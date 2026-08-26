"""The root agent. Its instruction is composed per request from the user's config:
base prompt + active skill + site profiles in scope + permissions.

Confirmation gating: tools listed in `permissions.ask_before` are blocked by `guard_tool`
unless the session holds a confirmation credit. Credits are added by the API when the
extension answers a `request_confirmation` long-running tool call with {"confirmed": true}
(ADK's FunctionTool(require_confirmation=...) does not compose with LongRunningFunctionTool,
so the confirmation itself is a long-running tool the panel renders as an Allow/Deny card).
"""

from __future__ import annotations

from typing import Any, Protocol
from urllib.parse import urlparse

from google.adk.agents import LlmAgent
from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.tools import BaseTool, ToolContext

from dayflow.core.loader import ConfigStore
from dayflow.core.models import Permissions, Skill, UserConfig
from dayflow.models.registry import registry
from dayflow.tools.browser import BROWSER_TOOLS, CONFIRM_TOOL
from dayflow.tools.connectors import connector_toolsets
from dayflow.tools.server import SERVER_TOOLS


class StateLike(Protocol):
    """The subset of ADK's session State (and a plain dict) that policy checks need."""

    def get(self, key: str, default: Any = None, /) -> Any: ...

    def __setitem__(self, key: str, value: Any, /) -> None: ...


CONFIRMATIONS_KEY = "confirmations"
SKILL_KEY = "skill_id"
DOMAINS_KEY = "domains"

BASE_PROMPT = """You are Dayflow, an autonomous agent living in the user's Chrome browser.
You act through browser tools (read_page, click, type_text, navigate, download, ...) and server
tools (document parsing, GitHub, Linear). The user is already signed in to their sites; never ask
for passwords.

Working style:
- Call ONE browser tool at a time and wait for its result. After navigation or a click, call
  read_page before deciding the next step; refs like [e17] come from the latest snapshot only.
- Prefer read_page over screenshot. Use screenshot only for canvas-based UIs.
- Outward-facing or irreversible actions (sending messages, creating issues/PRs) require
  request_confirmation first; if the user denies, stop that branch and say so.
- Be terse in prose. Finish with a short summary of what changed and links to artifacts.
"""


def compose_instruction(cfg: UserConfig, skill: Skill | None, domains: list[str]) -> str:
    parts = [BASE_PROMPT]
    if cfg.memory:
        parts.append(f"## What you remember about this user\n{cfg.memory}")
    parts.append(f"Vault folder (relative to Downloads): {cfg.vault_folder}")
    if skill:
        parts.append(f"## Active skill: {skill.title}\n{skill.instructions.strip()}")
        if skill.tools:
            parts.append("Tools this skill may use: " + ", ".join(skill.tools))
    notes = [s for d in domains if (s := cfg.site(d)) is not None]
    if notes:
        parts.append("## Site notes\n" + "\n".join(f"### {s.domain}\n{s.notes.strip()}" for s in notes))
    perms = cfg.permissions
    if perms.allowed_hosts:
        parts.append("Navigation is limited to: " + ", ".join(perms.allowed_hosts))
    if perms.ask_before and perms.mode == "ask":
        parts.append("Always call request_confirmation before: " + ", ".join(perms.ask_before))
    return "\n\n".join(parts)


def host_of(url: str) -> str:
    return (urlparse(url).hostname or "").lower()


def host_allowed(host: str, allowed_hosts: list[str]) -> bool:
    if not allowed_hosts:
        return True
    return any(host == a or host.endswith("." + a) for a in allowed_hosts)


def guard_tool(name: str, args: dict[str, Any], state: StateLike, perms: Permissions) -> dict[str, Any] | None:
    """Pure policy check. Returns an error dict to short-circuit the tool, or None to allow."""
    if name in {"navigate", "open_tab", "download"}:
        url = str(args.get("url", ""))
        scheme = urlparse(url).scheme.lower()
        if url and scheme not in {"http", "https"}:
            return {"status": "error", "error": f"Only http(s) URLs are allowed, got scheme '{scheme or 'none'}'."}
        host = host_of(url)
        if url and not host_allowed(host, perms.allowed_hosts):
            return {
                "status": "error",
                "error": f"Host '{host}' is not on the user's allow-list. "
                "Ask the user to add it in Settings → Permissions.",
            }
    if perms.mode == "ask" and name in perms.ask_before:
        credits = int(state.get(CONFIRMATIONS_KEY, 0) or 0)
        if credits <= 0:
            return {
                "status": "error",
                "error": f"'{name}' needs user approval. Call request_confirmation(action, details) first.",
            }
        state[CONFIRMATIONS_KEY] = credits - 1
    return None


def build_root_agent(store: ConfigStore) -> LlmAgent:
    async def instruction(ctx: ReadonlyContext) -> str:
        cfg = await store.get(ctx.user_id)
        skill_id = ctx.state.get(SKILL_KEY)
        skill = cfg.skill(str(skill_id)) if skill_id else None
        domains = list(ctx.state.get(DOMAINS_KEY) or (skill.sites if skill else []))
        return compose_instruction(cfg, skill, domains)

    async def before_tool(tool: BaseTool, args: dict[str, Any], tool_context: ToolContext) -> dict[str, Any] | None:
        cfg = await store.get(tool_context.user_id)
        return guard_tool(tool.name, args, tool_context.state, cfg.permissions)

    return LlmAgent(
        name="dayflow",
        model=registry().orchestrator,
        description="Dayflow orchestrator: drives the user's browser and server tools to run skills.",
        instruction=instruction,
        tools=[*BROWSER_TOOLS, CONFIRM_TOOL, *SERVER_TOOLS, *connector_toolsets()],
        before_tool_callback=before_tool,
    )
