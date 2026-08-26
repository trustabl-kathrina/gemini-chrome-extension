import { describe, expect, it } from 'vitest';
import { AdkAdapter, confirmMessage, parseSse, summarise } from './adk';
import { uniqueById } from './live';

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

describe('AdkAdapter.lastError', () => {
  it('records a streamed errorMessage so the run can end as an error', () => {
    const a = new AdkAdapter();
    const r = a.map({ errorMessage: 'RefreshError: invalid_grant', author: 'dayflow' });
    expect(r.events).toEqual([{ kind: 'text', text: 'Error: RefreshError: invalid_grant' }]);
    expect(a.lastError).toBe('RefreshError: invalid_grant');
  });
});

describe('AdkAdapter.resolved', () => {
  it('records server-answered call ids so the browser can skip them', () => {
    const a = new AdkAdapter();
    a.map({ longRunningToolIds: ['n1'], content: { parts: [{ functionCall: { id: 'n1', name: 'navigate', args: { url: 'https://evil.com' } } }] } });
    a.map({ content: { parts: [{ functionResponse: { id: 'n1', name: 'navigate', response: { status: 'error', message: 'blocked' } } }] } });
    expect(a.resolved.has('n1')).toBe(true);
  });
});

describe('confirmMessage / summarise', () => {
  it('joins action + details, falls back to message, and hides screenshots from summaries', () => {
    expect(confirmMessage({ action: 'Send message', details: 'hello' })).toBe('Send message\n\nhello');
    expect(confirmMessage({ message: 'Proceed with X?' })).toBe('Proceed with X?');
    expect(confirmMessage({})).toBe('Proceed?');
    expect(summarise({ status: 'success', screenshot_b64: 'x'.repeat(500), tabId: 4 })).toBe('{"status":"success","tabId":4}');
  });
});

describe('uniqueById', () => {
  it('collapses the partial + aggregate copies of one function call', () => {
    const a = new AdkAdapter();
    const fc = { functionCall: { id: 'c1', name: 'read_page', args: {} } };
    const p1 = a.map({ partial: true, longRunningToolIds: ['c1'], content: { parts: [fc] } }).pending;
    const p2 = a.map({ partial: false, longRunningToolIds: ['c1'], content: { parts: [fc] } }).pending;
    expect([...p1, ...p2]).toHaveLength(2);
    expect(uniqueById([...p1, ...p2]).map((c) => c.id)).toEqual(['c1']);
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
