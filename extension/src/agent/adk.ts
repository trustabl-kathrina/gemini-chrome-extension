import type { AgentEvent, ToolCall } from '../protocol';

/** Subset of an ADK `Event` as serialised by `model_dump_json(by_alias=True, exclude_none=True)`. */
export interface AdkEvent {
  id?: string;
  author?: string;
  partial?: boolean;
  longRunningToolIds?: string[];
  errorMessage?: string;
  content?: {
    role?: string;
    parts?: Array<{
      text?: string;
      thought?: boolean;
      functionCall?: { id?: string; name: string; args?: Record<string, unknown> };
      functionResponse?: { id?: string; name: string; response?: Record<string, unknown> };
    }>;
  };
}

/** The brain asks the browser for one of these; the loop pauses until the result is posted back. */
export interface PendingCall extends ToolCall {
  kind: 'browser' | 'confirm';
}

export const CONFIRM_TOOL = 'request_confirmation';

/**
 * Stateful mapper from ADK events to panel events. Handles: partial-text streaming (ADK sends the
 * chunks and then the aggregated final text), server tool call/response pairs, and long-running calls.
 */
export class AdkAdapter {
  private streaming = false;
  private started = new Map<string, number>();
  /** Last non-empty model text; used as the run summary. */
  lastText = '';

  /** Calls the brain answered itself in the same stream (e.g. a guard's error response) — the browser must NOT execute these. */
  resolved = new Set<string>();

  map(ev: AdkEvent, now = Date.now()): { events: AgentEvent[]; pending: PendingCall[] } {
    const events: AgentEvent[] = [];
    const pending: PendingCall[] = [];
    const lr = new Set(ev.longRunningToolIds ?? []);

    if (ev.errorMessage) events.push({ kind: 'text', text: `Error: ${ev.errorMessage}` });

    for (const part of ev.content?.parts ?? []) {
      if (part.thought) continue;

      if (part.text !== undefined) {
        if (ev.partial) {
          events.push({ kind: 'text', text: part.text, partial: true });
          this.streaming = true;
          this.lastText += part.text;
        } else if (this.streaming) {
          // Aggregated repeat of the chunks above: close the partial without re-emitting.
          events.push({ kind: 'text', text: '', partial: false });
          this.streaming = false;
        } else if (part.text.trim()) {
          events.push({ kind: 'text', text: part.text });
          this.lastText = part.text;
        }
        continue;
      }

      const fc = part.functionCall;
      if (fc) {
        const id = fc.id ?? `${fc.name}-${now}`;
        const call: ToolCall = { id, name: fc.name, args: fc.args ?? {} };
        if (fc.name === CONFIRM_TOOL) {
          events.push({ kind: 'confirm', id, message: String(fc.args?.message ?? 'Proceed?') });
          pending.push({ ...call, kind: 'confirm' });
        } else if (lr.has(id)) {
          events.push({ kind: 'tool.call', call, target: 'browser' });
          pending.push({ ...call, kind: 'browser' });
        } else {
          events.push({ kind: 'tool.call', call, target: 'server' });
        }
        this.started.set(id, now);
        continue;
      }

      const fr = part.functionResponse;
      if (fr) {
        const id = fr.id ?? fr.name;
        this.resolved.add(id);
        const t0 = this.started.get(id) ?? now;
        const r = fr.response ?? {};
        const ok = r.status !== 'error';
        events.push({ kind: 'tool.result', callId: id, ok, summary: summarise(r), ms: now - t0 });
      }
    }
    return { events, pending };
  }
}

export function summarise(r: Record<string, unknown>): string {
  if (typeof r.message === 'string') return r.message;
  if (typeof r.summary === 'string') return r.summary;
  if (typeof r.result === 'string') return r.result.slice(0, 120);
  const s = JSON.stringify(r);
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}

/** Parses a `text/event-stream` body into JSON payloads of `data:` lines. */
export async function* parseSse<T>(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<T> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const onAbort = () => void reader.cancel();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) !== -1) {
        const chunk = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const data = chunk
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (data) yield JSON.parse(data) as T;
      }
    }
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
}
