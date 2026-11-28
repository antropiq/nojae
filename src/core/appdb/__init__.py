"""nojae's own settings store: one SQLite file, and the only code that speaks SQL.

``<install root>/nojae.db`` is where the app keeps the model connections
(``servers`` + ``models``), the agent personas (``agents``) and the prompt
helpers (``prompt_helpers``). This package owns that file and **nothing else**:
the path, the connection lifecycle, the schema and its version gate. Every other
module asks it for data — nobody else opens the file, nobody else writes SQL, and
no public function takes a path. :func:`boot` is the boot's one call — bring the
store to the current schema level, then seed it — and it answers a state dict
instead of raising, so an unusable store is a **named state** rather than a dead
app.

The package is one namespace: this file binds the whole public surface, and each
domain file reads every shared name off it at call time, so a patch of
``appdb.PROJECT_ROOT`` or ``appdb.SCHEMA_VERSION`` moves what every one of them
answers. :mod:`appdb.constants` holds the file's name and the schema,
:mod:`appdb.errors` the failure type, :mod:`appdb.paths` the path answers,
:mod:`appdb.handle` the connections, :mod:`appdb.gate` the schema version gate,
:mod:`appdb.seeding` the built-in rows a boot writes, :mod:`appdb.fixture` the
e2e suite's flat connection file, read and turned into rows, and
:mod:`appdb.lifecycle` the boot itself and the state it keeps. :mod:`appdb.rows`
holds the columns and the one read seam, :mod:`appdb.writes` the one write seam
and the copy taken before a delete, :mod:`appdb.servers` the connection's two
tables, read and written, :mod:`appdb.agents` the personas' table, read and
written, and :mod:`appdb.prompt_helpers` the memory bullets' table, read and
written.

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

from pathlib import Path
from typing import Optional

from src.config import PROJECT_ROOT, env_flag  # noqa: F401 — the store's patch seam

from .constants import (
    BUSY_TIMEOUT_MS,
    DB_FILENAME,
    SCHEMA_STATEMENTS,
    SCHEMA_VERSION,
    TABLE_NAMES,
    TEST_ROOT_PREFIX,
    TEST_SETTINGS_KEY,
    UPGRADES,
    WAL_SIDECAR_SUFFIXES,
)
from .errors import AppStoreError
from .paths import (
    _describe,
    database_path,
    sidecar_paths,
    test_mode,
    test_root,
)
from .handle import _uri, close_thread_connection, connect, connection
from .gate import (  # noqa: F401 — bound here, so appdb.<name> keeps resolving
    _create_if_not_exists,
    _ensure_schema,
    _exclusive_create,
    _migrate,
    _rollback,
    _set_user_version,
    _user_version,
    prepare,
    version_of,
)
from .seeding import (  # noqa: F401 — bound here, so appdb.<name> keeps resolving
    AGENT_DEFAULTS_MODULE_NAME,
    SEEDED_MAX_TOOL_ITERATION,
    SEEDED_PROMPT_HELPER_COLOR,
    SEEDED_PROMPT_HELPER_COUNT,
    SEEDED_RESERVED_MAX_TOOL_ITERATION,
    _agent_definitions,
    _seed,
)
from .fixture import (  # noqa: F401 — bound here, so appdb.<name> keeps resolving
    TEST_MODEL_KEYS,
    TEST_SERVER_KEYS,
    TEST_SETTINGS_DIR,
    TEST_SETTINGS_FILENAME,
    TEST_TYPE_WORDS,
    TestFixtureError,
    _checked_block,
    _check_types,
    _describe_value,
    _read_test_fixture,
    materialise_test_fixture,
    test_settings_path,
)
from .lifecycle import boot, store_state  # noqa: F401 — the façade's boot seam
from .rows import (  # noqa: F401 — bound here, so appdb.<name> keeps resolving
    FINDING_ERROR,
    _AGENT_COLUMNS,
    _AGENT_JSON,
    _BOOLEAN_COLUMNS,
    _MODEL_COLUMNS,
    _MODEL_JSON,
    _PROMPT_HELPER_COLUMNS,
    _PROMPT_HELPER_JSON,
    _SERVER_COLUMNS,
    _SERVER_JSON,
    _finding,
    _kind_of,
    _read,
    _record,
    _select,
)
from .writes import (  # noqa: F401 — bound here, so appdb.<name> keeps resolving
    _checkpoint,
    _write,
    backup_before_delete,
)
from .servers import (  # noqa: F401 — bound here, so appdb.<name> keeps resolving
    add_model,
    add_server,
    delete_model,
    delete_server,
    load_servers,
    model_row,
    server_row,
    update_model,
    update_server,
)
from .agents import (  # noqa: F401 — bound here, so appdb.<name> keeps resolving
    AGENT_MODES_MODULE_NAME,
    BUILT_IN_AGENT_REFUSAL,
    RESERVED_AGENT_IDS_FALLBACK,
    READONLY_AGENT_REFUSAL,
    add_agent,
    agent_max_tool_iteration,
    built_in_agent_ids,
    built_in_refusal,
    delete_agent,
    readonly_refusal,
    resolve_agent,
    resolve_agents,
    update_agent,
    _agent_problem,
    _agent_row,
    _agent_rows_by_id,
    _AGENT_INTEGER_COLUMNS,
    _reserved_agent_ids,
)
from .prompt_helpers import (  # noqa: F401 — bound here, so appdb.<name> keeps resolving
    add_prompt_helper,
    delete_prompt_helper,
    load_prompt_helpers,
    update_prompt_helper,
)

#: Where test mode's throw-away root is, once it has been made (:func:`test_root`).
#: It is declared here because :func:`test_root` writes it, and a patch has to
#: land on the namespace every reader of it goes through.
_test_root: Optional[Path] = None

