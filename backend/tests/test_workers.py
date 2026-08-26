from typing import Any

import pytest

from dayflow.core.loader import MemoryConfigStore
from dayflow.workers.handlers import dispatch, parse_document_job, source_allowed


def test_source_allowed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DAYFLOW_BUCKET", "our-bucket")
    assert source_allowed("gs://our-bucket/u1/doc.pdf", [])
    assert not source_allowed("gs://other-bucket/doc.pdf", [])
    assert source_allowed("https://wsp.kbtu.kz/files/1.pdf", ["wsp.kbtu.kz"])
    assert not source_allowed("https://evil.com/1.pdf", ["wsp.kbtu.kz"])
    assert not source_allowed("http://wsp.kbtu.kz/1.pdf", ["wsp.kbtu.kz"])
    assert not source_allowed("file:///etc/passwd", ["wsp.kbtu.kz"])


async def test_dispatch_refuses_unverified() -> None:
    with pytest.raises(PermissionError):
        await dispatch({"job": "run_skill", "user_id": "local", "skill_id": "vault-sync"}, verified=False)


async def test_run_skill_validates_skill() -> None:
    store = MemoryConfigStore()
    ok = await dispatch({"job": "run_skill", "user_id": "local", "skill_id": "vault-sync"}, verified=True, store=store)
    assert ok["queued"] is True
    with pytest.raises(ValueError):
        await dispatch({"job": "run_skill", "user_id": "local", "skill_id": "nope"}, verified=True, store=store)
    with pytest.raises(ValueError):
        await dispatch({"job": "nope"}, verified=True, store=store)


async def test_parse_document_rejects_disallowed_source(monkeypatch: pytest.MonkeyPatch) -> None:
    fetched: list[str] = []

    async def fake_fetch(url: str) -> bytes:
        fetched.append(url)
        return b"%PDF"

    async def fake_parse(name: str, b64: str) -> dict[str, Any]:
        return {"title": name}

    monkeypatch.setattr("dayflow.workers.handlers._fetch_pdf", fake_fetch)
    monkeypatch.setattr("dayflow.workers.handlers.parse_document", fake_parse)
    store = MemoryConfigStore()
    with pytest.raises(PermissionError):
        await parse_document_job({"user_id": "local", "doc_id": "d", "source_url": "https://evil.com/x.pdf"}, store)
    assert fetched == []
    out = await parse_document_job(
        {"user_id": "local", "doc_id": "d", "source_url": "https://wsp.kbtu.kz/x.pdf"}, store
    )
    assert fetched == ["https://wsp.kbtu.kz/x.pdf"] and out["title"] == "d"
    with pytest.raises(ValueError):
        await parse_document_job({"user_id": "local", "doc_id": "d"}, store)
