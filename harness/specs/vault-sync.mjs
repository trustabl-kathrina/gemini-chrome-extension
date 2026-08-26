// Scene 1 — Vault sync. PLAN: status done; 3 files under DayflowVault/CSCI3240*/…; ≤40 actions.
export default {
  prompt: ({ wspUrl }) =>
    `Sync the CSCI3240 Introduction to Computer Vision course files from WSP (${wspUrl}) into my vault and tell me what changed.`,
  expect(r, ctx) {
    const f = [];
    if (r.status !== 'done') f.push(`status is "${r.status}", expected "done" (${r.summary || 'no summary'})`);
    const pdfs = ctx.files.filter((p) => /^DayflowVault\/CSCI3240[^/]*\/.+\.pdf$/i.test(p));
    if (pdfs.length < 3) f.push(`expected 3 files under DayflowVault/CSCI3240*/, found ${pdfs.length}: [${ctx.files.join(', ') || 'nothing downloaded'}]`);
    if (r.actions > 40) f.push(`${r.actions} browser actions, cap is 40`);
    return f;
  },
};
