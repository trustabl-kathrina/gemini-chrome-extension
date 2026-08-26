/** Minimal 5-field cron (min hour dom mon dow) with `*`, lists, ranges and steps. Local time. */

export interface CronSpec {
  min: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  mon: Set<number>;
  dow: Set<number>;
}

function field(expr: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const part of expr.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${part}"`);
    let a = lo;
    let b = hi;
    if (rangePart !== '*') {
      const [x, y] = (rangePart ?? '').split('-').map(Number);
      if (x === undefined || !Number.isInteger(x)) throw new Error(`bad value in "${part}"`);
      a = x;
      b = y === undefined ? (stepPart ? hi : x) : y;
      if (!Number.isInteger(b) || a < lo || b > hi || a > b) throw new Error(`out of range in "${part}"`);
    }
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): CronSpec {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error('cron needs 5 fields');
  const [m, h, d, mo, w] = f as [string, string, string, string, string];
  const dow = field(w, 0, 7);
  if (dow.has(7)) dow.add(0);
  return { min: field(m, 0, 59), hour: field(h, 0, 23), dom: field(d, 1, 31), mon: field(mo, 1, 12), dow };
}

/** Next matching time strictly after `from`, or null if none within a year. */
export function nextRun(expr: string, from: Date): Date | null {
  const c = parseCron(expr);
  const t = new Date(from);
  t.setSeconds(0, 0);
  t.setMinutes(t.getMinutes() + 1);
  const limit = from.getTime() + 366 * 24 * 3600 * 1000;
  while (t.getTime() <= limit) {
    if (!c.mon.has(t.getMonth() + 1)) {
      t.setMonth(t.getMonth() + 1, 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.dom.has(t.getDate()) || !c.dow.has(t.getDay())) {
      t.setDate(t.getDate() + 1);
      t.setHours(0, 0, 0, 0);
      continue;
    }
    if (!c.hour.has(t.getHours())) {
      t.setHours(t.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!c.min.has(t.getMinutes())) {
      t.setMinutes(t.getMinutes() + 1, 0, 0);
      continue;
    }
    return t;
  }
  return null;
}
