"""Scene 3 (team-ops): the pack's skill + Telegram profile drive the loop that the harness judges —
draft from the repo → open the chat → confirm the exact text → send → Linear issues → GitHub issue + PR."""

import json
from pathlib import Path

import pytest

from dayflow.agents.orchestrator import (
    ACTIONS_KEY,
    CONFIRMATIONS_KEY,
    compose_instruction,
    guard_tool,
    result_state_delta,
)
from dayflow.core.loader import default_config
from dayflow.core.models import Permissions
from dayflow.tools import connectors
from dayflow.tools.browser import BROWSER_TOOL_NAMES
from dayflow.tools.connectors import GITHUB_TOOLS, LINEAR_TOOLS

STEP_TOOLS = [
    "get_file_contents",
    "open_tab",
    "read_page",
    "click",
    "request_confirmation",
    "type(",
    "list_teams",
    "create_issue",
    "issue_write",
    "create_pull_request",
]


def team_ops():
    skill = default_config().skill("team-ops")
    assert skill is not None
    return skill


def test_skill_declares_the_tools_its_steps_use() -> None:
    skill = team_ops()
    known = BROWSER_TOOL_NAMES | set(GITHUB_TOOLS) | set(LINEAR_TOOLS)
    assert set(skill.tools) <= known, set(skill.tools) - known
    for name in ["get_file_contents", "open_tab", "read_page", "click", "type", "request_confirmation"]:
        assert name in skill.tools
    assert {"list_teams", "create_issue", "issue_write", "create_pull_request"} <= set(skill.tools)
    assert {"web.telegram.org", "github.com"} <= set(skill.sites)


def test_skill_steps_follow_the_scene_order() -> None:
    text = team_ops().instructions
    positions = [text.index(t) for t in STEP_TOOLS]
    assert positions == sorted(positions), "steps must go: draft → open chat → confirm → send → Linear → GitHub"
    # The message is confirmed verbatim, sent once with submit=true, then verified on the page.
    assert "verbatim" in text and "submit=true" in text and "Leave the chat tab open" in text
    assert "one gated call per confirmation" in text  # one credit per create_issue / issue_write / PR
    assert "ONE" in text and "create_pull_request" in text  # exactly one PR (the harness counts)
    assert "3 sentences" in text


def test_telegram_profile_describes_the_chat_layout() -> None:
    site = default_config().site("web.telegram.org")
    assert site is not None and site.mode == "dom"
    notes = site.notes
    for phrase in ["chat list", "left column", "search input", "contenteditable", "Send button", "bottom"]:
        assert phrase in notes, phrase
    assert "request_confirmation" in notes and "never send twice" in notes


def test_instruction_for_the_skill_and_for_a_free_prompt() -> None:
    cfg = default_config()
    skill = team_ops()
    scoped = compose_instruction(cfg, skill, skill.sites)
    assert "Active skill: Team ops" in scoped
    assert "### web.telegram.org (mode: dom)" in scoped and "### github.com (mode: dom)" in scoped
    assert "linear.app → dom (no profile)" in scoped
    assert "request_confirmation before: create_issue, create_pull_request, issue_write, type" in scoped
    # The harness types a free prompt (no skill_id): the same steps must reach the model as a playbook.
    free = compose_instruction(cfg, None, [])
    assert "### Team ops: Telegram → Linear → GitHub (/team-ops)" in free
    assert "submit=true" in free and "Telegram Web (K version" in free


