"""Request authentication.

Today: a static bearer token shared with the extension build (DAYFLOW_TOKEN).
TODO(auth): replace with Google ID-token verification (chrome.identity → google.oauth2.id_token)
and derive user_id from the token's `sub`; keep the static token only for local dev.
"""

from __future__ import annotations

import os
import secrets

from fastapi import Header, HTTPException, status


async def current_user(
    authorization: str = Header(default=""),
    x_dayflow_user: str = Header(default="local"),
) -> str:
    expected = os.getenv("DAYFLOW_TOKEN")
    if not expected:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "DAYFLOW_TOKEN is not configured")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not secrets.compare_digest(token, expected):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token")
    return x_dayflow_user or "local"
