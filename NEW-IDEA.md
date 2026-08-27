# NEW-IDEA — the repositioning we ship (2026-08-27)

Deadline: **2026-08-31 17:00 PDT**. Track: Taskmaster. Prize: $180k.
Sources: Fable product review (2026-08-27), mock Google-judge review (7.35/10 weighted), competitive check on
Gemini-in-Chrome auto browse.

**The uncomfortable summary: the codebase is already a winner; the story is a 7.35.** Every point between here and
8.5 comes from framing, proof, and one original idea — almost none from new agent capability. Spend the four days
accordingly.

---

## 1. The product, in one sentence

> **A cron job for the web that has no API.**
> Dayflow runs scheduled agents against the legacy, logged-in, non-English portals that will never ship an API or an
> MCP server — and every Monday it delivers files, briefs, deadlines and scaffolded workspaces to the right places,
> with a receipt for every action.

Why this and not the alternatives:
- *"The first consumer MCP client"* — an infrastructure story with no chore at its center. The brief is chore-first.
  It also invites judging on protocol/ecosystem, where we are weakest (no registry, four days). Keep it as **one
  slide inside** this story ("skills are data; MCPs are destinations"). Do not lead with it.
- *"Your university's operations department"* — shrinks to a vertical, re-triggers the homework flinch, and
  pattern-matches to a hundred student-copilot submissions.

"Cron" is doing real work in that sentence: no chatbot framing survives next to it.

**Kill on sight:** `docs/DEVPOST.md:12` currently opens with *"Claude Code for the browser, on Gemini."* That is the
exact pattern-match we are escaping, written by us, at the top of the first thing a judge reads.

## 2. The chore (singular — the whole submission is built on this one)

> "Every Sunday night my agent logs into our 20-year-old Cyrillic portal, works out what changed across my six
> courses, and by Monday morning my files are in Drive, deadlines are on my calendar, my team is briefed in Telegram,
> and my workspace is scaffolded. I haven't opened the portal by hand in three days."

The property no consumer-web chore has, and we say it out loud: **the distribution unit is the cohort.** Four thousand
students at one university have byte-for-byte the same chore against the same portal. "Book me a restaurant" scales
one user at a time; "sync WSP" scales one *institution* at a time. That is the N=1 rebuttal built into the chore.

## 3. The pivot, from → to

| From (today) | To (ship) |
|---|---|
| Chat-first side panel | **Schedule + run-ledger dashboard is the face.** Chat demoted to a debug console. |
| Six demo scenes | **One chore, done completely**, with receipts |
| "Agent solves my lab" | **Agent does everything about the work except the work** |
| Human types a prompt | **A trigger fires; nobody is at the machine** |
| Claims of time saved | **A ledger with runs, artifacts, cost, failures** |
| "Claude Code for the browser" | **A cron job for the web that has no API** |

## 4. The integrity boundary — as architecture, not a disclaimer

The academic-integrity flinch ("Google will not blog *AI does student homework*") is a silent disqualifier. We do not
answer it with words. We answer it with the permission system that already exists.

- The `kbtu-student` pack carries a policy block: **fetch, diff, organize, schedule, brief, scaffold** are auto-allowed.
  Anything producing graded intellectual content is out of the tool allow-list or behind `ask_before` — the same
  `request_confirmation` gate that stops a dangerous click stops ghost-writing.
- The notebook generator emits **scaffolds with TODOs and failing tests**, never solutions.
- `BuiltInCodeExecutor` is reframed from "lab solver" to **self-check runner**: it runs *the student's own* code
  against the assignment spec and reports what fails. A grader, not a ghostwriter.

The line for the judge:

> "We didn't bolt on an honor-code disclaimer. The permission architecture that stops the agent clicking *delete* is
> the same one that stops it doing my homework. **Integrity is config.**"

## 5. The original idea: the "Did & Didn't" receipt

**The headline feature, and nobody else will have it.**

Every artifact the agent touches gets a receipt derived from the run ledger, stating what the agent **did** (fetched,
diffed, organized, scheduled, scaffolded, ran self-checks) *and what it verifiably **did not** do* (write solution
code, author graded content) — a hash-chained excerpt of the action log a student can hand a professor.

In 2026 every university on Earth is drafting AI-use policy with no enforcement mechanism except vibes. This is the
first **machine-generated AI-use disclosure**. It inverts our worst liability into the most memorable thing in the
submission: *the first AI tool that can prove it didn't cheat.* It generalizes far past students — compliance, audit,
workplace AI policy.

Cost: ~6 hours on top of the ledger (§8.1), which we are building anyway.

## 6. The evidence engine: the race

The hook is a bet, and the bet is an experiment with a control group.

> **The bet.** My friend and I race through this week's lab assignments across six courses. He may use any coding agent
> he wants — Claude Code, Codex, Antigravity. I may use none of them; my only tool is this extension. First one to have
> every assignment found, set up, scheduled, and their own solution passing the self-checks wins. Stakes: 1,000
> Zimbabwe dollars.

