"""GET /pages/{kind}/{id}: HTML artifacts from the PageStore. No auth — ids are unguessable.

Also serves the privacy policy at GET /pages/privacy: the Chrome Web Store listing must link to a policy on a
live URL, and the brain is the only thing Dayflow deploys. `docs/PRIVACY.md` is the source of truth; PRIVACY_MD
below is the copy that ships with the backend, because `gcloud run deploy --source backend` uploads `backend/`
only and cannot see `docs/`. When the repo is checked out next to the package (local `uv run`), the file wins.

The bottom of this module renders the two pages built from the run ledger — the dashboard (GET /ledger) and
the per-artifact receipt (GET /receipt/…) — so that they share the look of every other generated page. Their
routes live in api/app.py, next to the run lifecycle that fills the ledger.
"""

from __future__ import annotations

import html
from collections.abc import Callable
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import HTMLResponse

from dayflow.core.ledger import ReceiptFacts, RunRecord, totals
from dayflow.core.pages import PageStore
from dayflow.tools.lab import markdown_to_html

router = APIRouter(prefix="/pages", tags=["pages"])

# Repo checkout: backend/dayflow/api/pages.py -> <repo>/docs/PRIVACY.md
PRIVACY_FILE = Path(__file__).resolve().parents[3] / "docs" / "PRIVACY.md"

PRIVACY_MD = """# Dayflow — Privacy

Last updated: 2026-08-27. Applies to the Chrome extension "Dayflow Agent" and the Dayflow brain (the backend you run).

Dayflow is a browser agent you self-host. There is no Dayflow company server: the extension only talks to the
backend URL you type into Settings (your own Cloud Run service, or `localhost`), and that backend only talks to
Google Gemini through your own Google Cloud project or API key. The author of Dayflow receives nothing.

## What the extension keeps on your computer

Stored with `chrome.storage.local`, and removed when you uninstall the extension:

- The backend URL and access token you entered.
- Your config: skills, site profiles, permissions and schedules (the YAML shown in the Config screen).
- If you sign in with Google: your email, display name and a short-lived Google OAuth access token for Drive.

Kept only in the side panel's memory while it is open — never written to `chrome.storage`, gone when you close or
reload the panel:

- The transcript of the runs in the current session: your prompts, the agent's one-line reasoning, tool calls and
  their arguments, and the JPEG screenshot attached to each step when **Vision** is on.

The current chat's id (not its content) is kept in `chrome.storage.session`, which survives closing the panel but
is cleared when the browser closes; it is what lets a follow-up prompt continue the same brain-side conversation.
The brain itself keeps the session history (see "What the backend stores" below) for as long as your own
Firestore retention allows.

## What leaves your browser

Only while a task you started (or a schedule you created) is running, and only to the backend you configured,
which forwards it to Gemini:

- Your prompt and the skill you picked.
- An element list of the page the agent is working on: roles, visible text and coordinates. Values of password,
  card-number and one-time-code fields are replaced with `•••` before the list leaves the page.
- A JPEG screenshot of that tab after each action — only when **Vision** is on in Settings. Turn Vision off and no
  screenshots are sent.
- Files the agent downloads for you (for example course PDFs), so the backend can parse and index them; and, if you
  connected Drive, the same files go to your Google Drive.
- Text you asked the agent to publish — a chat message, an issue, a pull-request description — goes to the site or
  service you named. That is the task itself.

Pages are captured only for the tab the agent is acting on, only during a run, and only for domains your own site
list allows. Dayflow does not watch your browsing in the background, has no analytics, telemetry, ads or tracking
code of any kind, and sends nothing to the author or to any third party that you did not name in the task.

## Google Drive

If you connect Drive, Dayflow asks for the `drive.file` scope only. That scope covers the files and folders the
extension itself creates (your `Dayflow/` vault) — not the rest of your Drive. Uploads happen only for files a task
produced or downloaded. Without Drive, files stay with your own backend.

## What the backend stores, on your infrastructure

- Firestore (your project): session state, your config, and one index entry per vault file — path, Drive file id, a
  short summary, extracted deadlines, SHA-256.
- Cloud Storage (your bucket) or process memory: the file bytes and the HTML/PPTX artifacts the agent generates.
- Cloud Run request logs, under your project's retention settings.
- Cloud Trace (your project), when the brain runs on Cloud Run or you set `DAYFLOW_TRACE=1`: one span per
  agent invocation, model call and tool call — names, timings and token counts. The CONTENT of those calls
  (prompts, page snapshots, tool arguments and results) is switched off; set `DAYFLOW_TRACE_CONTENT=1` if you
  want it in your own traces for debugging.

Gemini is called through Vertex AI or the Gemini API with your credentials, so those requests are handled by Google
under the terms of that product. No other model provider is used.

## Services you may connect

GitHub, Linear and Telegram are used only when you connect them or ask for them by name. The data goes to them
directly, under your account and their privacy policies. Dayflow adds no intermediary and keeps no copy beyond the
brain's own session history.

## Deleting your data

- Uninstall the extension — local settings and tokens go with it (run transcripts are already gone once the panel
  is closed; they are never written to disk on the extension side).
- Delete the Firestore collection and the Cloud Storage bucket in your project — the session history, the vault
  index and the generated artifacts go with them.
- Revoke Dayflow's access to your Google account at https://myaccount.google.com/permissions.

## Why each permission exists

- `storage` — keep your settings locally, and the current chat's id in session storage.
- `alarms` — run the schedules you created in Config.
- `sidePanel` — the panel is the whole UI.
- `tabs` — open and focus the tab a task needs, and read that tab's URL and title.
- `tabGroups` — group the tabs a run opens into one labelled, collapsible strip, separate from the rest of your
  tabs.
- `scripting` — read the page and click/type in it; this is how the agent acts instead of you.
- `downloads` — capture the file a page downloads so it can be saved to your vault.
- `notifications` — tell you when a scheduled run finished (or failed) while the panel was closed.
- `webNavigation` — know when the page finished loading before the next step.
- `activeTab` — act on the tab you are looking at when you ask for it.
- `identity` — Google sign-in for Drive, nothing else.
- `<all_urls>` — the sites you will point the agent at are not known in advance; in practice Dayflow acts only on
  the domains in your own allow-list: a step that tries to leave them is refused, in the panel and again in the brain.

## Contact

Questions or a deletion request: open an issue at https://github.com/OWNER/dayflow/issues (replace `OWNER` with the
repository owner once the repo is public) — the same address is the support site of the Chrome Web Store item.
"""


