"""appdb-02 — seeding, and a boot that survives an unusable store.

Boot brings the store up and populates it: open-or-create → schema at the current
level, upgrade, or refuse → seed (§4.3). Nothing reads the store for a model call
yet (that is task 03 onward), so what this suite tests is the seeding pass and the
boot contract, in the order the spec states them:

* **the four built-in agents** are inserted when absent, with ``model_id`` null,
  capped at 25 except the app-owned agent, which is capped at 500 (D9), and only
  ``todoBuilder`` is ``readonly`` (D4) — and their text is the module that holds
  the personas today, read rather than copied, including the **generated**
  lot-conventions block;
* **a `readonly` row is re-asserted from code** on every boot for every column
  except ``model_id``, which is what makes re-seeding safe rather than destructive
  (D4) — and an editable row is left alone, because overwriting it would undo a
  save the app promised to keep;
* **the nine prompt-helper rows land when the database is created and never
  again** — the gate is the exclusive create (or a zero-byte file an interrupted
  first boot left), not "is the table empty", so a delete the user made is still
  a delete on the next boot (D12);
* **servers and models are never seeded**: no example server, no placeholder key,
  no placeholder URL (§4.3);
* **an unusable store is a named state**: the boot answers a sentence naming the
  path instead of raising, the app still starts, and the state stays answerable
  after the boot that found it.

Hermeticity: every test runs against a database under its own ``tmp_path``, by
patching ``appdb.PROJECT_ROOT`` — the one value the whole module's path answers
come from. The real ``<install root>/nojae.db`` is never opened.
"""

import contextlib
import os
import sqlite3
from pathlib import Path
from typing import Any, Dict, Iterator, List, Tuple

import pytest
from fastapi.testclient import TestClient

from src.core import appdb
from src.core import agent_modes_defaults as defaults

#: The four built-in ids, in the order they are seeded — which is also the
#: dropdown's order (§4.4: insertion order, app-owned agent last).
BUILT_IN_IDS: Tuple[str, ...] = ("chat", "code", "architect", "todoBuilder")

AGENT_COLUMNS = (
    "id",
    "label",
    "max_tool_iteration",
    "mcp_enable",
    "lsp_enable",
    "system_message",
    "readonly",
    "model_id",
)


# -- the fixtures ---------------------------------------------------------------

@pytest.fixture
def store_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """An install root whose ``nojae.db`` does not exist yet."""
    root = tmp_path / "install"
    root.mkdir()
    monkeypatch.setattr(appdb, "PROJECT_ROOT", root)
    yield root
    appdb.close_thread_connection()


@pytest.fixture
def seeded(store_root: Path) -> Path:
    """An install root that has been booted once."""
    result = appdb.boot()
    assert result["state"] == "ok", result["sentence"]
    return store_root


def raw(path: Path, read_only: bool = False) -> sqlite3.Connection:
    """A connection that is **not** the module's — for asking what the file holds.

    Foreign keys are on because the tests plant a real ``model_id`` on a row, and
    a handle that left them off would let a dangling reference through and report
    the row as damaged when it is not.
    """
    conn = sqlite3.connect(
        path.as_uri() + ("?mode=ro" if read_only else ""), uri=True
    )
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def agents(path: Path) -> List[Tuple[Any, ...]]:
    """Every agent row, in the columns this suite reasons about."""
    conn = raw(path, read_only=True)
    try:
        return conn.execute(
            f"SELECT {', '.join(AGENT_COLUMNS)} FROM agents ORDER BY rowid"
        ).fetchall()
    finally:
        conn.close()


def counts(path: Path) -> Dict[str, int]:
    """How many rows each table holds."""
    conn = raw(path, read_only=True)
    try:
        return {
            table: conn.execute(f"SELECT count(*) FROM {table}").fetchone()[0]
            for table in appdb.TABLE_NAMES
        }
    finally:
        conn.close()


def helper_rows(path: Path) -> List[Tuple[str, str]]:
    conn = raw(path, read_only=True)
    try:
        return conn.execute(
            "SELECT color_code, content FROM prompt_helpers ORDER BY id"
        ).fetchall()
    finally:
        conn.close()


# -- the first boot -------------------------------------------------------------

