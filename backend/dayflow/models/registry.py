"""Role → model id registry, loaded from models.yaml (override with DAYFLOW_MODEL_<ROLE>; DAYFLOW_THINKING for the
orchestrator's thinking level)."""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel

_YAML = Path(__file__).with_name("models.yaml")


class ModelRegistry(BaseModel):
    orchestrator: str
    solver: str = ""  # empty → same model as the orchestrator
    parser: str
    classifier: str
    embed: str
    embed_dims: int = 768
    thinking: str = "low"  # orchestrator thinking level: minimal | low | medium | high
    solver_thinking: str = "medium"  # the lab solver writes code: one notch up
    image_resolution: str = "low"  # Gemini media_resolution for screenshots on dom-mode sites: low | medium | high
    fallbacks: list[str] = []  # tried in order when the orchestrator model answers 429/5xx: "model@location" | "model"


@lru_cache(maxsize=1)
def registry() -> ModelRegistry:
    data = yaml.safe_load(_YAML.read_text())
    for role in ("orchestrator", "solver", "parser", "classifier", "embed"):
        if override := os.getenv(f"DAYFLOW_MODEL_{role.upper()}"):
            data[role] = override
    if override := os.getenv("DAYFLOW_THINKING"):
        data["thinking"] = override
    if override := os.getenv("DAYFLOW_SOLVER_THINKING"):
        data["solver_thinking"] = override
    if override := os.getenv("DAYFLOW_IMAGE_RESOLUTION"):
        data["image_resolution"] = override
    if (override := os.getenv("DAYFLOW_FALLBACKS")) is not None:
        data["fallbacks"] = [f for f in override.split(",") if f.strip()]
    reg = ModelRegistry.model_validate(data)
    if not reg.solver:
        reg.solver = reg.orchestrator
    return reg
