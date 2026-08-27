import { describe, expect, it } from 'vitest';
import { shotPolicy } from './shots';

describe('shotPolicy', () => {
  it('skips the tools whose result already describes the view', () => {
    expect(shotPolicy('read_page')).toBe('never');
    expect(shotPolicy('list_tabs')).toBe('never');
    expect(shotPolicy('download')).toBe('never');
  });
  it('always captures for an explicit screenshot and only on change for actions', () => {
    expect(shotPolicy('screenshot')).toBe('always');
    for (const t of ['click', 'click_at', 'type', 'press_key', 'scroll', 'navigate', 'open_tab', 'wait', 'run_js', 'set_viewport']) expect(shotPolicy(t)).toBe('if-changed');
  });
});
