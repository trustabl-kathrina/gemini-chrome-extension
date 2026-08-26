# Devpost submission — Dayflow

All Things Agentic Hackathon (Google) · Track: **The Taskmaster** · Submission deadline 2026-08-31 17:00 PDT.

Paste the sections below into the Devpost form. Everything here is checked against the repo — if a claim below stops
being true, change the claim, not the reader's impression.

---

## Elevator pitch (200 characters max)

> Claude Code for the browser, on Gemini: a Chrome side-panel agent with a Google ADK brain on Cloud Run that does your
> university week — files, labs, team ops — in the tabs you're already signed into.

## Inspiration

I am a KBTU student, and every week the same twenty minutes evaporate the same way. New lecture files appear on the
student portal with no notification, so I go hunting for them; the portal is a Vaadin app where folders are table rows
with no links, so even a bookmark doesn't help. A lab is due, so I copy tasks into a notebook by hand. The diploma team
chat needs an update, Linear needs the issues, GitHub needs the pull request. None of it is difficult. All of it is
browser work, and all of it lands on me.

Coding agents already solved the shape of this problem for the terminal: a generic loop plus configuration you own —
skills, project instructions, permissions, MCP connections. Nothing like that existed for the browser I actually live
in, where my sessions already are. So I built it, and made a university student the first user because that user is me.

## What it does

Dayflow is a Chrome side panel with a Gemini brain. You type a request (or press `/` and pick a skill); the agent plans
out loud — one sentence of reasoning before **every** action — and then works in the tab you are signed into.

Six skills ship in the default pack, and all six are end-to-end tested:

1. **Vault sync** — walks the university portal (School → instructor → course folder), downloads every course file into
   the Google Drive vault `Dayflow/<course>/<Materials|Week NN|Lab NN>/`, parses each PDF on the brain (summary,
   deadlines) and indexes it in Firestore, then reports a changelog. Also runs on a schedule.
2. **Lab** — reads the lab PDF from the vault and solves every task with code it *actually runs* in Gemini's code
   execution sandbox, assembles a notebook with the real outputs, writes a report, creates a private GitHub repo and
   pushes README / TODO / notebook / report.
3. **Team ops** — summarises the week from the repo, opens the messenger, finds the team chat, shows you the exact text
   for approval, sends it, then files Linear issues and opens a GitHub issue and one pull request.
4. **Courseware** — a cheatsheet plus a ten-question quiz generated from the syllabus, served as a page and saved to
   the vault.
5. **Scaffold** — the semester's folder tree (15 weeks + labs) created in Drive from the syllabus schedule.
6. **Pitch deck** — a real 16:9 `.pptx` about a repo, with an HTML preview, saved to the vault.

The part I care most about is what surrounds those skills:

- **Configuration you own.** Skills, site profiles (per-domain notes plus a perception mode: DOM element list or
  vision-first), permissions (navigation allow-list, ask-before gates), connections and schedules are one YAML you edit
  in the panel and save to the brain. Nothing in the code knows what a specific university portal is.
- **Bound approvals.** Anything outward-facing — a chat message, an issue, a PR, `run_js` — needs an Allow card whose
  text covers exactly the content the call will send, and one approval buys exactly one call. If the model rewords the
  message after you approved it, the call is refused.
- **A hard budget.** Forty browser actions per run, enforced in the brain, so a confused agent stops instead of
  wandering through your tabs.

## How we built it

- **Brain:** Python 3.12 + **Google ADK 2.7** on **Cloud Run** (FastAPI, scale-to-zero). The orchestrator is an
  `LlmAgent` whose instruction is composed per run from the user's config; browser tools are ADK
  `LongRunningFunctionTool`s, so the turn ends, the extension executes the tool in the tab, and `POST /tool_result`
  resumes the same session — every HTTP exchange is short and instance-agnostic.
- **Models (Vertex AI):** `gemini-3.7-flash` as the orchestrator, `gemini-3.7-flash` with ADK's `BuiltInCodeExecutor`
  as the lab solver sub-agent (wrapped as an `AgentTool`), `gemini-3.5-flash-lite` as the document parser,
  `gemini-embedding-2` for the vault index. Roles → model ids live in one `models.yaml`, never in code.
- **State:** **Firestore** — ADK sessions, the user config, the vault index (`users/{uid}/vault/{id}`: path,
  drive_file_id, summary, deadlines, sha256). **Cloud Storage** for vault bytes and generated pages.
  **Secret Manager** for the brain token. **Pub/Sub** push and **Cloud Scheduler** handlers (`/pubsub`, `/cron`) verify
  Google OIDC tokens for background runs — the handlers ship and are tested, but no deploy target creates a worker
  subscription or a scheduler job yet; today's scheduled runs fire from `chrome.alarms` in the extension.
