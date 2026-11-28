"""The MCP and LSP panels, and the pool that owns a workspace's hubs.

A hub is bound to a folder at birth, so every route here answers about the
folder its request named, and the pool is the only thing it is read through.
"""

from typing import Any, Dict, List, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request

from src.core.mcphub import load_externals, set_externals_enabled
from src.core.lsphub import all_servers, set_lsp_enabled
from src.core import hubpool

from src.api.routes.inputs import LspIn, LspQueryIn, McpIn
from src.api.routes.seam import require_workspace
from src.api.routes.state import _chat_streaming_on
from src.api.routes.turn import _allowed_server_ids

# -- the workspace's own tools, reached only through the pool ---------------

router = APIRouter()


def _hub_pool(request: Request) -> hubpool.HubPool:
    """The app's one pool — the only thing a hub route reaches for tools.

    A hub is bound to a folder at birth, so a route that wanted "the" hub was
    asking a question with no answer: the pool is the only owner.
    """
    pool = getattr(request.app.state, "hubpool", None)
    if pool is None:
        raise HTTPException(
            status_code=503, detail="the workspace hub pool is not available"
        )
    return pool


def _acquire_hub_set(request: Request) -> Tuple[Optional[Any], bool]:
    """This workspace's :class:`~src.core.hubpool.HubSet`, admitting it.

    ``(hub_set, built)``: the flag is the **visible restart** — true when
    this request is the one that brought the folder's tools up, so the panel
    can say its tools are coming back instead of leaving the tab to infer it
    from an empty list.

    Called from a **synchronous** route, which FastAPI runs in a worker
    thread: the admission is dispatched onto the pool's own loop and waited
    for here. An async route awaits :func:`_acquire_hub_set_async` instead —
    blocking the loop the admission runs on would be a deadlock.
    """
    resolved = require_workspace(request)
    pool = _hub_pool(request)
    acquired = pool.acquire_sync(resolved.root)
    if acquired.refusal is not None:
        raise HTTPException(status_code=429, detail=acquired.refusal)
    return acquired.hub_set, acquired.built


async def _acquire_hub_set_async(
    request: Request,
) -> Tuple[Optional[Any], bool]:
    """:func:`_acquire_hub_set` for a route that already runs on the loop."""
    resolved = require_workspace(request)
    pool = _hub_pool(request)
    acquired = await pool.acquire(resolved.root)
    if acquired.refusal is not None:
        raise HTTPException(status_code=429, detail=acquired.refusal)
    return acquired.hub_set, acquired.built


def _read_hub_set(request: Request) -> Tuple[Optional[Any], bool]:
    """The workspace's set **without admitting it** — a read asks, not builds.

    A folder someone only meant to browse must be left exactly as it was: no
    reserved folder, no connector process, no language-server index. So this
    reads the pool's already-live set (which may be none) and answers the
    ceiling's sentence when the pool could not admit the folder at all — the
    refusal a read is entitled to, without the write a read must not do.
    """
    resolved = require_workspace(request)
    pool = _hub_pool(request)
    refusal = pool.admission_refusal(resolved.root)
    if refusal is not None:
        raise HTTPException(status_code=429, detail=refusal)
    return pool.live(resolved.root), False


