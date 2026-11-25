"""Subprocess plumbing shared by the hub's children (and the LSP hub's).

``connector_environment`` builds the environment every connector /
language-server subprocess is launched with, free of MCP-specific knowledge so
``lsphub`` can reuse it verbatim; :func:`child_environment` is that environment
plus the entry's own ``env`` — the one a start is actually handed — and
:func:`resolve_command` / :func:`searched_paths` are the single lookup of a
declared ``argv[0]`` through it. Both hubs and the connector wizard's snippet
check ask the same functions, which is what keeps *one search, one verdict*: a
command the panel would not start cannot read as installed on the page that
offers it. Resolving a program's path is not starting it.

The reach-capability question below is answered once for **both** hubs — do the
guardrails that would confine a local child's path reach speak this filesystem
at all? — so the answer cannot drift between them; each hub's ``constants``
module re-exports it, which is where a test forces the other answer.
"""

import os
import shutil
import sys
import tempfile
from pathlib import Path
from typing import Dict, Optional, Sequence

try:  # imported as part of the package (tests, ``python -m mcp_connectors...``)
    from mcp_connectors import path_policy
except ImportError:  # pragma: no cover - depends on how the app is started
    root = str(Path(__file__).resolve().parents[3])
    if root not in sys.path:
        sys.path.insert(0, root)
    from mcp_connectors import path_policy  # type: ignore[no-redef]

from src.core import workspace


def guardrails_speak_here(prefixes: Optional[Sequence[str]] = None) -> bool:
    """True when the guardrail prefixes could speak the **workspace's** form.

    A prefix matches as *text*, so a list of ``/etc``-shaped entries covers
    nothing once the working location is a ``C:`` tree — every rule stops
    matching and says nothing about it. The folder asked about is the seam's
    scope, so the answer is about *the workspace this call serves*, never about
    a folder another tab holds. It comes from the shape of the entries against
    the shape of the path, not from the platform's name, so a deployment that
    supplies matching prefixes is believed on either hub.

    ``prefixes`` is the caller's own list (the LSP hub's workspace-root
    deny-list); ``None`` asks the connector deny/allow prefixes. An **empty**
    list answers True: carrying no prefixes is a declaration, not a list that
    has stopped matching, and a hub whose list is absent has never been bounded
    by one either — refusing on that reading would change Linux.
    """
    entries: Sequence[str] = (
        tuple(path_policy.ALLOW_PREFIXES)
        + tuple(path_policy.DENY_PREFIXES)
        + tuple(path_policy.DENY_PREFIXES_READ)
        if prefixes is None
        else tuple(prefixes)
    )
    if not entries:
        return True
    # The seam's scope, never ``expanduser()``: the workspace is a canonical
    # real folder by the time any hub reads it.
    resolved = Path(workspace.current_root()).resolve().as_posix()
    return path_policy.lists_are_meaningful(resolved, prefixes=entries)


def connector_environment(project_root: Path, base_env: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    """Environment for a connector subprocess.

    Adds the project root to ``PYTHONPATH`` so ``mcp_connectors`` imports, and
    pins an absolute ``TMPDIR``: Node's ``os.tmpdir()`` (the playwright driver)
    falls back to ``TMPDIR``/``TMP``/``TEMP``, so a relative value in any of them
    — e.g. the Windows-style ``TEMP`` carried by an ambient environment — would
    otherwise be taken as a relative temp directory and break browser launches.
    """
    env = dict(os.environ if base_env is None else base_env)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(project_root), env.get("PYTHONPATH", "")]
    ).rstrip(os.pathsep)
    temp_dir = tempfile.gettempdir()
    for key in ("TMPDIR", "TMP", "TEMP"):
        value = env.get(key, "")
        if value and not Path(value).is_absolute():
            env.pop(key, None)
    env["TMPDIR"] = temp_dir
    return env


def child_environment(
    project_root: Path, entry_env: Optional[Dict[str, str]] = None
) -> Dict[str, str]:
    """The environment one declared entry's child is launched with.

    :func:`connector_environment` plus the entry's own ``env`` on top — the
    entry's values win, which is how a language server gets a ``PATH`` that
    resolves its own volted tools. One function, because the search below and
    the spawns must agree or a declaration the search accepted can fail at the
    spawn.
    """
    env = connector_environment(project_root)
    env.update(entry_env or {})
    return env


def searched_paths(command: str, env: Dict[str, str]) -> str:
    r"""The folders a lookup of ``command`` in ``env`` walks, as one string.

    The *search* path, not the variable: ``shutil.which`` consults ``PATH`` only
    for a bare name, and for a command that already spells a path
    (``C:\tools\langserver``, ``./x``) the directory it spells is the whole
    search. Naming ``PATH`` there would report folders the lookup never opened —
    a refusal has to say what was actually looked in.
    """
    directory, _name = os.path.split(command)
    if directory:
        return directory
    # The child's ``PATH`` and nothing else — see :func:`resolve_command`
    # for why the app's own PATH is never the one searched.
    return env.get("PATH") or "nothing: the child environment has no PATH"


def resolve_command(command: str, env: Dict[str, str]) -> Optional[str]:
    """The program the declaration names, or ``None`` when nothing answers it.

    ``shutil.which`` honours ``PATHEXT``, so the extensionless shim a POSIX user
    would write (npm/volta's ``pyright-langserver``, a ``#!/bin/bash`` script
    Windows cannot exec) resolves to the ``.cmd`` beside it. It is asked with
    **the environment the child actually gets** (:func:`child_environment`,
    which replaces ``PATH`` wholesale with the declaration's own ``env.PATH``):
    resolving with the app's PATH and spawning with the child's is two different
    searches, and a declaration can make the second one fail. One search, one
    verdict — the rule the wizard's readiness line is built from too.

    No platform branch: on POSIX an absolute command that exists resolves to
    itself, so the answer there is the unchanged path.
    """
    resolved = shutil.which(command, path=env.get("PATH", ""))
    if resolved is not None:
        return resolved
    # A file the search refused — no ``PATHEXT`` entry matches it on Windows,
    # no executable bit on POSIX — is still handed to the OS: its own error
    # (``[WinError 193]``, ``PermissionError``) is the accurate answer to *why
    # that file cannot run*. Refusing it here would replace a fact with a guess.
    if os.path.isfile(command):
        return command
    return None