def test_credit_accounting_across_the_scene() -> None:
    """One approval = one gated call: the message, then each issue and the PR (as the harness config asks)."""
    perms = Permissions(ask_before=["type", "type_text", "create_pull_request", "issue_write", "create_issue"])
    state: dict = {ACTIONS_KEY: 0}
    # Draft + open the chat: server tools cost nothing, browser tools cost actions.
    assert guard_tool("get_file_contents", {"owner": "o", "repo": "r", "path": "README.md"}, state, perms) is None
    for name, args in [
        ("open_tab", {"url": "https://web.telegram.org/k/"}),
        ("read_page", {}),
        ("click", {"ref": "e5"}),
    ]:
        assert guard_tool(name, args, state, perms) is None
        state.update(result_state_delta([name], state, perms))
    assert state[ACTIONS_KEY] == 3
    # Sending without approval is refused.
    err = guard_tool("type", {"ref": "e9", "text": "update", "submit": True}, state, perms)
    assert err is not None and "request_confirmation" in err["error"]
    # The approval arrives as a tool result and grants one credit; `type` spends it when its result arrives.
    assert guard_tool("request_confirmation", {"action": "Send", "details": "update"}, state, perms) is None
    state.update(result_state_delta(["request_confirmation"], state, perms, granted=1))
    assert guard_tool("type", {"ref": "e9", "text": "update", "submit": True}, state, perms) is None
    state.update(result_state_delta(["type"], state, perms))
    assert state[CONFIRMATIONS_KEY] == 0 and state[ACTIONS_KEY] == 4
    # Linear/GitHub: every gated server call needs its own credit and consumes it in the guard itself.
    assert guard_tool("list_teams", {}, state, perms) is None
    for name in ["create_issue", "create_issue", "issue_write", "create_pull_request"]:
        assert guard_tool(name, {"title": "t"}, state, perms) is not None, f"{name} must be blocked without a credit"
        state.update(result_state_delta(["request_confirmation"], state, perms, granted=1))
        assert guard_tool(name, {"title": "t"}, state, perms) is None
        assert state[CONFIRMATIONS_KEY] == 0
    assert guard_tool("push_files", {"files": []}, state, perms) is None  # not gated
    assert state[ACTIONS_KEY] == 4  # connector tools are not browser actions


def test_fake_connectors_produce_what_the_harness_expects(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    log = tmp_path / "team-ops-connectors.jsonl"
    monkeypatch.setenv("DAYFLOW_FAKE_CONNECTORS", "1")
    monkeypatch.setenv("DAYFLOW_FAKE_LOG", str(log))
    readme = connectors.get_file_contents("dayflow-student", "diploma", "README.md")
    todo = connectors.get_file_contents("dayflow-student", "diploma", "TODO.md")
    assert readme["status"] == "success" and "Diploma project" in readme["content"]
    assert todo["status"] == "success" and "Team ops" in todo["content"]
    team = connectors.list_teams()["teams"][0]["id"]
    a = connectors.create_issue("Courseware: cheatsheet + quiz", teamId=team, description="From TODO 2")
    b = connectors.create_issue("Vault scaffold from syllabus", teamId=team, description="From TODO 3")
    issue = connectors.issue_write("create", "dayflow-student", "diploma", title="Milestone: courseware", body="…")
    connectors.create_branch("dayflow-student", "diploma", "weekly-update-2026-08-26")
    connectors.push_files(
        "dayflow-student",
        "diploma",
        "weekly-update-2026-08-26",
        [{"path": "docs/updates/2026-08-26.md", "content": "x"}],
        "weekly",
    )
    pr = connectors.create_pull_request(
        "dayflow-student", "diploma", "Weekly update 2026-08-26", head="weekly-update-2026-08-26", base="main"
    )
    entries = [json.loads(line) for line in log.read_text().splitlines() if line.strip()]
    tools = [e["tool"] for e in entries]
    assert tools.count("create_issue") == 2 and tools.count("create_pull_request") == 1
    assert a["identifier"] != b["identifier"] and issue["html_url"].endswith(f"/issues/{issue['number']}")
    assert pr["html_url"] == f"https://github.com/dayflow-student/diploma/pull/{pr['number']}"
    assert entries[-1]["args"]["head"] == "weekly-update-2026-08-26" and entries[-1]["args"]["base"] == "main"
