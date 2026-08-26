import base64
import hashlib
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from google.adk.events import Event
from google.adk.sessions import InMemorySessionService
from google.genai import types

from dayflow.api.app import create_app
from dayflow.core.loader import MemoryConfigStore

AUTH = {"Authorization": "Bearer test-token"}


class FakeRunner:
    """Stands in for the ADK Runner: yields a text event, then a long-running browser tool call."""

    def __init__(self) -> None:
        self.session_service = InMemorySessionService()
        self.calls: list[dict[str, Any]] = []

    async def run_async(self, **kw: Any) -> AsyncIterator[Event]:
        self.calls.append(kw)
        yield Event(
            author="dayflow",
            invocation_id="inv1",
            content=types.Content(role="model", parts=[types.Part(text="Opening WSP.")]),
        )
        yield Event(
            author="dayflow",
            invocation_id="inv1",
            content=types.Content(
                role="model",
                parts=[
                    types.Part(
                        function_call=types.FunctionCall(id="c1", name="open_tab", args={"url": "https://wsp.kbtu.kz"})
                    )
                ],
            ),
            long_running_tool_ids={"c1"},
        )


@pytest.fixture
def fake() -> FakeRunner:
    return FakeRunner()


@pytest.fixture
async def client(fake: FakeRunner) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(store=MemoryConfigStore(), runner=fake)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        yield c


def parse_sse(body: str) -> list[dict[str, Any]]:
    return [json.loads(line[6:]) for line in body.splitlines() if line.startswith("data: ") and line != "data: {}"]


async def test_healthz(client: httpx.AsyncClient) -> None:
    r = await client.get("/health")
    assert r.status_code == 200 and r.json()["ok"] is True


async def test_auth_required(client: httpx.AsyncClient) -> None:
    assert (await client.get("/skills")).status_code == 401
    assert (await client.get("/skills", headers={"Authorization": "Bearer nope"})).status_code == 401


async def test_skills(client: httpx.AsyncClient) -> None:
    r = await client.get("/skills", headers=AUTH)
    assert r.status_code == 200
    assert [s["id"] for s in r.json()][:2] == ["vault-sync", "courseware"]


