"""Agent modes: what the WorkBench agent is *for*, read from the settings store.

The install's settings store holds the personas the composer offers — each one a
system message plus two flags saying whether the MCP and the LSP hub reach the
model at all — together with the model that agent runs on and the cap its tool
loop is bounded by. This module is the **read model** over those rows: it answers
"which agents exist", "what does agent *X* say", and what the editor's form is
allowed to write. It talks to no model, no route and no browser, and it writes no
SQL — :mod:`src.core.appdb` owns the store.

Two guarantees are about behaviour rather than storage:

* **it never raises.** A row the store cannot render is reported as a finding and
  the dropdown still renders — chat over a damaged store must keep working, and
  the cost of a bad row is that agent, never the list.
* **the app-owned agent is last.** The reserved ids are rendered from code and
  sorted last whatever the table's insertion order says, so no row can reorder
  the dropdown out of the shape the app documents.

There is no server-side default agent, which shapes two answers:

* the payload carries **no ``default`` key** — a key that always answered
  "nothing" would be read as meaningful by the composer and by the lot;
* :func:`resolve_mode` narrows to "an id in, a row or nothing out". A turn with
  no ``agentMode`` is the 422 naming the field, so a missing id resolves to
  nothing exactly like an unknown one.

There is no modes file and no per-root cache either: the app is the store's only
writer, so the optimistic-concurrency layer a hand-edited file needed went with
it. The one thing this module still borrows from
:mod:`core.agent_modes_defaults` is the fallback: a reserved agent whose row is
missing is still rendered, from code, because no table and no hand-edit can
remove the agent the lot contract pins.
"""

import importlib
import re
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Tuple

from src.core import appdb

# -- the constants (module attributes, patchable) -------------------------------

#: Bounds on one agent's id and its display label. The id is the slug a chat
#: payload and every saved session file on disk carry, so its shape is a wire
#: contract rather than a style choice.
MAX_MODE_ID_CHARS = 32
MAX_MODE_LABEL_CHARS = 40

#: Persona size, per agent, in UTF-8 bytes. This is the cap that keeps a persona
#: short: the text is re-sent on **every** turn of the conversation, so past it a
#: longer prompt is not a better agent, only a slower and dearer one.
MAX_MODE_SYSTEM_MESSAGE_BYTES = 16 * 1024

#: The **soft** prose budget a persona is written to, in lines. It is display,
#: never a rule: a persona over it is still a valid row, the byte cap above being
#: the hard one. The modes editor's form shows it as a "remaining line cap" label,
#: and the prose test bounds the seeded personas by it — one home for both.
MAX_MODE_PERSONA_LINES = 16

#: The tool-loop cap's floor: the accepted range is 1 and up, with **no ceiling**,
#: so a large number in a live store is a value someone typed, not a limit the app
#: imposed. A negative cap would stop the loop before its first round.
MIN_TOOL_ITERATION = 1

#: Agents nojae owns: rendered from code and sorted last whatever the table says.
#: A row for one cannot be deleted, and only its ``model_id`` is the user's.
RESERVED_MODE_IDS: Tuple[str, ...] = ("todoBuilder",)

#: The shape of an agent id. It is the table's primary key, the value of
#: ``ChatIn.agentMode``, and the id the batch runner pins a task turn to — so it
#: is matched against this pattern per call, which keeps a patch of it meaningful.
MODE_ID_PATTERN = r"^[a-z][A-Za-z0-9_-]*$"

#: Where the built-in content lives (``agent_modes_defaults``). Imported **by
#: name, per call**, never at module level: that module's ``default_modes()``
#: builds :class:`AgentMode` objects through this module, so a static import in
#: either direction is a cycle. The name is also an attribute, so a test of the
#: machinery here can swap in a stand-in for the personas.
DEFAULTS_MODULE_NAME = "src.core.agent_modes_defaults"


# -- the two shapes -------------------------------------------------------------

KIND_ERROR = "error"  # this row was dropped; the rest of the list still renders
KIND_NOTE = "note"    # nothing was dropped; the store says something odd


@dataclass(frozen=True)
class ModeFinding:
    """One thing the read noticed about the store's agent rows.

    ``message`` names the agent it is about (or the store's path, for a store
    that could not be read at all), because a finding nobody can trace to a row
    is a wall rather than a message.
    """

    kind: str
    message: str


@dataclass(frozen=True)
class AgentMode:
    """One agent as resolved: what the model is told, and what it may reach."""

    id: str
    label: str
    system_message: str              # "" = fall back to the model's sys_prompt
    mcptools: bool
    lsptools: bool
    readonly: bool = False           # True only for the app-owned agents
    instructions: Tuple[str, ...] = ()  # generated blocks, already rendered


