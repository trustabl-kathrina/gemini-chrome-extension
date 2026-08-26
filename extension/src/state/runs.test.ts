import { describe, expect, it } from 'vitest';
import { answerConfirm, applyEvent, browserActions, newRun, pendingConfirm } from './runs';

describe('applyEvent', () => {
  it('merges streamed partial text into one step', () => {
    let run = newRun('r1', 'x', undefined, 0);
    run = applyEvent(run, { kind: 'text', text: 'Hel', partial: true });
    run = applyEvent(run, { kind: 'text', text: 'lo', partial: false });
    run = applyEvent(run, { kind: 'text', text: 'Next' });
    expect(run.steps.map((s) => (s.kind === 'text' ? s.text : ''))).toEqual(['Hello', 'Next']);
  });

  it('resolves a tool call by id and ignores unknown results', () => {
    let run = newRun('r1', 'x', undefined, 0);
    run = applyEvent(run, { kind: 'tool.call', target: 'browser', call: { id: 'c1', name: 'read_page', args: {} } });
    const before = run;
    run = applyEvent(run, { kind: 'tool.result', callId: 'nope', ok: true, summary: '', ms: 1 });
    expect(run).toBe(before);
    run = applyEvent(run, { kind: 'tool.result', callId: 'c1', ok: false, summary: 'timeout', ms: 30, screenshot: 'data:image/jpeg;base64,AAA' });
    const step = run.steps[0];
    expect(step?.kind === 'tool' && step.status).toBe('error');
    expect(step?.kind === 'tool' && step.screenshot).toBe('data:image/jpeg;base64,AAA');
  });

  it('keeps the full prompt and counts browser actions', () => {
    let run = newRun('r1', 'Sync my files from WSP into the vault, please', 'vault-sync', 0);
    expect(run.prompt).toBe('Sync my files from WSP into the vault, please');
    run = applyEvent(run, { kind: 'tool.call', target: 'browser', call: { id: 'c1', name: 'read_page', args: {} } });
    run = applyEvent(run, { kind: 'tool.call', target: 'browser', call: { id: 'c1', name: 'read_page', args: {} } }); // stream repeat → no second row
    run = applyEvent(run, { kind: 'tool.call', target: 'server', call: { id: 'c2', name: 'parse_document', args: {} } });
    expect(browserActions(run)).toBe(1);
  });

  it('tracks confirmations', () => {
    let run = newRun('r1', 'x', undefined, 0);
    run = applyEvent(run, { kind: 'confirm', id: 'k1', message: 'Send?' });
    expect(pendingConfirm(run)?.id).toBe('k1');
    run = answerConfirm(run, 'k1', true);
    expect(pendingConfirm(run)).toBeUndefined();
    run = applyEvent(run, { kind: 'run.end', status: 'done', summary: 'ok' });
    expect(run.status).toBe('done');
  });
});
