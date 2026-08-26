"""Request authentication.

The client never chooses its own user id. Today the credential is a bearer token:
  - DAYFLOW_TOKEN            → user "local" (single-user / dev)
  - DAYFLOW_USERS            → "sha256(token)=user_id,sha256(token2)=user_id2" for several users
TODO(auth): Google ID-token verification (chrome.identity → google.oauth2.id_token.verify_oauth2_token);
user_id = verified `sub`. Keep the static token path for local dev only.
"""

from __future__ import annotations

import hashlib
import os
import secrets

from fastapi import Header, HTTPException, status


def _user_for_token(token: str) -> str | None:
    shared = os.getenv("DAYFLOW_TOKEN", "")
    if shared and secrets.compare_digest(token, shared):
        return "local"
    digest = hashlib.sha256(token.encode()).hexdigest()
    for pair in filter(None, os.getenv("DAYFLOW_USERS", "").split(",")):
        expected, _, user_id = pair.strip().partition("=")
        if user_id and secrets.compare_digest(digest, expected.strip()):
            return user_id
    return None


async def current_user(authorization: str = Header(default="")) -> str:
    if not os.getenv("DAYFLOW_TOKEN") and not os.getenv("DAYFLOW_USERS"):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "no credentials configured")
    scheme, _, token = authorization.partition(" ")
    user_id = _user_for_token(token) if scheme.lower() == "bearer" and token else None
    if user_id is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token")
    return user_id
