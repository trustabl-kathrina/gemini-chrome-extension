"""Lab solver (PLAN v2 §Lab solver): an LlmAgent with Gemini's built-in code execution, exposed to the
orchestrator as the AgentTool `solve_lab_task(task_text, context)` → {code, stdout, notes}.

The sub-agent writes a self-contained script, runs it in Gemini's sandbox (numpy available) and checks
the printed output; `LabSolverTool` reads the executable_code / code_execution_result parts from the
run instead of trusting the model to quote its own code, so what lands in the notebook is exactly what
was executed. When the model's code execution is unavailable (a model or endpoint without the tool, a
quota error) the tool falls back to asking Gemini for the script and running it in the brain's local
sandbox (`tools.lab.run_python`: fresh interpreter, temp cwd, timeout), retrying once on a traceback.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from google.adk.agents import LlmAgent
from google.adk.artifacts import InMemoryArtifactService
from google.adk.code_executors import BuiltInCodeExecutor
from google.adk.runners import Runner
from google.adk.sessions import InMemorySessionService
from google.adk.tools import ToolContext
from google.adk.tools.agent_tool import AgentTool
from google.genai import types
from pydantic import BaseModel, Field

from dayflow.models.registry import registry
from dayflow.tools.lab import run_python

log = logging.getLogger("dayflow.lab_solver")

SOLVER_NAME = "solve_lab_task"
FENCE_RE = re.compile(r"```(?:python|py)?\s*\n(.*?)```", re.DOTALL)


class LabTask(BaseModel):
    task_text: str = Field(description="The full text of ONE task from the lab, verbatim (numbering included).")
    context: str = Field(
        default="",
        description="Everything the task depends on: the lab's shared setup code/data snippet, the course and lab "
        "name, constraints (e.g. 'numpy only'). Repeat it for every task; tasks are solved independently.",
    )


SOLVER_INSTRUCTION = """You solve ONE task of a university programming lab in Python and you must RUN the code.

Rules:
- Write a single self-contained script: include the setup from the context at the top (imports, sample
  data), then the solution. Only numpy and the standard library; no files, no network, no plots — print
  numbers and text instead of drawing.
- Print every result the task asks for, with short labels (e.g. "shape: (64, 64, 3)").
- Execute the script with the code execution tool. Read the output and compare it with what the task
  expects; if something is off or an exception occurs, fix the script and run it again. The last run must
  succeed and its output must be complete.
- Reply, after the run, with 2–4 sentences: the approach and how the printed output matches the task's
  expectations. Do not paste the code or the output again — they are captured from the execution.
"""


def build_lab_solver(model: str | None = None) -> LlmAgent:
    return LlmAgent(
        name=SOLVER_NAME,
        model=model or registry().solver,
        description=(
            "Solves ONE lab task with Python: writes a self-contained script, runs it (numpy available) and "
            "returns {code, stdout, notes}. Call it once per task with the task's full text and the lab's "
            "shared setup as context; keep code + stdout for build_notebook and build_report."
        ),
        instruction=SOLVER_INSTRUCTION,
        input_schema=LabTask,
        code_executor=BuiltInCodeExecutor(),
    )


def _extract_code(text: str) -> str:
    blocks = FENCE_RE.findall(text)
    return blocks[-1].strip() if blocks else ""


def _clean(text: str) -> str:
    return re.sub(r"\n{3,}", "\n\n", text).strip()


class Solved(BaseModel):
    code: str = ""
    stdout: str = ""
    notes: str = ""
    outcome: str = ""
    runs: int = 0


def collect(events_parts: list[list[types.Part]]) -> Solved:
    """Reads the sub-agent's parts: the last executed script with an OK result wins; text becomes notes."""
    solved = Solved()
    pending: dict[str, str] = {}
    last_code = ""
    notes: list[str] = []
    for parts in events_parts:
        for p in parts:
            if p.executable_code and p.executable_code.code:
                last_code = p.executable_code.code
                if p.executable_code.id:
                    pending[p.executable_code.id] = last_code
            if p.code_execution_result:
                res = p.code_execution_result
                code = pending.get(res.id or "", last_code)
                outcome = str(res.outcome or "")
                solved.runs += 1
                if "OK" in outcome or not solved.code:
                    solved.code, solved.stdout, solved.outcome = code, res.output or "", outcome
            if p.text and not p.thought:
                notes.append(p.text)
    solved.notes = _clean("\n".join(notes))
    return solved