**Why this is the strongest framing available to us.** He has the best coding agents on Earth. He will still spend the
first forty minutes logging into a Cyrillic Vaadin portal, navigating School → Instructor → Course, hover-hunting
invisible download buttons, unzipping a folder of markdown and working out which of fourteen files is Assignment 4.
**No coding agent helps with any of that.** It is 80% of the wall clock and 0% of what those tools do.

The punchline writes itself, and it is the whole product thesis in six words:

> **"He had better AI. I had the boring 80%."**

It also answers *"why not just use Antigravity?"* — a question Google judges will absolutely ask — **empirically, on
camera, before anyone asks it.** And the friend is simultaneously a witness and a control group, which makes this an
experiment rather than a demo.

### The finish line is logistics, not solutions

**Both of us write our own code.** The race is over everything around the work: found, fetched, parsed, understood,
scaffolded into a runnable notebook, deadlines on the calendar, self-checks green. That keeps §4 intact — nothing on
camera contradicts the integrity boundary — and it makes the race *more* legible, not less: "fourteen assignments
found and set up in six minutes while he was still hunting for the third one" is far more specific and more visual
than two people finishing homework.

### Honesty rules (each one is a failure mode if broken)

- **"No coding agent" is not "no AI."** Gemini is in the loop and visible in the video. Say so in the same breath as
  the bet, or the first sharp viewer thinks we cheated.
- **Do not rig it.** Run the race early enough (28th–29th) that the result is known before the cut. If he wins, that
  is still usable content — but only if we know in time to build the video around it.
- **The opponent must be genuinely competent.** A straw man is obvious on camera and poisons everything else.
- **Instrument both sides.** The number that matters is *time to first line of code written*. Log it for both. That
  single split is the entire argument.
- **The failures go in.** Day 1 it burned three checks on a course with no files. Packet Tracer labs it cannot do —
  filed as tasks. Told it once; next run it went straight there. `remember()` demonstrated as a story, not a feature.
- **Teams stays out of the claim.** Its Files and Assignments views are cross-origin iframes `read_page` cannot
  enumerate. It belongs in the failures column, never in the abstinence list.

### The escalation, and the closing shot

The bet is won with **one prompt**. The reveal at 3:40 is that by mid-week there is **no prompt at all** — it runs on a
schedule. *"I won the bet on Monday. By Wednesday I'd stopped typing anything."* A stunt becomes a product.

Then: **film the friend paying up**, scrolling the ledger, checking it, sending the money. External verification of
the claim, on camera, as comedy — the N=1 problem answered in a way no other submission will attempt. Recruit him as
user #2 in the same sitting; he has just read the entire log.

### The log keeps running

The race is the hook and the proof of the thesis. The multi-day ledger that follows is the proof it was not a one-off:
three days in which the portal, Drive and the team's tools were never opened by hand. Constraint worded exactly that
way — "no web search, no social media" is a stunt that dies the moment one Google search appears in one frame.

Closing line is behaviour change, not a number:

> "By day three I stopped checking the portal. That's the part I didn't expect."

## 7. The 4-minute spine

Rule for the first 15 seconds: **no browser, no chat window, no cursor.** A browser-agent demo opens on a browser; we
open on the absence of one.

| Time | Beat |
|---|---|
| 0:00–0:15 | **The bet, on black.** "My friend gets Claude Code, Codex and Antigravity. I get one browser extension. First to have every lab found, set up and self-checked wins." No browser, no chat window, no cursor. |
| 0:15–0:40 | **The mess — why he loses.** Handheld: Cyrillic Vaadin portal, School → Instructor → Course, download buttons that exist only on hover, an assignment buried in a zip of markdown. "Six courses. Every week. Four thousand students at my university alone. There is no API. There never will be." |
| 0:40–1:15 | **The run.** Agent's own tab group in its own window, 8–10× timelapse of the real 352 s run, live action ledger scrolling beside it. Caption: *"Triggered by schedule, not by a prompt. Nobody is touching this machine."* One `ask_before` gate fires and is approved on camera. |
| 1:15–1:50 | **The dispatch.** Files → Drive. Diff brief → "what changed this week". Deadlines → Calendar. Team post → Telegram. Workspace → GitHub with a TODO notebook. On screen, the brief's own words: *"sends the right info to the right places."* |
| 1:50–2:30 | **Architecture (40 s).** Brain/hands split, ADK on Cloud Run with the console visible, Firestore, Pub/Sub, DOM-snapshot-first perception, mid-stream 429 model fallback, cost instrumentation, and the integrity boundary shown **as YAML config**. One line on the context-caching experiment we measured and shipped disabled. |
| 2:30–3:10 | **Skills are data; N > 1.** Show the YAML pack. A classmate installs it; it runs on *their* account, *their* courses — their ledger, real footage. "One person teaches the agent a portal; the cohort inherits it." |
| 3:10–3:40 | **Reproducibility.** Public replica portal + one-command harness: "You can run this yourself; link in the README." |
| 3:40–4:00 | **Receipts.** Cumulative ledger, then: *"A cron job for the web that has no API. Gemini-in-Chrome does the head of the web; this is for everything else."* |

