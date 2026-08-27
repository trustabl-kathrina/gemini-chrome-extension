"""Vault store + /vault routes + vault_list / vault_read server tools."""

from collections.abc import AsyncIterator, Iterator
from typing import Any

import httpx
import pytest

from dayflow.api.app import create_app
from dayflow.core.loader import MemoryConfigStore
from dayflow.core.vault import (
    MemoryBlobStore,
    MemoryVaultIndex,
    VaultStore,
    extract_text,
    normalize_path,
    set_default_vault,
)
from dayflow.tools.server import vault_list, vault_read
from tests.helpers import make_pdf
from tests.test_api import AUTH, FakeRunner

PARSED = {
    "status": "success",
    "title": "Lab 1: Image Basics",
    "summary": "Five numpy tasks on image arrays.",
    "key_terms": ["numpy"],
    "deadlines": ["2026-09-15 Lab 1 due"],
    "course_hint": "CSCI3240",
}


class Ctx:
    """The only part of ToolContext the vault tools use."""

    def __init__(self, user_id: str) -> None:
        self.user_id = user_id


@pytest.fixture
def vault() -> Iterator[VaultStore]:
    store = VaultStore(MemoryBlobStore(), MemoryVaultIndex())
    set_default_vault(store)
    yield store
    set_default_vault(None)


@pytest.fixture
async def client(vault: VaultStore) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(store=MemoryConfigStore(), runner=FakeRunner(), vault=vault)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        yield c


def test_normalize_path_rejects_traversal_and_empty() -> None:
    assert normalize_path("/CSCI3240 CV/../Lab 01//a.pdf/") == "CSCI3240 CV/Lab 01/a.pdf"
    assert normalize_path("a\\b\\c.txt") == "a/b/c.txt"
    with pytest.raises(ValueError):
        normalize_path("/../")


def test_extract_text_pdf_and_text() -> None:
    assert "Lab 1 tasks" in extract_text(make_pdf("Lab 1 tasks"), "application/pdf", "lab.pdf")
    assert extract_text(b"# notes", "text/markdown", "n.md") == "# notes"
    assert extract_text(b"# notes", "application/octet-stream", "n.md") == "# notes"
    assert extract_text(b"\x00\x01", "application/octet-stream", "blob.bin") == ""
    assert extract_text(b"%PDF-broken", "application/pdf", "x.pdf") == ""  # broken PDF → no text, no crash


async def test_store_add_list_resolve_text(vault: VaultStore) -> None:
    pdf = make_pdf("Welcome to computer vision")
    e1 = await vault.add("u", "CSCI3240 Intro to CV/Lab 01/Lab_01.pdf", pdf, drive_file_id="d1", parsed=PARSED)
    e2 = await vault.add("u", "CSCI3240 Intro to CV/Materials/syllabus.pdf", pdf)
    assert e1.summary == PARSED["summary"] and e1.deadlines == PARSED["deadlines"] and e1.drive_file_id == "d1"
    assert e2.title == "syllabus.pdf" and e2.summary == ""
    assert [e.path for e in await vault.list("u")] == [e1.path, e2.path]
    assert await vault.list("someone-else") == []
    # Same path → same id; unchanged bytes keep the parsed fields; drive id survives.
    again = await vault.add("u", e1.path, pdf)
    assert again.id == e1.id and again.summary == e1.summary and again.drive_file_id == "d1"
    assert len(await vault.list("u")) == 2
    # Changed bytes without a new parse → fields reset (the route re-parses in that case).
    changed = await vault.add("u", e1.path, make_pdf("v2"))
    assert changed.id == e1.id and changed.summary == "" and changed.sha256 != e1.sha256
    assert await vault.resolve("u", e1.id) is not None
    assert (await vault.resolve("u", "lab_01.pdf")).id == e1.id  # type: ignore[union-attr]
    assert (await vault.resolve("u", "Materials/syllabus.pdf")).id == e2.id  # type: ignore[union-attr]
    assert (await vault.resolve("u", "syllabus")).id == e2.id  # type: ignore[union-attr]
    assert await vault.resolve("u", "nope.pdf") is None and await vault.resolve("u", "") is None
    assert "Welcome to computer vision" in await vault.text("u", e2)
    assert await vault.data("u", e2) == pdf


