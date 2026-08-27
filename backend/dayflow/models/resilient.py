"""Gemini with retries and a fallback chain, so one 429 RESOURCE_EXHAUSTED from Vertex does not end a run.

`ResilientGemini` retries each request on 429/5xx with exponential backoff (google-genai HttpRetryOptions),
and when the primary still fails, replays the request on the fallbacks in order. The primary is retried by
this class (backoff from RETRY) because google-genai's retry covers only the initial request, not a 429 that
arrives inside the stream. A failure after chunks were streamed is replayed too: ADK persists only the final
aggregated response, so the cost is a repeated partial sentence in the panel, not a broken session.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncGenerator
from typing import Any

from google.adk.models.google_llm import Gemini
from google.adk.models.llm_request import LlmRequest
from google.adk.models.llm_response import LlmResponse
from google.genai import types
from google.genai.errors import ClientError, ServerError

log = logging.getLogger("dayflow.models")

ATTEMPTS, INITIAL_DELAY, MAX_DELAY, EXP_BASE = 5, 2.0, 20.0, 2.0
RETRY = types.HttpRetryOptions(
    attempts=ATTEMPTS,
    initial_delay=INITIAL_DELAY,
    max_delay=MAX_DELAY,
    exp_base=EXP_BASE,
    jitter=0.5,
    http_status_codes=[429, 500, 502, 503, 504],
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
        # google-genai's HttpRetryOptions only cover the initial request; a 429 that arrives inside the stream
        # (the common Vertex shape) is not retried there, so the primary gets its own backoff here first.
        delays = [min(INITIAL_DELAY * (EXP_BASE**i), MAX_DELAY) for i in range(ATTEMPTS - 1)]
        schedule: list[tuple[str, Gemini, float]] = [(attempts[0][0], attempts[0][1], d) for d in delays]
        schedule += [(label, llm, 0.0) for label, llm in attempts]
        last: BaseException | None = None
        for i, (label, llm, delay_after) in enumerate(schedule):
            request = llm_request if llm is self else llm_request.model_copy(update={"model": llm.model})
            yielded = False
            try:
                async for response in Gemini.generate_content_async(llm, request, stream):
                    yielded = True
                    yield response
                if llm is not self:
                    log.warning("model call served by fallback %s", label)
                return
            except Exception as e:  # noqa: BLE001 — decide below whether this failure is worth another attempt
                if not exhausted(e) or i == len(schedule) - 1:
                    log.warning(
                        "%s failed (%s), giving up: %s", label, type(e).__name__, str(e)[:160].replace("\n", " ")
                    )
                    raise
                nxt = schedule[i + 1][0]
                log.warning(
                    "%s failed%s (%s: %s); %s%s",
                    label,
                    " after streaming part of an answer" if yielded else "",
                    type(e).__name__,
                    str(e)[:120].replace("\n", " "),
                    f"retrying in {delay_after:.0f}s" if delay_after else "trying",
                    "" if delay_after else f" {nxt}",
                )
                last = e
                if delay_after:
                    await asyncio.sleep(delay_after)
        if last is not None:  # pragma: no cover — the loop re-raises the last failure itself
            raise last
