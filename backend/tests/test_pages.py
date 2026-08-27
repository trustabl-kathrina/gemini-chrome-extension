"""PageStore + GET /pages/{kind}/{id}."""

from collections.abc import AsyncIterator, Iterator

import httpx
import pytest
from fastapi import FastAPI

from dayflow.api.app import create_app
from dayflow.core.loader import MemoryConfigStore
from dayflow.core.pages import PageStore, set_default_pages
from dayflow.core.vault import MemoryBlobStore
from tests.test_api import FakeRunner


def test_the_deployed_privacy_policy_is_the_repo_one() -> None:
    """`gcloud run deploy --source backend` ships backend/ only, so /pages/privacy serves the copy embedded
    in the module. A drift between the two publishes a policy the product no longer follows."""
    from dayflow.api.pages import PRIVACY_FILE, PRIVACY_MD

    assert PRIVACY_FILE.exists(), "run from the repo checkout"
    assert PRIVACY_MD == PRIVACY_FILE.read_text(encoding="utf-8"), (
        "docs/PRIVACY.md changed without updating PRIVACY_MD in dayflow/api/pages.py"
    )


@pytest.fixture
def pages() -> Iterator[PageStore]:
    store = PageStore(MemoryBlobStore(), public_url="")
    yield store
    set_default_pages(None)


@pytest.fixture
def app(pages: PageStore) -> FastAPI:
    app = create_app(store=MemoryConfigStore(), runner=FakeRunner(), pages=pages)  # type: ignore[arg-type]
    return app


@pytest.fixture
async def client(app: FastAPI) -> AsyncIterator[httpx.AsyncClient]:
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://brain.test") as c:
        yield c


async def test_put_returns_unguessable_id_and_public_url(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DAYFLOW_PUBLIC_URL", "https://dayflow-brain.run.app/")
    store = PageStore(MemoryBlobStore())
    page = await store.put("courseware", "<h1>Quiz</h1>")
    assert page["url"] == f"https://dayflow-brain.run.app/pages/courseware/{page['id']}"
    assert len(page["id"]) >= 20 and store.valid_id(page["id"])
    assert await store.get("courseware", page["id"]) == "<h1>Quiz</h1>"
    assert await store.get("courseware", "short") is None and await store.get("report", page["id"]) is None
    with pytest.raises(ValueError):
        await store.put("Bad Kind", "<p>x</p>")


async def test_get_page_is_public_and_learns_base_url(
    client: httpx.AsyncClient, pages: PageStore, app: FastAPI
) -> None:
    assert pages.base_url == ""
    assert (await client.get("/health")).status_code == 200
    assert pages.base_url == "", "an arbitrary Host header must never seed public links"
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://127.0.0.1:8100") as local:
        assert (await local.get("/health")).status_code == 200
    # a trusted (loopback) host seeds the base URL when DAYFLOW_PUBLIC_URL is unset
    assert pages.base_url == "http://127.0.0.1:8100"
    page = await pages.put("report", "<html><body>Lab 1 report</body></html>")
    assert page["url"].startswith("http://127.0.0.1:8100/pages/report/")
    r = await client.get(page["url"])  # no auth header on purpose
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/html") and "Lab 1 report" in r.text
    assert (await client.get("/pages/report/does-not-exist-0123456")).status_code == 404
    assert (await client.get("/pages/../x")).status_code in (404, 422)
