"""PageStore: HTML artifacts the brain generates (courseware, lab reports, deck previews) served at
GET /pages/{kind}/{id}. No auth: the id is unguessable (128 bits) and the pages are the user's own output."""

from __future__ import annotations

import os
import re
import secrets
from typing import Any

from dayflow.core.vault import BlobStore, make_blob_store

KIND_RE = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{16,64}$")


class PageStore:
    def __init__(self, blobs: BlobStore | None = None, public_url: str | None = None) -> None:
        self.blobs = blobs or make_blob_store()
        # DAYFLOW_PUBLIC_URL wins; otherwise the API fills base_url from the first request it serves.
        self.base_url = (public_url if public_url is not None else os.getenv("DAYFLOW_PUBLIC_URL", "")).rstrip("/")

    @staticmethod
    def _key(kind: str, page_id: str) -> str:
        return f"pages/{kind}/{page_id}.html"

    @staticmethod
    def valid_kind(kind: str) -> bool:
        return bool(KIND_RE.match(kind))

    @staticmethod
    def valid_id(page_id: str) -> bool:
        return bool(ID_RE.match(page_id))

    def url_for(self, kind: str, page_id: str) -> str:
        return f"{self.base_url}/pages/{kind}/{page_id}"

    async def put(self, kind: str, html: str) -> dict[str, Any]:
        """Stores an HTML page and returns {id, url}."""
        if not self.valid_kind(kind):
            raise ValueError(f"invalid page kind '{kind}' (lowercase letters, digits, dashes)")
        page_id = secrets.token_urlsafe(16)
        await self.blobs.put(self._key(kind, page_id), html.encode(), "text/html; charset=utf-8")
        return {"id": page_id, "url": self.url_for(kind, page_id)}

    async def get(self, kind: str, page_id: str) -> str | None:
        if not (self.valid_kind(kind) and self.valid_id(page_id)):
            return None
        raw = await self.blobs.get(self._key(kind, page_id))
        return raw.decode("utf-8", errors="replace") if raw is not None else None


_default: PageStore | None = None


def default_pages() -> PageStore:
    global _default
    if _default is None:
        _default = PageStore()
    return _default


def set_default_pages(store: PageStore | None) -> None:
    global _default
    _default = store
