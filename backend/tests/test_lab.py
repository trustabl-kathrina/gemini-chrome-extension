"""Lab tools (build_notebook / build_report / local sandbox) + the solve_lab_task AgentTool."""

from __future__ import annotations

import json
from collections.abc import Iterator
from typing import Any

import pytest
from google.adk.agents import LlmAgent
from google.genai import types

from dayflow.agents import lab_solver
from dayflow.agents.lab_solver import LabSolverTool, LabTask, collect
from dayflow.core.loader import default_config
from dayflow.core.pages import PageStore, set_default_pages
from dayflow.core.vault import MemoryBlobStore
from dayflow.models.registry import registry
from dayflow.tools import lab
from dayflow.tools.lab import (
    LOCAL_EXEC_DISABLED,
    build_notebook,
    build_report,
    local_exec_enabled,
    markdown_to_html,
    run_python,
)

SETUP = "import numpy as np\nH, W = 64, 64\nimg = np.zeros((H, W, 3), dtype=np.uint8)\n"
CELLS = [
    {"kind": "markdown", "source": "## Task 1"},
    {"kind": "code", "source": SETUP + "print('shape:', img.shape)", "stdout": "shape: (64, 64, 3)\n"},
    {"kind": "markdown", "source": "## Task 2"},
    {"kind": "code", "source": SETUP + "print('mean:', img.mean())", "stdout": "mean: 0.0\n"},
]


@pytest.fixture
def pages() -> Iterator[PageStore]:
    store = PageStore(MemoryBlobStore(), public_url="http://brain.test")
    set_default_pages(store)
    yield store
    set_default_pages(None)


# ---------- local sandbox ----------


def test_run_python_captures_stdout_errors_and_timeouts() -> None:
    ok = run_python("import numpy as np\nprint(np.arange(3).sum())")
    assert ok["ok"] and ok["stdout"].strip() == "3"
    bad = run_python("raise ValueError('boom')")
    assert not bad["ok"] and "ValueError: boom" in bad["stderr"]
    slow = run_python("import time; time.sleep(5)", timeout=1)
    assert not slow["ok"] and slow["timed_out"]


async def test_model_code_never_runs_in_the_brain_on_cloud_run(monkeypatch: pytest.MonkeyPatch) -> None:
    """A lab PDF is untrusted input; on Cloud Run (K_SERVICE set) the local sandbox and the nbclient
    re-execution are refused unless DAYFLOW_LOCAL_EXEC=1 opts in explicitly."""
    monkeypatch.setenv("K_SERVICE", "dayflow-brain")
    monkeypatch.delenv("DAYFLOW_LOCAL_EXEC", raising=False)
    assert not local_exec_enabled()
    run = run_python("import urllib.request; print(urllib.request.urlopen('http://metadata.google.internal').read())")
    assert run == {"ok": False, "stdout": "", "stderr": LOCAL_EXEC_DISABLED, "returncode": -1, "timed_out": False}
    out = await build_notebook("Lab 01", CELLS)
    assert out["status"] == "success" and out["executed"] is None and "disabled on Cloud Run" in out["exec_error"]
    assert json.loads(out["ipynb_json"])["cells"][2]["outputs"][0]["text"] == "shape: (64, 64, 3)\n"
    monkeypatch.setenv("DAYFLOW_LOCAL_EXEC", "1")
    assert local_exec_enabled() and run_python("print(1)")["ok"]
    monkeypatch.delenv("K_SERVICE")
    monkeypatch.setenv("DAYFLOW_LOCAL_EXEC", "0")
    assert not local_exec_enabled()


# ---------- notebook ----------


async def test_build_notebook_without_execution_keeps_the_solver_stdout() -> None:
    out = await build_notebook("Lab 01", CELLS, execute=False)
    assert out["status"] == "success" and out["code_cells"] == 2 and out["executed"] is None
    nb = json.loads(out["ipynb_json"])
    assert nb["nbformat"] == 4 and nb["cells"][0]["source"].startswith("# Lab 01")
    code = [c for c in nb["cells"] if c["cell_type"] == "code"]
    assert all(c["outputs"][0]["output_type"] == "stream" for c in code)
    assert code[0]["outputs"][0]["text"] == "shape: (64, 64, 3)\n"
    assert all("id" in c for c in nb["cells"]), "nbformat 4.5 cells carry ids"
    # the model's own heading wins over the generated title cell (no duplicate titles)
    own = await build_notebook("Lab 01", [{"kind": "markdown", "source": "# Mine"}, *CELLS[1:]], execute=False)
    assert [c["source"] for c in json.loads(own["ipynb_json"])["cells"]][:2] == ["# Mine", CELLS[1]["source"]]


async def test_build_notebook_executes_and_replaces_outputs() -> None:
    cells = [{"kind": "code", "source": "print(6 * 7)", "stdout": "stale"}]
    out = await build_notebook("t", cells)
    assert out["status"] == "success" and out["executed"] is True, out
    nb = json.loads(out["ipynb_json"])
    assert nb["cells"][1]["outputs"][0]["text"].strip() == "42"


