"""Scaffold tools (PLAN v2 scene 5): plan_vault_folders (deterministic) + the make_folders browser tool."""

from __future__ import annotations

import pytest
from google.adk.tools import LongRunningFunctionTool

from dayflow.core.loader import default_config
from dayflow.tools.browser import BROWSER_TOOL_NAMES
from dayflow.tools.scaffold import (
    MAKE_FOLDERS_TOOL,
    MAX_PATHS,
    SEMESTER_WEEKS,
    course_folder_name,
    make_folders,
    plan_vault_folders,
    short_title,
)
from dayflow.tools.server import SERVER_TOOLS

# The syllabus the fake portal serves (harness/fake-wsp/.../syllabus.pdf), as pypdf extracts it.
CV_SYLLABUS = """CSCI3240 Introduction to Computer Vision
Instructor: Abenova Saule
KBTU, School of Information Technology and Engineering
Syllabus - weekly schedule (15 weeks)
Week 01: Course overview, images as arrays, color spaces
Week 02: Point operations, histograms, contrast and gamma
Week 03: Linear filtering, convolution, Gaussian and box filters
Week 04: Edge detection: Sobel, Canny, gradients
Week 05: Image pyramids, scale space, resampling
Week 06: Feature detection: Harris corners, blobs
Week 07: Feature description and matching: SIFT, ORB
Week 08: Midterm; geometric transforms, homographies
Week 09: Image stitching, RANSAC
Week 10: Camera model, calibration, stereo basics
Week 11: Segmentation: thresholding, k-means, graph cuts
Week 12: Optical flow and tracking
Week 13: Convolutional networks for classification
Week 14: Object detection: YOLO-style detectors
Week 15: Project presentations and final review
Labs (Fridays, room 412):
Lab 01: Image basics with numpy
Lab 02: Filtering and edges
Lab 03: Features and matching
Lab 04: Homography and stitching
Lab 05: A small CNN classifier
Grading: labs 30%, midterm 30%, final project 40%.
"""
COURSE = "CSCI3240 Introduction to Computer Vision"


async def plan(text: str = CV_SYLLABUS, code: str = "CSCI3240", name: str = "Introduction to Computer Vision") -> dict:
    out = await plan_vault_folders(course_code=code, course_name=name, syllabus_text=text)
    assert out["status"] == "success", out
    return out


# ---------- plan_vault_folders ----------


async def test_plans_every_week_and_lab_of_the_real_syllabus() -> None:
    """Scene 5's expectation: ≥15 folders under the course folder, named per the syllabus schedule."""
    out = await plan()
    paths: list[str] = out["paths"]
    assert out["course_folder"] == COURSE
    assert out["weeks"] == 15 and out["labs"] == 5
    assert len(paths) == 21, paths  # Materials + 15 weeks + 5 labs
    assert len([p for p in paths if p.startswith(f"{COURSE}/")]) == len(paths)
    assert f"{COURSE}/Materials" in paths
    assert f"{COURSE}/Week 01 - Course overview" in paths
    assert f"{COURSE}/Week 04 - Edge detection" in paths
    assert f"{COURSE}/Week 15 - Project presentations and final review" in paths
    assert f"{COURSE}/Lab 01 - Image basics with numpy" in paths
    assert f"{COURSE}/Lab 05 - A small CNN classifier" in paths
    # Two-digit numbering keeps the tree sorted in Drive, and no path names a file or escapes the course.
    assert [p for p in paths if "Week 1 " in p or "Lab 1 " in p] == []
    assert all(p.count("/") == 1 and not p.startswith("Dayflow/") for p in paths)


async def test_folder_count_never_falls_below_a_semester() -> None:
    """A short or unreadable schedule still yields a usable tree: 15 weeks are the semester, not a guess
    at the syllabus. The scene expects ≥15 folders under the course whatever the PDF parsed to."""
    short = await plan("Week 1: Intro\nWeek 2: More\nLab 1: Setup\n")
    assert short["weeks"] == SEMESTER_WEEKS and short["labs"] == 1
    assert len(short["paths"]) == 17
    assert f"{COURSE}/Week 01 - Intro" in short["paths"] and f"{COURSE}/Week 03" in short["paths"]
    empty = await plan("")
    assert empty["from_syllabus"] is False
    assert len([p for p in empty["paths"] if "/Week " in p]) == SEMESTER_WEEKS
    assert len(empty["paths"]) >= 15


