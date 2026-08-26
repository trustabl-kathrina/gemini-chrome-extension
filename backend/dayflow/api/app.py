"""Dayflow brain: FastAPI + ADK Runner. Each LLM turn is one short SSE stream; browser tool
calls end the turn and the extension resumes it via POST /tool_result."""

from __future__ import annotations

import base64
import binascii
import json
import logging
import os
from collections.abc import AsyncIterator
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from google.adk.agents.run_config import RunConfig, StreamingMode  # pyright: ignore[reportPrivateImportUsage]
from google.adk.apps import App
from google.adk.runners import Runner
from google.adk.sessions import BaseSessionService, InMemorySessionService, Session
from google.genai import types
from pydantic import BaseModel, Field

from dayflow.agents.orchestrator import ACTIONS_KEY, DOMAINS_KEY, SKILL_KEY, build_root_agent, result_state_delta
from dayflow.api.auth import current_user
from dayflow.api.oidc import verify_google_oidc
from dayflow.api.pages import router as pages_router
from dayflow.api.pubsub import router as pubsub_router
from dayflow.api.vault import router as vault_router
from dayflow.core.loader import ConfigStore, firestore_enabled, make_config_store
from dayflow.core.models import Skill, UserConfig
from dayflow.core.pages import PageStore, default_pages, set_default_pages
from dayflow.core.vault import VaultStore, default_vault, set_default_vault
from dayflow.scheduler import run_once

log = logging.getLogger("dayflow.api")
APP_NAME = "dayflow"
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}
SCREENSHOT_KEY = "screenshot_b64"
MAX_SCREENSHOT_BYTES = 1_500_000  # decoded; the extension sends JPEG ≤1280px q≈55, typically 100–200 KB


class ChatRequest(BaseModel):
    session_id: str
    text: str = ""
    skill_id: str | None = None
    domains: list[str] = Field(default_factory=list)


class ToolResult(BaseModel):
    call_id: str
    name: str
    result: dict[str, Any] = Field(default_factory=dict)


class ToolResultRequest(BaseModel):
    """One message may resolve several pending long-running calls."""

    session_id: str
    results: list[ToolResult] = Field(min_length=1)


def decode_screenshot(raw: str) -> tuple[bytes, str]:
    """Base64 (optionally a data: URL) → (bytes, mime). Raises ValueError on bad input."""
    payload = raw.split(",", 1)[1] if raw.startswith("data:") else raw
    try:
        data = base64.b64decode(payload, validate=True)
    except (binascii.Error, ValueError) as e:
        raise ValueError(f"screenshot_b64 is not valid base64: {e}") from e
    if not data:
        raise ValueError("screenshot_b64 is empty")
    mime = "image/png" if data.startswith(b"\x89PNG") else "image/jpeg"
    return data, mime


def function_response_part(r: ToolResult) -> types.Part:
    """FunctionResponse for one browser result. `screenshot_b64` leaves the JSON dict and becomes an inline
    image part (FunctionResponse.parts) so the model sees the page, not a base64 string."""
    response = dict(r.result)
    raw = response.pop(SCREENSHOT_KEY, None)
    parts: list[types.FunctionResponsePart] | None = None
    if isinstance(raw, str) and raw:
        try:
            data, mime = decode_screenshot(raw)
        except ValueError as e:
            log.warning("call %s (%s): %s", r.call_id, r.name, e)
            response["screenshot"] = f"dropped: {e}"
        else:
            if len(data) > MAX_SCREENSHOT_BYTES:
                log.warning("call %s (%s): screenshot %d bytes exceeds cap, dropped", r.call_id, r.name, len(data))
                response["screenshot"] = f"dropped: {len(data)} bytes exceeds the {MAX_SCREENSHOT_BYTES} byte cap"
            else:
                parts = [types.FunctionResponsePart(inline_data=types.FunctionResponseBlob(mime_type=mime, data=data))]
                response["screenshot"] = "attached"
    elif raw is not None:
        response["screenshot"] = "dropped: screenshot_b64 must be a base64 string"
    return types.Part(
        function_response=types.FunctionResponse(id=r.call_id, name=r.name, response=response, parts=parts)
    )


def make_session_service() -> BaseSessionService:
    if firestore_enabled():
        from google.adk.integrations.firestore.firestore_session_service import FirestoreSessionService

        return FirestoreSessionService()
    return InMemorySessionService()


def make_runner(store: ConfigStore) -> Runner:
    return Runner(
        app=App(name=APP_NAME, root_agent=build_root_agent(store)),
        session_service=make_session_service(),
        auto_create_session=True,
    )


def sse(
    runner: Runner, user_id: str, session_id: str, content: types.Content, state_delta: dict[str, Any] | None
) -> AsyncIterator[str]:
    async def gen() -> AsyncIterator[str]:
        try:
            async for ev in runner.run_async(
                user_id=user_id,
                session_id=session_id,
                new_message=content,
                state_delta=state_delta,
                run_config=RunConfig(streaming_mode=StreamingMode.SSE),
            ):
                yield f"data: {ev.model_dump_json(exclude_none=True, by_alias=True)}\n\n"
        except Exception as e:  # noqa: BLE001 — surface any failure as an ADK-shaped event, never an empty 200
            log.exception("run failed for user=%s session=%s", user_id, session_id)
            err = {"errorMessage": f"{type(e).__name__}: {e}", "author": "dayflow"}
            yield f"data: {json.dumps(err)}\n\n"
        finally:
            yield "event: done\ndata: {}\n\n"

    return gen()


