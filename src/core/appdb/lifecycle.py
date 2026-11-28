"""The boot's lifecycle: bringing the store up, and keeping what it answered.

:func:`boot` is the one call that opens the file, lets the gate decide it, seeds
it and reports the result; :func:`store_state` is the answer kept for everyone
who asks after that boot. Every shared name is read off the façade at call time,
so a patch of ``appdb.PROJECT_ROOT`` moves what the boot opens.
"""

import copy
import sqlite3
from typing import Any, Dict, Optional

import src.core.appdb as appdb

from .errors import AppStoreError
from .fixture import TestFixtureError

#: What the last :func:`boot` learned, and the starting answer before one has
#: run: this process has not opened the store, which is a state to name rather
#: than an empty store to read. It is the install's fact rather than a
#: workspace's, so a working-location switch never touches it.
#:
#: Replaced **wholesale** by :func:`boot`, never mutated in place.
_store_state: Dict[str, Any] = {
    "state": "unusable",
    "path": "",
    "sentence": "nojae's settings store has not been opened by this process yet.",
    "created": False,
    "upgradedFrom": None,
    "version": None,
    "agents": {"inserted": 0, "reasserted": 0},
    "promptHelpers": 0,
    "testFixture": None,
}


def boot() -> Dict[str, Any]:
    """Open (or create) the store, bring it to the current level, seed it.

    This is the boot's **one** call: :func:`prepare` already refuses a file it
    does not understand, so seeding can never run against a schema this app has
    not read.

    ``{"state": "ok" | "unusable", "path": str, "sentence": Optional[str],
    "created": bool, "upgradedFrom": Optional[int], "version": Optional[int],
    "agents": {...}, "promptHelpers": int}``.

    **It never raises** — a seed that cannot happen is a note, never a boot
    failure, and the store has the most to lose from breaking that: an
    unopenable, unwritable or too-new database must leave the app serving with
    the store reported as a **named state**. ``sentence`` is that state, the one
    sentence naming the path, which the chat refusal and the app bar both show.

    The unusable branch answers the same keys, with nothing written: ``created``
    false, ``version`` ``None``, and no rows claimed. That is the difference
    between reporting an unopenable database and treating it as an empty one —
    the silent default this app refuses everywhere else.

    The answer is also **kept** (:func:`store_state`), because the boot is not
    the only thing that needs to know: a store that was unusable at boot is
    still unusable on the request that asks.

    In **test mode** the same transaction also materialises the e2e suite's own
    connection fixture into rows (:func:`materialise_test_fixture`), and
    ``testFixture`` carries the two ids it assigned — ``None`` in production,
    where there is no fixture to read.
    """
    global _store_state
    target = appdb.database_path()
    # A first boot killed between the exclusive create and the schema leaves a
    # zero-byte file behind. It is "existing" to `prepare`, but it is a pristine
    # store, not one the user emptied: the helper rows belong in it exactly as
    # they do in a file this boot creates.
    was_empty_file = False
    try:
        was_empty_file = target.is_file() and target.stat().st_size == 0
    except OSError:
        was_empty_file = False
    try:
        prepared = appdb.prepare()
    except AppStoreError as exc:
        _store_state = {
            "state": "unusable",
            "path": appdb._describe(target),
            "sentence": str(exc),
            "created": False,
            "upgradedFrom": None,
            "version": None,
            "agents": {"inserted": 0, "reasserted": 0},
            "promptHelpers": 0,
        }
        return _store_state

    conn: Optional[sqlite3.Connection] = None
    fixture: Optional[Dict[str, int]] = None
    try:
        conn = appdb.connect()
        conn.execute("BEGIN IMMEDIATE")
        seeded = appdb._seed(conn, bool(prepared["created"] or was_empty_file))
        # The suite's own connection fixture becomes one server row and one model
        # row of the temporary store, inside the seed's transaction.
        fixture = appdb.materialise_test_fixture(conn) if appdb.test_mode() else None
        conn.execute("COMMIT")
    except TestFixtureError as exc:
        # A broken fixture is the suite's own breakage, so it gets a sentence
        # naming the file — "could not be seeded" would point at the store. It is
        # still the unusable state: the suite refuses rather than fall through to
        # this machine's configured connection.
        if conn is not None:
            appdb._rollback(conn)
        _store_state = {
            "state": "unusable",
            "path": appdb._describe(target),
            "sentence": str(exc),
            "created": prepared["created"],
            "upgradedFrom": prepared["upgraded_from"],
            "version": prepared["version"],
            "agents": {"inserted": 0, "reasserted": 0},
            "promptHelpers": 0,
            "testFixture": None,
        }
        return _store_state
    except Exception as exc:  # noqa: BLE001 — the seed never takes the boot down
        # Deliberately broad, and broader than the driver's errors: the seed
        # imports another module's definitions, so a failure there is this step's
        # too, and the contract is that *nothing* reaches the lifespan. The
        # sentence says the seed did not land, which is the truth whatever raised
        # it — and the next boot runs the same idempotent pass, so the store is
        # noted as missing its built-ins rather than the app being dead.
        if conn is not None:
            appdb._rollback(conn)
        _store_state = {
            "state": "unusable",
            "path": appdb._describe(target),
            "sentence": (
                f"nojae's settings store at {appdb._describe(target)} could not be "
                f"seeded ({exc})."
            ),
            "created": prepared["created"],
            "upgradedFrom": prepared["upgraded_from"],
            "version": prepared["version"],
            "agents": {"inserted": 0, "reasserted": 0},
            "promptHelpers": 0,
            "testFixture": None,
        }
        return _store_state
    finally:
        if conn is not None:
            conn.close()

    _store_state = {
        "state": "ok",
        "path": prepared["path"],
        "sentence": None,
        "created": prepared["created"],
        "upgradedFrom": prepared["upgraded_from"],
        "version": prepared["version"],
        "testFixture": fixture,
        **seeded,
    }
    return _store_state


def store_state() -> Dict[str, Any]:
    """The store's state as the last boot answered it — a copy, never the record.

    ``sentence`` is the one sentence naming the path when the state is
    ``"unusable"``, and ``None`` when it is ``"ok"``, so no caller re-derives the
    rule from a ``try``/``except`` of its own.

    Deep-copied, because the answer nests: a shallow one would hand a caller the
    record's own ``agents`` dict, and a route that annotated its copy would be
    editing what every later reader answers from.
    """
    return copy.deepcopy(_store_state)
