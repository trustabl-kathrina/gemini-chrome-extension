"""Default pack loading + per-user config store (Firestore when configured, memory otherwise)."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Any, Protocol

import yaml

from dayflow.core.models import Permissions, SiteProfile, Skill, UserConfig

PACKS_DIR = Path(__file__).with_name("packs")
DEFAULT_PACK = PACKS_DIR / "kbtu-student.yaml"


def load_pack(path: Path = DEFAULT_PACK) -> UserConfig:
    data: dict[str, Any] = yaml.safe_load(path.read_text())
    name = str(data.get("name", path.stem))
    skills = [Skill.model_validate({**s, "pack": name}) for s in data.get("skills", [])]
    sites = [SiteProfile.model_validate(s) for s in data.get("sites", [])]
    permissions = Permissions.model_validate(data.get("permissions", {}))
    return UserConfig(skills=skills, sites=sites, permissions=permissions)


@lru_cache(maxsize=1)
def default_config() -> UserConfig:
    return load_pack()


class ConfigStore(Protocol):
    async def get(self, user_id: str) -> UserConfig: ...
    async def put(self, user_id: str, config: UserConfig) -> None: ...


class MemoryConfigStore:
    def __init__(self) -> None:
        self._data: dict[str, UserConfig] = {}

    async def get(self, user_id: str) -> UserConfig:
        stored = self._data.get(user_id)
        return default_config().overlay(stored) if stored else default_config()

    async def put(self, user_id: str, config: UserConfig) -> None:
        self._data[user_id] = config


class FirestoreConfigStore:
    """users/{uid}/config/current — the user's overlay on top of the default pack."""

    def __init__(self, client: Any | None = None) -> None:
        from google.cloud import firestore

        self._db = client or firestore.AsyncClient()

    def _doc(self, user_id: str):
        return self._db.collection("users").document(user_id).collection("config").document("current")

    async def get(self, user_id: str) -> UserConfig:
        snap = await self._doc(user_id).get()
        if not snap.exists:
            return default_config()
        stored = UserConfig.model_validate(snap.to_dict() or {})
        return default_config().overlay(stored)

    async def put(self, user_id: str, config: UserConfig) -> None:
        await self._doc(user_id).set(config.model_dump(mode="json"))


def firestore_enabled() -> bool:
    return bool(os.getenv("K_SERVICE") or os.getenv("DAYFLOW_FIRESTORE") == "1")


def make_config_store() -> ConfigStore:
    return FirestoreConfigStore() if firestore_enabled() else MemoryConfigStore()
