// Screenshots of the real panel (extension context) in both Gemini themes: light + dark, empty state and Settings.
// Usage: node scripts/theme-shots.mjs [outDir]  (headless new Chromium; no window on the desktop)
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../.output/chrome-mv3');
const out = process.argv[2] ?? '/tmp/dayflow-theme-shots';
mkdirSync(out, { recursive: true });
const ctx = await chromium.launchPersistentContext(`${out}/.profile`, {
  headless: true,
  channel: 'chromium',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 15000 }));
const id = new URL(sw.url()).host;
const page = await ctx.newPage();
await page.setViewportSize({ width: 420, height: 760 });
await page.goto(`chrome-extension://${id}/sidepanel.html`);
await page.evaluate(() =>
  chrome.storage.local.set({ settings: { backendUrl: 'https://dayflow-brain.example', token: 't', account: { email: 'altair@kbtu.kz', name: 'Altair Zhambyl' } } }),
);
await page.reload();
await page.waitForSelector('textarea');
for (const theme of ['light', 'dark']) {
  await page.evaluate((t) => { localStorage.setItem('dayflow.theme', t); document.documentElement.dataset.theme = t; }, theme);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${out}/chat-${theme}.png` });
  await page.getByLabel('Settings').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/settings-${theme}.png` });
  await page.locator('header').getByLabel('Back').first().click();
  await page.fill('textarea', '/');
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${out}/slash-${theme}.png` });
  await page.fill('textarea', '');
}
await ctx.close();
console.log('ok →', out);
