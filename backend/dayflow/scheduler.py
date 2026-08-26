"""Scheduler runtime: finds skills that are due and enqueues `run_skill` jobs on Pub/Sub.

Run as a Cloud Run Job from Cloud Scheduler (`python -m dayflow.scheduler`), or on demand via POST /cron.
Cron support is deliberately minimal ("M H * * *" and "*" fields) — enough for daily/hourly skills.
"""

from __future__ import annotations

import asyncio
import base64
import json
import logging
import os
from datetime import UTC, datetime
from typing import Any

import httpx

from dayflow.core.loader import ConfigStore, MemoryConfigStore, firestore_enabled, make_config_store

log = logging.getLogger("dayflow.scheduler")


def _field_matches(field: str, value: int) -> bool:
    if field == "*":
        return True
    if field.startswith("*/"):
        step = int(field[2:])
        return step > 0 and value % step == 0
    return any(int(part) == value for part in field.split(","))


def is_due(cron: str, now: datetime) -> bool:
    parts = cron.split()
    if len(parts) != 5:
        return False
    minute, hour, _dom, _mon, dow = parts
    return _field_matches(minute, now.minute) and _field_matches(hour, now.hour) and _field_matches(dow, now.weekday())


async def list_user_ids(store: ConfigStore) -> list[str]:
    if isinstance(store, MemoryConfigStore) or not firestore_enabled():
        return ["local"]
    from google.cloud import firestore

    db = firestore.AsyncClient()
    return [doc.id async for doc in db.collection("users").stream()]


async def publish(job: dict[str, Any]) -> None:
    topic = os.getenv("PUBSUB_TOPIC")
    project = os.getenv("GOOGLE_CLOUD_PROJECT")
    if not topic or not project:
        log.info("PUBSUB_TOPIC not set; would enqueue %s", job)
        return
    import google.auth
    import google.auth.transport.requests

    creds, _ = google.auth.default(scopes=["https://www.googleapis.com/auth/pubsub"])
    creds.refresh(google.auth.transport.requests.Request())
    data = base64.b64encode(json.dumps(job).encode()).decode()
    async with httpx.AsyncClient(timeout=10) as http:
        r = await http.post(
            f"https://pubsub.googleapis.com/v1/projects/{project}/topics/{topic}:publish",
            json={"messages": [{"data": data}]},
            headers={"Authorization": f"Bearer {creds.token}"},
        )
        r.raise_for_status()


async def run_once(store: ConfigStore, now: datetime | None = None) -> list[dict[str, Any]]:
    now = now or datetime.now(UTC)
    jobs: list[dict[str, Any]] = []
    for user_id in await list_user_ids(store):
        cfg = await store.get(user_id)
        for skill in cfg.skills:
            if skill.enabled and skill.schedule and is_due(skill.schedule, now):
                job = {"job": "run_skill", "user_id": user_id, "skill_id": skill.id}
                await publish(job)
                jobs.append(job)
    return jobs


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    enqueued = asyncio.run(run_once(make_config_store()))
    log.info("enqueued %d job(s)", len(enqueued))
