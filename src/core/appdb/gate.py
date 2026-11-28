"""The schema version gate: whether this app may read the store file at all.

This file owns the three branches — create, migrate, refuse — and the recorded
level they move. Every shared name is read off the façade at call time, so a
patch of ``appdb.SCHEMA_VERSION`` or ``appdb.UPGRADES`` is what the gate sees.
"""

import os
import sqlite3
from pathlib import Path
from typing import Any, Dict

import src.core.appdb as appdb

from .errors import AppStoreError

# -- the version gate ----------------------------------------------------------

def _user_version(conn: sqlite3.Connection, target: Path) -> int:
    """The schema level recorded in the file, or the store-level error.

    A file that is not a database answers here rather than at the first query:
    SQLite opens it happily and raises ``file is not a database`` on the first
    statement, and this is the first statement. Naming the path is what makes the
    difference between the two states (a lock, a foreign file, a truncated store)
    visible to whoever reads the app bar.
    """
    try:
        row = conn.execute("PRAGMA user_version").fetchone()
    except sqlite3.Error as exc:
        raise AppStoreError(
            f"nojae's settings store at {appdb._describe(target)} is not a usable "
            f"database ({exc})."
        ) from exc
    return int(row[0]) if row else 0


def prepare() -> Dict[str, Any]:
    """Bring the store to :data:`SCHEMA_VERSION`, or refuse. The boot's one call.

    ``{"created": bool, "upgraded_from": Optional[int], "version": int,
    "path": str}`` — the facts the boot logs and the seeder needs. ``created``
    is the one-shot gate for the prompt-helper rows, so it answers "this boot
    made the file", not "this boot wrote a schema into it"; ``upgraded_from`` is
    the level a file that was already there arrived at, or ``None`` when it did
    not need moving.

    The three branches, in order:

    * **no file** — create it, then lay the schema down at the current level.
    * **an older level** — migrate it, in one transaction.
    * **a newer level** — refuse, and touch nothing. This is the branch that
      matters: reading a schema this app does not know with the rules it does
      know is how a settings store quietly loses rows, so the answer is the
      sentence naming the path and the level found.

    A file already at the current level is left alone entirely: no statement
    runs, so the boot that changes nothing is checked by the bytes rather than
    by an argument.

    Raises :class:`AppStoreError` for the refusal and for every unusable file.
    """
    target = appdb.database_path()
    created = not target.exists() and _exclusive_create(target)

    conn = appdb.connect()
    try:
        found = _user_version(conn, target)
        if found > appdb.SCHEMA_VERSION:
            raise AppStoreError(
                f"nojae's settings store at {appdb._describe(target)} was written by a "
                f"newer version of nojae (schema level {found}, this app knows "
                f"{appdb.SCHEMA_VERSION}); nothing was read or changed."
            )
        if found < appdb.SCHEMA_VERSION:
            _migrate(conn, found, target)
        return {
            "created": created,
            # Only a file that was already there can be *upgraded*: for a new
            # one, ``created`` is the whole story and a level of 0 in the log
            # would describe a migration nobody's data went through.
            "upgraded_from": None
            if created or found == appdb.SCHEMA_VERSION
            else found,
            "version": appdb.SCHEMA_VERSION,
            "path": appdb._describe(target),
        }
    finally:
        conn.close()


def _exclusive_create(target: Path) -> bool:
    """Make the empty file, and answer whether **this** call made it.

    ``O_CREAT | O_EXCL`` is the same exclusive primitive every seed in this app
    uses: two boots racing would otherwise both answer ``created: True``, and the
    loser would seed the prompt-helper rows a second time. So the loser's
    ``FileExistsError`` is not a failure: it is the answer "someone else made it",
    and the boot continues against the file that won.

    Exclusive rather than letting SQLite create it, so a file that cannot be made
    (a directory holding that name, a read-only install root) is answered by the
    operating system's own sentence instead of by SQLite inventing a partial file.
    """
    try:
        handle = os.open(
            str(target),
            os.O_CREAT | os.O_EXCL | os.O_WRONLY | getattr(os, "O_BINARY", 0),
            0o600,
        )
    except FileExistsError:
        return False
    except OSError as exc:
        raise AppStoreError(
            f"nojae's settings store at {appdb._describe(target)} cannot be created "
            f"({exc.strerror or exc})."
        ) from exc
    os.close(handle)
    return True


