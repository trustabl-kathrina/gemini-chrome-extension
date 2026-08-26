"""Role → model id registry, loaded from models.yaml (override with DAYFLOW_MODEL_<ROLE>)."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel

_YAML = Path(__file__).with_name("models.yaml")


class ModelRegistry(BaseModel):
    orchestrator: str
    parser: str
    classifier: str
    embed: str
    embed_dims: int = 768


@lru_cache(maxsize=1)
def registry() -> ModelRegistry:
    data = yaml.safe_load(_YAML.read_text())
    for role in ("orchestrator", "parser", "classifier", "embed"):
        if override := os.getenv(f"DAYFLOW_MODEL_{role.upper()}"):
            data[role] = override
    return ModelRegistry.model_validate(data)
