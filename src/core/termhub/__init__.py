"""Terminal surface of the Editor tab: one PTY per WebSocket connection.

Core-only (no FastAPI), a sibling of ``mcphub/``, ``lsphub/`` and ``editorfs/``
with the same one-concern-per-file layout:

* :mod:`termhub.constants` the session cap, the grace period, PTY framing sizes
* :mod:`termhub.session` ``TerminalSession`` — the pty, the shell, the pump, the
  tree teardown
* :mod:`termhub.pty_posix` the POSIX driver behind the session's seam, and its
  ``EIO`` translation
* :mod:`termhub.pty_conpty` the Windows pseudo-console behind the same seam: the
  console is created with its size, the pair starts the shell itself, and the
  pipe's EOF answers the same "far end gone" question
* :mod:`termhub.drivers` which driver this app can run right now (a capability
  answer, never ``os.name``), and the shape a driver's surface must have
* :mod:`termhub.shells` which shell the pane runs and what the child's
  environment says — POSIX ``$SHELL``; on Windows ``TERMINAL_SHELL`` then Git
  Bash, and a refusal naming what was looked for
* :mod:`termhub.manager` ``TerminalHub``: the ``app.state.terminal`` registry,
  the cap decision, ``stop_all`` on shutdown

A session is a **human** surface, reached only by the SPA over
``WS /api/terminal``: it is never an MCP or LSP tool, and that boundary is what
keeps "tools are read-only by design" intact while a real shell exists in the
app. Its ``cwd`` is the workspace in scope when it was born, entered from the
socket's own ``workspace`` query field — the folder arrives as a named
**workspace** when the socket opens, never as a path, and a live session keeps
the folder it was born in, so the tree/editor path policy has nothing to guard
here.

Like the two hubs, a session is torn down as a **tree** (via
:func:`src.core.proctree.kill_session_tree`) on every exit path: on POSIX the
shell leads its own process group and the kill answers with the session; on
Windows the session opens one job at spawn holding the shell and the driver's
console helper, and the same call lands in the job half.
"""

from typing import TYPE_CHECKING, Any

from . import constants
from .manager import TerminalHub
from .session import SessionCapacity, TerminalSession, TerminalUnsupported

_MISSING = object()


def __getattr__(name: str) -> Any:  # PEP 562
    """Resolve a constant from :mod:`termhub.constants` at lookup time.

    The caps and sizes are module attributes precisely so a test can patch them,
    which means they must not be bound here: a copy would go stale under it.
    """
    value = getattr(constants, name, _MISSING)
    if value is not _MISSING:
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


if TYPE_CHECKING:  # pragma: no cover - typing only
    from .constants import (
        CLOSE_CODE_CAPACITY,
        CLOSE_CODE_POLICY,
        CLOSE_CODE_UNSUPPORTED,
        DRIVER_ABSENT_FORCED,
        DEFAULT_COLS,
        DEFAULT_ROWS,
        FALLBACK_SHELL,
        MAX_CLOSE_REASON_BYTES,
        MAX_SESSIONS,
        NO_DRIVER_MESSAGE,
        PTY_READ_BYTES,
        SHELL_KEY,
        STOP_GRACE_SECONDS,
        TERM_VALUE,
        TERMINAL_SHELL_KEY,
        close_reason,
    )

__all__ = [
    "SessionCapacity",
    "TerminalHub",
    "TerminalSession",
    "TerminalUnsupported",
    "close_reason",
]