async def test_chat_streams_events_with_long_running_ids(client: httpx.AsyncClient, fake: FakeRunner) -> None:
    r = await client.post("/chat", headers=AUTH, json={"session_id": "s1", "skill_id": "vault-sync"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("text/event-stream")
    events = parse_sse(r.text)
    assert len(events) == 2
    assert events[0]["content"]["parts"][0]["text"] == "Opening WSP."
    assert events[1]["longRunningToolIds"] == ["c1"]
    assert events[1]["content"]["parts"][0]["functionCall"]["name"] == "open_tab"
    assert "event: done" in r.text
    sent = fake.calls[0]
    assert sent["new_message"].parts[0].text.startswith("Sync all course files")  # skill prompt used
    assert sent["state_delta"]["skill_id"] == "vault-sync"


async def test_chat_rejects_unknown_skill_and_empty_text(client: httpx.AsyncClient) -> None:
    assert (await client.post("/chat", headers=AUTH, json={"session_id": "s1", "skill_id": "nope"})).status_code == 404
    assert (await client.post("/chat", headers=AUTH, json={"session_id": "s1", "text": "  "})).status_code == 422


async def test_tool_result_resumes_and_adds_confirmation_credit(client: httpx.AsyncClient, fake: FakeRunner) -> None:
    body = {
        "session_id": "s1",
        "results": [
            {"call_id": "c1", "name": "read_page", "result": {"snapshot": "# WSP"}},
            {"call_id": "k1", "name": "request_confirmation", "result": {"confirmed": True}},
        ],
    }
    r = await client.post("/tool_result", headers=AUTH, json=body)
    assert r.status_code == 200 and len(parse_sse(r.text)) == 2
    sent = fake.calls[0]
    frs = [p.function_response for p in sent["new_message"].parts]
    assert [(f.id, f.name) for f in frs] == [("c1", "read_page"), ("k1", "request_confirmation")]
    assert sent["state_delta"] == {"confirmations": 1}
    assert (
        await client.post("/tool_result", headers=AUTH, json={"session_id": "s1", "results": []})
    ).status_code == 422


async def test_user_id_is_derived_server_side_not_from_headers(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    spoof = {**AUTH, "X-Dayflow-User": "victim"}
    await client.put("/config", headers=spoof, json={"vault_folder": "Spoofed"})
    # The write landed on the token's own user ("local"), not on "victim".
    assert (await client.get("/config", headers=AUTH)).json()["vault_folder"] == "Spoofed"
    # A second token maps to its own user via DAYFLOW_USERS.
    monkeypatch.setenv("DAYFLOW_USERS", f"{hashlib.sha256(b'other-token').hexdigest()}=u2")
    other = {"Authorization": "Bearer other-token"}
    assert (await client.get("/config", headers=other)).json()["vault_folder"] == "DayflowVault"
    assert (await client.get("/config", headers={**other, "X-Dayflow-User": "local"})).json()[
        "vault_folder"
    ] == "DayflowVault"


def oidc(monkeypatch: pytest.MonkeyPatch, claims: dict[str, Any] | None) -> None:
    """Stub Google's token verification: return claims, or raise like a bad token."""

    def fake_verify(token: str, request: Any, audience: str) -> dict[str, Any]:
        if claims is None:
            raise ValueError("bad token")
        return {**claims, "aud": audience}

    monkeypatch.setattr("google.oauth2.id_token.verify_oauth2_token", fake_verify)


def envelope(payload: dict[str, Any]) -> dict[str, Any]:
    data = base64.b64encode(json.dumps(payload).encode()).decode()
    return {"message": {"data": data, "messageId": "m1"}, "subscription": "s"}


async def test_pubsub_requires_oidc_from_push_sa(client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[dict[str, Any]] = []

    async def fake_dispatch(payload: dict[str, Any], *, verified: bool, store: Any = None) -> dict[str, Any]:
        assert verified is True
        seen.append(payload)
        return {}

    monkeypatch.setattr("dayflow.api.pubsub.dispatch", fake_dispatch)
    env = envelope({"job": "run_skill", "user_id": "u", "skill_id": "vault-sync"})
    bearer = {"Authorization": "Bearer id-token"}
    assert (await client.post("/pubsub", json=env)).status_code == 401  # no token
    oidc(monkeypatch, None)
    assert (await client.post("/pubsub", headers=bearer, json=env)).status_code == 401  # invalid token
    oidc(monkeypatch, {"email": "someone@else", "email_verified": True})
    assert (await client.post("/pubsub", headers=bearer, json=env)).status_code == 401  # wrong SA
    oidc(monkeypatch, {"email": "push@sa", "email_verified": True})
    assert (await client.post("/pubsub", headers=bearer, json={"nope": 1})).status_code == 400
    r = await client.post("/pubsub", headers=bearer, json=env)
    assert r.status_code == 204 and seen[0]["skill_id"] == "vault-sync" and seen[0]["_message_id"] == "m1"


async def test_pubsub_verify_bypass_only_off_cloud_run(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def fake_dispatch(payload: dict[str, Any], *, verified: bool, store: Any = None) -> dict[str, Any]:
        return {}

    monkeypatch.setattr("dayflow.api.pubsub.dispatch", fake_dispatch)
    env = envelope({"job": "run_skill", "user_id": "u", "skill_id": "vault-sync"})
    monkeypatch.setenv("PUBSUB_VERIFY", "0")
    assert (await client.post("/pubsub", json=env)).status_code == 204  # local dev: allowed
    monkeypatch.setenv("K_SERVICE", "dayflow-brain")
    assert (await client.post("/pubsub", json=env)).status_code == 401  # on Cloud Run: never


async def test_cron_rejects_user_token_and_accepts_scheduler_sa(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    oidc(monkeypatch, None)
    assert (await client.post("/cron", headers=AUTH)).status_code == 401
    oidc(monkeypatch, {"email": "push@sa", "email_verified": True})
    assert (await client.post("/cron", headers={"Authorization": "Bearer t"})).status_code == 401
    oidc(monkeypatch, {"email": "cron@sa", "email_verified": True})
    r = await client.post("/cron", headers={"Authorization": "Bearer t"})
    assert r.status_code == 200 and "enqueued" in r.json()
