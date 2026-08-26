/** Wire protocol shared by side panel ⇄ background ⇄ Cloud Run brain. Mirrors backend/dayflow/core models. */

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
  /** Allowed tool names; '*' = everything the user's permissions allow. */
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

export interface SiteProfile {
  domain: string;
  /** Free-form notes the agent reads when working on this domain (like CLAUDE.md for a repo). */
  notes: string;
  allow: boolean;
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

export interface Settings {
  mode: 'mock' | 'live';
  backendUrl: string;
  token: string;
  vaultFolder: string;
  account: { email: string; name: string } | null;
  skills: Skill[];
  sites: SiteProfile[];
  connections: Connection[];
  permissions: Permissions;
}

/** Ids of the default pack; the mock agent has a script for each. */
export type SceneId = 'vault-sync' | 'courseware' | 'scaffold' | 'bootstrap' | 'team-ops' | 'pitch-deck';

const PACK = 'kbtu-student';

export const DEFAULT_SKILLS: readonly Skill[] = [
  {
    id: 'vault-sync',
    title: 'Sync WSP files to vault',
    blurb: 'Walk every course directory on WSP, pull new or changed files into the vault.',
    prompt: 'Sync all course files from WSP into my vault and tell me what changed.',
    instructions:
      'Open WSP in a pinned background tab. For each course, open its Files section, compare every file against the vault index, and download new or changed files into <vault>/<course>/<week or lab>/. Parse each downloaded file and record summaries and deadlines. Finish with a short changelog.',
    tools: ['open_tab', 'read_page', 'click', 'download', 'parse_document'],
    sites: ['wsp.kbtu.kz'],
    schedule: '0 8 * * 1-5',
    pack: PACK,
    enabled: true,
    key: '1',
  },
  {
    id: 'courseware',
    title: 'Build courseware from syllabus',
    blurb: 'Cheatsheet + quiz per topic, generated from the syllabus and opened as a page.',
    prompt: 'Build a cheatsheet and a quiz from the syllabus of the current course.',
    instructions:
      'Read the syllabus from the vault. Produce a two-page cheatsheet and a 10-question quiz for the requested weeks as one HTML page, publish it, and open it in a new tab.',
    tools: ['vault_read', 'generate_courseware', 'open_tab'],
    sites: [],
    schedule: null,
    pack: PACK,
    enabled: true,
    key: '2',
  },
  {
    id: 'scaffold',
    title: 'Scaffold vault folders',
    blurb: 'Per course, per week, per lab — folder tree initialized from the syllabus schedule.',
    prompt: 'Create the vault folder structure for this semester from my syllabi.',
    instructions:
      'Read every syllabus in the vault, derive the week and lab schedule, and create the folder tree <vault>/<course>/Week NN and <vault>/<course>/Lab NN. Never overwrite existing files.',
    tools: ['vault_read', 'download'],
    sites: [],
    schedule: null,
    pack: PACK,
    enabled: true,
    key: '3',
  },
  {
    id: 'bootstrap',
    title: 'Bootstrap coding project',
    blurb: 'GitHub repo or notebook with a working foundation and a TODO list, via GitHub MCP.',
    prompt: 'Bootstrap a GitHub repo for my course project with a notebook and a TODO list.',
    instructions:
      'Read the lab or project requirements from the vault. Create a private GitHub repo, push README.md, TODO.md (numbered, testable items), a starter notebook or source tree, requirements and .gitignore. Open the repo in a tab.',
    tools: ['vault_read', 'github.*', 'open_tab'],
    sites: ['github.com'],
    schedule: null,
    pack: PACK,
    enabled: true,
    key: '4',
  },
  {
    id: 'team-ops',
    title: 'Team ops: Telegram → Linear → GitHub',
    blurb: 'Post an update to the diploma chat, file Linear issues, open a GitHub issue + PR.',
    prompt: 'Post this week’s update to the diploma project chat, create Linear issues for the next milestone, and open the PR.',
    instructions:
      'Summarise the last week of commits. Open Telegram Web, find the team chat by name, and ask for confirmation before sending. Then create Linear issues for the next milestone and open the GitHub issue and pull request.',
    tools: ['github.*', 'linear.*', 'open_tab', 'read_page', 'click', 'type'],
    sites: ['web.telegram.org', 'github.com', 'linear.app'],
    schedule: null,
    pack: PACK,
    enabled: true,
    key: '5',
  },
  {
    id: 'pitch-deck',
    title: 'Pitch deck from repo',
    blurb: 'A deck about the diploma project, generated from the repo and opened in Slides.',
    prompt: 'Build a pitch deck about my diploma project repo and open it.',
    instructions:
      'Read README and TODO from the repo. Outline an 8-slide pitch (problem, solution, demo, architecture, progress, roadmap, team, ask), build the .pptx, save it to the vault, upload it to Drive and open it in Slides.',
    tools: ['github.*', 'build_deck', 'download', 'open_tab', 'click'],
    sites: ['drive.google.com', 'docs.google.com'],
    schedule: null,
    pack: PACK,
    enabled: true,
    key: '6',
  },
];

export const DEFAULT_SITES: readonly SiteProfile[] = [
  { domain: 'wsp.kbtu.kz', notes: 'KBTU student portal. Course files live under Registration → Course → Files. Attendance marking button appears during lectures.', allow: true },
  { domain: 'teams.microsoft.com', notes: 'Course announcements and assignments per team channel.', allow: true },
  { domain: 'web.telegram.org', notes: 'Use the “/k/” web client. Chat search is the input at the top of the left column.', allow: true },
  { domain: 'github.com', notes: '', allow: true },
  { domain: 'linear.app', notes: '', allow: true },
  { domain: 'drive.google.com', notes: '', allow: true },
];

export const DEFAULT_CONNECTIONS: readonly Connection[] = [
  { id: 'github', label: 'GitHub', connected: false },
  { id: 'linear', label: 'Linear', connected: false },
  { id: 'drive', label: 'Google Drive', connected: false },
  { id: 'telegram', label: 'Telegram notifications', connected: false },
];

export const DEFAULT_SETTINGS: Settings = {
  mode: 'mock',
  backendUrl: 'https://dayflow-brain-lrqhed2z5a-ez.a.run.app',
  token: '',
  vaultFolder: 'DayflowVault',
  account: null,
  skills: [...DEFAULT_SKILLS],
  sites: [...DEFAULT_SITES],
  connections: [...DEFAULT_CONNECTIONS],
  permissions: {
    navigationAllowlist: DEFAULT_SITES.map((s) => s.domain),
    askBefore: { sendMessage: true, createPr: true, download: false },
  },
};

// ---------- Run-time events ----------

/** Tools the browser executes on behalf of the brain. */
export type BrowserToolName = 'navigate' | 'read_page' | 'click' | 'type' | 'wait' | 'screenshot' | 'download' | 'open_tab' | 'list_tabs';

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
  | { kind: 'tool.result'; callId: string; ok: boolean; summary: string; ms: number }
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
