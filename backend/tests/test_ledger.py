"""The run ledger: what one run records, what the dashboard totals, and what a receipt may claim."""

import os
from collections.abc import AsyncIterator
from typing import Any

import httpx
import pytest
from google.adk.events import Event
from google.adk.sessions import InMemorySessionService
from google.genai import types

from dayflow.api.app import create_app
from dayflow.core.ledger import (
    HUMAN_BASELINE_SECONDS,
    KNOWN_TOOLS,
    LedgerAction,
    LedgerArtifact,
    MemoryRunStore,
    RunLedger,
    RunRecord,
    chain_head,
    receipt_facts,
    saved_seconds,
    totals,
)
from dayflow.core.loader import MemoryConfigStore
from dayflow.core.pages import PageStore
from dayflow.core.telemetry import init_tracing, tracing_enabled
from dayflow.core.vault import MemoryBlobStore
from dayflow.tools.browser import BROWSER_TOOL_NAMES

AUTH = {"Authorization": "Bearer test-token"}
DOWNLOAD = {"path": "CSCI3240/Lab 01/lab.pdf", "ref": "e7"}
DOWNLOAD_OK = {"status": "success", "path": "CSCI3240/Lab 01/lab.pdf", "drive_link": "https://drive/f/1", "bytes": 100}


def call_part(call_id: str, name: str, args: dict[str, Any]) -> types.Part:
    return types.Part(function_call=types.FunctionCall(id=call_id, name=name, args=args))


def response_part(call_id: str, name: str, response: dict[str, Any]) -> types.Part:
    """What a SERVER tool's answer looks like: it arrives inside the same stream as its call."""
    return types.Part(function_response=types.FunctionResponse(id=call_id, name=name, response=response))


class ScriptedRunner:
    """Stands in for the ADK Runner: yields the parts scripted for each turn, then a plain final answer."""

    def __init__(self, turns: list[list[types.Part]]) -> None:
        self.session_service = InMemorySessionService()
        self.turns = turns
        self.calls: list[dict[str, Any]] = []

    async def run_async(self, **kw: Any) -> AsyncIterator[Event]:
        self.calls.append(kw)
        parts = self.turns.pop(0) if self.turns else [types.Part(text="Done: 1 file saved.")]
        # Only browser tools are long-running: a server tool's call AND its response arrive in this stream.
        ids = {
            p.function_call.id
            for p in parts
            if p.function_call and p.function_call.id and p.function_call.name in BROWSER_TOOL_NAMES
        }
        yield Event(
            author="dayflow",
            invocation_id="inv1",
            content=types.Content(role="model", parts=parts),
            long_running_tool_ids=ids or None,
            usage_metadata=types.GenerateContentResponseUsageMetadata(
                prompt_token_count=1000, candidates_token_count=200
            ),
        )


@pytest.fixture
def ledger() -> RunLedger:
    return RunLedger(MemoryRunStore())


@pytest.fixture
def runner() -> ScriptedRunner:
    return ScriptedRunner([[types.Part(text="Opening WSP."), call_part("c1", "download", DOWNLOAD)]])


@pytest.fixture
async def client(runner: ScriptedRunner, ledger: RunLedger) -> AsyncIterator[httpx.AsyncClient]:
    app = create_app(
        store=MemoryConfigStore(),
        runner=runner,  # type: ignore[arg-type]
        pages=PageStore(MemoryBlobStore(), public_url="http://t"),
        ledger=ledger,
    )
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        yield c


async def seed_pending(runner: ScriptedRunner, call_id: str, name: str) -> None:
    """Session s1 with one unanswered long-running call, so POST /tool_result accepts its result."""
    svc = runner.session_service
    session = await svc.create_session(app_name="dayflow", user_id="local", session_id="s1")
    await svc.append_event(
        session,
        Event(
            id="ev1",
            author="dayflow",
            invocation_id="inv",
            content=types.Content(role="model", parts=[call_part(call_id, name, DOWNLOAD)]),
            long_running_tool_ids={call_id},
        ),
    )


