import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'ghost' | 'danger';

/** Material-style pills: filled primary, tonal ghost, tonal danger. */
export function Button({ variant = 'ghost', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const base = 'inline-flex h-8 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';
  const look = {
    primary: 'bg-accent text-on-accent hover:brightness-110',
    ghost: 'bg-bg-1 text-fg hover:bg-bg-2',
    danger: 'bg-err/10 text-err hover:bg-err/15',
  }[variant];
  return <button className={`${base} ${look} ${className}`} {...props} />;
}

export function IconButton({ label, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={`inline-flex h-8 w-8 items-center justify-center rounded-full text-fg-2 transition-colors duration-150 hover:bg-bg-2 hover:text-fg ${className}`}
      {...props}
    />
  );
}

export function Pill({ tone = 'neutral', children, pulse }: { tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'err'; children: ReactNode; pulse?: boolean }) {
  const dot = { neutral: 'bg-fg-3', accent: 'bg-accent', ok: 'bg-ok', warn: 'bg-warn', err: 'bg-err' }[tone];
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-bg-1 px-2.5 text-[11.5px] text-fg-2">
      <span className={`h-1.5 w-1.5 rounded-full ${dot} ${pulse ? 'pulse-dot' : ''}`} />
      {children}
    </span>
  );
}

/** Material switch: 32×18 track, 14px thumb. */
export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-[18px] w-8 shrink-0 rounded-full transition-colors duration-150 ${checked ? 'bg-accent' : 'bg-bg-2 hairline'}`}
    >
      <span
        className={`absolute left-0 top-0.5 h-[14px] w-[14px] rounded-full transition-transform duration-150 ${checked ? 'translate-x-[16px] bg-on-accent' : 'translate-x-0.5 bg-fg-3'}`}
      />
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[12px] font-medium text-fg-2">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-fg-3">{hint}</span>}
    </label>
  );
}

export const inputCls = 'w-full rounded-xl bg-bg-1 px-3 py-2 text-fg outline-none placeholder:text-fg-3 focus:ring-2 focus:ring-accent/50';

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-1 pb-1.5 pt-3 text-[12px] font-medium text-fg-2">{children}</div>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <span className="kbd">{children}</span>;
}

export function relTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}
