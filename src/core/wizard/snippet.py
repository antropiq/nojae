"""The snippet, and the three checks that make it trustworthy.

Page 2 produces a prepared answer; page 3 must not present it as trustworthy on
its own word. This module is that second look, and its whole design is *not* to
be a second opinion:

* **the member is built, not echoed.** :func:`build_member` answers the ``member``
  group of what it is handed and nothing else — for MCP that is the catalogue
  entry, so an install line, a docs link, a signal and a description are the
  wizard's own material and cannot reach the JSON; for LSP it is the prepared
  answer. The output is always a **member** (``"id": { … }``), never a whole
  file: a missing declaration file changes a sentence, not the shape.
* **check 1 is the hub's own loader.** :func:`loader_verdict` hands the entry to
  ``mcphub.discovery.entry_from_declaration`` /
  ``lsphub.discovery.entry_from_declaration`` — the very functions each
  declaration file walk calls — so the words the user reads are the words the
  panel would have shown after a restart, and a member this module accepts is a
  member the loader accepts. There is no second validator here, by design: if the
  two ever disagreed the loader would win, so there is only one.
* **check 2 resolves a command, it never spawns one.** :func:`readiness` asks
  ``mcphub.process.resolve_command`` over ``mcphub.process.child_environment`` —
  the lookup and the environment the LSP hub's own start uses — so "not
  installed" is a fact about this machine rather than a trial run. Nothing here
  imports ``subprocess``, starts a connector or a language server, or installs
  anything: resolving a program's path is not starting it.
* **check 3 is a warning, never a stop.** :func:`duplicate_warning` reads the
  declaration file to say that the id — or a ``_``-prefixed note key of that name
  — is already a key of it, and the snippet is offered anyway.
* **the values live in one place.** :data:`SECRET_SENTINEL` and
  :data:`PATH_REFERENCE` are :mod:`wizard.prompts`' spellings, imported rather
  than restated; :func:`value_form` says *which* form the member shows and
  :func:`value_findings` what is wrong with it. ``${NAME}`` expansion stays the
  loader's job: nothing here expands a reference, blanks an unresolved one, or
  consults ``.env``.
* **the hub's own reach refusal, in its own words.** A ``local`` candidate the
  deployment refuses arrives as one of the loader's notes, verbatim — asked of
  the hub's predicate by the loader, never restated here.

What it may not do, stated because that is the whole design: it **writes no
declaration file** (it reads one, to warn and to name its path, and never touches
its mtime), starts no process, and re-checks nothing downstream — a pasted
sentinel surfaces exactly as a wrong value does.
"""

import json
import re
from pathlib import Path
from typing import Any, Dict, Iterator, List, Mapping, Optional, Tuple

from src.core import workspace
from src.core.mcphub import constants as mcp_constants
from src.core.mcphub.discovery import entry_from_declaration as mcp_entry
from src.core.mcphub.process import child_environment, resolve_command, searched_paths
from src.core.mcphub.validation import argv_from_command, str_map
from src.core.lsphub import constants as lsp_constants
from src.core.lsphub.discovery import denied_roots
from src.core.lsphub.discovery import entry_from_declaration as lsp_entry

from . import prompts

#: The readiness pair — the two answers check 2 may give. Spelled once, so the
#: route, the composable and the dialog cannot drift.
READY = "looks installed"
NOT_INSTALLED = "not installed"

#: Which of the two value forms a member is showing. ``none`` is the honest third
#: answer: an entry that needs no key shows neither.
VALUE_FORM_SENTINEL = "sentinel"
VALUE_FORM_REFERENCE = "environment-reference"
VALUE_FORM_NONE = "none"

#: What the page says when it is showing the sentinel: the loader does not expand
#: it, so the endpoint sees it as the key.
SENTINEL_WARNING = (
    "This entry carries " + prompts.SECRET_SENTINEL + " in the value slot: it "
    "will not authenticate until that slot is replaced with your key."
)

#: What the page says when it is showing the environment-reference form instead.
REFERENCE_NOTE = (
    "This entry carries a ${NAME} reference in the value slot: the declaration "
    "loader expands it when it reads the file."
)

#: A literal path where a reference belongs, and a literal value in a slot that
#: wants a key — the two things a snippet may never carry. Built by concatenation
#: rather than ``str.format``, because both sentences quote the settled spellings'
#: own braces: ``format`` would read them as fields.
LITERAL_PATH_FINDING = (
    "a literal absolute path inside this workspace. A path in a snippet is an "
    "environment reference — " + prompts.PATH_REFERENCE + ", optionally plus "
    "the sub-folder — so the entry survives the folder being moved or copied."
)
LITERAL_SECRET_FINDING = (
    "a value in a slot that holds a key. A snippet never carries a secret: "
    "carry " + prompts.SECRET_SENTINEL + " (or a "
    + prompts.SECRET_REFERENCE_FORM + " reference) in that slot instead."
)

