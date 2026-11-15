"""The suite's hermeticity, stated as tests rather than trusted as fixtures.

Three things a test could otherwise read from the machine it runs on, and the
guard that stops each:

* **the settings store** — ``<install root>/nojae.db``, which holds the
  developer's servers, key and agents. ``tests/conftest.py``'s autouse
  :func:`_every_test_gets_its_own_store` points it at a temporary file and
  asserts the install's own path can never be opened;
  ``tests/test_store_hermeticity.py`` is that invariant as a test.
* **the working location** — the seam's request scope, which decides where
  ``AGENTS.md``, the hubs' declarations and the e2e suite's connection fixture
  are looked for. The autouse
  :func:`_every_test_runs_in_a_workspace_scope` enters a throw-away root, so no
  core surface reads this checkout.
* **the environment** — ``SETTING_KEYS`` is the two technical keys,
  ``LLM_DEBUG`` and ``NOJAE_PYTHON_ROOT``, and the wipe loops in the app's
  fixtures must keep protecting exactly those, because those keys *stay* in the
  environment. Drop one from the tuple and the ambient environment answers it
  here.

Nothing here reads the values of, or writes to, this checkout's own ``.nojae``.
"""

import os
from pathlib import Path

import pytest

from src import config as config_module
from src.config import DEFAULT_MAX_TOOL_ITERATION, load_endpoints_config
from tests.conftest import (
    clear_test_settings_mode,
    neutralise_store,
    store_guard_root,
    workspace_guard_root,
)
from src.core import appdb


def agent_row(agent_id: str = "code") -> dict:
    """The store's row for ``agent_id``, as a turn hands it to the seam."""
    row, _findings = appdb.resolve_agent(agent_id)
    assert row is not None, f"the seeded store has no agent {agent_id!r}"
    return row


class TestTheWorkingLocationGuardPointsOffThisCheckout:
    """The autouse guard enters a scope, and the installation stays the install."""

    def test_the_installation_is_the_install_and_the_guard_is_not(
        self, tmp_path: Path
    ):
        """clws-10: the install folder is ``workspace.installation()``.

        The autouse scope is a throw-away folder; the installation is the app's
        own checkout, read from ``config.PROJECT_ROOT``. The two must not
        converge — that is what keeps the installation-scoped catalogue honest
        while a tab works on another folder.
        """
        from src.core import workspace

        guard_root = workspace_guard_root(tmp_path)
        current = os.path.normcase(workspace.current_root())
        install = os.path.normcase(workspace.installation())

        assert current == os.path.normcase(os.path.realpath(str(guard_root)))
        assert install == os.path.normcase(
            os.path.realpath(str(config_module.PROJECT_ROOT))
        )
        assert current != install

    def test_the_e2e_connection_fixture_is_looked_for_under_the_guard_root(
        self, tmp_path: Path
    ):
        """The fixture is a *file* still, so the location is what keeps it honest.

        With the switch off it is not read at all; with it on the lookup lands
        under the guard root, never on this checkout's hand-authored file.
        """
        guard_root = os.path.normcase(
            os.path.realpath(str(workspace_guard_root(tmp_path)))
        )
        answered = os.path.normcase(
            os.path.realpath(str(appdb.test_settings_path()))
        )

        assert answered.startswith(guard_root)
        assert appdb.TEST_SETTINGS_FILENAME in answered


