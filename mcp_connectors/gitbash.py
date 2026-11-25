"""Where a Git for Windows install is, and what a program started under it searches.

One probe, two callers: the console connector's discovery and the Editor
terminal's shell selection. Two copies of "where is Git" is how the pane and the
agent start disagreeing about a path, so the answers live here once.

It lives in ``mcp_connectors/`` for the same reason :mod:`path_norm`,
:mod:`policy_glob` and :mod:`fscase` do: a connector runs in its own process and
**cannot import ``src``**, while ``src`` may import ``mcp_connectors`` (the
precedent is ``editorfs/fscase.py`` re-exporting ``mcp_connectors/fscase.py``).
Stdlib-only, no transport, nothing that could turn a lookup into a client.

It answers *where a program is*, never *whether a command is allowed*: no policy
lives here (a policy rule changes in ``console_mcp.py`` / ``path_policy.py`` once
and both modes inherit it), and finding a shell program is not the same as being
allowed to run one — ``console_mcp.py`` still refuses ``bash``/``sh``/``cmd``/
``powershell``/``pwsh`` by name, so the pane may have a shell while the tool may
not.

Every question takes its arguments handed in, so a test forces either answer on
one runner. The module-level defaults below are the patch-point convention
``console_mcp`` delegates to: its own ``GIT_INSTALL_CANDIDATES`` /
``GIT_ENV_OVERRIDE`` are these values, and its ``GIT_SEARCH_PATHS`` is what
:func:`git_search_paths` returns for the root its startup probe found.

The override (``NOJAE_GIT_BASH_DIR``) is **process-environment only**, never a
managed ``.env`` key — the same reasoning as ``NOJAE_PATH_LOCATION`` (*"a
settings save must not erase it"*), so the managed template's key set is not
widened for a platform detail.
"""

import os
import shutil
from pathlib import Path
from typing import Dict, List, Mapping, Optional, Sequence

# What proves a directory is a Git install root rather than a folder holding a
# stray ``git.exe``: the POSIX toolset, not the launcher.
TOOLSET_MARKER: str = os.path.join("usr", "bin", "ls.exe")

# Install roots searched when ``git`` is not on PATH at all. Built from the
# environment at import; where those names are unset the entries are harmless
# non-candidates.
GIT_INSTALL_CANDIDATES: List[str] = [
    r"C:\Program Files\Git",
    os.path.join(os.environ.get("LOCALAPPDATA", ""), "Programs", "Git"),
    os.path.join(os.environ.get("USERPROFILE", ""), "scoop", "apps", "git", "current"),
    r"C:\ProgramData\chocolatey\opt\git\current",
]
GIT_ENV_OVERRIDE: str = "NOJAE_GIT_BASH_DIR"

# The C-runtime tool trees a Git install may carry. Which one exists is a fact
# about the install, not about the app, so the search path is built from the
# trees that are *there* rather than from a hard-coded name.
GIT_TOOL_TREES: List[str] = ["mingw64", "ucrt64"]


def has_git_toolset(candidate: str) -> Optional[str]:
    r"""``candidate`` as a Git install root when its ``usr\bin\ls.exe`` is there."""
    probe = Path(candidate) / TOOLSET_MARKER
    return str(Path(candidate)) if probe.is_file() else None


def discover_git_install(
    candidates: Optional[Sequence[str]] = None,
    env_override: Optional[str] = None,
    environ: Optional[Mapping[str, str]] = None,
) -> Optional[str]:
    r"""The Git for Windows install root, or None.

    1. ``shutil.which("git")`` walked up from ``...\cmd\git.exe`` to the install
       dir; 2. the fixed candidates; 3. the env override; 4. None — which the
       caller turns into its own refusal. A found root is always verified by
       ``usr\bin\ls.exe``, so a stray ``git.exe`` elsewhere on PATH cannot
       select the mode.

    The candidates and the override name are patchable attributes here, and
    ``console_mcp`` hands in its own patched ones, so a test forces either
    answer. ``environ`` defaults to the process environment.
    """
    names = GIT_INSTALL_CANDIDATES if candidates is None else list(candidates)
    override_name = GIT_ENV_OVERRIDE if env_override is None else env_override
    env = os.environ if environ is None else environ

    git = shutil.which("git")
    if git is not None:
        directory = Path(git).resolve().parent
        for _ in range(4):  # cmd/ or bin/ -> the install root
            found = has_git_toolset(str(directory))
            if found:
                return found
            if directory.parent == directory:
                break
            directory = directory.parent
    for candidate in names:
        found = has_git_toolset(candidate)
        if found:
            return found
    override = (env.get(override_name, "") or "").strip().strip('"')
    if override:
        return has_git_toolset(override)
    return None


def git_search_paths(
    git_root: str, tool_trees: Optional[Sequence[str]] = None
) -> List[str]:
    """The command search path for a Git root, in resolution order.

    ``usr\\bin`` (the POSIX toolset, so GNU ``find``/``sort``/``tar`` resolve
    before System32's), then ``bin``, then whichever C-runtime tool tree the
    install actually carries — a search path naming a directory that is not
    there is harmless but dishonest, so the tool trees are answered from the
    filesystem. The ambient PATH is the caller's business:
    ``console_mcp.resolve_command`` appends it.
    """
    trees = GIT_TOOL_TREES if tool_trees is None else list(tool_trees)
    paths = [
        str(Path(git_root) / "usr" / "bin"),
        str(Path(git_root) / "bin"),
    ]
    for tree in trees:
        directory = Path(git_root) / tree / "bin"
        if directory.is_dir():
            paths.append(str(directory))
    return paths


def git_shell_program(git_root: Optional[str]) -> Optional[str]:
    r"""The interactive shell program of a Git root (``bin\\bash.exe``), or None.

    The terminal's question, not the connector's: the console connector never
    runs a shell and refuses ``bash`` by name exactly as before. The program is
    asked for where Git puts it, and the answer is verified to exist — a root
    whose shell is absent is no shell, and the caller refuses rather than
    spawning a name.
    """
    if not git_root:
        return None
    program = Path(git_root) / "bin" / "bash.exe"
    return str(program) if program.is_file() else None


def git_child_env(
    base: Mapping[str, str],
    git_root: str,
    tool_trees: Optional[Sequence[str]] = None,
) -> Dict[str, str]:
    """A child environment for a shell or tool started under ``git_root``.

    Git's directories are **prepended** to ``PATH`` in :func:`git_search_paths`
    order, so the child resolves ``stty``, ``tty``, ``tput`` and ``which`` the
    way the app's resolver does instead of "command not found" from the ambient
    Windows ``PATH`` alone. An entry containing a space (``C:\\Program
    Files\\Git\\usr\\bin``) survives verbatim: only split and join on the
    separator, never shlex. Every other key of ``base`` is copied untouched.
    """
    child: Dict[str, str] = dict(base)
    entries = git_search_paths(git_root, tool_trees)
    ambient = child.get("PATH", "") or ""
    if ambient:
        entries.extend(part for part in ambient.split(os.pathsep) if part)
    child["PATH"] = os.pathsep.join(entries)
    return child
