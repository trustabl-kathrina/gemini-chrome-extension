import type { AgentEvent, ArtifactType, SceneId } from '../protocol';

const isScene = (id: string): id is SceneId => id in SCRIPTS;

/**
 * Scripted runs for UX-driven development. Timings and wording mirror what the
 * Cloud Run brain will emit; only the tool execution is simulated.
 */
type Op =
  | { ev: AgentEvent; after?: number }
  | { tool: { name: string; args: Record<string, unknown> }; target?: 'browser' | 'server'; ms: number; result: string; ok?: boolean }
  | { say: string; after?: number }
  | { artifact: { type: ArtifactType; label: string; href?: string } }
  | { confirm: string };

const SCRIPTS: Record<SceneId, Op[]> = {
  'vault-sync': [
    { say: 'Opening WSP in a background tab and walking your course directories.' },
    { tool: { name: 'open_tab', args: { url: 'https://wsp.kbtu.kz/RegistrationOnline', pinned: true } }, ms: 900, result: 'tab #41 (pinned, background)' },
    { tool: { name: 'read_page', args: { tab: 41 } }, ms: 1400, result: '6 courses · 212 nodes' },
    { say: 'Found 6 courses. Checking each file directory against the vault index…' },
    { tool: { name: 'click', args: { ref: 'e17', label: 'Machine Learning → Files' } }, ms: 700, result: 'navigated' },
    { tool: { name: 'read_page', args: { tab: 41 } }, ms: 1100, result: '14 files · 2 newer than index' },
    { tool: { name: 'download', args: { file: 'Lecture_07_Regularization.pdf', to: 'DayflowVault/Machine Learning/Week 07/' } }, ms: 1600, result: '1.8 MB' },
    { tool: { name: 'download', args: { file: 'Lab_03_Instructions.pdf', to: 'DayflowVault/Machine Learning/Lab 03/' } }, ms: 1200, result: '640 KB' },
    { tool: { name: 'parse_document', args: { file: 'Lecture_07_Regularization.pdf' } }, target: 'server', ms: 2400, result: 'summary + 4 key terms → Firestore' },
    { tool: { name: 'parse_document', args: { file: 'Lab_03_Instructions.pdf' } }, target: 'server', ms: 2100, result: 'deadline Sep 12 → Firestore' },
    { tool: { name: 'click', args: { ref: 'e21', label: 'Databases → Files' } }, ms: 700, result: 'navigated' },
    { tool: { name: 'read_page', args: { tab: 41 } }, ms: 1000, result: '9 files · up to date' },
    { say: 'Other four courses are unchanged.' },
    { artifact: { type: 'file', label: 'Machine Learning/Week 07/Lecture_07_Regularization.pdf' } },
    { artifact: { type: 'file', label: 'Machine Learning/Lab 03/Lab_03_Instructions.pdf' } },
    { ev: { kind: 'run.end', status: 'done', summary: '2 new files synced · Lab 03 due Sep 12 added to deadlines' } },
  ],
  courseware: [
    { say: 'Reading the syllabus from your vault.' },
    { tool: { name: 'vault_read', args: { path: 'Machine Learning/syllabus.pdf' } }, target: 'server', ms: 1300, result: '15 weeks · 11 topics' },
    { say: 'Generating a cheatsheet and a 10-question quiz for weeks 5–7 (midterm scope).' },
    { tool: { name: 'generate_courseware', args: { weeks: [5, 6, 7], format: 'html' } }, target: 'server', ms: 4200, result: 'cheatsheet 2 pages · quiz 10 q' },
    { tool: { name: 'open_tab', args: { url: 'https://dayflow-brain.run.app/courseware/ml-midterm' } }, ms: 800, result: 'opened' },
    { artifact: { type: 'url', label: 'ML midterm cheatsheet + quiz', href: 'https://dayflow-brain.run.app/courseware/ml-midterm' } },
    { ev: { kind: 'run.end', status: 'done', summary: 'Courseware ready and open in a new tab' } },
  ],
  scaffold: [
    { say: 'Building the semester tree from all six syllabi.' },
    { tool: { name: 'vault_read', args: { glob: '*/syllabus.pdf' } }, target: 'server', ms: 1800, result: '6 syllabi · 15 weeks · 9 labs' },
    { tool: { name: 'download', args: { tree: 'DayflowVault/**/.keep', count: 114 } }, ms: 2600, result: '114 folders' },
    { artifact: { type: 'folder', label: 'DayflowVault/ — 6 courses · 90 week folders · 9 lab folders' } },
    { ev: { kind: 'run.end', status: 'done', summary: 'Vault scaffolded for 6 courses' } },
  ],
  bootstrap: [
    { say: 'Reading Lab 03 requirements to pick a foundation.' },
    { tool: { name: 'vault_read', args: { path: 'Machine Learning/Lab 03/Lab_03_Instructions.pdf' } }, target: 'server', ms: 1200, result: 'regression on housing data · sklearn' },
    { tool: { name: 'github.create_repository', args: { name: 'ml-lab03-regression', private: true } }, target: 'server', ms: 1700, result: 'altairzhambyl/ml-lab03-regression' },
    { tool: { name: 'github.push_files', args: { files: ['README.md', 'TODO.md', 'notebook.ipynb', 'requirements.txt', '.gitignore'] } }, target: 'server', ms: 2300, result: '5 files · 1 commit' },
    { tool: { name: 'open_tab', args: { url: 'https://github.com/altairzhambyl/ml-lab03-regression' } }, ms: 700, result: 'opened' },
    { artifact: { type: 'repo', label: 'altairzhambyl/ml-lab03-regression', href: 'https://github.com/altairzhambyl/ml-lab03-regression' } },
    { ev: { kind: 'run.end', status: 'done', summary: 'Repo with notebook foundation and 7 TODOs' } },
  ],
  'team-ops': [
    { say: 'Drafting the weekly update from the last 7 days of commits.' },
    { tool: { name: 'github.list_commits', args: { repo: 'diploma-project', since: '7d' } }, target: 'server', ms: 1500, result: '12 commits · 3 authors' },
    { tool: { name: 'open_tab', args: { url: 'https://web.telegram.org/k/' } }, ms: 1200, result: 'opened' },
    { tool: { name: 'read_page', args: {} }, ms: 1000, result: 'chat list · 38 chats' },
    { tool: { name: 'click', args: { ref: 'e9', label: 'Diploma · Team' } }, ms: 800, result: 'chat open' },
    { confirm: 'Send this to “Diploma · Team”?\n\n“Weekly update: auth flow merged, data pipeline at 80%, demo on Friday. Next: evaluation module — issues incoming in Linear.”' },
    { tool: { name: 'type', args: { ref: 'e40', text: 'Weekly update: auth flow merged…' } }, ms: 900, result: 'typed 142 chars' },
    { tool: { name: 'click', args: { ref: 'e41', label: 'Send' } }, ms: 500, result: 'sent' },
    { tool: { name: 'linear.create_issue', args: { team: 'DIP', title: 'Evaluation module: metrics' } }, target: 'server', ms: 1100, result: 'DIP-31' },
    { tool: { name: 'linear.create_issue', args: { team: 'DIP', title: 'Evaluation module: report' } }, target: 'server', ms: 1000, result: 'DIP-32' },
    { tool: { name: 'github.issue_write', args: { repo: 'diploma-project', title: 'Evaluation module' } }, target: 'server', ms: 1200, result: '#47' },
    { tool: { name: 'github.create_pull_request', args: { head: 'feat/eval-module', base: 'main' } }, target: 'server', ms: 1400, result: '#48' },
    { artifact: { type: 'issue', label: 'DIP-31, DIP-32', href: 'https://linear.app/' } },
    { artifact: { type: 'pr', label: 'diploma-project#48', href: 'https://github.com/' } },
    { ev: { kind: 'run.end', status: 'done', summary: 'Update sent · 2 Linear issues · GitHub issue #47 · PR #48' } },
  ],
  'pitch-deck': [
    { say: 'Reading the repo README and TODO to outline the story.' },
    { tool: { name: 'github.get_file_contents', args: { repo: 'diploma-project', path: 'README.md' } }, target: 'server', ms: 1100, result: '3.1 KB' },
    { tool: { name: 'build_deck', args: { slides: 8, theme: 'dayflow' } }, target: 'server', ms: 5200, result: 'diploma-pitch.pptx · 8 slides' },
    { tool: { name: 'download', args: { file: 'diploma-pitch.pptx', to: 'DayflowVault/Diploma/' } }, ms: 900, result: '412 KB' },
    { tool: { name: 'open_tab', args: { url: 'https://drive.google.com/' } }, ms: 1100, result: 'opened' },
    { tool: { name: 'click', args: { ref: 'e3', label: 'New → File upload' } }, ms: 2200, result: 'uploaded' },
    { artifact: { type: 'deck', label: 'diploma-pitch.pptx — open in Slides', href: 'https://docs.google.com/presentation/' } },
    { ev: { kind: 'run.end', status: 'done', summary: '8-slide deck built and opened in Google Slides' } },
  ],
};

