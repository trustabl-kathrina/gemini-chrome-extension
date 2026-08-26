import base64
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
    r = await client.get("/healthz")
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
    r = await client.post(
        "/tool_result",
        headers=AUTH,
        json={"session_id": "s1", "call_id": "k1", "name": "request_confirmation", "result": {"confirmed": True}},
    )
    assert r.status_code == 200 and len(parse_sse(r.text)) == 2
    sent = fake.calls[0]
    fr = sent["new_message"].parts[0].function_response
    assert fr.id == "k1" and fr.name == "request_confirmation"
    assert sent["state_delta"] == {"confirmations": 1}


async def test_pubsub_envelope(client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[dict[str, Any]] = []

    async def fake_dispatch(payload: dict[str, Any]) -> dict[str, Any]:
        seen.append(payload)
        return {}

    monkeypatch.setattr("dayflow.api.pubsub.dispatch", fake_dispatch)
    data = base64.b64encode(
        json.dumps({"job": "run_skill", "user_id": "u", "skill_id": "vault-sync"}).encode()
    ).decode()
    env = {"message": {"data": data, "messageId": "m1"}, "subscription": "s"}
    assert (await client.post("/pubsub?token=wrong", json=env)).status_code == 401
    assert (await client.post("/pubsub?token=push-token", json={"nope": 1})).status_code == 400
    r = await client.post("/pubsub?token=push-token", json=env)
    assert r.status_code == 204 and seen[0]["skill_id"] == "vault-sync" and seen[0]["_message_id"] == "m1"
