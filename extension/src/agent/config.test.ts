import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS } from '../protocol';
import { parseConfigYaml, toConfigYaml, validateUserConfig } from './config';
import { toUserConfig } from './sync';

describe('config YAML', () => {
  it('round-trips the default config', () => {
    const cfg = toUserConfig(DEFAULT_SETTINGS);
    const { config, errors } = parseConfigYaml(toConfigYaml(cfg));
    expect(errors).toEqual([]);
    expect(config).toEqual(cfg);
  });

  it('reports YAML syntax errors with a line', () => {
    const { config, errors } = parseConfigYaml('skills:\n  - id: a\n   title: [unclosed');
    expect(config).toBeNull();
    expect(errors[0]).toMatch(/^YAML:/);
  });

  it('validates shape: required skill fields, duplicate ids, cron, site mode, permissions', () => {
    const errors = validateUserConfig({
      skills: [
        { id: 'a', title: 'A', prompt: 'p', instructions: 'i', schedule: '0 8 * *' },
        { id: 'a', title: '', prompt: 'p', instructions: 'i', tools: 'read_page' },
      ],
      sites: [{ domain: 'x.test', mode: 'magic' }],
      permissions: { mode: 'yolo', allowed_hosts: 'x' },
      connections: { github: 'yes' },
    });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining('skills[0].schedule: cron needs 5 fields'),
        expect.stringContaining('skills[1].title: required'),
        expect.stringContaining('skills[1].id: duplicate'),
        expect.stringContaining('skills[1].tools: must be a list'),
        expect.stringContaining('sites[0].mode'),
        expect.stringContaining('permissions.mode'),
        expect.stringContaining('permissions.allowed_hosts'),
        expect.stringContaining('connections'),
      ]),
    );
    expect(validateUserConfig('nope')).toHaveLength(1);
    expect(parseConfigYaml('').errors).toEqual(['config is empty']);
  });
});
