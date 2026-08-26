// Scene 1 — Vault sync (PLAN v2): status done; fake-Drive has the 3 CV files under Dayflow/CSCI3240*/…;
// the brain's vault index (GET /vault) has 3 entries for them; ≤40 browser actions.
const COURSE_FILES = ['syllabus.pdf', 'Lecture_01_Introduction.pdf', 'Lab_01_Image_Basics.pdf'];

export default {
  prompt: ({ wspUrl }) => `Sync the CSCI3240 Introduction to Computer Vision course files from WSP (${wspUrl}) into my vault and tell me what changed.`,
  realPrompt: () => 'Sync the CSCI3240 Introduction to Computer Vision course files from WSP into my vault and tell me what changed.',
  expect(r, ctx) {
    const f = [];
    if (r.status !== 'done') f.push(`status is "${r.status}", expected "done" (${r.summary || 'no summary'})`);
    const pdfs = ctx.driveFiles.filter((p) => /^Dayflow\/CSCI3240[^/]*\/.+\.pdf$/i.test(p));
    if (pdfs.length < 3) f.push(`expected 3 PDFs under Dayflow/CSCI3240*/ in fake-Drive, found ${pdfs.length}: [${ctx.drive.join(', ') || 'empty'}]`);
    for (const name of COURSE_FILES) {
      const hit = pdfs.find((p) => p.endsWith(`/${name}`));
      if (!hit) f.push(`${name} missing from fake-Drive (Dayflow/CSCI3240*/…)`);
      else if (ctx.readDrive(hit).subarray(0, 5).toString() !== '%PDF-') f.push(`${hit} is not a PDF (bytes were not the portal's file)`);
    }
    const vault = ctx.vault;
    const entries = Array.isArray(vault) ? vault : Array.isArray(vault?.items) ? vault.items : Array.isArray(vault?.files) ? vault.files : null;
    if (!entries) f.push(`GET /vault did not return a list: ${JSON.stringify(vault).slice(0, 160)}`);
    else {
      const cv = entries.filter((e) => /CSCI3240/.test(JSON.stringify(e)));
      if (cv.length < 3) f.push(`vault index has ${cv.length} CSCI3240 entries, expected 3 (total ${entries.length})`);
    }
    if (r.actions > 40) f.push(`${r.actions} browser actions, cap is 40`);
    return f;
  },
};
