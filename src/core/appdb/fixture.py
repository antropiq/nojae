"""The e2e suite's flat connection fixture, read and turned into rows.

The file's own strictness lives here: a closed vocabulary, a named failure for
every unknown or missing member or wrong JSON type, and the two inserts that
materialise it. ``PROJECT_ROOT`` and ``TEST_SETTINGS_DIR`` are read off the façade
at call time, so a patch of either moves where the lookup goes.
"""

import sqlite3
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Tuple

import src.core.appdb as appdb

# -- the e2e suite's flat fixture, materialised into rows ------------------------
#
# With the test switch on, the app never opens the install's own ``nojae.db``:
# :func:`database_path` answers a temporary root's file, and this section turns
# the suite's hand-authored flat connection fixture into **rows** of it — one
# server, one model, and every agent row pointing at that model, which is what
# lets a task turn run at all: an agent with no model refuses.
#
# Why materialise rather than special-case the resolution seam: "the agent has a
# model" is the only way a turn can run, so a test-mode branch in the seam — "in
# test mode, use the file's connection whatever the row says" — would mean the
# suite exercises a resolution path production never takes, which is the worst
# property a settings layer can have. Materialising keeps **one** seam, and a
# test that wants an agent with no model clears that row's ``model_id`` itself —
# the only way such a state is reachable here.

#: The e2e suite's own connection file: ``nojae-test-settings.json`` in the
#: frontend's tests folder (:data:`TEST_SETTINGS_DIR` below the install root).
#: Hand-authored, never seeded, never written by the app — and its member names
#: are the **column names**, because it is a store fixture rather than a UI
#: payload.
TEST_SETTINGS_FILENAME = "nojae-test-settings.json"

#: The folder that file lives in, relative to the installation: the e2e specs'
#: own folder, beside the Playwright config that boots the server reading it. Not
#: the reserved ``.nojae`` folder — that one holds **a workspace's** policy, and
#: this fixture is the installation's.
TEST_SETTINGS_DIR = ("web", "tests")

#: The members the fixture may carry, each with the JSON type it must hold. Same
#: strictness as the tables: an unknown key or a wrong type is a **named
#: failure**, never a silently-defaulted sampler — a green suite that measured a
#: default is worse than a red one. The names are the schema's, so one vocabulary
#: describes a connection everywhere.
TEST_SERVER_KEYS: Dict[str, type] = {"name": str, "url": str, "api_key": str}
TEST_MODEL_KEYS: Dict[str, type] = {
    "name": str,
    "sys_prompt": str,
    "temperature": float,
    "top_p": float,
    "top_k": int,
    "min_p": float,
    "repeat_penalty": float,
    "presence_penalty": float,
    "reasoning": str,
    "supports_vision": bool,
}

#: The one type word per approved type, for the sentences that name one.
TEST_TYPE_WORDS: Dict[type, str] = {
    str: "a string",
    bool: "a boolean",
    float: "a number",
    int: "an integer",
}


class TestFixtureError(Exception):
    """The e2e suite's connection fixture is missing or unusable.

    Raised out of :func:`materialise_test_fixture`, and the boot turns it into
    the store's **unusable** state: a suite without its own fixture must refuse
    rather than fall through to the developer's configured servers and key.
    """


def test_settings_path() -> Path:
    """Where the suite's connection fixture lives: ``<install>/web/tests/nojae-test-settings.json``.

    The **installation**, not a workspace: no tab's folder — and no developer's
    working location — decides where it is found. A *file* rather than a row
    because the store must be able to start before it has any rows; a
    **function** so a test can point the lookup elsewhere without rewriting the
    module.
    """
    return appdb.PROJECT_ROOT.joinpath(
        *appdb.TEST_SETTINGS_DIR, appdb.TEST_SETTINGS_FILENAME
    )


