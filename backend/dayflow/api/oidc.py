"""Google OIDC verification for machine callers (Pub/Sub push, Cloud Scheduler).

The caller's identity token must be for our audience and issued to the expected service account.
Local/test fallback: PUBSUB_VERIFY=0 disables verification, but ONLY when not running on Cloud Run.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

from fastapi import HTTPException, Request, status


def verification_disabled() -> bool:
    return os.getenv("PUBSUB_VERIFY", "1") == "0" and not os.getenv("K_SERVICE")


async def verify_google_oidc(
    request: Request, expected_sa_env: str, audience_env: str = "OIDC_AUDIENCE"
) -> dict[str, Any]:
    """Returns the verified claims, or raises 401/503."""
    if verification_disabled():
        return {"email": os.getenv(expected_sa_env, "local"), "email_verified": True, "local": True}
    expected_sa = os.getenv(expected_sa_env)
    if not expected_sa:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE, f"{expected_sa_env} is not configured")
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "missing bearer token")
    audience = os.getenv(audience_env) or str(request.url.replace(query=""))
    try:
        from google.auth.transport import requests as ga_requests
        from google.oauth2 import id_token

        claims = dict(await asyncio.to_thread(id_token.verify_oauth2_token, token, ga_requests.Request(), audience))
    except (ValueError, ImportError) as e:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, f"invalid identity token: {e}") from e
    if not claims.get("email_verified") or claims.get("email") != expected_sa:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "token is not from the expected service account")
    return claims
