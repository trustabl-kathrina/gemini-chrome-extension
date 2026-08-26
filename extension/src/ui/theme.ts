import { useCallback, useEffect, useState } from 'react';

/** Panel theme: follow the OS, or force light/dark. Stored locally (not part of the brain-synced config). */
export type Theme = 'system' | 'light' | 'dark';
const KEY = 'dayflow.theme';
export const THEMES: Theme[] = ['system', 'light', 'dark'];

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

/** `data-theme` on <html> drives the CSS tokens; "system" removes it so `prefers-color-scheme` applies. */
export function applyTheme(t: Theme) {
  const root = document.documentElement;
  if (t === 'system') delete root.dataset.theme;
  else root.dataset.theme = t;
}

export function useTheme(): [Theme, (t: Theme) => void, () => void] {
  const [theme, setThemeState] = useState<Theme>(readTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const setTheme = useCallback((t: Theme) => {
    try {
      localStorage.setItem(KEY, t);
    } catch {
      /* private mode */
    }
    setThemeState(t);
  }, []);
  const cycle = useCallback(() => setTheme(THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? 'system'), [theme, setTheme]);
  return [theme, setTheme, cycle];
}