@router.get("/privacy", response_class=HTMLResponse)
async def privacy() -> HTMLResponse:
    """The privacy policy the Chrome Web Store listing links to (docs/PRIVACY.md, rendered)."""
    try:
        md = PRIVACY_FILE.read_text(encoding="utf-8")
    except OSError:
        md = PRIVACY_MD
    return HTMLResponse(markdown_to_html(md, "Dayflow — Privacy"), headers={"Cache-Control": "public, max-age=3600"})


@router.get("/{kind}/{page_id}", response_class=HTMLResponse)
async def get_page(kind: str, page_id: str, request: Request) -> HTMLResponse:
    pages: PageStore = request.app.state.pages
    html = await pages.get(kind, page_id)
    if html is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "no such page")
    return HTMLResponse(html, headers={"Cache-Control": "private, max-age=300"})


# ---------- ledger & receipts ----------
#
# The dashboard and the per-artifact receipt are rendered here (the routes live in api/app.py) so every
# generated page shares one look with the courseware and report pages: light, system-ui, printable.

LEDGER_STYLE = """
:root{color-scheme:light}
*{box-sizing:border-box}
body{font:16px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;color:#16181d;background:#f6f7f9;
margin:0;padding:2.5rem 1.25rem 4rem}
main{max-width:64rem;margin:0 auto}
header{border-bottom:2px solid #16181d;padding-bottom:.8rem;margin-bottom:1.5rem}
h1{font-size:1.7rem;margin:0 0 .3rem}
.sub{margin:0;color:#5b6070;font-size:.92rem}
.totals{display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.75rem;margin:0 0 2rem}
.tile{background:#fff;border:1px solid #e2e5ec;border-radius:10px;padding:.8rem .9rem}
.tile b{display:block;font-size:1.5rem;line-height:1.2;font-variant-numeric:tabular-nums}
.tile span{color:#5b6070;font-size:.8rem}
h2{font-size:1.15rem;margin:2rem 0 .8rem}
table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e2e5ec;border-radius:10px}
th,td{text-align:left;padding:.55rem .7rem;border-bottom:1px solid #eceef3;vertical-align:top;font-size:.9rem}
th{font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:#5b6070;background:#fbfbfc}
tr:last-child td{border-bottom:none}
td.num{font-variant-numeric:tabular-nums;white-space:nowrap}
td.fail{color:#a3231f}
td.fail ul{margin:0;padding-left:1rem}
ul.art{margin:0;padding-left:1rem}
ul.art li{margin:.1rem 0}
a{color:#1a4fd6}
.tag{display:inline-block;padding:.05rem .45rem;border-radius:99px;font-size:.75rem;background:#eef1f7;color:#3a4152}
.empty{background:#fff;border:1px dashed #cfd4de;border-radius:10px;padding:1.5rem;color:#5b6070;text-align:center}
footer{margin-top:2rem;color:#5b6070;font-size:.82rem;border-top:1px solid #d8dbe4;padding-top:.75rem}
.card{background:#fff;border:1px solid #e2e5ec;border-radius:10px;padding:1rem 1.2rem;margin:0 0 1rem}
.card h2{margin:0 0 .6rem;font-size:1.05rem}
.card ul{margin:0;padding-left:1.15rem}
.card li{margin:.3rem 0}
.did-not li::marker{color:#1f7a45}
.unproven{color:#7a5a1f}
.hash{font-family:ui-monospace,SFMono-Regular,monospace;font-size:.78rem;word-break:break-all;color:#33384a;
background:#f2f4f8;border-radius:6px;padding:.5rem .6rem;margin:.4rem 0 0}
@media print{body{background:#fff;padding:0}.tile,.card,table{border-color:#bbb}a{color:inherit}}
"""