class TestTheFirstBoot:
    def test_a_first_boot_creates_the_store_and_reports_it(self, store_root: Path):
        result = appdb.boot()

        assert result["state"] == "ok"
        assert result["sentence"] is None
        assert result["created"] is True
        assert result["upgradedFrom"] is None
        assert result["version"] == appdb.SCHEMA_VERSION
        assert result["path"] == str(store_root / "nojae.db")
        assert (store_root / "nojae.db").is_file()

    def test_the_four_built_in_agents_are_seeded_in_order(self, seeded: Path):
        rows = agents(seeded / "nojae.db")

        assert [row[0] for row in rows] == list(BUILT_IN_IDS)
        # Only the app-owned agent is readonly (D4), and none of them has a model:
        # the seeder cannot know which model the user will configure, and inventing
        # one is what D5 refuses.
        assert [row[6] for row in rows] == [0, 0, 0, 1]
        assert all(row[7] is None for row in rows)

    def test_the_editable_built_ins_are_seeded_with_the_cap_of_25(self, seeded: Path):
        """D9: the number the app defaulted to until now, so a fresh install
        behaves exactly as it did before the column existed."""
        rows = {row[0]: row for row in agents(seeded / "nojae.db")}
        for agent_id in ("chat", "code", "architect"):
            assert rows[agent_id][2] == 25, agent_id
        assert appdb.SEEDED_MAX_TOOL_ITERATION == 25

    def test_the_app_owned_agent_is_seeded_with_the_cap_of_500(self, seeded: Path):
        """A lot-building turn writes a whole folder of task files, so the cap a
        chat agent is content with would stop it mid-lot.

        Asserted as **the app-owned row only**: the three editable built-ins keep
        the number above, and a user-created agent keeps it too (task 10's
        ``/api/agents/add`` default), because 500 is this agent's job's number,
        not a new global default.
        """
        rows = {row[0]: row for row in agents(seeded / "nojae.db")}
        assert rows["todoBuilder"][2] == 500
        assert appdb.SEEDED_RESERVED_MAX_TOOL_ITERATION == 500

    def test_the_hub_flags_are_the_modes_own(self, seeded: Path):
        """The seeder reads the definitions; it does not restate their flags."""
        expected = {
            mode.id: (mode.mcptools, mode.lsptools)
            for mode in [*defaults.default_modes(), defaults.todo_builder_mode()]
        }
        assert {
            row[0]: (bool(row[3]), bool(row[4]))
            for row in agents(seeded / "nojae.db")
        } == expected

    def test_the_labels_are_the_modes_own(self, seeded: Path):
        expected = {
            mode.id: mode.label
            for mode in [*defaults.default_modes(), defaults.todo_builder_mode()]
        }
        assert {row[0]: row[1] for row in agents(seeded / "nojae.db")} == expected

    def test_the_persona_text_is_read_from_the_module_that_holds_it(
        self, seeded: Path
    ):
        """The personas stay in ``agent_modes_defaults`` — the seeder reads them.

        Asserted as **equality with that module**, not as a length or a substring:
        a copy that drifts by a line is the failure this feature exists to avoid,
        and the module's stated reason for existing (the fallback and the seeded
        path share one definition) is unchanged by the move.
        """
        rows = {row[0]: row[5] for row in agents(seeded / "nojae.db")}
        for mode in defaults.default_modes():
            assert rows[mode.id] == mode.system_message

    def test_the_lot_conventions_block_rides_in_the_reserved_row(self, seeded: Path):
        """The generated block has exactly one home: the row is refreshed from it.

        ``todoBuilder``'s instructions are rendered from :mod:`core.batch`'s live
        constants, so a second copy in the database would be a rule that can go
        stale — which is the reason D4 makes code the source of truth for that row.
        """
        row = next(
            row for row in agents(seeded / "nojae.db") if row[0] == "todoBuilder"
        )
        persona = defaults.todo_builder_persona()
        conventions = defaults.lot_conventions_block()

        assert persona in row[5]
        assert conventions in row[5]
        assert row[5].startswith(persona)
        assert row[5].endswith(conventions)

    def test_nine_empty_gray_helper_rows_land_on_creation(self, seeded: Path):
        """The starting state a first boot draws today, so the move is invisible."""
        assert helper_rows(seeded / "nojae.db") == [
            (appdb.SEEDED_PROMPT_HELPER_COLOR, "")
        ] * appdb.SEEDED_PROMPT_HELPER_COUNT
        assert appdb.SEEDED_PROMPT_HELPER_COUNT == 9
        assert appdb.SEEDED_PROMPT_HELPER_COLOR == "#808080"

    def test_no_server_and_no_model_is_ever_seeded(self, seeded: Path):
        """§4.3: a value that cannot be dialled must not be inserted to be dialled."""
        assert counts(seeded / "nojae.db") == {
            "servers": 0,
            "models": 0,
            "agents": 4,
            "prompt_helpers": 9,
        }

    def test_the_seeded_values_are_the_values_the_app_still_uses(self):
        """The literals here are copies **by necessity**, so they are pinned.

        ``appdb`` names the helper count, the helper colour and the tool-loop cap
        itself rather than importing them: :mod:`core.prompt_helpers` reads these
        rows *through* ``appdb``, so a module-level import in either direction
        would be a cycle. That is a good reason to duplicate the values and a bad
        reason to let them drift — a store seeded in one colour while the bullet
        row falls back to another is a mismatch nobody notices until a user does,
        and a cap seeded away from ``DEFAULT_MAX_TOOL_ITERATION`` would change a
        fresh install's behaviour, which §4.3 says it must not.

        The **count** is pinned to no one (appdb-07): the file's ``SLOT_COUNT``
        went with the file, because a row is a bullet and the count is the user's
        business (§4.5). Nine is the store's own starting layout — what makes a
        first boot look exactly like the old one — and the test above asserts it
        as rows, which is the only authority left for it.

        Asserted here, in a test, so the coupling is checked without either
        module importing the other.
        """
        from src import config as config_module
        from src.core import prompt_helpers

        assert appdb.SEEDED_PROMPT_HELPER_COLOR == prompt_helpers.DEFAULT_COLOR
        assert appdb.SEEDED_MAX_TOOL_ITERATION == (
            config_module.DEFAULT_MAX_TOOL_ITERATION
        )


