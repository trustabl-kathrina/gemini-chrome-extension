# PLAN — make Dayflow actually work, provably

Read `CLAUDE.md` first. This plan is the contract for every builder; the harness is the judge.
Deadline: 2026-08-31 17:00 PDT. Today: 2026-08-26.

## Done-means (all must hold)
1. `make verify` green (ruff + pyright + pytest; tsc + vitest).
2. `make e2e` green: every scene below passes its harness spec against the **fake WSP** with the brain running
   locally (Vertex via ADC) — no human in the loop.
3. Scene 1 also passes against the real `wsp.kbtu.kz` using the signed-in demo profile (`extension/scripts/demo-browser.mjs`).
4. Deployed `dayflow-brain` (Cloud Run) serves the same code; README setup works from zero.

## The loop (Claude-in-Chrome style, on Gemini)
Every browser action returns **what the agent now sees**: a compact DOM snapshot with refs **and** a viewport
screenshot (JPEG ≤1280px, q≈55). The brain attaches the screenshot to the tool result as
`FunctionResponse.parts=[FunctionResponsePart(inline_data=FunctionResponseBlob(mime_type="image/jpeg", data=...))]`
(google-genai 2.20; ADK 2.7 decodes it). The orchestrator must, before EVERY tool call, write one sentence:
what it sees + what it will do (this is what the panel shows as reasoning). Hard cap 40 actions per run.

Browser tools (extension executes; brain declares them as long-running tools with the same names/args):
| tool | args | notes |
|---|---|---|
| `open_tab` | url, active? | allow-list + http(s) only |
| `navigate` | url | same |
| `read_page` | max_nodes? | refs for **every visible element with own text or interactivity** (rows, cells, spans), each line `[eN] role "label" @x,y` with the element's viewport-center coordinates |
| `screenshot` | — | explicit; every other browser tool also returns `screenshot_b64` when `settings.vision` (default true) |
| `click` | ref | scrollIntoView + highlight + click; then wait for load/idle |
| `click_at` | x, y | `document.elementFromPoint` → click (coordinates from the last screenshot/snapshot) |
| `type` | ref, text, submit? | React-safe |
| `press_key` | key | Enter/Escape/Tab/ArrowDown… dispatched to activeElement |
| `scroll` | dy? / ref? | |
| `set_viewport` | width, height | `chrome.windows.update` on the job window |
| `run_js` | expression | evaluated in the page via `chrome.scripting.executeScript({world:'MAIN'})`; returns JSON-serialisable result; allowed only on allow-listed hosts; logged in the timeline |
| `download` | url?, ref?, path | by URL (cookie fetch → `chrome.downloads`) or by clicking a ref that triggers a download (capture `chrome.downloads.onCreated`); saved under `Downloads/<vault>/<path>` |
| `make_folders` | paths[] | creates `<vault>/<path>/.keep` via `chrome.downloads` (data: URL) |
| `list_tabs`, `wait` | | |

Panel: the timeline shows the reasoning sentence, then the tool row, then (collapsed) the screenshot thumbnail.

## Harness (`harness/`)
- `harness/fake-wsp/` — static site + small JS, served by `node harness/serve.mjs` on **http://127.0.0.1:8099**, imitating
  the real portal's *behaviour* (Vaadin-like: no hrefs; navigation by clicking; table rows select on click; Back/Enter buttons):
  - `/` Desktop with the module list: Student files, Student's schedule, Attendance mark, Student's Journal, Transcript, News (English).
  - `/StudentFiles` folder browser: Schools → Instructors → course folders → files. Must include
    `School of Information Technology and Engineering` → `Koishiyeva Dinara` → `CSCI3240 Introduction to Computer Vision` →
    `syllabus.pdf`, `Lecture_01_Introduction.pdf`, `Lab_01_Image_Basics.pdf` (real small PDFs generated in the repo), plus 2 other
    instructors with 1–2 folders each. Files download on click.
  - `/StudentSchedule` weekly grid with Year/Term `<select>`s; Spring 2025-2026 shows `CSCI3240 Introduction to Computer Vision Koishiyeva D.`.
  - `/News` list.
