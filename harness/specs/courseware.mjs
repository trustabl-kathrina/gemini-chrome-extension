// Scene 4 — Courseware (PLAN v2): an artifact href serves 200 HTML containing "Quiz"; the HTML is saved in fake-Drive.
export default {
  prompt: ({ wspUrl }) => `Build a cheatsheet and a quiz from the CSCI3240 Introduction to Computer Vision syllabus (on WSP at ${wspUrl} / in my vault), open the result in a new tab and save it to my vault.`,
  realPrompt: () => 'Build a cheatsheet and a quiz from the CSCI3240 Introduction to Computer Vision syllabus in my vault, open the result in a new tab and save it to my vault.',
  async expect(r, ctx) {
    const f = [];
    if (r.status !== 'done') f.push(`status is "${r.status}", expected "done" (${r.summary || 'no summary'})`);
    const links = r.artifacts.filter((a) => /^https?:\/\//.test(a.href || ''));
    if (!links.length) f.push(`no artifact with an http(s) href (artifacts: ${JSON.stringify(r.artifacts)})`);
    else {
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
    }
    const html = ctx.driveFiles.filter((p) => /^Dayflow\/.+\.html?$/i.test(p));
    if (!html.length) f.push(`no .html under Dayflow/ in fake-Drive (entries: [${ctx.drive.join(', ') || 'empty'}])`);
    else if (!html.some((p) => /Quiz/.test(ctx.readDrive(p).toString('utf8')))) f.push(`Drive HTML has no "Quiz": [${html.join(', ')}]`);
    return f;
  },
};