# -- the content this module does not own --------------------------------------

def _defaults() -> Any:
    """``agent_modes_defaults``, resolved per call (see the constant).

    This is the one thing in the module allowed to raise: a missing content
    module is a broken installation, not a damaged row, and no fallback of mine
    could be any less wrong than saying so. The contract of :func:`resolve_modes`
    — never raises — is about *the store*.
    """
    return importlib.import_module(DEFAULTS_MODULE_NAME)


def _reserved_modes() -> List[AgentMode]:
    """The app-owned agents, rendered from code — appended last."""
    return [_defaults().todo_builder_mode()]


# -- the validator --------------------------------------------------------------

def _kind_of(value: Any) -> str:
    """What to call a stored value in a message — the JSON word, not the Python one."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "a boolean"
    if isinstance(value, (int, float)):
        return "a number"
    if isinstance(value, str):
        return "a string"
    return type(value).__name__


def _mode_id_problem(mode_id: Any) -> Optional[str]:
    """Why ``mode_id`` is not usable as an agent id, or ``None`` when it is.

    Matched against :data:`MODE_ID_PATTERN` per call rather than through a regex
    compiled at import, so patching the pattern patches the rule.
    """
    if not isinstance(mode_id, str) or not mode_id:
        return "id must be a non-empty string"
    if len(mode_id) > MAX_MODE_ID_CHARS:
        return f"id must be at most {MAX_MODE_ID_CHARS} characters"
    if re.match(MODE_ID_PATTERN, mode_id) is None:
        return (
            f"id must match {MODE_ID_PATTERN} — a lowercase letter, then "
            "letters, digits, '_' or '-'"
        )
    return None


def _label_problem(label: Any) -> Optional[str]:
    """Why ``label`` cannot be an agent's label, or ``None`` when it can."""
    if not isinstance(label, str) or not label.strip():
        return "label must not be empty"
    if len(label.strip()) > MAX_MODE_LABEL_CHARS:
        return f"label must be at most {MAX_MODE_LABEL_CHARS} characters"
    return None


def _persona_problem(text: Any) -> Optional[str]:
    """Why ``system_message`` cannot be stored, or ``None`` when it can.

    An **empty** persona is a value, not a problem: it means "use the model's own
    prompt". Only the byte cap refuses anything, and it is the same cap the
    editor's form counts against.
    """
    if not isinstance(text, str):
        return f"system message must be a string, not {_kind_of(text)}"
    size = len(text.encode("utf-8"))
    if size > MAX_MODE_SYSTEM_MESSAGE_BYTES:
        return (
            f"system message is {size} bytes, over the "
            f"{MAX_MODE_SYSTEM_MESSAGE_BYTES}-byte cap — this text is re-sent on "
            "every turn of the conversation"
        )
    return None


