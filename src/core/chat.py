"""Streaming chat with the configured LLM.

Pure loop + event emission: takes an ``emit`` callable, no FastAPI or browser
concerns. Reasoning text streams as ``reasoning_delta`` frames while a single
``reasoning`` event flags that the model started thinking. It is never answer
text: it reaches neither ``token`` events nor the assistant message content
sent back to the model.

When ``tools`` and ``tool_executor`` are provided, the reply runs an
OpenAI-style tool-calling loop: each iteration streams the model, executes any
``tool_calls`` it produced via the injected executor, feeds the results back,
and repeats — up to ``max_tool_iterations`` — until a plain answer arrives.

A call that arrives as *text* instead of as a ``tool_calls`` delta is repaired
rather than ending the reply: the markup is kept out of the answer by
:class:`~src.core.tooltext.TextToolCallFilter`, fed back as a failed tool turn,
and the loop continues — see :data:`BAD_TOOL_CALL_MESSAGE`.
"""

import json
import math
import threading
import time
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from src.core.llm import (
    Emit,
    TRUNCATION_EVENT_FLAG,
    TRUNCATION_MESSAGE,
    _extract_reasoning,
    _extract_usage,
    close_llm_stream,
    safe_get_choice_content,
    saw_finish_reason,
)
from src.core.llmkit import another_attempt_may_help, stream_completion
from src.core.llmkit.sanitize import StreamNeutralizer, neutralize
from src.core.models import DEFAULT_LLM_SYSPROMPT
from src.core.tooltext import TextToolCallFilter
from src.core.utils import estimate_completion_tokens

# Executor bridge onto the MCP manager: name + args in, tool text out.
ToolExecutor = Callable[[str, Dict[str, Any]], str]

# Some tool-capable chat templates make models reluctant to call tools unless
# the prompt says they are available; appended only while tools are passed.
TOOL_NOTICE = (
    "\n\nYou can call the provided tools (browser/console) when they help "
    "answer the user."
)

# The generation-side twin of llmkit's input sanitizer. Sanitizing the prompt
# cannot help when the user asks *about* the control tokens: the model
# generates a raw run, the serving runtime tokenizes it as a single end-of-turn
# token, and the sampler cuts this very reply mid-sentence -- an EOG stop the
# app cannot flag as truncation, because at the chunk level it looks like a
# finished answer. The prevention that works is telling the model to cite the
# tokens by name or with spaced-out delimiter characters. A recorded break
# showed where it slips: prose follows the rule, then a fenced code block
# "showing the real thing" emits one -- so the notice names code fences and
# examples explicitly. Appended here and nowhere else, so a prompt built
# elsewhere carries none. The notice must never contain a raw run itself -- a
# test guards that with the sanitizer.
CONTROL_TOKEN_NOTICE = (
    "\n\nWhen discussing chat-template control tokens (im_start, im_end "
    "and their like), never write one in its raw delimiter-wrapped form: "
    "the serving template reads it as a turn boundary and cuts this very "
    "reply mid-sentence. This binds everywhere in the reply -- prose, code "
    "blocks, fenced examples, template renderings -- with no exemption "
    "for showing what the real thing looks like. Refer to them by name, "
    "or separate the delimiter characters with spaces (e.g. '< | im_start "
    "| >', and ' < | im_start | >user' inside a template example) so the "
    "text describes the token without becoming one."
)


def batch_instructions_block(text: str) -> str:
    """The lot's big picture rendered as a system-message block.

    Framed like AGENTS.md: the wrapper says this describes a lot worked through
    *one task at a time*, so a big-picture file reading "implement the editor
    tab" is context, not an instruction to do the whole lot in this turn.
    """
    return (
        "The following is the big-picture description of the task lot being "
        "worked through, one task at a time. It is context, not a task: do "
        "only the task you are asked for now.\n\n" + text.strip()
    )


def _collect_tool_call_deltas(chunk: Any, acc: Dict[int, Dict[str, Any]]) -> str:
    """Accumulate streamed tool-call deltas (they split across chunks).

    Returns the argument text this chunk carried ("" when it carries none):
    those fragments are generated tokens too, so the caller anchors the decode
    window on them and folds them into the char-based token estimate.
    """
    arg_text = ""
    deltas = None
    if isinstance(chunk, dict):
        delta = (chunk.get("choices") or [{}])[0].get("delta") or {}
        deltas = delta.get("tool_calls") if isinstance(delta, dict) else None
    for call in deltas or []:
        is_dict = isinstance(call, dict)
        index = (call.get("index") if is_dict else getattr(call, "index", None)) or 0
        entry = acc.setdefault(index, {"id": None, "name": "", "arguments": ""})
        call_id = call.get("id") if is_dict else getattr(call, "id", None)
        if call_id:
            entry["id"] = call_id
        function = call.get("function") if is_dict else getattr(call, "function", None)
        if function is None:
            continue
        name = function.get("name") if is_dict else getattr(function, "name", None)
        if name:
            entry["name"] += name
        arguments = (
            function.get("arguments") if is_dict else getattr(function, "arguments", None)
        )
        if arguments:
            entry["arguments"] += arguments
            arg_text += str(arguments)
    return arg_text


