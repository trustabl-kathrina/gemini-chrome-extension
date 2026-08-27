"""The brain's copy of the user's vault (PLAN v2 §Drive & vault).

Files live in a blob store (GCS bucket `DAYFLOW_BUCKET` when set, memory otherwise) and are indexed
per user (Firestore `users/{uid}/vault/{id}` when Firestore is on, memory otherwise). The index holds
what the model needs to reason about a file without re-reading it: path, sha256, size, summary,
deadlines and the Drive file id the extension uploaded it under.
"""

from __future__ import annotations

import asyncio
import hashlib
import html
import io
import logging
import os
import posixpath
import secrets
from datetime import UTC, datetime
from typing import Any, Protocol

from pydantic import BaseModel, Field

from dayflow.core.loader import firestore_enabled

log = logging.getLogger("dayflow.vault")

TEXT_TYPES = ("text/", "application/json", "application/x-ipynb+json", "application/xml")
TEXT_SUFFIXES = (".txt", ".md", ".markdown", ".csv", ".json", ".ipynb", ".html", ".htm", ".py", ".yaml", ".yml")
MAX_TEXT_CHARS = 200_000


class VaultEntry(BaseModel):
    id: str
    path: str = Field(
        description='Vault-relative path, e.g. "CSCI3240 Introduction to Computer Vision/Lab 01/Lab_01.pdf".'
    )
    sha256: str
    size: int
    content_type: str = ""
    drive_file_id: str | None = None
    title: str = ""
    summary: str = ""
    deadlines: list[str] = Field(default_factory=list)
    key_terms: list[str] = Field(default_factory=list)
    parse_error: str = Field(default="", description="Why parse_document failed on upload, if it did.")
    parse_pending: bool = Field(default=False, description="Gemini is still summarising/transcribing this file.")
    updated_at: str = ""

    @property
    def name(self) -> str:
        return posixpath.basename(self.path)


# ---------- blobs ----------


class BlobStore(Protocol):
    async def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None: ...
    async def get(self, key: str) -> bytes | None: ...


class MemoryBlobStore:
    def __init__(self) -> None:
        self._data: dict[str, bytes] = {}

    async def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
        self._data[key] = data

    async def get(self, key: str) -> bytes | None:
        return self._data.get(key)


class GcsBlobStore:
    """google-cloud-storage is sync; calls run in a worker thread so the event loop stays free."""

    def __init__(self, bucket: str, client: Any | None = None) -> None:
        from google.cloud import storage

        self._bucket = (client or storage.Client()).bucket(bucket)

    async def put(self, key: str, data: bytes, content_type: str = "application/octet-stream") -> None:
        blob = self._bucket.blob(key)
        await asyncio.to_thread(blob.upload_from_string, data, content_type=content_type)

    async def get(self, key: str) -> bytes | None:
        from google.api_core.exceptions import NotFound

        blob = self._bucket.blob(key)
        try:
            return await asyncio.to_thread(blob.download_as_bytes)
        except NotFound:
            return None


def make_blob_store() -> BlobStore:
    bucket = os.getenv("DAYFLOW_BUCKET")
    return GcsBlobStore(bucket) if bucket else MemoryBlobStore()


# ---------- index ----------


class VaultIndex(Protocol):
    async def upsert(self, user_id: str, entry: VaultEntry) -> None: ...
    async def get(self, user_id: str, entry_id: str) -> VaultEntry | None: ...
    async def list(self, user_id: str) -> list[VaultEntry]: ...


class MemoryVaultIndex:
    def __init__(self) -> None:
        self._data: dict[str, dict[str, VaultEntry]] = {}

    async def upsert(self, user_id: str, entry: VaultEntry) -> None:
        self._data.setdefault(user_id, {})[entry.id] = entry

    async def get(self, user_id: str, entry_id: str) -> VaultEntry | None:
        return self._data.get(user_id, {}).get(entry_id)

    async def list(self, user_id: str) -> list[VaultEntry]:
        return sorted(self._data.get(user_id, {}).values(), key=lambda e: e.path.lower())


class FirestoreVaultIndex:
    """users/{uid}/vault/{id}"""

    def __init__(self, client: Any | None = None) -> None:
        from google.cloud import firestore

        self._db = client or firestore.AsyncClient()

    def _col(self, user_id: str):
        return self._db.collection("users").document(user_id).collection("vault")

    async def upsert(self, user_id: str, entry: VaultEntry) -> None:
        await self._col(user_id).document(entry.id).set(entry.model_dump(mode="json"))

    async def get(self, user_id: str, entry_id: str) -> VaultEntry | None:
        snap = await self._col(user_id).document(entry_id).get()
        return VaultEntry.model_validate(snap.to_dict() or {}) if snap.exists else None

    async def list(self, user_id: str) -> list[VaultEntry]:
        entries = [VaultEntry.model_validate(d.to_dict() or {}) async for d in self._col(user_id).stream()]
        return sorted(entries, key=lambda e: e.path.lower())


def make_vault_index() -> VaultIndex:
    return FirestoreVaultIndex() if firestore_enabled() else MemoryVaultIndex()


