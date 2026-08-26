"""Pub/Sub push endpoint shared by the brain and the worker runtime."""

from __future__ import annotations

import base64
import json
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, status

from dayflow.api.oidc import verify_google_oidc
from dayflow.workers.handlers import dispatch

router = APIRouter()


def decode_envelope(body: dict[str, Any]) -> dict[str, Any]:
    message = body.get("message")
    if not isinstance(message, dict) or "data" not in message:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "not a Pub/Sub push envelope")
    try:
        payload = json.loads(base64.b64decode(message["data"]).decode())
    except (ValueError, UnicodeDecodeError) as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"bad message data: {e}") from e
    if not isinstance(payload, dict) or "job" not in payload:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "message must be a JSON object with a 'job'")
    payload["_message_id"] = message.get("messageId")
    return payload


@router.post("/pubsub", status_code=status.HTTP_204_NO_CONTENT)
async def pubsub_push(request: Request) -> Response:
    # Push subscriptions authenticate with an OIDC token from PUBSUB_PUSH_SA (audience = this URL).
    verify_google_oidc(request, "PUBSUB_PUSH_SA")
    payload = decode_envelope(await request.json())
    try:
        await dispatch(payload, verified=True)
    except (ValueError, PermissionError) as e:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, str(e)) from e
    return Response(status_code=status.HTTP_204_NO_CONTENT)