async def test_build_notebook_reports_failing_and_silent_cells() -> None:
    failing = await build_notebook("t", [{"kind": "code", "source": "print(1)"}, {"kind": "code", "source": "1/0"}])
    assert failing["status"] == "error" and "ZeroDivisionError" in failing["error"]
    silent = await build_notebook("t", [{"kind": "code", "source": "x = 1"}], execute=False)
    assert silent["status"] == "error" and "cell(s) [1]" in silent["error"]
    empty = await build_notebook("t", [{"kind": "markdown", "source": "only prose"}], execute=False)
    assert empty["status"] == "error" and "no code cells" in empty["error"]
    invalid = await build_notebook("t", [{"kind": "video", "source": "x"}], execute=False)
    assert invalid["status"] == "error" and "invalid cells" in invalid["error"]


# ---------- report ----------


async def test_build_report_writes_markdown_and_a_page(pages: PageStore) -> None:
    tasks = [
        {"title": "Build the gradient", "approach": "np.linspace per channel", "result": "means 127.5 127.5 128.0"},
        {"title": "Grayscale", "approach": "weighted sum", "result": "gray[0,0]=15", "code": "print('hi')"},
    ]
    out = await build_report("CSCI3240 Introduction to Computer Vision", "Lab 01", tasks, summary="Two tasks.")
    assert out["status"] == "success" and out["file_name"] == "REPORT.md"
    md = out["markdown"]
    assert md.startswith("# CSCI3240 Introduction to Computer Vision — Lab 01: report")
    assert "### 1. Build the gradient" in md and "```python\nprint('hi')\n```" in md and len(md) > 200
    assert out["page_url"] == f"http://brain.test/pages/report/{out['page_id']}"
    html = await pages.get("report", out["page_id"])
    assert html is not None and "<h3>2. Grayscale</h3>" in html and "<pre><code>print(&#x27;hi&#x27;)" in html
    assert (await build_report("c", "l", []))["status"] == "error"


def test_markdown_to_html_subset() -> None:
    html = markdown_to_html("# T\n\npara **bold** `x<y`\n\n- a\n- b\n\n```\n<raw>\n```\n")
    assert "<h1>T</h1>" in html and "<strong>bold</strong>" in html and "<code>x&lt;y</code>" in html
    assert "<ul>\n<li>a</li>\n<li>b</li>\n</ul>" in html and "<pre><code>&lt;raw&gt;</code></pre>" in html


# ---------- solver ----------


def test_registry_has_a_solver_role() -> None:
    assert registry().solver.startswith("gemini")


def test_pack_has_the_lab_skill_with_the_lab_tools() -> None:
    skill = default_config().skill("lab")
    assert skill is not None
    assert {"solve_lab_task", "build_notebook", "build_report", "push_files", "download"} <= set(skill.tools)
    assert "solve_lab_task(task_text" in skill.instructions and "REPORT.html" in skill.instructions


def test_solver_tool_declaration_exposes_task_text_and_context() -> None:
    tool = LabSolverTool()
    assert tool.name == "solve_lab_task"
    decl = tool._get_declaration()
    schema = decl.parameters_json_schema or (decl.parameters.model_dump() if decl.parameters else {})
    props = schema.get("properties", {})
    assert set(props) == {"task_text", "context"}
    agent = tool.agent
    assert isinstance(agent, LlmAgent)
    assert agent.code_executor is not None and "RUN the code" in str(agent.instruction)


def _exec_parts(code: str, output: str, outcome: str = "OUTCOME_OK", call_id: str = "c1") -> list[types.Part]:
    return [
        types.Part(executable_code=types.ExecutableCode(code=code, language=types.Language.PYTHON, id=call_id)),
        types.Part(
            code_execution_result=types.CodeExecutionResult(outcome=types.Outcome(outcome), output=output, id=call_id)
        ),
    ]


def test_collect_prefers_the_last_successful_run_and_keeps_notes() -> None:
    events = [
        _exec_parts("print(1/0)", "ZeroDivisionError", "OUTCOME_FAILED", "a"),
        _exec_parts("print(42)", "42\n", "OUTCOME_OK", "b"),
        [types.Part(text="Fixed the division; the output is 42 as expected.")],
        [types.Part(text="hidden", thought=True)],
    ]
    solved = collect(events)
    assert solved.code == "print(42)" and solved.stdout == "42\n" and solved.runs == 2
    assert solved.outcome.endswith("OK") and solved.notes.startswith("Fixed") and "hidden" not in solved.notes


class _Ctx:
    """Just enough ToolContext for run_async: user id + a None invocation context."""

    user_id = "u"
    _invocation_context = None


async def test_run_async_returns_the_executed_code(monkeypatch: pytest.MonkeyPatch) -> None:
    tool = LabSolverTool()

    async def fake_run(self: LabSolverTool, task: LabTask, ctx: Any) -> lab_solver.Solved:
        assert task.task_text.startswith("Task 1")
        return collect([_exec_parts("print('ok')", "ok\n"), [types.Part(text="Done.")]])

    monkeypatch.setattr(LabSolverTool, "_run_agent", fake_run)
    out = await tool.run_async(args={"task_text": "Task 1. print ok", "context": "numpy only"}, tool_context=_Ctx())  # type: ignore[arg-type]
    assert out == {
        "status": "success",
        "code": "print('ok')",
        "stdout": "ok\n",
        "notes": "Done.",
        "executor": "gemini",
        "runs": 1,
    }
    assert (await tool.run_async(args={"task_text": " "}, tool_context=_Ctx()))["status"] == "error"  # type: ignore[arg-type]


