# Judging Dayflow in 10 minutes

Every claim in the README has a command that proves it. Pick the track that matches how much time and
how many accounts you have. Nothing here needs a university login, a GitHub token or a Google account.

| Track | Time | Needs | Proves |
|---|---|---|---|
| **A — read the evidence** | 2 min | nothing | all six scenes ran end to end, with the transcript and the artifacts |
| **B — run the tests** | 3 min | Node 22.18+, pnpm 10, [uv](https://docs.astral.sh/uv/) | the code is real, typed and tested |
| **C — run the agent** | 5 min | + a GCP project with Vertex AI enabled + `gcloud` ADC | Gemini really drives a browser: one scene, live, in front of you |
| **D — click it yourself** | 5 min | + Chrome | the product, not the harness |

---

## Track A — read the evidence (2 min)

`make e2e` writes one JSON per scene. They are committed, so you can read the verdicts without running
anything:

```bash
node -e "for (const s of ['vault-sync','lab','team-ops','courseware','scaffold','pitch-deck']) {
  const j = require('./harness/out/'+s+'.json');
  console.log(s.padEnd(12), j.pass ? 'PASS' : 'FAIL', String(j.actions).padStart(3)+' actions',
              Math.round(j.durationMs/1000)+'s', j.failures.join('; '));
}"
```

Then open one file — `harness/out/lab.json` is the richest:

| Field | What it proves |
|---|---|
| `prompt` | the plain-English request the agent was given — nothing scripted after that |
| `steps[]` | the whole transcript: one reasoning sentence, then a tool row (name, args, ms, ok/error), then artifacts |
| `actions`, `refusedActions` | browser actions used against the hard cap of 40, and every call the brain's guard refused |
| `toolCalls` | call count per tool, e.g. `solve_lab_task: 5` — Gemini ran code five times |
| `drive.entries` | the folder tree the agent actually created in (fake) Google Drive |
| `vault` | `GET /vault` from the brain — the parsed, indexed copy with titles, summaries and deadlines |
| `connectorCalls` | the GitHub/Linear calls, in order (`create_repository`, `push_files`, `create_pull_request`, …) |
| `confirms` | every Allow/Deny card, its exact text and the answer |
| `spec`, `specSha256`, `runnerSha256` | which judge produced the verdict — a stale JSON from an older spec is detectable |

Each spec (`harness/specs/<scene>.mjs`) states in its first comment what "green" means; the checks are
adversarial on purpose (the notebook is executed, the `.pptx` is unzipped and counted, the Drive copy is
compared byte-for-byte with the page the brain served).

## Track B — run the tests (3 min)

```bash
git clone <repo> && cd <repo>
make verify
```

`ruff check` + `pyright` + `pytest` for the brain, `tsc --noEmit` + `vitest` for the extension, and
`node --test` for the fake Drive's own self-test. No credentials, no network calls to Google — every test
runs against in-process fakes. The same command is the CI job (`.github/workflows/ci.yml`).

## Track C — run the agent live (5 min)

This is the honest one: the browser, the portal, the downloads and Drive are fakes; **Gemini is real**.

```bash
gcloud auth application-default login
export GOOGLE_CLOUD_PROJECT=<your project>      # Vertex AI enabled, billing on
make e2e-setup                                  # pnpm install + Playwright Chromium + uv sync   (~2 min, once)
make e2e SCENE=vault-sync                       # ~3 min; add SCENE=lab | team-ops | courseware | scaffold | pitch-deck
```

A Chromium window opens with the extension loaded, the side panel types the prompt itself, and you watch
the agent walk the portal. Exit code 0 = the spec passed. `make e2e` with no `SCENE` runs all six.

What you are watching, per scene:

| Scene | Prompt the panel types | Green means |
|---|---|---|
| vault-sync | *Sync the CSCI3240 … course files from WSP into my vault and tell me what changed.* | 3 PDFs under `Dayflow/CSCI3240*/{Materials,Week 01,Lab 01}` in fake Drive, 3 indexed vault entries, ≤40 actions |
| lab | *Solve Lab 1 … create a private GitHub repo, solve every task with code you actually run, push …* | `create_repository` + `push_files` with an `.ipynb` whose code cells carry outputs; the notebook is re-executed with nbclient and must run clean; `REPORT.md` + a report page returning 200 |
| team-ops | *Summarise this week … post the update to the "Diploma · Team" chat (ask me before sending) …* | an Allow card whose text **is** the message that then appears in the chat DOM; ≥1 Linear issue; exactly 1 pull request |
| courseware | *Build a cheatsheet and a quiz from the syllabus …* | the brain's `/pages/courseware/<id>` serves a cheatsheet + 10 quiz questions with folded answers; the same bytes are in the vault |
| scaffold | *Create the vault folder tree … one folder per week and per lab* | ≥15 folders, one per week of the syllabus' 15-week schedule plus the labs, and no doubled `Dayflow/` nesting |
| pitch-deck | *Build a pitch deck about my diploma project repo …* | a real OpenXML `.pptx`, 16:9, ≥6 slides, byte-identical in the vault, with a preview page that lists the same headings |

Artifacts land in `harness/out/<scene>/` (panel and tab screenshots under `shots/`), the brain's log in
`harness/out/brain-<scene>.log`, the Drive tree in `harness/out/drive/<scene>/`.

**What to look for in the brain log** — the loop is visible as a ping-pong, one HTTP exchange per action:

```
INFO:  127.0.0.1 - "POST /chat HTTP/1.1" 200 OK
INFO:  127.0.0.1 - "POST /tool_result HTTP/1.1" 200 OK     ← open_tab result came back
INFO:  127.0.0.1 - "POST /tool_result HTTP/1.1" 200 OK     ← read_page …
INFO:  127.0.0.1 - "POST /vault/upload HTTP/1.1" 200 OK    ← a downloaded PDF, parsed + indexed
INFO:  127.0.0.1 - "POST /tool_result HTTP/1.1" 200 OK
INFO:  127.0.0.1 - "GET /vault HTTP/1.1" 200 OK            ← the harness reads the index back
```

(verbatim from `harness/out/brain-vault-sync.log`). Each exchange is short and stateless — that is why the
same code scales to zero on Cloud Run between two clicks in a browser.

If it fails, read `harness/out/<scene>.json → failures[]`; it is written in words
(e.g. `"41 browser actions, cap is 40"`, `"create_issue calls: 0, expected ≥1"`).

## Track D — click it yourself (5 min)

```bash
cd backend && uv sync && gcloud auth application-default login
cd .. && GOOGLE_CLOUD_PROJECT=<your project> GOOGLE_GENAI_USE_ENTERPRISE=1 DAYFLOW_TOKEN=dev make dev-brain
cd extension && pnpm install && pnpm build
```

`chrome://extensions` → Developer mode → **Load unpacked** → `extension/.output/chrome-mv3` → click the
toolbar icon. In **Settings**: backend `http://localhost:8080`, token `dev`, press *Check* (it pings
`/health` and `/config`). Leave Vault on **Brain only** — no Google account needed. Then:

- Type `/` in the composer → the skill palette lists the six skills that came from the brain's pack.
- Open the **Config** view: the whole agent — skills, site profiles, permissions, schedules, memory — is
  editable YAML validated against the brain's schema. That is the point of the project: the university
  logic is configuration, not code.
- Add `127.0.0.1` to `permissions.allowed_hosts`, run `make e2e-up SCENE=dev` in another terminal (fake
  portal on :8099) and give it the vault-sync prompt against `http://127.0.0.1:8099` — same loop, your hands.
- Try to make it misbehave: ask it to open a host that is not on the allow-list, or to send a message with
  different text than the one it showed you on the Allow card. Both are refused, by the brain and again by
  the extension.

## Google Cloud, if you have the console open

Deployed with `make deploy-brain PROJECT=<your-project>` (one command; it creates the bucket, deploys,
back-fills `DAYFLOW_PUBLIC_URL`/`OIDC_AUDIENCE` and smoke-tests itself):

| Console page | What is there |
|---|---|
| **Cloud Run** → `dayflow-brain` → *Logs* | the same `/chat` → `/tool_result` ping-pong as above, one line per browser action; min-instances 0, so the service is idle between runs |
| **Cloud Run** → *Revisions* → env | `GOOGLE_GENAI_USE_ENTERPRISE=1`, `GOOGLE_CLOUD_PROJECT`, `DAYFLOW_BUCKET`, `DAYFLOW_FIRESTORE=1`; the token comes from Secret Manager, not from an env value |
| **Firestore** → `adk-session/dayflow/users/{uid}/sessions/{sid}` | the ADK session: every event of the run, plus `state` holding the action budget and the granted approvals |
| **Firestore** → `users/{uid}/config/current` | the user's overlay on the YAML pack (what the Config view writes with `PUT /config`) |
| **Firestore** → `users/{uid}/vault/{id}` | the vault index: `path`, `sha256`, `size`, `drive_file_id`, `title`, `summary`, `deadlines` |
| **Cloud Storage** → `gs://<project>-dayflow-vault` | the vault bytes and the generated pages |
| **Vertex AI** → *Model garden / quotas* | the Gemini calls; roles are pinned in `backend/dayflow/models/models.yaml` |
| **Secret Manager** → `dayflow-token` | the brain's bearer token |

Fastest check that a deployment is real and current:

```bash
make deploy-smoke PROJECT=<your-project>
# prints the URL, /health (bucket + Gemini backend + local_exec), then GET /vault and GET /config with the token
```

## The claims, and where each one is proved

| Claim | Evidence |
|---|---|
| Gemini drives a real browser, not a script | `harness/out/*.json → steps[]`: reasoning sentence, then the tool call it chose; `refusedActions` shows the guard is live |
| It solves the lab instead of describing it | `toolCalls.solve_lab_task: 5` in `harness/out/lab.json`; `harness/specs/lab.mjs` re-executes the pushed notebook with nbclient and fails if any cell errors |
| Files really land in the user's Drive | `harness/out/drive/<scene>/` is a real folder tree written by a Drive v3 subset; `harness/fake-drive.test.mjs` proves POST/PATCH multipart semantics match Drive's |
| Nothing outward-facing happens without consent | `harness/out/team-ops.json → confirms[]`; the brain binds the approval to the exact text (`guard_tool` / `find_approval` in `backend/dayflow/agents/orchestrator.py`) |
| The university logic is configuration, not code | `backend/dayflow/core/packs/kbtu-student.yaml` — delete it and the agent still runs, with no skills |
| It is a Google-stack agent | Google ADK 2.7 (`LlmAgent`, `LongRunningFunctionTool`, `AgentTool` + `BuiltInCodeExecutor`, `McpToolset`, `FirestoreSessionService`), Vertex AI, Cloud Run, Firestore, Cloud Storage, Secret Manager, Pub/Sub + Cloud Scheduler handlers |

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/health` says `"gemini": {"backend": "unconfigured"}` | no `GOOGLE_CLOUD_PROJECT` / ADC — run `gcloud auth application-default login` and export the project |
| `make e2e` fails before the browser opens | the preflight names the missing item (Playwright Chromium, the built extension, ADC) — `make e2e-setup` fixes all three |
| the lab scene fails in `nbcheck` | first run builds a venv with nbclient/numpy — it needs network once |
| ports are busy | `E2E_PORT_BASE=9200 make e2e SCENE=lab` (fake portal on BASE, brain BASE+1, fake Drive BASE+2) |
| the panel says *No brain configured* | Settings → Brain: URL **and** token, then *Check* |
| a scene JSON looks out of date | compare its `specSha256` with the current spec; re-run the scene |