async def run_download(client: httpx.AsyncClient, runner: ScriptedRunner, result: dict[str, Any]) -> None:
    """One full run: a prompt, the download call it makes, its result, and the model's final answer."""
    assert (await client.post("/chat", headers=AUTH, json={"session_id": "s1", "text": "sync CV"})).status_code == 200
    await seed_pending(runner, "c1", "download")
    body = {"session_id": "s1", "results": [{"call_id": "c1", "name": "download", "result": result}]}
    assert (await client.post("/tool_result", headers=AUTH, json=body)).status_code == 200


# ---------- the record ----------


async def test_a_run_records_its_action_artifact_cost_and_saved_time(
    client: httpx.AsyncClient, runner: ScriptedRunner, ledger: RunLedger
) -> None:
    await run_download(client, runner, DOWNLOAD_OK)
    runs = await ledger.list("local")
    assert len(runs) == 1
    run = runs[0]
    assert run.trigger == "manual" and run.finished and run.failures == []
    assert [(a.tool, a.target, a.ok) for a in run.actions] == [("download", "CSCI3240/Lab 01/lab.pdf", True)]
    assert run.counts == {"download": 1}
    assert [(a.kind, a.name, a.url) for a in run.artifacts] == [("file", "lab.pdf", "https://drive/f/1")]
    assert run.artifacts[0].produced_by == [0]
    assert run.usage["prompt"] == 2000 and run.usage["turns"] == 2, "both turns are booked on the run"
    assert run.cost_usd > 0
    assert 0 < run.saved_seconds <= 45, "one portal download, minus the time the run itself took"
    assert run.chain_head == chain_head(run.actions)


async def test_a_failed_tool_becomes_a_visible_failure_and_no_artifact(
    client: httpx.AsyncClient, runner: ScriptedRunner, ledger: RunLedger
) -> None:
    await run_download(client, runner, {"status": "error", "message": "the download icon is gone"})
    run = (await ledger.list("local"))[0]
    assert run.actions[0].ok is False and run.artifacts == []
    assert run.failures == ["download CSCI3240/Lab 01/lab.pdf: the download icon is gone"]
    assert run.saved_seconds == 0, "nothing succeeded, so nothing was saved"


async def test_a_new_prompt_closes_the_run_that_never_answered(
    client: httpx.AsyncClient, runner: ScriptedRunner, ledger: RunLedger
) -> None:
    runner.turns = [[call_part("c1", "click", {"ref": "e1"})], [call_part("c2", "click", {"ref": "e2"})]]
    for _ in range(2):
        assert (
            await client.post("/chat", headers=AUTH, json={"session_id": "s1", "text": "go", "trigger": "scheduled"})
        ).status_code == 200
    runs = await ledger.list("local")
    assert len(runs) == 2 and all(r.trigger == "scheduled" for r in runs)
    closed = [r for r in runs if r.finished]
    assert len(closed) == 1 and closed[0].failures == ["superseded by a new prompt before it finished"]


async def test_the_ledger_never_breaks_a_run(client: httpx.AsyncClient, ledger: RunLedger) -> None:
    class Broken(MemoryRunStore):
        async def put(self, user_id: str, record: RunRecord) -> None:
            raise RuntimeError("firestore is down")

    ledger.store = Broken()
    assert (await client.post("/chat", headers=AUTH, json={"session_id": "s2", "text": "go"})).status_code == 200
    assert await ledger.list("local") == []


def test_saved_seconds_never_goes_negative() -> None:
    record = RunRecord(
        run_id="r",
        session_id="s",
        user_id="local",
        duration_s=600.0,
        actions=[LedgerAction(tool="click", ok=True)],
    )
    assert saved_seconds(record) == 0


def test_totals_add_up_across_runs() -> None:
    def run(cost: float, saved: int) -> RunRecord:
        return RunRecord(
            run_id="r",
            session_id="s",
            user_id="local",
            cost_usd=cost,
            saved_seconds=saved,
            actions=[LedgerAction(tool="download", ok=True), LedgerAction(tool="click", ok=False, error="gone")],
            artifacts=[],
            failures=["click: gone"],
        )

    agg = totals([run(0.01, 1800), run(0.02, 5400)])
    assert (agg.runs, agg.actions, agg.ok_actions, agg.failures) == (2, 4, 2, 2)
    assert agg.cost_usd == 0.03 and agg.saved_hours == 2.0


