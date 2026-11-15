"""``HubPool``: one set of tools per workspace, bounded, and let go when idle.

A connector and a language server are bound to a folder **at birth** — a local
connector is spawned with the folder as its ``--root-dir``, a language server
with the folder as its ``workspaceRoot``, and neither can be pointed elsewhere
for the rest of its life (spec §3.1). So two workspaces cannot be served by one
hub: each folder needs **one of each**, spawned against it, answering about it
and nothing else, and torn down with it (spec §4.3, §5.4 rule 20).

**The pool is the long-lived singleton, not the manager.** The app holds one
:class:`HubPool`; a workspace's two managers live inside its :class:`HubSet` and
are rebuilt *in place* by :meth:`HubSet.restart` — never replaced while a worker
thread holds them, because a chat worker keeps the manager reference it resolved
at its turn's start for the whole turn. That is the same reason the managers' own
``restart`` docstrings give for keeping their object identity, read one level up:
something other than a single request owns the object.

Four rules bound the set (spec §4.4), and all four are this module's, not the
routes':

* **the ceiling** — at most :data:`MAX_LIVE_WORKSPACES` workspaces are alive at
  once, and the ``N+1``th is refused with :func:`ceiling_sentence`, which names
  the bound and the folders that hold it. Never a silent eviction of the tab that
  just asked, and never a live one evicted to make room;
* **the idle rule** — a workspace nobody has asked anything about for
  :data:`IDLE_RELEASE_SECONDS` is stopped and removed, freeing its slot. One
  reaper on the app's own event loop (the LSP hub keeps one on its own thread:
  same shape, same granularity), not a thread per workspace;
* **the veto** — a workspace with a streaming reply or a running batch is never
  let go. The pool asks through an injected ``busy(root) -> bool`` callable rather
  than importing the API (core owns logic, the API owns transport); an idle
  attempt on a busy workspace is skipped and tried again next tick;
* **the visible restart** — :meth:`HubPool.acquire` reports whether it *built*
  the set, so a tab returning to a workspace whose tools were let go is told its
  tools are coming back rather than silently left without them (rule 23).

**Admission is the one moment a folder's reserved folder is seeded** — the same
actions the boot performs, in the same order, with the same contract (a seeding
hiccup is a note, never a failure). A repeated ``acquire`` of a live root writes
nothing, because a read of a workspace must never leave files inside it. The
installation folder is admitted at boot like any other, so the boot calls the
pool rather than a copy of the pool's seeding.

**The scope is the pool's, not the hubs'.** :meth:`HubPool.acquire` enters
:func:`src.core.workspace.scope` around the seeding, the declaration scan and the
build, so ``${NOJAE_PATH_LOCATION}`` in a workspace's declaration expands to
*that* workspace while ``${PROJECT_ROOT}`` still means the installation in every
one of them (spec §4.3). Neither manager takes a root argument: they read their
declarations through ``constants.*_settings_path()``, which reads the scope.

Core only: no FastAPI, no browser, and every bound (:data:`MAX_LIVE_WORKSPACES`,
:data:`IDLE_RELEASE_SECONDS`, :data:`REAPER_INTERVAL_SECONDS`) and every
collaborator (the two manager classes, the two declaration loaders, the seeds)
read as a module attribute at call time, so a test can hold any of them.
"""

import asyncio
import logging
import os
import time
from typing import Any, Callable, Dict, List, NamedTuple, Optional, Sequence, Tuple

from src.core import workspace
from src.core.editorfs import mutate as editorfs_mutate, policy_seed
from src.core.lsphub import LspManager, all_servers, ensure_lsp_settings_template
from src.core.mcphub import McpManager, ensure_mcp_settings_file, load_externals

logger = logging.getLogger("nojae.hubpool")

#: How many workspaces may be alive at once. Small and stated, because "as many
#: tabs as I open" (spec D3) is not a licence to keep N sets of connector
#: processes and N language-server indexes resident forever (spec §4.4). Six:
#: the count includes the installation folder every new tab lands on, so a
#: smaller bound would leave room for only two or three real projects — and
#: reaching it is a hard stop for the tab that asked. Read at call time, so a
#: test patches this attribute rather than the pool.
MAX_LIVE_WORKSPACES = 6

