"""Lab tools (PLAN v2 §Lab solver): notebook assembly, sandboxed local execution and the report page.

`build_notebook` turns the solver's (code, stdout) pairs into a runnable nbformat v4 notebook whose
code cells carry stream outputs, then re-executes it with nbclient (ipykernel subprocess, timeout) so
the outputs shipped to GitHub are real and any cell that fails is reported back to the model instead
of landing in the repo. The .ipynb is also stored under `pages/notebook/{id}.ipynb` and served at
GET /pages/notebook/{id}.ipynb, so `download(url=ipynb_url, path=...)` can put it in the Drive vault and Colab
can open it from there. `build_report` renders the Markdown report and stores it in the PageStore
(kind=report) so the extension can open it and save it to the vault with download(url=page_url).
"""

from __future__ import annotations

import asyncio
import html
import logging
import os
import re
import secrets
import subprocess
import sys
import tempfile
from typing import Any, Literal

import nbformat
from pydantic import BaseModel, ValidationError

from dayflow.core.pages import PageStore, default_pages

log = logging.getLogger("dayflow.lab")

IPYNB_MIME = "application/x-ipynb+json"
EXEC_TIMEOUT_S = 90  # per cell (nbclient) / per script (local sandbox)
MAX_OUTPUT_CHARS = 20_000
LOCAL_EXEC_ENV_KEYS = ("PATH", "LANG", "LC_ALL", "SYSTEMROOT", "TMPDIR")
LOCAL_EXEC_DISABLED = (
    "local code execution is disabled on Cloud Run (model-written code never runs in the brain's container; "
    "set DAYFLOW_LOCAL_EXEC=1 only on a sandboxed deployment)"
)


def local_exec_enabled() -> bool:
    """Model-written code may run in this process's container only on a developer machine (no K_SERVICE)
    or when DAYFLOW_LOCAL_EXEC=1 is set explicitly. On Cloud Run the child would inherit the service
    account's metadata server and network — a crafted lab PDF must not become RCE on the brain."""
    flag = os.getenv("DAYFLOW_LOCAL_EXEC", "")
    if flag == "1":
        return True
    if flag == "0":
        return False
    return not os.getenv("K_SERVICE")


class NotebookCell(BaseModel):
    kind: Literal["markdown", "code"] = "code"
    source: str
    stdout: str = ""


class TaskResult(BaseModel):
    title: str
    approach: str = ""
    result: str = ""
    code: str = ""


# ---------- local sandbox ----------


def run_python(code: str, timeout: int = EXEC_TIMEOUT_S) -> dict[str, Any]:
    """Runs a Python script in a fresh interpreter (`-I`: isolated, no user site) inside an empty temp
    directory with a minimal environment and a wall-clock timeout. Not a security boundary against
    hostile code (the child keeps network and filesystem), which is why it is refused unless
    `local_exec_enabled()` — dev machines only. Returns {ok, stdout, stderr, returncode, timed_out}.
    """
    if not local_exec_enabled():
        return {"ok": False, "stdout": "", "stderr": LOCAL_EXEC_DISABLED, "returncode": -1, "timed_out": False}
    env = {k: v for k, v in os.environ.items() if k in LOCAL_EXEC_ENV_KEYS}
    with tempfile.TemporaryDirectory(prefix="dayflow-lab-") as cwd:
        env["HOME"] = cwd
        env["MPLBACKEND"] = "Agg"
        script = os.path.join(cwd, "task.py")
        with open(script, "w", encoding="utf-8") as f:
            f.write(code)
        try:
            proc = subprocess.run(  # noqa: S603 — interpreter + our own temp file, no shell
                [sys.executable, "-I", script],
                cwd=cwd,
                env=env,
                capture_output=True,
                text=True,
                timeout=timeout,
                check=False,
            )
        except subprocess.TimeoutExpired as e:
            out = e.stdout.decode() if isinstance(e.stdout, bytes) else (e.stdout or "")
            return {
                "ok": False,
                "stdout": out[:MAX_OUTPUT_CHARS],
                "stderr": f"timed out after {timeout}s",
                "returncode": -1,
                "timed_out": True,
            }
    return {
        "ok": proc.returncode == 0,
        "stdout": proc.stdout[:MAX_OUTPUT_CHARS],
        "stderr": proc.stderr[-4000:],
        "returncode": proc.returncode,
        "timed_out": False,
    }


