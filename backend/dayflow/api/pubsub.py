"""Pub/Sub push endpoint shared by the brain and the worker runtime."""

from __future__ import annotations

import base64
import json
import os
import secrets
from typing import Any

from fastapi import APIRouter, HTTPException, Query, Request, Response, status

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
async def pubsub_push(request: Request, token: str = Query(default="")) -> Response:
    # Push subscriptions carry ?token=... (see Cloud Run Pub/Sub tutorial). OIDC audience check: TODO(auth).
    expected = os.getenv("PUBSUB_VERIFICATION_TOKEN", "")
    if not expected or not secrets.compare_digest(token, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "bad verification token")
    payload = decode_envelope(await request.json())
    await dispatch(payload)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