#: How long a workspace nobody has asked anything about is kept alive: long
#: enough that moving a tab back is free, short enough that a folder the user
#: left an hour ago is not still holding an index and a set of connectors.
IDLE_RELEASE_SECONDS = 1800.0

#: How often the reaper wakes up on the app's loop — the same granularity the
#: LSP hub's own idle reaper keeps (``lsphub.constants.REAPER_INTERVAL_SECONDS``).
REAPER_INTERVAL_SECONDS = 30.0

#: The two dev/test switches, honoured **per workspace** exactly as the lifespan
#: honoured them for the one hub of each kind: the endpoints stay usable, nothing
#: is connected. A hermetic test therefore reaches no hub, on any workspace.
DISABLE_MCP_ENV = "NOJAE_DISABLE_MCP"
DISABLE_LSP_ENV = "NOJAE_DISABLE_LSP"


def ceiling_sentence(live_roots: Sequence[str], limit: int = MAX_LIVE_WORKSPACES) -> str:
    """The one sentence the ceiling answers with (spec §4.4, rule 22).

    It names the bound, names the workspaces that hold it, and says what to do —
    point another tab away, or wait for an idle one to be let go. Built here so
    every surface that hits the ceiling describes it the same way, which is the
    same rule the seam's workspace refusals follow.
    """
    live = ", ".join(live_roots) if live_roots else "none"
    return (
        f"Too many workspaces are open at once: nojae keeps at most {limit} "
        f"alive, and these are the live ones — {live}. Point another tab away "
        "from one of them, or wait for an idle one to be let go."
    )


