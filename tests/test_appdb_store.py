"""appdb-01 — the store module: path, schema, connection lifecycle, version gate.

Nothing in the app reads the database yet (that is tasks 02 and 03), so this
suite tests the only things that exist: where the file goes, what lands in it,
how it is opened, and what a boot says about a file it does not understand.

The promises asserted here, in the order the module states them:

* **the path is the install root's**, built by one ``Path`` join — no platform
  branch, no separator spelled, no ``~`` expansion, no drive assumption (§4.9);
* **the schema is the spec's** (§4.2), read back out of the file rather than
  trusted from the statement that made it: the four tables and no fifth, every
  column, the two ``UNIQUE`` constraints, both ``ON DELETE`` clauses, and the
  nullable samplers that keep ``0`` and "not set" apart;
* **the version gate** (D6): a fresh file is created and versioned, an older
  level is upgraded, a **newer** one is refused with the path and the level in
  the sentence and its bytes untouched;
* **an unusable store is a named state** — :class:`AppStoreError` naming the
  path, for a directory in the file's place, an unreadable file, a file that is
  not a database, and a level with no upgrade path;
* **the connection is the one the app's shape needs**: WAL on and persistent,
  foreign keys on, the busy timeout applied, one handle per thread (and a handle
  that follows a moved path), and a reader that proceeds while a writer holds
  the lock (§4.10's thread-safety test);
* **the module is the only one that speaks SQL**, the only one that names the
  file, takes no path from a caller, and speaks no HTTP.

Hermeticity: every test runs against a database under its own ``tmp_path``,
because the fixture patches ``appdb.PROJECT_ROOT`` — the one value the whole
module's path answers come from. The real ``<install root>/nojae.db`` is never
opened, and no test needs a model, a hub or a network.
"""

import ast
import contextlib
import hashlib
import sqlite3
import threading
import time
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

import pytest

from src.core import appdb

REPO_ROOT = Path(appdb.__file__).resolve().parents[2]


# -- the fixture: one patch moves the whole store -------------------------------

@pytest.fixture
def store_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """An install root whose ``nojae.db`` does not exist yet.

    Patching ``appdb.PROJECT_ROOT`` is the whole move: :func:`appdb.database_path`
    is the only place the path is built, and every other answer in the module —
    the connect seam, the sentences, the sidecars — comes through it.
    """
    root = tmp_path / "install"
    root.mkdir()
    monkeypatch.setattr(appdb, "PROJECT_ROOT", root)
    yield root
    appdb.close_thread_connection()


def digest(path: Path) -> str:
    """What the bytes of ``path`` are, so "untouched" can be asserted."""
    return hashlib.sha256(path.read_bytes()).hexdigest()


@contextlib.contextmanager
def raw(path: Path, read_only: bool = False) -> Iterator[sqlite3.Connection]:
    """A connection that is **not** the module's — for asking what the file holds.

    The point is to ask without the module's help: a test that checked the
    schema through ``appdb`` would be reading the module's own opinion back.
    Foreign keys are on because the tests assert the cascades, and a raw handle
    that left them off would answer "the constraint did not fire" for a rule
    that lives in the file.
    """
    conn = sqlite3.connect(
        path.as_uri() + ("?mode=ro" if read_only else ""), uri=True
    )
    try:
        conn.execute("PRAGMA foreign_keys = ON")
        yield conn
        conn.commit()
    finally:
        conn.close()


def _tables(conn: sqlite3.Connection) -> List[str]:
    """Every table the file holds, SQLite's own bookkeeping excluded."""
    return sorted(
        row[0]
        for row in conn.execute(
            "SELECT name FROM sqlite_master WHERE type = 'table' "
            "AND name NOT LIKE 'sqlite_%'"
        )
    )


# -- the path (§4.9) -----------------------------------------------------------