# ---------- notebook ----------


def make_notebook(title: str, cells: list[NotebookCell]) -> nbformat.NotebookNode:
    """nbformat v4 notebook: a title cell, then the given cells; code cells get one stdout stream output
    when `stdout` is non-empty. Validated before it is returned."""
    nb = nbformat.v4.new_notebook()
    nb.metadata["kernelspec"] = {"name": "python3", "display_name": "Python 3", "language": "python"}
    nb.metadata["language_info"] = {"name": "python"}
    own_title = bool(cells) and cells[0].kind == "markdown" and re.match(r"\s*#\s", cells[0].source) is not None
    if title.strip() and not own_title:  # skip the generated title when the model wrote its own h1
        nb.cells.append(nbformat.v4.new_markdown_cell(f"# {title.strip()}"))
    n = 0
    for cell in cells:
        if cell.kind == "markdown":
            nb.cells.append(nbformat.v4.new_markdown_cell(cell.source))
            continue
        n += 1
        outputs = [nbformat.v4.new_output("stream", name="stdout", text=cell.stdout)] if cell.stdout.strip() else []
        nb.cells.append(nbformat.v4.new_code_cell(cell.source, execution_count=n, outputs=outputs))
    nbformat.validate(nb)
    return nb


def _execute_sync(nb: nbformat.NotebookNode, timeout: int) -> None:
    from nbclient import NotebookClient

    NotebookClient(nb, timeout=timeout, kernel_name="python3", allow_errors=False).execute()


async def execute_notebook(nb: nbformat.NotebookNode, cell_timeout: int = EXEC_TIMEOUT_S) -> dict[str, Any]:
    """Executes the notebook in a fresh ipykernel (worker thread; nbclient's sync API) and replaces the
    outputs in place. {executed: True|False|None, error} — None when no kernel is available or when local
    execution is disabled (Cloud Run): the solver's sandbox outputs are kept as they are."""
    if not local_exec_enabled():
        return {"executed": None, "error": LOCAL_EXEC_DISABLED}
    try:
        await asyncio.to_thread(_execute_sync, nb, cell_timeout)
    except ImportError as e:
        return {"executed": None, "error": f"nbclient/ipykernel unavailable: {e}"}
    except Exception as e:  # noqa: BLE001 — CellExecutionError, kernel death, timeouts: all go back to the model
        msg = re.sub(r"\x1b\[[0-9;]*m", "", str(e))  # strip ANSI colours from the traceback
        return {"executed": False, "error": f"{type(e).__name__}: {msg[-2500:]}"}
    return {"executed": True, "error": ""}


def _outputs_text(cell: nbformat.NotebookNode) -> str:
    chunks: list[str] = []
    for out in cell.get("outputs", []):
        if out.get("output_type") == "stream":
            chunks.append(str(out.get("text", "")))
        elif out.get("output_type") in ("execute_result", "display_data"):
            chunks.append(str(out.get("data", {}).get("text/plain", "")))
        elif out.get("output_type") == "error":
            chunks.append("\n".join(out.get("traceback", [])))
    return "".join(chunks)