class HubSet:
    """One workspace's tools: its own ``McpManager`` and its own ``LspManager``.

    Built for one root, started and stopped together, and restarted **in place**:
    :meth:`restart` re-reads this workspace's declarations and hands them to the
    two managers' own ``restart``, which rebuilds their internals while keeping
    the object every worker thread already holds. The pool must not swap the
    managers out for the same reason the managers must not swap their hub threads
    — and for the same reason the pool, not a manager, is the app's singleton.

    ``created_at`` and ``last_used`` are **monotonic** stamps: the idle rule
    compares them with each other, so a wall-clock change cannot evict a
    workspace early or keep one alive forever.
    """

    def __init__(self, root: str, mcp: Any, lsp: Any) -> None:
        self.root = root
        self.mcp = mcp
        self.lsp = lsp
        now = time.monotonic()
        self.created_at = now
        self.last_used = now
        #: Set by :meth:`HubPool.release`: no tab is behind this workspace any
        #: more, so the next reaper tick may let it go (subject to the veto).
        self.idle = False
        #: Set by the reaper the moment it starts tearing this set down, while it
        #: holds the workspace's admission lock. :meth:`HubPool.acquire` will not
        #: hand out a set that is on its way out: it waits for the teardown and
        #: then builds a fresh one, which is the visible restart.
        self.releasing = False

    # -- lifecycle -----------------------------------------------------------

    async def start(self) -> None:
        """Bring both managers up. Never raises (neither ``start_all`` does)."""
        await self.mcp.start_all()
        await self.lsp.start_all()

    async def stop_all(self) -> None:
        """Tear both managers down, through their own ``stop_all``.

        Those *are* the shared ``proctree`` teardown (process trees, not
        wrappers): the pool adds no second teardown path. The LSP hub goes first
        because that is the order the app's shutdown block has always used.

        Both are asked even if the first raises, and the first error is then
        re-raised: a language server that would not join must not be what keeps a
        workspace's connector children alive. Neither manager's own ``stop_all``
        is expected to raise, so this is the guard, not the normal path.
        """
        failures: List[BaseException] = []
        for manager in (self.lsp, self.mcp):
            try:
                await manager.stop_all()
            except BaseException as exc:  # noqa: BLE001 — the other one still goes
                failures.append(exc)
        if failures:
            raise failures[0]

    async def restart(self) -> None:
        """Re-read this workspace's declarations and rebuild both managers.

        The two halves are the two routes' own (:meth:`restart_mcp`,
        :meth:`restart_lsp`), so this is their pair rather than a third scan: a
        panel's Restart button rebuilds its own hub and says nothing about the
        other one's running sessions.
        """
        await self.restart_mcp()
        await self.restart_lsp()

    async def restart_mcp(self) -> None:
        """Rebuild **this workspace's** connector manager from its own declaration.

        The scan happens inside this workspace's scope, so the fresh list is this
        folder's ``.nojae/mcp-settings.json`` and ``${NOJAE_PATH_LOCATION}`` in it
        expands to this folder — which is the whole of spec §4.3 for a restart,
        and the reason the route cannot do the scan itself. The dev/test switch is
        honoured by :func:`declared_connectors`, the same reader the build used,
        so a restart on a switched-off hub rebuilds it empty rather than
        connecting anything.
        """
        with workspace.scope(self.root):
            await self.mcp.restart(declared_connectors())

    async def restart_lsp(self) -> None:
        """Rebuild **this workspace's** language-server manager from its own file.

        The mirror of :meth:`restart_mcp`, including the one activation gate: the
        ids handed over are exactly the entries whose ``enable`` flag is on, the
        same answer :func:`declared_servers` gave when the set was built.
        """
        with workspace.scope(self.root):
            servers, enabled_ids = declared_servers()
            await self.lsp.restart(servers, enabled_ids)

    # -- reporting -----------------------------------------------------------

    def state(self) -> str:
        """``running`` / ``starting`` / ``idle`` — one answer for the pair.

        ``starting`` wins over ``running`` because it is the state a user acts on:
        a workspace with a cold connector is not yet the workspace they can use.
        ``idle`` means "alive, nothing running in it" — the tools are switched off
        or still lazy — and is not the same answer as "this workspace is gone",
        which has no entry here at all.
        """
        statuses: List[str] = []
        for manager in (self.mcp, self.lsp):
            try:
                statuses.extend(str(item.get("status")) for item in manager.status())
            except Exception:  # noqa: BLE001 — a status read never breaks a read
                continue
        if "starting" in statuses:
            return "starting"
        if "running" in statuses:
            return "running"
        return "idle"

    def status(self, now: Optional[float] = None) -> Dict[str, Any]:
        """This workspace's line of :meth:`HubPool.status`."""
        moment = time.monotonic() if now is None else now
        return {
            "root": self.root,
            "state": self.state(),
            "secondsSinceUse": max(0.0, round(moment - self.last_used, 3)),
            "secondsSinceBuild": max(0.0, round(moment - self.created_at, 3)),
            "idle": self.idle,
        }


class Acquisition(NamedTuple):
    """What :meth:`HubPool.acquire` answers: the set, and two facts about it.

    ``built`` is the visible-restart flag (rule 23): true when this call is the
    one that admitted the workspace, so the API can carry "this workspace's tools
    are starting" into its payload instead of leaving the tab to find out.
    ``refusal`` is the ceiling's sentence — and when it is set there is **no**
    set, because the workspace refused is the one that was asked for, never a
    live one.
    """

    hub_set: Optional[HubSet]
    built: bool
    refusal: Optional[str]


