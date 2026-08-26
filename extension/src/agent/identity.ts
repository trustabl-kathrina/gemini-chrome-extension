import { browser } from 'wxt/browser';
import type { Settings } from '../protocol';

const USERINFO = 'https://www.googleapis.com/oauth2/v3/userinfo';

/** chrome.identity.getAuthToken resolves to `{token}` (MV3 promise form) or a bare string on older builds. */
async function authToken(interactive: boolean): Promise<string> {
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

export interface GoogleProfile {
  email: string;
  name: string;
  token: string;
}

/** Interactive sign-in from the panel: token via chrome.identity, identity via the OpenID userinfo endpoint. */
export async function signIn(): Promise<GoogleProfile> {
  const token = await authToken(true);
  const res = await fetch(USERINFO, { headers: { authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`userinfo → HTTP ${res.status}`);
  const info = (await res.json()) as { email?: string; name?: string };
  return { email: info.email ?? '', name: info.name ?? '', token };
}

export async function signOut(token?: string): Promise<void> {
  if (token) await browser.identity.removeCachedAuthToken({ token }).catch(() => undefined);
  await browser.identity.clearAllCachedAuthTokens?.().catch(() => undefined);
}
