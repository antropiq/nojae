"""The settings store's servers and models, and the live probe of a server URL."""

from typing import Any, Dict, List, Optional

import httpx
from fastapi import APIRouter, HTTPException

from src.core import appdb
from src.core.llmkit.client import models_url

from src.api.routes.inputs import (
    REASONING_LEVELS,
    SAMPLER_RANGES,
    ModelCreateIn,
    ModelDeleteIn,
    ModelUpdateIn,
    ServerCreateIn,
    ServerDeleteIn,
    ServerUpdateIn,
    _model_columns,
)
from src.api.routes.turn import _model_ids

router = APIRouter()


def _connection_caps() -> Dict[str, Any]:
    """The numbers and words the form enforces, so none is spelled in the client.

    The sampler ranges and the reasoning levels are the same tables the request
    models above validate against — one authority, sent to the dialog so its
    fields and its refusals cannot disagree about a bound.
    """
    return {
        "samplerRanges": {
            field: {"min": low, "max": high}
            for field, (low, high) in SAMPLER_RANGES.items()
        },
        "reasoningLevels": list(REASONING_LEVELS),
    }


def _connection_envelope(servers: List[Dict[str, Any]]) -> Dict[str, Any]:
    """The connection read's whole answer, for a read **and every write**.

    One envelope for both, so a write cannot blank the caps the form's
    bounds come from or the unassigned count the band's actionable line
    reads. ``caps`` is static; ``unassigned`` is re-derived because a server
    or model delete nulls the agents that pointed at it.
    """
    try:
        agents = appdb.resolve_agents()["agents"]
    except appdb.AppStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {
        "servers": servers,
        "caps": _connection_caps(),
        "unassigned": {
            "agentsWithoutModel": sum(
                1 for agent in agents if agent["modelId"] is None
            ),
            "agents": len(agents),
        },
    }


def _connection_write(
    servers: Optional[List[Dict[str, Any]]], what: str, row_id: Optional[int]
) -> Dict[str, Any]:
    """One addressed server/model write's answer, mapped to its status.

    ``None`` from the store means the id named no row — the browser was working
    from a list that has since changed — which is a 404 naming it, the same
    shape the prompt-helper writes answer. A list is the new truth and is
    returned whole, in the read's envelope, so the dialog re-baselines on the
    server's rows rather than splicing the one it sent.
    """
    if servers is None:
        raise HTTPException(
            status_code=404,
            detail=(
                f"no row with id {row_id} — it cannot be {what}; "
                "reload the servers."
            ),
        )
    return _connection_envelope(servers)


def _require_free_server_name(name: str, servers: List[Dict[str, Any]],
                              keep_id: Optional[int] = None) -> None:
    """422 naming ``name`` when another server already answers to it.

    The app refuses before the database does, in words: the ``UNIQUE``
    constraint stays the last line for the two-tabs-saving-at-once case, but
    the dialog's own mistake gets the dialog's own sentence. ``keep_id`` is
    the row being renamed, which may of course keep its name.
    """
    for server in servers:
        if server["id"] != keep_id and server["name"] == name:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"name: a server named {name!r} already exists — server "
                    "names are how the dialog tells them apart."
                ),
            )


def _require_free_model_name(server: Dict[str, Any], name: str,
                             keep_id: Optional[int] = None) -> None:
    """422 naming ``name`` when that server already holds a model of it."""
    for model in server["models"]:
        if model["id"] != keep_id and model["name"] == name:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"name: {server['name']!r} already has a model named "
                    f"{name!r} — a model is chosen from its own server's list."
                ),
            )


@router.get("/servers")
def get_servers() -> Dict[str, Any]:
    """Every server **with its models**, plus the caps and the unassigned count.

    ``{"servers": [{id, name, url, apiKey, models: [...]}], "caps": {...},
    "unassigned": {"agentsWithoutModel": n, "agents": n}}`` — servers in
    insertion order, each server's models in theirs. There is no separate
    model list and no "app defaults" surface: the nesting is the shape the
    dialog renders.

    The API key is in here on purpose — this route answers only the dialog
    that edits it. "Never to a connector, a log or a tool listing" is those
    surfaces' rule, and this route is not reachable from a tool, which
    ``tests/test_write_surface_isolation.py`` asserts.

    ``unassigned`` is the one cross-store line — "2 of 4 agents have no
    model" — so a fresh install's dialog can say every agent is unrunnable
    without the client holding two stores. It is a derived count: no agent's
    text leaves the server here.

    An unusable store is a 422 naming its path, never an empty list: the
    silent empty answer is the state this app refuses everywhere.
    """
    try:
        servers = appdb.load_servers()
    except appdb.AppStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _connection_envelope(servers)


