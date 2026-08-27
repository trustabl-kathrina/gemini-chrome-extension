# Demo runbook — the 4-minute video

Everything needed to record the submission video in one sitting: pre-flight, the exact prompt per scene, what to
capture, what to do when a step misbehaves, the shot list for a 4:00 cut, and the narration to read.

What the four minutes have to prove, in this order of importance:

1. an agent really drives a real browser and finishes a real chore (scenes on screen, not slides);
2. it runs on Google's stack — Gemini via Vertex AI, Google ADK, Cloud Run, Firestore (Cloud console visible);
3. the user stays in control — one sentence of reasoning per action, an Allow card before anything outward-facing;
4. it is a product, not a script — one generic loop, skills and site knowledge as config the user owns, memory that
   carries from one request to the next.

The cut is **two deep scenes on the real portal** (Programming Principles II: sync → solve Assignment 4 → Colab), not
six shallow ones. Judges score autonomous high-value action (40 %), architecture discipline (30 %), demo readiness (30 %).

---

## 1. Pre-flight

Do this the day before, and again 30 minutes before recording. Each line has its own check — nothing is "probably fine".

### 1.1 Brain on Cloud Run

```bash
cd /home/altairzhambyl/projects/genaihack
make deploy-brain PROJECT=<your-project> REGION=europe-west4     # ~4 min; ends with deploy-smoke
BRAIN_URL=$(gcloud run services describe dayflow-brain --region europe-west4 --format='value(status.url)')
TOKEN=$(gcloud secrets versions access latest --secret dayflow-token)
curl -fsS $BRAIN_URL/health | tee /dev/stderr | grep -q '"backend":"vertex"'
curl -fsS -o /dev/null -w '/vault → %{http_code}\n' -H "authorization: Bearer $TOKEN" $BRAIN_URL/vault
```

`/health` must read `{"ok":true,"firestore":true,"service":"dayflow-brain","bucket":"<project>-dayflow-vault",
"gemini":{"backend":"vertex",…},"local_exec":false}`. `firestore:false` or `bucket:"memory"` means the deploy did not
pick up its env — redeploy before recording, not during.

Cloud Run scales to zero: **send one warm-up prompt** (any scene) 2–3 minutes before the take so the first on-camera
action is not a 15-second cold start.

Connections for scenes 2, 3 and 6 (GitHub / Linear MCP) live on the brain, not in the extension:

```bash
gcloud run services update dayflow-brain --region europe-west4 \
  --update-secrets GITHUB_TOKEN=github-token:latest,LINEAR_API_KEY=linear-key:latest
```

Without them the run stops at `create_repository` with an honest error — that is a re-shoot, so check by asking the
panel for a trivial repo read before recording.

### 1.2 Extension and the profile you record

```bash
cd extension && pnpm build          # writes .output/chrome-mv3 with the dev manifest key (stable extension id)
```

- Use the **demo profile** `~/.dayflow-demo-profile`, never the personal browser: no mail, no chats, no bookmarks bar
  full of private links. Sign it in once, by hand, to: the university portal, `web.telegram.org`, `github.com`, and the
  Google account whose Drive is the vault.
- Settings (panel → gear): **Brain** = `$BRAIN_URL` + token, press *Check* until it says the brain answers;
  **Vision = on** (screenshot with every action — this is what makes the transcript look alive);
  **Show work = on** (the agent's tab stays in front); **Google account** = signed in (needed for the Drive vault, and
  the account chip is nice evidence on camera); **Vault = Google Drive**, folder `Dayflow`, then press *Check Drive*
  until it confirms (fall back to *Brain only* if no OAuth client is configured — say so in the narration rather than
  faking it).
- Config view: open it once so the YAML (skills, sites, permissions, schedules) renders — it is a 3-second shot in the
  architecture segment.
- Mute the OS notifications, silence Telegram desktop, close every other window, set the display to 100 % scale.

### 1.2b Settings for the recording layout

- **Own window: off.** The layout below puts the site window and the panel side by side; with *Own window* on, the
  agent would open a third window and the viewer could not see the panel and the page at once. Off = the "Dayflow"
  tab group joins the site window (the extension activates its tab there for screenshots — that is the shot).
