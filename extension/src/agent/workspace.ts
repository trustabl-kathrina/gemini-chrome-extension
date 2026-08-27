/**
 * The agent's workspace: a "Dayflow" tab group, by default in a window of its own.
 *
 * Why a window and not only a group: screenshots come from `tabs.captureVisibleTab`, which needs the tab to be the
 * active one of its window — inside the user's window every capture would flip what they are looking at. In its
 * own (never focused) window the agent can activate tabs freely while the user keeps working. The group is what
 * the user sees: one colored strip, collapsible, easy to close. Ids are re-discovered through `tabGroups.query`
 * on every use, so a restarted service worker or a window the user closed never leaves the agent stranded.
 */

export const GROUP_TITLE = 'Dayflow';
export const GROUP_COLOR = 'blue';

export interface WorkspaceApi {
  tabs: {
    create(p: { url: string; windowId?: number; active?: boolean }): Promise<{ id?: number; windowId?: number }>;
    query(q: { groupId?: number; active?: boolean; windowId?: number; lastFocusedWindow?: boolean }): Promise<{ id?: number; windowId?: number; groupId?: number }[]>;
    group(p: { tabIds: number[]; groupId?: number; createProperties?: { windowId?: number } }): Promise<number>;
    get(id: number): Promise<{ id?: number; windowId?: number; groupId?: number }>;
  };
  tabGroups: {
    query(q: { title?: string }): Promise<{ id: number; windowId: number }[]>;
    update(id: number, p: { title?: string; color?: string; collapsed?: boolean }): Promise<unknown>;
  };
  windows: {
    create(p: { url: string; focused?: boolean; type?: 'normal' }): Promise<{ id?: number; tabs?: { id?: number }[] }>;
    get(id: number): Promise<{ id?: number }>;
  };
}

export class Workspace {
  constructor(
    private readonly api: WorkspaceApi,
    /** Own window (default) vs. the Dayflow group inside the user's current window. */
    private readonly ownWindow: boolean,
  ) {}

  /** The Dayflow group, if one exists (the first when several do). */
  async group(): Promise<{ id: number; windowId: number } | null> {
    const groups = await this.api.tabGroups.query({ title: GROUP_TITLE }).catch(() => []);
    return groups[0] ?? null;
  }

  /** Opens `url` inside the workspace: in the Dayflow group of its window, creating window and group as needed. */
  async createTab(url: string, active: boolean): Promise<number> {
    const group = await this.group();
    let tabId: number | undefined;
    let windowId: number | undefined = group?.windowId;
    if (windowId !== undefined && !(await this.api.windows.get(windowId).catch(() => null))) windowId = undefined;
    if (windowId === undefined && this.ownWindow) {
      // A new window opens on top; `focused: false` keeps the keyboard where the user has it.
      const win = await this.api.windows.create({ url, focused: false, type: 'normal' });
      windowId = win.id;
      tabId = win.tabs?.[0]?.id;
    }
    if (tabId === undefined) {
      const t = await this.api.tabs.create({ url, ...(windowId !== undefined ? { windowId } : {}), active });
      tabId = t.id;
      windowId = t.windowId ?? windowId;
    }
    if (tabId === undefined) throw new Error('tab has no id');
    await this.adopt(tabId, group && group.windowId === windowId ? group.id : undefined, windowId);
    return tabId;
  }

  /** Puts a tab into the Dayflow group of its window (a fresh group when the window has none). */
  async adopt(tabId: number, groupId?: number, windowId?: number): Promise<void> {
    try {
      const id = await this.api.tabs.group(groupId !== undefined ? { tabIds: [tabId], groupId } : { tabIds: [tabId], createProperties: windowId !== undefined ? { windowId } : {} });
      if (groupId === undefined) await this.api.tabGroups.update(id, { title: GROUP_TITLE, color: GROUP_COLOR });
    } catch {
      /* tab groups unavailable (old Chrome, popup window): the tab still works, just ungrouped */
    }
  }

  /** The active tab of the Dayflow group's window, when the group exists. */
  async activeTab(): Promise<number | undefined> {
    const group = await this.group();
    if (!group) return undefined;
    const [t] = await this.api.tabs.query({ active: true, windowId: group.windowId }).catch(() => []);
    return t?.id;
  }

  /** Whether a tab lives in the Dayflow group. */
  async owns(tabId: number): Promise<boolean> {
    const group = await this.group();
    if (!group) return false;
    const t = await this.api.tabs.get(tabId).catch(() => null);
    return t?.groupId === group.id;
  }
}
