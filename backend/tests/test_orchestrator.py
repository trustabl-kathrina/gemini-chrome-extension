from dayflow.agents.orchestrator import (
    ACTIONS_KEY,
    CONFIRMATIONS_KEY,
    MAX_ACTIONS,
    compose_instruction,
    guard_tool,
    host_allowed,
    result_state_delta,
)
from dayflow.core.loader import default_config
from dayflow.core.models import Permissions, SiteProfile, UserConfig


def test_instruction_includes_skill_and_site_notes() -> None:
    cfg = default_config()
    skill = cfg.skill("vault-sync")
    assert skill is not None
    text = compose_instruction(cfg, skill, skill.sites)
    assert "Active skill: Sync WSP files to vault" in text
    assert "Student files" in text and 'press_key("Enter")' in text and "vault_list()" in text
    assert "### wsp.kbtu.kz (mode: dom)" in text and "School > Instructor" in text
    assert "Perception modes: wsp.kbtu.kz → dom." in text
    assert "request_confirmation before: create_issue, create_pull_request, issue_write, type" in text


def test_base_prompt_states_the_loop_rules() -> None:
    text = compose_instruction(default_config(), None, [])
    assert "Before EVERY tool call write exactly one sentence" in text
    assert "screenshot taken after the action" in text
    assert "mode dom" in text and "mode vision" in text and "click_at" in text
    assert 'press_key("Enter")' in text  # Vaadin hint
    assert f"at most {MAX_ACTIONS} browser actions per run" in text


def test_instruction_mentions_mode_per_domain_in_scope() -> None:
    cfg = UserConfig(
        sites=[
            SiteProfile(domain="drive.google.com", notes="canvas UI", mode="vision"),
            SiteProfile(domain="wsp.kbtu.kz", notes="vaadin"),
        ]
    )
    text = compose_instruction(cfg, None, ["docs.drive.google.com", "wsp.kbtu.kz", "example.org"])
    assert "Perception modes: drive.google.com → vision, wsp.kbtu.kz → dom, example.org → dom (no profile)." in text
    assert "### drive.google.com (mode: vision)\ncanvas UI" in text
    # No skill and no domains: every configured profile is in scope (a free prompt may go anywhere).
    unscoped = compose_instruction(cfg, None, [])
    assert unscoped.count("Sites in scope") == 1
    assert "Perception modes: drive.google.com → vision, wsp.kbtu.kz → dom." in unscoped
    assert compose_instruction(cfg, None, ["wsp.kbtu.kz"]).count("drive.google.com") == 0


def test_guard_caps_browser_actions_per_run() -> None:
    perms = Permissions(ask_before=[])
    assert guard_tool("read_page", {}, {ACTIONS_KEY: MAX_ACTIONS - 1}, perms) is None
    err = guard_tool("click", {"ref": "e1"}, {ACTIONS_KEY: MAX_ACTIONS}, perms)
    assert err is not None and "budget exhausted" in err["error"]
    # Questions to the user and server tools are not browser actions.
    assert guard_tool("request_confirmation", {"action": "a", "details": "d"}, {ACTIONS_KEY: 99}, perms) is None
    assert guard_tool("vault_list", {}, {ACTIONS_KEY: 99}, perms) is None
    assert guard_tool("read_page", {}, {ACTIONS_KEY: 3}, perms, max_actions=5) is None
    assert guard_tool("read_page", {}, {ACTIONS_KEY: 5}, perms, max_actions=5) is not None


def test_result_state_delta_books_actions_and_credits() -> None:
    perms = Permissions(ask_before=["type_text", "create_issue"], mode="ask")
    assert result_state_delta(["read_page", "click"], {}, perms) == {ACTIONS_KEY: 2}
    assert result_state_delta(["read_page"], {ACTIONS_KEY: 39}, perms) == {ACTIONS_KEY: 40}
    assert result_state_delta(["request_confirmation"], {}, perms, granted=1) == {CONFIRMATIONS_KEY: 1}
    assert result_state_delta(["type"], {CONFIRMATIONS_KEY: 1}, perms) == {ACTIONS_KEY: 1, CONFIRMATIONS_KEY: 0}
    assert result_state_delta(["type"], {}, perms) == {ACTIONS_KEY: 1, CONFIRMATIONS_KEY: 0}  # never negative
    assert result_state_delta(["type"], {}, Permissions(ask_before=["type"], mode="auto")) == {ACTIONS_KEY: 1}
    assert result_state_delta([], {}, perms) == {}