- **Show work: on**, **Vision: on**.

### 1.3 Window layout — one command

```bash
cd extension
node scripts/demo-browser.mjs ~/.dayflow-demo-profile https://wsp.kbtu.kz/ --layout --pin
```

It launches the demo profile with the built extension, puts the site window on the left and the Dayflow panel in a
chrome-less extension window docked against its right edge, then prints exactly what to record:

```
layout: site 1020x900 @0,69 · panel 420x900 @1020,69 — record 1440x900 at 0,69
```

Point OBS's *Screen Capture* at that rectangle (Filters → Crop/Pad, or a 1440×900 canvas scaled to 1920×1080 on export).

| flag | default | why |
|---|---|---|
| `--total 1440x900` | 1440×900 | the whole recorded canvas — site window + panel together |
| `--panel-width 420` | 420 | panel width; the site window gets the rest (1020) |
| `--pos 0,0` | 0,0 | top-left of the canvas; the window manager may push both windows down (it does here: `@0,69`) — the printed rectangle is the truth, record that |
| `--panel window\|tab\|side` | `window` | `window` = docked extension window (recommended); `side` = one 1440×900 window and you click the toolbar icon to open Chrome's real side panel (Chrome only opens it on a user gesture, so the script can't); `tab` = panel as a second tab |
| `--pin` | off | re-asserts the layout every 3 s (the agent no longer resizes windows — `set_viewport` was removed — so this is only insurance) |

`--panel side` is the most honest shot (it is the real side panel, in the real browser chrome) at the cost of one
manual click on the toolbar icon before you hit record; `--panel window` needs no click and is what the shot list assumes.

### 1.4 The "backend on Google Cloud" proof

Open these in a **second window on another workspace** (not in the recorded rectangle) *before* the take, so they are
already loaded when the architecture segment needs them:

- Cloud Run → `dayflow-brain` → **Logs**, filtered to the last hour. During scene 1 the log fills with
  `POST /chat`, `POST /tool_result`, `POST /vault/upload` — that is the shot.
- Cloud Run → `dayflow-brain` → **Revisions** (region, image, env vars: `GOOGLE_GENAI_USE_ENTERPRISE=1`,
  `DAYFLOW_BUCKET`, `DAYFLOW_FIRESTORE=1`).
- Firestore → **Data** → `users/local/vault` (the index rows written during scene 1) and the ADK session collection.
- Cloud Storage → the `…-dayflow-vault` bucket, showing the PDFs and generated pages.
- A terminal with `curl $BRAIN_URL/health | jq` already run — one clean frame with `"backend":"vertex"`.

### 1.5 Dry run

Run every scene you plan to show, once, on the same profile, within the two hours before recording (models are
nondeterministic; a scene that passed yesterday can pick a different path today). Keep the resulting
`harness/out/<scene>.json` and the panel screenshots — they are the fallback B-roll if a live take fails.

The safety net when the real portal misbehaves is the harness: `make e2e SCENE=vault-sync` drives the same extension
against `harness/fake-wsp` with a headed browser, and every scene is green there
(`harness/out/*.json`: `pass: true`, vault-sync 14 actions, lab 14, team-ops 4, courseware 17, scaffold 13, deck 3).

---

## 2. The storyline — one chat, two prompts

Both prompts go into the **same chat** (do not press *New chat* between them): the second one relies on the first —
the zip is already in the vault and the instructor's name is in memory, so the agent never browses for it.

### Scene 1 — Vault sync on the real portal (≈ 90 s of screen time)

Prompt:

```
Sync the syllabus and the assignments of my Programming Principles II course (instructor Kelgenbayev, spring 2025-2026) from WSP into my vault and tell me what changed.
```

