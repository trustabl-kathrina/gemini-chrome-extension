"""Request authentication.

The client never chooses its own user id. Two credentials are accepted on `Authorization: Bearer …`:
  - a shared/static token (single-user and local dev, and what the extension sends today):
      DAYFLOW_TOKEN            → user "local"
      DAYFLOW_USERS            → "sha256(token)=user_id,sha256(token2)=user_id2" for several users
  - a Google ID token (a JWT), when GOOGLE_OAUTH_CLIENT_ID is set: verified with
    google.oauth2.id_token.verify_oauth2_token against that client id as the audience; the verified `sub`
    is the user id. Optional — with the env var unset, JWTs are refused like any other unknown token.

Honest limitation on the client side: `chrome.identity.getAuthToken` (what the extension uses for Drive)
returns an OAuth *access* token, never an ID token, so the extension keeps sending the shared token
(extension/src/agent/sync.ts `brainAuthToken`). The JWT path is for callers that do have an ID token —
a web client using `launchWebAuthFlow` with `response_type=id_token`, or `gcloud`-issued tokens in scripts.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import secrets
from typing import Any

from fastapi import Header, HTTPException, status


def _user_for_token(token: str) -> str | None:
    # Compare as bytes: compare_digest raises TypeError on non-ASCII str, which would be a 500.
    raw = token.encode()
    shared = os.getenv("DAYFLOW_TOKEN", "").encode()
    if shared and secrets.compare_digest(raw, shared):
        return "local"
    digest = hashlib.sha256(raw).hexdigest().encode()
    for pair in filter(None, os.getenv("DAYFLOW_USERS", "").split(",")):
        expected, _, user_id = pair.strip().partition("=")
        if user_id and secrets.compare_digest(digest, expected.strip().encode()):
            return user_id
    return None


def _looks_like_jwt(token: str) -> bool:
    """Three non-empty dot-separated segments — enough to tell a JWT from a static token before verifying."""
    parts = token.split(".")
    return len(parts) == 3 and all(parts)


async def _user_for_id_token(token: str) -> str | None:
    """Verified Google `sub`, or None when ID-token auth is off or the token does not check out."""
    client_id = os.getenv("GOOGLE_OAUTH_CLIENT_ID")
    if not client_id:
        return None
    try:
        # Imported here (like api/oidc.py) so the module loads without google-auth and so tests can patch it.
        from google.auth.transport import requests as ga_requests
        from google.oauth2 import id_token

        # Blocking: it fetches (and caches) Google's signing certs. Verifies signature, expiry, issuer and
        # that `aud` is exactly our OAuth client id.
        claims: dict[str, Any] = dict(
            await asyncio.to_thread(id_token.verify_oauth2_token, token, ga_requests.Request(), client_id)
        )
    except (ValueError, ImportError):
        return None
    sub = claims.get("sub")
    return str(sub) if sub else None


async def current_user(authorization: str = Header(default="")) -> str:
    if not os.getenv("DAYFLOW_TOKEN") and not os.getenv("DAYFLOW_USERS") and not os.getenv("GOOGLE_OAUTH_CLIENT_ID"):
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, "no credentials configured")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token")
    user_id = _user_for_token(token)
    if user_id is None and _looks_like_jwt(token):
        user_id = await _user_for_id_token(token)
    if user_id is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "invalid token")
    return user_id
