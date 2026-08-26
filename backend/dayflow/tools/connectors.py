"""MCP connectors — instantiated only when the corresponding token is present.

Per-user OAuth tokens (stored in Secret Manager) replace the env vars once "Connect GitHub/Linear"
exists in the extension; the toolset construction stays identical.

Harness mode (`DAYFLOW_FAKE_CONNECTORS=1`): the same tool names are served by in-process stubs that
append `{"tool", "args", "result"}` JSON lines to `DAYFLOW_FAKE_LOG` (default
/tmp/dayflow-fake-connectors.jsonl) and return plausible results, so `make e2e` can assert on
what the agent would have done to GitHub/Linear without touching either.
"""

from __future__ import annotations

import itertools
import json
import logging
import os
import secrets
import threading
import time
from pathlib import Path
from typing import Any

from google.adk.tools import FunctionTool

log = logging.getLogger("dayflow.connectors")

GITHUB_MCP_URL = "https://api.githubcopilot.com/mcp/"
GITHUB_TOOLS = [
    "create_repository",
    "create_branch",
    "push_files",
    "issue_write",
    "create_pull_request",
    "get_file_contents",
]
LINEAR_MCP_URL = "https://mcp.linear.app/mcp"
LINEAR_TOOLS = ["list_teams", "list_projects", "create_issue"]

FAKE_ENV = "DAYFLOW_FAKE_CONNECTORS"
FAKE_LOG_ENV = "DAYFLOW_FAKE_LOG"
DEFAULT_FAKE_LOG = "/tmp/dayflow-fake-connectors.jsonl"
FAKE_OWNER = "dayflow-student"


def _toolset(url: str, headers: dict[str, str], tool_filter: list[str]) -> Any | None:
    try:
        from google.adk.tools.mcp_tool import McpToolset, StreamableHTTPConnectionParams
    except ImportError:  # `mcp` extra missing
        log.warning("MCP support not installed; connector for %s disabled", url)
        return None
    return McpToolset(
        connection_params=StreamableHTTPConnectionParams(url=url, headers=headers, timeout=15, sse_read_timeout=120),
        tool_filter=tool_filter,
    )


def github_toolset(token: str | None = None) -> Any | None:
    token = token or os.getenv("GITHUB_TOKEN")
    if not token:
        return None
    return _toolset(
        GITHUB_MCP_URL,
        {"Authorization": f"Bearer {token}", "X-MCP-Toolsets": "repos,issues,pull_requests"},
        GITHUB_TOOLS,
    )


def linear_toolset(token: str | None = None) -> Any | None:
    token = token or os.getenv("LINEAR_API_KEY")
    if not token:
        return None
    return _toolset(LINEAR_MCP_URL, {"Authorization": f"Bearer {token}"}, LINEAR_TOOLS)


# ---------------------------------------------------------------------------------------------
# Fake connectors (harness). Same names and argument shapes as the remote MCP tools.
# ---------------------------------------------------------------------------------------------


def fake_connectors_enabled() -> bool:
    return os.getenv(FAKE_ENV) == "1"


def fake_log_path() -> Path:
    return Path(os.getenv(FAKE_LOG_ENV) or DEFAULT_FAKE_LOG)


_lock = threading.Lock()
_seq = itertools.count(1)
# owner/repo -> path -> content, so get_file_contents returns what push_files wrote earlier in this process.
_repo_files: dict[str, dict[str, str]] = {}

_CANNED_FILES = {
    "README.md": (
        "# Diploma project: Dayflow\n\nA Chrome-extension AI agent that automates KBTU student workflows: "
        "syncs course files from the WSP portal into a local vault, builds courseware from syllabi, "
        "scaffolds project repos and runs team operations (Telegram, Linear, GitHub).\n\n"
        "## Architecture\n- Brain: Python + Google ADK on Cloud Run (Gemini)\n- Hands: Chrome MV3 extension\n"
        "- State: Firestore, Pub/Sub\n\n## Status\nScenes 1-3 demoable; scenes 4-6 in progress.\n"
    ),
    "TODO.md": (
        "# TODO\n1. Vault sync on schedule (chrome.alarms)\n2. Courseware HTML: cheatsheet + quiz\n"
        "3. Vault scaffold from syllabus\n4. GitHub bootstrap via MCP\n5. Team ops: Telegram + Linear + PR\n"
        "6. Pitch deck generator (.pptx)\n7. README + architecture diagram\n8. Demo video\n"
    ),
}


