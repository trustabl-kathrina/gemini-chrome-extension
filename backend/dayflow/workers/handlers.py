"""Job handlers for the worker runtime. Jobs arrive as Pub/Sub messages: {"job": name, ...}.

Trust model: a payload is only acted on when it came through the OIDC-verified /pubsub path
(`dispatch(..., verified=True)`). Document sources are restricted to our GCS bucket or hosts on
the user's navigation allow-list — the same check the orchestrator applies to browser navigation.
"""

from __future__ import annotations

import base64
import logging
import os
from collections.abc import Awaitable, Callable
from typing import Any
from urllib.parse import urlparse

import httpx

from dayflow.agents.orchestrator import host_allowed, host_of
from dayflow.core.loader import ConfigStore, firestore_enabled, make_config_store
from dayflow.tools.server import parse_document

log = logging.getLogger("dayflow.workers")
Handler = Callable[[dict[str, Any], ConfigStore], Awaitable[dict[str, Any]]]
MAX_PDF_BYTES = 20 * 1024 * 1024


def source_allowed(url: str, allowed_hosts: list[str]) -> bool:
    """gs://<DAYFLOW_BUCKET>/... or https://<allow-listed host>/... only."""
    parsed = urlparse(url)
    if parsed.scheme == "gs":
        bucket = os.getenv("DAYFLOW_BUCKET")
        return bool(bucket) and parsed.netloc == bucket
    if parsed.scheme == "https":
        return bool(allowed_hosts) and host_allowed(host_of(url), allowed_hosts)
    return False


async def _fetch_pdf(url: str) -> bytes:
    headers: dict[str, str] = {}
    if url.startswith("gs://"):
        import google.auth
        from google.auth.transport import requests as ga_requests

        bucket, _, name = url[5:].partition("/")
        creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/devstorage.read_only"])
        creds.refresh(ga_requests.Request())
        headers["Authorization"] = f"Bearer {creds.token}"
        from urllib.parse import quote

        url = f"https://storage.googleapis.com/storage/v1/b/{bucket}/o/{quote(name, safe='')}?alt=media"
    async with httpx.AsyncClient(timeout=30, follow_redirects=False) as http:
        r = await http.get(url, headers=headers)
        r.raise_for_status()
        if len(r.content) > MAX_PDF_BYTES:
            raise ValueError("document exceeds 20 MB")
        return r.content


async def parse_document_job(payload: dict[str, Any], store: ConfigStore) -> dict[str, Any]:
    """Parse a PDF (inline base64 or an allow-listed source URL) → users/{uid}/documents/{doc_id}."""
    user_id = str(payload["user_id"])
    doc_id = str(payload["doc_id"])
    if "pdf_base64" in payload:
        pdf_b64 = str(payload["pdf_base64"])
    elif "source_url" in payload:
        url = str(payload["source_url"])
        cfg = await store.get(user_id)
        if not source_allowed(url, cfg.permissions.allowed_hosts):
            log.error("rejected document source %s for user %s", url, user_id)
            raise PermissionError(f"document source not allowed: {url}")
        pdf_b64 = base64.b64encode(await _fetch_pdf(url)).decode()
    else:
        raise ValueError("parse_document needs pdf_base64 or source_url")
    parsed = await parse_document(str(payload.get("file_name", doc_id)), pdf_b64)
    if firestore_enabled():
        from google.cloud import firestore

        db = firestore.AsyncClient()
        await db.collection("users").document(user_id).collection("documents").document(doc_id).set(parsed)
    log.info("parsed %s for %s: %s", doc_id, user_id, parsed.get("title"))
    return parsed


async def run_skill_job(payload: dict[str, Any], store: ConfigStore) -> dict[str, Any]:
    """Scheduled skill run. The browser must execute it, so the worker only records the request;
    the extension polls /jobs (TODO) and runs it in a pinned tab."""
    user_id, skill_id = str(payload.get("user_id")), str(payload.get("skill_id"))
    cfg = await store.get(user_id)
    if cfg.skill(skill_id) is None:
        raise ValueError(f"skill '{skill_id}' is unknown or disabled for user '{user_id}'")
    log.info("scheduled skill %s for %s", skill_id, user_id)
    return {"queued": True, "user_id": user_id, "skill_id": skill_id}


HANDLERS: dict[str, Handler] = {
    "parse_document": parse_document_job,
    "run_skill": run_skill_job,
}


async def dispatch(payload: dict[str, Any], *, verified: bool, store: ConfigStore | None = None) -> dict[str, Any]:
    if not verified:
        raise PermissionError("refusing to run a job from an unverified source")
    name = str(payload.get("job"))
    handler = HANDLERS.get(name)
    if handler is None:
        raise ValueError(f"unknown job '{name}'")
    return await handler(payload, store or make_config_store())
