import type { ButtonHTMLAttributes, ReactNode } from 'react';

type Variant = 'primary' | 'ghost' | 'danger';

export function Button({ variant = 'ghost', className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const base = 'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors duration-150 disabled:opacity-40 disabled:pointer-events-none';
  const look = {
    primary: 'bg-accent text-white hover:brightness-110',
    ghost: 'hairline text-fg-2 hover:bg-bg-2 hover:text-fg',
    danger: 'hairline text-err hover:bg-err/10',
  }[variant];
  return <button className={`${base} ${look} ${className}`} {...props} />;
}

export function IconButton({ label, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string }) {
  return (
    <button
      aria-label={label}
      title={label}
      className={`inline-flex h-7 w-7 items-center justify-center rounded-md text-fg-2 transition-colors duration-150 hover:bg-bg-2 hover:text-fg ${className}`}
      {...props}
    />
  );
}

export function Pill({ tone = 'neutral', children, pulse }: { tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'err'; children: ReactNode; pulse?: boolean }) {
  const dot = { neutral: 'bg-fg-3', accent: 'bg-accent', ok: 'bg-ok', warn: 'bg-warn', err: 'bg-err' }[tone];
  return (
    <span className="hairline inline-flex h-5 items-center gap-1.5 rounded-full px-2 text-[11px] text-fg-2">
      <span className={`h-1.5 w-1.5 rounded-full ${dot} ${pulse ? 'pulse-dot' : ''}`} />
      {children}
    </span>
  );
}

export function Toggle({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors duration-150 ${checked ? 'bg-accent' : 'bg-bg-2 hairline'}`}
    >
      <span className={`absolute left-0 top-0.5 h-3 w-3 rounded-full bg-white transition-transform duration-150 ${checked ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[11px] font-medium uppercase tracking-wide text-fg-3">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-fg-3">{hint}</span>}
    </label>
  );
}

export const inputCls = 'hairline w-full rounded-md bg-bg-1 px-2 py-1.5 text-fg outline-none placeholder:text-fg-3 focus:ring-1 focus:ring-accent/60';

export function SectionLabel({ children }: { children: ReactNode }) {
  return <div className="px-1 pb-1.5 pt-3 text-[11px] font-medium uppercase tracking-wide text-fg-3">{children}</div>;
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
