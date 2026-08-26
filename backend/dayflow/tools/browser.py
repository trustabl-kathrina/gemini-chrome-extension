"""Browser tools. The brain never executes these: each call pauses the run and the
extension performs it, then POSTs the result to /tool_result (ADK LongRunningFunctionTool).

Every tool returns None on purpose: ADK only skips the automatic FunctionResponse for a
long-running tool when it returns a falsy value (functions.py, "skip the auto-FR build when the
tool returned nothing"). Returning a dict would fake a result, trigger a second model round and
let the model chain several pending calls in one turn."""

from __future__ import annotations

from google.adk.tools import LongRunningFunctionTool


def navigate(url: str) -> None:
    """Navigates the agent's working tab to a URL and waits for the page to finish loading.

    Args:
        url: Absolute URL (https://...). Only hosts on the user's allow-list are permitted.
    """
    return None


def read_page() -> None:
    """Returns a compact text snapshot of the working tab: one line per visible element with a
    stable ref like [e17] for interactive elements. Call this after every navigation or click
    before deciding what to do next.
    """
    return None


def click(ref: str) -> None:
    """Clicks an element by the ref returned from read_page (e.g. "e17").

    Args:
        ref: Element ref from the latest read_page snapshot.
    """
    return None


def type_text(ref: str, text: str, submit: bool = False) -> None:
    """Types text into an input, textarea or contenteditable element.

    Args:
        ref: Element ref from the latest read_page snapshot.
        text: Text to enter (replaces existing content).
        submit: Press Enter after typing (sends messages, submits forms).
    """
    return None


def wait(ms: int = 1000) -> None:
    """Waits for a page to settle (network idle or the given milliseconds, whichever first).

    Args:
        ms: Maximum milliseconds to wait, 100–15000.
    """
    return None


def screenshot() -> None:
    """Captures a screenshot of the working tab. Use only when read_page is insufficient
    (canvas-based UIs); it is slower and costs more.
    """
    return None


def download(url: str, path: str) -> None:
    """Downloads a file into the user's vault, creating folders as needed.

    Args:
        url: File URL (the browser sends the user's cookies, so portal files work).
        path: Relative path inside the vault, e.g. "Machine Learning/Week 07/Lecture_07.pdf".
    """
    return None


def open_tab(url: str, pinned: bool = False) -> None:
    """Opens a new tab and makes it the working tab.

    Args:
        url: URL to open.
        pinned: Open as a pinned background tab (for scheduled jobs that should not disturb the user).
    """
    return None


def list_tabs() -> None:
    """Lists the user's open tabs (id, title, url) so you can pick a working tab."""
    return None


def request_confirmation(action: str, details: str) -> None:
    """Asks the user to approve an irreversible or outward-facing action BEFORE performing it
    (sending a message, opening a PR, creating issues). The answer arrives as {"confirmed": bool}.

    Args:
        action: Short label, e.g. "Send Telegram message to 'Diploma · Team'".
        details: The exact content that will be sent or created.
    """
    return None


BROWSER_FUNCTIONS = [navigate, read_page, click, type_text, wait, screenshot, download, open_tab, list_tabs]
BROWSER_TOOLS = [LongRunningFunctionTool(func=f) for f in BROWSER_FUNCTIONS]
CONFIRM_TOOL = LongRunningFunctionTool(func=request_confirmation)
BROWSER_TOOL_NAMES = {f.__name__ for f in BROWSER_FUNCTIONS} | {request_confirmation.__name__}
