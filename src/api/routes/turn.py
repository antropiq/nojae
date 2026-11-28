"""What one chat turn may reach: the model it runs on, its tools."""

from typing import Any, Dict, List, Optional

import httpx

from src.config import max_tool_iteration
from src.core import agent_modes
from src.core.lsphub import all_servers
from src.core.mcphub import load_externals
from src.core.llmkit.client import models_url


def _model_ids(payload: Any) -> List[str]:
    """Extract model ids from an OpenAI-compatible /models payload."""
    data = payload.get("data") if isinstance(payload, dict) else None
    ids = [
        item["id"]
        for item in data or []
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    ]
    return sorted(set(ids))


# Last known context window per (models url, model id): success is cached
# indefinitely (n_ctx only changes with a server restart, which also flips the
# key), failures fall back to the stale value or None.
_CTX_WINDOW_CACHE: Dict[tuple, int] = {}


def _context_window(server_url: str, api_key: str, model: str) -> Optional[int]:
    """Context window (tokens) of the configured model, None when unknown.

    Reads ``meta.n_ctx`` from an OpenAI-compatible ``/models`` entry
    (llama.cpp exposes it); a server that omits it is not an error — the
    chat occupancy badge then just shows the used side without a limit.

    Only the entry whose ``id`` is this model counts: a name the server does
    not list answers None rather than crediting another model's window.
    """
    if not server_url.strip():
        return None
    url = models_url(server_url)
    key = (url, model)
    try:
        headers = {"Authorization": f"Bearer {api_key}"} if api_key else {}
        with httpx.Client(timeout=3.0) as client:
            response = client.get(url, headers=headers)
            response.raise_for_status()
            payload = response.json()
        data = payload.get("data") if isinstance(payload, dict) else None
        entries = [item for item in data or [] if isinstance(item, dict)]
        entry = next((item for item in entries if item.get("id") == model), None)
        meta = entry.get("meta") if entry else None
        n_ctx = meta.get("n_ctx") if isinstance(meta, dict) else None
        if isinstance(n_ctx, int) and n_ctx > 0:
            _CTX_WINDOW_CACHE[key] = n_ctx
            return n_ctx
    except (httpx.HTTPError, ValueError):
        pass
    return _CTX_WINDOW_CACHE.get(key)


def _active_connector_ids() -> List[str]:
    """Connector ids whose tools chat may use.

    The one gate is each connector's ``enable`` flag in the workspace's
    ``.nojae/mcp-settings.json`` — nothing else has to agree.
    """
    connectors, _errors = load_externals()
    return [connector["id"] for connector in connectors if connector["enable"]]


def _active_server_ids() -> List[str]:
    """Language-server ids whose tools chat may use.

    One gate decides: the entry's ``enable`` flag in the workspace's
    ``.nojae/lsp-settings.json``, the same rule :func:`_active_connector_ids`
    follows for MCP.

    Not to be confused with a request's ``lspEnabled``: that is the
    **conversation**-scoped allowlist the Tools panel holds, which only narrows
    the ids computed here (see :func:`_allowed_server_ids`).
    """
    servers, _errors = all_servers()
    return [server["id"] for server in servers if server["enable"]]


def _allowed_server_ids(enabled: Optional[List[str]]) -> List[str]:
    """The activated server ids, narrowed by a caller's allowlist.

    One implementation, shared by chat (``_lsp_tool_kwargs``) and the Editor
    pane's query route, so the two can never disagree about what "this server is
    switched on" means. The intersection keeps the declaration the authority: a
    stale id silently drops and a server whose ``enable`` flag is off can never
    leak back in. ``None`` means "no filter" — the failed-snapshot case, which
    must not blind the pane.
    """
    server_ids = _active_server_ids()
    if enabled is not None:
        allowed = set(enabled)
        server_ids = [server_id for server_id in server_ids if server_id in allowed]
    return server_ids


#: The key :func:`_mcp_tool_kwargs` records the admitted MCP tool names under,
#: for :func:`turn_can_open_a_file` alone. It is **not** a ``stream_chat``
#: keyword: the route pops it out of the merged dict before the splat — a key
#: left in would arrive as an unexpected keyword argument and break every
#: tool-capable turn.
MCP_TOOL_NAMES_KWARG = "mcp_tool_names"


