#!/usr/bin/env node
// Dayflow scene runner (PLAN.md §Harness).
// Usage: node harness/run.mjs <scene>
// Env: DAYFLOW_URL (http://127.0.0.1:8080), DAYFLOW_TOKEN (dev), FAKE_WSP_URL (http://127.0.0.1:8099),
//      DAYFLOW_FAKE_LOG (/tmp/dayflow-fake-connectors.jsonl), HARNESS_TIMEOUT_MS (360000),
//      HARNESS_HEADLESS=1 (new headless Chromium), HARNESS_KEEP=1 (leave the browser open on exit),
//      HARNESS_MODE=mock (self-test: panel in mock mode, scene skill launched from its Home card; no brain needed).
// Writes harness/out/<scene>.json and exits 0 when the scene's spec passes, 1 otherwise (never throws out).
import { createRequire } from 'node:module';
import fs from 'node:fs';
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

const SCENES = ['vault-sync', 'courseware', 'scaffold', 'bootstrap', 'team-ops', 'pitch-deck'];
const END_STATES = new Set(['done', 'error', 'cancelled']);
const scene = process.argv[2];
const BRAIN_URL = (process.env.DAYFLOW_URL || 'http://127.0.0.1:8080').replace(/\/+$/, '');
const TOKEN = process.env.DAYFLOW_TOKEN || 'dev';
const WSP_URL = (process.env.FAKE_WSP_URL || 'http://127.0.0.1:8099').replace(/\/+$/, '');
const FAKE_LOG = process.env.DAYFLOW_FAKE_LOG || '/tmp/dayflow-fake-connectors.jsonl';
const TIMEOUT_MS = Number(process.env.HARNESS_TIMEOUT_MS || 6 * 60 * 1000);
const HEADLESS = process.env.HARNESS_HEADLESS === '1';
const KEEP = process.env.HARNESS_KEEP === '1';
const MOCK = process.env.HARNESS_MODE === 'mock';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

function walk(dir, acc = [], base = dir) {
  if (!fs.existsSync(dir)) return acc;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc, base);
    else acc.push(path.relative(base, p));
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
  const result = { scene, status: 'harness-error', summary: reason, steps: [], downloads: [], pass: false, failures: [reason], ...extra };
  fs.mkdirSync(OUT, { recursive: true });
  if (scene) fs.writeFileSync(path.join(OUT, `${scene}.json`), JSON.stringify(result, null, 2));
  console.error(`\nRED ${scene ?? '?'}: ${reason}`);
  process.exit(1);
}

if (!scene || !SCENES.includes(scene)) fail(`usage: node harness/run.mjs <${SCENES.join('|')}>`);
if (!fs.existsSync(path.join(EXT, 'manifest.json'))) fail(`extension build missing at ${EXT} — run: cd extension && pnpm build`);

const spec = (await import(pathToFileURL(path.join(here, 'specs', `${scene}.mjs`)).href)).default;
// Node strips TypeScript types natively (>=22.18/24): reuse the extension's own defaults and config mapper.
const { DEFAULT_SETTINGS } = await import(pathToFileURL(path.join(ROOT, 'extension/src/protocol.ts')).href);
const { toUserConfig } = await import(pathToFileURL(path.join(ROOT, 'extension/src/agent/sync.ts')).href);

const profileDir = path.join(here, `.profile-${scene}`);
const sceneOut = path.join(OUT, scene);
const downloadsDir = path.join(sceneOut, 'downloads');
const shotsDir = path.join(sceneOut, 'shots');
for (const d of [profileDir, sceneOut]) fs.rmSync(d, { recursive: true, force: true });
for (const d of [downloadsDir, shotsDir, path.join(profileDir, 'Default')]) fs.mkdirSync(d, { recursive: true });
// chrome.downloads honours the profile's default directory once Playwright's own download interception
// is switched off (see setDownloadBehavior below); this keeps the extension's DayflowVault/<course>/… paths.
fs.writeFileSync(
  path.join(profileDir, 'Default', 'Preferences'),
  JSON.stringify({ download: { default_directory: downloadsDir, prompt_for_download: false, directory_upgrade: true } }),
);

const ctxInfo = { wspUrl: WSP_URL, brainUrl: BRAIN_URL, downloadsDir, fakeLog: FAKE_LOG };
const prompt = typeof spec.prompt === 'function' ? spec.prompt(ctxInfo) : spec.prompt;
if (!prompt) fail(`spec ${scene} has no prompt`);

// ---------- pre-flight ----------
try {
  await health(WSP_URL, 'fake-wsp');
  if (!MOCK) await health(BRAIN_URL, 'brain');
} catch (e) {
  fail(e.message);
}
fs.mkdirSync(path.dirname(FAKE_LOG), { recursive: true });
fs.writeFileSync(FAKE_LOG, '');
await fetch(`${WSP_URL}/api/chat/reset`, { method: 'POST' }).catch(() => {});

