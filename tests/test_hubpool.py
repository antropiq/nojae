"""``HubPool``: one set of tools per workspace, with the four rules.

A connector and a language server are bound to a folder at birth, so two
workspaces need one of each (spec §3.1) — and a set of them needs a ceiling, an
idle rule, a veto and one sentence for when the ceiling is reached (spec §4.4).
Those **rules** are this suite's subject, not the connectors: both manager
classes are replaced with a recording double, so nothing here spawns a process,
opens a socket or reads a developer's declaration. The two dev/test switches are
asserted to keep that promise per workspace, and every root named is a
``tmp_path`` folder — never this checkout (the suite's own hermeticity rule).

The promises:

* **two roots, two of each** — one set per canonical folder, and neither set is
  the other's;
* **admission is the one seeding moment** — a fresh root gains its reserved
  files on the first ``acquire`` and nothing on the second, and a read of a
  folder nobody admitted leaves it untouched;
* **the ceiling** refuses the ``N+1``th workspace with one sentence naming the
  bound, and never evicts a live one to make room;
* **the idle rule** stops a workspace past its window through the managers' own
  ``stop_all`` and frees its slot;
* **the veto** — a workspace the API calls busy is never let go, however long it
  idles, and is released as soon as it is not;
* **the visible restart** — a returning tab is told its tools were built, which
  is what keeps rule 23 from becoming a silent pause;
* **the placeholder per workspace** — ``${NOJAE_PATH_LOCATION}`` in A's
  declaration expands to A and in B's to B, in one process, while
  ``${PROJECT_ROOT}`` stays the installation in both.
"""

import asyncio
import ast
import json
import os
import time
from pathlib import Path
from typing import Any, Dict, Iterator, List, Tuple

import pytest
from fastapi.testclient import TestClient

from src import config as config_module
from src.api.server import create_app
from src.core import hubpool, lsphub, mcphub, workspace
from src.core.hubpool import HubPool, ceiling_sentence

#: The one way a test names a folder on a request (clws-01): the hub routes are
#: workspace-scoped, so every case below asks about a ``tmp_path`` folder.
from tests.conftest import make_the_install, workspace_params, scoped

#: The three files the reserved folder gains when a folder is admitted. The LSP
#: **declaration** is deliberately not among them — it is hand-written, because
#: every entry names machine-local paths — and its absence is asserted below.
SEEDED_FILENAMES = (
    "read-write-policy.json",
    "mcp-settings.json",
    "lsp-settings.template.json",
)


def declaration_of(root: Path, ids: List[str]) -> Path:
    """Give ``root`` an MCP declaration whose entries are named by ``ids``.

    Written by hand rather than seeded, because the point is that two folders
    carry **different** declarations: the only way to see which one a set was
    built from is to be able to tell them apart.
    """
    folder = reserved(root)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / mcphub.constants.MCP_SETTINGS_FILENAME
    path.write_text(
        json.dumps(
            {
                name: {
                    "type": "remote",
                    "enable": True,
                    "url": f"https://example.invalid/{name}",
                }
                for name in ids
            }
        ),
        encoding="utf-8",
    )
    return path


class RecordingManager:
    """A hub manager that records instead of connecting or spawning anything.

    Stands in for both ``McpManager`` and ``LspManager``: the pool treats the two
    symmetrically, so one double with the union of the two interfaces is what
    keeps that symmetry honest rather than asserted twice.
    """

    #: every instance ever built, in order — how "two roots get two of each"
    #: and "the second acquire built nothing" are measured
    built: List["RecordingManager"] = []

    #: when set, ``start_all`` yields control, so a test can put two admissions
    #: genuinely in flight at once instead of one after the other
    slow_start = False

    installed = True

    def __init__(self, entries: List[Dict[str, Any]], *args: Any) -> None:
        self.entries = list(entries)
        self.extra_args = args
        self.starts = 0
        self.stops = 0
        self.restarts: List[Any] = []
        self.started: List[str] = []
        self.stopped: List[str] = []
        self.statuses: List[Dict[str, Any]] = [
            {"id": entry["id"], "status": "stopped"} for entry in self.entries
        ]
        RecordingManager.built.append(self)

    async def start_all(self) -> None:
        self.starts += 1
        if RecordingManager.slow_start:
            await asyncio.sleep(0)

    async def stop_all(self) -> None:
        self.stops += 1

    async def restart(self, *args: Any) -> None:
        self.restarts.append(args)

    def status(self) -> List[Dict[str, Any]]:
        return self.statuses

    # -- the per-entry hot-toggle surface the two ``enable``-flag routes use ---
    #
    # The union of the two managers' interfaces is what keeps the double honest
    # about the symmetry it stands in for: the routes reconcile a ticked row by
    # asking one entry's status and starting or stopping that one entry, and a
    # panel saved in A must do it to **A's** manager.

    def _record(self, which: str, entry_id: str) -> None:
        getattr(self, which).append(entry_id)

    def _status_of(self, entry_id: str):
        for entry in self.statuses:
            if entry.get("id") == entry_id:
                return entry.get("status")
        return None

    def connector_status(self, connector_id: str):
        return self._status_of(connector_id)

    def server_status(self, server_id: str):
        return self._status_of(server_id)

    def start_connector(self, connector_id: str) -> None:
        self._record("started", connector_id)

    def stop_connector(self, connector_id: str) -> None:
        self._record("stopped", connector_id)

    def start_server(self, server_id: str) -> None:
        self._record("started", server_id)

    def stop_server(self, server_id: str) -> None:
        self._record("stopped", server_id)


@pytest.fixture(autouse=True)
def _no_managers_are_real(monkeypatch: pytest.MonkeyPatch) -> Iterator[None]:
    """Both manager classes are the recording double, for every test here.

    Patched on ``hubpool`` rather than on the hub packages: the pool builds the
    managers, so that is the seam the pool's rules are about.
    """
    RecordingManager.built = []
    monkeypatch.setattr(hubpool, "McpManager", RecordingManager)
    monkeypatch.setattr(hubpool, "LspManager", RecordingManager)
    yield


