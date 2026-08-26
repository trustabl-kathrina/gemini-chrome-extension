import { ArrowUp, Slash } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Skill } from '../protocol';
import { filterCommands, type Command } from './CommandPalette';
import { Kbd } from './primitives';

/**
 * Chat composer. Typing "/" opens the skills palette inline (filtered as you type); ⏎ runs the selected skill
 * or sends the text. Placeholder starts with "Ask" — the harness finds the composer by it.
 */
export function Composer({
  skills,
  placeholder = 'Ask Dayflow to do something in this tab…',
  busy,
  onSubmit,
  onRunSkill,
}: {
  skills: Skill[];
  placeholder?: string;
  busy?: boolean;
  onSubmit: (text: string) => void;
  onRunSkill: (id: string) => void;
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
    if (e.key === 'Escape' && slash) {
      e.preventDefault();
      setText('');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="hairline-t relative bg-bg p-2">
      {slash && (
        <div className="fade-in hairline absolute bottom-full left-2 right-2 z-10 mb-1 max-h-64 overflow-y-auto rounded-md bg-bg-1 p-1 shadow-2xl" data-slash-palette>
          {matches.map((c, i) => (
            <button
              key={c.id}
              onMouseEnter={() => setIdx(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                setText('');
                c.run();
              }}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${i === idx ? 'bg-bg-2 text-fg' : 'text-fg-2'}`}
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
      <div className="hairline flex items-end gap-1 rounded-md bg-bg-1 p-1 focus-within:ring-1 focus-within:ring-accent/60">
        <textarea
          ref={area}
          autoFocus
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder}
          className="max-h-32 min-h-7 flex-1 resize-none bg-transparent px-1.5 py-1 outline-none placeholder:text-fg-3"
        />
        <button
          onClick={submit}
          disabled={!text.trim() || (slash && !matches.length)}
          aria-label="Send"
          className="inline-flex h-6 w-6 items-center justify-center rounded-sm bg-accent text-white transition-opacity disabled:opacity-30"
        >
          <ArrowUp size={14} />
        </button>
      </div>
      <div className="flex items-center gap-1 px-1 pt-1 text-[11px] text-fg-3">
        <Kbd>⏎</Kbd> send · <Kbd>/</Kbd> skills · <Kbd>⌘K</Kbd> palette
      </div>
    </div>
  );
}
