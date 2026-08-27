import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AgentEvent } from '../protocol';
import { brainPageUrl, liveRun, resultSummary } from './live';

describe('brainPageUrl', () => {
  const base = 'http://localhost:8100';
  it('recognises the brain\'s own pages and nothing else', () => {
    expect(brainPageUrl(base, 'http://localhost:8100/pages/report/AbCdEfGhIjKlMnOpQrStUv')).toBe('http://localhost:8100/pages/report/AbCdEfGhIjKlMnOpQrStUv');
    expect(brainPageUrl(base, 'http://localhost:8100/vault/x')).toBeUndefined();
    expect(brainPageUrl(base, 'http://127.0.0.1:8099/files/a.pdf')).toBeUndefined();
    expect(brainPageUrl(base, 'http://localhost:8101/view/f_x')).toBeUndefined();
    expect(brainPageUrl(base, undefined)).toBeUndefined();
    expect(brainPageUrl('', 'http://localhost:8100/pages/report/x')).toBeUndefined();
  });
});

describe('resultSummary', () => {
  it('prefers the tool summary, then message/title, then ok/failed', () => {
    expect(resultSummary({ status: 'success', summary: 'REPORT.html · 6 KB' })).toBe('REPORT.html · 6 KB');
    expect(resultSummary({ status: 'error', message: 'blocked' })).toBe('blocked');
    expect(resultSummary({ status: 'error' })).toBe('failed');
  });
});

/** One SSE frame per ADK event, as the brain streams them. */
function sse(events: unknown[]): Response {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } });
}

describe('liveRun session id', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the conversation id — not the run id — to /chat and /tool_result', async () => {
    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    const responses = [
      // First exchange asks the browser for a long-running tool, so a /tool_result exchange follows.
      sse([{ longRunningToolIds: ['c1'], content: { parts: [{ functionCall: { id: 'c1', name: 'read_page', args: {} } }] } }]),
      sse([{ content: { parts: [{ text: 'Done' }] } }]),
    ];
    vi.stubGlobal('fetch', (url: string, init: RequestInit) => {
      posted.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return Promise.resolve(responses.shift() ?? sse([]));
    });

    const settings = { ...DEFAULT_SETTINGS, backendUrl: 'http://localhost:8100', token: 't' };
    const req = { runId: 'run-2', sessionId: 'chat-1', text: 'now do the same for lab 2' };
    const ctl = {
      signal: new AbortController().signal,
      executeTool: () => Promise.resolve({ result: { status: 'success', summary: 'read' } }),
      waitForConfirm: () => Promise.resolve(true),
    };
    const events: AgentEvent[] = [];
    for await (const ev of liveRun(settings, req, ctl)) events.push(ev);

    expect(posted.map((p) => p.url)).toEqual(['http://localhost:8100/chat', 'http://localhost:8100/tool_result']);
    expect(posted[0]?.body.session_id).toBe('chat-1');
    expect(posted[0]?.body.text).toBe('now do the same for lab 2');
    expect(posted[1]?.body.session_id).toBe('chat-1');
    expect(posted.some((p) => p.body.session_id === 'run-2')).toBe(false);
    expect(events.at(-1)).toEqual({ kind: 'run.end', status: 'done', summary: 'Done' });
  });
});
