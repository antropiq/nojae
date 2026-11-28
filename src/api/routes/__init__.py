"""REST + SSE endpoints for the WorkBench and the Editor.

This module is the **assembly**: it owns the one parent router — the prefix and
the one dependency every route runs inside — and includes the domain routers in
it. It also re-exports the seam, the state, the request models and the turn
helpers, so ``src.api.routes`` stays the module the tests import.
"""

from fastapi import APIRouter, Depends

from src.api.routes.agents import router as agents_router
from src.api.routes.batch import router as batch_router
from src.api.routes.chat import router as chat_router
from src.api.routes.config import router as config_router
from src.api.routes.connection import router as connection_router
from src.api.routes.fs import router as fs_router
from src.api.routes.hubs import router as hubs_router
from src.api.routes.prompt_helpers import router as prompt_helpers_router
from src.api.routes.terminal import router as terminal_router
from src.api.routes.wizard import router as wizard_router
from src.api.routes.workspace import router as workspace_router

# -- what this package re-exports -------------------------------------------
#
# ``src.api.routes`` stays the seam the tests import: the names below are read
# through it. The three modules at the end are the ones a patch is read *off*
# (``routes.appdb``, ``routes.agent_modes``, ``routes.httpx``), so they travel
# with the package, not just the names defined in it.
from src.api.routes.seam import (
    INSTALLATION_SCOPED_PATHS,
    WORKSPACE_QUERY,
    _workspace_scope,
    require_workspace,
    workspace_refusal,
)
from src.api.routes.state import (
    ChatHandle,
    _CHAT_HANDLES,
    _CHAT_TASKS,
    _arm_chat_handle,
    _chat_reply_handle,
    _chat_streaming_on,
    _clear_chat_handle,
    _refuse_if_chat_streaming,
    workspace_is_busy,
)
from src.api.routes.turn import (
    LSP_TOOL_TIMEOUT,
    MCP_TOOL_NAMES_KWARG,
    _allowed_server_ids,
    _active_connector_ids,
    _active_server_ids,
    _chat_tool_kwargs,
    _context_window,
    _lsp_tool_kwargs,
    _mcp_tool_kwargs,
    _model_ids,
    turn_can_open_a_file,
)
from src.api.routes.inputs import (  # noqa: F401 — the request models, re-exported
    AgentCreateIn,
    AgentDeleteIn,
    AgentFieldsMixin,
    AgentUpdateIn,
    ChatContentPart,
    ChatIn,
    ChatImageUrl,
    ChatMessage,
    FileCreateIn,
    FileMoveBatchIn,
    FileRenameIn,
    FileSaveIn,
    LspIn,
    LspQueryIn,
    MAX_CHAT_IMAGE_BYTES,
    McpIn,
    ModelCreateIn,
    ModelDeleteIn,
    ModelUpdateIn,
    PromptHelperCreateIn,
    PromptHelperDeleteIn,
    PromptHelperFields,
    PromptHelperUpdateIn,
    REASONING_LEVELS,
    SAMPLER_RANGES,
    SamplerFieldsMixin,
    ServerCreateIn,
    ServerDeleteIn,
    ServerIn,
    ServerUpdateIn,
    SettingsFieldsMixin,
    WizardPrepareIn,
    WizardProposeIn,
    _agent_field_sentence,
    _model_columns,
    _sampler_range_sentence,
)

from src.core import agent_modes  # noqa: F401 — patched through the package
from src.core import appdb  # noqa: F401 — patched through the package

import httpx  # noqa: F401 — patched through the package


def build_router() -> APIRouter:
    """Create the API router."""
    # The router's **one** dependency: every route under this prefix resolves the
    # ``workspace`` field of its request and answers inside that scope, so no
    # route can forget the field, spell its name, or enter the scope itself — not
    # even the terminal's WebSocket, which carries it in its query string.
    # Refusing is :func:`require_workspace`'s job, not this one's.
    router = APIRouter(prefix="/api", dependencies=[Depends(_workspace_scope)])

    # The settings store's own routes: the app bar's connection read, the
    # prompt-helper bullets, the servers and models, and the agents. Then the
    # Editor's: its file surface, the workspace read, its terminal, and the two
    # batch reads. Then the workspace's own tools, the connector wizard, and the
    # chat turn.
    router.include_router(config_router)
    router.include_router(prompt_helpers_router)
    router.include_router(connection_router)
    router.include_router(agents_router)
    router.include_router(fs_router)
    router.include_router(workspace_router)
    router.include_router(terminal_router)
    router.include_router(batch_router)
    router.include_router(hubs_router)
    router.include_router(wizard_router)
    router.include_router(chat_router)

    return router
