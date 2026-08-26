import type { AgentEvent, ArtifactType, ToolCall } from '../protocol';

export type StepStatus = 'running' | 'ok' | 'error';

export type Step =
  | { id: string; kind: 'text'; text: string; partial: boolean }
  | { id: string; kind: 'tool'; call: ToolCall; target: 'browser' | 'server'; status: StepStatus; summary?: string; ms?: number; screenshot?: string }
  | { id: string; kind: 'artifact'; type: ArtifactType; label: string; href?: string }
  | { id: string; kind: 'confirm'; message: string; answer: 'pending' | 'allowed' | 'denied' };

export type RunStatus = 'running' | 'done' | 'error' | 'cancelled';

export interface Run {
  id: string;
  /** Short form of the prompt (header, recents). */
  title: string;
  /** What the user typed, in full — the transcript shows it verbatim. */
  prompt: string;
  skillId?: string;
  status: RunStatus;
  summary?: string;
  startedAt: number;
  steps: Step[];
}

export function newRun(id: string, prompt: string, skillId: string | undefined, now: number): Run {
  return { id, title: prompt.slice(0, 80), prompt, skillId, status: 'running', startedAt: now, steps: [] };
}

/** Pure reducer: folds one agent event into a run. Returns the same object if nothing changed. */
export function applyEvent(run: Run, ev: AgentEvent): Run {
  switch (ev.kind) {
    case 'run.start':
      return { ...run, title: ev.title, skillId: ev.skillId ?? run.skillId };
    case 'text': {
      const last = run.steps.at(-1);
      if (last?.kind === 'text' && last.partial) {
        const merged: Step = { ...last, text: last.text + ev.text, partial: ev.partial ?? false };
        return { ...run, steps: [...run.steps.slice(0, -1), merged] };
      }
      return { ...run, steps: [...run.steps, { id: `t${run.steps.length}`, kind: 'text', text: ev.text, partial: ev.partial ?? false }] };
    }
    case 'tool.call':
      if (run.steps.some((s) => s.kind === 'tool' && s.id === ev.call.id)) return run; // repeated stream copy of one call
      return { ...run, steps: [...run.steps, { id: ev.call.id, kind: 'tool', call: ev.call, target: ev.target, status: 'running' }] };
    case 'tool.result': {
      const idx = run.steps.findIndex((s) => s.kind === 'tool' && s.id === ev.callId);
      if (idx === -1) return run;
      const step = run.steps[idx];
      if (!step || step.kind !== 'tool') return run;
      const updated: Step = { ...step, status: ev.ok ? 'ok' : 'error', summary: ev.summary, ms: ev.ms, screenshot: ev.screenshot ?? step.screenshot };
      return { ...run, steps: run.steps.with(idx, updated) };
    }
    case 'artifact':
      return { ...run, steps: [...run.steps, { id: `a${run.steps.length}`, kind: 'artifact', type: ev.type, label: ev.label, href: ev.href }] };
    case 'confirm':
      return { ...run, steps: [...run.steps, { id: ev.id, kind: 'confirm', message: ev.message, answer: 'pending' }] };
    case 'run.end':
      return { ...run, status: ev.status, summary: ev.summary };
  }
}

export function answerConfirm(run: Run, confirmId: string, allow: boolean): Run {
  const idx = run.steps.findIndex((s) => s.kind === 'confirm' && s.id === confirmId);
  const step = run.steps[idx];
  if (!step || step.kind !== 'confirm') return run;
  return { ...run, steps: run.steps.with(idx, { ...step, answer: allow ? 'allowed' : 'denied' }) };
}

export function pendingConfirm(run: Run): Extract<Step, { kind: 'confirm' }> | undefined {
  return run.steps.find((s): s is Extract<Step, { kind: 'confirm' }> => s.kind === 'confirm' && s.answer === 'pending');
}

/** Browser actions so far (the brain caps a run at 40). */
export function browserActions(run: Run): number {
  return run.steps.filter((s) => s.kind === 'tool' && s.target === 'browser').length;
}
