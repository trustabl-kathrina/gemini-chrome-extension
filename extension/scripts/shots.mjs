// Design-loop screenshots of the side panel served as a plain page (mock transport).
// Usage: node scripts/shots.mjs [baseUrl] [outDir]
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const base = process.argv[2] ?? 'http://127.0.0.1:8765/sidepanel.html';
const out = process.argv[3] ?? '/tmp/dayflow-shots';
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 400, height: 720 }, deviceScaleFactor: 2, colorScheme: 'dark' });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

const shot = (name) => page.screenshot({ path: `${out}/${name}.png` });

await page.goto(base);
await page.waitForSelector('text=Skills');
await shot('01-home');

// Command palette
await page.keyboard.press('Control+K');
await page.waitForSelector('input[placeholder^="Run a skill"]');
await shot('02-palette');
await page.keyboard.press('Escape');

// Run: vault-sync, mid-flight and finished
await page.getByRole('button', { name: /Sync WSP files/ }).click();
await page.waitForTimeout(3500);
await shot('03-run-live');
await page.waitForTimeout(16000);
await shot('04-run-done');

// Run: team-ops up to the confirmation card
await page.getByLabel('Back').click();
await page.getByRole('button', { name: /Team ops/ }).click();
await page.waitForSelector('text=needs your OK', { timeout: 20000 });
await shot('05-run-confirm');
await page.keyboard.press('Escape'); // deny → cancelled
await page.waitForTimeout(600);
await shot('06-run-cancelled');

// Home with recents
await page.getByLabel('Back').click();
await shot('07-home-recent');

// Settings tabs
await page.getByLabel('Settings').click();
await page.waitForSelector('text=New skill');
await shot('08-settings-skills');
await page.getByRole('button', { name: 'Sync WSP files to vault' }).click();
await shot('09-settings-skill-editor');
for (const [i, tab] of ['Sites', 'Connections', 'Permissions', 'Schedules', 'Advanced'].entries()) {
  await page.getByRole('button', { name: tab, exact: true }).click();
  await page.waitForTimeout(150);
  await shot(`${10 + i}-settings-${tab.toLowerCase()}`);
}

await browser.close();
if (errors.length) {
  console.error('page errors:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('ok →', out);