def _page(title: str, body: str) -> str:
    e = html.escape
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f"<title>{e(title)}</title><style>{LEDGER_STYLE}</style></head>"
        f"<body><main>{body}</main></body></html>"
    )


def _hms(seconds: float) -> str:
    total = int(seconds)
    if total >= 3600:
        return f"{total // 3600}h {total % 3600 // 60}m"
    return f"{total // 60}m {total % 60:02d}s" if total >= 60 else f"{total}s"


def render_ledger_html(runs: list[RunRecord], receipt_href: Callable[[str, int], str], user_id: str = "") -> str:
    """The dashboard: cumulative totals, then one row per run. The failures column is never trimmed —
    what the agent could not do is the honest half of the record."""
    e = html.escape
    agg = totals(runs)
    tiles = [
        (str(agg.runs), "runs"),
        (f"{agg.ok_actions}/{agg.actions}", "actions succeeded"),
        (str(agg.artifacts), "artifacts"),
        (str(agg.files), "files into the vault"),
        (f"{agg.saved_hours:g} h", "of manual work avoided"),
        (f"${agg.cost_usd:.2f}", "spent on tokens"),
        (str(agg.failures), "recorded failures"),
    ]
    out = [
        "<header>",
        "<h1>Dayflow — run ledger</h1>",
        f'<p class="sub">Every run this brain recorded{" for " + e(user_id) if user_id else ""}, '
        "as it happened: what was done, what it cost, and what failed.</p>",
        "</header>",
        '<div class="totals">',
        *(f'<div class="tile"><b>{e(value)}</b><span>{e(label)}</span></div>' for value, label in tiles),
        "</div>",
    ]
    if not runs:
        out.append('<p class="empty">No runs recorded yet. Start one from the panel and refresh this page.</p>')
    else:
        out.append("<h2>Runs</h2><table><thead><tr>")
        out.append(
            "<th>When</th><th>Trigger</th><th>Skill</th><th>Took</th><th>Actions</th>"
            "<th>Artifacts</th><th>Cost</th><th>Saved</th><th>Failures</th></tr></thead><tbody>"
        )
        for run in runs:
            artifacts = (
                "<ul class='art'>"
                + "".join(
                    f'<li><a href="{e(receipt_href(run.run_id, i))}">{e(a.name)}</a> '
                    f'<span class="tag">{e(a.kind)}</span></li>'
                    for i, a in enumerate(run.artifacts)
                )
                + "</ul>"
                if run.artifacts
                else "—"
            )
            failures = (
                "<ul>" + "".join(f"<li>{e(f)}</li>" for f in run.failures) + "</ul>"
                if run.failures
                else ("—" if run.finished else "still running")
            )
            out.append(
                f"<tr><td class='num'>{e(run.started_at)}</td>"
                f"<td><span class='tag'>{e(run.trigger)}</span></td>"
                f"<td>{e(run.skill or 'free prompt')}</td>"
                f"<td class='num'>{e(_hms(run.duration_s))}</td>"
                f"<td class='num'>{run.ok_actions}/{len(run.actions)}</td>"
                f"<td>{artifacts}</td>"
                f"<td class='num'>${run.cost_usd:.4f}</td>"
                f"<td class='num'>{e(_hms(run.saved_seconds))}</td>"
                f"<td class='fail'>{failures}</td></tr>"
            )
        out.append("</tbody></table>")
    out.append(
        "<footer>Saved time is the sum of a per-tool estimate of how long each SUCCESSFUL step takes by hand "
        "(a portal file download 45 s, opening a course 20 s, reading a document 60 s) minus the wall-clock time "
        "the run took; steps that wrote content are counted as zero. Cost is a list-price estimate from the token "
        "counts of each turn — the cloud bill is the source of truth. Every artifact links to its receipt.</footer>"
    )
    return _page("Dayflow — run ledger", "\n".join(out))