- `harness/run.mjs <scene>` — Playwright: launch persistent Chromium (fresh profile under `harness/.profile`) with
  `extension/.output/chrome-mv3`; seed `chrome.storage.local.settings` (mode live, backendUrl, token, `vision`, allow-list incl.
  `127.0.0.1`, a site profile for `127.0.0.1` copied from the WSP notes, `showWork` true); open the panel as a tab
  (`chrome-extension://<id>/sidepanel.html`); type the scene prompt; poll the timeline until the run ends (timeout 6 min);
  write `harness/out/<scene>.json` (steps, status, summary, screenshots dir) and evaluate the scene's `expect` (below).
  Exit 0/1. `DAYFLOW_URL` (default http://127.0.0.1:8080) and `DAYFLOW_TOKEN` env.
- `make e2e [SCENE=…]` starts fake-wsp + local brain (`DAYFLOW_TOKEN=dev`, `DAYFLOW_FAKE_CONNECTORS=1`), runs the scene(s), stops them.
- Connectors under `DAYFLOW_FAKE_CONNECTORS=1`: GitHub/Linear tools are in-process stubs that record calls to
  `/tmp/dayflow-fake-connectors.jsonl` and return plausible results (repo url, issue ids); the harness reads that file.

## Scenes and their harness expectations
| scene | prompt (from the pack) | expect |
|---|---|---|
| vault-sync | sync the Computer Vision course files | status done; 3 files exist under the Playwright downloads dir `DayflowVault/CSCI3240*/…`; ≤40 actions |
| courseware | cheatsheet + quiz from the CV syllabus | status done; a `courseware` artifact with an `http(s)` href that returns 200 HTML containing "Quiz" |
| scaffold | folder tree for the CV course from its syllabus | ≥5 `.keep` files under `DayflowVault/CSCI3240*/Week NN/` |
| bootstrap | GitHub repo for CV Lab 1 | fake-connector log has `create_repository` + `push_files` with README.md, TODO.md, a `.ipynb` (valid nbformat) |
| team-ops | weekly update + Linear issues + PR | a `confirm` step answered allow (harness auto-allows); fake log has ≥1 `create_issue`, `create_pull_request`; a `type` on the fake chat page (`/chat` page in fake-wsp acting as "Telegram") |
| pitch-deck | deck from the repo | `.pptx` saved under `DayflowVault/…` (valid zip with `ppt/presentation.xml`, ≥6 slides) and a `deck` artifact href to a served HTML preview (200) |

## Backend work per scene (server tools, `backend/dayflow/tools/server.py` + pack skill instructions)
- `parse_document(file_name, pdf_base64)` exists → keep; add `vault_index_put/get` (Firestore or in-memory when no Firestore).
- `generate_courseware(course, weeks, syllabus_text) → {id, url}`: Gemini structured output → HTML from a template, stored
  (Firestore doc or in-memory), served at `GET /courseware/{id}` (no auth, unguessable id).
- `plan_vault_folders(syllabus_text) → {paths[]}` then the browser tool `make_folders`.
- `build_notebook(spec) → {ipynb_json}` via nbformat; GitHub via `McpToolset` or the fake connector.
- `build_deck(outline) → {id, pptx_base64, preview_url}` via python-pptx (add dependency) + HTML preview at `GET /deck/{id}`.
- Skill instructions in `packs/kbtu-student.yaml` rewritten to the tools above and to the loop rules.

## Phases (this is the workflow)
1. Harness + fake WSP + specs (one builder). Red for every scene is fine; infra must run.
2. Loop upgrade — two builders in parallel with disjoint scopes: (a) extension tools/panel, (b) backend tools/prompt/multimodal.
   Then an integrator runs `make e2e SCENE=vault-sync` and fixes until green (≤6 rounds, must change something each round).
3. Scenes 2–6 — one builder each in parallel (disjoint files: their tool module + skill YAML block + harness spec), each runs its own `make e2e SCENE=…` to green.
4. Adversarial review (3 lenses) → fixes → full `make e2e` → deploy → README refresh.

## Rules for builders
- Don't touch files outside your scope; don't commit (the coordinator commits between phases); no new top-level docs.
- Shell hook blocks commands containing `rm -rf` or the word "truncate"; never read `.env`.
- Real credentials never enter the repo. Fake-wsp content is synthetic.
- Every claim of "works" needs harness output (`harness/out/*.json`) or a test.
