#!/usr/bin/env node
// Chrome Web Store screenshots (1280×800) captured from the REAL extension build.
//
// Launches persistent Chromium with extension/.output/chrome-mv3 (the same way harness/run.mjs does), seeds the
// panel's settings against the harness services, runs the vault-sync prompt for real, and captures the panel next
// to the portal it is driving, then the Settings and Config screens. Every pixel of the panel and of the portal is
// a real screenshot; only the 1280×800 frame around them (background + caption) is composed, in the browser, on a
// blank page — no image library, no external assets.
//
// Prerequisites: `cd extension && pnpm build`, plus the harness services on E2E_PORT_BASE (fake-wsp BASE,
// brain BASE+1, fake-drive BASE+2). With --no-run it skips the agent run and captures the idle chat instead.
//
// Usage:  node docs/store/scripts/screenshots.mjs [--no-run] [--headless]
// Env:    E2E_PORT_BASE=8240  DAYFLOW_TOKEN=dev  SHOTS_TIMEOUT_MS=480000  OUT_DIR=docs/store/screenshots
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(here, '../../..');
const EXT = path.join(ROOT, 'extension/.output/chrome-mv3');
const require = createRequire(path.join(ROOT, 'extension/package.json'));
const { chromium } = require('playwright');

const argv = process.argv.slice(2);
const RUN = !argv.includes('--no-run');
const HEADLESS = argv.includes('--headless') || process.env.HARNESS_HEADLESS === '1';
const BASE = Number(process.env.E2E_PORT_BASE || 8240);
const WSP_URL = process.env.FAKE_WSP_URL || `http://127.0.0.1:${BASE}`;
const BRAIN_URL = process.env.DAYFLOW_URL || `http://localhost:${BASE + 1}`;
const DRIVE_URL = process.env.FAKE_DRIVE_URL || `http://127.0.0.1:${BASE + 2}`;
const TOKEN = process.env.DAYFLOW_TOKEN || 'dev';
const TIMEOUT_MS = Number(process.env.SHOTS_TIMEOUT_MS || 8 * 60 * 1000);
const OUT = path.resolve(ROOT, process.env.OUT_DIR || 'docs/store/screenshots');
const PROFILE = path.join(here, '..', '.profile-shots');

const W = 1280;
const H = 800;
const PANEL_W = 460; // Chrome's side panel is ~400–500px wide; capture at a real panel width
const SITE_W = W - PANEL_W;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  console.error(`no build at ${EXT} — run: cd extension && pnpm build`);
  process.exit(1);
}
for (const [url, label] of [
  [WSP_URL, 'fake-wsp'],
  [BRAIN_URL, 'brain'],
  [DRIVE_URL, 'fake-drive'],
]) {
  const r = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) }).catch((e) => ({ ok: false, statusText: e.message }));
  if (!r.ok) {
    console.error(`${label} is not answering at ${url}/health — start the harness services on E2E_PORT_BASE=${BASE}`);
    process.exit(1);
  }
}

// The panel's own defaults and config mapper (Node strips the TS types natively, as harness/run.mjs does).
const { DEFAULT_SETTINGS } = await import(pathToFileURL(path.join(ROOT, 'extension/src/protocol.ts')).href);
const { toUserConfig } = await import(pathToFileURL(path.join(ROOT, 'extension/src/agent/sync.ts')).href);
const spec = (await import(pathToFileURL(path.join(ROOT, 'harness/specs/vault-sync.mjs')).href)).default;
const prompt = process.env.SHOTS_PROMPT || spec.prompt({ wspUrl: WSP_URL });

const wspHost = new URL(WSP_URL).hostname;
const driveHost = new URL(DRIVE_URL).hostname;
const realWsp = DEFAULT_SETTINGS.sites.find((s) => s.domain === 'wsp.kbtu.kz') ?? { notes: '', allow: true };
const sites = [
  ...DEFAULT_SETTINGS.sites,
  {
    ...realWsp,
    domain: wspHost,
    allow: true,
    mode: 'dom',
    notes: `${realWsp.notes ?? ''}\nThis portal is served at ${WSP_URL} (a stand-in for wsp.kbtu.kz with the same layout).`,
  },
];
const settings = {
  ...DEFAULT_SETTINGS,
  mode: 'live',
  backendUrl: BRAIN_URL,
  token: TOKEN,
  vision: true,
  showWork: true,
  vaultFolder: 'Dayflow',
  vaultMode: 'drive',
  vault: { mode: 'drive', folder: 'Dayflow' },
  driveApiBase: DRIVE_URL,
  account: { email: 'you@example.com', name: 'Dayflow user', token: 'demo-oauth-token', expiresAt: Date.now() + 6 * 3600 * 1000 },
  google: { token: 'demo-oauth-token', email: 'you@example.com', name: 'Dayflow user' },
  skills: [],
  sites,
  connections: (DEFAULT_SETTINGS.connections ?? []).map((c) => ({ ...c, connected: true, account: c.id === 'drive' ? 'you@example.com' : 'dayflow-student' })),
  permissions: {
    ...DEFAULT_SETTINGS.permissions,
    navigationAllowlist: [...new Set([...(DEFAULT_SETTINGS.permissions?.navigationAllowlist ?? []), wspHost, driveHost])],
    askBefore: { sendMessage: true, createPr: true, download: false, runJs: true },
  },
};

