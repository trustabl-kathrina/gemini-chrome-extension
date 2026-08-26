# Demo runbook — the 4-minute video

Everything needed to record the submission video in one sitting: pre-flight, the exact prompt per scene, what to
capture, what to do when a step misbehaves, the shot list for a 4:00 cut, and the narration to read.

What the four minutes have to prove, in this order of importance:

1. an agent really drives a real browser and finishes a real chore (scenes on screen, not slides);
2. it runs on Google's stack — Gemini via Vertex AI, Google ADK, Cloud Run, Firestore (Cloud console visible);
3. the user stays in control — one sentence of reasoning per action, an Allow card before anything outward-facing;
4. it is a product, not a script — the same loop runs six different skills from a config the user owns.

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
| `--pin` | off | re-asserts the layout every 3 s — the agent's `set_viewport` tool resizes the window it works in |

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

## 2. Prompts, in priority order

Type them into the composer (or press `/` and pick the skill — the palette is a better shot for scene 1). Priority
order = the order to record; if time runs out, the last ones become the 20-second montage.

> Replace `<COURSE>`, `<CHAT>`, `<OWNER>/<REPO>` with your real values while recording. **Never type credentials on
> camera** and never show the portal's login page — the profile is already signed in.

### Scene 1 — Vault sync (the hero scene, real portal)

```
Sync the files of my <COURSE> course (Spring 2025-2026, instructor <SURNAME NAME>) from WSP into my vault and tell me what changed.
```

Naming the instructor is not decoration: without it the agent first opens *Student's schedule* to find them, and a real
run has already come in at 40 of the 40 allowed browser actions (`harness/out/vault-sync.real4.json`). Naming the
instructor saves ~6 actions and is the difference between a finished take and a cap error.

Capture: the `/` palette → the first reasoning sentence → the portal tree being clicked open (School → Instructor →
course) → the download rows → `vault_list` → the closing changelog with Drive links. Then cut to the Drive folder
`Dayflow/<course>/…` in the other window, and to the Firestore `vault` collection.

### Scene 2 — Lab

```
Solve Lab 1 of my <COURSE> course from my vault: create a private GitHub repo, solve every task with code you actually run, push README.md, TODO.md, the notebook with outputs and REPORT.md, and save the report to my vault.
```

Capture: the `solve_lab_task` rows (Gemini code execution — say the words "the code is actually executed"), the
`build_notebook` / `build_report` rows, `create_repository` + `push_files`, then the opened report page, then GitHub
showing the notebook **with outputs**. This scene is the longest (≈3–5 min live) — record it in full, cut to ~45 s.

### Scene 3 — Team ops (Telegram Web)

```
Summarise this week's work on <OWNER>/<REPO> and post the update to the "<CHAT>" chat on Telegram Web (ask me before sending). Then create Linear issues for the next milestone and open a GitHub issue and one pull request for the repo.
```

Capture: the chat list, the **Allow / Deny** card with the exact message text, your click on *Allow*, the message
appearing in the thread, then the Linear issues and the GitHub PR. This is the trust beat of the video — hold on the
card for a full second before clicking.

### Scenes 4–6 — Courseware, Scaffold, Pitch deck (montage)

```
Build a cheatsheet and a quiz from the <COURSE> syllabus in my vault, open the result in a new tab and save it to my vault.
Create the vault folder tree for <COURSE> from its syllabus in my vault: one folder per week and per lab.
Build a pitch deck about my diploma project repo <OWNER>/<REPO>, save it to my vault and open the preview.
```

Capture: the quiz page (open one `<details>` answer), the Drive tree with `Week 01 … Week 15` + `Lab 01 …`, and the
deck preview plus the `.pptx` in Drive. Three shots, ~7 seconds each.

---

## 3. When a step misbehaves

| Symptom | Do this |
|---|---|
| Panel says *no brain* | Settings → *Check*. Cold Cloud Run: wait 10 s and press again. Wrong token → `gcloud secrets versions access latest --secret dayflow-token`. |
| Run ends with "40 browser actions, cap is 40" | Re-prompt with more given: the instructor name, the exact folder, "download only the syllabus". Don't raise the cap on camera. |
| The portal re-renders and a click misses | Say nothing, let it retry — the agent re-reads the page. If two retries fail, cancel and re-prompt with the direct URL (`https://wsp.kbtu.kz/StudentFiles`). |
| The portal is down / shows a login page | Switch to the harness portal: `make e2e SCENE=vault-sync` (headed, seeds everything itself) — record its window. Driving the fake portal by hand instead (`make fake-wsp` + `node scripts/demo-browser.mjs … http://127.0.0.1:8099/ --layout`) needs `127.0.0.1` added to the navigation allow-list in the panel's Config first. Say on camera that this is the synthetic portal the test suite uses. |
| A gated call is refused ("differ from what the user approved") | Allow the *next* card; the agent re-asks with the exact text. Do not deny — a denial ends the run. |
| GitHub/Linear tool errors | The tokens on the brain expired. Fall back to a local brain with `DAYFLOW_FAKE_CONNECTORS=1` and say the connectors are stubbed, or cut the scene. |
| Drive upload fails mid-run | The OAuth token expired; the extension refreshes once and retries. If it still fails, switch Settings → Vault → *Brain only* and show `GET /vault` instead. |
| Windows drift during a run | You forgot `--pin`. Re-run the layout command; the profile is persistent, nothing is lost. |
| Nothing works 20 minutes before the deadline | Cut the dry-run B-roll: the harness recordings plus `harness/out/<scene>.json` on screen. Never fake a result you did not get. |

