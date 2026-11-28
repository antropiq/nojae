"""The workspace a request is about: the field, the scope, the refusal."""

from typing import Optional, Union

from fastapi import HTTPException, Query, Request, WebSocket

from src.core import workspace as workspace_seam


# --- the workspace of a request ------------------------------------------------

#: The one name the folder travels under, and the one place it is spelled. A
#: query parameter **everywhere**, including the routes that take a body: the
#: client then has one helper and the server one reader, and a folder whose name
#: is not latin-1 survives (a header would not). Nothing else carries it — not a
#: body field, not a header, not the address bar.
WORKSPACE_QUERY = "workspace"

#: The routes whose answer is the **installation's** and which therefore must
#: keep answering even while a tab's folder has gone away. Listed here so the
#: invariant is a fact of this module rather than of a habit, and asserted by
#: ``tests/test_workspace_seam.py``.
#:
#: The connector wizard's two reads are here because page 1's MCP list is
#: committed data and its header line says who the dialog runs as — both about
#: the install, neither about a folder, so a tab whose folder was deleted can
#: still open the wizard. Its scan and its two posts are workspace-scoped.
INSTALLATION_SCOPED_PATHS = (
    "/api/config",
    "/api/prompt-helpers",
    "/api/servers",
    "/api/models",
    "/api/agents",
    "/api/wizard/catalogue",
    "/api/wizard/connection",
)


async def _workspace_scope(
    # ``Request``/``WebSocket`` annotated bare and defaulted to ``None``, so the
    # one dependency serves both kinds of connection. ``Optional[...]`` here is
    # **not** an option — it turns the parameter into a pydantic field and the
    # router refuses to build, which the terminal's WebSocket route would hit at
    # import.
    request: Request = None,  # type: ignore[assignment]
    websocket: WebSocket = None,  # type: ignore[assignment]
    workspace: Optional[str] = Query(
        default=None, alias=WORKSPACE_QUERY, include_in_schema=False
    ),
):
    """Resolve the request's workspace and enter the seam's scope for it.

    The router's **one** dependency, so no route can forget the field or spell
    it. It resolves the raw text through :func:`src.core.workspace.resolve`,
    keeps all three answers on the connection's ``state``, and enters the scope
    for the request — cleared afterwards, whatever the route did, including a
    streaming reply whose worker thread inherited a *copy* of the context.

    It **never refuses**: a 422 belongs where a folder is actually needed
    (:func:`require_workspace`), because the installation-scoped routes above
    must answer even when the folder a tab named has been deleted; and an
    invalid value is a sentence the caller deserves verbatim, not a status.

    There is no default folder: no surface answers about a folder it was not
    given, so an empty, absent or unusable one draws the seam's own sentence.
    """
    connection = request if request is not None else websocket
    # The **boot read**: a tab that remembers no folder has nothing to name, so
    # ``GET /api/workspace`` with no field answers about the installation folder
    # — the folder a new tab lands on. It is the one route that may be asked
    # without a field, because it is how the client learns which folder to name
    # next. The answer is the same ``Workspace`` every other request gets, and
    # the scope is entered for it.
    if workspace is None and connection.url.path == "/api/workspace":
        workspace = workspace_seam.installation()
    connection.state.workspace_raw = workspace
    resolved, refusal = workspace_seam.resolve(workspace)
    connection.state.workspace_refusal = refusal
    if resolved is None:
        # Named, and refused: **no scope is entered**. Entering one for another
        # folder would be the substitution nothing may do, and a workspace-scoped
        # route cannot get past ``require_workspace`` to use it anyway. An
        # installation-scoped route answers with no scope, which is exactly what
        # it needs to keep working about a folder that has gone.
        yield None
        return
    # ``workspace`` is what ``require_workspace`` hands a route: the folder this
    # request is about. A folder that was named and refused never reaches here.
    connection.state.workspace = resolved
    with workspace_seam.scope(resolved.root):
        yield resolved


def workspace_refusal(connection: Union[Request, WebSocket]) -> Optional[str]:
    """The sentence the connection's field drew, or ``None`` when it was accepted.

    The one reader of the resolver's refusal, so the routes that answer with a
    *status* (:func:`require_workspace`) and the one that answers with a socket
    close (the terminal) cannot describe the same wrong folder differently.
    """
    return getattr(connection.state, "workspace_refusal", None)


def require_workspace(connection: Union[Request, WebSocket]) -> workspace_seam.Workspace:
    """The resolved workspace of this request, or the refusal as a 422.

    Called by every **workspace-scoped** route and by no installation-scoped one.
    The sentence is the seam's — built once, in
    :func:`src.core.workspace.resolve`, so the same wrong folder is described the
    same way wherever it is asked about — and the status is this layer's choice,
    which is why the seam answers sentences and never statuses.

    It never substitutes a folder for the one that was refused: a caller that
    gets an exception has no answer at all, which is the point.
    """
    refusal = workspace_refusal(connection)
    if refusal:
        raise HTTPException(
            status_code=422,
            detail=refusal,
        )
    return connection.state.workspace

