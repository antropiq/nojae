"""``servers`` and ``models``: the connection's two tables, read and written.

The Settings dialog's whole surface, as accessors: the reads answer the browser's
dicts, the writes answer the whole list again, and every name they share — the
row builders, the read and write seams, the pre-delete copy — is read off the
façade at call time, so a patch of ``appdb.server_row`` is what a write checks.
"""

from typing import Any, Dict, List, Optional

import src.core.appdb as appdb

# -- servers and models ----------------------------------------------------------

def server_row(server_id: Any) -> Optional[Dict[str, Any]]:
    """One server by id, or ``None`` when there is no such row."""
    if not isinstance(server_id, int) or isinstance(server_id, bool):
        return None
    found = appdb._read(
        appdb._select("servers", appdb._SERVER_COLUMNS, "id = ?"), (server_id,)
    )
    if not found:
        return None
    return appdb._record(appdb._SERVER_COLUMNS, found[0], appdb._SERVER_JSON)


def model_row(model_id: Any) -> Optional[Dict[str, Any]]:
    """One model by id, or ``None`` — the row alone, without its server."""
    if not isinstance(model_id, int) or isinstance(model_id, bool):
        return None
    found = appdb._read(
        appdb._select("models", appdb._MODEL_COLUMNS, "id = ?"), (model_id,)
    )
    if not found:
        return None
    return appdb._record(appdb._MODEL_COLUMNS, found[0], appdb._MODEL_JSON)


def load_servers() -> List[Dict[str, Any]]:
    """Every server with its models, as the browser's dicts.

    ``[{id, name, url, apiKey, models: [{id, serverId, name, sysPrompt, the six
    samplers, reasoning, supportsVision}]}]``, servers in insertion order and
    each server's models in theirs. The nesting is the shape the Settings dialog
    renders, which is why the models arrive inside their server rather than as a
    second list a route has to join.

    The API key is in here: it is returned to the dialog that edits it. "Never to
    a connector, a log or a tool listing" is those surfaces' rule, and this
    accessor is not one of them.

    Raises :class:`AppStoreError` naming the path when the store cannot be
    opened, which is deliberate for a plain read: an accessor that answered
    ``[]`` instead would make an unreadable store indistinguishable from one
    with no servers — the silent empty state this app refuses. The caller that
    has something to say about it is :func:`src.config.agent_connection_refusal`.
    """
    servers = [
        appdb._record(appdb._SERVER_COLUMNS, found, appdb._SERVER_JSON)
        for found in appdb._read(
            appdb._select("servers", appdb._SERVER_COLUMNS, order="id")
        )
    ]
    models_by_server: Dict[int, List[Dict[str, Any]]] = {}
    for found in appdb._read(
        appdb._select("models", appdb._MODEL_COLUMNS, order="id")
    ):
        model = appdb._record(appdb._MODEL_COLUMNS, found, appdb._MODEL_JSON)
        models_by_server.setdefault(model["serverId"], []).append(model)
    for server in servers:
        server["models"] = models_by_server.get(server["id"], [])
    return servers


# -- servers and models ----------------------------------------------------------
#
# The connection's two tables, written. Like every write here these are accessors
# rather than routes: they take values the route has already refused or accepted,
# they answer the whole server list in the read's shape (so the dialog re-baselines
# on what the store now holds rather than on what it sent), and they raise
# :class:`AppStoreError` rather than an HTTP status.
#
# **Duplicate names are the route's refusal, not these functions'.** The app
# refuses before the database does, in words: the route compares against
# :func:`load_servers` and answers a message naming the field, while the
# ``UNIQUE`` constraints stay the last line for two tabs saving at once, where
# the check passed and the statement did not.

def add_server(name: str, url: str, api_key: str = "") -> List[Dict[str, Any]]:
    """Append one server and answer the whole list.

    An **append**, always: a server is addressed by the ``id`` the read hands out,
    so there is nothing to aim at here. The new row's id is SQLite's, which is why
    the answer is the read rather than the values passed in.
    """
    appdb._write(
        "INSERT INTO servers (name, url, api_key) VALUES (?, ?, ?)",
        (name, url, api_key),
    )
    return appdb.load_servers()


def update_server(
    server_id: int, name: str, url: str, api_key: str
) -> Optional[List[Dict[str, Any]]]:
    """Rewrite one server; answers the whole list, or ``None`` for no such row.

    Every column is written, so a cleared field clears: the dialog owns all three
    fields of a server, and a save that left an unnamed one behind would be a row
    it cannot render. No copy is kept — an ``UPDATE`` replaces a field the user
    can retype.
    """
    changed = appdb._write(
        "UPDATE servers SET name = ?, url = ?, api_key = ? WHERE id = ?",
        (name, url, api_key, server_id),
    )
    return appdb.load_servers() if changed else None


