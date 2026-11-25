"""nojae's own settings store: one SQLite file, and the only code that speaks SQL.

``<install root>/nojae.db`` is where the app keeps the model connections
(``servers`` + ``models``), the agent personas (``agents``) and the prompt
helpers (``prompt_helpers``). This module owns that file and **nothing else**:
the path, the connection lifecycle, the schema and its version gate. Every other
module asks this one for data — nobody else opens the file, nobody else writes
SQL, and no public function takes a path. :func:`boot` is the boot's one call —
bring the store to the current schema level, then seed it — and it answers a
state dict instead of raising, so an unusable store is a **named state** rather
than a dead app.

Why the connection looks the way it does:

* **WAL journaling** — the app is a request thread plus a chat worker thread, and
  the worker reads the configuration while the request thread may be saving it;
  rollback journaling serialises that into ``database is locked``.
* **A busy timeout** — the other half: two browser tabs saving at once, and the
  second writer waits rather than failing.
* **One connection per thread** — a ``sqlite3`` handle is not for sharing, so
  each thread that asks gets its own, and WAL is what makes that safe rather
  than lucky.
* **Read-write, never created by an open** — see :func:`connect`: it is
  :func:`prepare` that creates the file, because the boot that creates the store
  is the boot that seeds it.
* **Autocommit at the handle level** (``isolation_level=None``) — SQLite opens no
  transaction behind the caller's back, so a write is exactly the ``BEGIN`` the
  caller asked for.
* **No text-mode translation** — SQLite writes the bytes itself, so nothing here
  opens the file with a text encoding or a newline mode; ``\n`` becoming
  ``\r\n`` on Windows would corrupt it.

The version gate is the other reason this module exists on its own:
``PRAGMA user_version`` records the schema level, and boot either creates the
schema at the current level, upgrades an older one, or **refuses to touch** a
file whose level it does not understand. Silently reading a newer schema with
older rules is how a settings store quietly loses rows, so a too-new file is a
refusal naming the path and the level found — never a read, never a traceback.

An unusable store is a *named state* too, which is why the failure type here is
raised rather than swallowed: :class:`AppStoreError` carries the one sentence
that names the path, and the boot turns it into the app bar's notice and the
chat refusal instead of taking the app down.

Nothing here reaches the web layer or a workspace: the store is install-scoped,
so a working-location switch invalidates nothing in it.
"""

import copy
import importlib
import os
import sqlite3
import tempfile
import threading
from pathlib import Path
from typing import Any, Dict, List, Mapping, Optional, Tuple

from src.config import PROJECT_ROOT, env_flag

# -- the constants (module attributes, patchable) -------------------------------

#: The database file's name, at the install root. A module attribute so a test can
#: move the lookup — the repo's ``mcphub.constants`` convention.
DB_FILENAME = "nojae.db"

#: The env var that puts this process in **test mode**: with it truthy the app
#: never opens the install's own ``nojae.db``, creating a temporary store instead
#: and materialising the e2e suite's flat connection fixture into it as rows, so a
#: suite run cannot read — and must not write — the developer's configured
#: servers, agents and key. Read **per call**, so a test can flip it without
#: reloading this module.
TEST_SETTINGS_KEY = "NOJAE_TEST_SETTINGS"

#: The prefix of the throw-away install root test mode lives on. One directory
#: per process, made on first use and kept: the store's path has to answer the
#: same thing to every thread and every read for as long as the process runs,
#: which a fresh ``mkdtemp`` per call would not.
TEST_ROOT_PREFIX = "nojae-test-store-"

#: Where test mode's throw-away root is, once it has been made (:func:`test_root`).
_test_root: Optional[Path] = None
_test_root_lock = threading.Lock()

#: The WAL sidecars SQLite creates beside it. They hold committed bytes and the
#: write-ahead index, so they are part of the store: hidden from every file
#: surface and gitignored with the file itself.
WAL_SIDECAR_SUFFIXES: Tuple[str, ...] = ("-wal", "-shm")

#: The schema level this app understands. ``PRAGMA user_version`` holds it.
#:
#: Bump it **only** together with an entry in :data:`UPGRADES` below: a file at
#: a level with no step leading out of it is a file boot refuses to touch.
SCHEMA_VERSION = 1

#: How long a writer waits for the lock before giving up, in milliseconds. The
#: writer-writer case is two browser tabs saving; a settings save is
#: milliseconds of work, so this is generous rather than slow.
BUSY_TIMEOUT_MS = 5000

#: The schema, in creation order, at :data:`SCHEMA_VERSION`: four tables and no
#: key/value bag.
#:
#: What each constraint is for, because each one is a rule the UI relies on:
#:
#: * ``servers.name`` unique — the dialog lists servers by name; two "Local"
#:   entries are unresolvable to a human.
#: * ``models`` unique per ``(server_id, name)`` — a model is chosen from its
#:   server's own list; a duplicate under the same server is a mistake.
#: * ``models.server_id`` ``ON DELETE CASCADE`` — the models under a deleted
#:   server are meaningless, and an orphan row is one the dialog cannot render.
#: * ``agents.model_id`` ``ON DELETE SET NULL`` — deleting a model must not
#:   delete the persona; the agent becomes unrunnable until it is given another
#:   model, which is the narrower damage.
#: * ``agents.id`` is the slug, not a surrogate — a chat payload and every saved
#:   session file on disk carry that value today, so keeping it stable keeps
#:   them resolvable.
#: * ``agents.label`` unique — the dialog creates an agent *by label* and
#:   derives the id from it; a duplicate is refused, never silently renumbered.
#: * the six nullable samplers — an absent sampler is omitted from the request
#:   body, as "member absent means" works today. ``0`` and "not set" are
#:   different values, so these columns carry **no default**: a NOT NULL or a
#:   ``DEFAULT 0`` would collapse the two.
#: * ``prompt_helpers`` has no count constraint — the row count is the user's
#:   business.
SCHEMA_STATEMENTS: Tuple[str, ...] = (
    """
    CREATE TABLE servers (
      id       INTEGER PRIMARY KEY,
      name     TEXT NOT NULL UNIQUE,
      url      TEXT NOT NULL,
      api_key  TEXT NOT NULL DEFAULT ''
    )
    """,
    """
    CREATE TABLE models (
      id               INTEGER PRIMARY KEY,
      server_id        INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
      name             TEXT NOT NULL,
      sys_prompt       TEXT NOT NULL DEFAULT '',
      temperature      REAL,
      top_p            REAL,
      top_k            INTEGER,
      min_p            REAL,
      repeat_penalty   REAL,
      presence_penalty REAL,
      reasoning        TEXT,
      supports_vision  INTEGER NOT NULL DEFAULT 0,
      UNIQUE (server_id, name)
    )
    """,
    """
    CREATE TABLE agents (
      id                  TEXT PRIMARY KEY,
      label               TEXT NOT NULL UNIQUE,
      max_tool_iteration  INTEGER NOT NULL DEFAULT 25,
      mcp_enable          INTEGER NOT NULL DEFAULT 1,
      lsp_enable          INTEGER NOT NULL DEFAULT 0,
      system_message      TEXT NOT NULL DEFAULT '',
      readonly            INTEGER NOT NULL DEFAULT 0,
      model_id            INTEGER REFERENCES models(id) ON DELETE SET NULL
    )
    """,
    """
    CREATE TABLE prompt_helpers (
      id          INTEGER PRIMARY KEY,
      color_code  TEXT NOT NULL,
      content     TEXT NOT NULL DEFAULT ''
    )
    """,
)

