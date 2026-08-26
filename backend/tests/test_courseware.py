"""Courseware tool (PLAN v2 scene 4): structured generation → printable page in the PageStore."""

from __future__ import annotations

import json
import re
from collections.abc import Iterator
from typing import Any

import pytest

from dayflow.core.pages import PageStore, set_default_pages
from dayflow.core.vault import MemoryBlobStore
from dayflow.tools import courseware as cw
from dayflow.tools.courseware import (
    QUIZ_QUESTIONS,
    Courseware,
    QuizQuestion,
    Section,
    generate_courseware,
    render_courseware_html,
)

SYLLABUS = (
    "CSCI3240 Introduction to Computer Vision — Spring 2026\n"
    "Week 1: image formation, pixels, colour spaces. Week 2: filtering and convolution.\n"
    "Week 3: edge detection (Sobel, Canny). Week 4: features and descriptors.\n"
    "Assessment: midterm week 8, final project week 15.\n"
) * 4


def make_doc(n_quiz: int = QUIZ_QUESTIONS, offset: int = 0) -> Courseware:
    return Courseware(
        title="CSCI3240 Introduction to Computer Vision — cheatsheet & quiz",
        overview="What the course covers.",
        sections=[
            Section(
                title=f"Topic {i}",
                weeks=f"Week {i}",
                key_points=[f"Point {i}.1", f"Point {i}.2"],
                terms=[f"term{i} — gloss"],
            )
            for i in range(1, 4)
        ],
        quiz=[
            QuizQuestion(question=f"Question {i + offset}?", answer=f"Answer {i + offset}.")
            for i in range(1, n_quiz + 1)
        ],
    )


class FakeResponse:
    def __init__(self, text: str) -> None:
        self.text = text


class FakeClient:
    """Stands in for google.genai Client: records the calls and replays queued JSON responses."""

    def __init__(self, responses: list[Any]) -> None:
        self.responses = list(responses)
        self.calls: list[dict[str, Any]] = []
        self.aio = self

    @property
    def models(self) -> FakeClient:
        return self

    async def generate_content(self, **kwargs: Any) -> FakeResponse:
        self.calls.append(kwargs)
        nxt = self.responses.pop(0) if self.responses else self.responses
        if isinstance(nxt, Exception):
            raise nxt
        payload = nxt.model_dump_json() if isinstance(nxt, Courseware) else json.dumps(nxt)
        return FakeResponse(payload)


@pytest.fixture
def pages() -> Iterator[PageStore]:
    store = PageStore(MemoryBlobStore(), public_url="http://brain.test")
    set_default_pages(store)
    yield store
    set_default_pages(None)


def use_client(monkeypatch: pytest.MonkeyPatch, *responses: Any) -> FakeClient:
    fake = FakeClient(list(responses))
    monkeypatch.setattr(cw, "client", lambda: fake)
    return fake


# ---------- rendering ----------


def test_render_puts_ten_answers_behind_details_and_escapes_the_model_text() -> None:
    doc = make_doc()
    doc.sections[0].title = "<script>alert('xss')</script> & filtering"
    doc.quiz[0].answer = '5 < 6 & "quoted"'
    html = render_courseware_html(doc, "CSCI3240 Introduction to Computer Vision", "all 15 weeks")

    assert html.startswith("<!doctype html>") and html.rstrip().endswith("</html>")
    assert "<h2>Quiz</h2>" in html and "Cheatsheet" in html
    assert html.count("<details>") == QUIZ_QUESTIONS == html.count("</details>")
    assert html.count("<summary>Show answer</summary>") == QUIZ_QUESTIONS
    # Each question is visible; each answer only inside its <details>.
    for q in doc.quiz:
        assert f'<p class="q">{q.question}</p>' in html
    assert "<script>" not in html and "&lt;script&gt;" in html
    assert "5 &lt; 6 &amp; &quot;quoted&quot;" in html
    assert "@media print" in html  # printable: the print stylesheet ships with the page
    assert "CSCI3240 Introduction to Computer Vision" in html and "all 15 weeks" in html


