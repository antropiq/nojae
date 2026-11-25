"""Discovery and validation of the declared language servers.

Reads the workspace's ``.nojae/lsp-settings.json`` into the dicts the rest
of the package consumes. The declaration path and the deny-list are resolved
through ``lsphub.constants`` *inside* each call, so a switched working
location moves the read and a patched pin redirects it.
"""

import importlib.util
import json
import os
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

# The path-*text* questions the shared connector policy answers: what root a
# prefix is spelled with, on either platform, with no ``os.path`` branch.
# Imported the connectors' own way, because ``mcp_connectors`` sits outside
# ``src`` and is not always on ``sys.path`` (the same fallback
# ``mcphub.process`` and ``editorfs.constants`` use).
try:
    from mcp_connectors import path_policy
except ImportError:  # pragma: no cover - depends on how the app is started
    import sys

    _root = str(Path(__file__).resolve().parents[3])
    if _root not in sys.path:
        sys.path.insert(0, _root)
    from mcp_connectors import path_policy  # type: ignore[no-redef]

# The one containment rule. Direction of this import: the editorfs surface
# reaches *this* module for ``restricted_lsp_roots`` — lazily, inside the one
# function that asks — while this module needs only the pure compare, which
# imports nothing from ``lsphub``. So no cycle. ``fscase`` answers the fold from
# the *workspace's* filesystem (see ``_is_within``'s docstring); the root
# accessor is aliased because this module's own entries carry a ``workspaceRoot``
# and that local name is a string, not the function.
from src.core.editorfs import fscase
from src.core.editorfs.policy import _is_within
from src.core.editorfs.policy import workspace_root as active_workspace_root

from src.core.mcphub.validation import (
    argv_from_command,
    expand_env,
    expand_env_json,
    expand_env_list,
    expand_env_map,
    str_map,
    unresolved_env_note,
)

from . import constants


def lsp_installed() -> bool:
    """True when the optional LSP deps (the ``[lsp]`` extra) are importable."""
    try:
        return (
            importlib.util.find_spec("pygls") is not None
            and importlib.util.find_spec("lsprotocol") is not None
        )
    except (ImportError, ValueError):
        return False


def restricted_lsp_roots(path: Optional[Path] = None) -> List[str]:
    r"""Workspace-root prefixes refused by the hub, from ``restricted-paths.txt``.

    One absolute prefix per line, ``#`` starts a comment, and a line may name an
    environment variable as ``${NAME}`` (or ``${NAME:-fallback}``), expanded here
    at read time so one committed list stays machine-neutral and carries both
    platforms' path forms with no drive letter or home directory spelled in it.

    A line whose reference does **not** resolve is dropped, not kept as written —
    the opposite of a declaration's rule, and for a reason: an un-expanded prefix
    reads to ``guardrails_speak_here`` as an entry that speaks this filesystem's
    root form while protecting nothing, so the reach seam would be lifted on that
    reading and the entries that *did* resolve would go unenforced. A guardrail
    that cannot be honoured is absent, not guessed.
    """
    root = path or constants.LSP_RESTRICTED_PATHS
    try:
        lines = root.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    entries: List[str] = []
    for line in lines:
        text = line.strip()
        if not text or text.startswith("#"):
            continue
        entry, missing = expand_env(text)
        entry = entry.strip()
        # ``missing`` first and on its own: a half-resolved line — ``/home/
        # ${NOPE}/.ssh`` — still has a rooted shape, so testing only the shape
        # would let the literal reference in as a working prefix. Dropped in
        # silence: a cross-platform list drops its other-platform lines by
        # design, so a note here would be pure noise. A guardrail stated twice
        # is noise too.
        honoured = not missing and _is_prefix(entry)
        if honoured and entry not in entries:
            entries.append(entry)
    return entries


def _is_prefix(text: str) -> bool:
    r"""Is ``text`` an absolute prefix at all — on **either** platform?

    Asked of the shared text classifier, never of ``os.path.isabs``: that answers
    ``False`` for ``/etc`` on Windows, which would make a POSIX guardrail dead on
    the runner it was read on. What makes a prefix speak a path is its *root*
    (``path_policy.root_form``); only text with no root at all (``~/.ssh``, a
    relative path) is dropped for being unrooted.
    """
    return path_policy.root_form(text) in ("absolute", "drive", "unc")


def lsp_reach_is_refused() -> bool:
    """Must a declared language server be refused here?

    The LSP hub's call of the shared predicate (``mcphub.process``, which the
    MCP hub calls too), so a refusal cannot be argued differently in the two
    hubs; what differs per hub is *which* guardrails are asked about. For a
    language server that is :func:`restricted_lsp_roots` — the deny-list that
    would confine its ``workspaceRoot`` — and, when that file carries no
    entries, the connector prefix lists, so an absent list is not mistaken for
    a bound that has stopped matching.

    What refuses here is an **inert list**, never an operating system: a rule
    that stops matching produces no error, so a server whose ``workspaceRoot`` no
    prefix can name is one whose reach the app has bounded in words only. The
    rest of the bound is a capability this hub holds on either platform (the
    spawn's Job Object, the shared ``proctree`` teardown, the Windows path forms
    read from the environment), so a deployment is fixed by *writing values*, not
    by the code knowing which OS it is on.
    """
    return not constants.guardrails_speak_here(restricted_lsp_roots() or None)


