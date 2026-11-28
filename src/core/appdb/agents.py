"""``agents``: the personas' table, read and written.

The composer's dropdown and the Agents dialog both land here. The read **never
raises**: a row it cannot render is dropped as a unit and reported, and the
app-owned agent sorts last. The writes carry their own refusals — a ``readonly``
row answers every edit but its model with one sentence, and no built-in can be
deleted. Everything the domain shares with the rest of the package — the read
and write seams, the row builders, the pre-delete copy, the seeded cap — is read
off the façade at call time.
"""

import importlib
from typing import Any, Dict, List, Mapping, Optional, Tuple

import src.core.appdb as appdb

from .errors import AppStoreError

# -- the agents read model -------------------------------------------------------
#
# What ``agent_modes.resolve_modes()`` / ``resolve_mode()`` are, over the
# ``agents`` table. The guarantees that are about behaviour rather than storage
# are kept: the read **never raises** (a damaged row is reported, the dropdown
# still renders) and the app-owned agent stays **last**. There is no ``default``
# key in the answer at all, and :func:`resolve_agent` is "an id in, a row or
# nothing out".

#: Where the app-owned agent ids come from. Resolved **by name, per call**: that
#: module reads these rows, so a static import in either direction is a cycle.
AGENT_MODES_MODULE_NAME = "src.core.agent_modes"

#: The ids the read model puts last, whatever the table's insertion order says —
#: the fallback for the case :func:`_reserved_agent_ids` cannot answer. Same
#: tuple the seeder writes its rows from, named here rather than re-typed.
RESERVED_AGENT_IDS_FALLBACK: Tuple[str, ...] = ("todoBuilder",)


def _reserved_agent_ids() -> Tuple[str, ...]:
    """The ids nojaé owns, which the read model puts last whatever the table says.

    A module that cannot be imported is a broken installation rather than a
    damaged row, so the answer is the one every failure here gives: say nothing
    extra, render what there is — the fallback tuple keeps the app-owned agent
    last.
    """
    try:
        module = importlib.import_module(AGENT_MODES_MODULE_NAME)
    except Exception:  # noqa: BLE001 — a missing module is not a row to report
        return RESERVED_AGENT_IDS_FALLBACK
    declared = getattr(module, "RESERVED_MODE_IDS", None)
    return tuple(declared) if declared else RESERVED_AGENT_IDS_FALLBACK


#: The agent columns whose integer declaration is a **preference**, not a guard:
#: SQLite's type affinity lets a hand-edited file hold the text ``"lots"`` in
#: them, so the reader checks them instead of trusting the schema.
_AGENT_INTEGER_COLUMNS: Tuple[str, ...] = (
    "max_tool_iteration",
    "mcp_enable",
    "lsp_enable",
    "readonly",
)


def _agent_problem(values: Mapping[str, Any]) -> Optional[str]:
    """Why one agent row cannot be rendered, or ``None`` when it can.

    Takes the **raw** column values, before :func:`_record` turns the flags into
    booleans: a damaged value has to be seen as what it is, or the check would
    be reading its own coercion back.

    ``system_message`` is checked for its type only — an empty persona means "use
    the model's own prompt", so a blank string there is a choice, not damage.
    """
    for column in ("id", "label"):
        value = values[column]
        if not isinstance(value, str) or not value.strip():
            return f"holds {column} as {appdb._kind_of(value)}, expected a non-empty string"
    if not isinstance(values["system_message"], str):
        return (
            "holds system_message as "
            f"{appdb._kind_of(values['system_message'])}, expected a string"
        )
    for column in _AGENT_INTEGER_COLUMNS:
        value = values[column]
        if isinstance(value, bool) or not isinstance(value, int):
            return f"holds {column} as {appdb._kind_of(value)}, expected an integer"
    model_id = values["model_id"]
    if model_id is not None and (
        isinstance(model_id, bool) or not isinstance(model_id, int)
    ):
        return f"holds model_id as {appdb._kind_of(model_id)}, expected an integer or null"
    return None


