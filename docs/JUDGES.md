# Testing instructions

Dayflow automates a KBTU student's week: it drives the university portal in a real Chrome tab, mirrors the
course files into a vault, and turns them into notebooks, cheatsheets and repos. The real portal sits behind
the author's personal university account, which cannot be shared — so this repo ships an **anonymized replica
of it that you run yourself**. Everything below needs *zero* credentials of ours.

---

## Run it yourself — five steps, about five minutes

Prerequisites: **Node 22.18+**, **pnpm 10**, **Chrome**. (Steps 1 and 2 need nothing else.)

### 1. Start the replica portal

```bash
git clone <this repo> && cd genaihack
make replica                      # → http://127.0.0.1:8099
```

No install step: the server is one dependency-free Node file. Open <http://127.0.0.1:8099> and sign in with
the seeded demo account — **`demo` / `demo`**, already filled into the form; press *Sign in*. You get the
portal the agent will drive: *Desktop* → *Student files* → School → Instructor → course → PDFs, plus
*Student's schedule*, *News* and a *Messenger* page.

Stay signed in in this browser profile. The agent inherits the session exactly as it inherits the author's
real one — it never types credentials.

<details><summary>Other ways to run it</summary>

```bash
make replica-docker                        # the same container Cloud Run would run (harness/Dockerfile)
make replica-deploy PROJECT=<your-project> # PRINTS the `gcloud run deploy` command; runs nothing
node harness/serve.mjs --login --port 9000 # any port; --no-login for the open portal `make e2e` drives
```
Credentials are overridable with `FAKE_WSP_USER` / `FAKE_WSP_PASSWORD`; the login gate itself is
`FAKE_WSP_LOGIN=1` (or `--login`). Port 8099 is also the harness's port — don't run `make e2e` at the
same time, or pick another port.
</details>

### 2. Load the extension

```bash
cd extension && pnpm install && pnpm build     # → extension/.output/chrome-mv3
```

`chrome://extensions` → *Developer mode* → **Load unpacked** → `extension/.output/chrome-mv3`. Click the
toolbar icon to open the side panel.

Build output is not committed, so the repo carries no prebuilt binary; `pnpm zip` packs the same folder into
`extension/.output/dayflow-extension-<version>-chrome.zip`, and that zip is what a GitHub Release (if the
submission links one) carries — unzip it and *Load unpacked* the resulting folder instead.

### 3. Point the panel at a brain, then give it the portal

In the panel's **Settings**:

| Field | Value |
|---|---|
| **Brain URL** | `https://dayflow-brain-226180967155.europe-west4.run.app` (ours, live) or `http://localhost:8080` (yours, see below) |
| **Token** | ours: the bearer token in the Devpost submission's *Testing instructions* field — it is not in a public repo. Yours: `dev` |
| **Vault** | **Brain only** — no Google account, nothing to configure |

Press *Check*: it pings `/health` and `/config`. Prefer your own brain? `DAYFLOW_TOKEN=dev make dev-brain`
after `gcloud auth application-default login` and `export GOOGLE_CLOUD_PROJECT=<a project with Vertex AI on>`.

Then open the **Config** view (the whole agent is YAML the brain serves) and tell it about the replica —
two edits, because the pack ships pointed at the real `wsp.kbtu.kz`:

```yaml
sites:                       # add this entry
  - domain: 127.0.0.1
    mode: dom
    notes: |
      Replica of the KBTU student portal at http://127.0.0.1:8099 (already signed in).
      Desktop lists the modules; "Student files" (/StudentFiles) is a folder browser with no links:
      School > Instructor (Surname Name) > course folder > files. Click a row to select it, then click
      the Enter button; Back goes up one level. A file row does not download when clicked — its last
      cell holds an icon-only download button: call download(ref=<the row's ref>).

permissions:
  allowed_hosts: [wsp.kbtu.kz, …, 127.0.0.1]     # append 127.0.0.1
```

Save. Anything not on `allowed_hosts` is refused — by the brain and again by the extension.

### 4. Type the prompt (or let the schedule fire)

Paste into the composer:

```
Sync the CSCI3240 Introduction to Computer Vision course files from WSP (http://127.0.0.1:8099)
into my vault and tell me what changed.
```

To watch it run **unattended** instead, edit the `vault-sync` skill's `schedule:` in the Config view from
`0 8 * * *` to a couple of minutes ahead (e.g. `*/2 * * * *`) and save — the worker re-registers its
`chrome.alarms` on every settings change and the run starts on its own, with a Chrome notification at the end.

### 5. Watch, then check where things landed