# ---------- the hash chain ----------


def test_the_chain_head_changes_when_an_entry_is_edited_or_reordered() -> None:
    actions = [LedgerAction(tool="download", target="a.pdf", ok=True), LedgerAction(tool="click", target="e1", ok=True)]
    head = chain_head(actions)
    assert head == chain_head([a.model_copy(deep=True) for a in actions])
    assert chain_head(list(reversed(actions))) != head
    edited = [actions[0].model_copy(update={"ok": False}), actions[1]]
    assert chain_head(edited) != head
    assert chain_head(actions[:1]) != head


# ---------- receipts ----------


def make_run(*tools: str) -> RunRecord:
    """A finished run whose single artifact was produced by every action in it."""
    actions = [LedgerAction(tool=t, target=f"t{i}", ok=True) for i, t in enumerate(tools)]
    artifact = LedgerArtifact(kind="file", name="lab.pdf", produced_by=list(range(len(actions))))
    record = RunRecord(run_id="r1", session_id="s1", user_id="local", actions=actions, artifacts=[artifact])
    record.chain_head = chain_head(actions)
    return record


def test_a_receipt_states_only_what_the_log_shows() -> None:
    facts = receipt_facts(make_run("open_tab", "read_page", "download", "download"), 0)
    assert facts.did[0] == "Downloaded 2 file(s) from the pages the browser was already signed in to."
    assert len(facts.did_not) == 3 and facts.unproven == []
    assert any("writes or solves coursework" in line for line in facts.did_not)
    assert facts.chain_verified and facts.action_count == 4


def test_a_receipt_refuses_to_claim_what_the_log_contradicts() -> None:
    facts = receipt_facts(make_run("download", "solve_lab_task", "push_files"), 0)
    assert any("Wrote and executed Python" in line for line in facts.did)
    assert not any("coursework" in line for line in facts.did_not)
    assert [line.split('"')[1] for line in facts.unproven] == [
        "No tool that writes or solves coursework was called.",
        "No message, issue or pull-request tool was called.",
    ]


def test_a_receipt_never_denies_what_a_click_could_have_done() -> None:
    """The team-ops scene posts a Telegram message with type + click — no publishing TOOL is involved, so a
    tool list cannot say "nothing was posted". It may only claim the narrow thing it can prove."""
    facts = receipt_facts(make_run("open_tab", "read_page", "type", "click", "press_key"), 0)
    assert not any("posted" in line for line in facts.did_not)
    assert any("Send or Turn-in control" in line for line in facts.unproven)
    assert "No message, issue or pull-request tool was called." in facts.did_not
    # A click alone (Teams' "Turn in" button) is enough to withhold the wider claim.
    assert any("Send or Turn-in control" in line for line in receipt_facts(make_run("click"), 0).unproven)
    # A run that only read and downloaded claims all three: nothing in it can have sent anything.
    assert receipt_facts(make_run("open_tab", "read_page", "download_many"), 0).unproven == []


def test_every_tool_the_agent_can_call_is_classified() -> None:
    """One unclassified tool suppresses every claim a receipt makes, and prices no saved time — so a new
    tool must land in these tables. This is the check `download_many` shipped without."""
    from dayflow.agents.lab_solver import lab_solver_tool
    from dayflow.tools.connectors import GITHUB_TOOLS, LINEAR_TOOLS

    declared = (
        set(BROWSER_TOOL_NAMES)
        | {"vault_list", "vault_read", "parse_document", "embed_text", "remember"}
        | {"plan_vault_folders", "make_folders", "build_notebook", "build_report"}
        | {"generate_courseware", "build_deck", lab_solver_tool().name}
        | set(GITHUB_TOOLS)
        | set(LINEAR_TOOLS)
    )
    assert declared <= KNOWN_TOOLS, f"unclassified: {sorted(declared - KNOWN_TOOLS)}"
    assert declared <= set(HUMAN_BASELINE_SECONDS), f"unpriced: {sorted(declared - set(HUMAN_BASELINE_SECONDS))}"