def resolve_agents() -> Dict[str, Any]:
    """Every agent, in dropdown order, plus what the read noticed.

    ``{"agents": [{id, label, maxToolIteration, mcpEnable, lspEnable,
    systemMessage, readonly, modelId, modelName}], "findings": [{kind,
    message}]}`` — and deliberately **no** ``default`` key: there is no
    server-side default agent to report, and a key that always answered
    "nothing" would be read as meaningful by the composer and by the lot.

    ``modelName`` is the resolved model's name, or ``None``. With ``modelId`` it
    is the whole answer to "can this agent run at all", so the composer's warning
    reads a field instead of re-deriving the rule from two tables. A ``modelId``
    that names no row is reported as a finding and answers ``modelName: None`` —
    the agent is unrunnable, the same named state a model whose server row is
    missing gets.

    **It never raises.** A row the reader cannot render is dropped as a unit and
    reported — the dropdown is the thing that has to stay usable, and a persona
    with a damaged cap is still a persona someone can fix from the dialog. An
    unopenable store answers the same way: no agents, and the sentence naming
    the path in the findings.

    Order is the table's insertion order (``rowid``) — the order the seeder wrote
    and the dialog creates in — with the app-owned agent moved last whatever the
    table says. That is the modes read's rule, unchanged by the move.
    """
    findings: List[Dict[str, str]] = []
    try:
        rows = [
            dict(zip(appdb._AGENT_COLUMNS, found))
            for found in appdb._read(
                appdb._select("agents", appdb._AGENT_COLUMNS, order="rowid")
            )
        ]
        models = {
            model["id"]: model
            for model in (
                appdb._record(appdb._MODEL_COLUMNS, found, appdb._MODEL_JSON)
                for found in appdb._read(
                    appdb._select("models", appdb._MODEL_COLUMNS, order="id")
                )
            )
        }
    except AppStoreError as exc:
        return {
            "agents": [],
            "findings": [appdb._finding(appdb.FINDING_ERROR, str(exc))],
        }

    agents: List[Dict[str, Any]] = []
    for position, raw in enumerate(rows, start=1):
        problem = _agent_problem(raw)
        if problem is not None:
            # The row is named by its id when it has one, and by its position
            # when even that is damaged: a finding nobody can trace to a row is
            # a wall rather than a message.
            who = raw["id"] if isinstance(raw["id"], str) and raw["id"] else f"row {position}"
            findings.append(
                appdb._finding(
                    appdb.FINDING_ERROR, f"The agent {who!r} {problem}; it is not shown."
                )
            )
            continue
        agent = appdb._record(
            appdb._AGENT_COLUMNS,
            tuple(raw[column] for column in appdb._AGENT_COLUMNS),
            appdb._AGENT_JSON,
        )
        model_id = agent["modelId"]
        model = models.get(model_id) if model_id is not None else None
        if model_id is not None and model is None:
            findings.append(
                appdb._finding(
                    appdb.FINDING_ERROR,
                    f"The agent {agent['id']!r} names model {model_id}, which the "
                    "store does not hold; it cannot run until it is given one.",
                )
            )
        agent["modelName"] = model["name"] if model else None
        agents.append(agent)

    reserved = _reserved_agent_ids()
    agents.sort(key=lambda agent: agent["id"] in reserved)
    return {"agents": agents, "findings": findings}


def resolve_agent(
    agent_id: Optional[str],
) -> Tuple[Optional[Dict[str, Any]], List[Dict[str, str]]]:
    """One agent by id: an id in, a row or nothing out.

    **A missing id resolves to nothing** — there is no server-side default to
    fall back to: a turn with no ``agentMode`` is the 422 naming the field, not
    a turn that runs as some agent the client never chose. So ``None``/empty
    answers ``(None, findings)`` like any unresolvable id, and the caller decides
    what it costs — the route answers 422, and the message listing what *is*
    available is built from :func:`resolve_agents`.

    The findings ride along, so a caller that reports the agent it used can say
    in the same breath that the store has problems.
    """
    resolved = appdb.resolve_agents()
    wanted = (agent_id or "").strip()
    if not wanted:
        return (None, resolved["findings"])
    for agent in resolved["agents"]:
        if agent["id"] == wanted:
            return (agent, resolved["findings"])
    return (None, resolved["findings"])


