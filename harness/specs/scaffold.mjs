// Scene 3 — Vault scaffold. PLAN: ≥5 `.keep` files under DayflowVault/CSCI3240*/Week NN/.
export default {
  prompt: ({ wspUrl }) =>
    `Create the vault folder tree for the CSCI3240 Introduction to Computer Vision course from its syllabus on WSP (${wspUrl}): one folder per week and per lab.`,
  expect(r, ctx) {
    const f = [];
    if (r.status !== 'done') f.push(`status is "${r.status}", expected "done" (${r.summary || 'no summary'})`);
    const keeps = ctx.files.filter((p) => /^DayflowVault\/CSCI3240[^/]*\/Week \d{2}\/\.keep$/.test(p));
    if (keeps.length < 5) f.push(`expected ≥5 .keep files under DayflowVault/CSCI3240*/Week NN/, found ${keeps.length}: [${ctx.files.join(', ') || 'none'}]`);
    return f;
  },
};
