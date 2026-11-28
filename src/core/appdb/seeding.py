"""What a boot writes into a store it made or found: the built-in rows.

The seeding pass, the numbers it seeds with and where the built-in agents' words
come from live here. Every shared name is read off the façade at call time, so a
patch of ``appdb.SEEDED_PROMPT_HELPER_COUNT`` or ``appdb._agent_definitions`` is
what the seeder sees.
"""

import importlib
import sqlite3
from typing import Any, Dict, List

import src.core.appdb as appdb

# -- seeding -------------------------------------------------------------------

#: The tool-loop cap an **editable** built-in agent is seeded with: what the app
#: has always defaulted to, so a fresh install behaves exactly as it did. The
#: per-agent column carries the same default in its DDL; naming it here is what
#: lets the seeder say it rather than rely on the column list omitting it.
SEEDED_MAX_TOOL_ITERATION = 25

#: The cap the **app-owned** agent is seeded with. It is not the number above: a
#: lot-building turn writes a whole folder of task files through the file tools,
#: so the cap a chat agent is content with would stop it mid-lot. That row is
#: ``readonly``, so this is code's number rather than the user's — which is what
#: lets the boot re-assert it on every column but ``model_id``.
SEEDED_RESERVED_MAX_TOOL_ITERATION = 500

#: How many prompt-helper rows a **created** store starts with, and the colour
#: they start in: the nine empty gray bullets a first boot draws. Both are named
#: here rather than imported from :mod:`core.prompt_helpers`, which reads these
#: rows through this module — a store that imported its own reader is a cycle,
#: and the two values are the store's own starting layout, not a rendering
#: choice.
SEEDED_PROMPT_HELPER_COUNT = 9
SEEDED_PROMPT_HELPER_COLOR = "#808080"

#: Where the built-in agents' words live. Resolved **by name, per call**, for the
#: reason :mod:`core.agent_modes` gives for the same choice: that module's
#: content is validated by code that reads these rows, so a static import in
#: either direction is a cycle. The personas, labels, hub flags and the generated
#: lot-conventions block all stay there — the seeder *reads* them, it does not
#: copy them, which is what keeps one definition of a persona.
AGENT_DEFAULTS_MODULE_NAME = "src.core.agent_modes_defaults"


def _agent_definitions() -> List[Dict[str, Any]]:
    """The four built-in agents, as the rows they are seeded into.

    Read from :data:`AGENT_DEFAULTS_MODULE_NAME`, in that module's own order —
    the three declared modes then the app-owned one — which is also the dropdown
    order, since agents come back in insertion order. Nothing here names an agent
    id: ``readonly`` comes from the definition's own flag, so the row says what
    the definition says.

    The tool-loop cap follows the same ``readonly`` discriminator as every other
    column: the app-owned agent is seeded with
    :data:`SEEDED_RESERVED_MAX_TOOL_ITERATION`, the editable built-ins with
    :data:`SEEDED_MAX_TOOL_ITERATION`.

    ``system_message`` is the whole text the agent is told, so the reserved mode's
    **generated** lot-conventions block rides in it. That is what lets the block
    stay defined in one place: the row is a copy refreshed from code on every
    boot, never a second text someone has to remember to edit.
    """
    defaults = importlib.import_module(appdb.AGENT_DEFAULTS_MODULE_NAME)
    modes = [*defaults.default_modes(), defaults.todo_builder_mode()]
    rows: List[Dict[str, Any]] = []
    for mode in modes:
        blocks = [mode.system_message, *mode.instructions]
        rows.append(
            {
                "id": mode.id,
                "label": mode.label,
                "max_tool_iteration": (
                    appdb.SEEDED_RESERVED_MAX_TOOL_ITERATION
                    if mode.readonly
                    else appdb.SEEDED_MAX_TOOL_ITERATION
                ),
                "mcp_enable": 1 if mode.mcptools else 0,
                "lsp_enable": 1 if mode.lsptools else 0,
                "system_message": "\n\n".join(b for b in blocks if b),
                "readonly": 1 if mode.readonly else 0,
            }
        )
    return rows


def _seed(conn: sqlite3.Connection, created: bool) -> Dict[str, Any]:
    """Bring the built-in rows into the store. Idempotent, and run every boot.

    Returns ``{"agents": {"inserted": n, "reasserted": n}, "promptHelpers": n}``
    — what this pass wrote, for the boot's log line.

    **Agents: inserted when absent, re-asserted when the *definition* says
    `readonly`.** A row that is already there and whose definition is editable is
    left alone entirely: it is either the user's own agent or a built-in whose
    persona they were allowed to edit, and a boot that overwrote it would undo
    work the app promised to keep. A ``readonly`` row gets every column except
    ``model_id`` rewritten from code, which is what makes re-seeding safe rather
    than destructive: the only thing on that row the user owns is which model it
    runs on. The decision reads the definition and not the stored flag, because
    for that row code *is* the source of truth — a hand-corrupted ``readonly = 0``
    is re-asserted rather than obeyed.

    **Helpers: only when this boot made the store.** "Is the table empty" is not
    the question — a user who deleted every bullet made the table empty, and a
    boot that refilled it would undo a delete the app promised to honour. The
    gate is :func:`prepare`'s ``created``, widened by :func:`boot` to cover a
    zero-byte file left between the exclusive create and the schema: that file
    holds no user data either, so it is still a first boot.

    **Servers and models are never seeded**: there is no example server, no
    placeholder key and no placeholder URL, because a value that cannot be
    dialled must not be inserted in order to be dialled.

    One transaction, so a boot either has the built-ins or has the store as it
    found it — a half-seeded store is the state where an agent's persona is
    today's and its label is last week's.
    """
    inserted = 0
    reasserted = 0
    for row in appdb._agent_definitions():
        existing = conn.execute(
            "SELECT 1 FROM agents WHERE id = ?", (row["id"],)
        ).fetchone()
        if existing is None:
            conn.execute(
                "INSERT INTO agents (id, label, max_tool_iteration, mcp_enable, "
                "lsp_enable, system_message, readonly, model_id) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, NULL)",
                (
                    row["id"],
                    row["label"],
                    row["max_tool_iteration"],
                    row["mcp_enable"],
                    row["lsp_enable"],
                    row["system_message"],
                    row["readonly"],
                ),
            )
            inserted += 1
        elif row["readonly"]:
            conn.execute(
                "UPDATE agents SET label = ?, max_tool_iteration = ?, "
                "mcp_enable = ?, lsp_enable = ?, system_message = ?, readonly = ? "
                "WHERE id = ?",
                (
                    row["label"],
                    row["max_tool_iteration"],
                    row["mcp_enable"],
                    row["lsp_enable"],
                    row["system_message"],
                    row["readonly"],
                    row["id"],
                ),
            )
            reasserted += 1
    helpers = 0
    if created:
        for _ in range(appdb.SEEDED_PROMPT_HELPER_COUNT):
            conn.execute(
                "INSERT INTO prompt_helpers (color_code, content) VALUES (?, '')",
                (appdb.SEEDED_PROMPT_HELPER_COLOR,),
            )
            helpers += 1
    return {
        "agents": {"inserted": inserted, "reasserted": reasserted},
        "promptHelpers": helpers,
    }