def agent_max_tool_iteration(agent: Mapping[str, Any]) -> int:
    """The resolved agent's tool-loop cap, behind ``config.max_tool_iteration()``.

    A **floor of 1 and no ceiling**: the 500 found in a live settings file is a
    value someone typed, not a limit the app imposed.

    Still MCP's knob only: a round that used nothing but language-server tools
    never advances the count, so LSP round-trips stay uncapped. And the number is
    the one the turn resolved **at its start** — a save that lands mid-turn
    cannot move the cap the loop is running with.
    """
    raw = agent.get("maxToolIteration")
    if isinstance(raw, bool) or not isinstance(raw, int):
        # :func:`resolve_agents` checked every row that reached a caller, so this
        # is a hand-built mapping: the seeded number is the honest answer, and
        # the floor still applies to it.
        return appdb.SEEDED_MAX_TOOL_ITERATION
    return max(1, raw)


# -- agents, written -------------------------------------------------------------
#
# The personas' table, written. Like the connection's writes these are accessors
# rather than routes: they take values the route has already refused or accepted,
# and they answer the whole agent list in the read's shape so the dialog
# re-baselines on what the store now holds.
#
# Two rules the store enforces on itself here, because they are about rows rather
# than about what a browser typed:
#
# * a **``readonly``** row refuses every write except its ``model_id``. The
#   refusal is one sentence built here (:func:`readonly_refusal`) so the dialog,
#   the route and the boot's re-assertion cannot disagree about it;
# * a **missing agent id names no row**, so a create that would collide and an
#   update that would vanish are both ``None`` — the route turns that into the
#   status its own contract gives it.
#
# Duplicate **labels** stay the route's refusal, exactly as duplicate server and
# model names are: the ``UNIQUE`` constraint is the last line for two tabs saving
# at once, and the dialog's own mistake gets the dialog's own sentence.

#: The one refusal sentence nojae's own agents answer a write with. It is a
#: property of the agent, not of the field someone tried to change, so it does
#: not name one — and it is the *same* sentence wherever it is reached from: the
#: update route, the delete route, and any future writer.
READONLY_AGENT_REFUSAL = (
    "This agent is nojae's own: its fields cannot be edited or deleted. Its model "
    "is the one thing you can set."
)

#: The refusal a **built-in** agent answers *deletion* with. It is a second
#: sentence because the two rules cover different sets: only the app-owned agent
#: is ``readonly`` (the other three are personas the user may edit), while every
#: built-in is undeletable, because the seeder owns those ids and a dropdown
#: that could lose `code` would turn the lot's pin into a mystery.
BUILT_IN_AGENT_REFUSAL = (
    "This agent is one of nojae's own and cannot be deleted — you can edit it "
    "instead."
)


def readonly_refusal(agent_id: str) -> AppStoreError:
    """The error a write to a ``readonly`` agent raises, naming the agent."""
    return AppStoreError(
        f"Cannot change agent {agent_id!r}. {READONLY_AGENT_REFUSAL}"
    )


def built_in_refusal(agent_id: str) -> AppStoreError:
    """The error deleting a **built-in** agent raises, naming the agent."""
    return AppStoreError(
        f"Cannot delete agent {agent_id!r}. {BUILT_IN_AGENT_REFUSAL}"
    )


def built_in_agent_ids() -> Tuple[str, ...]:
    """The ids nojae seeds, read from the module that defines them.

    The one place "built-in" is decided, and it is the *definition* that decides
    it — not a list retyped here and not a column: the schema has no ``builtin``
    flag, and code is the source of truth for which agents nojae owns. Resolved
    by name for the reason :data:`AGENT_DEFAULTS_MODULE_NAME` gives.
    """
    defaults = importlib.import_module(appdb.AGENT_DEFAULTS_MODULE_NAME)
    modes = [*defaults.default_modes(), defaults.todo_builder_mode()]
    return tuple(mode.id for mode in modes)


def _agent_row(agent_id: Any) -> Optional[Dict[str, Any]]:
    """One agent row as the read answers it, or ``None``.

    Goes through :func:`resolve_agents` rather than a bare ``SELECT`` so the row a
    write is judged against is the row the dialog is showing — same columns, same
    ``modelName``, same reserved ordering. The list is small and a write is rare,
    so the second read costs nothing a cache would have earned.
    """
    found, _findings = appdb.resolve_agent(agent_id)
    return found


def _agent_rows_by_id() -> Dict[str, Dict[str, Any]]:
    """Every renderable agent row, keyed by id — the shape a write answers with."""
    return {agent["id"]: agent for agent in appdb.resolve_agents()["agents"]}