- **Hands:** a Chrome MV3 extension (WXT 0.21, React 19, TypeScript) — side panel, background service worker (run loop,
  alarms, permission guard, Drive client with `chrome.identity` and scope `drive.file`), content script that returns a
  labelled element list with stable refs and coordinates. Every tool result carries a JPEG of the tab when Vision is on,
  forwarded to Gemini as multimodal function-response parts.
- **Connections:** GitHub and Linear via ADK's `McpToolset`, or in-process fakes for CI.
- **The judge:** a Playwright harness with a synthetic Vaadin-like portal (generated PDFs, click-only navigation), a
  fake Google Drive v3 that writes a real folder tree, and fake connectors that log every call. `make e2e SCENE=<scene>`
  drives the *real* extension in a real Chromium and grades the run against a per-scene spec. Only Gemini is real.

## Challenges we ran into

- **A portal with no links.** The target portal is Vaadin: folders are table rows, `href`s don't exist, keyboard Enter
  does nothing, and the toolbar re-renders after every click. The fix was not code — it was making perception and
  site knowledge configuration: the site profile teaches the model "click the row, then click Enter", and the extension
  re-finds refs after a re-render.
- **Long-running tools across a stateless service.** ADK's long-running tool mechanism ends the turn; resuming the same
  session from a different Cloud Run instance meant treating every browser action as an independent HTTP exchange.
- **Approvals that actually bind.** An early version asked for confirmation and then sent slightly different text
  (the model re-wrapped a sentence). Approvals are now matched against the exact argument strings of the gated call.
- **A notebook that really runs.** "Solved the lab" is only true if the notebook executes: the harness re-runs the
  pushed `.ipynb` with `nbclient` and fails the scene if any cell errors.
- **Action budgets.** A real portal run came in at exactly 40 of 40 allowed actions. Making the skills spend actions
  deliberately — one `read_page` per level, one download call per file — was most of the tuning work.
- **Nondeterminism.** You cannot iterate on an agent by watching it. The harness came first; every fix was judged by
  `harness/out/<scene>.json`, not by a demo that felt right.

## Accomplishments that we're proud of

- Six skills, six passing end-to-end scenes, driven through the actual extension in a real browser — not mocks.
- The lab scene produces a notebook whose cells contain outputs from code that a sandbox really executed, and the test
  suite re-executes it to prove it.
- A permission model with teeth: allow-list checks in both the brain and the extension, tab-level guards on every
  action (not just the URL the model passed), masked password/OTP fields, and approvals bound to exact content.
- Scene 1 verified against the real university portal from a signed-in profile — with the honest result recorded
  (40 of 40 actions).
- Everything a judge needs runs locally in ten minutes with no accounts: synthetic portal, fake Drive, fake connectors.

## What we learned

- Agent quality is mostly **configuration** quality. The same loop went from "clicks randomly" to "walks a folder tree"
  by writing better site notes and better skill playbooks — not by changing the model or the code.
- **A screenshot after every action** changes how the model behaves: with the tab's JPEG attached to each tool result
  it checks whether the click did what it expected instead of assuming, which is what makes a re-rendering page
  survivable.
- Long-running tools + a stateless brain is a genuinely good fit for browser agents: the browser holds the session, the
  cloud holds the reasoning, and the bill is per request.
- Building the harness before the features felt slow for a day and then paid for itself three times over.

## What's next for Dayflow

- Chrome Web Store release (unlisted first — `<all_urls>` + `scripting` + `identity` mean manual review), with the
  unpacked zip in GitHub Releases as the judge path.
- Google ID-token auth on the brain replacing the shared token, and OAuth "Connect" flows for GitHub and Linear.
- A sandboxed executor (Cloud Run Job, no service account, egress blocked) for verifying model-written code in prod.
- The rest of the student pack: attendance tracking with the 70 % rule, GPA projection, the Teams digest, and an
  opportunity scanner — all as skills in the same YAML, no new code.

## Built with

`python` `google-adk` `gemini` `vertex-ai` `google-cloud-run` `firestore` `cloud-storage` `pub-sub` `secret-manager`
`chrome-extension` `manifest-v3` `typescript` `react` `wxt` `tailwind` `fastapi` `playwright` `mcp` `google-drive-api`
`github-api` `linear-api` `nbformat` `python-pptx`

## Try it (for judges)

```bash
git clone <repo> && cd genaihack
make e2e-setup                       # pnpm install + Playwright Chromium + backend venv
gcloud auth application-default login # only Gemini is real; everything else is synthetic
make e2e SCENE=vault-sync            # then: lab | team-ops | courseware | scaffold | pitch-deck
```

Results land in `harness/out/<scene>.json` (`pass`, `failures[]`, the full transcript, the fake-Drive tree, the
connector log). `docs/JUDGES.md` is the ten-minute path; `README.md` covers deploying your own brain.

