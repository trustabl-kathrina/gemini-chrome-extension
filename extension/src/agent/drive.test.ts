import { describe, expect, it, vi } from 'vitest';
import { DriveClient, FOLDER_MIME, fileNameFromHeaders, mimeFor, q, splitDrivePath } from './drive';

describe('path helpers', () => {
  it('splits and cleans vault paths', () => {
    expect(splitDrivePath('Dayflow/CSCI3240 CV/Lab 01/x.pdf')).toEqual(['Dayflow', 'CSCI3240 CV', 'Lab 01', 'x.pdf']);
    expect(splitDrivePath('/a//b/../c/./d')).toEqual(['a', 'b', 'c', 'd']);
    expect(splitDrivePath('')).toEqual([]);
  });
  it('escapes Drive query literals', () => {
    expect(q("Student's files")).toBe("'Student\\'s files'");
  });
  it('guesses mime types', () => {
    expect(mimeFor('a.PDF')).toBe('application/pdf');
    expect(mimeFor('deck.pptx')).toContain('presentationml');
    expect(mimeFor('blob')).toBe('application/octet-stream');
  });
  it('reads file names from Content-Disposition, else the URL', () => {
    expect(fileNameFromHeaders(new Headers({ 'content-disposition': 'attachment; filename="Lab 01.pdf"' }), 'http://x/y')).toBe('Lab 01.pdf');
    expect(fileNameFromHeaders(new Headers({ 'content-disposition': "attachment; filename*=UTF-8''L%C3%A9on.pdf" }), 'http://x/y')).toBe('Léon.pdf');
    expect(fileNameFromHeaders(new Headers(), 'http://x/files/A/B/syllabus.pdf?dl=1')).toBe('syllabus.pdf');
    expect(fileNameFromHeaders(new Headers(), 'http://x/')).toBe('download.bin');
  });
});

