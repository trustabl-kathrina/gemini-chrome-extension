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
  askBefore: { sendMessage: boolean; createPr: boolean; download: boolean };
}

export type VaultMode = 'drive' | 'brain';

export interface Account {
  email: string;
  name: string;
  /** OAuth access token (harness seeds one; real sign-in keeps it in chrome.identity's cache). */
  token?: string;
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

const PACK = 'kbtu-student';
const VAULT = 'Google Drive folder Dayflow/<course>/<week|lab|materials>/';

export const DEFAULT_SKILLS: readonly Skill[] = [
  {
    id: 'vault-sync',
    title: 'Sync WSP files to vault',
    blurb: 'Walk the course file directories on WSP, download every file into Drive, parse and index it.',
    prompt: 'Sync my course files from WSP into my vault and tell me what changed.',
    instructions:
      `Goal: mirror the course file directories from WSP into the vault (${VAULT}), then index every file.\n` +
      'Steps: open_tab the portal; read_page; open Student files; walk School → Instructor → course folder (click the row, then Enter; take a fresh read_page after every click); ' +
      'for every file row call download(ref, path="<course>/<week|lab|materials>/<file name>") — the extension uploads the bytes to Drive and to the brain, which parses the summary and deadlines. ' +
      'Never download the same file twice. Finish with a short changelog: files added, deadlines discovered.',
    tools: ['open_tab', 'navigate', 'read_page', 'click', 'type_text', 'press_key', 'scroll', 'wait', 'download', 'screenshot'],
    sites: ['wsp.kbtu.kz'],
    schedule: '0 8 * * 1-5',
    pack: PACK,
    enabled: true,
    key: '1',
  },
  {
    id: 'lab',
    title: 'Solve a lab from the vault',
    blurb: 'Read the lab PDF, create a private repo, solve each task with code execution, push notebook + report.',
    prompt: 'Solve Lab 1 of my Computer Vision course and push the solution to a new GitHub repo.',
    instructions:
      'Steps: find the lab in the vault (vault_search / vault_read); create_repository (private); for each task call solve_lab_task(task_text, context) and keep code + stdout; ' +
      'build_notebook(cells) with outputs; build_report(course, lab, results) → Markdown + HTML page; push_files README.md, TODO.md, the .ipynb and REPORT.md in ONE call; ' +
      'upload the report to Drive with download(url=<report page>, path="<course>/<lab>/REPORT.html"). Reply with repo, report and notebook links.',
    tools: ['vault_search', 'vault_read', 'create_repository', 'push_files', 'solve_lab_task', 'build_notebook', 'build_report', 'download', 'open_tab'],
    sites: ['github.com'],
    schedule: null,
    pack: PACK,
    enabled: true,
    key: '2',
  },
  {
    id: 'team-ops',
    title: 'Team ops: Telegram → Linear → GitHub',
    blurb: 'Post the weekly update to the diploma chat, file Linear issues, open a GitHub issue + PR.',
    prompt: 'Post this week’s update to the diploma project chat, create Linear issues for the next milestone, and open the PR.',
    instructions:
      'Steps: summarise the week from the repo (get_file_contents / recent activity); open_tab Telegram Web; read_page; find the diploma chat by name (search box at the top of the left column); ' +
      'click it; request_confirmation with the exact message; type_text into the composer at the bottom and press_key Enter; verify with read_page. ' +
      'Then create_issue in Linear for each next-milestone task, issue_write and create_pull_request on GitHub. Summarise IDs and links.',
    tools: ['open_tab', 'read_page', 'click', 'type_text', 'press_key', 'wait', 'get_file_contents', 'list_teams', 'list_projects', 'create_issue', 'issue_write', 'create_pull_request'],
    sites: ['web.telegram.org', 'github.com', 'linear.app'],
    schedule: null,
    pack: PACK,
    enabled: true,
    key: '3',
  },
  {
    id: 'courseware',
    title: 'Build courseware from syllabus',
    blurb: 'Cheatsheet + quiz per topic, generated from the syllabus, opened as a page and saved to Drive.',
    prompt: 'Build a cheatsheet and a quiz from the syllabus of the current course.',
    instructions:
      'Steps: read the syllabus from the vault (vault_read); generate_courseware(course, weeks) → HTML page URL; open_tab it; download(url=<page>, path="<course>/materials/courseware.html") to save it to Drive.',
    tools: ['vault_search', 'vault_read', 'generate_courseware', 'open_tab', 'download'],
    sites: [],
    schedule: null,
    pack: PACK,
    enabled: true,
    key: '4',
  },
  {
    id: 'scaffold',
    title: 'Scaffold vault folders',
    blurb: 'Per course, per week, per lab — folder tree in Drive initialized from the syllabus schedule.',
    prompt: 'Create the vault folder structure for this semester from my syllabi.',
    instructions:
      'Steps: read each syllabus from the vault; plan_vault_folders(course, schedule) → list of folder paths; the extension creates them on Drive (ensure_folder via download of a .keep file is NOT needed — call plan_vault_folders and report the tree).',
    tools: ['vault_search', 'vault_read', 'plan_vault_folders'],
    sites: [],
    schedule: null,
    pack: PACK,
    enabled: true,
    key: '5',
  },
  {
    id: 'pitch-deck',
    title: 'Pitch deck from repo',
    blurb: 'A deck about the diploma project, generated from the repo, previewed in a tab and saved to Drive.',
    prompt: 'Build a pitch deck about my diploma project repo and open it.',
    instructions:
      'Steps: get_file_contents README and TODO; build_deck(title, slides) → pptx URL + HTML preview; open_tab the preview; download(url=<pptx>, path="Diploma/pitch-deck.pptx") to save it to Drive.',
    tools: ['get_file_contents', 'build_deck', 'open_tab', 'download'],
    sites: ['github.com', 'drive.google.com'],
    schedule: null,
    pack: PACK,
    enabled: true,
    key: '6',
  },
];

export const DEFAULT_SITES: readonly SiteProfile[] = [
  {
    domain: 'wsp.kbtu.kz',
    mode: 'dom',
    notes:
      "KBTU student portal (Vaadin app, no real links; navigation is by clicking). Top-right flag icon img[src*=gb.png] switches UI to English; home icon img[src*=home.png] opens the Desktop, which lists modules as links: Student files, Student's schedule, Attendance mark, Student's Journal, Transcript, Student exam schedule, Registration for disciplines, News. Student files (https://wsp.kbtu.kz/StudentFiles) is a folder browser: a table plus Back/Enter buttons; the tree is School > Instructor (surname name) > course folders > files. Select a row by clicking it, then click Enter; Back goes up. Student's schedule (https://wsp.kbtu.kz/StudentSchedule) is a weekly grid with 'CODE Course name Instructor room (hh:mm-hh:mm)' cells - read it first to learn each course's instructor.",
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
  backendUrl: 'https://dayflow-brain-lrqhed2z5a-ez.a.run.app',
  token: '',
  vision: true,
  showWork: true,
  driveApiBase: 'https://www.googleapis.com',
  vaultMode: 'drive',
  vaultFolder: 'Dayflow',
  account: null,
  skills: [...DEFAULT_SKILLS],
  sites: [...DEFAULT_SITES],
  connections: [...DEFAULT_CONNECTIONS],
  permissions: {
    navigationAllowlist: DEFAULT_SITES.map((s) => s.domain),
    askBefore: { sendMessage: true, createPr: true, download: false },
  },
};

/** Legacy / harness-seeded shapes that older builds or the runner may store. */
interface StoredSettings extends Partial<Settings> {
  vault?: { mode?: VaultMode; folder?: string };
  google?: { token?: string; email?: string; name?: string };
}

/** Fills defaults and maps older shapes (`vault.mode`, `google.token`, `account.token`) onto the v2 model. */
export function normalizeSettings(stored: unknown): Settings {
  const s = (stored && typeof stored === 'object' ? stored : {}) as StoredSettings;
  const next: Settings = { ...DEFAULT_SETTINGS, ...s };
  if (s.vault?.mode) next.vaultMode = s.vault.mode;
  if (s.vault?.folder) next.vaultFolder = s.vault.folder;
  if (!next.driveToken) next.driveToken = s.account?.token ?? s.google?.token;
  if (!next.account && s.google?.email) next.account = { email: s.google.email, name: s.google.name ?? '' };
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
  | { kind: 'run.end'; status: 'done' | 'error' | 'cancelled'; summary: string };

/** Side panel → background. */
export type PanelRequest =
  | { type: 'run.start'; runId: string; skillId?: string; text: string }
  | { type: 'run.cancel'; runId: string }
  | { type: 'confirm.answer'; runId: string; confirmId: string; allow: boolean };

/** Background → side panel. */
export type PanelMessage = { type: 'event'; runId: string; event: AgentEvent };

export const PANEL_PORT = 'dayflow-panel';
export const TOOL_CHANNEL = 'dayflow-tool';
