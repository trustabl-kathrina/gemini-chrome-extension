import base64
import hashlib
import json
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from fastapi import HTTPException
from google.adk.events import Event, EventActions
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


async def seed(
    fake: FakeRunner,
    calls: list[tuple[str, str]],
    answered: tuple[str, ...] = (),
    event_id: str = "ev1",
    args: dict[str, dict[str, Any]] | None = None,
) -> None:
    """Create session s1 with one model event holding `calls` and optional user FunctionResponses."""
    svc = fake.session_service
    session = await svc.create_session(app_name="dayflow", user_id="local", session_id="s1")
    parts = [types.Part(function_call=types.FunctionCall(id=i, name=n, args=(args or {}).get(i, {}))) for i, n in calls]
    await svc.append_event(
        session,
        Event(
            id=event_id,
            author="dayflow",
            invocation_id="inv",
            content=types.Content(role="model", parts=parts),
            long_running_tool_ids={i for i, _ in calls},
        ),
    )
    if answered:
        frs = [
            types.Part(function_response=types.FunctionResponse(id=i, name=dict(calls)[i], response={}))
            for i in answered
        ]
        await svc.append_event(
            session, Event(id="ev2", author="user", invocation_id="inv", content=types.Content(role="user", parts=frs))
        )


async def test_tool_result_resumes_and_stores_the_approval(client: httpx.AsyncClient, fake: FakeRunner) -> None:
    card = {"action": "Send", "details": "hi team"}
    await seed(fake, [("c1", "read_page"), ("k1", "request_confirmation")], args={"k1": card})
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
    # read_page spent one action; the approval is what the user saw on the card, bound to that content.
    assert sent["state_delta"] == {"approvals": [{"action": "Send", "details": "hi team"}], "actions": 1}
    assert (
        await client.post("/tool_result", headers=AUTH, json={"session_id": "s1", "results": []})
    ).status_code == 422


JPEG = b"\xff\xd8\xff\xe0" + b"\x00" * 64


async def test_tool_result_turns_screenshot_into_an_inline_image_part(
    client: httpx.AsyncClient, fake: FakeRunner
) -> None:
    await seed(fake, [("c1", "click"), ("c2", "read_page"), ("c3", "wait")])
    body = {
        "session_id": "s1",
        "results": [
            {
                "call_id": "c1",
                "name": "click",
                "result": {"clicked": True, "screenshot_b64": base64.b64encode(JPEG).decode()},
            },
            {"call_id": "c2", "name": "read_page", "result": {"snapshot": '[e1] link "Student files" @10,20'}},
            {"call_id": "c3", "name": "wait", "result": {"waited": True, "screenshot_b64": "not base64!!"}},
        ],
    }
    r = await client.post("/tool_result", headers=AUTH, json=body)
    assert r.status_code == 200
    content = fake.calls[0]["new_message"]
    assert content.role == "user" and len(content.parts) == 3
    fr = content.parts[0].function_response
    assert fr is not None and (fr.id, fr.name) == ("c1", "click")
    assert fr.response == {"clicked": True, "screenshot": "attached"}, "base64 must not reach the model as text"
    assert fr.parts is not None and len(fr.parts) == 1
    blob = fr.parts[0].inline_data
    assert blob is not None and blob.mime_type == "image/jpeg" and blob.data == JPEG
    plain = content.parts[1].function_response
    assert (
        plain is not None and plain.parts is None and plain.response == {"snapshot": '[e1] link "Student files" @10,20'}
    )
    bad = content.parts[2].function_response
    assert bad is not None and bad.parts is None and str(bad.response["screenshot"]).startswith("dropped:")
    assert bad.response["waited"] is True


