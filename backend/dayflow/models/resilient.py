"""Gemini with retries and a fallback chain, so one 429 RESOURCE_EXHAUSTED from Vertex does not end a run.

`ResilientGemini` retries each request on 429/5xx with exponential backoff (google-genai HttpRetryOptions),
and when the primary still fails before any chunk was streamed, replays the request on the fallbacks in
order: first the same model on another Vertex location (separate capacity, same thought signatures in the
history), then another model. A failure after chunks were streamed is re-raised — a half-answer cannot be
replayed without duplicating what the client already saw.
"""

from __future__ import annotations

import logging
from collections.abc import AsyncGenerator
from typing import Any

from google.adk.models.google_llm import Gemini
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from google.genai.errors import ClientError, ServerError

log = logging.getLogger("dayflow.models")

RETRY = types.HttpRetryOptions(
    attempts=5, initial_delay=2.0, max_delay=20.0, exp_base=2.0, jitter=0.5, http_status_codes=[429, 500, 502, 503, 504]
)


def parse_fallback(spec: str) -> tuple[str, str | None]:
    """'model@location' → (model, location); 'model' → (model, None)."""
    model, _, location = spec.strip().partition("@")
    return model, location or None


def exhausted(e: BaseException) -> bool:
    """A quota/capacity or transient server failure worth a fallback (ADK wraps 429 in a ClientError subclass)."""
    return (isinstance(e, ClientError) and e.code == 429) or isinstance(e, ServerError)


class ResilientGemini(Gemini):
    fallbacks: list[str] = []  # "model@location" or "model", tried in order after the primary
    _alternates: dict[str, Gemini] = {}

    def alternate(self, spec: str) -> Gemini:
        """One client per fallback, built once: the location goes into the client, the model into the request."""
        if spec not in self._alternates:
            model, location = parse_fallback(spec)
            kwargs: dict[str, Any] = {"location": location} if location else {}
            self._alternates[spec] = Gemini(model=model, retry_options=self.retry_options, client_kwargs=kwargs)
        return self._alternates[spec]

    async def generate_content_async(
        self, llm_request: LlmRequest, stream: bool = False
    ) -> AsyncGenerator[LlmResponse, None]:
        attempts: list[tuple[str, Gemini]] = [(f"{self.model} (primary)", self)]
        attempts += [(spec, self.alternate(spec)) for spec in self.fallbacks]
        last: BaseException | None = None
        for i, (label, llm) in enumerate(attempts):
            request = llm_request if llm is self else llm_request.model_copy(update={"model": llm.model})
            yielded = False
            try:
                async for response in Gemini.generate_content_async(llm, request, stream):
                    yielded = True
                    yield response
                if i:
                    log.warning("model call served by fallback %s", label)
                return
            except Exception as e:  # noqa: BLE001 — decide below whether this failure is worth a fallback
                if yielded or not exhausted(e) or i == len(attempts) - 1:
                    raise
                log.warning("%s failed (%s: %s); trying %s", label, type(e).__name__, str(e)[:120], attempts[i + 1][0])
                last = e
        if last is not None:  # pragma: no cover — the loop re-raises the last failure itself
            raise last
