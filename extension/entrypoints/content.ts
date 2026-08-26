import { TOOL_CHANNEL } from '@/src/protocol';

/**
 * Eyes and hands (PLAN v2 §The loop). Runs in every frame; the background addresses the top frame and
 * elements by the stable refs this script hands out with each snapshot.
 */
type ToolRequest =
  | { channel: typeof TOOL_CHANNEL; name: 'snapshot'; maxNodes?: number }
  | { channel: typeof TOOL_CHANNEL; name: 'click'; ref: string }
  | { channel: typeof TOOL_CHANNEL; name: 'click_at'; x: number; y: number }
  | { channel: typeof TOOL_CHANNEL; name: 'type'; ref: string; text: string; submit?: boolean }
  | { channel: typeof TOOL_CHANNEL; name: 'press_key'; key: string }
  | { channel: typeof TOOL_CHANNEL; name: 'scroll'; ref?: string; dy?: number }
  | { channel: typeof TOOL_CHANNEL; name: 'viewport' }
  | { channel: typeof TOOL_CHANNEL; name: 'href'; ref: string };

type ToolResponse = { ok: true; data: unknown } | { ok: false; error: string };

const refs = new WeakMap<Element, string>();
const byRef = new Map<string, Element>();
let counter = 0;

function refFor(el: Element): string {
  let r = refs.get(el);
  if (!r) {
    r = `e${++counter}`;
    refs.set(el, r);
    byRef.set(r, el);
  }
  return r;
}

function isVisible(el: Element, rect: DOMRect): boolean {
  if (rect.width === 0 || rect.height === 0) return false;
  if (rect.bottom < 0 || rect.right < 0 || rect.top > innerHeight || rect.left > innerWidth) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
}

function* walk(root: Node): Generator<Element> {
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const el = n as Element;
    if (el instanceof HTMLScriptElement || el instanceof HTMLStyleElement) continue;
    yield el;
    if (el.shadowRoot) yield* walk(el.shadowRoot);
  }
}

const INTERACTIVE = 'a,button,input,select,textarea,summary,option,[role],[onclick],[tabindex],[contenteditable="true"],tr,td,li,img';
const INTERACTIVE_ROLES = new Set(['button', 'link', 'menuitem', 'tab', 'option', 'row', 'gridcell', 'cell', 'checkbox', 'radio', 'textbox', 'combobox', 'listitem', 'treeitem']);

function ownText(el: Element): string {
  return Array.from(el.childNodes)
    .filter((n) => n.nodeType === Node.TEXT_NODE)
    .map((n) => n.textContent?.replace(/\s+/g, ' ').trim() ?? '')
    .filter(Boolean)
    .join(' ');
}

function isInteractive(el: Element): boolean {
  if (!el.matches(INTERACTIVE)) return false;
  const role = el.getAttribute('role');
  if (role && !INTERACTIVE_ROLES.has(role)) return false;
  if (el instanceof HTMLImageElement) return !!(el.getAttribute('alt') || el.closest('a,button,[onclick]'));
  if (el.matches('td,li,tr') && !el.hasAttribute('onclick') && getComputedStyle(el).cursor !== 'pointer') return false;
  return true;
}

function labelOf(el: Element, own: string): string {
  const aria = el.getAttribute('aria-label') ?? el.getAttribute('title') ?? el.getAttribute('placeholder');
  if (aria) return aria;
  if (el instanceof HTMLImageElement) return el.alt || el.src.split('/').pop() || 'image';
  if (el instanceof HTMLInputElement && (el.type === 'submit' || el.type === 'button')) return el.value;
  const text = own || (el as HTMLElement).innerText?.replace(/\s+/g, ' ').trim() || '';
  return text;
}

/**
 * Element list: one line per visible element that has its own text or is interactive —
 * `[eN] role "label" @x,y` (x,y = viewport centre in CSS px). Capped at `maxNodes` lines.
 */