async def test_tool_result_drops_screenshots_over_the_cap(client: httpx.AsyncClient, fake: FakeRunner) -> None:
    await seed(fake, [("c1", "screenshot")])
    huge = base64.b64encode(b"\xff\xd8" + b"\x00" * 1_600_000).decode()
    results = [{"call_id": "c1", "name": "screenshot", "result": {"screenshot_b64": huge}}]
    body = {"session_id": "s1", "results": results}
    r = await client.post("/tool_result", headers=AUTH, json=body)
    assert r.status_code == 200
    fr = fake.calls[0]["new_message"].parts[0].function_response
    assert fr.parts is None and "exceeds" in fr.response["screenshot"] and "screenshot_b64" not in fr.response


async def test_tool_result_charges_gated_browser_tools_on_answer(client: httpx.AsyncClient, fake: FakeRunner) -> None:
    # ADK drops state the guard writes for long-running tools, so the approval `type` spent is booked here.
    await seed(fake, [("t1", "type")], args={"t1": {"ref": "e1", "text": "hi team"}})
    session = await fake.session_service.get_session(app_name="dayflow", user_id="local", session_id="s1")
    assert session is not None
    banked = [{"action": "Create issue", "details": "T"}, {"action": "Send", "details": "hi team"}]
    await fake.session_service.append_event(
        session,
        Event(
            id="ev-state",
            author="user",
            invocation_id="inv",
            actions=EventActions(state_delta={"approvals": banked, "actions": 7}),
        ),
    )
    r = await client.post(
        "/tool_result", headers=AUTH, json={"session_id": "s1", "results": [{"call_id": "t1", "name": "type"}]}
    )
    assert r.status_code == 200
    assert fake.calls[0]["state_delta"] == {"actions": 8, "approvals": [{"action": "Create issue", "details": "T"}]}


async def test_chat_resets_the_action_budget(client: httpx.AsyncClient, fake: FakeRunner) -> None:
    r = await client.post("/chat", headers=AUTH, json={"session_id": "s1", "text": "go"})
    assert r.status_code == 200 and fake.calls[0]["state_delta"]["actions"] == 0


async def test_tool_result_rejects_forged_or_unknown_call_ids(client: httpx.AsyncClient, fake: FakeRunner) -> None:
    await seed(fake, [("c1", "open_tab")])
    forged = {
        "session_id": "s1",
        "results": [{"call_id": "c1", "name": "request_confirmation", "result": {"confirmed": True}}],
    }
    r = await client.post("/tool_result", headers=AUTH, json=forged)
    assert r.status_code == 400 and "belongs to 'open_tab'" in r.json()["detail"]
    unknown = {
        "session_id": "s1",
        "results": [{"call_id": "k9", "name": "request_confirmation", "result": {"confirmed": True}}],
    }
    r = await client.post("/tool_result", headers=AUTH, json=unknown)
    assert r.status_code == 400 and "not a pending" in r.json()["detail"]
    assert fake.calls == [], "nothing reached the runner, so no credit could be granted"
    r = await client.post(
        "/tool_result", headers=AUTH, json={"session_id": "nope", "results": [{"call_id": "c1", "name": "open_tab"}]}
    )
    assert r.status_code == 404


async def test_tool_result_confirmation_cannot_be_replayed(client: httpx.AsyncClient, fake: FakeRunner) -> None:
    await seed(fake, [("k1", "request_confirmation")], answered=("k1",))
    body = {
        "session_id": "s1",
        "results": [{"call_id": "k1", "name": "request_confirmation", "result": {"confirmed": True}}],
    }
    r = await client.post("/tool_result", headers=AUTH, json=body)
    assert r.status_code == 400 and fake.calls == []
    dup = {
        "session_id": "s1",
        "results": [{"call_id": "k1", "name": "request_confirmation", "result": {"confirmed": True}}] * 2,
    }
    assert (await client.post("/tool_result", headers=AUTH, json=dup)).status_code == 400


