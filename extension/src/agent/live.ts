import type { AgentEvent, Settings, ToolCall } from '../protocol';
import { AdkAdapter, parseSse, type AdkEvent, type PendingCall } from './adk';

export interface LiveControls {
  signal: AbortSignal;
  executeTool: (call: ToolCall) => Promise<Record<string, unknown>>;
  waitForConfirm: (id: string) => Promise<boolean>;
}

/**
 * One run against the Cloud Run brain. Each HTTP exchange is one short SSE stream: the brain
 * stops at every long-running (browser) tool call; we execute it and post the result to resume.
 */
export async function* liveRun(
  settings: Settings,
  req: { runId: string; skillId?: string; text: string },
  ctl: LiveControls,
): AsyncGenerator<AgentEvent> {
  const base = settings.backendUrl.replace(/\/+$/, '');
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${settings.token}` };
  const adapter = new AdkAdapter();

  async function* exchange(path: string, body: unknown): AsyncGenerator<AdkEvent> {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok || !res.body) throw new Error(`${path} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    yield* parseSse<AdkEvent>(res.body, ctl.signal);
  }

  yield { kind: 'run.start', title: req.text.slice(0, 80), skillId: req.skillId };

  try {
    let stream = exchange('/chat', { session_id: req.runId, skill_id: req.skillId, text: req.text });
    for (;;) {
      const queued: PendingCall[] = [];
      for await (const ev of stream) {
        const { events, pending: p } = adapter.map(ev);
        for (const e of events) yield e;
        queued.push(...p);
      }
      // A call the server already answered (guard error) is not ours to execute.
      const pending = queued.filter((c) => !adapter.resolved.has(c.id));
      if (pending.length === 0) break;

      // Resolve every pending call, then resume with all results in one message.
      const results: { call_id: string; name: string; result: Record<string, unknown> }[] = [];
      for (const call of pending) {
        const t0 = Date.now();
        let result: Record<string, unknown>;
        if (call.kind === 'confirm') {
          const allowed = await ctl.waitForConfirm(call.id);
          result = { confirmed: allowed };
          if (!allowed) yield { kind: 'text', text: 'Okay — not doing that.' };
        } else {
          result = await ctl.executeTool(call);
          const ok = result.status !== 'error';
          const summary = typeof result.message === 'string' ? result.message : typeof result.title === 'string' ? result.title : ok ? 'ok' : 'failed';
          yield { kind: 'tool.result', callId: call.id, ok, summary, ms: Date.now() - t0 };
        }
        results.push({ call_id: call.id, name: call.name, result });
      }
      stream = exchange('/tool_result', { session_id: req.runId, results });
    }
    yield { kind: 'run.end', status: 'done', summary: adapter.lastText.slice(0, 200) || 'Done' };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      yield { kind: 'run.end', status: 'cancelled', summary: 'Cancelled' };
      return;
    }
    yield { kind: 'run.end', status: 'error', summary: e instanceof Error ? e.message : String(e) };
  }
}
