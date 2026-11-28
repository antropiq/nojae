"""The connection the app bar reads, and the agent a turn resolves to a row."""

import json
from typing import Any, Dict

from fastapi import APIRouter, HTTPException

from src.config import load_endpoints_config, network_fail_budget
from src.core import agent_modes
from src.core import appdb
from src.core.models import EndpointsConfig

from src.api.routes.turn import _context_window

router = APIRouter()


def _agent_row_for(mode: agent_modes.AgentMode) -> Dict[str, Any]:
    """The store's row for the agent a turn selected, as the seam wants it.

    The mode read and the row are the same source — the ``agents`` table —
    so one lookup answers what :func:`src.config.load_endpoints_config` and
    :func:`src.config.agent_connection_refusal` need.

    A mode with no row is answered as an agent with no model. That is
    reachable only for a reserved id, whose mode is rendered from code even
    when its row is gone; the connection then refuses with the sentence
    naming the agent, which is the honest answer rather than a silent one.
    """
    row, _findings = appdb.resolve_agent(mode.id)
    return row or {"id": mode.id, "label": mode.label, "modelId": None}


def _load_config(agent: Dict[str, Any]) -> EndpointsConfig:
    """The connection **one agent** runs on, or the refusal a turn answers with.

    Two kinds of refusal, in the shape the client already renders: a
    ``ValidationError`` from a sampler column pydantic rejects keeps the 422
    field list, and everything :func:`src.config.agent_connection_refusal`
    names — no model, a model whose server row is missing, an unusable store
    — answers 422 with that one sentence.

    **A turn resolves once, at its start**: the caller holds this answer for
    the whole turn, so a settings save that lands mid-turn cannot split the
    reply that is streaming. That invariant is why the store's write routes
    are not gated on a streaming reply.
    """
    config, error = load_endpoints_config(agent)
    if isinstance(error, str):
        raise HTTPException(status_code=422, detail=error)
    if error is not None:
        raise HTTPException(
            status_code=422,
            detail=json.loads(error.json()),
        )
    assert config is not None
    return config


def _store_block() -> Dict[str, Any]:
    """Is nojae's settings store usable, and the one sentence when it is not.

    The only thing the app bar says about the connection: whether *this* turn
    can run is the composer's business, because that is where the agent is
    chosen and where the fix is one click away. One warning in two places
    would mean two sentences to keep in step.
    """
    state = appdb.store_state()
    return {
        "usable": state["state"] == "ok",
        "sentence": None if state["state"] == "ok" else state["sentence"],
    }


def _retry_budget_block() -> Dict[str, Any]:
    """The endpoint-wait budget the screen must be able to read.

    The pair this **run** was booted with (``--network-max-retry`` /
    ``--network-wait-for``, or the defaults). Read at call time, so what the
    screen shows is what the next refused round will spend.

    There is no "written value was unusable" note to carry: an unusable flag
    stops the boot, so a running app has nothing of the kind left to report.
    """
    max_retry, wait_seconds = network_fail_budget()
    return {"maxRetry": max_retry, "waitSeconds": wait_seconds}


@router.get("/config")
def get_config() -> Dict[str, Any]:
    """Everything the two views read about the connection, **per model**.

    ``{"models": [{id, name, serverId, serverName, serverUrl,
    supportsVision, contextWindow}], "store": {usable, sentence},
    "retryBudget": {maxRetry, waitSeconds}}``.

    A **list**, not one connection, and deliberately so: which model a view
    is looking at is the composer's answer, not this route's, so the vision
    flag and the occupancy gauge's context-window cap arrive with the model
    they describe rather than as "the" model's. Nothing here resolves an
    agent and nothing here invents a default model: an install with no
    models answers an empty list, and the app bar's store-level line says so.

    The ``retryBudget`` block is the effective pair the endpoint-wait guard
    reads at call time — what this run was booted with, the only source
    those two numbers have and so the only thing worth showing.
    """
    try:
        servers = appdb.load_servers()
    except appdb.AppStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    models = [
        {
            "id": model["id"],
            "name": model["name"],
            "serverId": server["id"],
            "serverName": server["name"],
            "serverUrl": server["url"],
            "supportsVision": model["supportsVision"],
            # The occupancy gauge's cap: this model's context window
            # (meta.n_ctx), None when its server does not expose it.
            "contextWindow": _context_window(
                server["url"], server["apiKey"] or "none", model["name"]
            ),
        }
        for server in servers
        for model in server["models"]
    ]
    return {
        "models": models,
        "store": _store_block(),
        "retryBudget": _retry_budget_block(),
    }
