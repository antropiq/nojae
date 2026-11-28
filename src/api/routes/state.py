"""The chat replies in flight, and what they hold still."""

import threading
from typing import Any, Dict, Optional

from fastapi import HTTPException


# Strong references to in-flight chat pump tasks (the event loop only keeps
# weak references to bare tasks), **keyed by the workspace each reply is about**
# and valued with that reply's canonical root — so "is a reply streaming" can be
# asked *of a workspace*, the only form of the question that means anything when
# two folders are served at once.
_CHAT_TASKS: Dict[Any, str] = {}


class ChatHandle:
    """One in-flight chat reply, so another request can pause it.

    ``POST /api/chat/pause`` is a separate HTTP request from the reply's own
    stream, so the pause flag has to live somewhere the two requests share. It
    is **keyed by workspace**, not held in one process-wide slot: the reply a tab
    may pause is the reply running on *that tab's* folder, and a second tab's
    turn is nobody else's to stop.
    """

    def __init__(self, pause_event: threading.Event, cancel_event: threading.Event) -> None:
        self.pause_event = pause_event
        self.cancel_event = cancel_event


# One handle per workspace, set for the duration of that workspace's streaming
# reply (cleared when its SSE generator ends), so a finished or aborted reply can
# never be paused afterwards. Two workspaces therefore hold two replies at the
# same time — nothing here serialises them, and nothing may: turns are never
# queued across tabs.
_CHAT_HANDLES: Dict[str, ChatHandle] = {}


def _arm_chat_handle(
    root: str, cancel_event: threading.Event, pause_event: threading.Event
) -> None:
    """Publish this workspace's in-flight reply so /chat/pause can reach it."""
    _CHAT_HANDLES[root] = ChatHandle(pause_event=pause_event, cancel_event=cancel_event)


def _clear_chat_handle(root: str, cancel_event: threading.Event) -> None:
    """Retire a workspace's handle, but only if it is still this reply's.

    Per key, with the rule the process-wide slot already had: a newer
    conversation on the same folder must never be un-registered by an old
    stream's ``finally``, and a reply on another folder is not this one's to
    clear either.
    """
    handle = _CHAT_HANDLES.get(root)
    if handle is not None and handle.cancel_event is cancel_event:
        _CHAT_HANDLES.pop(root, None)


def _chat_reply_handle(root: str) -> Optional[ChatHandle]:
    """The reply a request about ``root`` may pause, or ``None``."""
    return _CHAT_HANDLES.get(root)


def _chat_streaming_on(root: str) -> bool:
    """Is a reply streaming **on this workspace**? (Not: anywhere.)

    The wider question the hub-restart routes ask — it covers a reply whose
    handle is not armed yet, because those routes tear down what that reply is
    using. Keyed by the same canonical root the reply was armed under, so a
    reply on A never holds B's hub still.
    """
    return root in _CHAT_TASKS.values()


def workspace_is_busy(root: str) -> bool:
    """The pool's **veto**: is this workspace mid-work?

    Handed to :meth:`src.core.hubpool.HubPool.set_busy_predicate` at startup, so
    the pool can refuse to let go of a workspace whose tools are in use without
    importing this layer. The answer is the workspace's, never the process's: a
    reply on A says nothing about B.

    A **running batch** is covered by the same fact: every task of a lot is a
    chat turn on the workspace the lot was launched from, so a lot in progress
    keeps this answer true while it works. What it does not cover is the few
    seconds' pause between two relaunches of a task, which only costs a rebuild
    of a folder the tab is still pointed at.

    The wider question (``_chat_streaming_on``) is the one to ask, not the armed
    handle: the pool would be tearing down the very hub that reply is about to
    call.
    """
    return _chat_streaming_on(root)


def _refuse_if_chat_streaming(what: str, root: str) -> None:
    """409 while a chat reply is in flight **on ``root``** — the one place.

    A reply is the only other writer of *its* workspace, so a mutation landing
    in the middle of one races the model's own tool edits. Its **subject** is
    the folder the request names, so a save in B is not refused by a reply
    streaming against A. The check is the same per-workspace slot
    ``POST /api/chat/pause`` reads; the client-side rule in ``useEditorMode``
    is the *display* of this and the server is the enforcement.

    (The hub-restart routes ask the wider question instead —
    :func:`_chat_streaming_on`, which also covers a reply whose handle is not
    armed yet — because they tear down what that reply is using. A file write
    only needs to know a reply is streaming.)
    """
    if _chat_reply_handle(root) is not None:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot {what} while a chat reply is streaming on {root}",
        )

