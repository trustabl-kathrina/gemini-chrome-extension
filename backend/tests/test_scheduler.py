from datetime import UTC, datetime

from dayflow.core.loader import MemoryConfigStore
from dayflow.scheduler import is_due, run_once


def test_is_due_minimal_cron() -> None:
    assert is_due("0 8 * * *", datetime(2026, 8, 26, 8, 0, tzinfo=UTC))
    assert not is_due("0 8 * * *", datetime(2026, 8, 26, 9, 0, tzinfo=UTC))
    assert is_due("*/15 * * * *", datetime(2026, 8, 26, 9, 30, tzinfo=UTC))
    assert not is_due("garbage", datetime(2026, 8, 26, 9, 30, tzinfo=UTC))


async def test_run_once_enqueues_due_skills(monkeypatch) -> None:
    monkeypatch.delenv("PUBSUB_TOPIC", raising=False)
    jobs = await run_once(MemoryConfigStore(), datetime(2026, 8, 26, 8, 0, tzinfo=UTC))
    assert jobs == [{"job": "run_skill", "user_id": "local", "skill_id": "vault-sync"}]
    assert await run_once(MemoryConfigStore(), datetime(2026, 8, 26, 13, 7, tzinfo=UTC)) == []
