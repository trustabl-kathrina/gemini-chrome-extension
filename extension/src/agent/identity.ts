import { browser } from 'wxt/browser';
import type { Settings } from '../protocol';

const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

/**
 * The OAuth client id baked into the manifest at build time from `extension/.env` (`VITE_GOOGLE_CLIENT_ID`,
 * see wxt.config.ts). Only its presence is ever exposed — the value itself is never logged or shown, and the
 * panel only needs to know whether Google sign-in can work at all.
 */
export function driveConfigured(): boolean {
  const id = import.meta.env.VITE_GOOGLE_CLIENT_ID;
  return typeof id === 'string' && id.trim().length > 0;
}

export const NOT_CONFIGURED = 'Drive not configured: this build has no VITE_GOOGLE_CLIENT_ID, so Google sign-in is unavailable';

/** chrome.identity.getAuthToken resolves to `{token}` (MV3 promise form) or a bare string on older builds. */
async function authToken(interactive: boolean): Promise<string> {
  if (!driveConfigured()) throw new Error(NOT_CONFIGURED);
  const r = (await browser.identity.getAuthToken({ interactive })) as unknown;
  const token = typeof r === 'string' ? r : (r as { token?: string } | undefined)?.token;
  if (!token) throw new Error('Google sign-in did not return a token');
  return token;
}

/**
 * OAuth token for Drive: the explicit `driveToken` (harness / manual) wins; otherwise chrome.identity's cached
 * token (non-interactive from the worker; the Settings screen asks interactively).
 */
export async function getGoogleToken(settings: Pick<Settings, 'driveToken' | 'account'>, interactive = false): Promise<string> {
  if (settings.driveToken) return settings.driveToken;
  if (settings.account?.token && (!settings.account.expiresAt || settings.account.expiresAt > Date.now())) return settings.account.token;
  try {
    return await authToken(interactive);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Google sign-in required (Settings → Sign in with Google): ${msg}`);
  }
}

/**
 * Google answered 401 with `stale`: drop it from chrome.identity's cache (it hands out the same expired token
 * for an hour otherwise) and ask for a fresh one without a prompt. Returns null when there is nothing to
 * refresh — an explicitly provided token (harness / manual override) or no OAuth client in this build — so the
 * caller reports the original 401 instead of looping.
 */
export async function refreshGoogleToken(settings: Pick<Settings, 'driveToken' | 'account'>, stale: string): Promise<string | null> {
  if (settings.driveToken === stale || !driveConfigured()) return null;
  await browser.identity.removeCachedAuthToken({ token: stale }).catch(() => undefined);
  const fresh = await authToken(false).catch(() => null);
  return fresh && fresh !== stale ? fresh : null;
}

export interface GoogleProfile {
  email: string;
  name: string;
  token: string;
}

/** Interactive sign-in from the panel: token via chrome.identity, identity via the OpenID userinfo endpoint. */
export async function signIn(): Promise<GoogleProfile> {
  const token = await authToken(true);
  const res = await fetch(USERINFO, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) {
    // A token cached from a previous build/scope set is rejected here; drop it so the next attempt is clean.
    await browser.identity.removeCachedAuthToken({ token }).catch(() => undefined);
    throw new Error(`userinfo → HTTP ${res.status}`);
  }
  const info = (await res.json()) as { email?: string; name?: string };
  return { email: info.email ?? '', name: info.name ?? '', token };
}

export async function signOut(token?: string): Promise<void> {
  if (token) await browser.identity.removeCachedAuthToken({ token }).catch(() => undefined);
  await browser.identity.clearAllCachedAuthTokens?.().catch(() => undefined);
}