#: How to reach :data:`SCHEMA_VERSION` from each older level: ``{level: steps}``,
#: the statements that turn a file at ``level`` into one at ``level + 1``, run in
#: order for every level between the one found and the current one. The whole
#: walk is one transaction (:func:`_migrate`), and the level is recorded once, at
#: the end.
#:
#: ``0`` is the empty file — the level SQLite gives a database that has no schema
#: at all, which is what a create leaves behind and what a boot killed before the
#: schema can leave too. Its steps are empty because there is nothing to convert:
#: :func:`_ensure_schema` creates what is missing and the level is raised.
#:
#: Every other level needs its own entry before :data:`SCHEMA_VERSION` may name
#: it, and a level with no entry is **refused**: an upgrade path invented under
#: time pressure is how rows are lost, so this app never guesses at a schema it
#: does not know.
UPGRADES: Dict[int, Tuple[str, ...]] = {0: ()}

#: The four tables, in schema order — the store's whole vocabulary. The tests
#: assert the file holds exactly these, and the accessors answer from them. A
#: fifth table would have to be added here.
TABLE_NAMES: Tuple[str, ...] = (
    "servers",
    "models",
    "agents",
    "prompt_helpers",
)


# -- the failure ---------------------------------------------------------------

class AppStoreError(Exception):
    """The settings store cannot be opened, read or used at this level.

    Carries the one sentence that names the path — the sentence the boot turns
    into the app bar's "the settings store is unusable" notice and the chat
    refusal.

    Raised rather than collected as a finding because every state it reports
    leaves the store with **no answer to give**: an unreadable file, a file that
    is not a database, a schema this app does not understand. A caller that
    caught nothing would run on an empty store, which is the silent default this
    app refuses everywhere else.
    """


# -- the path ------------------------------------------------------------------

def test_mode() -> bool:
    """Whether this process is the e2e suite's, and so must not touch the real store.

    One process-level switch, answered by ``config.env_flag`` — the same
    ``1/true/yes/on`` rule as ``NOJAE_DISABLE_MCP``. Read **per call**, never at
    import, so a test can flip it without reloading this module.

    It changes only *which file* is the store: with it on, :func:`database_path`
    answers a temporary root's ``nojae.db``, and the boot materialises the e2e
    suite's flat connection fixture into it as rows (:func:`materialise_test_fixture`).
    There is no fallback in either direction — with the switch on an absent or
    malformed fixture makes the suite **refuse to start** rather than reach the
    developer's configured servers and key.
    """
    return env_flag(TEST_SETTINGS_KEY)


def test_root() -> Path:
    """The throw-away install root test mode lives on, made on first use.

    One directory per process, kept for its lifetime: every path answer comes
    through :func:`database_path`, so a root that changed between two calls
    would leave one thread reading the store another thread just booted. A
    directory this process made is not removed — the temporary directory it sits
    in is the platform's to sweep.
    """
    global _test_root
    with _test_root_lock:
        if _test_root is None:
            _test_root = Path(tempfile.mkdtemp(prefix=TEST_ROOT_PREFIX))
        return _test_root


def _install_root() -> Path:
    """The root the store is built under: test mode's throw-away one, or the install's."""
    return test_root() if test_mode() else Path(PROJECT_ROOT)


def database_path() -> Path:
    """Where the store lives: ``<install root>/nojae.db`` (it may not exist yet).

    Built from :data:`PROJECT_ROOT` the way every other install-scoped path in
    this app is built (``editorfs.constants.BACKUP_DIR`` and the log folder are
    the others): one ``Path`` join, so it is correct on Linux and Windows with no
    platform branch, no separator spelled, no drive assumption and no ``~``
    expansion anywhere near it. It is the install's only configuration file — the
    ``.env`` beside it is gone, its keys are boot flags now.

    A **function**, not a constant, so a test can move the whole store by
    patching :data:`PROJECT_ROOT` — which is what keeps the suite off the
    developer's real file. Every path this module hands out (the connect seam,
    the sentences, the sidecars) comes through here, so one patch moves all of
    them at once.

    In **test mode** the root is :func:`test_root` instead: the install's own
    file is then not merely unlikely to be reached, it has no name here at all.
    """
    return _install_root() / DB_FILENAME


def sidecar_paths() -> Tuple[Path, ...]:
    """The WAL sidecars beside :func:`database_path`, in ``-wal``/``-shm`` order."""
    base = str(database_path())
    return tuple(Path(base + suffix) for suffix in WAL_SIDECAR_SUFFIXES)