fs.rmSync(PROFILE, { recursive: true, force: true });
fs.mkdirSync(path.join(PROFILE, 'Default'), { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: HEADLESS,
  ...(HEADLESS ? { channel: 'chromium' } : {}),
  viewport: { width: W, height: H },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--hide-crash-restore-bubble', '--disable-blink-features=AutomationControlled', `--window-size=${W},${H + 120}`],
  ignoreDefaultArgs: ['--enable-automation'],
});

/** Composes real PNG screenshots into one 1280×800 frame, in the browser, and saves it. */
let composer = null;
async function compose(file, html) {
  composer ??= await ctx.newPage();
  await composer.setViewportSize({ width: W, height: H });
  await composer.setContent(
    `<!doctype html><meta charset="utf-8"><style>
       *{margin:0;padding:0;box-sizing:border-box}
       html,body{width:${W}px;height:${H}px;overflow:hidden;
         font:400 15px/1.5 'Inter',system-ui,-apple-system,sans-serif;color:#e9e7f0;
         background:radial-gradient(700px 420px at 18% -10%, #6d4bd8 0%, transparent 65%), linear-gradient(140deg,#181528 0%,#241b3e 100%)}
       .shot{display:block;border-radius:10px;box-shadow:0 24px 70px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.08)}
       h1{font-size:34px;line-height:1.15;font-weight:600;letter-spacing:-.02em}
       p{font-size:17px;line-height:1.5;color:#b9b3ca;margin-top:14px}
       .tag{display:inline-block;font-size:12px;letter-spacing:.14em;text-transform:uppercase;color:#c4b5fd;margin-bottom:16px}
     </style>${html}`,
    { waitUntil: 'load' },
  );
  await composer.evaluate(() => Promise.all([...document.images].map((i) => (i.complete ? null : i.decode().catch(() => {})))));
  const out = path.join(OUT, file);
  await composer.screenshot({ path: out });
  log(`wrote ${path.relative(ROOT, out)}`);
}

const dataUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;

