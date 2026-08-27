import { useEffect, useMemo, useRef } from 'react';
import type { Settings } from '../protocol';
import type { Run } from '../state/runs';
import { Composer } from './Composer';
import { Kbd } from './primitives';
import { RunBlock } from './Timeline';

/** Chat-first transcript: runs in order, composer at the bottom. */
/** Sent as a new turn of the same chat: the brain's session holds every step of the failed run. */
export const RETRY_PROMPT = 'Continue exactly where you stopped: the earlier steps of this chat are done, do not repeat them.';

export function Chat({
  settings,
  runs,
  onSubmit,
  onRunSkill,
  onPause,
  onResume,
  onCancel,
  onAnswer,
}: {
  settings: Settings;
  runs: Record<string, Run>;
  onSubmit: (text: string) => void;
  onRunSkill: (id: string) => void;
  onPause: (runId: string) => void;
  onResume: (runId: string) => void;
  onCancel: (runId: string) => void;
  onAnswer: (runId: string, confirmId: string, allow: boolean) => void;
}) {
  const ordered = useMemo(() => Object.values(runs).sort((a, b) => a.startedAt - b.startedAt), [runs]);
  const endRef = useRef<HTMLDivElement>(null);
  const stepCount = ordered.reduce((n, r) => n + r.steps.length, 0);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [stepCount, ordered.length, ordered.at(-1)?.status]);

  const latest = ordered.at(-1);
  const activeRun = ordered.find((r) => r.status === 'running' || r.status === 'paused');
  const busy = ordered.some((r) => r.status === 'running' || r.status === 'paused');
  const unconfigured = !settings.token || !settings.backendUrl;
  const firstName = settings.account?.name?.split(' ')[0] || settings.account?.email?.split('@')[0] || '';
  const suggestions = settings.skills.filter((s) => s.enabled).slice(0, 4);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto py-1" data-transcript>
        {ordered.length === 0 && (
          <div className="flex h-full flex-col justify-center gap-5 px-5 pb-10">
            <div>
              <h1 className="gemini-text gemini-shimmer text-[30px] font-medium leading-tight tracking-tight">{firstName ? `Hello, ${firstName}` : 'Hello'}</h1>
              <p className="mt-1 text-[24px] font-medium leading-tight tracking-tight text-fg-3">What should I do in your browser?</p>
            </div>
            {suggestions.length > 0 && (
              <div className="grid grid-cols-2 gap-2">
                {suggestions.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => onRunSkill(s.id)}
                    className="rounded-2xl bg-bg-1 px-3.5 py-3 text-left text-[13px] leading-snug text-fg-2 transition-colors duration-150 hover:bg-bg-2 hover:text-fg"
                  >
                    {s.title}
                  </button>
                ))}
              </div>
            )}
            <p className="text-[12px] text-fg-3">
              Type <Kbd>/</Kbd> to pick a skill or describe the task. I plan out loud, show every click with a screenshot, and ask before anything outward-facing.
            </p>
            {unconfigured && <p className="text-[12px] text-warn">No brain configured — set the backend URL and token in Settings.</p>}
          </div>
        )}
        {ordered.map((r) => (
          <RunBlock
            key={r.id}
            run={r}
            latest={r.id === latest?.id}
            onPause={() => onPause(r.id)}
            onResume={() => onResume(r.id)}
            onCancel={() => onCancel(r.id)}
            onRetry={() => onSubmit(RETRY_PROMPT)}
            onAnswer={(cid, allow) => onAnswer(r.id, cid, allow)}
          />
        ))}
        <div ref={endRef} />
      </div>
      <Composer
        skills={settings.skills}
        busy={busy}
        activeRun={activeRun}
        onSubmit={onSubmit}
        onRunSkill={onRunSkill}
        onPause={() => activeRun && onPause(activeRun.id)}
        onResume={() => activeRun && onResume(activeRun.id)}
        onCancel={() => activeRun && onCancel(activeRun.id)}
      />
    </div>
  );
}
