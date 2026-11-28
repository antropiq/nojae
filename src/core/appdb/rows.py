"""The row vocabulary: the columns, the browser's names for them, the read seam.

Every read in the package answers a dict built here, from the column lists below,
and every read goes through the one :func:`_read`. The shared names — the path,
the handle, the failure type — are read off the façade at call time, so a patch
of ``appdb.PROJECT_ROOT`` or ``appdb.connection`` moves what a row is read from.
"""

import sqlite3
from typing import Any, Dict, List, Tuple

import src.core.appdb as appdb

from .errors import AppStoreError

# -- the read side ------------------------------------------------------------
#
# Everything the rest of the app asks the store for, and the only code in the
# repo that spells a ``SELECT``. The reads are **uncached**: the database is the
# cache, so there is no per-root key here and nothing a working-location switch
# could leave stale.
#
# Rows leave with the **browser's** names, not the columns': the
# ``snake_case`` → ``camelCase`` translation lives in this module and nowhere
# else, because the same table copied into every route is a table that stops
# agreeing with itself. The column lists below are therefore the module's whole
# vocabulary, in schema order, and a row is the same dict whether it was read
# alone or nested inside its server.

#: The columns of each table, in schema order, and the reason no accessor spells
#: a ``SELECT *``: a row then holds exactly the columns this module knows about,
#: whatever a later schema level adds beside them.
_SERVER_COLUMNS: Tuple[str, ...] = ("id", "name", "url", "api_key")

_MODEL_COLUMNS: Tuple[str, ...] = (
    "id",
    "server_id",
    "name",
    "sys_prompt",
    "temperature",
    "top_p",
    "top_k",
    "min_p",
    "repeat_penalty",
    "presence_penalty",
    "reasoning",
    "supports_vision",
)

_AGENT_COLUMNS: Tuple[str, ...] = (
    "id",
    "label",
    "max_tool_iteration",
    "mcp_enable",
    "lsp_enable",
    "system_message",
    "readonly",
    "model_id",
)

_PROMPT_HELPER_COLUMNS: Tuple[str, ...] = ("id", "color_code", "content")

#: Column → the name the browser knows it by. A column not listed keeps its own
#: name (``id``, ``name``, ``url``, ``label``, ``content``, ``reasoning``).
_SERVER_JSON: Dict[str, str] = {"api_key": "apiKey"}

_MODEL_JSON: Dict[str, str] = {
    "server_id": "serverId",
    "sys_prompt": "sysPrompt",
    "top_p": "topP",
    "top_k": "topK",
    "min_p": "minP",
    "repeat_penalty": "repeatPenalty",
    "presence_penalty": "presencePenalty",
    "supports_vision": "supportsVision",
}

_AGENT_JSON: Dict[str, str] = {
    "max_tool_iteration": "maxToolIteration",
    "mcp_enable": "mcpEnable",
    "lsp_enable": "lspEnable",
    "system_message": "systemMessage",
    "model_id": "modelId",
}

#: The helpers' one renamed column. ``color`` rather than ``colorCode`` so the
#: move stays invisible to the bullet row the client already renders.
_PROMPT_HELPER_JSON: Dict[str, str] = {"color_code": "color"}

#: Columns that carry a JSON boolean rather than a number. SQLite stores them as
#: integers, so the translation happens here once instead of as a ``v == 1`` in
#: every surface that reads one.
_BOOLEAN_COLUMNS: frozenset[str] = frozenset(
    {"supports_vision", "mcp_enable", "lsp_enable", "readonly"}
)

#: The finding kind the read model reports a damaged row with. The browser's
#: modes payload also knows ``note``, for something odd that cost nothing; a row
#: this reader cannot render always costs the agent, so only ``error`` is here.
FINDING_ERROR = "error"


def _kind_of(value: Any) -> str:
    """What to call a stored value in a sentence — the JSON word, not the Python one."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "a boolean"
    if isinstance(value, (int, float)):
        return "a number"
    if isinstance(value, str):
        return "a string"
    return type(value).__name__


def _finding(kind: str, message: str) -> Dict[str, str]:
    """One thing the read noticed, in the shape a route passes straight through."""
    return {"kind": kind, "message": message}


def _record(
    columns: Tuple[str, ...], values: Tuple[Any, ...], mapping: Dict[str, str]
) -> Dict[str, Any]:
    """One row, as the browser's dict: renamed, and the flags made booleans."""
    record: Dict[str, Any] = {}
    for column, value in zip(columns, values):
        record[mapping.get(column, column)] = (
            bool(value) if column in _BOOLEAN_COLUMNS else value
        )
    return record


def _select(
    table: str, columns: Tuple[str, ...], where: str = "", order: str = ""
) -> str:
    """The one ``SELECT`` builder in the repo.

    ``table`` and ``columns`` are never caller-supplied: every argument is a
    constant above, which is what lets the statement be assembled with no
    placeholder in sight. A **value** always goes through a ``?``.
    """
    clause = f" WHERE {where}" if where else ""
    tail = f" ORDER BY {order}" if order else ""
    return f"SELECT {', '.join(columns)} FROM {table}{clause}{tail}"


def _read(sql: str, params: Tuple[Any, ...] = ()) -> List[Tuple[Any, ...]]:
    """Run one read statement — the only place a read's failure is decided.

    Every accessor here goes through it, so the module answers **one** failure
    type for the read side: a driver error becomes :class:`AppStoreError` naming
    the path, the same sentence an unopenable file gets. :func:`resolve_agents`
    keeps its never-raises promise by catching that one type: a file that opens
    but has no schema (a boot killed between the create and the migration) would
    otherwise escape as a raw ``OperationalError`` and take the dropdown with it.
    """
    target = appdb.database_path()
    try:
        return list(appdb.connection().execute(sql, params))
    except sqlite3.Error as exc:
        raise AppStoreError(
            f"nojae's settings store at {appdb._describe(target)} cannot be read "
            f"({exc})."
        ) from exc
