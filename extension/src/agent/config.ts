import { parse, stringify, YAMLParseError } from 'yaml';
import type { UserConfig } from './sync';

/** Client-side shape check for the brain's UserConfig; the brain (pydantic) is the final judge. */
export function validateUserConfig(value: unknown): string[] {
  const errors: string[] = [];
  const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!isObj(value)) return ['config must be a YAML mapping with skills / sites / permissions'];
  const str = (v: unknown) => typeof v === 'string';
  const strList = (v: unknown) => Array.isArray(v) && v.every(str);

  const skills = value.skills;
  if (skills !== undefined && !Array.isArray(skills)) errors.push('skills: must be a list');
  if (Array.isArray(skills)) {
    const ids = new Set<string>();
    skills.forEach((s, i) => {
      const at = `skills[${i}]`;
      if (!isObj(s)) return void errors.push(`${at}: must be a mapping`);
      for (const k of ['id', 'title', 'prompt', 'instructions']) if (!str(s[k]) || !(s[k] as string).trim()) errors.push(`${at}.${k}: required string`);
      if (str(s.id)) {
        if (ids.has(s.id)) errors.push(`${at}.id: duplicate "${s.id}"`);
        ids.add(s.id);
      }
      for (const k of ['tools', 'sites']) if (s[k] !== undefined && !strList(s[k])) errors.push(`${at}.${k}: must be a list of strings`);
      if (s.schedule !== undefined && s.schedule !== null && !str(s.schedule)) errors.push(`${at}.schedule: cron string or null`);
      if (str(s.schedule) && s.schedule.trim().split(/\s+/).length !== 5) errors.push(`${at}.schedule: cron needs 5 fields ("0 8 * * 1-5")`);
      if (s.enabled !== undefined && typeof s.enabled !== 'boolean') errors.push(`${at}.enabled: true or false`);
    });
  }

  const sites = value.sites;
  if (sites !== undefined && !Array.isArray(sites)) errors.push('sites: must be a list');
  if (Array.isArray(sites)) {
    sites.forEach((s, i) => {
      const at = `sites[${i}]`;
      if (!isObj(s)) return void errors.push(`${at}: must be a mapping`);
      if (!str(s.domain) || !s.domain.trim()) errors.push(`${at}.domain: required`);
      if (s.notes !== undefined && !str(s.notes)) errors.push(`${at}.notes: must be text`);
      if (s.allow !== undefined && typeof s.allow !== 'boolean') errors.push(`${at}.allow: true or false`);
      if (s.mode !== undefined && s.mode !== 'dom' && s.mode !== 'vision') errors.push(`${at}.mode: "dom" or "vision"`);
    });
  }

  const p = value.permissions;
  if (p !== undefined) {
    if (!isObj(p)) errors.push('permissions: must be a mapping');
    else {
      if (p.allowed_hosts !== undefined && !strList(p.allowed_hosts)) errors.push('permissions.allowed_hosts: list of domains');
      if (p.ask_before !== undefined && !strList(p.ask_before)) errors.push('permissions.ask_before: list of tool names');
      if (p.mode !== undefined && p.mode !== 'ask' && p.mode !== 'auto') errors.push('permissions.mode: "ask" or "auto"');
    }
  }
  const c = value.connections;
  if (c !== undefined && (!isObj(c) || Object.values(c).some((v) => typeof v !== 'boolean'))) errors.push('connections: mapping of name → true/false');
  if (value.vault_folder !== undefined && !str(value.vault_folder)) errors.push('vault_folder: must be text');
  if (value.memory !== undefined && !str(value.memory)) errors.push('memory: must be text');
  return errors;
}

export function parseConfigYaml(text: string): { config: UserConfig | null; errors: string[] } {
  let value: unknown;
  try {
    value = parse(text);
  } catch (e) {
    const pos = e instanceof YAMLParseError && e.linePos?.[0] ? ` (line ${e.linePos[0].line})` : '';
    return { config: null, errors: [`YAML: ${e instanceof Error ? e.message.split('\n')[0] : String(e)}${pos}`] };
  }
  if (value === null || value === undefined) return { config: null, errors: ['config is empty'] };
  const errors = validateUserConfig(value);
  return { config: errors.length ? null : (value as UserConfig), errors };
}

/** Readable key order per level (id/title first, long instructions last) instead of whatever order the JSON came in. */
const ORDER = {
  top: ['skills', 'sites', 'permissions', 'connections', 'vault_folder', 'memory'],
  skill: ['id', 'title', 'blurb', 'prompt', 'key', 'enabled', 'schedule', 'sites', 'tools', 'instructions', 'pack'],
  site: ['domain', 'mode', 'allow', 'notes'],
};

function ordered<T extends Record<string, unknown>>(obj: T, keys: string[]): T {
  const rest = Object.keys(obj).filter((k) => !keys.includes(k)).sort();
  return Object.fromEntries([...keys.filter((k) => k in obj), ...rest].map((k) => [k, obj[k]])) as T;
}

export function toConfigYaml(cfg: UserConfig): string {
  const shaped = ordered(
    {
      ...cfg,
      skills: (cfg.skills ?? []).map((s) => ordered(s, ORDER.skill)),
      sites: (cfg.sites ?? []).map((s) => ordered(s, ORDER.site)),
    },
    ORDER.top,
  );
  return stringify(shaped, { lineWidth: 0, defaultStringType: 'PLAIN', defaultKeyType: 'PLAIN' });
}