def _describe_value(value: Any) -> str:
    """What to call a JSON value in a sentence — the JSON word, not the Python one."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "a boolean"
    if isinstance(value, (int, float)):
        return "a number"
    if isinstance(value, str):
        return "a string"
    if isinstance(value, list):
        return "a list"
    if isinstance(value, dict):
        return "an object"
    return type(value).__name__  # pragma: no cover - json never produces this


def _checked_block(
    value: Any,
    path: Path,
    where: str,
    table: Mapping[str, type],
    extra: Tuple[str, ...] = (),
) -> Optional[Dict[str, Any]]:
    """One nested object of the fixture, or ``None`` when it is absent.

    Only one level nests: the server carries ``model`` beside its own three
    columns, and any other name at that level is an unknown member — the same
    closed vocabulary the tables have.
    """
    if value is None:
        return None
    if not isinstance(value, dict):
        raise TestFixtureError(
            f"the e2e test settings file {path} holds {where} as "
            f"{_describe_value(value)}, expected an object"
        )
    allowed = set(table) | set(extra)
    unknown = sorted(name for name in value if name not in allowed)
    if unknown:
        listed = ", ".join(f'"{name}"' for name in unknown)
        understood = ", ".join(f'"{name}"' for name in sorted(allowed))
        raise TestFixtureError(
            f"the e2e test settings file {path} has an unknown member {where}.{listed}; "
            f"it understands {understood}"
        )
    return value


def _check_types(
    block: Mapping[str, Any], table: Mapping[str, type], path: Path, where: str
) -> None:
    """Refuse a member whose JSON type is not the one the column declares.

    Strict on purpose, exactly as the tables are: ``null`` is not a value a
    sampler may hold, and ``1`` is not what the user means where a boolean
    belongs. ``float`` here means "a JSON number", so it accepts ``2`` as well as
    ``2.0``; ``int`` means a JSON integer and rejects ``true``, which Python reads
    as an ``int``.
    """
    # ``where`` names the block in the file's own spelling; the member is joined
    # to it as a path, so the sentence reads ``server.model.temperature``.
    prefix = where.strip('"')
    for name, expected in table.items():
        if name not in block:
            raise TestFixtureError(
                f"the e2e test settings file {path} has no {prefix}.{name}; "
                "every column the tables declare is required"
            )
        value = block[name]
        if expected is bool:
            ok = isinstance(value, bool)
        elif expected is int:
            ok = isinstance(value, int) and not isinstance(value, bool)
        elif expected is float:
            ok = isinstance(value, (int, float)) and not isinstance(value, bool)
        else:
            ok = isinstance(value, str)
        if not ok:
            wanted = TEST_TYPE_WORDS.get(expected, str(expected))
            raise TestFixtureError(
                f"the e2e test settings file {path} holds {prefix}.{name} as "
                f"{_describe_value(value)}, expected {wanted}"
            )


def _read_test_fixture(path: Path) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    """``(server, model)`` from the fixture, or :class:`TestFixtureError` naming it."""
    import json

    try:
        raw = path.read_text(encoding="utf-8")
    except OSError as exc:
        raise TestFixtureError(
            f"the e2e test settings file {path} cannot be read "
            f"({exc.strerror or exc}); the suite has no model connection without it"
        ) from exc
    try:
        document = json.loads(raw)
    except (UnicodeDecodeError, ValueError) as exc:
        raise TestFixtureError(
            f"the e2e test settings file {path} is not valid JSON ({exc})"
        ) from exc
    if not isinstance(document, dict):
        raise TestFixtureError(
            f"the e2e test settings file {path} holds "
            f"{_describe_value(document)}, expected an object with a \"server\" member"
        )
    unknown = sorted(name for name in document if name != "server")
    if unknown:
        listed = ", ".join(f'"{name}"' for name in unknown)
        raise TestFixtureError(
            f"the e2e test settings file {path} has an unknown member {listed}; "
            'it understands "server" alone'
        )
    if document.get("server") is None:
        raise TestFixtureError(
            f'the e2e test settings file {path} has no "server" member; the suite '
            "has no model connection without it"
        )
    server = _checked_block(
        document["server"], path, '"server"', TEST_SERVER_KEYS, extra=("model",)
    )
    assert server is not None  # the None case is answered above
    if server.get("model") is None:
        raise TestFixtureError(
            f'the e2e test settings file {path} has no "server.model" member; the '
            "suite has no model connection without it"
        )
    model = _checked_block(server["model"], path, '"server.model"', TEST_MODEL_KEYS)
    assert model is not None
    _check_types(server, TEST_SERVER_KEYS, path, '"server"')
    _check_types(model, TEST_MODEL_KEYS, path, '"server.model"')
    return server, model


def materialise_test_fixture(conn: sqlite3.Connection) -> Dict[str, int]:
    """Insert the fixture's server and model as rows and point every agent at it.

    The temporary database exists and the built-ins are seeded before this runs;
    what this adds is **one** server row with **one** model row — the file never
    carries an id, because the harness assigns both.

    **Every** agent row's ``model_id`` is set to that model because "an agent has
    a model" is the only way a turn can run, so a suite whose agents were left
    null would exercise only the refusal. Doing it in the row keeps the
    resolution seam free of a test-mode branch; a test that wants an unrunnable
    agent clears that row's ``model_id`` itself.

    It runs inside the boot's own transaction, so a fixture that fails half way
    leaves the store as it was found rather than holding a server with no model.

    Raises :class:`TestFixtureError` when the file is missing or malformed; the
    boot turns that into the store's unusable state, which makes the suite refuse
    instead of falling through to a developer's connection.
    """
    path = test_settings_path()
    server, model = _read_test_fixture(path)
    cursor = conn.execute(
        "INSERT INTO servers (name, url, api_key) VALUES (?, ?, ?)",
        (server["name"], server["url"], server["api_key"]),
    )
    server_id = int(cursor.lastrowid or 0)
    cursor = conn.execute(
        "INSERT INTO models (server_id, name, sys_prompt, temperature, top_p,"
        " top_k, min_p, repeat_penalty, presence_penalty, reasoning,"
        " supports_vision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            server_id,
            model["name"],
            model["sys_prompt"],
            model["temperature"],
            model["top_p"],
            model["top_k"],
            model["min_p"],
            model["repeat_penalty"],
            model["presence_penalty"],
            model["reasoning"],
            1 if model["supports_vision"] else 0,
        ),
    )
    model_id = int(cursor.lastrowid or 0)
    # The fixture's model is the one every agent runs on. One statement, so no
    # row can be left pointing at nothing.
    conn.execute("UPDATE agents SET model_id = ?", (model_id,))
    return {"serverId": server_id, "modelId": model_id}
