import { normalizeBackendUrl, type AgentEvent, type Settings, type ToolCall } from '../protocol';
import { AdkAdapter, parseSse, type AdkEvent, type PendingCall } from './adk';
import { brainAuthHeader, brainAuthToken } from './sync';
import type { ToolOutcome } from './tools';

export function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((i) => [i.id, i])).values()];
}

export interface LiveControls {
  signal: AbortSignal;
  executeTool: (call: ToolCall) => Promise<ToolOutcome>;
  waitForConfirm: (id: string) => Promise<boolean>;
  waitIfPaused?: () => Promise<void>;
}

/** `source` when it is one of the brain's own pages (`<backendUrl>/pages/<kind>/<id>`), else undefined. */
export function brainPageUrl(base: string, source: unknown): string | undefined {
  if (typeof source !== 'string' || !base) return undefined;
  try {
    const u = new URL(source);
    const b = new URL(base);
    return u.origin === b.origin && u.pathname.startsWith('/pages/') ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** One line for the closing summary of a failed run; the full text is already in the transcript as a text step. */
export function errorSummary(message: string): string {
  const m = /(\d{3}) ([A-Z_]+)/.exec(message);
  if (m?.[1] === '429') return 'Gemini is out of capacity right now (429) — the brain retried and fell back; press Retry to continue this chat.';
  if (m) return `Model call failed (${m[1]} ${m[2]}) — press Retry to continue this chat.`;
  const first = message.split('\n').find((l) => l.trim() && !/^On how to mitigate|^https?:/.test(l.trim())) ?? message;
  return `${first.trim().slice(0, 160)} — press Retry to continue this chat.`;
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
  req: { runId: string; sessionId: string; skillId?: string; text: string },
  ctl: LiveControls,
): AsyncGenerator<AgentEvent> {
  const base = normalizeBackendUrl(settings.backendUrl);
  const headers = { 'content-type': 'application/json', ...brainAuthHeader(settings) };
  const adapter = new AdkAdapter();

  async function* exchange(path: string, body: unknown): AsyncGenerator<AdkEvent> {
    await ctl.waitIfPaused?.();
    const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: JSON.stringify(body), signal: ctl.signal });
    if (!res.ok || !res.body) throw new Error(`${path} → HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    yield* parseSse<AdkEvent>(res.body, ctl.signal);
  }

  yield { kind: 'run.start', title: req.text.slice(0, 80), skillId: req.skillId };
  if (!brainAuthToken(settings) || !base) {
    yield { kind: 'run.end', status: 'error', summary: 'No brain configured — set the backend URL and token in Settings.' };
    return;
  }

  try {
    // session_id is the CONVERSATION, not the run: follow-ups land in the same ADK session and keep the history.
    let stream = exchange('/chat', { session_id: req.sessionId, skill_id: req.skillId, text: req.text });
    for (;;) {
      await ctl.waitIfPaused?.();
      const queued: PendingCall[] = [];
      for await (const ev of stream) {
        const { events, pending: p } = adapter.map(ev);
        for (const e of events) yield e;
        queued.push(...p);
        await ctl.waitIfPaused?.();
      }
      // ADK streams each function call twice (partial + aggregate) → dedupe by id;
      // a call the server already answered (guard error) is not ours to execute.
      const pending = uniqueById(queued).filter((c) => !adapter.resolved.has(c.id));
      if (pending.length === 0) break;

      // Resolve every pending call, then resume with all results in one message.
      const results: { call_id: string; name: string; result: Record<string, unknown> }[] = [];
      for (const call of pending) {
        await ctl.waitIfPaused?.();
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
            // A page the brain generated (report, courseware) and the vault now holds: link the live page too.
            const source = brainPageUrl(base, result.source);
            if (source) yield { kind: 'artifact', type: 'url', label: `${result.path.split('/').pop() ?? 'page'} (page)`, href: source };
          }
        }
        results.push({ call_id: call.id, name: call.name, result });
      }
      await ctl.waitIfPaused?.();
      stream = exchange('/tool_result', { session_id: req.sessionId, results });
    }
    if (adapter.lastError) yield { kind: 'run.end', status: 'error', summary: errorSummary(adapter.lastError) };
    else yield { kind: 'run.end', status: 'done', summary: adapter.lastText.slice(0, 200) || 'Done' };
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') {
      yield { kind: 'run.end', status: 'cancelled', summary: 'Cancelled' };
      return;
    }
    yield { kind: 'run.end', status: 'error', summary: e instanceof Error ? e.message : String(e) };
  }
}
