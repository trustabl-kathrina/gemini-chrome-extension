# Dayflow — Privacy

Last updated: 2026-08-26. Applies to the Chrome extension "Dayflow Agent" and the Dayflow brain (the backend you run).

Dayflow is a browser agent you self-host. There is no Dayflow company server: the extension only talks to the
backend URL you type into Settings (your own Cloud Run service, or `localhost`), and that backend only talks to
Google Gemini through your own Google Cloud project or API key. The author of Dayflow receives nothing.

## What the extension keeps on your computer

Stored with `chrome.storage.local`, and removed when you uninstall the extension:

- The backend URL and access token you entered.
- Your config: skills, site profiles, permissions and schedules (the YAML shown in the Config screen).
- If you sign in with Google: your email, display name and a short-lived Google OAuth access token for Drive.
- Recent run transcripts, including tool arguments and small screenshot thumbnails of the pages the agent used.

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

Gemini is called through Vertex AI or the Gemini API with your credentials, so those requests are handled by Google
under the terms of that product. No other model provider is used.

## Services you may connect

GitHub, Linear and Telegram are used only when you connect them or ask for them by name. The data goes to them
directly, under your account and their privacy policies. Dayflow adds no intermediary and keeps no copy beyond the
run transcript on your machine.

## Deleting your data

- Uninstall the extension — local settings, tokens and transcripts go with it.
- Delete the Firestore collection and the Cloud Storage bucket in your project — the vault index and artifacts go
  with them.
- Revoke Dayflow's access to your Google account at https://myaccount.google.com/permissions.

## Why each permission exists

- `storage` — keep your settings and transcripts locally.
- `alarms` — run the schedules you created in Config.
- `sidePanel` — the panel is the whole UI.
- `tabs` — open and focus the tab a task needs, and read that tab's URL and title.
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