async def pending_calls(runner: Runner, user_id: str, session_id: str) -> tuple[Session, dict[str, tuple[str, str]]]:
    """The session and call_id -> (tool name, event id) for FunctionCalls that have no FunctionResponse yet."""
    session = await runner.session_service.get_session(app_name=APP_NAME, user_id=user_id, session_id=session_id)
    if session is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, f"unknown session '{session_id}'")
    answered = {fr.id for ev in session.events for fr in ev.get_function_responses()}
    return session, {
        fc.id: (fc.name or "", ev.id)
        for ev in session.events
        for fc in ev.get_function_calls()
        if fc.id and fc.id not in answered
    }


def create_app(
    store: ConfigStore | None = None,
    runner: Runner | None = None,
    vault: VaultStore | None = None,
    pages: PageStore | None = None,
) -> FastAPI:
    store = store or make_config_store()
    app = FastAPI(title="Dayflow brain", version="0.1.0")
    app.state.store = store
    app.state.runner = runner or make_runner(store)
    # The server tools (vault_list / vault_read, page builders) reach these through the module defaults,
    # so an injected store must also become the default.
    if vault is not None:
        set_default_vault(vault)
    if pages is not None:
        set_default_pages(pages)
    app.state.vault = default_vault()
    app.state.pages = default_pages()
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"chrome-extension://.*|http://localhost(:\d+)?",
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(pubsub_router)
    app.include_router(vault_router)
    app.include_router(pages_router)

    @app.middleware("http")
    async def learn_public_url(request: Request, call_next: Any) -> Any:
        # Without DAYFLOW_PUBLIC_URL, page links use the base URL the first request came in on.
        pages_store: PageStore = request.app.state.pages
        if not pages_store.base_url:
            pages_store.base_url = str(request.base_url).rstrip("/")
        return await call_next(request)

    @app.get("/health")
    async def healthz() -> dict[str, Any]:
        return {"ok": True, "firestore": firestore_enabled(), "service": os.getenv("K_SERVICE", "local")}

    @app.get("/skills", response_model=list[Skill])
    async def skills(request: Request, user_id: str = Depends(current_user)) -> list[Skill]:
        cfg: UserConfig = await request.app.state.store.get(user_id)
        return [s for s in cfg.skills if s.enabled]

    @app.get("/config", response_model=UserConfig)
    async def get_config(request: Request, user_id: str = Depends(current_user)) -> UserConfig:
        return await request.app.state.store.get(user_id)

    @app.put("/config", response_model=UserConfig)
    async def put_config(body: UserConfig, request: Request, user_id: str = Depends(current_user)) -> UserConfig:
        await request.app.state.store.put(user_id, body)
        return await request.app.state.store.get(user_id)

    @app.post("/chat")
    async def chat(body: ChatRequest, request: Request, user_id: str = Depends(current_user)) -> StreamingResponse:
        cfg: UserConfig = await request.app.state.store.get(user_id)
        text = body.text
        if body.skill_id:
            skill = cfg.skill(body.skill_id)
            if skill is None:
                raise HTTPException(status.HTTP_404_NOT_FOUND, f"unknown or disabled skill '{body.skill_id}'")
            text = text or skill.prompt
        if not text.strip():
            raise HTTPException(status.HTTP_422_UNPROCESSABLE_CONTENT, "text or skill_id required")
        # A new prompt starts a new run: the browser action budget starts from zero.
        state_delta: dict[str, Any] = {SKILL_KEY: body.skill_id, DOMAINS_KEY: body.domains, ACTIONS_KEY: 0}
        content = types.Content(role="user", parts=[types.Part(text=text)])
        return StreamingResponse(
            sse(request.app.state.runner, user_id, body.session_id, content, state_delta),
            media_type="text/event-stream",
            headers=SSE_HEADERS,
        )

    @app.post("/tool_result")
    async def tool_result(
        body: ToolResultRequest, request: Request, user_id: str = Depends(current_user)
    ) -> StreamingResponse:
        runner: Runner = request.app.state.runner
        session, pending = await pending_calls(runner, user_id, body.session_id)
        seen: set[str] = set()
        credits = 0
        for r in body.results:
            if r.call_id in seen:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"duplicate call_id '{r.call_id}'")
            seen.add(r.call_id)
            match = pending.get(r.call_id)
            if match is None:
                raise HTTPException(status.HTTP_400_BAD_REQUEST, f"call_id '{r.call_id}' is not a pending tool call")
            name, _ = match
            if name != r.name:
                raise HTTPException(
                    status.HTTP_400_BAD_REQUEST, f"call_id '{r.call_id}' belongs to '{name}', not '{r.name}'"
                )
            if name == "request_confirmation" and r.result.get("confirmed") is True:
                credits += 1
        if len({pending[r.call_id][1] for r in body.results}) > 1:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "results must answer calls from the same model turn")
        cfg: UserConfig = await request.app.state.store.get(user_id)
        state_delta = (
            result_state_delta([r.name for r in body.results], session.state, cfg.permissions, credits) or None
        )
        content = types.Content(role="user", parts=[function_response_part(r) for r in body.results])
        return StreamingResponse(
            sse(runner, user_id, body.session_id, content, state_delta),
            media_type="text/event-stream",
            headers=SSE_HEADERS,
        )

    @app.post("/cron")
    async def cron(request: Request) -> dict[str, Any]:
        # Cloud Scheduler calls with an OIDC token from CRON_INVOKER_SA — never the extension's user token.
        await verify_google_oidc(request, "CRON_INVOKER_SA")
        jobs = await run_once(request.app.state.store)
        return {"enqueued": len(jobs), "jobs": jobs}

    return app


app = create_app()