class LabSolverTool(AgentTool):
    """AgentTool over the solver that returns a dict instead of the sub-agent's final text."""

    def __init__(self, agent: LlmAgent | None = None) -> None:
        super().__init__(agent or build_lab_solver(), skip_summarization=True, include_plugins=False)

    async def _run_agent(self, task: LabTask, tool_context: ToolContext) -> Solved:
        inv = tool_context._invocation_context  # noqa: SLF001 — same access AgentTool itself uses
        app_name = inv.app_name if inv else self.agent.name
        runner = Runner(
            app_name=app_name,
            agent=self.agent,
            artifact_service=InMemoryArtifactService(),
            session_service=InMemorySessionService(),
        )
        session = await runner.session_service.create_session(app_name=app_name, user_id=tool_context.user_id)
        content = types.Content(role="user", parts=[types.Part.from_text(text=task.model_dump_json())])
        parts: list[list[types.Part]] = []
        error = ""
        try:
            async for ev in runner.run_async(user_id=session.user_id, session_id=session.id, new_message=content):
                if ev.error_message:
                    error = ev.error_message
                if ev.content and ev.content.parts and not ev.partial:
                    parts.append(list(ev.content.parts))
        finally:
            await runner.close()
        solved = collect(parts)
        if not solved.code and error:
            raise RuntimeError(error)
        return solved

    async def _fallback(self, task: LabTask, reason: str) -> dict[str, Any]:
        """No sandbox run happened: ask Gemini for the script, run it locally, feed a traceback back once."""
        from dayflow.tools.server import client

        log.warning("solve_lab_task: falling back to local execution (%s)", reason)
        prompt = (
            f"{SOLVER_INSTRUCTION}\nYou cannot execute code here: reply with the complete script in ONE ```python "
            f"fence, then 2–4 sentences of notes.\n\nContext:\n{task.context}\n\nTask:\n{task.task_text}"
        )
        history: list[types.ContentUnion] = [types.Content(role="user", parts=[types.Part.from_text(text=prompt)])]
        last: dict[str, Any] = {}
        for attempt in range(2):
            resp = await client().aio.models.generate_content(model=registry().solver, contents=history)
            text = resp.text or ""
            code = _extract_code(text)
            if not code:
                return {"status": "error", "error": "the model returned no python code block", "notes": text[:800]}
            run = run_python(code)
            last = {
                "status": "success" if run["ok"] else "error",
                "code": code,
                "stdout": run["stdout"],
                "notes": _clean(FENCE_RE.sub("", text)),
                "executor": "local",
                "attempts": attempt + 1,
                **({} if run["ok"] else {"error": run["stderr"] or "non-zero exit"}),
            }
            if run["ok"] and run["stdout"].strip():
                return last
            history.append(types.Content(role="model", parts=[types.Part.from_text(text=text)]))
            feedback = run["stderr"] or "the script printed nothing — print every result"
            history.append(
                types.Content(
                    role="user", parts=[types.Part.from_text(text=f"Running it failed:\n{feedback}\nFix it.")]
                )
            )
        return last

    async def run_async(self, *, args: dict[str, Any], tool_context: ToolContext) -> Any:
        task = LabTask.model_validate(args)
        if not task.task_text.strip():
            return {"status": "error", "error": "task_text is empty"}
        try:
            solved = await self._run_agent(task, tool_context)
        except Exception as e:  # noqa: BLE001 — model/endpoint errors become the fallback path, not a crash
            log.exception("solve_lab_task: sub-agent failed")
            return await self._fallback(task, f"{type(e).__name__}: {e}")
        if solved.code and solved.stdout.strip() and "OK" in solved.outcome:
            return {
                "status": "success",
                "code": solved.code,
                "stdout": solved.stdout,
                "notes": solved.notes,
                "executor": "gemini",
                "runs": solved.runs,
            }
        if solved.code:
            # The sandbox ran but the last result was not clean (or silent): confirm locally before giving up.
            run = run_python(solved.code)
            if run["ok"] and run["stdout"].strip():
                return {
                    "status": "success",
                    "code": solved.code,
                    "stdout": run["stdout"],
                    "notes": solved.notes,
                    "executor": "local-verify",
                    "runs": solved.runs,
                }
            return {
                "status": "error",
                "error": f"the script did not run cleanly ({solved.outcome or 'no result'}): {run['stderr'][-800:]}",
                "code": solved.code,
                "stdout": solved.stdout or run["stdout"],
                "notes": solved.notes,
            }
        code = _extract_code(solved.notes)
        if code:
            run = run_python(code)
            if run["ok"] and run["stdout"].strip():
                return {
                    "status": "success",
                    "code": code,
                    "stdout": run["stdout"],
                    "notes": _clean(FENCE_RE.sub("", solved.notes)),
                    "executor": "local",
                }
        return await self._fallback(task, "no code execution parts in the sub-agent's answer")


def lab_solver_tool() -> LabSolverTool:
    return LabSolverTool()
