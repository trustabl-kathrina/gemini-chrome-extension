import { describe, expect, it } from 'vitest';
import { AdkAdapter, parseSse } from './adk';

describe('AdkAdapter', () => {
  it('streams partial text and swallows the aggregated repeat', () => {
    const a = new AdkAdapter();
    const r1 = a.map({ partial: true, content: { parts: [{ text: 'Hel' }] } });
    const r2 = a.map({ partial: true, content: { parts: [{ text: 'lo' }] } });
    const r3 = a.map({ content: { parts: [{ text: 'Hello' }] } });
    expect(r1.events).toEqual([{ kind: 'text', text: 'Hel', partial: true }]);
    expect(r2.events).toEqual([{ kind: 'text', text: 'lo', partial: true }]);
    expect(r3.events).toEqual([{ kind: 'text', text: '', partial: false }]);
    expect(a.lastText).toBe('Hello');
  });

  it('routes long-running calls to the browser and others to the server', () => {
    const a = new AdkAdapter();
    const r = a.map({
      longRunningToolIds: ['c1'],
      content: {
        parts: [
          { functionCall: { id: 'c1', name: 'read_page', args: {} } },
          { functionCall: { id: 'c2', name: 'parse_document', args: { file: 'x.pdf' } } },
        ],
      },
    });
    expect(r.pending).toEqual([{ id: 'c1', name: 'read_page', args: {}, kind: 'browser' }]);
    expect(r.events.map((e) => e.kind === 'tool.call' && e.target)).toEqual(['browser', 'server']);
  });

  it('maps confirmations and server tool responses', () => {
    const a = new AdkAdapter();
    const r1 = a.map({ longRunningToolIds: ['k1'], content: { parts: [{ functionCall: { id: 'k1', name: 'request_confirmation', args: { message: 'Send?' } } }] } }, 1000);
    expect(r1.events).toEqual([{ kind: 'confirm', id: 'k1', message: 'Send?' }]);
    expect(r1.pending[0]?.kind).toBe('confirm');
    a.map({ content: { parts: [{ functionCall: { id: 's1', name: 'embed', args: {} } }] } }, 2000);
    const r2 = a.map({ content: { parts: [{ functionResponse: { id: 's1', name: 'embed', response: { status: 'error', message: 'quota' } } }] } }, 2500);
    expect(r2.events).toEqual([{ kind: 'tool.result', callId: 's1', ok: false, summary: 'quota', ms: 500 }]);
  });
});

describe('parseSse', () => {
  it('splits events across chunk boundaries', async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('data: {"a":1}\n\nda'));
        c.enqueue(enc.encode('ta: {"a":2}\n\n'));
        c.close();
      },
    });
    const out: unknown[] = [];
    for await (const e of parseSse<{ a: number }>(body)) out.push(e);
    expect(out).toEqual([{ a: 1 }, { a: 2 }]);
  });
});
