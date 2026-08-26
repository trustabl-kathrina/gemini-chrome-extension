import { TOOL_CHANNEL } from '@/src/protocol';

/**
 * Eyes and hands. Runs in every frame; the background addresses a frame by
 * `frameId` and elements by the stable refs this script hands out.
 */
type ToolRequest =
  | { channel: typeof TOOL_CHANNEL; name: 'snapshot'; maxNodes?: number }
  | { channel: typeof TOOL_CHANNEL; name: 'click'; ref: string }
  | { channel: typeof TOOL_CHANNEL; name: 'type'; ref: string; text: string; submit?: boolean }
  | { channel: typeof TOOL_CHANNEL; name: 'scroll'; ref?: string; dy?: number };

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

function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none';
}

function* walk(root: Node): Generator<Element> {
  const tw = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
  for (let n = tw.nextNode(); n; n = tw.nextNode()) {
    const el = n as Element;
    yield el;
    if (el.shadowRoot) yield* walk(el.shadowRoot);
  }
}

const INTERACTIVE = 'a,button,input,select,textarea,summary,[role],[onclick],[contenteditable="true"]';

/** Compact, LLM-friendly page representation: one line per meaningful element. */
function snapshot(maxNodes = 400): string {
  const lines: string[] = [`# ${document.title} — ${location.href}`];
  for (const el of walk(document.body)) {
    if (lines.length > maxNodes) {
      lines.push('… more nodes omitted');
      break;
    }
    const interactive = el.matches(INTERACTIVE);
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent?.trim() ?? '')
      .join(' ')
      .trim();
    if (!interactive && !own) continue;
    if (!isVisible(el)) continue;
    const role = el.getAttribute('role') ?? el.tagName.toLowerCase();
    const label = el.getAttribute('aria-label') ?? (el as HTMLElement).innerText?.trim().slice(0, 80) ?? own.slice(0, 80);
    const value =
      el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? ` value=${JSON.stringify(el.value.slice(0, 40))}` : '';
    const href = el instanceof HTMLAnchorElement && el.href ? ` href=${el.href.slice(0, 80)}` : '';
    lines.push(`${interactive ? `[${refFor(el)}] ` : ''}${role} ${JSON.stringify(label)}${value}${href}`);
  }
  return lines.join('\n');
}

function resolve(ref: string): Element {
  const el = byRef.get(ref);
  if (!el || !el.isConnected) throw new Error(`ref ${ref} is gone — take a new snapshot`);
  return el;
}

function click(ref: string) {
  const el = resolve(ref) as HTMLElement;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  el.focus?.();
  el.click();
  return { clicked: ref };
}

function type(ref: string, text: string, submit = false) {
  const el = resolve(ref) as HTMLElement;
  el.scrollIntoView({ block: 'center' });
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
  if (submit) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', bubbles: true }));
  }
  return { typed: text.length };
}

function scroll(ref?: string, dy = 600) {
  if (ref) resolve(ref).scrollIntoView({ block: 'center' });
  else window.scrollBy({ top: dy, behavior: 'instant' });
  return { scrollY: window.scrollY };
}

function handle(req: ToolRequest): ToolResponse {
  try {
    switch (req.name) {
      case 'snapshot':
        return { ok: true, data: snapshot(req.maxNodes) };
      case 'click':
        return { ok: true, data: click(req.ref) };
      case 'type':
        return { ok: true, data: type(req.ref, req.text, req.submit) };
      case 'scroll':
        return { ok: true, data: scroll(req.ref, req.dy) };
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