def _mcp_payload(
    manager: Any,
    built: bool,
    extra_errors: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Connector list (live ``.nojae/mcp-settings.json`` scan) merged with manager status.

    Connectors are active on their file ``enable`` flag — the single source
    of truth. Secret material (``headers``/``env``) is stripped.

    The scan is a read of **the workspace in scope**, so the rows are this
    folder's declaration and the statuses come from this folder's manager —
    A's panel can never show B's connectors. ``manager`` is ``None`` when
    the folder has no live set, which is the honest "nothing is running
    here" answer rather than an empty list pretending to be a declaration.
    """
    statuses = {s["id"]: s for s in (manager.status() if manager else [])}
    connectors, errors = load_externals()
    if extra_errors:
        errors = errors + list(extra_errors)
    payload_connectors = []
    for connector in connectors:
        status = statuses.get(connector["id"], {})
        payload_connectors.append(
            {
                key: value
                for key, value in connector.items()
                if key not in ("headers", "env")
            }
            | {
                "active": connector["enable"],
                "status": status.get("status", "stopped"),
                "error": status.get("error"),
            }
        )
    return {
        "installed": bool(manager and manager.installed),
        "connectors": payload_connectors,
        "externalsError": "\n".join(errors) if errors else None,
        "built": built,
    }


@router.get("/mcp")
def get_mcp(request: Request) -> Dict[str, Any]:
    """List **this workspace's** declared MCP connectors with live status."""
    hub_set, built = _acquire_hub_set(request)
    return _mcp_payload(hub_set.mcp if hub_set else None, built)


@router.post("/mcp")
def post_mcp(body: McpIn, request: Request) -> Dict[str, Any]:
    """Activate MCP connectors for the Chat tab.

    Toggles write the entry ``enable`` flag back to the workspace's
    ``.nojae/mcp-settings.json`` (the only activation source) and
    start/stop the connector right away.

    There is no ``maxIterations`` in either direction: the tool-loop cap this
    route used to write is a per-agent column now.

    The declaration it writes is **the request's workspace's** — the path is
    built per call from the scope the router entered — and the connectors it
    hot-starts or stops are that workspace's own. Like every other
    ``enable``-flag write it is not gated on a streaming reply: a turn
    resolves its tools once, at its start.
    """
    hub_set, built = _acquire_hub_set(request)
    requested = [item.strip() for item in body.enabled if item.strip()]
    connectors, _errors = load_externals()
    connector_ids = {connector["id"] for connector in connectors}
    unknown = [item for item in requested if item not in connector_ids]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown MCP connectors: {', '.join(unknown)}",
        )
    enabled = set(requested)
    write_errors = (
        set_externals_enabled({cid: cid in enabled for cid in connector_ids})
        if connector_ids
        else []
    )
    manager = hub_set.mcp if hub_set is not None else None
    if manager is not None and hasattr(manager, "start_connector"):
        for connector in connectors:
            connector_id = connector["id"]
            current = manager.connector_status(connector_id)
            if connector_id in enabled and current not in ("running", "starting"):
                manager.start_connector(connector_id)
            elif connector_id not in enabled and current in ("running", "starting"):
                manager.stop_connector(connector_id)
    return _mcp_payload(manager, built, extra_errors=write_errors)


@router.post("/mcp/restart")
async def post_mcp_restart(request: Request) -> Dict[str, Any]:
    """Restart **this workspace's** MCP hub: reconnect from its own declaration.

    Everything is torn down (client sessions and, with them, every local
    stdio child process) and rebuilt from a fresh scan of the declaration
    file, so an edit made by hand — a new connector, a changed ``command``,
    another ``cwd`` — takes effect without restarting the web app.
    Validation problems do not abort the restart: the connectors that did
    parse come back up and the errors are returned in ``externalsError``.

    The rebuild is the workspace's own: :meth:`src.core.hubpool.HubSet.restart_mcp`
    re-scans inside *that* folder's scope, so a restart in A leaves B's
    connectors, sessions and statuses exactly as they were. The gate is the
    per-workspace one too — only a reply streaming on **this** folder holds
    these connectors still.

    Awaited, so the response carries the real post-restart status (a failing
    connector burns its whole retry window — the button stays busy).
    """
    resolved = require_workspace(request)
    if _chat_streaming_on(resolved.root):
        raise HTTPException(
            status_code=409,
            detail=f"Cannot restart the MCP hub while a chat reply is streaming on {resolved.root}",
        )
    hub_set, _built = await _acquire_hub_set_async(request)
    manager = hub_set.mcp if hub_set is not None else None
    if hub_set is None or manager is None or not hasattr(manager, "restart"):
        raise HTTPException(status_code=503, detail="MCP hub is not available")
    await hub_set.restart_mcp()
    # The payload re-scans the file, so it re-derives the same validation
    # errors — they must not be passed as extra_errors or they appear twice.
    # ``built`` is true because this request really did rebuild the tools:
    # the flag means "these tools were just rebuilt", which an admission and
    # a restart both answer, and never "the list happens to be empty".
    return _mcp_payload(manager, True)