## 8. Build list — 4 days, nothing else

**8.1 Run ledger as a first-class dashboard + Did & Didn't receipts — ~14 h.** Every run: actions, artifacts, diffs,
cost, duration, failures; every artifact links back to the actions that produced it; a counter accumulates hours
avoided. Per-tool logging and `/usage/{session_id}` already exist — this is rendering, and `PageStore` already serves
pages. **Build first: the challenge has no evidence without it, and it is the face of the product.** Moves the 40%.

**8.2 Two classmates running the pack on their own accounts, on camera, with their ledgers — ~10–12 h** (onboarding
polish, supervision, filming). Attacks the single biggest gap in the only currency judges accept: footage of someone
who isn't us. Needs pack install to be five minutes, not an afternoon. **If we add only one thing, this is it.**

**8.3 Public replica portal + one-command judge harness — ~8–10 h.** The anonymized fake WSP already exists in the e2e
harness; this is deploy + docs + seeded credentials. Converts "Cyrillic portal behind personal credentials" from a
liability into a flex: *so hard we built you a replica.*

**Explicitly NOT building: headless Chrome on Cloud Run.** Highest-variance item on the board. The substitute is free:
schedule a real overnight run, timelapse the unattended machine, show the ledger stamped 03:14. One honest roadmap
sentence covers the rest ("the Pub/Sub worker path exists; headless hands are next"). Honesty about the seam scores
better than hiding it.

*Stretch, only if 8.1–8.3 land:* self-improving site profiles — the agent diffs its execution trace against the
SiteProfile and proposes a patch, and we film the curve (run 1: 352 s / $0.34 → run 3: ~200 s / $0.19). An agent that
gets measurably cheaper at a chore *by doing it* is a stronger autonomy claim than any single run. Even two data
points is filmable.

## 9. Cut list

- **Pitch deck / Canva as a scene.** Code stays in the repo; it leaves the video. (See §12 — open decision.)
- **Lab solver as a demoed capability.** Reframed per §4 or absent.
- **Linear MCP from the video.** Telegram + Calendar + GitHub already prove multi-destination dispatch. Stays in the
  README connector list.
- **Chat as the primary surface.** No chat box in the first three minutes. Period.
- **Vision mode from the demo.** DOM-first is the story; vision is a footnote on the site-profile slide.
- **The six-skill pack as narrative.** One chore, completely. Six shallow scenes read as six half-finished demos.
- **Courseware as its own scene.** Survives as a two-second flash inside the dispatch montage (it is our
  integrity-positive artifact).

## 10. The two answers we must have ready — say them before we're asked

**"Didn't Google ship this in January?"** Gemini-in-Chrome auto browse is interactive, consumer-web, US-only, Pro/Ultra
-gated, session-bound. Ours is scheduled, legacy/logged-in, global, with durable state. *"Extensions didn't compete with
Chrome."* Left unrebutted in a room of Google judges, this question is fatal — so we raise it ourselves, on a slide.

**"Who else uses it?"** §8.2, on camera. There is no other acceptable answer.

## 11. The moat, one paragraph

Google is structurally doing the opposite half of the problem. Gemini-in-Chrome targets the head of the web: consumer
sites, English, US, sessions Google can test, partner with and be liable for. The other 95% — the Vaadin portal from
2006, the Kazakh government form, the hospital intranet, every logged-in legacy system on Earth — cannot be reached by
a platform team, only by the people trapped inside those systems. Our moat is that the site knowledge lives in
**shareable data, not in the model**: "downloads are hover-hidden on WSP" is a line of YAML one student writes and four
thousand inherit, and the distribution unit is the institution, where everyone shares the same chore. Add the trust
layer institutions demand — permission gates, integrity boundaries, signed receipts — which a platform cannot ship
one-size-fits-all, and we are not competing with Gemini-in-Chrome; we are the layer it needs to reach the rest of the
web and the rest of the world.

## 12. Open decisions (need a call before Friday)

1. **Canva.** Fable argues cut entirely: weakest scene, Autofill is Enterprise-gated, purest breadth creep. Counter:
   it can survive as a **two-second destination inside the dispatch montage** (weekly team deck), not a scene. It was
   named as the thing we most wanted to show judges — so this is a call, not a default.
2. ~~**Lab solver.**~~ RESOLVED by §6: both racers write their own code; the notebook appears scaffolded with tasks
   and failing tests, and the executor is narrated as the **self-check runner**. Same code path, different claim.
3. **Which friend**, and is the race filmable on the 28th–29th? Needs their consent to record their screen.

## 13. Done-means

- `make verify` and `make e2e` green (unchanged gate).
- Ledger dashboard live, with ≥3 days of real runs and a Did & Didn't receipt on at least one artifact.
- ≥2 non-builder users with their own ledgers, on camera.
- Replica portal reachable + one README command a judge can run.
- ≤4-min video cut to §7, with no chat box before 3:00 and no frame contradicting §4.
- DEVPOST.md rewritten to §1; `CLAUDE.md` demo-scene list reduced to the one chore.
