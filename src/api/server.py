"""FastAPI application entry point."""

import logging
from contextlib import asynccontextmanager
from typing import Any, Dict, Optional, Sequence

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from src.api import routes as api_routes
from src.api.routes import build_router
from src.config import (
    apply_llm_debug,
    DEFAULT_HOST,
    boot_flags,
    PROJECT_ROOT,
    parse_boot_args,
    set_boot_flags,
)
from src.core.hubpool import HubPool
from src.core.termhub import TerminalHub
from src.core import appdb
from src.core import workspace as workspace_seam

WEB_DIST = PROJECT_ROOT / "web" / "dist"

_log = logging.getLogger("nojae")


def _boot_app_store() -> Dict[str, Any]:
    """Bring the app's own settings store up; never raise.

    :func:`src.core.appdb.boot` already answers a state dict instead of raising,
    so this wrapper only guards the *unexpected*: a database this app could not
    open, write or understand must not take the boot down with it. The app
    starts, the failure is recorded in :func:`src.core.appdb.store_state` (the
    one place the store's state is answered from) and named in the log — a named
    state, never a silent empty store.

    It runs **before** the workspace seeds because it is install-scoped: nothing
    in it depends on, or is invalidated by, the working location.
    """
    try:
        result = appdb.boot()
    except Exception as exc:  # noqa: BLE001 — boot must survive anything here
        _log.warning("could not bring up the settings store: %s", exc)
        return {"state": "unusable", "path": None, "sentence": str(exc)}
    if result["state"] == "unusable":
        _log.warning("the settings store is unusable: %s", result["sentence"])
    else:
        _log.info(
            "settings store at %s (schema level %s%s): %d built-in agent(s) "
            "inserted, %d re-asserted, %d prompt-helper row(s) seeded",
            result["path"],
            result["version"],
            "" if result["upgradedFrom"] is None
            else f", upgraded from {result['upgradedFrom']}",
            result["agents"]["inserted"],
            result["agents"]["reasserted"],
            result["promptHelpers"],
        )
    return result


