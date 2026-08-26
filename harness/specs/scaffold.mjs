// Scene 5 — Vault scaffold (PLAN v2): ≥15 folders under Dayflow/<course>/ in fake-Drive, derived from the syllabus schedule.
export default {
  prompt: ({ wspUrl }) => `Create the vault folder tree for the CSCI3240 Introduction to Computer Vision course from its syllabus (on WSP at ${wspUrl} / in my vault): one folder per week and per lab.`,
  realPrompt: () => 'Create the vault folder tree for the CSCI3240 Introduction to Computer Vision course from its syllabus in my vault: one folder per week and per lab.',
  expect(r, ctx) {
    const f = [];
    if (r.status !== 'done') f.push(`status is "${r.status}", expected "done" (${r.summary || 'no summary'})`);
    const folders = ctx.driveFolders.filter((p) => /^Dayflow\/CSCI3240[^/]*\/.+/.test(p));
    if (folders.length < 15) f.push(`expected ≥15 folders under Dayflow/CSCI3240*/ in fake-Drive, found ${folders.length}: [${ctx.drive.join(', ') || 'empty'}]`);
    return f;
  },
};