@router.post("/servers/add")
def post_servers_add(body: ServerCreateIn) -> Dict[str, Any]:
    """Append one server and return the whole list.

    An **add**, not a fill: the new row's id is the store's to assign and
    comes back in the list. A duplicate name is a 422 naming the field.

    Not gated on a reply streaming: a turn resolves its connection once, at
    its start, so a server saved mid-turn cannot change what it says.
    """
    try:
        _require_free_server_name(body.name, appdb.load_servers())
        servers = appdb.add_server(body.name, body.url, body.apiKey)
    except appdb.AppStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return {"servers": servers}


@router.post("/servers/save")
def post_servers_save(body: ServerUpdateIn) -> Dict[str, Any]:
    """Rewrite one server and return the whole list.

    Addressed by ``id`` — the handle the read hands out. Every field is
    written, so a cleared key clears; an id that names no row is a 404. No
    copy is kept: an update replaces a field the user can retype.
    """
    try:
        servers = appdb.load_servers()
        _require_free_server_name(body.name, servers, keep_id=body.id)
        written = appdb.update_server(body.id, body.name, body.url, body.apiKey)
    except appdb.AppStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _connection_write(written, "saved", body.id)


@router.post("/servers/delete")
def post_servers_delete(body: ServerDeleteIn) -> Dict[str, Any]:
    """Remove one server **and its models**, and return what is left.

    The cascade is the schema's, which is why this is the destructive write
    of the server routes: one delete takes the models under it with it and
    leaves every agent that pointed at one with no model. The whole store
    therefore lands in the app's dated backup folder first, through the same
    helper every file replacement already uses. An id that names no row is a
    404, and then nothing was destroyed and no copy was taken.
    """
    try:
        servers = appdb.delete_server(body.id)
    except appdb.AppStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _connection_write(servers, "deleted", body.id)


@router.post("/models/add")
def post_models_add(body: ModelCreateIn) -> Dict[str, Any]:
    """Append one model under its server and return the whole list.

    A ``serverId`` naming no row is a 404 naming it — the browser was adding
    a model to a server that has since been deleted. A duplicate name under
    that server is a 422 naming the field.
    """
    try:
        servers = appdb.load_servers()
        server = next((s for s in servers if s["id"] == body.serverId), None)
        if server is None:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"no server with id {body.serverId} — a model belongs to "
                    "one; reload the servers."
                ),
            )
        _require_free_model_name(server, body.name)
        written = appdb.add_model(
            body.serverId, body.name, **_model_columns(body)
        )
    except appdb.AppStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _connection_write(written, "added", body.serverId)


@router.post("/models/save")
def post_models_save(body: ModelUpdateIn) -> Dict[str, Any]:
    """Rewrite one model and return the whole list.

    Every column but its server is written, so a cleared sampler clears to
    ``NULL`` and is omitted from the next request body — the same "member
    absent means" the file's reader held, now per column. A model is never
    moved between servers: that would silently re-point every agent running
    on it, and there is no route that asks for it.
    """
    try:
        servers = appdb.load_servers()
        row = next(
            (
                model
                for server in servers
                for model in server["models"]
                if model["id"] == body.id
            ),
            None,
        )
        if row is None:
            raise HTTPException(
                status_code=404,
                detail=(
                    f"no model with id {body.id} — it cannot be saved; "
                    "reload the servers."
                ),
            )
        server = next(s for s in servers if s["id"] == row["serverId"])
        _require_free_model_name(server, body.name, keep_id=body.id)
        written = appdb.update_model(body.id, body.name, **_model_columns(body))
    except appdb.AppStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _connection_write(written, "saved", body.id)


@router.post("/models/delete")
def post_models_delete(body: ModelDeleteIn) -> Dict[str, Any]:
    """Remove one model and return what is left.

    The agents pointing at it are **not** deleted: the schema nulls their
    ``model_id``, so each becomes unrunnable until it is given another rather
    than losing its persona. That is visible as the unassigned count above
    and the composer's warning, not as a silent failure. The store is copied
    first.
    """
    try:
        servers = appdb.delete_model(body.id)
    except appdb.AppStoreError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    return _connection_write(servers, "deleted", body.id)


@router.get("/models")
async def get_models(serverUrl: str = "", apiKey: str = "") -> Dict[str, Any]:
    """List models exposed by an OpenAI-compatible server URL."""
    url = serverUrl.strip()
    if not url:
        raise HTTPException(status_code=422, detail="No server URL provided")
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(
            status_code=422, detail="Server URL must start with http:// or https://"
        )
    url = models_url(url)
    headers = {}
    if apiKey.strip():
        headers["Authorization"] = f"Bearer {apiKey.strip()}"
    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(url, headers=headers)
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not fetch models from {url}: {exc}",
        ) from exc
    return {"models": _model_ids(payload)}
