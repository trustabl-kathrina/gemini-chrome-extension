import {
  Check,
  CircleDot,
  FileText,
  Folder,
  GitBranch,
  GitPullRequest,
  Globe,
  Link2,
  Loader2,
  Presentation,
  Server,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ArtifactType } from '../protocol';
import { pendingConfirm, type Run, type Step } from '../state/runs';
import { Button, Kbd, Pill } from './primitives';

const ARTIFACT_ICON: Record<ArtifactType, typeof FileText> = {
  file: FileText,
  folder: Folder,
  url: Link2,
  repo: GitBranch,
  deck: Presentation,
  issue: CircleDot,
  pr: GitPullRequest,
};

const STATUS_TONE = { running: 'accent', done: 'ok', error: 'err', cancelled: 'neutral' } as const;

function argsSummary(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ')
    .slice(0, 96);
}

function ToolRow({ step }: { step: Extract<Step, { kind: 'tool' }> }) {
  const Icon = step.target === 'browser' ? Globe : Server;
  return (
    <div className="fade-in flex items-start gap-2 rounded-md px-2 py-1 font-mono text-[11.5px]">
      <Icon size={13} className="mt-0.5 shrink-0 text-fg-3" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-fg">{step.call.name}</span>
          <span className="truncate text-fg-3">{argsSummary(step.call.args)}</span>
        </div>
        {step.summary && <div className="text-fg-2">{step.summary}</div>}
      </div>
      <div className="flex shrink-0 items-center gap-1.5 text-fg-3">
        {step.ms !== undefined && <span>{(step.ms / 1000).toFixed(1)}s</span>}
        {step.status === 'running' && <Loader2 size={13} className="animate-spin text-accent" />}
        {step.status === 'ok' && <Check size={13} className="text-ok" />}
        {step.status === 'error' && <X size={13} className="text-err" />}
      </div>
    </div>
  );
}

/** Only http(s) links are rendered as anchors; anything else (javascript:, file:, …) shows as plain text. */
function safeHref(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function ArtifactRow({ step }: { step: Extract<Step, { kind: 'artifact' }> }) {
  const Icon = ARTIFACT_ICON[step.type];
  const href = safeHref(step.href);
  const inner = (
    <>
      <Icon size={13} className="shrink-0 text-accent" />
      <span className="truncate">{step.label}</span>
    </>
  );
  const cls = 'fade-in hairline mx-2 my-0.5 flex items-center gap-2 rounded-md bg-accent-soft px-2.5 py-1.5 text-fg';
  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className={`${cls} hover:brightness-110`}>
      {inner}
    </a>
  ) : (
    <div className={cls}>{inner}</div>
  );
}

function ConfirmCard({ step, onAnswer }: { step: Extract<Step, { kind: 'confirm' }>; onAnswer: (allow: boolean) => void }) {
  const pending = step.answer === 'pending';
  return (
    <div className="fade-in hairline mx-2 my-1 rounded-md bg-bg-1 p-3">
      <div className="mb-2 flex items-center gap-2">
        <Pill tone={pending ? 'warn' : step.answer === 'allowed' ? 'ok' : 'neutral'} pulse={pending}>
          {pending ? 'needs your OK' : step.answer}
        </Pill>
      </div>
      <p className="whitespace-pre-wrap text-fg">{step.message}</p>
      {pending && (
        <div className="mt-3 flex justify-end gap-1.5">
          <Button onClick={() => onAnswer(false)}>Deny</Button>
          <Button variant="primary" onClick={() => onAnswer(true)} autoFocus>
            Allow <Kbd>⏎</Kbd>
          </Button>
        </div>
      )}
    </div>
  );
}

export function RunView({
  run,
  onCancel,
  onAnswer,
}: {
  run: Run;
  onCancel: () => void;
  onAnswer: (confirmId: string, allow: boolean) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [run.steps.length, run.status]);

  const pending = pendingConfirm(run);
  useEffect(() => {
    if (!pending) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter') onAnswer(pending.id, true);
      if (e.key === 'Escape') onAnswer(pending.id, false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, onAnswer]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="hairline-b flex items-center gap-2 px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-medium tracking-tight">{run.title}</span>
        <Pill tone={STATUS_TONE[run.status]} pulse={run.status === 'running'}>
          {run.status}
        </Pill>
        {run.status === 'running' && (
          <button
            onClick={onCancel}
            aria-label="Stop"
            title="Stop"
            className="inline-flex h-6 w-6 items-center justify-center rounded-md text-fg-2 hover:bg-bg-2 hover:text-fg"
          >
            <Square size={12} />
          </button>
        )}
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {run.steps.map((s) => {
          switch (s.kind) {
            case 'text':
              return (
                <p key={s.id} className="fade-in px-3 py-1 text-fg">
                  {s.text}
                  {s.partial && <span className="pulse-dot ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-accent" />}
                </p>
              );
            case 'tool':
              return <ToolRow key={s.id} step={s} />;
            case 'artifact':
              return <ArtifactRow key={s.id} step={s} />;
            case 'confirm':
              return <ConfirmCard key={s.id} step={s} onAnswer={(a) => onAnswer(s.id, a)} />;
          }
        })}
        {run.status !== 'running' && run.summary && (
          <div className="fade-in mx-2 mt-2 flex items-start gap-2 rounded-md px-1 py-1 text-fg-2">
            {run.status === 'done' ? (
              <Check size={14} className="mt-0.5 shrink-0 text-ok" />
            ) : (
              <X size={14} className="mt-0.5 shrink-0 text-fg-3" />
            )}
            <span>{run.summary}</span>
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}