def test_instruction_without_skill_lists_playbooks_and_all_sites() -> None:
    cfg = default_config()
    text = compose_instruction(cfg, None, [])
    assert "Active skill" not in text and "You are Dayflow" in text
    # A free-text prompt still gets the skill steps (as playbooks) and every site profile.
    assert "## Skills you know (playbooks)" in text
    assert "### Sync WSP files to vault (/vault-sync)" in text and 'press_key("Enter")' in text
    assert "### wsp.kbtu.kz (mode: dom)" in text and "### drive.google.com (mode: vision)" in text
    # An active skill narrows the prompt to its own steps and sites.
    skill = cfg.skill("vault-sync")
    assert skill is not None
    scoped = compose_instruction(cfg, skill, skill.sites)
    assert "Skills you know" not in scoped and "### drive.google.com" not in scoped


def test_host_allowlist() -> None:
    assert host_allowed("wsp.kbtu.kz", ["wsp.kbtu.kz"])
    assert host_allowed("a.wsp.kbtu.kz", ["wsp.kbtu.kz"])
    assert not host_allowed("kbtu.kz.evil.com", ["wsp.kbtu.kz"])
    assert host_allowed("anything", [])


def test_guard_blocks_disallowed_navigation() -> None:
    perms = Permissions(allowed_hosts=["wsp.kbtu.kz"])
    err = guard_tool("navigate", {"url": "https://evil.com/x"}, {}, perms)
    assert err is not None and "not on the user's allow-list" in err["error"]
    assert guard_tool("navigate", {"url": "https://wsp.kbtu.kz/x"}, {}, perms) is None
    assert guard_tool("read_page", {}, {}, perms) is None


def test_guard_confirmation_credit_is_consumed() -> None:
    perms = Permissions(ask_before=["type", "create_issue"], mode="ask")
    state: dict = {}
    err = guard_tool("type", {"ref": "e1", "text": "hi"}, state, perms)
    assert err is not None and "request_confirmation" in err["error"]
    state[CONFIRMATIONS_KEY] = 1
    assert guard_tool("type", {"ref": "e1", "text": "hi"}, state, perms) is None
    assert state[CONFIRMATIONS_KEY] == 1, "browser tools are charged when their result arrives (see result_state_delta)"
    # Server tools get a FunctionResponse event, so the guard charges them directly.
    assert guard_tool("create_issue", {"title": "t"}, state, perms) is None
    assert state[CONFIRMATIONS_KEY] == 0
    assert guard_tool("create_issue", {"title": "t"}, state, perms) is not None
    assert guard_tool("type", {}, {}, Permissions(ask_before=["type"], mode="auto")) is None
    # The extension's permission mapper still says `type_text`; it gates the same tool.
    legacy = Permissions(ask_before=["type_text"], mode="ask")
    assert guard_tool("type", {"ref": "e1", "text": "hi"}, {}, legacy) is not None


def test_guard_rejects_non_http_schemes_even_without_allowlist() -> None:
    perms = Permissions(allowed_hosts=[])
    for name in ("navigate", "open_tab", "download"):
        err = guard_tool(name, {"url": "file:///etc/passwd"}, {}, perms)
        assert err is not None and "http(s)" in err["error"]
        assert guard_tool(name, {"url": "javascript:alert(1)"}, {}, perms) is not None
        assert guard_tool(name, {"url": "https://anything.example/x"}, {}, perms) is None
    # download by ref has no URL to check.
    strict = Permissions(allowed_hosts=["a.b"])
    assert guard_tool("download", {"ref": "e3", "path": "C/Lab 01/a.pdf"}, {}, strict) is None
