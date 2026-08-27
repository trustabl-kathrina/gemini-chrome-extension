/**
 * Wire protocol shared by side panel ⇄ background ⇄ brain. Mirrors backend/dayflow/core models.
 * Keep this file dependency-free: the harness imports it straight into Node (type stripping only).
 */

// ---------- User-owned configuration (the "Claude Code" mapping) ----------

/** A skill = a playbook the agent can run. Everything site-specific lives here, never in code. */
export interface Skill {
  id: string;
  title: string;
  blurb: string;
  /** Opening message when the skill is launched from the panel. */
  prompt: string;
  /** Instructions injected into the brain's system prompt for this run. */
  instructions: string;
  /** Allowed tool names; empty = everything the user's permissions allow. */
  tools: string[];
  /** Domains the skill operates on; site profiles for these are loaded. */
  sites: string[];
  /** Cron expression, or null when not scheduled. */
  schedule: string | null;
  pack: string;
  enabled: boolean;
  /** Single-key shortcut inside the ⌘K palette. */
  key?: string;
}

/** How the agent perceives a site: element list with refs + coords, or screenshot-first. */
export type SiteMode = 'dom' | 'vision';

export interface SiteProfile {
  domain: string;
  /** Free-form notes the agent reads when working on this domain (like CLAUDE.md for a repo). */
  notes: string;
  allow: boolean;
  mode?: SiteMode;
}

export type ConnectionId = 'github' | 'linear' | 'drive' | 'telegram';

export interface Connection {
  id: ConnectionId;
  label: string;
  connected: boolean;
  account?: string;
}

export interface Permissions {
  navigationAllowlist: string[];
  /** Gates that need an Allow card: sending messages (`type`), issues/PRs, downloads, `run_js` (arbitrary page JS). */
  askBefore: { sendMessage: boolean; createPr: boolean; download: boolean; runJs: boolean };
}

export type VaultMode = 'drive' | 'brain';

export interface Account {
  email: string;
  name: string;
  /** OAuth access token (harness seeds one; real sign-in keeps it in chrome.identity's cache). */
  token?: string;
  /**
   * Google ID token (JWT) for the brain, when a sign-in path can produce one. `chrome.identity.getAuthToken`
   * returns an ACCESS token only — it never yields an ID token — so with the current sign-in this stays
   * undefined and the brain is called with the shared DAYFLOW_TOKEN (see `brainAuthToken`). The brain accepts
   * either (backend/dayflow/api/auth.py); filling this in needs a web OAuth client + `launchWebAuthFlow`.
   */
  idToken?: string;
  expiresAt?: number;
}

export interface Settings {
  backendUrl: string;
  token: string;
  /** Attach a JPEG screenshot to every browser tool result. */
  vision: boolean;
  /** Keep the agent's tab in the foreground and flash the elements it acts on (demo-friendly). */
  showWork: boolean;
  /** Google Drive API base; the harness points it at the fake Drive. */
  driveApiBase: string;
  /** Explicit OAuth token; when unset the extension asks chrome.identity. */
  driveToken?: string;
  /** 'drive' = upload to the user's Drive and index in the brain; 'brain' = brain storage only (no OAuth client). */
  vaultMode: VaultMode;
  /** Root folder of the vault on Drive. */
  vaultFolder: string;
  account: Account | null;
  skills: Skill[];
  sites: SiteProfile[];
  connections: Connection[];
  permissions: Permissions;
}

/**
 * Skills are NOT shipped with the extension: the brain's default pack (backend/dayflow/core/packs/*.yaml) is the
 * single source of skill text, and the panel caches what `GET /config` returns (App.tsx pulls it on open). A
 * stale local copy would overlay the pack skill-by-skill on the next `PUT /config`.
 */
export const DEFAULT_SITES: readonly SiteProfile[] = [
  {
    domain: 'wsp.kbtu.kz',
    mode: 'dom',
    notes:
      "KBTU student portal (Vaadin app, no real links; navigation is by clicking). Top-right flag icon img[src*=gb.png] switches UI to English; home icon img[src*=home.png] opens the Desktop, which lists modules as links: Student files, Student's schedule, Attendance mark, Student's Journal, Transcript, Student exam schedule, Registration for disciplines, News. Student files (https://wsp.kbtu.kz/StudentFiles) is a folder browser: a table plus Back/Enter buttons; the tree is School > Instructor (surname name) > course folder > numbered subfolders (1.Syllabus for the student, 2.Lectures, 3.Labs, ...) > files. Select a row by clicking it, then click the Enter button right away (keyboard Enter does not open folders; reuse the Back/Enter refs from the last read_page - they are re-found after re-renders); Back goes up. A file row does not download when clicked: its last cell holds an icon-only download button - call download(ref=<that button>) (or the row's ref) to put the file in the vault. Student's schedule (https://wsp.kbtu.kz/StudentSchedule) is a weekly grid with 'CODE Course name Instructor room (hh:mm-hh:mm)' cells - read it first to learn each course's instructor.",
    allow: true,
  },
  {
    domain: 'web.telegram.org',
    mode: 'dom',
    notes: 'Use the “/k/” web client. Chat list on the left; chat search is the input at the top of the left column; the message composer is the contenteditable at the bottom; Enter sends. Never send without confirmation.',
    allow: true,
  },
  { domain: 'github.com', mode: 'dom', notes: '', allow: true },
  { domain: 'linear.app', mode: 'dom', notes: '', allow: true },
  { domain: 'drive.google.com', mode: 'vision', notes: 'Canvas-heavy UI: act by coordinates from the screenshot; use read_page only to read text.', allow: true },
  { domain: 'teams.microsoft.com', mode: 'dom', notes: 'Course announcements and assignments per team channel.', allow: true },
];

