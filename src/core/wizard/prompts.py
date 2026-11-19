"""The wizard's two questions, and the answers it accepts back (§5, §11).

The prompts and the *shape* of their answers live in this one module, side by
side, because a prompt and the parse of its answer are one decision: widen a
field here and the parser has to follow it in the same edit. Nothing else in the
app knows what the wizard asks a model, and no second place may start asking it.

Two steps, one per question:

* **propose** (:func:`propose_messages`, :func:`parse_proposals`) is the LSP
  flow's first step. There is no catalogue of language servers, by decision, so
  this question is the only place a language-server candidate can come from for
  that family. It is handed the scan's derived facts (task 02) and the
  declaration file's path, and it answers an **ordered** list of servers — the
  ordering rule the prompt states and the parser preserves being that what this
  folder *clearly lacks* leads and a language the project *already serves* does
  not.
* **prepare** (:func:`prepare_messages`, :func:`parse_prepared`) is the second
  step of both families. It is handed the chosen candidate (a catalogue
  ``member`` for MCP, a proposal for LSP) plus the same facts, and it answers the
  complete JSON member, the install line(s) per platform where they differ,
  whether anything has to be installed, and one line per platform- or
  project-specific decision it had to make.

Both answers are **one JSON object of a stated shape** (:data:`PROPOSAL_FIELDS`,
:data:`PREPARED_FIELDS`). :func:`decode_answer` tolerates a text block around
that object — a model wrapping its answer in prose is ordinary — and tolerates
nothing else: an answer that is not a JSON object raises
:class:`AnswerShapeError`, which the step reports as its own named failure rather
than reading as an empty list.

Two spellings are settled here and nowhere else, because the snippet is built
from this module's own words (§8): :data:`PATH_REFERENCE` is how a path is
written (an environment reference, never a literal absolute path) and
:data:`SECRET_SENTINEL` is the **one** canonical spelling of "fill this in with
your key". Task 04's snippet check imports both names instead of spelling them a
second time.

Hermetic by construction: this module builds text and parses text. It speaks to
no endpoint, reads no file, imports no hub and knows no package name — every fact
it works from is an argument.
"""

import json
import re
from typing import Any, Dict, List, Sequence, Tuple

# -- the settled spellings -----------------------------------------------------

#: How a path inside a snippet is written (§8): an environment reference, so the
#: entry survives the folder being moved or the file being copied to another
#: checkout. ``${NOJAE_PATH_LOCATION}`` is the workspace being served; a member
#: may append a sub-folder to it.
PATH_REFERENCE = "${NOJAE_PATH_LOCATION}"

#: The **one** canonical spelling of "the user's key goes here" (§8). It is not a
#: ``${NAME}`` reference and the loader does not expand it — an unreplaced one is
#: sent upstream and fails at authentication — which is why there is exactly one
#: spelling and why the page that shows it also says it must be replaced.
SECRET_SENTINEL = "__put_your_api_key_here__"

#: The alternative form a key slot may take, for a user who wants the value
#: outside the file: the entry carries ``${NAME}`` and the loader expands it.
SECRET_REFERENCE_FORM = '"${NAME}"'

#: The families the prepare step serves — the two panels' own names. The family
#: comes from the button that opened the dialog and is never a question.
FAMILIES: Tuple[str, ...] = ("mcp", "lsp")

#: The five facts one proposal must carry. An item missing any of them is
#: **dropped with a note** by :func:`parse_proposals`, never guessed into shape.
PROPOSAL_FIELDS: Tuple[str, ...] = (
    "id",
    "command",
    "extensions",
    "workspaceRoot",
    "evidence",
)

#: The facts one prepared answer may carry. Only the first two are required: an
#: answer that installs nothing and decided nothing is a real answer, and saying
#: so by omission is honest.
PREPARED_FIELDS: Tuple[str, ...] = (
    "id",
    "member",
    "install",
    "requiresInstall",
    "decisions",
)

#: ``${NAME}``, optionally followed by a sub-folder — the only shape a path may
#: take inside a proposal (§8). A *literal* path is wrong at this step already,
#: so a proposal carrying one is dropped rather than handed on. Either separator
#: is accepted for the sub-folder: what the check refuses is a path this machine
#: spells absolutely, not the way a platform joins two names.
_ENV_REFERENCE = re.compile(r"^\$\{[A-Za-z_][A-Za-z0-9_]*\}(?:[/\\].*)?$")


