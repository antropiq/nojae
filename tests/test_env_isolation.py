"""The suite's hermeticity, stated as tests rather than trusted as fixtures.

Four things a test could otherwise read from the machine it runs on, and the
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
* **the environment and the command line** — the install's own configuration is
  no longer in the environment at all: it is this process's **boot flags**
  (:class:`src.config.BootFlags`), so an ambient ``LLM_DEBUG`` or
  ``NETWORK_FAIL_MAX_RETRY`` decides nothing and there is no wipe loop to forget
  a key. What still needs pinning is the opposite direction: the flags a test
  runs on come from ``conftest._no_debug_switch_leak``, which replaces the whole
  value with its defaults, so neither the console script under test nor the
  process that started pytest decides a run's numbers. The environment names a
  *parent* sets for a child keep working (``NOJAE_DISABLE_MCP`` and friends) —
  those are switches about the process, not its configuration.
* **the user's skills root** — ``<home>/.agents/skills``, one of the two folders
  :func:`src.core.skills.scan` walks for the catalogue that goes into the system
  prompt. The autouse :func:`_every_test_gets_its_own_home` pins the module's
  ``user_home()`` seam at a throw-away folder. This one differs from the other
  three in *how often* it is read: the store is opened by a request that needs a
  connection, the workspace by a request that names one, the environment by a
  lookup that falls back to it — but the home root is read on **every chat turn**,
  so a suite running against the real one would make the prompts under test depend
  on whatever skills the developer happens to have installed, and would do it
  without a single test mentioning skills at all.

Nothing here reads the values of, or writes to, this checkout's own ``.nojae``.
"""

import logging
import os
import sys
from pathlib import Path
from typing import List

import pytest

