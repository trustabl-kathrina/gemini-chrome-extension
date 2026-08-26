import { chromium } from 'playwright';
const EXT = '/home/altairzhambyl/projects/genaihack/extension/.output/chrome-mv3';
const ctx = await chromium.launchPersistentContext('/tmp/dayflow-profile-test', {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
let sw = ctx.serviceWorkers()[0];
if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
console.log('service worker:', sw ? sw.url() : 'NONE');
if (sw) {
  const id = new URL(sw.url()).host;
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
  page.on('console', (m) => (m.type() === 'error') && errs.push('console: ' + m.text()));
  await page.goto(`chrome-extension://${id}/sidepanel.html`);
  await page.waitForTimeout(1500);
  console.log('panel title:', await page.title(), '| skills rendered:', await page.locator('text=Sync WSP files').count());
  console.log('errors:', errs.length ? errs.join('\n') : 'none');
}
await ctx.close();