# The one id a text-shaped call round is reported under: the round produced no
# structured call, so no id came off the wire for it.
BAD_TOOL_CALL_ID = "bad-tool-call"

# What a reply whose tool call arrived as text is told back. The loop repairs
# the round instead of ending it, so the model gets the correction and the
# reply carries on in the same turn.
BAD_TOOL_CALL_MESSAGE = (
    "Your last tool call did not succeed: it arrived as text instead of as a "
    "tool call, so nothing was executed. Call one of the tools that were "
    "actually offered, submitting it as a real tool call rather than writing "
    "the call out in your answer."
)


def _tool_names(tools: Optional[List[Dict[str, Any]]]) -> Set[str]:
    """The tool names a round offered the model, in the wire's own shape."""
    names: Set[str] = set()
    for tool in tools or []:
        function = tool.get("function") if isinstance(tool, dict) else None
        name = function.get("name") if isinstance(function, dict) else None
        if isinstance(name, str) and name:
            names.add(name)
    return names


def _bad_tool_call_content(name: str, offered: Set[str]) -> str:
    """What one text-shaped call's tool turn answers with.

    A name the round *did* offer needs only to be resubmitted; one the model
    invented is told the names it actually had.
    """
    if name in offered:
        return (
            f"Error: the call to '{name}' arrived as text, so it was not "
            "executed. Retry it as a real tool call."
        )
    return (
        f"{BAD_TOOL_CALL_MESSAGE}\n\n"
        f"Tool '{name}' is not one of them. Available: "
        f"{', '.join(sorted(offered)) or 'none'}."
    )


def _preview(value: str, limit: int = 200) -> str:
    return value if len(value) <= limit else value[:limit] + "\n... [truncated]"


def _content_text(message: Dict[str, Any]) -> str:
    """Text of a message's content, "" for multimodal (list) content parts."""
    content = message.get("content", "")
    return content if isinstance(content, str) else ""


def _prompt_estimate(messages: List[Dict[str, Any]]) -> int:
    """Char-based (~4 chars/token) estimate of one round's prompt cost.

    Fallback for a round whose server reported no usage: the history at the
    round's start is what the request sends as prompt, so the figure is a floor
    — flagged through the estimated badge.
    """
    return estimate_completion_tokens("".join(_content_text(m) for m in messages))


def _emit_paused(
    emit: Emit,
    usage: Optional[Dict[str, Any]] = None,
) -> None:
    """Terminate a user-interrupted reply: optional usage, then the ack.

    ``usage`` is the cumulative figure the stream path still needs (its round is
    folded but never reported), so the badges read the server's numbers rather
    than the client's ~4 chars/token estimate. The tool-loop sites pass
    nothing: those figures went out as the pre-tool ``usage`` frame.
    """
    if usage is not None:
        emit({"event": "usage", **usage})
    emit({"event": "pause_ack", "partial": True})


# A wait is slept in slices, the cancel flag re-checked between them: that is
# what makes it interruptible, so a Stop costs at most one slice, never the
# seconds still to come.
WAIT_SLICE_SECONDS = 0.2

#: The sleep itself, as a module attribute so a test can record and skip it
#: rather than sleep the configured ten seconds; the wait's behaviour is then
#: asserted on the recorded slices, not on elapsed wall time.
_wait_slice = time.sleep


def _budget_pair(source: Optional[Callable[[], Any]]) -> Tuple[int, float]:
    """The ``(waits, seconds)`` a round may spend, read **now**.

    The source is the caller's own accessor rather than a number handed over at
    the turn's start, because the two keys are read when the retry decision is
    made. An answer this cannot use — the source raising, a pair that is not a
    pair, a non-numeric or negative value — reads as *no waiting*, so a mis-set
    budget can never itself become the reason a turn fails.
    """
    if source is None:
        return 0, 0.0
    try:
        pair = source()
        max_retry, wait_seconds = pair
        max_retry = int(max_retry)
        wait_seconds = float(wait_seconds)
    except (TypeError, ValueError):
        return 0, 0.0
    return max(max_retry, 0), max(wait_seconds, 0.0)