---

## Bonus items checklist

- [ ] **Social post with `#AllThingsAgenticHackathon`** — post from the author's X/LinkedIn, link the Devpost entry and
      the demo video, and paste the post URL into the submission form. Draft:

  > I built Dayflow: Claude Code for the browser, on Gemini. A Chrome side panel + a Google ADK brain on Cloud Run that
  > syncs my course files into Drive, solves a lab into a notebook that actually runs, and posts my team update — in the
  > tabs I'm already signed into, asking before anything leaves my machine. Six skills, six end-to-end tests.
  > #AllThingsAgenticHackathon @GoogleAI

  Attach: the 30-second cut of scene 1 (portal → Drive) and one screenshot of the Allow card.

- [ ] **Blog post** (Medium/dev.to, linked in the submission) — outline:
  1. *The twenty minutes* — the weekly chore, and why an API integration doesn't solve it (the session is in the browser).
  2. *Why a browser agent is a coding agent* — generic loop + user-owned config (skills, site profiles, permissions,
     connections, schedules); the mapping table from the README.
  3. *The loop in ADK* — `LongRunningFunctionTool` + a stateless Cloud Run brain; the `/chat` → tool call → `/tool_result`
     sequence; why each exchange is short.
  4. *Perception per site* — DOM element list with refs vs vision-first; what a Vaadin portal with no links taught us.
  5. *Making approvals binding* — the reworded-message bug and how approvals became content-bound, one call per approval.
  6. *Proving it works* — the harness: synthetic portal, fake Drive, fake connectors, and re-executing the pushed
     notebook with `nbclient`.
  7. *Costs and honesty* — scale-to-zero economics, the 40-action budget, and what still isn't done.
  Include: the architecture diagram, one `harness/out/*.json` excerpt, and the notebook-with-outputs screenshot.

- [ ] **Gemma usage** — *currently not claimable, and the submission must not claim it.* `backend/dayflow/models/
      models.yaml` declares `classifier: gemma-4-26b-a4b-it`, but no code path calls the `classifier` role today
      (`grep -rn classifier backend/dayflow` hits only `models/registry.py`). To earn the bonus honestly, wire Gemma
      into a real decision before submitting — the natural one is vault triage in `dayflow/tools/server.py`: classify
      each uploaded file (syllabus / lecture / lab / admin) with the `classifier` model and let the class drive the
      vault folder (`Materials` vs `Week NN` vs `Lab NN`) instead of the current filename heuristic. That is one call
      site, it is on the scene-1 path, and it is visible in the demo. Until that lands, leave this box empty.

- [ ] **Cloud console visible in the video** — Cloud Run logs + Firestore data during scene 1 (see `docs/DEMO.md` §1.4).

## Private-repo access (if the repo stays private)

The submission form requires reviewers to be able to open the code. Add both accounts as collaborators **before**
submitting, and screenshot the invitations:

```bash
gh repo view --json visibility -q .visibility          # confirm what you are actually submitting
```

Then invite both reviewers with **read** access — GitHub takes an e-mail address only through the invitation UI for a
user repo (Settings → Collaborators → *Add people* → paste the address), or through the API for an organisation repo:

```bash
# organisation repo: invite by e-mail, then grant the repo
gh api -X POST orgs/<org>/invitations -f email=testing@devpost.com -f role=direct_member
gh api -X POST orgs/<org>/invitations -f email=cloudhackathons@google.com -f role=direct_member
# once they accept and you know their handles:
gh api -X PUT repos/<owner>/<repo>/collaborators/<handle> -f permission=pull
```

The two addresses to invite, exactly:

- `testing@devpost.com`
- `cloudhackathons@google.com`

If the repo is public instead, say so in the submission and skip this step. Either way, re-run the secrets audit before
pushing: `git ls-files | xargs grep -nE 'AIza|ghp_|lin_api_|BEGIN .*PRIVATE KEY'` must come back empty, and no real
course, instructor or student names may appear outside `harness/fake-wsp` (whose names are invented).

## Submission form checklist

- [ ] Video ≤ 4:00, public on YouTube, Cloud console visible, English narration or burned-in subtitles.
- [ ] Repo link (public, or private with both reviewer accounts added).
- [ ] Track selected: **The Taskmaster**.
- [ ] Google technologies listed: Google ADK, Gemini (Vertex AI), Cloud Run, Firestore, Cloud Storage, Pub/Sub,
      Cloud Scheduler, Secret Manager, Google Drive API, Chrome extensions platform.
- [ ] Testing instructions = the "Try it" block above (no accounts needed).
- [ ] Screenshots: the panel mid-run with a screenshot thumbnail, the Allow card, the Drive vault tree, the notebook
      with outputs, the Cloud Run logs.
- [ ] Bonus links pasted (social post, blog post) if those boxes were ticked.
