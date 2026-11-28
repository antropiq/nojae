"""The store's module attributes: the file's name, the schema, and the level gate.

They are plain module attributes so a test can move a lookup by patching the
façade, and the schema text lives here and nowhere else.
"""

from typing import Dict, Tuple

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
