"""ResilientGemini: 429 on the primary → same request replayed on the fallbacks; mid-stream failures re-raise."""

from __future__ import annotations

from collections.abc import AsyncGenerator
from typing import Any

import pytest
from google.adk.models.google_llm import Gemini
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from google.genai.errors import ClientError

from dayflow.models.resilient import ResilientGemini, exhausted, parse_fallback


def err(code: int) -> ClientError:
    return ClientError(code, {"error": {"code": code, "message": "Resource exhausted", "status": "RESOURCE_EXHAUSTED"}})


def resp(text: str) -> LlmResponse:
    return LlmResponse(content=types.Content(role="model", parts=[types.Part(text=text)]))


def scripted(monkeypatch: pytest.MonkeyPatch, plan: dict[str, list[Any]]) -> list[str]:
    """Fake Gemini.generate_content_async: per model id a list of items — str = streamed chunk, exception = raised."""
    calls: list[str] = []

    async def fake(self: Gemini, llm_request: LlmRequest, stream: bool = False) -> AsyncGenerator[LlmResponse, None]:
        calls.append(f"{self.model}:{llm_request.model}")
        for item in plan[self.model]:
            if isinstance(item, BaseException):
                raise item
            yield resp(item)

    monkeypatch.setattr(Gemini, "generate_content_async", fake)
    return calls


async def collect(llm: ResilientGemini, req: LlmRequest) -> list[str]:
    out: list[str] = []
    async for r in llm.generate_content_async(req, stream=True):
        out.append(r.content.parts[0].text or "" if r.content and r.content.parts else "")
    return out


async def test_primary_429_falls_through_the_chain_in_order(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = scripted(monkeypatch, {"gemini-3.7-flash": [err(429)], "gemini-3.5-flash": ["fallback answer"]})
    llm = ResilientGemini(model="gemini-3.7-flash", fallbacks=["gemini-3.7-flash@europe-west4", "gemini-3.5-flash"])
    assert await collect(llm, LlmRequest(model="gemini-3.7-flash")) == ["fallback answer"]
    # the regional alternate shares the primary's model id, so the scripted 429 hits it too; then 3.5-flash answers
    assert calls == [
        "gemini-3.7-flash:gemini-3.7-flash",
        "gemini-3.7-flash:gemini-3.7-flash",
        "gemini-3.5-flash:gemini-3.5-flash",
    ]
    alt = llm.alternate("gemini-3.7-flash@europe-west4")
    assert alt.client_kwargs == {"location": "europe-west4"} and llm.alternate("gemini-3.5-flash").client_kwargs == {}


async def test_primary_success_never_touches_a_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = scripted(monkeypatch, {"gemini-3.7-flash": ["a", "b"]})
    llm = ResilientGemini(model="gemini-3.7-flash", fallbacks=["gemini-3.5-flash"])
    assert await collect(llm, LlmRequest(model="gemini-3.7-flash")) == ["a", "b"] and len(calls) == 1


async def test_failure_after_streamed_chunks_is_not_replayed(monkeypatch: pytest.MonkeyPatch) -> None:
    scripted(monkeypatch, {"gemini-3.7-flash": ["partial", err(429)], "gemini-3.5-flash": ["never"]})
    llm = ResilientGemini(model="gemini-3.7-flash", fallbacks=["gemini-3.5-flash"])
    with pytest.raises(ClientError):
        await collect(llm, LlmRequest(model="gemini-3.7-flash"))


async def test_non_quota_errors_and_exhausted_chain_re_raise(monkeypatch: pytest.MonkeyPatch) -> None:
    scripted(monkeypatch, {"gemini-3.7-flash": [err(400)], "gemini-3.5-flash": ["never"]})
    llm = ResilientGemini(model="gemini-3.7-flash", fallbacks=["gemini-3.5-flash"])
    with pytest.raises(ClientError) as e:
        await collect(llm, LlmRequest(model="gemini-3.7-flash"))
    assert e.value.code == 400
    scripted(monkeypatch, {"gemini-3.7-flash": [err(429)], "gemini-3.5-flash": [err(429)]})
    with pytest.raises(ClientError) as e2:
        await collect(llm, LlmRequest(model="gemini-3.7-flash"))
    assert e2.value.code == 429


def test_helpers() -> None:
    assert parse_fallback("gemini-3.7-flash@us-central1") == ("gemini-3.7-flash", "us-central1")
    assert parse_fallback("gemini-3.5-flash") == ("gemini-3.5-flash", None)
    assert exhausted(err(429)) and not exhausted(err(403)) and not exhausted(ValueError("x"))