def _exhausted_failure_message(exc: BaseException, waits: int, waited: float) -> str:
    """The final error sentence once a round's whole budget is spent.

    The endpoint's own sentence verbatim — nothing here interprets it — with
    what the app already did appended, since that sentence alone would hide the
    fact that it tried. ``waits`` and ``waited`` are this round's, so the
    sentence carries both.
    """
    plural = "" if waits == 1 else "s"
    return (
        f"LLM call failed: {exc} "
        f"(waited {waited:.0f}s over {waits} further attempt{plural}; "
        "the model endpoint is still refusing)"
    )


def _wait_for_endpoint(
    wait_seconds: float,
    cancel_event: Optional[threading.Event],
) -> bool:
    """Sleep ``wait_seconds``, cutting short when Stop is asked for.

    Returns whether the wait ran its full length (``False`` = Stop landed in
    it). The flag is consulted after every slice, so a Stop costs at most one
    slice and none of the seconds still to come.

    ``pause_event`` is deliberately **not** consulted here: a Pause armed during
    a wait is answered where it always is — at the first chunk of the next
    successful round — so the wait keeps its full length. "Handle the pause here
    too" is the tempting wrong edit: pause means *interrupt the reply and keep
    what arrived*, and during a wait nothing has arrived to keep.
    """
    total = float(wait_seconds)
    if total <= 0:
        return True
    # The length divided into whole slices up front, rather than subtracted from
    # it in a loop: no rounding residue, so the slept seconds are exactly what
    # was announced.
    slice_count = max(1, math.ceil(total / WAIT_SLICE_SECONDS))
    for _ in range(slice_count):
        _wait_slice(total / slice_count)
        if cancel_event is not None and cancel_event.is_set():
            return False
    return True


