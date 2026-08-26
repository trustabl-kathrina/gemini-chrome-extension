// Scene 6 — Pitch deck (PLAN v2): a .pptx in fake-Drive that is a valid zip with ≥6 slides; a preview href serving 200 HTML.
export default {
  prompt: () => 'Build a pitch deck about my diploma project repo (dayflow-student/diploma on GitHub), save it to my vault and open the preview.',
  async expect(r, ctx) {
    const f = [];
    if (r.status !== 'done') f.push(`status is "${r.status}", expected "done" (${r.summary || 'no summary'})`);
    const decks = ctx.driveFiles.filter((p) => /^Dayflow\/.+\.pptx$/i.test(p));
    if (!decks.length) f.push(`no .pptx under Dayflow/ in fake-Drive (entries: [${ctx.drive.join(', ') || 'empty'}])`);
    for (const d of decks) {
      try {
        const entries = ctx.zipEntries(ctx.readDrive(d));
        const slides = entries.filter((e) => /^ppt\/slides\/slide\d+\.xml$/.test(e));
        if (!entries.includes('ppt/presentation.xml')) f.push(`${d} has no ppt/presentation.xml`);
        if (slides.length < 6) f.push(`${d} has ${slides.length} slides, expected ≥6`);
      } catch (e) {
        f.push(`${d} is not a valid zip: ${e.message}`);
      }
    }
    const withHref = r.artifacts.filter((a) => /^https?:\/\//.test(a.href || ''));
    if (!withHref.length) return [...f, `no artifact with an http(s) href for the preview (artifacts: ${JSON.stringify(r.artifacts)})`];
    let ok = false;
    const seen = [];
    for (const a of withHref) {
      try {
        const res = await ctx.fetch(a.href);
        seen.push(`${a.href} → ${res.status}`);
        if (res.status === 200 && /html/i.test(res.headers.get('content-type') || '')) ok = true;
      } catch (e) {
        seen.push(`${a.href} → ${e.message}`);
      }
    }
    if (!ok) f.push(`deck preview href did not return 200 HTML: ${seen.join('; ')}`);
    return f;
  },
};
