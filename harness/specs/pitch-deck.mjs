// Scene 6 — Pitch deck (PLAN v2): a .pptx in fake-Drive that is a valid zip with ≥6 slides; a preview href serving 200 HTML.
// Beyond the plan's minimum this spec proves the two artifacts are one deck built by the brain: the preview is the
// brain's own PageStore page (GET /pages/deck/<id>), the .pptx it links serves the OpenXML bytes, that file is 16:9,
// carries every heading the preview shows, and the copy in fake-Drive is byte-identical to it and indexed in the vault.
import zlib from 'node:zlib';

const SLIDE_RE = /^ppt\/slides\/slide\d+\.xml$/;
const MIN_SLIDES = 6;
const PPTX_MIME = 'application/vnd.openxmlformats-officedocument.presentationml.presentation';

/** One member of a zip, inflated (central directory → local header → deflate stream). null when absent. */
function zipMember(buf, name) {
  let i = buf.length - 22;
  const stop = Math.max(0, buf.length - 65557);
  for (; i >= stop; i--) if (buf.readUInt32LE(i) === 0x06054b50) break;
  if (i < stop) throw new Error('not a zip: no end-of-central-directory record');
  const count = buf.readUInt16LE(i + 10);
  let p = buf.readUInt32LE(i + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip: bad central directory entry');
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    if (buf.toString('utf8', p + 46, p + 46 + nameLen) === name) {
      const method = buf.readUInt16LE(p + 10);
      const csize = buf.readUInt32LE(p + 20);
      const off = buf.readUInt32LE(p + 42);
      const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const textOf = (xml) => [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((m) => m[1]).join(' ');
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

/** Everything that makes a buffer the generated deck; `where` names it in the failures. */
function deckProblems(buf, where, ctx, headings = []) {
  const f = [];
  let entries;
  try {
    entries = ctx.zipEntries(buf);
  } catch (e) {
    return [`${where} is not a valid zip: ${e.message} (${buf.length} bytes)`];
  }
  if (!entries.includes('ppt/presentation.xml')) f.push(`${where} has no ppt/presentation.xml`);
  const slides = entries.filter((e) => SLIDE_RE.test(e));
  if (slides.length < MIN_SLIDES) f.push(`${where} has ${slides.length} slides, expected ≥${MIN_SLIDES}`);
  try {
    const pres = zipMember(buf, 'ppt/presentation.xml');
    const size = pres && /<p:sldSz[^>]*cx="(\d+)"[^>]*cy="(\d+)"/.exec(pres.toString('utf8'));
    if (size) {
      const ratio = Number(size[1]) / Number(size[2]);
      if (ratio < 1.7 || ratio > 1.85) f.push(`${where} is not 16:9 (slide size ratio ${ratio.toFixed(2)})`);
    } else if (pres) f.push(`${where}: ppt/presentation.xml has no <p:sldSz>`);
    const text = norm(slides.map((s) => textOf(zipMember(buf, s)?.toString('utf8') ?? '')).join(' '));
    if (text.length < 200) f.push(`${where} carries almost no text (${text.length} chars): "${text.slice(0, 120)}"`);
    const missing = headings.filter((h) => norm(h).length > 2 && !text.includes(norm(h)));
    if (missing.length) f.push(`${where} is missing the preview's headings [${missing.join(', ')}] (slide text: "${text.slice(0, 200)}…")`);
  } catch (e) {
    f.push(`${where}: could not read the slide XML: ${e.message}`);
  }
  return f;
}

export default {
  prompt: () => 'Build a pitch deck about my diploma project repo (dayflow-student/diploma on GitHub), save it to my vault and open the preview.',
  async expect(r, ctx) {
    const f = [];
    if (r.status !== 'done') f.push(`status is "${r.status}", expected "done" (${r.summary || 'no summary'})`);

    // 1. The preview: an artifact linking the brain's own deck page (GET /pages/deck/<id>), serving 200 HTML.
    // The run also links the Drive copies (the fake Drive answers /view/<id> with an HTML viewer), so the page
    // is picked by identity — brain origin + /pages/deck/, not the ".pptx" download URL — never "first HTML".
    const withHref = r.artifacts.filter((a) => /^https?:\/\//.test(a.href || ''));
    if (!withHref.length) f.push(`no artifact with an http(s) href for the preview (artifacts: ${JSON.stringify(r.artifacts)})`);
    const isDeckPage = (href) => {
      try {
        const u = new URL(href);
        return u.origin === new URL(ctx.brainUrl).origin && u.pathname.startsWith('/pages/deck/') && !u.pathname.endsWith('.pptx');
      } catch {
        return false;
      }
    };
    const pageLinks = withHref.filter((a) => isDeckPage(a.href));
    if (withHref.length && !pageLinks.length) {
      f.push(`no artifact links a brain deck page (${ctx.brainUrl}/pages/deck/…); artifacts: ${JSON.stringify(withHref.map((a) => a.href))}`);
    }
    let preview = null;
    const seen = [];
    for (const a of pageLinks) {
      try {
        const res = await ctx.fetch(a.href);
        const type = res.headers.get('content-type') || '';
        const body = await res.text();
        seen.push(`${a.href} → ${res.status} ${type}`);
        if (res.status === 200 && /html/i.test(type) && !preview) preview = { href: a.href, body };
      } catch (e) {
        seen.push(`${a.href} → ${e.message}`);
      }
    }
    if (pageLinks.length && !preview) f.push(`the deck preview page did not return 200 HTML: ${seen.join('; ')}`);
    let headings = [];
    let served = null;
    if (preview) {
      headings = [...preview.body.matchAll(/<h2>([\s\S]*?)<\/h2>/g)].map((m) => m[1]);
      if (headings.length < MIN_SLIDES - 1) f.push(`the preview shows ${headings.length} slide headings, expected ≥${MIN_SLIDES - 1} (+ the cover)`);
      // 2. The .pptx the preview links is served by the brain with the OpenXML type.
      const link = /href="([^"]*\/pages\/deck\/[^"]+\.pptx)"/.exec(preview.body);
      if (!link) f.push(`the preview page has no link to its .pptx (${preview.href})`);
      else {
        try {
          const res = await ctx.fetch(link[1]);
          if (res.status !== 200) f.push(`${link[1]} → HTTP ${res.status}, expected 200`);
          else {
            const type = res.headers.get('content-type') || '';
            if (!type.startsWith(PPTX_MIME)) f.push(`${link[1]} served content-type "${type}", expected ${PPTX_MIME}`);
            served = Buffer.from(await res.arrayBuffer());
            f.push(...deckProblems(served, `the deck served at ${link[1]}`, ctx, headings));
          }
        } catch (e) {
          f.push(`${link[1]} → ${e.message}`);
        }
      }
    }

    // 3. The vault copy: every .pptx in fake-Drive is a real deck, and one of them is the served file byte for byte.
    const decks = ctx.driveFiles.filter((p) => /^Dayflow\/.+\.pptx$/i.test(p));
    if (!decks.length) f.push(`no .pptx under Dayflow/ in fake-Drive (entries: [${ctx.drive.join(', ') || 'empty'}])`);
    for (const d of decks) f.push(...deckProblems(ctx.readDrive(d), d, ctx, headings));
    if (served && decks.length && !decks.some((d) => ctx.readDrive(d).equals(served))) {
      f.push(`no .pptx in fake-Drive matches the deck the brain served (Drive: [${decks.map((d) => `${d} ${ctx.readDrive(d).length}B`).join(', ')}], served ${served.length}B)`);
    }

    // 4. The brain indexed the deck too (download → POST /vault/upload), so it is in the vault, not only in Drive.
    const entries = Array.isArray(ctx.vault) ? ctx.vault : Array.isArray(ctx.vault?.files) ? ctx.vault.files : null;
    if (!entries) f.push(`GET /vault did not return a list: ${JSON.stringify(ctx.vault).slice(0, 160)}`);
    else if (!entries.some((e) => /\.pptx$/i.test(String(e.path ?? '')))) {
      f.push(`the brain's vault index has no .pptx entry (paths: [${entries.map((e) => e.path).join(', ') || 'empty'}])`);
    }
    return f;
  },
};