# ---------- helpers ----------


def normalize_path(path: str) -> str:
    """Vault-relative POSIX path: no leading slashes, no '.'/'..' segments, single separators."""
    cleaned = path.replace("\\", "/").strip()
    parts = [p.strip() for p in cleaned.split("/") if p.strip() not in ("", ".", "..")]
    if not parts:
        raise ValueError("path must name a file")
    return "/".join(parts)


def guess_content_type(name: str, declared: str = "") -> str:
    if declared and declared != "application/octet-stream":
        return declared
    lower = name.lower()
    if lower.endswith(".pdf"):
        return "application/pdf"
    if lower.endswith((".md", ".markdown", ".txt", ".py", ".yaml", ".yml", ".csv")):
        return "text/plain"
    if lower.endswith((".html", ".htm")):
        return "text/html"
    if lower.endswith(".ipynb"):
        return "application/x-ipynb+json"
    if lower.endswith(".json"):
        return "application/json"
    if lower.endswith(".pptx"):
        return "application/vnd.openxmlformats-officedocument.presentationml.presentation"
    return declared or "application/octet-stream"


def is_pdf(data: bytes, content_type: str = "") -> bool:
    return data.startswith(b"%PDF-") or content_type == "application/pdf"


def extract_text(data: bytes, content_type: str, name: str = "") -> str:
    """Plain text for the model: pypdf for PDFs, utf-8 for text-like files, '' otherwise."""
    if is_pdf(data, content_type):
        try:
            from pypdf import PdfReader

            reader = PdfReader(io.BytesIO(data))
            pages = [(page.extract_text() or "").strip() for page in reader.pages]
            return "\n\n".join(f"[page {i + 1}]\n{t}" for i, t in enumerate(pages) if t)[:MAX_TEXT_CHARS]
        except Exception as e:  # noqa: BLE001 — a broken PDF must not block the upload; the summary still works
            log.warning("pypdf failed on %s: %s", name or "<pdf>", e)
            return ""
    if content_type.startswith(TEXT_TYPES) or name.lower().endswith(TEXT_SUFFIXES):
        return data.decode("utf-8", errors="replace")[:MAX_TEXT_CHARS]
    if name.lower().endswith(".docx") or content_type == DOCX_TYPE:
        return docx_text(data, name)[:MAX_TEXT_CHARS]
    if name.lower().endswith(".zip") or content_type == "application/zip":
        return zip_text(data, name)[:MAX_TEXT_CHARS]
    return ""


DOCX_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
ZIP_TEXT_SUFFIXES = TEXT_SUFFIXES + (
    ".py",
    ".ipynb",
    ".java",
    ".c",
    ".cpp",
    ".h",
    ".js",
    ".ts",
    ".sql",
    ".sh",
    ".cfg",
    ".ini",
)
ZIP_MAX_MEMBER = 200_000


def docx_text(data: bytes, name: str = "") -> str:
    """Paragraph text of a .docx (word/document.xml): lab sheets at KBTU are often Word files. No python-docx —
    the XML is read directly: <w:p> = paragraph, <w:t> = text run, <w:tab/> = tab, <w:br/> = line break."""
    import re as _re
    import zipfile

    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            xml = z.read("word/document.xml").decode("utf-8", errors="replace")
    except (zipfile.BadZipFile, KeyError, OSError) as e:
        log.warning("docx unreadable %s: %s", name or "<docx>", e)
        return ""
    paragraphs: list[str] = []
    for para in _re.findall(r"<w:p[ >].*?</w:p>", xml, flags=_re.S):
        para = _re.sub(r"<w:tab/>", "<w:t>\t</w:t>", para)  # keep tabs/breaks: only <w:t> text survives below
        para = _re.sub(r"<w:br/>", "<w:t>\n</w:t>", para)
        text = "".join(_re.findall(r"<w:t(?:\s[^>]*)?>(.*?)</w:t>", para, flags=_re.S))
        text = html.unescape(text).strip()
        if text:
            paragraphs.append(text)
    return "\n".join(paragraphs)


def zip_text(data: bytes, name: str = "") -> str:
    """A listing of a .zip plus the text of its readable members (markdown, code, notebooks): assignment bundles
    arrive as repo zips. Members over ZIP_MAX_MEMBER bytes and binaries are listed by name only."""
    import zipfile

    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except (zipfile.BadZipFile, OSError) as e:
        log.warning("zip unreadable %s: %s", name or "<zip>", e)
        return ""
    with z:
        members = [m for m in z.infolist() if not m.is_dir()]
        out = ["[zip] " + ", ".join(m.filename for m in members[:200])]
        for m in members:
            if not m.filename.lower().endswith(ZIP_TEXT_SUFFIXES) or m.file_size > ZIP_MAX_MEMBER:
                continue
            try:
                body = z.read(m).decode("utf-8", errors="replace")
            except (zipfile.BadZipFile, OSError, RuntimeError):
                continue
            out.append(f"[file {m.filename}]\n{body}")
            if sum(len(o) for o in out) > MAX_TEXT_CHARS:
                break
    return "\n\n".join(out)


