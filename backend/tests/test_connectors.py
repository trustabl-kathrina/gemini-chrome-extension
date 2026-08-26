import json
from pathlib import Path

import pytest

from dayflow.tools import connectors
from dayflow.tools.connectors import GITHUB_TOOLS, LINEAR_TOOLS, connector_toolsets

EXPECTED = set(GITHUB_TOOLS) | set(LINEAR_TOOLS)


@pytest.fixture
def fake_log(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    path = tmp_path / "fake-connectors.jsonl"
    monkeypatch.setenv("DAYFLOW_FAKE_CONNECTORS", "1")
    monkeypatch.setenv("DAYFLOW_FAKE_LOG", str(path))
    return path


def read_log(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def test_no_connectors_without_tokens_or_fake_flag(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("DAYFLOW_FAKE_CONNECTORS", raising=False)
    assert connector_toolsets() == []


def test_fake_mode_serves_every_mcp_tool_name_in_process(fake_log: Path) -> None:
    tools = connector_toolsets()
    names = {t.name for t in tools}
    assert names == EXPECTED
    # Every stub must yield a valid Gemini function declaration (ADK derives it from the signature).
    for t in tools:
        decl = t._get_declaration()
        assert decl is not None and decl.name == t.name and decl.description


def test_github_stubs_record_calls_and_round_trip_files(fake_log: Path) -> None:
    repo = connectors.create_repository("cv-lab1", "CV Lab 1", private=True)
    assert repo["status"] == "success" and repo["html_url"].endswith("/cv-lab1") and repo["default_branch"] == "main"

    files = [
        {"path": "README.md", "content": "# CV Lab 1"},
        {"path": "TODO.md", "content": "1. load image"},
        {
            "path": "lab01.ipynb",
            "content": json.dumps({"nbformat": 4, "nbformat_minor": 5, "cells": [], "metadata": {}}),
        },
    ]
    pushed = connectors.push_files(repo["owner"], "cv-lab1", "main", files, "init")
    assert pushed["files"] == ["README.md", "TODO.md", "lab01.ipynb"] and len(pushed["commit_sha"]) == 40

    got = connectors.get_file_contents(repo["owner"], "cv-lab1", "TODO.md")
    assert got["status"] == "success" and got["content"] == "1. load image"
    canned = connectors.get_file_contents("someone", "diploma", "README.md")
    assert canned["status"] == "success" and "Diploma project" in canned["content"]
    missing = connectors.get_file_contents("someone", "diploma", "nope.txt")
    assert missing["status"] == "error"

    issue = connectors.issue_write("create", repo["owner"], "cv-lab1", title="Week 1", body="do it")
    pr = connectors.create_pull_request(repo["owner"], "cv-lab1", "Add loader", head="feat/loader", base="main")
    assert issue["html_url"].endswith(f"/issues/{issue['number']}") and pr["html_url"].endswith(f"/pull/{pr['number']}")

    entries = read_log(fake_log)
    assert [e["tool"] for e in entries] == [
        "create_repository",
        "push_files",
        "get_file_contents",
        "get_file_contents",
        "get_file_contents",
        "issue_write",
        "create_pull_request",
    ]
    push = next(e for e in entries if e["tool"] == "push_files")
    assert [f["path"] for f in push["args"]["files"]] == ["README.md", "TODO.md", "lab01.ipynb"]
    assert json.loads(push["args"]["files"][2]["content"])["nbformat"] == 4
    assert entries[0]["args"] == {"name": "cv-lab1", "description": "CV Lab 1", "private": True, "autoInit": True}
    assert entries[-1]["result"]["number"] == pr["number"]


def test_linear_stubs(fake_log: Path) -> None:
    teams = connectors.list_teams()
    assert teams["teams"][0]["id"] == "team_dayflow"
    assert connectors.list_teams("nomatch")["teams"] == []
    projects = connectors.list_projects("team_dayflow")
    assert projects["projects"][0]["id"] == "proj_diploma"
    a = connectors.create_issue("Milestone 2: data loader", teamId="team_dayflow", projectId="proj_diploma", priority=2)
    b = connectors.create_issue("Milestone 2: eval script")
    assert a["identifier"] != b["identifier"] and a["url"].endswith(a["identifier"])
    tools = [e["tool"] for e in read_log(fake_log)]
    assert tools == ["list_teams", "list_teams", "list_projects", "create_issue", "create_issue"]


def test_fake_log_path_default_and_override(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    monkeypatch.delenv("DAYFLOW_FAKE_LOG", raising=False)
    assert str(connectors.fake_log_path()) == connectors.DEFAULT_FAKE_LOG
    monkeypatch.setenv("DAYFLOW_FAKE_LOG", str(tmp_path / "x.jsonl"))
    assert connectors.fake_log_path() == tmp_path / "x.jsonl"
