// Headed Chromium with the Dayflow extension pre-loaded, on a persistent profile.
// Usage: node scripts/demo-browser.mjs [profileDir] [startUrl] [--layout] [--total 1440x900] [--panel-width 420]
//                                      [--pos 0,0] [--panel window|tab|side] [--pin]
// Writes .demo-browser.json (extension id, panel URL, granted window bounds, record rectangle); Ctrl+C to close.
//
// --layout (docs/DEMO.md): the recording layout, so nothing has to be dragged into place — the target site fills a
// window on the left and the Dayflow panel is docked against its right edge, together --total (default 1440x900)
// at --pos (default 0,0). --panel picks how the panel is shown:
//   window (default) an extension popup window: a real extension page (chrome.runtime is live — a window.open popup
//                    is not), created with chrome.windows.create({type:'popup'}) from the service worker; Chrome
//                    ignores its create-time bounds, so applyLayout() places it afterwards.
//   side             no second window: the site window is sized to the full --total and you click the Dayflow
//                    toolbar icon once — Chrome's side panel needs a user gesture, it cannot be opened from here.
//   tab              the panel as a second tab in the same window (what the harness does).
// --pin re-asserts the bounds every 3 s (insurance: the agent no longer has a set_viewport tool).
import { chromium } from 'playwright';
import { writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const EXT = resolve(here, '../.output/chrome-mv3');

const argv = process.argv.slice(2);
/** `--flag value` or `--flag=value`; returns `fallback` when absent. */
function flag(name, fallback = null) {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return fallback;
  const inline = argv[i].split('=').slice(1).join('=');
  const next = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
  return inline || next || fallback;
}
const has = (name) => argv.some((a) => a === `--${name}` || a.startsWith(`--${name}=`));
// Flags that take a separate value; that value is not a positional argument.
const VALUED = new Set(['total', 'panel-width', 'pos', 'panel']);
const consumed = (i) => i > 0 && argv[i - 1].startsWith('--') && !argv[i - 1].includes('=') && VALUED.has(argv[i - 1].slice(2));
const positional = argv.filter((a, i) => !a.startsWith('--') && !consumed(i));

/** `--<name> 1440x900` / `--<name> 0,0` → [a, b]; a typo exits instead of silently falling back to the default. */
const pair = (name, sep, dflt) => {
  const raw = flag(name);
  if (raw == null) return dflt;
  const m = new RegExp(`^(\\d+)\\s*${sep}\\s*(\\d+)$`).exec(String(raw).trim());
  if (!m) {
    console.error(`--${name} ${raw}: expected ${dflt[0]}${sep === ',' ? ',' : 'x'}${dflt[1]}`);
    process.exit(1);
  }
  return [Number(m[1]), Number(m[2])];
};
const profile = positional[0] ?? resolve(process.env.HOME, '.dayflow-demo-profile');
const startUrl = positional[1] ?? 'https://wsp.kbtu.kz/';
const LAYOUT = has('layout');
const PIN = has('pin');
const PANEL = String(flag('panel', 'window'));
if (!['window', 'tab', 'side'].includes(PANEL)) {
  console.error(`--panel ${PANEL}: expected window, tab or side`);
  process.exit(1);
}
const [TOTAL_W, TOTAL_H] = pair('total', '[x×]', [1440, 900]);
const PANEL_W = Number(flag('panel-width', 420));
const [POS_X, POS_Y] = pair('pos', ',', [0, 0]);
if (!Number.isFinite(PANEL_W)) {
  console.error(`--panel-width ${flag('panel-width')}: expected a number of pixels`);
  process.exit(1);
}
const MAIN_W = Math.max(400, TOTAL_W - (LAYOUT && PANEL === 'window' ? PANEL_W : 0));

if (!existsSync(`${EXT}/manifest.json`)) {
  console.error(`no build at ${EXT} — run pnpm build first`);
  process.exit(1);
}
if (LAYOUT && PANEL === 'window' && (PANEL_W < 300 || PANEL_W > TOTAL_W - 400)) {
  console.error(`--panel-width ${PANEL_W} does not fit in --total ${TOTAL_W}x${TOTAL_H} (300 … ${TOTAL_W - 400})`);
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
    `--window-size=${LAYOUT ? MAIN_W : 1440},${LAYOUT ? TOTAL_H : 900}`,
    ...(LAYOUT ? [`--window-position=${POS_X},${POS_Y}`] : []),
  ],
  ignoreDefaultArgs: ['--enable-automation'],
});

let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null));
const extId = sw ? new URL(sw.url()).host : null;
const panelUrl = extId ? `chrome-extension://${extId}/sidepanel.html` : null;
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto(startUrl).catch(() => {});

/**
 * Place the site window and the panel window side by side and report what Chrome actually granted.
 * `chrome.windows.update` echoes the request, so every placement is read back with `chrome.windows.get`.
 * A window manager clamps how high a window may sit, and it clamps a popup lower than a normal window
 * (measured here: normal top 13, popup top 69 for the same request), so the second pass settles both at
 * the lower of the two granted tops — that value is above both clamps, so it is honoured verbatim.
 * The returned `recordRect` is the union of the two windows: the region to record.
 */