class HubPool:
    """The map from canonical root to that workspace's :class:`HubSet`.

    The app holds one of these for its whole life. Entries come and go; the pool
    object never does, so a worker thread that resolved a manager mid-turn keeps
    a live reference even if the entry is let go afterwards — the veto exists so
    that is not a normal occurrence, but the shape of the object is what makes it
    safe.

    **What is locked, and what is not.** Every piece of bookkeeping (the map, the
    ceiling, the in-flight set) happens in a block containing no ``await``, so it
    is atomic on the event loop the pool runs on and needs no lock of its own. The
    one lock is **per root** and covers an admission, for two reasons pointing the
    other way from each other: the slow part of an admission — a cold local
    connector burning its retry window — must not delay the admission of a
    *different* workspace (spec §5.3 rule 13: a second tab is a peer, not a
    guest), and two requests naming **one** unseen folder must build one set, so
    the second waits on that folder's lock and then reuses the answer the first
    built.
    """

    def __init__(self) -> None:
        self._entries: Dict[str, HubSet] = {}
        self._busy: Optional[Callable[[str], bool]] = None
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._reaper: Optional[asyncio.TimerHandle] = None
        #: one lock per root ever admitted or released, **never dropped**. It is
        #: keyed by folders a human chose in this session, so it costs a few
        #: bytes; the hubs it protects are the expensive thing, and those are
        #: freed by the idle rule. Dropping a lock while another coroutine is
        #: queued on it would let a third build a second set for one folder.
        self._admit_locks: Dict[str, asyncio.Lock] = {}
        #: roots whose admission is in flight. They hold a ceiling slot from the
        #: moment they claim one, so concurrent admissions cannot over-commit.
        self._admitting: List[str] = []
        self._stopped = False
        #: The folder the app admitted at boot — the installation folder in
        #: production, and the folder the interim location names under the test
        #: suite's own pin. Every hub route now names the folder its request
        #: carries, so nothing asks "which folder did boot land on" any more;
        #: this stays because the boot's own admission and the suite's pin both
        #: need to say which folder that was.
        self.boot_root: Optional[str] = None

    # -- the API's questions ---------------------------------------------------

    def live(self, root: str) -> Optional[HubSet]:
        """The live set for ``root``, **without admitting it**.

        A read of a workspace must never start processes or write files, so the
        surfaces that only report ask this. ``None`` means "this folder is not
        alive in this process" — an answer, not an error, and never a reason to
        answer about a different folder (spec §5.2 rule 12).
        """
        return self._entries.get(workspace.canonical(root))

    async def acquire(self, root: str) -> Acquisition:
        """The workspace's own tools, admitting the folder if this is its first.

        The one call that admits, and therefore the one moment a folder's reserved
        folder is seeded. Ordering rule kept: **seed, then build, then start** —
        the MCP declaration lives inside the folder the manager is spawned against,
        so a hub built over an unseeded folder comes up with zero connectors.

        Everything the admission does happens inside ``root``'s scope, which is
        what makes ``${NOJAE_PATH_LOCATION}`` mean *this* workspace in a
        declaration read here.
        """
        resolved = workspace.canonical(root)
        entry = self._entries.get(resolved)
        if entry is not None and not entry.releasing:
            return self._reused(entry)
        async with self._admission_lock(resolved):
            # Asked again *inside* the lock: two requests for one unseen folder
            # both reach here, and only the first of them builds. A workspace
            # whose teardown is in progress is **not** an answer — it is about to
            # be gone, and handing it out would leave the tab with tools that
            # stop under it. Waiting here and rebuilding is the visible restart.
            entry = self._entries.get(resolved)
            if entry is not None and not entry.releasing:
                return self._reused(entry)
            limit = MAX_LIVE_WORKSPACES
            if len(self._entries) + len(self._admitting) >= limit:
                return Acquisition(
                    None,
                    built=False,
                    refusal=ceiling_sentence(self._slot_holders(), limit),
                )
            self._admitting.append(resolved)
            try:
                with workspace.scope(resolved):
                    self.seed_reserved_folder(resolved)
                    entry = self._build(resolved)
                    await entry.start()
                self._entries[resolved] = entry
            finally:
                self._admitting.remove(resolved)
            logger.info("admitted workspace %s", resolved)
            return Acquisition(entry, built=True, refusal=None)

    @staticmethod
    def _reused(entry: HubSet) -> Acquisition:
        """Stamp the workspace as used again, and hand it back."""
        entry.last_used = time.monotonic()
        entry.idle = False
        return Acquisition(entry, built=False, refusal=None)

    def _admission_lock(self, root: str) -> asyncio.Lock:
        """``root``'s admission lock, made on first need and kept for the session.

        One lock serves both ends of a workspace's life: ``acquire`` builds under
        it and the reaper tears down under it, so the two can never overlap and a
        tab returning to a workspace being let go waits for the teardown and then
        gets a **fresh** set with ``built`` set — the visible restart, rather than
        a set that stops working under it. The lock is never dropped, so a third
        caller cannot create a second one and enter beside a coroutine still
        queued on the first.
        """
        lock = self._admit_locks.get(root)
        if lock is None:
            lock = self._admit_locks[root] = asyncio.Lock()
        return lock

    def _slot_holders(self) -> List[str]:
        """Every root holding a ceiling slot, live or mid-admission."""
        return [*self._entries, *self._admitting]

    def release(self, root: str) -> bool:
        """Mark a workspace idle: no tab is behind it any more.

        It stops nothing — the reaper does that, on its next tick, and only while
        the veto has no hand on the workspace. Returns whether anything was
        marked, so a caller releasing a folder that was never admitted learns that
        rather than being told it worked.
        """
        entry = self._entries.get(workspace.canonical(root))
        if entry is None:
            return False
        entry.idle = True
        return True

    # -- the four rules --------------------------------------------------------

    def set_busy_predicate(self, busy: Optional[Callable[[str], bool]]) -> None:
        """Register the veto: ``busy(root) -> bool``, asked per workspace.

        The API owns the answer (a streaming reply, and a batch's turns are
        replies on the same workspace); the pool only ever asks. ``None`` — the
        state before the API registers one — means "nothing is ever busy", which
        is what a pool with no API around it is.
        """
        self._busy = busy

    def is_busy(self, root: str) -> bool:
        """Ask the veto. A predicate that raises is answered as *busy*."""
        if self._busy is None:
            return False
        try:
            return bool(self._busy(root))
        except Exception:  # noqa: BLE001 — the veto fails closed
            logger.warning("the busy predicate raised for %s", root, exc_info=True)
            return True

    def roots(self) -> List[str]:
        """The live workspaces, in admission order."""
        return list(self._entries)

    def status(self) -> List[Dict[str, Any]]:
        """One dict per live workspace: its root, its state, when it was last used."""
        now = time.monotonic()
        return [entry.status(now) for entry in self._entries.values()]

    def acquire_sync(self, root: str) -> Acquisition:
        """:meth:`acquire` from a thread that has no event loop of its own.

        The hub routes that must stay synchronous — the two panels' reads, the
        two ``enable``-flag writes, the Editor pane's query and the log tail —
        run in a worker thread, where the blocking half of an admission
        (``stop_connector`` waiting on its own hub thread, a tool query waiting
        on a future) belongs. They still need *this workspace's* set, so the
        admission is dispatched onto the pool's own loop and waited for here.

        It is waited for **without a timeout**, which is the same choice the
        awaited restart route has always made: an admission is bounded by the
        managers' own connect-retry windows, and a route that gave up mid-build
        would leave a set nobody owns. The wait happens on a worker thread, so
        the loop it is waiting on is free to run the admission.

        Raises :class:`RuntimeError` when the pool has no loop, i.e. before the
        app that starts the reaper has started — a pool nobody runs cannot
        admit anything, and saying so beats building a set on a loop that will
        never drive it.
        """
        loop = self._loop
        if loop is None:
            raise RuntimeError("HubPool is not running: no event loop to admit on")
        return asyncio.run_coroutine_threadsafe(self.acquire(root), loop).result()

    def admission_refusal(self, root: str) -> Optional[str]:
        """The ceiling's sentence if ``root`` could **not** be admitted now.

        The question a **read** asks instead of :meth:`acquire`: a folder someone
        only meant to browse must be left as it was (no seeding, no processes),
        yet a folder the pool could not serve must not be answered with a silent
        empty catalogue. So the read asks whether admission *would* be refused,
        and answers the same sentence the refusal would have carried — one
        sentence, built by :func:`ceiling_sentence`, wherever the ceiling is
        reached (spec §5.2 rule 10).
        """
        resolved = workspace.canonical(root)
        if resolved in self._entries:
            return None
        limit = MAX_LIVE_WORKSPACES
        if len(self._slot_holders()) >= limit:
            return ceiling_sentence(self._slot_holders(), limit)
        return None

    def summary(self) -> Dict[str, Any]:
        """The pool's own line, for the interface to render (spec §4.4, rule 22).

        Which workspaces are live (with the state each one is in), the bound,
        whether it has been reached, and the one sentence for when it has. The
        ``GET /api/workspace`` read carries this beside the two hub payloads so
        a tab can say "your tools are not running here" and "too many workspaces
        are open" as the two different answers they are.
        """
        limit = MAX_LIVE_WORKSPACES
        holders = self._slot_holders()
        at_limit = len(holders) >= limit
        return {
            "workspaces": self.status(),
            "limit": limit,
            "atLimit": at_limit,
            "sentence": ceiling_sentence(holders, limit) if at_limit else None,
        }

    async def reap_once(self) -> List[str]:
        """One pass of the idle rule; returns the workspaces that were let go.

        A workspace is let go when its last tab released it or it has been unused
        past :data:`IDLE_RELEASE_SECONDS` — and never while the veto says it is
        busy. A skipped workspace is not a failure: the next tick asks again, which
        is the whole reason the reaper is one loop rather than a timer per
        workspace.

        The teardown runs under the workspace's **admission lock** — the same one
        :meth:`acquire` builds under — and the whole condition is asked again once
        it is held. That pairing is what makes "a workspace with a tab behind it
        is never stopped" true by construction rather than by an argument about
        when :class:`asyncio.Lock` yields: a tab arriving mid-teardown waits on
        the lock and then rebuilds, and a tab that arrived *before* the teardown
        began makes the second ask answer "not releasable".
        """
        limit = IDLE_RELEASE_SECONDS
        let_go: List[str] = []
        for root, entry in list(self._entries.items()):
            if not self._releasable(root, entry, limit):
                continue
            async with self._admission_lock(root):
                if not self._releasable(root, entry, limit):
                    continue
                entry.releasing = True
                # Whatever the teardown managed, this entry is finished: a
                # half-stopped set must not keep holding a slot nobody can use,
                # and ``releasing`` means no acquire will hand it out.
                try:
                    try:
                        await entry.stop_all()
                    finally:
                        if self._entries.get(root) is entry:
                            del self._entries[root]
                except Exception:  # noqa: BLE001 — one workspace must not strand
                    logger.warning(
                        "the tools of %s did not stop cleanly", root, exc_info=True
                    )
                let_go.append(root)
                logger.info("released workspace %s", root)
        return let_go

    def _releasable(self, root: str, entry: HubSet, limit: float) -> bool:
        """Idle (or past its window), not busy, and not already going.

        A returning tab stamps ``last_used`` and clears :attr:`HubSet.idle`, so
        asking this a second time inside the lock is what turns "this workspace
        looked idle" into "it is idle now".
        """
        if entry.releasing:
            return False
        if not entry.idle and (time.monotonic() - entry.last_used) < limit:
            return False
        if self.is_busy(root):
            logger.info("not releasing busy workspace %s", root)
            return False
        return True

    # -- the reaper ------------------------------------------------------------

    def start_reaper(self, loop: Optional[asyncio.AbstractEventLoop] = None) -> None:
        """Arm the one reaper, on the app's own event loop."""
        self._loop = loop or asyncio.get_running_loop()
        self._schedule_reaper()

    def _schedule_reaper(self) -> None:
        if self._loop is None or self._stopped:
            return
        self._reaper = self._loop.call_later(REAPER_INTERVAL_SECONDS, self._reap)

    def _reap(self) -> None:
        """The timer callback: run one pass on the loop, then re-arm."""
        if self._loop is None or self._stopped:
            return
        task = asyncio.ensure_future(self.reap_once(), loop=self._loop)
        task.add_done_callback(_log_reap_failure)
        self._schedule_reaper()

    # -- seeding ---------------------------------------------------------------

    def seed_reserved_folder(self, root: str) -> Dict[str, Any]:
        """Leave the reserved folder's default files behind. Never raises.

        The **same** actions the boot performs, and the boot calls this rather
        than repeating them: the policy file, the MCP declaration, and the LSP
        *template* — the LSP declaration itself is hand-written and is still
        never seeded, because every entry names machine-local paths. Plus the
        trash sweep, which is what keeps a folder nobody deletes into any more
        from rotting (the boot has always done it at this same moment).

        Each action already answers a dict instead of raising, so what is guarded
        here is only the unexpected, and a hiccup stays a note: an unseeded
        workspace simply has no level-B rules and no connectors yet.

        Idempotent by construction — every create is exclusive — so this is safe
        to call on every admission and costs nothing on the second. It enters the
        workspace's own scope, because the trash it sweeps is resolved from the
        seam: correct from any caller, including one outside a request.
        """
        answers: Dict[str, Any] = {}
        with workspace.scope(root):
            for name, action in (
                ("policy", lambda: policy_seed.ensure_policy_file(root)),
                ("mcpSettings", lambda: ensure_mcp_settings_file(root)),
                ("lspSettingsTemplate", lambda: ensure_lsp_settings_template(root)),
                (
                    "trash",
                    lambda: {"state": "ok", "removed": editorfs_mutate.sweep_trash()},
                ),
            ):
                answers[name] = _note(name, root, action)
        # The one answer with a number worth saying out loud: the boot logged this
        # line before the sweep moved here, and a folder that never gets a delete
        # is exactly the case where it is the only trace.
        removed = answers["trash"].get("removed")
        if isinstance(removed, int) and removed:
            logger.info("removed %d expired trash batch(es) of %s", removed, root)
        return answers

    # -- shutdown --------------------------------------------------------------

    async def stop_all(self) -> None:
        """Tear every entry down — one call per manager — and disarm the reaper."""
        self._stopped = True
        if self._reaper is not None:
            try:
                self._reaper.cancel()
            except Exception:  # noqa: BLE001 — shutdown reports, never raises
                logger.warning("could not cancel the workspace reaper", exc_info=True)
            self._reaper = None
        for root, entry in list(self._entries.items()):
            try:
                await entry.stop_all()
            except Exception:  # noqa: BLE001 — one workspace must not strand the rest
                logger.warning("could not stop the tools of %s", root, exc_info=True)
            self._entries.pop(root, None)

    # -- internals -------------------------------------------------------------

    def _build(self, root: str) -> HubSet:
        """The two managers for ``root``, from ``root``'s declarations.

        Called inside the scope. Neither manager takes a root: a connector's
        ``--root-dir`` and a server's ``workspaceRoot`` come from the declaration,
        whose ``${NOJAE_PATH_LOCATION}`` the scope resolves.
        """
        return HubSet(
            root,
            McpManager(declared_connectors()),
            LspManager(declared_servers()[0]),
        )


