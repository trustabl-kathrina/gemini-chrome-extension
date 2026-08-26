#!/usr/bin/env node
// Dayflow scene runner (PLAN v2 §Harness). No human in the loop.
// Usage: node harness/run.mjs <scene> [--real]
// Env: DAYFLOW_URL (http://127.0.0.1:8080), DAYFLOW_TOKEN (dev), FAKE_WSP_URL (http://127.0.0.1:8099),
//      FAKE_DRIVE_URL (http://127.0.0.1:8101), DAYFLOW_FAKE_LOG (harness/out/<scene>-connectors.jsonl),
//      HARNESS_TIMEOUT_MS (480000), HARNESS_HEADLESS=1 (new headless Chromium), HARNESS_KEEP=1 (leave the browser open),
//      REAL_WSP_URL (https://wsp.kbtu.kz), REAL_PROFILE (~/.gstack/chromium-profile).
// Flow: seed chrome.storage.local.settings (backend, fake Drive, fake OAuth token, vision, showWork, allow-list, site profile
// for the fake portal with mode dom) → open the side panel → type the scene prompt → auto-allow confirmation cards → poll the
// transcript until the run ends → write harness/out/<scene>.json {status, summary, steps[], actions, drive, …} → judge with
// harness/specs/<scene>.mjs. Exit 0 = spec passed, 1 otherwise (never throws out).
// --real: persistent profile ~/.gstack/chromium-profile (already signed in to wsp.kbtu.kz — the runner never logs in and never
// types credentials) and the real portal prompt; fake Drive + fake connectors stay in place, only the portal is real.
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zipEntries } from './lib/zip.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '..');
const EXT = path.join(ROOT, 'extension/.output/chrome-mv3');
const OUT = path.join(here, 'out');
// Playwright is a devDependency of extension/; resolve it from there so harness/ needs no install.
const require = createRequire(path.join(ROOT, 'extension/package.json'));
const { chromium } = require('playwright');

const SCENES = ['vault-sync', 'lab', 'team-ops', 'courseware', 'scaffold', 'pitch-deck'];
const END_STATES = new Set(['done', 'error', 'cancelled']);
const argv = process.argv.slice(2);
const scene = argv.find((a) => !a.startsWith('--'));
const REAL = argv.includes('--real');
const BRAIN_URL = (process.env.DAYFLOW_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const TOKEN = process.env.DAYFLOW_TOKEN || 'dev';
const REAL_WSP_URL = (process.env.REAL_WSP_URL || 'https://wsp.kbtu.kz').replace(/\/+$/, '');
const WSP_URL = (REAL ? REAL_WSP_URL : process.env.FAKE_WSP_URL || 'http://127.0.0.1:8099').replace(/\/+$/, '');
const DRIVE_URL = (process.env.FAKE_DRIVE_URL || 'http://127.0.0.1:8101').replace(/\/+$/, '');
const FAKE_LOG = path.resolve(ROOT, process.env.DAYFLOW_FAKE_LOG || path.join(OUT, `${scene}-connectors.jsonl`));
const TIMEOUT_MS = Number(process.env.HARNESS_TIMEOUT_MS || 8 * 60 * 1000);
const HEADLESS = process.env.HARNESS_HEADLESS === '1';
const KEEP = process.env.HARNESS_KEEP === '1';
const FAKE_OAUTH_TOKEN = 'harness-fake-oauth-token';
// Vault mode the panel is seeded with: fake Drive for fake scenes; on the real portal the user's Drive is not
// configured (no OAuth client), so files are kept by the brain only (PLAN v2: settings.vault.mode = 'brain').
const VAULT_MODE = process.env.HARNESS_VAULT_MODE || (REAL ? 'brain' : 'drive');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

/** Relative paths of every entry under `dir`; folders carry a trailing '/'. */
function walk(dir, acc = [], base = dir) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      acc.push(`${path.relative(base, p)}/`);
      walk(p, acc, base);
    } else acc.push(path.relative(base, p));
  }
  return acc.sort();
}

async function health(url, label) {
  try {
    const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    throw new Error(`${label} is not reachable at ${url}/health: ${e.message}`);
  }
}

