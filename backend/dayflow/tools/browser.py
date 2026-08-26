"""Browser tools (PLAN v2 §The loop). The brain never executes these: each call pauses the run and the
extension performs it, then POSTs the result to /tool_result (ADK LongRunningFunctionTool).

Every tool returns None on purpose: ADK only skips the automatic FunctionResponse for a
long-running tool when it returns a falsy value (functions.py, "skip the auto-FR build when the
tool returned nothing"). Returning a dict would fake a result, trigger a second model round and
let the model chain several pending calls in one turn.

Every result carries `screenshot_b64` (JPEG of the working tab after the action) when the user's
vision setting is on; /tool_result turns it into an inline image part so the model can look at it.
"""

from __future__ import annotations

from google.adk.tools import LongRunningFunctionTool


def open_tab(url: str, pinned: bool = False) -> None:
    """Opens a new tab at a URL and makes it the working tab; waits for the page to finish loading.
    Result: {tabId, title, url} plus a screenshot of the loaded page.

    Args:
        url: Absolute http(s) URL. Only hosts on the user's allow-list are permitted.
        pinned: Open as a pinned background tab (scheduled jobs that must not disturb the user).
    """
    return None


def navigate(url: str) -> None:
    """Navigates the working tab to a URL and waits for the page to finish loading.
    Result: {tabId, title, url} plus a screenshot of the loaded page.

    Args:
        url: Absolute http(s) URL. Only hosts on the user's allow-list are permitted.
    """
    return None


def read_page(max_nodes: int = 400) -> None:
    """Returns the element list of the working tab: one line per visible element that has its own text
    or is interactive, as `[eN] role "label" @x,y` (N = stable ref, x,y = viewport centre). Refs are
    only valid until the next action; re-read after every navigation, click or Enter. Result also
    includes the page title, URL and a screenshot.

    Args:
        max_nodes: Upper bound on listed elements (default 400; raise it for long tables).
    """
    return None


def screenshot() -> None:
    """Captures a JPEG screenshot of the working tab's viewport (≤1280px wide). Use it to verify what
    happened after an action, or as the primary perception on `mode: vision` sites; then act with
    click_at(x, y) on what you see.
    """
    return None


def click(ref: str) -> None:
    """Clicks an element by the ref from the latest read_page (e.g. "e17"), waits for the page to settle.
    Result: {clicked, title, url} plus a screenshot taken after the click — check it before deciding
    the next step (on Vaadin tables a click only SELECTS the row; press_key("Enter") or the Enter
    button opens it).

    Args:
        ref: Element ref from the latest read_page snapshot (with or without the brackets).
    """
    return None


def click_at(x: int, y: int) -> None:
    """Clicks at viewport coordinates (CSS pixels, origin top-left) — for `mode: vision` sites or when an
    element has no ref. Result includes a screenshot taken after the click.

    Args:
        x: Horizontal offset in pixels from the left edge of the viewport.
        y: Vertical offset in pixels from the top of the viewport.
    """
    return None


def type_text(ref: str, text: str, submit: bool = False) -> None:
    """Types text into an input, textarea or contenteditable element (replaces existing content) and
    optionally presses Enter. Result includes a screenshot taken after typing. Sending messages needs
    request_confirmation first when the user's permissions say so.

    Args:
        ref: Element ref from the latest read_page snapshot.
        text: Text to enter.
        submit: Press Enter after typing (sends messages, submits forms).
    """
    return None


type_text.__name__ = "type"  # the tool the model sees is `type` (PLAN v2); `type_text` stays the Python name


def press_key(key: str) -> None:
    """Presses one key on the focused element (e.g. "Enter", "Escape", "Tab", "ArrowDown", "Backspace",
    "Control+A"). On Vaadin folder tables: click the row, then press Enter to open it. Result includes a
    screenshot taken after the key press.

    Args:
        key: Key name as in KeyboardEvent.key, optionally with modifiers joined by "+".
    """
    return None


