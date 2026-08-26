"""Server-side tools: document parsing and embeddings via google-genai."""

from __future__ import annotations

import base64
from functools import lru_cache

from google.genai import Client, types
from pydantic import BaseModel, Field

from dayflow.models.registry import registry


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


SERVER_TOOLS = [parse_document, embed_text]