async function applyLayout(panelWindowId) {
  return await sw.evaluate(
    async ({ panelWindowId, x, y, mainW, panelW, h }) => {
      const get = async (id) => {
        const w = await chrome.windows.get(id);
        return { id, left: w.left ?? 0, top: w.top ?? 0, width: w.width ?? 0, height: w.height ?? 0 };
      };
      const put = async (id, b) => {
        await chrome.windows.update(id, { ...b, state: 'normal' });
        await new Promise((r) => setTimeout(r, 200)); // let the WM answer before reading the real bounds back
        return get(id);
      };
      const union = (a, b) => {
        const left = Math.min(a.left, b?.left ?? a.left);
        const top = Math.min(a.top, b?.top ?? a.top);
        return { left, top, width: Math.max(a.left + a.width, (b?.left ?? 0) + (b?.width ?? 0)) - left, height: Math.max(a.top + a.height, (b?.top ?? 0) + (b?.height ?? 0)) - top };
      };
      const mainId = (await chrome.windows.getAll({ windowTypes: ['normal'] })).filter((w) => w.id !== panelWindowId)[0]?.id;
      if (mainId === undefined) return {};

      let main = await put(mainId, { left: x, top: y, width: mainW, height: h });
      if (panelWindowId == null) return { main, recordRect: union(main, null) };
      let panel = await put(panelWindowId, { left: main.left + main.width, top: main.top, width: panelW, height: h });

      const top = Math.max(main.top, panel.top);
      if (main.top !== top) main = await put(mainId, { left: x, top, width: mainW, height: h });
      if (panel.top !== top || panel.left !== main.left + main.width) panel = await put(panelWindowId, { left: main.left + main.width, top, width: panelW, height: h });
      return { main, panel, recordRect: union(main, panel) };
    },
    { panelWindowId, x: POS_X, y: POS_Y, mainW: MAIN_W, panelW: PANEL_W, h: TOTAL_H },
  );
}

let layout = null;
let panelWindowId = null;
if (LAYOUT && sw && panelUrl) {
  try {
    if (PANEL === 'window') {
      // chrome.windows.create ignores left/top here (Chrome places the popup itself) — applyLayout moves it.
      panelWindowId = await sw.evaluate(
        async ({ url, w, h }) => (await chrome.windows.create({ url, type: 'popup', width: w, height: h, focused: true })).id,
        { url: panelUrl, w: PANEL_W, h: TOTAL_H },
      );
    } else if (PANEL === 'tab') {
      await (await ctx.newPage()).goto(panelUrl);
    }
    layout = await applyLayout(panelWindowId);
    // The site window keeps the focus so the agent's active-tab fallback resolves to the page, not to the panel.
    if (layout.main) await sw.evaluate((id) => chrome.windows.update(id, { focused: true }), layout.main.id).catch(() => {});
    if (PANEL === 'side') console.log('click the Dayflow toolbar icon to open the side panel (chrome.sidePanel.open needs a user gesture)');
  } catch (e) {
    console.error(`--layout failed (${e.message}); arrange the windows manually`);
  }
} else if (LAYOUT) {
  console.error('--layout needs the extension service worker (no extension id) — arrange the windows manually');
}

const state = {
  pid: process.pid,
  profile,
  extensionId: extId,
  panelUrl,
  startUrl,
  layout: LAYOUT ? { panel: PANEL, total: [TOTAL_W, TOTAL_H], pos: [POS_X, POS_Y], panelWidth: PANEL === 'window' ? PANEL_W : 0, mainWidth: MAIN_W, pinned: PIN, windows: layout } : null,
  startedAt: new Date().toISOString(),
};
writeFileSync(resolve(here, '../.demo-browser.json'), JSON.stringify(state, null, 2));
console.log(JSON.stringify(state));
if (!extId) console.error('extension service worker did not start');
if (LAYOUT && layout?.main) {
  const r = layout.recordRect;
  console.log(
    `layout: site ${layout.main.width}x${layout.main.height} @${layout.main.left},${layout.main.top}` +
      (layout.panel ? ` · panel ${layout.panel.width}x${layout.panel.height} @${layout.panel.left},${layout.panel.top}` : ` · panel: ${PANEL}`) +
      (r ? ` — record ${r.width}x${r.height} at ${r.left},${r.top}` : ''),
  );
}

// Mirror extension + page console errors so the operator can watch a run from the terminal.
ctx.on('page', (p) => {
  p.on('pageerror', (e) => console.log(`[page:${p.url().slice(0, 60)}] ${e.message}`));
});
if (sw) sw.on('console', (m) => console.log(`[sw:${m.type()}] ${m.text()}`));

// --pin: the agent's set_viewport (and Chrome's own restore) resize the tab's window mid-run; put it back.
let pinTimer = null;
if (LAYOUT && PIN && sw) {
  pinTimer = setInterval(() => {
    applyLayout(panelWindowId).catch(() => {});
  }, 3000);
  pinTimer.unref?.();
}

process.on('SIGINT', async () => {
  if (pinTimer) clearInterval(pinTimer);
  await ctx.close();
  process.exit(0);
});
await new Promise(() => {});
