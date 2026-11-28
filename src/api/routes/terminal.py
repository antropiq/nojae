"""One PTY per WebSocket: the terminal stays a human surface."""

import json
from contextlib import suppress
from typing import Any, Dict

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect

from src.core import termhub
from src.core.termhub import drivers as term_drivers
from src.core.termhub import policy as term_policy

from src.api.routes.seam import require_workspace, workspace_refusal

# -- terminal: one PTY per WebSocket ---------------------------------------

router = APIRouter()


@router.get("/terminal")
def get_terminal(request: Request) -> Dict[str, Any]:
    """The live terminal sessions (pid, cwd, started, bytes) — for the
    settings panel. An orphan must be nameable, so whatever the registry
    holds is reported here; the shells themselves are driven by the WS,
    never by this route.

    One registry, every workspace: the sessions are the **app's**, not a
    folder's, so this lists them all and each row names the folder that
    session was **born in** — neither moves when a tab re-points.
    """
    # A workspace-scoped route, like every other one: a refused folder is
    # the seam's sentence, never a silent substitution.
    require_workspace(request)
    hub = getattr(request.app.state, "terminal", None)
    return {"sessions": hub.list_sessions() if hub is not None else []}


@router.websocket("/terminal")
async def terminal_ws(websocket: WebSocket) -> None:
    """One shell on one PTY, bridged to the browser's xterm pane.

    Guards, in order, each refusing *before* any process is spawned: the
    Origin check (the app has no CORS/CSRF layer, so this is the one cheap
    defence against a random page reaching a shell), **the workspace** (the
    router-level dependency resolves the folder the socket names), the
    driver check (a session needs an available pseudo-terminal driver —
    ``termhub.drivers``' capability answer, not a platform name), and the
    concurrent-session cap. A real shell can change anything the app's user
    can — which is why it is *never* an MCP or LSP tool, only this route,
    used by the SPA. The tools stay read-only; a shell is a human surface.

    A socket has no per-request body, so its folder arrives **when the
    socket opens**, as the same query parameter every workspace-scoped
    request carries. A live shell keeps the folder it was born in whatever
    the tab later points at: this route never re-roots, kills or relaunches
    an open session, and a **new** shell (this pane's reconnect) starts in
    the tab's current folder. The frame stream still carries no path: ``cd``
    inside the shell is the user's own business. The session owns the
    framing and teardown, this route only adapts the socket to it.
    """
    hub = getattr(websocket.app.state, "terminal", None)
    if hub is None:  # pragma: no cover - lifespan always sets it
        await websocket.close(termhub.CLOSE_CODE_UNSUPPORTED, "Terminal unavailable")
        return

    headers = {k.lower(): v for k, v in websocket.headers.raw}
    allowed, reason = term_policy.origin_allowed(headers)
    if not allowed:
        await websocket.close(
            termhub.CLOSE_CODE_POLICY, f"Origin refused: {reason}"
        )
        return

    # The folder this shell will be born in. A refused one is answered with
    # the seam's sentence — the same words the 422 routes use — in an
    # ``error`` frame (the pane's own error line) and as the policy close
    # reason. Nothing is reserved and nothing spawns: the refusal comes
    # before ``hub.create``, so the registry and the cap are untouched.
    refusal = workspace_refusal(websocket)
    if refusal:
        await websocket.accept()
        await websocket.send_json({"type": "error", "message": refusal})
        # A close reason is capped at 123 bytes by the protocol, so the
        # sentence is bounded here (`termhub.close_reason`) rather than
        # letting the close frame fail and the pane see a bare 1006.
        await websocket.close(
            termhub.CLOSE_CODE_POLICY, termhub.close_reason(refusal)
        )
        return

    if not term_drivers.driver_available():
        await websocket.accept()
        await websocket.send_json(
            {
                "type": "error",
                "message": termhub.NO_DRIVER_MESSAGE,
            }
        )
        await websocket.close(
            termhub.CLOSE_CODE_UNSUPPORTED, termhub.NO_DRIVER_MESSAGE
        )
        return

    if hub.is_full():
        await websocket.close(
            termhub.CLOSE_CODE_CAPACITY,
            f"Too many terminal sessions (cap {hub.capacity()})",
        )
        return

    # Publish a frame straight to the socket. Raises when the client is
    # gone, which the session's reader treats as "stop pumping".
    async def emit(event: Dict[str, Any]) -> None:
        await websocket.send_json(event)

    async def receive_frame():
        try:
            text = await websocket.receive_text()
        except (WebSocketDisconnect, RuntimeError):
            return None
        try:
            frame = json.loads(text)
        except (json.JSONDecodeError, ValueError):
            # Malformed frame: ignored by the session, not fatal.
            return {"type": ""}
        return frame if isinstance(frame, dict) else {"type": ""}

    try:
        session = hub.create(emit)
    except termhub.SessionCapacity as exc:
        await websocket.close(termhub.CLOSE_CODE_CAPACITY, str(exc))
        return

    await websocket.accept()
    try:
        # One session per connection: no attach, no reuse.
        session.spawn(cols=termhub.DEFAULT_COLS, rows=termhub.DEFAULT_ROWS)
    except (termhub.TerminalUnsupported, OSError) as exc:
        hub.drop(session.id)
        await websocket.send_json({"type": "error", "message": str(exc)})
        await websocket.close(termhub.CLOSE_CODE_UNSUPPORTED, "Could not spawn shell")
        return

    try:
        await session.run(receive_frame)
    finally:
        hub.drop(session.id)
        with suppress(Exception):
            await websocket.close()