def denied_roots() -> Tuple[List[str], bool]:
    """``(real deny-list, one fold answer)`` — the pair a scan computes once.

    Two facts that always travel together and are properties of the running
    configuration rather than of one entry: the deny-list's entries as real
    paths, and whether the *workspace's* filesystem folds case (``_is_within``'s
    docstring records why that is the fold). The file walk and the wizard's
    snippet check both hand the pair to :func:`entry_from_declaration` — one
    computation, one verdict.
    """
    denied = [os.path.realpath(entry) for entry in restricted_lsp_roots()]
    return denied, fscase.case_folded(active_workspace_root()) if denied else False


def entry_from_declaration(
    name: str,
    server_id: str,
    entry: Any,
    *,
    denied: Sequence[str] = (),
    fold: bool = False,
    refused_reach: Optional[bool] = None,
) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    """One declared language server, read and validated — the per-entry rule.

    The **only** place the shape of a server entry is judged, so the file walk
    (:func:`load_lsp_servers`) and the connector wizard's snippet check
    (:mod:`wizard.snippet`) cannot drift. Its mirror is
    :func:`mcphub.discovery.entry_from_declaration` — same name, same shape, so
    the two hubs keep mirroring each other.

    ``name`` is the declaration file's name, which the sentences begin with.
    Answers ``(server, errors)``: a refused entry is ``None`` with its refusal
    as the last error, a loaded one a dict plus the notes it earned (an
    unresolved ``${NAME}``, a refused reach).

    ``denied``/``fold`` and ``refused_reach`` are properties of the running
    configuration, computed once per load; ``refused_reach=None`` asks the seam
    here, which is what a caller checking a single entry wants.
    """
    prefix = f"{name}: '{server_id}'"
    errors: List[str] = []
    if refused_reach is None:
        refused_reach = lsp_reach_is_refused()
    if not isinstance(entry, dict):
        errors.append(f"{prefix}: entry must be a JSON object — skipped")
        return None, errors
    # Everything that may carry a ``${NAME}`` reference is expanded here, in one
    # block, before the checks that consume it — so an unresolved reference is
    # reported by name *and* explains the shape error it causes below (an unset
    # ``${ROOT}`` turns into a relative path, which would read like a typo).
    missing: List[str] = []
    command = argv_from_command(entry.get("command"), entry.get("args"))
    if command is None:
        errors.append(f"{prefix}: an LSP server needs a command — skipped")
        return None, errors
    command, names = expand_env_list(command)
    missing.extend(names)
    env = str_map(entry.get("env"))
    if env is None:
        errors.append(f"{prefix}: env must be an object of string values — skipped")
        return None, errors
    env, names = expand_env_map(env)
    missing.extend(names)
    workspace_root = entry.get("workspaceRoot")
    if isinstance(workspace_root, str):
        workspace_root, names = expand_env(workspace_root)
        missing.extend(names)
    initialization_options = entry.get("initializationOptions")
    if initialization_options is not None and not isinstance(
        initialization_options, dict
    ):
        errors.append(
            f"{prefix}: initializationOptions must be an object — skipped"
        )
        return None, errors
    initialization_options, names = expand_env_json(initialization_options)
    missing.extend(names)
    # Answers to the server's own workspace/configuration requests, keyed by LSP
    # section ('html.customData', 'vue.suggest.propNameCasing', …). Anything not
    # listed is answered null, "not set", so the server's own ?? fallback lands
    # on its default.
    settings = entry.get("settings")
    if settings is not None and not isinstance(settings, dict):
        errors.append(f"{prefix}: settings must be an object — skipped")
        return None, errors
    settings, names = expand_env_json(settings)
    missing.extend(names)
    note = unresolved_env_note(prefix, missing)
    if note is not None:
        errors.append(note)
    extensions = entry.get("extensions")
    if extensions is None:
        extensions = []
    if not isinstance(extensions, list) or not all(
        isinstance(item, str) and item.startswith(".") for item in extensions
    ):
        errors.append(
            f"{prefix}: extensions must be a list of '.ext' strings — skipped"
        )
        return None, errors
    if not isinstance(workspace_root, str) or not os.path.isabs(workspace_root):
        errors.append(f"{prefix}: workspaceRoot must be an absolute path — skipped")
        return None, errors
    real_root = os.path.realpath(workspace_root)
    if not os.path.isdir(real_root):
        errors.append(f"{prefix}: workspaceRoot does not exist — skipped")
        return None, errors
    if any(
        _is_within(denied_entry, real_root, fold=fold) for denied_entry in denied
    ):
        errors.append(f"{prefix}: workspaceRoot is on the deny-list — skipped")
        return None, errors
    tools = entry.get("tools")
    if tools is not None and (
        not isinstance(tools, list)
        or not all(isinstance(item, str) and item for item in tools)
    ):
        errors.append(f"{prefix}: tools must be a list of names — skipped")
        return None, errors
    max_diagnostics = entry.get("maxDiagnostics", constants.DEFAULT_MAX_DIAGNOSTICS)
    if not isinstance(max_diagnostics, int) or max_diagnostics < 1:
        errors.append(
            f"{prefix}: maxDiagnostics must be a positive integer — skipped"
        )
        return None, errors
    idle_shutdown = entry.get(
        "idleShutdownSeconds", constants.DEFAULT_IDLE_SHUTDOWN_SECONDS
    )
    if not isinstance(idle_shutdown, int) or idle_shutdown < 0:
        errors.append(
            f"{prefix}: idleShutdownSeconds must be an integer (0 disables) — skipped"
        )
        return None, errors
    if refused_reach and bool(entry.get("enable", False)):
        # Every declared server here is a stdio child process whose path reach
        # the lists above must confine — so when no entry in them can name this
        # filesystem's paths there is no bound to claim. The entry is still
        # loaded, because a card naming the gap beats a vanished server, and the
        # hub marks it ``error`` with these same words rather than spawning it.
        # Asked only of an entry that wants to run: a disabled server is not a
        # missing capability, it is a switch the user made.
        errors.append(
            f"{prefix}: {constants.LOCAL_REACH_REFUSAL} — not started"
        )
    label = entry.get("label")
    language_id = entry.get("languageId")
    return (
        {
            "id": server_id,
            "label": label if isinstance(label, str) and label else server_id,
            "description": (
                entry["description"]
                if isinstance(entry.get("description"), str)
                else ""
            ),
            "command": command,
            "workspaceRoot": workspace_root,
            "extensions": sorted({item.lower() for item in extensions}),
            "languageId": language_id if isinstance(language_id, str) else "",
            "enable": bool(entry.get("enable", False)),
            "lazy": bool(entry.get("lazy", False)),
            "initializationOptions": initialization_options or {},
            "tools": list(tools) if tools is not None else None,
            "env": env or {},
            "settings": settings or {},
            "maxDiagnostics": max_diagnostics,
            "idleShutdownSeconds": idle_shutdown,
        },
        errors,
    )