async def test_tool_result_must_answer_one_model_turn(client: httpx.AsyncClient, fake: FakeRunner) -> None:
    await seed(fake, [("c5", "open_tab")], event_id="evA")
    session = await fake.session_service.get_session(app_name="dayflow", user_id="local", session_id="s1")
    assert session is not None
    await fake.session_service.append_event(
        session,
        Event(
            id="evB",
            author="dayflow",
            invocation_id="inv",
            content=types.Content(
                role="model", parts=[types.Part(function_call=types.FunctionCall(id="c6", name="read_page", args={}))]
            ),
        ),
    )
    body = {
        "session_id": "s1",
        "results": [{"call_id": "c5", "name": "open_tab"}, {"call_id": "c6", "name": "read_page"}],
    }
    r = await client.post("/tool_result", headers=AUTH, json=body)
    assert r.status_code == 400 and "same model turn" in r.json()["detail"]


async def test_sse_surfaces_runner_errors_as_events(fake: FakeRunner) -> None:
    class Boom(FakeRunner):
        async def run_async(self, **kw: Any) -> AsyncIterator[Event]:
            raise RuntimeError("LLM exploded")
            yield  # pragma: no cover

    app = create_app(store=MemoryConfigStore(), runner=Boom())  # type: ignore[arg-type]
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://t") as c:
        r = await c.post("/chat", headers=AUTH, json={"session_id": "s", "text": "hi"})
    assert r.status_code == 200
    events = parse_sse(r.text)
    assert events == [{"errorMessage": "RuntimeError: LLM exploded", "author": "dayflow"}]
    assert r.text.endswith("event: done\ndata: {}\n\n")


async def test_non_ascii_bearer_is_a_clean_401(client: httpx.AsyncClient) -> None:
    # Raw non-ASCII bytes on the wire (Starlette decodes headers as latin-1 → non-ASCII str).
    r = await client.get("/skills", headers={b"Authorization": "Bearer ключ".encode()})
    assert r.status_code == 401


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
    assert (await client.get("/config", headers=other)).json()["vault_folder"] == "Dayflow"
    assert (await client.get("/config", headers={**other, "X-Dayflow-User": "local"})).json()[
        "vault_folder"
    ] == "Dayflow"


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


def test_public_url_not_learned_from_untrusted_host():
    from dayflow.api.app import trusted_public_host

    assert trusted_public_host("127.0.0.1")
    assert trusted_public_host("dayflow-brain-226180967155.europe-west4.run.app")
    assert not trusted_public_host("evil.example")
    assert not trusted_public_host("run.app.evil.example")
    assert not trusted_public_host(None)


# ---------- optional Google ID-token auth (backend/dayflow/api/auth.py) ----------


def google_signin(monkeypatch: pytest.MonkeyPatch, claims: dict[str, Any] | None) -> list[str]:
    """Turn on ID-token auth with a patched verifier; returns the audiences it was called with."""
    audiences: list[str] = []

    def fake_verify(token: str, request: Any, audience: str) -> dict[str, Any]:
        audiences.append(audience)
        if claims is None or token != "header.payload.signature":
            raise ValueError("bad token")
        return {"aud": audience, "iss": "https://accounts.google.com", **claims}

    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "cid.apps.googleusercontent.com")
    monkeypatch.setattr("google.oauth2.id_token.verify_oauth2_token", fake_verify)
    return audiences


