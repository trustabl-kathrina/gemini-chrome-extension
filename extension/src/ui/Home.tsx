import { ChevronRight } from 'lucide-react';
import type { Settings } from '../protocol';
import type { Run } from '../state/runs';
import { Kbd, Pill, SectionLabel, relTime } from './primitives';

const STATUS_DOT = { running: 'bg-accent pulse-dot', done: 'bg-ok', error: 'bg-err', cancelled: 'bg-fg-3' } as const;

export function Home({
  settings,
  runs,
  onRunSkill,
  onOpenRun,
}: {
  settings: Settings;
  runs: Run[];
  onRunSkill: (id: string) => void;
  onOpenRun: (id: string) => void;
}) {
  const skills = settings.skills.filter((s) => s.enabled);
  const recent = [...runs].sort((a, b) => b.startedAt - a.startedAt).slice(0, 8);
  return (
    <div className="flex-1 overflow-y-auto px-2 pb-2">
      <SectionLabel>Skills</SectionLabel>
      <ul className="flex flex-col gap-1">
        {skills.map((s) => (
          <li key={s.id}>
            <button
              onClick={() => onRunSkill(s.id)}
              className="hairline group flex w-full items-start gap-2 rounded-md bg-bg-1 px-3 py-2 text-left transition-colors duration-150 hover:bg-bg-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium tracking-tight">{s.title}</span>
                  {s.schedule && <Pill tone="neutral">scheduled</Pill>}
                </div>
                <p className="line-clamp-2 text-fg-2">{s.blurb}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1 pt-0.5">
                {s.key && <Kbd>{s.key}</Kbd>}
                <ChevronRight size={14} className="text-fg-3 opacity-0 transition-opacity group-hover:opacity-100" />
              </div>
            </button>
          </li>
        ))}
        {skills.length === 0 && (
          <li className="px-3 py-6 text-center text-fg-3">No skills enabled. Add one in Settings → Skills.</li>
        )}
      </ul>

      {recent.length > 0 && (
        <>
          <SectionLabel>Recent</SectionLabel>
          <ul className="flex flex-col">
            {recent.map((r) => (
              <li key={r.id}>
                <button
                  onClick={() => onOpenRun(r.id)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-bg-1"
                >
                  <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[r.status]}`} />
                  <span className="min-w-0 flex-1 truncate">{r.summary ?? r.title}</span>
                  <span className="shrink-0 text-[11px] text-fg-3">{relTime(r.startedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