def _describe(path: Path) -> str:
    """The path as a sentence spells it."""
    return str(path)


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
    target = database_path()
    try:
        conn = sqlite3.connect(
            _uri(target, mode="rw"),
            uri=True,
            timeout=BUSY_TIMEOUT_MS / 1000.0,
            isolation_level=None,
        )
    except sqlite3.Error as exc:
        raise AppStoreError(
            f"nojae's settings store at {_describe(target)} cannot be opened "
            f"({exc})."
        ) from exc
    try:
        _configure(conn)
    except sqlite3.Error as exc:
        conn.close()
        raise AppStoreError(
            f"nojae's settings store at {_describe(target)} cannot be used "
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
        raise AppStoreError(
            f"nojae's settings store at {_describe(target)} cannot be opened "
            f"({exc})."
        ) from exc
    return f"{uri}?mode={mode}"


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
            f"nojae's settings store at {_describe(target)} is not a usable "
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
    target = database_path()
    created = not target.exists() and _exclusive_create(target)

    conn = connect()
    try:
        found = _user_version(conn, target)
        if found > SCHEMA_VERSION:
            raise AppStoreError(
                f"nojae's settings store at {_describe(target)} was written by a "
                f"newer version of nojae (schema level {found}, this app knows "
                f"{SCHEMA_VERSION}); nothing was read or changed."
            )
        if found < SCHEMA_VERSION:
            _migrate(conn, found, target)
        return {
            "created": created,
            # Only a file that was already there can be *upgraded*: for a new
            # one, ``created`` is the whole story and a level of 0 in the log
            # would describe a migration nobody's data went through.
            "upgraded_from": None
            if created or found == SCHEMA_VERSION
            else found,
            "version": SCHEMA_VERSION,
            "path": _describe(target),
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
            f"nojae's settings store at {_describe(target)} cannot be created "
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
            f"nojae's settings store at {_describe(target)} could not be opened "
            f"for writing ({exc})."
        ) from exc
    try:
        level = found
        while level < SCHEMA_VERSION:
            steps = UPGRADES.get(level)
            if steps is None:
                raise AppStoreError(
                    f"nojae's settings store at {_describe(target)} is at schema "
                    f"level {level}, which this app has no upgrade path for (it "
                    f"knows {SCHEMA_VERSION}); nothing was changed."
                )
            for statement in steps:
                conn.execute(statement)
            level += 1
        _ensure_schema(conn)
        _set_user_version(conn, SCHEMA_VERSION)
        conn.execute("COMMIT")
    except sqlite3.Error as exc:
        _rollback(conn)
        raise AppStoreError(
            f"nojae's settings store at {_describe(target)} could not be brought "
            f"from schema level {found} to {SCHEMA_VERSION} ({exc})."
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
    for statement in SCHEMA_STATEMENTS:
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


# -- seeding -------------------------------------------------------------------

#: The tool-loop cap an **editable** built-in agent is seeded with: what the app
#: has always defaulted to, so a fresh install behaves exactly as it did. The
#: per-agent column carries the same default in its DDL; naming it here is what
#: lets the seeder say it rather than rely on the column list omitting it.
SEEDED_MAX_TOOL_ITERATION = 25

#: The cap the **app-owned** agent is seeded with. It is not the number above: a
#: lot-building turn writes a whole folder of task files through the file tools,
#: so the cap a chat agent is content with would stop it mid-lot. That row is
#: ``readonly``, so this is code's number rather than the user's — which is what
#: lets the boot re-assert it on every column but ``model_id``.
SEEDED_RESERVED_MAX_TOOL_ITERATION = 500

#: How many prompt-helper rows a **created** store starts with, and the colour
#: they start in: the nine empty gray bullets a first boot draws. Both are named
#: here rather than imported from :mod:`core.prompt_helpers`, which reads these
#: rows through this module — a store that imported its own reader is a cycle,
#: and the two values are the store's own starting layout, not a rendering
#: choice.
SEEDED_PROMPT_HELPER_COUNT = 9
SEEDED_PROMPT_HELPER_COLOR = "#808080"

#: Where the built-in agents' words live. Resolved **by name, per call**, for the
#: reason :mod:`core.agent_modes` gives for the same choice: that module's
#: content is validated by code that reads these rows, so a static import in
#: either direction is a cycle. The personas, labels, hub flags and the generated
#: lot-conventions block all stay there — the seeder *reads* them, it does not
#: copy them, which is what keeps one definition of a persona.
AGENT_DEFAULTS_MODULE_NAME = "src.core.agent_modes_defaults"


def _agent_definitions() -> List[Dict[str, Any]]:
    """The four built-in agents, as the rows they are seeded into.

    Read from :data:`AGENT_DEFAULTS_MODULE_NAME`, in that module's own order —
    the three declared modes then the app-owned one — which is also the dropdown
    order, since agents come back in insertion order. Nothing here names an agent
    id: ``readonly`` comes from the definition's own flag, so the row says what
    the definition says.

    The tool-loop cap follows the same ``readonly`` discriminator as every other
    column: the app-owned agent is seeded with
    :data:`SEEDED_RESERVED_MAX_TOOL_ITERATION`, the editable built-ins with
    :data:`SEEDED_MAX_TOOL_ITERATION`.

    ``system_message`` is the whole text the agent is told, so the reserved mode's
    **generated** lot-conventions block rides in it. That is what lets the block
    stay defined in one place: the row is a copy refreshed from code on every
    boot, never a second text someone has to remember to edit.
    """
    defaults = importlib.import_module(AGENT_DEFAULTS_MODULE_NAME)
    modes = [*defaults.default_modes(), defaults.todo_builder_mode()]
    rows: List[Dict[str, Any]] = []
    for mode in modes:
        blocks = [mode.system_message, *mode.instructions]
        rows.append(
            {
                "id": mode.id,
                "label": mode.label,
                "max_tool_iteration": (
                    SEEDED_RESERVED_MAX_TOOL_ITERATION
                    if mode.readonly
                    else SEEDED_MAX_TOOL_ITERATION
                ),
                "mcp_enable": 1 if mode.mcptools else 0,
                "lsp_enable": 1 if mode.lsptools else 0,
                "system_message": "\n\n".join(b for b in blocks if b),
                "readonly": 1 if mode.readonly else 0,
            }
        )
    return rows


def _seed(conn: sqlite3.Connection, created: bool) -> Dict[str, Any]:
    """Bring the built-in rows into the store. Idempotent, and run every boot.

    Returns ``{"agents": {"inserted": n, "reasserted": n}, "promptHelpers": n}``
    — what this pass wrote, for the boot's log line.

    **Agents: inserted when absent, re-asserted when the *definition* says
    `readonly`.** A row that is already there and whose definition is editable is
    left alone entirely: it is either the user's own agent or a built-in whose
    persona they were allowed to edit, and a boot that overwrote it would undo
    work the app promised to keep. A ``readonly`` row gets every column except
    ``model_id`` rewritten from code, which is what makes re-seeding safe rather
    than destructive: the only thing on that row the user owns is which model it
    runs on. The decision reads the definition and not the stored flag, because
    for that row code *is* the source of truth — a hand-corrupted ``readonly = 0``
    is re-asserted rather than obeyed.

    **Helpers: only when this boot made the store.** "Is the table empty" is not
    the question — a user who deleted every bullet made the table empty, and a
    boot that refilled it would undo a delete the app promised to honour. The
    gate is :func:`prepare`'s ``created``, widened by :func:`boot` to cover a
    zero-byte file left between the exclusive create and the schema: that file
    holds no user data either, so it is still a first boot.

    **Servers and models are never seeded**: there is no example server, no
    placeholder key and no placeholder URL, because a value that cannot be
    dialled must not be inserted in order to be dialled.

    One transaction, so a boot either has the built-ins or has the store as it
    found it — a half-seeded store is the state where an agent's persona is
    today's and its label is last week's.
    """
    inserted = 0
    reasserted = 0
    for row in _agent_definitions():
        existing = conn.execute(
            "SELECT 1 FROM agents WHERE id = ?", (row["id"],)
        ).fetchone()
        if existing is None:
            conn.execute(
                "INSERT INTO agents (id, label, max_tool_iteration, mcp_enable, "
                "lsp_enable, system_message, readonly, model_id) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
                (
                    row["id"],
                    row["label"],
                    row["max_tool_iteration"],
                    row["mcp_enable"],
                    row["lsp_enable"],
                    row["system_message"],
                    row["readonly"],
                ),
            )
            inserted += 1
        elif row["readonly"]:
            conn.execute(
                "UPDATE agents SET label = ?, max_tool_iteration = ?, "
                "mcp_enable = ?, lsp_enable = ?, system_message = ?, readonly = ? "
                "WHERE id = ?",
                (
                    row["label"],
                    row["max_tool_iteration"],
                    row["mcp_enable"],
                    row["lsp_enable"],
                    row["system_message"],
                    row["readonly"],
                    row["id"],
                ),
            )
            reasserted += 1
    helpers = 0
    if created:
        for _ in range(SEEDED_PROMPT_HELPER_COUNT):
            conn.execute(
                "INSERT INTO prompt_helpers (color_code, content) VALUES (?, '')",
                (SEEDED_PROMPT_HELPER_COLOR,),
            )
            helpers += 1
    return {
        "agents": {"inserted": inserted, "reasserted": reasserted},
        "promptHelpers": helpers,
    }


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
    return PROJECT_ROOT.joinpath(*TEST_SETTINGS_DIR, TEST_SETTINGS_FILENAME)


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
    target = database_path()
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
        prepared = prepare()
    except AppStoreError as exc:
        _store_state = {
            "state": "unusable",
            "path": _describe(target),
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
        conn = connect()
        conn.execute("BEGIN IMMEDIATE")
        seeded = _seed(conn, bool(prepared["created"] or was_empty_file))
        # The suite's own connection fixture becomes one server row and one model
        # row of the temporary store, inside the seed's transaction.
        fixture = materialise_test_fixture(conn) if test_mode() else None
        conn.execute("COMMIT")
    except TestFixtureError as exc:
        # A broken fixture is the suite's own breakage, so it gets a sentence
        # naming the file — "could not be seeded" would point at the store. It is
        # still the unusable state: the suite refuses rather than fall through to
        # this machine's configured connection.
        if conn is not None:
            _rollback(conn)
        _store_state = {
            "state": "unusable",
            "path": _describe(target),
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
            _rollback(conn)
        _store_state = {
            "state": "unusable",
            "path": _describe(target),
            "sentence": (
                f"nojae's settings store at {_describe(target)} could not be "
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


def version_of() -> int:
    """The store's schema level, read without changing anything.

    Part of the gate, not an accessor: it is the gate's own question, asked of a
    file this call must not touch. Read-only mode is what makes that provable —
    refusing is the only answer a too-new file gets. Raises
    :class:`AppStoreError` naming the path when the file cannot be opened or is
    not a database.
    """
    target = database_path()
    try:
        conn = sqlite3.connect(_uri(target, mode="ro"), uri=True)
    except sqlite3.Error as exc:
        raise AppStoreError(
            f"nojae's settings store at {_describe(target)} cannot be opened "
            f"({exc})."
        ) from exc
    try:
        return _user_version(conn, target)
    finally:
        conn.close()


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
    target = database_path()
    cached: Optional[Tuple[str, sqlite3.Connection]] = getattr(
        _thread_state, "handle", None
    )
    if cached is not None and cached[0] == str(target):
        return cached[1]
    if cached is not None:
        close_thread_connection()
    conn = connect()
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


# -- the read side ------------------------------------------------------------
#
# Everything the rest of the app asks the store for, and the only code in the
# repo that spells a ``SELECT``. The reads are **uncached**: the database is the
# cache, so there is no per-root key here and nothing a working-location switch
# could leave stale.
#
# Rows leave with the **browser's** names, not the columns': the
# ``snake_case`` → ``camelCase`` translation lives in this module and nowhere
# else, because the same table copied into every route is a table that stops
# agreeing with itself. The column lists below are therefore the module's whole
# vocabulary, in schema order, and a row is the same dict whether it was read
# alone or nested inside its server.

#: The columns of each table, in schema order, and the reason no accessor spells
#: a ``SELECT *``: a row then holds exactly the columns this module knows about,
#: whatever a later schema level adds beside them.
_SERVER_COLUMNS: Tuple[str, ...] = ("id", "name", "url", "api_key")

_MODEL_COLUMNS: Tuple[str, ...] = (
    "id",
    "server_id",
    "name",
    "sys_prompt",
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "repeat_penalty",
    "presence_penalty",
    "reasoning",
    "supports_vision",
)

_AGENT_COLUMNS: Tuple[str, ...] = (
    "id",
    "label",
    "max_tool_iteration",
    "mcp_enable",
    "lsp_enable",
    "system_message",
    "readonly",
    "model_id",
)

_PROMPT_HELPER_COLUMNS: Tuple[str, ...] = ("id", "color_code", "content")

#: Column → the name the browser knows it by. A column not listed keeps its own
#: name (``id``, ``name``, ``url``, ``label``, ``content``, ``reasoning``).
_SERVER_JSON: Dict[str, str] = {"api_key": "apiKey"}

_MODEL_JSON: Dict[str, str] = {
    "server_id": "serverId",
    "sys_prompt": "sysPrompt",
    "top_p": "topP",
    "top_k": "topK",
    "min_p": "minP",
    "repeat_penalty": "repeatPenalty",
    "presence_penalty": "presencePenalty",
    "supports_vision": "supportsVision",
}

_AGENT_JSON: Dict[str, str] = {
    "max_tool_iteration": "maxToolIteration",
    "mcp_enable": "mcpEnable",
    "lsp_enable": "lspEnable",
    "system_message": "systemMessage",
    "model_id": "modelId",
}

#: The helpers' one renamed column. ``color`` rather than ``colorCode`` so the
#: move stays invisible to the bullet row the client already renders.
_PROMPT_HELPER_JSON: Dict[str, str] = {"color_code": "color"}

#: Columns that carry a JSON boolean rather than a number. SQLite stores them as
#: integers, so the translation happens here once instead of as a ``v == 1`` in
#: every surface that reads one.
_BOOLEAN_COLUMNS: frozenset[str] = frozenset(
    {"supports_vision", "mcp_enable", "lsp_enable", "readonly"}
)

#: The finding kind the read model reports a damaged row with. The browser's
#: modes payload also knows ``note``, for something odd that cost nothing; a row
#: this reader cannot render always costs the agent, so only ``error`` is here.
FINDING_ERROR = "error"


def _kind_of(value: Any) -> str:
    """What to call a stored value in a sentence — the JSON word, not the Python one."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "a boolean"
    if isinstance(value, (int, float)):
        return "a number"
    if isinstance(value, str):
        return "a string"
    return type(value).__name__


def _finding(kind: str, message: str) -> Dict[str, str]:
    """One thing the read noticed, in the shape a route passes straight through."""
    return {"kind": kind, "message": message}


def _record(
    columns: Tuple[str, ...], values: Tuple[Any, ...], mapping: Dict[str, str]
) -> Dict[str, Any]:
    """One row, as the browser's dict: renamed, and the flags made booleans."""
    record: Dict[str, Any] = {}
    for column, value in zip(columns, values):
        record[mapping.get(column, column)] = (
            bool(value) if column in _BOOLEAN_COLUMNS else value
        )
    return record


def _select(
    table: str, columns: Tuple[str, ...], where: str = "", order: str = ""
) -> str:
    """The one ``SELECT`` builder in the repo.

    ``table`` and ``columns`` are never caller-supplied: every argument is a
    constant above, which is what lets the statement be assembled with no
    placeholder in sight. A **value** always goes through a ``?``.
    """
    clause = f" WHERE {where}" if where else ""
    tail = f" ORDER BY {order}" if order else ""
    return f"SELECT {', '.join(columns)} FROM {table}{clause}{tail}"


def _read(sql: str, params: Tuple[Any, ...] = ()) -> List[Tuple[Any, ...]]:
    """Run one read statement — the only place a read's failure is decided.

    Every accessor here goes through it, so the module answers **one** failure
    type for the read side: a driver error becomes :class:`AppStoreError` naming
    the path, the same sentence an unopenable file gets. :func:`resolve_agents`
    keeps its never-raises promise by catching that one type: a file that opens
    but has no schema (a boot killed between the create and the migration) would
    otherwise escape as a raw ``OperationalError`` and take the dropdown with it.
    """
    target = database_path()
    try:
        return list(connection().execute(sql, params))
    except sqlite3.Error as exc:
        raise AppStoreError(
            f"nojae's settings store at {_describe(target)} cannot be read ({exc})."
        ) from exc


# -- servers and models ----------------------------------------------------------

def server_row(server_id: Any) -> Optional[Dict[str, Any]]:
    """One server by id, or ``None`` when there is no such row."""
    if not isinstance(server_id, int) or isinstance(server_id, bool):
        return None
    found = _read(_select("servers", _SERVER_COLUMNS, "id = ?"), (server_id,))
    return None if not found else _record(_SERVER_COLUMNS, found[0], _SERVER_JSON)


def model_row(model_id: Any) -> Optional[Dict[str, Any]]:
    """One model by id, or ``None`` — the row alone, without its server."""
    if not isinstance(model_id, int) or isinstance(model_id, bool):
        return None
    found = _read(_select("models", _MODEL_COLUMNS, "id = ?"), (model_id,))
    return None if not found else _record(_MODEL_COLUMNS, found[0], _MODEL_JSON)


def load_servers() -> List[Dict[str, Any]]:
    """Every server with its models, as the browser's dicts.

    ``[{id, name, url, apiKey, models: [{id, serverId, name, sysPrompt, the six
    samplers, reasoning, supportsVision}]}]``, servers in insertion order and
    each server's models in theirs. The nesting is the shape the Settings dialog
    renders, which is why the models arrive inside their server rather than as a
    second list a route has to join.

    The API key is in here: it is returned to the dialog that edits it. "Never to
    a connector, a log or a tool listing" is those surfaces' rule, and this
    accessor is not one of them.

    Raises :class:`AppStoreError` naming the path when the store cannot be
    opened, which is deliberate for a plain read: an accessor that answered
    ``[]`` instead would make an unreadable store indistinguishable from one
    with no servers — the silent empty state this app refuses. The caller that
    has something to say about it is :func:`src.config.agent_connection_refusal`.
    """
    servers = [
        _record(_SERVER_COLUMNS, found, _SERVER_JSON)
        for found in _read(_select("servers", _SERVER_COLUMNS, order="id"))
    ]
    models_by_server: Dict[int, List[Dict[str, Any]]] = {}
    for found in _read(_select("models", _MODEL_COLUMNS, order="id")):
        model = _record(_MODEL_COLUMNS, found, _MODEL_JSON)
        models_by_server.setdefault(model["serverId"], []).append(model)
    for server in servers:
        server["models"] = models_by_server.get(server["id"], [])
    return servers


# -- the agents read model -------------------------------------------------------
#
# What ``agent_modes.resolve_modes()`` / ``resolve_mode()`` are, over the
# ``agents`` table. The guarantees that are about behaviour rather than storage
# are kept: the read **never raises** (a damaged row is reported, the dropdown
# still renders) and the app-owned agent stays **last**. There is no ``default``
# key in the answer at all, and :func:`resolve_agent` is "an id in, a row or
# nothing out".

#: Where the app-owned agent ids come from. Resolved **by name, per call**: that
#: module reads these rows, so a static import in either direction is a cycle.
AGENT_MODES_MODULE_NAME = "src.core.agent_modes"

#: The ids the read model puts last, whatever the table's insertion order says —
#: the fallback for the case :func:`_reserved_agent_ids` cannot answer. Same
#: tuple the seeder writes its rows from, named here rather than re-typed.
RESERVED_AGENT_IDS_FALLBACK: Tuple[str, ...] = ("todoBuilder",)


def _reserved_agent_ids() -> Tuple[str, ...]:
    """The ids nojaé owns, which the read model puts last whatever the table says.

    A module that cannot be imported is a broken installation rather than a
    damaged row, so the answer is the one every failure here gives: say nothing
    extra, render what there is — the fallback tuple keeps the app-owned agent
    last.
    """
    try:
        module = importlib.import_module(AGENT_MODES_MODULE_NAME)
    except Exception:  # noqa: BLE001 — a missing module is not a row to report
        return RESERVED_AGENT_IDS_FALLBACK
    declared = getattr(module, "RESERVED_MODE_IDS", None)
    return tuple(declared) if declared else RESERVED_AGENT_IDS_FALLBACK


#: The agent columns whose integer declaration is a **preference**, not a guard:
#: SQLite's type affinity lets a hand-edited file hold the text ``"lots"`` in
#: them, so the reader checks them instead of trusting the schema.
_AGENT_INTEGER_COLUMNS: Tuple[str, ...] = (
    "max_tool_iteration",
    "mcp_enable",
    "lsp_enable",
    "readonly",
)


def _agent_problem(values: Mapping[str, Any]) -> Optional[str]:
    """Why one agent row cannot be rendered, or ``None`` when it can.

    Takes the **raw** column values, before :func:`_record` turns the flags into
    booleans: a damaged value has to be seen as what it is, or the check would
    be reading its own coercion back.

    ``system_message`` is checked for its type only — an empty persona means "use
    the model's own prompt", so a blank string there is a choice, not damage.
    """
    for column in ("id", "label"):
        value = values[column]
        if not isinstance(value, str) or not value.strip():
            return f"holds {column} as {_kind_of(value)}, expected a non-empty string"
    if not isinstance(values["system_message"], str):
        return (
            "holds system_message as "
            f"{_kind_of(values['system_message'])}, expected a string"
        )
    for column in _AGENT_INTEGER_COLUMNS:
        value = values[column]
        if isinstance(value, bool) or not isinstance(value, int):
            return f"holds {column} as {_kind_of(value)}, expected an integer"
    model_id = values["model_id"]
    if model_id is not None and (
        isinstance(model_id, bool) or not isinstance(model_id, int)
    ):
        return f"holds model_id as {_kind_of(model_id)}, expected an integer or null"
    return None


def resolve_agents() -> Dict[str, Any]:
    """Every agent, in dropdown order, plus what the read noticed.

    ``{"agents": [{id, label, maxToolIteration, mcpEnable, lspEnable,
    systemMessage, readonly, modelId, modelName}], "findings": [{kind,
    message}]}`` — and deliberately **no** ``default`` key: there is no
    server-side default agent to report, and a key that always answered
    "nothing" would be read as meaningful by the composer and by the lot.

    ``modelName`` is the resolved model's name, or ``None``. With ``modelId`` it
    is the whole answer to "can this agent run at all", so the composer's warning
    reads a field instead of re-deriving the rule from two tables. A ``modelId``
    that names no row is reported as a finding and answers ``modelName: None`` —
    the agent is unrunnable, the same named state a model whose server row is
    missing gets.

    **It never raises.** A row the reader cannot render is dropped as a unit and
    reported — the dropdown is the thing that has to stay usable, and a persona
    with a damaged cap is still a persona someone can fix from the dialog. An
    unopenable store answers the same way: no agents, and the sentence naming
    the path in the findings.

    Order is the table's insertion order (``rowid``) — the order the seeder wrote
    and the dialog creates in — with the app-owned agent moved last whatever the
    table says. That is the modes read's rule, unchanged by the move.
    """
    findings: List[Dict[str, str]] = []
    try:
        rows = [
            dict(zip(_AGENT_COLUMNS, found))
            for found in _read(_select("agents", _AGENT_COLUMNS, order="rowid"))
        ]
        models = {
            model["id"]: model
            for model in (
                _record(_MODEL_COLUMNS, found, _MODEL_JSON)
                for found in _read(_select("models", _MODEL_COLUMNS, order="id"))
            )
        }
    except AppStoreError as exc:
        return {"agents": [], "findings": [_finding(FINDING_ERROR, str(exc))]}

    agents: List[Dict[str, Any]] = []
    for position, raw in enumerate(rows, start=1):
        problem = _agent_problem(raw)
        if problem is not None:
            # The row is named by its id when it has one, and by its position
            # when even that is damaged: a finding nobody can trace to a row is
            # a wall rather than a message.
            who = raw["id"] if isinstance(raw["id"], str) and raw["id"] else f"row {position}"
            findings.append(
                _finding(FINDING_ERROR, f"The agent {who!r} {problem}; it is not shown.")
            )
            continue
        agent = _record(
            _AGENT_COLUMNS, tuple(raw[column] for column in _AGENT_COLUMNS), _AGENT_JSON
        )
        model_id = agent["modelId"]
        model = models.get(model_id) if model_id is not None else None
        if model_id is not None and model is None:
            findings.append(
                _finding(
                    FINDING_ERROR,
                    f"The agent {agent['id']!r} names model {model_id}, which the "
                    "store does not hold; it cannot run until it is given one.",
                )
            )
        agent["modelName"] = model["name"] if model else None
        agents.append(agent)

    reserved = _reserved_agent_ids()
    agents.sort(key=lambda agent: agent["id"] in reserved)
    return {"agents": agents, "findings": findings}


def resolve_agent(
    agent_id: Optional[str],
) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, str]]]:
    """One agent by id: an id in, a row or nothing out.

    **A missing id resolves to nothing** — there is no server-side default to
    fall back to: a turn with no ``agentMode`` is the 422 naming the field, not
    a turn that runs as some agent the client never chose. So ``None``/empty
    answers ``(None, findings)`` like any unresolvable id, and the caller decides
    what it costs — the route answers 422, and the message listing what *is*
    available is built from :func:`resolve_agents`.

    The findings ride along, so a caller that reports the agent it used can say
    in the same breath that the store has problems.
    """
    resolved = resolve_agents()
    wanted = (agent_id or "").strip()
    if not wanted:
        return (None, resolved["findings"])
    for agent in resolved["agents"]:
        if agent["id"] == wanted:
            return (agent, resolved["findings"])
    return (None, resolved["findings"])


def agent_max_tool_iteration(agent: Mapping[str, Any]) -> int:
    """The resolved agent's tool-loop cap, behind ``config.max_tool_iteration()``.

    A **floor of 1 and no ceiling**: the 500 found in a live settings file is a
    value someone typed, not a limit the app imposed.

    Still MCP's knob only: a round that used nothing but language-server tools
    never advances the count, so LSP round-trips stay uncapped. And the number is
    the one the turn resolved **at its start** — a save that lands mid-turn
    cannot move the cap the loop is running with.
    """
    raw = agent.get("maxToolIteration")
    if isinstance(raw, bool) or not isinstance(raw, int):
        # :func:`resolve_agents` checked every row that reached a caller, so this
        # is a hand-built mapping: the seeded number is the honest answer, and
        # the floor still applies to it.
        return SEEDED_MAX_TOOL_ITERATION
    return max(1, raw)


# -- the prompt-helper rows ------------------------------------------------------

def load_prompt_helpers() -> List[Dict[str, Any]]:
    """Every helper row, in insertion order.

    ``[{id, color, content}]``. There is **no count rule**: a row is a bullet and
    the count is simply the count, so a user who deleted every one of them has no
    rows and the bullet row renders nothing. The old "exactly nine or an error"
    existed because the app was one file's only writer and a wrong count meant
    corruption; in a table, adding and deleting are the normal operations.

    The ``id`` is in the answer because the writes below address a bullet by it —
    "update one" and "delete" have no slot index once the count is the user's
    business.

    Raises :class:`AppStoreError` like :func:`load_servers`: an unusable store
    is a named state, never nine empty bullets.
    """
    return [
        _record(_PROMPT_HELPER_COLUMNS, found, _PROMPT_HELPER_JSON)
        for found in _read(
            _select("prompt_helpers", _PROMPT_HELPER_COLUMNS, order="id")
        )
    ]


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

    target = database_path()
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
        connection().execute("PRAGMA wal_checkpoint(TRUNCATE)")
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
    conn = connection()
    try:
        conn.execute("BEGIN IMMEDIATE")
        cursor = conn.execute(sql, params)
        changed = cursor.rowcount
        conn.execute("COMMIT")
    except sqlite3.Error as exc:
        _rollback(conn)
        raise AppStoreError(
            f"nojae's settings store at {_describe(database_path())} could not be "
            f"written ({exc})."
        ) from exc
    return changed


# -- servers and models ----------------------------------------------------------
#
# The connection's two tables, written. Like every write here these are accessors
# rather than routes: they take values the route has already refused or accepted,
# they answer the whole server list in the read's shape (so the dialog re-baselines
# on what the store now holds rather than on what it sent), and they raise
# :class:`AppStoreError` rather than an HTTP status.
#
# **Duplicate names are the route's refusal, not these functions'.** The app
# refuses before the database does, in words: the route compares against
# :func:`load_servers` and answers a message naming the field, while the
# ``UNIQUE`` constraints stay the last line for two tabs saving at once, where
# the check passed and the statement did not.

def add_server(name: str, url: str, api_key: str = "") -> List[Dict[str, Any]]:
    """Append one server and answer the whole list.

    An **append**, always: a server is addressed by the ``id`` the read hands out,
    so there is nothing to aim at here. The new row's id is SQLite's, which is why
    the answer is the read rather than the values passed in.
    """
    _write(
        "INSERT INTO servers (name, url, api_key) VALUES (?, ?, ?)",
        (name, url, api_key),
    )
    return load_servers()


def update_server(
    server_id: int, name: str, url: str, api_key: str
) -> Optional[List[Dict[str, Any]]]:
    """Rewrite one server; answers the whole list, or ``None`` for no such row.

    Every column is written, so a cleared field clears: the dialog owns all three
    fields of a server, and a save that left an unnamed one behind would be a row
    it cannot render. No copy is kept — an ``UPDATE`` replaces a field the user
    can retype.
    """
    changed = _write(
        "UPDATE servers SET name = ?, url = ?, api_key = ? WHERE id = ?",
        (name, url, api_key, server_id),
    )
    return load_servers() if changed else None


def delete_server(server_id: int) -> Optional[List[Dict[str, Any]]]:
    """Remove one server **and its models**, keeping a copy of the store first.

    The cascade is the schema's (``ON DELETE CASCADE``, and ``ON DELETE SET
    NULL`` for the agents that pointed at those models), not code here. That is
    why the copy is taken first — one delete destroys more rows than the one the
    user named.

    ``None`` for an id that names no row, and then nothing was destroyed and no
    copy was taken.
    """
    if server_row(server_id) is None:
        return None
    backup_before_delete()
    _write("DELETE FROM servers WHERE id = ?", (server_id,))
    return load_servers()


def add_model(
    server_id: int,
    name: str,
    *,
    sys_prompt: str = "",
    temperature: Optional[float] = None,
    top_p: Optional[float] = None,
    top_k: Optional[int] = None,
    min_p: Optional[float] = None,
    repeat_penalty: Optional[float] = None,
    presence_penalty: Optional[float] = None,
    reasoning: Optional[str] = None,
    supports_vision: bool = False,
) -> Optional[List[Dict[str, Any]]]:
    """Append one model under ``server_id`` and answer the whole list.

    ``None`` when the server is not there: a model is a child row, and a create
    that names no parent is the browser working from a list that has since
    changed — the caller answers with the list it now has. (The schema would
    refuse it too, with ``FOREIGN KEY constraint failed``; answering ``None`` is
    what lets the route say that in words instead of quoting SQLite.)

    The six samplers are **nullable columns**: a ``None`` here is a ``NULL`` in
    the row, which :meth:`EndpointsConfig.from_store` omits from the request
    body, while a ``0`` is kept. The two are different values and must not
    converge, which is why there is no default spelled for them.
    """
    if server_row(server_id) is None:
        return None
    _write(
        "INSERT INTO models (server_id, name, sys_prompt, temperature, top_p,"
        " top_k, min_p, repeat_penalty, presence_penalty, reasoning,"
        " supports_vision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            server_id,
            name,
            sys_prompt,
            temperature,
            top_p,
            top_k,
            min_p,
            repeat_penalty,
            presence_penalty,
            reasoning,
            1 if supports_vision else 0,
        ),
    )
    return load_servers()


def update_model(
    model_id: int,
    name: str,
    *,
    sys_prompt: str = "",
    temperature: Optional[float] = None,
    top_p: Optional[float] = None,
    top_k: Optional[int] = None,
    min_p: Optional[float] = None,
    repeat_penalty: Optional[float] = None,
    presence_penalty: Optional[float] = None,
    reasoning: Optional[str] = None,
    supports_vision: bool = False,
) -> Optional[List[Dict[str, Any]]]:
    """Rewrite one model; answers the whole list, or ``None`` for no such row.

    Every column but ``server_id`` is written, so a cleared sampler clears to
    ``NULL`` — the same "member absent means" the dialog held for the file, now
    per column. A model is never **moved** between servers: that would silently
    re-point every agent that runs on it, and the dialog offers no such action.
    """
    changed = _write(
        "UPDATE models SET name = ?, sys_prompt = ?, temperature = ?, top_p = ?,"
        " top_k = ?, min_p = ?, repeat_penalty = ?, presence_penalty = ?,"
        " reasoning = ?, supports_vision = ? WHERE id = ?",
        (
            name,
            sys_prompt,
            temperature,
            top_p,
            top_k,
            min_p,
            repeat_penalty,
            presence_penalty,
            reasoning,
            1 if supports_vision else 0,
            model_id,
        ),
    )
    return load_servers() if changed else None


def delete_model(model_id: int) -> Optional[List[Dict[str, Any]]]:
    """Remove one model, keeping a copy of the store first.

    The agents pointing at it are **not** deleted: ``ON DELETE SET NULL`` leaves
    each one with a null ``model_id``, which is the narrower damage — the persona
    outlives the model it was tried with, and the agent becomes unrunnable until
    it is given another. The unassigned count in the dialog is what makes that
    visible rather than silent.
    """
    if model_row(model_id) is None:
        return None
    backup_before_delete()
    _write("DELETE FROM models WHERE id = ?", (model_id,))
    return load_servers()


# -- agents, written -------------------------------------------------------------
#
# The personas' table, written. Like the connection's writes these are accessors
# rather than routes: they take values the route has already refused or accepted,
# and they answer the whole agent list in the read's shape so the dialog
# re-baselines on what the store now holds.
#
# Two rules the store enforces on itself here, because they are about rows rather
# than about what a browser typed:
#
# * a **``readonly``** row refuses every write except its ``model_id``. The
#   refusal is one sentence built here (:func:`readonly_refusal`) so the dialog,
#   the route and the boot's re-assertion cannot disagree about it;
# * a **missing agent id names no row**, so a create that would collide and an
#   update that would vanish are both ``None`` — the route turns that into the
#   status its own contract gives it.
#
# Duplicate **labels** stay the route's refusal, exactly as duplicate server and
# model names are: the ``UNIQUE`` constraint is the last line for two tabs saving
# at once, and the dialog's own mistake gets the dialog's own sentence.

#: The one refusal sentence nojae's own agents answer a write with. It is a
#: property of the agent, not of the field someone tried to change, so it does
#: not name one — and it is the *same* sentence wherever it is reached from: the
#: update route, the delete route, and any future writer.
READONLY_AGENT_REFUSAL = (
    "This agent is nojae's own: its fields cannot be edited or deleted. Its model "
    "is the one thing you can set."
)

#: The refusal a **built-in** agent answers *deletion* with. It is a second
#: sentence because the two rules cover different sets: only the app-owned agent
#: is ``readonly`` (the other three are personas the user may edit), while every
#: built-in is undeletable, because the seeder owns those ids and a dropdown
#: that could lose `code` would turn the lot's pin into a mystery.
BUILT_IN_AGENT_REFUSAL = (
    "This agent is one of nojae's own and cannot be deleted — you can edit it "
    "instead."
)


def readonly_refusal(agent_id: str) -> AppStoreError:
    """The error a write to a ``readonly`` agent raises, naming the agent."""
    return AppStoreError(
        f"Cannot change agent {agent_id!r}. {READONLY_AGENT_REFUSAL}"
    )


def built_in_refusal(agent_id: str) -> AppStoreError:
    """The error deleting a **built-in** agent raises, naming the agent."""
    return AppStoreError(
        f"Cannot delete agent {agent_id!r}. {BUILT_IN_AGENT_REFUSAL}"
    )


def built_in_agent_ids() -> Tuple[str, ...]:
    """The ids nojae seeds, read from the module that defines them.

    The one place "built-in" is decided, and it is the *definition* that decides
    it — not a list retyped here and not a column: the schema has no ``builtin``
    flag, and code is the source of truth for which agents nojae owns. Resolved
    by name for the reason :data:`AGENT_DEFAULTS_MODULE_NAME` gives.
    """
    defaults = importlib.import_module(AGENT_DEFAULTS_MODULE_NAME)
    modes = [*defaults.default_modes(), defaults.todo_builder_mode()]
    return tuple(mode.id for mode in modes)


def _agent_row(agent_id: Any) -> Optional[Dict[str, Any]]:
    """One agent row as the read answers it, or ``None``.

    Goes through :func:`resolve_agents` rather than a bare ``SELECT`` so the row a
    write is judged against is the row the dialog is showing — same columns, same
    ``modelName``, same reserved ordering. The list is small and a write is rare,
    so the second read costs nothing a cache would have earned.
    """
    found, _findings = resolve_agent(agent_id)
    return found


def _agent_rows_by_id() -> Dict[str, Dict[str, Any]]:
    """Every renderable agent row, keyed by id — the shape a write answers with."""
    return {agent["id"]: agent for agent in resolve_agents()["agents"]}


def add_agent(
    agent_id: str,
    label: str,
    *,
    max_tool_iteration: int = SEEDED_MAX_TOOL_ITERATION,
    mcp_enable: bool = True,
    lsp_enable: bool = False,
    system_message: str = "",
    model_id: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Insert one agent and answer the whole list.

    ``readonly`` is deliberately **not** a parameter: a user-created agent is
    editable by definition, and no route may create one nojae owns. The one
    built-in refusal that matters at create time is a **taken id**, which the
    schema asserts — a route checks it in words first, so this is the last line.

    An append, like every create here: ``agents.id`` is the slug the payload and
    the session files carry, so the caller *does* name it, and the store's answer
    is the list because that is what the dialog renders next.
    """
    _write(
        "INSERT INTO agents (id, label, max_tool_iteration, mcp_enable, lsp_enable,"
        " system_message, readonly, model_id) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
        (
            agent_id,
            label,
            max_tool_iteration,
            1 if mcp_enable else 0,
            1 if lsp_enable else 0,
            system_message,
            model_id,
        ),
    )
    return list(_agent_rows_by_id().values())


def update_agent(
    agent_id: str,
    *,
    label: Optional[str] = None,
    max_tool_iteration: Optional[int] = None,
    mcp_enable: Optional[bool] = None,
    lsp_enable: Optional[bool] = None,
    system_message: Optional[str] = None,
    model_id: Any = ...,
) -> Optional[List[Dict[str, Any]]]:
    """Rewrite one agent; answers the whole list, or ``None`` for no such row.

    Refuses a **``readonly``** agent outright — with :func:`readonly_refusal` —
    unless the only column asked for is ``model_id``, which is the one field of
    such a row the user owns. "Only the model" is decided by which keyword
    arguments were supplied, not by which of them equal the stored value: a body
    that sends an unchanged label is still an edit of that label.

    ``model_id=...`` (the default sentinel) means "leave it alone", so an update
    that does not mention the model cannot null it by accident; passing ``None``
    explicitly clears the association, which is a legal save.

    No copy is kept: an ``UPDATE`` replaces a field the user can retype.
    """
    row = _agent_row(agent_id)
    if row is None:
        return None

    columns: Dict[str, Any] = {}
    if label is not None:
        columns["label"] = label
    if max_tool_iteration is not None:
        columns["max_tool_iteration"] = max_tool_iteration
    if mcp_enable is not None:
        columns["mcp_enable"] = 1 if mcp_enable else 0
    if lsp_enable is not None:
        columns["lsp_enable"] = 1 if lsp_enable else 0
    if system_message is not None:
        columns["system_message"] = system_message
    model_given = model_id is not ...
    if model_given:
        columns["model_id"] = model_id

    if row["readonly"] and any(column != "model_id" for column in columns):
        raise readonly_refusal(agent_id)
    if not columns:
        # Nothing asked for: answer the list unchanged rather than spelling a
        # `SET` with no assignment (which is not SQL).
        return list(_agent_rows_by_id().values())

    assignments = ", ".join(f"{column} = ?" for column in columns)
    _write(
        f"UPDATE agents SET {assignments} WHERE id = ?",
        (*columns.values(), agent_id),
    )
    return list(_agent_rows_by_id().values())


def delete_agent(agent_id: str) -> Optional[List[Dict[str, Any]]]:
    """Remove one agent, keeping a copy of the store first.

    Refuses a **built-in** agent — every agent nojae seeds, not only the
    ``readonly`` one, because the seeder owns those ids and the dropdown a lot
    pins must not be able to lose `code`. The sentence is
    :func:`built_in_refusal`'s, so the route and any later writer answer it in one
    voice.

    A user-created agent goes, and the whole store is copied into the app's dated
    backup folder before the ``DELETE`` — the one thing the user cannot retype.

    ``None`` for an id that names no row, and then nothing was destroyed and no
    copy was taken.
    """
    row = _agent_row(agent_id)
    if row is None:
        return None
    if agent_id in built_in_agent_ids():
        raise built_in_refusal(agent_id)
    backup_before_delete()
    _write("DELETE FROM agents WHERE id = ?", (agent_id,))
    return list(_agent_rows_by_id().values())


def add_prompt_helper(color: str, content: str = "") -> List[Dict[str, Any]]:
    """Append one bullet and answer the whole list as the browser renders it.

    An **append**, always: the row count is the user's business, so there is no
    slot to aim at and no free slot to fill. The new row's ``id`` is the one
    SQLite assigns, which is why the answer is the read rather than the values
    passed in.
    """
    _write(
        "INSERT INTO prompt_helpers (color_code, content) VALUES (?, ?)",
        (color, content),
    )
    return load_prompt_helpers()


def update_prompt_helper(
    helper_id: int, color: str, content: str
) -> Optional[List[Dict[str, Any]]]:
    """Rewrite one bullet's colour and text; answers the whole list.

    ``None`` when no row carries that id — the id is the handle the read hands
    out, so a row that is not there means the browser was looking at an older
    list, and the caller answers with the list it now has.
    """
    changed = _write(
        "UPDATE prompt_helpers SET color_code = ?, content = ? WHERE id = ?",
        (color, content, helper_id),
    )
    return load_prompt_helpers() if changed else None


def delete_prompt_helper(helper_id: int) -> Optional[List[Dict[str, Any]]]:
    """Remove one bullet, keeping a copy of the store first.

    Answers the whole list, or ``None`` when no row carried that id. The copy is
    taken **before** the ``DELETE`` and only for a row that exists: an UPDATE
    needs none, because the row it replaces is a field the user can retype, and a
    delete that deletes nothing destroys nothing.
    """
    found = _read(
        _select("prompt_helpers", _PROMPT_HELPER_COLUMNS, "id = ?"), (helper_id,)
    )
    if not found:
        return None
    backup_before_delete()
    _write("DELETE FROM prompt_helpers WHERE id = ?", (helper_id,))
    return load_prompt_helpers()

