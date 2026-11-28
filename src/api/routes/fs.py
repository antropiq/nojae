"""The Editor's file routes: every writer here is guarded, and browser-only."""

from typing import Any, Dict, List

from fastapi import APIRouter, HTTPException, Query, Request

from src.core import editorfs

from src.api.routes.inputs import (
    FileCreateIn,
    FileMoveBatchIn,
    FileRenameIn,
    FileSaveIn,
)
from src.api.routes.seam import require_workspace
from src.api.routes.state import _refuse_if_chat_streaming

# -- the guarded write surface (browser-only) ------------------------------

router = APIRouter()


@router.get("/fs/tree")
def get_fs_tree(request: Request, path: str = "") -> Dict[str, Any]:
    """One directory level of **this request's** workspace, for the Editor tab.

    ``path`` is relative to the folder the request named ("" is its root).
    One level per call keeps the first paint at one ``listdir`` however big
    the checkout is. All the rules live in ``core/editorfs``; this route
    only turns a :class:`~src.core.editorfs.policy.WorkspacePathError` into
    its HTTP status. This route reads — the write routes are browser-only.
    """
    # Asked before anything touches disk: a folder that was named and refused
    # answers 422 and is never browsed. The root itself is not an argument —
    # the scope this request entered is what ``core/editorfs`` resolves
    # against.
    require_workspace(request)
    try:
        return editorfs.list_dir(path)
    except editorfs.WorkspacePathError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.get("/fs/file")
def get_fs_file(request: Request, path: str) -> Dict[str, Any]:
    """The whole text of one workspace-relative file, for the Editor tab.

    A name the tree pruned answers **404** here, never the policy refusal
    another surface would give it — a refusal would confirm the file exists.
    Past the size cap the answer is 413 naming the size; a binary file
    answers ``binary: true`` with no ``text`` key, so the pane can label it.

    ``mtime`` is the token both the save guard and the freshness probe
    compare: the client sends it back as ``ifUnmodifiedSince``, and a disk
    mtime that has moved answers 409 instead of overwriting someone else's
    change. This route reads; the write routes are browser-only.
    """
    require_workspace(request)
    try:
        return editorfs.read_file(path)
    except editorfs.WorkspacePathError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.get("/fs/search")
def get_fs_search(
    request: Request,
    path: str = "",
    q: str = "",
    caseSensitive: bool = False,
    regex: bool = False,
) -> Dict[str, Any]:
    """Every match of one query inside one scope of **this request's** workspace.

    ``path`` is the scope and uses the tree's convention — "" meaning the
    whole workspace — so the row a gesture was made on is what gets searched.
    ``q`` defaults to "" so an unset query reaches the core's one-sentence
    refusal rather than a framework validation error.

    All the rules live in :func:`src.core.editorfs.search.search_workspace`
    (a search sees exactly what the tree shows); this route only turns the
    core's errors into their HTTP status: 400 for a bad pattern (carrying
    ``re``'s own message), 422 for a scope outside the workspace or refused
    by a lock, 404 for a scope that is absent or hidden. This route reads.
    """
    require_workspace(request)
    try:
        return editorfs.search_workspace(
            path, query=q, case_sensitive=caseSensitive, regex=regex
        )
    except editorfs.SearchQueryError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)
    except editorfs.WorkspacePathError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.get("/fs/files")
def get_fs_files(request: Request) -> Dict[str, Any]:
    """Every candidate path of the quick-open finder, for the whole workspace.

    Fetched once per dialog open and filtered per keystroke in the browser,
    so this is one bounded walk per open, not per keystroke. All the rules
    live in :func:`src.core.editorfs.quickopen.list_workspace_files` —
    notably that read-only paths are excluded: the finder is a shortcut to
    files you will *edit*. This route only transports the core's dict.
    """
    require_workspace(request)
    return editorfs.list_workspace_files()