def _migrate(conn: sqlite3.Connection, found: int, target: Path) -> None:
    """Take the file from ``found`` to :data:`SCHEMA_VERSION`, or change nothing.

    **One transaction**, so an upgrade is all or nothing: the recorded level and
    the schema it describes move together, and a step that fails leaves the file
    exactly as it was rather than half-migrated with a level that claims
    otherwise. A half-migrated store is the expensive state — the next boot
    cannot tell which steps still need to run.

    A level with no recorded step is refused rather than skipped: guessing which
    columns a level this app has never seen added is the same mistake the gate
    refuses on the other side of the current version.
    """
    try:
        conn.execute("BEGIN IMMEDIATE")
    except sqlite3.Error as exc:
        raise AppStoreError(
            f"nojae's settings store at {appdb._describe(target)} could not be opened "
            f"for writing ({exc})."
        ) from exc
    try:
        level = found
        while level < appdb.SCHEMA_VERSION:
            steps = appdb.UPGRADES.get(level)
            if steps is None:
                raise AppStoreError(
                    f"nojae's settings store at {appdb._describe(target)} is at schema "
                    f"level {level}, which this app has no upgrade path for (it "
                    f"knows {appdb.SCHEMA_VERSION}); nothing was changed."
                )
            for statement in steps:
                conn.execute(statement)
            level += 1
        _ensure_schema(conn)
        _set_user_version(conn, appdb.SCHEMA_VERSION)
        conn.execute("COMMIT")
    except sqlite3.Error as exc:
        _rollback(conn)
        raise AppStoreError(
            f"nojae's settings store at {appdb._describe(target)} could not be brought "
            f"from schema level {found} to {appdb.SCHEMA_VERSION} ({exc})."
        ) from exc
    except AppStoreError:
        _rollback(conn)
        raise


def _rollback(conn: sqlite3.Connection) -> None:
    """Undo the open transaction, if there is one — and never mask the reason.

    The failure that got us here is the thing the boot has to report, so a
    rollback that itself fails (there is nothing to undo) is swallowed rather
    than allowed to replace it.
    """
    try:
        conn.execute("ROLLBACK")
    except sqlite3.Error:
        pass


def _ensure_schema(conn: sqlite3.Connection) -> None:
    """Create whatever of the current schema the file does not have yet.

    ``IF NOT EXISTS`` is not laziness: it is what lets one statement list serve
    both the empty file and the tail of an upgrade, where an older level may
    already hold three of the four tables.
    """
    for statement in appdb.SCHEMA_STATEMENTS:
        conn.execute(_create_if_not_exists(statement))


def _create_if_not_exists(statement: str) -> str:
    """``CREATE TABLE x`` -> ``CREATE TABLE IF NOT EXISTS x``, nothing else changed.

    Rewritten rather than written twice so :data:`SCHEMA_STATEMENTS` stays the
    one copy of the schema — two copies is how they stop agreeing.
    """
    head, _, rest = statement.partition("CREATE TABLE")
    tail = rest.partition("(")
    return f"{head}CREATE TABLE IF NOT EXISTS{tail[0]}{tail[1]}{tail[2]}"


def _set_user_version(conn: sqlite3.Connection, level: int) -> None:
    """Record the schema level. An integer is interpolated, never a parameter:
    SQLite takes no placeholder in a ``PRAGMA``."""
    conn.execute("PRAGMA user_version = %d" % int(level))


def version_of() -> int:
    """The store's schema level, read without changing anything.

    Part of the gate, not an accessor: it is the gate's own question, asked of a
    file this call must not touch. Read-only mode is what makes that provable —
    refusing is the only answer a too-new file gets. Raises
    :class:`AppStoreError` naming the path when the file cannot be opened or is
    not a database.
    """
    target = appdb.database_path()
    try:
        conn = sqlite3.connect(appdb._uri(target, mode="ro"), uri=True)
    except sqlite3.Error as exc:
        raise AppStoreError(
            f"nojae's settings store at {appdb._describe(target)} cannot be opened "
            f"({exc})."
        ) from exc
    try:
        return _user_version(conn, target)
    finally:
        conn.close()
