"""MCP connectors — instantiated only when the corresponding token is present.

Per-user OAuth tokens (stored in Secret Manager) replace the env vars once "Connect GitHub/Linear"
exists in the extension; the toolset construction stays identical.
"""

from __future__ import annotations

import logging
import os
from typing import Any

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


def connector_toolsets() -> list[Any]:
    return [t for t in (github_toolset(), linear_toolset()) if t is not None]
