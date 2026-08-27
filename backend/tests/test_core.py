from dayflow.core.loader import MemoryConfigStore, default_config, load_pack
from dayflow.core.models import Permissions, SiteProfile, Skill, UserConfig
from dayflow.models.registry import registry

# The six palette skills (keys 1-6) in order, plus the scheduled watch skill appended after them.
PACK_SKILLS = ["vault-sync", "courseware", "scaffold", "lab", "team-ops", "pitch-deck", "standing-watch"]


def test_default_pack_has_every_skill_and_its_sites() -> None:
    cfg = load_pack()
    assert [s.id for s in cfg.skills] == PACK_SKILLS
    assert all(s.pack == "kbtu-student" and s.instructions.strip() for s in cfg.skills)
    assert {s.domain for s in cfg.sites} >= {"wsp.kbtu.kz", "teams.microsoft.com", "web.telegram.org"}
    assert "wsp.kbtu.kz" in cfg.permissions.allowed_hosts
    vault = cfg.skill("vault-sync")
    assert vault is not None and vault.schedule == "0 8 * * *"


def test_site_lookup_matches_subdomains() -> None:
    cfg = default_config()
    assert cfg.site("wsp.kbtu.kz") is not None
    assert cfg.site("login.wsp.kbtu.kz") is not None
    assert cfg.site("evil.example") is None


def test_overlay_user_config_wins() -> None:
    base = default_config()
    user = UserConfig(
        skills=[Skill(id="vault-sync", title="Mine", prompt="p", instructions="custom", enabled=False)],
        sites=[SiteProfile(domain="wsp.kbtu.kz", notes="my notes")],
        permissions=Permissions(allowed_hosts=["only.example"]),
        memory="I study ML",
    )
    merged = base.overlay(user)
    # the user disabled vault-sync: it stays in the list (so the UI can re-enable it) but no longer resolves
    assert len(merged.skills) == len(PACK_SKILLS) and merged.skill("vault-sync") is None
    site = merged.site("wsp.kbtu.kz")
    assert site is not None and site.notes == "my notes"
    assert merged.permissions.allowed_hosts == ["only.example"]
    assert merged.memory == "I study ML"


async def test_memory_store_roundtrip() -> None:
    store = MemoryConfigStore()
    assert len((await store.get("u1")).skills) == len(PACK_SKILLS)
    await store.put("u1", UserConfig(vault_folder="Vault2"))
    assert (await store.get("u1")).vault_folder == "Vault2"


def test_registry_roles() -> None:
    reg = registry()
    assert reg.orchestrator.startswith("gemini-") and reg.embed_dims == 768
