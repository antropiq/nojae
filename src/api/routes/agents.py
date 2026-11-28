"""The agents of the settings store: the dropdown's reader and the dialog's writes."""

from typing import Any, Dict, List, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from src.core import agent_modes
from src.core import appdb

from src.api.routes.inputs import (
    AgentCreateIn,
    AgentDeleteIn,
    AgentUpdateIn,
    _agent_field_sentence,
)

router = APIRouter()


def _agent_payload() -> Dict[str, Any]:
    """The agent list in the shape both the dropdown and the dialog read.

    The store's rows as-is, plus the caps the dialog's form enforces so no cap
    is spelled in client code. Each row carries whether it can **run at all**
    (``modelId`` plus the resolved ``modelName``), so the composer's warning
    reads a field rather than re-deriving the rule from two tables. There is
    deliberately no ``default`` key: there is no server-side default agent, and
    a key that always answered "nothing" would be read as meaningful.

    ``deletable`` is a **flag** because ``readonly`` cannot answer it: the
    app's own rows refuse deletion, yet none of them is ``readonly``. Keeping
    it per-row is what lets the client offer the button without ever holding an
    agent id to compare against (``web/src`` names no reserved agent, and
    ``readonly`` stays the flag that disables a field).

    The read never raises: a damaged store answers 200 with the rows it could
    render plus its own findings, because the dropdown is the thing that has to
    stay usable.
    """
    resolved = appdb.resolve_agents()
    built_ins = set(appdb.built_in_agent_ids())
    agents = [
        {**agent, "deletable": agent["id"] not in built_ins}
        for agent in resolved["agents"]
    ]
    return {
        "agents": agents,
        "caps": agent_modes.caps(),
        "findings": resolved["findings"],
    }


def _agent_write(
    agents: Optional[List[Dict[str, Any]]], what: str, agent_id: str
) -> Dict[str, Any]:
    """One addressed agent write's answer, mapped to its status.

    ``None`` from the store means the id named no row — the browser was working
    from a list that has since changed — which is a 404 naming it. A list is
    the new truth and is returned whole, so the dialog re-baselines on the
    server's rows rather than splicing the one it sent.
    """
    if agents is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"no agent with id {agent_id!r} — it cannot be {what}; "
                "reload the agents."
            ),
        )
    return _agent_payload()


def _require_usable_agent_fields(body: BaseModel, *, creating: bool) -> None:
    """422 naming the first field the core's rules refuse.

    The bounds live in :mod:`core.agent_modes`; this is the transport half, so
    the dialog gets a message it can put next to the input rather than a
    framework type error. A create must state its id and label; an update may
    omit either (an omitted field is "leave it alone").
    """
    agent_id = getattr(body, "id", "") or ""
    label = getattr(body, "label", None)
    if creating or agent_id:
        problem = agent_modes._mode_id_problem(agent_id)
        if problem is not None:
            raise HTTPException(
                status_code=422,
                detail=_agent_field_sentence(problem, "id"),
            )
    if label is not None:
        problem = agent_modes._label_problem(label)
        if problem is not None:
            raise HTTPException(
                status_code=422,
                detail=_agent_field_sentence(problem, "label"),
            )
    elif creating:
        raise HTTPException(
            status_code=422, detail=_agent_field_sentence(
                "label must not be empty", "label"),
        )
    persona = getattr(body, "systemMessage", None)
    if persona is not None:
        problem = agent_modes._persona_problem(persona)
        if problem is not None:
            raise HTTPException(
                status_code=422,
                detail=_agent_field_sentence(problem, "systemMessage"),
            )
    cap = getattr(body, "maxToolIteration", None)
    if cap is not None:
        problem = agent_modes._tool_iteration_problem(cap)
        if problem is not None:
            raise HTTPException(
                status_code=422,
                detail=_agent_field_sentence(problem, "maxToolIteration"),
            )


def _require_free_agent_label(label: str, agents: List[Dict[str, Any]],
                              keep_id: Optional[str] = None) -> None:
    """422 naming ``label`` when another agent already answers to it.

    The app refuses before the database does, in words: the dialog creates an
    agent *by label* and derives the id from it, so a duplicate label is
    answered with the slug-collision message rather than a silent renumber —
    the ``UNIQUE`` constraint stays the last line for the
    two-tabs-saving-at-once case.
    """
    wanted = label.strip()
    for agent in agents:
        if agent["id"] != keep_id and agent["label"].strip() == wanted:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"label: an agent labelled {wanted!r} already exists — the "
                    "id is derived from the label, so this would collide with "
                    f"the existing agent {agent['id']!r}."
                ),
            )