function fail(reason, extra = {}) {
  const result = { scene, real: REAL, status: 'harness-error', summary: reason, steps: [], actions: 0, drive: { root: null, entries: [] }, pass: false, failures: [reason], ...extra };
  fs.mkdirSync(OUT, { recursive: true });
  if (scene) fs.writeFileSync(path.join(OUT, `${scene}.json`), JSON.stringify(result, null, 2));
  console.error(`\nRED ${scene ?? '?'}: ${reason}`);
  process.exit(1);
}

if (!scene || !SCENES.includes(scene)) fail(`usage: node harness/run.mjs <${SCENES.join('|')}> [--real]`);
if (!fs.existsSync(path.join(EXT, 'manifest.json'))) fail(`extension build missing at ${EXT} — run: cd extension && pnpm build`);

const specFile = path.join(here, 'specs', `${scene}.mjs`);
const spec = (await import(pathToFileURL(specFile).href)).default;
// Stamped into the result so a stale harness/out/<scene>.json (older spec or runner) is detectable.
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
const specVersion = { spec: path.relative(ROOT, specFile), specSha256: sha(specFile), runnerSha256: sha(fileURLToPath(import.meta.url)) };
// Node strips TypeScript types natively (>=22.18/24): reuse the extension's own defaults and config mapper.
const { DEFAULT_SETTINGS } = await import(pathToFileURL(path.join(ROOT, 'extension/src/protocol.ts')).href);
const { toUserConfig } = await import(pathToFileURL(path.join(ROOT, 'extension/src/agent/sync.ts')).href);

const profileDir = REAL ? path.resolve(process.env.REAL_PROFILE || path.join(os.homedir(), '.gstack/chromium-profile')) : path.join(here, `.profile-${scene}`);
const sceneOut = path.join(OUT, scene);
const downloadsDir = path.join(sceneOut, 'downloads');
const shotsDir = path.join(sceneOut, 'shots');
const driveDir = path.join(OUT, 'drive', scene);
fs.rmSync(sceneOut, { recursive: true, force: true });
if (!REAL) fs.rmSync(profileDir, { recursive: true, force: true }); // never wipe the real, signed-in profile
for (const d of [downloadsDir, shotsDir, path.join(profileDir, 'Default')]) fs.mkdirSync(d, { recursive: true });
if (!REAL) {
  // chrome.downloads honours the profile's default directory once Playwright's own download interception is off.
  fs.writeFileSync(
    path.join(profileDir, 'Default', 'Preferences'),
    JSON.stringify({ download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true } }),
  );
}
if (REAL && !fs.existsSync(path.join(profileDir, 'Default'))) fail(`--real profile has no Default/ dir: ${profileDir}`);

const ctxInfo = { scene, real: REAL, vaultMode: VAULT_MODE, wspUrl: WSP_URL, brainUrl: BRAIN_URL, driveUrl: DRIVE_URL, driveDir, downloadsDir, fakeLog: FAKE_LOG, token: TOKEN };
// HARNESS_PROMPT overrides the spec's prompt (e.g. a different course on the real portal); the spec still judges.
const prompt = process.env.HARNESS_PROMPT || (REAL && spec.realPrompt ? spec.realPrompt(ctxInfo) : typeof spec.prompt === 'function' ? spec.prompt(ctxInfo) : spec.prompt);
if (!prompt) fail(`spec ${scene} has no prompt`);