@router.put("/fs/file")
def put_fs_file(request: Request, body: FileSaveIn) -> Dict[str, Any]:
    """One whole editor buffer, back to disk (``PUT /api/fs/file``).

    The rules all live in :func:`src.core.editorfs.files.write_file`,
    including the atomic temp-file + ``os.replace`` that keeps the file's
    mode and its exact bytes (CRLF included, no normalisation).

    Refused while a chat reply streams on **this request's** workspace: that
    reply may be editing these very files through its tools, so a save
    landing in the middle of one would race the model — and a reply
    streaming against another folder does not lock this one's files. The
    payload answers the new ``size``/``mtime`` so the caller re-baselines on
    the server's truth.

    This is a **browser** surface: no MCP connector, LSP tool or chat code
    path may call it, which ``tests/test_editorfs_write.py`` asserts.
    """
    # Asked before anything else: the folder is what the write resolves
    # against, and it is what the streaming refusal is about. Nothing below
    # re-reads it, so a save cannot answer about another folder.
    resolved = require_workspace(request)
    _refuse_if_chat_streaming("save", resolved.root)
    try:
        return editorfs.write_file(
            body.path, body.text, if_unmodified_since=body.ifUnmodifiedSince
        )
    except editorfs.WorkspaceSaveConflict as exc:
        # The object, not the sentence: the client offers reload-or-
        # overwrite, and that choice needs both numbers, not prose.
        raise HTTPException(status_code=exc.status_code, detail=exc.detail_object)
    except editorfs.WorkspacePathError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.post("/fs/create")
def post_fs_create(request: Request, body: FileCreateIn) -> Dict[str, Any]:
    """One new file or folder inside the working location.

    The rules live in :func:`src.core.editorfs.mutate.create_path` — notably
    a policy-hidden parent answers 422, never the 404 a caller would read as
    "the name is free", and an occupied name is refused by ``O_EXCL`` rather
    than checked first, so no race can overwrite.

    Refused while a chat reply streams, like every other write. The payload
    answers ``path``/``dir``/``size``/``mtime`` — the shape a save answers,
    so the client re-baselines the new empty buffer on the server's truth.

    Browser-only, like every route under ``/fs`` that mutates disk.
    """
    resolved = require_workspace(request)
    _refuse_if_chat_streaming("create a file or folder", resolved.root)
    try:
        return editorfs.create_path(body.path, is_dir=body.dir)
    except editorfs.WorkspacePathExists as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail_object)
    except editorfs.WorkspacePathError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.delete("/fs/file")
def delete_fs_file(request: Request, path: str) -> Dict[str, Any]:
    """One file or one whole folder, moved to the trash (``DELETE /api/fs/file``).

    The rules live in :func:`src.core.editorfs.mutate.trash_path`, including
    the **all-or-nothing subtree check**: one hidden or read-only descendant
    refuses the whole delete, naming that descendant, and nothing moves.

    Nothing is ``unlink``ed — a delete lands in ``.nojae/trash/<batch>/`` of
    the **request's** workspace, so one tab's bytes never file themselves
    inside another's reserved folder, and is swept after the retention days.
    That folder is reserved, so the pane cannot list it: a batch is restored
    with ``mv`` in a terminal.

    Refused while a chat reply streams, like every other write. The answer
    carries ``entries`` — the descendant count from the server's own walk —
    so the confirmation the UI already showed matches what happened.

    Browser-only, like every route under ``/fs`` that mutates disk.
    """
    resolved = require_workspace(request)
    _refuse_if_chat_streaming("delete a file or folder", resolved.root)
    try:
        return editorfs.trash_path(path)
    except editorfs.WorkspacePathError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.post("/fs/rename")
