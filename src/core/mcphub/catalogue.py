"""The committed catalogue of well-known MCP connectors.

``mcp_connectors/catalog-mcp.json`` is the wizard's **only** source of a package
name: nothing under ``src`` knows one, so adding a connector is a data change
and a review, never a new module. It sits beside ``mcp-settings.default.json``,
where the app's committed connector data already lives, and it is *catalogue*,
never declaration — no hub reads this file, no process starts because of it, and
nothing in it lands in a workspace.

The read mirrors the two declaration loaders (:mod:`mcphub.discovery`,
:mod:`lsphub.discovery`) on purpose, because a user meets the same sentences:

* the path is looked up through :mod:`mcphub.constants` **at call time**, so a
  test redirects it by patching one attribute and nothing is cached at import;
* it never raises — an unreadable or invalid file answers ``([], [one
  sentence])``, the same shape a damaged declaration answers with;
* one shape-valid entry whose *member* group is unusable is skipped with a
  per-entry note while the rest still load.

An entry carries four groups, and the split is the point — only ``member``
becomes JSON in the user's file:

* **identity** — ``name``/``description``/``docs``: what the list shows;
* **member** — ``type``, ``url`` *or* ``command``, ``headers``/``env``: the JSON
  a snippet is built from;
* **requirements** — ``requires`` (per platform: package + install line; the
  key ``any`` holds the line where no platform differs, and a platform's own
  key beside it overrides that one) and ``inputs`` (the slots to fill):
  guidance, never pasted as-is;
* **relevance** — ``signals``: which projects it suits, for ordering only.

The id keys the top-level object, exactly as it does in a declaration file.

``member`` is checked with the hub's own shape primitives
(:func:`mcphub.validation.argv_from_command`, :func:`~mcphub.validation.str_map`)
and nothing is expanded here — ``${NAME}`` expansion belongs to the loader that
reads the declaration, so a member is handed on exactly as the file spells it.
``tests/test_mcp_catalogue.py`` proves the other half: every committed member is
accepted by the hub's own loader when it is written into a declaration file.
"""

import json
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

from . import constants
from .validation import argv_from_command, str_map


def load_catalogue(
    path: Optional[Path] = None,
) -> Tuple[List[Dict[str, Any]], List[str]]:
    """Read the committed catalogue into entry dicts, plus the reader's notes.

    Answers ``([], [sentence])`` for a file that cannot be read, that is absent
    or that is not a JSON object — the catalogue is committed with the install,
    so an absent one is a damaged install and pays for a sentence rather than
    reading as an empty list. One unusable entry is one note and that entry
    alone. **Never raises.**

    Entries keep the file's own order: the catalogue is a curated list, so the
    order a reviewer reads in the file is the order the panel offers.

    ``path`` is the test's seam; production reads
    :data:`mcphub.constants.MCP_CATALOGUE_PATH`, resolved *inside* this call so
    the redirect is one attribute patch.
    """
    source = Path(path) if path is not None else constants.MCP_CATALOGUE_PATH
    try:
        return _load_catalogue(source)
    except Exception as exc:  # noqa: BLE001 — a damaged catalogue is a named state
        return [], [f"{source.name} is not readable JSON: {exc}"]


