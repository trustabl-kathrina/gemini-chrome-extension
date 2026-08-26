"""Job handlers for the worker runtime. Jobs arrive as Pub/Sub messages: {"job": name, ...}."""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from typing import Any

from dayflow.core.loader import firestore_enabled
from dayflow.tools.server import parse_document

log = logging.getLogger("dayflow.workers")
Handler = Callable[[dict[str, Any]], Awaitable[dict[str, Any]]]


async def parse_document_job(payload: dict[str, Any]) -> dict[str, Any]:
    """Parse a PDF and store the result under users/{uid}/documents/{doc_id}."""
    user_id = str(payload["user_id"])
    doc_id = str(payload["doc_id"])
    parsed = await parse_document(str(payload.get("file_name", doc_id)), str(payload["pdf_base64"]))
    if firestore_enabled():
        from google.cloud import firestore

        db = firestore.AsyncClient()
        await db.collection("users").document(user_id).collection("documents").document(doc_id).set(parsed)
    log.info("parsed %s for %s: %s", doc_id, user_id, parsed.get("title"))
    return parsed


async def run_skill_job(payload: dict[str, Any]) -> dict[str, Any]:
    """Scheduled skill run. The browser must execute it, so the worker only records the request;
    the extension polls /jobs (TODO) and runs it in a pinned tab."""
    log.info("scheduled skill %s for %s", payload.get("skill_id"), payload.get("user_id"))
    return {"queued": True, **{k: v for k, v in payload.items() if not k.startswith("_")}}


HANDLERS: dict[str, Handler] = {
    "parse_document": parse_document_job,
    "run_skill": run_skill_job,
}


async def dispatch(payload: dict[str, Any]) -> dict[str, Any]:
    name = str(payload.get("job"))
    handler = HANDLERS.get(name)
    if handler is None:
        raise ValueError(f"unknown job '{name}'")
    return await handler(payload)
