"""appdb-04 — the suite never opens the install's own settings store.

AGENTS.md's Gotcha says *"Tests stay hermetic"*, and until this task the store
was the one thing a test did not own: ``<install root>/nojae.db`` holds the
model connection, the agent personas and the prompt helpers (spec §4.1), so a
suite run that reached it would read — and, because the boot seeds, could
**write** — a developer's configured agents, bullets and API key. The suite's
own ``conftest.py`` closes that with three parts, and this file asserts each of
them rather than trusting the fixture:

* **every test gets its own database** — the autouse fixture moves the store by
  patching the one value every path answer comes from, then boots it, so a test
  starts from the four built-in agents and nine empty helper rows and no server
  or model (§4.3);
* **the install's own file is unopenable, not merely unlikely to be reached** —
  an audit hook refuses it — with its WAL sidecars, which ``appdb`` calls part of
  the store — at the connect *and* at the create, and an audit hook is not a
  ``monkeypatch``, so the ``undo()`` leak ``tests/test_env_isolation.py``'s last
  class is about cannot lift it;
* **the guard is a guard** — it is fed deliberately poisoned inputs, including
  the event name the open actually fires under, because a hook keyed on a name
  that never fires passes every test that does not check that.

The style is the write-surface isolation guard's: assert the invariant, not the
intent. Nothing here reads, writes or stats the install's own file: the only
things done with that path are attempts to open it — which the guard refuses
before the driver or the operating system reaches the file — and one
``monkeypatch.chdir`` of its **folder**, so a relative name resolves where the
real file sits. A case that could damage the developer's store on its way to
failing would be a worse harness than the leak it looks for.
"""

import os
import sqlite3
from pathlib import Path
from typing import Any, Tuple

import pytest

from src.core import appdb
from tests.conftest import (
    REAL_DATABASE_PATH,
    REAL_STORE_PATHS,
    SQLITE_OPENS,
    clear_agent_model,
    neutralise_store,
    opened_path,
    refuse_the_real_store,
    store_guard_audit_hook,
    store_guard_root,
)

#: The four built-in ids, in the order the seeder writes them.
BUILT_IN_IDS: Tuple[str, ...] = ("chat", "code", "architect", "todoBuilder")


class TestEveryTestRunsOnItsOwnTemporaryDatabase:
    """The autouse fixture's store is a temporary file, and it is a booted one."""

    def test_the_active_store_is_under_the_tests_own_root(self, tmp_path: Path):
        active = appdb.database_path()
        assert active == store_guard_root(tmp_path) / appdb.DB_FILENAME
        assert active != REAL_DATABASE_PATH, (
            "the store lookup answered the install's own file: the autouse "
            "fixture that moves it is not running for this test"
        )

    def test_that_store_is_the_one_the_boot_seeded(self):
        """Four built-ins, nine empty helpers, and no server or model (§4.3)."""
        agents = appdb.resolve_agents()
        assert [agent["id"] for agent in agents["agents"]] == list(BUILT_IN_IDS)
        assert agents["findings"] == []
        assert appdb.load_servers() == []
        helpers = appdb.load_prompt_helpers()
        assert len(helpers) == appdb.SEEDED_PROMPT_HELPER_COUNT
        assert [helper["content"] for helper in helpers] == [""] * len(helpers)

    def test_the_connection_the_module_holds_is_not_the_installs(self):
        """The per-thread handle follows the moved root, it does not outlive it."""
        handle = appdb.connection()
        opened = handle.execute("PRAGMA database_list").fetchone()[2]
        assert opened_path(opened) == appdb.database_path()
        assert opened_path(opened) != REAL_DATABASE_PATH


class TestTheRecordedOpensNeverNameTheInstallsFile:
    """The audit trail the guard keeps: every database this process opened."""

    def test_the_trail_is_not_empty(self):
        # An empty trail would make the next case vacuously true, so the trail's
        # own liveness is asserted first: the fixture's boot went through here.
        assert SQLITE_OPENS

    def test_not_one_of_them_resolves_to_the_installs_own_file(self):
        reached = [
            attempt
            for attempt in SQLITE_OPENS
            if opened_path(attempt) in REAL_STORE_PATHS
        ]
        assert reached == [], (
            f"the suite opened nojae's own settings store: {reached[0]!r} is in "
            "the recorded opens, so something bypassed the temporary database "
            "tests/conftest.py gives every test"
        )

    def test_this_tests_own_store_is_among_them(self, tmp_path: Path):
        """The trail records the temporary file, so it records what it records."""
        wanted = store_guard_root(tmp_path) / appdb.DB_FILENAME
        assert any(opened_path(attempt) == wanted for attempt in SQLITE_OPENS)


