# PLAN v2 — Dayflow: "Claude Code for the browser, on Gemini"

Read `CLAUDE.md` first. This plan is the contract for every builder; the harness is the judge.
Deadline: 2026-08-31 17:00 PDT. Today: 2026-08-26. Priority order below is binding: **1 and 2 flawless beats 6 mediocre**.

## Vision (from the user, 2026-08-26)
- Identity: a universal browser agent — generic loop + user-owned config (skills, site profiles, permissions,
  connections). The KBTU student pack is the default pack that proves it; README/UI/video lead with the generic agent.
- Perception is chosen **per site** by the site profile: `mode: dom` (element list with refs + coords; screenshot after
  every action to verify) or `mode: vision` (screenshot-first; act by coordinates; DOM only to read text).
- The panel is **chat-first** like a Claude Code transcript: user prompt → one-sentence reasoning before every action →
  tool rows (with screenshot thumbnails) → artifacts. Skills are invoked by typing `/` (palette). No mock mode.
- The vault is **Google Drive** (the user's own account), folder `Dayflow/<course>/<week|lab|materials>/`. No local Downloads vault.
- Settings = one screen (Google account, backend URL/token, vision, show-work) + **Config**: an editable YAML of
  skills / sites / permissions / schedules, validated and synced to the brain (`PUT /config`).

## Scenes, in priority order (harness expectation in the last column)
| # | scene | what Gemini does | expect |
|---|---|---|---|
| 1 | **vault-sync** | WSP → Student files → school → instructor → course → download every file → upload to Drive `Dayflow/<course>/…` → parse each (summary, deadlines) → index | status done; fake-Drive has the 3 CV files under `Dayflow/CSCI3240*/`; vault index has 3 entries; ≤40 actions |
| 2 | **lab** | read the course's Lab 1 PDF from the vault, create a private GitHub repo, **solve the lab**: a sub-agent with Gemini code execution writes and runs the code per task, assembles a runnable notebook with outputs, writes a report (Markdown; rendered HTML page), pushes README/TODO/notebook/report; uploads the report to Drive | fake-connector log has `create_repository` + `push_files` incl. a valid `.ipynb` whose code cells have outputs and a `REPORT.md`; report page returns 200; ≤40 browser actions |
| 3 | **team-ops** | summarise the week from the repo, open Telegram Web (harness: fake `/chat`), find the diploma chat by name, `request_confirmation`, type + send; then Linear `create_issue` ×N and GitHub `issue_write` + `create_pull_request` | confirm answered (harness auto-allows); message present on the chat page; fake log has create_issue ≥1, create_pull_request 1 |
| 4 | courseware | cheatsheet + quiz page from the syllabus; opened in a tab; saved to Drive | artifact href 200 with "Quiz"; Drive has the HTML |
| 5 | scaffold | folder tree in Drive from the syllabus schedule | ≥15 folders under `Dayflow/<course>/` in fake-Drive |
| 6 | pitch-deck | pptx + HTML preview from the repo; saved to Drive | pptx in fake-Drive is a valid zip with ≥6 slides; preview 200 |

## The loop
Browser tools (extension executes; brain declares them as long-running tools returning `None`):
`open_tab(url)`, `navigate(url)`, `read_page(max_nodes?)` → `[eN] role "label" @x,y` for every visible element with own text or
interactivity, `screenshot()`, `click(ref)`, `click_at(x,y)`, `type(ref,text,submit?)`, `press_key(key)`, `scroll(dy?|ref?)`,
`set_viewport(w,h)`, `run_js(expression)` (MAIN world; allow-listed hosts only; logged), `download(ref?|url?)` → returns the file to
the brain (bytes streamed to `POST /vault/upload`, see below) , `list_tabs()`, `wait(ms)`.
Every browser tool result carries `screenshot_b64` (JPEG ≤1280px, q≈55) when `settings.vision` is on; the brain forwards it as
`FunctionResponse.parts=[FunctionResponsePart(inline_data=FunctionResponseBlob(mime_type='image/jpeg', data=…))]`.
The orchestrator writes one sentence (what it sees → what it does) before EVERY tool call; hard cap 40 browser actions per run
(enforced in `before_tool_callback`); Vaadin hint: click row, then Enter.

Drive & vault:
- Extension obtains a Google OAuth token with `chrome.identity.getAuthToken` (manifest `oauth2` block: client_id from env
  `VITE_GOOGLE_CLIENT_ID`, scopes `drive.file`). A stable extension id is required → manifest `key` (generate once, commit the public key;
  the private key stays out of the repo).
- Extension-side Drive client (`src/agent/drive.ts`): `ensureFolder(path)`, `upload(path, blob)`, `list(path)`; base URL from
  `settings.driveApiBase` (default `https://www.googleapis.com`) so the harness can point it at the **fake Drive**.
- `download(ref|url)` flow: extension captures bytes (cookie fetch for URLs; for click-triggered downloads read the completed
  `chrome.downloads` item then `fetch('file://…')` is NOT allowed → instead prefer capturing the URL from the download item and refetching
  with cookies), uploads to Drive at the path the brain asked for, and ALSO posts the bytes to the brain `POST /vault/upload`
  (multipart: user's path + file) so the brain can parse/index (Firestore `users/{uid}/vault/{id}`: path, drive_file_id, summary, deadlines, sha256).
- If no OAuth client is configured (judges, CI): `settings.vault.mode = 'brain'` — files are only stored by the brain (GCS bucket
  `DAYFLOW_BUCKET` when set, else in-memory) and listed at `GET /vault`. The harness uses fake Drive so both paths are exercised.

Lab solver:
- `agents/lab_solver.py`: an ADK `LlmAgent` with `BuiltInCodeExecutor` (Gemini code execution) used as an `AgentTool`
  `solve_lab_task(task_text, context)` → `{code, stdout, notes}`; the orchestrator calls it per task, then `build_notebook(cells)` (nbformat,
  with outputs from stdout), `build_report(course, lab, results)` → Markdown + PageStore HTML.
- Verify: the assembled notebook executes with `nbclient` in a subprocess with timeout in the harness step (numpy/matplotlib available in the
  harness venv) — expectation: all cells execute without error.

## Harness (`harness/`) — no human in the loop
- `harness/fake-wsp/` — static site + JS on `FAKE_WSP_PORT` (default 8099), Vaadin-like (no hrefs, click navigation, table rows select on
  click, Back/Enter): `/` Desktop with module links (Student files, Student's schedule, Attendance mark, Student's Journal, Transcript, News);
  `/StudentFiles` Schools → Instructors → course folders → files (incl. `School of Information Technology and Engineering` → `Abenova Saule` (all names are invented)
  → `CSCI3240 Introduction to Computer Vision` → `syllabus.pdf`, `Lecture_01_Introduction.pdf`, `Lab_01_Image_Basics.pdf` — real generated
  PDFs: syllabus = 15-week topic list; lab = 5 concrete numpy image tasks with sample data described in-text); `/StudentSchedule` with
  Year/Term selects (Spring 2025-2026 shows the CV row); `/News`; `/chat` fake messenger (chat rows incl. "Diploma · Team", textarea, Send).
- `harness/fake-drive.mjs` — minimal Drive v3: `GET /drive/v3/files?q=…` (name/parent lookup), `POST /drive/v3/files` (folders),
  `POST /upload/drive/v3/files?uploadType=multipart`, `GET /drive/v3/files/{id}?alt=media`; stores under `harness/out/drive/<scene>/` as a
  real folder tree so expectations can `ls`. Port `FAKE_DRIVE_PORT` (default base+2). Accepts any bearer token.
- `harness/run.mjs <scene> [--real]` — Playwright: persistent Chromium + `extension/.output/chrome-mv3`; seed `chrome.storage.local.settings`
  (backendUrl, token, vision, showWork, driveApiBase → fake Drive, a fake OAuth token, allow-list with `127.0.0.1`, site profile for
  `127.0.0.1` copied from the WSP notes with `mode: dom`); open `chrome-extension://<id>/sidepanel.html`; type the prompt; auto-allow
  confirmation cards; poll until the run ends (timeout 8 min); write `harness/out/<scene>.json` {status, summary, steps[], actions};
  evaluate `harness/specs/<scene>.mjs`. `--real` uses `~/.gstack/chromium-profile` (signed in to wsp.kbtu.kz; never log in, never type
  credentials) and the real portal prompt.
- `make e2e [SCENE=…]` with `E2E_PORT_BASE` (fake-wsp BASE, brain BASE+1, fake-drive BASE+2), brain env `DAYFLOW_TOKEN=dev
  DAYFLOW_FAKE_CONNECTORS=1 DAYFLOW_FAKE_LOG=harness/out/<scene>-connectors.jsonl`; profile `harness/.profile-<scene>`; logs in `harness/out/`.
- Fake connectors: `DAYFLOW_FAKE_CONNECTORS=1` → in-process stubs named like the MCP tools (create_repository, push_files, issue_write,
  create_pull_request, get_file_contents, list_teams, list_projects, create_issue) logging JSON lines and returning plausible results.

## Extension changes (chat-first)
- Delete: mock transport (`src/agent/mock.ts`, in-page transport), Home skills board, six-tab settings. Keep scheduler code (config-driven).
- Views: **Chat** (transcript; composer; `/` opens the skills palette; ⌘K too), **Settings** (account via Google sign-in button →
  `chrome.identity`, backend URL + token, vision, show work, Drive status), **Config** (YAML editor of the brain's UserConfig with validation
  errors inline; Save → `PUT /config`; a "reset to pack" button).
- Timeline: reasoning sentence (text step) → tool row (name, args, timing, ✓/✗) → collapsed screenshot thumbnail → artifacts (Drive links,
  repo, PR, pages).

## Backend changes
- `UserConfig.sites[].mode: 'dom' | 'vision'` (default dom); prompt composition mentions the mode for the domains in scope.
- `POST /vault/upload` (auth) multipart → store (GCS when `DAYFLOW_BUCKET` else memory) + index doc; `GET /vault` list; `parse_document`
  runs on upload (Gemini flash-lite) and fills summary/deadlines; `GET /pages/{kind}/{id}` PageStore (courseware, report, deck previews).
- Tools: browser tools (above), `solve_lab_task` (AgentTool over lab_solver), `build_notebook`, `build_report`, `generate_courseware`,
  `plan_vault_folders`, `build_deck`; GitHub/Linear via McpToolset or fake connectors.
- Pack: skills rewritten as concrete step lists using these tools; site profiles: `wsp.kbtu.kz` (mode dom, tree notes), `web.telegram.org`
  (mode dom; chat list on the left, search box, composer at the bottom), `github.com`, `drive.google.com` (mode vision).

## Phases (the workflow)
1. **Harness** (one builder): fake-wsp, fake-drive, runner, specs for scenes 1–3 (4–6 later), Makefile e2e, fake connectors.
2. **Loop** (parallel, disjoint): (a) extension — chat-first UI, tools, Drive client, config editor, no mock; (b) backend — tools, vault upload
   + index, multimodal tool results, prompt, site modes, PageStore.
3. **Integrate scene 1** to green (fake), then `--real` on the portal (report honestly).
4. **Scene 2 (lab)** then **scene 3 (team-ops)** — sequential builders, each to green.
5. **Review** (3 lenses) → fixer → full e2e for scenes 1–3. Scenes 4–6 only after 1–3 are green.

## Rules for builders
- **Never kill a process except through `harness/lib/safe-kill.sh`** (`safe_kill <pid>`, `safe_kill_port <port>`). No `kill $PPID`, no `pkill -f`, no `kill -- -<pgid>` of your own; the parent of a setsid'd server is `systemd --user` and killing it ends the user's desktop session (happened 2026-08-26).
- Stay in scope; don't commit (coordinator commits between phases); no new top-level docs; keep `make verify` green.
- Shell hook blocks commands containing `rm -rf` or the word "truncate"; never read `.env`.
- No real credentials or personal data in the repo; fake-wsp/fake-drive content is synthetic.
- "Works" = harness JSON or a test. If something can't be done, say so with evidence.

## Ship (phase 7 — queued as workflow `dayflow-v3-ship`, starts when v2 finishes)
Goal: a stranger can install Dayflow from a zip or the Chrome Web Store, run it against their own brain, and a judge can verify every claim.

1. **Remaining scenes 4–6** (courseware, scaffold, pitch-deck) each to `make e2e` green, in parallel on separate port sets.
2. **Real Drive + sign-in**: `oauth2.client_id` from `VITE_GOOGLE_CLIENT_ID` (needs the user's OAuth client for id `jagkpbdiempedibinmfafamdhnogognn`);
   Sign in with Google via `chrome.identity`; graceful fallback to the brain vault when unconfigured; optional Google ID-token auth on the brain.
3. **Chrome Web Store package**: branded icons; `pnpm zip:store` builds without the dev `key`; `docs/store/listing.md` (single purpose,
   permission justifications, data-use disclosure); `docs/PRIVACY.md` served at `/pages/privacy`; ≥3 real 1280×800 screenshots.
   Store review realities: `<all_urls>` + `scripting` + `identity` trigger manual review (days to weeks) — submit as **unlisted** first so the
   hackathon link works immediately; keep the unpacked zip in GitHub Releases as the judge path.
4. **Repo readiness** (`/hackathon-repo` after the GitHub remote exists): README to v2 reality with honest per-scene status from
   `harness/out/*.json`, `docs/ARCHITECTURE.md` (diagram + sequence), `docs/JUDGES.md` (10-minute path), CI (`make verify`), LICENSE (MIT),
   `.env.example` files, `git ls-files` audit. Then create the GitHub repo and push — **requires the user's OK** (public, or private shared with
   testing@devpost.com and cloudhackathons@google.com).
5. **Demo readiness**: `docs/DEMO.md` runbook (pre-flight, prompts per scene, shot list 0:00–4:00, narration ≈550 words), `docs/DEVPOST.md`
   submission text + bonus checklist, `demo-browser.mjs --layout` (site window + docked panel at 1440×900). Recording: OBS or Chrome tab
   capture at 1080p, Cloud Run logs + Firestore visible in a second window during scene 1; English narration or subtitles.
6. **Final review** (correctness / security / judge lenses) → fixer → full `make e2e` for all six scenes → deploy → tag `v0.2.0`.
