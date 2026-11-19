"""Discovery and validation of the workspace's declared connectors.

Reads ``<working location>/.nojae/mcp-settings.json`` (kilo.json-style
``remote``/``local`` entries) into the dicts the rest of the package
consumes — that file is the one and only source of connectors. The path is
looked up through ``mcphub.constants.mcp_settings_path()`` *inside* each
function call, so a switched working location moves the read and a patched
pin redirects it — one attribute, not an import dance. The heavy ``mcp``
package is only checked for, never imported here, so discovery keeps working
without the optional ``[mcp]`` extra.
"""

import importlib.util
import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import constants
from .validation import (
    argv_from_command,
    expand_env,
    expand_env_list,
    expand_env_map,
    str_map,
    unresolved_env_note,
)


def mcp_installed() -> bool:
    """True when the optional ``mcp`` dependency (the ``[mcp]`` extra) is present."""
    return importlib.util.find_spec("mcp") is not None


def mcp_reach_is_refused() -> bool:
    """Must a ``local`` connector be refused here? (win-07 / A-D4, lifted by B1.)

    One answer, consulted by :func:`load_externals` (called at boot and on every
    hub reload, so the validation note appears in both) and by ``McpManager``
    (which must not spawn the entry). It is read through this hub's
    ``constants`` — the single named seam — so a test forces it by patching one
    attribute here. This hub's guardrails are the connector prefix lists of
    ``mcp_connectors/path_policy``, so the shape question is asked without an
    explicit list.

    This hub asks only the *guardrail* half, and since lspfinal-04 so does the
    LSP hub: the two predicates are one shape again (AGENTS.md — the hubs mirror
    each other). What a connector's path reach is bounded by is the prefix lists
    of ``path_policy``, which speak both platforms' path forms; its children are
    short-lived direct children the connector itself kills on timeout, on top of
    the hub's wrapper kill — bounding *path* reach is the whole claim a console
    or fedit makes.
    """
    return not constants.guardrails_speak_here()


def entry_from_declaration(
    name: str,
    connector_id: str,
    entry: Any,
    *,
    refused_local: Optional[bool] = None,
) -> Tuple[Optional[Dict[str, Any]], List[str]]:
    """One declaration entry, read and validated — the loader's per-entry rule.

    The **only** place the shape of a connector entry is judged, so the file
    walk (:func:`load_externals`) and the connector wizard's snippet check
    (:mod:`wizard.snippet`) cannot drift: a member the wizard accepts is a
    member this loader accepts, in the same words, because it is this function
    that answers both.

    ``name`` is the declaration file's name, which the sentences begin with, so
    a caller holding a different path (the wizard's) spells its own file and the
    rest of the sentence is unchanged.

    Answers ``(connector, errors)``: an entry that is refused is ``None`` with
    the refusal as the **last** error, and a loaded entry is a dict with the
    notes it earned (an unresolved ``${NAME}``, a refused reach) beside it.
    Entries keep their ``enable`` flag; the caller decides what to do with
    disabled ones.

    ``refused_local`` is the reach answer for the whole scan — a property of the
    deployment, asked once per load so every note in one read agrees. ``None``
    asks the seam here, which is what a caller checking a single entry wants.
    """
    prefix = f"{name}: '{connector_id}'"
    errors: List[str] = []
    if refused_local is None:
        refused_local = mcp_reach_is_refused()
    if not isinstance(entry, dict):
        errors.append(f"{prefix}: entry must be a JSON object — skipped")
        return None, errors
    kind = entry.get("type")
    kind = kind.lower() if isinstance(kind, str) else ""
    if kind not in ("local", "remote"):
        errors.append(f"{prefix}: type must be \"local\" or \"remote\" — skipped")
        return None, errors
    # Every field that may carry a ``${NAME}`` reference is expanded here,
    # in one block, *before* the shape checks below consume it — so a whole
    # ``url`` can be an environment reference, and an unresolved name is
    # reported by name before (and thereby explains) the shape error it
    # causes. Values are read raw first, then checked after expansion.
    missing: List[str] = []
    headers = str_map(entry.get("headers"))
    env = str_map(entry.get("env"))
    if headers is None or env is None:
        errors.append(
            f"{prefix}: headers/env must be objects of string values — skipped"
        )
        return None, errors
    headers, names = expand_env_map(headers)
    missing.extend(names)
    env, names = expand_env_map(env)
    missing.extend(names)
    endpoint = ""
    command: Optional[List[str]] = None
    if kind == "remote":
        url = entry.get("url")
        if isinstance(url, str):
            url, names = expand_env(url)
            missing.extend(names)
        if not isinstance(url, str) or not url.lower().startswith(
            ("http://", "https://")
        ):
            errors.append(
                f"{prefix}: remote connector needs an http(s) url — skipped"
            )
            return None, errors
        endpoint = url
    else:
        command = argv_from_command(entry.get("command"), entry.get("args"))
        if command is None:
            errors.append(
                f"{prefix}: local connector needs a command — skipped"
            )
            return None, errors
        command, names = expand_env_list(command)
        missing.extend(names)
    note = unresolved_env_note(prefix, missing)
    if note is not None:
        errors.append(note)
    if kind == "local" and refused_local and entry.get("enable", False):
        # A ``local`` entry is a stdio child whose reach is bounded only by
        # the POSIX prefixes of ``mcp_connectors/path_policy``. Where those
        # speak nothing (win-07 / A-D4) the entry is still loaded — a card
        # naming the gap beats a vanished connector — but the hub refuses to
        # start it and marks it ``error`` with the same words. Asked only of
        # an entry that *wants* to run: a disabled one is nobody's missing
        # capability, and its silence is today's Linux behaviour. Remote
        # entries are untouched: they carry no local path reach, and their
        # ``restricted-fqdn.txt`` guard is separator-free.
        errors.append(
            f"{prefix}: {constants.LOCAL_REACH_REFUSAL} — not started"
        )
    description = entry.get("description")
    return (
        {
            "id": connector_id,
            "label": connector_id,
            "description": description if isinstance(description, str) else "",
            "endpoint": endpoint,
            "command": command,
            "kind": kind,
            "enable": bool(entry.get("enable", False)),
            "headers": headers or {},
            "env": env or {},
        },
        errors,
    )