// ---------- settings the panel would hold after the user configured it for this portal ----------
const wspHost = new URL(WSP_URL).hostname;
const brainHost = new URL(BRAIN_URL).hostname;
const realNotes = DEFAULT_SETTINGS.sites.find((s) => s.domain === 'wsp.kbtu.kz')?.notes ?? '';
const fakeNotes =
  `${realNotes.replaceAll('https://wsp.kbtu.kz', WSP_URL)}\n` +
  `This portal is served at ${WSP_URL} (a stand-in for wsp.kbtu.kz with the same layout). ` +
  `Its Messenger page at ${WSP_URL}/chat stands in for Telegram Web (chat list on the left, message box and Send button on the right).`;
const settings = {
  ...DEFAULT_SETTINGS,
  mode: MOCK ? 'mock' : 'live',
  backendUrl: BRAIN_URL,
  token: TOKEN,
  vaultFolder: 'DayflowVault',
  showWork: true,
  vision: true,
  account: { email: 'harness@dayflow.local', name: 'Harness' },
  skills: DEFAULT_SETTINGS.skills.map((s) => ({ ...s, sites: [...new Set([...s.sites, wspHost])] })),
  sites: [...DEFAULT_SETTINGS.sites, { domain: wspHost, notes: fakeNotes, allow: true }],
  permissions: {
    navigationAllowlist: [...new Set([...DEFAULT_SETTINGS.permissions.navigationAllowlist, wspHost, brainHost, 'localhost'])],
    askBefore: { sendMessage: true, createPr: true, download: false },
  },
};
const brainConfig = {
  ...toUserConfig(settings),
  memory: `The student's WSP portal in this environment is ${WSP_URL} (same modules as wsp.kbtu.kz); the messenger at ${WSP_URL}/chat stands in for Telegram Web. The diploma project repo is dayflow-student/diploma on GitHub.`,
};

// ---------- browser ----------
const started = Date.now();
const result = {
  scene,
  mode: MOCK ? 'mock' : 'live',
  prompt,
  status: 'running',
  summary: '',
  title: '',
  startedAt: new Date(started).toISOString(),
  endedAt: null,
  durationMs: 0,
  steps: [],
  actions: 0,
  toolCalls: {},
  artifacts: [],
  confirms: [],
  downloads: [],
  files: [],
  connectorCalls: [],
  chatMessages: [],
  brainConfigSynced: false,
  screenshotsDir: shotsDir,
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
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      '--hide-crash-restore-bubble',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1440,900',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  });
} catch (e) {
  fail(`could not launch Chromium with the extension: ${e.message}`);
}

const finish = async (code) => {
  if (!KEEP) await ctx.close().catch(() => {});
  process.exit(code);
};

