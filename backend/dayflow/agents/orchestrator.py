"""The root agent. Its instruction is composed per request from the user's config:
base prompt + active skill + site profiles in scope (with their perception mode) + permissions.

Policy lives in `guard_tool` (pure, unit-tested) and runs in `before_tool_callback`:
- host allow-list for navigate / open_tab / download(url=…);
- a hard cap of MAX_ACTIONS browser actions per run (counter in session state, reset by /chat);
- confirmation credits: tools listed in `permissions.ask_before` are blocked unless the session holds a
  credit. Credits are added by the API when the extension answers a `request_confirmation` long-running
  tool call with {"confirmed": true} (ADK's FunctionTool(require_confirmation=...) does not compose with
  LongRunningFunctionTool, so the confirmation itself is a long-running tool the panel renders as an
  Allow/Deny card).

Bookkeeping (`result_state_delta`) happens in POST /tool_result, not in the guard: ADK builds no
FunctionResponse event for a long-running tool that returns None (functions.py, "skip the auto-FR build"),
so state the guard writes for a browser call is discarded. Server tools (GitHub, Linear) do get an FR
event, so the guard consumes their credit itself.
"""

from __future__ import annotations

from typing import Any, Protocol
from urllib.parse import urlparse

from google.adk.agents import LlmAgent
from google.adk.agents.readonly_context import ReadonlyContext
from google.adk.tools import BaseTool, ToolContext

from dayflow.core.loader import ConfigStore
from dayflow.core.models import Permissions, SiteProfile, Skill, UserConfig
from dayflow.models.registry import registry
from dayflow.tools.browser import BROWSER_ACTION_NAMES, BROWSER_TOOLS, CONFIRM_TOOL, URL_TOOL_NAMES
from dayflow.tools.connectors import connector_toolsets
from dayflow.tools.server import SERVER_TOOLS


class StateLike(Protocol):
    """The subset of ADK's session State (and a plain dict) that policy checks need."""

    def get(self, key: str, default: Any = None, /) -> Any: ...

    def __setitem__(self, key: str, value: Any, /) -> None: ...


CONFIRMATIONS_KEY = "confirmations"
SKILL_KEY = "skill_id"
DOMAINS_KEY = "domains"
ACTIONS_KEY = "actions"
MAX_ACTIONS = 40
# Older configs and the extension's permission mapper say `type_text`; the tool the model sees is `type`.
TOOL_ALIASES = {"type_text": "type"}

BASE_PROMPT = f"""You are Dayflow, an autonomous agent that works inside the user's Chrome browser — the browser
equivalent of a coding agent: a generic loop driven by the user's own config (skills, site profiles,
permissions, connections). You act through browser tools the extension executes (open_tab, navigate,
read_page, screenshot, click, click_at, type, press_key, scroll, set_viewport, run_js, download, list_tabs,
wait) and server tools (vault_list, vault_read, parse_document, GitHub, Linear, ...). The user is already
signed in to their sites; never ask for or type passwords.

How you work:
- Before EVERY tool call write exactly one sentence: what you see → what you do next. Then call the tool.
  Call ONE browser tool at a time and wait for its result; never queue several browser calls in one turn.
- Every browser tool result includes a screenshot taken after the action. Look at it and check that the
  action had the intended effect (page changed, row selected, folder opened, text entered) before you
  decide the next step. If it did not, do not repeat the same click blindly: re-read the page, scroll,
  wait, or choose another element.
- Sites are perceived per the site profile's mode:
  · mode dom (default): call read_page after every navigation, click or Enter and act by element refs
    ([eN]); refs are valid only for the latest snapshot. Use the screenshot to verify, not to locate.
  · mode vision: start from screenshot(), act by coordinates with click_at(x, y); use read_page only to
    read text you cannot make out. Take a screenshot after every action.
- Vaadin portals (like WSP) have no real links: navigate by clicking. In folder tables a click only
  SELECTS the row — then press_key("Enter") (or click the Enter button) to open it; Back goes up.
- Budget: at most {MAX_ACTIONS} browser actions per run. Plan the shortest path, avoid redundant reads,
  and when the budget is exhausted the tools return an error — then stop and report what was done.
- Outward-facing or irreversible actions (sending messages, creating issues/PRs) need request_confirmation
  first; if the user denies, stop that branch and say so. The answer arrives as a tool result.
- The vault is the user's Google Drive folder "Dayflow/<course>/<Materials|Week NN|Lab NN>/"; download(path=...)
  puts a file there and indexes it on the brain (vault_list / vault_read read it back).
- Be terse in prose. Finish with a short summary of what changed and links to the artifacts.
"""