def turn_can_open_a_file(tool_kwargs: Dict[str, Any]) -> bool:
    """Can this turn open a file at all?

    The skills catalogue is an instruction to *read a file*, so it is only ever
    issued when reading one is possible: the answer is yes exactly when at least
    one **MCP** tool survived the three admission gates into the turn's tool
    kwargs. MCP tools are this app's only file-reading surface; LSP tools answer
    queries only and never file bytes — so an LSP-only turn, a tools-off agent
    and a connector that is declared and enabled but never started all answer no.

    The verdict reads the names :func:`_mcp_tool_kwargs` recorded at admission
    rather than a name pattern, a tool count or a hub lookup: a second lookup
    could disagree with the first. The caller passes the kwargs **as the merge
    returned them**; the route pops the recorded key before ``stream_chat`` sees
    the dict.
    """
    return bool(tool_kwargs.get(MCP_TOOL_NAMES_KWARG))


def _mcp_tool_kwargs(
    manager: Any,
    enabled: Optional[List[str]] = None,
    agent: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """Extra ``stream_chat`` kwargs when MCP connectors are active for chat.

    ``manager`` is **this workspace's** connector manager — the one the turn's
    :class:`~src.core.hubpool.HubSet` holds, resolved once at the turn's start —
    or ``None`` when the workspace has none. It is handed in rather than looked up
    here because only the caller knows which folder the turn is about.

    ``enabled`` is the conversation-scoped connector allowlist from the chat
    body, intersected with the Settings-activated ids so Settings stays the
    authority — a connector deactivated there can never leak back into a running
    conversation. ``None`` means no filter. Returns ``{}`` when nothing is active,
    so the no-MCP call shape stays untouched. When tools *are* admitted the dict
    also carries :data:`MCP_TOOL_NAMES_KWARG`, which the route pops before
    ``stream_chat`` is called.

    ``agent`` is the row the turn resolved at its start, and it is where the
    tool-loop cap comes from — a per-agent column, so a save that lands mid-turn
    cannot move the number the loop is running with.
    """
    if manager is None:
        return {}
    connector_ids = _active_connector_ids()
    if enabled is not None:
        allowed = set(enabled)
        connector_ids = [cid for cid in connector_ids if cid in allowed]
    try:
        tools, tool_to_server = manager.active_tool_defs(connector_ids)
    except Exception:  # noqa: BLE001 — never block chat because of the hub
        return {}
    if not tools:
        return {}

    def tool_executor(name: str, arguments: Dict[str, Any]) -> str:
        return manager.call_tool_sync(tool_to_server[name], name, arguments)

    return {
        "tools": tools,
        "tool_executor": tool_executor,
        "tool_servers": tool_to_server,
        "max_tool_iterations": max_tool_iteration(agent),
        # The merged dict keeps no provenance, so the admission site is the only
        # place that can say which tools are MCP's. The route drops the key.
        MCP_TOOL_NAMES_KWARG: set(tool_to_server),
    }


# Chat-side budget for one LSP tool call: covers a lazy server's cold start
# (``initialize`` may take ``INIT_TIMEOUT`` while it indexes the project) plus
# the request and the diagnostics wait.
LSP_TOOL_TIMEOUT = 90.0


def _lsp_tool_kwargs(
    manager: Any, enabled: Optional[List[str]] = None
) -> Dict[str, Any]:
    """Extra ``stream_chat`` kwargs when language servers are active for chat.

    ``manager`` is this workspace's language-server manager, for the same reason
    :func:`_mcp_tool_kwargs` takes its own: which folder a turn is about is the
    caller's answer, not this one's.

    Same conversation-scoped filter as MCP: ``enabled`` is intersected with
    the Settings-activated ids, so a server disabled in Settings can never
    leak back into a running conversation. ``{}`` when nothing is active.
    """
    if manager is None:
        return {}
    server_ids = _allowed_server_ids(enabled)
    try:
        tools, tool_to_server = manager.active_tool_defs(server_ids)
    except Exception:  # noqa: BLE001 — never block chat because of the hub
        return {}
    if not tools:
        return {}

    def tool_executor(name: str, arguments: Dict[str, Any]) -> str:
        return manager.call_tool_sync(
            tool_to_server[name], name, arguments, timeout=LSP_TOOL_TIMEOUT
        )

    return {
        "tools": tools,
        "tool_executor": tool_executor,
        "tool_servers": tool_to_server,
    }


def _chat_tool_kwargs(
    hub_set: Any,
    mcp_enabled: Optional[List[str]] = None,
    lsp_enabled: Optional[List[str]] = None,
    mode: Optional[agent_modes.AgentMode] = None,
    agent: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """The single tool loop of ``stream_chat``, fed by both hubs.

    ``hub_set`` is **the turn's workspace's** :class:`~src.core.hubpool.HubSet`
    (or ``None``), resolved once at the turn's start like the agent's row and
    the connection: a turn's tools belong to the folder it was asked about, and
    they stay that folder's whatever another tab does to the pool afterwards.

    Three levels gate the tools that reach that loop and they only ever
    **intersect**: **Settings** (``_active_connector_ids`` /
    ``_active_server_ids``, the whole install), the **agent mode**
    (``mode.mcptools`` / ``mode.lsptools``, one hub) and the **conversation**
    (``mcp_enabled`` / ``lsp_enabled``, one connector). All three narrow the
    same allowlist, so Settings stays the authority and an open mode can never
    *grant* a connector the user unticked.

    The merge lives here (not in ``core/chat.py``): ``stream_chat`` keeps
    taking one ``tools`` list, one executor and one iteration cap, and the
    ``tool_servers`` map is what makes every tool call attributable to its
    hub in the Chat UI. MCP tools win a name clash (LSP tool names are
    namespaced, so in practice they cannot collide).

    ``mode=None`` means "no mode gate" and keeps the no-mode call shape
    byte-for-byte.

    ``agent`` is the row the turn resolved **at its start**, and the iteration
    cap rides with it: the number is a per-agent column, so the loop is bounded
    by what the agent said when the turn began and a save that lands mid-turn
    cannot move it.
    """
    # A mode with the flag false must take the hub away from the *model*, not
    # just from the prompt. ``[]`` — not ``None``, which is the "no filter"
    # sentinel on ``mcp_enabled``/``lsp_enabled``: passing ``None`` here would
    # open the hub wide. This is the one line to get wrong. The empty allowlist
    # makes both helpers return ``{}``, so ``stream_chat`` receives no ``tools``
    # key at all and no ``TOOL_NOTICE`` is appended.
    if mode is not None and not mode.mcptools:
        mcp_enabled = []
    if mode is not None and not mode.lsptools:
        lsp_enabled = []
    mcp_kwargs = _mcp_tool_kwargs(
        getattr(hub_set, "mcp", None), mcp_enabled, agent
    )
    lsp_kwargs = _lsp_tool_kwargs(getattr(hub_set, "lsp", None), lsp_enabled)
    if not mcp_kwargs and not lsp_kwargs:
        return {}
    if not lsp_kwargs:
        return mcp_kwargs
    if not mcp_kwargs:
        # LSP-only: every LSP tool is listed as uncapped, so an agent's LSP
        # round-trips are never bounded by ``max_tool_iterations`` (that knob is
        # MCP's). The cap value is still carried so the gauge's
        # ``maxIterations`` matches the agent's own value whenever it does move.
        return {**lsp_kwargs, "max_tool_iterations": max_tool_iteration(agent),
                "uncapped_tool_names": set(lsp_kwargs["tool_servers"])}

    tools = list(mcp_kwargs["tools"])
    tool_to_server = dict(mcp_kwargs["tool_servers"])
    for definition in lsp_kwargs["tools"]:
        name = definition["function"]["name"]
        if name in tool_to_server:
            continue
        tool_to_server[name] = lsp_kwargs["tool_servers"][name]
        tools.append(definition)
    mcp_executor = mcp_kwargs["tool_executor"]
    lsp_executor = lsp_kwargs["tool_executor"]
    lsp_tool_names = set(lsp_kwargs["tool_servers"])

    def tool_executor(name: str, arguments: Dict[str, Any]) -> str:
        if name in lsp_tool_names:
            return lsp_executor(name, arguments)
        return mcp_executor(name, arguments)

    return {
        "tools": tools,
        "tool_executor": tool_executor,
        "tool_servers": tool_to_server,
        "uncapped_tool_names": lsp_tool_names,
        "max_tool_iterations": max_tool_iteration(agent),
        # Carried through the merge so :func:`turn_can_open_a_file` still sees
        # the MCP admission. The route pops it before ``stream_chat`` is called.
        MCP_TOOL_NAMES_KWARG: mcp_kwargs[MCP_TOOL_NAMES_KWARG],
    }
