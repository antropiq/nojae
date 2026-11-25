"""Reading the chunks of a streamed completion, and knowing when one was cut.

The WorkBench chat stream (:mod:`core.chat`) is the only caller and speaks no
HTTP of its own, so all it needs from here is how to read the chunk dicts
:mod:`core.llmkit` hands over, and what a stream that never carried a finish
reason means. Nothing here judges an answer's quality: the only judgement made
is whether a stream ended honestly.
"""

from typing import Any, Callable, Dict, Optional

Emit = Callable[[Dict[str, Any]], None]


# --- chunk reading ------------------------------------------------------------
#
# One read path, one protocol: a chunk is read as a mapping (``.get``), never as
# the SDK's attribute shape. A chunk of any shape then either yields its fields
# or reads as absent, so a read never raises out of the streaming loop.


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
    """Streamed reasoning text (thinking) from a chunk.

    Reasoning-capable servers emit it under ``reasoning_content`` or
    ``reasoning`` instead of ``content``; it is generated tokens too, so it must
    anchor the decode-window timing even though it is not answer text.
    """
    delta = _delta(chunk)
    return str(
        _field(delta, "reasoning_content") or _field(delta, "reasoning") or ""
    )


def _extract_usage(chunk: Any) -> Optional[Dict[str, Optional[int]]]:
    """The chunk's usage block as ``{prompt_tokens, completion_tokens,
    total_tokens}`` with ``None`` for missing or zero fields; ``None`` when the
    server sent no usage.
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


# The chat stream's truncation sentence, shown as the WorkBench error line, so it
# is deliberately free of provider jargon.
TRUNCATION_MESSAGE = (
    "The answer was cut short by the server before it finished "
    "(the stream ended without a finish reason). The reply above is "
    "incomplete — the task was not carried through."
)

# On the terminal event, so a client can style this failure differently and mark
# the *message*, not only show an error line the next send clears.
TRUNCATION_EVENT_FLAG = "truncated"


def saw_finish_reason(response_generator: Any) -> bool:
    """Whether the stream ended with a chunk that carried a finish reason.

    Recorded while the stream is iterated, so the answer is only meaningful once
    the loop has drained it. Nothing downstream would notice a server that cut a
    generation short: the chunks of a cut answer and of a finished one look the
    same. Fails open — a stream without the attribute returns ``True``, so a
    complete answer never raises a false alarm.
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
