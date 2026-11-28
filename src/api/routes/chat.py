"""The chat turn: one streamed reply, and the request that can pause it."""

import asyncio
import threading
from typing import Any, AsyncIterator, Dict

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse

from src.api.events import sse_format
from src.config import agent_instructions_block, network_fail_budget
from src.core import agent_modes
from src.core import skills as skills_core
from src.core.chat import stream_chat

from src.api.routes.config import _agent_row_for, _load_config
from src.api.routes.hubs import _acquire_hub_set_async
from src.api.routes.inputs import ChatIn
from src.api.routes.seam import require_workspace
from src.api.routes.state import (
    _CHAT_TASKS,
    _arm_chat_handle,
    _chat_reply_handle,
    _clear_chat_handle,
)
from src.api.routes.turn import (
    MCP_TOOL_NAMES_KWARG,
    _chat_tool_kwargs,
    turn_can_open_a_file,
)

# -- the chat routes ---------------------------------------------------------

router = APIRouter()


@router.post("/chat")
async def post_chat(body: ChatIn, request: Request) -> StreamingResponse:
    """Stream one chat reply from the turn's agent's model as SSE.

    **The turn resolves once, at its start**: the agent's row, the connection
    built from its model and server, and the tool-loop cap are all read *here*,
    before the worker is handed anything. A settings save that lands mid-turn
    therefore cannot split the reply that is streaming, which is what makes the
    store's write routes safe without the "refused while a chat reply streams"
    gate the Editor's writes carry.

    The sync LLM client runs in a worker thread feeding an ``asyncio.Queue``
    (project convention: sync client in a thread + ``emit``); the SSE generator
    polls the queue and disconnect, closing the upstream stream via
    ``cancel_event`` when the client goes away.

    While the reply streams, its events are also *pausable*: the handle
    registered here lets the pause route arm ``pause_event``, which
    ``core.chat.stream_chat`` checks at its next message boundary.

    **The turn is workspace-scoped**: the folder the request names is the one
    whose ``AGENTS.md`` is injected and whose tools are offered, so a folder
    that was named and refused is a 422 here rather than an answer about
    somebody else's project.

    **The reply occupies its workspace's slot, not the process's**: the pause
    handle and the in-flight bookkeeping are keyed by the folder this request
    named, so a turn on A neither blocks a write on B nor is paused by B's tab.
    Two workspaces therefore stream at the same time, and nothing here queues
    them.
    """
    # Asked first: a turn must not arm the pause handle for a workspace that
    # was refused, and the project-instructions block read below is the
    # scope this request entered.
    resolved = require_workspace(request)
    # The active agent mode contributes exactly two things to the system
    # message: its persona replaces the model's own ``sys_prompt``, and its
    # generated blocks append after AGENTS.md. It is resolved **per request**,
    # so a change lands on the *next* turn of an existing conversation, the
    # same way an AGENTS.md edit does.
    mode, _mode_findings = agent_modes.resolve_mode(body.agentMode)
    if mode is None:
        # Unknown id → 422 naming it, never a silent fall back to another
        # agent: the only way to reach here is a typo — in a stale tab after
        # a rename, or in a hand-made request — and a default would answer
        # the user's question with the wrong agent and no clue. The detail
        # lists what *is* available so the fix is in the message. (A *missing*
        # id never reaches here: the request model refuses it, because there
        # is no server-side default this branch could fall back to.) Raised
        # before the pause handle is armed and before the SSE generator
        # exists — a request that never streams must not own the handle a
        # later request needs.
        available = ", ".join(
            entry.id for entry in agent_modes.resolve_modes()["modes"]
        )
        raise HTTPException(
            status_code=422,
            detail=f"Unknown agent mode {body.agentMode!r}. "
                   f"Available: {available}",
        )
    # The **agent's row** is what says which model answers this turn: the mode
    # names the persona, and the store's row of the same id carries the
    # `model_id` and the cap — one table, so one lookup answers everything the
    # turn needs.
    agent = _agent_row_for(mode)
    config = _load_config(agent)
    models = config.model_list()
    if not models:
        raise HTTPException(status_code=400, detail="No models configured (ENDPOINT)")
    # An empty persona means "use the configured prompt" — the escape hatch
    # for an agent that wants the model's own prompt back.
    persona = mode.system_message or config.sysprompt

    messages = [m.payload() for m in body.messages]
    loop = asyncio.get_running_loop()
    queue: asyncio.Queue = asyncio.Queue()
    cancel_event = threading.Event()
    pause_event = threading.Event()
    # **The turn's tools are resolved once, at its start**, beside its agent
    # and its connection: the workspace's own set, admitted by this request
    # because a turn is the clearest possible sign that a tab is working on
    # that folder. A folder the pool cannot serve is refused here — before the
    # pause handle is armed — rather than running the turn with nobody's tools.
    hub_set, _built = await _acquire_hub_set_async(request)
    _arm_chat_handle(resolved.root, cancel_event, pause_event)
    # The same mode decides the hub gate: a mode whose flag is false
    # contributes no tool schemas to the request at all, so the persona and
    # the affordance can never disagree. Order of the three levels does not
    # matter — they intersect.
    tool_kwargs = _chat_tool_kwargs(
        hub_set, body.mcpEnabled, body.lspEnabled, mode=mode, agent=agent
    )
    # The skills catalogue is resolved **here** too — once, at the turn's
    # start — so a skill folder edited mid-turn cannot split this reply. The
    # gate is evaluated **before** the scan: a turn with no way to open a file
    # must not walk two folder trees and read every header it finds in order to
    # throw the result away, so a refusal forwards ``""`` and never touches the
    # file system. When it says yes, the scan and the render run now and are
    # never cached — the same freshness AGENTS.md has: edit a SKILL.md and the
    # next message sees it. No exception is caught around the scan: it cannot
    # raise over a damaged input, and the workspace seam cannot raise here — a
    # silent catch would turn a real bug into a turn that quietly has no
    # catalogue.
    skills_block = ""
    if turn_can_open_a_file(tool_kwargs):
        found_skills, _skill_findings = skills_core.scan()
        skills_block = skills_core.catalogue_block(found_skills)
    # The MCP names the gate read are the merge's own bookkeeping, not a
    # ``stream_chat`` keyword: out of the dict before the splat below, or
    # every tool-capable turn would arrive with an unexpected argument.
    tool_kwargs.pop(MCP_TOOL_NAMES_KWARG, None)

    def emit(event: Any) -> None:
        loop.call_soon_threadsafe(queue.put_nowait, event)

    async def pump() -> None:
        try:
            await asyncio.to_thread(
                stream_chat,
                messages,
                models[0],
                config.serverUrl,
                emit,
                config.to_kwargs(),
                cancel_event=cancel_event,
                pause_event=pause_event,
                api_key=config.apiKey or "none",
                # The mode's persona, or the configured prompt when the mode
                # declares none: the two are alternatives, never stacked.
                sysprompt=persona,
                # The wait's budget **accessor**, not its numbers: they are
                # read when a refused round is about to be waited on, never at
                # the turn's start, and ``core/`` reads no run configuration —
                # so the route hands over the reader, which answers this
                # process's boot flags. It is the *module* function, not this
                # route's local ``config``.
                retry_budget=network_fail_budget,
                # Keywords from here on: the flag pair is optional on
                # ``stream_chat``, so a stub may omit it (tests do).
                # Project instructions ride on the system message: when the
                # working location carries AGENTS.md, its text is appended
                # there so every conversation starts already knowing the
                # project's conventions.
                agent_instructions=agent_instructions_block(),
                # The skills catalogue rides beside it, as its own keyword and
                # **unconditionally**: ``""`` is already the "nothing to inject"
                # answer the other blocks use, so the gate above needs no
                # conditional shape here — and none may have one, because a
                # conditional is the shape a switch takes. The value is the
                # server's own decision, computed above from the tool set this
                # turn was already given, so no request body, stored row or
                # caller can ask for a catalogue or waive one.
                skills_instructions=skills_block,
                # The mode's generated blocks (only the reserved Todo builder
                # has any) join after them, and are passed only when present —
                # same conditional shape as ``batch_instructions`` below, so a
                # request whose mode has no blocks keeps the call shape the
                # existing chat tests stub.
                **({"mode_instructions": "\n\n".join(mode.instructions)}
                   if mode.instructions else {}),
                # The lot's big picture (batch mode only) rides alongside
                # the project instructions, never merged into ``sysprompt``:
                # that separation is what keeps the TOOL_NOTICE word check
                # judging only the prompt the user configured. It is passed
                # only when set, so a plain chat request keeps exactly the
                # call shape it always had.
                **({"batch_instructions": body.batchContext}
                   if body.batchContext else {}),
                **tool_kwargs,
            )
        except Exception as exc:  # noqa: BLE001 — surface any failure to the UI
            emit({"event": "error", "message": str(exc)})
        finally:
            emit(None)  # sentinel: worker finished

    task = asyncio.create_task(pump())
    # Keyed with the workspace, so the question the hub restarts ask is
    # "is a reply streaming *here*". The dict is also what keeps the task
    # alive: the event loop holds only weak references to bare tasks.
    _CHAT_TASKS[task] = resolved.root
    task.add_done_callback(lambda _done: _CHAT_TASKS.pop(task, None))

    async def event_stream() -> AsyncIterator[str]:
        seq = 0
        try:
            while True:
                if await request.is_disconnected():
                    return
                try:
                    item = await asyncio.wait_for(queue.get(), timeout=0.25)
                except asyncio.TimeoutError:
                    continue
                if item is None:
                    return
                yield sse_format(seq, item)
                seq += 1
                if item.get("event") in ("done", "error", "pause_ack"):
                    return
        finally:
            # Client gone (or terminal event): stop the worker thread,
            # which closes the upstream LLM stream.
            cancel_event.set()
            _clear_chat_handle(resolved.root, cancel_event)

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@router.post("/chat/pause", status_code=200)
async def post_chat_pause(request: Request) -> Dict[str, Any]:
    """Ask the one in-flight chat reply to stop at its next boundary.

    The worker closes the upstream stream, reports its exact usage and
    terminates the reply with ``pause_ack``, so the client keeps the partial
    turn in its history. Idempotent — a second call while the first is pending
    says so.

    The client sends this tab's workspace with it, so the handle read here is
    the one armed by a chat post naming the same folder: a reply streaming on
    another workspace is not this request's to stop.
    """
    resolved = require_workspace(request)
    handle = _chat_reply_handle(resolved.root)
    if handle is None:
        # A fact about **this** folder, named as such: another tab's reply
        # makes "no chat reply is streaming" false for the process but never
        # for the workspace this request asked about.
        raise HTTPException(
            status_code=409,
            detail=f"No chat reply is streaming on {resolved.root}",
        )
    if handle.pause_event.is_set():
        return {"paused": "pending"}
    handle.pause_event.set()
    return {"paused": "requested"}