A tab opens on the replica and the agent walks it: *Student files* → *School of Information Technology and
Engineering* → *Abenova Saule* → *CSCI3240 Introduction to Computer Vision* → three PDFs downloaded one by
one. The panel prints one line of reasoning per step and then the tool call it chose, with its arguments.
Typical run: ~15 browser actions in 1–2 minutes (the committed `harness/out/vault-sync.json` verdict: 14
actions, 91 s). The brain hard-caps a run at 60 browser actions and the tools start returning errors after that.

| Where | What you should find |
|---|---|
| the panel's transcript | `open_tab` → `read_page` → `click` → `click` (Enter) → … → `download` ×3 → `vault_list`, then a changelog naming the three files |
| the portal's server log (the `make replica` terminal) | `GET /StudentFiles 200`, then `GET /files/Abenova Saule/…/syllabus.pdf 200` — the downloads really came from it |
| the vault | `curl -H "authorization: Bearer <token>" <brain>/vault` — three entries under `CSCI3240 Introduction to Computer Vision/{Materials,Week 01,Lab 01}/`, each with `sha256`, `title`, `summary`, `deadlines` (the brain parsed the PDFs) |
| Chrome's download folder | the three PDFs, byte-identical to what the portal served |
| the brain | our Cloud Run *Logs*, or the local terminal: one short HTTP exchange per browser action |

Verify the brain is live and is the one you are talking to — no token needed:

```bash
curl -s https://dayflow-brain-226180967155.europe-west4.run.app/health
# {"ok":true,"firestore":true,"service":"dayflow-brain","bucket":"dayflow-agentic-dayflow-vault",
#  "gemini":{"backend":"vertex","project":"dayflow-agentic","location":"global"},"local_exec":false}
```

Everything past `/health` requires the bearer token (`GET /vault`, `GET /config`, `POST /chat`).

---

## What is real, and what is replicated

Said plainly, because it is the one thing that would be dishonest to blur:

| | Real | Replicated |
|---|---|---|
| **The portal** | the demo video drives the author's actual university portal, `wsp.kbtu.kz`, signed in with his own account | `make replica` serves **an anonymized copy of that portal's layout**, under `harness/fake-wsp/`. The students, instructors, courses, PDFs, chats and news in it are generated (`harness/fake-wsp/gen.py`), the credentials are `demo`/`demo`, and no real personal data is in this repo. It reproduces the behaviours that make the real one hard — a Vaadin-style app with no links, folders that open only via *select row + Enter*, hidden per-row download buttons, downloads as `Content-Disposition: attachment` |
| **The agent** | real. Gemini via Vertex AI decides every action; nothing about the run is scripted | — |
| **The browser** | real Chrome, real MV3 extension, real `chrome.downloads` / `chrome.alarms` / `chrome.notifications` | — |
| **The brain** | real: Google ADK on Cloud Run, Firestore for sessions/vault/config, GCS for bytes, Pub/Sub + Cloud Scheduler handlers | — |
| **Google Drive** | real in the product (Drive v3 with scope `drive.file`) | the automated harness talks to a Drive v3 stand-in (`harness/fake-drive.mjs`) so `make e2e` needs no Google account. The judge path above uses **Brain only**, which is the real storage path |
| **GitHub / Linear** | real MCP servers when `GITHUB_TOKEN` / `LINEAR_API_KEY` are set on the brain | `DAYFLOW_FAKE_CONNECTORS=1` gives same-named in-process stubs, which is what the harness records |

The replica exists for one reason: the rules require judges to be able to run the project, and we will not
hand out a student's university credentials. Same agent, same code path, same site profile — a different host
name.

---

## More ways to check, if you have longer

### Read the committed evidence (2 min, nothing to install)

`make e2e` writes one JSON verdict per scene, and those six files are committed:

```bash
node -e "for (const s of ['vault-sync','lab','team-ops','courseware','scaffold','pitch-deck']) {
  const j = require('./harness/out/'+s+'.json');
  console.log(s.padEnd(12), j.pass ? 'PASS' : 'FAIL', String(j.actions).padStart(3)+' actions',
              Math.round(j.durationMs/1000)+'s', j.failures.join('; '));
}"
```

Then open one — `harness/out/lab.json` is the richest:

