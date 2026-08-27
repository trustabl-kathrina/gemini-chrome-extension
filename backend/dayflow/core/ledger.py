"""Run ledger: what the agent actually did, kept as proof of work.

One document per run at `users/{uid}/runs/{run_id}` (Firestore when `firestore_enabled()`, memory
otherwise — same split as the config store and the vault index). A run is one prompt and everything the
agent did until it answered: POST /chat opens it, every tool call and its result is appended in order,
and the turn that emits no further tool call closes it.

Two things are derived from that log and nothing else:
  - the dashboard (GET /ledger): runs, actions, artifacts, cost, and — visibly — the failures;
  - the receipt (GET /receipt/{run_id}/{i}): what the agent did for one artifact, what it provably did
    NOT do (a claim is only made when no tool of that class appears in the log), and a sha256 chain over
    the ordered actions so an excerpt can be checked against the stored run.

Nothing here may break a run: every entry point swallows its own errors and logs them.
"""

from __future__ import annotations

import hashlib
import json
import logging
import posixpath
import secrets
import time
from collections import Counter
from collections.abc import Callable, Iterable, Mapping, Sequence
from datetime import UTC, datetime
from typing import Any, Literal, Protocol

from pydantic import BaseModel, Field

from dayflow.core.loader import firestore_enabled

log = logging.getLogger("dayflow.ledger")

Trigger = Literal["manual", "scheduled"]

MAX_ACTIONS_KEPT = 400  # a run is capped at 60 browser actions; server tools and retries add to that
MAX_ACTIVE_RUNS = 200  # bounded: a panel that dies mid-run leaves its run open until the next prompt
MAX_ERROR_CHARS = 200

# ---------- tool classification (the receipt's allow/deny lists) ----------
#
# Every tool the agent can call is named in exactly one of these sets. A "did not" claim on a receipt is
# made only when the deny set for that claim does not intersect the run's tool names — and an unknown tool
# name (a connector added later, an MCP tool) suppresses the claim instead of weakening it silently.

MECHANICAL_TOOLS = frozenset(
    {
        # browser hands
        "open_tab",
        "navigate",
        "read_page",
        "screenshot",
        "click",
        "click_at",
        "scroll",
        "list_tabs",
        "wait",
        "download",
        "download_many",
        "request_confirmation",
        # server-side reading and filing
        "vault_list",
        "vault_read",
        "parse_document",
        "embed_text",
        "remember",
        "plan_vault_folders",
        "make_folders",
        "get_file_contents",
        "list_teams",
        "list_projects",
    }
)
# Tools that put characters into a page or run script in it.
INPUT_TOOLS = frozenset({"type", "type_text", "press_key", "run_js"})
# Tools that author content a professor would grade.
AUTHORING_TOOLS = frozenset({"solve_lab_task", "build_notebook", "build_report", "generate_courseware", "build_deck"})
# Tools that send something outward under the user's name through an API of their own.
PUBLISHING_TOOLS = frozenset(
    {"create_repository", "create_branch", "push_files", "issue_write", "create_pull_request", "create_issue"}
)
# Tools that can ACTIVATE a control in a page — a Send button, a Turn-in button, a form's submit. None of
# them proves anything was sent, and none of them lets the receipt claim nothing was.
ACTIVATION_TOOLS = frozenset({"click", "click_at", "press_key", "type", "type_text", "run_js"})
KNOWN_TOOLS = MECHANICAL_TOOLS | INPUT_TOOLS | AUTHORING_TOOLS | PUBLISHING_TOOLS

# How long the same step costs the student by hand: opening a Vaadin course folder and waiting for it to
# render, finding one file's download icon and filing the file under the right week, skimming a PDF. These
# are deliberately conservative, and every tool that WRITES something (a notebook, a report, a deck) is
# worth 0 here: the ledger claims time only for chores it replaced, never for content it produced.
HUMAN_BASELINE_SECONDS: dict[str, int] = {
    "open_tab": 20,
    "navigate": 10,
    "read_page": 15,
    "screenshot": 0,
    "click": 4,
    "click_at": 4,
    "type": 8,
    "type_text": 8,
    "press_key": 2,
    "scroll": 2,
    "run_js": 0,
    "list_tabs": 0,
    "wait": 0,
    "download": 45,
    "download_many": 45,  # per stored file: one call answers for many (LedgerAction.count)
    "request_confirmation": 0,
    "vault_list": 20,
    "vault_read": 60,
    "parse_document": 120,
    "embed_text": 0,
    "remember": 0,
    "plan_vault_folders": 0,
    "make_folders": 240,
    "get_file_contents": 15,
    "list_teams": 5,
    "list_projects": 5,
    "create_repository": 120,
    "create_branch": 20,
    "push_files": 90,
    "issue_write": 90,
    "create_pull_request": 120,
    "create_issue": 60,
    # Authored content is worth 0 by policy, and listed here so a NEW tool is never silently unpriced.
    "solve_lab_task": 0,
    "build_notebook": 0,
    "build_report": 0,
    "generate_courseware": 0,
    "build_deck": 0,
}