export const DEFAULT_CONNECTIONS: readonly Connection[] = [
  { id: 'github', label: 'GitHub', connected: false },
  { id: 'linear', label: 'Linear', connected: false },
  { id: 'drive', label: 'Google Drive', connected: false },
  { id: 'telegram', label: 'Telegram notifications', connected: false },
];

export const DEFAULT_SETTINGS: Settings = {
  // Empty on purpose: the user pastes their own brain URL (Settings → Brain). A baked-in URL would silently point
  // at someone else's deployment (and at whatever revision happens to be live there).
  backendUrl: '',
  token: '',
  vision: true,
  showWork: true,
  driveApiBase: 'https://www.googleapis.com',
  vaultMode: 'drive',
  vaultFolder: 'Dayflow',
  account: null,
  skills: [],
  sites: [...DEFAULT_SITES],
  connections: [...DEFAULT_CONNECTIONS],
  permissions: {
    navigationAllowlist: DEFAULT_SITES.map((s) => s.domain),
    askBefore: { sendMessage: true, createPr: true, download: false, runJs: true },
  },
};

/**
 * The vault mode actually in force. `drive` needs a credential: an explicit `driveToken`, a token from a
 * previous sign-in, or a build with an OAuth client id (`VITE_GOOGLE_CLIENT_ID`, passed as `driveConfigured`).
 * Without one, Drive cannot work at all, so the vault falls back to the brain instead of failing mid-run.
 */
export function effectiveVaultMode(s: Pick<Settings, 'vaultMode' | 'driveToken' | 'account'>, driveConfigured: boolean): VaultMode {
  if (s.vaultMode !== 'drive') return s.vaultMode;
  return driveConfigured || s.driveToken || s.account?.token ? 'drive' : 'brain';
}

/** Legacy / harness-seeded shapes that older builds or the runner may store. */
interface StoredSettings extends Partial<Settings> {
  vault?: { mode?: VaultMode; folder?: string };
  google?: { token?: string; email?: string; name?: string };
}

export function normalizeBackendUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) {
    if (/^(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?$/i.test(trimmed) || /:\d+$/.test(trimmed)) {
      return `http://${trimmed}`.replace(/\/+$/, '');
    }
    return `https://${trimmed}`.replace(/\/+$/, '');
  }
  return trimmed.replace(/\/+$/, '');
}

/** Fills defaults and maps older shapes (`vault.mode`, `google.token`, `account.token`) onto the v2 model. */
export function normalizeSettings(stored: unknown): Settings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as StoredSettings;
  const next: Settings = { ...DEFAULT_SETTINGS, ...s };
  if (s.vault?.mode) next.vaultMode = s.vault.mode;
  if (s.vault?.folder) next.vaultFolder = s.vault.folder;
  if (!next.driveToken) next.driveToken = s.account?.token ?? s.google?.token;
  if (!next.account && s.google?.email) next.account = { email: s.google.email, name: s.google.name ?? '' };
  if (next.backendUrl) next.backendUrl = normalizeBackendUrl(next.backendUrl);
  if (next.driveApiBase) next.driveApiBase = normalizeBackendUrl(next.driveApiBase);
  next.sites = (next.sites ?? []).map((site) => ({ ...site, mode: site.mode ?? DEFAULT_SITES.find((d) => d.domain === site.domain)?.mode ?? 'dom' }));
  next.permissions = { ...DEFAULT_SETTINGS.permissions, ...next.permissions, askBefore: { ...DEFAULT_SETTINGS.permissions.askBefore, ...next.permissions?.askBefore } };
  return next;
}

// ---------- Run-time events ----------

/** Tools the browser executes on behalf of the brain (PLAN v2 §The loop). */
export type BrowserToolName =
  | 'open_tab'
  | 'navigate'
  | 'read_page'
  | 'screenshot'
  | 'click'
  | 'click_at'
  | 'type'
  | 'type_text'
  | 'press_key'
  | 'scroll'
  | 'set_viewport'
  | 'run_js'
  | 'download'
  | 'list_tabs'
  | 'wait';

export interface ToolCall {
  id: string;
  name: BrowserToolName | (string & {});
  args: Record<string, unknown>;
}

export type ArtifactType = 'file' | 'folder' | 'url' | 'repo' | 'deck' | 'issue' | 'pr';

export type AgentEvent =
  | { kind: 'run.start'; title: string; skillId?: string }
  | { kind: 'text'; text: string; partial?: boolean }
  | { kind: 'tool.call'; call: ToolCall; target: 'browser' | 'server' }
  /** `screenshot` is a small data-URL thumbnail (≤320px) of the page after the tool ran. */
  | { kind: 'tool.result'; callId: string; ok: boolean; summary: string; ms: number; screenshot?: string }
  | { kind: 'artifact'; type: ArtifactType; label: string; href?: string }
  | { kind: 'confirm'; id: string; message: string }
  | { kind: 'run.pause' }
  | { kind: 'run.resume' }
  | { kind: 'run.end'; status: 'done' | 'error' | 'cancelled'; summary: string };

/**
 * Side panel → background. `runId` = one prompt (transcript row, cancel/pause/confirm routing);
 * `sessionId` = the conversation the brain remembers, shared by every run typed into the panel.
 */
export type PanelRequest =
  | { type: 'run.start'; runId: string; sessionId: string; skillId?: string; text: string }
  | { type: 'run.pause'; runId: string }
  | { type: 'run.resume'; runId: string }
  | { type: 'run.cancel'; runId: string }
  | { type: 'confirm.answer'; runId: string; confirmId: string; allow: boolean };

/** Background → side panel. */
export type PanelMessage = { type: 'event'; runId: string; event: AgentEvent };

export const PANEL_PORT = 'dayflow-panel';
export const TOOL_CHANNEL = 'dayflow-tool';