def _lsp_payload(
    manager: Any,
    built: bool,
    extra_errors: Optional[List[str]] = None,
) -> Dict[str, Any]:
    """Language-server list (file scan + validation errors) + live status.

    A server is active when its ``enable`` flag says so — the one gate, the
    same answer ``_mcp_payload`` gives for a connector. Secret material
    (``env``) is stripped. There is no ``maxIterations`` here: the tool-loop
    cap is a per-agent column, not a hub setting.

    The scan reads **the workspace in scope** and the statuses come from
    that workspace's own manager, so A's panel lists A's servers and B's
    lists B's. A declared-but-unconnected server is still published from its
    declared tools (the manager answers that from its declaration), which is
    unchanged by being asked per workspace.
    """
    statuses = {s["id"]: s for s in (manager.status() if manager else [])}
    servers, errors = all_servers()
    if extra_errors:
        errors = errors + list(extra_errors)
    payload_servers = []
    for server in servers:
        status = statuses.get(server["id"], {})
        payload_servers.append(
            {
                key: value
                for key, value in server.items()
                if key not in ("env", "initializationOptions")
            }
            | {
                "active": server["enable"],
                "status": status.get("status", "stopped"),
                "error": status.get("error"),
                "toolCount": status.get("toolCount", 0),
            }
        )
    return {
        "installed": bool(manager and manager.installed),
        "servers": payload_servers,
        "serversError": "\n".join(errors) if errors else None,
        "built": built,
    }


@router.get("/lsp")
def get_lsp(request: Request) -> Dict[str, Any]:
    """List **this workspace's** declared language servers with live status."""
    hub_set, built = _acquire_hub_set(request)
    return _lsp_payload(hub_set.lsp if hub_set else None, built)


@router.post("/lsp")
def post_lsp(body: LspIn, request: Request) -> Dict[str, Any]:
    """Activate language servers for the Chat tab.

    Activation writes one place: the ``enable`` flag of every declared entry
    in ``.nojae/lsp-settings.json`` — the declaration file is the only LSP
    gate, so a ticked row is the whole decision and the file is the record
    of it. Running servers are hot-started/stopped right away. There is no
    tool-loop cap here: that is a per-agent column, not an LSP setting.

    The declaration written is the **request's workspace's**, and the servers
    hot-started or stopped are that workspace's own; like the MCP toggle
    above, this write is never gated on a streaming reply.
    """
    hub_set, built = _acquire_hub_set(request)
    requested = [item.strip() for item in body.enabled if item.strip()]
    servers, _errors = all_servers()
    known_ids = {server["id"] for server in servers}
    unknown = [item for item in requested if item not in known_ids]
    if unknown:
        raise HTTPException(
            status_code=422,
            detail=f"Unknown LSP servers: {', '.join(unknown)}",
        )
    enabled = set(requested)
    write_errors = (
        set_lsp_enabled({sid: sid in enabled for sid in known_ids})
        if known_ids
        else []
    )
    manager = hub_set.lsp if hub_set is not None else None
    if manager is not None and hasattr(manager, "start_server"):
        for server in servers:
            server_id = server["id"]
            current = manager.server_status(server_id)
            # Only ``running`` means "nothing to do": the hub treats a live
            # session or an in-flight attempt as a no-op, so a server stuck
            # in ``starting`` can be re-activated from the panel instead of
            # waiting for a full hub restart.
            if server_id in enabled and current != "running":
                manager.start_server(server_id)
            elif server_id not in enabled and current in ("running", "starting"):
                manager.stop_server(server_id)
    return _lsp_payload(manager, built, extra_errors=write_errors)