def declared_connectors() -> List[Dict[str, Any]]:
    """This workspace's connectors (every entry, ``enable`` flag included).

    Reads the declaration of **the workspace in scope**, so the answer a
    :class:`HubSet` gets is its own folder's — which is the whole of spec §4.3.
    """
    if os.environ.get(DISABLE_MCP_ENV):
        return []
    connectors, _errors = load_externals()
    return connectors


def declared_servers() -> Tuple[List[Dict[str, Any]], List[str]]:
    """This workspace's servers, and the ids whose ``enable`` flag is on.

    The one activation gate (D13), stated once so admission and restart cannot
    disagree about what "this server runs here" means.
    """
    if os.environ.get(DISABLE_LSP_ENV):
        return [], []
    servers, _errors = all_servers()
    return servers, [server["id"] for server in servers if server["enable"]]


def _note(what: str, root: str, action: Callable[[], Dict[str, Any]]) -> Dict[str, Any]:
    """Run one seeding action, turning a hiccup into a note in the log.

    The contract every seed in this app already holds, kept here so admission
    cannot fail a workspace over a file it could not leave behind.
    """
    try:
        answer = action()
    except Exception as exc:  # noqa: BLE001 — a seed is a note, never a failure
        logger.warning("could not seed the %s of %s: %s", what, root, exc)
        return {"state": "failed", "error": str(exc)}
    if isinstance(answer, dict) and answer.get("state") == "failed":
        logger.warning("could not seed the %s of %s: %s", what, root, answer.get("error"))
    return answer if isinstance(answer, dict) else {"state": "ok"}


def _log_reap_failure(task: "asyncio.Future[List[str]]") -> None:
    """The reaper's one error channel: a pass that raised is logged, not lost."""
    try:
        task.result()
    except asyncio.CancelledError:
        return
    except Exception:  # noqa: BLE001 — the next tick re-arms regardless
        logger.warning("the workspace reaper raised", exc_info=True)
