"""The write seam: one transaction per statement, and the copy before a delete.

Every write in the package goes through :func:`_write`, and every destructive
accessor takes its copy of the whole store through :func:`backup_before_delete`.
The shared names — the path, the handle, the rollback — are read off the façade
at call time, so a patch of ``appdb.PROJECT_ROOT`` moves what a write lands in.
"""

import sqlite3
from typing import Any, Optional, Tuple

import src.core.appdb as appdb

from .errors import AppStoreError

# -- the write side -------------------------------------------------------------
#
# The store's own writes, and the only code in the repo that spells an ``INSERT``,
# an ``UPDATE`` or a ``DELETE``. They are **accessors, not routes**: each answers
# the rows the browser should now render (the whole list, in the read's shape), so
# a route never re-reads what it just wrote, and each raises
# :class:`AppStoreError` naming the path rather than an HTTP status — the same
# core-owns-logic / API-owns-transport split the read side keeps.
#
# A write takes the **values**, already validated. Validation strictness belongs
# to the route that speaks to the browser (a colour that is not a hex triplet is
# refused there, in a message naming the field), because "a database column does
# not make a bad value less bad" is a rule about what reaches the user, not about
# who last touched the row.

#: The one helper every destructive route calls first: "a save backs up what it
#: replaces", and for a table that means a copy of the whole file before a
#: ``DELETE``. Lives here rather than in each route so one rule covers every
#: destructive write of the store — helper, server, model and agent deletes
#: alike.
#:
#: It reuses the Editor's own backup helper and therefore its folder, its digest
#: naming and its retention sweep: two backup trees for one app is how one of
#: them stops being looked at. The path it copies is :func:`database_path`, which
#: the caller cannot name — the derived-path rule holds on the write side too.
#:
#: Only the main file is copied, and that is only honest because the copy is
#: taken **after** a checkpoint: under WAL the newest commits sit in ``-wal``, so
#: a bare copy of the main file would be the store as of its last checkpoint
#: rather than as of now. See :func:`_checkpoint`.
def backup_before_delete() -> Optional[str]:
    """Copy the whole store into the app's dated backup folder. Never raises.

    Answers the copy's path, or ``None`` when there was nothing to copy or the
    copy could not be made. ``None`` is not a failure the caller acts on: the
    rule is that a destructive write **keeps** a copy, and a store that cannot
    be copied (a read-only install root) is the named state the next read
    reports — refusing the delete the user asked for would be a second authority
    on a disk problem the app already names.
    """
    # Imported here rather than at the top: this module's import graph is
    # ``src.config`` and nothing else, and the Editor's write surface is a
    # *tool* of the app rather than a layer under it. The module is already
    # loaded by the time a route reaches a delete, so it costs nothing.
    from src.core.editorfs import files as editorfs_files

    target = appdb.database_path()
    _checkpoint()
    try:
        copied = editorfs_files.backup_for_write(target)
    except OSError:
        return None
    return None if copied is None else str(copied)


def _checkpoint() -> None:
    """Fold ``-wal`` back into the main file, so a copy of it is a real snapshot.

    Private, and the module's only caller of :func:`connection` outside the read
    and write seams. Its failure is deliberately **not** reported: a checkpoint
    that cannot take the lock leaves the store as it was, and a slightly older
    snapshot is worth more than none, because the delete still lands.
    """
    try:
        appdb.connection().execute("PRAGMA wal_checkpoint(TRUNCATE)")
    except (sqlite3.Error, AppStoreError):
        # Including "there is no store to checkpoint": the copy answers ``None``
        # for that too, and the caller's next read is what reports it.
        pass


def _write(sql: str, params: Tuple[Any, ...] = ()) -> int:
    """Run one write statement in a transaction of its own.

    The write side's twin of :func:`_read`: a driver error becomes
    :class:`AppStoreError` naming the path, so a route catches **one** type for
    the store however the statement failed, and no raw ``sqlite3`` error escapes
    into a 500.

    ``BEGIN IMMEDIATE`` rather than a bare statement: autocommit at the handle
    level means SQLite would otherwise open a deferred transaction, which takes
    the write lock only when it reaches the write — so two tabs saving at once
    could both read, both decide to write, and the loser would fail on the
    statement instead of waiting out the busy timeout.

    Answers the statement's ``rowcount``, which is how a caller tells "updated"
    from "there was no such row" without a second query.
    """
    conn = appdb.connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        cursor = conn.execute(sql, params)
        changed = cursor.rowcount
        conn.execute("COMMIT")
    except sqlite3.Error as exc:
        appdb._rollback(conn)
        raise AppStoreError(
            f"nojae's settings store at {appdb._describe(appdb.database_path())} "
            f"could not be written ({exc})."
        ) from exc
    return changed