@router.post("/lsp/restart")
async def post_lsp_restart(request: Request) -> Dict[str, Any]:
    """Restart **this workspace's** LSP hub: respawn from its own declaration.

    Every language server of the folder the request names is shut down
    (``shutdown``/``exit``, then SIGTERM/SIGKILL) and respawned from a fresh
    scan of **that folder's** declaration file, so a hand-edited entry — a
    new server, a changed ``command``, another ``workspaceRoot`` — takes
    effect without restarting the web app. The one activation gate (the
    entry's ``enable`` flag) is re-applied exactly as at admission, so a
    declaration whose flags are all off stays dormant. Invalid entries never
    spawn: the valid ones come back up and the problems are reported in
    ``serversError``.

    The rebuild is the workspace's own
    (:meth:`src.core.hubpool.HubSet.restart_lsp`), so a restart in A leaves
    B's servers running and their statuses untouched, and the gate is the
    per-workspace one: only a reply streaming on **this** folder holds these
    servers still.

    Awaited, so the response carries real post-restart status (a cold
    language-server start is multi-second — the button stays busy).
    """
    resolved = require_workspace(request)
    if _chat_streaming_on(resolved.root):
        raise HTTPException(
            status_code=409,
            detail=f"Cannot restart the LSP hub while a chat reply is streaming on {resolved.root}",
        )
    hub_set, _built = await _acquire_hub_set_async(request)
    manager = hub_set.lsp if hub_set is not None else None
    if hub_set is None or manager is None or not hasattr(manager, "restart"):
        raise HTTPException(status_code=503, detail="LSP hub is not available")
    await hub_set.restart_lsp()
    # The payload re-scans the file, so it re-derives the same validation
    # errors — they must not be passed as extra_errors or they appear twice.
    # ``built`` true, for the same reason as the MCP restart above.
    return _lsp_payload(manager, True)


@router.post("/lsp/query")
def post_lsp_query(body: LspQueryIn, request: Request) -> Dict[str, Any]:
    """Answer one Editor-pane question about a buffer, as structured JSON.

    The Editor's code pane asks the hub one question at a time in the app's
    own vocabulary — ``status``, ``diagnostics``, ``definition``, ``hover``,
    ``references`` — and gets back the envelope ``core/lsphub/editor.py``
    defines: the answering server's id, a one-line reason when there is
    none, and the action's structured answer. No JSON-RPC crosses this
    boundary and no LSP method name appears in the browser; the hub stays
    the only thing that talks to a language server. The answer carries
    positions, hover text and diagnostic items, never file bytes — this is
    not a second file reader.

    ``diagnostics`` is answered from what the hub already holds, without
    waiting: a cold file answers "not analysed yet" rather than blocking.
    Waiting belongs to the model's tool, which has a deadline and a reader
    expecting an answer.

    A ``POST`` because the buffer's text travels with it when the buffer is
    dirty, and that can be large: a ``GET`` would put a megabyte in a query
    string. A plain ``def``, not ``async def``, so FastAPI runs it in a
    threadpool — the hub bridge blocks on a future, and blocking the event
    loop would stall every other request.

    It is a **read**: it names no write route, writes nothing, and is
    therefore not refused while a chat reply streams. A file no server
    claims is a quiet answer (``server: null`` with a reason), never an
    error — the gesture falls through to whatever Monaco would have done.

    The servers asked are **the tab's workspace's own**, so a pane on A
    never gets an answer out of B's index.
    """
    hub_set, _built = _acquire_hub_set(request)
    manager = hub_set.lsp if hub_set is not None else None
    if manager is None:
        # The hub is disabled in tests and in a hermetic e2e run: the pane
        # must degrade to the status quo, so this is the quiet envelope
        # rather than a 500.
        return {
            "status": "no_server",
            "server": None,
            "reason": "the language-server hub is not available",
            "action": body.action,
            "result": None,
        }
    position = None
    if body.line is not None and body.character is not None:
        position = {"line": body.line, "character": body.character}
    return manager.query_editor_sync(
        body.action,
        body.path,
        position=position,
        text=body.text,
        allowed_ids=_allowed_server_ids(body.lspEnabled),
    )


@router.get("/lsp/log")
def get_lsp_log(request: Request, server: str = "") -> Dict[str, Any]:
    """Tail of one language server's log file (for the settings panel).

    The log is the **request's workspace's** server's: two workspaces can
    declare the same id, and the panel that shows one must not tail the
    other's file.
    """
    hub_set, _built = _acquire_hub_set(request)
    manager = hub_set.lsp if hub_set is not None else None
    if manager is None or not server:
        raise HTTPException(status_code=404, detail="No LSP log available")
    log = manager.log_tail(server) if hasattr(manager, "log_tail") else ""
    return {"server": server, "log": log}
