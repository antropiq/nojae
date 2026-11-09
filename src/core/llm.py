"""Reading the chunks of a streamed completion, and knowing when one was cut.

The WorkBench chat stream (:mod:`core.chat`) is the only caller: it speaks no
HTTP of its own, so what it needs from here is how to read the chunk dicts
:mod:`core.llmkit` hands over, and what a stream that never carried a finish
reason means. The chat loop times its reply with these helpers, so they stay a
module of their own instead of folding into that loop.

Nothing here speaks HTTP and nothing here judges an answer's quality: the only
judgement made is whether a stream ended honestly.
"""

from typing import Any, Callable, Dict, Optional

Emit = Callable[[Dict[str, Any]], None]


# --- chunk reading ------------------------------------------------------------
#
# One read path, one protocol: a chunk is read as a mapping (``.get``), never
# partly as the attribute shape (``chunk.choices[0].delta.content``). ``llmkit``
# hands over plain chunk dicts, which read as mappings, and a stub that answers
# ``.get`` without being a dict reads the same way — so a chunk of any shape
# either yields its fields or reads as absent, and a read never raises out of
# the streaming loop. Anything else (a string, ``None``, a drained stream) reads
# as absent rather than raising.


def _field(container: Any, name: str) -> Any:
    """One mapping read, ``None`` when ``container`` carries no such field."""
    get = getattr(container, "get", None)
    if not callable(get):
        return None
    return get(name)


def _delta(chunk: Any) -> Any:
    """The chunk's generation delta, ``None`` when it carries none."""
    choices = _field(chunk, "choices")
    if not choices:
        return None
    return _field(choices[0], "delta")


def safe_get_choice_content(chunk: Any) -> str:
    """Safely extract content from a streamed chunk."""
    return str(_field(_delta(chunk), "content") or "")


def _extract_reasoning(chunk: Any) -> str:
    """Safely extract streamed reasoning text (thinking) from a chunk.

    Reasoning-capable servers emit thinking deltas under ``reasoning_content``
    or ``reasoning`` instead of ``content``; they are generated tokens too,
    so they must anchor the decode-window timing even though they are not
    part of the answer text.
    """
    delta = _delta(chunk)
    return str(
        _field(delta, "reasoning_content") or _field(delta, "reasoning") or ""
    )


def _extract_usage(chunk: Any) -> Optional[Dict[str, Optional[int]]]:
    """Read the usage block from a streamed chunk, when the server sent one.

    Returns ``{prompt_tokens, completion_tokens, total_tokens}`` with
    ``None`` for missing/zero fields, ``None`` overall when the chunk
    carries no usage.
    """
    usage = _field(chunk, "usage")
    if not usage:
        return None

    def field(name: str) -> Optional[int]:
        value = _field(usage, name)
        return int(value) if value else None

    return {
        "prompt_tokens": field("prompt_tokens"),
        "completion_tokens": field("completion_tokens"),
        "total_tokens": field("total_tokens"),
    }


# The chat stream's truncation sentence, imported by chat together with the
# event flag below. One sentence, deliberately free of provider jargon: it
# becomes the visible message in the WorkBench error line.
TRUNCATION_MESSAGE = (
    "The answer was cut short by the server before it finished "
    "(the stream ended without a finish reason). The reply above is "
    "incomplete — the task was not carried through."
)

# Carried on the terminal event so a client can style this failure differently
# from a plain one — and, in WorkBench, mark the *message* rather than only
# showing a transient error line (which the next send clears).
TRUNCATION_EVENT_FLAG = "truncated"


def saw_finish_reason(response_generator: Any) -> bool:
    """Whether the stream ended with a chunk that carried a finish reason.

    A stream records this while it is iterated, so the answer is only
    meaningful once the loop has drained it. A stream that ends with no chunk
    ever carrying a reason is a generation the server cut short, and nothing
    downstream would notice otherwise: the chunks of a cut answer and of a
    finished one look the same.

    Fails open: a stream without the attribute (``None``, or a stub) returns
    ``True``, so detection never raises a false alarm on a complete answer.
    """
    return bool(getattr(response_generator, "saw_finish_reason", True))


def close_llm_stream(response_generator: Any) -> None:
    """Close a streamed response so the server aborts generation.

    Best-effort: the socket teardown must never raise out of a cancel path, and
    a stream without a ``close()`` has nothing to close.
    """
    if response_generator is None:
        return
    close = getattr(response_generator, "close", None)
    if not callable(close):
        return
    try:
        close()
    except Exception:  # noqa: BLE001 — closing on cancel is best-effort
        pass
