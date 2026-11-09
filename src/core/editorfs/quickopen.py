"""The quick-open finder's candidate list: every path the tree lists, minus ``ro``.

``list_workspace_files`` is the core behind ``GET /api/fs/files``. It answers
one flat list of workspace-relative paths, fetched once per dialog open and
filtered per keystroke in the browser — so the walk is the whole cost, and it
is bounded by one cap.

What it promises (each rule mirrored by a test in ``tests/test_editorfs_quickopen.py``):

* **the candidate set is exactly what the tree would list, minus ``ro``.** One
  :func:`editorfs.policy_modes.mode_for` verdict per child, in the same three
  lines :func:`editorfs.tree.list_dir` uses — ``hidden`` is *pruned* (a
  directory costs no ``scandir`` below it, a file is omitted, and nothing is
  counted for either, so the payload never even confirms a hidden name) — and
  then ``ro`` is **excluded**: the finder is a shortcut to files you will
  *edit*, so a read-only path is not a candidate even though the tree shows it.
  The policy is the only exclusion mechanism; this module keeps no private
  ignore list.
* **the walk's order is the tree's order** (directories first, then files, each
  sorted by :func:`editorfs.tree._name_key`), so the list is deterministic and
  a truncated one is the same first N paths every run.
* **a symlinked directory is listed at one level and never descended** — the
  ``tree.py`` rule, so the walk cannot leave the workspace one hop at a time.
* **no file is ever opened** — names only. No size cap, no binary sniff, no
  UTF-8 question: the finder knows names, not contents.
* ``MAX_QUICKOPEN_FILES`` bounds the payload: paths past it are still counted
  (``fileCount`` is the honest total), and ``truncated`` is true only when the
  cap was hit. The cap is read qualified (``constants.MAX_…``) so a test can
  patch it instead of writing thousands of files.
"""

import os
from pathlib import Path
from typing import Any, Dict, List

from . import constants, tree
from .policy_modes import mode_for
from .constants import policy_shared as shared


def list_workspace_files() -> Dict[str, Any]:
    """Every candidate path of the quick-open finder, in the tree's order.

    Plain values in, dict out — the discipline of the rest of ``editorfs/``:
    no FastAPI type anywhere, and no file contents anywhere.
    """
    root = Path(tree.workspace_root())
    files: List[str] = []
    total = 0
    truncated = False

    def walk(rel: str, folder: Path) -> None:
        nonlocal total, truncated
        try:
            with os.scandir(folder) as scan:
                entries = list(scan)
        except OSError:
            # Unreadable directory: end this branch rather than fail the
            # listing — the same answer ``tree._has_children`` gives.
            return

        dirs: List[os.DirEntry] = []
        plain_files: List[os.DirEntry] = []
        for scan_entry in entries:
            child_rel = tree._rel_of(rel, scan_entry.name)
            verdict = mode_for(child_rel).mode
            # One verdict, and it is a *prune*, exactly ``tree.list_dir``'s
            # three lines: a hidden folder is neither listed nor walked, so
            # the payload never confirms a hidden name. Nothing is counted.
            if verdict == shared.HIDDEN:
                continue
            # ``ro`` is the finder's own narrowing of the tree's set: a
            # read-only path is not a file you will edit, so it is excluded —
            # a directory is not descended either.
            if verdict == shared.READ_ONLY:
                continue
            if scan_entry.is_dir(follow_symlinks=False):
                dirs.append(scan_entry)
            elif scan_entry.is_dir():
                # A symlinked directory: listed at one level in the tree, but
                # the finder emits files only, so it contributes nothing — and
                # it is never descended, so the walk cannot leave the
                # workspace through it.
                continue
            else:
                plain_files.append(scan_entry)

        # ``tree._name_key`` reads the ``name`` of an entry dict, so it is
        # handed that one field — the tree's own ordering, never re-derived.
        dirs.sort(key=lambda entry: tree._name_key({"name": entry.name}))
        plain_files.sort(key=lambda entry: tree._name_key({"name": entry.name}))

        for scan_entry in dirs:
            walk(tree._rel_of(rel, scan_entry.name), Path(scan_entry.path))
        for scan_entry in plain_files:
            child_rel = tree._rel_of(rel, scan_entry.name)
            total += 1
            if len(files) < constants.MAX_QUICKOPEN_FILES:
                files.append(child_rel)
            else:
                truncated = True

    walk("", root)
    return {"files": files, "fileCount": total, "truncated": truncated}
