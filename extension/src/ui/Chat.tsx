import { useEffect, useMemo, useRef } from 'react';
import type { Settings } from '../protocol';
import type { Run } from '../state/runs';
import { Composer } from './Composer';
import { Kbd } from './primitives';
import { RunBlock } from './Timeline';

/** Chat-first transcript: runs in order, composer at the bottom. */
export function Chat({
  settings,
  runs,
  onSubmit,
  onRunSkill,
  onCancel,
  onAnswer,
}: {
  settings: Settings;
  runs: Record<string, Run>;
  onSubmit: (text: string) => void;
  onRunSkill: (id: string) => void;
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
  const busy = ordered.some((r) => r.status === 'running');
  const unconfigured = !settings.token || !settings.backendUrl;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex-1 overflow-y-auto py-1" data-transcript>
        {ordered.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
            <div className="hairline flex h-10 w-10 items-center justify-center rounded-lg bg-bg-1 font-mono text-[15px] text-accent">›_</div>
            <p className="text-fg">Tell me what to do in your browser.</p>
            <p className="text-[12px] text-fg-3">
              Type <Kbd>/</Kbd> to pick a skill, or just describe the task. I plan out loud, show every click with a screenshot, and ask before anything outward-facing.
            </p>
            {unconfigured && <p className="text-[12px] text-warn">No brain configured — set the backend URL and token in Settings.</p>}
          </div>
        )}
        {ordered.map((r) => (
          <RunBlock key={r.id} run={r} latest={r.id === latest?.id} onCancel={() => onCancel(r.id)} onAnswer={(cid, allow) => onAnswer(r.id, cid, allow)} />
        ))}
        <div ref={endRef} />
      </div>
      <Composer skills={settings.skills} busy={busy} onSubmit={onSubmit} onRunSkill={onRunSkill} />
    </div>
  );
}