# -- the second boot ------------------------------------------------------------

class TestASecondBootChangesNothing:
    def test_the_agents_are_never_duplicated(self, seeded: Path):
        first = agents(seeded / "nojae.db")

        result = appdb.boot()

        assert result["created"] is False
        assert result["state"] == "ok"
        assert agents(seeded / "nojae.db") == first

    def test_the_helper_rows_are_not_refilled(self, seeded: Path):
        """The one-shot gate is the create, so a second boot writes nothing."""
        appdb.boot()
        assert len(helper_rows(seeded / "nojae.db")) == 9

    def test_the_gate_is_the_creation_and_not_an_empty_table(self, store_root: Path):
        """The distinction D12 turns on, stated as a test.

        ``prepare()`` alone makes the file and lays the schema down, so the next
        boot finds a store that **exists** and is **empty**. A seeder that asked
        "is the table empty" would fill these nine rows; the one that asks "did
        this boot create the file" does not, which is the same answer a user's
        delete gets.
        """
        appdb.prepare()

        result = appdb.boot()

        assert result["created"] is False
        assert result["promptHelpers"] == 0
        assert helper_rows(store_root / "nojae.db") == []

    def test_a_zero_byte_interrupted_first_boot_still_gets_the_helpers(
        self, store_root: Path
    ):
        """A boot killed between the create and the schema leaves an empty file.

        It is "existing" to ``prepare``, but it holds no user data: the next boot
        is still a first boot and seeds the helper rows.
        """
        (store_root / "nojae.db").touch()

        result = appdb.boot()

        assert result["created"] is False
        assert result["promptHelpers"] == appdb.SEEDED_PROMPT_HELPER_COUNT
        assert len(helper_rows(store_root / "nojae.db")) == (
            appdb.SEEDED_PROMPT_HELPER_COUNT
        )

    def test_a_deleted_helper_row_stays_deleted(self, seeded: Path):
        """A table that is empty afterwards is a choice the user made (D12)."""
        target = seeded / "nojae.db"
        conn = raw(target)
        conn.execute("DELETE FROM prompt_helpers")
        conn.commit()
        conn.close()

        result = appdb.boot()

        assert result["promptHelpers"] == 0
        assert helper_rows(target) == []

    def test_a_readonly_row_is_re_asserted_and_its_model_survives(self, seeded: Path):
        """D4 in both halves: code owns every column except ``model_id``.

        The row is damaged by hand — label, persona, cap and hub flags all
        changed, and ``readonly`` itself cleared — and a model association is
        planted, because that is the one column the user owns. After the boot the
        definition answers every damaged column, ``readonly`` is back to 1 (code
        is the source of truth for that column too, so a hand-corrupted 0 is
        re-asserted rather than obeyed), and the model is still the one planted.
        """
        target = seeded / "nojae.db"
        conn = raw(target)
        conn.execute("INSERT INTO servers (name, url) VALUES ('S', 'http://s')")
        server = conn.execute("SELECT id FROM servers").fetchone()[0]
        conn.execute(
            "INSERT INTO models (server_id, name) VALUES (?, 'kept')", (server,)
        )
        model = conn.execute("SELECT id FROM models").fetchone()[0]
        conn.execute(
            "UPDATE agents SET label = 'damaged', max_tool_iteration = 3, "
            "mcp_enable = 0, lsp_enable = 1, system_message = 'gone', "
            "readonly = 0, model_id = ? WHERE id = 'todoBuilder'",
            (model,),
        )
        conn.commit()
        conn.close()

        result = appdb.boot()

        assert result["agents"]["reasserted"] == 1
        assert result["agents"]["inserted"] == 0
        row = next(row for row in agents(target) if row[0] == "todoBuilder")
        assert row[1] == defaults.TODO_BUILDER_LABEL
        assert row[2] == appdb.SEEDED_RESERVED_MAX_TOOL_ITERATION
        assert (row[3], row[4]) == (1, 0)
        assert row[6] == 1
        assert defaults.todo_builder_persona() in row[5]
        assert defaults.lot_conventions_block() in row[5]
        assert row[7] == model

    def test_an_editable_row_is_left_alone(self, seeded: Path):
        """The other half of D4, and the half that keeps re-seeding non-destructive.

        ``chat`` is a built-in the user *may* edit, so a boot that re-asserted it
        would overwrite a persona the app had promised to keep — which is what
        "no write destroys bytes" means for a row.
        """
        target = seeded / "nojae.db"
        conn = raw(target)
        conn.execute(
            "UPDATE agents SET label = 'My chat', system_message = 'mine', "
            "max_tool_iteration = 3, mcp_enable = 1, lsp_enable = 1 "
            "WHERE id = 'chat'"
        )
        conn.commit()
        conn.close()

        result = appdb.boot()

        assert result["agents"] == {"inserted": 0, "reasserted": 1}
        row = next(row for row in agents(target) if row[0] == "chat")
        assert (row[1], row[2], row[3], row[4], row[5]) == (
            "My chat",
            3,
            1,
            1,
            "mine",
        )

    def test_a_built_in_the_user_deleted_comes_back(self, seeded: Path):
        """Inserted **when absent**, so the built-ins cannot be lost.

        No route can delete one (D4, task 10), but the row is a row, and the
        pass that re-checks every boot is what makes "built-ins cannot be
        deleted" a property of the store rather than of one route.
        """
        target = seeded / "nojae.db"
        conn = raw(target)
        conn.execute("DELETE FROM agents WHERE id = 'code'")
        conn.commit()
        conn.close()

        result = appdb.boot()

        assert result["agents"]["inserted"] == 1
        rows = {row[0]: row for row in agents(target)}
        assert set(rows) == set(BUILT_IN_IDS)
        # The row comes back as a **fresh** one, not as a repaired copy of the
        # deleted one: cap 25, no model, and the definition's own persona.
        assert (rows["code"][2], rows["code"][7]) == (25, None)
        assert rows["code"][5] == next(
            mode.system_message
            for mode in defaults.default_modes()
            if mode.id == "code"
        )
        # Insertion order is what the dropdown answers from (§4.4), so a restored
        # built-in lands last — the honest consequence of "no new column", and
        # worth pinning so a later task that sorts the list notices it changed.
        assert [row[0] for row in agents(target)] == [
            "chat",
            "architect",
            "todoBuilder",
            "code",
        ]

    def test_a_second_boot_writes_nothing_at_all(self, seeded: Path):
        """Idempotence, measured by the file rather than by the answer."""
        target = seeded / "nojae.db"
        conn = raw(target)
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.commit()
        conn.close()
        before = target.read_bytes()

        appdb.boot()

        assert target.read_bytes() == before


