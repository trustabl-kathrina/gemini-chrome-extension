# Dayflow Agent — Chrome-extension AI agent for KBTU student workflows

Hackathon: All Things Agentic (Google, Devpost). Deadline **2026-08-31 17:00 PDT**. Track: Taskmaster.
Primary user is the author; the product must stay usable after the hackathon (local backend mode).

## Stack (hard constraints — hackathon gates)
- Brain: Python 3.12 + **Google ADK** on **Cloud Run** (also runs locally via `uv run`). Gemini 3.5 via Gemini API.
- State: **Firestore** (sessions, memory, course state, job queue, vector index). Events: **Pub/Sub**.
- Hands: Chrome MV3 extension (TypeScript), thin client — tools = read_page / click / type / navigate / screenshot / download.
- Notifications: Telegram bot + chrome.notifications.

## Hero jobs (priority order; tail degrades to thin, never absent)
1. WSP attendance + scores → cGPA prediction vs target; auto-click attendance when it appears.
2. Course files → detect new/updated on WSP/Teams → download → Gemini parse → Firestore vector RAG → summary notify + Q&A.
3. Teams digest: announcements/assignments, delay/cancel/reschedule detection, "where to be now".
4. Opportunity scanner: selected Telegram channels / uni Outlook → hackathons, internships, events.

## Done-means
- `make verify` exits 0: `ruff check` + `pyright` + `pytest` (backend), `pnpm typecheck` + `pnpm test` (extension).
- Backend deployed on Cloud Run (`*.run.app`), Firestore + Pub/Sub used for real; extension loads unpacked and runs job 1 end-to-end.
- README spin-up from zero, architecture diagram, ≤4-min video with Cloud console visible.

## Rules
- No real credentials or scraped personal data in the repo; site fixtures are anonymized HTML under `backend/tests/fixtures/`.
- Site-specific logic (WSP, Teams) lives behind one `SiteSkill` interface; jobs behind one `Job` interface.
- Never read `.env`. Secrets via env / Secret Manager only.