def stream_chat(
    messages: List[Dict[str, Any]],
    model_name: str,
    server_url: str,
    emit: Emit,
    sampling: Optional[Dict[str, Any]] = None,
    cancel_event: Optional[threading.Event] = None,
    pause_event: Optional[threading.Event] = None,
    api_key: str = "none",
    sysprompt: Optional[str] = None,
    tools: Optional[List[Dict[str, Any]]] = None,
    tool_executor: Optional[ToolExecutor] = None,
    tool_servers: Optional[Dict[str, str]] = None,
    max_tool_iterations: int = 25,
    uncapped_tool_names: Optional[Set[str]] = None,
    agent_instructions: Optional[str] = None,
    skills_instructions: Optional[str] = None,
    mode_instructions: Optional[str] = None,
    batch_instructions: Optional[str] = None,
    retry_budget: Optional[Callable[[], Tuple[int, float]]] = None,
) -> None:
    """Stream one chat reply, emitting ``token`` / ``reasoning`` / ``done``.

    Message ``content`` may be a plain string or a list of OpenAI-style
    multimodal parts (``text`` / ``image_url`` data URLs); parts are passed
    through to the LLM client untouched.

    With tools active also emits ``tool_call`` / ``tool_result`` events per
    executed call (``tool_call`` carries ``iteration`` and ``maxIterations``
    for the UI gauge) plus a cumulative ``usage`` event as soon as each round
    stops generating — before the tool executes, so the badges tick when
    generation stops instead of waiting for the tool to return.

    ``decode`` is the sum of the per-round generation windows (tool-call
    argument deltas in, tool execution and inter-round re-prefill gaps out), so
    the client can compute an accurate tok/s. ``tokens``/``usage.tokens`` count
    **completion tokens only** (the tok/s numerator). ``contextTokens`` carries
    the LAST round's prompt + generation — the context-window occupancy figure,
    NOT summed across rounds — and ``contextEstimated`` flags a fallback
    estimate. ``waited`` is the seconds the turn spent waiting on a refused
    endpoint, summed over every round and ``0`` when it waited on nothing: a
    wait has no chunk arrival, so it enters neither ``decode`` nor the token
    rate, while ``took`` spans the whole request, waits included.

    Terminal event is exactly one of ``done``, ``error`` or ``pause_ack``
    (unless the call was cancelled — then the client is gone and nothing is
    emitted). ``pause_ack`` (``partial: True``) closes a reply the user
    interrupted through ``pause_event``; when the interrupted round has not
    been reported yet, a cumulative ``usage`` frame rides with the ack so the
    badges keep the server's exact figures. Precedence is cancel > error >
    pause — an ``error`` already emitted is never followed by an ack, and a
    pause arriving while a round was already finishing honestly still ends on
    ``done``. A pause never travels as a truncation: the interrupt closed the
    upstream stream, so no ``finish_reason`` was expected and the truncation
    check is skipped.

    ``agent_instructions`` (when non-empty) is appended to the system message
    after the configured prompt, so a conversation starts carrying the
    project's own instructions. It is a separate argument rather than
    pre-concatenated into ``sysprompt`` because ``TOOL_NOTICE`` is skipped when
    the prompt already mentions tools, and instruction files are full of the
    word — keeping them apart lets that check judge only the user's prompt.

    ``skills_instructions`` (when non-empty) is the catalogue of the skills this
    workspace and the user's home folder hold: name, what it is for, and the
    path of its file, so the turn starts knowing which know-how exists without
    reading any of it. ``""`` or an omitted argument means "nothing to inject".
    Nothing is cached here: the caller re-resolves the text per turn, so an
    edited skill shows up in the next message. It is separate for the same
    reason as every block here — the ``TOOL_NOTICE`` word check must judge
    prompt-like text only, and a catalogue is written for a model with tools.

    ``mode_instructions`` (an agent mode's own generated blocks) rides between
    the two below — text only; this function never learns what a mode is.

    ``batch_instructions`` (batch mode's lot big picture) is appended *after*
    the project instructions and the mode blocks, so the system message reads
    sysprompt → tool notice → control-token notice → AGENTS.md → skills → mode
    blocks → big picture: the project's rules stay closest to the conversation
    and the lot description — context, not a task — furthest. It is re-sent on
    every task turn because the per-task context reset means nothing else
    carries it.

    ``retry_budget`` is the **round** wait's budget source: a callable
    answering ``(waits, seconds)``, called at the moment a refused round is
    about to be waited on and never before. Omitting it, or a budget of ``0``
    waits, means one seam call per round and the plain error frame. When it
    allows a wait, a round whose seam call raises a **retryable** failure (the
    seam's own verdict, ``llmkit.another_attempt_may_help``) emits one
    non-terminal ``reconnecting`` event — ``attempt`` (1-based within this
    round), ``budget``, ``waitSeconds`` and the endpoint's own ``message`` —
    sleeps, and re-sends the identical request, so the turn still ends on its
    normal terminal frame and the batch loop reads an ordinary outcome. A final
    failure, and anything the seam does not recognise, ends the turn on the
    error frame at the first attempt. A mid-stream cut is never replayed: text
    already reached the panel, so only the seam *call* is guarded.
    """
    if not messages or messages[0].get("role") != "system":
        messages = [
            {"role": "system", "content": sysprompt or DEFAULT_LLM_SYSPROMPT},
            *messages,
        ]

    use_tools = bool(tools) and tool_executor is not None
    if use_tools and "tool" not in _content_text(messages[0]).lower():
        # Replace (never mutate) the caller's system message.
        messages[0] = {
            "role": "system",
            "content": _content_text(messages[0]) + TOOL_NOTICE,
        }
    # Every turn carries the control-token notice -- the danger is the model
    # generating a raw run, not the conversation carrying one. Placed after the
    # TOOL_NOTICE word check so its wording never reaches that heuristic.
    messages[0] = {
        "role": "system",
        "content": _content_text(messages[0]) + CONTROL_TOKEN_NOTICE,
    }
    if agent_instructions:
        # Appended last, so the notice heuristic above never sees the
        # instructions' own wording.
        messages[0] = {
            "role": "system",
            "content": _content_text(messages[0]) + "\n\n" + agent_instructions,
        }
    if skills_instructions:
        # Adjacent to AGENTS.md: both are standing reference material about this
        # folder, while the mode's blocks and the lot's big picture stay further
        # out. Separate from ``agent_instructions`` because the TOOL_NOTICE word
        # check must judge prompt-like text only, and a catalogue is a list of
        # things to open with a tool.
        messages[0] = {
            "role": "system",
            "content": _content_text(messages[0]) + "\n\n" + skills_instructions,
        }
    if mode_instructions:
        # The active mode's own standing instructions. Separate from
        # ``agent_instructions`` for the same reason as every block here.
        messages[0] = {
            "role": "system",
            "content": _content_text(messages[0]) + "\n\n" + mode_instructions,
        }
    if batch_instructions and batch_instructions.strip():
        # The lot's big picture closes the system message (see the docstring):
        # framed as context, so a model that reads "implement the editor tab"
        # in it does not start doing the whole lot on task 1.
        messages[0] = {
            "role": "system",
            "content": _content_text(messages[0])
            + "\n\n"
            + batch_instructions_block(batch_instructions),
        }
    sampling_kwargs: Dict[str, Any] = dict(sampling or {})

    t0 = time.monotonic()
    answer_buffer = ""
    # Every generated character (answer + reasoning + tool-call arguments): the
    # corpus for the char-based estimate when the server reports no usage.
    generated_chars = ""
    completion_tokens = 0
    # Sum of (total - prompt) per round, used only when no round reported
    # completion_tokens itself.
    usage_derived_completion = 0
    # Occupancy of the LAST round only: every round re-processes the history,
    # but only the latest figure says how full the context window is.
    context_tokens = 0
    context_estimated = False
    reasoning_emitted = False
    t_first: Optional[float] = None
    t_last: Optional[float] = None
    decode_seconds = 0.0
    # Seconds this turn spent waiting on a refused endpoint, summed over every
    # round's waits. A wait has no chunk arrival, so it enters no timing
    # accumulator above: it is a figure of its own for the terminal frame.
    waited_seconds = 0.0
    capped = False

    iteration = 0
    while True:
        # Prompt cost of this round, from the exact messages the request is
        # about to send — used only if the server reports no usable usage (a
        # floor: server-side template tokens are not in it, hence the flag).
        round_prompt_est = _prompt_estimate(messages)
        # The one retry site: this round's seam call, looped over the round's
        # own budget. A replay never reaches the chunk loop below, because a
        # refused call raises before a byte of the reply exists — which is why
        # both shapes of a mid-stream cut keep their paths untouched.
        round_waits = 0
        round_waited = 0.0
        while True:
            try:
                response_generator: Any = stream_completion(
                    model=model_name,
                    server_url=server_url,
                    messages=messages,
                    api_key=api_key,
                    sampling=sampling_kwargs,
                    # The client omits an empty/``None`` ``tools``, so a
                    # tool-less request still carries no ``tools`` key rather
                    # than ``[]``.
                    tools=tools if use_tools else None,
                )
                break
            except Exception as exc:
                # The seam owns the verdict: a final status, or an exception it
                # does not recognise, is the plain error path.
                if not another_attempt_may_help(exc):
                    emit({"event": "error", "message": f"LLM call failed: {exc}"})
                    return
                # The budget is read *here*, at the decision; ``_budget_pair``
                # turns a missing source into the feature switched off.
                waits_left, wait_seconds = _budget_pair(retry_budget)
                if round_waits >= waits_left:
                    message = (
                        _exhausted_failure_message(exc, round_waits, round_waited)
                        if round_waits
                        else f"LLM call failed: {exc}"
                    )
                    emit({"event": "error", "message": message})
                    return
                if cancel_event is not None and cancel_event.is_set():
                    # Stop arrived before this wait could be announced: end the
                    # turn the way a Stop during a stream ends one — the client
                    # is gone, so not even the wait's own frame goes out.
                    return
                # Announce the wait (the UI's only sign the turn is not stuck)
                # with the endpoint's own sentence verbatim, sleep, then re-send
                # the *identical* request: same ``messages`` object, model, URL,
                # key, sampling and tools. The wait re-arms nothing; the turn's
                # connection was resolved at its start.
                emit(
                    {
                        "event": "reconnecting",
                        "attempt": round_waits + 1,
                        "budget": waits_left,
                        "waitSeconds": wait_seconds,
                        "message": str(exc),
                    }
                )
                if not _wait_for_endpoint(wait_seconds, cancel_event):
                    # Stop landed inside the wait: nothing emitted, the partial
                    # turn discarded, none of the remaining seconds spent.
                    return
                round_waits += 1
                round_waited += wait_seconds
                # The turn's running total for the terminal frame; a wait enters
                # no other measurement, having produced no chunk arrival.
                waited_seconds += wait_seconds

        iteration_content = ""
        iteration_chars = ""
        iteration_completion = 0
        iteration_usage: Optional[Dict[str, Optional[int]]] = None
        iteration_usage_from_completion = False
        tool_calls: Dict[int, Dict[str, Any]] = {}
        iter_first: Optional[float] = None
        iter_last: Optional[float] = None
        paused = False
        # The display twin of the seam sanitizer: a token-shaped run can straddle
        # chunk borders, so what reaches the panels is filtered stream-by-stream,
        # never frame-by-frame. Raw text still feeds the accumulators and the
        # estimates -- measurement, not display.
        answer_display = StreamNeutralizer()
        reasoning_display = StreamNeutralizer()
        # Only while tools are offered: a call written as text rather than as a
        # `tool_calls` delta is held back here instead of painted, and its calls
        # are what the round is repaired with below.
        tool_text = TextToolCallFilter() if use_tools else None

        def flush_display() -> None:
            # Hand over what the filters held back before any terminal frame of
            # the round: a held benign partial (an unterminated delimiter) is
            # the user's text and must not vanish silently.
            left = reasoning_display.flush()
            if left:
                emit({"event": "reasoning_delta", "text": left})
            left = answer_display.flush()
            if left:
                emit({"event": "token", "text": left})
            # A text-shaped call that never closed was prose after all, so it
            # is released here like any other held partial.
            left = tool_text.flush() if tool_text is not None else ""
            if left:
                emit({"event": "token", "text": left})

        try:
            for chunk in response_generator:
                if cancel_event is not None and cancel_event.is_set():
                    close_llm_stream(response_generator)
                    return
                # Cancel wins over pause, checked first at every site; reasoning
                # and tool-call argument deltas ride this same loop, so one check
                # covers them too.
                if pause_event is not None and pause_event.is_set():
                    close_llm_stream(response_generator)
                    paused = True
                    break
                usage = _extract_usage(chunk)
                if usage is not None:
                    iteration_usage = usage
                    if usage["completion_tokens"]:
                        iteration_completion = usage["completion_tokens"]
                        iteration_usage_from_completion = True
                tool_args_text = _collect_tool_call_deltas(chunk, tool_calls)
                content = safe_get_choice_content(chunk) or ""
                reasoning = _extract_reasoning(chunk)
                if reasoning:
                    if not reasoning_emitted:
                        reasoning_emitted = True
                        emit({"event": "reasoning"})
                    shown = reasoning_display.feed(reasoning)
                    if shown:
                        emit({"event": "reasoning_delta", "text": shown})
                # All three delta kinds open and extend the decode window: they
                # are generated tokens too, so neither the thinking phase nor a
                # tool-call-only round looks free to the tok/s maths.
                if not content and not reasoning and not tool_args_text:
                    continue
                arrival = time.monotonic()
                if t_first is None:
                    t_first = arrival
                t_last = arrival
                if iter_first is None:
                    iter_first = arrival
                iter_last = arrival
                generated_chars += content + reasoning + tool_args_text
                iteration_chars += content + reasoning + tool_args_text
                if not content:
                    continue
                iteration_content += content
                answer_buffer += content
                shown = answer_display.feed(content)
                # Chained after the token filter, so a call is held back whole
                # whichever of the two would have painted part of it.
                if tool_text is not None:
                    shown = tool_text.feed(shown)
                if shown:
                    emit({"event": "token", "text": shown})
        except Exception as exc:
            flush_display()
            emit({"event": "error", "message": f"Stream error: {exc}"})
            return

        # The chunk loop is over for every path that reaches here; hand the
        # filters' held remainder over before any terminal or per-round frame.
        flush_display()

        # No chunk ever carried a finish_reason: the server cut this round short
        # (a disconnecting upstream behind llama.cpp does exactly this) and the
        # chunks of a cut answer look like the chunks of a finished one. Stop
        # here rather than falling through — a half-streamed tool call would be
        # executed with truncated arguments, blaming the model for a transport
        # cut, and the fragment would be re-posted as a finished turn. Checked
        # after the loop because the stream only records the reason while it is
        # iterated.
        #
        # A pause disqualifies that reading: the interrupt itself closed the
        # stream, so no finish_reason was ever expected, and a flag armed a
        # moment before the stream died is not a server cut either. Hence the
        # raced ordering is settled here rather than inside the loop: an
        # interrupted round always ends on the ack, and a round that finished
        # honestly (``done``) is never rewritten by a late flag.
        finish_seen = saw_finish_reason(response_generator)
        if (
            not paused
            and pause_event is not None
            and pause_event.is_set()
            and not finish_seen
        ):
            # The flag was armed while the last chunks were already arriving:
            # treat it as the interrupt that ended this round.
            paused = True
        if not paused and iteration_chars and not finish_seen:
            emit(
                {
                    "event": "error",
                    "message": TRUNCATION_MESSAGE,
                    TRUNCATION_EVENT_FLAG: True,
                }
            )
            return

        completion_tokens += iteration_completion
        if iter_first is not None and iter_last is not None:
            decode_seconds += iter_last - iter_first
        round_context_est = round_prompt_est + max(
            iteration_completion, estimate_completion_tokens(iteration_chars)
        )
        # This round's own prompt + generation, i.e. ``context_tokens``.
        round_estimated = False
        if iteration_usage is not None:
            total = iteration_usage.get("total_tokens")
            prompt = iteration_usage.get("prompt_tokens")
            if total:
                # The per-round total covers the full prompt plus generation:
                # the exact occupancy figure.
                round_context = total
            elif prompt:
                # Exact prompt without a total: add the completion, or its
                # char estimate — then flagged.
                round_context = prompt + (
                    iteration_completion
                    or estimate_completion_tokens(iteration_chars)
                )
                round_estimated = not iteration_completion
            else:
                # Prompt unseen: estimate it, and never present that as a
                # server-reported count.
                round_context = round_context_est
                round_estimated = True
            if not iteration_usage_from_completion and total and prompt:
                # Only a round that omitted completion_tokens contributes its
                # (total - prompt) delta: one that reported it is already
                # counted in completion_tokens.
                usage_derived_completion += max(total - prompt, 0)
        else:
            round_context = round_context_est
            round_estimated = True
        context_tokens = round_context
        context_estimated = round_estimated

        # A pause from inside the chunk loop ends the reply here: the round's
        # figures were just folded into the totals but no other frame reports
        # them, so the usage rides with the ack. Checked *before* the tool-loop
        # decision so a round interrupted mid tool-call stream never executes
        # it — the client cannot re-post a tool_calls turn, so it is dropped.
        if paused:
            _emit_paused(
                emit,
                {
                    "tokens": completion_tokens,
                    "decode": decode_seconds,
                    "contextTokens": context_tokens,
                    "contextEstimated": context_estimated,
                },
            )
            return

        # `tool_executor is None` only narrows for the type checker: use_tools
        # already implies the executor is set.
        if not use_tools or tool_executor is None:
            break

        # A round with no structured call may still have written one as text:
        # the serving runtime gives up on its parser at the first name it cannot
        # match, and the markup arrives as ordinary content. Repair that round
        # instead of ending the reply -- the display filter kept the call out of
        # the answer, so the panel never showed it, and a correction keeps the
        # reply running.
        text_calls = tool_text.calls if tool_text is not None else []
        if not tool_calls:
            if not text_calls:
                break
            iteration += 1
            emit(
                {
                    "event": "usage",
                    "tokens": completion_tokens,
                    "decode": decode_seconds,
                    "contextTokens": context_tokens,
                    "contextEstimated": context_estimated,
                }
            )
            offered = _tool_names(tools)
            emit(
                {
                    "event": "tool_call",
                    "id": BAD_TOOL_CALL_ID,
                    # No connector answered this one, so the badge names the
                    # call the model tried to make instead of a tool of ours.
                    "tool": _preview(
                        neutralize(", ".join(c["name"] for c in text_calls)), 80
                    ),
                    "server": "",
                    "argsPreview": "",
                    "iteration": iteration,
                    "maxIterations": max_tool_iterations,
                    # The panel's red badge, rather than a connector's badge.
                    "bad": True,
                }
            )
            # One tool turn per call written: OpenAI-style servers reject a
            # message list whose call ids were never answered.
            for index, call in enumerate(text_calls):
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": f"{BAD_TOOL_CALL_ID}-{index}",
                        "content": _bad_tool_call_content(call["name"], offered),
                    }
                )
            emit(
                {
                    "event": "tool_result",
                    "id": BAD_TOOL_CALL_ID,
                    "ok": False,
                    "preview": BAD_TOOL_CALL_MESSAGE,
                }
            )
            if cancel_event is not None and cancel_event.is_set():
                return
            if pause_event is not None and pause_event.is_set():
                _emit_paused(emit)
                return
            if iteration >= max_tool_iterations:
                capped = True
                break
            continue

        # A recovered round can mix both spellings: the structured calls execute,
        # and the text ones are answered too rather than left as orphans.
        stray_calls = text_calls

        # The cap is MCP's: a round using nothing but the uncapped tools named in
        # ``uncapped_tool_names`` does not advance it, so an agent chains as many
        # of those as it needs. A mixed round counts once; an all-uncapped round
        # leaves the gauge where it was.
        uncapped = uncapped_tool_names or set()
        if any(
            call["name"] not in uncapped for call in tool_calls.values()
        ):
            iteration += 1

        # Generation is over: report cumulative usage *before* executing the
        # tool(s) (which can take tens of seconds), so the badge ticks as soon
        # as generation stops -- and before the post-tool cancellation check,
        # so a stop during the tool run still leaves the exact figure.
        emit(
            {
                "event": "usage",
                "tokens": completion_tokens,
                "decode": decode_seconds,
                # Occupancy of the round that just ended (not cumulative):
                # what the server had in its window for that round.
                "contextTokens": context_tokens,
                "contextEstimated": context_estimated,
            }
        )
        messages.append(
            {
                "role": "assistant",
                "content": iteration_content or None,
                "tool_calls": [
                    {
                        "id": call["id"],
                        "type": "function",
                        "function": {"name": call["name"], "arguments": call["arguments"]},
                    }
                    for _, call in sorted(tool_calls.items())
                ],
            }
        )
        for _, call in sorted(tool_calls.items()):
            # A tool already running is allowed to finish (Stop covers the hard
            # case); only the *next* call is skipped. The figures went out as the
            # pre-tool ``usage`` frame, so the ack needs none of its own.
            if pause_event is not None and pause_event.is_set():
                _emit_paused(emit)
                return
            tool_name = call["name"]
            try:
                tool_args = json.loads(call["arguments"]) if call["arguments"] else {}
                invalid_json = None
            except json.JSONDecodeError as exc:
                tool_args = {}
                invalid_json = exc
            try:
                args_preview = json.dumps(tool_args, ensure_ascii=False)
            except (TypeError, ValueError):
                args_preview = str(tool_args)
            emit(
                {
                    "event": "tool_call",
                    "id": call["id"],
                    # Sanitized for the browser only: the executor and the
                    # re-posted message keep the raw text (the seam strips it
                    # on the next round).
                    "tool": neutralize(tool_name),
                    "server": (tool_servers or {}).get(tool_name, ""),
                    "argsPreview": _preview(neutralize(args_preview)),
                    "iteration": iteration,
                    "maxIterations": max_tool_iterations,
                }
            )
            if invalid_json is not None:
                # Return a clear error so the model self-corrects next iteration.
                result_text = (
                    f"Error: the arguments for '{tool_name}' are not valid JSON. "
                    f"Fix the syntax and retry. Details: {invalid_json}"
                )
                ok = False
            else:
                try:
                    result_text = tool_executor(tool_name, tool_args)
                    ok = True
                except Exception as exc:  # noqa: BLE001 — feed failure back to the model
                    result_text = f"Error calling {tool_name}: {exc}"
                    ok = False
            messages.append(
                {"role": "tool", "tool_call_id": call["id"], "content": result_text}
            )
            emit(
                {
                    "event": "tool_result",
                    "id": call["id"],
                    "ok": ok,
                    # Untrusted text rendered in the panel: the preview is
                    # run-free for the browser, the re-posted message is
                    # stripped at the seam.
                    "preview": _preview(neutralize(result_text), 400),
                }
            )
        # The text-shaped calls get an answer too, so no call id of the re-posted
        # history is left unanswered (a server rejects such a list). They are not
        # executed: the model is told to submit them properly instead.
        offered = _tool_names(tools)
        for index, call in enumerate(stray_calls):
            call_id = f"{BAD_TOOL_CALL_ID}-{index}"
            content = _bad_tool_call_content(call["name"], offered)
            messages.append(
                {"role": "tool", "tool_call_id": call_id, "content": content}
            )
            emit(
                {
                    "event": "tool_call",
                    "id": call_id,
                    "tool": _preview(neutralize(call["name"]), 80),
                    "server": "",
                    "argsPreview": "",
                    "iteration": iteration,
                    "maxIterations": max_tool_iterations,
                    "bad": True,
                }
            )
            emit(
                {
                    "event": "tool_result",
                    "id": call_id,
                    "ok": False,
                    "preview": _preview(neutralize(content), 400),
                }
            )
        if cancel_event is not None and cancel_event.is_set():
            return
        # A pause asked for during a tool run (which was allowed to finish)
        # lands here instead of starting another round. No usage frame: that
        # round's figures went out before the first tool executed.
        if pause_event is not None and pause_event.is_set():
            _emit_paused(emit)
            return
        if iteration >= max_tool_iterations:
            capped = True
            break

    if capped:
        note = (
            f"\n\n(maximum of {max_tool_iterations} tool iterations reached — stopping)"
        )
        answer_buffer += note
        emit({"event": "token", "text": note})

    took = (t_last or time.monotonic()) - t0
    ttft = t_first - t0 if t_first is not None else 0.0
    tokens_estimated = False
    if not completion_tokens:
        # Servers that omit completion_tokens still report total/prompt per
        # round, and the summed differences cover every tool round — the last
        # round's usage alone would keep only its own share.
        if usage_derived_completion:
            completion_tokens = usage_derived_completion
        else:
            # Char heuristic over everything generated: answer text, reasoning
            # and tool-call arguments alike.
            completion_tokens = estimate_completion_tokens(generated_chars)
            tokens_estimated = completion_tokens > 0

    emit({
        "event": "done",
        # The turn's whole span, ``t0`` to the last chunk arrival, so it includes
        # the endpoint waits. Do NOT subtract ``waited`` from it: the separate
        # field is what lets the UI tell "took 41 minutes" from "took 1 minute
        # and waited 40", with neither number re-derived.
        "took": took,
        "ttft": ttft,
        # Cumulative across all rounds — the tok/s denominator once tools ran
        # (took - ttft would wrongly include tool execution and inter-round
        # gaps). Equals took - ttft for a single round.
        "decode": decode_seconds,
        # Seconds waited on a refused endpoint, summed over every round's waits;
        # 0 when it waited on nothing, never omitted, so a client reads one
        # shape. A wait has no chunk arrival, so it enters neither ``decode``
        # nor the token rate.
        "waited": waited_seconds,
        "tokens": completion_tokens or 0,
        "tokensEstimated": tokens_estimated,
        # Occupancy of the FINAL round — what the server slotted into its
        # window, template and tool schemas included. It does not accumulate
        # across rounds, so it is the figure to compare against the server's
        # context window (``meta.n_ctx`` from /v1/models).
        "contextTokens": context_tokens,
        "contextEstimated": context_estimated,
    })
