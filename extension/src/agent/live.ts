import { normalizeBackendUrl, type AgentEvent, type Settings, type ToolCall } from '../protocol';
import { AdkAdapter, parseSse, type AdkEvent, type PendingCall } from './adk';
import { brainAuthHeader, brainAuthToken } from './sync';
import type { ToolOutcome } from './tools';

export function uniqueById<T extends { id: string }>(items: T[]): T[] {
  return [...new Map(items.map((i) => [i.id, i])).values()];
}

/** One finished pending call: its result body, the panel thumbnail, and how long it actually took. */
interface Settled {
  result: Record<string, unknown>;
  screenshot?: string;
  ms: number;
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

/** The lane every tool that acts on the agent's working tab shares (tools.ts keeps exactly one job tab). */
const WORKING_TAB = 'tab:working';

/** Tools whose effect is the working tab's state — the switch in tools.ts that starts with `await this.tab()`. */
const WORKING_TAB_TOOLS = new Set(['open_tab', 'navigate', 'read_page', 'screenshot', 'click', 'click_at', 'type', 'type_text', 'press_key', 'scroll', 'set_viewport', 'run_js', 'wait']);

/** Tool calls in flight at once: enough to overlap a batch of file fetches, not enough to thrash the browser. */
export const MAX_PARALLEL_TOOLS = 6;

/**
 * The serial lane a pending call belongs to. Calls in the same lane run strictly in the order the model
 * emitted them (a click and the screenshot after it are one story); different lanes — and lane-less calls
 * like url downloads or make_folders — run concurrently. `null` = no lane.
 */
export function toolLane(call: PendingCall): string | null {
  // A confirmation gates the actions that follow it, and the user answers one card at a time.
  if (call.kind === 'confirm') return WORKING_TAB;
  // No tool honours a `tab_id` argument — every browser tool acts on the one working tab (tools.ts `tab()`),
  // so a hallucinated tab_id must NOT take a call out of the working-tab lane.
  // download(ref=…) clicks inside the working tab; download(url=…) and download_many only fetch bytes.
  if (call.name === 'download') return typeof call.args.ref === 'string' && call.args.ref ? WORKING_TAB : null;
  return WORKING_TAB_TOOLS.has(call.name) ? WORKING_TAB : null;
}

/** Admission control: at most `limit` bodies running at once, FIFO for the rest. */
function gate(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(body: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
    active++;
    try {
      return await body();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}

/** Files a download tool put in the vault: one artifact per stored file, plus the brain page it came from. */
function* downloadArtifacts(base: string, result: Record<string, unknown>): Generator<AgentEvent> {
  const items = Array.isArray(result.items) ? result.items : [result];
  for (const raw of items) {
    const item = raw as Record<string, unknown>;
    if (!item || item.status === 'error' || typeof item.path !== 'string') continue;
    yield { kind: 'artifact', type: 'file', label: item.path, href: typeof item.drive_link === 'string' ? item.drive_link : undefined };
    // A page the brain generated (report, courseware) and the vault now holds: link the live page too.
    const source = brainPageUrl(base, item.source);
    if (source) yield { kind: 'artifact', type: 'url', label: `${item.path.split('/').pop() ?? 'page'} (page)`, href: source };
  }
}

/**
 * One run against the brain. Each HTTP exchange is one short SSE stream: the brain stops at every
 * long-running (browser) tool call; we execute it and post the result to resume.
 */
export async function* liveRun(
  settings: Settings,
  req: { runId: string; sessionId: string; skillId?: string; text: string; trigger?: 'manual' | 'scheduled' },
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
    let stream = exchange('/chat', { session_id: req.sessionId, skill_id: req.skillId, text: req.text, trigger: req.trigger ?? 'manual' });
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

      // Resolve every pending call, then resume with all results in one message. Gemini emits several calls
      // per turn and the brain answers them as one turn, so they run concurrently — except within a lane
      // (toolLane), where the model's order is the story and must be kept.
      const admit = gate(MAX_PARALLEL_TOOLS);
      const lanes = new Map<string, Promise<unknown>>();
      const started = pending.map((call) => {
        const settle = async (): Promise<Settled> => {
          await ctl.waitIfPaused?.();
          const t0 = Date.now();
          try {
            if (call.kind === 'confirm') {
              const confirmed = await ctl.waitForConfirm(call.id);
              return { result: { confirmed }, ms: Date.now() - t0 };
            }
            const out = await admit(async () => {
              // Queued behind the gate while the user pressed Pause: the batch stops here too, not only at its start.
              await ctl.waitIfPaused?.();
              return ctl.executeTool(call);
            });
            return { result: out.result, screenshot: out.screenshot, ms: Date.now() - t0 };
          } catch (e) {
            // One call throwing is that call's own error result; the rest of the batch still answers the model.
            return { result: { status: 'error', message: e instanceof Error ? e.message : String(e) }, ms: Date.now() - t0 };
          }
        };
        const lane = toolLane(call);
        const after = (lane && lanes.get(lane)) || Promise.resolve();
        const done = after.then(settle, settle);
        if (lane) lanes.set(lane, done);
        return done;
      });

      // Awaited in the model's own order: the transcript and the results array stay deterministic.
      const results: { call_id: string; name: string; result: Record<string, unknown> }[] = [];
      for (const [i, call] of pending.entries()) {
        const { result, screenshot, ms } = await started[i]!;
        const ok = result.status !== 'error';
        if (call.kind === 'confirm') {
          if (!result.confirmed) yield { kind: 'text', text: 'Okay — not doing that.' };
        } else {
          yield { kind: 'tool.result', callId: call.id, ok, summary: resultSummary(result), ms, screenshot };
          if (ok && (call.name === 'download' || call.name === 'download_many')) yield* downloadArtifacts(base, result);
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