def _record(tool: str, args: dict[str, Any], result: dict[str, Any]) -> None:
    line = json.dumps({"ts": time.time(), "tool": tool, "args": args, "result": result}, ensure_ascii=False)
    path = fake_log_path()
    with _lock:
        path.parent.mkdir(parents=True, exist_ok=True)
        with path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")


def _repo_key(owner: str, repo: str) -> str:
    return f"{owner or FAKE_OWNER}/{repo}"


def create_repository(name: str, description: str = "", private: bool = True, autoInit: bool = True) -> dict[str, Any]:
    """Creates a new GitHub repository in your account.

    Args:
        name: Repository name (e.g. "cv-lab1").
        description: Short description.
        private: Whether the repository is private.
        autoInit: Initialize with an empty README.
    """
    key = _repo_key(FAKE_OWNER, name)
    _repo_files.setdefault(key, {})
    result = {
        "status": "success",
        "id": next(_seq),
        "name": name,
        "full_name": key,
        "owner": FAKE_OWNER,
        "private": private,
        "default_branch": "main",
        "html_url": f"https://github.com/{key}",
        "clone_url": f"https://github.com/{key}.git",
    }
    _record(
        "create_repository",
        {"name": name, "description": description, "private": private, "autoInit": autoInit},
        result,
    )
    return result


def create_branch(owner: str, repo: str, branch: str, from_branch: str = "main") -> dict[str, Any]:
    """Creates a new branch in a GitHub repository.

    Args:
        owner: Repository owner.
        repo: Repository name.
        branch: Name for the new branch.
        from_branch: Source branch (defaults to the repository default branch).
    """
    result = {"status": "success", "ref": f"refs/heads/{branch}", "sha": secrets.token_hex(20)}
    _record("create_branch", {"owner": owner, "repo": repo, "branch": branch, "from_branch": from_branch}, result)
    return result


def push_files(owner: str, repo: str, branch: str, files: list[dict[str, str]], message: str) -> dict[str, Any]:
    """Pushes multiple files to a GitHub repository in a single commit.

    Args:
        owner: Repository owner.
        repo: Repository name.
        branch: Branch to push to.
        files: List of {"path": ..., "content": ...} objects (content is the full text of the file).
        message: Commit message.
    """
    store = _repo_files.setdefault(_repo_key(owner, repo), {})
    paths: list[str] = []
    for f in files:
        path, content = str(f.get("path", "")), str(f.get("content", ""))
        if path:
            store[path] = content
            paths.append(path)
    result = {"status": "success", "commit_sha": secrets.token_hex(20), "branch": branch, "files": paths}
    _record(
        "push_files", {"owner": owner, "repo": repo, "branch": branch, "files": list(files), "message": message}, result
    )
    return result


def issue_write(
    method: str,
    owner: str,
    repo: str,
    title: str = "",
    body: str = "",
    issue_number: int = 0,
    labels: list[str] | None = None,
) -> dict[str, Any]:
    """Creates or updates a GitHub issue.

    Args:
        method: "create" or "update".
        owner: Repository owner.
        repo: Repository name.
        title: Issue title.
        body: Issue body (markdown).
        issue_number: Existing issue number (for "update").
        labels: Labels to apply.
    """
    number = issue_number if method == "update" and issue_number else 100 + next(_seq)
    key = _repo_key(owner, repo)
    result = {
        "status": "success",
        "number": number,
        "title": title,
        "html_url": f"https://github.com/{key}/issues/{number}",
    }
    _record(
        "issue_write",
        {
            "method": method,
            "owner": owner,
            "repo": repo,
            "title": title,
            "body": body,
            "issue_number": issue_number,
            "labels": labels or [],
        },
        result,
    )
    return result