| Field | What it proves |
|---|---|
| `prompt` | the plain-English request the agent was given — nothing scripted after that |
| `steps[]` | the whole transcript: one reasoning sentence, then a tool row (name, args, ms, ok/error), then artifacts |
| `actions`, `refusedActions` | browser actions against the hard cap, and every call the brain's guard refused |
| `toolCalls` | call count per tool, e.g. `solve_lab_task: 5` — Gemini ran code five times |
| `drive.entries` | the folder tree the agent actually created in (fake) Google Drive |
| `vault` | `GET /vault` from the brain — the parsed, indexed copy with titles, summaries and deadlines |
| `connectorCalls` | the GitHub/Linear calls, in order (`create_repository`, `push_files`, `create_pull_request`, …) |
| `confirms` | every Allow/Deny card, its exact text and the answer |
| `spec`, `specSha256`, `runnerSha256` | which judge produced the verdict — a stale JSON from an older spec is detectable |

Each spec (`harness/specs/<scene>.mjs`) states in its first comment what "green" means; the checks are
adversarial on purpose (the notebook is executed, the `.pptx` is unzipped and its slides counted, the Drive
copy is compared byte-for-byte with the page the brain served).

### Run the tests (3 min)

```bash
make verify
```

`ruff check` + `pyright` + `pytest` for the brain, `tsc --noEmit` + `vitest` for the extension, and
`node --test` for the harness's own self-tests (the fake Drive's upload semantics, the replica portal's login
gate). No credentials, no network calls to Google. The same command is the CI job (`.github/workflows/ci.yml`).

### Run the whole agent suite (5–25 min, needs your own GCP project)

The browser, the portal and Drive are fakes here; **Gemini is real**.

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=<your project>      # Vertex AI enabled, billing on
make e2e-setup                                  # pnpm install + Playwright Chromium + uv sync   (~2 min, once)
make e2e SCENE=vault-sync                       # ~3 min; or SCENE=lab | team-ops | courseware | scaffold | pitch-deck
```

Exit code 0 = the spec passed. `make e2e` with no `SCENE` runs all six.

| Scene | Prompt the panel types | Green means |
|---|---|---|
| vault-sync | *Sync the CSCI3240 … course files from WSP into my vault and tell me what changed.* | 3 PDFs under `Dayflow/CSCI3240*/{Materials,Week 01,Lab 01}` in fake Drive, 3 indexed vault entries, ≤60 actions |
| lab | *Solve Lab 1 … create a private GitHub repo, solve every task with code you actually run, push …* | `create_repository` + `push_files` with an `.ipynb` whose code cells carry outputs; the notebook is re-executed with nbclient and must run clean; `REPORT.md` + a report page returning 200 |
| team-ops | *Summarise this week … post the update to the "Diploma · Team" chat (ask me before sending) …* | an Allow card whose text **is** the message that then appears in the chat DOM; ≥1 Linear issue; exactly 1 pull request |
| courseware | *Build a cheatsheet and a quiz from the syllabus …* | the brain's `/pages/courseware/<id>` serves a cheatsheet + 10 quiz questions with folded answers; the same bytes are in the vault |
| scaffold | *Create the vault folder tree … one folder per week and per lab* | ≥15 folders, one per week of the syllabus' 15-week schedule plus the labs, and no doubled `Dayflow/` nesting |
| pitch-deck | *Build a pitch deck about my diploma project repo …* | a real OpenXML `.pptx`, 16:9, ≥6 slides, byte-identical in the vault, with a preview page that lists the same headings |

Artifacts land in `harness/out/<scene>/` (screenshots under `shots/`), the brain's log in
`harness/out/brain-<scene>.log`, the Drive tree in `harness/out/drive/<scene>/`. The loop is visible in the
brain log as a ping-pong, one HTTP exchange per action:

```
INFO:  127.0.0.1 - "POST /chat HTTP/1.1" 200 OK
INFO:  127.0.0.1 - "POST /tool_result HTTP/1.1" 200 OK     ← open_tab result came back
INFO:  127.0.0.1 - "POST /tool_result HTTP/1.1" 200 OK     ← read_page …
INFO:  127.0.0.1 - "POST /vault/upload HTTP/1.1" 200 OK    ← a downloaded PDF, parsed + indexed
INFO:  127.0.0.1 - "GET /vault HTTP/1.1" 200 OK            ← the harness reads the index back
```

If a scene fails, `harness/out/<scene>.json → failures[]` says why in words
(e.g. `"41 browser actions, cap is 40"`, `"create_issue calls: 0, expected ≥1"`).

### Try to break it

- Ask it to open a host that is not on `allowed_hosts` → refused twice, by the brain and by the extension.
- Ask it to send a message with different text than the one on the Allow card → refused; the approval is
  bound to the exact text (`guard_tool` / `find_approval` in `backend/dayflow/agents/orchestrator.py`).
- Delete `backend/dayflow/core/packs/kbtu-student.yaml` and restart the brain: the agent still runs, with no
  skills. The university logic is configuration, not code.

---

## Google Cloud, if you have the console open

Deployed with `make deploy-brain PROJECT=<your-project>` — one command; it creates the bucket, deploys,
back-fills `DAYFLOW_PUBLIC_URL`/`OIDC_AUDIENCE` and smoke-tests itself.

| Console page | What is there |
|---|---|
| **Cloud Run** → `dayflow-brain` → *Logs* | the `/chat` → `/tool_result` ping-pong above, one line per browser action; min-instances 0, so the service is idle between runs |
| **Cloud Run** → *Revisions* → env | `GOOGLE_GENAI_USE_ENTERPRISE=1`, `GOOGLE_CLOUD_PROJECT`, `DAYFLOW_BUCKET`, `DAYFLOW_FIRESTORE=1`; the token comes from Secret Manager, not from an env value |
| **Firestore** → `adk-session/dayflow/users/{uid}/sessions/{sid}` | the ADK session: every event of the run, plus `state` holding the action budget and the granted approvals |
| **Firestore** → `users/{uid}/config/current` | the user's overlay on the YAML pack (what the Config view writes with `PUT /config`) |
| **Firestore** → `users/{uid}/vault/{id}` | the vault index: `path`, `sha256`, `size`, `drive_file_id`, `title`, `summary`, `deadlines` |
| **Cloud Storage** → `gs://<project>-dayflow-vault` | the vault bytes and the generated pages |
| **Vertex AI** → *Model garden / quotas* | the Gemini calls; roles are pinned in `backend/dayflow/models/models.yaml` |
| **Secret Manager** → `dayflow-token` | the brain's bearer token |