def test_render_survives_a_short_document() -> None:
    doc = make_doc(n_quiz=1)
    doc.overview = ""
    doc.sections = doc.sections[:1]
    doc.sections[0].terms = []
    doc.sections[0].weeks = ""
    html = render_courseware_html(doc, "MGT2100 Principles of Management", "")
    assert "<h2>Quiz</h2>" in html and html.count("<details>") == 1
    assert "Terms." not in html and 'class="weeks"' not in html


# ---------- generation ----------


async def test_generate_courseware_stores_a_page_with_the_quiz(
    monkeypatch: pytest.MonkeyPatch, pages: PageStore
) -> None:
    fake = use_client(monkeypatch, make_doc())
    out = await generate_courseware("CSCI3240 Introduction to Computer Vision", "all 15 weeks", SYLLABUS)

    assert out["status"] == "success", out
    assert out["questions"] == QUIZ_QUESTIONS and len(out["sections"]) == 3
    assert out["id"] and out["url"] == f"http://brain.test/pages/courseware/{out['id']}"
    assert out["page_id"] == out["id"] and out["page_url"] == out["url"] and "warning" not in out
    html = await pages.get("courseware", out["id"])
    assert html and "<h2>Quiz</h2>" in html and html.count("<details>") == QUIZ_QUESTIONS

    assert len(fake.calls) == 1  # ten questions on the first try: no top-up call
    sent = fake.calls[0]["contents"]
    assert "CSCI3240 Introduction to Computer Vision" in sent and "all 15 weeks" in sent
    assert "Week 3: edge detection" in sent  # the syllabus is passed through, not summarised
    assert "untrusted" in sent  # the prompt tells the model the syllabus is data, not instructions


async def test_a_short_quiz_is_topped_up_with_a_second_call(monkeypatch: pytest.MonkeyPatch, pages: PageStore) -> None:
    """The page must ship ten questions; a first generation that returns six triggers one top-up call,
    and questions repeated by the model are dropped rather than shown twice."""
    first, second = make_doc(n_quiz=6), make_doc(n_quiz=6, offset=4)  # 4 overlap, 2 new… plus 2 more below
    second.quiz += [QuizQuestion(question=f"Extra {i}?", answer=f"Extra answer {i}.") for i in range(1, 3)]
    fake = use_client(monkeypatch, first, second)
    out = await generate_courseware("CSCI3240 Introduction to Computer Vision", "weeks 1-4", SYLLABUS)

    assert out["status"] == "success" and len(fake.calls) == 2
    assert "4 MORE" in fake.calls[1]["contents"] and "Question 1?" in fake.calls[1]["contents"]
    assert out["questions"] == QUIZ_QUESTIONS and "warning" not in out
    html = await pages.get("courseware", out["id"])
    assert html and html.count("<details>") == QUIZ_QUESTIONS
    assert len(re.findall(r'<p class="q">Question 5\?</p>', html)) == 1


async def test_a_stubborn_model_still_yields_a_page_with_a_warning(
    monkeypatch: pytest.MonkeyPatch, pages: PageStore
) -> None:
    fake = use_client(monkeypatch, make_doc(n_quiz=3), make_doc(n_quiz=3))  # the top-up repeats itself
    out = await generate_courseware("CSCI3240 Introduction to Computer Vision", "midterm", SYLLABUS)

    assert out["status"] == "success" and len(fake.calls) == 2
    assert out["questions"] == 3 and out["warning"] == f"only 3 of {QUIZ_QUESTIONS} quiz questions were generated"
    html = await pages.get("courseware", out["id"])
    assert html and "<h2>Quiz</h2>" in html and html.count("<details>") == 3


async def test_an_empty_syllabus_is_refused_before_any_model_call(monkeypatch: pytest.MonkeyPatch) -> None:
    fake = use_client(monkeypatch, make_doc())
    out = await generate_courseware("CSCI3240 Introduction to Computer Vision", "all", "   ")
    assert out["status"] == "error" and "vault_read" in out["error"] and not fake.calls


