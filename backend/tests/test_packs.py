"""The pack is data, not code — these tests are the schema check for the parts of it the runtime relies on."""

from datetime import UTC, datetime, timedelta

from dayflow.core.loader import load_pack
from dayflow.core.models import Skill
from dayflow.scheduler import is_due

# Tools that send, create, change or persist something. A watch skill must have none of them: `restrict_tools`
# drops every declaration outside the skill's list, so this list IS the sandbox, not a suggestion.
WRITE_TOOLS = {
    "download",
    "type",
    "type_text",
    "run_js",
    "make_folders",
    "push_files",
    "create_repository",
    "create_branch",
    "create_pull_request",
    "create_issue",
    "issue_write",
    "build_notebook",
    "build_report",
    "build_deck",
    "generate_courseware",
}


def watch_skill() -> Skill:
    skill = load_pack().skill("standing-watch")
    assert skill is not None, "the pack must ship the standing-watch skill"
    return skill


def test_standing_watch_validates_and_stays_read_only() -> None:
    skill = watch_skill()
    assert skill.pack == "kbtu-student" and skill.enabled and skill.key == "7"
    assert skill.sites == ["wsp.kbtu.kz"]
    assert set(skill.tools) & WRITE_TOOLS == set(), "a watch skill may not write, download or type"
    assert "remember" in skill.tools, "it must persist each course's figure for the next run's delta"
    assert set(skill.tools) <= {"open_tab", "read_page", "click", "scroll", "wait", "screenshot", "remember"}


def test_standing_watch_instructions_carry_thresholds_and_a_give_up_rule() -> None:
    text = watch_skill().instructions
    assert "70%" in text, "the exam bar is the whole point of the skill"
    assert "71%" in text and "75%" in text, "alarm and warn thresholds"
    assert "3 lookups per course" in text, "it must stop hunting after 3 failed lookups"
    assert "remember(" in text and "delta" in text
    # The report is a number plus its consequence, never a bare percentage.
    assert "cannot sit the final" in text


def test_standing_watch_runs_once_a_week_in_the_evening() -> None:
    schedule = watch_skill().schedule
    assert schedule is not None
    minute, hour, dom, mon, dow = schedule.split()
    assert (minute, hour, dom, mon) == ("0", "20", "*", "*")
    assert dow.isdigit(), "a single weekday, not a range — this runs before the week starts"
    # Once a week, on the weekday cron names (0 = Sunday, as in the extension's own cron.ts — both
    # schedulers must fire this skill on the same day), and never at the daily sync's hour.
    week = [datetime(2026, 8, 24, tzinfo=UTC) + timedelta(days=d) for d in range(7)]  # Mon 24 .. Sun 30 Aug
    due = [day for day in week if is_due(schedule, day.replace(hour=20))]
    assert [d.strftime("%A") for d in due] == ["Sunday"]
    assert not any(is_due(schedule, day.replace(hour=8)) for day in week)


def test_teams_profile_documents_the_iframe_workarounds() -> None:
    site = load_pack().site("teams.microsoft.com")
    assert site is not None and site.allow
    assert site.mode == "vision", "the Assignments app and the file lists are iframes read_page cannot see through"
    notes = site.notes
    assert "Задания" in notes and "iframe" in notes
    for tab in ("Предстоящие", "Просрочено", "Выполнено"):
        assert tab in notes, f"the Assignments tab {tab} must be documented"
    assert "SharePoint" in notes and "Классная работа" in notes and "Оценки" in notes
    assert "Class Notebook" in notes
    assert "src" in notes and "open_tab" in notes, "prefer opening an iframe's src as a top-level tab"
    assert "RUSSIAN" in notes.upper(), "the account's UI language may be Russian"


def test_source_fallback_rule_is_general_not_per_course() -> None:
    """Every skill that goes looking for course material must try portal → Teams → syllabus, in that order."""
    cfg = load_pack()
    for skill_id in ("vault-sync", "lab"):
        skill = cfg.skill(skill_id)
        assert skill is not None
        text = skill.instructions
        assert "SOURCE ORDER" in text, f"{skill_id} must carry the ordered source list"
        rule = text[text.index("SOURCE ORDER") :]
        portal, teams, syllabus = (rule.index(s) for s in ("the university portal", "Microsoft Teams", "syllabus"))
        assert portal < teams < syllabus, f"{skill_id}: the sources must be tried in order"
        assert "3 failed checks" in rule and "remember(" in rule
    for skill_id in ("courseware", "scaffold"):
        skill = cfg.skill(skill_id)
        assert skill is not None and "SOURCE ORDER" in skill.instructions
    # A rule, not a hardcode: no course code or name may appear in the rule's own wording.
    for skill in cfg.skills:
        for line in skill.instructions.splitlines():
            if "SOURCE ORDER" in line or "source order" in line.lower():
                assert "CSCI" not in line and "Computer Vision" not in line
