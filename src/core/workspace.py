"""What a workspace **is**: the folder a request is about, and nothing else.

The seam client-owned-workspace (clws-01) introduces. Before it, "which folder"
had one answer per **process**, read live at every call from an environment
value, so two browser tabs on two folders were impossible no matter what the
client asked for. This module makes the folder a **value**: a request names one,
the API resolves it here, and every path-resolving surface under ``src/core``
reads the answer back from here rather than from the environment.

Two things it owns, and is the only place that owns them:

* **what a workspace is** — :class:`Workspace`, a canonical absolute root, and
  :func:`resolve`, the one validator that decides whether a piece of text names
  one. Shape, existence and the restricted-roots deny-list are answered here;
  the **per-path** read/write verdicts stay in :mod:`src.core.editorfs.policy`,
  which is a different question about a folder already admitted.
* **which workspace a call is about** — :func:`scope` / :func:`current_root`, a
  :class:`contextvars.ContextVar`. That is the whole mechanism: FastAPI runs a
  sync route in a worker thread that inherits a **copy** of the caller's context,
  so a scope entered in the request's context is visible inside the route and
  cannot leak into a concurrent one. Two requests, two folders, no shared state.

**There is no default scope.** Reading :func:`current_root` outside one is an
error, never the installation folder (spec §5.2 rule 12: "no surface falls back
to a different folder").

Two placeholders must not be confused, and :func:`src.config.provided_env_values`
is where they are handed to the declaration expansion:

* ``${NOJAE_PATH_LOCATION}`` means **the folder being served** — the scope
  (spec §4.3: a tab on A gets A's connectors, so A's declaration expands to A);
* ``${PROJECT_ROOT}`` means **the installation**, always, in every workspace.

Core only: no FastAPI, no browser concerns, and no import of ``src.api``. The
deny-list lives in ``lsphub.discovery`` and the containment compare in
``editorfs.policy``, both of which import *this* module, so both are imported
lazily inside the one function that asks.
"""

import contextvars
import os
from contextlib import contextmanager
from typing import Iterator, Optional, Tuple

from src import config


class WorkspaceNotScoped(RuntimeError):
    """The seam was asked which folder, inside no scope.

    Named so a caller can tell "nobody said which workspace" from "the workspace
    that was said is not a folder" (:func:`resolve` answers the second with a
    sentence, never by raising). It is the reason the seam must never silently
    answer the installation folder: the interim environment fallback is gone
    (clws-10), so a surface reached outside a scope has **no** folder rather
    than a wrong one.
    """


class Workspace:
    """A resolved workspace: one canonical absolute root, and nothing else.

    Deliberately thin. The policy, the cached tree answers and the hubs all
    *hang off* the root — they are not the workspace, and holding them here
    would make this object a second owner of state that already has one (the
    per-root caches key on the resolved root, so a second workspace gets its own
    entry with no change here).

    ``root`` is the same canonical form the app has always compared against:
    ``realpath`` with ``~`` already expanded, so two spellings of one folder —
    through a symlink, with a trailing ``.``, with a home reference — are one
    workspace and one cache key.
    """

    __slots__ = ("root",)

    def __init__(self, root: str) -> None:
        self.root = root

    def __eq__(self, other: object) -> bool:
        return isinstance(other, Workspace) and other.root == self.root

    def __hash__(self) -> int:
        return hash(self.root)

    def __repr__(self) -> str:
        return f"Workspace({self.root!r})"


def canonical(text: str) -> str:
    """The one canonical form a folder is held in: ``realpath``, ``~`` expanded.

    Public because a second owner of the same key needs the same answer: the hub
    pool maps workspace → tools (clws-05), and two spellings of one folder must
    be one entry there exactly as they are one workspace here. A pool keyed on
    the raw text would give ``~/proj`` and ``/home/me/proj`` two sets of
    connectors.
    """
    return os.path.realpath(os.path.expanduser((text or "").strip()))


def installation() -> str:
    """The **installation** directory — the app's own checkout, not a workspace.

    Read through ``config.PROJECT_ROOT`` at call time, so a patched value (a test
    does exactly that) moves the answer — the convention every other path answer
    in this app follows.

    Three things ask this question and must agree on one answer: it is the folder
    a new tab lands on (spec D4), the folder :func:`is_self_workspace` compares a
    workspace against (spec §5.6 rule 30 — the app's own built-in rules apply
    **only** while the workspace *is* the installation), and the value
    ``${PROJECT_ROOT}`` expands to in a declaration. It is never a workspace
    chosen by a request.
    """
    return os.path.realpath(str(config.PROJECT_ROOT))


# --- the request-scoped workspace ---------------------------------------------

_CURRENT_ROOT: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "nojae_workspace_root", default=None
)