async def test_prose_around_the_schedule_is_not_mistaken_for_weeks_or_labs() -> None:
    out = await plan("Syllabus - weekly schedule (15 weeks). Labs (Fridays, room 412): see below.\nWeek 07 Features\n")
    assert out["labs"] == 0
    assert f"{COURSE}/Week 07 - Features" in out["paths"]


async def test_folder_names_are_safe_and_bounded() -> None:
    """A syllabus is untrusted text from a PDF: no path separators, no Drive-illegal characters, no
    unbounded names — a crafted line must not create folders outside the course folder."""
    out = await plan(
        'Week 01: ../../etc/passwd | "evil" <tag>\n'
        f"Week 02: {'very long topic ' * 20}\n"
        "Week 99: out of range\nLab 00: out of range\n"
    )
    weeks = [p.split("/", 1)[1] for p in out["paths"] if "/Week " in p]
    assert all(".." not in n and '"' not in n and "<" not in n and "|" not in n for n in weeks), weeks
    assert all(len(n) <= 60 for n in weeks), weeks
    assert all(p.count("/") == 1 for p in out["paths"])
    assert "Week 99" not in " ".join(out["paths"]) and "Lab 00" not in " ".join(out["paths"])


async def test_duplicate_and_unnumbered_mentions_keep_the_first_title() -> None:
    out = await plan("Week 03: Linear filtering\nSee week 3 for the reading list.\n")
    assert f"{COURSE}/Week 03 - Linear filtering" in out["paths"]
    assert len([p for p in out["paths"] if "/Week 03" in p]) == 1


async def test_course_folder_matches_the_vault_path_convention() -> None:
    assert course_folder_name("CSCI3240", "Introduction to Computer Vision") == COURSE
    # The model may pass the code twice (it is often already in the portal's folder name).
    assert course_folder_name("CSCI3240", COURSE) == COURSE
    assert course_folder_name("", "Introduction to Computer Vision") == "Introduction to Computer Vision"
    assert course_folder_name("CS/101", "A:B") == "CS 101 A B"
    err = await plan_vault_folders(course_code=" ", course_name="", syllabus_text=CV_SYLLABUS)
    assert err["status"] == "error" and "empty" in err["error"]


async def test_plan_is_capped() -> None:
    out = await plan("\n".join(f"Week {n}: Topic {n}\nLab {n}: Lab {n}" for n in range(1, 31)))
    assert len(out["paths"]) <= MAX_PATHS


def test_short_title_takes_the_first_clause() -> None:
    assert short_title("Course overview, images as arrays") == "Course overview"
    assert short_title("Edge detection: Sobel, Canny") == "Edge detection"
    assert short_title("") == ""


# ---------- make_folders (executed by the extension) ----------


def test_make_folders_is_a_long_running_browser_tool() -> None:
    """Long-running tools must return None: ADK skips the automatic FunctionResponse only for a falsy
    result, which is what lets the extension answer the call with the real Drive result."""
    assert isinstance(MAKE_FOLDERS_TOOL, LongRunningFunctionTool)
    assert MAKE_FOLDERS_TOOL.name == "make_folders"
    assert make_folders(["A/Week 01"]) is None
    doc = make_folders.__doc__ or ""
    assert "idempotent" in doc and "Dayflow/" in doc  # the model must not prefix the vault folder itself


@pytest.mark.parametrize("name", ["plan_vault_folders", "make_folders"])
def test_scaffold_skill_declares_its_tools(name: str) -> None:
    skill = default_config().skill("scaffold")
    assert skill is not None
    known = BROWSER_TOOL_NAMES | {t.__name__ for t in SERVER_TOOLS} | {"plan_vault_folders", "make_folders"}
    assert set(skill.tools) <= known, set(skill.tools) - known
    assert name in skill.tools


def test_scaffold_skill_steps_are_concrete_and_in_order() -> None:
    text = (default_config().skill("scaffold") or pytest.fail("no scaffold skill")).instructions
    steps = ["vault_list", "download(ref=", "vault_read", "plan_vault_folders", "make_folders"]
    assert [text.index(s) for s in steps] == sorted(text.index(s) for s in steps), text
    assert "VERBATIM" in text and "ONE call" in text  # the plan is passed through, not re-written
    assert "created + existing" in text  # what to verify after make_folders
    assert "15 week" in text
