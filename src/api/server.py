"""FastAPI application entry point."""

import logging
from contextlib import asynccontextmanager
from typing import Any, Dict

import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from src.api import routes as api_routes
from src.api.routes import build_router
from src.config import (
    apply_llm_debug,
    ENV_PATH,
    load_dotenv_once,
    PROJECT_ROOT,
)
from src.core.hubpool import HubPool
from src.core.termhub import TerminalHub
from src.core import appdb
from src.core import workspace as workspace_seam

WEB_DIST = PROJECT_ROOT / "web" / "dist"

_log = logging.getLogger("nojae")


def _boot_app_store() -> Dict[str, Any]:
    """Bring the app's own settings store up; never raise.

    ``appdb.boot()`` is open-or-create → schema at the current level, upgrade, or
    refuse → seed (§4.3), and it already answers a state dict instead of raising,
    so this wrapper only guards the *unexpected* — the same contract the
    workspace's reserved-folder seeds hold (``src/core/hubpool.py``), and the
    reason it matters most here: a database this app could not open, write or
    understand must not take the boot down with it. The
    app starts, the store's state is kept where a later task can answer it
    (:func:`src.core.appdb.store_state` — the app bar's notice and the chat
    refusal are tasks 09 and 03), and the sentence naming the path goes to the
    log so the failure is a named state rather than a silent empty store.

    It runs **before** the workspace seeds because it is install-scoped: nothing
    in it depends on, or is invalidated by, the working location (D11).
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
    load_dotenv_once()
    # The debug switch is read from the environment, so it is applied right
    # after the .env has been loaded (and again on every settings save).
    # Keeping it here rather than in the module's import side effects means the
    # tests build an app without touching the loggers of the whole process
    # unless they ask for it.
    apply_llm_debug()
    # The folder the boot lands on is the **installation**, which is the workspace
    # a new tab starts on (spec D4). It is admitted to the pool like any other:
    # seeded first (its reserved files must exist before the first scan of the
    # declaration files, which is what ``${NOJAE_PATH_LOCATION}`` in both of them
    # points at), then given its own two managers in the lifespan below. Nothing
    # process-wide decides it any more — the interim location value is gone
    # (clws-10) and the pool's admission is the one seeding moment.
    boot_root = workspace_seam.installation()
    # One pool for the whole app, built here rather than in the lifespan because
    # the boot seeding below belongs to this moment (see the note above) and is
    # the pool's own function: **boot calls the pool, not a copy of the pool**.
    # Every folder another tab names is admitted by ``acquire`` on its own
    # request, which seeds it the same way — a read of a workspace never writes.
    pool = HubPool()
    pool.boot_root = boot_root
    # The four actions the boot has always performed at this point — the policy
    # file, the MCP declaration, the LSP *template* (the declaration itself is
    # hand-written and is still never seeded), and the trash sweep that keeps a
    # folder nobody deletes into from rotting — are now one call, with the same
    # contract: each is a note in the log, never a boot failure. An unseeded
    # workspace simply has no level-B rules and no connectors yet.
    #
    # The agent modes are **not** seeded here any more (appdb-10): the personas
    # are rows of the install's ``nojae.db``, which :func:`_boot_app_store`
    # brings up and seeds in the lifespan below. Nothing about an agent depends
    # on the working location, so there is nothing to leave in the folder a
    # switch just moved to (D11).
    #
    # Seeding is idempotent (every create is exclusive), so the lifespan's
    # admission of the same folder costs nothing the second time — and the
    # ordering rule survives: the MCP declaration is seeded **before** the MCP
    # manager scans, because the declaration lives inside the folder the manager
    # is spawned against.
    pool.seed_reserved_folder(boot_root)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        # The app's own settings store comes up first: open-or-create, schema at
        # the current level (or upgrade, or refuse), then seed (§4.3). It is
        # install-scoped, so it has no ordering relationship with the workspace
        # seeds above — nothing in them reads it and nothing in it reads the
        # working location (D11).
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
        # refusal of the tasks after this one cannot disagree with the boot.
        # The store is the install's, but in test mode its connection fixture is
        # a file at the **installation** folder's reserved subfolder — the one
        # workspace the boot is about (spec D4). Entering that folder's scope is
        # what lets the store's own workspace-scoped fixture lookup answer where
        # the suite committed it, without giving any route a default folder.
        with workspace_seam.scope(boot_root):
            _boot_app_store()
        # The pool is the app's long-lived singleton: it holds **one set of
        # tools per workspace**, and the object itself never changes, so a worker
        # thread that resolved a manager mid-turn keeps a live reference across
        # the request (and across a hub restart, which rebuilds a manager's
        # internals in place).
        #
        # The boot workspace is admitted here — the same ``acquire`` any other
        # folder goes through, so its connectors and language servers are
        # declared, built and started exactly as a second tab's would be. The
        # two env switches are honoured **per workspace** by the pool's own
        # declaration readers: a hermetic test reaches no hub, on any folder.
        # Entries with ``enable: false`` stay stopped until toggled on, and
        # servers declared ``"lazy": true`` spawn on their first tool call.
        admitted = await pool.acquire(boot_root)
        if admitted.refusal is not None:
            # Unreachable in practice (the boot folder was just admitted by this
            # same process), but the answer is a note, never a boot failure: the
            # app starts, and the first request about that folder says so.
            _log.warning("could not admit the boot workspace: %s", admitted.refusal)
        # The veto (spec §4.4): the pool never lets go of a workspace this
        # process is busy with. The answer belongs to the API — it is the one
        # that knows which workspaces have a reply in flight — and is handed over
        # as a plain ``root -> bool`` callable, so nothing under ``core`` reaches
        # up here.
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
    # The pool is the only hub the app's state carries. The two interim
    # process-wide hub names are gone (clws-06): a hub is bound to a folder at
    # birth, so a process-wide name for "the" hub could only ever answer about
    # one workspace, and every hub route now asks the pool for the request's own.
    app.state.hubpool = pool
    app.include_router(build_router())

    @app.get("/api/health")
    def health() -> dict:
        return {
            "status": "ok",
            "env": ENV_PATH.is_file(),
        }

    if WEB_DIST.is_dir():
        app.mount("/", StaticFiles(directory=WEB_DIST, html=True), name="static")

    return app


def run() -> None:
    """Console-script entry: serve the API and built frontend on :8001."""
    uvicorn.run("src.api.server:app", host="127.0.0.1", port=8001)


app = create_app()
