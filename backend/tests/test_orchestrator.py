from dayflow.agents.orchestrator import CONFIRMATIONS_KEY, compose_instruction, guard_tool, host_allowed
from dayflow.core.loader import default_config
from dayflow.core.models import Permissions


def test_instruction_includes_skill_and_site_notes() -> None:
    cfg = default_config()
    skill = cfg.skill("vault-sync")
    assert skill is not None
    text = compose_instruction(cfg, skill, skill.sites)
    assert "Active skill: Sync WSP files to vault" in text
    assert "mirror every course's file directory" in text
    assert "### wsp.kbtu.kz" in text and "School > Instructor" in text
    assert "request_confirmation before: type_text" in text


def test_instruction_without_skill_has_base_only() -> None:
    text = compose_instruction(default_config(), None, [])
    assert "Active skill" not in text and "You are Dayflow" in text


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
    perms = Permissions(ask_before=["type_text"], mode="ask")
    state: dict = {}
    err = guard_tool("type_text", {"ref": "e1", "text": "hi"}, state, perms)
    assert err is not None and "request_confirmation" in err["error"]
    state[CONFIRMATIONS_KEY] = 1
    assert guard_tool("type_text", {"ref": "e1", "text": "hi"}, state, perms) is None
    assert state[CONFIRMATIONS_KEY] == 0
    assert guard_tool("type_text", {"ref": "e1", "text": "hi"}, state, perms) is not None
    assert guard_tool("type_text", {}, {}, Permissions(ask_before=["type_text"], mode="auto")) is None


def test_guard_rejects_non_http_schemes_even_without_allowlist() -> None:
    perms = Permissions(allowed_hosts=[])
    for name in ("navigate", "open_tab", "download"):
        err = guard_tool(name, {"url": "file:///etc/passwd"}, {}, perms)
        assert err is not None and "http(s)" in err["error"]
        assert guard_tool(name, {"url": "javascript:alert(1)"}, {}, perms) is not None
        assert guard_tool(name, {"url": "https://anything.example/x"}, {}, perms) is None