def add_agent(
    agent_id: str,
    label: str,
    *,
    max_tool_iteration: int = appdb.SEEDED_MAX_TOOL_ITERATION,
    mcp_enable: bool = True,
    lsp_enable: bool = False,
    system_message: str = "",
    model_id: Optional[int] = None,
) -> List[Dict[str, Any]]:
    """Insert one agent and answer the whole list.

    ``readonly`` is deliberately **not** a parameter: a user-created agent is
    editable by definition, and no route may create one nojae owns. The one
    built-in refusal that matters at create time is a **taken id**, which the
    schema asserts — a route checks it in words first, so this is the last line.

    An append, like every create here: ``agents.id`` is the slug the payload and
    the session files carry, so the caller *does* name it, and the store's answer
    is the list because that is what the dialog renders next.
    """
    appdb._write(
        "INSERT INTO agents (id, label, max_tool_iteration, mcp_enable, lsp_enable,"
        " system_message, readonly, model_id) VALUES (?, ?, ?, ?, ?, ?, 0, ?)",
        (
            agent_id,
            label,
            max_tool_iteration,
            1 if mcp_enable else 0,
            1 if lsp_enable else 0,
            system_message,
            model_id,
        ),
    )
    return list(_agent_rows_by_id().values())


def update_agent(
    agent_id: str,
    *,
    label: Optional[str] = None,
    max_tool_iteration: Optional[int] = None,
    mcp_enable: Optional[bool] = None,
    lsp_enable: Optional[bool] = None,
    system_message: Optional[str] = None,
    model_id: Any = ...,
) -> Optional[List[Dict[str, Any]]]:
    """Rewrite one agent; answers the whole list, or ``None`` for no such row.

    Refuses a **``readonly``** agent outright — with :func:`readonly_refusal` —
    unless the only column asked for is ``model_id``, which is the one field of
    such a row the user owns. "Only the model" is decided by which keyword
    arguments were supplied, not by which of them equal the stored value: a body
    that sends an unchanged label is still an edit of that label.

    ``model_id=...`` (the default sentinel) means "leave it alone", so an update
    that does not mention the model cannot null it by accident; passing ``None``
    explicitly clears the association, which is a legal save.

    No copy is kept: an ``UPDATE`` replaces a field the user can retype.
    """
    row = _agent_row(agent_id)
    if row is None:
        return None

    columns: Dict[str, Any] = {}
    if label is not None:
        columns["label"] = label
    if max_tool_iteration is not None:
        columns["max_tool_iteration"] = max_tool_iteration
    if mcp_enable is not None:
        columns["mcp_enable"] = 1 if mcp_enable else 0
    if lsp_enable is not None:
        columns["lsp_enable"] = 1 if lsp_enable else 0
    if system_message is not None:
        columns["system_message"] = system_message
    model_given = model_id is not ...
    if model_given:
        columns["model_id"] = model_id

    if row["readonly"] and any(column != "model_id" for column in columns):
        raise readonly_refusal(agent_id)
    if not columns:
        # Nothing asked for: answer the list unchanged rather than spelling a
        # `SET` with no assignment (which is not SQL).
        return list(_agent_rows_by_id().values())

    assignments = ", ".join(f"{column} = ?" for column in columns)
    appdb._write(
        f"UPDATE agents SET {assignments} WHERE id = ?",
        (*columns.values(), agent_id),
    )
    return list(_agent_rows_by_id().values())


def delete_agent(agent_id: str) -> Optional[List[Dict[str, Any]]]:
    """Remove one agent, keeping a copy of the store first.

    Refuses a **built-in** agent — every agent nojae seeds, not only the
    ``readonly`` one, because the seeder owns those ids and the dropdown a lot
    pins must not be able to lose `code`. The sentence is
    :func:`built_in_refusal`'s, so the route and any later writer answer it in one
    voice.

    A user-created agent goes, and the whole store is copied into the app's dated
    backup folder before the ``DELETE`` — the one thing the user cannot retype.

    ``None`` for an id that names no row, and then nothing was destroyed and no
    copy was taken.
    """
    row = _agent_row(agent_id)
    if row is None:
        return None
    if agent_id in appdb.built_in_agent_ids():
        raise built_in_refusal(agent_id)
    appdb.backup_before_delete()
    appdb._write("DELETE FROM agents WHERE id = ?", (agent_id,))
    return list(_agent_rows_by_id().values())