// ---------- pre-flight ----------
try {
  if (!REAL) await health(WSP_URL, 'fake-wsp');
  await health(BRAIN_URL, 'brain');
  await health(DRIVE_URL, 'fake-drive');
} catch (e) {
  fail(e.message);
}
fs.mkdirSync(path.dirname(FAKE_LOG), { recursive: true });
fs.writeFileSync(FAKE_LOG, '');
if (!REAL) await fetch(`${WSP_URL}/api/chat/reset`, { method: 'POST' }).catch(() => {});
{
  const r = await fetch(`${DRIVE_URL}/__harness/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scene }) }).catch((e) => ({ ok: false, statusText: e.message }));
  if (!r.ok) fail(`fake-drive reset failed: ${r.status ?? ''} ${r.statusText ?? ''}`);
}

// ---------- settings the panel would hold after the user configured it for this portal (PLAN v2) ----------
const wspHost = new URL(WSP_URL).hostname;
const brainHost = new URL(BRAIN_URL).hostname;
const driveHost = new URL(DRIVE_URL).hostname;
const realWsp = DEFAULT_SETTINGS.sites.find((s) => s.domain === 'wsp.kbtu.kz') ?? { notes: '', allow: true };
const fakeNotes =
  `${(realWsp.notes ?? '').replaceAll(REAL_WSP_URL, WSP_URL)}\n` +
  `This portal is served at ${WSP_URL} (a stand-in for wsp.kbtu.kz with the same layout). ` +
  `Its Messenger page at ${WSP_URL}/chat stands in for Telegram Web (chat list on the left with a search box, message textarea and Send button on the right).`;
const fakeSite = { ...realWsp, domain: wspHost, notes: fakeNotes, allow: true, mode: 'dom' };
const sites = REAL
  ? DEFAULT_SETTINGS.sites.map((s) => (s.domain === 'wsp.kbtu.kz' ? { ...s, mode: s.mode ?? 'dom' } : s))
  : [...DEFAULT_SETTINGS.sites, fakeSite];
const settings = {
  ...DEFAULT_SETTINGS,
  mode: 'live',
  backendUrl: BRAIN_URL,
  token: TOKEN,
  vision: true,
  showWork: true,
  vaultFolder: 'Dayflow',
  vaultMode: VAULT_MODE,
  vault: { mode: VAULT_MODE, folder: 'Dayflow' },
  // Drive client base URL → fake Drive; a fake OAuth token so the extension skips chrome.identity entirely.
  driveApiBase: DRIVE_URL,
  account: { email: 'harness@dayflow.local', name: 'Harness', token: FAKE_OAUTH_TOKEN, expiresAt: Date.now() + 6 * 3600 * 1000 },
  google: { token: FAKE_OAUTH_TOKEN, email: 'harness@dayflow.local', name: 'Harness' },
  // No skill text from the harness: the brain's pack is the single source (the panel pulls it from GET /config).
  skills: [],
  sites,
  connections: (DEFAULT_SETTINGS.connections ?? []).map((c) => ({ ...c, connected: true, account: c.id === 'drive' ? 'harness@dayflow.local' : 'harness' })),
  permissions: {
    ...DEFAULT_SETTINGS.permissions,
    // Only the portal and the Drive stand-in are allow-listed. The brain (a different host, see e2e.sh) is NOT:
    // download(url=page_url) / open_tab(page_url) must pass through the implicit brain-host rule on both sides,
    // exactly as in production.
    navigationAllowlist: [...new Set([...(DEFAULT_SETTINGS.permissions?.navigationAllowlist ?? []), wspHost, driveHost])],
    askBefore: { sendMessage: true, createPr: true, download: false, runJs: true },
  },
};
if (settings.permissions.navigationAllowlist.some((h) => h === brainHost || brainHost.endsWith(`.${h}`))) {
  log(`note: the brain host ${brainHost} is also on the seeded allow-list (portal/Drive share it); the implicit brain-host rule is not exercised in this run`);
}
const brainConfig = {
  ...toUserConfig(settings),
  sites: sites.map((s) => ({ domain: s.domain, notes: s.notes, allow: s.allow, mode: s.mode ?? 'dom' })),
  memory:
    (REAL
      ? `The student's portal is ${REAL_WSP_URL} (already signed in; never log in or type credentials). `
      : `The student's WSP portal in this environment is ${WSP_URL} (same modules as wsp.kbtu.kz); the messenger at ${WSP_URL}/chat stands in for Telegram Web. `) +
    'The diploma project repo is dayflow-student/diploma on GitHub. The vault is Google Drive folder Dayflow/<course>/<week|lab|materials>/.',
};

// ---------- result skeleton ----------
const started = Date.now();
const result = {
  scene,
  real: REAL,
  ...specVersion,
  prompt,
  status: 'running',
  summary: '',
  title: '',
  startedAt: new Date(started).toISOString(),
  endedAt: null,
  durationMs: 0,
  steps: [],
  actions: 0,
  refusedActions: 0,
  toolCalls: {},
  artifacts: [],
  confirms: [],
  drive: { root: path.relative(ROOT, driveDir), entries: [] },
  vault: null,
  downloads: [],
  connectorCalls: [],
  chatMessages: [],
  chatDom: [],
  brainConfigSynced: false,
  screenshotsDir: path.relative(ROOT, shotsDir),
  pass: false,
  failures: [],
};