def delete_server(server_id: int) -> Optional[List[Dict[str, Any]]]:
    """Remove one server **and its models**, keeping a copy of the store first.

    The cascade is the schema's (``ON DELETE CASCADE``, and ``ON DELETE SET
    NULL`` for the agents that pointed at those models), not code here. That is
    why the copy is taken first — one delete destroys more rows than the one the
    user named.

    ``None`` for an id that names no row, and then nothing was destroyed and no
    copy was taken.
    """
    if appdb.server_row(server_id) is None:
        return None
    appdb.backup_before_delete()
    appdb._write("DELETE FROM servers WHERE id = ?", (server_id,))
    return appdb.load_servers()


def add_model(
    server_id: int,
    name: str,
    *,
    sys_prompt: str = "",
    temperature: Optional[float] = None,
    top_p: Optional[float] = None,
    top_k: Optional[int] = None,
    min_p: Optional[float] = None,
    repeat_penalty: Optional[float] = None,
    presence_penalty: Optional[float] = None,
    reasoning: Optional[str] = None,
    supports_vision: bool = False,
) -> Optional[List[Dict[str, Any]]]:
    """Append one model under ``server_id`` and answer the whole list.

    ``None`` when the server is not there: a model is a child row, and a create
    that names no parent is the browser working from a list that has since
    changed — the caller answers with the list it now has. (The schema would
    refuse it too, with ``FOREIGN KEY constraint failed``; answering ``None`` is
    what lets the route say that in words instead of quoting SQLite.)

    The six samplers are **nullable columns**: a ``None`` here is a ``NULL`` in
    the row, which :meth:`EndpointsConfig.from_store` omits from the request
    body, while a ``0`` is kept. The two are different values and must not
    converge, which is why there is no default spelled for them.
    """
    if appdb.server_row(server_id) is None:
        return None
    appdb._write(
        "INSERT INTO models (server_id, name, sys_prompt, temperature, top_p,"
        " top_k, min_p, repeat_penalty, presence_penalty, reasoning,"
        " supports_vision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (
            server_id,
            name,
            sys_prompt,
            temperature,
            top_p,
            top_k,
            min_p,
            repeat_penalty,
            presence_penalty,
            reasoning,
            1 if supports_vision else 0,
        ),
    )
    return appdb.load_servers()


def update_model(
    model_id: int,
    name: str,
    *,
    sys_prompt: str = "",
    temperature: Optional[float] = None,
    top_p: Optional[float] = None,
    top_k: Optional[int] = None,
    min_p: Optional[float] = None,
    repeat_penalty: Optional[float] = None,
    presence_penalty: Optional[float] = None,
    reasoning: Optional[str] = None,
    supports_vision: bool = False,
) -> Optional[List[Dict[str, Any]]]:
    """Rewrite one model; answers the whole list, or ``None`` for no such row.

    Every column but ``server_id`` is written, so a cleared sampler clears to
    ``NULL`` — the same "member absent means" the dialog held for the file, now
    per column. A model is never **moved** between servers: that would silently
    re-point every agent that runs on it, and the dialog offers no such action.
    """
    changed = appdb._write(
        "UPDATE models SET name = ?, sys_prompt = ?, temperature = ?, top_p = ?,"
        " top_k = ?, min_p = ?, repeat_penalty = ?, presence_penalty = ?,"
        " reasoning = ?, supports_vision = ? WHERE id = ?",
        (
            name,
            sys_prompt,
            temperature,
            top_p,
            top_k,
            min_p,
            repeat_penalty,
            presence_penalty,
            reasoning,
            1 if supports_vision else 0,
            model_id,
        ),
    )
    return appdb.load_servers() if changed else None


def delete_model(model_id: int) -> Optional[List[Dict[str, Any]]]:
    """Remove one model, keeping a copy of the store first.

    The agents pointing at it are **not** deleted: ``ON DELETE SET NULL`` leaves
    each one with a null ``model_id``, which is the narrower damage — the persona
    outlives the model it was tried with, and the agent becomes unrunnable until
    it is given another. The unassigned count in the dialog is what makes that
    visible rather than silent.
    """
    if appdb.model_row(model_id) is None:
        return None
    appdb.backup_before_delete()
    appdb._write("DELETE FROM models WHERE id = ?", (model_id,))
    return appdb.load_servers()
