// Scene 4 — Courseware (PLAN v2): an artifact href serves 200 HTML containing "Quiz"; the HTML is saved in fake-Drive.
// Beyond the plan's minimum this spec checks that the page really is the generated courseware — the brain's own
// PageStore page (GET /pages/courseware/<id>), a cheatsheet plus ten quiz questions whose answers are folded into
// <details> — and that the copy in the vault (Drive + the brain's index) is those same bytes, not a stub.
const QUIZ_QUESTIONS = 10;

/** What makes an HTML string the courseware page (the same checks for the served page and the Drive copy). */
function pageProblems(html, where) {
  const f = [];
  if (!/<h2>Quiz<\/h2>/.test(html)) f.push(`${where} has no "Quiz" section (${html.length} bytes, starts ${JSON.stringify(html.slice(0, 80))})`);
  if (!/<h2>Cheatsheet<\/h2>/.test(html)) f.push(`${where} has no "Cheatsheet" section`);
  const details = (html.match(/<details>/g) ?? []).length;
  const answers = (html.match(/<summary>Show answer<\/summary>/g) ?? []).length;
  if (details !== QUIZ_QUESTIONS || answers !== QUIZ_QUESTIONS)
    f.push(`${where} has ${details} <details> / ${answers} "Show answer" blocks, expected ${QUIZ_QUESTIONS} quiz questions with hidden answers`);
  return f;
}

export default {
  prompt: ({ wspUrl }) => `Build a cheatsheet and a quiz from the CSCI3240 Introduction to Computer Vision syllabus (on WSP at ${wspUrl} / in my vault), open the result in a new tab and save it to my vault.`,
  realPrompt: () => 'Build a cheatsheet and a quiz from the CSCI3240 Introduction to Computer Vision syllabus in my vault, open the result in a new tab and save it to my vault.',
  async expect(r, ctx) {
    const f = [];
    if (r.status !== 'done') f.push(`status is "${r.status}", expected "done" (${r.summary || 'no summary'})`);
    if (r.actions > 60) f.push(`${r.actions} browser actions, cap is 60`);

    // 1. An artifact href that serves the page: 200, HTML, "Quiz".
    const links = r.artifacts.filter((a) => /^https?:\/\//.test(a.href || ''));
    if (!links.length) f.push(`no artifact with an http(s) href (artifacts: ${JSON.stringify(r.artifacts)})`);
    else {
      let served = null;
      const seen = [];
      for (const a of links) {
        try {
          const res = await ctx.fetch(a.href);
          const type = res.headers.get('content-type') || '';
          const body = await res.text();
          seen.push(`${a.href} → ${res.status} ${type}`);
          if (res.status === 200 && /html/i.test(type) && /Quiz/.test(body) && !served) served = { href: a.href, body };
        } catch (e) {
          seen.push(`${a.href} → ${e.message}`);
        }
      }
      if (!served) f.push(`no artifact href returned 200 HTML containing "Quiz": ${seen.join('; ')}`);
      else f.push(...pageProblems(served.body, `the served page ${served.href}`));
    }

    // 2. It is the brain's own courseware page — generate_courseware stored it, the panel linked it.
    const onBrain = (href) => {
      try {
        const u = new URL(href);
        return u.origin === new URL(ctx.brainUrl).origin && u.pathname.startsWith('/pages/courseware/');
      } catch {
        return false;
      }
    };
    if (!links.some((a) => onBrain(a.href))) f.push(`no artifact links a brain courseware page (${ctx.brainUrl}/pages/courseware/…); artifacts: ${JSON.stringify(r.artifacts.map((a) => a.href))}`);

    // 3. The vault copy in fake-Drive is those same bytes.
    const html = ctx.driveFiles.filter((p) => /^Dayflow\/.+\.html?$/i.test(p));
    if (!html.length) f.push(`no .html under Dayflow/ in fake-Drive (entries: [${ctx.drive.join(', ') || 'empty'}])`);
    else {
      const good = html.filter((p) => pageProblems(ctx.readDrive(p).toString('utf8'), p).length === 0);
      if (!good.length) f.push(...pageProblems(ctx.readDrive(html[0]).toString('utf8'), html[0]));
    }

    // 4. The brain indexed it too (download → POST /vault/upload), so the page is in the vault, not only in Drive.
    const entries = Array.isArray(ctx.vault) ? ctx.vault : Array.isArray(ctx.vault?.items) ? ctx.vault.items : Array.isArray(ctx.vault?.files) ? ctx.vault.files : null;
    if (!entries) f.push(`GET /vault did not return a list: ${JSON.stringify(ctx.vault).slice(0, 160)}`);
    else if (!entries.some((e) => /\.html?$/i.test(String(e.path ?? '')))) f.push(`the brain's vault index has no .html entry (paths: [${entries.map((e) => e.path).join(', ') || 'empty'}])`);
    return f;
  },
};
