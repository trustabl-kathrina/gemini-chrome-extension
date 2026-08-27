"""Server-side tools: document parsing and embeddings via google-genai, and vault access."""

from __future__ import annotations

import base64
from functools import lru_cache

from google.adk.tools import ToolContext
from google.genai import Client, types
from pydantic import BaseModel, Field

from dayflow.core.vault import default_vault
from dayflow.models.registry import registry

MAX_VAULT_READ_CHARS = 60_000


class ParsedDocument(BaseModel):
    title: str
    summary: str = Field(description="3–5 sentences a student can read in 20 seconds.")
    key_terms: list[str] = Field(default_factory=list, description="Up to 8 terms with a short gloss each.")
    deadlines: list[str] = Field(default_factory=list, description="ISO dates with what is due, if any.")
    course_hint: str = Field(default="", description="Course this document most likely belongs to.")


@lru_cache(maxsize=1)
def client() -> Client:
    # Reads GOOGLE_GENAI_USE_ENTERPRISE / GOOGLE_CLOUD_PROJECT / GOOGLE_CLOUD_LOCATION or GOOGLE_API_KEY.
    return Client()


async def parse_document(file_name: str, pdf_base64: str) -> dict:
    """Extracts a summary, key terms and deadlines from a PDF (Gemini structured output).

    Args:
        file_name: Original file name, used as a title hint.
        pdf_base64: The PDF bytes, base64-encoded (inline; keep under ~20 MB).
    """
    pdf = base64.b64decode(pdf_base64)
    resp = await client().aio.models.generate_content(
        model=registry().parser,
        contents=[
            types.Part.from_bytes(data=pdf, mime_type="application/pdf"),
            f"File name: {file_name}. Extract the fields of the schema for a university student.",
        ],
        config=types.GenerateContentConfig(
            response_mime_type="application/json",
            response_schema=ParsedDocument,
            thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW),
        ),
    )
    doc = ParsedDocument.model_validate_json(resp.text or "{}")
    return {"status": "success", **doc.model_dump()}


async def transcribe_pdf(file_name: str, pdf_base64: str) -> str:
    """Plain text of a PDF that has no text layer (scanned syllabi, photographed sheets): Gemini reads the pages.
    Returns "" when the model finds no readable text. Page breaks are kept as "[page N]" lines."""
    pdf = base64.b64decode(pdf_base64)
    resp = await client().aio.models.generate_content(
        model=registry().parser,
        contents=[
            types.Part.from_bytes(data=pdf, mime_type="application/pdf"),
            f"File name: {file_name}. Transcribe ALL the text of this document verbatim, page by page, in reading "
            "order; start each page with a line '[page N]'. Keep tables as text lines. Output the text only — no "
            "commentary, no markdown fences. If a page has no readable text, write '[page N] (no text)'.",
        ],
        config=types.GenerateContentConfig(
            thinking_config=types.ThinkingConfig(thinking_level=types.ThinkingLevel.LOW)
        ),
    )
    return (resp.text or "").strip()


async def embed_text(text: str) -> dict:
    """Embeds text for vault search (gemini-embedding-2, 768 dims, Firestore-compatible).

    Args:
        text: Chunk to embed (≤ 8k tokens).
    """
    reg = registry()
    resp = await client().aio.models.embed_content(
        model=reg.embed,
        contents=text,
        config=types.EmbedContentConfig(output_dimensionality=reg.embed_dims),
    )
    values = resp.embeddings[0].values if resp.embeddings and resp.embeddings[0].values else []
    return {"status": "success", "dims": len(values), "embedding": values}


async def vault_list(tool_context: ToolContext) -> dict:
    """Lists the user's vault: every file the agent downloaded, with its path, size, summary and deadlines.
    Call it after a sync to confirm what landed, or before reading a document to find its path.
    """
    entries = await default_vault().list(tool_context.user_id)
    files = [
        {
            "id": e.id,
            "path": e.path,
            "size": e.size,
            "drive_file_id": e.drive_file_id,
            "title": e.title,
            "summary": e.summary,
            "deadlines": e.deadlines,
            **({"parse_error": e.parse_error} if e.parse_error else {}),
        }
        for e in entries
    ]
    return {"status": "success", "count": len(files), "files": files}


async def vault_read(path_or_id: str, tool_context: ToolContext) -> dict:
    """Returns the extracted text of one vault file (PDF text via the brain, or the file itself for text
    formats) so you can work with its content — syllabus topics, lab tasks, notes.

    Args:
        path_or_id: The vault entry id, its full path, or just the file name (e.g. "Lab_01_Image_Basics.pdf").
    """
    vault = default_vault()
    entry = await vault.resolve(tool_context.user_id, path_or_id)
    if entry is None:
        return {"status": "error", "error": f"No vault file matches '{path_or_id}'. Call vault_list to see paths."}
    text = await vault.text(tool_context.user_id, entry)
    truncated = len(text) > MAX_VAULT_READ_CHARS
    return {
        "status": "success",
        "id": entry.id,
        "path": entry.path,
        "summary": entry.summary,
        "deadlines": entry.deadlines,
        "text": text[:MAX_VAULT_READ_CHARS],
        "truncated": truncated,
    }


SERVER_TOOLS = [parse_document, embed_text, vault_list, vault_read]