#: The two duplicate sentences: an entry of that id already, and a ``_``-prefixed
#: note key of that name. Both are warnings — the snippet is still offered.
DUPLICATE_ENTRY_WARNING = (
    "{name} already declares an entry of that id: pasting this member would "
    "duplicate it, so rename one of the two."
)
DUPLICATE_NOTE_WARNING = (
    "{name} already carries a '_'-prefixed note key of that name: pasting this "
    "member would duplicate the note, so rename one of the two."
)

#: What the loader answered when it accepted the member. A refusal is reported in
#: the loader's own words, so this is only the line for the other outcome.
ACCEPTED_SENTENCE = "The declaration loader accepts this member."

#: A header/env key name that wants a credential rather than a plain value.
_SECRET_KEY = re.compile(
    r"(?:API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|TOKEN|SECRET|PASSWORD|PASSWD"
    r"|CREDENTIAL|AUTHORIZATION)",
    re.IGNORECASE,
)

#: ``${NAME}``, optionally followed by a sub-folder — the reference form the
#: loader expands, and the only shape a filled slot or a path may take. Asked
#: here to *recognise* one, never to expand it.
_REFERENCE = re.compile(r"\$\{[A-Za-z_][A-Za-z0-9_]*\}(?:[/\\].*)?")


# -- building the member -------------------------------------------------------


def build_member(source: Mapping[str, Any]) -> Dict[str, Any]:
    """The ``member`` group of ``source`` and nothing else — a deep copy.

    One rule for both families: an MCP catalogue entry and an LSP prepared
    answer both carry their JSON under ``member``, so the identity, requirements
    and relevance groups cannot leak into a snippet, and neither can an install
    line or a decision line. A source without a ``member`` object has no snippet
    at all, which is the caller's error rather than a repaired value.
    """
    member = source.get("member") if isinstance(source, Mapping) else None
    if not isinstance(member, dict) or not member:
        raise ValueError("the candidate carries no declaration member")
    return json.loads(json.dumps(member))


def render_member(declared_id: str, member: Mapping[str, Any]) -> str:
    """The snippet's text: one JSON **member**, never a whole file.

    ``"id": { … }`` is what the user pastes inside the declaration file's
    top-level object, so a file's outer braces are not part of the text — which
    is what makes a missing declaration file a sentence rather than a different
    shape.
    """
    text = json.dumps({declared_id: member}, indent=2, ensure_ascii=False)
    lines = text.splitlines()[1:-1]
    return "\n".join(line[2:] if line.startswith("  ") else line for line in lines)


# -- check 1: the hub's own loader ---------------------------------------------


def declaration_file(family: str) -> Path:
    """The absolute path of the declaration file this family's entry belongs in.

    Resolved through each hub's own ``*_settings_path()`` at call time, so the
    wizard names the file the hub would read — a pinned path, a switched
    workspace and the reserved folder's own name all move together. Never
    created: a file that is not there is reported, not fixed.
    """
    _require_family(family)
    path = (
        mcp_constants.mcp_settings_path()
        if family == "mcp"
        else lsp_constants.lsp_settings_path()
    )
    return Path(path).absolute()


def loader_verdict(
    family: str,
    declared_id: str,
    member: Mapping[str, Any],
    declaration_path: Optional[Path] = None,
) -> Dict[str, Any]:
    """What the app's own loader says about this member — its words, verbatim.

    The entry is handed to the same per-entry function each declaration file walk
    calls, so the verdict and the notes (an unresolved ``${NAME}``, a refused
    reach) are exactly what the panel would have shown after a restart. The
    declaration file's *name* is used in the sentences, the way the loader spells
    them, so a member refused here is refused in the same words.
    """
    _require_family(family)
    path = (
        Path(declaration_path)
        if declaration_path is not None
        else declaration_file(family)
    )
    if family == "mcp":
        entry, notes = mcp_entry(path.name, declared_id, dict(member))
    else:
        denied, fold = denied_roots()
        entry, notes = lsp_entry(
            path.name, declared_id, dict(member), denied=denied, fold=fold
        )
    accepted = entry is not None
    # A refusal is the loader's last note; an acceptance keeps every note it
    # earned (a reach refusal is one, and the user needs it *before* a restart).
    sentence = ACCEPTED_SENTENCE if accepted else (notes[-1] if notes else "")
    return {"accepted": accepted, "sentence": sentence, "notes": list(notes)}


