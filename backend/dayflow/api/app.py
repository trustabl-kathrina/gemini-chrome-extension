"""Dayflow brain: FastAPI + ADK Runner. Each LLM turn is one short SSE stream; browser tool
calls end the turn and the extension resumes it via POST /tool_result."""

from __future__ import annotations

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
from google.adk.sessions import BaseSessionService, InMemorySessionService
from google.genai import types
from pydantic import BaseModel, Field

from dayflow.agents.orchestrator import CONFIRMATIONS_KEY, DOMAINS_KEY, SKILL_KEY, build_root_agent
from dayflow.api.auth import current_user
from dayflow.api.oidc import verify_google_oidc
from dayflow.api.pubsub import router as pubsub_router
from dayflow.core.loader import ConfigStore, firestore_enabled, make_config_store
from dayflow.core.models import Skill, UserConfig
from dayflow.scheduler import run_once

log = logging.getLogger("dayflow.api")
APP_NAME = "dayflow"
SSE_HEADERS = {"Cache-Control": "no-cache", "X-Accel-Buffering": "no"}


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
        async for ev in runner.run_async(
            user_id=user_id,
            session_id=session_id,
            new_message=content,
            state_delta=state_delta,
            run_config=RunConfig(streaming_mode=StreamingMode.SSE),
        ):
            yield f"data: {ev.model_dump_json(exclude_none=True, by_alias=True)}\n\n"
        yield "event: done\ndata: {}\n\n"

    return gen()


def create_app(store: ConfigStore | None = None, runner: Runner | None = None) -> FastAPI:
    store = store or make_config_store()
    app = FastAPI(title="Dayflow brain", version="0.1.0")
    app.state.store = store
    app.state.runner = runner or make_runner(store)
    app.add_middleware(
        CORSMiddleware,
        allow_origin_regex=r"chrome-extension://.*|http://localhost(:\d+)?",
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.include_router(pubsub_router)

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
        state_delta: dict[str, Any] = {SKILL_KEY: body.skill_id, DOMAINS_KEY: body.domains}
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
        state_delta: dict[str, Any] | None = None
        confirmed = sum(1 for r in body.results if r.name == "request_confirmation" and r.result.get("confirmed"))
        if confirmed:
            session = await runner.session_service.get_session(
                app_name=APP_NAME, user_id=user_id, session_id=body.session_id
            )
            credits = int((session.state.get(CONFIRMATIONS_KEY, 0) if session else 0) or 0)
            state_delta = {CONFIRMATIONS_KEY: credits + confirmed}
        parts = [
            types.Part(function_response=types.FunctionResponse(id=r.call_id, name=r.name, response=r.result))
            for r in body.results
        ]
        content = types.Content(role="user", parts=parts)
        return StreamingResponse(
            sse(runner, user_id, body.session_id, content, state_delta),
            media_type="text/event-stream",
            headers=SSE_HEADERS,
        )

    @app.post("/cron")
    async def cron(request: Request) -> dict[str, Any]:
        # Cloud Scheduler calls with an OIDC token from CRON_INVOKER_SA — never the extension's user token.
        verify_google_oidc(request, "CRON_INVOKER_SA")
        jobs = await run_once(request.app.state.store)
        return {"enqueued": len(jobs), "jobs": jobs}

    return app


app = create_app()
