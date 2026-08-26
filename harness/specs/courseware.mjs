// Scene 2 — Courseware. PLAN: status done; a courseware artifact with an http(s) href that serves 200 HTML containing "Quiz".
export default {
  prompt: ({ wspUrl }) =>
    `Build a cheatsheet and a quiz from the CSCI3240 Introduction to Computer Vision syllabus on WSP (${wspUrl}) and open the result in a new tab.`,
  async expect(r, ctx) {
    const f = [];
    if (r.status !== 'done') f.push(`status is "${r.status}", expected "done" (${r.summary || 'no summary'})`);
    const links = r.artifacts.filter((a) => /^https?:\/\//.test(a.href || ''));
    if (!links.length) return [...f, `no artifact with an http(s) href (artifacts: ${JSON.stringify(r.artifacts)})`];
    let ok = false;
    const seen = [];
    for (const a of links) {
      try {
        const res = await ctx.fetch(a.href);
        const type = res.headers.get('content-type') || '';
        const body = await res.text();
        seen.push(`${a.href} → ${res.status} ${type}`);
        if (res.status === 200 && /html/i.test(type) && /Quiz/.test(body)) ok = true;
      } catch (e) {
        seen.push(`${a.href} → ${e.message}`);
      }
    }
    if (!ok) f.push(`no artifact href returned 200 HTML containing "Quiz": ${seen.join('; ')}`);
    return f;
  },
};