class AnswerShapeError(ValueError):
    """The model's answer is not the shape the prompt asked for.

    One failure, named, rather than a half-read answer: the caller turns this
    into the wizard's "the answer could not be read" sentence, which is a
    different state from "nothing fits" and from "the endpoint refused".
    """


# -- the two prompts -----------------------------------------------------------

PROPOSE_PROMPT = (
    "You choose language servers for one project folder. You are given facts "
    "derived by a read-only scan of that folder: how many files it holds of each "
    "extension, which manifests it carries and which dependencies they declare, "
    "which language servers are already declared, which sub-folder looks like the "
    "project's front end, and whether the scan stopped at its own file cap. There "
    "is no catalogue of language servers, so your answer is the only source of a "
    "candidate: propose only servers you believe exist and run on this machine.\n"
    "\n"
    "Order the list by what this folder clearly lacks. What the folder clearly "
    "lacks leads: many .py files, a pyproject.toml, and no Python language server "
    "declared is a Python server first. A language the project already serves "
    "does not lead: when an already-declared server covers an extension, that "
    "server is enough and its language belongs at the bottom of the list or "
    "nowhere. Never pad the list with a language the scan does not show.\n"
    "\n"
    "Answer with one JSON object and nothing else:\n"
    "\n"
    '{"servers": [\n'
    '  {"id": "...",\n'
    '   "command": ["program", "argument", "..."],\n'
    '   "extensions": [".ext", "..."],\n'
    '   "workspaceRoot": "' + PATH_REFERENCE + '",\n'
    '   "evidence": "one line naming what you saw"}\n'
    "]}\n"
    "\n"
    '- "servers" is the ordered list, best first. An empty list means this '
    "folder needs no language server of its own.\n"
    '- "command" is the argv you believe runs on this machine. It is checked '
    "against this machine before it is offered, so name the program as it is "
    "installed and never pad a package with a version you are not sure of. Never "
    "invent a package name, a version pin or a documentation URL.\n"
    '- "extensions" are the extensions this server should serve here.\n'
    '- "workspaceRoot" is an environment reference: ' + PATH_REFERENCE + ", or "
    "that plus the sub-folder the server should treat as its root. Never a "
    "literal absolute path.\n"
    '- "evidence" names the files and manifests that justify the choice, in the '
    "scan's own terms.\n"
)

PREPARE_PROMPT = (
    "You prepare one entry of this app's declaration file. You are handed the "
    "chosen candidate and the facts a read-only scan derived from this project. "
    "Nothing you answer is written anywhere: the user reads it, copies it into "
    "the declaration file and restarts the app, so every value has to be right as "
    "it stands.\n"
    "\n"
    "Answer with one JSON object and nothing else:\n"
    "\n"
    '{"id": "...",\n'
    ' "member": {},\n'
    ' "install": {"any": "..."},\n'
    ' "requiresInstall": false,\n'
    ' "decisions": ["one line per choice"]}\n'
    "\n"
    '- "id" is the key the entry carries in the declaration file.\n'
    '- "member" is the complete JSON member: the object that goes under that '
    "key, and nothing else. Install lines, documentation links and your "
    'reasoning stay out of it.\n'
    '- Every path inside the member is an environment reference: '
    + PATH_REFERENCE + ", or that plus a sub-folder. A literal absolute path from "
    "any machine, this one included, is wrong.\n"
    "- A value the entry needs a secret for carries exactly " + SECRET_SENTINEL
    + " in the value slot: never a key you have seen, never an empty string and "
    "never a different spelling. Where the candidate names a "
    + SECRET_REFERENCE_FORM + " reference for that slot instead, keep the "
    "reference: it is the alternative form the user may choose.\n"
    '- "install" holds the line the user runs themselves — per platform where '
    'the line differs, under the keys "any", "windows" or "posix" — or an empty '
    "object when nothing has to be installed. Take it from the candidate where "
    "the candidate carries one.\n"
    '- "requiresInstall" says whether anything has to be installed before the '
    "entry can start.\n"
    '- "decisions" holds one line per platform- or project-specific decision '
    "that shaped the member.\n"
    "\n"
    "Never invent a version pin, a registry name or a documentation URL. For a "
    "curated candidate the command line and the install line are the candidate's "
    "own; a language server's command line is checked against this machine before "
    "the entry is offered, so do not pad a package with a version you are not "
    "sure of.\n"
)

