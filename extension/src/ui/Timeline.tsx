import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  FileText,
  Folder,
  GitBranch,
  GitPullRequest,
  Globe,
  Image as ImageIcon,
  Link2,
  Loader2,
  Presentation,
  Server,
  Square,
  X,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ArtifactType } from '../protocol';
import { browserActions, pendingConfirm, type Run, type Step } from '../state/runs';
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

/** `key=value` pairs, long strings clipped, screenshots never shown here. */
export function argsSummary(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([k]) => k !== 'screenshot_b64')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? (v.length > 60 ? `${v.slice(0, 57)}…` : v) : JSON.stringify(v)}`)
    .join(' ')
    .slice(0, 140);
}

/** Only http(s) links are rendered as anchors; anything else (javascript:, file:, …) shows as plain text. */
export function safeHref(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

function TextStep({ step }: { step: Extract<Step, { kind: 'text' }> }) {
  return (
    <p className="fade-in whitespace-pre-wrap px-3 py-1 text-fg" data-step="text">
      {step.text}
      {step.partial && <span className="pulse-dot ml-0.5 inline-block h-3.5 w-1.5 translate-y-0.5 bg-accent" />}
    </p>
  );
}

function ToolRow({ step }: { step: Extract<Step, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  const Icon = step.target === 'browser' ? Globe : Server;
  const args = argsSummary(step.call.args);
  return (
    <div
      className="fade-in mx-1 rounded-md px-2 py-1 font-mono text-[11.5px]"
      data-step="tool"
      data-name={step.call.name}
      data-args={args}
      data-summary={step.summary ?? ''}
      data-target={step.target}
      data-status={step.status}
      data-ms={step.ms ?? ''}
    >
      <div className="flex items-start gap-2">
        <Icon size={13} className="mt-0.5 shrink-0 text-fg-3" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-fg" data-tool-name>
              {step.call.name}
            </span>
            <span className="truncate text-fg-3" data-tool-args title={args}>
              {args}
            </span>
          </div>
          {step.summary && (
            <div className="truncate text-fg-2" data-tool-summary title={step.summary}>
              {step.summary}
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5 text-fg-3">
          {step.screenshot && (
            <button
              onClick={() => setOpen((o) => !o)}
              aria-label={open ? 'Hide screenshot' : 'Show screenshot'}
              title={open ? 'Hide screenshot' : 'Show screenshot'}
              className={`inline-flex h-5 items-center gap-0.5 rounded-sm px-1 transition-colors hover:bg-bg-2 hover:text-fg ${open ? 'text-fg' : ''}`}
            >
              <ImageIcon size={12} />
              {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
            </button>
          )}
          {step.ms !== undefined && <span>{(step.ms / 1000).toFixed(1)}s</span>}
          {step.status === 'running' && <Loader2 size={13} className="animate-spin text-accent" />}
          {step.status === 'ok' && <Check size={13} className="text-ok" />}
          {step.status === 'error' && <X size={13} className="text-err" />}
        </div>
      </div>
      {open && step.screenshot && (
        <a href={step.screenshot} target="_blank" rel="noreferrer noopener" className="mt-1.5 block">
          <img src={step.screenshot} alt={`Screenshot after ${step.call.name}`} className="hairline max-h-60 w-full rounded-md object-contain" style={{ maxWidth: 320 }} />
        </a>
      )}
    </div>
  );
}

function ArtifactRow({ step }: { step: Extract<Step, { kind: 'artifact' }> }) {
  const Icon = ARTIFACT_ICON[step.type] ?? Link2;
  const href = safeHref(step.href);
  const inner = (
    <>
      <Icon size={13} className="shrink-0 text-accent" />
      <span className="truncate">{step.label}</span>
    </>
  );
  const cls = 'fade-in hairline mx-2 my-0.5 flex items-center gap-2 rounded-md bg-accent-soft px-2.5 py-1.5 text-fg';
  return href ? (
    <a href={href} target="_blank" rel="noreferrer noopener" className={`${cls} hover:brightness-110`} data-step="artifact" data-type={step.type} data-href={href}>
      {inner}
    </a>
  ) : (
    <div className={cls} data-step="artifact" data-type={step.type}>
      {inner}
    </div>
  );
}

function ConfirmCard({ step, onAnswer }: { step: Extract<Step, { kind: 'confirm' }>; onAnswer: (allow: boolean) => void }) {
  const pending = step.answer === 'pending';
  return (
    <div className="fade-in hairline mx-2 my-1 rounded-md bg-bg-1 p-3" data-step="confirm" data-message={step.message} data-answer={step.answer}>
      <div className="mb-2 flex items-center gap-2">
        <Pill tone={pending ? 'warn' : step.answer === 'allowed' ? 'ok' : 'neutral'} pulse={pending}>
          {pending ? 'needs your OK' : step.answer}
        </Pill>
      </div>
      <p className="whitespace-pre-wrap text-fg" data-confirm-message>
        {step.message}
      </p>
      {pending && (
        <div className="mt-3 flex justify-end gap-1.5">
          <Button onClick={() => onAnswer(false)} data-confirm="deny">
            Deny
          </Button>
          <Button variant="primary" onClick={() => onAnswer(true)} autoFocus data-confirm="allow">
            Allow <Kbd>⏎</Kbd>
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * One run in the transcript: the user's prompt, then reasoning → tool rows (with screenshot thumbnails) →
 * artifacts → confirmation cards, then the closing summary. `latest` marks the run the harness reads.
 */
export function RunBlock({
  run,
  latest,
  onCancel,
  onAnswer,
}: {
  run: Run;
  latest: boolean;
  onCancel: () => void;
  onAnswer: (confirmId: string, allow: boolean) => void;
}) {
  const pending = pendingConfirm(run);
  useEffect(() => {
    if (!pending || !latest) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.tagName === 'TEXTAREA') return;
      if (e.key === 'Enter') onAnswer(pending.id, true);
      if (e.key === 'Escape') onAnswer(pending.id, false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending, latest, onAnswer]);

  const actions = browserActions(run);
  return (
    <section className="py-2" data-run={run.id}>
      <div className="mx-2 mb-1 flex items-start gap-2 rounded-md bg-bg-1 px-3 py-2">
        <span className="mt-0.5 font-mono text-[12px] text-accent">›</span>
        <p className="min-w-0 flex-1 whitespace-pre-wrap text-fg" {...(latest ? { 'data-run-title': true } : {})}>
          {run.prompt}
        </p>
        <div className="flex shrink-0 items-center gap-1">
          <span {...(latest ? { 'data-run-status': run.status } : {})}>
            <Pill tone={STATUS_TONE[run.status]} pulse={run.status === 'running'}>
              {run.status}
            </Pill>
          </span>
          {run.status === 'running' && (
            <button
              onClick={onCancel}
              aria-label="Stop"
              title="Stop"
              data-action="stop"
              className="inline-flex h-6 w-6 items-center justify-center rounded-md text-fg-2 hover:bg-bg-2 hover:text-fg"
            >
              <Square size={12} />
            </button>
          )}
        </div>
      </div>
      {run.steps.map((s) => {
        switch (s.kind) {
          case 'text':
            return <TextStep key={s.id} step={s} />;
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
          {run.status === 'done' ? <Check size={14} className="mt-0.5 shrink-0 text-ok" /> : <X size={14} className="mt-0.5 shrink-0 text-fg-3" />}
          <span className="min-w-0 flex-1 whitespace-pre-wrap" {...(latest ? { 'data-run-summary': true } : {})}>
            {run.summary}
          </span>
          {actions > 0 && <span className="shrink-0 font-mono text-[11px] text-fg-3">{actions} actions</span>}
        </div>
      )}
    </section>
  );
}