async def build_notebook(title: str, cells: list[dict[str, str]], execute: bool = True) -> dict:
    """Assembles a runnable Jupyter notebook (nbformat v4) from the solved tasks and returns its JSON,
    ready to be pushed as `lab01.ipynb` with push_files. Each code cell gets a stdout output from the
    `stdout` you pass; the brain then RE-RUNS the whole notebook in a fresh Python kernel (numpy
    available, 90 s per cell) and stores the real outputs — if a cell fails or prints nothing you get an
    error naming the cell: fix that task (solve_lab_task again) and call build_notebook once more.

    Args:
        title: Notebook title, e.g. "CSCI3240 — Lab 01: Image basics".
        cells: Ordered cells as {"kind": "markdown"|"code", "source": <text>, "stdout": <output>}. Put a
            short markdown cell (task title + one line) before each task's code cell; every code cell must be
            self-contained (repeat the setup) and print its results.
        execute: Re-run the notebook before returning (default true; set false only if the kernel is unavailable).
    """
    try:
        parsed = [NotebookCell.model_validate(c) for c in cells]
    except ValidationError as e:
        return {"status": "error", "error": f"invalid cells: {e.errors()[:3]}"}
    if not any(c.kind == "code" for c in parsed):
        return {"status": "error", "error": "no code cells — pass one code cell per task"}
    try:
        nb = make_notebook(title, parsed)
    except nbformat.ValidationError as e:
        return {"status": "error", "error": f"notebook failed nbformat validation: {e}"}
    result: dict[str, Any] = {"executed": None, "exec_error": ""}
    if execute:
        run = await execute_notebook(nb)
        result["executed"] = run["executed"]
        result["exec_error"] = run["error"]
        if run["executed"] is False:
            return {
                "status": "error",
                "error": "the notebook does not run cleanly; fix the failing cell and rebuild. " + run["error"],
                **result,
            }
        if run["executed"] is None:
            log.warning("build_notebook: execution skipped (%s); keeping the solver's stdout", run["error"])
    code_cells = [c for c in nb.cells if c.cell_type == "code"]
    silent = [i + 1 for i, c in enumerate(code_cells) if not _outputs_text(c).strip()]
    if silent:
        return {
            "status": "error",
            "error": f"code cell(s) {silent} produced no output — every task cell must print its result",
            **result,
        }
    ipynb = nbformat.writes(nb, split_lines=False)  # one string per source: fewer tokens for the model to copy
    pages = default_pages()
    page_id = await save_notebook(ipynb.encode(), pages)
    return {
        "status": "success",
        "file_name": "lab01.ipynb",
        "code_cells": len(code_cells),
        "ipynb_json": ipynb,
        "ipynb_url": notebook_url(page_id, pages),
        "outputs_preview": [_outputs_text(c)[:200] for c in code_cells],
        **result,
        "next": 'Drive/Colab: download(url=ipynb_url, path="<course>/Lab NN/<file_name>") saves it to the vault; then '
        'open_tab("https://colab.research.google.com/drive/<drive_file_id from that result>"). GitHub: pass '
        "ipynb_json VERBATIM as the content of the .ipynb entry in push_files (do not reformat it), together with "
        "README.md, TODO.md, REPORT.md, requirements.txt (numpy, jupyter) and .gitignore in ONE call.",
    }


def notebook_key(page_id: str) -> str:
    return f"pages/notebook/{page_id}.ipynb"


def notebook_url(page_id: str, pages: PageStore | None = None) -> str:
    return (pages or default_pages()).url_for("notebook", page_id) + ".ipynb"


async def save_notebook(data: bytes, pages: PageStore | None = None) -> str:
    """Stores the .ipynb bytes next to the HTML pages and returns the unguessable id it is served under."""
    page_id = secrets.token_urlsafe(16)
    await (pages or default_pages()).blobs.put(notebook_key(page_id), data, IPYNB_MIME)
    return page_id


async def load_notebook(page_id: str, pages: PageStore | None = None) -> bytes | None:
    store = pages or default_pages()
    if not store.valid_id(page_id):
        return None
    return await store.blobs.get(notebook_key(page_id))


# ---------- report ----------


def render_report_markdown(course: str, lab: str, tasks: list[TaskResult], summary: str = "") -> str:
    lines = [f"# {course} — {lab}: report", ""]
    if summary.strip():
        lines += [summary.strip(), ""]
    lines += ["## Tasks", ""]
    for i, t in enumerate(tasks, start=1):
        lines.append(f"### {i}. {t.title.strip()}")
        lines.append("")
        if t.approach.strip():
            lines += [f"**Approach.** {t.approach.strip()}", ""]
        if t.code.strip():
            lines += ["```python", t.code.rstrip(), "```", ""]
        if t.result.strip():
            lines += ["**Result.**", "", "```", t.result.rstrip(), "```", ""]
    lines += [
        "## How to run",
        "",
        "```bash",
        "pip install -r requirements.txt",
        "jupyter nbconvert --to notebook --execute lab01.ipynb",
        "```",
        "",
        "_Generated by Dayflow: every cell was executed by the agent before this report was written._",
        "",
    ]
    return "\n".join(lines)