# Argument that names what a call acted on, most specific first.
TARGET_ARGS = ("url", "path", "path_or_id", "paths", "ref", "file_name", "title", "action", "note", "task_text")
# Result keys that carry the address of something the run produced, most durable first.
ARTIFACT_URL_KEYS = ("drive_link", "html_url", "page_url", "ipynb_url", "pptx_url", "url", "permalink")
# Tools whose successful result is an artifact, and the kind it gets on the ledger.
ARTIFACT_KINDS: dict[str, str] = {
    "download": "file",
    "download_many": "file",
    "generate_courseware": "courseware",
    "build_report": "report",
    "build_notebook": "notebook",
    "build_deck": "deck",
    "push_files": "commit",
    "create_repository": "repo",
    "create_pull_request": "pull-request",
    "issue_write": "issue",
    "create_issue": "issue",
    "make_folders": "folders",
}


# ---------- records ----------


class LedgerAction(BaseModel):
    """One tool call and how it ended. `ok` is None while the call is still in flight."""

    tool: str
    target: str = ""
    ok: bool | None = None
    error: str = ""
    at: str = ""
    count: int = Field(default=1, description="Items this call handled: a batch tool answers for many files.")


class LedgerArtifact(BaseModel):
    kind: str
    name: str
    url: str = ""
    produced_by: list[int] = Field(
        default_factory=list,
        description="Indices of the actions recorded between the previous artifact and this one, inclusive.",
    )


class RunRecord(BaseModel):
    run_id: str
    session_id: str
    user_id: str
    skill: str = ""
    trigger: Trigger = "manual"
    started_at: str = ""
    ended_at: str = ""
    duration_s: float = 0.0
    actions: list[LedgerAction] = Field(default_factory=list)
    counts: dict[str, int] = Field(default_factory=dict, description="Actions per tool name.")
    artifacts: list[LedgerArtifact] = Field(default_factory=list)
    usage: dict[str, int] = Field(default_factory=dict, description="Token counts, as booked by the API per turn.")
    cost_usd: float = 0.0
    failures: list[str] = Field(default_factory=list)
    saved_seconds: int = 0
    chain_head: str = ""

    @property
    def ok_actions(self) -> int:
        return sum(1 for a in self.actions if a.ok)

    @property
    def files(self) -> int:
        return sum(1 for a in self.artifacts if a.kind == "file")

    @property
    def finished(self) -> bool:
        return bool(self.ended_at)


class LedgerTotals(BaseModel):
    runs: int = 0
    actions: int = 0
    ok_actions: int = 0
    artifacts: int = 0
    files: int = 0
    failures: int = 0
    saved_seconds: int = 0
    cost_usd: float = 0.0

    @property
    def saved_hours(self) -> float:
        return round(self.saved_seconds / 3600, 2)


def totals(records: Iterable[RunRecord]) -> LedgerTotals:
    t = LedgerTotals()
    for r in records:
        t.runs += 1
        t.actions += len(r.actions)
        t.ok_actions += r.ok_actions
        t.artifacts += len(r.artifacts)
        t.files += r.files
        t.failures += len(r.failures)
        t.saved_seconds += r.saved_seconds
        t.cost_usd += r.cost_usd
    t.cost_usd = round(t.cost_usd, 4)
    return t


# ---------- hash chain ----------

GENESIS = hashlib.sha256(b"dayflow-ledger-v1").hexdigest()