try {
  // Playwright registers "allowAndName" (guid file names) for the context; put Chrome's own download
  // pipeline back so chrome.downloads' relative filenames land under downloadsDir/DayflowVault/…
  const cdp = await ctx.browser().newBrowserCDPSession();
  await cdp.send('Browser.setDownloadBehavior', { behavior: 'default' });
  await cdp.detach();

  let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20000 }).catch(() => null));
  if (!sw) throw new Error('extension service worker did not start (is the build valid?)');
  const extId = new URL(sw.url()).host;
  const swLog = [];
  sw.on('console', (m) => swLog.push(`[${m.type()}] ${m.text()}`));
  log(`extension ${extId}; profile ${path.relative(ROOT, profileDir)}`);

  // Seed settings from the panel page (it has chrome.storage), then let the background push them to the brain.
  const panel = ctx.pages()[0] ?? (await ctx.newPage());
  const panelErrors = [];
  panel.on('pageerror', (e) => panelErrors.push(e.message));
  const panelUrl = `chrome-extension://${extId}/sidepanel.html`;
  await panel.goto(panelUrl);
  await panel.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);

  const getConfig = async () => {
    const r = await fetch(`${BRAIN_URL}/config`, { headers: { authorization: `Bearer ${TOKEN}` } });
    return r.ok ? r.json() : null;
  };
  for (let i = 0; i < 12 && !MOCK; i++) {
    const cfg = await getConfig();
    if (cfg?.sites?.some((s) => s.domain === wspHost)) {
      result.brainConfigSynced = true;
      break;
    }
    await sleep(500);
  }
  if (!MOCK) {
    log(`background pushed config to brain: ${result.brainConfigSynced}`);
    // Authoritative copy (adds `memory`, which the panel does not send); the brain overlays it on the pack.
    const put = await fetch(`${BRAIN_URL}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify(brainConfig),
    });
    if (!put.ok) throw new Error(`PUT /config failed: HTTP ${put.status} ${(await put.text()).slice(0, 200)}`);
  }

  // A working tab on the portal so read_page has something even before open_tab; the panel stays a tab.
  const work = await ctx.newPage();
  await work.goto(`${WSP_URL}/`);
  await panel.reload();
  const composer = panel.locator('textarea[placeholder^="Ask Dayflow"]');
  await composer.waitFor({ timeout: 15000 });
  if (MOCK) {
    // Self-test of the panel reader: the scene's skill card runs the extension's scripted mock.
    const title = DEFAULT_SETTINGS.skills.find((s) => s.id === scene)?.title ?? scene;
    await panel.getByRole('button', { name: title }).first().click();
    log(`mock skill launched: ${title}`);
  } else {
    await composer.fill(prompt);
    await composer.press('Enter');
    log(`prompt sent: ${prompt}`);
  }

  // ---------- poll the timeline ----------
  const readPanel = () =>
    panel.evaluate(() => {
      const txt = (el) => (el?.textContent ?? '').trim();
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
      const allow = [...document.querySelectorAll('button')].some((b) => /^Allow/.test(txt(b)));
      return { status, title: txt(header), steps, summary, allow };
    });

  let snap = null;
  let lastCount = -1;
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
    if (snap.status) startedRun = true;
    else if (Date.now() - started > 20000) throw new Error(`run did not start (no status pill after 20s); panel errors: ${panelErrors.join(' | ') || 'none'}`);
    if (snap.allow) {
      const pending = snap.steps.find((s) => s.kind === 'confirm' && s.answer === 'pending');
      await panel.getByRole('button', { name: /Allow/ }).first().click().catch(() => {});
      result.confirms.push({ message: pending?.message ?? '', answer: 'allowed', at: new Date().toISOString() });
      log(`auto-allowed confirmation: ${(pending?.message ?? '').slice(0, 100)}`);
    }
    if (snap.steps.length !== lastCount) {
      const last = snap.steps.at(-1);
      if (last) log(`step ${snap.steps.length}: ${last.kind} ${last.kind === 'tool' ? `${last.name} ${last.args}` : (last.text ?? last.label ?? last.message ?? '').slice(0, 120)}`);
      lastCount = snap.steps.length;
      if (Date.now() - lastShot > 1500) {
        lastShot = Date.now();
        await panel.screenshot({ path: path.join(shotsDir, `${String(++shotN).padStart(2, '0')}-panel.png`) }).catch(() => {});
      }
    }
    if (startedRun && END_STATES.has(snap.status)) break;
    await sleep(700);
  }
  await sleep(500);
  snap = (await readPanel().catch(() => snap)) ?? snap;
  result.endedAt = new Date().toISOString();
  result.durationMs = Date.now() - started;
  result.status = snap?.status && END_STATES.has(snap.status) ? snap.status : 'timeout';
  result.summary = snap?.summary || '';
  result.title = snap?.title || '';
  result.steps = snap?.steps ?? [];
  result.actions = result.steps.filter((s) => s.kind === 'tool' && s.target !== 'server').length;
  for (const s of result.steps) if (s.kind === 'tool') result.toolCalls[s.name] = (result.toolCalls[s.name] ?? 0) + 1;
  result.artifacts = result.steps.filter((s) => s.kind === 'artifact');
  if (result.status === 'timeout') {
    result.summary = `no terminal status after ${Math.round(TIMEOUT_MS / 1000)}s (last: ${snap?.status ?? 'none'})`;
    await panel.getByRole('button', { name: 'Stop' }).click().catch(() => {});
  }

  // ---------- evidence ----------
  await panel.screenshot({ path: path.join(shotsDir, 'final-panel.png') }).catch(() => {});
  let n = 0;
  for (const p of ctx.pages()) {
    if (p === panel) continue;
    await p.screenshot({ path: path.join(shotsDir, `final-tab-${++n}.png`) }).catch(() => {});
  }
  fs.writeFileSync(path.join(sceneOut, 'panel.html'), await panel.content().catch(() => ''));
  fs.writeFileSync(path.join(sceneOut, 'sw-console.log'), swLog.join('\n'));
  if (panelErrors.length) fs.writeFileSync(path.join(sceneOut, 'panel-errors.log'), panelErrors.join('\n'));

  sw = ctx.serviceWorkers()[0] ?? sw;
  const items = await sw
    .evaluate(async () => (await chrome.downloads.search({})).map((i) => ({ url: i.url, path: i.filename, state: i.state, bytes: i.fileSize })))
    .catch(() => []);
  result.downloads = items.map((i) => ({ ...i, relative: i.path && i.path.startsWith(downloadsDir) ? path.relative(downloadsDir, i.path) : null }));
  result.files = walk(downloadsDir);
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
  result.chatMessages = await fetch(`${WSP_URL}/api/chat/messages`)
    .then((r) => r.json())
    .catch(() => []);

  // ---------- judge ----------
  const specCtx = {
    ...ctxInfo,
    files: result.files,
    connectorCalls: result.connectorCalls,
    chatMessages: result.chatMessages,
    readFile: (rel) => fs.readFileSync(path.join(downloadsDir, rel)),
    zipEntries: (rel) => zipEntries(fs.readFileSync(path.join(downloadsDir, rel))),
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
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${scene}.json`), JSON.stringify(result, null, 2));
console.log(`\n${result.pass ? 'GREEN' : 'RED'} ${scene}: status=${result.status} steps=${result.steps.length} actions=${result.actions} files=${result.files.length} connector-calls=${result.connectorCalls.length} (${Math.round(result.durationMs / 1000)}s)`);
for (const f of result.failures) console.log(`  - ${f}`);
console.log(`  → ${path.relative(ROOT, path.join(OUT, `${scene}.json`))}`);
await finish(result.pass ? 0 : 1);
