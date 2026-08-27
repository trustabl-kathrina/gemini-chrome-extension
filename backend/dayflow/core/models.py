"""Domain models: everything user-specific is data, never code."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

SkillId = str


class Skill(BaseModel):
    """A playbook the agent can run — the Dayflow analogue of a Claude Code skill."""

    id: SkillId
    title: str
    blurb: str = ""
    prompt: str = Field(description="Opening user message used when the skill is launched from the panel.")
    instructions: str = Field(description="Injected into the system prompt while this skill is active.")
    tools: list[str] = Field(default_factory=list, description="Tool names the skill may use; empty = all.")
    sites: list[str] = Field(default_factory=list, description="Domains the skill operates on.")
    keywords: list[str] = Field(
        default_factory=list,
        description="Words that mark a free-text prompt as this skill's job; its playbook is then injected "
        "(no keywords = always injected).",
    )
    schedule: str | None = Field(default=None, description="Cron expression; None = on demand only.")
    pack: str = "custom"
    enabled: bool = True
    key: str = Field(default="", description="Single-key shortcut in the ⌘K palette.")


class SiteProfile(BaseModel):
    """Per-domain notes — the Dayflow analogue of a per-repo CLAUDE.md."""

    domain: str
    notes: str
    allow: bool = True
    mode: Literal["dom", "vision"] = Field(
        default="dom",
        description="Perception on this site: 'dom' = element list + screenshot to verify; "
        "'vision' = screenshot first, act by coordinates.",
    )


class Permissions(BaseModel):
    allowed_hosts: list[str] = Field(default_factory=list, description="Empty = any host.")
    ask_before: list[str] = Field(
        default_factory=lambda: ["type", "create_pull_request", "issue_write", "create_issue", "run_js"],
        description="Tool names that require user confirmation before running.",
    )
    mode: Literal["ask", "auto"] = "ask"


class Connections(BaseModel):
    github: bool = False
    linear: bool = False


class UserConfig(BaseModel):
    """Everything a user can change from the extension settings."""

    skills: list[Skill] = Field(default_factory=list)
    sites: list[SiteProfile] = Field(default_factory=list)
    permissions: Permissions = Field(default_factory=Permissions)
    connections: Connections = Field(default_factory=Connections)
    vault_folder: str = Field(default="Dayflow", description="Google Drive folder that holds the vault.")
    memory: str = Field(default="", description="Free-form notes the agent reads at run start.")

    def skill(self, skill_id: SkillId) -> Skill | None:
        return next((s for s in self.skills if s.id == skill_id and s.enabled), None)

    def site(self, domain: str) -> SiteProfile | None:
        return next((s for s in self.sites if domain == s.domain or domain.endswith("." + s.domain)), None)

    def overlay(self, other: UserConfig) -> UserConfig:
        """User-stored config wins over the default pack, skill-by-skill and site-by-site."""
        skills = {s.id: s for s in self.skills}
        skills.update({s.id: s for s in other.skills})
        sites = {s.domain: s for s in self.sites}
        sites.update({s.domain: s for s in other.sites})
        return UserConfig(
            skills=list(skills.values()),
            sites=list(sites.values()),
            permissions=other.permissions if other.model_fields_set & {"permissions"} else self.permissions,
            connections=other.connections if other.model_fields_set & {"connections"} else self.connections,
            vault_folder=other.vault_folder if "vault_folder" in other.model_fields_set else self.vault_folder,
            memory=other.memory or self.memory,
        )