/** In-memory Drive: folders/files keyed by parent+name, mirroring the harness fake's contract. */
function fakeDrive() {
  const files = new Map<string, { id: string; name: string; mimeType: string; parents: string[]; bytes?: string }>();
  let n = 0;
  const log: string[] = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    log.push(`${method} ${url.pathname}`);
    const auth = (init?.headers as Record<string, string>)?.authorization;
    if (auth !== 'Bearer tok') return new Response('{"error":"no auth"}', { status: 401 });
    if (method === 'GET' && url.pathname === '/drive/v3/files') {
      const query = url.searchParams.get('q') ?? '';
      const name = /name = '((?:[^'\\]|\\.)*)'/.exec(query)?.[1]?.replace(/\\'/g, "'");
      const parent = /'([^']+)' in parents/.exec(query)?.[1];
      const mime = /mimeType (=|!=) '([^']+)'/.exec(query);
      const out = [...files.values()].filter((f) => (!name || f.name === name) && (!parent || f.parents.includes(parent)) && (!mime || (f.mimeType === mime[2]) === (mime[1] === '=')));
      return new Response(JSON.stringify({ files: out }), { status: 200 });
    }
    if (method === 'POST' && url.pathname === '/drive/v3/files') {
      const md = JSON.parse(init?.body as string) as { name: string; mimeType: string; parents: string[] };
      const f = { id: `id${++n}`, ...md };
      files.set(f.id, f);
      return new Response(JSON.stringify(f), { status: 200 });
    }
    if (url.pathname.startsWith('/upload/drive/v3/files')) {
      const body = init?.body as Blob;
      const text = await body.text();
      const ct = (init?.headers as Record<string, string>)['content-type'] ?? '';
      const boundary = /boundary=(.+)$/.exec(ct)?.[1];
      const parts = text.split(`--${boundary}`).filter((p) => p.trim() && p.trim() !== '--');
      const meta = JSON.parse(parts[0]?.split('\r\n\r\n')[1] ?? '{}') as { name: string; mimeType: string; parents?: string[] };
      const bytes = (parts[1]?.split('\r\n\r\n')[1] ?? '').replace(/\r\n$/, '');
      const existingId = url.pathname.split('/').pop();
      if (method === 'PATCH' && existingId && files.has(existingId)) {
        const f = { ...files.get(existingId)!, bytes };
        files.set(existingId, f);
        return new Response(JSON.stringify(f), { status: 200 });
      }
      const f = { id: `id${++n}`, name: meta.name, mimeType: meta.mimeType, parents: meta.parents ?? ['root'], bytes };
      files.set(f.id, f);
      return new Response(JSON.stringify({ ...f, webViewLink: `https://drive/view/${f.id}` }), { status: 200 });
    }
    return new Response('{}', { status: 404 });
  });
  return { files, log, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe('DriveClient', () => {
  it('creates the folder chain once and uploads bytes as multipart/related', async () => {
    const d = fakeDrive();
    const c = new DriveClient({ base: 'https://drive.test/', token: 'tok', fetch: d.fetchImpl });
    const f1 = await c.upload('Dayflow/CSCI3240 CV/Lab 01/lab.pdf', new Blob(['%PDF-1.4 hello'], { type: 'application/pdf' }));
    expect(f1.name).toBe('lab.pdf');
    const folders = [...d.files.values()].filter((f) => f.mimeType === FOLDER_MIME).map((f) => f.name);
    expect(folders).toEqual(['Dayflow', 'CSCI3240 CV', 'Lab 01']);
    expect([...d.files.values()].find((f) => f.name === 'lab.pdf')?.bytes).toBe('%PDF-1.4 hello');

    // second file in the same folder: chain resolved from the cache, no new folders
    const before = d.log.filter((l) => l.startsWith('POST /drive/v3/files')).length;
    await c.upload('Dayflow/CSCI3240 CV/Lab 01/notes.md', new Blob(['# notes']));
    expect(d.log.filter((l) => l.startsWith('POST /drive/v3/files')).length).toBe(before);
    expect(folders.length).toBe(3);

    // same name again → replaced in place (PATCH), not duplicated
    await c.upload('Dayflow/CSCI3240 CV/Lab 01/lab.pdf', new Blob(['%PDF-1.4 v2']));
    const pdfs = [...d.files.values()].filter((f) => f.name === 'lab.pdf');
    expect(pdfs).toHaveLength(1);
    expect(pdfs[0]?.bytes).toBe('%PDF-1.4 v2');
    expect(d.log.some((l) => l.startsWith('PATCH /upload/'))).toBe(true);
  });

  it('lists a folder by path and returns [] for a missing one', async () => {
    const d = fakeDrive();
    const c = new DriveClient({ base: 'https://drive.test', token: 'tok', fetch: d.fetchImpl });
    await c.upload('Dayflow/A/x.txt', new Blob(['x']));
    expect((await c.list('Dayflow/A')).map((f) => f.name)).toEqual(['x.txt']);
    expect(await c.list('Dayflow/Nope')).toEqual([]);
  });

  it('surfaces HTTP errors with the status', async () => {
    const d = fakeDrive();
    const c = new DriveClient({ base: 'https://drive.test', token: 'bad', fetch: d.fetchImpl });
    await expect(c.ensureFolder('Dayflow')).rejects.toThrow(/HTTP 401/);
  });

  it('refreshes an expired token on 401 and retries the request once', async () => {
    const d = fakeDrive();
    const stale: string[] = [];
    const c = new DriveClient({
      base: 'https://drive.test',
      token: 'expired',
      fetch: d.fetchImpl,
      onUnauthorized: async (t) => {
        stale.push(t);
        return 'tok';
      },
    });
    const f = await c.upload('Dayflow/A/x.txt', new Blob(['x']));
    expect(f.name).toBe('x.txt');
    expect(stale).toEqual(['expired']); // only the first call needed it; the fresh token is kept
    expect(c.accessToken).toBe('tok');
  });

  it('gives up after one retry: a still-bad or unrefreshable token surfaces the 401', async () => {
    const d = fakeDrive();
    const calls: string[] = [];
    const again = new DriveClient({
      base: 'https://drive.test',
      token: 'expired',
      fetch: d.fetchImpl,
      onUnauthorized: async (t) => {
        calls.push(t);
        return 'still-bad';
      },
    });
    await expect(again.list('Dayflow')).rejects.toThrow(/HTTP 401/);
    expect(calls).toEqual(['expired']); // one refresh, one retry, then the error

    const none = new DriveClient({ base: 'https://drive.test', token: 'expired', fetch: d.fetchImpl, onUnauthorized: async () => null });
    await expect(none.list('Dayflow')).rejects.toThrow(/HTTP 401/);
  });
});