What happens (verified 2026-08-27 on wsp.kbtu.kz): plan (6 numbered steps) → `vault_list` (empty) → `open_tab`
wsp.kbtu.kz/StudentFiles in the **Dayflow window** (your own tabs are never touched) → School of IT&E → Kelgenbayev →
"Programming Principles II, spring 2025-2026" → `1. Syllabus for the student` → download both PDFs →
`4. Assignments` → download `programming-principles-2-main.zip` → `remember("PP2: instructor Kelgenbayev, files on
WSP …")` → `vault_list` → changelog with the vault paths and the syllabus summary (parsed by Gemini: 15 weeks, Python,
Pygame, PostgreSQL). ~15 browser actions, ~90–120 s, ≈ $0.10.

Beats to catch on screen: the one-sentence reasoning above every tool row; a row that says `screenshot: unchanged` after
a click that only *selected* a row (the agent then clicks Enter — it reads its own screenshots); the download rows
turning into `→ Drive → indexed` artifacts; the changelog.

### Scene 2 — Solve Assignment 4 into a Colab notebook (≈ 100 s of screen time)

Prompt (same chat):

```
Now solve Assignment 4 of that course as a notebook and open it in Google Colab.
```

What happens: plan → `vault_list` finds `Programming Principles II/Lab 04/programming-principles-2-main.zip` →
`vault_read` shows the bundle as `[file Assignment 4/generators.md] …`, `math.md`, `date.md` → one `solve_lab_task`
per numbered task (Gemini code execution: the code runs, stdout is captured; 14 tasks, ~7 s each) → `build_notebook`
(the brain re-executes every cell with nbclient before it ships — a failing cell comes back as an error, not a repo) →
`build_report` → `download(url=ipynb_url)` and `download(url=page_url)` into the vault → `open_tab
colab.research.google.com/drive/<Drive file id>` → the report page. Zero portal browsing; ≈ 3 browser actions;
≈ 3–5 min wall time (cut to 100 s: real time on the first `solve_lab_task`, 4× over the rest).

Beats: the solver rows' `stdout` (real numbers, e.g. `squares up to 10: 0 1 4 9 …`); `build_notebook` returning
`executed: true`; Colab opening with the notebook already there; the report page.

### If a scene misbehaves — see §3; the fallback take is the harness run on `harness/fake-wsp`
(`make e2e SCENE=vault-sync` / `HARNESS_PROMPT="… open it in Google Colab" make e2e SCENE=lab`), both green.

---

## 3. When a step misbehaves

- **429 RESOURCE_EXHAUSTED** — the brain retries with backoff and falls back to `gemini-3.5-flash`; the panel shows a
  one-line summary and a **Retry** button that continues the same chat. Keep the take: "and when Vertex ran out of
  capacity it fell back and carried on" is a better line than a clean run.
- **The agent selects a row and stops** — it will see `screenshot: unchanged` and click Enter itself; do not intervene.
- **Budget** — 60 browser actions per run; scene 1 as scoped uses ~15. If it starts opening `2.Lectures`, let it finish
  the syllabus + assignments; the changelog is still the shot.
- **Colab opens without the notebook** — the Drive sign-in lapsed (no `drive_file_id`); re-sign in Settings and type
  `open the notebook in Colab again`.
- **Portal signed out** — sign in by hand before the take; the agent never types passwords (site notes say so).

---

## 4. Shot list — 4:00

