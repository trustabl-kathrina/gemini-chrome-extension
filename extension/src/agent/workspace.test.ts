import { describe, expect, it } from 'vitest';
import { GROUP_COLOR, GROUP_TITLE, Workspace, type WorkspaceApi } from './workspace';

/** Enough of chrome.tabs / tabGroups / windows to exercise the workspace: tabs, groups and windows as plain records. */
function fakeChrome() {
  const tabs = new Map<number, { id: number; windowId: number; groupId: number; active: boolean }>();
  const groups = new Map<number, { id: number; windowId: number; title?: string; color?: string }>();
  const windows = new Set<number>([1]); // the user's window
  let nextTab = 10;
  let nextGroup = 100;
  let nextWindow = 2;
  const calls: string[] = [];
  const api: WorkspaceApi = {
    tabs: {
      async create(p) {
        const windowId = p.windowId ?? 1;
        if (!windows.has(windowId)) throw new Error('no such window');
        const t = { id: nextTab++, windowId, groupId: -1, active: !!p.active };
        tabs.set(t.id, t);
        calls.push(`tabs.create ${p.url} win=${windowId} active=${!!p.active}`);
        return t;
      },
      async query(q) {
        return [...tabs.values()].filter((t) => (q.windowId === undefined || t.windowId === q.windowId) && (q.active === undefined || t.active === q.active));
      },
      async group(p) {
        const id = p.groupId ?? nextGroup++;
        const first = tabs.get(p.tabIds[0]!);
        if (!first) throw new Error('no tab');
        if (p.groupId === undefined) groups.set(id, { id, windowId: p.createProperties?.windowId ?? first.windowId });
        for (const tid of p.tabIds) tabs.get(tid)!.groupId = id;
        calls.push(`tabs.group ${p.tabIds.join(',')} → ${id}`);
        return id;
      },
      async get(id) {
        const t = tabs.get(id);
        if (!t) throw new Error('no tab');
        return t;
      },
    },
    tabGroups: {
      async query(q) {
        return [...groups.values()].filter((g) => q.title === undefined || g.title === q.title);
      },
      async update(id, p) {
        Object.assign(groups.get(id)!, p);
        calls.push(`tabGroups.update ${id} ${p.title}/${p.color}`);
      },
    },
    windows: {
      async create(p) {
        const id = nextWindow++;
        windows.add(id);
        const t = { id: nextTab++, windowId: id, groupId: -1, active: true };
        tabs.set(t.id, t);
        calls.push(`windows.create ${p.url} focused=${p.focused}`);
        return { id, tabs: [t] };
      },
      async get(id) {
        if (!windows.has(id)) throw new Error('no window');
        return { id };
      },
    },
    _close: (id: number) => {
      windows.delete(id);
      for (const t of [...tabs.values()]) if (t.windowId === id) tabs.delete(t.id);
      for (const g of [...groups.values()]) if (g.windowId === id) groups.delete(g.id);
    },
  } as WorkspaceApi & { _close: (id: number) => void };
  return { api, calls, tabs, groups };
}

describe('Workspace', () => {
  it('opens the first tab in its own unfocused window and names the group', async () => {
    const { api, calls, groups } = fakeChrome();
    const ws = new Workspace(api, true);
    const id = await ws.createTab('https://wsp.kbtu.kz', true);
    expect(calls).toEqual(['windows.create https://wsp.kbtu.kz focused=false', `tabs.group ${id} → 100`, `tabGroups.update 100 ${GROUP_TITLE}/${GROUP_COLOR}`]);
    expect([...groups.values()][0]).toMatchObject({ title: GROUP_TITLE, windowId: 2 });
    expect(await ws.owns(id)).toBe(true);
    expect(await ws.activeTab()).toBe(id);
  });

  it('adds later tabs to the same window and group', async () => {
    const { api, calls, tabs } = fakeChrome();
    const ws = new Workspace(api, true);
    const a = await ws.createTab('https://a', true);
    const b = await ws.createTab('https://b', false);
    expect(calls.at(-2)).toBe('tabs.create https://b win=2 active=false');
    expect(tabs.get(b)!.groupId).toBe(tabs.get(a)!.groupId);
    expect(calls.filter((c) => c.startsWith('windows.create'))).toHaveLength(1);
  });

  it('recreates the window when the user closed it', async () => {
    const { api, calls } = fakeChrome();
    const ws = new Workspace(api, true);
    await ws.createTab('https://a', true);
    (api as unknown as { _close: (id: number) => void })._close(2);
    expect(await ws.activeTab()).toBeUndefined();
    await ws.createTab('https://b', true);
    expect(calls.filter((c) => c.startsWith('windows.create'))).toHaveLength(2);
  });

  it('without its own window, groups inside the current window', async () => {
    const { api, calls, tabs } = fakeChrome();
    const ws = new Workspace(api, false);
    const id = await ws.createTab('https://a', false);
    expect(calls[0]).toBe('tabs.create https://a win=1 active=false');
    expect(tabs.get(id)!.windowId).toBe(1);
    expect(await ws.owns(id)).toBe(true);
    expect(await ws.owns(999)).toBe(false);
  });
});