def _load_catalogue(source: Path) -> Tuple[List[Dict[str, Any]], List[str]]:
    entries: List[Dict[str, Any]] = []
    notes: List[str] = []
    try:
        data = json.loads(source.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        return [], [f"{source.name} is not readable JSON: {exc}"]
    if not isinstance(data, dict):
        return [], [f"{source.name} must contain an object of entries keyed by id"]
    for entry_id in data:
        prefix = f"{source.name}: '{entry_id}'"
        entry = _entry(prefix, entry_id, data[entry_id], notes)
        if entry is not None:
            entries.append(entry)
    return entries, notes


def _entry(
    prefix: str, entry_id: Any, raw: Any, notes: List[str]
) -> Optional[Dict[str, Any]]:
    """One entry, or ``None`` when the groups a listing depends on are unusable.

    ``identity`` and ``member`` gate the entry: without a name there is nothing
    to show, and without a usable member there is no snippet to build.
    ``requirements`` and ``relevance`` are guidance, so a malformed one is a note
    and an empty group — the entry still loads.
    """
    if not isinstance(entry_id, str) or not entry_id:
        notes.append(f"{prefix}: the id must be a non-empty string — skipped")
        return None
    if not isinstance(raw, dict):
        notes.append(f"{prefix}: entry must be a JSON object — skipped")
        return None
    identity = _identity(raw.get("identity"))
    if isinstance(identity, str):
        notes.append(f"{prefix}: {identity} — skipped")
        return None
    member_reason = _member_reason(raw.get("member"))
    if member_reason is not None:
        notes.append(f"{prefix}: {member_reason} — skipped")
        return None
    requirements = _requirements(prefix, raw.get("requirements"), notes)
    relevance = _relevance(prefix, raw.get("relevance"), notes)
    return {
        "id": entry_id,
        "identity": identity,
        "member": raw["member"],
        "requirements": requirements,
        "relevance": relevance,
    }


def _identity(raw: Any) -> Any:
    """The identity group, or one sentence saying what it is missing."""
    if not isinstance(raw, dict):
        return "the identity group must be a JSON object"
    name = raw.get("name")
    if not isinstance(name, str) or not name.strip():
        return "the identity group needs a name"
    description = raw.get("description")
    if not isinstance(description, str) or not description.strip():
        return "the identity group needs a description"
    docs = raw.get("docs")
    if not _is_http(docs):
        return "the identity group needs an http(s) docs link"
    return {"name": name, "description": description, "docs": docs}


def _member_reason(raw: Any) -> Optional[str]:
    """Why this member group cannot be offered, or ``None`` when it can.

    The checks are the loader's own (``mcphub.discovery.load_externals``), in the
    same order: a ``local``/``remote`` type, then the command or the url that
    type requires, then the ``headers``/``env`` mapping. Nothing is expanded:
    a ``${NAME}`` stays a reference until the declaring file is read.
    """
    if not isinstance(raw, dict):
        return "the member group must be a JSON object"
    kind = raw.get("type")
    kind = kind.lower() if isinstance(kind, str) else ""
    if kind not in ("local", "remote"):
        return 'the member group needs a type of "local" or "remote"'
    if str_map(raw.get("headers")) is None or str_map(raw.get("env")) is None:
        return "the member group's headers/env must be objects of string values"
    if kind == "remote":
        if not _is_http(raw.get("url")):
            return "a remote member needs an http(s) url"
        return None
    if argv_from_command(raw.get("command"), raw.get("args")) is None:
        return "a local member needs a command"
    return None


def _is_http(value: Any) -> bool:
    """True for the one shape a ``url``/``docs`` value may take."""
    return isinstance(value, str) and value.lower().startswith(("http://", "https://"))


def _requires(raw: Any) -> Optional[Dict[str, Dict[str, str]]]:
    """The ``requires`` mapping: platform -> {package, install line}."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        return None
    coerced: Dict[str, Dict[str, str]] = {}
    for platform, item in raw.items():
        if not isinstance(platform, str) or not platform:
            return None
        if not isinstance(item, dict):
            return None
        package, install = item.get("package"), item.get("install")
        if not isinstance(package, str) or not package:
            return None
        if not isinstance(install, str) or not install:
            return None
        coerced[platform] = {"package": package, "install": install}
    return coerced


def _inputs(raw: Any) -> Optional[List[Dict[str, Any]]]:
    """The ``inputs`` list: the slots the user has to fill after the paste."""
    if raw is None:
        return []
    if not isinstance(raw, list):
        return None
    coerced: List[Dict[str, Any]] = []
    for item in raw:
        if not isinstance(item, dict):
            return None
        name, slot = item.get("name"), item.get("slot")
        if not isinstance(name, str) or not name:
            return None
        if not isinstance(slot, str) or not slot:
            return None
        coerced.append(
            {
                "name": name,
                "label": item["label"] if isinstance(item.get("label"), str) else name,
                "slot": slot,
                "required": item.get("required") is not False,
            }
        )
    return coerced


def _requirements(prefix: str, raw: Any, notes: List[str]) -> Dict[str, Any]:
    """The requirements group, degrading to an empty group with a note."""
    if raw is None:
        return {"requires": {}, "inputs": []}
    if not isinstance(raw, dict):
        notes.append(
            f"{prefix}: the requirements group must be a JSON object — ignored"
        )
        return {"requires": {}, "inputs": []}
    requires = _requires(raw.get("requires"))
    inputs = _inputs(raw.get("inputs"))
    if requires is None:
        notes.append(
            f"{prefix}: requires must map a platform to a package and its "
            "install line — ignored"
        )
    if inputs is None:
        notes.append(f"{prefix}: inputs must be a list of slots — ignored")
    return {
        "requires": {} if requires is None else requires,
        "inputs": [] if inputs is None else inputs,
    }


def _relevance(prefix: str, raw: Any, notes: List[str]) -> Dict[str, List[str]]:
    """The relevance group, degrading to no signals with a note."""
    if raw is None:
        return {"signals": []}
    if not isinstance(raw, dict) or not isinstance(raw.get("signals", []), list):
        notes.append(
            f"{prefix}: the relevance group must hold a signals list — ignored"
        )
        return {"signals": []}
    signals = raw.get("signals", [])
    if not all(isinstance(item, str) and item for item in signals):
        notes.append(
            f"{prefix}: the relevance group must hold a signals list — ignored"
        )
        return {"signals": []}
    return {"signals": [item for item in signals]}
