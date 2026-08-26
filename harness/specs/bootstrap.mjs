// Scene 4 — Project bootstrap. PLAN: fake-connector log has create_repository + push_files with README.md, TODO.md and a valid .ipynb.
export default {
  prompt: ({ wspUrl }) =>
    `Bootstrap a GitHub repo for Computer Vision Lab 1 (Lab_01_Image_Basics.pdf under CSCI3240 on WSP, ${wspUrl}) with a starter notebook and a TODO list.`,
  expect(r, ctx) {
    const f = [];
    if (r.status !== 'done') f.push(`status is "${r.status}", expected "done" (${r.summary || 'no summary'})`);
    const calls = ctx.connectorCalls;
    const names = calls.map((c) => c.tool);
    if (!names.includes('create_repository')) f.push(`no create_repository in the fake-connector log (calls: [${names.join(', ') || 'none'}])`);
    const pushes = calls.filter((c) => c.tool === 'push_files');
    if (!pushes.length) return [...f, `no push_files in the fake-connector log (calls: [${names.join(', ') || 'none'}])`];
    const files = pushes.flatMap((p) => (Array.isArray(p.args?.files) ? p.args.files : []));
    const paths = files.map((x) => String(x.path || ''));
    for (const want of ['README.md', 'TODO.md']) if (!paths.some((p) => p === want || p.endsWith(`/${want}`))) f.push(`push_files has no ${want} (paths: [${paths.join(', ')}])`);
    const nb = files.find((x) => /\.ipynb$/.test(String(x.path || '')));
    if (!nb) f.push(`push_files has no .ipynb (paths: [${paths.join(', ')}])`);
    else {
      try {
        const doc = JSON.parse(String(nb.content));
        if (!(Number(doc.nbformat) >= 4) || !Array.isArray(doc.cells)) f.push(`${nb.path} is not valid nbformat (nbformat=${doc.nbformat}, cells=${Array.isArray(doc.cells)})`);
      } catch (e) {
        f.push(`${nb.path} is not JSON: ${e.message}`);
      }
    }
    return f;
  },
};
