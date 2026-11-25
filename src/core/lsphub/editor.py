"""The Editor pane's action table and its structured answers.

Two things live here and nothing else: the actions the Editor's code pane may
ask the hub for, and the wire shapes their answers take. Core-only — plain
values in, dicts out, no FastAPI and no browser concern.

**This table is the editor's, not the model's.** :data:`lsphub.tools.TOOL_SPECS`
is what a chat turn may call; **adding a row to this table must never add a
tool to the model's list**. The two sets overlap and are deliberately not the
same, and they do not even share an answer where they overlap: ``diagnostics``
appears in both, and the model gets a rendered, truncated text report while the
pane gets structured items. Sharing one return shape would mean the pane
parsing English back out of a prompt paragraph, or the model receiving raw JSON.

Positions on the wire are **0-based**, LSP-native. The ``+1`` that turns them
into Monaco's 1-based coordinates happens once, in the browser's ``lib/``
module, never here. ``path`` is always relative to the **working location**,
never to the server's ``workspaceRoot``: a server rooted at ``<workspace>/web``
must answer ``web/src/app.ts``, because the browser's buffers are keyed by
workspace-relative paths.
"""

from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple, Union

from . import rendering

# The absent/``False``/``None`` capability rule is ``tools.py``'s, imported
# rather than copied: the editor and the model must agree on what "this server
# advertises the capability" means.
from .tools import _capability_present

#: action -> the LSP request method it maps to, the server capability that
#: gates it (in the shape ``TOOL_SPECS`` uses), and whether it needs a
#: position. ``status`` maps to no method: the hub's own state answers it.
#: ``diagnostics`` names no method either, for a different reason: it is
#: answered from the per-session inbox the notification handler already fills,
#: without waiting for a push and without sending a 3.17 pull request. Its
#: capability is ``None`` — "always offered" — because a push notification is
#: not a capability anything advertises, the same rule the model's own
#: diagnostics tool follows.
#:
#: Every method here is a query, and every action here is the **Editor's,
#: never a tool**: this table and :data:`lsphub.tools.TOOL_SPECS` overlap on
#: purpose and are deliberately not the same, so no row added here reaches a
#: chat turn's tool list. No document mutation may ever appear in this table —
#: no ``willSave``, ``didChange``, ``willCreate``, ``willRename``, ``willDelete``,
#: ``executeCommand`` or ``applyEdit`` — because the pane reads code and never
#: writes it. The document sync is not an action: it is the hub's step before
#: one, and it appears nowhere below.
EDITOR_ACTIONS: Dict[str, Dict[str, Any]] = {
    "status": {
        "method": None,
        "capability": None,
        "needs_position": False,
    },
    "diagnostics": {
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

    An unknown action is not supported.
    """
    spec = EDITOR_ACTIONS.get(action)
    if spec is None:
        return False
    return _capability_present(capabilities, spec["capability"])


def _relative_path(workspace_root: Union[str, Path], uri: str) -> str:
    """``uri`` as a workspace-relative, ``/``-joined path.

    Relative to the **working location**, not the server's root, and with the
    separators the browser's buffers use. A path outside the workspace falls
    back to its absolute form rather than raising.
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


def _range_answer(range_: Any) -> Optional[Dict[str, Any]]:
    """An LSP range as ``{start: {line, character}, end: {line, character}}``.

    Both ends stay **0-based**, exactly as the server sent them: the ``+1``
    that turns them into Monaco's coordinates happens once, in the browser.
    """
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
        "range": _range_answer(getattr(hover, "range", None)),
    }


def diagnostics_answer(
    entry: Optional[Tuple[Optional[int], Any]],
    limit: int,
    oldest_version: Optional[int] = None,
) -> Dict[str, Any]:
    """One inbox entry as the pane's structured diagnostics answer.

    ``entry`` is what :meth:`lsphub.session.DiagnosticsInbox.peek` holds for the
    document — ``(version, diagnostics)``, or ``None`` when no publish has ever
    arrived for it — and ``limit`` is the server's own cap on how many reach the
    browser, the same one the model's tool applies.

    The answer distinguishes the three states the bar exists for, because an
    empty list means *clean* only once an analysis was actually reached:

    - ``analysed: False`` — the hub holds no analysis for this document. This is
      *unknown*, never "clean", and deliberately **not** an error: it is a
      normal ``ok`` answer whose result says nothing has been analysed yet.
    - ``analysed: True`` with an empty ``items`` — analysed and clean.
    - ``analysed: True`` with items — analysed, N problems.

    ``oldest_version`` is the version the text now on the server was sent at
    (``actions.DocumentSync.text_version``). A payload below it was analysed
    from text a later sync replaced, so it describes bytes nobody is looking at
    and the honest answer is ``analysed: False`` — never that payload, whose
    squiggles would sit under code that no longer has them. ``None`` means no
    comparison is possible (the caller has no sync, or the server published no
    version) and then the payload is accepted rather than guessed at.

    ``version`` is the document version the payload belongs to, absent when
    there is no payload. **The client compares successive answers for one
    buffer**: a strictly *older* version is the stale one and an equal version
    is the same analysis. It must not test "this version equals the document's
    current version" — the shared sync bumps that version on every call, so that
    comparison would call every answer stale, a good one included.

    ``suppressed`` is what the cap hid, so a truncated list is never presented
    as the whole truth. A range stays 0-based on the wire, and there is no path
    per item: a payload is per document and the caller asked about one file.
    """
    if entry is None:
        return {"analysed": False, "items": [], "suppressed": 0}
    version, diagnostics = entry
    if (
        oldest_version is not None
        and version is not None
        and version < oldest_version
    ):
        # The inbox still holds an analysis of text this sync replaced: it
        # describes bytes nobody is looking at, so it is *unknown*, never a
        # verdict. The version is deliberately absent, like a cold file's.
        return {"analysed": False, "items": [], "suppressed": 0}
    published = list(diagnostics or [])
    cap = max(int(limit), 0)
    items: List[Dict[str, Any]] = []
    for diagnostic in published[:cap]:
        item: Dict[str, Any] = {
            "range": _range_answer(getattr(diagnostic, "range", None)),
            # The absent-severity rule is the rendering module's: a server that
            # omitted the field means "error".
            "severity": rendering.severity_name(getattr(diagnostic, "severity", None)),
            "message": str(getattr(diagnostic, "message", "") or ""),
        }
        code = getattr(diagnostic, "code", None)
        if code is not None:
            item["code"] = code
        source = getattr(diagnostic, "source", None)
        if source is not None:
            item["source"] = source
        items.append(item)
    return {
        "analysed": True,
        "version": version,
        "items": items,
        "suppressed": len(published) - len(items),
    }
