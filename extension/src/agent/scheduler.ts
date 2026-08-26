import { browser } from 'wxt/browser';
import type { Settings } from '../protocol';
import { nextRun } from './cron';

const PREFIX = 'skill:';

/** Re-registers one alarm per scheduled skill (idempotent; call on startup and whenever settings change). */
export async function syncAlarms(settings: Settings): Promise<string[]> {
  const existing = await browser.alarms.getAll();
  await Promise.all(existing.filter((a) => a.name.startsWith(PREFIX)).map((a) => browser.alarms.clear(a.name)));
  const registered: string[] = [];
  for (const skill of settings.skills) {
    if (!skill.enabled || !skill.schedule) continue;
    let when: Date | null;
    try {
      when = nextRun(skill.schedule, new Date());
    } catch {
      continue; // malformed cron: skip rather than crash the worker
    }
    if (!when) continue;
    await browser.alarms.create(`${PREFIX}${skill.id}`, { when: when.getTime() });
    registered.push(skill.id);
  }
  return registered;
}

export function skillIdFromAlarm(name: string): string | null {
  return name.startsWith(PREFIX) ? name.slice(PREFIX.length) : null;
}

export function notify(title: string, message: string) {
  void browser.notifications.create({ type: 'basic', iconUrl: browser.runtime.getURL('/icon/128.png'), title, message });
}
