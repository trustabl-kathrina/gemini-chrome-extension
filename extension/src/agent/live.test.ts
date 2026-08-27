import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AgentEvent, type ToolCall } from '../protocol';
import { brainPageUrl, errorSummary, liveRun, resultSummary, toolLane } from './live';
import type { ToolOutcome } from './tools';

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
    expect(posted[0]?.body.trigger).toBe('manual');
    expect(posted[1]?.body.session_id).toBe('chat-1');
    expect(posted.some((p) => p.body.session_id === 'run-2')).toBe(false);
    expect(events.at(-1)).toEqual({ kind: 'run.end', status: 'done', summary: 'Done' });
  });
});

describe('liveRun trigger', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('tells the brain a scheduled run was not typed by the user', async () => {
    const posted: Record<string, unknown>[] = [];
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
      posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Promise.resolve(sse([{ content: { parts: [{ text: 'Done' }] } }]));
    });
    const settings = { ...DEFAULT_SETTINGS, backendUrl: 'http://localhost:8100', token: 't' };
    const req = { runId: 'r', sessionId: 's', text: 'sync', trigger: 'scheduled' as const };
    const ctl = {
      signal: new AbortController().signal,
      executeTool: () => Promise.resolve({ result: { status: 'success' } }),
      waitForConfirm: () => Promise.resolve(true),
    };
    for await (const _ of liveRun(settings, req, ctl)) void _;
    expect(posted[0]?.trigger).toBe('scheduled');
  });
});

describe('errorSummary', () => {
  it('turns the ADK 429 wall of text into one actionable line', () => {
    const adk = '_ResourceExhaustedError: \nOn how to mitigate this issue, please refer to:\n\nhttps://google.github.io/adk-docs/x\n\n\n429 RESOURCE_EXHAUSTED. {"error": {"code": 429}}';
    expect(errorSummary(adk)).toMatch(/^Gemini is out of capacity right now \(429\)/);
    expect(errorSummary('ClientError: 400 INVALID_ARGUMENT. bad')).toBe('Model call failed (400 INVALID_ARGUMENT) — press Retry to continue this chat.');
    expect(errorSummary('TypeError: fetch failed')).toBe('TypeError: fetch failed — press Retry to continue this chat.');
  });
});

describe('toolLane', () => {
  const call = (name: string, args: Record<string, unknown> = {}): Parameters<typeof toolLane>[0] => ({ id: 'x', name, args, kind: 'browser' });

  it('puts everything that touches the working tab in one lane and lets the rest float', () => {
    expect(toolLane(call('click', { ref: 'e1' }))).toBe(toolLane(call('screenshot')));
    expect(toolLane(call('read_page'))).toBe('tab:working');
    expect(toolLane(call('download', { ref: 'e9', path: 'a.pdf' }))).toBe('tab:working');
    expect(toolLane(call('download', { url: 'https://x/a.pdf', path: 'a.pdf' }))).toBeNull();
    expect(toolLane(call('download_many', { items: [] }))).toBeNull();
    expect(toolLane(call('make_folders', { paths: ['a'] }))).toBeNull();
    expect(toolLane(call('list_tabs'))).toBeNull();
  });

  it('ignores a hallucinated tab_id — no tool honours it — and keeps confirmations on the working tab lane', () => {
    expect(toolLane(call('click', { ref: 'e1', tab_id: 7 }))).toBe('tab:working');
    expect(toolLane(call('read_page', { tabId: 8 }))).toBe('tab:working');
    expect(toolLane({ id: 'c', name: 'request_confirmation', args: {}, kind: 'confirm' })).toBe('tab:working');
  });
});

/** Records when each tool call starts and ends, and hands the test the levers to finish them out of order. */
function recorder() {
  const log: string[] = [];
  const finish = new Map<string, (outcome: ToolOutcome | Error) => void>();
  const executeTool = (c: ToolCall): Promise<ToolOutcome> => {
    log.push(`start ${c.id}`);
    return new Promise<ToolOutcome>((resolve, reject) => {
      finish.set(c.id, (outcome) => {
        log.push(`end ${c.id}`);
        if (outcome instanceof Error) reject(outcome);
        else resolve(outcome);
      });
    });
  };
  // The SSE body is read through a stream, so "has the loop got there yet?" is a task, not a microtask.
  const tick = () => new Promise((r) => setTimeout(r, 0));
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 200 && !done(); i++) await tick();
  };
  const started = (id: string) => log.includes(`start ${id}`);
  const settle = async (id: string, outcome: ToolOutcome | Error) => {
    await until(() => finish.has(id));
    finish.get(id)?.(outcome);
    await tick();
  };
  return { log, executeTool, settle, started, until, tick };
}

