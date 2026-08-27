import { ArrowUp, Pause, Play, Slash, Square } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Skill } from '../protocol';
import type { Run } from '../state/runs';
import { filterCommands, type Command } from './CommandPalette';
import { Kbd } from './primitives';

/**
 * Chat composer. Typing "/" opens the skills palette inline (filtered as you type); ⏎ runs the selected skill
 * or sends the text. Placeholder starts with "Ask" — the harness finds the composer by it.
 */
export function Composer({
  skills,
  placeholder = 'Ask Dayflow to do something…',
  busy,
  activeRun,
  onSubmit,
  onRunSkill,
  onPause,
  onResume,
  onCancel,
}: {
  skills: Skill[];
  placeholder?: string;
  busy?: boolean;
  activeRun?: Run;
  onSubmit: (text: string) => void;
  onRunSkill: (id: string) => void;
  onPause?: () => void;
  onResume?: () => void;
  onCancel?: () => void;
}) {
  const [text, setText] = useState('');
  const [idx, setIdx] = useState(0);
  const area = useRef<HTMLTextAreaElement>(null);
  const slash = text.startsWith('/');
  const commands = useMemo<Command[]>(
    () => skills.filter((s) => s.enabled).map((s) => ({ id: s.id, title: s.title, hint: s.blurb, key: s.key, run: () => onRunSkill(s.id) })),
    [skills, onRunSkill],
  );
  const matches = useMemo(() => (slash ? filterCommands(commands, text.slice(1)) : []), [slash, commands, text]);

  useEffect(() => setIdx(0), [text]);
  useEffect(() => {
    if (!busy) area.current?.focus();
  }, [busy]);

  const submit = () => {
    const t = text.trim();
    if (!t) return;
    if (slash) {
      const c = matches[idx];
      if (!c) return;
      setText('');
      c.run();
      return;
    }
    onSubmit(t);
    setText('');
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash && matches.length) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setIdx((i) => Math.min(i + 1, matches.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setIdx((i) => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        const c = matches[idx];
        if (c) setText(`/${c.id}`);
        return;
      }
    }
    if (e.key === 'Escape') {
      if (slash) {
        e.preventDefault();
        setText('');
        return;
      }
      if (activeRun) {
        e.preventDefault();
        onCancel?.();
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const isRunning = activeRun?.status === 'running';
  const isPaused = activeRun?.status === 'paused';

  return (
    <div className="relative px-3 pb-3 pt-1">
      {slash && (
        <div className="fade-in absolute bottom-full left-3 right-3 z-10 mb-2 max-h-64 overflow-y-auto rounded-2xl bg-bg-1 p-1.5 shadow-xl" data-slash-palette>
          {matches.map((c, i) => (
            <button
              key={c.id}
              onMouseEnter={() => setIdx(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setText('');
                c.run();
              }}
              className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left ${i === idx ? 'bg-bg-2 text-fg' : 'text-fg-2'}`}
            >
              <Slash size={12} className="shrink-0 text-fg-3" />
              <span className="min-w-0 flex-1">
                <span className="block truncate">
                  <span className="font-mono text-[11.5px] text-accent">/{c.id}</span> <span>{c.title}</span>
                </span>
                {c.hint && <span className="block truncate text-[11px] text-fg-3">{c.hint}</span>}
              </span>
              {c.key && <Kbd>{c.key}</Kbd>}
            </button>
          ))}
          {matches.length === 0 && <div className="px-2 py-3 text-center text-[12px] text-fg-3">No skill matches “{text.slice(1)}”</div>}
        </div>
      )}
      <div className="flex items-end gap-1.5 rounded-[26px] bg-bg-1 py-1.5 pl-4 pr-1.5 transition-shadow focus-within:ring-2 focus-within:ring-accent/40">
        <textarea
          ref={area}
          autoFocus
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={isPaused ? 'Agent is paused…' : isRunning ? 'Agent is working…' : placeholder}
          className="max-h-32 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-[14px] outline-none placeholder:text-fg-3"
        />
        {isRunning ? (
          <div className="mb-0.5 flex items-center gap-1">
            {onPause && (
              <button
                onClick={onPause}
                aria-label="Pause run"
                title="Pause run"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-2 text-fg-2 transition-colors hover:bg-bg-3 hover:text-fg"
              >
                <Pause size={13} />
              </button>
            )}
            {onCancel && (
              <button
                onClick={onCancel}
                aria-label="Stop run"
                title="Stop run (Esc)"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-err text-white transition-opacity hover:opacity-90"
              >
                <Square size={12} fill="currentColor" />
              </button>
            )}
          </div>
        ) : isPaused ? (
          <div className="mb-0.5 flex items-center gap-1">
            {onResume && (
              <button
                onClick={onResume}
                aria-label="Resume run"
                title="Resume run"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-ok text-white transition-opacity hover:opacity-90"
              >
                <Play size={13} fill="currentColor" />
              </button>
            )}
            {onCancel && (
              <button
                onClick={onCancel}
                aria-label="Stop run"
                title="Stop run (Esc)"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-err text-white transition-opacity hover:opacity-90"
              >
                <Square size={12} fill="currentColor" />
              </button>
            )}
          </div>
        ) : (
          <button
            onClick={submit}
            disabled={!text.trim() || (slash && !matches.length)}
            aria-label="Send"
            className="mb-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent text-on-accent transition-opacity disabled:opacity-30"
          >
            <ArrowUp size={14} />
          </button>
        )}
      </div>
      <div className="flex items-center gap-1 px-3 pt-1.5 text-[11px] text-fg-3">
        {isRunning || isPaused ? (
          <>
            <Kbd>Esc</Kbd> stop · {isPaused ? <><Kbd>▶</Kbd> resume · </> : <><Kbd>❚❚</Kbd> pause · </>}<Kbd>⌘K</Kbd> palette
          </>
        ) : (
          <>
            <Kbd>⏎</Kbd> send · <Kbd>/</Kbd> skills · <Kbd>⌘K</Kbd> palette
          </>
        )}
      </div>
    </div>
  );
}