def site_section(site: SiteProfile) -> str:
    return f"### {site.domain} (mode: {site.mode})\n{site.notes.strip()}"


def compose_instruction(cfg: UserConfig, skill: Skill | None, domains: list[str]) -> str:
    parts = [BASE_PROMPT]
    if cfg.memory:
        parts.append(f"## What you remember about this user\n{cfg.memory}")
    parts.append(f"Vault folder (Google Drive): {cfg.vault_folder}")
    if skill:
        parts.append(f"## Active skill: {skill.title}\n{skill.instructions.strip()}")
        if skill.tools:
            parts.append("Tools this skill may use: " + ", ".join(skill.tools))
    profiles: list[SiteProfile] = []
    unprofiled: list[str] = []
    for d in domains:
        site = cfg.site(d)
        if site is None:
            unprofiled.append(d)
        elif site not in profiles:
            profiles.append(site)
    if profiles or unprofiled:
        lines = ["## Sites in scope"]
        lines.append(
            "Perception modes: "
            + ", ".join([f"{s.domain} → {s.mode}" for s in profiles] + [f"{d} → dom (no profile)" for d in unprofiled])
            + "."
        )
        lines.extend(site_section(s) for s in profiles)
        parts.append("\n".join(lines))
    perms = cfg.permissions
    if perms.allowed_hosts:
        parts.append("Navigation is limited to: " + ", ".join(perms.allowed_hosts))
    if perms.ask_before and perms.mode == "ask":
        names = sorted({TOOL_ALIASES.get(n, n) for n in perms.ask_before})
        parts.append("Always call request_confirmation before: " + ", ".join(names))
    return "\n\n".join(parts)


def host_of(url: str) -> str:
    return (urlparse(url).hostname or "").lower()


def host_allowed(host: str, allowed_hosts: list[str]) -> bool:
    if not allowed_hosts:
        return True
    return any(host == a or host.endswith("." + a) for a in allowed_hosts)


def guard_tool(
    name: str, args: dict[str, Any], state: StateLike, perms: Permissions, max_actions: int = MAX_ACTIONS
) -> dict[str, Any] | None:
    """Pure policy check. Returns an error dict to short-circuit the tool, or None to allow."""
    if name in URL_TOOL_NAMES:
        url = str(args.get("url", "") or "")
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
    if name in BROWSER_ACTION_NAMES and int(state.get(ACTIONS_KEY, 0) or 0) >= max_actions:
        return {
            "status": "error",
            "error": f"Browser action budget exhausted ({max_actions} actions per run). "
            "Stop acting and report what was done and what remains.",
        }
    if is_gated(name, perms):
        credits = int(state.get(CONFIRMATIONS_KEY, 0) or 0)
        if credits <= 0:
            return {
                "status": "error",
                "error": f"'{name}' needs user approval. Call request_confirmation(action, details) first.",
            }
        if name not in BROWSER_ACTION_NAMES:  # browser tools are charged when their result arrives
            state[CONFIRMATIONS_KEY] = credits - 1
    return None


def is_gated(name: str, perms: Permissions) -> bool:
    return perms.mode == "ask" and name in {TOOL_ALIASES.get(n, n) for n in perms.ask_before}


def result_state_delta(names: list[str], state: StateLike, perms: Permissions, granted: int = 0) -> dict[str, Any]:
    """State changes for a batch of answered long-running calls: each browser action spends budget, each
    answered gated tool spends one confirmation credit, `granted` confirmed answers add credits."""
    delta: dict[str, Any] = {}
    actions = sum(1 for n in names if n in BROWSER_ACTION_NAMES)
    if actions:
        delta[ACTIONS_KEY] = int(state.get(ACTIONS_KEY, 0) or 0) + actions
    consumed = sum(1 for n in names if n in BROWSER_ACTION_NAMES and is_gated(n, perms))
    if granted or consumed:
        current = int(state.get(CONFIRMATIONS_KEY, 0) or 0)
        delta[CONFIRMATIONS_KEY] = max(0, current + granted - consumed)
    return delta


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