def render_receipt_html(facts: ReceiptFacts, ledger_href: str = "") -> str:
    """The "did & didn't" receipt for one artifact — an AI-use disclosure a student can hand to a professor."""
    e = html.escape
    did = facts.did or ["Nothing was recorded for this artifact."]
    out = [
        "<header>",
        f"<h1>{e(facts.artifact.name)}</h1>",
        f'<p class="sub">Dayflow receipt · <span class="tag">{e(facts.artifact.kind)}</span> · '
        f"run {e(facts.run_id)} · started {e(facts.when)} · {e(facts.trigger)} run · "
        f"{facts.action_count} recorded action(s)</p>",
        "</header>",
        '<section class="card"><h2>What Dayflow did</h2><ul>',
        *(f"<li>{e(line)}</li>" for line in did),
        "</ul></section>",
    ]
    if facts.did_not:
        out.append('<section class="card"><h2>What Dayflow did not do</h2><ul class="did-not">')
        out += [f"<li>{e(line)}</li>" for line in facts.did_not]
        out.append(
            "</ul><p class='sub'>Each line above is a statement about the whole run: the tools that would have "
            "done it do not appear anywhere in the log.</p></section>"
        )
    if facts.unproven:
        out.append('<section class="card"><h2>Not claimed</h2><ul class="unproven">')
        out += [f"<li>{e(line)}</li>" for line in facts.unproven]
        out.append("</ul></section>")
    verified = (
        "the chain recomputed from the stored actions matches the head written when the run closed"
        if facts.chain_verified
        else "the run has no stored chain head yet (it is still running, or it was recorded before it closed)"
    )
    out.append(
        '<section class="card"><h2>How to check this</h2>'
        f"<p>{facts.action_count} action(s) were recorded in order; each is hashed together with the hash of the "
        "one before it (sha256), so removing, editing or reordering an entry changes the value below — "
        f"{e(verified)}.</p>"
        f'<p class="hash">{e(facts.chain_head)}</p>'
        f"<p class='sub'>Tools called during the run: {e(', '.join(facts.tools_used)) or '—'}."
        + (f' · <a href="{e(ledger_href)}">full ledger</a>' if ledger_href else "")
        + "</p></section>"
    )
    out.append(
        "<footer>This receipt is generated from Dayflow's own log of the run and states only what that log "
        "shows. It is not a claim about the quality of the work, and it does not cover anything done outside "
        "Dayflow.</footer>"
    )
    return _page(f"Receipt — {facts.artifact.name}", "\n".join(out))