const GENERIC: Op[] = [
  { say: 'Looking at the current tab to understand the task.' },
  { tool: { name: 'read_page', args: {} }, ms: 1100, result: '84 nodes' },
  { say: 'I can do that. In live mode this would be planned by the brain; in mock mode I stop here.' },
  { ev: { kind: 'run.end', status: 'done', summary: 'Mock run complete' } },
];

export interface MockControls {
  signal: AbortSignal;
  /** Resolves with the user's answer to a confirmation request. */
  waitForConfirm: (id: string) => Promise<boolean>;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
  });

export async function* mockRun(skillId: string | undefined, text: string, ctl: MockControls): AsyncGenerator<AgentEvent> {
  const script = skillId && isScene(skillId) ? SCRIPTS[skillId] : GENERIC;
  yield { kind: 'run.start', title: text.slice(0, 80), skillId };
  let n = 0;
  try {
    for (const op of script) {
      if ('say' in op) {
        // stream words to exercise the partial-text path
        const words = op.say.split(' ');
        for (let i = 0; i < words.length; i++) {
          yield { kind: 'text', text: (i ? ' ' : '') + words[i], partial: i < words.length - 1 };
          await sleep(28, ctl.signal);
        }
        await sleep(op.after ?? 250, ctl.signal);
      } else if ('tool' in op) {
        const id = `c${++n}`;
        yield { kind: 'tool.call', call: { id, ...op.tool }, target: op.target ?? 'browser' };
        await sleep(op.ms, ctl.signal);
        yield { kind: 'tool.result', callId: id, ok: op.ok ?? true, summary: op.result, ms: op.ms };
        await sleep(120, ctl.signal);
      } else if ('artifact' in op) {
        yield { kind: 'artifact', ...op.artifact };
        await sleep(150, ctl.signal);
      } else if ('confirm' in op) {
        const id = `k${++n}`;
        yield { kind: 'confirm', id, message: op.confirm };
        const allowed = await ctl.waitForConfirm(id);
        if (!allowed) {
          yield { kind: 'text', text: 'Okay — not sending. Stopping here.' };
          yield { kind: 'run.end', status: 'cancelled', summary: 'Cancelled at confirmation' };
          return;
        }
      } else {
        await sleep(op.after ?? 0, ctl.signal);
        yield op.ev;
      }
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      yield { kind: 'run.end', status: 'cancelled', summary: 'Cancelled' };
      return;
    }
    throw e;
  }
}