def create_app() -> FastAPI:
    """Build the FastAPI app: API routes first, static SPA fallback after."""
    # What this app runs on comes from the command line that booted it
    # (:func:`src.config.parse_boot_args`, recorded by :func:`run`) or from the
    # module's defaults. A process that never went through ``run`` — this
    # module's import in a test, a ``uvicorn src.api.server:app`` dev server —
    # therefore builds the same app on the documented defaults, so there is no
    # file to read here.
    #
    # The debug switch is applied here because its whole effect is process-wide
    # logger state, and an app that is *created* is the moment that state should
    # match what the run decided. Keeping it out of the module's import side
    # effects means tests build an app without touching the process's loggers
    # unless they ask for it; ``run`` re-applies it after parsing.
    apply_llm_debug()
    # The folder the boot lands on is the **installation**, the workspace a new
    # tab starts on. It is admitted to the pool like any other: seeded first
    # (its reserved files must exist before the first scan of the declaration
    # files, which is what ``${NOJAE_PATH_LOCATION}`` in both of them points at),
    # then given its own two managers in the lifespan below. Nothing
    # process-wide decides it — the pool's admission is the one seeding moment.
    boot_root = workspace_seam.installation()
    # One pool for the whole app, built here rather than in the lifespan because
    # the boot seeding below belongs to this moment and is the pool's own
    # function: **boot calls the pool, not a copy of the pool**. Every folder
    # another tab names is admitted by ``acquire`` on its own request.
    pool = HubPool()
    pool.boot_root = boot_root
    # The boot's reserved-folder work — policy file, MCP declaration, the LSP
    # *template* (the declaration itself is hand-written and is never seeded),
    # and the trash sweep: each is a note in the log, never a boot failure. An
    # unseeded workspace simply has no level-B rules and no connectors yet.
    #
    # The agent modes are **not** seeded here: the personas are rows of the
    # install's ``nojae.db``, which :func:`_boot_app_store` brings up in the
    # lifespan below. Nothing about an agent depends on the working location.
    #
    # Seeding is idempotent (every create is exclusive), so the lifespan's
    # admission of the same folder costs nothing the second time — and the
    # ordering rule survives: the MCP declaration is seeded **before** the MCP
    # manager scans, because the declaration lives inside the folder the manager
    # is spawned against.
    pool.seed_reserved_folder(boot_root)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # The app's own settings store comes up first. It is install-scoped, so
        # it has no ordering relationship with the workspace seeds above —
        # nothing in them reads it and nothing in it reads the working location.
        #
        # In the lifespan rather than beside those seeds, because ``create_app()``
        # runs at *import* time here (the module-level ``app`` below), and a store
        # created at import happens before any test fixture can move the install
        # root — the suite would create the developer's real ``nojae.db``. The
        # lifespan is the one moment guaranteed to run exactly once per started
        # app, which is also what a test that owns its own store can drive.
        #
        # The answer is not kept on ``app.state``: ``appdb.store_state()`` is the
        # one place the store's state is recorded, so the app bar and the chat
        # refusal cannot disagree with the boot.
        # The store is the install's, but in test mode its connection fixture is
        # a file at the **installation** folder's reserved subfolder — the one
        # workspace the boot is about. Entering that folder's scope is what lets
        # the store's own workspace-scoped fixture lookup answer where the suite
        # committed it, without giving any route a default folder.
        with workspace_seam.scope(boot_root):
            _boot_app_store()
        # The pool is the app's long-lived singleton: it holds **one set of
        # tools per workspace**, and the object itself never changes, so a worker
        # thread that resolved a manager mid-turn keeps a live reference across
        # the request (and across a hub restart, which rebuilds a manager's
        # internals in place).
        #
        # The boot workspace is admitted here — the same ``acquire`` any other
        # folder goes through. The two env switches are honoured **per
        # workspace** by the pool's own declaration readers: a hermetic test
        # reaches no hub, on any folder. Entries with ``enable: false`` stay
        # stopped until toggled on, and servers declared ``"lazy": true`` spawn
        # on their first tool call.
        admitted = await pool.acquire(boot_root)
        if admitted.refusal is not None:
            # Unreachable in practice (the boot folder was just admitted by this
            # same process), but the answer is a note, never a boot failure: the
            # app starts, and the first request about that folder says so.
            _log.warning("could not admit the boot workspace: %s", admitted.refusal)
        # The veto: the pool never lets go of a workspace this process is busy
        # with. The answer belongs to the API — it is the one that knows which
        # workspaces have a reply in flight — and is handed over as a plain
        # ``root -> bool`` callable, so nothing under ``core`` reaches up here.
        pool.set_busy_predicate(api_routes.workspace_is_busy)
        # One reaper for every workspace, on the app's own loop: the idle rule
        # needs no thread per folder.
        pool.start_reaper()
        # The terminal registry is a plain dict (no hub thread): sessions are
        # driven by their WebSocket coroutine, on this loop. Nothing spawns at
        # boot — a session is only born on a WS upgrade — but it is created
        # here so every route can find it, and torn down in the same block as
        # the hubs, so a shell that outlived its socket cannot outlive the app.
        terminal = TerminalHub()
        app.state.terminal = terminal
        try:
            yield
        finally:
            await terminal.stop_all()
            # Every workspace's own two managers, one call each, through their
            # own ``stop_all`` — the shared process-tree teardown.
            await pool.stop_all()

    app = FastAPI(title="nojae", version="0.2.0", lifespan=lifespan)
    # The pool is the only hub the app's state carries: a hub is bound to a
    # folder at birth, so a process-wide name for "the" hub could only ever
    # answer about one workspace. Every hub route asks the pool for its own.
    app.state.hubpool = pool
    app.include_router(build_router())

    @app.get("/api/health")
    def health() -> dict:
        """Reachability probe, and what this process was booted with.

        The boot flags are process state with no file behind them, so this is
        the only place a run's debug switch, endpoint-wait pair and port —
        everything about the run that is not in the settings store — are
        readable.
        """
        return {
            "status": "ok",
            "boot": {
                "llmDebug": boot_flags().llm_debug,
                "networkMaxRetry": boot_flags().network_max_retry,
                "networkWaitFor": boot_flags().network_wait_for,
                "port": boot_flags().port,
            },
        }

    if WEB_DIST.is_dir():
        app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="static")

    return app


def run(argv: Optional[Sequence[str]] = None) -> None:
    """Console-script entry: parse this run's flags, then serve the API and UI.

    The one place the command line becomes process state, and an unusable value
    exits *before* anything is served — no app nobody asked for boots.

    ``argv`` exists so ``run`` is testable about a *given* command line instead
    of about whatever arguments reached the process. It defaults to the
    process's own.
    """
    set_boot_flags(parse_boot_args(argv))
    flags = boot_flags()
    # Re-apply here, not only in ``create_app``: the module-level app that
    # ``uvicorn.run`` imports below was already created — before this parse — so
    # this is the call that makes ``--llm-debug`` mean anything on the console
    # script's own path.
    apply_llm_debug()
    uvicorn.run(
        "src.api.server:app", host=DEFAULT_HOST, port=flags.port
    )


app = create_app()
