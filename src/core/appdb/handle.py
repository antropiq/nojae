"""Opening the store: the read-write handle, its per-connection settings, its URI.

One connection per thread, keyed on the path it was opened at, so a moved
``PROJECT_ROOT`` cannot leave a thread answering from the file it used to be.
"""

import sqlite3
import threading
from pathlib import Path
from typing import Optional, Tuple

import src.core.appdb as appdb

# -- opening -------------------------------------------------------------------


def connect() -> sqlite3.Connection:
    """Open the store, read-write, ready to use: WAL on, foreign keys on, busy timeout set.

    Takes no path, and neither does any other public function here: a parameter
    that "only tests use" is the seam that lets a caller read a store the install
    does not own. A test moves the whole store by patching :data:`PROJECT_ROOT`.

    Raises :class:`AppStoreError` naming the path when the file cannot be opened.
    The file is **not created** here: ``uri`` mode ``rw`` fails on an absent path,
    which keeps "the store did not exist" a fact the boot can act on rather than
    something a stray read leaves behind as an empty file.
    """
    target = appdb.database_path()
    try:
        conn = sqlite3.connect(
            _uri(target, mode="rw"),
            uri=True,
            timeout=appdb.BUSY_TIMEOUT_MS / 1000.0,
            isolation_level=None,
        )
    except sqlite3.Error as exc:
        raise appdb.AppStoreError(
            f"nojae's settings store at {appdb._describe(target)} cannot be opened "
            f"({exc})."
        ) from exc
    try:
        _configure(conn)
    except sqlite3.Error as exc:
        conn.close()
        raise appdb.AppStoreError(
            f"nojae's settings store at {appdb._describe(target)} cannot be used "
            f"({exc})."
        ) from exc
    return conn


def _configure(conn: sqlite3.Connection) -> None:
    """The per-connection settings every handle in this app carries.

    ``journal_mode`` is a property of the *file*, so setting it here makes a file
    this app created a WAL file for every later connection. It is checked rather
    than fired and forgotten: WAL is why a reader and a writer coexist, so a file
    system that would not take it (a network share) must not be run on quietly
    with the rollback rules that produce ``database is locked``.

    ``foreign_keys`` is the opposite: per-connection and off by default. A handle
    that forgot would let an orphan model through — a state the app itself cannot
    produce.
    """
    mode = conn.execute("PRAGMA journal_mode = WAL").fetchone()
    if not mode or str(mode[0]).lower() != "wal":
        answered = mode[0] if mode else None
        raise sqlite3.DatabaseError(
            f"write-ahead logging is unavailable (journal mode answered {answered!r})"
        )
    conn.execute("PRAGMA foreign_keys = ON")


def _uri(target: Path, mode: str) -> str:
    """The ``file:`` URI SQLite opens ``target`` at, with the requested ``mode``.

    The URI is the authority here, not the path text: a ``?`` or a ``#`` in a
    folder name would otherwise become a query or a fragment and open something
    else. So the path goes to :meth:`Path.as_uri`, which knows how this platform
    spells an absolute path as a URI. The ``mode`` — ``rw`` so an open never
    creates, ``ro`` so a read never touches — is appended after the encoded path.

    A relative path has no URI form, and that is answered as the same named state
    as any other unusable path rather than as a ``ValueError`` escaping the
    module.
    """
    try:
        uri = target.as_uri()
    except ValueError as exc:
        raise appdb.AppStoreError(
            f"nojae's settings store at {appdb._describe(target)} cannot be opened "
            f"({exc})."
        ) from exc
    return f"{uri}?mode={mode}"


# -- the per-thread handle -----------------------------------------------------

_thread_state = threading.local()


def connection() -> sqlite3.Connection:
    """This thread's handle on the store, opened on first use and kept.

    One connection per worker thread: a ``sqlite3`` handle is not shareable, and
    the app's shape is a request thread plus a chat worker reading the
    configuration while the request thread may be saving it — which is what WAL
    is for. A thread that never touches the store never opens a handle.

    The handle is keyed on the path it was opened at, so a moved
    :data:`PROJECT_ROOT` — which is how a test moves the whole store — cannot
    leave a thread answering from the file it used to be.

    Raises :class:`AppStoreError` when the store cannot be opened; the read and
    write seams turn that into the refusal sentence.
    """
    target = appdb.database_path()
    cached: Optional[Tuple[str, sqlite3.Connection]] = getattr(
        _thread_state, "handle", None
    )
    if cached is not None and cached[0] == str(target):
        return cached[1]
    if cached is not None:
        close_thread_connection()
    conn = appdb.connect()
    _thread_state.handle = (str(target), conn)
    return conn


def close_thread_connection() -> None:
    """Drop this thread's handle, if it has one.

    For the threads the app starts and finishes (a chat worker, a batch lot):
    a handle left open past its thread leaves a reader in the WAL's bookkeeping.
    """
    cached: Optional[Tuple[str, sqlite3.Connection]] = getattr(
        _thread_state, "handle", None
    )
    if cached is not None:
        try:
            cached[1].close()
        finally:
            _thread_state.handle = None