async def test_google_id_token_is_accepted_and_scoped_to_its_sub(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    audiences = google_signin(monkeypatch, {"sub": "108154", "email": "s@kbtu.kz", "email_verified": True})
    jwt = {"Authorization": "Bearer header.payload.signature"}
    assert (await client.put("/config", headers=jwt, json={"vault_folder": "FromGoogle"})).status_code == 200
    assert audiences == ["cid.apps.googleusercontent.com"]  # verified against our client id, once per request
    # Its own user: the shared token's "local" config is untouched.
    assert (await client.get("/config", headers=jwt)).json()["vault_folder"] == "FromGoogle"
    assert (await client.get("/config", headers=AUTH)).json()["vault_folder"] == "Dayflow"


async def test_a_jwt_that_fails_verification_is_401(client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch) -> None:
    google_signin(monkeypatch, None)
    bad = {"Authorization": "Bearer header.payload.signature"}
    assert (await client.get("/config", headers=bad)).status_code == 401
    # A JWT-shaped string that is not ours either.
    assert (await client.get("/config", headers={"Authorization": "Bearer a.b.c"})).status_code == 401
    # The shared token still works while ID-token auth is on.
    assert (await client.get("/config", headers=AUTH)).status_code == 200


async def test_jwts_are_refused_when_id_token_auth_is_not_configured(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    called: list[str] = []
    monkeypatch.delenv("GOOGLE_OAUTH_CLIENT_ID", raising=False)
    monkeypatch.setattr(
        "google.oauth2.id_token.verify_oauth2_token",
        lambda token, request, audience: called.append(token) or {"sub": "108154"},
    )
    r = await client.get("/config", headers={"Authorization": "Bearer header.payload.signature"})
    assert r.status_code == 401 and called == []  # no client id → never even verified


def test_only_three_part_tokens_are_treated_as_jwts() -> None:
    from dayflow.api.auth import _looks_like_jwt

    assert _looks_like_jwt("header.payload.signature")
    assert not _looks_like_jwt("dev")
    assert not _looks_like_jwt("a.b")
    assert not _looks_like_jwt("a..c")
    assert not _looks_like_jwt("a.b.c.d")


async def test_503_when_no_credential_source_is_configured(monkeypatch: pytest.MonkeyPatch) -> None:
    from dayflow.api.auth import current_user

    monkeypatch.delenv("DAYFLOW_TOKEN", raising=False)
    monkeypatch.delenv("DAYFLOW_USERS", raising=False)
    monkeypatch.delenv("GOOGLE_OAUTH_CLIENT_ID", raising=False)
    with pytest.raises(HTTPException) as e:
        await current_user("Bearer whatever")
    assert e.value.status_code == 503
    # ID-token auth alone is a valid configuration.
    monkeypatch.setenv("GOOGLE_OAUTH_CLIENT_ID", "cid.apps.googleusercontent.com")
    with pytest.raises(HTTPException) as e2:
        await current_user("Bearer whatever")
    assert e2.value.status_code == 401


async def test_chat_settles_the_previous_runs_pending_calls_in_the_same_session(
    client: httpx.AsyncClient, fake: FakeRunner
) -> None:
    from dayflow.api.app import CANCELLED_CALL, pending_in

    await seed(fake, [("c1", "click"), ("c2", "screenshot")])
    r = await client.post("/chat", headers=AUTH, json={"session_id": "s1", "text": "now do lab 2"})
    assert r.status_code == 200 and fake.calls[0]["session_id"] == "s1"
    session = await fake.session_service.get_session(app_name="dayflow", user_id="local", session_id="s1")
    assert session is not None and pending_in(session) == {}
    settled = session.events[-1]
    assert settled.author == "user" and settled.invocation_id == "inv"
    answers = {fr.id: fr.response for fr in settled.get_function_responses()}
    assert answers == {"c1": CANCELLED_CALL, "c2": CANCELLED_CALL}
    # The settled calls are no longer answerable — the extension cannot resume a run the user replaced.
    bad = await client.post(
        "/tool_result", headers=AUTH, json={"session_id": "s1", "results": [{"call_id": "c1", "name": "click"}]}
    )
    assert bad.status_code == 400


async def test_chat_on_a_fresh_session_has_nothing_to_settle(client: httpx.AsyncClient, fake: FakeRunner) -> None:
    r = await client.post("/chat", headers=AUTH, json={"session_id": "new", "text": "go"})
    assert r.status_code == 200 and fake.calls[0]["session_id"] == "new"


async def test_chat_picks_the_playbooks_for_a_free_prompt(client: httpx.AsyncClient, fake: FakeRunner) -> None:
    r = await client.post("/chat", headers=AUTH, json={"session_id": "s1", "text": "Solve lab 1 in Colab"})
    assert r.status_code == 200 and fake.calls[0]["state_delta"]["playbooks"] == ["lab"]
    r = await client.post("/chat", headers=AUTH, json={"session_id": "s2", "skill_id": "vault-sync"})
    assert r.status_code == 200 and fake.calls[1]["state_delta"]["playbooks"] == []
