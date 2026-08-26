# /// script
# requires-python = ">=3.11"
# dependencies = ["nbformat>=5.10", "nbclient>=0.10", "ipykernel>=6.29", "numpy>=2", "matplotlib>=3.9", "pillow>=10"]
# ///
"""Validates (and optionally executes) a Jupyter notebook for the lab scene (PLAN v2 §Lab solver).

Usage: python nbcheck.py <notebook.ipynb> [--execute] [--timeout 120]
Prints one JSON object:
  {"valid": bool, "errors": [...], "code_cells": n, "cells_with_outputs": n, "cells_with_nonempty_outputs": n,
   "executed": true|false|null, "exec_error": str|null, "exec_seconds": float|null}
Exit code 0 when the static checks pass (and execution, if requested and available, succeeded); 1 otherwise.

Static checks (stdlib only): nbformat >= 4, `cells` list, at least one code cell, every code cell has an
`outputs` list and a `source`. Execution needs nbclient + ipykernel: run through `uv run --script` (inline
deps above) for a self-contained venv, or with any interpreter that already has them; when they are
missing, `executed` is null and the static verdict stands.
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from typing import Any


def static_check(doc: Any) -> dict[str, Any]:
    errors: list[str] = []
    if not isinstance(doc, dict):
        return {
            "valid": False,
            "errors": ["notebook is not a JSON object"],
            "code_cells": 0,
            "cells_with_outputs": 0,
            "cells_with_nonempty_outputs": 0,
        }
    nbformat = doc.get("nbformat")
    if not isinstance(nbformat, int) or nbformat < 4:
        errors.append(f"nbformat is {nbformat!r}, expected >= 4")
    cells = doc.get("cells")
    if not isinstance(cells, list):
        errors.append("`cells` is not a list")
        cells = []
    code = [c for c in cells if isinstance(c, dict) and c.get("cell_type") == "code"]
    if not code:
        errors.append("no code cells")
    with_outputs = 0
    nonempty = 0
    for i, c in enumerate(code):
        src = c.get("source")
        if not (
            isinstance(src, str)
            or (isinstance(src, list) and all(isinstance(s, str) for s in src))
        ):
            errors.append(f"code cell {i}: `source` is not a string or list of strings")
        outs = c.get("outputs")
        if not isinstance(outs, list):
            errors.append(f"code cell {i}: `outputs` is missing or not a list")
            continue
        with_outputs += 1
        if outs:
            nonempty += 1
    if code and nonempty == 0:
        errors.append(
            "no code cell has a non-empty `outputs` list (the solver did not run the code)"
        )
    return {
        "valid": not errors,
        "errors": errors,
        "code_cells": len(code),
        "cells_with_outputs": with_outputs,
        "cells_with_nonempty_outputs": nonempty,
    }


def execute(path: Path, timeout: int) -> tuple[bool | None, str | None, float | None]:
    try:
        import nbformat  # type: ignore[import-not-found]
        from nbclient import NotebookClient  # type: ignore[import-not-found]
    except ImportError as e:
        return (
            None,
            f"nbclient not importable ({e}); run via `uv run --script harness/lib/nbcheck.py --execute`",
            None,
        )
    started = time.monotonic()
    try:
        nb = nbformat.read(str(path), as_version=4)
        client = NotebookClient(
            nb,
            timeout=timeout,
            kernel_name="python3",
            allow_errors=False,
            resources={"metadata": {"path": str(path.parent)}},
        )
        client.execute()
        return True, None, round(time.monotonic() - started, 2)
    except Exception as e:  # noqa: BLE001 — surface any kernel/cell failure as the verdict
        return (
            False,
            f"{type(e).__name__}: {str(e)[:800]}",
            round(time.monotonic() - started, 2),
        )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("notebook")
    ap.add_argument("--execute", action="store_true")
    ap.add_argument("--timeout", type=int, default=120)
    a = ap.parse_args()
    path = Path(a.notebook)
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        print(
            json.dumps(
                {
                    "valid": False,
                    "errors": [f"cannot read notebook: {e}"],
                    "executed": None,
                }
            )
        )
        return 1
    out = static_check(doc)
    out.update({"executed": None, "exec_error": None, "exec_seconds": None})
    if a.execute and out["valid"]:
        executed, err, secs = execute(path, a.timeout)
        out.update({"executed": executed, "exec_error": err, "exec_seconds": secs})
    print(json.dumps(out))
    return 0 if out["valid"] and out["executed"] is not False else 1


if __name__ == "__main__":
    sys.exit(main())