def post_fs_rename(request: Request, body: FileRenameIn) -> Dict[str, Any]:
    """One path to another path — a rename, which is also a move.

    The rules live in :func:`src.core.editorfs.mutate.rename_path`, whose
    key one is that **both ends** go through the write gate — ``to`` plus
    every one of its ancestors, which is what refuses an innocent file
    moving into ``.git/…`` or the reserved folder. A cross-device move
    (``EXDEV``) is refused rather than copied.

    Refused while a chat reply streams, like every other write. Nothing is
    backed up here, deliberately: the bytes did not change and the trash
    plus git already describe the move. The payload answers
    ``from``/``to``/``dir``/``size``/``mtime`` so the caller can re-point
    its open buffers and re-baseline on the server's truth.

    Browser-only, like every route under ``/fs`` that mutates disk.
    """
    resolved = require_workspace(request)
    _refuse_if_chat_streaming("rename a file or folder", resolved.root)
    try:
        return editorfs.rename_path(body.frm, body.to)
    except editorfs.WorkspacePathExists as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail_object)
    except editorfs.WorkspacePathError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.post("/fs/move-batch")
def post_fs_move_batch(request: Request, body: FileMoveBatchIn) -> Dict[str, Any]:
    """Several files into one existing folder — one request, or nothing moves.

    The rules live in :func:`src.core.editorfs.mutate.move_paths_batch`,
    which is ``rename_path``'s rules asked of every entry.

    The transaction is the **ordering**: every entry is validated before any
    of them is applied, so a refusal leaves the whole set at home. The apply
    loop itself is *not* atomic across paths — there is no filesystem
    transaction to borrow — and it owns that: it stops at the first
    ``OSError`` and the payload's ``moved`` array says exactly what landed
    instead of pretending the list did.

    Refused while a chat reply streams, like every other write. Nothing is
    backed up, as for a rename: the bytes did not change. The payload answers
    ``{"moved": [{"from", "to", "mtime"}…], "to_parent"}`` so the caller can
    re-point its open buffers and re-list the two folders it touched.

    Browser-only, like every route under ``/fs`` that mutates disk.
    """
    resolved = require_workspace(request)
    _refuse_if_chat_streaming("move files", resolved.root)
    try:
        return editorfs.move_paths_batch(body.paths, body.to_parent)
    except editorfs.WorkspacePathExists as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail_object)
    except editorfs.WorkspacePathError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.get("/fs/stat")
def get_fs_stat(
    request: Request, path: List[str] = Query(default_factory=list)
) -> Dict[str, Any]:
    """``mtime``/``size``/``exists`` for a handful of exact paths.

    The freshness probe: the client names the files it has open, so nothing
    has to poll a tree or run a file watcher. Every path goes through the
    same gate as the tree, measured from the folder this request named.
    """
    require_workspace(request)
    try:
        return {"paths": editorfs.stat_paths(path)}
    except editorfs.WorkspacePathError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.get("/fs/status")
def get_fs_status(request: Request) -> Dict[str, Any]:
    """Which files of **this request's** workspace git considers unstaged.

    One call for the whole tree (not one per row). A workspace that is not a
    git repository answers ``repo: false`` with an empty list — the silent,
    non-error case the UI is expected to ignore.

    Read-only like the rest of ``/api/fs``: ``GIT_OPTIONAL_LOCKS=0`` keeps
    even ``git status`` from touching the index on disk.
    """
    require_workspace(request)
    try:
        return editorfs.git_status()
    except editorfs.WorkspacePathError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)


@router.get("/fs/diff")
def get_fs_diff(request: Request, path: str) -> Dict[str, Any]:
    """The two sides of one file: ``original`` as of ``HEAD``, ``modified``
    as it sits on disk.

    Returned as two texts rather than a patch so the editor renders the diff
    itself. The disk side goes through the same reader as the file read, so
    the size cap, the binary answer and the policy refusal are identical
    here. A file with no committed side (added, untracked) gets an empty
    ``original``.
    """
    require_workspace(request)
    try:
        return editorfs.file_diff(path)
    except editorfs.WorkspacePathError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.detail)
