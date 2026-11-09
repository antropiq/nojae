"""The Editor pane's action table and its structured answers.

Two things live here and nothing else: the actions the Editor's code pane may
ask the hub for, and the wire shapes their answers take. Core-only — plain
values in, dicts out, no FastAPI and no browser concern.

**This table is the editor's, not the model's.** :data:`lsphub.tools.TOOL_SPECS`
is what a chat turn may call; adding an action here must never add a tool
there. The two sets overlap and are deliberately not the same: the model also
gets document symbols, workspace symbols, completion, signature help,
formatting and diagnostics, none of which the pane needs in v1.

Positions on the wire are **0-based**, LSP-native. The ``+1`` that turns them
into Monaco's 1-based coordinates happens once, in the browser's ``lib/``
module, never here. ``path`` is always relative to the **working location**,
never to the server's ``workspaceRoot``: a server rooted at ``<workspace>/web``
must answer ``web/src/app.ts``, because the browser's buffers are keyed by
workspace-relative paths.
"""

from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from . import rendering

# The absent/``False``/``None`` capability rule is ``tools.py``'s, imported
# rather than copied: two copies of it would drift, and the editor and the
# model must agree on what "this server advertises the capability" means.
from .tools import _capability_present

#: action -> the LSP request method it maps to, the server capability that
#: gates it (in the shape ``TOOL_SPECS`` uses), and whether it needs a
#: position. ``status`` maps to no method: the hub's own state answers it.
#:
#: Every method here is a query. No document mutation may ever appear in this
#: table — no ``willSave``, ``didChange``, ``willCreate``, ``willRename``,
#: ``willDelete``, ``executeCommand`` or ``applyEdit`` — because the pane reads
#: code and never writes it.
EDITOR_ACTIONS: Dict[str, Dict[str, Any]] = {
    "status": {
        "method": None,
        "capability": None,
        "needs_position": False,
    },
    "definition": {
        "method": "textDocument/definition",
        "capability": "definition_provider",
        "needs_position": True,
    },
    "hover": {
        "method": "textDocument/hover",
        "capability": "hover_provider",
        "needs_position": True,
    },
    "references": {
        "method": "textDocument/references",
        "capability": "references_provider",
        "needs_position": True,
    },
}


def supports_action(capabilities: Any, action: str) -> bool:
    """Whether a server advertises the capability ``action`` needs.

    The absent/``False``/``None`` rule is ``tools.py``'s, imported rather than
    copied: one rule, one place. An unknown action is not supported.
    """
    spec = EDITOR_ACTIONS.get(action)
    if spec is None:
        return False
    return _capability_present(capabilities, spec["capability"])


def _relative_path(workspace_root: Union[str, Path], uri: str) -> str:
    """``uri`` as a workspace-relative, ``/``-joined path.

    Relative to the **working location**, not the server's root, and with the
    separators the browser's buffers use. A path outside the workspace falls
    back to its absolute form rather than raising: the answer is still a
    position, and the caller decides what to do with it.
    """
    path = Path(rendering.uri_to_path(uri))
    root = Path(workspace_root)
    # The root as given, then its resolved form: a working location reached
    # through a symlink would otherwise never match the resolved path a server
    # answers with, and every location would come back absolute.
    for candidate in (root, root.resolve()):
        try:
            return path.relative_to(candidate).as_posix()
        except ValueError:
            continue
    return path.as_posix()


def _location_range(location: Any) -> Any:
    """The range of a ``Location`` or a ``LocationLink`` (``None`` if neither).

    A ``LocationLink`` names its target twice: ``targetSelectionRange`` is the
    identifier the user asked about, ``targetRange`` the whole declaration. The
    selection is what a Ctrl+click should land on.
    """
    range_ = getattr(location, "range", None)
    if range_ is not None:
        return range_
    return getattr(location, "target_selection_range", None) or getattr(
        location, "target_range", None
    )


def _location_uri(location: Any) -> Optional[str]:
    """The URI of a ``Location`` or a ``LocationLink`` (``None`` if neither)."""
    return getattr(location, "uri", None) or getattr(location, "target_uri", None)


def location_answer(
    workspace_root: Union[str, Path], location: Any
) -> Optional[Dict[str, Any]]:
    """One LSP location as ``{path, line, character}``, or ``None``.

    Accepts either LSP shape — a ``Location`` (``uri``/``range``) or a
    ``LocationLink`` (``targetUri``/``targetSelectionRange``) — because both
    arrive on the same responses. A definition response is often a *list* of
    them, so a list is accepted too and its first entry is the answer: a
    Ctrl+click lands on one place. ``None`` means the server answered nothing,
    which is a real answer, not a failure.
    """
    if isinstance(location, (list, tuple)):
        location = location[0] if location else None
    if location is None:
        return None
    uri = _location_uri(location)
    range_ = _location_range(location)
    if uri is None or range_ is None:
        return None
    start = range_.start
    return {
        "path": _relative_path(workspace_root, uri),
        "line": int(start.line),
        "character": int(start.character),
    }


def references_answer(
    workspace_root: Union[str, Path], locations: Any
) -> List[Dict[str, Any]]:
    """A references result as a list of locations, in the server's order.

    Possibly empty. Some servers answer a single location rather than a list,
    so a bare location is wrapped rather than dropped.
    """
    if not locations:
        return []
    if not isinstance(locations, (list, tuple)):
        locations = [locations]
    answers: List[Dict[str, Any]] = []
    for location in locations:
        answer = location_answer(workspace_root, location)
        if answer is not None:
            answers.append(answer)
    return answers


def _hover_markdown(contents: Any) -> str:
    """The server's hover text as one string, whatever shape it used.

    A plain string, a ``MarkupContent``, a legacy ``MarkedStringWithLanguage``
    or a list of those. The editor wants one string, not a rendering decision,
    so the values are joined and nothing is fenced or escaped here.
    """
    if contents is None:
        return ""
    if isinstance(contents, str):
        return contents
    value = getattr(contents, "value", None)
    if isinstance(value, str):
        return value
    parts: List[str] = []
    for item in contents or []:
        if isinstance(item, str):
            parts.append(item)
            continue
        item_value = getattr(item, "value", None)
        if isinstance(item_value, str):
            parts.append(item_value)
    return "\n".join(part for part in parts if part)


def _hover_range(range_: Any) -> Optional[Dict[str, Any]]:
    """An LSP range as ``{start: {line, character}, end: {line, character}}``."""
    if range_ is None:
        return None
    return {
        "start": {
            "line": int(range_.start.line),
            "character": int(range_.start.character),
        },
        "end": {
            "line": int(range_.end.line),
            "character": int(range_.end.character),
        },
    }


def hover_answer(hover: Any) -> Optional[Dict[str, Any]]:
    """A hover result as ``{markdown, range}``, or ``None``.

    ``range`` is ``None`` when the server named no range — the markdown is
    still the answer. No root is taken: a hover carries no path, so there is
    nothing to make relative.
    """
    if hover is None:
        return None
    contents = getattr(hover, "contents", None)
    if contents is None:
        return None
    return {
        "markdown": _hover_markdown(contents),
        "range": _hover_range(getattr(hover, "range", None)),
    }