async def test_a_batch_download_records_every_file_it_stored(ledger: RunLedger) -> None:
    """`download_many` is one call and N chores: N artifacts (N receipts), N × the manual baseline, and the
    files that failed named in the failures column."""
    await ledger.start("local", "s9")
    ledger.called("s9", "c1", "download_many", {"items": [{"url": "u1"}, {"url": "u2"}, {"url": "u3"}]})
    ledger.resolved(
        "s9",
        "c1",
        {
            "status": "success",
            "ok": 2,
            "failed": 1,
            "items": [
                {"status": "success", "path": "CS/Lab 01/a.pdf", "drive_link": "https://drive/a"},
                {"status": "error", "url": "https://wsp/b.pdf", "message": "HTTP 404"},
                {"status": "success", "path": "CS/Lab 01/c.pdf"},
            ],
        },
    )
    record = await ledger.finish("s9")
    assert record is not None
    assert [(a.kind, a.name, a.url) for a in record.artifacts] == [
        ("file", "a.pdf", "https://drive/a"),
        ("file", "c.pdf", ""),
    ]
    assert record.files == 2
    assert record.failures == ["download_many https://wsp/b.pdf: HTTP 404"]
    assert record.actions[0].count == 2, "the run did two file chores, not one call"
    assert record.saved_seconds == 90, "45 s per stored file, not per call"
    facts = receipt_facts(record, 1)
    assert facts.artifact.name == "c.pdf"
    assert "Downloaded 2 file(s) in batches" in facts.did[0]


def test_an_unclassified_tool_suppresses_every_claim() -> None:
    facts = receipt_facts(make_run("download", "some_new_mcp_tool"), 0)
    assert facts.did_not == []
    assert facts.unproven == [
        "Nothing is claimed: the log contains tool(s) this receipt cannot classify: some_new_mcp_tool."
    ]


def test_a_tampered_log_fails_verification() -> None:
    record = make_run("download", "click")
    record.actions[1].tool = "type"
    assert receipt_facts(record, 0).chain_verified is False


# ---------- the pages ----------


async def test_dashboard_shows_the_run_its_artifact_and_its_failures(
    client: httpx.AsyncClient, runner: ScriptedRunner
) -> None:
    await run_download(client, runner, {"status": "error", "message": "the download icon is gone"})
    data = (await client.get("/ledger.json", headers=AUTH)).json()
    assert data["totals"]["runs"] == 1 and data["totals"]["failures"] == 1 and data["totals"]["saved_hours"] == 0.0
    assert data["runs"][0]["actions"][0]["tool"] == "download"

    page = await client.get("/ledger", headers=AUTH)
    assert page.status_code == 200 and page.headers["content-type"].startswith("text/html")
    assert "the download icon is gone" in page.text, "failures are the point of the ledger"
    assert "run ledger" in page.text and "of manual work avoided" in page.text


async def test_receipt_page_and_its_404s(client: httpx.AsyncClient, runner: ScriptedRunner, ledger: RunLedger) -> None:
    await run_download(client, runner, DOWNLOAD_OK)
    run_id = (await ledger.list("local"))[0].run_id
    page = await client.get(f"/receipt/{run_id}/0", headers=AUTH)
    assert page.status_code == 200
    assert "lab.pdf" in page.text and "What Dayflow did not do" in page.text
    assert chain_head((await ledger.list("local"))[0].actions) in page.text
    assert (await client.get(f"/receipt/{run_id}/9", headers=AUTH)).status_code == 404
    assert (await client.get("/receipt/nope/0", headers=AUTH)).status_code == 404
    assert (await client.get(f"/receipt/{run_id}/0")).status_code == 401


