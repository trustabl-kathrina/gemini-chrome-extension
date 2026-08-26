import { Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Skill } from '../protocol';
import { Kbd } from './primitives';

export interface Command {
  id: string;
  title: string;
  hint?: string;
  key?: string;
  run: () => void;
}

export function commandsFromSkills(skills: Skill[], run: (id: string) => void): Command[] {
  return skills
    .filter((s) => s.enabled)
    .map((s) => ({ id: `skill:${s.id}`, title: s.title, hint: s.blurb, key: s.key, run: () => run(s.id) }));
}

/** Substring match on title + hint + id, case-insensitive; empty query = everything. */
export function filterCommands(commands: Command[], query: string): Command[] {
  const needle = query.trim().toLowerCase();
  return needle ? commands.filter((c) => `${c.title} ${c.hint ?? ''} ${c.id}`.toLowerCase().includes(needle)) : commands;
}

export function CommandPalette({ commands, onClose, initialQuery = '' }: { commands: Command[]; onClose: () => void; initialQuery?: string }) {
  const [q, setQ] = useState(initialQuery);
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => filterCommands(commands, q), [q, commands]);

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setIdx(0), [q]);

  const pick = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIdx((i) => Math.min(i + 1, list.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIdx((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      pick(list[idx]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (!q && /^[1-9]$/.test(e.key)) {
      const c = commands.find((x) => x.key === e.key);
      if (c) {
        e.preventDefault();
        pick(c);
      }
    }
  };

  return (
    <div className="absolute inset-0 z-20 flex items-start justify-center bg-bg/70 p-3 pt-10 backdrop-blur-[2px]" onMouseDown={onClose}>
      <div className="fade-in w-full max-w-sm overflow-hidden rounded-3xl bg-bg-1 shadow-2xl" onMouseDown={(e) => e.stopPropagation()}>
        <div className="hairline-b flex items-center gap-2 px-3">
          <Search size={14} className="text-fg-3" />
          <input
            ref={input}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="Run a skill or jump to…"
            className="h-10 flex-1 bg-transparent outline-none placeholder:text-fg-3"
          />
          <Kbd>esc</Kbd>
        </div>
        <ul className="max-h-80 overflow-y-auto p-1">
          {list.map((c, i) => (
            <li key={c.id}>
              <button
                onMouseEnter={() => setIdx(i)}
                onClick={() => pick(c)}
                className={`flex w-full items-center gap-2 rounded-xl px-2.5 py-1.5 text-left ${i === idx ? 'bg-bg-2 text-fg' : 'text-fg-2'}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{c.title}</span>
                  {c.hint && <span className="block truncate text-[11px] text-fg-3">{c.hint}</span>}
                </span>
                {c.key && <Kbd>{c.key}</Kbd>}
              </button>
            </li>
          ))}
          {list.length === 0 && <li className="px-2 py-4 text-center text-fg-3">Nothing matches</li>}
        </ul>
      </div>
    </div>
  );
}