@pytest.fixture
def real_declarations(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    """Let the pool actually read a workspace's declaration files.

    The suite's own guards set both disable switches and the hub packages pin
    their declaration paths, both of which are right for the rest of the suite
    and both of which would make a "whose declaration did this set get?"
    assertion measure nothing. So the tests that ask that question clear the
    switches and unpin the lookups, which is what leaves the **scope** as the
    only thing that can answer it.
    """
    monkeypatch.delenv(hubpool.DISABLE_MCP_ENV, raising=False)
    monkeypatch.delenv(hubpool.DISABLE_LSP_ENV, raising=False)
    monkeypatch.setattr(mcphub.constants, "MCP_SETTINGS_PATH", None)
    monkeypatch.setattr(lsphub.constants, "LSP_SETTINGS_PATH", None)
    # Hermetic LSP deny-list: the real file's entries belong to this machine, and
    # the loader refuses a workspaceRoot under one of them.
    servers_dir = tmp_path / "lsp_connectors"
    servers_dir.mkdir()
    (servers_dir / "restricted-paths.txt").write_text("/etc\n", encoding="utf-8")
    monkeypatch.setattr(lsphub.constants, "LSP_RESTRICTED_PATHS", servers_dir / "restricted-paths.txt")


@pytest.fixture
def pool() -> HubPool:
    return HubPool()


@pytest.fixture
def roots(tmp_path: Path) -> List[Path]:
    """Five scratch folders, so a patched ceiling is reachable by one more."""
    made = []
    for index in range(5):
        root = tmp_path / f"project-{index}"
        root.mkdir()
        made.append(root)
    return made


def run(coroutine: Any) -> Any:
    """Drive one coroutine on a fresh loop — the pool is async, the rules are not."""
    return asyncio.run(coroutine)


def reserved(root: Path) -> Path:
    return root / mcphub.constants.POLICY_DIRNAME


def reserved_files(root: Path) -> List[str]:
    folder = reserved(root)
    if not folder.is_dir():
        return []
    return sorted(item.name for item in folder.iterdir())


def lsp_declaration_of(root: Path, ids: List[str]) -> Path:
    """Give ``root`` a language-server declaration whose entries are ``ids``."""
    folder = reserved(root)
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / lsphub.constants.LSP_SETTINGS_FILENAME
    path.write_text(
        json.dumps(
            {
                name: {
                    "enable": True,
                    "extensions": [".py"],
                    "command": ["a-langserver", "--stdio"],
                    "workspaceRoot": str(root),
                }
                for name in ids
            }
        ),
        encoding="utf-8",
    )
    return path


# -- one set per workspace ------------------------------------------------------


class TestOneSetOfToolsPerWorkspace:
    def test_two_roots_admit_two_sets(
        self, pool: HubPool, roots: List[Path], real_declarations: None
    ):
        declaration_of(roots[0], ["console"])
        declaration_of(roots[1], ["fedit", "playwright"])
        first = run(pool.acquire(str(roots[0])))
        second = run(pool.acquire(str(roots[1])))

        assert first.hub_set is not None and second.hub_set is not None
        assert first.hub_set.root == str(roots[0])
        assert second.hub_set.root == str(roots[1])
        # Neither manager is the other's — the whole point of the pool.
        assert first.hub_set.mcp is not second.hub_set.mcp
        assert first.hub_set.lsp is not second.hub_set.lsp
        # And each was built from **its own** declaration: the folder is the only
        # thing that differs between the two sets.
        assert [entry["id"] for entry in first.hub_set.mcp.entries] == ["console"]
        assert [
            entry["id"] for entry in second.hub_set.mcp.entries
        ] == ["fedit", "playwright"]
        assert pool.roots() == [str(roots[0]), str(roots[1])]

    def test_two_spellings_of_one_folder_are_one_entry(
        self, pool: HubPool, roots: List[Path]
    ):
        """The pool keys on the seam's canonical form, so ``~/p`` and ``/home/p``
        cannot get two sets of connectors."""
        root = roots[0]
        run(pool.acquire(str(root)))
        spelled = str(root) + "/."
        acquired = run(pool.acquire(spelled))
        assert acquired.built is False
        assert pool.roots() == [str(root)]

    def test_a_live_root_acquired_twice_builds_nothing_and_writes_nothing(
        self, pool: HubPool, roots: List[Path]
    ):
        root = roots[0]
        built = run(pool.acquire(str(root)))
        files = reserved_files(root)
        RecordingManager.built = []

        again = run(pool.acquire(str(root)))

        assert again.built is False
        assert again.hub_set is built.hub_set
        assert RecordingManager.built == []
        assert reserved_files(root) == files

    def test_a_set_starts_both_managers_once_on_admission(
        self, pool: HubPool, roots: List[Path]
    ):
        hub_set = run(pool.acquire(str(roots[0]))).hub_set
        assert hub_set is not None
        assert (hub_set.mcp.starts, hub_set.lsp.starts) == (1, 1)

    def test_live_does_not_admit(self, pool: HubPool, roots: List[Path]):
        """A read of a folder must not start processes or write files."""
        assert pool.live(str(roots[0])) is None
        assert pool.roots() == []
        assert reserved_files(roots[0]) == []
        assert RecordingManager.built == []

    def test_two_requests_for_one_unseen_folder_build_one_set(
        self,
        pool: HubPool,
        roots: List[Path],
        monkeypatch: pytest.MonkeyPatch,
    ):
        """Admission is serialised, so two tabs on one folder get one hub.

        Both arrive before either has been admitted, which is the only moment the
        question is hard: the answer must be one set, started once, not two sets
        of connector processes for one workspace.
        """
        root = str(roots[0])
        monkeypatch.setattr(RecordingManager, "slow_start", True)

        async def both() -> Tuple[Any, Any]:
            return await asyncio.gather(pool.acquire(root), pool.acquire(root))

        first, second = run(both())

        assert first.hub_set is second.hub_set
        assert sorted([first.built, second.built]) == [False, True]
        assert pool.roots() == [root]
        assert len(RecordingManager.built) == 2  # one MCP + one LSP, for one root
        assert first.hub_set.mcp.starts == 1

    def test_a_cold_start_of_one_workspace_does_not_delay_another(
        self, pool: HubPool, roots: List[Path], monkeypatch: pytest.MonkeyPatch
    ):
        """The lock is per root, because a cold connector is not everyone's wait.

        A local connector's start burns its whole retry window, so an admission
        genuinely in flight must not stop a **different** folder's first request
        from being served (spec §5.3 rule 13). One lock for the whole pool would
        pass every other test here and fail this one.
        """
        started = asyncio.Event()
        release = asyncio.Event()
        calls: List[Any] = []

        async def slow_start(self) -> None:  # records, then waits to be let go
            self.starts += 1
            calls.append(self)
            if len(calls) == 1:
                started.set()
                await asyncio.wait_for(release.wait(), timeout=5)

        monkeypatch.setattr(RecordingManager, "start_all", slow_start)

        async def both() -> Tuple[Any, Any]:
            first = asyncio.ensure_future(pool.acquire(str(roots[0])))
            # roots[0] is now mid-admission: its connector start is still running.
            await started.wait()
            second = await asyncio.wait_for(pool.acquire(str(roots[1])), timeout=2)
            release.set()
            return await first, second

        try:
            slow, quick = run(both())
        except asyncio.TimeoutError:  # pragma: no cover — the failure this pins
            pytest.fail("a second workspace queued behind the first's cold start")

        assert slow.hub_set is not None and quick.hub_set is not None
        assert slow.hub_set.root == str(roots[0])
        assert quick.hub_set.root == str(roots[1])

    def test_an_admission_in_flight_already_holds_a_slot(
        self, pool: HubPool, roots: List[Path], monkeypatch: pytest.MonkeyPatch
    ):
        """The ceiling counts what is being built, not only what is finished.

        Two concurrent admissions could otherwise both pass the check on an
        empty pool and both build, over-committing the bound the sentence names.
        """
        started = asyncio.Event()
        release = asyncio.Event()
        calls: List[Any] = []

        async def slow_start(self) -> None:
            self.starts += 1
            calls.append(self)
            if len(calls) == 1:
                started.set()
                await asyncio.wait_for(release.wait(), timeout=5)

        monkeypatch.setattr(RecordingManager, "start_all", slow_start)
        monkeypatch.setattr(hubpool, "MAX_LIVE_WORKSPACES", 1)

        async def both() -> Tuple[Any, Any]:
            first = asyncio.ensure_future(pool.acquire(str(roots[0])))
            await started.wait()
            second = await pool.acquire(str(roots[1]))
            release.set()
            return await first, second

        built, refused = run(both())
        assert built.hub_set is not None
        assert refused.hub_set is None
        assert refused.refusal is not None


class TestAReturningTabNeverGetsADyingSet:
    """The idle rule and a returning tab share one lock, for one reason.

    "A workspace with a tab behind it is never let go" (spec §5.4 rule 24) has to
    hold at the moment of the teardown, not only at the moment the reaper looked.
    A tab that arrives while a set is being stopped must not be handed that set —
    its tools would stop under it — and a tab that arrived a moment earlier must
    save it.
    """

    @pytest.fixture
    def slow_teardown(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> Tuple[asyncio.Event, asyncio.Event]:
        started = asyncio.Event()
        release = asyncio.Event()
        calls: List[Any] = []

        async def slow_stop(self) -> None:
            self.stops += 1
            calls.append(self)
            if len(calls) == 1:
                started.set()
                await asyncio.wait_for(release.wait(), timeout=5)

        monkeypatch.setattr(RecordingManager, "stop_all", slow_stop)
        monkeypatch.setattr(hubpool, "IDLE_RELEASE_SECONDS", 0.0)
        return started, release

    def test_a_tab_arriving_mid_teardown_waits_and_gets_a_fresh_set(
        self, pool: HubPool, roots: List[Path], slow_teardown: Tuple[Any, Any]
    ):
        started, release = slow_teardown
        root = str(roots[0])
        dying = run(pool.acquire(root)).hub_set
        assert dying is not None
        pool.release(root)

        async def scenario() -> Tuple[Any, Any]:
            reaper = asyncio.ensure_future(pool.reap_once())
            await started.wait()  # the teardown is in flight, holding the lock
            # The arriving tab queues on the lock the teardown holds. Let the
            # teardown finish *after* it has queued, so the wait is real.
            arriving = asyncio.ensure_future(pool.acquire(root))
            await asyncio.sleep(0)
            release.set()
            let_go = await asyncio.wait_for(reaper, timeout=2)
            return await asyncio.wait_for(arriving, timeout=2), let_go

        arriving, let_go = run(scenario())

        # The arriving tab was **not** handed the set being stopped: it waited and
        # got a new one, flagged as built so the interface can say so (rule 23).
        assert arriving.hub_set is not dying
        assert arriving.built is True
        assert arriving.hub_set is not None
        assert arriving.hub_set.mcp.starts == 1
        assert pool.live(root) is arriving.hub_set
        assert let_go == [root]

    def test_a_tab_that_arrived_first_saves_the_workspace(
        self, pool: HubPool, roots: List[Path]
    ):
        """The reaper re-asks its own condition once it holds the lock.

        Driven by holding the workspace's admission lock from the outside, which
        is the only way to make the reaper actually *wait* between its first look
        and the teardown: an uncontended ``async with`` never yields. With the
        reaper parked on the lock, a tab arrives (the fast path, no lock needed),
        and the reaper must then answer "not releasable" rather than stop the
        tools of a workspace that has a tab on it.
        """
        root = str(roots[0])
        hub_set = run(pool.acquire(root)).hub_set
        assert hub_set is not None
        pool.release(root)

        async def scenario() -> List[str]:
            lock = pool._admission_lock(root)
            await lock.acquire()
            try:
                reaper = asyncio.ensure_future(pool.reap_once())
                await asyncio.sleep(0)  # let it pass its first look and park
                arrived = await pool.acquire(root)  # the fast path: stamps it
                assert arrived.built is False
                lock.release()
                return await asyncio.wait_for(reaper, timeout=2)
            finally:
                if lock.locked():
                    lock.release()

        assert run(scenario()) == []
        assert pool.roots() == [root]
        assert (hub_set.mcp.stops, hub_set.lsp.stops) == (0, 0)

# -- the four rules -------------------------------------------------------------


class TestTheCeiling:
    def test_the_next_root_is_refused_with_one_sentence(
        self, pool: HubPool, roots: List[Path], monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(hubpool, "MAX_LIVE_WORKSPACES", 2)
        for root in roots[:2]:
            assert run(pool.acquire(str(root))).built is True
        # Nothing may be built for the folder that is about to be refused.
        RecordingManager.built = []

        refused = run(pool.acquire(str(roots[2])))

        assert refused.hub_set is None
        assert refused.built is False
        assert refused.refusal is not None
        # The sentence names the bound, and the workspaces that hold it.
        assert "2" in refused.refusal
        assert str(roots[0]) in refused.refusal
        assert str(roots[1]) in refused.refusal
        # ... and says what to do about it.
        assert "Point another tab away" in refused.refusal
        # The refused folder is the one that was asked for: nothing was built for
        # it, and nothing was written into it.
        assert reserved_files(roots[2]) == []
        assert RecordingManager.built == []

    def test_the_ceiling_never_evicts_a_live_workspace(
        self, pool: HubPool, roots: List[Path], monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(hubpool, "MAX_LIVE_WORKSPACES", 1)
        kept = run(pool.acquire(str(roots[0])))
        assert run(pool.acquire(str(roots[1]))).refusal is not None

        # The live one is untouched: still there, still started, still usable.
        assert pool.roots() == [str(roots[0])]
        assert kept.hub_set is not None
        assert (kept.hub_set.mcp.stops, kept.hub_set.lsp.stops) == (0, 0)
        assert run(pool.acquire(str(roots[0]))).hub_set is kept.hub_set

    def test_a_slot_freed_by_the_idle_rule_admits_the_next(
        self, pool: HubPool, roots: List[Path], monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(hubpool, "MAX_LIVE_WORKSPACES", 1)
        run(pool.acquire(str(roots[0])))
        assert run(pool.acquire(str(roots[1]))).refusal is not None
        pool.release(str(roots[0]))
        assert run(pool.reap_once()) == [str(roots[0])]

        admitted = run(pool.acquire(str(roots[1])))
        assert admitted.built is True
        assert pool.roots() == [str(roots[1])]

    def test_the_sentence_is_the_pools_one_builder(self):
        """The API raises this text as a 429; it must not re-word it."""
        sentence = ceiling_sentence(["/a", "/b"], 3)
        assert "3" in sentence and "/a" in sentence and "/b" in sentence
        assert ceiling_sentence([], 3) == sentence.replace("/a, /b", "none")


class TestTheIdleRule:
    def test_a_root_past_its_window_is_stopped_and_its_slot_freed(
        self, pool: HubPool, roots: List[Path], monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(hubpool, "IDLE_RELEASE_SECONDS", 0.0)
        hub_set = run(pool.acquire(str(roots[0]))).hub_set
        assert hub_set is not None

        let_go = run(pool.reap_once())

        assert let_go == [str(roots[0])]
        assert pool.roots() == []
        assert pool.live(str(roots[0])) is None
        # The teardown is the managers' own ``stop_all`` — the shared process-tree
        # path — and it ran exactly once each.
        assert (hub_set.mcp.stops, hub_set.lsp.stops) == (1, 1)

    def test_a_root_inside_its_window_is_kept(
        self, pool: HubPool, roots: List[Path]
    ):
        run(pool.acquire(str(roots[0])))
        assert run(pool.reap_once()) == []
        assert pool.roots() == [str(roots[0])]

    def test_releasing_marks_idle_without_stopping_anything(
        self, pool: HubPool, roots: List[Path]
    ):
        hub_set = run(pool.acquire(str(roots[0]))).hub_set
        assert hub_set is not None
        assert pool.release(str(roots[0])) is True
        assert hub_set.idle is True
        assert (hub_set.mcp.stops, hub_set.lsp.stops) == (0, 0)
        # A folder that was never admitted is answered as such, not as released.
        assert pool.release(str(roots[1])) is False

    def test_an_acquire_of_a_released_root_clears_the_mark(
        self, pool: HubPool, roots: List[Path]
    ):
        """A tab that came back is not the tab that left."""
        run(pool.acquire(str(roots[0])))
        pool.release(str(roots[0]))
        run(pool.acquire(str(roots[0])))
        assert run(pool.reap_once()) == []

    def test_one_reaper_for_the_whole_pool(
        self, pool: HubPool, roots: List[Path], monkeypatch: pytest.MonkeyPatch
    ):
        """The reaper is the app's loop's timer, not a thread per workspace."""
        scheduled: List[float] = []

        class FakeLoop:
            def call_later(self, delay: float, callback: Any) -> Any:
                scheduled.append(delay)
                return object()

        monkeypatch.setattr(hubpool, "REAPER_INTERVAL_SECONDS", 12.5)
        pool.start_reaper(loop=FakeLoop())  # type: ignore[arg-type]
        assert scheduled == [12.5]
        run(pool.acquire(str(roots[0])))
        run(pool.acquire(str(roots[1])))
        assert scheduled == [12.5]


class TestTheVeto:
    def test_a_busy_workspace_is_never_let_go(
        self, pool: HubPool, roots: List[Path], monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(hubpool, "IDLE_RELEASE_SECONDS", 0.0)
        busy = roots[0]
        hub_set = run(pool.acquire(str(busy))).hub_set
        assert hub_set is not None
        pool.set_busy_predicate(lambda root: root == str(busy))
        pool.release(str(busy))

        assert run(pool.reap_once()) == []
        assert pool.roots() == [str(busy)]
        assert (hub_set.mcp.stops, hub_set.lsp.stops) == (0, 0)

    def test_the_same_workspace_is_released_once_it_is_not_busy(
        self, pool: HubPool, roots: List[Path], monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(hubpool, "IDLE_RELEASE_SECONDS", 0.0)
        busy = roots[0]
        pool.set_busy_predicate(lambda root: root == str(busy))
        run(pool.acquire(str(busy)))
        pool.release(str(busy))
        assert run(pool.reap_once()) == []

        pool.set_busy_predicate(lambda root: False)
        assert run(pool.reap_once()) == [str(busy)]

    def test_the_veto_is_asked_of_the_workspace_and_no_other(
        self, pool: HubPool, roots: List[Path], monkeypatch: pytest.MonkeyPatch
    ):
        """A reply on A says nothing about B — including to the reaper."""
        monkeypatch.setattr(hubpool, "IDLE_RELEASE_SECONDS", 0.0)
        asked: List[str] = []
        pool.set_busy_predicate(lambda root: asked.append(root) or root == str(roots[0]))
        for root in roots[:2]:
            run(pool.acquire(str(root)))
            pool.release(str(root))

        assert run(pool.reap_once()) == [str(roots[1])]
        assert pool.roots() == [str(roots[0])]
        assert set(asked) == {str(roots[0]), str(roots[1])}

    def test_a_predicate_that_raises_is_answered_as_busy(
        self, pool: HubPool, roots: List[Path], monkeypatch: pytest.MonkeyPatch
    ):
        """The veto fails closed: a broken answer never tears a hub down."""
        monkeypatch.setattr(hubpool, "IDLE_RELEASE_SECONDS", 0.0)

        def explodes(root: str) -> bool:
            raise RuntimeError("the API asked about a folder it does not hold")

        pool.set_busy_predicate(explodes)
        run(pool.acquire(str(roots[0])))
        pool.release(str(roots[0]))
        assert run(pool.reap_once()) == []
        assert pool.roots() == [str(roots[0])]

    def test_no_predicate_means_nothing_is_busy(self, pool: HubPool):
        assert pool.is_busy("/anywhere") is False


class TestTheVisibleRestart:
    def test_a_returning_tab_is_told_its_tools_were_built(
        self, pool: HubPool, roots: List[Path], monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(hubpool, "IDLE_RELEASE_SECONDS", 0.0)
        root = roots[0]
        assert run(pool.acquire(str(root))).built is True
        assert run(pool.acquire(str(root))).built is False

        pool.release(str(root))
        run(pool.reap_once())

        returned = run(pool.acquire(str(root)))
        assert returned.built is True
        assert returned.hub_set is not None
        assert returned.hub_set.mcp.starts == 1

    def test_a_plain_acquire_answers_reused(self, pool: HubPool, roots: List[Path]):
        run(pool.acquire(str(roots[0])))
        assert run(pool.acquire(str(roots[0]))).built is False


# -- admission and seeding ------------------------------------------------------


class TestAdmissionSeeds:
    def test_a_fresh_root_gains_its_reserved_files_on_first_acquire(
        self, pool: HubPool, roots: List[Path]
    ):
        root = roots[0]
        assert reserved_files(root) == []
        run(pool.acquire(str(root)))
        assert reserved_files(root) == sorted(SEEDED_FILENAMES)
        # The LSP **declaration** is still never seeded: its entries are
        # per-machine, so the app hands out the template and nothing else.
        assert lsphub.constants.LSP_SETTINGS_FILENAME not in reserved_files(root)
        # And the folder gained nothing else at its root.
        assert sorted(item.name for item in root.iterdir()) == [
            mcphub.constants.POLICY_DIRNAME
        ]

    def test_the_second_acquire_writes_nothing(
        self, pool: HubPool, roots: List[Path]
    ):
        root = roots[0]
        run(pool.acquire(str(root)))
        written = {
            item.name: item.read_bytes() for item in reserved(root).iterdir()
        }
        run(pool.acquire(str(root)))
        assert {
            item.name: item.read_bytes() for item in reserved(root).iterdir()
        } == written

    def test_a_hand_edited_declaration_survives_admission(
        self, pool: HubPool, roots: List[Path]
    ):
        """The reserved folder is *created* when absent and changed outside the
        app, so admission must not touch what an operator wrote."""
        root = roots[0]
        declaration = reserved(root)
        declaration.mkdir()
        handwritten = '{"only-mine": {"type": "remote", "url": "https://x/mcp"}}\n'
        (declaration / mcphub.constants.MCP_SETTINGS_FILENAME).write_text(
            handwritten, encoding="utf-8"
        )
        run(pool.acquire(str(root)))
        assert (
            declaration / mcphub.constants.MCP_SETTINGS_FILENAME
        ).read_text(encoding="utf-8") == handwritten

    def test_the_declaration_is_seeded_before_the_manager_scans(
        self, pool: HubPool, roots: List[Path], real_declarations: None
    ):
        """The ordering rule, as the consequence it exists to keep.

        The MCP declaration lives inside the folder the manager is spawned
        against, so a hub built over an unseeded folder would come up with zero
        connectors. With the real seed and the real loader in place, an admitted
        fresh root is handed the two shipped connectors — the seed landed before
        the scan, in that order, or the list below would be empty.
        """
        hub_set = run(pool.acquire(str(roots[0]))).hub_set
        assert hub_set is not None
        assert [entry["id"] for entry in hub_set.mcp.entries] == ["console", "fedit"]

    def test_admission_also_drains_the_workspaces_trash(
        self, pool: HubPool, roots: List[Path]
    ):
        """The fourth of the boot's actions, so the two entry points stay one.

        The sweep is what keeps a folder nobody deletes into any more from
        rotting, and the boot has always done it at the same moment as the three
        seeds — so admission does too, and the batch it expires is the admitted
        workspace's own.
        """
        root = roots[0]
        batch = reserved(root) / "trash" / "2020-01-01-ancient"
        batch.mkdir(parents=True)
        stale = time.time() - 400 * 86400
        os.utime(batch, (stale, stale))

        run(pool.acquire(str(root)))

        assert not batch.exists()
        # The three seeds landed too, so admission is the whole boot pair. (The
        # empty ``trash`` folder this test created stays: a sweep expires
        # *batches*, never the folder that holds them.)
        assert reserved_files(root) == sorted(
            [*SEEDED_FILENAMES, "trash"]
        )

    def test_a_seeding_hiccup_is_a_note_never_a_refusal(
        self, pool: HubPool, roots: List[Path], monkeypatch: pytest.MonkeyPatch
    ):
        """An unwritable reserved file must not stop a workspace being served."""

        def explodes(root: str) -> Dict[str, Any]:
            raise OSError("the disk went away")

        monkeypatch.setattr(hubpool, "ensure_mcp_settings_file", explodes)
        acquired = run(pool.acquire(str(roots[0])))
        assert acquired.refusal is None
        assert acquired.hub_set is not None
        assert pool.roots() == [str(roots[0])]

    def test_the_boot_admits_the_folder_a_new_tab_lands_on(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """Boot calls the pool, so the two entry points cannot drift.

        The installation folder is where a new tab starts (spec D4), so it is
        admitted at boot like any other workspace — and the app's state carries
        the pool, not two hubs.
        """
        boot = tmp_path / "boot-workspace"
        boot.mkdir()
        make_the_install(monkeypatch, boot)
        with TestClient(create_app()) as client:
            pool = client.app.state.hubpool
            assert pool.boot_root == str(boot)
            assert pool.roots() == [str(boot)]
            # The pool is the only hub the app's state carries: the interim
            # ``app.state.mcp`` / ``app.state.lsp`` read-through is gone, so a
            # hub route has no way to answer about a folder other than the one
            # its request named.
            assert not hasattr(client.app.state, "mcp")
            assert not hasattr(client.app.state, "lsp")
        assert reserved_files(boot) == sorted(SEEDED_FILENAMES)

    def test_the_veto_is_registered_at_startup(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """The API answers the busy question; the pool only ever asks it."""
        boot = tmp_path / "boot-veto"
        boot.mkdir()
        make_the_install(monkeypatch, boot)
        with TestClient(create_app()) as client:
            pool = client.app.state.hubpool
            assert pool.is_busy(str(boot)) is False
            assert pool.is_busy(str(tmp_path / "elsewhere")) is False

    def test_the_busy_answer_is_the_workspaces_own(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """The registered veto is the per-workspace one, not a global flag.

        A reply streaming on one folder must not make the pool hold every other
        folder still (spec §5.3 rule 13), so the predicate is asked *of a root*
        and answers about that root alone.
        """
        from src.api import routes

        boot = tmp_path / "boot-veto-two"
        boot.mkdir()
        make_the_install(monkeypatch, boot)
        with TestClient(create_app()) as client:
            pool = client.app.state.hubpool
            routes._CHAT_TASKS["a-task"] = str(boot)
            try:
                assert pool.is_busy(str(boot)) is True
                assert pool.is_busy(str(tmp_path / "elsewhere")) is False
            finally:
                routes._CHAT_TASKS.pop("a-task", None)


# -- the placeholder resolves per workspace -------------------------------------


class TestThePlaceholderPerWorkspace:
    """Spec §4.3 / §5.4 rule 21, at the one place it could go wrong.

    ``${NOJAE_PATH_LOCATION}`` must mean *the workspace being served*, so a
    declaration read for A expands to A and one read for B expands to B — in one
    process, with both alive at once. ``${PROJECT_ROOT}`` keeps meaning the
    installation in both, and the two must never converge.
    """

    def _write_declarations(self, root: Path) -> None:
        folder = reserved(root)
        folder.mkdir()
        (folder / mcphub.constants.MCP_SETTINGS_FILENAME).write_text(
            json.dumps(
                {
                    "console": {
                        "type": "local",
                        "enable": True,
                        "command": [
                            "python",
                            "console_mcp.py",
                            "--root-dir",
                            "${NOJAE_PATH_LOCATION}",
                            "--install",
                            "${PROJECT_ROOT}",
                        ],
                    }
                }
            ),
            encoding="utf-8",
        )
        (folder / lsphub.constants.LSP_SETTINGS_FILENAME).write_text(
            json.dumps(
                {
                    "pyright": {
                        "enable": True,
                        "extensions": [".py"],
                        "command": ["pyright-langserver", "--stdio"],
                        "workspaceRoot": "${NOJAE_PATH_LOCATION}",
                    }
                }
            ),
            encoding="utf-8",
        )

    def test_each_workspaces_declaration_expands_to_that_workspace(
        self, pool: HubPool, roots: List[Path], real_declarations: None
    ):
        first, second = roots[0], roots[1]
        self._write_declarations(first)
        self._write_declarations(second)

        set_a = run(pool.acquire(str(first))).hub_set
        set_b = run(pool.acquire(str(second))).hub_set
        assert set_a is not None and set_b is not None

        install = str(config_module.PROJECT_ROOT)
        for hub_set, root in ((set_a, first), (set_b, second)):
            command = hub_set.mcp.entries[0]["command"]
            assert command[command.index("--root-dir") + 1] == str(root)
            # The install-root placeholder keeps its meaning, in every workspace.
            assert command[command.index("--install") + 1] == install
            assert hub_set.lsp.entries[0]["workspaceRoot"] == str(root)

    def test_the_two_hubs_of_one_workspace_are_built_in_its_scope(
        self, pool: HubPool, roots: List[Path], real_declarations: None
    ):
        """The scope is entered around the build, not left to the caller.

        Nothing here is inside a request, so the seam would answer the interim
        default: the folder the pool read is proof it entered its own.
        """
        root = roots[0]
        self._write_declarations(root)
        assert workspace.current_root() != str(root)
        hub_set = run(pool.acquire(str(root))).hub_set
        assert hub_set is not None
        assert hub_set.lsp.entries[0]["workspaceRoot"] == str(root)
        assert workspace.current_root() != str(root)

    def test_the_disable_switches_hold_per_workspace(
        self, pool: HubPool, roots: List[Path]
    ):
        """The switches keep a hermetic test off every hub, on **any** folder.

        The suite sets both switches, and the pool honours them per workspace
        rather than only for the boot one: a folder admitted later on a request
        of its own is no more allowed to spawn something than the boot folder
        was.
        """
        self._write_declarations(roots[0])
        hub_set = run(pool.acquire(str(roots[0]))).hub_set
        assert hub_set is not None
        assert hub_set.mcp.entries == []
        assert hub_set.lsp.entries == []
        assert os.environ.get(hubpool.DISABLE_MCP_ENV)


# -- status and shutdown --------------------------------------------------------


class TestStatusAndShutdown:
    def test_status_reports_one_line_per_live_workspace(
        self, pool: HubPool, roots: List[Path]
    ):
        run(pool.acquire(str(roots[0])))
        run(pool.acquire(str(roots[1])))
        pool.release(str(roots[1]))

        lines = pool.status()
        assert [line["root"] for line in lines] == [str(roots[0]), str(roots[1])]
        for line in lines:
            assert set(line) == {
                "root",
                "state",
                "secondsSinceUse",
                "secondsSinceBuild",
                "idle",
            }
            assert line["state"] in ("running", "starting", "idle")
            assert line["secondsSinceUse"] >= 0.0
        assert [line["idle"] for line in lines] == [False, True]

    def test_a_starting_connector_makes_the_workspace_starting(
        self, pool: HubPool, roots: List[Path]
    ):
        hub_set = run(pool.acquire(str(roots[0]))).hub_set
        assert hub_set is not None
        assert hub_set.state() == "idle"
        hub_set.mcp.statuses = [{"id": "console", "status": "running"}]
        assert hub_set.state() == "running"
        hub_set.lsp.statuses = [{"id": "pyright", "status": "starting"}]
        assert hub_set.state() == "starting"

    def test_stop_all_stops_every_set_once_per_manager(
        self, pool: HubPool, roots: List[Path]
    ):
        sets = [run(pool.acquire(str(root))).hub_set for root in roots[:3]]
        run(pool.stop_all())

        assert pool.roots() == []
        for hub_set in sets:
            assert hub_set is not None
            assert (hub_set.mcp.stops, hub_set.lsp.stops) == (1, 1)

    def test_stop_all_survives_one_manager_that_raises(
        self, pool: HubPool, roots: List[Path]
    ):
        """One workspace's broken teardown must not strand the others'."""
        sets = [run(pool.acquire(str(root))).hub_set for root in roots[:2]]
        assert sets[0] is not None

        async def explodes() -> None:
            raise RuntimeError("the hub thread would not join")

        sets[0].lsp.stop_all = explodes  # type: ignore[method-assign]
        run(pool.stop_all())

        assert pool.roots() == []
        assert sets[1] is not None and sets[1].mcp.stops == 1

    def test_a_set_stops_both_managers_even_if_the_first_raises(
        self, pool: HubPool, roots: List[Path]
    ):
        """A language server that will not join must not spare the connectors.

        The teardown is the app's only promise that no child outlives the
        workspace, so one manager failing to stop cannot be the reason the other
        is never asked.
        """
        hub_set = run(pool.acquire(str(roots[0]))).hub_set
        assert hub_set is not None

        async def explodes() -> None:
            raise RuntimeError("the lsp hub thread would not join")

        hub_set.lsp.stop_all = explodes  # type: ignore[method-assign]
        with pytest.raises(RuntimeError):
            run(hub_set.stop_all())
        assert hub_set.mcp.stops == 1

    def test_a_reaper_pass_survives_a_workspace_that_will_not_stop(
        self, pool: HubPool, roots: List[Path], monkeypatch: pytest.MonkeyPatch
    ):
        """The slot is freed and the next workspace is still reaped."""
        monkeypatch.setattr(hubpool, "IDLE_RELEASE_SECONDS", 0.0)
        sets = [run(pool.acquire(str(root))).hub_set for root in roots[:2]]
        assert sets[0] is not None

        async def explodes() -> None:
            raise RuntimeError("no teardown")

        sets[0].lsp.stop_all = explodes  # type: ignore[method-assign]
        pool.release(str(roots[0]))
        pool.release(str(roots[1]))
        assert run(pool.reap_once()) == [str(roots[0]), str(roots[1])]
        assert pool.roots() == []
        assert sets[1] is not None and sets[1].mcp.stops == 1

    def test_a_set_restarts_its_managers_in_place(
        self, pool: HubPool, roots: List[Path], real_declarations: None
    ):
        """The pool must not replace what a worker thread holds.

        ``HubSet.restart`` re-reads the folder's declarations and hands them to
        the two managers' own ``restart`` — the same objects, so an in-flight
        conversation keeps the manager it resolved at its turn's start.
        """
        declaration_of(roots[0], ["console"])
        lsp_declaration_of(roots[0], ["pyright"])
        hub_set = run(pool.acquire(str(roots[0]))).hub_set
        assert hub_set is not None
        mcp, lsp = hub_set.mcp, hub_set.lsp

        run(hub_set.restart())

        assert hub_set.mcp is mcp and hub_set.lsp is lsp
        assert len(mcp.restarts) == 1 and len(lsp.restarts) == 1
        # Re-read **inside this workspace's scope**, so the fresh list is this
        # folder's declaration and not whichever folder the process holds.
        assert [entry["id"] for entry in mcp.restarts[0][0]] == ["console"]
        assert [entry["id"] for entry in lsp.restarts[0][0]] == ["pyright"]
        # The LSP restart is handed the ids whose ``enable`` flag is on — the one
        # gate, the same answer the build used.
        assert lsp.restarts[0][1] == ["pyright"]


# -- the hub routes follow the request (clws-06) --------------------------------


@pytest.fixture
def route_client(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path, real_declarations: None
):
    """A live app whose two managers are the recording double, on a scratch boot root.

    ``real_declarations`` un-pins the two declaration lookups and clears the two
    dev/test switches, so the **scope** is the only thing that can decide whose
    declaration a route read — which is exactly the question these cases ask.
    The managers are still the recording double (the autouse fixture above), so
    nothing here spawns a connector or a language server.
    """
    from src import config as config_module
    from src.api.server import create_app

    boot = tmp_path / "boot-project"
    boot.mkdir()
    make_the_install(monkeypatch, boot)
    with TestClient(create_app()) as client:
        yield client, boot


def workspace_declaration(client, root: Path, mcp_ids, lsp_ids) -> None:
    """Give ``root`` its own two declarations, then admit it through the pool."""
    declaration_of(root, mcp_ids)
    lsp_declaration_of(root, lsp_ids)
    client.app.state.hubpool.acquire_sync(str(root))


class TestTheHubRoutesAnswerTheRequestsWorkspace:
    """``GET /api/mcp?workspace=A`` offers A's connectors and never B's (spec §10.5).

    The pool has held one set per folder since clws-05; what these cases pin is
    that the **routes** reach it with the folder their request named, which is
    the half that makes a panel show the right catalogue.
    """

    def test_two_folders_offer_their_own_connectors(
        self, route_client, tmp_path: Path
    ):
        client, _boot = route_client
        first = tmp_path / "repo-a"
        second = tmp_path / "repo-b"
        for root in (first, second):
            root.mkdir()
        workspace_declaration(client, first, ["console"], ["pyright"])
        workspace_declaration(client, second, ["fedit"], ["vue"])

        in_a = client.get("/api/mcp", params=workspace_params(first)).json()
        in_b = client.get("/api/mcp", params=workspace_params(second)).json()

        assert [c["id"] for c in in_a["connectors"]] == ["console"]
        assert [c["id"] for c in in_b["connectors"]] == ["fedit"]
        # Neither offers the other's — the failure this whole lot exists to kill.
        assert "fedit" not in json.dumps(in_a)
        assert "console" not in json.dumps(in_b)

    def test_two_folders_offer_their_own_language_servers(
        self, route_client, tmp_path: Path
    ):
        client, _boot = route_client
        first = tmp_path / "repo-a"
        second = tmp_path / "repo-b"
        for root in (first, second):
            root.mkdir()
        workspace_declaration(client, first, ["console"], ["pyright"])
        workspace_declaration(client, second, ["fedit"], ["vue"])

        in_a = client.get("/api/lsp", params=workspace_params(first)).json()
        in_b = client.get("/api/lsp", params=workspace_params(second)).json()

        assert [s["id"] for s in in_a["servers"]] == ["pyright"]
        assert [s["id"] for s in in_b["servers"]] == ["vue"]
        assert "vue" not in json.dumps(in_a)
        assert "pyright" not in json.dumps(in_b)

    def test_a_restart_in_one_workspace_leaves_the_other_alone(
        self, route_client, tmp_path: Path
    ):
        """Rule 13's hub half: a restart is the workspace's, not the process's."""
        client, _boot = route_client
        first = tmp_path / "repo-a"
        second = tmp_path / "repo-b"
        for root in (first, second):
            root.mkdir()
        workspace_declaration(client, first, ["console"], ["pyright"])
        workspace_declaration(client, second, ["fedit"], ["vue"])
        pool = client.app.state.hubpool
        set_a = pool.live(str(first))
        set_b = pool.live(str(second))
        assert set_a is not None and set_b is not None
        # B's servers are *running*, so "untouched" is a fact with teeth.
        set_b.lsp.statuses = [{"id": "vue", "status": "running"}]
        set_b.mcp.statuses = [{"id": "fedit", "status": "running"}]

        mcp_restart = client.post(
            "/api/mcp/restart", params=workspace_params(first)
        )
        lsp_restart = client.post(
            "/api/lsp/restart", params=workspace_params(first)
        )
        assert mcp_restart.status_code == 200
        assert lsp_restart.status_code == 200
        # Rule 23's other half: the request that **rebuilt** the tools says so,
        # so the panel that pressed Restart can say what happened.
        assert mcp_restart.json()["built"] is True
        assert lsp_restart.json()["built"] is True

        # A's own two managers were rebuilt, in place, from A's declarations.
        assert len(set_a.mcp.restarts) == 1
        assert [entry["id"] for entry in set_a.mcp.restarts[0][0]] == ["console"]
        assert len(set_a.lsp.restarts) == 1
        assert [entry["id"] for entry in set_a.lsp.restarts[0][0]] == ["pyright"]
        # B was not touched at all: no restart, no status change, same objects.
        assert set_b.mcp.restarts == []
        assert set_b.lsp.restarts == []
        assert set_b.mcp.statuses == [{"id": "fedit", "status": "running"}]
        assert set_b.lsp.statuses == [{"id": "vue", "status": "running"}]
        assert pool.live(str(second)) is set_b

    def test_the_enable_flag_write_lands_in_the_named_workspaces_file(
        self, route_client, tmp_path: Path
    ):
        """The two declaration writes are the workspace's too (spec §5.4 rule 20).

        ``set_externals_enabled`` / ``set_lsp_enabled`` build their path per call
        from the scope, so a toggle saved in A must rewrite **A's** file and leave
        B's bytes alone — and the hot start/stop must go to A's manager.
        """
        client, _boot = route_client
        first = tmp_path / "repo-a"
        second = tmp_path / "repo-b"
        for root in (first, second):
            root.mkdir()
        workspace_declaration(client, first, ["console"], ["pyright"])
        workspace_declaration(client, second, ["fedit"], ["vue"])
        before_b = (second / ".nojae" / "mcp-settings.json").read_text(encoding="utf-8")
        pool = client.app.state.hubpool
        # A's connector is *running*, so unticking it has something to stop; B's
        # is too, and must not be stopped by A's save.
        pool.live(str(first)).mcp.statuses = [{"id": "console", "status": "running"}]
        pool.live(str(second)).mcp.statuses = [{"id": "fedit", "status": "running"}]

        response = client.post(
            "/api/mcp", params=workspace_params(first), json={"enabled": []}
        )

        assert response.status_code == 200
        assert all(not c["active"] for c in response.json()["connectors"])
        # A's file holds the new flags; B's is byte-identical.
        assert json.loads(
            (first / ".nojae" / "mcp-settings.json").read_text(encoding="utf-8")
        )["console"]["enable"] is False
        assert (
            second / ".nojae" / "mcp-settings.json"
        ).read_text(encoding="utf-8") == before_b
        # And the hot stop went to A's manager only.
        assert pool.live(str(first)).mcp.stopped == ["console"]
        assert pool.live(str(second)).mcp.stopped == []

        # The LSP side is the same route shape on the other declaration file, so
        # it is asked the same question here rather than in a copy of this test.
        pool.live(str(first)).lsp.statuses = [{"id": "pyright", "status": "running"}]
        pool.live(str(second)).lsp.statuses = [{"id": "vue", "status": "running"}]
        before_lsp_b = (
            second / ".nojae" / "lsp-settings.json"
        ).read_text(encoding="utf-8")

        lsp_response = client.post(
            "/api/lsp", params=workspace_params(first), json={"enabled": []}
        )

        assert lsp_response.status_code == 200
        assert json.loads(
            (first / ".nojae" / "lsp-settings.json").read_text(encoding="utf-8")
        )["pyright"]["enable"] is False
        assert (
            second / ".nojae" / "lsp-settings.json"
        ).read_text(encoding="utf-8") == before_lsp_b
        assert pool.live(str(first)).lsp.stopped == ["pyright"]
        assert pool.live(str(second)).lsp.stopped == []

    def test_the_ceiling_refuses_a_hub_route_with_the_pools_sentence(
        self, route_client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """A folder the pool cannot serve is a 429 naming the bound, not an empty list."""
        client, boot = route_client
        monkeypatch.setattr(hubpool, "MAX_LIVE_WORKSPACES", 1)
        unopened = tmp_path / "one-too-many"
        unopened.mkdir()

        response = client.get("/api/mcp", params=workspace_params(unopened))

        assert response.status_code == 429
        detail = response.json()["detail"]
        assert "at most 1" in detail
        assert str(boot) in detail  # the live workspace that holds the slot
        # The same sentence from the restart route and from the workspace read.
        assert client.post(
            "/api/lsp/restart", params=workspace_params(unopened)
        ).json()["detail"] == detail
        assert client.get(
            "/api/workspace", params=workspace_params(unopened)
        ).json()["detail"] == detail
        # And a live workspace is still served: the refusal is the new folder's.
        assert client.get("/api/mcp", params=workspace_params(boot)).status_code == 200
        # The pool's summary carries the same sentence, so a tab that is *not*
        # refused can still be told the bound has been reached (task 11 renders
        # this line; nothing renders it yet).
        pool = client.get(
            "/api/workspace", params=workspace_params(boot)
        ).json()["hubs"]["pool"]
        assert pool["atLimit"] is True
        assert pool["sentence"] == detail

    def test_the_workspace_read_reports_the_live_workspaces_and_the_bound(
        self, route_client, tmp_path: Path
    ):
        """``hubs.pool`` is the data task 11 renders (spec §4.4, rule 22)."""
        client, boot = route_client
        first = tmp_path / "repo-a"
        second = tmp_path / "repo-b"
        for root in (first, second):
            root.mkdir()
        workspace_declaration(client, first, ["console"], ["pyright"])
        workspace_declaration(client, second, ["fedit"], ["vue"])

        hubs = client.get("/api/workspace", params=workspace_params(first)).json()["hubs"]
        pool = hubs["pool"]

        assert set(pool) == {"workspaces", "limit", "atLimit", "sentence"}
        assert pool["limit"] == hubpool.MAX_LIVE_WORKSPACES
        assert pool["atLimit"] is False
        assert pool["sentence"] is None
        assert set(str(root) for root in (boot, first, second)) <= {
            row["root"] for row in pool["workspaces"]
        }
        # Every live row says what its tools are doing and when they were used.
        row = next(r for r in pool["workspaces"] if r["root"] == str(first))
        assert set(row) == {
            "root", "state", "secondsSinceUse", "secondsSinceBuild", "idle",
        }

    def test_the_built_flag_marks_the_request_that_brought_the_tools_back(
        self, route_client, tmp_path: Path
    ):
        """Rule 23's data half: a returning tab is *told*, not left to guess."""
        client, _boot = route_client
        root = tmp_path / "cold-then-warm"
        root.mkdir()
        declaration_of(root, ["console"])
        lsp_declaration_of(root, ["pyright"])

        first = client.get("/api/mcp", params=workspace_params(root)).json()
        again = client.get("/api/mcp", params=workspace_params(root)).json()

        assert first["built"] is True
        assert again["built"] is False
        assert client.get(
            "/api/lsp", params=workspace_params(root)
        ).json()["built"] is False


class TestThePoolIsTheOnlyThingTheHubRoutesReach:
    """Structure: no route may re-introduce a process-wide hub.

    The behaviour cases above can only cover the folders they name, so the
    structural half is what keeps the rule true of a route nobody thought to
    test: every hub handler resolves its request's workspace, and nothing in
    ``src`` reads a hub off the app's state — which is how the interim
    read-through stays deleted rather than resurrected by one careless line.
    """

    #: The eight hub routes, as ``routes.py`` registers them.
    HUB_ROUTES = {
        ("get", "/mcp"),
        ("post", "/mcp"),
        ("post", "/mcp/restart"),
        ("get", "/lsp"),
        ("post", "/lsp"),
        ("post", "/lsp/restart"),
        ("post", "/lsp/query"),
        ("get", "/lsp/log"),
    }

    @staticmethod
    def _handlers() -> Dict[Tuple[str, str], Any]:
        from pathlib import Path

        source = (
            Path(__file__).resolve().parent.parent / "src" / "api" / "routes.py"
        ).read_text(encoding="utf-8")
        found: Dict[str, Any] = {}
        for node in ast.walk(ast.parse(source)):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for decorator in node.decorator_list:
                if (
                    isinstance(decorator, ast.Call)
                    and isinstance(decorator.func, ast.Attribute)
                    and decorator.args
                    and isinstance(decorator.args[0], ast.Constant)
                    and isinstance(decorator.args[0].value, str)
                ):
                    found[
                        (decorator.func.attr, decorator.args[0].value)
                    ] = node
        return found

    def test_every_hub_route_resolves_its_workspaces_set(self):
        handlers = self._handlers()
        assert self.HUB_ROUTES <= set(handlers), (
            "a hub route was renamed or removed without this list knowing: "
            f"{sorted(self.HUB_ROUTES - set(handlers))}"
        )
        for key in sorted(self.HUB_ROUTES):
            names = {
                node.func.id
                for node in ast.walk(handlers[key])
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            }
            # The one way a handler may get a manager at all: through the pool
            # helpers, each of which resolves the request's workspace first. A
            # route that reached for a manager any other way would be answering
            # about a folder its request never named.
            assert names & {
                "_acquire_hub_set", "_acquire_hub_set_async", "_read_hub_set",
            }, key

    def test_no_source_file_names_a_process_wide_hub(self):
        """The shim's grep, as an assertion: ``src`` holds no such name."""
        from pathlib import Path

        root = Path(__file__).resolve().parent.parent / "src"
        offenders = [
            f"{path}:{lineno}"
            for path in sorted(root.rglob("*.py"))
            for lineno, line in enumerate(
                path.read_text(encoding="utf-8").splitlines(), start=1
            )
            if "app.state.mcp" in line or "app.state.lsp" in line
        ]
        assert offenders == [], (
            "a process-wide hub name is back, so a hub route could answer "
            f"about the boot folder: {offenders}"
        )