function snapshot(maxNodes = 400): { text: string; nodes: number; truncated: boolean } {
  const cap = Math.min(Math.max(1, maxNodes), 500);
  const head = `# ${document.title} — ${location.href} (viewport ${innerWidth}x${innerHeight}, scrollY ${Math.round(scrollY)})`;
  const lines: string[] = [];
  const seen = new Set<string>();
  let truncated = false;
  for (const el of walk(document.body)) {
    if (lines.length >= cap) {
      truncated = true;
      break;
    }
    const own = ownText(el);
    const interactive = isInteractive(el);
    if (!interactive && !own) continue;
    const rect = el.getBoundingClientRect();
    if (!isVisible(el, rect)) continue;
    const role = el.getAttribute('role') ?? (el instanceof HTMLInputElement ? `input:${el.type}` : el.tagName.toLowerCase());
    const label = labelOf(el, own).slice(0, 80);
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? ` value=${JSON.stringify(el.value.slice(0, 40))}` : '';
    const href = el instanceof HTMLAnchorElement && el.href ? ` href=${el.href.slice(0, 80)}` : '';
    const state = el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio') ? (el.checked ? ' checked' : '') : el.classList.contains('v-selected') || el.getAttribute('aria-selected') === 'true' ? ' selected' : '';
    const line = `[${refFor(el)}] ${role} ${JSON.stringify(label)} @${x},${y}${value}${href}${state}`;
    // Nested wrappers repeat the same label at the same spot: keep the outermost only.
    const key = `${role}|${label}|${x}|${y}`;
    if (seen.has(key)) continue;
    seen.add(key);
    lines.push(line);
  }
  return { text: [head, ...lines, ...(truncated ? ['… more nodes omitted (raise max_nodes or scroll)'] : [])].join('\n'), nodes: lines.length, truncated };
}

/** Flash an outline on the element the agent is acting on, so a human can follow along. */
function highlight(el: Element) {
  const h = el as HTMLElement;
  if (!h.style) return;
  const prev = { outline: h.style.outline, offset: h.style.outlineOffset, transition: h.style.transition };
  h.style.transition = 'outline-color 120ms ease-out';
  h.style.outline = '2px solid oklch(0.7 0.19 292)';
  h.style.outlineOffset = '2px';
  setTimeout(() => {
    h.style.outline = prev.outline;
    h.style.outlineOffset = prev.offset;
    h.style.transition = prev.transition;
  }, 900);
}

function resolve(raw: string): Element {
  const ref = raw.trim().replace(/^\[|\]$/g, '');
  const el = byRef.get(ref);
  if (!el || !el.isConnected) throw new Error(`ref ${ref} is gone — call read_page again`);
  return el;
}

function mouseSequence(el: Element, x: number, y: number) {
  const opts = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, view: window };
  for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
    el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...opts, pointerType: 'mouse', isPrimary: true }) : new MouseEvent(type, opts));
  }
}

function click(ref: string) {
  const el = resolve(ref) as HTMLElement;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  highlight(el);
  el.focus?.();
  const r = el.getBoundingClientRect();
  mouseSequence(el, r.left + r.width / 2, r.top + r.height / 2);
  el.click();
  return { clicked: ref, label: labelOf(el, ownText(el)).slice(0, 80) };
}

function clickAt(x: number, y: number) {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!el) throw new Error(`nothing at ${x},${y} (viewport is ${innerWidth}x${innerHeight})`);
  highlight(el);
  el.focus?.();
  mouseSequence(el, x, y);
  el.click();
  return { clicked_at: [x, y], target: `${el.tagName.toLowerCase()} ${JSON.stringify(labelOf(el, ownText(el)).slice(0, 60))}` };
}

const KEY_CODES: Record<string, number> = { Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, ' ': 32, Space: 32, PageDown: 34, PageUp: 33, Home: 36, End: 35 };