def create_pull_request(
    owner: str, repo: str, title: str, head: str, base: str = "main", body: str = "", draft: bool = False
) -> dict[str, Any]:
    """Opens a pull request in a GitHub repository.

    Args:
        owner: Repository owner.
        repo: Repository name.
        title: PR title.
        head: Branch containing the changes.
        base: Branch to merge into.
        body: PR description (markdown).
        draft: Open as a draft PR.
    """
    number = 200 + next(_seq)
    key = _repo_key(owner, repo)
    result = {
        "status": "success",
        "number": number,
        "title": title,
        "html_url": f"https://github.com/{key}/pull/{number}",
    }
    _record(
        "create_pull_request",
        {"owner": owner, "repo": repo, "title": title, "head": head, "base": base, "body": body, "draft": draft},
        result,
    )
    return result


def get_file_contents(owner: str, repo: str, path: str, ref: str = "") -> dict[str, Any]:
    """Reads a file from a GitHub repository.

    Args:
        owner: Repository owner.
        repo: Repository name.
        path: File path inside the repository (e.g. "README.md").
        ref: Branch, tag or commit (defaults to the default branch).
    """
    store = _repo_files.get(_repo_key(owner, repo), {})
    content = store.get(path) or _CANNED_FILES.get(path.rsplit("/", 1)[-1])
    if content is None:
        result: dict[str, Any] = {"status": "error", "error": f"{path} not found in {owner}/{repo}"}
    else:
        result = {"status": "success", "path": path, "encoding": "utf-8", "content": content, "size": len(content)}
    _record("get_file_contents", {"owner": owner, "repo": repo, "path": path, "ref": ref}, result)
    return result


def list_teams(query: str = "") -> dict[str, Any]:
    """Lists the Linear teams the user belongs to.

    Args:
        query: Optional name filter.
    """
    teams = [{"id": "team_dayflow", "name": "Dayflow", "key": "DAY"}]
    result = {"status": "success", "teams": [t for t in teams if query.lower() in t["name"].lower()]}
    _record("list_teams", {"query": query}, result)
    return result


def list_projects(teamId: str = "") -> dict[str, Any]:
    """Lists Linear projects, optionally for one team.

    Args:
        teamId: Team id from list_teams.
    """
    result = {
        "status": "success",
        "projects": [{"id": "proj_diploma", "name": "Diploma project", "teamId": "team_dayflow", "state": "started"}],
    }
    _record("list_projects", {"teamId": teamId}, result)
    return result


def create_issue(
    title: str, teamId: str = "team_dayflow", description: str = "", projectId: str = "", priority: int = 0
) -> dict[str, Any]:
    """Creates a Linear issue.

    Args:
        title: Issue title.
        teamId: Team id from list_teams.
        description: Issue description (markdown).
        projectId: Project id from list_projects.
        priority: 0 (none) to 4 (low); 1 is urgent.
    """
    n = next(_seq)
    result = {
        "status": "success",
        "id": f"issue_{secrets.token_hex(4)}",
        "identifier": f"DAY-{n}",
        "title": title,
        "url": f"https://linear.app/dayflow/issue/DAY-{n}",
    }
    _record(
        "create_issue",
        {"title": title, "teamId": teamId, "description": description, "projectId": projectId, "priority": priority},
        result,
    )
    return result


FAKE_FUNCTIONS = [
    create_repository,
    create_branch,
    push_files,
    issue_write,
    create_pull_request,
    get_file_contents,
    list_teams,
    list_projects,
    create_issue,
]


def fake_connector_tools() -> list[FunctionTool]:
    return [FunctionTool(func=f) for f in FAKE_FUNCTIONS]


def connector_toolsets() -> list[Any]:
    if fake_connectors_enabled():
        log.warning(
            "DAYFLOW_FAKE_CONNECTORS=1: GitHub/Linear tools are in-process stubs logging to %s", fake_log_path()
        )
        return list(fake_connector_tools())
    return [t for t in (github_toolset(), linear_toolset()) if t is not None]
