import pytest


@pytest.fixture(autouse=True)
def _env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("DAYFLOW_TOKEN", "test-token")
    monkeypatch.setenv("PUBSUB_PUSH_SA", "push@sa")
    monkeypatch.setenv("CRON_INVOKER_SA", "cron@sa")
    monkeypatch.setenv("PUBSUB_VERIFY", "1")
    monkeypatch.delenv("DAYFLOW_FIRESTORE", raising=False)
    monkeypatch.delenv("K_SERVICE", raising=False)
    monkeypatch.delenv("GITHUB_TOKEN", raising=False)
    monkeypatch.delenv("LINEAR_API_KEY", raising=False)