try {
  const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 20000 }));
  const extId = new URL(sw.url()).host;
  log(`extension ${extId}`);

  const panel = ctx.pages()[0] ?? (await ctx.newPage());
  await panel.setViewportSize({ width: PANEL_W, height: H });
  await panel.goto(`chrome-extension://${extId}/sidepanel.html`);
  await panel.evaluate((s) => chrome.storage.local.set({ settings: s }), settings);

  const authed = { authorization: `Bearer ${TOKEN}` };
  const put = await fetch(`${BRAIN_URL}/config`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...authed },
    body: JSON.stringify({
      ...toUserConfig(settings),
      sites: sites.map((s) => ({ domain: s.domain, notes: s.notes, allow: s.allow, mode: s.mode ?? 'dom' })),
      memory: `The student's WSP portal in this environment is ${WSP_URL} (same modules as wsp.kbtu.kz). The vault is Google Drive folder Dayflow/<course>/<week|lab|materials>/.`,
    }),
  });
  if (!put.ok) throw new Error(`PUT /config failed: HTTP ${put.status}`);

  const site = await ctx.newPage();
  await site.setViewportSize({ width: SITE_W, height: H });
  await site.goto(`${WSP_URL}/`, { waitUntil: 'domcontentloaded' }).catch((e) => log(`portal: ${e.message}`));
  await panel.bringToFront();
  await panel.reload();

  let composer1Done = false;
  // The tab the agent itself opened on the portal (it works in its own tab); fall back to the seeded one.
  const agentTab = () => ctx.pages().filter((p) => p.url().startsWith(WSP_URL)).at(-1) ?? site;
  const shotRun = async (file) => {
    const tab = agentTab();
    const p = await panel.screenshot();
    // The agent's tabs inherit the context viewport (1280×800); crop the right band the panel will cover
    // instead of resizing them mid-run (a resize would move the coordinates the model is working with).
    const s = await tab.screenshot(tab === site ? {} : { clip: { x: 0, y: 0, width: SITE_W, height: H } });
    await compose(
      file,
      `<div style="display:flex;height:${H}px">
         <img class="shot" style="border-radius:0;box-shadow:none" src="${dataUrl(s)}" width="${SITE_W}" height="${H}">
         <img style="box-shadow:-18px 0 40px rgba(0,0,0,.45)" src="${dataUrl(p)}" width="${PANEL_W}" height="${H}">
       </div>`,
    );
  };
  const shotPanel = async (file, tag, title, body) => {
    const p = await panel.screenshot();
    // Uniform scale (no crop): the whole panel, composer included, stays visible.
    const h = H - 96;
    const w = Math.round((PANEL_W * h) / H);
    await compose(
      file,
      `<div style="display:flex;height:${H}px;align-items:center;gap:56px;padding:0 64px">
         <div style="flex:1"><span class="tag">${tag}</span><h1>${title}</h1><p>${body}</p></div>
         <img class="shot" src="${dataUrl(p)}" width="${w}" height="${h}">
       </div>`,
    );
  };

  if (RUN) {
    let composerEl = panel.locator('textarea[placeholder^="Ask"]').first();
    if (!(await composerEl.count())) composerEl = panel.locator('textarea').first();
    await composerEl.waitFor({ timeout: 20000 });
    await composerEl.fill(prompt);
    await composerEl.press('Enter');
    log(`prompt sent: ${prompt}`);

    const read = () =>
      panel.evaluate(() => {
        const txt = (el) => (el?.textContent ?? '').trim();
        const statusEl = document.querySelector('[data-run-status]');
        return {
          status: statusEl ? (statusEl.dataset.runStatus || txt(statusEl)).toLowerCase() : null,
          steps: document.querySelectorAll('[data-step]').length,
          allow: [...document.querySelectorAll('button')].some((b) => b.dataset.confirm === 'allow' || /^Allow/.test(txt(b))),
        };
      });

    const deadline = Date.now() + TIMEOUT_MS;
    let last = -1;
    while (Date.now() < deadline) {
      const snap = await read().catch(() => null);
      if (snap) {
        if (snap.allow) await panel.locator('button[data-confirm="allow"], button:has-text("Allow")').first().click().catch(() => {});
        if (snap.steps !== last) {
          last = snap.steps;
          log(`steps ${snap.steps} status ${snap.status ?? '—'}`);
        }
        // Mid-run frame: enough of the transcript to show reasoning + tool rows, while the portal is on a course page.
        if (!composer1Done && snap.steps >= 8) {
          composer1Done = true;
          await shotRun('01-run.png');
        }
        if (['done', 'error', 'cancelled'].includes(snap.status)) {
          log(`run ended: ${snap.status}`);
          break;
        }
      }
      await sleep(1000);
    }
    if (!composer1Done) await shotRun('01-run.png');
    // Bottom of the transcript: summary + artifacts.
    await panel.evaluate(() => document.querySelectorAll('[data-step]')?.[document.querySelectorAll('[data-step]').length - 1]?.scrollIntoView({ block: 'end' }));
    await sleep(500);
    await shotPanel(
      '02-chat.png',
      'Chat-first',
      'Every step, in the open',
      'One sentence of reasoning before each action, the tool it used, how long it took, and the files it produced — like a terminal transcript, not a spinner.',
    );
  } else {
    await shotRun('01-run.png');
    await shotPanel('02-chat.png', 'Chat-first', 'Ask for the task, watch it work', 'Type a task or press / to pick a skill. The panel narrates every step and asks before anything irreversible.');
  }

  await panel.locator('button[aria-label="Settings"]').first().click();
  await sleep(600);
  await shotPanel(
    '03-settings.png',
    'Your brain, your keys',
    'No server of ours in the middle',
    'Point the panel at a backend you run — on your laptop or on your own Cloud Run project — sign in to Google for the Drive vault, and turn vision on or off.',
  );

  await panel.locator('button[aria-label="Config"]').first().click();
  await sleep(900);
  await shotPanel(
    '04-config.png',
    'Editable config',
    'Skills, sites and permissions are one YAML',
    'Add a skill, teach the agent a new site, restrict where it may navigate, schedule a run. Validated in the panel and synced to your brain.',
  );

  log(`done — ${fs.readdirSync(OUT).filter((f) => f.endsWith('.png')).length} screenshots in ${path.relative(ROOT, OUT)}`);
} catch (e) {
  console.error(`screenshots failed: ${e.message}`);
  process.exitCode = 1;
} finally {
  await ctx.close().catch(() => {});
}