async def test_run_async_verifies_a_failed_sandbox_run_locally(monkeypatch: pytest.MonkeyPatch) -> None:
    tool = LabSolverTool()

    async def fake_run(self: LabSolverTool, task: LabTask, ctx: Any) -> lab_solver.Solved:
        # The sandbox reported a failure although the script is fine (e.g. a sandbox hiccup): local run decides.
        return collect([_exec_parts("print(2 + 2)", "", "OUTCOME_FAILED")])

    monkeypatch.setattr(LabSolverTool, "_run_agent", fake_run)
    out = await tool.run_async(args={"task_text": "Task 2. add"}, tool_context=_Ctx())  # type: ignore[arg-type]
    assert out["status"] == "success" and out["executor"] == "local-verify" and out["stdout"].strip() == "4"

    async def broken(self: LabSolverTool, task: LabTask, ctx: Any) -> lab_solver.Solved:
        return collect([_exec_parts("raise RuntimeError('x')", "", "OUTCOME_FAILED")])

    monkeypatch.setattr(LabSolverTool, "_run_agent", broken)
    out = await tool.run_async(args={"task_text": "Task 3."}, tool_context=_Ctx())  # type: ignore[arg-type]
    assert out["status"] == "error" and "RuntimeError" in out["error"] and out["code"].startswith("raise")


async def test_run_async_falls_back_to_local_execution_when_the_sandbox_is_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Code execution rejected by the endpoint → ask Gemini for the script, run it in the brain, retry once."""
    tool = LabSolverTool()

    async def unavailable(self: LabSolverTool, task: LabTask, ctx: Any) -> lab_solver.Solved:
        raise RuntimeError("400 code_execution is not supported for this model")

    monkeypatch.setattr(LabSolverTool, "_run_agent", unavailable)
    replies = iter(["```python\nprint(undefined_name)\n```\nnotes 1", "```python\nprint('fixed')\n```\nnotes 2"])
    prompts: list[list[types.Content]] = []

    class _Models:
        async def generate_content(self, *, model: str, contents: list[types.Content]) -> Any:
            prompts.append(list(contents))
            return types.GenerateContentResponse(
                candidates=[types.Candidate(content=types.Content(parts=[types.Part(text=next(replies))]))]
            )

    class _Client:
        class aio:  # noqa: N801 — mirrors google-genai's `client.aio.models`
            models = _Models()

    monkeypatch.setattr("dayflow.tools.server.client", lambda: _Client())
    out = await tool.run_async(args={"task_text": "Task 1. print", "context": "ctx"}, tool_context=_Ctx())  # type: ignore[arg-type]
    assert out["status"] == "success" and out["executor"] == "local" and out["attempts"] == 2
    assert out["code"] == "print('fixed')" and out["stdout"].strip() == "fixed" and out["notes"] == "notes 2"
    # the retry carried the traceback back to the model
    assert "NameError" in (prompts[1][-1].parts or [types.Part()])[0].text  # type: ignore[union-attr]


def test_lab_tools_are_registered_on_the_orchestrator() -> None:
    from dayflow.agents.orchestrator import build_root_agent
    from dayflow.core.loader import MemoryConfigStore

    tools: list[Any] = list(build_root_agent(MemoryConfigStore()).tools)
    names = {str(getattr(t, "name", None) or getattr(t, "__name__", "")) for t in tools}
    assert {"build_notebook", "build_report", "solve_lab_task"} <= names
    assert lab.LAB_TOOLS == [build_notebook, build_report]


async def test_build_notebook_serves_the_ipynb_for_drive_and_colab(pages: PageStore) -> None:
    import httpx

    from dayflow.api.app import create_app
    from dayflow.core.loader import MemoryConfigStore
    from dayflow.tools.lab import IPYNB_MIME, load_notebook

    out = await build_notebook("Lab 01", CELLS, execute=False)
    url = out["ipynb_url"]
    assert url.startswith("http://brain.test/pages/notebook/") and url.endswith(".ipynb")
    page_id = url.rsplit("/", 1)[1].removesuffix(".ipynb")
    assert (await load_notebook(page_id, pages)) == out["ipynb_json"].encode()
    assert await load_notebook("../etc/passwd", pages) is None
    assert "colab.research.google.com/drive/" in out["next"] and "push_files" in out["next"]

    app = create_app(store=MemoryConfigStore(), runner=object(), pages=pages)  # type: ignore[arg-type]
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://brain.test") as c:
        res = await c.get(f"/pages/notebook/{page_id}.ipynb")
        assert res.status_code == 200 and res.headers["content-type"].startswith(IPYNB_MIME)
        assert json.loads(res.content)["nbformat"] == 4
        assert (await c.get("/pages/notebook/nope.ipynb")).status_code == 404