@contextmanager
def scope(root: str) -> Iterator[Workspace]:
    """Enter the workspace ``root`` names, for as long as the block runs.

    The API enters it once per request (``src/api/routes.py``) and nothing else
    does: a scope is the answer to "which folder is this call about", so the
    request that carries the field is the only thing entitled to set it.

    ``root`` is canonicalised here, so a caller may hand it any spelling of a
    folder it already validated. Nesting is fine and each exit restores the
    outer answer — that is what the token is for, and why an exception inside
    the block cannot leave the scope set.
    """
    entered = Workspace(canonical(root))
    token = _CURRENT_ROOT.set(entered.root)
    try:
        yield entered
    finally:
        _CURRENT_ROOT.reset(token)


def current_root() -> str:
    """The folder the call in progress is about.

    The scope's answer when one is entered, and :class:`WorkspaceNotScoped`
    outside one. Never the installation folder as a guess — a wrong folder is
    worse than no answer, because every path below it would resolve *somewhere*
    (spec §5.2 rule 12).
    """
    root = _CURRENT_ROOT.get()
    if root is not None:
        return root
    raise WorkspaceNotScoped(
        "no workspace is in scope: the seam answers 'which folder' only for a "
        "request that named one (see src/core/workspace.py)"
    )


def current_workspace() -> Workspace:
    """:func:`current_root` as the object the core surfaces hand to each other."""
    return Workspace(current_root())


def provided_path_location() -> str:
    """What ``${NOJAE_PATH_LOCATION}`` expands to: **the folder being served**.

    The one meaning the placeholder has in this app (spec §4.3): a declaration
    read for a workspace expands to *that* workspace, which is what makes one
    declaration file correct in two tabs at once. It is the scope and nothing
    else, so outside one this raises like every other read of the seam (rule 12)
    — the boot seeds and the hub scans all run inside the pool's scope.

    ``${PROJECT_ROOT}`` is **not** this: it keeps meaning the installation, in
    every workspace, and the two must never converge.
    """
    return current_root()


# --- the one validator ---------------------------------------------------------

#: The four refusals, in the order they are asked. Each names the folder and the
#: rule that fired, and never what the refusal stopped itself from looking at
#: (spec §5.2 rule 11). The deny-list wording is the one the tree and the old
#: location switch already emitted, because rule 10 asks for **one** sentence
#: wherever the same wrong folder is asked about.
EMPTY_REFUSAL = "Working location must not be empty"


def _not_absolute_refusal(raw: str) -> str:
    return f"Working location must be an absolute path: {raw}"


def _not_a_directory_refusal(raw: str) -> str:
    return f"Working location is not an existing directory: {raw}"


def _deny_list_refusal(denied: str) -> str:
    return f"Working location is on the deny-list: {denied}"


def resolve(raw: Optional[str]) -> Tuple[Optional[Workspace], Optional[str]]:
    """``(Workspace, None)`` for a folder a request may work on, else ``(None, sentence)``.

    Four questions, in this order, each with its own sentence:

    1. is anything named at all;
    2. is the name an **absolute** path once ``~`` is expanded (a relative name
       would mean a folder chosen by the server's working directory, which is
       never the answer a browser is entitled to get);
    3. does it name an existing **directory**;
    4. is it on the restricted-roots deny-list — the same list the tree refuses
       by and the old location switch refused by, so a folder cannot be admitted
       as a workspace and then refused as a tree root.

    Answers a **sentence**, never a status: the route decides what the refusal
    costs. The sentence is the whole answer — a caller that got one must not
    also try a folder of its own (spec §5.2 rule 12).
    """
    text = (raw or "").strip()
    if not text:
        return None, EMPTY_REFUSAL
    expanded = os.path.expanduser(text)
    if not os.path.isabs(expanded):
        return None, _not_absolute_refusal(text)
    root = canonical(text)
    if not os.path.isdir(root):
        return None, _not_a_directory_refusal(text)
    denied = _restricted_refusal(root)
    if denied is not None:
        return None, denied
    return Workspace(root), None


def _restricted_refusal(root: str) -> Optional[str]:
    """The deny-list sentence for ``root``, or ``None`` when it is not denied.

    The same compare the tree's own root lock makes: the entries are realpaths,
    containment is the shared component-wise rule, and the **case** answer comes
    from the probe of the workspace being admitted — one answer per running
    configuration, and no probe of a folder this call has just decided it may not
    open (``editorfs.policy._is_within`` records that choice). Asked only when the
    list has entries, so a hub without a deny-list costs no disk question.
    """
    # Lazy, both: each of these modules imports *this* one, so a module-level
    # import here would be a cycle.
    from src.core.editorfs import fscase
    from src.core.editorfs.policy import _is_within
    from src.core.lsphub.discovery import restricted_lsp_roots

    entries = restricted_lsp_roots()
    fold = fscase.case_folded(root) if entries else False
    for denied in entries:
        if _is_within(os.path.realpath(denied), root, fold=fold):
            return _deny_list_refusal(denied)
    return None