```bash
make deploy-smoke PROJECT=<your-project>
# prints the URL, /health (bucket + Gemini backend), then GET /vault and GET /config with the token
```

The replica portal deploys the same way if you want a hosted one:
`make replica-deploy PROJECT=<your-project>` prints the exact `gcloud run deploy` line (it never runs it).

## The claims, and where each one is proved

| Claim | Evidence |
|---|---|
| Gemini drives a real browser, not a script | `harness/out/*.json → steps[]`: reasoning sentence, then the tool call it chose; `refusedActions` shows the guard is live |
| It solves the lab instead of describing it | `toolCalls.solve_lab_task: 5` in `harness/out/lab.json`; `harness/specs/lab.mjs` re-executes the pushed notebook with nbclient and fails if any cell errors |
| Files really land in the user's Drive | `harness/out/drive/<scene>/` is a real folder tree written by a Drive v3 subset; `harness/fake-drive.test.mjs` proves POST/PATCH multipart semantics match Drive's |
| Nothing outward-facing happens without consent | `harness/out/team-ops.json → confirms[]`; the brain binds the approval to the exact text |
| The university logic is configuration, not code | `backend/dayflow/core/packs/kbtu-student.yaml` — delete it and the agent still runs, with no skills |
| It is a Google-stack agent | Google ADK 2.7 (`LlmAgent`, `LongRunningFunctionTool`, `AgentTool` + `BuiltInCodeExecutor`, `McpToolset`, `FirestoreSessionService`), Vertex AI, Cloud Run, Firestore, Cloud Storage, Secret Manager, Pub/Sub + Cloud Scheduler handlers |
| The portal in the repo is a replica, not the university's | `harness/fake-wsp/` is 400 lines of HTML/JS plus PDFs generated by `harness/fake-wsp/gen.py`; the video shows the real one |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| the replica shows the login form again after signing in | the server restarted (sessions are in memory) — sign in again, `demo` / `demo` |
| `EADDRINUSE` from `make replica` | port 8099 is the harness's too: `make replica REPLICA_PORT=9000` and use that URL in the prompt and in `allowed_hosts` |
| the agent says a host is not allowed | `127.0.0.1` is missing from `permissions.allowed_hosts` in the Config view (step 3) |
| the panel says *No brain configured* | Settings → Brain: URL **and** token, then *Check* |
| `/health` says `"gemini": {"backend": "unconfigured"}` | your local brain has no `GOOGLE_CLOUD_PROJECT` / ADC — `gcloud auth application-default login`, then export the project |
| `make e2e` fails before the browser opens | the preflight names the missing item (Playwright Chromium, the built extension, ADC) — `make e2e-setup` fixes all three |
| the lab scene fails in `nbcheck` | the first run builds a venv with nbclient/numpy — it needs network once |
| a scene JSON looks out of date | compare its `specSha256` with the current spec; re-run the scene |