async def test_vault_tools_use_the_caller_identity(vault: VaultStore) -> None:
    await vault.add("u", "C/Materials/syllabus.md", b"# Week 1: intro\n# Week 2: filters", parsed=None)
    listed = await vault_list(Ctx("u"))  # type: ignore[arg-type]
    assert listed["count"] == 1 and listed["files"][0]["path"] == "C/Materials/syllabus.md"
    assert (await vault_list(Ctx("other")))["count"] == 0  # type: ignore[arg-type]
    read = await vault_read("syllabus.md", Ctx("u"))  # type: ignore[arg-type]
    assert read["status"] == "success" and "Week 2: filters" in read["text"] and read["truncated"] is False
    miss = await vault_read("syllabus.md", Ctx("other"))  # type: ignore[arg-type]
    assert miss["status"] == "error" and "vault_list" in miss["error"]


async def test_upload_parses_pdfs_and_lists(client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []

    async def fake_parse(file_name: str, pdf_base64: str) -> dict[str, Any]:
        calls.append(file_name)
        return PARSED

    monkeypatch.setattr("dayflow.api.vault.parse_document", fake_parse)
    pdf = make_pdf("Task 1: load the image as a numpy array")
    form = {"path": "CSCI3240 Introduction to Computer Vision/Lab 01/Lab_01_Image_Basics.pdf", "drive_file_id": "drv-1"}
    r = await client.post(
        "/vault/upload", headers=AUTH, data=form, files={"file": ("Lab_01.pdf", pdf, "application/pdf")}
    )
    assert r.status_code == 200, r.text
    entry = r.json()
    assert entry["path"] == form["path"] and entry["drive_file_id"] == "drv-1" and entry["size"] == len(pdf)
    assert entry["summary"] == PARSED["summary"] and entry["deadlines"] == PARSED["deadlines"]
    assert calls == ["Lab_01_Image_Basics.pdf"]
    # Same bytes again (a re-sync): stored, not re-parsed.
    r = await client.post("/vault/upload", headers=AUTH, data={"path": form["path"]}, files={"file": ("x.pdf", pdf)})
    assert r.status_code == 200 and r.json()["id"] == entry["id"] and r.json()["drive_file_id"] == "drv-1"
    assert calls == ["Lab_01_Image_Basics.pdf"]
    listed = (await client.get("/vault", headers=AUTH)).json()
    assert isinstance(listed, list) and [e["path"] for e in listed] == [form["path"]]
    text = await client.get(f"/vault/{entry['id']}/text", headers=AUTH)
    assert text.status_code == 200 and "numpy array" in text.text
    assert (await client.get(f"/vault/{entry['id']}", headers=AUTH)).json()["sha256"] == entry["sha256"]
    assert (await client.get("/vault/nope/text", headers=AUTH)).status_code == 404
    # Non-PDF files are stored without parsing.
    r = await client.post(
        "/vault/upload", headers=AUTH, data={"path": "C/Materials/notes.md"}, files={"file": ("notes.md", b"# hi")}
    )
    assert r.status_code == 200 and r.json()["summary"] == "" and calls == ["Lab_01_Image_Basics.pdf"]
    assert (await client.get(f"/vault/{r.json()['id']}/text", headers=AUTH)).text == "# hi"


async def test_upload_survives_parser_failure_and_validates_input(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def boom(file_name: str, pdf_base64: str) -> dict[str, Any]:
        raise RuntimeError("Gemini unavailable")

    monkeypatch.setattr("dayflow.api.vault.parse_document", boom)
    r = await client.post(
        "/vault/upload", headers=AUTH, data={"path": "C/Materials/s.pdf"}, files={"file": ("s.pdf", make_pdf("x"))}
    )
    assert r.status_code == 200 and r.json()["parse_error"] == "RuntimeError: Gemini unavailable"
    assert r.json()["summary"] == "" and len((await client.get("/vault", headers=AUTH)).json()) == 1
    assert (
        await client.post("/vault/upload", data={"path": "a/b.pdf"}, files={"file": ("b.pdf", b"x")})
    ).status_code == 401
    assert (
        await client.post("/vault/upload", headers=AUTH, data={"path": "../"}, files={"file": ("b", b"x")})
    ).status_code == 422
    assert (
        await client.post("/vault/upload", headers=AUTH, data={"path": "a/b"}, files={"file": ("b", b"")})
    ).status_code == 422
    assert (await client.post("/vault/upload", headers=AUTH, files={"file": ("b", b"x")})).status_code == 422
    assert (await client.get("/vault")).status_code == 401


async def test_upload_transcribes_scanned_pdfs_with_gemini(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A PDF without a text layer (scanned syllabus) gets Gemini transcription as its text; a text PDF does not."""
    transcribed: list[str] = []

    async def fake_parse(file_name: str, pdf_base64: str) -> dict[str, Any]:
        return PARSED

    async def fake_transcribe(file_name: str, pdf_base64: str) -> str:
        transcribed.append(file_name)
        return "[page 1]\nCyber Security Fundamentals — syllabus\nWeek 01: Threat landscape"

    monkeypatch.setattr("dayflow.api.vault.parse_document", fake_parse)
    monkeypatch.setattr("dayflow.api.vault.transcribe_pdf", fake_transcribe)
    monkeypatch.setattr(
        "dayflow.api.vault.extract_text", lambda data, ctype, name="": ""
    )  # what pypdf yields on a scan
    scanned = make_pdf("scan")
    r = await client.post(
        "/vault/upload",
        headers=AUTH,
        data={"path": "CSF Cyber Security Fundamentals/Materials/syllabus.pdf"},
        files={"file": ("syllabus.pdf", scanned, "application/pdf")},
    )
    assert r.status_code == 200, r.text
    text = await client.get(f"/vault/{r.json()['id']}/text", headers=AUTH)
    assert text.status_code == 200 and "Week 01: Threat landscape" in text.text
    assert transcribed == ["syllabus.pdf"]
    # Re-upload of the same bytes: no second transcription, the stored text survives.
    r2 = await client.post(
        "/vault/upload",
        headers=AUTH,
        data={"path": "CSF Cyber Security Fundamentals/Materials/syllabus.pdf"},
        files={"file": ("syllabus.pdf", scanned, "application/pdf")},
    )
    assert r2.status_code == 200 and r2.json()["id"] == r.json()["id"] and transcribed == ["syllabus.pdf"]
    again = await client.get(f"/vault/{r.json()['id']}/text", headers=AUTH)
    assert "Week 01: Threat landscape" in again.text
    # A PDF with a text layer is never sent for transcription.
    monkeypatch.setattr("dayflow.api.vault.extract_text", lambda data, ctype, name="": "x" * 500)
    r3 = await client.post(
        "/vault/upload",
        headers=AUTH,
        data={"path": "CSF/Lab 01/2.1.7.pdf"},
        files={"file": ("2.1.7.pdf", make_pdf("lab"), "application/pdf")},
    )
    assert r3.status_code == 200 and transcribed == ["syllabus.pdf"]


def test_extract_text_docx_and_zip() -> None:
    import io
    import zipfile

    from dayflow.core.vault import extract_text

    doc_xml = (
        '<?xml version="1.0"?><w:document xmlns:w="x"><w:body>'
        "<w:p><w:r><w:t>Practice 1: Hashing</w:t></w:r></w:p>"
        '<w:p><w:r><w:t xml:space="preserve">Implement </w:t></w:r><w:r><w:t>SHA-256</w:t></w:r>'
        "<w:tab/><w:r><w:t>in Python &amp; test</w:t></w:r></w:p>"
        "<w:p/></w:body></w:document>"
    )
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("word/document.xml", doc_xml)
    text = extract_text(buf.getvalue(), "", "Practice №1.docx")
    assert text == "Practice 1: Hashing\nImplement SHA-256\tin Python & test"

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr("repo-main/README.md", "# PP2 labs\nLab 1: variables")
        z.writestr("repo-main/lab1/task.py", "print('hi')")
        z.writestr("repo-main/img/logo.png", b"\x89PNG....")
    text = extract_text(buf.getvalue(), "application/zip", "programming-principles-2-main.zip")
    assert text.startswith("[zip] repo-main/README.md, repo-main/lab1/task.py, repo-main/img/logo.png")
    assert (
        "[file repo-main/README.md]\n# PP2 labs" in text
        and "print('hi')" in text
        and "PNG" not in text.split("\n", 1)[1]
    )
    assert extract_text(b"not a zip", "", "x.docx") == "" and extract_text(b"nope", "application/zip", "x.zip") == ""