---

## 4. Shot list — 4:00

| Time | Shot | Source | Note |
|---|---|---|---|
| 0:00–0:10 | Cold open: portal file tree, Telegram, GitHub, Linear tabs flicking past; title card **Dayflow — a browser agent on Gemini** | screen recording | no narration on the first 2 s |
| 0:10–0:25 | The problem: one student's week — files scattered across the portal, a lab due, a team chat to update | same | narration starts at 0:03 |
| 0:25–0:40 | The panel: `/` opens the skills palette, six skills listed | scene 1 take, first seconds | slow the palette to 0.75× |
| 0:40–0:50 | Settings + Config YAML (skills, sites, permissions, schedules) | pre-flight capture | "the config is yours" beat |
| 0:50–1:40 | **Scene 1 — vault sync**: reasoning sentence → portal clicks → downloads → `vault_list` → changelog; cut to Drive `Dayflow/<course>/…` | live take | speed 1.5–2× over the walking, real-time on the first two actions |
| 1:40–2:25 | **Scene 2 — lab**: `solve_lab_task` rows → notebook + report → repo pushed → report page → GitHub notebook with outputs | live take | hold 1 s on a code cell's output |
| 2:25–2:55 | **Scene 3 — team ops**: chat found → **Allow** card with the exact text → sent message → Linear issues → GitHub PR | live take | real time on the Allow card |
| 2:55–3:10 | Montage: quiz page, Drive week/lab tree, pitch deck preview | live takes | ~5 s each, no narration cuts |
| 3:10–3:25 | Architecture diagram (README mermaid, exported PNG) with the loop animated: panel → Cloud Run → tool call → extension → `/tool_result` | still + labels | |
| 3:25–3:40 | Cloud console: Cloud Run logs filling live, revision env vars, Firestore `users/local/vault`, the vault bucket, `curl /health` showing `"backend":"vertex"` | second window | this is the "runs on Google Cloud" proof |
| 3:40–3:52 | Honest status: six scenes green in the harness (`make e2e`), scene 1 verified on the real portal | terminal + `harness/out/*.json` | |
| 3:52–4:00 | Close: logo, repo URL, "install it, point it at your own brain" | title card | end before 4:00, hard |

Recording settings: 1080p, 30 fps, capture exactly the rectangle the layout command printed, upscale 1440×900 → 1920×1080
on export. Voice at −12 dB, music (if any) at −28 dB. Burn in subtitles — every prompt typed on screen should also be
legible as a caption.

---

## 5. Narration (≈550 words, read at ~150 wpm)

**[0:03 — problem]**
Every week at my university the same twenty minutes disappear. New lecture files appear on the student portal with no
notification, so I go looking for them. A lab is due, so I copy the tasks into a notebook. The team chat needs the
weekly update, Linear needs the issues, GitHub needs the pull request. None of it is hard. All of it is browser work,
and all of it is on me.

**[0:25 — what it is]**
This is Dayflow. It is Claude Code for the browser, running on Gemini: a Chrome side panel with a Google ADK brain on
Cloud Run. You type what you want, it plans out loud, and then it uses the same browser you are signed into — your
portal session, your Telegram, your GitHub. Not scraping, not an API bolted on the side. Eyes and hands in the tab.

**[0:40 — the config]**
Everything specific to me is configuration I own: skills, one per chore; site profiles telling it how a page behaves;
permissions — where it may navigate and what it must ask before doing. Nothing in the code knows what my university is.

**[0:50 — scene 1]**
First skill: sync my course files. Watch the panel. Before every single action there is one sentence: what it sees, what
it will do. It opens the portal, walks School, instructor, course folder — this portal has no links, only clickable
rows, and the site profile is what taught it that. It downloads every file straight into my Google Drive vault, and the
brain parses each PDF, pulls the deadlines, and indexes it. It finishes with a changelog: what is new, what changed.
Twenty minutes of clicking, in about ninety seconds, with a hard cap of forty actions so it can never wander.

**[1:40 — scene 2]**
Second skill: solve the lab. It reads the lab PDF out of the vault and, for each task, writes code and actually runs it
in Gemini's code execution sandbox. Real output, not a plausible-looking answer. It assembles a notebook with those
outputs, writes a report, creates a private GitHub repo, and pushes the notebook, the report, a README and a TODO of
what is still missing. Here is the notebook on GitHub — cells with results in them.

**[2:25 — scene 3]**
Third skill: the team. It summarises the week from the repo, opens the messenger, finds our diploma chat — and stops.
Anything that leaves my machine needs my word first, and the approval is bound to this exact text: if the model rewrote
a single sentence afterwards, the call is refused. I click Allow. Message sent. Then two Linear issues and a pull
request, each with its own approval.

**[2:55 — montage]**
Same loop, three more skills: a cheatsheet and a quiz from the syllabus, the whole semester's folder tree in Drive, and
a pitch deck as a real PowerPoint file.

**[3:10 — architecture]**
How it works: the panel posts to Cloud Run, where Google ADK's orchestrator streams events. Browser tools are
long-running tools — the brain asks, the extension does it in the tab, and posts the result with a screenshot back.
Sessions, the config and the vault index live in Firestore, files in Cloud Storage, and Gemini 3.7 Flash runs on Vertex
AI in my own project. Here it is happening, in the Cloud Run logs, in Firestore, in the bucket.

**[3:40 — close]**
Every scene you just saw is checked by an end-to-end test suite against a synthetic portal, so you can verify the same
claims on your machine in ten minutes. Clone it, point it at your own brain, and take your twenty minutes back.