def _tool_iteration_problem(value: Any) -> Optional[str]:
    """Why ``max_tool_iteration`` cannot be stored, or ``None`` when it can.

    A **floor of 1 and no ceiling**: the schema's ``INTEGER NOT NULL`` says nothing
    about the range, and a negative cap would stop the loop before its first round
    — a turn that can never call a tool is not a setting anyone means.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        return f"max tool iterations must be an integer, not {_kind_of(value)}"
    if value < MIN_TOOL_ITERATION:
        return f"max tool iterations must be at least {MIN_TOOL_ITERATION}"
    return None


def caps() -> Dict[str, Any]:
    """The numbers and shapes the editor's form enforces, built per call.

    Read per call rather than spelled as a literal, for the same reason the caps
    are module attributes at all: several tests patch one and expect the verdict
    to move with it — here the payload has to move with it too, or the form would
    enforce numbers this app no longer uses. No cap is spelled in the client.
    """
    return {
        "maxIdChars": MAX_MODE_ID_CHARS,
        "idPattern": MODE_ID_PATTERN,
        "maxLabelChars": MAX_MODE_LABEL_CHARS,
        "maxPersonaBytes": MAX_MODE_SYSTEM_MESSAGE_BYTES,
        "maxPersonaLines": MAX_MODE_PERSONA_LINES,
        "minToolIteration": MIN_TOOL_ITERATION,
    }


# -- the read model over the ``agents`` table -----------------------------------
#
# The store's own read (``appdb.resolve_agents``) answers rows in the browser's
# vocabulary, with its own findings; this half turns a row into the
# :class:`AgentMode` the prompt assembly and the tool loop consume and merges the
# reserved ids from code. One module owns the SQL, this one owns the vocabulary.

def _mode_of_row(row: Dict[str, Any]) -> AgentMode:
    """One store row as the mode a chat turn runs as."""
    return AgentMode(
        id=row["id"],
        label=row["label"],
        system_message=row["systemMessage"],
        mcptools=row["mcpEnable"],
        lsptools=row["lspEnable"],
        readonly=row["readonly"],
    )


def _reserved_mode_for(agent_id: str) -> Optional[AgentMode]:
    """The code definition of a reserved id, or ``None`` for an ordinary one."""
    if agent_id not in RESERVED_MODE_IDS:
        return None
    for mode in _reserved_modes():
        if mode.id == agent_id:
            return mode
    return None


def _findings_of(resolved: Dict[str, Any]) -> List[ModeFinding]:
    """The store's findings, in this module's shape."""
    return [
        ModeFinding(str(item.get("kind") or KIND_ERROR), str(item.get("message") or ""))
        for item in resolved.get("findings") or []
    ]


def resolve_modes() -> Dict[str, Any]:
    """Every agent usable now, in dropdown order, plus what the read noticed.

    ``{"modes": [AgentMode…], "findings": [ModeFinding…], "caps": {...}}`` — and
    deliberately **no** ``default`` key: there is no server-side default agent to
    report.

    **It never raises.** A row the store cannot render is a finding and the rest
    of the list still renders — the dropdown is the thing that has to stay
    usable. An unopenable store answers the same way: the app-owned agents stay
    (they are code, not rows), so the composer always has something to show, and
    the finding names the store's path.

    Order is the table's insertion order, with the app-owned agents moved last
    whatever the table says. A reserved agent's *row* is read for its model
    association only; its persona, label and hub flags are the code definition's,
    so a hand-damaged row cannot change what the lot contract pins.
    """
    resolved = appdb.resolve_agents()
    modes: List[AgentMode] = []
    seen: List[str] = []
    for row in resolved.get("agents") or []:
        agent_id = row["id"]
        seen.append(agent_id)
        modes.append(_reserved_mode_for(agent_id) or _mode_of_row(row))
    # The fallback: a reserved agent whose row is gone is still offered, because
    # code — not a row — is where that agent is defined.
    for mode in _reserved_modes():
        if mode.id not in seen:
            modes.append(mode)
    reserved = set(RESERVED_MODE_IDS)
    modes.sort(key=lambda mode: mode.id in reserved)
    return {
        "modes": modes,
        "findings": _findings_of(resolved),
        "caps": caps(),
    }


def resolve_mode(
    mode_id: Optional[str],
) -> Tuple[Optional[AgentMode], List[ModeFinding]]:
    """One agent by id: an id in, a mode or nothing out.

    **A missing id resolves to nothing**: a turn with no ``agentMode`` is the 422
    naming the field, not a turn that runs as some agent the client never chose.

    The caller decides what an unknown id costs: the chat route answers **422**
    naming it, and lists what *is* available from :func:`resolve_modes`.
    ``None`` rather than an exception because the caller is the SSE path, where an
    exception has already lost the client's stream.

    The findings ride along, so a caller that reports the agent it used can say in
    the same breath that the store has problems.
    """
    resolved = resolve_modes()
    findings: List[ModeFinding] = resolved["findings"]
    wanted = (mode_id or "").strip()
    if not wanted:
        return (None, findings)
    for mode in resolved["modes"]:
        if mode.id == wanted:
            return (mode, findings)
    return (None, findings)


# -- self-check ----------------------------------------------------------------

def _self_check() -> None:
    """Fail at import on what the rules above quietly assume.

    A cap typed as ``MAX_MODE_ID_CHARS = "32"`` would otherwise surface as a
    ``TypeError`` inside a reader whose contract is to never raise, and a reserved
    id that does not match the pattern would mean a name reaching the declared
    path by accident.
    """
    for name in (
        "MAX_MODE_ID_CHARS",
        "MAX_MODE_LABEL_CHARS",
        "MAX_MODE_SYSTEM_MESSAGE_BYTES",
        "MAX_MODE_PERSONA_LINES",
        "MIN_TOOL_ITERATION",
    ):
        value = globals()[name]
        if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
            raise ValueError(f"agent_modes.{name} must be a positive int, got {value!r}")
    for name in ("MODE_ID_PATTERN", "DEFAULTS_MODULE_NAME"):
        if not isinstance(globals()[name], str) or not globals()[name]:
            raise ValueError(f"agent_modes.{name} must be a non-empty string")
    pattern = re.compile(MODE_ID_PATTERN)
    if not isinstance(RESERVED_MODE_IDS, tuple) or not all(
        isinstance(item, str) and pattern.match(item) for item in RESERVED_MODE_IDS
    ):
        raise ValueError(
            "agent_modes.RESERVED_MODE_IDS must be a tuple of ids matching "
            f"{MODE_ID_PATTERN}, got {RESERVED_MODE_IDS!r}"
        )


_self_check()
