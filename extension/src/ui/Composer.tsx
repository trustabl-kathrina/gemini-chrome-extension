import { ArrowUp } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import { Kbd } from './primitives';

export function Composer({ placeholder, onSubmit, autoFocus }: { placeholder: string; onSubmit: (text: string) => void; autoFocus?: boolean }) {
  const [text, setText] = useState('');
  const submit = () => {
    const t = text.trim();
    if (!t) return;
    onSubmit(t);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };
  return (
    <div className="hairline-t bg-bg p-2">
      <div className="hairline flex items-end gap-1 rounded-md bg-bg-1 p-1 focus-within:ring-1 focus-within:ring-accent/60">
        <textarea
          autoFocus={autoFocus}
          rows={1}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          placeholder={placeholder}
          className="max-h-32 min-h-7 flex-1 resize-none bg-transparent px-1.5 py-1 outline-none placeholder:text-fg-3"
        />
        <button
          onClick={submit}
          disabled={!text.trim()}
          aria-label="Send"
          className="inline-flex h-6 w-6 items-center justify-center rounded-sm bg-accent text-white transition-opacity disabled:opacity-30"
        >
          <ArrowUp size={14} />
        </button>
      </div>
      <div className="flex items-center gap-1 px-1 pt-1 text-[11px] text-fg-3">
        <Kbd>⏎</Kbd> run · <Kbd>⌘K</Kbd> skills
      </div>
    </div>
  );
}