| Time | Shot | Source | Note |
|---|---|---|---|
| 0:00–0:08 | Cold open, no narration: the portal's file tree, a lecture PDF, the Colab logo — 2 s each, then the title card **Dayflow — a browser agent on Gemini** | b-roll | |
| 0:08–0:25 | The problem: files appear on a portal with no notifications, in a Russian-only UI that international students cannot read; an assignment is a zip of Markdown; every week the same clicks | portal (Russian UI) + zip on screen | narration starts at 0:08 |
| 0:25–0:45 | The panel appears **in its own window next to the portal**; `/` opens the skills palette; 3 s on Config YAML (skills, site notes, permissions) | pre-flight capture | "config you own" beat |
| 0:45–2:15 | **Scene 1** live: plan → portal walk → downloads → memory → changelog. Real time on the plan and the first two actions, 2× over the walk, real time on `remember` and the changelog. Cut to Drive `Dayflow/Programming Principles II/…` for 3 s | live take | keep the `screenshot: unchanged` row in |
| 2:15–3:20 | **Scene 2** live, same chat: plan → `vault_read` bundle → `solve_lab_task` rows (hold 2 s on one stdout) → `build_notebook executed: true` → Colab opens with the notebook → report page | live take | 4× over the middle solver rows |
| 3:20–3:38 | Architecture: README diagram; overlay the loop panel → Cloud Run (ADK) → long-running tool → extension → `/tool_result` (+screenshot) | still + labels | |
| 3:38–3:50 | Cloud console: Cloud Run logs with `usage session=… ≈$0.10` and `tool_result … screenshot_b64=` lines, the revision env, Firestore `users/local/vault`, the bucket, `curl /health` → `"backend":"vertex"` | second window | "runs on Google Cloud, and I can see what it costs" |
| 3:50–4:00 | Close: "two prompts, one chat, twenty minutes back"; repo URL | title card | end before 4:00 |

Recording: 1080p 30 fps, capture the rectangle the layout command printed; voice −12 dB, music −28 dB; burn in
subtitles for both prompts.

---

## 5. Narration (≈ 520 words, ~150 wpm)

**[0:08 — problem]**
Every week the same twenty minutes disappear. New files appear on my university portal with no notification, so I go
looking — in a portal whose interface is Russian-only, which for the international students in my class is a wall,
not a website. An assignment arrives as a zip of Markdown, so I copy tasks into a notebook by hand. None of it is
hard — all of it is browser work, and all of it is on me.

**[0:25 — what it is]**
This is Dayflow: Claude Code for the browser, on Gemini. A Chrome side panel; a Google ADK brain on Cloud Run. You say
what you want, it plans out loud, then it works in *its own* window with your sessions — the portal you're signed into,
your Drive — while you keep using yours. Everything specific to me is config I own: skills, site notes on how a page
behaves, permissions on what it must ask before doing. Nothing in the code knows what my university is.

**[0:45 — scene 1]**
First: sync my Programming Principles course. Watch the panel. It writes a plan, then one sentence before every action:
what it sees, what it does next. The portal has no links — only clickable rows and an Enter button — and the site note
is what taught it that. Notice the portal is in Russian: "Войти", "Назад", the instructor's name in Cyrillic. Half of
my classmates are international students who cannot read that. The agent can — it reads the Russian screen and
reports to you in your language, so the portal stops being a wall. Here it clicked a row, and the screenshot came back *unchanged*; it noticed, and clicked Enter.
Syllabus, then the assignments bundle, straight into my Google Drive vault; the brain parses each file with Gemini,
indexes it, and — this is new — *remembers* the instructor and where the files live. It finishes with a changelog.
Fifteen actions, about a minute and a half, ten cents.

**[2:15 — scene 2]**
Same chat, second prompt: solve Assignment 4 and open it in Colab. No browsing this time — it already knows. It reads
the bundle out of the vault, finds the three Markdown files of Assignment 4, and for each of the fourteen tasks writes
code and *runs* it in Gemini's code-execution sandbox. Real output, not a plausible-looking answer. Then it assembles a
notebook — and the brain re-executes every cell before shipping it; a failing cell comes back as an error, never as a
file. The notebook lands in Drive, Colab opens it, and a report page is saved next to it.

**[3:20 — architecture]**
How it works: the panel talks to Cloud Run, where Google ADK's orchestrator streams events. Browser tools are
long-running tools — the brain asks, the extension acts in the tab and posts the result back with a screenshot, low
resolution unless the site needs vision. Every turn is pruned so the model only carries what it still needs. Sessions,
config and the vault index live in Firestore; files in Cloud Storage; Gemini 3.7 Flash on Vertex AI in my own project.
Here it is in the logs — including the cost of every run, and the moment Vertex ran out of capacity and the brain fell
back to 3.5 Flash and carried on.

**[3:50 — close]**
Two prompts, one chat, twenty minutes back — and an end-to-end test suite against a synthetic portal so you can check
every claim on your machine in ten minutes. Clone it, point it at your own brain.
