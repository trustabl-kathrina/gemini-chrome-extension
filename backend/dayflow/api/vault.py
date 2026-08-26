"""Vault routes: the extension posts every downloaded file here (besides Drive) so the brain can parse
and index it; the panel and the harness list the index; the model reads extracted text."""

from __future__ import annotations

import base64
import hashlib
import logging
from typing import Annotated, Any

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile, status
from fastapi.responses import PlainTextResponse

from dayflow.api.auth import current_user
from dayflow.core.vault import VaultEntry, VaultStore, guess_content_type, is_pdf, normalize_path
from dayflow.tools.server import parse_document

log = logging.getLogger("dayflow.vault")
router = APIRouter(prefix="/vault", tags=["vault"])
MAX_UPLOAD_BYTES = 50 * 1024 * 1024
MAX_PARSE_BYTES = 20 * 1024 * 1024  # inline PDF limit for Gemini


def vault_of(request: Request) -> VaultStore:
    return request.app.state.vault


async def parse_pdf(name: str, data: bytes) -> tuple[dict[str, Any] | None, str]:
    """(parsed fields, error). Never raises: a parser outage must not lose the file."""
    if len(data) > MAX_PARSE_BYTES:
        return None, "PDF exceeds 20 MB; not parsed"
    try:
        parsed = await parse_document(name, base64.b64encode(data).decode())
    except Exception as e:  # noqa: BLE001 — Gemini/network errors are recorded on the entry, the upload succeeds
        log.exception("parse_document failed for %s", name)
        return None, f"{type(e).__name__}: {e}"
    return parsed, ""


@router.post("/upload", response_model=VaultEntry)
async def upload(
    request: Request,
    path: Annotated[str, Form()],
    file: Annotated[UploadFile, File()],
    drive_file_id: Annotated[str | None, Form()] = None,
    user_id: str = Depends(current_user),
) -> VaultEntry:
    try:
        clean = normalize_path(path)
    except ValueError as e:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, str(e)) from e
    data = await file.read(MAX_UPLOAD_BYTES + 1)
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(status.HTTP_413_CONTENT_TOO_LARGE, "file exceeds 50 MB")
    if not data:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "empty file")
    name = clean.rsplit("/", 1)[-1]
    ctype = guess_content_type(name, file.content_type or "")
    vault = vault_of(request)
    parsed: dict[str, Any] | None = None
    error = ""
    if is_pdf(data, ctype):
        existing = await vault.find_by_path(user_id, clean)
        digest = hashlib.sha256(data).hexdigest()
        unchanged = existing is not None and bool(existing.summary) and existing.sha256 == digest
        if not unchanged:
            parsed, error = await parse_pdf(name, data)
    entry = await vault.add(
        user_id, clean, data, content_type=ctype, drive_file_id=drive_file_id or None, parsed=parsed, parse_error=error
    )
    log.info("vault upload user=%s path=%s bytes=%d parsed=%s", user_id, entry.path, entry.size, bool(parsed))
    return entry


@router.get("", response_model=list[VaultEntry])
async def list_vault(request: Request, user_id: str = Depends(current_user)) -> list[VaultEntry]:
    return await vault_of(request).list(user_id)


@router.get("/{entry_id}", response_model=VaultEntry)
async def get_entry(entry_id: str, request: Request, user_id: str = Depends(current_user)) -> VaultEntry:
    entry = await vault_of(request).get(user_id, entry_id)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"no vault entry '{entry_id}'")
    return entry


@router.get("/{entry_id}/text", response_class=PlainTextResponse)
async def get_text(entry_id: str, request: Request, user_id: str = Depends(current_user)) -> str:
    vault = vault_of(request)
    entry = await vault.get(user_id, entry_id)
    if entry is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"no vault entry '{entry_id}'")
    return await vault.text(user_id, entry)