class TestTheGuardRefusesEverySpellingOfTheInstallsFile:
    """The poisoned inputs: each is how a bypassed harness would name the file."""

    def test_the_plain_path_is_refused_and_named(self):
        with pytest.raises(RuntimeError) as caught:
            refuse_the_real_store(REAL_DATABASE_PATH)
        assert str(REAL_DATABASE_PATH) in str(caught.value)

    def test_the_wal_sidecars_are_refused_too(self):
        """The store is the file **and** its sidecars, so the guard is too.

        ``appdb`` calls ``-wal``/``-shm`` part of the store — they hold committed
        bytes and the write-ahead index — so a harness that could open one could
        damage a developer's settings without ever naming ``nojae.db``. The
        refusal also has to name the path it refused: "the store is unusable
        because of a path" is only actionable if it is the right path.
        """
        assert REAL_STORE_PATHS[0] == REAL_DATABASE_PATH
        assert set(REAL_STORE_PATHS) == {
            *(Path(str(REAL_DATABASE_PATH) + suffix)
              for suffix in appdb.WAL_SIDECAR_SUFFIXES),
            REAL_DATABASE_PATH,
        }
        for target in REAL_STORE_PATHS[1:]:
            with pytest.raises(RuntimeError) as caught:
                refuse_the_real_store(target)
            assert str(target) in str(caught.value)

    def test_the_uri_the_module_builds_is_refused(self):
        """``appdb`` connects through a ``file:`` URI, so that is a real spelling."""
        uri = REAL_DATABASE_PATH.as_uri() + "?mode=rw"
        with pytest.raises(RuntimeError):
            store_guard_audit_hook("sqlite3.connect", (uri,))

    def test_the_open_event_is_refused_at_the_create_too(self):
        """The event ``os.open`` fires is ``open`` — the name this hook keys on.

        The negative control is the point: the same arguments under the
        function's own name are *not* refused, because no such event exists. A
        hook written against ``os.open`` would therefore watch nothing and fail
        no test, which is the guard-that-cannot-fail this case exists to catch.
        """
        args: Tuple[Any, ...] = (str(REAL_DATABASE_PATH), "r", 0)
        with pytest.raises(RuntimeError):
            store_guard_audit_hook("open", args)
        # Not a pass: the name above is the only one the interpreter fires.
        store_guard_audit_hook("os.open", args)

    def test_a_relative_name_is_judged_where_it_can_be_resolved(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The one spelling the ``open`` event cannot answer, asserted as a choice.

        That event carries no ``dir_fd``, so a relative name there is relative to
        a directory the hook cannot see — and the runner walks plenty of them
        (its own temp-dir cleanup opens a leftover ``nojae.db`` with
        ``os.open(name, ..., dir_fd=...)``). Guessing the working directory would
        resolve such a name onto this checkout and blame the harness for a file
        no test touched. The half of the seam that would actually read or write
        the rows is ``sqlite3.connect``, which resolves a relative name against
        the working directory itself — so the same name *is* refused there.
        """
        monkeypatch.chdir(REAL_DATABASE_PATH.parent)
        store_guard_audit_hook("open", (appdb.DB_FILENAME, "r", 0))
        with pytest.raises(RuntimeError):
            store_guard_audit_hook("sqlite3.connect", (appdb.DB_FILENAME,))
        # And the absolute spelling is refused on both events, which is the only
        # one the app ever produces.
        with pytest.raises(RuntimeError):
            store_guard_audit_hook("open", (str(REAL_DATABASE_PATH), "r", 0))

    def test_a_temporary_file_of_the_same_name_is_not_refused(self, tmp_path: Path):
        """The guard is the *path*, not the filename — the suite's own stores are
        named ``nojae.db`` too, and refusing them would refuse the harness."""
        lookalike = tmp_path / appdb.DB_FILENAME
        assert opened_path(str(lookalike)) != REAL_DATABASE_PATH
        refuse_the_real_store(opened_path(str(lookalike)))
        store_guard_audit_hook("open", (str(lookalike), "w", 0o600))

    def test_the_drivers_names_for_no_file_answer_no_path(self):
        """``""`` and ``:memory:`` are the driver's two names for a database that
        is not a file, so there is nothing for the guard to compare."""
        assert opened_path("") is None
        assert opened_path(":memory:") is None
        refuse_the_real_store(None)
        # A temporary database's name is a *relative* path, so it is judged like
        # one: harmless wherever it resolves, and never the install's file.
        refuse_the_real_store(opened_path(":temp:"))


class TestTheGuardSurvivesATestUndoingItsOwnPatches:
    """An audit hook is not a ``monkeypatch``: nothing a test does lifts it."""

    def test_after_the_undo_the_file_is_still_unopenable(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setenv("NOJAE_UNDO_PROBE", "1")
        monkeypatch.undo()
        # Prove the undo ran, then ask every question the bypass would ask: read
        # it, create it, and open it through the driver both ways.
        assert "NOJAE_UNDO_PROBE" not in os.environ

        target = str(REAL_DATABASE_PATH)
        with pytest.raises(RuntimeError):
            os.close(os.open(target, os.O_RDONLY))
        with pytest.raises(RuntimeError):
            # The create is the one that would leave the developer's file behind.
            os.close(os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600))
        with pytest.raises(RuntimeError):
            sqlite3.connect(target)
        with pytest.raises(RuntimeError):
            sqlite3.connect(REAL_DATABASE_PATH.as_uri() + "?mode=ro", uri=True)

    def test_the_store_the_module_uses_is_still_the_temporary_one(self):
        """The undo lifted the test's patches, not the fixture's store."""
        assert appdb.database_path() != REAL_DATABASE_PATH
        assert appdb.load_prompt_helpers()

    def test_a_bypassed_harness_is_refused_by_the_production_code_path(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The poisoned input fed through ``appdb`` itself, not through a helper.

        Everything above asks the hook a question directly; this asks the real
        module, with its install root put back where the developer's file is —
        the exact state a harness that stopped running would leave. It goes
        through :func:`src.core.appdb.version_of`, the module's **read-only**
        open, because a guard that had somehow rotted must not be allowed to
        create or migrate the file it was supposed to refuse: the point of the
        case is to be refused, and it must not be able to do damage on its way
        to failing.
        """
        monkeypatch.setattr(appdb, "PROJECT_ROOT", REAL_DATABASE_PATH.parent)
        assert appdb.database_path() == REAL_DATABASE_PATH

        with pytest.raises(RuntimeError) as caught:
            appdb.version_of()
        assert "may not open" in str(caught.value)
        # The refusal came from the guard, not from SQLite: the file is there and
        # perfectly openable, which is what makes the raise the guard's doing.
        assert "tests/conftest.py" in str(caught.value)

        # And the harness's own store is still the one the module answers from,
        # so the poisoned patch is the monkeypatch's to undo and nothing leaked.
        monkeypatch.undo()
        assert appdb.database_path() != REAL_DATABASE_PATH


class TestTheHarnessWritesRowsAndOnlyRows:
    """The store-shaped neutraliser: rows for the connection, and one way to
    take an agent's model away."""

    def test_an_agent_without_a_model_is_only_reachable_by_clearing_it(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        neutralise_store(monkeypatch, tmp_path, serverUrl="http://mine:9/v1")
        before = appdb.resolve_agents()["agents"]
        assert all(agent["modelId"] is not None for agent in before)
        assert all(agent["modelName"] for agent in before)
        # D14's step 3: the helper pins *every* agent to the model it writes, so
        # a configured store leaves none unrunnable.
        assert len({agent["modelId"] for agent in before}) == 1

        clear_agent_model("code")
        after = {agent["id"]: agent for agent in appdb.resolve_agents()["agents"]}
        assert after["code"]["modelId"] is None
        assert after["code"]["modelName"] is None
        # The other rows are untouched: the state is one row's, deliberately.
        assert after["chat"]["modelId"] == before[0]["modelId"]

    def test_the_absent_connection_leaves_no_server_and_no_model(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        neutralise_store(monkeypatch, tmp_path, absent=True)
        assert appdb.load_servers() == []
        assert all(
            agent["modelId"] is None for agent in appdb.resolve_agents()["agents"]
        )

    def test_an_agent_without_a_model_can_be_asked_for_by_name(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """The same state as an argument, for a test that wants it at once.

        Both spellings answer the same row: the argument is the shorthand, and
        :func:`clear_agent_model` is the one a test reaches for mid-body. Neither
        is a store rule — the store simply has a nullable column.
        """
        neutralise_store(
            monkeypatch, tmp_path, agents_without_model=("architect",)
        )
        agents = {agent["id"]: agent for agent in appdb.resolve_agents()["agents"]}
        assert agents["architect"]["modelId"] is None
        assert agents["architect"]["modelName"] is None
        assert all(
            agent["modelId"] is not None
            for agent_id, agent in agents.items()
            if agent_id != "architect"
        )

    def test_the_written_values_are_the_ones_the_store_answers(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        neutralise_store(
            monkeypatch,
            tmp_path,
            serverUrl="http://mine:9/v1",
            serverApiKey="sk-mine",
            endpoint="my-model",
            temperature=0.25,
        )
        servers = appdb.load_servers()
        assert len(servers) == 1
        assert servers[0]["url"] == "http://mine:9/v1"
        assert servers[0]["apiKey"] == "sk-mine"
        assert [model["name"] for model in servers[0]["models"]] == ["my-model"]
        assert servers[0]["models"][0]["temperature"] == 0.25
        # And the agents point at it, which is what makes a turn runnable (D5).
        assert all(
            agent["modelName"] == "my-model"
            for agent in appdb.resolve_agents()["agents"]
        )