@router.get("/agents")
def get_agents() -> Dict[str, Any]:
    """Every agent the store holds, **read-only**, with its model and the caps.

    The composer's dropdown, the modes dialog's tabs and the hub panels'
    gray-out all read this one payload. ``readonly`` is the flag the client
    renders disabled fields from — as **data**, never by naming an id, which
    is what keeps a reserved agent's name out of ``web/src``.

    An unreadable store still answers **200** with the agents it could render
    plus the finding naming the path: a 4xx would hide the fix and leave the
    dropdown unrenderable.

    This answers *about* the store; it is not a way to read the database.
    There is no ``?path=``, no SQL and no file — and the store is itself
    invisible to ``/api/fs/*`` and to both connectors.
    """
    return _agent_payload()


@router.post("/agents/add")
def post_agents_add(body: AgentCreateIn) -> Dict[str, Any]:
    """Create one agent and return the whole list.

    Refused with a 422 naming the field for: an id outside the slug pattern, a
    duplicate id, a duplicate label (the slug-collision sentence), an empty
    label, a persona over the byte cap, or a tool-iteration cap below 1 — there
    is **no ceiling**.

    The new agent is always editable: ``readonly`` is not a body field, so no
    route may create one nojae owns.

    Not gated on a reply streaming, and deliberately so: a turn resolves its
    agent and connection once, at its start, so an agent saved mid-turn cannot
    change what that turn says.
    """
    _require_usable_agent_fields(body, creating=True)
    # A create refuses an absent label in words just above, so one is stated
    # by here: this is that invariant made readable, not a second refusal.
    label = body.label
    assert label is not None
    try:
        agents = _agent_payload()["agents"]
        if any(agent["id"] == body.id for agent in agents):
            raise HTTPException(
                status_code=422,
                detail=(
                    f"id: an agent with the id {body.id!r} already exists — "
                    "the id is derived from the label, so pick another label."
                ),
            )
        _require_free_agent_label(label, agents)
        written = appdb.add_agent(
            body.id,
            label,
            max_tool_iteration=(
                body.maxToolIteration
                if body.maxToolIteration is not None
                else appdb.SEEDED_MAX_TOOL_ITERATION
            ),
            mcp_enable=body.mcpEnable if body.mcpEnable is not None else True,
            lsp_enable=bool(body.lspEnable),
            system_message=body.systemMessage or "",
            model_id=body.modelId,
        )
    except appdb.AppStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _agent_write(written, "added", body.id)


@router.post("/agents/save")
def post_agents_save(body: AgentUpdateIn) -> Dict[str, Any]:
    """Rewrite one agent and return the whole list.

    A **``readonly``** agent refuses every field but its model association,
    with the one sentence :func:`src.core.appdb.readonly_refusal` builds — the
    same sentence the delete route answers, so the client sees one refusal
    wherever it is reached from. That is checked by the field list the body
    actually supplied, not by a comparison against the stored values, so
    re-sending an unchanged label is still refused.

    ``modelId`` absent leaves the association alone and ``modelId: null``
    clears it — a legal save, and the reason an agent can be unrunnable.

    No copy is kept: an ``UPDATE`` replaces a field the user can retype.
    """
    _require_usable_agent_fields(body, creating=False)
    model_given = "modelId" in body.model_fields_set
    try:
        agents = _agent_payload()["agents"]
        label = body.label
        if label is not None:
            _require_free_agent_label(label, agents, keep_id=body.id)
        written = appdb.update_agent(
            body.id,
            label=label,
            max_tool_iteration=body.maxToolIteration,
            mcp_enable=body.mcpEnable,
            lsp_enable=body.lspEnable,
            system_message=body.systemMessage,
            **({"model_id": body.modelId} if model_given else {}),
        )
    except appdb.AppStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _agent_write(written, "saved", body.id)


@router.post("/agents/delete")
def post_agents_delete(body: AgentDeleteIn) -> Dict[str, Any]:
    """Remove one agent and return what is left.

    A **built-in** agent refuses deletion: nojae's own rows cannot be deleted,
    from the dialog or from the route, and the refusal names the agent. A
    user-created agent goes, and the whole store lands in the app's dated
    backup folder first, through the same helper and the same retention sweep
    every file replacement already uses.

    An id that names no row is a 404, and then nothing was destroyed and no
    copy was taken.
    """
    try:
        written = appdb.delete_agent(body.id)
    except appdb.AppStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _agent_write(written, "deleted", body.id)
