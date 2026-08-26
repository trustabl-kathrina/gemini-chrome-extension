// Scene 1 — Vault sync (PLAN v2): status done; fake-Drive has the 3 CV files under Dayflow/CSCI3240*/…;
// the brain's vault index (GET /vault) has 3 entries for them; ≤40 browser actions.
const COURSE_FILES = ['syllabus.pdf', 'Lecture_01_Introduction.pdf', 'Lab_01_Image_Basics.pdf'];

export default {
  prompt: ({ wspUrl }) => `Sync the CSCI3240 Introduction to Computer Vision course files from WSP (${wspUrl}) into my vault and tell me what changed.`,
  // The real portal's course/instructor names are personal data: pass them via HARNESS_PROMPT (never committed).
  realPrompt: () =>
    'Sync the files of my Computer Vision course (Spring 2025-2026; find the instructor in the schedule) from WSP into my vault; if that folder is missing, say so and sync another course of that term instead.',
  expect(r, ctx) {
    const f = [];
    if (r.status !== 'done') f.push(`status is "${r.status}", expected "done" (${r.summary || 'no summary'})`);
    if (ctx.real && ctx.vaultMode === 'brain') {
      // Real portal without a Drive client: the brain keeps the files. Either ≥1 vault entry, or an honest
      // statement that the requested folder is missing (the portal's content is not under the harness's control).
      const entries = Array.isArray(ctx.vault) ? ctx.vault : null;
      if (!entries) f.push(`GET /vault did not return a list: ${JSON.stringify(ctx.vault).slice(0, 160)}`);
      else if (entries.length === 0 && !/missing|not found|no such|could not find|couldn't find|does not exist|not present|absent/i.test(r.summary)) {
        f.push(`vault is empty and the summary does not say the folder is missing: ${r.summary.slice(0, 200)}`);
      }
      if (r.actions > 40) f.push(`${r.actions} browser actions, cap is 40`);
      return f;
    }
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
