import { chromium } from 'playwright';
const profile = process.env.HOME + '/.gstack/chromium-profile';
const ctx = await chromium.launchPersistentContext(profile, { headless: false, viewport: { width: 1280, height: 800 }, args: ['--no-first-run'] });
const page = ctx.pages()[0] ?? (await ctx.newPage());
const step = async (label, fn) => { try { await fn(); } catch (e) { console.log(`!! ${label}: ${e.message.slice(0, 100)}`); } };
const rows = async () => (await page.locator('tr').allInnerTexts()).map((t) => t.replace(/\s+/g, ' ').trim()).filter((t) => t && !/^fol name file$/i.test(t));
const item = (name) => page.locator('.v-menubar-menuitem', { hasText: new RegExp(`^\\s*${name}\\s*$`) }).first();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const enter = async (name) => { await page.locator('tr', { hasText: new RegExp(esc(name.slice(0, 30)), 'i') }).first().click({ timeout: 8000 }); await page.waitForTimeout(300); await item('Enter').click({ timeout: 8000 }); await page.waitForTimeout(2000); };
const back = async () => { await item('Back').click({ timeout: 8000 }); await page.waitForTimeout(1500); };
await page.goto('https://wsp.kbtu.kz/StudentFiles', { waitUntil: 'domcontentloaded', timeout: 60000 }); await page.waitForTimeout(5000);
await enter('School of Information Technology');
const instructors = (await rows()).filter((r) => !/^folder/i.test(r));
for (const who of instructors) {
  await step(who, async () => {
    await enter(who); const courses = (await rows()).filter((r) => !/^folder/i.test(r));
    for (const c of courses) {
      await step(c, async () => {
        await enter(c); const subs = (await rows()).filter((r) => !/^folder/i.test(r));
        console.log(`${who} / ${c}: [${subs.join(' | ').slice(0, 300)}]`);
        for (const s of subs.filter((x) => /lab|лаб|practi|практ|assign|task|homework|seminar/i.test(x)).slice(0, 2)) {
          await step(s, async () => { await enter(s); const files = (await rows()).filter((r) => !/^folder/i.test(r)); console.log(`      ${s}: ${files.slice(0, 10).join(' | ').slice(0, 400)}`); await back(); });
        }
        await back();
      });
    }
    await back();
  });
}
await ctx.close();