#: What prepare is told about the family it is serving. The difference is *whose*
#: the command line and the install line are, which is the one thing the two
#: flows do not share (§9: MCP offers a curated list, LSP a reasoned one).
PREPARE_FAMILY_LINES: Dict[str, str] = {
    "mcp": (
        "The candidate is one entry of the committed connector catalogue: which "
        "connector this is, its command line and its install line are the "
        "catalogue's, so hand its member back changed only where the rules above "
        "require it."
    ),
    "lsp": (
        "The candidate is a language server proposed for this project: its "
        "command line is what the proposal believes runs on this machine, and it "
        "is checked against this machine before the entry is offered."
    ),
}


# -- building the two questions ------------------------------------------------


def _json_block(value: Any) -> str:
    """One value as a JSON block the model can read, whatever it holds."""
    return json.dumps(value, indent=2, ensure_ascii=False, default=str)


def _user_message(lines: Sequence[str]) -> Dict[str, str]:
    return {"role": "user", "content": "\n\n".join(lines)}


def propose_messages(
    facts: Dict[str, Any], declaration_path: str
) -> List[Dict[str, str]]:
    """The propose step's messages: the module's prompt plus the scan's facts.

    ``facts`` is :func:`src.core.editorfs.projectfacts.project_facts`'s own
    payload, handed over unread — this module derives nothing from it and quotes
    no file: it renders the plain values a scan already computed.
    """
    return [
        {"role": "system", "content": PROPOSE_PROMPT},
        _user_message(
            [
                "The declaration file for language servers in this workspace: "
                f"{declaration_path}",
                "The scan's facts, as JSON:\n" + _json_block(facts),
            ]
        ),
    ]


def prepare_messages(
    family: str,
    candidate: Dict[str, Any],
    facts: Dict[str, Any],
    declaration_path: str,
) -> List[Dict[str, str]]:
    """The prepare step's messages for one family's chosen candidate."""
    if family not in PREPARE_FAMILY_LINES:
        raise ValueError(
            f"unknown wizard family {family!r}: expected one of "
            f"{', '.join(FAMILIES)}"
        )
    return [
        {"role": "system", "content": PREPARE_PROMPT},
        _user_message(
            [
                PREPARE_FAMILY_LINES[family],
                f"The declaration file this entry belongs in: {declaration_path}",
                "The chosen candidate, as JSON:\n" + _json_block(candidate),
                "The scan's facts, as JSON:\n" + _json_block(facts),
            ]
        ),
    ]


# -- reading the two answers ---------------------------------------------------


def decode_answer(text: str) -> Dict[str, Any]:
    """The one JSON object an answer carries.

    A text block around it is tolerated — a model that writes "Here is the
    entry:" before its object has still answered — and anything that is not a
    JSON object raises :class:`AnswerShapeError`. The whole text is tried first,
    so an answer that is already the object is never re-sliced.
    """
    body = (text or "").strip()
    candidates: List[str] = [body]
    start, end = body.find("{"), body.rfind("}")
    if 0 <= start < end:
        candidates.append(body[start : end + 1])
    for candidate in candidates:
        try:
            payload = json.loads(candidate)
        except ValueError:
            continue
        if isinstance(payload, dict):
            return payload
    raise AnswerShapeError("the answer is not a JSON object")