let ctx;
try {
  ctx = await chromium.launchPersistentContext(profileDir, {
    headless: HEADLESS,
    ...(HEADLESS ? { channel: 'chromium' } : {}),
    viewport: null,
    acceptDownloads: true,
    downloadsPath: downloadsDir,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--hide-crash-restore-bubble', '--disable-blink-features=AutomationControlled', '--window-size=1440,900'],
    ignoreDefaultArgs: ['--enable-automation'],
  });
} catch (e) {
  fail(`could not launch Chromium with the extension (profile ${profileDir}): ${e.message}`);
}

const finish = async (code) => {
  if (!KEEP) await ctx.close().catch(() => {});
  process.exit(code);
};

try {
  // Playwright registers "allowAndName" (guid file names) for the context; put Chrome's own download pipeline back.
  const cdp = await ctx.browser().newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  await cdp.detach();

  let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null));
  if (!sw) throw new Error('extension service worker did not start (is the build valid?)');
  if (REAL) {
    // A persistent profile keeps the previous build's service worker script; reload the unpacked extension so the
    // build on disk is what runs (the fake profiles are recreated per run and never hit this).
    const fresh = ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null);
    await sw.evaluate(() => chrome.runtime.reload()).catch(() => {});
    sw = (await fresh) ?? ctx.serviceWorkers().at(-1) ?? sw;
    log('extension reloaded so the current build runs');
  }
  const extId = new URL(sw.url()).host;
  const swLog = [];
  sw.on('console', (m) => swLog.push(`[${m.type()}] ${m.text()}`));
  log(`extension ${extId}; profile ${path.relative(ROOT, profileDir) || profileDir}${REAL ? ' (REAL portal)' : ''}`);

  // Seed settings from the panel page (it has chrome.storage), then let the background push them to the brain.
  const panel = ctx.pages()[0] ?? (await ctx.newPage());
  const panelErrors = [];
  panel.on('pageerror', (e) => panelErrors.push(e.message));
  const panelUrl = `chrome-extension://${extId}/sidepanel.html`;
  await panel.goto(panelUrl);
  await panel.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);

  const authed = { authorization: `Bearer ${TOKEN}` };
  const getConfig = async () => {
    const r = await fetch(`${BRAIN_URL}/config`, { headers: authed });
    return r.ok ? r.json() : null;
  };
  for (let i = 0; i < 12; i++) {
    const cfg = await getConfig();
    if (cfg?.sites?.some((s) => s.domain === wspHost)) {
      result.brainConfigSynced = true;
      break;
    }
    await sleep(500);
  }
  log(`background pushed config to brain: ${result.brainConfigSynced}`);
  // Authoritative copy (adds `memory` and site modes, which the panel may not send); the brain overlays it on the pack.
  const put = await fetch(`${BRAIN_URL}/config`, { method: 'PUT', headers: { 'content-type': 'application/json', ...authed }, body: JSON.stringify(brainConfig) });
  if (!put.ok) throw new Error(`PUT /config failed: HTTP ${put.status} ${(await put.text()).slice(0, 200)}`);

  // A working tab on the portal so read_page has something even before open_tab; the panel stays a tab.
  const work = await ctx.newPage();
  await work.goto(`${WSP_URL}/`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e) => log(`portal tab: ${e.message}`));
  if (REAL) {
    const url = work.url();
    if (/login|auth|signin/i.test(url) || (await work.locator('input[type=password]').count()) > 0) throw new Error(`real portal shows a login page (${url}); sign in manually in ${profileDir} first — the harness never types credentials`);
  }
  await panel.reload();
  // Chat-first panel: the composer is a textarea whose placeholder starts with "Ask"; fall back to the first textarea.
  let composer = panel.locator('textarea[placeholder^="Ask"]').first();
  if (!(await composer.count())) composer = panel.locator('textarea').first();
  await composer.waitFor({ timeout: 20000 });
  await composer.fill(prompt);
  await composer.press('Enter');
  log(`prompt sent: ${prompt}`);

  // ---------- transcript reader ----------
  // Prefers a data-attribute contract (chat-first UI): [data-run-status], [data-run-summary], [data-step=text|tool|artifact|confirm]
  // with data-name/data-args/data-target/data-status/data-ms/data-type/data-href/data-answer, button[data-confirm=allow].
  // Falls back to the previous class-based markup so the runner works against either build.
  const readPanel = () =>
    panel.evaluate(() => {
      const txt = (el) => (el?.textContent ?? '').trim();
      const btnAllow = [...document.querySelectorAll('button')].find((b) => b.dataset.confirm === 'allow' || /^Allow/.test(txt(b)));
      const stopBtn = [...document.querySelectorAll('button')].some((b) => b.getAttribute('aria-label') === 'Stop' || b.dataset.action === 'stop');
      const tagged = document.querySelectorAll('[data-step]');
      if (tagged.length || document.querySelector('[data-run-status]')) {
        const steps = [...tagged].map((el) => {
          const d = el.dataset;
          const kind = d.step;
          if (kind === 'tool')
            return { kind, name: d.name ?? txt(el.querySelector('[data-tool-name]')), args: d.args ?? txt(el.querySelector('[data-tool-args]')), summary: d.summary ?? txt(el.querySelector('[data-tool-summary]')), target: d.target ?? 'unknown', status: d.status ?? 'ok', ms: d.ms ? Number(d.ms) : null };
          if (kind === 'artifact') return { kind, type: d.type ?? '', label: txt(el), href: d.href ?? el.getAttribute('href') ?? el.querySelector('a')?.getAttribute('href') ?? null };
          if (kind === 'confirm') return { kind, message: d.message ?? txt(el.querySelector('[data-confirm-message]')) ?? txt(el), answer: d.answer ?? 'pending' };
          return { kind: 'text', text: txt(el) };
        });
        const statusEl = document.querySelector('[data-run-status]');
        const status = statusEl ? (statusEl.dataset.runStatus || txt(statusEl)).toLowerCase() : null;
        return { status: status || null, title: txt(document.querySelector('[data-run-title]')), steps, summary: txt(document.querySelector('[data-run-summary]')), allow: !!btnAllow, stop: stopBtn, contract: 'data' };
      }
      const pills = [...document.querySelectorAll('span.rounded-full')].map(txt);
      const status = pills.find((t) => ['running', 'done', 'error', 'cancelled'].includes(t)) ?? null;
      const header = document.querySelector('div.hairline-b span.truncate');
      const timeline = document.querySelector('div.flex-1.overflow-y-auto.py-2');
      const iconType = (el) => {
        const cls = [...(el.querySelector('svg')?.classList ?? [])].find((c) => c.startsWith('lucide-') && c !== 'lucide-icon');
        return cls ? cls.replace('lucide-', '') : '';
      };
      const steps = [];
      let summary = '';
      for (const el of timeline?.children ?? []) {
        if (el.tagName === 'P') steps.push({ kind: 'text', text: txt(el) });
        else if (el.classList.contains('font-mono')) {
          const spans = el.querySelectorAll(':scope > div > div > span');
          const icon = iconType(el);
          steps.push({
            kind: 'tool',
            name: txt(spans[0]),
            args: txt(spans[1]),
            summary: txt(el.querySelector(':scope > div > div.text-fg-2')),
            target: icon === 'server' ? 'server' : icon === 'globe' ? 'browser' : icon || 'unknown',
            status: el.querySelector('svg.text-ok') ? 'ok' : el.querySelector('svg.text-err') ? 'error' : 'running',
            ms: (() => {
              const m = txt(el.querySelector(':scope > div.shrink-0 > span')).match(/^(\d+\.\d)s$/);
              return m ? Math.round(Number(m[1]) * 1000) : null;
            })(),
          });
        } else if (el.classList.contains('bg-accent-soft')) {
          const type = { 'file-text': 'file', folder: 'folder', 'link-2': 'url', link2: 'url', 'git-branch': 'repo', presentation: 'deck', 'circle-dot': 'issue', 'git-pull-request': 'pr' }[iconType(el)] ?? iconType(el);
          steps.push({ kind: 'artifact', type, label: txt(el), href: el.getAttribute('href') });
        } else if (el.querySelector('p.whitespace-pre-wrap')) {
          const pill = txt(el.querySelector('span.rounded-full'));
          steps.push({ kind: 'confirm', message: txt(el.querySelector('p.whitespace-pre-wrap')), answer: pill === 'needs your OK' ? 'pending' : pill });
        } else if (el.classList.contains('mt-2')) summary = txt(el.querySelector('span'));
      }
      return { status, title: txt(header), steps, summary, allow: !!btnAllow, stop: stopBtn, contract: 'class' };
    });

  // ---------- poll ----------
  let snap = null;
  let lastCount = -1;
  let lastChange = Date.now();
  let lastShot = 0;
  let shotN = 0;
  let startedRun = false;
  const deadline = started + TIMEOUT_MS;
  while (Date.now() < deadline) {
    snap = await readPanel().catch((e) => ({ error: e.message }));
    if (snap.error) {
      await sleep(700);
      continue;
    }
    if (snap.status || snap.stop || snap.steps.length) startedRun = true;
    else if (Date.now() - started > 30000) throw new Error(`run did not start (no status, steps or Stop button after 30s); panel errors: ${panelErrors.join(' | ') || 'none'}`);
    if (snap.allow) {
      const pending = snap.steps.find((s) => s.kind === 'confirm' && s.answer === 'pending');
      const btn = panel.locator('button[data-confirm="allow"], button:has-text("Allow")').first();
      await btn.click().catch(() => {});
      result.confirms.push({ message: pending?.message ?? '', answer: 'allowed', at: new Date().toISOString() });
      log(`auto-allowed confirmation: ${(pending?.message ?? '').slice(0, 100)}`);
      await sleep(300);
    }
    if (snap.steps.length !== lastCount) {
      const last = snap.steps.at(-1);
      if (last) log(`step ${snap.steps.length}: ${last.kind} ${last.kind === 'tool' ? `${last.name} ${last.args}` : (last.text ?? last.label ?? last.message ?? '').slice(0, 120)}`);
      lastCount = snap.steps.length;
      lastChange = Date.now();
      if (Date.now() - lastShot > 1500) {
        lastShot = Date.now();
        await panel.screenshot({ path: path.join(shotsDir, `${String(++shotN).padStart(2, '0')}-panel.png`) }).catch(() => {});
      }
    }
    if (startedRun && END_STATES.has(snap.status)) break;
    // Status-less UI: the run is over once the Stop button is gone and nothing changed for 8s.
    if (startedRun && !snap.status && !snap.stop && snap.steps.length && Date.now() - lastChange > 8000) {
      snap.status = snap.steps.some((s) => s.kind === 'tool' && s.status === 'error') ? 'error' : 'done';
      break;
    }
    await sleep(700);
  }
  await sleep(500);
  const last = await readPanel().catch(() => null);
  if (last && !last.error) snap = { ...last, status: END_STATES.has(last.status) ? last.status : snap?.status };
  result.endedAt = new Date().toISOString();
  result.durationMs = Date.now() - started;
  result.status = snap?.status && END_STATES.has(snap.status) ? snap.status : 'timeout';
  result.summary = snap?.summary || '';
  result.title = snap?.title || '';
  result.steps = snap?.steps ?? [];
  // Executed browser actions: a call the brain's guard refused ("budget exhausted") never reached the browser.
  result.actions = result.steps.filter((s) => s.kind === 'tool' && s.target !== 'server' && !/budget exhausted/i.test(s.summary ?? '')).length;
  result.refusedActions = result.steps.filter((s) => s.kind === 'tool' && /budget exhausted/i.test(s.summary ?? '')).length;
  for (const s of result.steps) if (s.kind === 'tool') result.toolCalls[s.name] = (result.toolCalls[s.name] ?? 0) + 1;
  result.artifacts = result.steps.filter((s) => s.kind === 'artifact');
  if (result.status === 'timeout') {
    result.summary = `no terminal status after ${Math.round(TIMEOUT_MS / 1000)}s (last: ${snap?.status ?? 'none'})`;
    await panel.locator('button[aria-label="Stop"], button[data-action="stop"]').first().click().catch(() => {});
  }

  // ---------- evidence ----------
  await panel.screenshot({ path: path.join(shotsDir, 'final-panel.png') }).catch(() => {});
  let n = 0;
  for (const p of ctx.pages()) {
    if (p === panel) continue;
    await p.screenshot({ path: path.join(shotsDir, `final-tab-${++n}.png`) }).catch(() => {});
    // Messenger stand-in: outgoing messages are exposed in the DOM as [data-sent] (see fake-wsp/public/app.js).
    if (/\/chat(\?|$)/.test(p.url())) {
      const sent = await p
        .evaluate(() => [...document.querySelectorAll('[data-sent]')].map((el) => ({ chat: el.dataset.chat ?? '', text: el.dataset.text ?? (el.textContent ?? '').trim() })))
        .catch(() => []);
      result.chatDom.push(...sent);
    }
  }
  fs.writeFileSync(path.join(sceneOut, 'panel.html'), await panel.content().catch(() => ''));
  fs.writeFileSync(path.join(sceneOut, 'sw-console.log'), swLog.join('\n'));
  if (panelErrors.length) fs.writeFileSync(path.join(sceneOut, 'panel-errors.log'), panelErrors.join('\n'));

  sw = ctx.serviceWorkers()[0] ?? sw;
  const items = await sw.evaluate(async () => (await chrome.downloads.search({})).map((i) => ({ url: i.url, path: i.filename, state: i.state, bytes: i.fileSize }))).catch(() => []);
  result.downloads = items;
  result.drive.entries = walk(driveDir);
  result.vault = await fetch(`${BRAIN_URL}/vault`, { headers: authed, signal: AbortSignal.timeout(10000) })
    .then(async (r) => (r.ok ? r.json() : { error: `HTTP ${r.status}` }))
    .catch((e) => ({ error: e.message }));
  result.connectorCalls = fs.existsSync(FAKE_LOG)
    ? fs
        .readFileSync(FAKE_LOG, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return { tool: 'unparsable', raw: l };
          }
        })
    : [];
  result.chatMessages = REAL ? [] : await fetch(`${WSP_URL}/api/chat/messages`).then((r) => r.json()).catch(() => []);

  // ---------- judge ----------
  const specCtx = {
    ...ctxInfo,
    drive: result.drive.entries,
    driveFiles: result.drive.entries.filter((e) => !e.endsWith('/')),
    driveFolders: result.drive.entries.filter((e) => e.endsWith('/')).map((e) => e.slice(0, -1)),
    vault: result.vault,
    connectorCalls: result.connectorCalls,
    chatMessages: result.chatMessages,
    chatDom: result.chatDom,
    sceneOut,
    readDrive: (rel) => fs.readFileSync(path.join(driveDir, rel)),
    zipEntries: (buf) => zipEntries(buf),
    fetch: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(15000) }),
  };
  try {
    const failures = await spec.expect(result, specCtx);
    result.failures = Array.isArray(failures) ? failures : failures ? [String(failures)] : [];
  } catch (e) {
    result.failures = [`spec threw: ${e.message}`];
  }
  result.pass = result.failures.length === 0;
} catch (e) {
  result.status = result.status === 'running' ? 'harness-error' : result.status;
  result.failures = [e.message];
  result.summary = result.summary || e.message;
  result.endedAt = new Date().toISOString();
  result.durationMs = Date.now() - started;
  result.drive.entries = walk(driveDir);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${scene}.json`), JSON.stringify(result, null, 2));
console.log(
  `\n${result.pass ? 'GREEN' : 'RED'} ${scene}${REAL ? ' (real)' : ''}: status=${result.status} steps=${result.steps.length} actions=${result.actions} drive=${result.drive.entries.length} connector-calls=${result.connectorCalls.length} (${Math.round(result.durationMs / 1000)}s)`,
);
for (const f of result.failures) console.log(`  - ${f}`);
console.log(`  → ${path.relative(ROOT, path.join(OUT, `${scene}.json`))}`);
await finish(result.pass ? 0 : 1);