def scroll(dy: int = 600, ref: str = "") -> None:
    """Scrolls the page (or a scrollable element) so more content becomes visible. Result includes a
    screenshot after scrolling; refs from before the scroll stay valid.

    Args:
        dy: Pixels to scroll; positive = down, negative = up.
        ref: Optional element ref to scroll into view instead of scrolling by dy.
    """
    return None


def set_viewport(width: int, height: int) -> None:
    """Resizes the working tab's window so the viewport is about width×height pixels — use it when a
    page cuts off tables or when screenshots need more room. Result includes a screenshot.

    Args:
        width: Viewport width in pixels (800–1920).
        height: Viewport height in pixels (600–1200).
    """
    return None


def run_js(expression: str) -> None:
    """Evaluates a JavaScript expression in the page (MAIN world) and returns its JSON-serialisable value
    as {value}. Only allowed on hosts in the user's allow-list; every call is logged and shown to the
    user. Use it for reading data the element list does not expose (table cells, hidden hrefs), not for
    clicking — clicks must go through click / click_at so the user sees them.

    Args:
        expression: A single JavaScript expression, e.g. "document.title" or
            "[...document.querySelectorAll('a')].map(a => a.href)".
    """
    return None


def download(path: str, ref: str = "", url: str = "") -> None:
    """Downloads one file from the working tab and stores it in the user's vault (Google Drive folder
    and the brain's vault index) at the given path. Give either the ref of the file's row/link (the
    extension triggers the download with the user's cookies) or a direct URL.
    Result: {drive_file_id, path, bytes, vault_id} plus a screenshot; the brain parses PDFs on upload,
    so summaries and deadlines appear in vault_list right after.

    Args:
        path: Vault-relative path "<course code> <course name>/<Materials|Week NN|Lab NN>/<file name>",
            e.g. "CSCI3240 Introduction to Computer Vision/Lab 01/Lab_01_Image_Basics.pdf".
        ref: Element ref of the file row or link from the latest read_page (Vaadin tables: the row).
        url: Direct file URL instead of a ref (only hosts on the user's allow-list).
    """
    return None


def list_tabs() -> None:
    """Lists the user's open tabs as {tabs: [{id, title, url, active}]} so you can pick a working tab."""
    return None


def wait(ms: int = 1000) -> None:
    """Waits for the page to settle (network idle or the given milliseconds, whichever comes first) and
    returns a fresh screenshot — use it after actions that trigger slow loads.

    Args:
        ms: Maximum milliseconds to wait, 100–15000.
    """
    return None


def request_confirmation(action: str, details: str) -> None:
    """Asks the user to approve an irreversible or outward-facing action BEFORE performing it
    (sending a message, opening a PR, creating issues). The answer arrives as {"confirmed": bool};
    a "true" answer grants one credit for the next guarded tool call.

    Args:
        action: Short label, e.g. "Send Telegram message to 'Diploma · Team'".
        details: The exact content that will be sent or created.
    """
    return None


BROWSER_FUNCTIONS = [
    open_tab,
    navigate,
    read_page,
    screenshot,
    click,
    click_at,
    type_text,
    press_key,
    scroll,
    set_viewport,
    run_js,
    download,
    list_tabs,
    wait,
]
BROWSER_TOOLS = [LongRunningFunctionTool(func=f) for f in BROWSER_FUNCTIONS]
CONFIRM_TOOL = LongRunningFunctionTool(func=request_confirmation)
# Tools that count towards the per-run browser action cap (request_confirmation is a question, not an action).
BROWSER_ACTION_NAMES = frozenset(f.__name__ for f in BROWSER_FUNCTIONS)
BROWSER_TOOL_NAMES = BROWSER_ACTION_NAMES | {request_confirmation.__name__}
# Tools whose `url` argument must pass the host allow-list.
URL_TOOL_NAMES = frozenset({"navigate", "open_tab", "download"})