def action_digest(action: LedgerAction, previous: str) -> str:
    payload = json.dumps(action.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(f"{previous}\n{payload}".encode()).hexdigest()


def chain_head(actions: Sequence[LedgerAction]) -> str:
    """sha256 chain over the actions in order: changing, dropping or reordering one entry changes the head."""
    head = GENESIS
    for action in actions:
        head = action_digest(action, head)
    return head


# ---------- storage ----------


class RunStore(Protocol):
    async def put(self, user_id: str, record: RunRecord) -> None: ...
    async def get(self, user_id: str, run_id: str) -> RunRecord | None: ...
    async def list(self, user_id: str, limit: int = 50) -> list[RunRecord]: ...


class MemoryRunStore:
    def __init__(self, keep: int = 200) -> None:
        self._data: dict[str, dict[str, RunRecord]] = {}
        self._keep = keep

    async def put(self, user_id: str, record: RunRecord) -> None:
        runs = self._data.setdefault(user_id, {})
        runs[record.run_id] = record.model_copy(deep=True)
        while len(runs) > self._keep:
            runs.pop(next(iter(runs)))

    async def get(self, user_id: str, run_id: str) -> RunRecord | None:
        found = self._data.get(user_id, {}).get(run_id)
        return found.model_copy(deep=True) if found else None

    async def list(self, user_id: str, limit: int = 50) -> list[RunRecord]:
        runs = sorted(self._data.get(user_id, {}).values(), key=lambda r: r.started_at, reverse=True)
        return [r.model_copy(deep=True) for r in runs[:limit]]


class FirestoreRunStore:
    """users/{uid}/runs/{run_id}"""

    def __init__(self, client: Any | None = None) -> None:
        from google.cloud import firestore

        self._db = client or firestore.AsyncClient()

    def _col(self, user_id: str):
        return self._db.collection("users").document(user_id).collection("runs")

    async def put(self, user_id: str, record: RunRecord) -> None:
        await self._col(user_id).document(record.run_id).set(record.model_dump(mode="json"))

    async def get(self, user_id: str, run_id: str) -> RunRecord | None:
        snap = await self._col(user_id).document(run_id).get()
        return RunRecord.model_validate(snap.to_dict() or {}) if snap.exists else None

    async def list(self, user_id: str, limit: int = 50) -> list[RunRecord]:
        from google.cloud import firestore

        query = self._col(user_id).order_by("started_at", direction=firestore.Query.DESCENDING).limit(limit)
        return [RunRecord.model_validate(d.to_dict() or {}) async for d in query.stream()]


def make_run_store() -> RunStore:
    return FirestoreRunStore() if firestore_enabled() else MemoryRunStore()


# ---------- helpers ----------


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def target_of(args: Mapping[str, Any]) -> str:
    """The most specific thing a call names: a URL, a vault path, an element ref, a title."""
    for key in TARGET_ARGS:
        value = args.get(key)
        if isinstance(value, list):
            value = ", ".join(str(v) for v in value[:3]) + (f" (+{len(value) - 3})" if len(value) > 3 else "")
        if value not in (None, "", []):
            return str(value)[:200]
    return ""


def error_of(result: Mapping[str, Any]) -> str:
    for key in ("error", "message", "detail"):
        value = result.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip()[:MAX_ERROR_CHARS]
    return "failed"


def result_ok(result: Mapping[str, Any]) -> bool:
    """Tool results carry status success/error (extension `tools.ts`, server tools); absent means success."""
    return str(result.get("status", "success")) != "error"


def _artifact(kind: str, result: Mapping[str, Any]) -> LedgerArtifact:
    url = next((str(result[k]) for k in ARTIFACT_URL_KEYS if isinstance(result.get(k), str) and result[k]), "")
    path = result.get("path") or result.get("file_name") or result.get("course_folder") or ""
    name = posixpath.basename(str(path)) if path else ""
    if not name:
        name = str(result.get("name") or result.get("title") or url or kind)
    return LedgerArtifact(kind=kind, name=str(name)[:200], url=url[:500])


def batch_items(result: Mapping[str, Any]) -> list[Mapping[str, Any]] | None:
    """The per-item results of a batch tool (`download_many`), or None when this is a single result."""
    items = result.get("items")
    if not isinstance(items, list):
        return None
    return [i for i in items if isinstance(i, Mapping)]


def artifacts_of(tool: str, result: Mapping[str, Any]) -> list[LedgerArtifact]:
    """The artifacts a successful result announces. A batch call (`download_many` storing 12 files) announces
    one per stored file, so each of them has its own receipt — an empty list when the tool produces none."""
    kind = ARTIFACT_KINDS.get(tool)
    if kind is None:
        return []
    items = batch_items(result)
    if items is None:
        return [_artifact(kind, result)]
    return [_artifact(kind, item) for item in items if result_ok(item)]


class _ActiveRun:
    """A run in flight: the record plus the bookkeeping that never reaches Firestore."""

    def __init__(self, record: RunRecord) -> None:
        self.record = record
        self.started = time.monotonic()
        self.calls: dict[str, int] = {}  # call_id -> index in record.actions
        self.last_artifact_action = -1  # so the next artifact claims the actions since the previous one


# ---------- the ledger ----------


class RunLedger:
    """Records runs. Every method is non-fatal: a ledger failure is logged, never raised at the caller."""

    def __init__(self, store: RunStore | None = None) -> None:
        self.store = store or make_run_store()
        self._active: dict[str, _ActiveRun] = {}  # session_id -> run in flight (one run per chat at a time)

    # -- lifecycle --

    async def start(self, user_id: str, session_id: str, *, trigger: Trigger = "manual", skill: str = "") -> str:
        """Opens a run for the session and returns its id. A run still open for that session is closed first:
        the user sent a new prompt, so the old one never produced a final answer."""
        try:
            if session_id in self._active:
                await self.finish(session_id, note="superseded by a new prompt before it finished")
            record = RunRecord(
                run_id=secrets.token_urlsafe(12),
                session_id=session_id,
                user_id=user_id,
                skill=skill,
                trigger=trigger,
                started_at=_now(),
            )
            self._active[session_id] = _ActiveRun(record)
            while len(self._active) > MAX_ACTIVE_RUNS:
                self._active.pop(next(iter(self._active)))
            await self._save(record)
            return record.run_id
        except Exception:  # noqa: BLE001 — the ledger must never keep a run from starting
            log.exception("ledger: could not start a run for session %s", session_id)
            return ""

    def called(self, session_id: str, call_id: str, tool: str, args: Mapping[str, Any]) -> None:
        """Appends the call the model just made. Ignores a call_id already recorded: ADK streams every
        function call twice (the partial chunk and the aggregate event)."""
        run = self._active.get(session_id)
        if run is None or not call_id or call_id in run.calls or len(run.record.actions) >= MAX_ACTIONS_KEPT:
            return
        run.calls[call_id] = len(run.record.actions)
        run.record.actions.append(LedgerAction(tool=tool, target=target_of(args), at=_now()))

    def resolved(self, session_id: str, call_id: str, result: Mapping[str, Any]) -> None:
        """Closes the recorded call with its result: browser calls resolve in POST /tool_result, server
        tools in the SSE stream. The first answer wins."""
        run = self._active.get(session_id)
        if run is None:
            return
        index = run.calls.get(call_id)
        if index is None:
            return
        action = run.record.actions[index]
        if action.ok is not None:
            return
        action.ok = result_ok(result)
        if not action.ok:
            action.error = error_of(result)
            run.record.failures.append(f"{action.tool}{f' {action.target}' if action.target else ''}: {action.error}")
            return
        items = batch_items(result)
        if items is not None:  # one call, many files: the run did N chores, not one
            action.count = max(sum(1 for i in items if result_ok(i)), 1)
            for failed in (i for i in items if not result_ok(i)):
                run.record.failures.append(f"{action.tool} {target_of(failed)}: {error_of(failed)}")
        artifacts = artifacts_of(action.tool, result)
        if artifacts:
            produced_by = list(range(run.last_artifact_action + 1, index + 1))
            for artifact in artifacts:
                artifact.produced_by = produced_by
            run.last_artifact_action = index
            run.record.artifacts.extend(artifacts)

    def add_usage(self, session_id: str, turn: Mapping[str, int]) -> None:
        """Adds one turn's token counts to the run. The API books them; the ledger never re-derives them."""
        run = self._active.get(session_id)
        if run is None:
            return
        for key, value in turn.items():
            run.record.usage[key] = run.record.usage.get(key, 0) + int(value)
        run.record.usage["turns"] = run.record.usage.get("turns", 0) + 1

    def note_failure(self, session_id: str, text: str) -> None:
        run = self._active.get(session_id)
        if run is not None and text:
            run.record.failures.append(text[:MAX_ERROR_CHARS])

    async def finish(
        self, session_id: str, price: Callable[[Mapping[str, int]], float] | None = None, note: str = ""
    ) -> RunRecord | None:
        """Closes the run of the session and persists it. `price` turns the booked token counts into dollars
        (the API's own estimator) — the ledger does not know prices."""
        run = self._active.pop(session_id, None)
        if run is None:
            return None
        record = run.record
        try:
            if note:
                record.failures.append(note[:MAX_ERROR_CHARS])
            record.ended_at = _now()
            record.duration_s = round(time.monotonic() - run.started, 1)
            record.counts = dict(Counter(a.tool for a in record.actions))
            record.cost_usd = round(price(record.usage), 6) if price else 0.0
            record.saved_seconds = saved_seconds(record)
            record.chain_head = chain_head(record.actions)
            await self._save(record)
            log.info(
                "ledger run=%s session=%s %s: actions=%d ok=%d artifacts=%d failures=%d %.1fs ≈$%.4f saved≈%ds",
                record.run_id,
                session_id,
                record.trigger,
                len(record.actions),
                record.ok_actions,
                len(record.artifacts),
                len(record.failures),
                record.duration_s,
                record.cost_usd,
                record.saved_seconds,
            )
        except Exception:  # noqa: BLE001 — a run that ended must not fail because of its own bookkeeping
            log.exception("ledger: could not close run %s", record.run_id)
        return record

    def active(self, session_id: str) -> RunRecord | None:
        run = self._active.get(session_id)
        return run.record if run else None

    # -- reading --

    async def list(self, user_id: str, limit: int = 50) -> list[RunRecord]:
        try:
            return await self.store.list(user_id, limit)
        except Exception:  # noqa: BLE001 — the dashboard degrades to empty, it never 500s
            log.exception("ledger: could not list runs for %s", user_id)
            return []

    async def get(self, user_id: str, run_id: str) -> RunRecord | None:
        try:
            return await self.store.get(user_id, run_id)
        except Exception:  # noqa: BLE001
            log.exception("ledger: could not read run %s", run_id)
            return None

    async def _save(self, record: RunRecord) -> None:
        try:
            await self.store.put(record.user_id, record)
        except Exception:  # noqa: BLE001 — Firestore hiccups cost proof of work, never the work itself
            log.exception("ledger: could not persist run %s", record.run_id)


def saved_seconds(record: RunRecord) -> int:
    """What the same steps cost by hand (HUMAN_BASELINE_SECONDS over the SUCCESSFUL actions) minus the
    wall-clock time the run took. Never negative, and never counting work the agent authored."""
    by_hand = sum(HUMAN_BASELINE_SECONDS.get(a.tool, 0) * max(a.count, 1) for a in record.actions if a.ok)
    return max(int(by_hand - record.duration_s), 0)


_default: RunLedger | None = None


def default_ledger() -> RunLedger:
    global _default
    if _default is None:
        _default = RunLedger()
    return _default


def set_default_ledger(ledger: RunLedger | None) -> None:
    global _default
    _default = ledger


# ---------- receipts ----------


class ReceiptFacts(BaseModel):
    """Everything a receipt states, derived from the stored action log only."""

    run_id: str
    artifact_index: int
    artifact: LedgerArtifact
    when: str
    trigger: Trigger
    did: list[str] = Field(default_factory=list)
    did_not: list[str] = Field(default_factory=list)
    unproven: list[str] = Field(default_factory=list, description="Claims the log cannot support, and why.")
    tools_used: list[str] = Field(default_factory=list)
    action_count: int = 0
    chain_head: str = ""
    chain_verified: bool = False


# A claim is printed only when the run's tool names do not intersect the set behind it. Each claim states
# exactly what the log proves — never the wider thing a reader might infer: the agent can post a message by
# clicking Send in a page, so "nothing was published" is not something a tool list can assert.
DID_NOT_CLAIMS: tuple[tuple[str, frozenset[str]], ...] = (
    ("No tool that writes or solves coursework was called.", AUTHORING_TOOLS),
    ("Nothing was typed into a page and no script was run in a page.", INPUT_TOOLS),
    ("No message, issue or pull-request tool was called.", PUBLISHING_TOOLS),
)

# What a click or a keypress in a page could have done, and therefore what the receipt may not deny.
ACTIVATION_CAVEAT = (
    '"Nothing was posted, sent or submitted" is not claimed — the run acted inside pages ({tools}), '
    "and a click or a keypress can activate a Send or Turn-in control."
)

# Plain sentences for what the log shows, in the order a reader expects them.
DID_LINES: tuple[tuple[str, str], ...] = (
    ("download", "Downloaded {n} file(s) from the pages the browser was already signed in to."),
    ("download_many", "Downloaded {n} file(s) in batches from the pages the browser was already signed in to."),
    ("open_tab", "Opened {n} tab(s)."),
    ("navigate", "Navigated {n} time(s)."),
    ("click", "Clicked {n} element(s) to walk the portal's folders."),
    ("click_at", "Clicked {n} point(s) on screen."),
    ("read_page", "Read {n} page(s) to find the next element."),
    ("scroll", "Scrolled {n} time(s)."),
    ("make_folders", "Created the vault folder structure ({n} call(s))."),
    ("plan_vault_folders", "Derived the folder structure from the syllabus ({n} call(s))."),
    ("parse_document", "Extracted the text of {n} document(s)."),
    ("vault_read", "Read {n} file(s) already in the vault."),
    ("vault_list", "Listed the vault ({n} call(s))."),
    ("remember", "Saved {n} durable fact(s) about the courses."),
    ("solve_lab_task", "Wrote and executed Python for {n} lab task(s) — this is authored content."),
    ("build_notebook", "Assembled a notebook and ran every cell as a self-check ({n} call(s))."),
    ("build_report", "Wrote a report page from those results ({n} call(s))."),
    ("generate_courseware", "Generated study material from the syllabus ({n} call(s))."),
    ("build_deck", "Generated a slide deck ({n} call(s))."),
    ("push_files", "Pushed {n} commit(s) to the repository."),
    ("create_repository", "Created {n} repository/ies."),
    ("create_pull_request", "Opened {n} pull request(s)."),
    ("issue_write", "Wrote {n} issue(s)."),
    ("create_issue", "Created {n} issue(s)."),
)


def receipt_facts(record: RunRecord, artifact_index: int) -> ReceiptFacts:
    """The DID / DID NOT statements for one artifact. DID counts only the successful actions that produced
    it; DID NOT is asserted over the WHOLE run, so a claim cannot be true of a slice and false elsewhere.
    Raises IndexError when the artifact does not exist."""
    artifact = record.artifacts[artifact_index]
    slice_indices = artifact.produced_by or list(range(len(record.actions)))
    produced_by = [record.actions[i] for i in slice_indices if 0 <= i < len(record.actions) and record.actions[i].ok]
    counts: Counter[str] = Counter()
    for action in produced_by:  # a batch call did as many things as it has items
        counts[action.tool] += max(action.count, 1)
    did = [text.format(n=counts[tool]) for tool, text in DID_LINES if counts.get(tool)]
    names = {a.tool for a in record.actions}
    unknown_list = ", ".join(sorted(names - KNOWN_TOOLS))
    unknown = bool(unknown_list)
    did_not: list[str] = []
    unproven: list[str] = []
    if unknown:  # one unclassified tool and no negative claim can be proved from this log
        unproven.append(f"Nothing is claimed: the log contains tool(s) this receipt cannot classify: {unknown_list}.")
    else:
        for claim, deny in DID_NOT_CLAIMS:
            used = sorted(names & deny)
            if used:
                unproven.append(f'"{claim}" is not claimed — the run called: {", ".join(used)}.')
            else:
                did_not.append(claim)
        activation = sorted(names & ACTIVATION_TOOLS)
        if activation:
            unproven.append(ACTIVATION_CAVEAT.format(tools=", ".join(activation)))
    return ReceiptFacts(
        run_id=record.run_id,
        artifact_index=artifact_index,
        artifact=artifact,
        when=record.started_at,
        trigger=record.trigger,
        did=did,
        did_not=did_not,
        unproven=unproven,
        tools_used=sorted(names),
        action_count=len(record.actions),
        chain_head=record.chain_head or chain_head(record.actions),
        chain_verified=bool(record.chain_head) and record.chain_head == chain_head(record.actions),
    )
