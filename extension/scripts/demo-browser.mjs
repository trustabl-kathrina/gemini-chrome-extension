// Headed Chromium with the Dayflow extension pre-loaded, on a persistent profile.
// Usage: node scripts/demo-browser.mjs [profileDir] [startUrl]
// Writes .demo-browser.json (extension id, CDP endpoint) next to this script; Ctrl+C to close.
import { chromium } from 'playwright';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../.output/chrome-mv3');
const profile = process.argv[2] ?? resolve(process.env.HOME, '.dayflow-demo-profile');
const startUrl = process.argv[3] ?? 'https://wsp.kbtu.kz/';
if (!existsSync(`${EXT}/manifest.json`)) {
  console.error(`no build at ${EXT} — run pnpm build first`);
  process.exit(1);
}

const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: null,
  args: [
    `--disable-extensions-except=${EXT}`,
    `--load-extension=${EXT}`,
    '--hide-crash-restore-bubble',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1440,900',
  ],
  ignoreDefaultArgs: ['--enable-automation'],
});

let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null));
const extId = sw ? new URL(sw.url()).host : null;
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(startUrl).catch(() => {});

const state = { pid: process.pid, profile, extensionId: extId, panelUrl: extId ? `chrome-extension://${extId}/sidepanel.html` : null, startedAt: new Date().toISOString() };
writeFileSync(resolve(here, '../.demo-browser.json'), JSON.stringify(state, null, 2));
console.log(JSON.stringify(state));
if (!extId) console.error('extension service worker did not start');

// Mirror extension + page console errors so the operator can watch a run from the terminal.
ctx.on('page', (p) => {
  p.on('pageerror', (e) => console.log(`[page:${p.url().slice(0, 60)}] ${e.message}`));
});
if (sw) sw.on('console', (m) => console.log(`[sw:${m.type()}] ${m.text()}`));

process.on('SIGINT', async () => {
  await ctx.close();
  process.exit(0);
});
await new Promise(() => {});