# -- check 2: the command is resolved, never spawned ---------------------------


def readiness(
    member: Mapping[str, Any], project_root: Optional[Path] = None
) -> Dict[str, Any]:
    """Whether this member's program is on the path the hub would look it up on.

    ``remote`` members carry no command and answer ``None`` — there is nothing to
    install or to look up. A ``local`` member's ``argv[0]`` is resolved through
    ``mcphub.process.resolve_command`` over ``child_environment``, which is the
    child's own environment (the entry's ``env`` wins, so a declaration that sets
    ``PATH`` is judged on that ``PATH``). **Nothing is spawned to find out**, and
    a not-installed candidate is still offered.
    """
    command = argv_from_command(member.get("command"), member.get("args"))
    if command is None:
        return {"readiness": None, "program": None, "searched": None}
    env = str_map(member.get("env"))
    child = child_environment(
        project_root if project_root is not None else mcp_constants.PROJECT_ROOT,
        env or {},
    )
    program = resolve_command(command[0], child)
    if program is None:
        return {
            "readiness": NOT_INSTALLED,
            "program": None,
            "searched": searched_paths(command[0], child),
        }
    return {"readiness": READY, "program": program, "searched": None}


# -- check 3: a declared id is a warning, not a stop ---------------------------


def _declared_ids(declaration_path: Optional[Path]) -> Optional[Dict[str, Any]]:
    """The declaration file's decoded object, or ``None`` when there is none.

    Read, never written: no mtime touch, no backup, no created file. A file that
    is absent or unreadable answers ``None``, which is the same "there is nothing
    declared yet" a missing file means — the duplicate warning has nothing to say.
    """
    if declaration_path is None:
        return None
    try:
        data = json.loads(Path(declaration_path).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if isinstance(data, dict) else None


def duplicate_warning(
    declared_id: str, declaration_path: Optional[Path]
) -> Optional[str]:
    """The plain warning for an id the declaration file already carries, or ``None``.

    Both shapes count: an entry of that id (the pasted member would duplicate it)
    and a ``_``-prefixed note key of that name (a comment key there would make the
    pasted member a duplicate of the note). It is a **warning**: the snippet is
    offered anyway, because nothing changes until the user pastes it.
    """
    data = _declared_ids(declaration_path)
    if data is None:
        return None
    name = Path(declaration_path).name
    if declared_id in data:
        return f"'{declared_id}' " + DUPLICATE_ENTRY_WARNING.format(name=name)
    if f"_{declared_id}" in data:
        return f"'_{declared_id}' " + DUPLICATE_NOTE_WARNING.format(name=name)
    return None


# -- the values ----------------------------------------------------------------


def _leaves(
    value: Any, key: Optional[str] = None
) -> Iterator[Tuple[Optional[str], str]]:
    """Every string leaf of a member, with the member key it sits under."""
    if isinstance(value, str):
        yield key, value
    elif isinstance(value, dict):
        for name, item in value.items():
            yield from _leaves(item, str(name))
    elif isinstance(value, list):
        for item in value:
            yield from _leaves(item, key)


def _is_reference(value: str) -> bool:
    return bool(_REFERENCE.fullmatch(value.strip()))


def _is_inside(workspace: str, value: str) -> bool:
    """Is ``value`` a path this workspace spells absolutely?

    Asked of the *text*, on either platform's spelling, so no ``os.path.isabs``
    branch decides it: a snippet carrying ``/home/me/project`` or ``C:\\work`` is
    a literal of the machine it was written on either way, and the reference
    exists to replace exactly that.
    """
    if not workspace or not value:
        return False
    text = value.rstrip("/\\")
    root = workspace.rstrip("/\\")
    return text == root or text.startswith(root + "/") or text.startswith(root + "\\")


def value_findings(
    member: Mapping[str, Any], workspace_root: Optional[str] = None
) -> List[str]:
    """What is wrong with the member's values — a literal path, a literal secret.

    A **finding** is a refusal to offer the snippet. A path is judged against the
    workspace the wizard serves, so a program named absolutely
    (``/usr/bin/pyright-langserver``) is not mistaken for a workspace root that
    should have been a reference. A value in a slot whose key names a credential
    is a secret unless it is the sentinel or a ``${NAME}`` reference — an empty
    string is neither shown nor trusted, so it is a finding too.
    """
    root = workspace_root if workspace_root is not None else workspace.current_root()
    findings: List[str] = []
    for key, value in _leaves(member):
        if key is not None and _SECRET_KEY.search(key):
            # A slot that holds a key: the sentinel and a ``${NAME}`` reference
            # are the two forms it may carry, and an empty one says nothing.
            if value == prompts.SECRET_SENTINEL or _is_reference(value):
                continue
            findings.append(f"{key}: " + LITERAL_SECRET_FINDING)
            continue
        if not value.strip() or _is_reference(value):
            continue
        if _is_inside(root, value):
            findings.append(f"{key or 'the member'}: " + LITERAL_PATH_FINDING)
    return findings


def _slots(member: Mapping[str, Any]) -> List[str]:
    """The values filling a header/env key that names a credential."""
    return [
        value
        for key, value in _leaves(member)
        if key is not None and _SECRET_KEY.search(key) and value.strip()
    ]


def value_form(member: Mapping[str, Any]) -> str:
    """Which of the two secret forms this member shows, or ``none``.

    The sentinel is checked first and by exact equality, because it is the
    default and because it is **not** a reference: a page that confused the two
    would tell the user their key resolves when it does not. A slot filled with
    neither is the one case page 3 must not present as a form at all —
    :func:`value_findings` has already refused it, and calling it a reference
    here would print the wrong sentence beside the refusal.
    """
    slots = _slots(member)
    if prompts.SECRET_SENTINEL in slots:
        return VALUE_FORM_SENTINEL
    if any(_is_reference(value) for value in slots):
        return VALUE_FORM_REFERENCE
    return VALUE_FORM_NONE


def value_warning(form: str) -> Optional[str]:
    """The line that goes with the form the member shows."""
    if form == VALUE_FORM_SENTINEL:
        return SENTINEL_WARNING
    if form == VALUE_FORM_REFERENCE:
        return REFERENCE_NOTE
    return None


# -- the answer page 3 renders ------------------------------------------------


def assess(
    family: str,
    declared_id: str,
    member: Mapping[str, Any],
    *,
    declaration_path: Optional[Path] = None,
    install: Optional[Mapping[str, str]] = None,
    workspace_root: Optional[str] = None,
    project_root: Optional[Path] = None,
) -> Dict[str, Any]:
    """Everything page 3 shows about one member, and nothing that is a number.

    The three checks, the values and the file it belongs in, in one answer:

    * ``accepted``/``verdict``/``notes`` — the loader's own words (check 1);
    * ``readiness``/``program``/``searched`` — the resolution answer (check 2);
    * ``duplicate`` — the warning, plain and non-blocking (check 3);
    * ``valueForm``/``valueWarning``/``valueFindings`` — the value checks;
    * ``declarationPath``/``declarationExists`` — the absolute path it belongs in,
      and whether the user has to create that file;
    * ``snippet``/``member``/``id`` — what to copy, always a member.

    ``offered`` is the page's one verdict on *may this be presented as
    trustworthy*: the loader accepted it **and** its values carry no finding. A
    duplicate does not clear it — that is a warning — and a not-installed command
    does not either, because an entry can be pasted before its dependency exists.
    """
    _require_family(family)
    if not isinstance(declared_id, str) or not declared_id.strip():
        raise ValueError("the snippet needs a non-empty declaration id")
    built = build_member({"member": member})
    path = (
        Path(declaration_path).absolute()
        if declaration_path is not None
        else declaration_file(family)
    )
    verdict = loader_verdict(family, declared_id, built, path)
    resolved = readiness(built, project_root)
    found = value_findings(built, workspace_root)
    form = value_form(built)
    return {
        "family": family,
        "id": declared_id,
        "member": built,
        "snippet": render_member(declared_id, built),
        "accepted": verdict["accepted"],
        "verdict": verdict["sentence"],
        "notes": verdict["notes"],
        "readiness": resolved["readiness"],
        "program": resolved["program"],
        "searched": resolved["searched"],
        "install": dict(install or {}),
        "duplicate": duplicate_warning(declared_id, path),
        "valueForm": form,
        "valueWarning": value_warning(form),
        "valueFindings": found,
        "declarationPath": str(path),
        "declarationExists": path.is_file(),
        "offered": verdict["accepted"] and not found,
    }


def _require_family(family: str) -> None:
    """One family, spelled the way the panels spell it — never a third."""
    if family not in prompts.FAMILIES:
        raise ValueError(
            f"unknown wizard family {family!r}: expected one of "
            f"{', '.join(prompts.FAMILIES)}"
        )