def load_externals(
    path: Optional[Path] = None,
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Read the workspace's ``.nojae/mcp-settings.json`` into connector dicts.

    A missing file yields ``([], [])``. Unreadable/invalid JSON yields one
    file-level error and no connectors. A single malformed entry is skipped
    with a per-entry note. Never raises. Entries keep their ``enable`` flag;
    the caller decides what to do with disabled ones.

    ``url``, ``command``/``args``, ``headers`` and ``env`` may reference
    environment variables as ``${NAME}`` (or ``${NAME:-fallback}``): they are
    expanded here, once, so the rest of the package never sees a reference
    and one declaration file works on every machine. An entry that references
    an unset name is still loaded, with a note saying so (see
    :func:`~mcphub.validation.expand_env`).

    One entry is judged by :func:`entry_from_declaration`, which this walk only
    calls — the rule has one home, so a caller checking a member that does not
    exist yet reads the same verdict as this walk.
    """
    root = path or constants.mcp_settings_path()
    connectors: List[Dict[str, Any]] = []
    errors: List[str] = []
    if not root.is_file():
        return connectors, errors
    try:
        data = json.loads(root.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return [], [f"{root.name} is not readable JSON: {exc}"]
    if not isinstance(data, dict):
        return [], [f"{root.name} must contain an object of connectors keyed by id"]
    # One reach answer per scan, not per entry (the capability is a property of
    # the deployment, and asking the seam once keeps every note in one load
    # consistent with every other).
    refused_local = mcp_reach_is_refused()
    for connector_id in sorted(data):
        connector, entry_errors = entry_from_declaration(
            root.name,
            connector_id,
            data[connector_id],
            refused_local=refused_local,
        )
        errors.extend(entry_errors)
        if connector is not None:
            connectors.append(connector)
    return connectors, errors


def set_externals_enabled(
    enabled: Dict[str, bool], path: Optional[Path] = None
) -> List[str]:
    """Write ``enable`` flags back to the workspace's declaration file, keeping everything else.

    Only entries already present in the file are touched; other keys, entry
    order, and unknown ids are preserved. A missing file is a no-op. A file
    that cannot be parsed is left untouched (never rebuilt from partial
    knowledge) and reported back as an error list.
    """
    root = path or constants.mcp_settings_path()
    if not root.is_file():
        return []
    try:
        data = json.loads(root.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return [f"Could not update {root.name}: {exc}"]
    if not isinstance(data, dict):
        return [f"Could not update {root.name}: top level is not an object"]
    for connector_id, value in enabled.items():
        entry = data.get(connector_id)
        if isinstance(entry, dict):
            entry["enable"] = bool(value)
    try:
        root.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
    except OSError as exc:
        return [f"Could not write {root.name}: {exc}"]
    return []