function pressKey(spec: string) {
  const parts = spec.split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop() ?? 'Enter';
  const mods = new Set(parts.map((m) => m.toLowerCase()));
  const target = (document.activeElement as HTMLElement | null) ?? document.body;
  const norm = key.length === 1 ? key : key === 'Space' ? ' ' : key;
  const init: KeyboardEventInit = {
    key: norm,
    code: norm.length === 1 ? (/[a-z]/i.test(norm) ? `Key${norm.toUpperCase()}` : /\d/.test(norm) ? `Digit${norm}` : norm) : norm,
    keyCode: KEY_CODES[norm] ?? (norm.length === 1 ? norm.toUpperCase().charCodeAt(0) : 0),
    bubbles: true,
    cancelable: true,
    composed: true,
    ctrlKey: mods.has('control') || mods.has('ctrl'),
    metaKey: mods.has('meta') || mods.has('cmd') || mods.has('command'),
    shiftKey: mods.has('shift'),
    altKey: mods.has('alt') || mods.has('option'),
  };
  const down = target.dispatchEvent(new KeyboardEvent('keydown', init));
  if (down && norm.length === 1 && !init.ctrlKey && !init.metaKey) {
    target.dispatchEvent(new KeyboardEvent('keypress', init));
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target.isContentEditable) document.execCommand('insertText', false, norm);
  }
  if (down && norm === 'Enter' && target instanceof HTMLInputElement && target.form) target.form.requestSubmit?.();
  target.dispatchEvent(new KeyboardEvent('keyup', init));
  return { pressed: spec, target: target.tagName.toLowerCase() };
}

function type(ref: string, text: string, submit = false) {
  const el = resolve(ref) as HTMLElement;
  el.scrollIntoView({ block: 'center' });
  highlight(el);
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    // Native setter bypasses React's value tracker so frameworks see the change.
    const proto = el instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else if (el.isContentEditable) {
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
  } else {
    throw new Error(`ref ${ref} is not editable`);
  }
  if (submit) pressKey('Enter');
  return { typed: text.length, submitted: submit };
}

function scroll(ref?: string, dy = 600) {
  if (ref) resolve(ref).scrollIntoView({ block: 'center' });
  else {
    // Prefer the tallest scrollable container under the cursor-less page (SPAs often scroll a div, not the window).
    const before = scrollY;
    window.scrollBy({ top: dy, behavior: 'instant' });
    if (scrollY === before) {
      const scroller = [...document.querySelectorAll<HTMLElement>('*')].find((e) => e.scrollHeight > e.clientHeight + 50 && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.clientHeight > innerHeight / 3);
      scroller?.scrollBy({ top: dy, behavior: 'instant' });
    }
  }
  return { scrollY: Math.round(scrollY), viewport: [innerWidth, innerHeight] };
}

function hrefOf(ref: string): { href?: string } {
  const el = resolve(ref);
  const a = el.closest('a[href]') ?? el.querySelector('a[href]');
  return { href: a instanceof HTMLAnchorElement ? a.href : undefined };
}

function handle(req: ToolRequest): ToolResponse {
  try {
    switch (req.name) {
      case 'snapshot':
        return { ok: true, data: snapshot(req.maxNodes) };
      case 'click':
        return { ok: true, data: click(req.ref) };
      case 'click_at':
        return { ok: true, data: clickAt(req.x, req.y) };
      case 'type':
        return { ok: true, data: type(req.ref, req.text, req.submit) };
      case 'press_key':
        return { ok: true, data: pressKey(req.key) };
      case 'scroll':
        return { ok: true, data: scroll(req.ref, req.dy) };
      case 'viewport':
        return { ok: true, data: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio, title: document.title, url: location.href } };
      case 'href':
        return { ok: true, data: hrefOf(req.ref) };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export default defineContentScript({
  matches: ['<all_urls>'],
  allFrames: true,
  runAt: 'document_idle',
  main() {
    browser.runtime.onMessage.addListener((raw: unknown, _sender, sendResponse) => {
      const req = raw as Partial<ToolRequest>;
      if (req?.channel !== TOOL_CHANNEL) return;
      sendResponse(handle(req as ToolRequest));
    });
  },
});