from src import config as config_module
from src.config import DEFAULT_MAX_TOOL_ITERATION, load_endpoints_config
from tests.conftest import (
    clear_test_settings_mode,
    neutralise_store,
    skills_guard_root,
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


class TestTheBootFlagsOfATestArePinned:
    """Nothing the machine carries can set a test's install-level configuration.

    The install's keys left the environment for the command line, so the hazard
    changed shape and so did the guard: it is no longer a wipe loop over a tuple
    of key names (which a future key could be forgotten from), it is one
    whole-value replacement of the process's :class:`src.config.BootFlags`.
    """

    def test_an_ambient_environment_sets_no_install_key(self, monkeypatch):
        """Every name the old ``.env`` held is inert here.

        Pinned by *setting* them rather than deleting them, because deletion
        proves only that this machine does not happen to export them: an install
        that still has an exported ``LLM_DEBUG`` from before the change would
        otherwise answer it, and the suite would pass on the machine that does
        not have it and fail on the one that does.
        """
        for name in (
            "LLM_DEBUG",
            "LITELLM_DEBUG",
            "NETWORK_FAIL_MAX_RETRY",
            "NETWORK_FAIL_WAIT_FOR",
            "NOJAE_PYTHON_ROOT",
        ):
            monkeypatch.setenv(name, "1" if name.endswith("DEBUG") else "77")

        assert config_module.llm_debug_enabled() is False
        assert config_module.network_fail_budget() == (
            config_module.DEFAULT_NETWORK_FAIL_MAX_RETRY,
            config_module.DEFAULT_NETWORK_FAIL_WAIT_FOR,
        )
        # The interpreter answer never came from the environment either.
        assert config_module.python_root() == sys.executable

    def test_the_flags_answer_the_pin_and_not_the_host_process(self):
        """The guard's answer, asserted as the whole value it is.

        A run of ``python -m pytest --llm-debug``-style arguments belongs to
        pytest; nothing copies ``sys.argv`` into the flags, so the value here is
        the module's own defaults whatever started the suite.
        """
        assert config_module.boot_flags() == config_module.BootFlags()


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


class TestTheUserSkillsRootGuardPointsOffThisMachine:
    """skl-06: no test may scan this machine's real ``<home>/.agents/skills``.

    The catalogue a chat turn is given comes from two folders, and the second is
    the developer's home folder — a file of *their* machine, read on every turn.
    These cases assert the guard rather than trusting it, in the same style as the
    store's: the answered path, the scan's actual reach, and the folder's silence.

    Every case here fails if ``conftest._every_test_gets_its_own_home`` is removed
    — checked once, by removing it and watching these fail — because a guard no
    case notices is a guard that can rot.
    """

    def test_the_answered_home_is_the_guard_root_never_the_real_one(
        self, tmp_path: Path
    ):
        """The seam's answer, compared as resolved paths like the store guard's.

        ``user_home()`` canonicalises through ``realpath``, so a comparison that
        assumed ``tmp_path`` is already resolved would pass or fail on the volume's
        symlink layout rather than on the guard.
        """
        from src.core import skills

        answered = os.path.normcase(skills.user_home())
        guard_root = os.path.normcase(
            os.path.realpath(str(skills_guard_root(tmp_path)))
        )
        real_home = os.path.normcase(os.path.realpath(os.path.expanduser("~")))

        assert answered == guard_root, (
            f"the user skills root answered {answered}, not this test's throw-away "
            f"home {guard_root}: the guard is not holding, so the catalogue under "
            "test is being built from this machine's installed skills"
        )
        assert answered != real_home

    def test_the_guard_root_is_created_so_a_scan_of_it_is_silent(
        self, tmp_path: Path
    ):
        """§5.2: an absent root makes no finding, an unreadable one makes one.

        The guard's folder exists and holds no skills root, so a scan answers
        nothing **and** says nothing. Were the folder left absent-but-unreadable, or
        were the pin to name a path the walk cannot open, every test's log would
        gain a skills finding and any ``caplog`` case anywhere would be fragile.
        """
        from src.core import skills

        assert skills_guard_root(tmp_path).is_dir()

        found, findings = skills.scan()

        assert found == []
        assert findings == []

    def test_a_skill_under_the_guard_root_is_scanned_and_one_outside_is_not(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """The guard moves the *scan*, not just a string.

        Both halves are needed: a case that only asserted the answered path would
        still pass if the scan computed the home some other way, and a case that
        only asserted a sibling folder is ignored would pass if the scan read
        nothing at all. So the second half points the seam at that sibling with the
        test's own ``monkeypatch`` — the documented override, guards first and test
        body later — and shows the scan follows it.
        """
        from src.core import skills

        def plant(home: Path, folder: str) -> Path:
            skill = home.joinpath(*skills.SKILLS_ROOT_PARTS) / folder
            skill.mkdir(parents=True)
            (skill / skills.SKILLS_FILENAME).write_text(
                f"---\ndescription: About {folder}.\n---\n\nthe body\n",
                encoding="utf-8",
            )
            return skill

        plant(skills_guard_root(tmp_path), "inside-the-guard")
        elsewhere = tmp_path.parent / f"{tmp_path.name}-not-the-home"
        plant(elsewhere, "outside-the-guard")

        offered, _findings = skills.scan()

        assert [item.name for item in offered] == ["inside-the-guard"]
        assert offered[0].scope == skills.SCOPE_USER

        monkeypatch.setattr(
            skills, "user_home", lambda: str(elsewhere.resolve())
        )
        moved, _ = skills.scan()
        assert [item.name for item in moved] == ["outside-the-guard"]

        # And the guard is back the moment the override is undone: the seam is
        # resolved per call, so nothing here is process state that outlives a patch.
        monkeypatch.undo()
        assert [item.name for item in skills.scan()[0]] == ["inside-the-guard"]

    def test_no_scan_of_this_suite_walks_the_real_home_skills_root(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """The honest form of "never reads this machine's files": the **reach**.

        The cases above assert what the seam *answers*; this one asserts what the
        walk *opens*, because the claim under test is about bytes, not about a
        function's return value. The trail asserts its own liveness too (the store
        guard's lesson): the guard's root must be in it, or the refusal below would
        pass on an empty list.
        """
        from src.core import skills

        walked: List[str] = []
        real_scandir = os.scandir

        def recording_scandir(path, *args, **kwargs):  # noqa: ANN001, ANN202
            walked.append(os.path.normcase(os.path.realpath(str(path))))
            return real_scandir(path, *args, **kwargs)

        monkeypatch.setattr(os, "scandir", recording_scandir)
        skills.scan()

        def skills_root_under(base: Path) -> str:
            return os.path.normcase(
                os.path.realpath(str(base.joinpath(*skills.SKILLS_ROOT_PARTS)))
            )

        # The walk opens the two **roots**, never the home folder itself, so the
        # trail is compared against the roots the guard moved.
        assert skills_root_under(skills_guard_root(tmp_path)) in walked
        assert skills_root_under(workspace_guard_root(tmp_path)) in walked
        # And the hazard itself, stated as the absence: not this machine's root.
        assert skills_root_under(Path(os.path.expanduser("~"))) not in walked

    def test_a_damaged_skill_under_the_guard_root_is_named_on_the_console(
        self, tmp_path: Path, caplog: pytest.LogCaptureFixture
    ):
        """§5.23 / D7, end to end: the log line **is** the diagnosis.

        There is no UI for a skill that did not appear, so what it costs the user
        is one console line naming the path. Tasks 02–04 wrote the logging; this is
        the case that proves the story works from a damaged file on disk to a
        readable line about it — nothing else in the suite asserts that whole rail
        (the skills suite's own ``caplog`` cases check one finding's level or its
        count, not that a scan of a real folder produces a line a user could act
        on). It runs on the guard root, so it is also the case that shows a
        *user-level* skill's damage is reportable without this machine's home.
        """
        from src.core import skills, workspace

        damaged = (
            skills_guard_root(tmp_path)
            .joinpath(*skills.SKILLS_ROOT_PARTS)
            / "broken-frontmatter"
        )
        damaged.mkdir(parents=True)
        # Opens with the delimiter and never closes it: unparseable (§5.8), so the
        # skill is dropped and the finding is an error.
        (damaged / skills.SKILLS_FILENAME).write_text(
            "---\ndescription: A skill whose header never closes.\n", encoding="utf-8"
        )

        with caplog.at_level(logging.WARNING, logger=skills.logger.name):
            offered, findings = skills.scan()

        assert offered == []
        assert len(findings) == 1
        assert findings[0].kind == skills.KIND_ERROR
        # The path in the line is the one the module answered with, so a user can
        # open that file rather than guess which of their skills was meant.
        assert workspace.canonical(str(damaged / skills.SKILLS_FILENAME)) in caplog.text


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

        The debug switch joins them from the other side: it is no longer an
        environment key a lifted wipe loop could re-expose, but process state a
        guard pins by replacing the whole value — which no ``undo()`` can reach
        either, for the same reason the environment guards cannot.
        """
        monkeypatch.setenv("NOJAE_UNDO_PROBE", "1")
        monkeypatch.undo()

        assert os.environ.get("NOJAE_DISABLE_MCP") == "1"
        assert os.environ.get("NOJAE_DISABLE_LSP") == "1"
        assert appdb.TEST_SETTINGS_KEY not in os.environ
        assert config_module.boot_flags() == config_module.BootFlags()
        assert config_module.llm_debug_enabled() is False

    def test_the_user_skills_root_guard_still_answers_the_guard_root(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """Extending this class with skl-06's guard: the home seam is a patch too.

        The store and the working location are the two this class was written for,
        but the skills guard is the same shape — a ``setattr`` on
        ``conftest._hermetic`` — so it is the same leak. Had it been written against
        the test's own ``monkeypatch``, this undo would have put every test's
        catalogue back together out of the developer's own ``.agents/skills``, which
        is the hazard the class above exists to stop.
        """
        from src.core import skills

        guard_root = os.path.normcase(
            os.path.realpath(str(skills_guard_root(tmp_path)))
        )
        assert os.path.normcase(skills.user_home()) == guard_root

        monkeypatch.setenv("NOJAE_UNDO_PROBE", "1")
        monkeypatch.undo()
        assert "NOJAE_UNDO_PROBE" not in os.environ

        assert os.path.normcase(skills.user_home()) == guard_root, (
            "the skills guard was lifted by the test's undo: the user skills root "
            "is this machine's own again"
        )
