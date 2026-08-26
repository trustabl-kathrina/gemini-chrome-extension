"""Scaffold tools (PLAN v2 scene 5): syllabus text → the vault's folder tree, created in the user's Drive.

Two tools, on purpose:

* `plan_vault_folders(course_code, course_name, syllabus_text)` is a **server** tool and is deterministic —
  no model call. A syllabus is untrusted text from a PDF on the portal; parsing it with a regex means the
  plan cannot be steered by instructions hidden in the document, is unit-testable and costs nothing. It
  returns vault-relative folder paths ("<course code> <course name>/Week 01 - Edge detection"), the same
  path space `download(path=…)` uses, so the extension prefixes the user's vault folder ("Dayflow/").
* `make_folders(paths)` is a **browser** tool (LongRunningFunctionTool → returns None): the extension owns
  the Google OAuth token, so only it can talk to Drive. It creates every folder with the Drive client's
  idempotent `ensureFolder`, so re-running a scaffold is a no-op instead of a duplicate tree.

A KBTU semester runs 15 weeks: when a syllabus lists fewer (or its schedule is unreadable), the missing
weeks are still planned so the student has somewhere to file material as the term goes on.
"""

from __future__ import annotations

import re
from typing import Any

from google.adk.tools import LongRunningFunctionTool

SEMESTER_WEEKS = 15  # KBTU semester length; weeks the syllabus does not mention are created empty
MAX_WEEKS = 30
MAX_LABS = 30
MAX_PATHS = 200  # what one make_folders call may create (the extension enforces the same cap)
MAX_TITLE_CHARS = 40
MATERIALS = "Materials"
# Characters Drive/Windows refuse in a name, plus the path separators the vault path is split on.
ILLEGAL_NAME_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]')
# "Week 01: Point operations…", "Week 3 - Filtering", "Неделя 2. Фильтрация". The separator is optional so
# "Week 7 Features" is still found; the number must follow the word, so "15 weeks" / "weekly" never match.
WEEK_RE = re.compile(r"\b(?:week|нед(?:еля)?)\s*#?\s*0*(\d{1,2})\b\s*[:.)\-–—]?[ \t]*([^\n\r]*)", re.I)
LAB_RE = re.compile(
    r"\b(?:lab(?:oratory)?(?:\s*work)?|лаб(?:ораторная)?)\s*#?\s*0*(\d{1,2})\b\s*[:.)\-–—]?[ \t]*([^\n\r]*)",
    re.I,
)


def clean_segment(text: str) -> str:
    """One folder name: illegal characters out, whitespace collapsed, no leading/trailing dots or spaces."""
    return re.sub(r"\s+", " ", ILLEGAL_NAME_CHARS.sub(" ", text).replace("\u00a0", " ")).strip(" .")


def short_title(raw: str) -> str:
    """A folder-sized topic from a syllabus line: the first clause, trimmed to MAX_TITLE_CHARS."""
    title = clean_segment(re.split(r"[,;:(]|\s[–—-]\s", raw.strip(), maxsplit=1)[0])
    title = re.sub(r"\s+", " ", title)
    if len(title) > MAX_TITLE_CHARS:
        title = title[:MAX_TITLE_CHARS].rsplit(" ", 1)[0].strip(" .,-")
    return title


def numbered(text: str, pattern: re.Pattern[str], limit: int) -> dict[int, str]:
    """{number: short title} for every "Week NN …" / "Lab NN …" line; the first mention of a number wins."""
    found: dict[int, str] = {}
    for match in pattern.finditer(text):
        n = int(match.group(1))
        if not 1 <= n <= limit:
            continue
        title = short_title(match.group(2))
        if n not in found or (not found[n] and title):
            found[n] = title
    return found


def course_folder_name(course_code: str, course_name: str) -> str:
    """ "CSCI3240" + "Introduction to Computer Vision" → "CSCI3240 Introduction to Computer Vision"."""
    code = clean_segment(course_code)
    name = clean_segment(course_name)
    if code and name.lower().startswith(code.lower()):
        return name
    return f"{code} {name}".strip()


def folder_names(prefix: str, items: dict[int, str]) -> list[str]:
    """{1: "Course overview"} → ["Week 01 - Course overview"] (no title → "Week 01")."""
    names: list[str] = []
    for n in sorted(items):
        title = items[n]
        names.append(f"{prefix} {n:02d} - {title}" if title else f"{prefix} {n:02d}")
    return names


async def plan_vault_folders(course_code: str, course_name: str, syllabus_text: str) -> dict[str, Any]:
    """Plans the vault folder tree for one course from its syllabus: a "Materials" folder, one folder per
    week of the schedule ("Week 01 - Course overview") and one per lab ("Lab 01 - Image basics"). Returns
    vault-relative paths ready to pass to make_folders verbatim (no "Dayflow/" prefix — the extension adds
    the user's vault folder). Deterministic: it reads the syllabus, it does not invent topics.

    Args:
        course_code: Course code as the portal writes it, e.g. "CSCI3240". May be empty if unknown.
        course_name: Course title, e.g. "Introduction to Computer Vision".
        syllabus_text: The syllabus text verbatim (vault_read's `text`), including its weekly schedule.
    """
    course = course_folder_name(course_code, course_name)
    if not course:
        return {"status": "error", "error": "course_code and course_name are both empty — name the course."}
    text = syllabus_text or ""
    weeks = numbered(text, WEEK_RE, MAX_WEEKS)
    labs = numbered(text, LAB_RE, MAX_LABS)
    # A semester has SEMESTER_WEEKS weeks even when the schedule is short or unparsable: create them all.
    for n in range(1, SEMESTER_WEEKS + 1):
        weeks.setdefault(n, "")
    names = [MATERIALS, *folder_names("Week", weeks), *folder_names("Lab", labs)]
    paths = [f"{course}/{name}" for name in names][:MAX_PATHS]
    return {
        "status": "success",
        "course_folder": course,
        "weeks": len(weeks),
        "labs": len(labs),
        "count": len(paths),
        "paths": paths,
        "from_syllabus": bool(text.strip()),
        "next": "call make_folders(paths=<these paths verbatim, all in one call>) to create them in the vault.",
    }


def make_folders(paths: list[str]) -> None:
    """Creates folders in the user's vault (Google Drive) — one call for the whole list, idempotent: a
    folder that already exists is reused, never duplicated. Result: {created, existing, failed, folders,
    root}; check that created + existing equals the number of paths you sent.

    Args:
        paths: Vault-relative folder paths, e.g. ["CSCI3240 Introduction to Computer Vision/Week 01 -
            Course overview", "…/Lab 01 - Image basics"]. No file names, no "Dayflow/" prefix (the
            extension puts them under the user's vault folder). At most 200 per call.
    """
    return None


MAKE_FOLDERS_TOOL = LongRunningFunctionTool(func=make_folders)
SCAFFOLD_TOOLS = [plan_vault_folders, MAKE_FOLDERS_TOOL]
SCAFFOLD_TOOL_NAMES = frozenset({plan_vault_folders.__name__, make_folders.__name__})
