/**
 * Screenshot policy per browser tool. Every image the brain forwards costs Gemini tokens (and the session store
 * bytes), so a tool result only carries one when it can show something the model does not already have:
 * - `never`: the result IS the page (read_page) or the view did not move (list_tabs, download).
 * - `always`: the model asked for a picture (screenshot).
 * - `if-changed`: actions — captured only when the page fingerprint differs from the last capture of that tab,
 *   otherwise the result says "unchanged", which is itself the answer to "did the click do anything?".
 */
export type ShotPolicy = 'never' | 'always' | 'if-changed';

const NEVER = new Set(['read_page', 'list_tabs', 'download']);

export function shotPolicy(tool: string): ShotPolicy {
  if (tool === 'screenshot') return 'always';
  return NEVER.has(tool) ? 'never' : 'if-changed';
}

/** Longer side of the JPEG sent to the brain; Gemini reads it at the resolution the brain configures. */
export const SHOT_MAX_PX = 1024;
export const SHOT_QUALITY = 0.5;

export const UNCHANGED_NOTE = 'unchanged: the page is exactly as in the previous screenshot';