def markdown_to_html(md: str, title: str = "Report") -> str:
    """Small Markdown subset → HTML (headings, fenced code, lists, paragraphs, inline code/bold). No deps."""
    out: list[str] = []
    para: list[str] = []
    in_list = False
    fence: list[str] | None = None

    def inline(text: str) -> str:
        text = html.escape(text)
        text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
        text = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)
        return re.sub(r"(?<![\w*])_([^_]+)_(?![\w*])", r"<em>\1</em>", text)

    def flush_para() -> None:
        if para:
            out.append(f"<p>{inline(' '.join(para))}</p>")
            para.clear()

    def close_list() -> None:
        nonlocal in_list
        if in_list:
            out.append("</ul>")
            in_list = False

    for raw in md.splitlines():
        line = raw.rstrip()
        if fence is not None:
            if line.startswith("```"):
                out.append(f"<pre><code>{html.escape(chr(10).join(fence))}</code></pre>")
                fence = None
            else:
                fence.append(raw)
            continue
        if line.startswith("```"):
            flush_para()
            close_list()
            fence = []
            continue
        m = re.match(r"^(#{1,6})\s+(.*)$", line)
        if m:
            flush_para()
            close_list()
            out.append(f"<h{len(m.group(1))}>{inline(m.group(2))}</h{len(m.group(1))}>")
            continue
        if re.match(r"^\s*[-*]\s+", line):
            flush_para()
            if not in_list:
                out.append("<ul>")
                in_list = True
            out.append(f"<li>{inline(re.sub(r'^\s*[-*]\s+', '', line))}</li>")
            continue
        if not line.strip():
            flush_para()
            close_list()
            continue
        para.append(line.strip())
    if fence is not None:
        out.append(f"<pre><code>{html.escape(chr(10).join(fence))}</code></pre>")
    flush_para()
    close_list()
    body = "\n".join(out)
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        f'<meta name="viewport" content="width=device-width,initial-scale=1"><title>{html.escape(title)}</title>'
        "<style>body{font:16px/1.55 system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}"
        "pre{background:#f4f4f5;padding:.8rem 1rem;overflow:auto;border-radius:6px}"
        "code{font-family:ui-monospace,monospace;font-size:.92em}"
        "h1{font-size:1.7rem}h2{margin-top:2rem}h3{margin-top:1.4rem}</style></head>"
        f"<body>{body}</body></html>"
    )


async def build_report(course: str, lab: str, tasks: list[dict[str, str]], summary: str = "") -> dict:
    """Writes the lab report: Markdown (push it as REPORT.md) plus a rendered HTML page served by the brain
    at `page_url`. Save the page to the vault afterwards with
    download(url=page_url, path="<course>/<Lab NN>/REPORT.html") and open it in a tab for the user.

    Args:
        course: Course, e.g. "CSCI3240 Introduction to Computer Vision".
        lab: Lab name, e.g. "Lab 01 - Image basics".
        tasks: One entry per task, in order: {"title": ..., "approach": <how it was solved, 1–3 sentences>,
            "result": <the printed output or the key numbers>, "code": <the final code, optional>}.
        summary: Optional 2–4 sentence overview (what the lab covered, what was verified, what is left).
    """
    try:
        parsed = [TaskResult.model_validate(t) for t in tasks]
    except ValidationError as e:
        return {"status": "error", "error": f"invalid tasks: {e.errors()[:3]}"}
    if not parsed:
        return {"status": "error", "error": "tasks is empty — pass one entry per solved task"}
    markdown = render_report_markdown(course, lab, parsed, summary)
    page = await default_pages().put("report", markdown_to_html(markdown, f"{course} — {lab} report"))
    return {
        "status": "success",
        "file_name": "REPORT.md",
        "markdown": markdown,
        "page_id": page["id"],
        "page_url": page["url"],
        "next": "push_files REPORT.md with `markdown`; then download(url=page_url, "
        "path='<course>/<Lab NN>/REPORT.html').",
    }


LAB_TOOLS = [build_notebook, build_report]