async def test_an_empty_generation_is_an_error_not_an_empty_page(
    monkeypatch: pytest.MonkeyPatch, pages: PageStore
) -> None:
    empty = Courseware(title="t", overview="o", sections=[], quiz=[])
    use_client(monkeypatch, empty, empty)
    out = await generate_courseware("CSCI3240 Introduction to Computer Vision", "all", SYLLABUS)
    assert out["status"] == "error" and "no sections" in out["error"]
    assert await pages.get("courseware", "x" * 20) is None


async def test_a_model_failure_comes_back_as_a_tool_error(monkeypatch: pytest.MonkeyPatch) -> None:
    use_client(monkeypatch, RuntimeError("429 RESOURCE_EXHAUSTED"))
    out = await generate_courseware("CSCI3240 Introduction to Computer Vision", "all", SYLLABUS)
    assert out["status"] == "error" and "RESOURCE_EXHAUSTED" in out["error"] and "Retry" in out["error"]


async def test_invalid_json_from_the_model_is_reported(monkeypatch: pytest.MonkeyPatch) -> None:
    use_client(monkeypatch, {"title": "t", "overview": "o", "quiz": "not a list"})
    out = await generate_courseware("CSCI3240 Introduction to Computer Vision", "all", SYLLABUS)
    assert out["status"] == "error" and "did not validate" in out["error"]


async def test_the_syllabus_is_truncated_and_junk_entries_are_dropped(
    monkeypatch: pytest.MonkeyPatch, pages: PageStore
) -> None:
    doc = make_doc()
    doc.sections.append(Section(title="  ", key_points=["x"]))  # no title
    doc.sections.append(Section(title="No points", key_points=[" "]))
    doc.quiz.append(QuizQuestion(question="Question 1?", answer="dup"))  # duplicate of quiz[0]
    doc.quiz.append(QuizQuestion(question="No answer?", answer=""))
    fake = use_client(monkeypatch, doc)
    out = await generate_courseware("CSCI3240", "all", "x" * (cw.MAX_SYLLABUS_CHARS + 5_000))

    assert out["status"] == "success" and out["sections"] == ["Topic 1", "Topic 2", "Topic 3"]
    assert out["questions"] == QUIZ_QUESTIONS
    assert fake.calls[0]["contents"].count("x") <= cw.MAX_SYLLABUS_CHARS + 10


def test_the_tool_is_registered_on_the_orchestrator() -> None:
    from dayflow.agents.orchestrator import build_root_agent
    from dayflow.core.loader import MemoryConfigStore

    tools: list[Any] = list(build_root_agent(MemoryConfigStore()).tools)
    names = {str(getattr(t, "name", None) or getattr(t, "__name__", "")) for t in tools}
    assert "generate_courseware" in names
    assert cw.COURSEWARE_TOOLS == [generate_courseware]


# ---------- the pack's skill block (PLAN v2 scene 4: the steps Gemini follows) ----------


@pytest.mark.parametrize("name", ["vault_list", "vault_read", "generate_courseware", "download", "open_tab"])
def test_courseware_skill_declares_its_tools(name: str) -> None:
    from dayflow.core.loader import default_config
    from dayflow.tools.browser import BROWSER_TOOL_NAMES
    from dayflow.tools.server import SERVER_TOOLS

    skill = default_config().skill("courseware")
    assert skill is not None
    known = BROWSER_TOOL_NAMES | {t.__name__ for t in SERVER_TOOLS} | {"generate_courseware"}
    assert set(skill.tools) <= known, set(skill.tools) - known
    assert name in skill.tools


def test_courseware_skill_steps_are_concrete_and_in_order() -> None:
    """The scene's expectation in one place: find the syllabus (sync it from WSP if the vault is empty),
    read it, generate, save the page to the vault, open it."""
    from dayflow.core.loader import default_config

    skill = default_config().skill("courseware") or pytest.fail("no courseware skill in the pack")
    text = skill.instructions
    steps = [
        "vault_list",
        "download(ref=",
        "vault_read",
        "generate_courseware",
        "download(url=page_url",
        "open_tab(page_url)",
    ]
    assert [text.index(s) for s in steps] == sorted(text.index(s) for s in steps), text
    assert "VERBATIM" in text  # the syllabus text is passed through, not summarised
    assert "Materials/courseware.html" in text  # where the page lands in the vault
    assert "Quiz" in text  # what to verify in the opened tab
