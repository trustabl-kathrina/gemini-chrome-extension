// Scene 5 — Vault scaffold (PLAN v2): ≥15 folders under Dayflow/<course>/ in fake-Drive, derived from the syllabus schedule.
// Beyond the plan's minimum this spec checks the tree is the *syllabus'* tree and lands where the vault lives:
// every week of the 15-week schedule has its own "Week NN …" folder, the labs have theirs, and nothing is nested
// under a second "Dayflow/" (the model must pass vault-relative paths, the extension adds the vault folder).
const SEMESTER_WEEKS = 15;

export default {
  prompt: ({ wspUrl }) => `Create the vault folder tree for the CSCI3240 Introduction to Computer Vision course from its syllabus (on WSP at ${wspUrl} / in my vault): one folder per week and per lab.`,
  realPrompt: () => 'Create the vault folder tree for the CSCI3240 Introduction to Computer Vision course from its syllabus in my vault: one folder per week and per lab.',
  expect(r, ctx) {
    const f = [];
    if (r.status !== 'done') f.push(`status is "${r.status}", expected "done" (${r.summary || 'no summary'})`);

    // 1. The plan's expectation: ≥15 folders under the course folder in the vault.
    const folders = ctx.driveFolders.filter((p) => /^Dayflow\/CSCI3240[^/]*\/.+/.test(p));
    if (folders.length < SEMESTER_WEEKS) f.push(`expected ≥${SEMESTER_WEEKS} folders under Dayflow/CSCI3240*/ in fake-Drive, found ${folders.length}: [${ctx.drive.join(', ') || 'empty'}]`);

    // 2. It is the syllabus' schedule: every week 01..15 and at least one lab folder.
    const names = folders.map((p) => p.split('/').pop());
    const weeks = new Set(names.map((n) => /^Week\s+(\d{2})\b/.exec(n)?.[1]).filter(Boolean));
    const missing = [...Array(SEMESTER_WEEKS).keys()].map((i) => String(i + 1).padStart(2, '0')).filter((w) => !weeks.has(w));
    if (missing.length) f.push(`no folder for week(s) ${missing.join(', ')} (week folders: [${[...weeks].sort().join(', ') || 'none'}]; all: [${names.join(', ') || 'none'}])`);
    const labs = names.filter((n) => /^Lab\s+\d{2}\b/.test(n));
    if (!labs.length) f.push(`no "Lab NN" folder under Dayflow/CSCI3240*/ (folders: [${names.join(', ') || 'none'}])`);

    // 3. The vault folder is not nested inside itself (vault-relative paths, prefixed once by the extension).
    const nested = ctx.driveFolders.filter((p) => /^Dayflow\/Dayflow(\/|$)/.test(p));
    if (nested.length) f.push(`the tree was created under a second vault folder: [${nested.join(', ')}]`);
    return f;
  },
};