class TestThePath:
    def test_the_database_sits_at_the_install_root(self, store_root: Path):
        assert appdb.database_path() == store_root / "nojae.db"

    def test_the_sidecars_are_the_wal_pair_beside_it(self, store_root: Path):
        assert appdb.sidecar_paths() == (
            store_root / "nojae.db-wal",
            store_root / "nojae.db-shm",
        )

    def test_the_filename_is_a_module_attribute(self):
        """A test must be able to move the lookup without editing the module."""
        assert appdb.DB_FILENAME == "nojae.db"
        assert appdb.WAL_SIDECAR_SUFFIXES == ("-wal", "-shm")

    @pytest.mark.posix_behaviour(
        "the invariant is that a ``?`` in the store's path is not read as a query, "
        "and a folder whose name holds a ``?`` is not a name Windows allows"
    )
    def test_a_root_whose_name_holds_a_uri_marker_still_gets_its_own_file(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """The URI is the authority, so a folder named ``we?ird`` must not misfire.

        Opened by URI so the ``mode=rw`` rule can hold, which means a path that
        is not encoded correctly becomes a query string: the store would open
        somewhere else while every sentence named this path.

        The ``?`` is the part that bites (SQLite splits a URI's query at the first
        one; a ``#`` it leaves alone), so the state this plants is one Windows
        cannot name — hence the marker rather than a Windows-side variant.
        """
        root = tmp_path / "we?ird #1"
        root.mkdir()
        monkeypatch.setattr(appdb, "PROJECT_ROOT", root)

        appdb.prepare()

        assert (root / "nojae.db").exists()
        assert appdb.version_of() == appdb.SCHEMA_VERSION
        with raw(root / "nojae.db", read_only=True) as conn:
            assert _tables(conn) == sorted(appdb.TABLE_NAMES)

    def test_the_module_spells_no_platform_path_and_no_home_expansion(self):
        """§4.9 as a guard rather than a sentence.

        The rule is that the path is *derived*, so what is pinned is the absence
        of every way to spell it by hand. Parsed rather than grepped, because
        the module's own docstring has to *name* the things it does not do.

        What would break the rule, each pinned: importing a platform answer,
        expanding a home directory, joining with a spelled separator, or
        spelling the filename with a separator in it (which is what a
        hand-written ``"src/../nojae.db"`` or a ``"~/"`` would look like).
        """
        tree = ast.parse(Path(appdb.__file__).read_text(encoding="utf-8"))

        imported: List[str] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported += [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.append(node.module)
        assert not [
            name
            for name in imported
            if name.split(".")[0] in {"platform", "ntpath", "posixpath"}
        ]

        calls = [ast.unparse(node) for node in ast.walk(tree) if isinstance(node, ast.Call)]
        assert not [call for call in calls if "expanduser" in call or "os.path.join" in call]

        # The filename is one word, so the join cannot smuggle a path in.
        assert "/" not in appdb.DB_FILENAME and "\\" not in appdb.DB_FILENAME
        assert not any("~" in name for name in (appdb.DB_FILENAME, *appdb.WAL_SIDECAR_SUFFIXES))


# -- the schema (§4.2) ---------------------------------------------------------

class TestTheSchema:
    def test_a_fresh_boot_creates_the_four_tables_at_the_current_level(
        self, store_root: Path
    ):
        result = appdb.prepare()

        assert result == {
            "created": True,
            "upgraded_from": None,
            "version": appdb.SCHEMA_VERSION,
            "path": str(store_root / "nojae.db"),
        }
        assert appdb.version_of() == appdb.SCHEMA_VERSION

    def test_the_file_holds_exactly_the_four_tables(self, store_root: Path):
        """No fifth table and no key/value bag (D5)."""
        appdb.prepare()
        with raw(store_root / "nojae.db", read_only=True) as conn:
            names = _tables(conn)
        assert names == sorted(appdb.TABLE_NAMES)
        assert names == ["agents", "models", "prompt_helpers", "servers"]

    def test_every_column_of_every_table_is_the_spec(self, store_root: Path):
        """Name, declared type and NOT NULL, read back from the file.

        The expected shape is written out here rather than derived from
        ``SCHEMA_STATEMENTS`` — a test that parsed the module's own text would
        pass while the file it created held something else.
        """
        appdb.prepare()
        with raw(store_root / "nojae.db", read_only=True) as conn:
            columns = {
                table: [
                    (row[1], row[2], bool(row[3]))
                    for row in conn.execute(f"PRAGMA table_info({table})")
                ]
                for table in appdb.TABLE_NAMES
            }

        assert columns == {
            "servers": [
                ("id", "INTEGER", False),
                ("name", "TEXT", True),
                ("url", "TEXT", True),
                ("api_key", "TEXT", True),
            ],
            "models": [
                ("id", "INTEGER", False),
                ("server_id", "INTEGER", True),
                ("name", "TEXT", True),
                ("sys_prompt", "TEXT", True),
                ("temperature", "REAL", False),
                ("top_p", "REAL", False),
                ("top_k", "INTEGER", False),
                ("min_p", "REAL", False),
                ("repeat_penalty", "REAL", False),
                ("presence_penalty", "REAL", False),
                ("reasoning", "TEXT", False),
                ("supports_vision", "INTEGER", True),
            ],
            "agents": [
                ("id", "TEXT", False),
                ("label", "TEXT", True),
                ("max_tool_iteration", "INTEGER", True),
                ("mcp_enable", "INTEGER", True),
                ("lsp_enable", "INTEGER", True),
                ("system_message", "TEXT", True),
                ("readonly", "INTEGER", True),
                ("model_id", "INTEGER", False),
            ],
            "prompt_helpers": [
                ("id", "INTEGER", False),
                ("color_code", "TEXT", True),
                ("content", "TEXT", True),
            ],
        }

    def test_the_stored_declarations_carry_both_on_delete_clauses(
        self, store_root: Path
    ):
        """``sqlite_master`` holds the DDL verbatim, so the clauses are checkable."""
        appdb.prepare()
        with raw(store_root / "nojae.db", read_only=True) as conn:
            ddl = {
                row[0]: row[1]
                for row in conn.execute(
                    "SELECT name, sql FROM sqlite_master WHERE type = 'table'"
                )
            }

        assert "REFERENCES servers(id) ON DELETE CASCADE" in ddl["models"]
        assert "REFERENCES models(id) ON DELETE SET NULL" in ddl["agents"]
        assert "UNIQUE (server_id, name)" in ddl["models"]
        assert "max_tool_iteration  INTEGER NOT NULL DEFAULT 25" in ddl["agents"]

    def test_the_two_unique_constraints_are_enforced(self, store_root: Path):
        """``servers.name`` alone, and ``models`` per ``(server_id, name)``."""
        appdb.prepare()
        with raw(store_root / "nojae.db") as conn:
            conn.execute("INSERT INTO servers (name, url) VALUES ('Local', 'http://a')")
            with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
                conn.execute(
                    "INSERT INTO servers (name, url) VALUES ('Local', 'http://b')"
                )

            server = conn.execute("SELECT id FROM servers").fetchone()[0]
            conn.execute(
                "INSERT INTO models (server_id, name) VALUES (?, 'gpt')", (server,)
            )
            with pytest.raises(sqlite3.IntegrityError, match="UNIQUE"):
                conn.execute(
                    "INSERT INTO models (server_id, name) VALUES (?, 'gpt')", (server,)
                )
            # The same name under another server is not a duplicate: the
            # constraint is per server, and a global one would make a second
            # provider's `gpt` impossible to add.
            conn.execute("INSERT INTO servers (name, url) VALUES ('Other', 'http://c')")
            other = conn.execute(
                "SELECT id FROM servers WHERE name = 'Other'"
            ).fetchone()[0]
            conn.execute(
                "INSERT INTO models (server_id, name) VALUES (?, 'gpt')", (other,)
            )
            assert conn.execute("SELECT count(*) FROM models").fetchone() == (2,)

    def test_the_nullable_samplers_keep_zero_and_not_set_apart(
        self, store_root: Path
    ):
        """The one column shape a request body depends on.

        A sampler that is absent is **omitted** from the body; one that is 0 is
        sent as 0. A ``NOT NULL`` or a ``DEFAULT 0`` would make the two the same
        row, and the difference would be lost on the way to the model.
        """
        appdb.prepare()
        with raw(store_root / "nojae.db") as conn:
            conn.execute("INSERT INTO servers (name, url) VALUES ('S', 'http://s')")
            server = conn.execute("SELECT id FROM servers").fetchone()[0]
            conn.execute(
                "INSERT INTO models (server_id, name, temperature, top_p) "
                "VALUES (?, 'zeroed', 0, 0)",
                (server,),
            )
            conn.execute(
                "INSERT INTO models (server_id, name) VALUES (?, 'absent')", (server,)
            )
            rows = {
                row[0]: row[1:]
                for row in conn.execute(
                    "SELECT name, temperature, top_p, top_k, min_p, repeat_penalty, "
                    "presence_penalty, reasoning FROM models"
                ).fetchall()
            }

        assert rows["zeroed"] == (0.0, 0.0, None, None, None, None, None)
        assert rows["absent"] == (None,) * 7

    def test_the_defaults_the_spec_gives_are_the_ones_the_file_holds(
        self, store_root: Path
    ):
        """An insert naming only the required columns gets the seeded values."""
        appdb.prepare()
        with raw(store_root / "nojae.db") as conn:
            conn.execute("INSERT INTO servers (name, url) VALUES ('S', 'http://s')")
            server = conn.execute("SELECT id FROM servers").fetchone()[0]
            conn.execute(
                "INSERT INTO models (server_id, name) VALUES (?, 'm')", (server,)
            )
            conn.execute("INSERT INTO agents (id, label) VALUES ('code', 'Code')")
            conn.execute("INSERT INTO prompt_helpers (color_code) VALUES ('#808080')")

            model = conn.execute(
                "SELECT sys_prompt, supports_vision FROM models"
            ).fetchone()
            agent = conn.execute(
                "SELECT max_tool_iteration, mcp_enable, lsp_enable, system_message, "
                "readonly, model_id FROM agents"
            ).fetchone()
            helper = conn.execute("SELECT content FROM prompt_helpers").fetchone()

        assert model == ("", 0)
        # 25 is D9's seeded cap; MCP on, LSP off, no persona, editable, and no
        # model — which is D7's "cannot run" state, reached by inserting nothing,
        # which is exactly why the composer warns before sending.
        assert agent == (25, 1, 0, "", 0, None)
        assert helper == ("",)

    def test_deleting_a_server_cascades_and_deleting_a_model_nulls_the_agent(
        self, store_root: Path
    ):
        """Both ``ON DELETE`` clauses, as behaviour and not as text."""
        appdb.prepare()
        with raw(store_root / "nojae.db") as conn:
            conn.execute("INSERT INTO servers (name, url) VALUES ('S', 'http://s')")
            server = conn.execute("SELECT id FROM servers").fetchone()[0]
            conn.execute(
                "INSERT INTO models (server_id, name) VALUES (?, 'm')", (server,)
            )
            model = conn.execute("SELECT id FROM models").fetchone()[0]
            conn.execute(
                "INSERT INTO agents (id, label, model_id) VALUES ('code', 'Code', ?)",
                (model,),
            )

            conn.execute("DELETE FROM models WHERE id = ?", (model,))
            assert conn.execute(
                "SELECT model_id FROM agents WHERE id = 'code'"
            ).fetchone() == (None,)
            # The persona outlived the model: that is the whole point of SET NULL.
            assert conn.execute("SELECT count(*) FROM agents").fetchone() == (1,)

            conn.execute("DELETE FROM servers WHERE id = ?", (server,))
            assert conn.execute("SELECT count(*) FROM models").fetchone() == (0,)
            assert conn.execute("SELECT count(*) FROM agents").fetchone() == (1,)

    def test_a_model_without_a_server_is_refused(self, store_root: Path):
        """``server_id NOT NULL REFERENCES`` — an orphan row is unrenderable."""
        appdb.prepare()
        with raw(store_root / "nojae.db") as conn:
            with pytest.raises(sqlite3.IntegrityError):
                conn.execute(
                    "INSERT INTO models (server_id, name) VALUES (999, 'm')"
                )

    def test_prompt_helpers_holds_any_number_of_rows(self, store_root: Path):
        """No count constraint (§4.5): the row count is the user's business."""
        appdb.prepare()
        with raw(store_root / "nojae.db") as conn:
            for index in range(20):
                conn.execute(
                    "INSERT INTO prompt_helpers (color_code, content) VALUES (?, ?)",
                    ("#808080", f"helper {index}"),
                )
            conn.execute("DELETE FROM prompt_helpers")
            assert conn.execute("SELECT count(*) FROM prompt_helpers").fetchone() == (0,)


# -- the version gate (D6) -----------------------------------------------------

class TestTheVersionGate:
    def test_an_empty_file_is_versioned_and_gets_the_schema(self, store_root: Path):
        """Level 0 is SQLite's answer for "a database with no schema".

        It is reachable for real: the create writes an empty file, so a boot
        killed between the create and the schema lands here. The next boot
        finishes the job rather than refusing its own half-made file.
        """
        (store_root / "nojae.db").touch()

        result = appdb.prepare()

        assert result["created"] is False
        assert result["upgraded_from"] == 0
        assert result["version"] == appdb.SCHEMA_VERSION
        assert appdb.version_of() == appdb.SCHEMA_VERSION
        with raw(store_root / "nojae.db", read_only=True) as conn:
            assert _tables(conn) == sorted(appdb.TABLE_NAMES)

    def test_an_older_level_is_upgraded_and_its_rows_survive(
        self, store_root: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """The upgrade branch, driven by a recorded step.

        ``SCHEMA_VERSION`` and ``UPGRADES`` are patched to a two-level world so
        the branch that runs on every future schema change is tested before
        there is a second level to test it with.
        """
        appdb.prepare()
        target = store_root / "nojae.db"
        with raw(target) as conn:
            conn.execute("INSERT INTO servers (name, url) VALUES ('S', 'http://s')")
            conn.execute("PRAGMA user_version = 1")

        monkeypatch.setattr(appdb, "SCHEMA_VERSION", 2)
        monkeypatch.setattr(
            appdb,
            "UPGRADES",
            {0: (), 1: ("CREATE TABLE IF NOT EXISTS scratch (x)",)},
        )

        result = appdb.prepare()

        assert result["upgraded_from"] == 1
        assert result["version"] == 2
        assert appdb.version_of() == 2
        with raw(target, read_only=True) as conn:
            assert conn.execute("SELECT name FROM servers").fetchone() == ("S",)
            assert conn.execute("SELECT count(*) FROM scratch").fetchone() == (0,)

    def test_an_upgrade_that_fails_changes_nothing(
        self, store_root: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """The whole migration is one transaction, so it is all or nothing.

        The recorded level and the schema it describes move together. A store
        left half-migrated is the expensive state: the next boot cannot tell
        which steps still have to run, and a step that must not run twice is a
        step nobody wants to reason about at boot time.
        """
        appdb.prepare()
        target = store_root / "nojae.db"
        with raw(target) as conn:
            conn.execute("INSERT INTO servers (name, url) VALUES ('S', 'http://s')")
            conn.execute("PRAGMA user_version = 1")
        before = digest(target)
        monkeypatch.setattr(appdb, "SCHEMA_VERSION", 3)
        monkeypatch.setattr(
            appdb,
            "UPGRADES",
            {
                0: (),
                1: ("CREATE TABLE IF NOT EXISTS first_step (x)",),
                2: ("CREATE TABLE first_step (x)",),  # the name is taken: fails
            },
        )

        with pytest.raises(appdb.AppStoreError, match="could not be brought"):
            appdb.prepare()

        assert appdb.version_of() == 1
        assert digest(target) == before
        with raw(target, read_only=True) as conn:
            # Neither the step that would have succeeded nor the row is touched.
            assert _tables(conn) == sorted(appdb.TABLE_NAMES)
            assert conn.execute("SELECT name FROM servers").fetchone() == ("S",)

    def test_a_level_with_no_upgrade_path_is_refused(
        self, store_root: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """Guessing at a schema this app has never seen is the refused thing."""
        appdb.prepare()
        with raw(store_root / "nojae.db") as conn:
            conn.execute("PRAGMA user_version = 1")
        monkeypatch.setattr(appdb, "SCHEMA_VERSION", 2)
        monkeypatch.setattr(appdb, "UPGRADES", {0: ()})

        with pytest.raises(appdb.AppStoreError, match="no upgrade path") as raised:
            appdb.prepare()

        assert str(store_root / "nojae.db") in str(raised.value)
        assert appdb.version_of() == 1

    def test_a_newer_file_is_refused_and_its_bytes_are_untouched(
        self, store_root: Path
    ):
        """D6's whole point: never read a newer schema with older rules."""
        appdb.prepare()
        target = store_root / "nojae.db"
        with raw(target) as conn:
            conn.execute("INSERT INTO servers (name, url) VALUES ('S', 'http://s')")
            conn.execute("INSERT INTO agents (id, label) VALUES ('code', 'Code')")
            conn.execute("PRAGMA user_version = 99")
        before = digest(target)

        with pytest.raises(appdb.AppStoreError) as raised:
            appdb.prepare()

        sentence = str(raised.value)
        assert str(target) in sentence
        assert "99" in sentence and str(appdb.SCHEMA_VERSION) in sentence
        assert digest(target) == before
        # And the refusal did not lose the rows: the file is still what it was.
        with raw(target, read_only=True) as conn:
            assert conn.execute("SELECT name FROM servers").fetchone() == ("S",)
            assert conn.execute("SELECT id FROM agents").fetchone() == ("code",)

    def test_a_second_boot_changes_nothing(self, store_root: Path):
        """Idempotence, and the reason the boot may run this every time.

        ``created`` is the one-shot gate the prompt-helper seeding hangs on
        (§4.3), so a second boot that answered ``created: True`` would refill
        rows the user deleted.
        """
        appdb.prepare()
        target = store_root / "nojae.db"
        before = digest(target)

        result = appdb.prepare()

        assert result["created"] is False
        assert result["upgraded_from"] is None
        assert result["version"] == appdb.SCHEMA_VERSION
        assert digest(target) == before

    def test_version_of_reads_without_touching(self, store_root: Path):
        appdb.prepare()
        target = store_root / "nojae.db"
        before = digest(target)

        assert appdb.version_of() == appdb.SCHEMA_VERSION
        assert digest(target) == before


# -- an unusable store is a named state (§4.3) ---------------------------------

class TestAnUnusableStoreIsNamed:
    def test_a_directory_in_the_files_place_names_the_path(self, store_root: Path):
        target = store_root / "nojae.db"
        target.mkdir()

        with pytest.raises(appdb.AppStoreError) as raised:
            appdb.prepare()

        assert str(target) in str(raised.value)

    def test_a_missing_parent_folder_names_the_path(
        self, store_root: Path, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(appdb, "PROJECT_ROOT", store_root / "not-created")

        with pytest.raises(appdb.AppStoreError) as raised:
            appdb.prepare()

        assert str(store_root / "not-created" / "nojae.db") in str(raised.value)

    @pytest.mark.posix_behaviour(
        "the invariant is that an unreadable file is reported, which needs chmod"
    )
    def test_an_unreadable_file_names_the_path(self, store_root: Path):
        appdb.prepare()
        target = store_root / "nojae.db"
        target.chmod(0o000)
        try:
            with pytest.raises(appdb.AppStoreError) as raised:
                appdb.prepare()
            assert str(target) in str(raised.value)
        finally:
            target.chmod(0o600)

    def test_a_file_that_is_not_a_database_names_the_path(self, store_root: Path):
        """The state a hand-edited or misnamed file reaches: reported, not repaired."""
        target = store_root / "nojae.db"
        target.write_text("not a database at all\n" * 40, encoding="utf-8")
        before = digest(target)

        with pytest.raises(appdb.AppStoreError) as raised:
            appdb.prepare()

        assert str(target) in str(raised.value)
        assert digest(target) == before

    def test_one_error_type_reports_every_unusable_state(self, store_root: Path):
        """Task 02's boot wraps exactly this type to keep the app up.

        A second failure type would be a boot that dies on the path nobody
        thought of, so every entry point answers the same one.
        """
        (store_root / "nojae.db").mkdir()
        for call in (appdb.prepare, appdb.connect, appdb.version_of, appdb.connection):
            with pytest.raises(appdb.AppStoreError):
                call()

        assert issubclass(appdb.AppStoreError, Exception)
        # Not a ``sqlite3`` subclass: a caller that caught the driver's errors
        # would catch a lock raised inside a query too, which is a different
        # question from "the store cannot be used at all".
        assert not issubclass(appdb.AppStoreError, sqlite3.Error)


# -- the connection (§4.1) -----------------------------------------------------

class TestTheConnection:
    def test_connect_never_creates_the_file(self, store_root: Path):
        """A read must not leave a store behind, or "there is none yet" is lost."""
        target = store_root / "nojae.db"

        with pytest.raises(appdb.AppStoreError):
            appdb.connect()

        assert not target.exists()

    def test_the_file_is_wal_after_the_boot_that_made_it(self, store_root: Path):
        """Persistent, so a later handle that forgot to ask still gets WAL.

        Asked of a raw connection: the module's own pragma would answer WAL
        because the module set it, which is not the question.
        """
        appdb.prepare()
        with raw(store_root / "nojae.db") as conn:
            assert conn.execute("PRAGMA journal_mode").fetchone() == ("wal",)

    def test_every_handle_carries_the_busy_timeout_and_foreign_keys(
        self, store_root: Path
    ):
        appdb.prepare()
        conn = appdb.connect()
        try:
            assert conn.execute("PRAGMA busy_timeout").fetchone() == (
                appdb.BUSY_TIMEOUT_MS,
            )
            assert conn.execute("PRAGMA foreign_keys").fetchone() == (1,)
        finally:
            conn.close()

    def test_a_handle_is_autocommit_so_a_read_takes_no_lock(self, store_root: Path):
        """``isolation_level=None``: a write is exactly the BEGIN the caller asked for.

        The observable half is that a plain ``SELECT`` leaves the handle with no
        transaction open, so it holds no read lock afterwards — which is what
        keeps a chat worker's read from delaying a save.
        """
        appdb.prepare()
        conn = appdb.connect()
        try:
            conn.execute("SELECT count(*) FROM servers").fetchone()
            assert not conn.in_transaction
            conn.execute("BEGIN IMMEDIATE")
            assert conn.in_transaction
            conn.execute("COMMIT")
            assert not conn.in_transaction
        finally:
            conn.close()

    def test_connection_is_one_handle_per_thread(self, store_root: Path):
        """The thread-local seam: same thread same handle, different thread new one.

        A ``sqlite3`` handle is not shareable, so a cached handle handed to two
        threads is the bug this pins out — and the reason the app's shape (a
        request thread plus a chat worker) needs WAL.
        """
        appdb.prepare()
        main = appdb.connection()
        assert appdb.connection() is main

        seen: Dict[str, object] = {}

        def worker() -> None:
            seen["handle"] = appdb.connection()
            seen["again"] = appdb.connection()
            appdb.close_thread_connection()

        thread = threading.Thread(target=worker)
        thread.start()
        thread.join(timeout=10)

        assert seen["again"] is seen["handle"]
        assert seen["handle"] is not main

    def test_close_thread_connection_is_safe_without_one(self, store_root: Path):
        """A thread that never touched the store still runs its teardown."""
        appdb.close_thread_connection()
        appdb.close_thread_connection()

    def test_a_moved_root_moves_the_cached_handle(
        self, store_root: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """The one way a per-thread handle could outlive what it caches.

        A handle is opened *at* a path, so a path that moved makes the handle
        wrong rather than merely old: keeping it would answer from the file the
        store used to be. The suite moves the store by patching the root, so this
        is also what keeps one test's handle from answering another's.
        """
        appdb.prepare()
        first = appdb.connection()

        other = tmp_path / "other-install"
        other.mkdir()
        monkeypatch.setattr(appdb, "PROJECT_ROOT", other)
        appdb.prepare()
        second = appdb.connection()

        assert second is not first
        # The new handle answers from the new file, not the old one.
        assert second.execute("SELECT count(*) FROM servers").fetchone() == (0,)
        with raw(store_root / "nojae.db") as conn:
            conn.execute("INSERT INTO servers (name, url) VALUES ('S', 'http://s')")
        assert second.execute("SELECT count(*) FROM servers").fetchone() == (0,)
        # And the old one is closed rather than left pointing at the previous
        # store: a thread's handle is its own, and a moved path makes it wrong.
        with pytest.raises(sqlite3.ProgrammingError):
            first.execute("SELECT count(*) FROM servers")

    def test_a_reader_proceeds_while_a_writer_holds_the_lock(self, store_root: Path):
        """§4.10's thread-safety test, and the reason WAL is on.

        One thread holds an open write transaction — the request thread saving
        the settings — while another reads, which is the chat worker resolving
        the connection for a turn. With rollback journaling this is
        ``database is locked``; here the reader answers, and answers with the
        store as it was before the uncommitted write.
        """
        appdb.prepare()
        with raw(store_root / "nojae.db") as seed:
            seed.execute("INSERT INTO servers (name, url) VALUES ('S', 'http://s')")

        errors: List[BaseException] = []
        read: List[Tuple[object, ...]] = []
        holding = threading.Event()
        release = threading.Event()

        def write() -> None:
            # Each handle is opened by the thread that uses it: that is the
            # thread-local rule, and the driver enforces it.
            writer = appdb.connect()
            try:
                writer.execute("BEGIN IMMEDIATE")
                writer.execute(
                    "INSERT INTO servers (name, url) VALUES ('Second', 'http://b')"
                )
                holding.set()
                if not release.wait(timeout=10):  # pragma: no cover - test scaffolding
                    raise AssertionError("the reader never finished")
                writer.execute("COMMIT")
            except BaseException as exc:  # noqa: BLE001 - reported to the test
                errors.append(exc)
                holding.set()  # so the reader is never left waiting
            finally:
                writer.close()

        thread = threading.Thread(target=write)
        thread.start()
        reader = appdb.connect()
        try:
            assert holding.wait(timeout=10), "the writer never got its lock"
            try:
                read.append(reader.execute("SELECT count(*) FROM servers").fetchone())
            except BaseException as exc:  # noqa: BLE001 - reported to the test
                errors.append(exc)
        finally:
            release.set()
            thread.join(timeout=10)
            reader.close()

        assert errors == []
        # The uncommitted row is invisible: the reader saw the store as it was.
        assert read == [(1,)]

    def test_a_second_writer_waits_for_the_first_rather_than_failing(
        self, store_root: Path
    ):
        """The busy timeout's own case: two browser tabs saving at once.

        The first writer holds the lock briefly and releases it; the second must
        wait it out and write, not answer ``database is locked``.
        """
        appdb.prepare()
        holding = threading.Event()
        release = threading.Event()
        errors: List[BaseException] = []

        def hold_the_lock() -> None:
            first = appdb.connect()  # opened by the thread that uses it
            try:
                first.execute("BEGIN IMMEDIATE")
                first.execute(
                    "INSERT INTO servers (name, url) VALUES ('First', 'http://a')"
                )
                holding.set()
                release.wait(timeout=10)
                first.execute("COMMIT")
            except BaseException as exc:  # noqa: BLE001 - reported to the test
                errors.append(exc)
                holding.set()
            finally:
                first.close()

        thread = threading.Thread(target=hold_the_lock)
        thread.start()
        second = appdb.connect()
        waited: Optional[float] = None
        try:
            assert holding.wait(timeout=10), "the first writer never got its lock"
            # The lock is released a moment *after* the second writer starts
            # waiting, never before: the timer is armed once the attempt is
            # already under way, so the wait measured is the busy timeout doing
            # its job and not a lock that happened to be free.
            started = time.monotonic()
            timer = threading.Timer(0.4, release.set)
            timer.start()
            try:
                second.execute("BEGIN IMMEDIATE")
                second.execute(
                    "INSERT INTO servers (name, url) VALUES ('Second', 'http://b')"
                )
                second.execute("COMMIT")
            except BaseException as exc:  # noqa: BLE001 - reported to the test
                errors.append(exc)
            finally:
                timer.cancel()
            waited = time.monotonic() - started
        finally:
            release.set()
            thread.join(timeout=10)
            second.close()

        assert errors == []
        # Well under the 5s timeout, and long enough that the second writer can
        # only have got here by waiting: a handle that never asked for the
        # timeout would have raised ``database is locked`` instead.
        assert waited is not None and 0.3 <= waited < 2.0, (
            f"the second writer's wait was not the busy timeout ({waited})"
        )
        with raw(store_root / "nojae.db", read_only=True) as conn:
            assert conn.execute("SELECT count(*) FROM servers").fetchone() == (2,)


# -- the module's own boundaries ----------------------------------------------

class TestTheModuleBoundary:
    def test_nothing_else_in_the_app_writes_sql(self):
        """§4.1 as a guard: this module owns the database, so it owns the SQL.

        A second module that imports ``sqlite3`` is a second place that knows the
        schema, and the version gate stops meaning anything the moment a reader
        can bypass it. Parsed, not grepped, so a docstring that mentions the
        driver does not trip it and a function-local import does not pass it.
        """
        speakers: List[str] = []
        for folder in ("src", "mcp_connectors", "lsp_connectors"):
            for path in sorted((REPO_ROOT / folder).rglob("*.py")):
                if "__pycache__" in path.parts:
                    continue
                names: List[str] = []
                for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
                    if isinstance(node, ast.Import):
                        names += [alias.name for alias in node.names]
                    elif isinstance(node, ast.ImportFrom) and node.module:
                        names.append(node.module)
                if any(name == "sqlite3" or name.startswith("sqlite3.") for name in names):
                    speakers.append(str(path.relative_to(REPO_ROOT)))
        assert speakers == [str(Path("src") / "core" / "appdb.py")]

    def test_the_store_module_touches_no_http_layer(self):
        """AGENTS.md: core never touches FastAPI, and nothing under ``core`` imports the API layer."""
        names: List[str] = []
        for node in ast.walk(ast.parse(Path(appdb.__file__).read_text(encoding="utf-8"))):
            if isinstance(node, ast.Import):
                names += [alias.name for alias in node.names]
            elif isinstance(node, ast.ImportFrom) and node.module:
                names.append(node.module)
        assert not [
            name for name in names if name.split(".")[0] in {"fastapi", "src.api"}
        ]

    def test_no_function_takes_a_path_to_the_database(self):
        """§4.1: no core function accepts a path to the database.

        The one seam that points the store somewhere is the module attribute the
        tests patch. A parameter would let a caller read a database the install
        does not own, and would make that convention a lie.

        Only the public surface is meant: the private helpers that *format* a
        path it was handed (`_describe`, `_uri_quote`) are not a way to redirect
        the store, because nothing outside the module can call them.
        """
        tree = ast.parse(Path(appdb.__file__).read_text(encoding="utf-8"))
        offenders = []
        for node in ast.walk(tree):
            if not isinstance(node, ast.FunctionDef) or node.name.startswith("_"):
                continue
            arguments = list(node.args.args) + list(node.args.kwonlyargs)
            if any("path" in str(argument.arg).lower() for argument in arguments):
                offenders.append(node.name)
        assert offenders == []
        # And the two that *answer* a path take no argument either.
        assert appdb.database_path.__code__.co_argcount == 0
        assert appdb.sidecar_paths.__code__.co_argcount == 0
        assert appdb.version_of.__code__.co_argcount == 0
        assert appdb.connect.__code__.co_argcount == 0
        assert appdb.prepare.__code__.co_argcount == 0

    def test_the_store_module_is_the_only_one_that_names_the_file(self):
        """The path is this module's to hand out, so it is its to spell.

        A second module that wrote ``nojae.db`` into its own constant would be a
        second answer to "where is the store", and the two drift the moment one
        of them is patched by a test.

        The two policy modules are the named exception, and they are named rather
        than absent: the store's invisibility rules (D10) have to spell the name
        to hide it, in the app's level-A rules and in the connectors' deny-list.
        Those are rules *about* a name, not a lookup of one — which is exactly
        why they must not be reached through ``appdb``, and why the name is
        spelled there instead.
        """
        allowed = {
            str(Path("src") / "core" / "editorfs" / "builtin_policy.py"),
            str(Path("mcp_connectors") / "path_policy.py"),
        }
        spellers: List[str] = []
        for folder in ("src", "mcp_connectors", "lsp_connectors"):
            for path in sorted((REPO_ROOT / folder).rglob("*.py")):
                if "__pycache__" in path.parts or path.name == "appdb.py":
                    continue
                if str(path.relative_to(REPO_ROOT)) in allowed:
                    continue
                tree = ast.parse(path.read_text(encoding="utf-8"))
                literals = [
                    node.value
                    for node in ast.walk(tree)
                    if isinstance(node, ast.Constant) and isinstance(node.value, str)
                ]
                if any(appdb.DB_FILENAME in str(value) for value in literals):
                    spellers.append(str(path.relative_to(REPO_ROOT)))
        assert spellers == []
