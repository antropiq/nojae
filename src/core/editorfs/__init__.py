"""File surface of the Editor tab: a bounded view of the workspace.

Core-only (no FastAPI, no browser concerns), a sibling of ``mcphub/`` and
``lsphub/`` whose layout it mirrors — one concern per file. Two pieces decide
what every surface answers:

* :mod:`editorfs.policy_modes` the one verdict: ``mode_for`` answering what the
  policy says about a workspace-relative path, from two levels —
  :mod:`editorfs.builtin_policy` (the rules about files *this app* writes, live
  only while the workspace **is** the install directory, plus the ``.nojae``
  folder, reserved in every workspace) and :mod:`editorfs.policy_file` (the one
  reader of ``<workspace>/.nojae/read-write-policy.json``, whose schema lives in
  ``mcp_connectors/policy_file.py``). :mod:`editorfs.fscase` answers the one disk
  question the verdict asks — whether this filesystem keeps ``Dist`` and ``dist``
  apart — so the matcher stays pure text.
* :mod:`editorfs.policy` the one gate: the three locks, then that verdict —
  ``resolve_in_workspace`` for a read, ``resolve_write_target`` for a change to a
  folder's listing, ``resolve_save_target`` for a change to a file's bytes. Every
  surface asks it, so none can disagree about what a path may be listed as, read
  as, or changed into.

:mod:`editorfs.policy_seed` writes a default policy file when a folder becomes the
working location, never over an existing one. :mod:`editorfs.constants` holds the
caps (visibility is a rule in the policy file, not a constant). The surfaces:
:mod:`editorfs.tree` (one directory level), :mod:`editorfs.files` (read, stat and
the guarded save), :mod:`editorfs.mutate` (operations on *paths*: create, rename,
batch move, trash — never ``unlink``), :mod:`editorfs.gitstatus` (read-only git
queries), :mod:`editorfs.search`, :mod:`editorfs.quickopen` and
:mod:`editorfs.projectfacts`.

Two invariants the whole Editor surface rests on:

* every path is **relative to ``NOJAE_PATH_LOCATION``** — the same
  working location both hubs point at, so one value moves the tree, the hubs
  and the terminal's ``cwd`` together;
* **every writer here is guarded, and browser-only.** No connector, no LSP tool
  and no chat code path reaches a write route. The connector deny-list still
  guards its own surface (an agent putting a private key into a context window
  is a different question from a human looking at their own file in a pane), and
  the workspace's policy is what guards this one.
"""

from typing import TYPE_CHECKING, Any

from . import constants
from .files import (
    WorkspaceSaveConflict,
    backup_for_write,
    read_file,
    stat_paths,
    write_file,
)
from .gitstatus import file_diff, git_status
from .mutate import (
    WorkspacePathExists,
    create_path,
    move_paths_batch,
    rename_path,
    sweep_trash,
    trash_batches,
    trash_dir,
    trash_digest,
    trash_path,
)
from .policy import (
    WorkspacePathError,
    normalise_rel,
    policy_blocking_error,
    resolve_existing_in_workspace,
    resolve_save_target,
    resolve_in_workspace,
    resolve_parent_in_workspace,
    resolve_write_target,
    workspace_root,
)
from .policy_modes import mode_for, refusal_message
from .projectfacts import project_facts
from .quickopen import list_workspace_files
from .search import SearchQueryError, search_workspace
from .tree import list_dir

# The verdict's vocabulary, from the shared module the connectors use too: they
# are names of this surface, and the definitions live outside ``src`` so both
# sides answer the same question with the same words.
MODES = constants.policy_shared.MODES
Verdict = constants.policy_shared.Verdict

_MISSING = object()


def __getattr__(name: str) -> Any:  # PEP 562
    """Resolve a constant from :mod:`editorfs.constants` at lookup time.

    Same rule as the two hubs: the caps are module attributes precisely so a test
    can patch them, so they must not be bound into this module's namespace (a
    copy would go stale under the patch).
    """
    value = getattr(constants, name, _MISSING)
    if value is not _MISSING:
        return value
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


if TYPE_CHECKING:  # pragma: no cover - typing only
    from .constants import (
        BINARY_SNIFF_BYTES,
        GIT_COMMAND_TIMEOUT,
        MAX_EDITOR_BYTES,
        MAX_STATUS_ENTRIES,
        MAX_TREE_ENTRIES_PER_DIR,
        PROJECT_ROOT,
    )
