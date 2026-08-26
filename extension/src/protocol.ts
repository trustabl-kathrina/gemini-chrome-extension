/** Wire protocol shared by side panel ⇄ background ⇄ (later) Cloud Run brain. */

export type SceneId =
  | 'vault-sync'
  | 'courseware'
  | 'scaffold'
  | 'bootstrap'
  | 'team-ops'
  | 'pitch-deck';

export interface Scene {
  id: SceneId;
  title: string;
  blurb: string;
  /** What the user would have typed; sent to the brain as the run's opening message. */
  prompt: string;
  /** Single-key shortcut inside the ⌘K palette. */
  key: string;
}

export const SCENES: readonly Scene[] = [
  {
    id: 'vault-sync',
    title: 'Sync WSP files to vault',
    blurb: 'Walk every course directory on WSP, pull new or changed files into Downloads/DayflowVault.',
    prompt: 'Sync all course files from WSP into my vault and tell me what changed.',
    key: '1',
  },
  {
    id: 'courseware',
    title: 'Build courseware from syllabus',
    blurb: 'Cheatsheet + quiz per topic, generated from the syllabus and opened as a page.',
    prompt: 'Build a cheatsheet and a quiz from the syllabus of the current course.',
    key: '2',
  },
  {
    id: 'scaffold',
    title: 'Scaffold vault folders',
    blurb: 'Per course, per week, per lab — folder tree initialized from the syllabus schedule.',
    prompt: 'Create the vault folder structure for this semester from my syllabi.',
    key: '3',
  },
  {
    id: 'bootstrap',
    title: 'Bootstrap coding project',
    blurb: 'GitHub repo or notebook with a working foundation and a TODO list, via GitHub MCP.',
    prompt: 'Bootstrap a GitHub repo for my Machine Learning course project with a notebook and a TODO list.',
    key: '4',
  },
  {
    id: 'team-ops',
    title: 'Team ops: Telegram → Linear → GitHub',
    blurb: 'Post an update to the diploma chat, file Linear issues, open a GitHub issue + PR.',
    prompt: 'Post this week’s update to the diploma project chat, create Linear issues for the next milestone, and open the PR.',
    key: '5',
  },
  {
    id: 'pitch-deck',
    title: 'Pitch deck from repo',
    blurb: 'A deck about the diploma project, generated from the repo and opened in Slides.',
    prompt: 'Build a pitch deck about my diploma project repo and open it.',
    key: '6',
  },
];

/** Tools the browser executes on behalf of the brain. */
export type BrowserToolName =
  | 'navigate'
  | 'read_page'
  | 'click'
  | 'type'
  | 'wait'
  | 'screenshot'
  | 'download'
  | 'open_tab'
  | 'list_tabs';

export interface ToolCall {
  id: string;
  name: BrowserToolName | (string & {});
  args: Record<string, unknown>;
}

export type ArtifactType = 'file' | 'folder' | 'url' | 'repo' | 'deck' | 'issue' | 'pr';

export type AgentEvent =
  | { kind: 'run.start'; title: string; sceneId?: SceneId }
  | { kind: 'text'; text: string; partial?: boolean }
  | { kind: 'tool.call'; call: ToolCall; target: 'browser' | 'server' }
  | { kind: 'tool.result'; callId: string; ok: boolean; summary: string; ms: number }
  | { kind: 'artifact'; type: ArtifactType; label: string; href?: string }
  | { kind: 'confirm'; id: string; message: string }
  | { kind: 'run.end'; status: 'done' | 'error' | 'cancelled'; summary: string };

/** Side panel → background. */
export type PanelRequest =
  | { type: 'run.start'; runId: string; sceneId?: SceneId; text: string }
  | { type: 'run.cancel'; runId: string }
  | { type: 'confirm.answer'; runId: string; confirmId: string; allow: boolean };

/** Background → side panel. */
export type PanelMessage = { type: 'event'; runId: string; event: AgentEvent };

export interface Settings {
  mode: 'mock' | 'live';
  backendUrl: string;
  vaultFolder: string;
  connections: { github: boolean; linear: boolean };
  account: { email: string; name: string } | null;
}

export const DEFAULT_SETTINGS: Settings = {
  mode: 'mock',
  backendUrl: 'https://dayflow-brain.run.app',
  vaultFolder: 'DayflowVault',
  connections: { github: false, linear: false },
  account: null,
};

export const PANEL_PORT = 'dayflow-panel';
export const TOOL_CHANNEL = 'dayflow-tool';
