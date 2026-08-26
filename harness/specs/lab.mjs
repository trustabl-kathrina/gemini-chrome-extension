// Scene 2 — Lab (PLAN v2): fake-connector log has create_repository + push_files incl. a valid .ipynb whose code cells
// have outputs, and a REPORT.md; the notebook executes cleanly (nbclient via `uv run --script harness/lib/nbcheck.py`,
// 120 s); the report page returns 200; ≤40 browser actions.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..', '..');
const NBCHECK = path.join(here, '..', 'lib', 'nbcheck.py');

/** Static validation + execution of a notebook; returns nbcheck's JSON (or an error object). */
export function checkNotebook(file, { execute = true, timeoutS = 120 } = {}) {
  const run = (cmd, args, ms) => spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', timeout: ms });
  // uv builds a self-contained venv from the script's inline metadata (nbclient, ipykernel, numpy, matplotlib, pillow).
  let res = run('uv', ['run', '--script', NBCHECK, file, ...(execute ? ['--execute', '--timeout', String(timeoutS)] : [])], (timeoutS + 240) * 1000);
  if (res.error || (res.status !== 0 && !res.stdout.trim().startsWith('{'))) {
    // uv unavailable/offline: static check with the backend interpreter (execution reported as skipped).
    res = run('uv', ['run', '--project', path.join(ROOT, 'backend'), 'python', NBCHECK, file], 60000);
  }
  const line = (res.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  if (!line) return { valid: false, errors: [`nbcheck produced no JSON: ${(res.stderr || res.error?.message || '').slice(-400)}`], executed: null };
  return JSON.parse(line);
}

export default {
  prompt: ({ wspUrl }) =>
    `Solve Lab 1 of CSCI3240 Introduction to Computer Vision (Lab_01_Image_Basics.pdf, on WSP at ${wspUrl} and in my vault): create a private GitHub repo, solve every task with code you actually run, push README.md, TODO.md, the notebook with outputs and REPORT.md, and save the report to my vault.`,
  realPrompt: () =>
    'Solve Lab 1 of CSCI3240 Introduction to Computer Vision from my vault: create a private GitHub repo, solve every task with code you actually run, push README.md, TODO.md, the notebook with outputs and REPORT.md, and save the report to my vault.',
  async expect(r, ctx) {
    const f = [];
    if (r.status !== 'done') f.push(`status is "${r.status}", expected "done" (${r.summary || 'no summary'})`);
    if (r.actions > 40) f.push(`${r.actions} browser actions, cap is 40`);
    const calls = ctx.connectorCalls;
    const names = calls.map((c) => c.tool);
    if (!names.includes('create_repository')) f.push(`no create_repository in the fake-connector log (calls: [${names.join(', ') || 'none'}])`);
    const pushes = calls.filter((c) => c.tool === 'push_files');
    if (!pushes.length) return [...f, `no push_files in the fake-connector log (calls: [${names.join(', ') || 'none'}])`];
    const files = pushes.flatMap((p) => (Array.isArray(p.args?.files) ? p.args.files : []));
    const paths = files.map((x) => String(x.path || ''));
    for (const want of ['README.md', 'TODO.md', 'REPORT.md']) if (!paths.some((p) => p === want || p.endsWith(`/${want}`))) f.push(`push_files has no ${want} (paths: [${paths.join(', ')}])`);
    const report = files.find((x) => /(^|\/)REPORT\.md$/.test(String(x.path || '')));
    if (report && String(report.content || '').trim().length < 200) f.push(`REPORT.md is too short (${String(report.content || '').length} chars)`);

    const nb = files.filter((x) => /\.ipynb$/.test(String(x.path || ''))).pop();
    if (!nb) f.push(`push_files has no .ipynb (paths: [${paths.join(', ')}])`);
    else {
      let doc = null;
      try {
        doc = typeof nb.content === 'string' ? JSON.parse(nb.content) : nb.content;
      } catch (e) {
        f.push(`${nb.path} is not JSON: ${e.message}`);
      }
      if (doc) {
        fs.mkdirSync(ctx.sceneOut, { recursive: true });
        const file = path.join(ctx.sceneOut, path.basename(String(nb.path)));
        fs.writeFileSync(file, JSON.stringify(doc, null, 1));
        const check = checkNotebook(file);
        r.notebook = { path: nb.path, saved: path.relative(ROOT, file), ...check };
        if (!check.valid) f.push(`${nb.path}: ${check.errors.join('; ')}`);
        else {
          if (check.code_cells < 5) f.push(`${nb.path} has ${check.code_cells} code cells, expected ≥5 (one per lab task)`);
          if (check.cells_with_nonempty_outputs < check.code_cells) f.push(`${nb.path}: ${check.code_cells - check.cells_with_nonempty_outputs} code cell(s) have empty outputs`);
        }
        if (check.executed === false) f.push(`${nb.path} failed to execute with nbclient: ${check.exec_error}`);
        else if (check.executed === null && check.valid) r.notebook.note = `execution skipped: ${check.exec_error || 'nbclient unavailable'}`;
      }
    }

    // Report page: an artifact href (any http(s) link whose page mentions the report / lab) must serve 200.
    const links = r.artifacts.filter((a) => /^https?:\/\//.test(a.href || ''));
    if (!links.length) f.push(`no artifact with an http(s) href for the report page (artifacts: ${JSON.stringify(r.artifacts)})`);
    else {
      let ok = false;
      const seen = [];
      for (const a of links) {
        try {
          const res = await ctx.fetch(a.href);
          const body = await res.text();
          seen.push(`${a.href} → ${res.status}`);
          if (res.status === 200 && /report|lab/i.test(a.label + body)) ok = true;
        } catch (e) {
          seen.push(`${a.href} → ${e.message}`);
        }
      }
      if (!ok) f.push(`no report page returned 200: ${seen.join('; ')}`);
    }
    const driveReport = ctx.driveFiles.filter((p) => /^Dayflow\/.+\.(md|html)$/i.test(p));
    if (!driveReport.length) f.push(`no report (.md/.html) under Dayflow/ in fake-Drive (entries: [${ctx.drive.join(', ') || 'empty'}])`);
    return f;
  },
};