class TestNoTestTurnsOnAConnectionItDidNotWrite:
    """No rows of its own → nothing answers; its own rows → their values answer."""

    def test_without_rows_of_its_own_every_agent_refuses(self, tmp_path: Path):
        """A first boot has four agents and no models: every turn refuses (D7)."""
        config, error = load_endpoints_config(agent_row())

        assert config is None
        assert isinstance(error, str)
        assert "no model" in error

    def test_after_the_test_writes_its_own_rows_the_values_answer(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """The guard is a neutralisation, not a wall: owned rows are read."""
        neutralise_store(
            monkeypatch,
            tmp_path,
            serverUrl="http://mine:9090/v1",
            serverApiKey="sk-mine",
            endpoint="my-model",
        )

        config, error = load_endpoints_config(agent_row())
        assert error is None
        assert config is not None
        assert config.serverUrl == "http://mine:9090/v1"
        assert config.apiKey == "sk-mine"
        assert config.model_list() == ["my-model"]


class TestThePerAgentCapIsNeutralToo:
    """``max_tool_iteration()`` answers the seeded number, never a typed one.

    It used to have a sibling here, the reader of the workspace file's
    ``lspEnabled`` array: the second LSP gate. D13 deleted that gate, so the only
    activation answer a language server gets is its declaration's ``enable``
    flag, and the declaration lookup the guard moves with the working location is
    the one that answers it — which is what
    ``test_no_language_server_is_active_from_an_ambient_declaration`` below asks.
    """

    def test_the_tool_loop_cap_is_the_seeded_number(self):
        # A developer's store may hold any number on any agent; a test that names
        # no agent must not answer it, or every tool-loop assertion changes meaning.
        assert config_module.max_tool_iteration() == DEFAULT_MAX_TOOL_ITERATION

    def test_an_env_name_cannot_reopen_it(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """Read from the agent's column only (D2): no ``os.environ`` fallback."""
        monkeypatch.setenv("MAX_TOOL_ITERATION", "3")
        monkeypatch.setenv("MAX_MCP_ITERATION", "3")
        assert config_module.max_tool_iteration(agent_row()) == (
            DEFAULT_MAX_TOOL_ITERATION
        )

    def test_no_language_server_is_active_from_an_ambient_declaration(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The one gate, and it is neutral too (D13).

        With a single gate the declaration file is the only thing that can put a
        language server on a turn's tool list, so a developer who runs real
        servers in this checkout must not have them reach every test. The
        answer comes from the working location the guard moved — and an
        ``LSP_ENABLED`` in the ambient environment reopens nothing, because
        nothing reads that name any more.
        """
        from src.api import routes
        from src.core import lsphub
        from src.core import workspace
        from src.core.lsphub import constants as lsp_constants

        monkeypatch.setenv("LSP_ENABLED", "pyright,typescript")
        # The declaration the lookup answers from is the guard's throw-away
        # root's, not this checkout's — and that file is not there, so the
        # scan finds nothing to activate.
        assert lsp_constants.lsp_settings_path().is_relative_to(
            Path(workspace.current_root())
        )
        assert lsphub.constants.LSP_SETTINGS_PATH is None
        assert routes._active_server_ids() == []


class TestTheEnvWipeLoopsStillCoverWhatStaysInTheEnv:
    """The two technical keys are still the environment's, so the loops keep them."""

    def test_the_managed_keys_answer_nothing_after_the_wipe_loop(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """The six fixtures' loop, run here: the managed keys stay neutralised.

        The model connection is neutralised by the temporary store; the keys
        that stayed in ``.env`` are neutralised by wiping ``SETTING_KEYS`` —
        which is why that tuple must keep naming them.
        """
        for key in config_module.SETTING_KEYS:
            monkeypatch.delenv(key, raising=False)
            assert key not in os.environ

        # Rows of this test's own, so the config is built at all: with the env
        # wiped, nothing ambient reaches it.
        neutralise_store(monkeypatch, tmp_path)
        config, error = load_endpoints_config(agent_row())
        assert error is None
        assert config is not None

    def test_the_still_env_sourced_keys_are_named_by_the_tuple(self):
        """The tuple is exactly these; it may not drop them.

        The two technical keys stay in ``.env``, so they stay wiped by the
        loops this file's first class is about.
        """
        for key in (
            config_module.LLM_DEBUG_KEY,
            "NOJAE_PYTHON_ROOT",
        ):
            assert key in config_module.SETTING_KEYS


class TestTheTestSettingsSwitchCannotLeakIntoTheSuite:
    """D14: the e2e switch is pinned off, so it cannot redirect the store.

    ``NOJAE_TEST_SETTINGS`` puts a process in the e2e suite's mode, where the
    store is a temporary database materialised from
    ``.nojae/nojae-test-settings.json`` — a hand-authored fixture the app never
    seeds. An exported ``1`` in the runner's shell would leave every test here
    failing en masse for a reason no traceback explains, so ``tests/conftest.py``
    clears the key and these cases pin that.
    """

    def test_the_guard_clears_an_ambient_value(self, _hermetic):
        """The guard itself, run against an exported ``1``.

        Called directly rather than exported around the test: a module-scoped
        export would be read by ``_every_test_gets_its_own_store`` too, and the
        store fixture would then boot from this checkout's own hand-authored
        fixture — the very leak this case exists to forbid. Running the guard's
        own function asks the same question without arranging that collision.
        """
        _hermetic.setenv(appdb.TEST_SETTINGS_KEY, "1")
        assert appdb.test_mode() is True

        clear_test_settings_mode(_hermetic)

        assert appdb.TEST_SETTINGS_KEY not in os.environ
        assert appdb.test_mode() is False
        # And the store's path is the install's own, never a throw-away root.
        assert appdb.database_path() == (
            Path(appdb.PROJECT_ROOT) / appdb.DB_FILENAME
        )

    def test_with_the_switch_on_the_store_moves_off_the_install(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The mode is reachable per test — and then the install's file is gone.

        A connection written into this test's own store is *not* what a
        switched-on process reads either: the path itself moves to the temporary
        root, which is what makes "no fallback in either direction" mechanical.
        """
        install_path = appdb.database_path()
        monkeypatch.setenv(appdb.TEST_SETTINGS_KEY, "1")

        assert appdb.test_mode() is True
        assert appdb.database_path() != install_path
        assert appdb.database_path().parent == appdb.test_root()
        assert appdb.database_path().name == appdb.DB_FILENAME

    def test_the_switch_is_named_by_the_module_not_by_a_literal(self):
        assert appdb.TEST_SETTINGS_KEY == "NOJAE_TEST_SETTINGS"


class TestAGuardSurvivesATestUndoingItsOwnPatches:
    """``monkeypatch.undo()`` lifts a test's patches, never a guard's.

    The suite's guards used to patch through the test's own ``monkeypatch``,
    which is the same instance a test body can undo — and undo reverts
    *everything* recorded on it. The working location then fell back to the
    install directory, so the modes and settings lookups answered from this
    checkout's own ``.nojae``: a real model connection, a real API key, and
    whatever agents the developer happens to have defined. A test that asserted
    a fixed list of mode ids passed or failed on the contents of a file no test
    wrote — the machine-dependence this whole file forbids.

    So the guards patch on an instance of their own (``conftest._hermetic``).
    These cases force the undo and assert the guards are still holding, which is
    the only way to tell that from a guard that was never needed.
    """

    def test_the_working_location_stays_off_the_install_root(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        from src.core import workspace

        guard_root = os.path.normcase(
            os.path.realpath(str(workspace_guard_root(tmp_path)))
        )
        assert os.path.normcase(workspace.current_root()) == guard_root

        # Prove the undo actually ran: a patch this test made itself is gone.
        monkeypatch.setenv("NOJAE_UNDO_PROBE", "1")
        monkeypatch.undo()
        assert "NOJAE_UNDO_PROBE" not in os.environ

        # And the guard's own scope is not: it is a context, not a monkeypatch,
        # so undoing the test's patches cannot fall back to this checkout — the
        # leak that made a mode-list assertion machine-dependent.
        assert os.path.normcase(workspace.current_root()) == guard_root
        assert os.path.normcase(workspace.installation()) != guard_root

    def test_the_agents_lookup_still_answers_the_guard_root(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """The bug this pins: the agents were read from the developer's own state.

        The modes file is gone (appdb-10) and the agents are rows of the install's
        store, so the leak this guards against is the same one the store guard
        closes — asserted through the answered **path**, never through the rows,
        because naming the developer's agents here would make the case depend on
        them again, which is the thing being forbidden.
        """
        monkeypatch.setenv("NOJAE_UNDO_PROBE", "1")
        monkeypatch.undo()

        answered = os.path.normcase(str(appdb.database_path()))
        # The module resolves the location through realpath, so compare resolved
        # against resolved rather than assuming tmp_path is already one.
        guard_root = os.path.normcase(
            os.path.realpath(str(store_guard_root(tmp_path)))
        )
        assert answered.startswith(guard_root), (
            f"the store lookup answered {answered}, outside the test's throw-away "
            f"root {guard_root}: the guard was lifted and this checkout's own "
            "settings store is being read"
        )

    def test_the_process_and_switch_guards_still_hold(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The other guards the same undo used to lift, in one assertion.

        ``NOJAE_DISABLE_MCP``/``_LSP`` off means an app lifespan in a test
        spawns real connector processes; the test-settings key back means the
        whole suite reads the e2e fixture instead of the workspace's file.
        """
        monkeypatch.setenv("NOJAE_UNDO_PROBE", "1")
        monkeypatch.undo()

        assert os.environ.get("NOJAE_DISABLE_MCP") == "1"
        assert os.environ.get("NOJAE_DISABLE_LSP") == "1"
        assert appdb.TEST_SETTINGS_KEY not in os.environ
        assert config_module.LLM_DEBUG_KEY not in os.environ