def _proposal_refusal(item: Any) -> Any:
    """``None`` for a usable proposal, else the reason it cannot be offered."""
    if not isinstance(item, dict):
        return "it is not a JSON object"
    proposal_id = item.get("id")
    if not isinstance(proposal_id, str) or not proposal_id.strip():
        return "it carries no id"
    command = item.get("command")
    if (
        not isinstance(command, list)
        or not command
        or not all(isinstance(token, str) and token.strip() for token in command)
    ):
        return "its command is not an argv list"
    extensions = item.get("extensions")
    if not isinstance(extensions, list) or not all(
        isinstance(extension, str) and extension.startswith(".")
        for extension in extensions
    ):
        return "its extensions are not a list of '.ext' names"
    root = item.get("workspaceRoot")
    if not isinstance(root, str) or not _ENV_REFERENCE.match(root.strip()):
        return "its workspaceRoot is not an environment reference"
    evidence = item.get("evidence")
    if not isinstance(evidence, str) or not evidence.strip():
        return "it carries no evidence line"
    return None


def parse_proposals(text: str) -> Tuple[List[Dict[str, Any]], List[str]]:
    """The proposals an answer holds, **in the model's own order**, plus notes.

    An item missing any of :data:`PROPOSAL_FIELDS` — or carrying one in a shape
    that cannot be offered, a literal absolute ``workspaceRoot`` included — is
    **dropped with a note**: nothing is repaired into shape, because a member
    built from a guessed value is the broken config this feature exists to
    prevent. An empty list is a real answer, not a parse failure.
    """
    payload = decode_answer(text)
    if "servers" not in payload:
        raise AnswerShapeError('the answer carries no "servers" list')
    raw = payload["servers"]
    if not isinstance(raw, list):
        raise AnswerShapeError('the answer\'s "servers" is not a list')
    proposals: List[Dict[str, Any]] = []
    notes: List[str] = []
    for index, item in enumerate(raw, start=1):
        reason = _proposal_refusal(item)
        if reason is not None:
            notes.append(f"proposal {index} dropped: {reason}")
            continue
        proposals.append(
            {
                "id": item["id"].strip(),
                "command": [token.strip() for token in item["command"]],
                "extensions": [
                    extension.strip() for extension in item["extensions"]
                ],
                "workspaceRoot": item["workspaceRoot"].strip(),
                "evidence": item["evidence"].strip(),
            }
        )
    return proposals, notes


def _install_lines(raw: Any) -> Any:
    """The ``install`` mapping, or a sentence saying why it cannot be read."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        return "the answer's install lines are not a JSON object"
    lines: Dict[str, str] = {}
    for platform, line in raw.items():
        if not isinstance(platform, str) or not platform:
            return "the answer's install lines are not keyed by platform"
        if not isinstance(line, str) or not line.strip():
            return "the answer's install lines are not non-empty strings"
        lines[platform] = line.strip()
    return lines


def _decision_lines(raw: Any) -> Any:
    """The ``decisions`` list, or a sentence saying why it cannot be read."""
    if raw is None:
        return []
    if not isinstance(raw, list) or not all(
        isinstance(line, str) and line.strip() for line in raw
    ):
        return "the answer's decisions are not a list of lines"
    return [line.strip() for line in raw]


def parse_prepared(text: str) -> Tuple[Dict[str, Any], List[str]]:
    """The one prepared entry an answer holds, plus notes.

    ``id`` and a non-empty ``member`` are required: without either there is no
    snippet to show, which is a failure of the answer rather than an empty list.
    ``install``, ``requiresInstall`` and ``decisions`` may be omitted — an entry
    that installs nothing and decided nothing is a real answer — but a malformed
    one raises, because it is the shape that carries the user's install line.
    """
    payload = decode_answer(text)
    prepared_id = payload.get("id")
    if not isinstance(prepared_id, str) or not prepared_id.strip():
        raise AnswerShapeError("the answer carries no id")
    member = payload.get("member")
    if not isinstance(member, dict) or not member:
        raise AnswerShapeError("the answer carries no declaration member")
    install = _install_lines(payload.get("install"))
    if isinstance(install, str):
        raise AnswerShapeError(install)
    decisions = _decision_lines(payload.get("decisions"))
    if isinstance(decisions, str):
        raise AnswerShapeError(decisions)
    requires_install = payload.get("requiresInstall")
    if requires_install is None:
        requires_install = bool(install)
    elif not isinstance(requires_install, bool):
        raise AnswerShapeError("the answer's requiresInstall is not true or false")
    return (
        {
            "id": prepared_id.strip(),
            "member": member,
            "install": install,
            "requiresInstall": requires_install,
            "decisions": decisions,
        },
        [],
    )
