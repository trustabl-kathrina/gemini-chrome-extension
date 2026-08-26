import type { AgentEvent, Settings, ToolCall } from '../protocol';
import { AdkAdapter, parseSse, type AdkEvent, type PendingCall } from './adk';
import type { ToolOutcome } from './tools';

export function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((i) => [i.id, i])).values()];
}

export interface LiveControls {
  signal: AbortSignal;
  executeTool: (call: ToolCall) => Promise<ToolOutcome>;
  waitForConfirm: (id: string) => Promise<boolean>;
}

/** One line for the tool row: the tool's own summary, else its message/title, else ok/failed. */
export function resultSummary(result: Record<string, unknown>): string {
  const ok = result.status !== 'error';
  for (const k of ['summary', 'message', 'title']) if (typeof result[k] === 'string' && result[k]) return (result[k] as string).slice(0, 160);
  return ok ? 'ok' : 'failed';
}

/**
 * One run against the brain. Each HTTP exchange is one short SSE stream: the brain stops at every
 * long-running (browser) tool call; we execute it and post the result to resume.
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
  if (!settings.token) {
    yield { kind: 'run.end', status: 'error', summary: 'No access token — set the backend URL and token in Settings.' };
    return;
  }

  try {
    let stream = exchange('/chat', { session_id: req.runId, skill_id: req.skillId, text: req.text });
    for (;;) {
      const queued: PendingCall[] = [];
      for await (const ev of stream) {
        const { events, pending: p } = adapter.map(ev);
        for (const e of events) yield e;
        queued.push(...p);
      }
      // ADK streams each function call twice (partial + aggregate) → dedupe by id;
      // a call the server already answered (guard error) is not ours to execute.
      const pending = uniqueById(queued).filter((c) => !adapter.resolved.has(c.id));
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
          const out = await ctl.executeTool(call);
          result = out.result;
          const ok = result.status !== 'error';
          yield { kind: 'tool.result', callId: call.id, ok, summary: resultSummary(result), ms: Date.now() - t0, screenshot: out.screenshot };
          if (ok && call.name === 'download' && typeof result.path === 'string') {
            yield { kind: 'artifact', type: 'file', label: result.path, href: typeof result.drive_link === 'string' ? result.drive_link : undefined };
          }
        }
        results.push({ call_id: call.id, name: call.name, result });
      }
      stream = exchange('/tool_result', { session_id: req.runId, results });
    }
    if (adapter.lastError) yield { kind: 'run.end', status: 'error', summary: adapter.lastError.slice(0, 200) };
    else yield { kind: 'run.end', status: 'done', summary: adapter.lastText.slice(0, 200) || 'Done' };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      yield { kind: 'run.end', status: 'cancelled', summary: 'Cancelled' };
      return;
    }
    yield { kind: 'run.end', status: 'error', summary: e instanceof Error ? e.message : String(e) };
  }
}