async def test_a_turn_a_server_tool_answered_closes_and_persists_the_run(
    client: httpx.AsyncClient, runner: ScriptedRunner, ledger: RunLedger
) -> None:
    """A courseware / notebook / vault_list turn is answered inside the SSE stream: nothing is left for the
    extension to send back, so the run is over and must be written. It used to stay open, empty and free."""
    runner.turns = [
        [
            call_part("c1", "vault_list", {"path": "CSCI3240"}),
            response_part("c1", "vault_list", {"status": "success", "files": 2}),
            types.Part(text="Two files are in the vault."),
        ]
    ]
    body = {"session_id": "s1", "text": "what is in the vault?"}
    assert (await client.post("/chat", headers=AUTH, json=body)).status_code == 200
    runs = await ledger.list("local")
    assert len(runs) == 1
    run = runs[0]
    assert run.finished, "the model gave its final answer; the run is closed"
    assert [(a.tool, a.ok) for a in run.actions] == [("vault_list", True)]
    assert run.counts == {"vault_list": 1} and run.cost_usd > 0 and run.chain_head


async def test_a_shared_receipt_is_not_a_door_into_the_whole_history(
    client: httpx.AsyncClient, runner: ScriptedRunner
) -> None:
    await run_download(client, runner, DOWNLOAD_OK)
    shared = (await client.post("/ledger/share", headers=AUTH)).json()
    dashboard = await client.get(shared["url"].removeprefix("http://t"))
    receipt_url = dashboard.text.split('href="')[1].split('"')[0]
    receipt = await client.get(receipt_url.removeprefix("http://t"))
    assert "full ledger" not in receipt.text, "a receipt for a professor is not a link to every run"
    assert "for local" not in dashboard.text, "the published dashboard names no user"


async def test_sharing_publishes_pages_that_open_without_a_token(
    client: httpx.AsyncClient, runner: ScriptedRunner
) -> None:
    await run_download(client, runner, DOWNLOAD_OK)
    shared = (await client.post("/ledger/share", headers=AUTH)).json()
    assert shared["runs"] == 1 and shared["receipts"] == 1
    dashboard = await client.get(shared["url"].removeprefix("http://t"))
    assert dashboard.status_code == 200 and "lab.pdf" in dashboard.text
    receipt_url = dashboard.text.split('href="')[1].split('"')[0]
    assert "/pages/receipt/" in receipt_url
    receipt = await client.get(receipt_url.removeprefix("http://t"))
    assert receipt.status_code == 200 and "What Dayflow did" in receipt.text


# ---------- telemetry ----------


def test_span_content_is_off_unless_the_operator_asks_for_it(monkeypatch: pytest.MonkeyPatch) -> None:
    """ADK puts the whole LLM request/response and every tool argument on its spans by default — page
    snapshots and grades in Cloud Trace. Turning tracing on must not turn that on."""
    import dayflow.core.telemetry as telemetry

    monkeypatch.setattr(telemetry, "_initialised", False)
    monkeypatch.delenv(telemetry.CONTENT_ENV, raising=False)
    monkeypatch.delenv("DAYFLOW_TRACE_CONTENT", raising=False)
    monkeypatch.setenv("DAYFLOW_TRACE", "1")
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "/nonexistent")
    init_tracing()
    assert os.environ[telemetry.CONTENT_ENV] == "false"

    monkeypatch.setattr(telemetry, "_initialised", False)
    monkeypatch.delenv(telemetry.CONTENT_ENV, raising=False)
    monkeypatch.setenv("DAYFLOW_TRACE_CONTENT", "1")
    init_tracing()
    assert os.environ[telemetry.CONTENT_ENV] == "true"


def test_tracing_stays_off_without_cloud_run_or_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    import dayflow.core.telemetry as telemetry

    monkeypatch.setattr(telemetry, "_initialised", False)
    monkeypatch.delenv("DAYFLOW_TRACE", raising=False)
    assert tracing_enabled() is False and init_tracing() is False
    monkeypatch.setenv("DAYFLOW_TRACE", "1")
    monkeypatch.setenv("GOOGLE_APPLICATION_CREDENTIALS", "/nonexistent")
    assert tracing_enabled() is True
    assert init_tracing() is False, "no credentials: telemetry is a silent no-op, never an exception"