# ---------- store ----------


class VaultStore:
    def __init__(self, blobs: BlobStore | None = None, index: VaultIndex | None = None) -> None:
        self.blobs = blobs or make_blob_store()
        self.index = index or make_vault_index()

    @staticmethod
    def _key(user_id: str, entry_id: str, suffix: str = "") -> str:
        return f"vault/{user_id}/{entry_id}{suffix}"

    async def find_by_path(self, user_id: str, path: str) -> VaultEntry | None:
        wanted = normalize_path(path).lower()
        return next((e for e in await self.index.list(user_id) if e.path.lower() == wanted), None)

    async def add(
        self,
        user_id: str,
        path: str,
        data: bytes,
        *,
        content_type: str = "",
        drive_file_id: str | None = None,
        parsed: dict[str, Any] | None = None,
        parse_error: str = "",
        text: str | None = None,
    ) -> VaultEntry:
        """Store bytes + extracted text and upsert the index entry. Same path → same id (replaces)."""
        clean = normalize_path(path)
        name = posixpath.basename(clean)
        ctype = guess_content_type(name, content_type)
        existing = await self.find_by_path(user_id, clean)
        entry = VaultEntry(
            id=existing.id if existing else secrets.token_hex(8),
            path=clean,
            sha256=hashlib.sha256(data).hexdigest(),
            size=len(data),
            content_type=ctype,
            drive_file_id=drive_file_id or (existing.drive_file_id if existing else None),
            updated_at=datetime.now(UTC).isoformat(timespec="seconds"),
        )
        if parsed:
            entry.title = str(parsed.get("title") or name)
            entry.summary = str(parsed.get("summary") or "")
            entry.deadlines = [str(d) for d in parsed.get("deadlines") or []]
            entry.key_terms = [str(k) for k in parsed.get("key_terms") or []]
        elif existing and existing.sha256 == entry.sha256:
            entry.title, entry.summary = existing.title, existing.summary
            entry.deadlines, entry.key_terms = existing.deadlines, existing.key_terms
        else:
            entry.title = name
        entry.parse_error = parse_error
        if text is None:
            text = extract_text(data, ctype, name)
        await self.blobs.put(self._key(user_id, entry.id), data, ctype)
        await self.blobs.put(self._key(user_id, entry.id, ".txt"), text.encode(), "text/plain")
        await self.index.upsert(user_id, entry)
        return entry

    async def enrich(
        self,
        user_id: str,
        entry: VaultEntry,
        *,
        parsed: dict[str, Any] | None,
        parse_error: str = "",
        text: str | None = None,
    ) -> VaultEntry:
        """Fills the summary fields (and the text, when a transcription replaced pypdf's) after a background parse."""
        current = await self.index.get(user_id, entry.id) or entry
        if current.sha256 != entry.sha256:
            return current  # the file changed underneath the parse: its own upload owns the entry now
        if parsed:
            current.title = str(parsed.get("title") or current.title)
            current.summary = str(parsed.get("summary") or "")
            current.deadlines = [str(d) for d in parsed.get("deadlines") or []]
            current.key_terms = [str(k) for k in parsed.get("key_terms") or []]
        current.parse_error = parse_error
        current.parse_pending = False
        if text is not None:
            await self.blobs.put(self._key(user_id, current.id, ".txt"), text.encode(), "text/plain")
        await self.index.upsert(user_id, current)
        return current

    async def list(self, user_id: str) -> list[VaultEntry]:
        return await self.index.list(user_id)

    async def get(self, user_id: str, entry_id: str) -> VaultEntry | None:
        return await self.index.get(user_id, entry_id)

    async def resolve(self, user_id: str, path_or_id: str) -> VaultEntry | None:
        """Entry by id, exact path, or (case-insensitive) path suffix / file name — the model rarely has the id."""
        needle = path_or_id.strip()
        if not needle:
            return None
        if entry := await self.index.get(user_id, needle):
            return entry
        entries = await self.index.list(user_id)
        lowered = needle.replace("\\", "/").strip("/").lower()
        for match in (
            lambda e: e.path.lower() == lowered,
            lambda e: e.path.lower().endswith("/" + lowered),
            lambda e: e.name.lower() == posixpath.basename(lowered),
            lambda e: lowered in e.path.lower(),
        ):
            hits = [e for e in entries if match(e)]
            if len(hits) == 1:
                return hits[0]
            if hits:
                return sorted(hits, key=lambda e: len(e.path))[0]
        return None

    async def text(self, user_id: str, entry: VaultEntry) -> str:
        raw = await self.blobs.get(self._key(user_id, entry.id, ".txt"))
        return raw.decode("utf-8", errors="replace") if raw is not None else ""

    async def data(self, user_id: str, entry: VaultEntry) -> bytes | None:
        return await self.blobs.get(self._key(user_id, entry.id))


_default: VaultStore | None = None


def default_vault() -> VaultStore:
    """Process-wide store shared by the API routes and the server tools."""
    global _default
    if _default is None:
        _default = VaultStore()
    return _default


def set_default_vault(store: VaultStore | None) -> None:
    global _default
    _default = store