# -- an unusable store is a named state ----------------------------------------

class TestABootThatCannotUseTheStore:
    def test_a_file_that_is_not_a_database_is_reported_not_repaired(
        self, store_root: Path
    ):
        target = store_root / "nojae.db"
        target.write_text("not a database at all\n" * 40, encoding="utf-8")

        result = appdb.boot()

        assert result["state"] == "unusable"
        assert str(target) in result["sentence"]
        assert target.read_text(encoding="utf-8").startswith("not a database")
        assert result["agents"] == {"inserted": 0, "reasserted": 0}
        assert result["promptHelpers"] == 0

    def test_a_directory_in_the_files_place_is_reported(self, store_root: Path):
        target = store_root / "nojae.db"
        target.mkdir()

        result = appdb.boot()

        assert result["state"] == "unusable"
        assert str(target) in result["sentence"]

    def test_a_root_that_cannot_be_created_is_reported(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        """The install root itself is missing: the boot says so, it does not die."""
        missing = tmp_path / "not-created" / "install"
        monkeypatch.setattr(appdb, "PROJECT_ROOT", missing)

        result = appdb.boot()

        assert result["state"] == "unusable"
        assert str(missing / "nojae.db") in result["sentence"]

    def test_a_too_new_file_is_refused_and_untouched(self, seeded: Path):
        """D6's refusal reaches the boot as the same named state."""
        target = seeded / "nojae.db"
        conn = raw(target)
        conn.execute("INSERT INTO servers (name, url) VALUES ('S', 'http://s')")
        conn.execute("PRAGMA user_version = 99")
        conn.commit()
        conn.close()
        before = target.read_bytes()

        result = appdb.boot()

        assert result["state"] == "unusable"
        assert "99" in result["sentence"]
        assert target.read_bytes() == before
        conn = raw(target, read_only=True)
        try:
            assert conn.execute("SELECT name FROM servers").fetchone() == ("S",)
        finally:
            conn.close()

    @pytest.mark.posix_behaviour(
        "the invariant is that an unwritable store is reported, which needs chmod"
    )
    def test_an_unwritable_store_is_reported(self, store_root: Path):
        """The file is there and the app may not touch it — a named state, not an
        empty store."""
        appdb.boot()
        target = store_root / "nojae.db"
        target.chmod(0o000)
        try:
            result = appdb.boot()
        finally:
            target.chmod(0o600)

        assert result["state"] == "unusable"
        assert str(target) in result["sentence"]

    def test_boot_never_raises_whatever_is_wrong(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        """The contract the task states in one case per unusable shape.

        A second failure type escaping here is a boot that dies on the path
        nobody thought of, so this is asserted over every state the module can
        find — including the one a caller cannot produce by hand (a store whose
        schema is there but whose seed cannot land, forced below).
        """
        cases: List[Path] = []

        directory = tmp_path / "a"
        directory.mkdir()
        (directory / "nojae.db").mkdir()
        cases.append(directory)

        not_a_db = tmp_path / "b"
        not_a_db.mkdir()
        (not_a_db / "nojae.db").write_text("x\n" * 40, encoding="utf-8")
        cases.append(not_a_db)

        cases.append(tmp_path / "c" / "missing")

        for root in cases:
            monkeypatch.setattr(appdb, "PROJECT_ROOT", root)
            assert appdb.boot()["state"] == "unusable"

    def test_a_store_that_cannot_be_seeded_is_still_a_named_state(
        self, store_root: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """The schema is fine and the seed cannot land: reported, not fatal.

        Forced by making the definitions unresolvable — the state a broken
        install reaches. What matters is the answer: the boot says the store is
        unusable with the path in the sentence, and the app that caught nothing
        would have died here.
        """
        def broken() -> List[Dict[str, Any]]:
            raise RuntimeError("the built-in definitions are unreachable")

        monkeypatch.setattr(appdb, "_agent_definitions", broken)

        result = appdb.boot()

        assert result["state"] == "unusable"
        assert str(store_root / "nojae.db") in result["sentence"]
        assert "seeded" in result["sentence"]
        # And the schema it did reach is still there for the next boot, which
        # runs the same pass: nothing was half-written.
        assert counts(store_root / "nojae.db") == {
            "servers": 0,
            "models": 0,
            "agents": 0,
            "prompt_helpers": 0,
        }

    def test_the_state_stays_answerable_after_the_boot_that_found_it(
        self, store_root: Path
    ):
        """Task 03's refusal and task 09's app bar both read this one answer.

        A store that was unusable at boot is still unusable on the request that
        asks about it, so the state has to outlive the boot — and a store that
        became usable answers the other way, with no sentence to show.
        """
        target = store_root / "nojae.db"
        target.mkdir()
        appdb.boot()

        state = appdb.store_state()
        assert state["state"] == "unusable"
        assert str(target) in state["sentence"]

        target.rmdir()
        appdb.boot()

        state = appdb.store_state()
        assert state["state"] == "ok"
        assert state["sentence"] is None
        assert state["path"] == str(target)

    def test_the_answer_is_a_copy(self, seeded: Path):
        """A caller cannot rewrite the record the app answers from."""
        state = appdb.store_state()
        state["state"] = "ok"
        state["agents"]["inserted"] = 999

        assert appdb.store_state()["agents"]["inserted"] == 4


# -- the app's boot contract ----------------------------------------------------

class TestTheAppBootsAnyway:
    """The lifespan's half of the contract: the app serves, whatever the store did.

    Driven through the real lifespan, because that is where the call sits and the
    only way to show that nothing about a broken store raises into it.
    """

    @contextlib.contextmanager
    def started(
        self, monkeypatch: pytest.MonkeyPatch, root: Path
    ) -> Iterator[TestClient]:
        """A **started** app — the lifespan run, which is where the store comes up.

        ``TestClient`` only enters the lifespan as a context manager, so this is
        the shape the other seed suites use for the same reason.
        """
        from src.api.server import create_app

        monkeypatch.setattr(appdb, "PROJECT_ROOT", root)
        with TestClient(create_app()) as client:
            yield client

    def test_the_lifespan_brings_the_store_up_and_seeds_it(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        root = tmp_path / "install"
        root.mkdir()

        with self.started(monkeypatch, root) as client:
            assert client.get("/api/health").status_code == 200
            assert appdb.store_state()["state"] == "ok"
            assert counts(root / "nojae.db")["agents"] == 4

    def test_an_unusable_store_still_serves_the_app(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """The acceptance sentence: the app starts, and the store names itself.

        The database is a directory, so the boot cannot open or create it. The
        health endpoint answering 200 is the proof that the failure stayed a
        state; the sentence is the proof it stayed a **named** one.
        """
        root = tmp_path / "install"
        root.mkdir()
        (root / "nojae.db").mkdir()

        with self.started(monkeypatch, root) as client:
            assert client.get("/api/health").status_code == 200
            state = appdb.store_state()
            assert state["state"] == "unusable"
            assert str(root / "nojae.db") in state["sentence"]

    def test_the_boot_wrapper_is_shaped_like_the_other_seeds(self):
        """A seed that cannot write logs and returns a state dict (AGENTS.md)."""
        import ast
        import inspect

        from src.api import server

        assert callable(server._boot_app_store)
        assert server._boot_app_store.__module__ == "src.api.server"
        # No raise statement of its own: the failure it reports is the one
        # ``appdb.boot`` already turned into a state dict, and the wrapper's only
        # job is the unexpected. Parsed, because the docstring has to *name* the
        # promise it keeps.
        wrapper = ast.parse(inspect.getsource(server._boot_app_store))
        assert not [node for node in ast.walk(wrapper) if isinstance(node, ast.Raise)]
        # And it is called from the lifespan, not from the factory: the factory
        # runs at import time here, which is the one moment a test fixture cannot
        # move the install root out of the way for.
        lifespan = next(
            node
            for node in ast.walk(ast.parse(inspect.getsource(server.create_app)))
            if isinstance(node, ast.AsyncFunctionDef) and node.name == "lifespan"
        )
        calls = {
            node.func.id
            for node in ast.walk(lifespan)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
        }
        assert "_boot_app_store" in calls
        factory = ast.parse(inspect.getsource(server.create_app))
        assert "_boot_app_store" not in {
            node.func.id
            for node in ast.walk(factory)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            and node.lineno < lifespan.lineno
        }


# -- the boot's reserved-folder rule --------------------------------------------
#
# The seed that used to write a workspace's ``agent-modes.json`` is gone with the
# file (task 10). What that seeder's suite asserted about the *boot* survives
# here, because it is a rule about what a first launch leaves behind rather than
# about the modalities file: the reserved folder gets its declarations, and the
# store's own content never appears there.

class TestTheBootLeavesTheReservedFolderAlone:
    def test_boot_seeds_the_declarations_and_no_store_file(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """A brand-new workspace opened at boot ends up with exactly the
        reserved folder's declarations — the policy, the MCP declaration, the LSP
        template (never the LSP declaration, which is hand-written) — and nothing
        else.

        The three stores are absent from that list: the prompt helpers
        (appdb-07), the model connection (appdb-09) and the agent modes
        (appdb-10) are all rows of the install's store, so a workspace has no
        such file at all — and a second checkout configured once is configured
        everywhere.
        """
        from src.api.server import create_app
        from src.core import lsphub, mcphub
        from src.core.editorfs import constants as editorfs_constants
        from mcp_connectors import policy_shared

        target = tmp_path / "booted-project"
        target.mkdir()
        from tests.conftest import make_the_install

        make_the_install(monkeypatch, target)
        create_app()
        folder = target / policy_shared.POLICY_DIRNAME
        assert sorted(name.name for name in folder.iterdir()) == sorted(
            [
                editorfs_constants.POLICY_FILENAME,
                mcphub.constants.MCP_SETTINGS_FILENAME,
                lsphub.constants.LSP_SETTINGS_TEMPLATE_FILENAME,
            ]
        )
        # The three stores are gone, and they are named so a later re-add fails
        # here rather than silently coming back.
        for gone in ("agent-modes.json", "prompt-helpers.json", "nojae-settings.json"):
            assert not (folder / gone).exists(), gone
        assert sorted(os.listdir(target)) == [policy_shared.POLICY_DIRNAME]

    def test_the_reserved_folder_is_out_of_source_control(self):
        """A store file must not turn up in ``git status``, and the ignore rule
        is the *folder*, never a line for one file."""
        repo = Path(__file__).resolve().parents[1]
        lines = [
            line.strip()
            for line in (repo / ".gitignore").read_text(encoding="utf-8").splitlines()
        ]
        assert ".nojae/" in lines
        assert not any("agent-modes" in line for line in lines)


# -- the seeding pass' own boundaries ------------------------------------------

class TestTheSeedingPassStaysInsideTheStore:
    def test_seeding_writes_no_declaration_file(self, seeded: Path):
        """The app may write its own store; it may not write a **declaration**.

        ``AGENTS.md``: "a declaration is created only when absent and changed only
        outside the app". The store is the app's, the reserved folder's files are
        not, so a boot that seeded the store must have left the workspace alone —
        and the working location here is a folder of this test's own, so anything
        appearing in it is the seeding pass' doing.
        """
        workspace = seeded / "workspace"
        workspace.mkdir()

        appdb.boot()

        assert list(workspace.iterdir()) == []

    def test_the_store_is_install_scoped_across_a_workspace_switch(
        self, seeded: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """D11: a working-location switch invalidates nothing in the database.

        The seeded rows are the install's, so moving the workspace must not
        re-seed, re-assert or refill anything — the second boot answers exactly
        as if nothing had moved.
        """
        from tests.conftest import scoped

        first = appdb.boot()
        (seeded / "another-workspace").mkdir(exist_ok=True)
        with scoped(seeded / "another-workspace"):
            second = appdb.boot()

        assert second["created"] is False
        assert second["agents"] == {"inserted": 0, "reasserted": 1}
        assert second["promptHelpers"] == 0
        assert first["path"] == second["path"]
