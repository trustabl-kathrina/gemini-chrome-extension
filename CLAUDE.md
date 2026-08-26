# Dayflow Agent — Chrome-extension AI agent for KBTU student workflows

Hackathon: All Things Agentic (Google, Devpost). Deadline **2026-08-31 17:00 PDT**. Track: Taskmaster.
Primary user is the author; the product must stay usable after the hackathon (local backend mode).

## Stack (hard constraints — hackathon gates)
- Brain: Python 3.12 + **Google ADK** on **Cloud Run** (also runs locally via `uv run`). Gemini 3.5 via Gemini API.
- State: **Firestore** (sessions, memory, course state, job queue, vector index). Events: **Pub/Sub**.
- Hands: Chrome MV3 extension (TypeScript), thin client — tools = read_page / click / type / navigate / screenshot / download.
- Notifications: Telegram bot + chrome.notifications.

## Demo scenes (the scope — video shows all six, in this order)
1. **Vault sync** — agent opens WSP in a Chrome tab, walks course file directories, downloads new/changed files into a local vault `Downloads/DayflowVault/<course>/<week|lab>/`, indexes them (Firestore + vector). Runs on a schedule (chrome.alarms) and on demand.
2. **Courseware** — from the syllabus: cheatsheet + quiz generated as HTML, served from Cloud Run, auto-opened in a new tab.
3. **Vault scaffold** — per course / per week / per lab folders initialized in the vault from the syllabus schedule.
4. **Project bootstrap** — for coding courses: GitHub repo (or .ipynb) created via GitHub MCP with a working foundation + TODO.md.
5. **Team ops** — agent opens Telegram Web, finds the diploma-project chat, posts an update; creates Linear issues (Linear MCP); opens a GitHub issue + PR (GitHub MCP).
6. **Pitch deck** — builds a pitch deck about the diploma repo; generated server-side (.pptx), opened in PowerPoint Online / Google Slides via the browser; Canva-driving is a stretch via Gemini computer-use.

Backlog (post-hackathon): WSP attendance/GPA, Teams digest + schedule changes, Telegram opportunity scanner.

## Done-means
- `make verify` exits 0: `ruff check` + `pyright` + `pytest` (backend), `pnpm typecheck` + `pnpm test` (extension).
- `make e2e` exits 0: harness (Playwright + fake WSP + local brain) passes every scene — see PLAN.md.
- Backend deployed on Cloud Run (`*.run.app`), Firestore + Pub/Sub used for real; extension loads unpacked and runs scene 1 end-to-end.
- README spin-up from zero, architecture diagram, ≤4-min video with Cloud console visible.

## Rules
- No real credentials or scraped personal data in the repo; site fixtures are anonymized HTML under `backend/tests/fixtures/`.
- Site-specific logic (WSP, Teams) lives behind one `SiteSkill` interface; jobs behind one `Job` interface.
- Never read `.env`. Secrets via env / Secret Manager only.