def load_lsp_servers(
    path: Optional[Path] = None, reserved_ids: Optional[Set[str]] = None
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Read the workspace's ``.nojae/lsp-settings.json`` into server dicts.

    A missing file yields ``([], [])``. Unreadable/invalid JSON yields one
    file-level error and no servers. A single malformed entry is skipped with
    a per-entry note; unknown keys are ignored. Entries keep their ``enable``
    flag; the caller decides what to do with disabled ones. Never raises.

    Environment references in a declaration's values are expanded here, once,
    before any path/shape check runs. An entry that references an unset name is
    still loaded (subject to the usual checks) with a note saying so.

    One entry is judged by :func:`entry_from_declaration`, which this walk only
    calls — the rule has one home.
    """
    root = path or constants.lsp_settings_path()
    servers: List[Dict[str, Any]] = []
    errors: List[str] = []
    reserved = {str(entry) for entry in reserved_ids or ()}
    if not root.is_file():
        return servers, errors
    try:
        data = json.loads(root.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return [], [f"{root.name} is not readable JSON: {exc}"]
    if not isinstance(data, dict):
        return [], [f"{root.name} must contain an object of servers keyed by id"]
    # The deny-list, its fold answer and the reach answer are properties of the
    # running configuration, so every note in one load has to agree with every
    # other.
    denied, fold = denied_roots()
    refused_reach = lsp_reach_is_refused()
    for server_id in sorted(data):
        if server_id in reserved:
            errors.append(f"{root.name}: '{server_id}': id is reserved — skipped")
            continue
        if server_id.startswith("_"):
            # Convention: an underscore key is a comment, not a server.
            continue
        server, entry_errors = entry_from_declaration(
            root.name,
            server_id,
            data[server_id],
            denied=denied,
            fold=fold,
            refused_reach=refused_reach,
        )
        errors.extend(entry_errors)
        if server is not None:
            servers.append(server)
    return servers, errors


def all_servers(
    path: Optional[Path] = None,
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Every declared language server plus the file's validation errors."""
    return load_lsp_servers(path)


def set_lsp_enabled(
    enabled: Dict[str, bool], path: Optional[Path] = None
) -> List[str]:
    """Write ``enable`` flags back to ``.nojae/lsp-settings.json``.

    Only entries already present in the file are touched; other keys, entry
    order, and unknown ids are preserved. A missing file is a no-op; a file
    that cannot be parsed is left untouched and reported as an error list.
    """
    root = path or constants.lsp_settings_path()
    if not root.is_file():
        return []
    try:
        data = json.loads(root.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return [f"Could not update {root.name}: {exc}"]
    if not isinstance(data, dict):
        return [f"Could not update {root.name}: top level is not an object"]
    for server_id, value in enabled.items():
        entry = data.get(server_id)
        if isinstance(entry, dict):
            entry["enable"] = bool(value)
    try:
        root.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
    except OSError as exc:
        return [f"Could not write {root.name}: {exc}"]
    return []