/** Runs liveRun against one batch of pending calls; `drive` settles them while the run is in flight. */
async function batchRun(calls: { id: string; name: string; args: Record<string, unknown> }[], rec: ReturnType<typeof recorder>, drive: () => Promise<void>) {
  const posted: Record<string, unknown>[] = [];
  const responses = [
    sse([{ longRunningToolIds: calls.map((c) => c.id), content: { parts: calls.map((c) => ({ functionCall: c })) } }]),
    sse([{ content: { parts: [{ text: 'Done' }] } }]),
  ];
  vi.stubGlobal('fetch', (_url: string, init: RequestInit) => {
    posted.push(JSON.parse(String(init.body)) as Record<string, unknown>);
    return Promise.resolve(responses.shift() ?? sse([]));
  });
  const settings = { ...DEFAULT_SETTINGS, backendUrl: 'http://localhost:8100', token: 't' };
  const ctl = { signal: new AbortController().signal, executeTool: rec.executeTool, waitForConfirm: () => Promise.resolve(true) };
  const events: AgentEvent[] = [];
  const run = (async () => {
    for await (const ev of liveRun(settings, { runId: 'r', sessionId: 's', text: 'go' }, ctl)) events.push(ev);
  })();
  await drive();
  await run;
  return { events, results: (posted[1]?.results ?? []) as { call_id: string; result: Record<string, unknown> }[] };
}

describe('liveRun tool concurrency', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('keeps calls on the same tab strictly ordered', async () => {
    const rec = recorder();
    const calls = [
      { id: 'a', name: 'click', args: { ref: 'e1' } },
      { id: 'b', name: 'screenshot', args: {} },
    ];
    const { results } = await batchRun(calls, rec, async () => {
      await rec.until(() => rec.started('a'));
      await rec.tick();
      expect(rec.started('b')).toBe(false); // the click has not finished: the screenshot must not have begun
      await rec.settle('a', { result: { status: 'success', summary: 'clicked' } });
      await rec.settle('b', { result: { status: 'success', summary: 'shot' } });
    });
    expect(rec.log).toEqual(['start a', 'end a', 'start b', 'end b']);
    expect(results.map((r) => r.call_id)).toEqual(['a', 'b']);
  });

  it('overlaps calls in different lanes, and answers in the model\'s order', async () => {
    const rec = recorder();
    const calls = [
      { id: 'a', name: 'download', args: { url: 'https://wsp.test/a.pdf', path: 'C/a.pdf' } },
      { id: 'b', name: 'download', args: { url: 'https://wsp.test/b.pdf', path: 'C/b.pdf' } },
      { id: 'c', name: 'click', args: { ref: 'e1' } },
    ];
    const { results, events } = await batchRun(calls, rec, async () => {
      await rec.until(() => rec.started('a'));
      await rec.tick();
      expect(rec.log).toEqual(['start a', 'start b', 'start c']); // all three in flight at once
      // Finished out of order; the results array must still follow the model's order.
      await rec.settle('c', { result: { status: 'success', summary: 'clicked' } });
      await rec.settle('b', { result: { status: 'success', path: 'C/b.pdf', summary: 'b.pdf' } });
      await rec.settle('a', { result: { status: 'success', path: 'C/a.pdf', summary: 'a.pdf' } });
    });
    expect(results.map((r) => r.call_id)).toEqual(['a', 'b', 'c']);
    expect(events.filter((e) => e.kind === 'artifact').map((e) => e.label)).toEqual(['C/a.pdf', 'C/b.pdf']);
  });

  it('turns one rejected call into its own error result without losing the others', async () => {
    const rec = recorder();
    const calls = [
      { id: 'a', name: 'download', args: { url: 'https://wsp.test/a.pdf', path: 'C/a.pdf' } },
      { id: 'b', name: 'download', args: { url: 'https://wsp.test/b.pdf', path: 'C/b.pdf' } },
    ];
    const { results, events } = await batchRun(calls, rec, async () => {
      await rec.settle('a', new Error('GET a.pdf → HTTP 404'));
      await rec.settle('b', { result: { status: 'success', path: 'C/b.pdf', summary: 'b.pdf' } });
    });
    expect(results.map((r) => r.result.status)).toEqual(['error', 'success']);
    expect(results[0]?.result.message).toBe('GET a.pdf → HTTP 404');
    expect(events.filter((e) => e.kind === 'tool.result').map((e) => e.ok)).toEqual([false, true]);
    expect(events.at(-1)).toEqual({ kind: 'run.end', status: 'done', summary: 'Done' });
  });

  it('reports every file of a download_many batch as its own artifact', async () => {
    const rec = recorder();
    const calls = [{ id: 'a', name: 'download_many', args: { items: [{ url: 'https://wsp.test/a.pdf', path: 'C/a.pdf' }] } }];
    const { events } = await batchRun(calls, rec, async () => {
      await rec.settle('a', {
        result: {
          status: 'success',
          ok: 2,
          failed: 1,
          items: [
            { status: 'success', path: 'C/a.pdf', drive_link: 'https://drive/a' },
            { status: 'error', url: 'https://wsp.test/b.pdf', message: 'HTTP 404' },
            { status: 'success', path: 'C/c.pdf' },
          ],
          summary: '2/3 files → vault, 1 failed',
        },
      });
    });
    expect(events.filter((e) => e.kind === 'artifact')).toEqual([
      { kind: 'artifact', type: 'file', label: 'C/a.pdf', href: 'https://drive/a' },
      { kind: 'artifact', type: 'file', label: 'C/c.pdf', href: undefined },
    ]);
  });
});
