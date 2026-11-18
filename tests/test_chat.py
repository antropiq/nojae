"""Tests for the streaming chat core and the /api/chat SSE endpoint."""

import base64
import json
import math
import threading
import time
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Tuple

import httpx
import pytest
from fastapi.testclient import TestClient

from src.api import routes
from src.api.server import create_app
from src.core import agent_modes
from src.core import agent_modes_defaults as modes_defaults
from src.core import chat as chat_core
from src.core import skills
from src.core import workspace
from src.core.llmkit import LLMRequestError
from src.core.models import DEFAULT_LLM_SYSPROMPT, EndpointsConfig
#: ``workspace_params`` builds the field every workspace-scoped request names;
#: the two hub helpers hand a test's manager double to the **workspace's own**
#: set, which is the only place a hub lives now (clws-06).
from tests.conftest import NO_HUB, WorkspaceClient, set_workspace_hubs, workspace_params
# The chunk builders and the stream double come from ``tests/llmkit_fakes`` so
# the stubs and ``llmkit.client.ChatStream`` are held to one interface.
from tests.llmkit_fakes import (
    CLOSE_DELIM,
    OPEN_DELIM,
    FakeStream,
    content_chunk,
    finish_chunk,
    reasoning_chunk,
    special_token,
    tool_call_chunk,
    usage_chunk,
)


class TestStreamChatTruncation:
    """A server-cut reply must end on ``error``, not a tidy ``done``.

    Without this, a stream that ends with no finish_reason chunk (llama.cpp
    losing its upstream mid-generation) is indistinguishable from a finished
    answer: the UI would settle to idle with a half-finished task, and a
    half-streamed tool call would be executed with truncated arguments.
    """

    def _run(self, monkeypatch, generator, **kwargs):
        monkeypatch.setattr("src.core.chat.stream_completion", lambda **kw: generator)
        events = []
        chat_core.stream_chat(
            [{"role": "user", "content": "hi?"}],
            "model-a",
            "http://server:8080/v1",
            events.append,
            **kwargs,
        )
        return events

    def test_cut_reply_ends_on_error_not_done(self, monkeypatch):
        events = self._run(
            monkeypatch,
            FakeStream([content_chunk("half an "), content_chunk("answer")]),
        )
        assert [e["event"] for e in events][-1] == "error"
        assert events[-1]["message"] == chat_core.TRUNCATION_MESSAGE
        assert "done" not in [e["event"] for e in events]

    def test_completed_reply_still_ends_on_done(self, monkeypatch):
        events = self._run(
            monkeypatch,
            FakeStream([content_chunk("hi"), finish_chunk("stop")]),
        )
        assert events[-1]["event"] == "done"

    def test_plain_iterable_is_left_alone(self, monkeypatch):
        # Fails open: a stream shape that records nothing reads as finished.
        events = self._run(monkeypatch, iter([content_chunk("hi")]))
        assert events[-1]["event"] == "done"

    def test_cut_tool_call_is_not_executed(self, monkeypatch):
        # The dangerous case: a tool call whose arguments stopped streaming
        # would run with truncated JSON, and the model would be told its own
        # arguments were invalid — blaming it for a transport cut.
        executed = []
        chunk = {
            "choices": [
                {
                    "delta": {
                        "tool_calls": [
                            {
                                "index": 0,
                                "id": "call-1",
                                "function": {
                                    "name": "execute_command",
                                    "arguments": '{"command": "ls -l',
                                },
                            }
                        ]
                    }
                }
            ]
        }
        events = self._run(
            monkeypatch,
            FakeStream([chunk]),
            tools=[{"type": "function", "function": {"name": "execute_command"}}],
            tool_executor=lambda name, args: executed.append(name) or "ok",
        )
        assert executed == []
        assert not [e for e in events if e["event"] == "tool_call"]
        assert events[-1]["event"] == "error"

    def test_reasoning_only_cut_ends_on_error(self, monkeypatch):
        events = self._run(
            monkeypatch, FakeStream([reasoning_chunk("thinking…")])
        )
        assert events[-1]["event"] == "error"

    def test_empty_stream_is_not_flagged(self, monkeypatch):
        events = self._run(monkeypatch, FakeStream([]))
        assert events[-1]["event"] == "done"


class TestStreamChat:
    def _run(self, monkeypatch, chunks, cancel_event=None):
        monkeypatch.setattr(
            "src.core.chat.stream_completion", lambda **kwargs: iter(chunks)
        )
        events = []
        chat_core.stream_chat(
            [{"role": "user", "content": "hi?"}],
            "model-a",
            "http://server:8080/v1",
            events.append,
            cancel_event=cancel_event,
        )
        return events

    def test_emits_reasoning_once_then_tokens_then_done(self, monkeypatch):
        events = self._run(
            monkeypatch,
            [
                reasoning_chunk("thinking"),
                reasoning_chunk(" more"),
                content_chunk("Hel"),
                content_chunk("lo"),
                usage_chunk(prompt=5, completion=7, total=12),
            ],
        )
        names = [e["event"] for e in events]
        # The one-shot `reasoning` flag opens the phase, then every thinking
        # delta streams as its own `reasoning_delta` frame.
        assert names == [
            "reasoning",
            "reasoning_delta", "reasoning_delta",
            "token", "token",
            "done",
        ]
        assert [e["text"] for e in events if e["event"] == "reasoning_delta"] == [
            "thinking", " more",
        ]
        text = "".join(e["text"] for e in events if e["event"] == "token")
        assert text == "Hello"
        # Reasoning is never ANSWER text: it stays out of `token` frames and
        # out of the assistant turn fed back to the model.
        assert all("thinking" not in e["text"] for e in events if e["event"] == "token")
        assert events[0] == {"event": "reasoning"}  # flag carries no text
        done = events[-1]
        assert done["tokens"] == 7
        assert done["tokensEstimated"] is False
        # Single round: the occupancy figure is that round's total, exact.
        assert done["contextTokens"] == 12
        assert done["contextEstimated"] is False

    def test_context_estimated_from_prompt_when_server_reports_no_usage(
        self, monkeypatch,
    ):
        # No usage chunk at all: completion keeps its char estimate, and the
        # occupancy figure adds the char estimate of the prompt the request
        # carries (system prompt + user text) — flagged as estimated.
        from src.core.models import DEFAULT_LLM_SYSPROMPT
        from src.core.utils import estimate_completion_tokens

        events = self._run(monkeypatch, [content_chunk("Hello there")])
        done = events[-1]
        prompt_est = estimate_completion_tokens(
            DEFAULT_LLM_SYSPROMPT + chat_core.CONTROL_TOKEN_NOTICE + "hi?"
        )
        assert done["tokens"] == estimate_completion_tokens("Hello there")
        # Without usage the occupancy figure is the char-based round
        # estimate (prompt + estimated generation), flagged.
        assert done["contextTokens"] == prompt_est + done["tokens"]
        assert done["contextEstimated"] is True

    def test_context_prompt_exact_when_only_completion_is_estimated(
        self, monkeypatch,
    ):
        # prompt without completion or total: the exact prompt is kept, only
        # the generation share is char-estimated (flagged).
        events = self._run(
            monkeypatch,
            [content_chunk("abcd"), usage_chunk(prompt=40)],
        )
        done = events[-1]
        assert done["tokens"] == 1  # 4 chars / 4
        assert done["tokensEstimated"] is True
        assert done["contextTokens"] == 41
        assert done["contextEstimated"] is True

    def test_reasoning_deltas_open_and_extend_decode_window(self, monkeypatch):
        # t0, reasoning, reasoning, content — the usage-only chunk is not
        # timed. The window must start at the first reasoning delta, so tok/s
        # does not pretend thinking was free.
        clock = [0.0, 1.0, 2.0, 6.0]  # t0 + one arrival per generated chunk
        monkeypatch.setattr(
            "src.core.chat.time.monotonic", lambda: clock.pop(0)
        )
        events = self._run(
            monkeypatch,
            [
                reasoning_chunk("thinking"),
                reasoning_chunk(" more"),
                content_chunk("Hi"),
                usage_chunk(prompt=5, completion=9, total=14),
            ],
        )
        done = events[-1]
        assert clock == []
        assert done["ttft"] == 1.0  # first generated delta was reasoning
        assert done["took"] == 6.0
        assert done["tokens"] == 9  # completion usage counts reasoning tokens
        # Single round: the decode window equals took - ttft, thinking included.
        assert done["decode"] == 5.0

    def test_prepends_system_prompt(self, monkeypatch):
        from src.core.models import DEFAULT_LLM_SYSPROMPT

        captured = {}

        def fake_completion(**kwargs):
            captured.update(kwargs)
            return iter([])

        monkeypatch.setattr("src.core.chat.stream_completion", fake_completion)
        chat_core.stream_chat(
            [{"role": "user", "content": "hi"}], "m", "http://s/v1", lambda e: None
        )
        assert captured["messages"][0] == {
            "role": "system",
            # The standing app-owned notice rides every chat turn.
            "content": DEFAULT_LLM_SYSPROMPT + chat_core.CONTROL_TOKEN_NOTICE,
        }

    def test_configured_sysprompt_is_prepended(self, monkeypatch):
        captured = {}

        def fake_completion(**kwargs):
            captured.update(kwargs)
            return iter([])

        monkeypatch.setattr("src.core.chat.stream_completion", fake_completion)
        chat_core.stream_chat(
            [{"role": "user", "content": "hi"}], "m", "http://s/v1", lambda e: None,
            sysprompt="Answer concisely.",
        )
        assert captured["messages"][0] == {
            "role": "system",
            "content": "Answer concisely." + chat_core.CONTROL_TOKEN_NOTICE,
        }

    def test_existing_system_prompt_kept(self, monkeypatch):
        captured = {}

        def fake_completion(**kwargs):
            captured.update(kwargs)
            return iter([])

        monkeypatch.setattr("src.core.chat.stream_completion", fake_completion)
        chat_core.stream_chat(
            [{"role": "system", "content": "be nice"}, {"role": "user", "content": "hi"}],
            "m",
            "http://s/v1",
            lambda e: None,
        )
        # Kept as the base of the system message; the standing notice
        # still rides, appended after it.
        assert captured["messages"][0]["content"] == (
            "be nice" + chat_core.CONTROL_TOKEN_NOTICE
        )

    def test_agent_instructions_appended_to_the_system_message(self, monkeypatch):
        captured = {}

        def fake_completion(**kwargs):
            captured.update(kwargs)
            return iter([])

        monkeypatch.setattr("src.core.chat.stream_completion", fake_completion)
        chat_core.stream_chat(
            [{"role": "user", "content": "hi"}], "m", "http://s/v1", lambda e: None,
            sysprompt="Answer concisely.",
            agent_instructions="project root is /srv/proj\n\nuse pytest",
        )
        system = captured["messages"][0]
        assert system["role"] == "system"
        assert system["content"].startswith("Answer concisely.")
        assert system["content"].endswith("project root is /srv/proj\n\nuse pytest")

    def test_blank_agent_instructions_leave_the_prompt_untouched(self, monkeypatch):
        captured = {}

        def fake_completion(**kwargs):
            captured.update(kwargs)
            return iter([])

        monkeypatch.setattr("src.core.chat.stream_completion", fake_completion)
        chat_core.stream_chat(
            [{"role": "user", "content": "hi"}], "m", "http://s/v1", lambda e: None,
            sysprompt="Answer concisely.", agent_instructions="",
        )
        assert captured["messages"][0]["content"] == (
            "Answer concisely." + chat_core.CONTROL_TOKEN_NOTICE
        )

    def test_agent_instructions_do_not_suppress_the_tool_notice(self, monkeypatch):
        # Instruction files mention "tool" everywhere; the notice-skipping
        # heuristic must judge only the configured prompt, so passing the
        # instructions separately keeps the nudge alive.
        captured = {}

        def fake_completion(**kwargs):
            captured.update(kwargs)
            return iter([])

        monkeypatch.setattr("src.core.chat.stream_completion", fake_completion)
        chat_core.stream_chat(
            [{"role": "user", "content": "hi"}], "m", "http://s/v1", lambda e: None,
            sysprompt="Answer concisely.",
            tools=[{"type": "function", "function": {"name": "use_thing"}}],
            tool_executor=lambda name, args: "ok",
            agent_instructions="tools are documented in AGENTS.md",
        )
        system = captured["messages"][0]["content"]
        assert chat_core.TOOL_NOTICE.strip() in system
        assert system.endswith("tools are documented in AGENTS.md")

    # -- mode_instructions: the mode's own generated blocks (am-04) ----------

    def _captured_system(self, monkeypatch, **kwargs) -> str:
        captured = {}

        def fake_completion(**kw):
            captured.update(kw)
            return iter([])

        monkeypatch.setattr("src.core.chat.stream_completion", fake_completion)
        chat_core.stream_chat(
            [{"role": "user", "content": "hi"}], "m", "http://s/v1",
            lambda e: None, **kwargs,
        )
        return captured["messages"][0]["content"]

    def test_mode_instructions_are_appended_after_the_project_instructions(
        self, monkeypatch
    ):
        content = self._captured_system(
            monkeypatch,
            sysprompt="Answer concisely.",
            agent_instructions="project root is /srv/proj",
            mode_instructions="the lot conventions",
        )
        assert content == (
            "Answer concisely."
            + chat_core.CONTROL_TOKEN_NOTICE
            + "\n\nproject root is /srv/proj\n\nthe lot conventions"
        )

    def test_mode_instructions_are_no_op_when_absent_or_blank(self, monkeypatch):
        # The regression guard: for anyone who never touches the feature the
        # system message is byte-identical to the one chat produced before.
        plain = self._captured_system(
            monkeypatch, sysprompt="Answer concisely.",
            agent_instructions="Project root /x",
        )
        for blank in (None, ""):
            assert self._captured_system(
                monkeypatch, sysprompt="Answer concisely.",
                agent_instructions="Project root /x", mode_instructions=blank,
            ) == plain
        assert "conventions" not in plain

    def test_mode_instructions_do_not_suppress_the_tool_notice(self, monkeypatch):
        # Mirror of the agent_instructions case above: the blocks are appended
        # *after* the notice heuristic has run, so text about tools in them
        # cannot switch the notice off.
        content = self._captured_system(
            monkeypatch,
            sysprompt="Answer concisely.",
            tools=[{"type": "function", "function": {"name": "use_thing"}}],
            tool_executor=lambda name, args: "ok",
            mode_instructions="the tools here write files in todos/",
        )
        assert chat_core.TOOL_NOTICE.strip() in content
        assert content.endswith("the tools here write files in todos/")

    def test_a_persona_that_already_offers_tools_gets_no_notice(self, monkeypatch):
        # The persona arrives as ``sysprompt``, so the existing word check
        # judges it: a mode whose own text already speaks of tools needs no
        # nudge, and ``mode_instructions`` below cannot talk it out of one.
        content = self._captured_system(
            monkeypatch,
            sysprompt="Use the tools to prove the change.",
            tools=[{"type": "function", "function": {"name": "use_thing"}}],
            tool_executor=lambda name, args: "ok",
        )
        assert content.count(chat_core.TOOL_NOTICE.strip()) == 0
        assert content.startswith("Use the tools")

    def test_six_part_order_is_persona_notice_agents_skills_mode_lot(self, monkeypatch):
        # Extended by skl-04: §5.16 puts the skills catalogue between AGENTS.md
        # and the mode's blocks, so this is the order the signature spells too
        # (pinned by the case below).
        content = self._captured_system(
            monkeypatch,
            sysprompt="PERSONA.",
            tools=[{"type": "function", "function": {"name": "use_thing"}}],
            tool_executor=lambda name, args: "ok",
            agent_instructions="AGENTS_MD_BLOCK",
            skills_instructions="SKILLS_CATALOGUE",
            mode_instructions="MODE_BLOCKS",
            batch_instructions="LOT_BIG_PICTURE",
        )
        order = [
            content.index("PERSONA."),
            content.index(chat_core.TOOL_NOTICE.strip()),
            content.index("AGENTS_MD_BLOCK"),
            content.index("SKILLS_CATALOGUE"),
            content.index("MODE_BLOCKS"),
            content.index("LOT_BIG_PICTURE"),
        ]
        assert order == sorted(order)
        assert len(set(order)) == 6

    def test_a_blank_skills_block_leaves_the_system_content_untouched(
        self, monkeypatch
    ):
        # The regression guard for the new rail position: for anyone whose turn
        # has no catalogue, the system message is byte-identical to the one chat
        # produced before this block existed.
        plain = self._captured_system(
            monkeypatch,
            sysprompt="Answer concisely.",
            agent_instructions="Project root /x",
            mode_instructions="MODE BLOCKS",
        )
        for blank in (None, ""):
            assert self._captured_system(
                monkeypatch,
                sysprompt="Answer concisely.",
                agent_instructions="Project root /x",
                skills_instructions=blank,
                mode_instructions="MODE BLOCKS",
            ) == plain
        assert "Skills" not in plain

    def test_the_block_adds_no_event_to_the_stream(self, monkeypatch):
        # The catalogue is text decided before the worker starts: it adds no
        # frame and no terminal path. One real stream with the block present
        # still closes on exactly one ``done``.
        monkeypatch.setattr(
            "src.core.chat.stream_completion",
            lambda **kw: FakeStream([content_chunk("hi"), finish_chunk("stop")]),
        )
        events: List[Dict[str, Any]] = []
        chat_core.stream_chat(
            [{"role": "user", "content": "hi"}], "m", "http://s/v1", events.append,
            skills_instructions="SKILLS_CATALOGUE",
        )
        assert [e["event"] for e in events][-1] == "done"
        assert len([e for e in events
                    if e["event"] in ("done", "error", "pause_ack")]) == 1

    def test_a_catalogue_full_of_the_word_tool_does_not_silence_the_notice(
        self, monkeypatch
    ):
        # §5.17's reason for the separate argument, asserted on the block itself:
        # the catalogue is a list of things to open *with a tool*, and it is
        # appended after the word check, so it cannot talk the notice out of
        # existing.
        content = self._captured_system(
            monkeypatch,
            sysprompt="Answer concisely.",
            tools=[{"type": "function", "function": {"name": "use_thing"}}],
            tool_executor=lambda name, args: "ok",
            skills_instructions="SKILLS: read these tools with your tools",
        )
        assert chat_core.TOOL_NOTICE.strip() in content
        assert content.endswith("SKILLS: read these tools with your tools")

    def test_stream_chat_never_learns_what_a_mode_is(self):
        """The seam: this module takes text, so its callers stay mode-blind."""
        import inspect

        source = inspect.getsource(chat_core)
        assert "agent_modes" not in source
        assert "mode_instructions" in source
        names = list(inspect.signature(chat_core.stream_chat).parameters)
        assert "mode" not in names
        assert names.index("agent_instructions") < names.index("skills_instructions")
        assert names.index("skills_instructions") < names.index("mode_instructions")
        assert names.index("mode_instructions") < names.index("batch_instructions")

    def test_call_failure_emits_error(self, monkeypatch):
        def boom(**kwargs):
            raise RuntimeError("down")

        monkeypatch.setattr("src.core.chat.stream_completion", boom)
        events = []
        chat_core.stream_chat([{"role": "user", "content": "hi"}], "m", "http://s", events.append)
        assert [e["event"] for e in events] == ["error"]
        assert "down" in events[0]["message"]

    def test_cancel_stops_without_done(self, monkeypatch):
        cancel = threading.Event()
        cancel.set()
        stream = FakeStream([content_chunk("x")])
        monkeypatch.setattr(
            "src.core.chat.stream_completion", lambda **kwargs: stream
        )
        events = []
        chat_core.stream_chat(
            [{"role": "user", "content": "hi"}], "m", "http://s", events.append,
            cancel_event=cancel,
        )
        assert events == []
        # The stream owns its own teardown now, so this is the assertion that
        # the cancel path reaches it: one ``close()`` on the stream itself.
        assert stream.close_calls == 1

    def test_cancel_close_errors_are_swallowed(self, monkeypatch):
        cancel = threading.Event()
        cancel.set()
        # The double is deliberately stricter than ``ChatStream.close()`` (which
        # never raises): only a close that really fails exercises the
        # best-effort wrapper on the cancel path.
        monkeypatch.setattr(
            "src.core.chat.stream_completion",
            lambda **kwargs: FakeStream(
                [content_chunk("x")],
                close_error=RuntimeError("socket already gone"),
            ),
        )
        events = []
        chat_core.stream_chat(
            [{"role": "user", "content": "hi"}], "m", "http://s", events.append,
            cancel_event=cancel,
        )
        assert events == []

    def test_estimates_tokens_without_usage(self, monkeypatch):
        events = self._run(monkeypatch, [content_chunk("hello world!!!")])
        done = events[-1]
        assert done["event"] == "done"
        assert done["tokens"] == 4
        assert done["tokensEstimated"] is True

    def test_char_estimate_covers_reasoning_text(self, monkeypatch):
        # No usage at all: the ~4 chars/token fallback must count the
        # reasoning deltas too (they were generated tokens), not just answer
        # text: 8 reasoning chars + "hi" = 10 chars -> 3 tokens.
        events = self._run(
            monkeypatch,
            [reasoning_chunk("thinking"), content_chunk("hi")],
        )
        done = events[-1]
        assert done["tokens"] == 3
        assert done["tokensEstimated"] is True

    def test_total_minus_prompt_derived_across_rounds_without_completion(
        self, monkeypatch,
    ):
        # A server that omits completion_tokens but reports total/prompt per
        # request: without tools the single usage chunk still yields total -
        # prompt, not flagged as estimated.
        events = self._run(
            monkeypatch,
            [content_chunk("hi"), usage_chunk(prompt=5, total=12)],
        )
        done = events[-1]
        assert done["tokens"] == 7
        assert done["tokensEstimated"] is False

    def test_multimodal_content_passed_through_untouched(self, monkeypatch):
        captured = {}

        def fake_completion(**kwargs):
            captured.update(kwargs)
            return iter([])

        monkeypatch.setattr("src.core.chat.stream_completion", fake_completion)
        parts = [
            {"type": "text", "text": "describe"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAA="}},
        ]
        chat_core.stream_chat(
            [{"role": "user", "content": parts}], "m", "http://s/v1", lambda e: None
        )
        # Only the system message is prepended; the multimodal parts are
        # handed to the seam's ``messages`` as-is (the body they land in is
        # asserted once in ``tests/test_llmkit_client.py``).
        assert captured["messages"][1] == {"role": "user", "content": parts}


class TestARefusedRoundWaits:
    """A round the endpoint refused waits and re-sends (spec §5).

    Two things hold across the class. The failures are the seam's **own** shapes
    — :class:`LLMRequestError` for a refused status, an ``httpx`` transport error
    for a connect/read failure — because the guard acts on the seam's verdict on
    those types, never on a sentence (task 02). And the wait's sleep is patched
    (``chat_core._wait_slice``), so the numbers asserted here are recorded slice
    lengths and call counts: no case here sleeps anything like the configured ten
    seconds.
    """

    #: The budget a case hands the guard unless it says otherwise: 3 waits of
    #: 10 seconds — the two keys' default values, stated here rather than read
    #: from the environment.
    BUDGET: Tuple[int, float] = (3, 10)

    def _run(self, monkeypatch, refusals,
             *, budget: Tuple[int, float] = BUDGET,
             budget_source: Optional[Callable[[], Tuple[int, float]]] = None,
             chunks=None, during_wait: Optional[Callable[[], None]] = None,
             **kwargs):
        """One turn over a seam that refuses ``refusals`` times, then answers.

        ``chunks`` are the frames of the stream it answers with once it stops
        refusing; ``during_wait`` is called inside the first slept slice, which
        is how a case arms Stop or Pause *during* a wait; ``budget_source``
        replaces the accessor the guard reads, for the case that watches *when*
        it reads it. Returns the events, the captured seam calls, and the wait
        slices the guard slept.
        """
        calls: List[Dict[str, Any]] = []
        slept: List[float] = []
        pending = list(refusals)
        frames = list(chunks or [])
        source: Callable[[], Tuple[int, float]] = budget_source or (
            lambda: budget
        )

        def seam(**kw):
            calls.append(dict(kw))
            if pending:
                raise pending.pop(0)
            return FakeStream(frames)

        def sleep_slice(seconds: float) -> None:
            slept.append(seconds)
            if during_wait is not None:
                during_wait()

        monkeypatch.setattr("src.core.chat.stream_completion", seam)
        monkeypatch.setattr(chat_core, "_wait_slice", sleep_slice)
        events: List[Dict[str, Any]] = []
        chat_core.stream_chat(
            [{"role": "user", "content": "hi?"}],
            "model-a",
            "http://server:8080/v1",
            events.append,
            retry_budget=source,
            **kwargs,
        )
        return events, calls, slept

    @staticmethod
    def _refused(status: int) -> LLMRequestError:
        """One refused round, built from the seam's error type and its status."""
        return LLMRequestError(
            status=status,
            message="Bad Gateway",
            url="http://server:8080/v1/chat/completions",
        )

    @staticmethod
    def _terminal(events: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        return [e for e in events if e["event"] in ("done", "error", "pause_ack")]

    @staticmethod
    def _slices(wait_seconds: float, times: int = 1) -> List[float]:
        """The slices ``times`` waits of ``wait_seconds`` are slept in.

        A wait is slept as ``ceil(wait / WAIT_SLICE_SECONDS)`` equal slices, the
        flag re-checked between them so a Stop can cut it (spec §5.7) — so the
        assertions here name that shape, and stay right whatever the slice
        length is set to.
        """
        per_wait = max(1, math.ceil(wait_seconds / chat_core.WAIT_SLICE_SECONDS))
        slice_seconds = wait_seconds / per_wait
        return [slice_seconds] * (per_wait * times)

    # -- the replay ----------------------------------------------------------

    def test_two_refusals_then_an_answer_completes_the_turn(self, monkeypatch):
        events, calls, slept = self._run(
            monkeypatch,
            [self._refused(502), self._refused(503)],
            chunks=[content_chunk("answer"), finish_chunk("stop")],
        )
        assert len(calls) == 3
        assert slept == self._slices(10, 2)
        assert [e["event"] for e in events] == [
            "reconnecting", "reconnecting", "token", "done",
        ]
        # ``reconnecting`` is a *progress* event: the turn still closes with
        # exactly one terminal frame, and it is the normal one.
        assert self._terminal(events) == [events[-1]]

    def test_a_replay_sends_the_identical_request(self, monkeypatch):
        _events, calls, _slept = self._run(
            monkeypatch,
            [self._refused(502), self._refused(502)],
            chunks=[content_chunk("answer"), finish_chunk("stop")],
        )
        # A pure replay (spec §2): every argument of the failed attempt again —
        # and the *same* ``messages`` object, so nothing was rebuilt. The wait
        # re-arms nothing: not the connection, not the tools (spec §5.9).
        assert calls[0] == calls[1] == calls[2]
        assert calls[0]["messages"] is calls[2]["messages"]
        assert calls[0]["model"] == "model-a"
        assert calls[0]["server_url"] == "http://server:8080/v1"

    def test_each_wait_is_announced_with_the_pinned_fields(self, monkeypatch):
        events, _calls, _slept = self._run(
            monkeypatch,
            [self._refused(502)] * 3,
            budget=(3, 7),
            chunks=[content_chunk("late but fine"), finish_chunk("stop")],
        )
        waits = [e for e in events if e["event"] == "reconnecting"]
        # ``attempt`` is 1-based *within the round*, ``budget`` the key's value:
        # three waits of a budget of 3, so the label can read 1/3, 2/3, 3/3.
        assert [e["attempt"] for e in waits] == [1, 2, 3]
        assert [e["budget"] for e in waits] == [3, 3, 3]
        assert [e["waitSeconds"] for e in waits] == [7, 7, 7]
        # The endpoint's own sentence, verbatim — nothing here re-words it.
        assert [e["message"] for e in waits] == [str(self._refused(502))] * 3
        assert "HTTP 502" in waits[0]["message"]
        assert set(waits[0]) == {
            "event", "attempt", "budget", "waitSeconds", "message",
        }

    def test_the_budget_is_read_at_the_decision_not_at_the_turn_start(
        self, monkeypatch
    ):
        reads: List[int] = []

        def accessor():
            reads.append(1)
            return (3, 4)

        # A round that is never refused never reads it at all.
        _events, calls, slept = self._run(
            monkeypatch, [], budget_source=accessor,
            chunks=[content_chunk("ok"), finish_chunk("stop")],
        )
        assert len(calls) == 1 and slept == [] and reads == []
        # A refused round reads it once, at the failure, and the wait plus its
        # frame carry what the accessor answered *then*.
        events, _calls, slept = self._run(
            monkeypatch, [self._refused(502)], budget_source=accessor,
            chunks=[content_chunk("ok"), finish_chunk("stop")],
        )
        assert reads == [1]
        assert slept == self._slices(4)
        assert events[0]["waitSeconds"] == 4

    # -- what never waits ----------------------------------------------------

    @pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
    def test_a_final_status_fails_on_the_first_attempt(self, monkeypatch, status):
        events, calls, slept = self._run(
            monkeypatch, [self._refused(status)],
            chunks=[content_chunk("never"), finish_chunk("stop")],
        )
        assert len(calls) == 1
        assert slept == []
        assert [e["event"] for e in events] == ["error"]
        # Today's wording, untouched.
        assert events[0]["message"] == f"LLM call failed: {self._refused(status)}"

    def test_an_unrecognised_exception_is_final(self, monkeypatch):
        events, calls, slept = self._run(
            monkeypatch, [RuntimeError("a bug of ours")],
            chunks=[content_chunk("never"), finish_chunk("stop")],
        )
        assert len(calls) == 1
        assert slept == []
        assert [e["event"] for e in events] == ["error"]
        assert events[0]["message"] == "LLM call failed: a bug of ours"

    def test_a_connect_failure_does_wait(self, monkeypatch):
        """The other retryable half: no answer at all, and no byte streamed."""
        events, calls, slept = self._run(
            monkeypatch, [httpx.ConnectError("connection refused")],
            chunks=[content_chunk("back up"), finish_chunk("stop")],
        )
        assert len(calls) == 2
        assert slept == self._slices(10)
        assert [e["event"] for e in events] == ["reconnecting", "token", "done"]

    def test_a_budget_of_zero_is_today_behaviour_exactly(self, monkeypatch):
        events, calls, slept = self._run(
            monkeypatch, [self._refused(502)], budget=(0, 10),
            chunks=[content_chunk("never"), finish_chunk("stop")],
        )
        assert len(calls) == 1
        assert slept == []
        assert [e["event"] for e in events] == ["error"]
        assert events[0]["message"] == f"LLM call failed: {self._refused(502)}"

    def test_a_caller_that_passes_no_budget_never_waits(self, monkeypatch):
        # The keyword is optional: every existing caller and every stub that
        # omits it keeps the old behaviour, which is the guard switched off.
        def seam(**kw):
            raise self._refused(502)

        monkeypatch.setattr("src.core.chat.stream_completion", seam)
        events: List[Dict[str, Any]] = []
        chat_core.stream_chat(
            [{"role": "user", "content": "hi?"}], "m", "http://s/v1", events.append,
        )
        assert [e["event"] for e in events] == ["error"]
        assert events[0]["message"] == f"LLM call failed: {self._refused(502)}"

    # -- a cut stream is not a refused round (spec §5.4) ---------------------

    def test_a_stream_that_dies_mid_read_is_not_replayed(self, monkeypatch):
        calls: List[Dict[str, Any]] = []
        slept: List[float] = []

        def seam(**kw):
            calls.append(dict(kw))
            return FakeStream(
                [content_chunk("half an "), content_chunk("answer")],
                error_after=1,
                error=ConnectionError("the server cut the stream"),
            )

        monkeypatch.setattr("src.core.chat.stream_completion", seam)
        monkeypatch.setattr(chat_core, "_wait_slice", lambda s: slept.append(s))
        events: List[Dict[str, Any]] = []
        chat_core.stream_chat(
            [{"role": "user", "content": "hi?"}], "m", "http://s/v1", events.append,
            retry_budget=lambda: self.BUDGET,
        )
        # Text already reached the panel: a replay would duplicate it.
        assert len(calls) == 1
        assert slept == []
        assert [e for e in events if e["event"] == "reconnecting"] == []
        assert [e["event"] for e in events][-1] == "error"
        assert events[-1]["message"].startswith("Stream error:")

    def test_a_stream_with_no_finish_reason_is_not_replayed(self, monkeypatch):
        calls: List[Dict[str, Any]] = []
        slept: List[float] = []

        def seam(**kw):
            calls.append(dict(kw))
            return FakeStream([content_chunk("half an answer")])

        monkeypatch.setattr("src.core.chat.stream_completion", seam)
        monkeypatch.setattr(chat_core, "_wait_slice", lambda s: slept.append(s))
        events: List[Dict[str, Any]] = []
        chat_core.stream_chat(
            [{"role": "user", "content": "hi?"}], "m", "http://s/v1", events.append,
            retry_budget=lambda: self.BUDGET,
        )
        assert len(calls) == 1
        assert slept == []
        assert events[-1]["message"] == chat_core.TRUNCATION_MESSAGE
        assert events[-1][chat_core.TRUNCATION_EVENT_FLAG] is True

    # -- every round of the loop, the ones after tool calls included ---------

    def test_a_replay_after_a_tool_round_keeps_the_earlier_work(self, monkeypatch):
        calls: List[Dict[str, Any]] = []
        # Round 1 answers with a real tool call; round 2 refuses twice before
        # its third attempt streams the answer.
        plan = [
            FakeStream([
                tool_call_chunk(0, "call-1", "read_file", '{"path": "a.txt"}'),
                finish_chunk("tool_calls"),
            ]),
            None,
            None,
            FakeStream([content_chunk("done reading"), finish_chunk("stop")]),
        ]

        def seam(**kw):
            calls.append(dict(kw))
            item = plan[len(calls) - 1]
            if item is None:
                raise self._refused(502)
            return item

        monkeypatch.setattr("src.core.chat.stream_completion", seam)
        monkeypatch.setattr(chat_core, "_wait_slice", lambda s: None)
        events: List[Dict[str, Any]] = []
        chat_core.stream_chat(
            [{"role": "user", "content": "read a.txt"}], "m", "http://s/v1",
            events.append,
            tools=[{"type": "function", "function": {"name": "read_file"}}],
            tool_executor=lambda name, args: "the file's contents",
            retry_budget=lambda: (3, 5),
        )
        assert len(calls) == 4
        replay = calls[-1]["messages"]
        # The earlier rounds' work is still in the list: that is what makes
        # "continue where it left off" literal rather than approximate.
        assistant_turn = next(m for m in replay if m.get("tool_calls"))
        assert assistant_turn["tool_calls"][0]["id"] == "call-1"
        assert assistant_turn["tool_calls"][0]["function"]["name"] == "read_file"
        tool_turn = next(m for m in replay if m["role"] == "tool")
        assert tool_turn["tool_call_id"] == "call-1"
        assert tool_turn["content"] == "the file's contents"
        assert events[-1]["event"] == "done"

    # -- inside the wait: Stop ends it, Pause does not (spec §5.7, §5.8) -----

    def test_stop_during_a_wait_ends_the_turn_without_a_re_send(self, monkeypatch):
        cancel = threading.Event()
        events, calls, slept = self._run(
            monkeypatch,
            [self._refused(502), self._refused(502)],
            cancel_event=cancel,
            # Stop is armed inside the first slept slice: the wait is cut there.
            during_wait=cancel.set,
            chunks=[content_chunk("never"), finish_chunk("stop")],
        )
        # A Stop emits no frame at all — the turn ends as a Stop during a stream
        # does — and the re-send never happened.
        assert [e["event"] for e in events] == ["reconnecting"]
        assert len(calls) == 1
        # The wait's own accounting stops where the Stop landed: the guard asked
        # for no further slice, so the rest of the wait was never spent.
        assert slept == [chat_core.WAIT_SLICE_SECONDS]

    def test_a_pause_armed_during_a_wait_does_not_shorten_it(self, monkeypatch):
        pause = threading.Event()
        events, calls, slept = self._run(
            monkeypatch,
            [self._refused(502)],
            pause_event=pause,
            # The flag goes up inside the very first slice of the wait.
            during_wait=pause.set,
            budget=(1, 2),
            chunks=[content_chunk("partial"), content_chunk(" more")],
        )
        # The wait ran its full 2 seconds even though the flag was armed inside
        # it: pause means *keep what arrived*, and a wait has streamed nothing.
        assert slept == self._slices(2)
        # The replay really happened: the re-send was not skipped by the flag.
        assert len(calls) == 2
        # And the Pause is answered where it is always answered — at the first
        # chunk of that next round, whose flag check comes before the chunk is
        # handled. The flag was armed before that round began, so nothing of it
        # streams; that is today's pause shape, unchanged (compare the pause
        # cases in ``TestStreamChatPause``).
        assert [e["text"] for e in events if e["event"] == "token"] == []
        assert [e["event"] for e in events] == ["reconnecting", "usage", "pause_ack"]
        assert events[-1]["partial"] is True
        # Not an error and not a truncation: the wait ended on its own length and
        # the turn closed on the ack, once.
        assert self._terminal(events) == [events[-1]]

    def test_the_round_after_a_wait_streams_and_a_pause_keeps_its_partial(self,
                                                                          monkeypatch):
        """The other half of §5.8: the wait does not swallow the Pause request.

        The flag is armed *inside* the replayed round instead of inside the wait,
        so what is asserted is that the replay really streams and the pause is
        answered where it always is — the partial turn is kept and the turn ends
        on ``pause_ack``, the same shape a pause has when no wait came first.
        """
        pause = threading.Event()
        calls: List[Dict[str, Any]] = []

        def replayed_round():
            yield content_chunk("partial")
            pause.set()          # the interrupt lands mid-round, as it always does
            yield content_chunk(" more")

        def seam(**kw):
            calls.append(dict(kw))
            if len(calls) == 1:
                raise self._refused(502)
            return replayed_round()

        monkeypatch.setattr("src.core.chat.stream_completion", seam)
        events: List[Dict[str, Any]] = []
        chat_core.stream_chat(
            [{"role": "user", "content": "hi?"}], "m", "http://s/v1",
            events.append, pause_event=pause, retry_budget=lambda: (1, 1),
        )
        assert len(calls) == 2
        assert [e["text"] for e in events if e["event"] == "token"] == ["partial"]
        assert events[-1]["event"] == "pause_ack"
        assert events[-1]["partial"] is True

    def test_the_wait_primitive_is_cut_by_stop_and_nothing_else(self):
        """The wait on the real clock and a short budget.

        Asserted on the primitive because a patched sleep cannot show
        *interruptibility*. A 10-second wait whose Stop arrives after 50ms comes
        back in the slice it was sleeping, so this costs milliseconds and still
        proves the seconds after a Stop are never spent; the sibling branch — a
        flag that is **not** Stop — is the pause armed below, which the guard
        never reads (the case above shows its full wait slept anyway).
        """
        stop = threading.Event()

        started = time.monotonic()
        stop_later = threading.Timer(0.05, stop.set)
        stop_later.start()
        try:
            completed = chat_core._wait_for_endpoint(10.0, stop)
        finally:
            stop_later.cancel()
        elapsed = time.monotonic() - started
        assert completed is False
        assert elapsed < 1.0

        # No cancel flag at all: the wait runs its (short) full length.
        started = time.monotonic()
        assert chat_core._wait_for_endpoint(0.05, None) is True
        assert time.monotonic() - started >= 0.05

    # -- the budget spent (spec §5.10) --------------------------------------

    def test_an_exhausted_budget_names_the_attempts_and_the_sentence(
        self, monkeypatch
    ):
        events, calls, slept = self._run(
            monkeypatch, [self._refused(502)] * 5, budget=(2, 5),
            chunks=[content_chunk("never"), finish_chunk("stop")],
        )
        # 2 waits of a budget of 2, then the failure is final.
        assert len(calls) == 3
        assert slept == self._slices(5, 2)
        assert [e["event"] for e in events] == [
            "reconnecting", "reconnecting", "error",
        ]
        message = events[-1]["message"]
        # The endpoint's sentence verbatim, plus what the app already did: the
        # round's own wait count and the seconds it slept.
        assert str(self._refused(502)) in message
        assert "2 further attempts" in message
        assert "10s" in message
        assert self._terminal(events) == [events[-1]]

    # -- a wait is not inference (measurement rule) -------------------------

    def test_the_route_hands_over_the_accessor_not_its_numbers(
        self, client, monkeypatch
    ):
        """End to end: the browser's turn carries the guard, without a stub in
        the middle knowing about it.

        The route passes the **accessor** (so the keys are read at the decision,
        not at the turn's start) — an ordinary keyword whose value is a callable.
        A stub that spells the parameters out receives it and nothing else about
        the feature changes in its call shape.
        """
        seen = {}

        def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
                 pause_event=None, api_key="none", sysprompt=None, retry_budget=None,
                 agent_instructions=None, mode_instructions=None,
                 skills_instructions=None):
            seen["retry_budget"] = retry_budget
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 0,
                  "tokensEstimated": False})

        monkeypatch.setattr(routes, "stream_chat", fake)
        assert client.post(
            "/api/chat", json={"messages": [{"role": "user", "content": "hi"}]}
        ).status_code == 200
        # Not a number and not a snapshot of one: the route hands over the
        # accessor itself, which is what makes the keys read at the decision.
        assert seen["retry_budget"] is routes.network_fail_budget
        assert callable(seen["retry_budget"])

    def test_a_wait_crosses_the_sse_channel_without_ending_the_stream(
        self, client, monkeypatch
    ):
        """The real loop over the real route: one progress frame, then ``done``.

        ``reconnecting`` rides the browser's channel as an ordinary non-terminal
        frame — the generator must neither stop on it nor swallow it. What the UI
        *does* with it is tasks 05 and 06; here it is enough that a stream which
        waited still looks like one stream that finished.
        """
        calls: List[Dict[str, Any]] = []

        def seam(**kw):
            calls.append(dict(kw))
            if len(calls) == 1:
                raise self._refused(502)
            return FakeStream([content_chunk("recovered"), finish_chunk("stop")])

        monkeypatch.setattr("src.core.chat.stream_completion", seam)
        # The real loop this time, so the frames are the ones a browser is sent.
        monkeypatch.setattr(routes, "stream_chat", chat_core.stream_chat)
        # A millisecond budget: the wait is real but costs nothing.
        monkeypatch.setattr(
            routes, "network_fail_budget", lambda: (1, chat_core.WAIT_SLICE_SECONDS)
        )
        response = client.post(
            "/api/chat", json={"messages": [{"role": "user", "content": "hi"}]}
        )
        frames = _events(response.text)
        names = [name for name, _payload in frames]
        assert len(calls) == 2
        assert names == ["reconnecting", "token", "done"]
        # The transport forwards the emitted dict as it is, so the ``done``
        # payload a browser reads already carries the turn's wait (task 04) —
        # the one waited second this case's millisecond budget allowed.
        assert frames[-1][1]["waited"] == pytest.approx(chat_core.WAIT_SLICE_SECONDS)

    def test_a_wait_enters_no_measurement(self, monkeypatch):
        """One real wait of a real (tiny) length, on the real clock.

        The turn's *span* (``took``) necessarily covers it, while every figure
        anchored to chunk arrivals — ``ttft`` and the decode window — cannot:
        a wait produces no arrival. The budget here is in milliseconds, so the
        case costs nothing and sleeps for real.
        """
        calls: List[Dict[str, Any]] = []

        def seam(**kw):
            calls.append(dict(kw))
            if len(calls) == 1:
                raise self._refused(502)
            return FakeStream([
                content_chunk("ab"),
                content_chunk("cd"),
                finish_chunk("stop", usage={"prompt_tokens": 4,
                                           "completion_tokens": 2,
                                           "total_tokens": 6}),
            ])

        monkeypatch.setattr("src.core.chat.stream_completion", seam)
        events: List[Dict[str, Any]] = []
        started = time.monotonic()
        chat_core.stream_chat(
            [{"role": "user", "content": "hi?"}], "m", "http://s/v1",
            events.append, retry_budget=lambda: (1, 0.3),
        )
        elapsed = time.monotonic() - started
        assert len(calls) == 2
        done = events[-1]
        # The wait really happened, and it is nowhere in the measurement: the
        # decode window is the span between two arrivals of the last round.
        assert elapsed >= 0.3
        assert done["decode"] == done["took"] - done["ttft"]
        assert done["decode"] < 0.3
        assert done["tokens"] == 2


class _HandDrivenClock:
    """A ``time.monotonic`` stand-in a case drives by hand.

    Task 04 is about *which* numbers a wait touches, so they are stated rather
    than measured: with the clock in the test's hands the span of a waited turn,
    the span of the same turn unwaited, and every decode window are known
    exactly, and the patched sleep advances the very clock the waits are slept
    on. ``step`` is what a chunk arrival costs; ``advance`` is a wait.
    """

    def __init__(self, step: float = 1.0) -> None:
        self.now = 0.0
        self.step = step

    def __call__(self) -> float:
        answered = self.now
        self.now += self.step
        return answered

    def advance(self, seconds: float) -> None:
        self.now += seconds


class TestTheDoneFrameCarriesTheWait:
    """The turn's ``done`` frame totals the seconds it waited (spec §5.15, D5).

    Same discipline as ``TestARefusedRoundWaits``: the seam is a stub and the
    wait's sleep is patched, so every figure asserted here is one the case
    handed the guard — no test sleeps, and the expected ``waited`` is known
    rather than raced. The hand-driven clock is what lets the class pin that
    ``took`` keeps the wait (spec §5.17) while ``decode`` never gains it.
    """

    #: The pair a case hands the guard unless it says otherwise.
    BUDGET: Tuple[int, float] = (3, 9)

    @staticmethod
    def _refused(status: int = 502) -> LLMRequestError:
        return LLMRequestError(
            status=status,
            message="Bad Gateway",
            url="http://server:8080/v1/chat/completions",
        )

    def _run(self, monkeypatch, refusals,
             *, budget: Tuple[int, float] = BUDGET,
             chunks=None, clock: Optional[_HandDrivenClock] = None,
             during_wait: Optional[Callable[[], None]] = None, **kwargs):
        """One turn over a seam that refuses ``refusals`` times, then answers.

        Returns the events, the seam calls, and the wait slices it slept: those
        slices are exactly what ``waited`` must add up to. ``during_wait`` runs
        inside the first slept slice — how a case arms Pause *during* a wait.
        """
        calls: List[Dict[str, Any]] = []
        slept: List[float] = []
        pending = list(refusals)
        frames = list(chunks or [])

        def seam(**kw):
            calls.append(dict(kw))
            if pending:
                raise pending.pop(0)
            return FakeStream(frames)

        def sleep_slice(seconds: float) -> None:
            slept.append(seconds)
            if clock is not None:
                clock.advance(seconds)
            if during_wait is not None:
                during_wait()

        monkeypatch.setattr("src.core.chat.stream_completion", seam)
        monkeypatch.setattr(chat_core, "_wait_slice", sleep_slice)
        if clock is not None:
            monkeypatch.setattr(chat_core.time, "monotonic", clock)
        events: List[Dict[str, Any]] = []
        chat_core.stream_chat(
            [{"role": "user", "content": "hi?"}],
            "model-a",
            "http://server:8080/v1",
            events.append,
            retry_budget=lambda: budget,
            **kwargs,
        )
        return events, calls, slept

    # -- the field itself ----------------------------------------------------

    def test_a_waited_turn_reports_the_seconds_it_slept(self, monkeypatch):
        events, calls, slept = self._run(
            monkeypatch,
            [self._refused(502), self._refused(503)],
            chunks=[content_chunk("answer"), finish_chunk("stop")],
        )
        assert len(calls) == 3
        # Two waits of the budget's 9 seconds, slept in slices summing to them.
        assert slept == TestARefusedRoundWaits._slices(9, 2)
        done = events[-1]
        assert done["event"] == "done"
        # The sum of the waits this turn slept — and it rides on ``done`` only.
        assert done["waited"] == pytest.approx(sum(slept))
        assert done["waited"] == pytest.approx(18.0)
        assert [e for e in events if e["event"] == "done"] == [done]

    def test_a_turn_that_never_waits_reports_waited_zero(self, monkeypatch):
        # A refusal-free turn under a real budget: the guard ran and slept
        # nothing.
        events, _calls, slept = self._run(
            monkeypatch, [],
            chunks=[content_chunk("answer"), finish_chunk("stop")],
        )
        assert slept == []
        done = events[-1]
        assert "waited" in done, "the field is never omitted"
        assert done["waited"] == 0

        # The same for a caller that passes no budget at all: every existing
        # caller and every stub keeps the shape it always had, plus the field.
        monkeypatch.setattr(
            "src.core.chat.stream_completion",
            lambda **kw: FakeStream([content_chunk("answer"), finish_chunk("stop")]),
        )
        plain: List[Dict[str, Any]] = []
        chat_core.stream_chat(
            [{"role": "user", "content": "hi?"}], "m", "http://s/v1", plain.append,
        )
        assert plain[-1]["event"] == "done"
        assert plain[-1]["waited"] == 0

    def test_waits_in_two_rounds_are_summed(self, monkeypatch):
        """The figure is the **turn's** total, not the last round's."""
        calls: List[Dict[str, Any]] = []
        slept: List[float] = []
        # Round 1 answers with a tool call after two refusals; round 2 refuses
        # once before streaming the answer. Same turn, three waits.
        plan = [
            None,
            None,
            FakeStream([
                tool_call_chunk(0, "call-1", "read_file", '{"path": "a.txt"}'),
                finish_chunk("tool_calls"),
            ]),
            None,
            FakeStream([content_chunk("done reading"), finish_chunk("stop")]),
        ]

        def seam(**kw):
            calls.append(dict(kw))
            item = plan[len(calls) - 1]
            if item is None:
                raise self._refused(502)
            return item

        monkeypatch.setattr("src.core.chat.stream_completion", seam)
        monkeypatch.setattr(chat_core, "_wait_slice", lambda s: slept.append(s))
        events: List[Dict[str, Any]] = []
        chat_core.stream_chat(
            [{"role": "user", "content": "read a.txt"}], "m", "http://s/v1",
            events.append,
            tools=[{"type": "function", "function": {"name": "read_file"}}],
            tool_executor=lambda name, args: "the file's contents",
            retry_budget=lambda: (3, 4),
        )
        assert len(calls) == 5
        assert slept == TestARefusedRoundWaits._slices(4, 3)
        done = events[-1]
        assert done["event"] == "done"
        # round 1: two waits of 4s, round 2: one — 12s for the turn.
        assert done["waited"] == pytest.approx(12.0)

    # -- the other numbers, untouched ----------------------------------------

    def test_took_keeps_the_wait_and_waited_is_the_separate_figure(
        self, monkeypatch
    ):
        """Same turn, same chunk arrival, with and without a wait (spec §5.17).

        The clock is driven by the test, so both spans are exact: the waited
        turn's ``took`` is the unwaited one's plus the seconds it slept, which
        is the sentence "the turn's span is the whole request, waiting included"
        made testable. ``decode`` is identical in both — that is what D5 keeps
        apart, and why a later reader must not subtract ``waited`` from ``took``
        to recover it.
        """
        frames = [content_chunk("ab"), content_chunk("cd"), finish_chunk("stop")]

        unwaited, _calls1, slept1 = self._run(
            monkeypatch, [], chunks=frames, clock=_HandDrivenClock(),
        )
        waited, calls2, slept2 = self._run(
            monkeypatch, [self._refused(502), self._refused(502)],
            chunks=frames, clock=_HandDrivenClock(),
        )
        assert len(calls2) == 3 and slept2 and not slept1
        slept_total = sum(slept2)

        first, second = unwaited[-1], waited[-1]
        assert (first["event"], second["event"]) == ("done", "done")
        # Both turns stream the same two content chunks: one arrival each, so
        # the decode window is one clock step in both, waited or not.
        assert first["decode"] == 1.0 and second["decode"] == 1.0
        assert first["took"] == 2.0 and first["ttft"] == 1.0
        # The waited turn's span grew by exactly the wait and nothing else…
        assert second["took"] == pytest.approx(first["took"] + slept_total)
        # …and is reported as it was measured, not reduced by the new field:
        # subtracting ``waited`` from ``took`` here would be the wrong edit.
        assert second["waited"] == pytest.approx(slept_total)
        # What the wait did move is the time to first token — the only arrival
        # figure a wait can reach, because it delays the arrivals.
        assert second["ttft"] == pytest.approx(first["ttft"] + slept_total)

    # -- on ``done`` and on nothing else -------------------------------------

    def test_an_error_frame_gains_nothing(self, monkeypatch):
        events, _calls, _slept = self._run(
            monkeypatch, [self._refused(502)] * 5, budget=(2, 5),
            chunks=[content_chunk("never"), finish_chunk("stop")],
        )
        assert [e["event"] for e in events][-1] == "error"
        assert "waited" not in events[-1]
        assert set(events[-1]) == {"event", "message"}

    def test_a_pause_ack_gains_nothing(self, monkeypatch):
        """A turn that waited and then paused still reports the wait nowhere.

        The flag is armed *inside* the wait, so the turn really did wait (task
        03: the wait runs its full length) and closed on the ack — the shape
        task 04 keeps simple: one frame, one place to read the figure.
        """
        pause = threading.Event()
        events, calls, slept = self._run(
            monkeypatch, [self._refused(502)], budget=(1, 2),
            pause_event=pause, during_wait=pause.set,
            chunks=[content_chunk("partial")],
        )
        assert slept == TestARefusedRoundWaits._slices(2)
        assert len(calls) == 2
        assert [e["event"] for e in events] == ["reconnecting", "usage", "pause_ack"]
        assert "waited" not in events[-1]
        assert not [e for e in events if "waited" in e]

    def test_the_field_is_additive_to_the_existing_shape(self, monkeypatch):
        # A client that does not know ``waited`` keeps working: every key it
        # read before is still there, same name, same kind.
        events, _calls, _slept = self._run(
            monkeypatch, [],
            chunks=[content_chunk("answer"),
                    finish_chunk("stop", usage={"prompt_tokens": 4,
                                                "completion_tokens": 2,
                                                "total_tokens": 6})],
        )
        done = events[-1]
        assert done["waited"] == 0
        for key in ("took", "ttft", "decode", "tokens", "tokensEstimated",
                    "contextTokens", "contextEstimated"):
            assert key in done


def _config(endpoint: Optional[str] = "model-a") -> EndpointsConfig:
    return EndpointsConfig(
        serverUrl="http://localhost:8080/v1",
        endpoint=endpoint,
    )


#: The agent the fixture's client names on every chat turn. D5 made the field
#: mandatory — there is no server-side default agent any more — so a test about
#: anything *else* on this route has to supply one, exactly as the composer does.
#: The refusal for a missing or unknown id is pinned in ``tests/test_api.py``
#: (``TestChatAgentModeField``), which posts through the undecorated client
#: below.
DEFAULT_AGENT = "code"


class _ChatClient:
    """A ``TestClient`` whose ``POST /api/chat`` names an agent when it is given none.

    ``http`` is the undecorated client, for the tests that are about the request
    body itself. Everything else goes through this one, so a test of streaming,
    sanitizing or pausing does not have to restate a field the feature made
    mandatory in the same breath.
    """

    def __init__(self, http: Any) -> None:
        self.http = http
        self.app = http.app
        self.root = getattr(http, "root", None)

    def post(self, url: str, *args: Any, **kwargs: Any):
        body = kwargs.get("json")
        if url == "/api/chat" and isinstance(body, dict) and "agentMode" not in body:
            kwargs["json"] = {**body, "agentMode": DEFAULT_AGENT}
        return self.http.post(url, *args, **kwargs)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.http, name)


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    app = create_app()
    monkeypatch.setattr(routes, "load_endpoints_config", lambda agent: (_config(), None))
    with TestClient(app) as test_client:
        # Every route is answered about the folder its request names (clws-02),
        # so the suite's client names the test's own ``tmp_path`` on every call.
        # That is also the folder the hub helpers below put their doubles on.
        yield _ChatClient(WorkspaceClient(test_client, tmp_path))


def _events(body: str):
    parsed = []
    for frame in body.strip().split("\n\n"):
        name = None
        data = None
        for line in frame.split("\n"):
            if line.startswith("event: "):
                name = line[len("event: "):]
            elif line.startswith("data: "):
                data = json.loads(line[len("data: "):])
        if name is not None:
            parsed.append((name, data))
    return parsed


# Real 1x1 transparent PNG.
_PNG_DATA_URL = (
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ"
    "AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
)


def _oversized_data_url() -> str:
    from src.api.routes import MAX_CHAT_IMAGE_BYTES

    payload = base64.b64encode(b"x" * (MAX_CHAT_IMAGE_BYTES + 1)).decode()
    return f"data:image/png;base64,{payload}"


class TestChatEndpoint:
    def test_happy_path_streams_frames(self, client, monkeypatch):
        def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
                 pause_event=None, api_key="none", sysprompt=None, retry_budget=None,
                 agent_instructions=None, mode_instructions=None,
                 skills_instructions=None):
            emit({"event": "token", "text": "Hel"})
            emit({"event": "token", "text": "lo"})
            emit({"event": "done", "took": 1.0, "ttft": 0.1, "tokens": 3,
                  "tokensEstimated": False})

        monkeypatch.setattr(routes, "stream_chat", fake)
        response = client.post(
            "/api/chat", json={"messages": [{"role": "user", "content": "hi"}]}
        )
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        names = [name for name, _ in _events(response.text)]
        assert names == ["token", "token", "done"]

    def test_uses_first_configured_model_and_server(self, client, monkeypatch):
        seen = {}

        def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
                 pause_event=None, api_key="none", sysprompt=None, retry_budget=None,
                 agent_instructions=None, mode_instructions=None,
                 skills_instructions=None):
            seen["model"] = model
            seen["server_url"] = server_url
            seen["messages"] = messages
            seen["api_key"] = api_key
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 0,
                  "tokensEstimated": False})

        monkeypatch.setattr(routes, "stream_chat", fake)
        client.post(
            "/api/chat",
            json={"messages": [
                {"role": "user", "content": "a"},
                {"role": "assistant", "content": "b"},
                {"role": "user", "content": "c"},
            ]},
        )
        assert seen["model"] == "model-a"
        assert seen["server_url"] == "http://localhost:8080/v1"
        assert seen["api_key"] == "none"
        assert [m["role"] for m in seen["messages"]] == ["user", "assistant", "user"]

    def test_multimodal_message_forwarded_as_parts(self, client, monkeypatch):
        seen = {}

        def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
                 pause_event=None, api_key="none", sysprompt=None, retry_budget=None,
                 agent_instructions=None, mode_instructions=None,
                 skills_instructions=None):
            seen["messages"] = messages
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 0,
                  "tokensEstimated": False})

        monkeypatch.setattr(routes, "stream_chat", fake)
        response = client.post(
            "/api/chat",
            json={"messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": "describe"},
                    {"type": "image_url", "image_url": {"url": _PNG_DATA_URL}},
                ],
            }]},
        )
        assert response.status_code == 200
        content = seen["messages"][0]["content"]
        assert content[0] == {"type": "text", "text": "describe"}
        assert content[1] == {"type": "image_url",
                              "image_url": {"url": _PNG_DATA_URL}}

    def test_image_only_message_accepted(self, client, monkeypatch):
        seen = {}

        def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
                 pause_event=None, api_key="none", sysprompt=None, retry_budget=None,
                 agent_instructions=None, mode_instructions=None,
                 skills_instructions=None):
            seen["messages"] = messages
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 0,
                  "tokensEstimated": False})

        monkeypatch.setattr(routes, "stream_chat", fake)
        response = client.post(
            "/api/chat",
            json={"messages": [{
                "role": "user",
                "content": [{"type": "image_url",
                             "image_url": {"url": _PNG_DATA_URL}}],
            }]},
        )
        assert response.status_code == 200
        assert len(seen["messages"][0]["content"]) == 1

    @pytest.mark.parametrize(
        "parts",
        [
            [],  # empty parts list
            [{"type": "text", "text": "   "}],  # blank text only
            [{"type": "text"}],  # text part without text
            [{"type": "image_url"}],  # image part without image_url
            # Not a data URL
            [{"type": "image_url", "image_url": {"url": "http://x/y.png"}}],
            # Disallowed media type
            [{"type": "image_url", "image_url":
              {"url": "data:image/svg+xml;base64,AAA="}}],
            # Not base64
            [{"type": "image_url", "image_url":
              {"url": "data:image/png;base64,!!!not base64!!!"}}],
            # Over the 10 MB decoded limit
            [{"type": "image_url", "image_url": {"url": _oversized_data_url()}}],
        ],
    )
    def test_invalid_multimodal_bodies_return_422(self, client, parts):
        response = client.post(
            "/api/chat", json={"messages": [{"role": "user", "content": parts}]}
        )
        assert response.status_code == 422

    def test_assistant_multimodal_content_returns_422(self, client):
        response = client.post(
            "/api/chat",
            json={"messages": [
                {"role": "assistant",
                 "content": [{"type": "text", "text": "hi"}]},
            ]},
        )
        assert response.status_code == 422


class TestChatIncomingSanitization:
    """The incoming door: no delimiter-wrapped control token gets *in*.

    The seam also strips on the way out, but history is re-posted every
    turn and a model asked about these tokens answers with them -- if the
    runs lived inside the app's message objects, they would ride every
    non-seam path (validation, UI state, logging) until the request was
    built. Cleaning at the model boundary removes them once, at entry.
    """

    def _capture(self, monkeypatch) -> Dict[str, Any]:
        seen: Dict[str, Any] = {}

        def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
                 pause_event=None, api_key="none", sysprompt=None, retry_budget=None,
                 agent_instructions=None, mode_instructions=None,
                 skills_instructions=None):
            seen["messages"] = messages
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 0,
                  "tokensEstimated": False})

        monkeypatch.setattr(routes, "stream_chat", fake)
        return seen

    def test_reposted_history_arrives_clean_at_the_core(self, client, monkeypatch):
        # The exact break in the field: an earlier answer *about* these
        # tokens comes back as history and would re-close every later
        # turn; at the boundary it is text again before anything reads it.
        seen = self._capture(monkeypatch)
        response = client.post(
            "/api/chat",
            json={"messages": [
                {"role": "user",
                 "content": f"what is {special_token('im_start')} ?"},
                {"role": "assistant",
                 "content": f"it is written {special_token('im_start')}"},
                {"role": "user", "content": "thanks"},
            ]},
        )
        assert response.status_code == 200
        contents = [m["content"] for m in seen["messages"]]
        assert contents == ["what is  ?", "it is written ", "thanks"]

    def test_multimodal_text_parts_arrive_clean(self, client, monkeypatch):
        seen = self._capture(monkeypatch)
        response = client.post(
            "/api/chat",
            json={"messages": [{
                "role": "user",
                "content": [
                    {"type": "text", "text": f"a{special_token('evil')}b"},
                    {"type": "image_url", "image_url": {"url": _PNG_DATA_URL}},
                ],
            }]},
        )
        assert response.status_code == 200
        assert seen["messages"][0]["content"][0] == {"type": "text", "text": "ab"}

    def test_a_message_of_only_control_tokens_is_refused_not_forwarded(
        self, client, monkeypatch
    ):
        # The sanitized "" must hit the emptiness rule, not reach the
        # model as a blank turn: refusing names the input as the problem.
        self._capture(monkeypatch)
        response = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": special_token("evil")}]},
        )
        assert response.status_code == 422

    def test_a_blank_assistant_turn_does_not_brick_the_conversation(
        self, client, monkeypatch
    ):
        # The stream filter removed a run-only answer, so the client's
        # history legitimately carries an empty assistant turn. Refusing
        # it would answer every later continuation with a 422 the user
        # cannot clear from the UI -- the brick is worse than the artefact.
        seen = self._capture(monkeypatch)
        response = client.post(
            "/api/chat",
            json={"messages": [
                {"role": "user", "content": f"what is {special_token('evil')} ?"},
                {"role": "assistant", "content": ""},
                {"role": "user", "content": "continue"},
            ]},
        )
        assert response.status_code == 200
        assert [m["content"] for m in seen["messages"]] == [
            "what is  ?", "", "continue",
        ]

    def test_text_part_of_only_control_tokens_alone_is_refused(
        self, client, monkeypatch
    ):
        self._capture(monkeypatch)
        response = client.post(
            "/api/chat",
            json={"messages": [{
                "role": "user",
                "content": [{"type": "text", "text": special_token("evil")}],
            }]},
        )
        assert response.status_code == 422


class TestControlTokenNotice:
    """The system message tells the model never to *generate* a raw run.

    The input sanitizer cannot prevent the asked-about-the-tokens cut:
    the model generates a raw run, the serving runtime tokenizes it as a
    single end-of-turn token, and the reply dies mid-sentence reading as
    a clean stop. The prevention that works is a standing chat-turn
    instruction -- this loop's own, appended in core/chat.py and nowhere
    else, so no other prompt carries it.
    """

    def _capture_system(self, monkeypatch, messages, **kwargs):
        seen = {}

        def capture(**kw):
            seen["messages"] = kw["messages"]
            return FakeStream([content_chunk("ok"), finish_chunk("stop")])

        monkeypatch.setattr("src.core.chat.stream_completion", capture)
        events = []
        chat_core.stream_chat(
            messages,
            "model-a",
            "http://server:8080/v1",
            events.append,
            **kwargs,
        )
        return seen["messages"][0]["content"]

    def test_every_turn_carries_the_notice(self, monkeypatch):
        system = self._capture_system(
            monkeypatch, [{"role": "user", "content": "what is im_start ?"}]
        )
        assert "raw delimiter-wrapped form" in system

    def test_a_caller_supplied_system_message_gets_the_notice_too(
        self, monkeypatch
    ):
        system = self._capture_system(
            monkeypatch,
            [
                {"role": "system", "content": "be terse"},
                {"role": "user", "content": "what is im_start ?"},
            ],
        )
        assert system.startswith("be terse")
        assert "raw delimiter-wrapped form" in system

    def test_the_notice_coexists_with_the_tool_notice(self, monkeypatch):
        system = self._capture_system(
            monkeypatch,
            [{"role": "user", "content": "hi"}],
            sysprompt="be terse",
            tools=[{"type": "function", "function": {"name": "read_file"}}],
            tool_executor=lambda name, args: "r",
        )
        assert "browser/console" in system  # TOOL_NOTICE still applied
        assert "raw delimiter-wrapped form" in system

    def test_the_notice_names_the_code_fence_loophole(self, monkeypatch):
        # The recorded break: the model followed the rule in prose -- its
        # reasoning even said so -- then reproduced the raw form inside a
        # fenced template example and was EOG-cut mid-fence. The notice
        # must close that exemption in words the model cannot re-read
        # around.
        system = self._capture_system(
            monkeypatch, [{"role": "user", "content": "what is a chat template?"}]
        )
        assert "code blocks" in system
        assert "no exemption" in system

    def test_the_notice_itself_is_not_a_smuggled_run(self):
        # The guard against the guard becoming the hole: the instruction
        # survives the sanitizer byte for byte, so it never spells the
        # very run it forbids the model from spelling.
        from src.core.chat import CONTROL_TOKEN_NOTICE
        from src.core.llmkit.sanitize import sanitize_content

        assert sanitize_content(CONTROL_TOKEN_NOTICE) == CONTROL_TOKEN_NOTICE


class TestStreamedDisplayIsSanitized:
    """What the panels (and the client's history) see is run-free.

    A token-shaped run arrives split across content deltas, so the
    frames must be filtered as one stream, not per frame: a model asked
    about these tokens must be able to answer without the raw sequence
    ever being painted or stored by the browser.
    """

    def _run_chunks(self, monkeypatch, chunks, **kwargs):
        monkeypatch.setattr(
            "src.core.chat.stream_completion", lambda **kw: FakeStream(chunks)
        )
        events: List[Dict[str, Any]] = []
        chat_core.stream_chat(
            [{"role": "user", "content": "hi"}],
            "m",
            "http://s/v1",
            events.append,
            **kwargs,
        )
        return events

    def test_a_run_split_across_answer_chunks_never_reaches_a_token_frame(
        self, monkeypatch
    ):
        events = self._run_chunks(
            monkeypatch,
            [
                content_chunk("It is written "),
                content_chunk(OPEN_DELIM + "im_st"),
                content_chunk("art" + CLOSE_DELIM),
                content_chunk(" in ChatML"),
                finish_chunk("stop"),
            ],
        )
        streamed = "".join(e["text"] for e in events if e["event"] == "token")
        assert streamed == "It is written  in ChatML"
        assert [e for e in events if e["event"] == "done"]

    def test_reasoning_frames_are_filtered_as_one_stream(self, monkeypatch):
        events = self._run_chunks(
            monkeypatch,
            [
                reasoning_chunk("think about "),
                reasoning_chunk(special_token("q")[:4]),
                reasoning_chunk(special_token("q")[4:]),
                reasoning_chunk(" now"),
                finish_chunk("stop"),
            ],
        )
        thought = "".join(
            e["text"] for e in events if e["event"] == "reasoning_delta"
        )
        assert thought == "think about  now"

    def test_a_held_partial_survives_truncation_before_the_error(
        self, monkeypatch
    ):
        # The fragment is kept as streamed AND the benign held partial is
        # flushed before the terminal error frame -- nothing vanishes.
        events = self._run_chunks(
            monkeypatch, [content_chunk("x"), content_chunk(OPEN_DELIM)]
        )
        names = [e["event"] for e in events]
        assert names == ["token", "token", "error"]
        assert events[1]["text"] == OPEN_DELIM

    def test_tool_result_and_call_previews_reach_the_panel_run_free(
        self, monkeypatch
    ):
        streams = [
            FakeStream([
                tool_call_chunk(call_id="c1",
                                name=f"ech{special_token('x')}o",
                                arguments='{"x": 1}'),
                finish_chunk("stop"),
            ]),
            FakeStream([content_chunk("ok"), finish_chunk("stop")]),
        ]
        calls = []

        def fake(**kw):
            calls.append(kw)
            return streams[len(calls) - 1]

        monkeypatch.setattr("src.core.chat.stream_completion", fake)
        events: List[Dict[str, Any]] = []
        chat_core.stream_chat(
            [{"role": "user", "content": "hi"}],
            "m",
            "http://s/v1",
            events.append,
            tools=[{"type": "function", "function": {"name": "x"}}],
            tool_executor=lambda name, args: f"result {special_token('s')} done",
        )
        call = next(e for e in events if e["event"] == "tool_call")
        result = next(e for e in events if e["event"] == "tool_result")
        assert call["tool"] == "echo"
        assert result["preview"] == "result  done"

    def test_forwards_configured_api_key(self, monkeypatch, tmp_path):
        def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
                 pause_event=None, api_key="none", sysprompt=None, retry_budget=None,
                 agent_instructions=None, mode_instructions=None,
                 skills_instructions=None):
            emit({"api_key_seen": api_key, "event": "done", "took": 0.0,
                  "ttft": 0.0, "tokens": 0, "tokensEstimated": False})

        app = create_app()
        monkeypatch.setattr(
            routes,
            "load_endpoints_config",
            lambda agent: (
                EndpointsConfig(
                    serverUrl="http://localhost:8080/v1",
                    apiKey="sk-42",
                    endpoint="model-a",
                ),
                None,
            ),
        )
        monkeypatch.setattr(routes, "stream_chat", fake)
        with TestClient(app) as test_client:
            response = test_client.post(
                "/api/chat",
                params=workspace_params(tmp_path),
                json={"messages": [{"role": "user", "content": "hi"}],
                      "agentMode": DEFAULT_AGENT},
            )
        assert '"api_key_seen": "sk-42"' in response.text

    def test_agent_instructions_reach_the_chat_call(
        self, client, monkeypatch, tmp_path: Path
    ):
        # The **request's** workspace's AGENTS.md is injected on every request, so
        # a conversation starts knowing that project's conventions (spec §5.6
        # rule 31): the folder is named by the field, not by the process.
        (tmp_path / "AGENTS.md").write_text("# rules\n\nrun pytest first\n", encoding="utf-8")
        seen = {}

        def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
                 pause_event=None, api_key="none", sysprompt=None, retry_budget=None,
                 agent_instructions=None, mode_instructions=None,
                 skills_instructions=None):
            seen["instructions"] = agent_instructions
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 0,
                  "tokensEstimated": False})

        monkeypatch.setattr(routes, "stream_chat", fake)
        client.post(
            "/api/chat",
            params=workspace_params(tmp_path),
            json={"messages": [{"role": "user", "content": "hi"}]},
        )
        assert seen["instructions"].endswith("run pytest first")
        assert f"project root is {tmp_path}" in seen["instructions"]

    def test_agent_instructions_empty_without_the_file(
        self, client, monkeypatch, tmp_path: Path
    ):
        # No AGENTS.md at the named workspace: the configured prompt stands alone.
        seen = {}

        def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
                 pause_event=None, api_key="none", sysprompt=None, retry_budget=None,
                 agent_instructions=None, mode_instructions=None,
                 skills_instructions=None):
            seen["instructions"] = agent_instructions
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 0,
                  "tokensEstimated": False})

        monkeypatch.setattr(routes, "stream_chat", fake)
        client.post(
            "/api/chat",
            params=workspace_params(tmp_path),
            json={"messages": [{"role": "user", "content": "hi"}]},
        )
        assert seen["instructions"] == ""

    @pytest.mark.parametrize("first", ["a", "b"], ids=["a-first", "b-first"])
    def test_two_turns_in_two_workspaces_carry_their_own_instructions(
        self, client, monkeypatch, tmp_path: Path, first: str
    ):
        """Rule 31, stated as the contract it is: the **system message**, twice.

        The seam suite pins the route's kwarg; this runs the real
        :func:`src.core.chat.stream_chat` with only the LLM client stubbed, so
        what is asserted is the system message that would leave the process —
        each turn carrying its own workspace's ``AGENTS.md``, its own project
        root, and **nothing** of the other's. Both request orders are run,
        because "whichever folder was asked about last" is the one failure mode
        a process-wide location used to make unavoidable.
        """
        alpha = tmp_path / "alpha"
        beta = tmp_path / "beta"
        for name, root in (("ALPHA", alpha), ("BETA", beta)):
            root.mkdir()
            (root / "AGENTS.md").write_text(
                f"# rules of {name}\n\nonly {name} builds with make\n", encoding="utf-8"
            )

        captured: List[Dict[str, Any]] = []
        monkeypatch.setattr(routes, "stream_chat", chat_core.stream_chat)
        monkeypatch.setattr(
            "src.core.chat.stream_completion",
            lambda **kwargs: captured.append(kwargs) or iter([]),
        )

        order = (alpha, beta) if first == "a" else (beta, alpha)
        for root in order:
            marker = "ALPHA" if root is alpha else "BETA"
            other = "BETA" if root is alpha else "ALPHA"
            response = client.post(
                "/api/chat",
                params=workspace_params(root),
                json={"messages": [{"role": "user", "content": "hi"}]},
            )
            assert response.status_code == 200, response.text
            content = captured[-1]["messages"][0]["content"]
            assert f"# rules of {marker}" in content
            assert f"only {marker} builds with make" in content
            assert f"project root is {root}" in content
            assert other not in content
        assert len(captured) == 2

    def test_error_event_terminates_stream(self, client, monkeypatch):
        def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
                 pause_event=None, api_key="none", sysprompt=None, retry_budget=None,
                 agent_instructions=None, mode_instructions=None,
                 skills_instructions=None):
            emit({"event": "error", "message": "boom"})

        monkeypatch.setattr(routes, "stream_chat", fake)
        response = client.post(
            "/api/chat", json={"messages": [{"role": "user", "content": "hi"}]}
        )
        frames = _events(response.text)
        assert [name for name, _ in frames] == ["error"]

    def test_truncation_flag_survives_the_sse_frame(self, client, monkeypatch):
        # The whole event dict is JSON-serialized into the frame, so the flag
        # the WorkBench view needs to mark the bubble reaches the browser.
        def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
                 pause_event=None, api_key="none", sysprompt=None, retry_budget=None,
                 agent_instructions=None, mode_instructions=None,
                 skills_instructions=None):
            emit({"event": "error", "message": "cut short", "truncated": True})

        monkeypatch.setattr(routes, "stream_chat", fake)
        response = client.post(
            "/api/chat", json={"messages": [{"role": "user", "content": "hi"}]}
        )
        name, payload = _events(response.text)[0]
        assert name == "error"
        assert payload["message"] == "cut short"
        assert payload["truncated"] is True

    @pytest.mark.parametrize(
        "payload",
        [
            {"messages": []},
            {"messages": [{"role": "user", "content": "   "}]},
            {"messages": [{"role": "wizard", "content": "abracadabra"}]},
            {"messages": [{"role": "user"}]},
        ],
    )
    def test_invalid_bodies_return_422(self, client, payload):
        assert client.post("/api/chat", json=payload).status_code == 422

    def test_no_model_configured_returns_400(self, client, monkeypatch):
        monkeypatch.setattr(
            routes, "load_endpoints_config", lambda agent: (_config(None), None)
        )
        response = client.post(
            "/api/chat", json={"messages": [{"role": "user", "content": "hi"}]}
        )
        assert response.status_code == 400


class TestTheTurnResolvesThroughTheStore:
    """D7's switch, end to end through the chat route.

    ``_load_config`` is **not** patched for these cases: which server answers a
    turn is a fact about the store's rows, so the assertions are about what a
    chat request does with them.
    """

    @pytest.fixture
    def store_client(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
        """A real app whose ``stream_chat`` records the connection it was handed."""
        seen: Dict[str, Any] = {}

        def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
                 pause_event=None, api_key="none", sysprompt=None,
                 agent_instructions=None, mode_instructions=None, **tools):
            seen.update({"model": model, "server_url": server_url, "api_key": api_key})
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 0,
                  "tokensEstimated": False})

        monkeypatch.setattr(routes, "stream_chat", fake)
        monkeypatch.setattr(routes, "_active_connector_ids", lambda: [])
        monkeypatch.setattr(routes, "_active_server_ids", lambda: [])
        app = create_app()
        with TestClient(app) as test_client:
            # A chat turn names its folder (clws-02); the second tab below shares
            # this app, so it names the same test-owned workspace.
            yield WorkspaceClient(test_client, tmp_path), seen

    @staticmethod
    def _post(client, agent_mode: str = "code"):
        return client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "hi"}],
                  "agentMode": agent_mode},
        )

    def test_the_next_turns_server_comes_from_the_agents_model_row(
        self, store_client, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """Point the agent at another server's model, and the next turn moves."""
        from src.core import appdb
        from tests.conftest import neutralise_store

        client, seen = store_client
        neutralise_store(
            monkeypatch, tmp_path,
            serverUrl="http://first-host/v1", endpoint="first-model",
        )
        assert self._post(client).status_code == 200
        assert seen["server_url"] == "http://first-host/v1"
        assert seen["model"] == "first-model"

        # A **second** server with its own model, written through the routes a
        # user's dialog uses, with the agent's `model_id` pointed at it.
        created = client.post(
            "/api/servers/add",
            json={"name": "Second", "url": "http://second-host/v1", "apiKey": ""},
        )
        server_id = next(
            server["id"] for server in created.json()["servers"]
            if server["name"] == "Second"
        )
        client.post(
            "/api/models/add", json={"serverId": server_id, "name": "second-model"}
        )
        second_model = next(
            model["id"] for server in appdb.load_servers()
            for model in server["models"] if model["name"] == "second-model"
        )
        appdb.connection().execute(
            "UPDATE agents SET model_id = ? WHERE id = 'code'", (second_model,)
        )

        assert self._post(client).status_code == 200
        assert seen["server_url"] == "http://second-host/v1"
        assert seen["model"] == "second-model"

    def test_a_save_inside_the_turn_cannot_split_it(
        self, store_client, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """A turn resolves **once, at its start** (D7).

        The stub below rewrites the server row from inside the worker — as mid
        turn as a save can land — and records the connection it was *handed*. The
        row having moved must not reach that argument, which is exactly what
        replaces "refused while a chat reply streams" for these stores (§4.5).
        """
        from src.core import appdb
        from tests.conftest import neutralise_store

        client, seen = store_client
        neutralise_store(
            monkeypatch, tmp_path,
            serverUrl="http://before-host/v1", endpoint="before-model",
        )

        seen_list: List[Dict[str, Any]] = []

        def saving_stream(messages, model, server_url, emit, sampling=None,
                          cancel_event=None, pause_event=None, api_key="none",
                          sysprompt=None, agent_instructions=None,
                          mode_instructions=None, **tools):
            seen_list.append({"model": model, "server_url": server_url})
            if len(seen_list) == 1:
                appdb.connection().execute(
                    "UPDATE servers SET url = 'http://after-host/v1' "
                    "WHERE url = 'http://before-host/v1'"
                )
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 0,
                  "tokensEstimated": False})

        monkeypatch.setattr(routes, "stream_chat", saving_stream)

        assert self._post(client).status_code == 200
        assert self._post(client).status_code == 200

        # The turn that was streaming answered on the connection it resolved ...
        assert seen_list[0]["server_url"] == "http://before-host/v1"
        # ... and the save was visible to the *next* turn, not that one.
        assert seen_list[1]["server_url"] == "http://after-host/v1"

    def test_an_agent_with_no_model_refuses_with_one_sentence_naming_it(
        self, store_client, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """AC-3's server half: the same sentence the app bar and dialog show."""
        from src.config import agent_connection_refusal
        from src.core import appdb
        from tests.conftest import neutralise_store

        client, seen = store_client
        neutralise_store(
            monkeypatch, tmp_path,
            serverUrl="http://x/v1", endpoint="m",
            agents_without_model=("code",),
        )

        response = self._post(client)

        assert response.status_code == 422
        detail = response.json()["detail"]
        assert "no model" in detail
        assert appdb.resolve_agent("code")[0]["label"] in detail
        assert detail == agent_connection_refusal(appdb.resolve_agent("code")[0])
        # Nothing streamed: the worker was never handed a connection.
        assert seen == {}

    def test_a_save_from_the_other_tab_cannot_split_the_streaming_turn(
        self, store_client, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """§5.5 rule 27, with the *other* tab doing the saving.

        The stored row moves through the store's own route — ``POST
        /api/models/save``, the write a second tab's dialog makes — while this
        tab's reply is mid-stream, and the reply keeps the model it started on.
        That is the whole of "a turn resolves once, at its start": the *other*
        side of the change is what no earlier case covered, and it is the case
        two tabs make reachable.

        The second ``TestClient`` is the second tab: same app, same store, a
        request of its own. Nothing is serialised between the two, which is why
        the turn has to hold its answer rather than re-read the row.
        """
        from src.core import appdb
        from tests.conftest import neutralise_store

        client, _seen = store_client
        neutralise_store(
            monkeypatch, tmp_path,
            serverUrl="http://host/v1", endpoint="model-before",
        )
        model_id = int(appdb.load_servers()[0]["models"][0]["id"])

        started = threading.Event()
        release = threading.Event()
        handed: List[Dict[str, Any]] = []

        def slow_stream(messages, model, server_url, emit, sampling=None,
                        cancel_event=None, pause_event=None, api_key="none",
                        sysprompt=None, agent_instructions=None,
                        mode_instructions=None, **tools):
            handed.append({"model": model, "server_url": server_url})
            started.set()
            # Hold the reply open across the other tab's save: a turn that
            # re-read the row would answer with the *new* name here.
            release.wait(timeout=5)
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 0,
                  "tokensEstimated": False})

        monkeypatch.setattr(routes, "stream_chat", slow_stream)
        other_tab = TestClient(client.app)

        answered: Dict[str, Any] = {}

        def run_turn() -> None:
            # TestClient buffers a whole SSE body before answering, so the turn
            # has to be driven from another thread for the save to land mid-stream.
            answered["response"] = self._post(client)

        worker = threading.Thread(target=run_turn)
        worker.start()
        assert started.wait(timeout=5), "the turn never started"

        saved = other_tab.post(
            "/api/models/save", json={"id": model_id, "name": "model-after"}
        )
        assert saved.status_code == 200, saved.text

        release.set()
        worker.join(timeout=10)

        assert answered["response"].status_code == 200
        # The streaming reply kept the model it started on ...
        assert handed == [{"model": "model-before", "server_url": "http://host/v1"}]
        # ... and the save was a success the *next* turn will see.
        assert appdb.load_servers()[0]["models"][0]["name"] == "model-after"


class TestChatPauseEndpoint:
    """``POST /api/chat/pause`` arms the flag of the one in-flight reply."""

    def test_no_reply_streaming_returns_409(self, client, tmp_path: Path):
        response = client.post("/api/chat/pause")
        assert response.status_code == 409
        detail = response.json()["detail"]
        assert "No chat reply is streaming" in detail
        # The answer is a fact about **this** folder: the workspace is named, so
        # a second tab's reply can never make this sentence read as global.
        assert str(tmp_path) in detail

    def test_pause_arms_the_flag_and_the_stream_ends_on_pause_ack(
        self, client, monkeypatch
    ):
        seen = {}
        started = threading.Event()
        released = threading.Event()

        def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
                 pause_event=None, api_key="none", sysprompt=None, retry_budget=None,
                 agent_instructions=None, mode_instructions=None,
                 skills_instructions=None):
            seen["pause_event"] = pause_event
            started.set()
            # The route always hands the stream a flag; the default None only
            # exists so other fakes can omit it.
            assert pause_event is not None
            # Stands in for the core: the flag is what the real loop checks.
            while not pause_event.is_set():
                time.sleep(0.01)
            # Hold the reply open across both pause calls: the second one must
            # still see the handle, so no ack may go out before it landed.
            released.wait(timeout=5)
            emit({"event": "token", "text": "partial"})
            emit({"event": "usage", "tokens": 3, "decode": 0.2,
                  "contextTokens": 12, "contextEstimated": False})
            emit({"event": "pause_ack", "partial": True})

        monkeypatch.setattr(routes, "stream_chat", fake)

        def arm_pause():
            # The TestClient buffers a whole SSE body before returning, so the
            # reply below only ends once the flag is armed: the POST has to come
            # from another thread, exactly as it does in the browser.
            started.wait(timeout=5)
            arm_pause.results["first"] = client.post("/api/chat/pause")
            arm_pause.results["again"] = client.post("/api/chat/pause")
            released.set()

        arm_pause.results = {}
        poster = threading.Thread(target=arm_pause)
        poster.start()
        response = client.post(
            "/api/chat", json={"messages": [{"role": "user", "content": "hi"}]}
        )
        poster.join(timeout=5)

        assert seen["pause_event"] is not None
        first = arm_pause.results["first"]
        assert first.status_code == 200
        assert first.json() == {"paused": "requested"}
        # Idempotent: a second call while the ack is pending says so.
        again = arm_pause.results["again"]
        assert again.status_code == 200
        assert again.json() == {"paused": "pending"}
        names = [name for name, _data in _events(response.text)]
        assert names == ["token", "usage", "pause_ack"]

    def test_handle_is_retired_once_the_reply_ended(self, client, monkeypatch):
        def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
                 pause_event=None, api_key="none", sysprompt=None, retry_budget=None,
                 agent_instructions=None, mode_instructions=None,
                 skills_instructions=None):
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 1,
                  "tokensEstimated": False})

        monkeypatch.setattr(routes, "stream_chat", fake)
        response = client.post(
            "/api/chat", json={"messages": [{"role": "user", "content": "hi"}]}
        )
        assert response.status_code == 200
        assert [name for name, _ in _events(response.text)] == ["done"]
        assert client.post("/api/chat/pause").status_code == 409


def _model_per_agent(monkeypatch: pytest.MonkeyPatch) -> None:
    """Give each built-in agent its own model, so two turns can be told apart."""
    monkeypatch.setattr(
        routes,
        "load_endpoints_config",
        lambda agent: (_config(f"model-{agent['id']}"), None),
    )


def _post_chat(client: Any, root: Path, agent_mode: str):
    """One streaming request naming ``root`` and answering as ``agent_mode``."""
    return client.post(
        "/api/chat",
        params=workspace_params(root),
        json={
            "messages": [{"role": "user", "content": "hi"}],
            "agentMode": agent_mode,
        },
    )


class TestTwoTurnsAtOnce:
    """Spec §5.3 rules 15–16: two conversations, two workspaces, no queue.

    The in-flight slot became per workspace in clws-04; this class is the
    contract that keeps it that way. Every stream is the existing stubbed
    shape — no test reaches a model endpoint — and the barriers prove the two
    workers really overlap rather than merely both finishing.
    """

    def test_two_workspaces_stream_at_once_each_on_its_own_model(
        self, client, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        alpha = tmp_path / "alpha"
        beta = tmp_path / "beta"
        for root in (alpha, beta):
            root.mkdir()

        both_streaming = threading.Barrier(2, timeout=10)
        models: List[str] = []

        def fake(messages, model, server_url, emit, sampling=None,
                 cancel_event=None, pause_event=None, api_key="none",
                 sysprompt=None, agent_instructions=None,
                 mode_instructions=None, **tools):
            models.append(model)
            # Both workers have to be inside the turn at the same moment: a
            # serialised app breaks this barrier and the reply becomes an error.
            both_streaming.wait()
            for index in range(3):
                emit({"event": "token", "text": f"{model}:{index}"})
                time.sleep(0.01)
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 3,
                  "tokensEstimated": False})

        _model_per_agent(monkeypatch)
        monkeypatch.setattr(routes, "stream_chat", fake)

        results: Dict[str, Any] = {}
        errors: Dict[str, BaseException] = {}

        def run(label: str, root: Path, mode: str) -> None:
            try:
                results[label] = _post_chat(client, root, mode)
            except BaseException as exc:  # noqa: BLE001 - surfaced below
                errors[label] = exc

        threads = [
            threading.Thread(target=run, args=("a", alpha, "chat")),
            threading.Thread(target=run, args=("b", beta, "code")),
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=15)

        assert not errors, errors
        assert set(results) == {"a", "b"}
        for label in ("a", "b"):
            assert results[label].status_code == 200, results[label].text
        assert sorted(models) == ["model-chat", "model-code"], (
            "the two turns did not both reach their own agent's model"
        )

        for label, own, other in (
            ("a", "model-chat", "model-code"),
            ("b", "model-code", "model-chat"),
        ):
            frames = _events(results[label].text)
            names = [name for name, _payload in frames]
            assert names[-1] == "done", (label, results[label].text)
            text = "".join(
                payload.get("text", "")
                for name, payload in frames
                if name == "token"
            )
            assert f"{own}:0" in text
            assert other not in text, (
                f"{label}'s stream carried frames from the other workspace"
            )

    def test_pause_reaches_only_its_own_workspace(
        self, client, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        alpha = tmp_path / "alpha"
        beta = tmp_path / "beta"
        for root in (alpha, beta):
            root.mkdir()

        alpha_started = threading.Event()
        beta_started = threading.Event()
        alpha_acked = threading.Event()
        release_beta = threading.Event()

        def fake(messages, model, server_url, emit, sampling=None,
                 cancel_event=None, pause_event=None, api_key="none",
                 sysprompt=None, agent_instructions=None,
                 mode_instructions=None, **tools):
            if model == "model-chat":
                assert pause_event is not None
                alpha_started.set()
                while not pause_event.is_set():
                    time.sleep(0.01)
                emit({"event": "token", "text": "alpha-partial"})
                emit({"event": "pause_ack", "partial": True})
                alpha_acked.set()
                return
            beta_started.set()
            # Held open across A's pause: if Pause reached this turn it would
            # never reach `done`.
            assert release_beta.wait(timeout=10)
            emit({"event": "token", "text": "beta-answer"})
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 2,
                  "tokensEstimated": False})

        _model_per_agent(monkeypatch)
        monkeypatch.setattr(routes, "stream_chat", fake)

        results: Dict[str, Any] = {}
        errors: Dict[str, BaseException] = {}

        def run(label: str, root: Path, mode: str) -> None:
            try:
                results[label] = _post_chat(client, root, mode)
            except BaseException as exc:  # noqa: BLE001 - surfaced below
                errors[label] = exc

        alpha_thread = threading.Thread(target=run, args=("a", alpha, "chat"))
        beta_thread = threading.Thread(target=run, args=("b", beta, "code"))
        alpha_thread.start()
        beta_thread.start()

        assert alpha_started.wait(timeout=10), "A's turn never started"
        assert beta_started.wait(timeout=10), "B's turn never started"

        paused = client.post(
            "/api/chat/pause", params=workspace_params(alpha)
        )
        assert paused.status_code == 200, paused.text
        assert paused.json() == {"paused": "requested"}
        assert alpha_acked.wait(timeout=10), "A's pause_ack never arrived"
        # B is still held open, so A's pause neither ended nor armed B's turn.
        assert not release_beta.is_set()

        release_beta.set()
        alpha_thread.join(timeout=15)
        beta_thread.join(timeout=15)

        assert not errors, errors
        assert [name for name, _p in _events(results["a"].text)] == [
            "token", "pause_ack",
        ]
        beta_frames = _events(results["b"].text)
        assert [name for name, _p in beta_frames] == ["token", "done"]
        assert beta_frames[0][1]["text"] == "beta-answer"

    def test_a_pause_on_a_quiet_workspace_409s_while_another_streams(
        self, client, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """Rule 15's other half: a quiet folder is not the busy tab's folder."""
        alpha = tmp_path / "alpha"
        beta = tmp_path / "beta"
        for root in (alpha, beta):
            root.mkdir()

        started = threading.Event()
        release = threading.Event()

        def fake(messages, model, server_url, emit, sampling=None,
                 cancel_event=None, pause_event=None, api_key="none",
                 sysprompt=None, agent_instructions=None,
                 mode_instructions=None, **tools):
            started.set()
            assert release.wait(timeout=10)
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 1,
                  "tokensEstimated": False})

        _model_per_agent(monkeypatch)
        monkeypatch.setattr(routes, "stream_chat", fake)

        answered: Dict[str, Any] = {}

        def run_beta() -> None:
            answered["beta"] = _post_chat(client, beta, "code")

        thread = threading.Thread(target=run_beta)
        thread.start()
        assert started.wait(timeout=10), "B's turn never started"

        refused = client.post(
            "/api/chat/pause", params=workspace_params(alpha)
        )
        assert refused.status_code == 409, refused.text
        detail = refused.json()["detail"]
        assert detail == f"No chat reply is streaming on {alpha.resolve()}"
        assert str(beta.resolve()) not in detail

        release.set()
        thread.join(timeout=15)
        assert thread.is_alive() is False
        assert [name for name, _p in _events(answered["beta"].text)] == ["done"]

    def test_a_write_refused_in_one_workspace_does_not_obstruct_the_other(
        self, client, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """Rules 13–14 with a live reply: A is locked, B is not."""
        alpha = tmp_path / "alpha"
        beta = tmp_path / "beta"
        for root in (alpha, beta):
            root.mkdir()

        started = threading.Event()
        release = threading.Event()

        def fake(messages, model, server_url, emit, sampling=None,
                 cancel_event=None, pause_event=None, api_key="none",
                 sysprompt=None, agent_instructions=None,
                 mode_instructions=None, **tools):
            started.set()
            assert release.wait(timeout=10)
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 1,
                  "tokensEstimated": False})

        _model_per_agent(monkeypatch)
        monkeypatch.setattr(routes, "stream_chat", fake)

        answered: Dict[str, Any] = {}

        def run_alpha() -> None:
            answered["alpha"] = _post_chat(client, alpha, "chat")

        thread = threading.Thread(target=run_alpha)
        thread.start()
        assert started.wait(timeout=10), "A's turn never started"

        # The other workspace's write is a peer's, not a guest's.
        written = client.post(
            "/api/fs/create",
            params=workspace_params(beta),
            json={"path": "b.txt", "dir": False},
        )
        assert written.status_code == 200, written.text
        assert (beta / "b.txt").is_file()

        # The same write against the streaming workspace is refused, and the
        # refusal names the folder it is about.
        refused = client.post(
            "/api/fs/create",
            params=workspace_params(alpha),
            json={"path": "a.txt", "dir": False},
        )
        assert refused.status_code == 409, refused.text
        assert "while a chat reply is streaming" in refused.json()["detail"]
        assert str(alpha.resolve()) in refused.json()["detail"]
        assert not (alpha / "a.txt").exists()

        release.set()
        thread.join(timeout=15)
        assert [name for name, _p in _events(answered["alpha"].text)] == ["done"]


class _CancelAwareStream(FakeStream):
    """An upstream that waits for the route's cancel flag, then yields once more.

    ``stream_chat`` checks the flag at the top of every chunk, so the chunk
    pulled after the client went away is what makes it call ``close()`` — the
    upstream half of "the turn is cancelled". ``more_after_gate`` models a reply
    that still had content to send ("between two frames"); ``False`` models one
    whose last content chunk had already gone ("after the last content chunk").
    Either way the terminal frame never leaves.
    """

    def __init__(self, holder: Dict[str, Any], more_after_gate: bool) -> None:
        super().__init__([])
        self.holder = holder
        self.more_after_gate = more_after_gate
        self.closed_event = threading.Event()

    def __iter__(self):
        yield content_chunk("PARTIAL-DISCONNECTED-TOKEN ")
        cancel = self.holder["cancel"]
        assert cancel.wait(timeout=10), "the route never set its cancel flag"
        if self.more_after_gate:
            yield content_chunk("NEVER-DELIVERED ")
        yield finish_chunk("stop")

    def close(self) -> None:
        super().close()
        self.closed_event.set()


class _ReleasableStream(FakeStream):
    """A second reply held open until the test releases it."""

    def __init__(self, chunks, release: threading.Event, started: threading.Event) -> None:
        super().__init__(chunks)
        self.release = release
        self.started = started

    def __iter__(self):
        self.started.set()
        assert self.release.wait(timeout=10), "the second reply was never released"
        yield from super().__iter__()


class TestAClosedTabCancelsItsOwnTurnOnly:
    """D10 at the route: a vanished client cancels its turn, nobody else's.

    The behaviour already existed in the SSE generator's ``finally``; what these
    cases prove is that the per-workspace slot did not weaken it. A second
    workspace's reply is held open across the disconnect and then has to finish
    normally — the same pair of facts spec §5.3 rule 18 asks for.
    """

    @pytest.mark.parametrize(
        "more_after_gate",
        [True, False],
        ids=["between-two-frames", "after-last-content"],
    )
    def test_a_disconnect_cancels_only_that_workspace(
        self, client, monkeypatch: pytest.MonkeyPatch, tmp_path: Path,
        more_after_gate: bool,
    ):
        alpha = tmp_path / "alpha"
        beta = tmp_path / "beta"
        for root in (alpha, beta):
            root.mkdir()

        holders: Dict[str, Dict[str, Any]] = {
            "model-chat": {},
            "model-code": {},
        }
        streams: Dict[str, Any] = {}
        beta_started = threading.Event()
        release_beta = threading.Event()

        def completion(**kwargs):
            model = kwargs["model"]
            if model == "model-chat":
                stream = _CancelAwareStream(
                    holders[model], more_after_gate=more_after_gate
                )
            else:
                stream = _ReleasableStream(
                    [content_chunk("BETA-ANSWER"), finish_chunk("stop")],
                    release=release_beta,
                    started=beta_started,
                )
            streams[model] = stream
            return stream

        def captured(messages, model, server_url, emit, sampling=None, **kwargs):
            holders[model]["cancel"] = kwargs.get("cancel_event")
            return chat_core.stream_chat(
                messages, model, server_url, emit, sampling, **kwargs
            )

        _model_per_agent(monkeypatch)
        monkeypatch.setattr(routes, "stream_chat", captured)
        monkeypatch.setattr("src.core.chat.stream_completion", completion)

        answered: Dict[str, Any] = {}

        def run_beta() -> None:
            try:
                answered["beta"] = _post_chat(client, beta, "code")
            except BaseException as exc:  # noqa: BLE001 - surfaced below
                answered["error"] = exc

        beta_thread = threading.Thread(target=run_beta)
        beta_thread.start()
        assert beta_started.wait(timeout=10), (
            "B's turn never started: "
            f"{answered.get('beta').text if 'beta' in answered else answered!r}"
        )

        # A's client reads one frame, then goes away between this frame and the
        # next one (or after the last content chunk, for the other id).
        with client.stream(
            "POST",
            "/api/chat",
            params=workspace_params(alpha),
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "agentMode": "chat",
            },
        ) as response:
            assert response.status_code == 200
            for line in response.iter_lines():
                if line.startswith("data: "):
                    payload = json.loads(line[len("data: "):])
                    if payload.get("event") == "token":
                        break

        alpha_stream = streams["model-chat"]
        assert alpha_stream.closed_event.wait(timeout=10), (
            "the worker's upstream stream was never closed"
        )
        cancel = holders["model-chat"]["cancel"]
        assert cancel is not None
        assert cancel.is_set(), "the disconnect did not arm the turn's cancel flag"
        assert alpha_stream.close_calls >= 1
        # B is untouched: still streaming, and no terminal frame yet.
        assert release_beta.is_set() is False
        assert beta_thread.is_alive()

        release_beta.set()
        beta_thread.join(timeout=15)
        assert beta_thread.is_alive() is False
        beta_frames = _events(answered["beta"].text)
        assert [name for name, _p in beta_frames] == ["token", "done"]
        assert beta_frames[0][1]["text"] == "BETA-ANSWER"

        # The partial reply was kept nowhere: no chat/transcript table exists,
        # and no file in the workspace carries the fragment.
        from src.core import appdb

        tables = {
            row[0].lower()
            for row in appdb.connection().execute(
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }
        assert not any(
            word in table
            for table in tables
            for word in ("chat", "message", "conversation", "transcript")
        ), tables
        for path in alpha.rglob("*"):
            if not path.is_file():
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            assert "PARTIAL-DISCONNECTED-TOKEN" not in text, path
            assert "NEVER-DELIVERED" not in text, path


class TestStreamChatPause:
    """``pause_event`` interrupts a reply without throwing its context away.

    The ack must be terminal and unambiguous (no ``done``, no ``error``, no
    truncation frame — the pause itself closed the stream, so no finish_reason
    was ever expected), and it must carry the exact usage of the partial turn.
    """

    def _run(self, monkeypatch, generator, **kwargs):
        monkeypatch.setattr("src.core.chat.stream_completion", lambda **kw: generator)
        events = []
        chat_core.stream_chat(
            [{"role": "user", "content": "hi?"}],
            "model-a",
            "http://server:8080/v1",
            events.append,
            **kwargs,
        )
        return events

    def test_paused_reply_ends_on_pause_ack(self, monkeypatch):
        pause = threading.Event()
        pause.set()
        events = self._run(
            monkeypatch,
            FakeStream([content_chunk("half an "), content_chunk("answer")]),
            pause_event=pause,
        )
        names = [e["event"] for e in events]
        # Nothing streamed (the flag was armed before the first chunk), but the
        # ack is still terminal and preceded by the usage frame.
        assert names == ["usage", "pause_ack"]
        assert events[-1]["partial"] is True
        assert "done" not in names and "error" not in names

    def test_pause_is_never_reported_as_a_truncation(self, monkeypatch):
        pause = threading.Event()
        pause.set()
        events = self._run(
            monkeypatch,
            FakeStream([content_chunk("partial")]),
            pause_event=pause,
        )
        assert not [e for e in events if e["event"] == "error"]
        assert not [e for e in events if e.get("truncated")]

    def test_pause_closes_the_upstream_stream(self, monkeypatch):
        pause = threading.Event()
        pause.set()
        stream = FakeStream([content_chunk("x")])
        self._run(monkeypatch, stream, pause_event=pause)
        assert stream.closed

    def test_pause_mid_stream_keeps_only_the_tokens_so_far(self, monkeypatch):
        # The check is per chunk: a flag armed after N chunks must stop the
        # loop there, not at the end of the stream.
        pause = threading.Event()

        def gen():
            for i in range(10):
                if i == 3:
                    pause.set()
                yield content_chunk(f"t{i}")

        events = self._run(monkeypatch, gen(), pause_event=pause)
        tokens = [e["text"] for e in events if e["event"] == "token"]
        assert tokens == ["t0", "t1", "t2"]
        assert events[-1]["event"] == "pause_ack"

    def test_partial_tokens_then_usage_then_the_ack(self, monkeypatch):
        # The flag is armed after the server's usage chunk: what streamed so
        # far is kept, the usage frame carries the exact cumulative figures,
        # and the ack terminates the reply (the chunk after the flag is gone).
        pause = threading.Event()

        def gen():
            yield content_chunk("par")
            yield usage_chunk(prompt=40, completion=8, total=48)
            pause.set()
            yield content_chunk("tially-streamed-but-skipped")

        events = self._run(monkeypatch, gen(), pause_event=pause)
        names = [e["event"] for e in events]
        assert names == ["token", "usage", "pause_ack"]
        usage = events[1]
        assert usage["tokens"] == 8
        assert usage["contextTokens"] == 48
        assert usage["contextEstimated"] is False
        assert not [e for e in events if e.get("text", "").startswith("tially")]

    class DrainThenArm:
        """A stream that arms ``event`` only once its chunks are all delivered.

        ``saw_finish_reason`` is delegated to the double underneath, so the race
        below is judged on what the stream really carried rather than on an
        attribute a stub declared up front.
        """

        def __init__(self, stream, event):
            self._stream = stream
            self._event = event

        def __iter__(self):
            yield from self._stream
            self._event.set()

        @property
        def saw_finish_reason(self):
            return self._stream.saw_finish_reason

        @property
        def closed(self):
            return self._stream.closed

        def close(self):
            self._stream.close()

    def test_flag_armed_after_the_last_chunk_still_ends_on_done(self, monkeypatch):
        # The race: the round streamed to its end with a real finish_reason and
        # the flag was armed only after that last chunk. The reply is complete,
        # so `done` wins — a round that carries its finish_reason was never
        # interrupted, whatever the flag says afterwards.
        pause = threading.Event()
        stream = self.DrainThenArm(
            FakeStream([content_chunk("whole answer"), finish_chunk("stop")]), pause
        )
        events = self._run(monkeypatch, stream, pause_event=pause)
        names = [e["event"] for e in events]
        assert names == ["token", "done"]

    def test_cancel_wins_over_a_pause_on_the_same_chunk(self, monkeypatch):
        # Stop after Pause: the client is gone, so nothing may be emitted —
        # the cancel check comes first at every pause site.
        cancel = threading.Event()
        cancel.set()
        pause = threading.Event()
        pause.set()
        stream = FakeStream([content_chunk("x")])
        events = self._run(
            monkeypatch, stream, cancel_event=cancel, pause_event=pause
        )
        assert events == []
        assert stream.closed

    def test_pause_while_tool_calls_stream_never_runs_them(self, monkeypatch):
        # The dangerous shape: tool-call arguments only half-streamed, so
        # executing them would feed the model invalid JSON of its own cutting.
        executed = []
        pause = threading.Event()

        def gen():
            yield {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "call-1",
                                    "function": {
                                        "name": "execute_command",
                                        "arguments": '{"command": "ls',
                                    },
                                }
                            ]
                        }
                    }
                ]
            }
            pause.set()
            yield content_chunk("must not stream")

        events = self._run(
            monkeypatch,
            gen(),
            pause_event=pause,
            tools=[{"type": "function", "function": {"name": "execute_command"}}],
            tool_executor=lambda name, args: executed.append(name) or "ok",
        )
        assert executed == []
        assert not [e for e in events if e["event"] == "tool_call"]
        assert events[-1]["event"] == "pause_ack"

    def test_pause_asked_during_a_tool_run_ends_between_rounds(self, monkeypatch):
        # A running tool is allowed to finish (its `tool_result` still lands,
        # so the badge never sticks on "running"), and the next round is never
        # started. No extra `usage` frame: this round's figures went out as the
        # pre-tool one.
        pause = threading.Event()

        def executor(name, args):
            pause.set()
            return "done"

        chunks_round_one = [
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "call-1",
                                    "function": {
                                        "name": "execute_command",
                                        "arguments": '{"command": "ls"}',
                                    },
                                }
                            ]
                        }
                    }
                ]
            },
            usage_chunk(prompt=10, completion=4, total=14),
        ]

        monkeypatch.setattr(
            "src.core.chat.stream_completion",
            lambda **kw: FakeStream(
                chunks_round_one + [finish_chunk("tool_calls")]
            ),
        )
        events = []
        chat_core.stream_chat(
            [{"role": "user", "content": "hi?"}],
            "model-a",
            "http://server:8080/v1",
            events.append,
            pause_event=pause,
            tools=[{"type": "function", "function": {"name": "execute_command"}}],
            tool_executor=executor,
        )
        names = [e["event"] for e in events]
        # `usage` precedes the tool badges (it is emitted as soon as that
        # round stops generating), and the ack is the only terminal frame.
        assert names == ["usage", "tool_call", "tool_result", "pause_ack"]


# -- the skills fixtures (skl-04) -------------------------------------------------
#
# The catalogue cases below plant skills in **their own** throw-away folders and
# pin the user scope's home at another one. skl-06's autouse guard
# (``conftest._every_test_gets_its_own_home``) now pins it for every test; these
# cases keep their own pin because they plant a *user-level* skill and so name the
# folder they write into — an ordinary override of the guard, which is allowed.

def write_skill(root: Path, folder: str, *, description: str) -> Path:
    """A skill folder with a readable header under ``root``'s skills root."""
    skill = root.joinpath(*skills.SKILLS_ROOT_PARTS) / folder
    skill.mkdir(parents=True, exist_ok=True)
    (skill / skills.SKILLS_FILENAME).write_text(
        f"---\ndescription: {description}\n---\n\nthe body\n", encoding="utf-8"
    )
    return skill


@pytest.fixture
def pinned_home(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The user scope's home, pinned at a throw-away folder with no skills.

    A **sibling** of ``tmp_path``, the way the suite's own guards are, so a case
    asserting a folder it pointed at stayed empty is not disturbed by the home
    tree. ``skills.user_home()`` is the seam (task 01): the one place the user
    scope's folder is computed.
    """
    folder = tmp_path.parent / f"{tmp_path.name}-home"
    folder.mkdir(exist_ok=True)
    monkeypatch.setattr(
        skills, "user_home", lambda: workspace.canonical(str(folder))
    )
    return folder


def add_agent(client, agent_id: str, label: str, **fields: Any) -> Dict[str, Any]:
    """Create one agent through the route the dialog uses, and answer its row.

    The model association comes from whatever the store already holds, so a test
    that says nothing about models gets the harness's one row — a turn needs an
    agent *and* a model (D5), and a created agent with neither would be a refusal
    this file is not about. A test that wants the refusal states it itself.
    """
    if "modelId" not in fields:
        fields["modelId"] = next(
            (
                agent["modelId"]
                for agent in client.get("/api/agents").json()["agents"]
                if agent["modelId"] is not None
            ),
            None,
        )
    response = client.post("/api/agents/add", json={
        "id": agent_id, "label": label, **fields,
    })
    assert response.status_code == 200, response.json()
    return {agent["id"]: agent for agent in response.json()["agents"]}[agent_id]


class TestAgentModePromptAssembly:
    """The resolved agent's words reach ``POST /api/chat``'s system message.

    The agents are rows now, so the persona a turn runs as is the row the route
    read — created through the very route the dialog uses, which is what makes
    this the request path rather than a mock of it. The stub records the
    ``stream_chat`` kwargs, where the substitution happens; the six-part *order*
    belongs to ``core.chat`` and is pinned in ``TestStreamChat`` above.
    """

    @pytest.fixture
    def mode_client(self, client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
        """``client`` on a scratch workspace with AGENTS.md, plus the stub's kwargs."""
        (tmp_path / "AGENTS.md").write_text("# rules\n\nUse pytest.\n", encoding="utf-8")
        seen: Dict[str, Any] = {}

        def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
                 pause_event=None, api_key="none", sysprompt=None,
                 agent_instructions=None, skills_instructions=None,
                 mode_instructions=None, **tools):
            seen.clear()
            seen["sysprompt"] = sysprompt
            seen["agent_instructions"] = agent_instructions
            seen["skills_instructions"] = skills_instructions
            if mode_instructions is not None:
                seen["mode_instructions"] = mode_instructions
            seen.update(tools)
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 0,
                  "tokensEstimated": False})

        monkeypatch.setattr(routes, "stream_chat", fake)
        yield client, tmp_path, seen

    @staticmethod
    def _post(client, agent: str = "builder") -> None:
        response = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "hi"}],
                  "agentMode": agent},
        )
        assert response.status_code == 200

    def test_the_persona_replaces_the_configured_prompt(self, mode_client):
        client, _root, seen = mode_client
        add_agent(client, "builder", "Builder", systemMessage="PERSONA TEXT")
        self._post(client)
        assert seen["sysprompt"] == "PERSONA TEXT"
        # D8: alternatives, never stacked — the model's own prompt is gone.
        assert DEFAULT_LLM_SYSPROMPT not in seen["sysprompt"]

    def test_an_empty_persona_falls_back_to_the_configured_prompt(
        self, mode_client
    ):
        # The escape hatch, as a supported path: an empty persona restores the
        # pre-agent behaviour with no code change.
        client, _root, seen = mode_client
        add_agent(client, "builder", "Builder", systemMessage="")
        self._post(client)
        assert seen["sysprompt"] == DEFAULT_LLM_SYSPROMPT

    def test_a_missing_persona_is_the_same_fallback(self, mode_client):
        client, _root, seen = mode_client
        add_agent(client, "builder", "Builder")
        self._post(client)
        assert seen["sysprompt"] == DEFAULT_LLM_SYSPROMPT

    def test_an_agent_without_blocks_keeps_the_call_shape(self, mode_client):
        # ``mode_instructions`` is passed only when the agent has blocks (the
        # conditional shape already used for ``batch_instructions``), so every
        # ordinary chat request is unaffected.
        client, _root, seen = mode_client
        add_agent(client, "builder", "Builder", systemMessage="PERSONA")
        self._post(client)
        assert "mode_instructions" not in seen

    def test_the_app_owned_agent_blocks_reach_the_call(self, mode_client):
        # Only the app-owned agent carries blocks; it is a real row, so picking
        # it is the supported path rather than a monkeypatch.
        client, _root, seen = mode_client
        self._post(client, modes_defaults.TODO_BUILDER_MODE_ID)
        assert seen["mode_instructions"] == "\n\n".join(
            modes_defaults.todo_builder_mode().instructions
        )
        assert modes_defaults.lot_conventions_block() in seen["mode_instructions"]

    def test_the_project_instructions_arrive_for_a_tools_off_agent(
        self, mode_client
    ):
        # AGENTS.md is unconditional. An agent with both hub flags false still
        # gets the project block.
        client, root, seen = mode_client
        add_agent(client, "builder", "Builder", systemMessage="PERSONA TEXT",
                  mcpEnable=False, lspEnable=False)
        self._post(client)
        assert seen["agent_instructions"].endswith("Use pytest.")
        assert f"project root is {root}" in seen["agent_instructions"]

    def test_the_agent_is_resolved_per_request(self, mode_client):
        # Hot edit, no cache layer: the persona of the *next* turn of a
        # conversation is the row says now (D11).
        client, _root, seen = mode_client
        add_agent(client, "builder", "Builder", systemMessage="PERSONA ONE")
        self._post(client)
        assert seen["sysprompt"] == "PERSONA ONE"
        assert client.post("/api/agents/save", json={
            "id": "builder", "systemMessage": "PERSONA TWO",
        }).status_code == 200
        self._post(client)
        assert seen["sysprompt"] == "PERSONA TWO"

    def test_a_damaged_store_still_chats_on_what_it_can_render(self, mode_client):
        """D7 on the request path: a bad row costs the user that agent, not the turn.

        The store's agent read never raises (task 03), so a row the reader cannot
        render is reported and the rest stand — a chat turn naming a *good* agent
        still runs.
        """
        from src.core import appdb

        client, _root, seen = mode_client
        conn = appdb.connection()
        conn.execute("UPDATE agents SET label = '' WHERE id = 'architect'")
        self._post(client, "code")
        assert seen["sysprompt"] == "\n".join(modes_defaults.CODE_PERSONA)

    def test_nothing_anywhere_can_suppress_the_project_instructions(self):
        # The invariant, stated as a test: AGENTS.md is always injected.
        # Neither the core, the agent vocabulary nor a request body carries a
        # knob for it, so no caller — a later feature or a hand-edited row —
        # can ask for a conversation without them.
        #
        # The skills catalogue (skl-04) is the **first conditional block on this
        # rail**, and this case's whole technique is reading the route for a
        # conditional shape — so it is worth stating what it actually forbids.
        # The §5.19 gate is a *server-computed precondition*, not a suppression
        # knob: it is derived from the tool set the turn was already given by the
        # three admission gates, so no request body, no stored row and no caller
        # can forge it (ask for a catalogue on a turn that cannot read a file) or
        # waive it (hide one from a turn that can). And no parameter anywhere —
        # in ``stream_chat``, in the route or in ``ChatIn`` — asks for or
        # suppresses a catalogue: the route forwards the server's own text, and
        # ``""`` is that text's "nothing to inject" answer. A precondition the
        # server computes and a switch the caller holds are different kinds of
        # thing, and only the second is what this case is written to catch.
        import inspect

        def suppressed_names(names) -> list:
            """Any name that reads like a switch over the instruction blocks."""
            out = []
            for name in names:
                lowered = name.lower()
                if "agents_md" in lowered or "agentsmd" in lowered:
                    out.append(name)
                elif lowered.startswith(("include_", "without_", "skip_",
                                         "no_", "suppress_")):
                    out.append(name)
            return sorted(out)

        assert suppressed_names(chat_core.stream_chat.__code__.co_varnames) == []
        # Still empty with the skills block on the rail: ``skills_instructions``
        # matches none of those prefixes, and no ``ChatIn`` field was added for
        # it (§5.20) — the vocabulary check passes because the request model is
        # byte-for-byte what it was.
        assert suppressed_names(routes.ChatIn.model_fields) == []
        # And no field of the request body mentions skills at all, in any
        # spelling: the block has no client-facing switch.
        assert [name for name in routes.ChatIn.model_fields
                if "skill" in name.lower()] == []
        # The instruction arguments are the only injection points, and each is
        # appended to the system message, never allowed to replace it: the route
        # passes ``agent_instructions=agent_instructions_block()`` with no
        # condition anywhere around it. ``skills_instructions`` is named here
        # explicitly, so a fifth instruction argument is a deliberate edit to
        # this assertion and not an accident (spec §10).
        params = list(inspect.signature(chat_core.stream_chat).parameters)
        assert [p for p in params if "instructions" in p] == [
            "agent_instructions", "skills_instructions",
            "mode_instructions", "batch_instructions",
        ]
        route_source = inspect.getsource(routes)
        # Exactly one call site, passed unconditionally — never through the
        # conditional-kwarg shape the two optional blocks use.
        assert route_source.count(
            "agent_instructions=agent_instructions_block(),") == 1
        assert '"agent_instructions"' not in route_source
        # The same for the catalogue: one unconditional keyword whose value is
        # the server's own string, never a conditional-kwarg shape and never a
        # boolean.
        assert route_source.count("skills_instructions=skills_block,") == 1
        assert '"skills_instructions"' not in route_source

    def test_the_six_parts_arrive_in_order_through_the_route(self, mode_client,
                                                             pinned_home,
                                                             monkeypatch):
        """End to end, six parts: persona → notice → AGENTS.md → skills → blocks → lot.

        Extended (not replaced) by skl-04: this is the case spec §10 tells the
        skills task to widen, because §5.16 inserts the catalogue between
        ``AGENTS.md`` and the mode's blocks — so the six parts are asserted in
        order, and the count is asserted too. The stub above only sees the
        kwargs; this lets the *real* ``stream_chat`` run (with the LLM client
        seam stubbed) so the assertion is on the system message that would leave
        the process, with a persona, a skill, blocks and ``batchContext`` all in
        play at once.
        """
        client, root, _seen = mode_client
        # A real skill in the request's own workspace, so the block the route
        # renders comes from the same scan a turn gets. The user scope is pinned
        # empty by ``pinned_home`` (an override of skl-06's autouse guard, which
        # already keeps every test off this machine's home).
        write_skill(root, "pdf-processing", description="Handles PDF files.")

        class Hub:
            def status(self):
                return []

            def active_tool_defs(self, ids):
                return ([{"type": "function", "function": {"name": "read_file"}}],
                        {"read_file": "console"})

            def call_tool_sync(self, cid, name, args):
                return "ok"

        # The double rides on the workspace this fixture pinned, because that is
        # the folder the request is answered about (clws-06).
        set_workspace_hubs(client.app, root, mcp=Hub())
        monkeypatch.setattr(routes, "_active_connector_ids", lambda: ["console"])
        captured: Dict[str, Any] = {}
        monkeypatch.setattr(routes, "stream_chat", chat_core.stream_chat)
        monkeypatch.setattr(
            "src.core.chat.stream_completion",
            lambda **kwargs: captured.update(kwargs) or iter([]),
        )
        # An agent of the same shape as the app-owned one — persona plus blocks
        # — with a persona that does not use the word "tool", so the notice is
        # expected (its own behaviour is pinned in TestStreamChat above).
        monkeypatch.setattr(
            routes.agent_modes, "resolve_mode",
            lambda mode_id: (agent_modes.AgentMode(
                id="builder", label="Builder", system_message="PERSONA TEXT",
                mcptools=True, lsptools=False, readonly=True,
                instructions=("MODE BLOCKS", "SECOND MODE BLOCK"),
            ), []),
        )
        response = client.post("/api/chat", json={
            "messages": [{"role": "user", "content": "hi"}],
            "agentMode": "builder",
            "batchContext": "The lot: tasks 1 to 8.",
        })
        assert response.status_code == 200
        content = captured["messages"][0]["content"]
        parts = [
            content.index("PERSONA TEXT"),
            content.index(chat_core.TOOL_NOTICE.strip()),
            content.index("# rules"),
            content.index("pdf-processing"),
            content.index("MODE BLOCKS\n\nSECOND MODE BLOCK"),
            content.index("The lot: tasks 1 to 8."),
        ]
        assert parts == sorted(parts)
        assert len(set(parts)) == 6
        # The catalogue is the §5.16 block, not a stray mention: it carries the
        # path the model is meant to open, in the workspace the request named.
        assert str(root.joinpath(*skills.SKILLS_ROOT_PARTS)) in content



class TestChatMcpFilter:
    """``mcpEnabled`` (Chat tab conversation toggles) intersects the active ids."""

    class RecordingManager:
        installed = True

        def __init__(self):
            self.requested_ids = None

        def status(self):
            return []

        def active_tool_defs(self, ids):
            self.requested_ids = list(ids)
            tools = [
                {"type": "function", "function": {"name": f"use_{cid}"}}
                for cid in ids
            ]
            return tools, {f"use_{cid}": cid for cid in ids}

        def call_tool_sync(self, cid, name, args):
            return "ok"

    @pytest.fixture
    def mcp_setup(self, client, monkeypatch):
        monkeypatch.setattr(routes, "_active_connector_ids", lambda: ["alpha", "beta"])
        manager = self.RecordingManager()
        set_workspace_hubs(client.app, client.root, mcp=manager)

        seen = {}

        def fake(messages, model, server_url, emit, sampling=None,
                 cancel_event=None, api_key="none", sysprompt=None, **kwargs):
            seen.update(kwargs)
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 0,
                  "tokensEstimated": False})

        monkeypatch.setattr(routes, "stream_chat", fake)
        return client, manager, seen

    @staticmethod
    def _post(client, extra=None):
        body = {"messages": [{"role": "user", "content": "hi"}]}
        body.update(extra or {})
        response = client.post("/api/chat", json=body)
        assert response.status_code == 200
        return response

    def test_mcp_enabled_intersects_active_ids(self, mcp_setup):
        client, manager, seen = mcp_setup
        self._post(client, {"mcpEnabled": ["beta"]})
        assert manager.requested_ids == ["beta"]
        assert seen["tool_servers"] == {"use_beta": "beta"}

    def test_mcp_enabled_absent_keeps_all_active(self, mcp_setup):
        client, manager, seen = mcp_setup
        self._post(client)
        assert manager.requested_ids == ["alpha", "beta"]
        assert set(seen["tool_servers"]) == {"use_alpha", "use_beta"}

    def test_empty_mcp_enabled_disables_all_tools(self, mcp_setup):
        client, manager, seen = mcp_setup
        self._post(client, {"mcpEnabled": []})
        assert manager.requested_ids == []
        # No tools at all: the no-MCP stream_chat call shape is preserved.
        assert "tools" not in seen

    def test_unknown_ids_are_dropped_by_the_intersection(self, mcp_setup):
        client, manager, _seen = mcp_setup
        self._post(client, {"mcpEnabled": ["beta", "gone_mcp"]})
        assert manager.requested_ids == ["beta"]

    def test_mcp_enabled_wrong_type_returns_422(self, mcp_setup):
        client, _manager, _seen = mcp_setup
        response = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "hi"}],
                  "mcpEnabled": "beta"},
        )
        assert response.status_code == 422


class TestAgentModeToolGate:
    """am-05: the mode's two booleans decide whether a hub reaches the *model*.

    Three levels gate the tool loop and they only ever **intersect** (D4):
    Settings (``_active_connector_ids`` / ``_active_server_ids``), the mode
    (``mcptools`` / ``lsptools``) and the conversation (``mcpEnabled`` /
    ``lspEnabled``). ``_chat_tool_kwargs`` is where they meet, so most of what
    is asserted here is the kwargs dict the route hands ``stream_chat`` —
    including the one assertion that is the requirement rather than a detail:
    a gated request has **no ``tools`` key at all**, never ``tools=[]``, which
    is a different request to an OpenAI-compatible server.
    """

    class HubSetStub:
        """Just enough of a ``HubSet`` for the two hub lookups.

        ``_chat_tool_kwargs`` takes the **workspace's** set rather than a request
        (clws-06): which folder a turn is about is the caller's answer, so the
        helper only ever reaches ``.mcp`` and ``.lsp`` on what it is handed.
        """

        def __init__(self, mcp, lsp):
            self.mcp = mcp
            self.lsp = lsp

    class Hub:
        """Answers ``active_tool_defs`` from the ids it was *given*, as MCP does."""

        installed = True

        def __init__(self):
            self.requested_ids: List[List[str]] = []

        def status(self):
            return []

        def active_tool_defs(self, ids):
            self.requested_ids.append(list(ids))
            tools = [
                {"type": "function", "function": {"name": f"use_{cid}"}}
                for cid in ids
            ]
            return tools, {f"use_{cid}": cid for cid in ids}

        def call_tool_sync(self, cid, name, args, timeout=30.0):
            return "ok"

    @staticmethod
    def _mode(mcptools: bool, lsptools: bool) -> agent_modes.AgentMode:
        return agent_modes.AgentMode(
            id="gated", label="Gated", system_message="PERSONA",
            mcptools=mcptools, lsptools=lsptools,
        )

    @pytest.fixture
    def hubs(self, client, monkeypatch):
        """Both hubs live and Settings-activated; nothing is mode-gated yet."""
        monkeypatch.setattr(routes, "_active_connector_ids", lambda: ["console"])
        monkeypatch.setattr(routes, "_active_server_ids", lambda: ["pyright"])
        mcp, lsp = self.Hub(), self.Hub()
        # No pool involvement: these cases call ``_chat_tool_kwargs`` directly and
        # hand it the workspace's set, so the two doubles are the whole world the
        # helper sees (clws-06 moved the lookup out of the helper and into its
        # caller).
        return client, mcp, lsp

    @staticmethod
    def _names(kwargs) -> List[str]:
        return [d["function"]["name"] for d in kwargs.get("tools", [])]

    def test_both_flags_false_leaves_no_tools_key_at_all(self, hubs):
        client, mcp, lsp = hubs
        # The connector is Settings-activated *and* ticked in the conversation;
        # the mode still takes it away, and it does so by emptying the list the
        # hub is asked for — no tool definition is ever serialised.
        kwargs = routes._chat_tool_kwargs(
            self.HubSetStub(mcp, lsp), ["console"], ["pyright"],
            mode=self._mode(False, False),
        )
        assert kwargs == {}
        assert mcp.requested_ids == [[]] and lsp.requested_ids == [[]]
        # The requirement, stated as the assertion: no ``tools`` **key**, never
        # ``tools == []`` — the LLM client forwards what it is handed, and an
        # empty array is a different request to an OpenAI-compatible server.
        assert "tools" not in kwargs
        assert "tool_executor" not in kwargs
        assert "tool_servers" not in kwargs
        # The iteration cap belongs to the tool loop, so gating the only hub
        # that had tools must not leave one behind (the LSP-only branch of the
        # merge is where it would leak from).
        assert "max_tool_iterations" not in kwargs

    def test_gating_the_only_hub_with_tools_drops_the_iteration_cap(self, hubs,
                                                                   monkeypatch):
        # Only MCP has tools here, and the mode closes it. The merge's LSP-only
        # branch (``{**lsp_kwargs, "max_tool_iterations": …}``) must not fire for
        # an empty ``lsp_kwargs``: the request has no tool loop at all, so a cap
        # alone would be a ``stream_chat`` call shape no hub asked for.
        client, mcp, lsp = hubs
        monkeypatch.setattr(routes, "_active_server_ids", lambda: [])
        kwargs = routes._chat_tool_kwargs(
            self.HubSetStub(mcp, lsp), ["console"], mode=self._mode(False, True)
        )
        assert kwargs == {}
        assert mcp.requested_ids == [[]]
        assert lsp.requested_ids == [[]]
        for key in ("tools", "tool_executor", "tool_servers",
                    "max_tool_iterations"):
            assert key not in kwargs

    def test_mcp_gate_leaves_the_lsp_hub_alone(self, hubs):
        client, mcp, lsp = hubs
        kwargs = routes._chat_tool_kwargs(
            self.HubSetStub(mcp, lsp), ["console"], ["pyright"],
            mode=self._mode(False, True),
        )
        assert mcp.requested_ids == [[]]
        assert lsp.requested_ids == [["pyright"]]
        # One hub off, the other still whole — the gate is per hub, not global.
        assert self._names(kwargs) == ["use_pyright"]
        assert kwargs["tool_servers"] == {"use_pyright": "pyright"}

    def test_lsp_gate_leaves_the_mcp_hub_alone(self, hubs):
        client, mcp, lsp = hubs
        kwargs = routes._chat_tool_kwargs(
            self.HubSetStub(mcp, lsp), ["console"], ["pyright"],
            mode=self._mode(True, False),
        )
        assert lsp.requested_ids == [[]]
        assert mcp.requested_ids == [["console"]]
        assert self._names(kwargs) == ["use_console"]

    def test_a_mode_flag_cannot_grant_a_settings_disabled_hub(self, hubs,
                                                             monkeypatch):
        # The invariant a future "let the mode pick the connectors" refactor
        # would break: the mode only ever *narrows*, so both flags being true
        # hands the model nothing that Settings unticked.
        client, mcp, lsp = hubs
        monkeypatch.setattr(routes, "_active_connector_ids", lambda: [])
        monkeypatch.setattr(routes, "_active_server_ids", lambda: [])
        kwargs = routes._chat_tool_kwargs(
            self.HubSetStub(mcp, lsp), mode=self._mode(True, True)
        )
        assert kwargs == {}
        assert mcp.requested_ids == [[]]
        assert lsp.requested_ids == [[]]

    def test_a_conversation_toggle_still_narrows_a_mode_open_hub(self, hubs,
                                                                monkeypatch):
        # Settings stays the authority at the finest level too: an open mode
        # does not re-tick a connector this thread switched off.
        client, mcp, lsp = hubs
        monkeypatch.setattr(routes, "_active_connector_ids",
                            lambda: ["alpha", "beta"])
        kwargs = routes._chat_tool_kwargs(
            self.HubSetStub(mcp, lsp), ["beta"], [], mode=self._mode(True, False)
        )
        assert mcp.requested_ids == [["beta"]]
        assert lsp.requested_ids == [[]]
        assert self._names(kwargs) == ["use_beta"]
        # …and a thread that switches the last one off ends with no tools, even
        # though its mode opens the hub (the empty list means "nothing in it",
        # which is what the mode gate relies on too).
        kwargs = routes._chat_tool_kwargs(
            self.HubSetStub(mcp, lsp), [], [], mode=self._mode(True, True)
        )
        assert kwargs == {}

    def test_mode_none_keeps_the_pre_feature_call_shape(self, hubs, tmp_path, monkeypatch):
        # The regression guard: every call site that existed before the feature
        # (and every existing test in this file) sees exactly the kwargs it saw
        # then — same keys, same merged tool list, same cap.
        from tests.conftest import neutralise_store

        client, mcp, lsp = hubs
        # The cap is the resolved agent's own column now (D9), not the env key.
        neutralise_store(monkeypatch, tmp_path, maxToolIteration=7)
        from src.core import appdb
        agent, _findings = appdb.resolve_agent("code")
        request = self.HubSetStub(mcp, lsp)
        without = routes._chat_tool_kwargs(request, agent=agent)
        with_mode = routes._chat_tool_kwargs(
            request, mode=self._mode(True, True), agent=agent
        )
        # ``mcp_tool_names`` is the §5.19 gate's own bookkeeping: the merge
        # records which admitted tools are MCP's, and the route pops the key
        # before ``stream_chat`` sees the dict (pinned by
        # ``TestTheSkillsCatalogueRidesTheSystemMessage``). Every key the loop
        # itself consumes is exactly what it was.
        assert set(without) == {
            "tools", "tool_executor", "tool_servers", "max_tool_iterations",
            "uncapped_tool_names", "mcp_tool_names",
        }
        assert without["max_tool_iterations"] == 7
        assert self._names(without) == ["use_console", "use_pyright"]
        assert without["tool_servers"] == {
            "use_console": "console", "use_pyright": "pyright",
        }
        # The merged shape names the LSP tools as the uncapped ones, so the
        # loop only counts the MCP round against the cap (that knob is MCP's).
        assert without["uncapped_tool_names"] == {"use_pyright"}
        assert self._names(with_mode) == self._names(without)
        assert set(with_mode) == set(without)
        # Both hubs really did merge, so the cases above are removing something.
        assert without["tool_executor"]("use_pyright", {}) == "ok"

    # -- the same verdict, through ``POST /api/chat`` --------------------------

    @pytest.fixture
    def route_client(self, client, tmp_path: Path, monkeypatch):
        """Real ``stream_chat`` on a scratch workspace; the seam is the spy."""
        (tmp_path / "AGENTS.md").write_text("# rules\n\nUse pytest.\n", encoding="utf-8")
        hub = self.Hub()
        # The double goes on **this** workspace's set: the client names this
        # folder on every request (clws-02), so this is the answered folder.
        set_workspace_hubs(client.app, tmp_path, mcp=hub)
        monkeypatch.setattr(routes, "_active_connector_ids", lambda: ["console"])
        captured: Dict[str, Any] = {}
        monkeypatch.setattr(routes, "stream_chat", chat_core.stream_chat)
        monkeypatch.setattr(
            "src.core.chat.stream_completion",
            lambda **kwargs: captured.update(kwargs) or iter([]),
        )
        yield client, tmp_path, hub, captured

    def test_a_tools_off_agent_reaches_the_llm_client_with_no_tools(
        self, route_client):
        client, _root, hub, captured = route_client
        add_agent(client, "builder", "Builder", systemMessage="PERSONA TEXT",
                  mcpEnable=False, lspEnable=False)
        response = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "hi"}],
                  "agentMode": "builder", "mcpEnabled": ["console"]},
        )
        assert response.status_code == 200
        assert hub.requested_ids == [[]]
        # Nothing reaches the LLM client as tools. The client turns an absent/
        # empty ``tools`` into a request body with no ``tools`` key at all
        # (pinned in ``tests/test_llmkit_client.py``), so this is the same
        # requirement, asserted at the seam the route now feeds.
        assert not captured.get("tools")
        # D3: with no tools in play, the notice is not appended either — the
        # prompt and the affordance cannot disagree.
        assert chat_core.TOOL_NOTICE.strip() not in captured["messages"][0]["content"]
        # AGENTS.md is unaffected by the gate (am-00's invariant).
        assert "# rules" in captured["messages"][0]["content"]

    def test_a_tools_on_agent_keeps_the_tools_and_the_notice(self, route_client):
        # Same request, same persona, one flipped flag: the tool array and the
        # notice are both back, which is what makes the test above about the
        # agent rather than about the persona's wording.
        client, _root, hub, captured = route_client
        add_agent(client, "builder", "Builder", systemMessage="PERSONA TEXT",
                  mcpEnable=True, lspEnable=False)
        response = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "hi"}],
                  "agentMode": "builder", "mcpEnabled": ["console"]},
        )
        assert response.status_code == 200
        assert hub.requested_ids == [["console"]]
        assert self._names(captured) == ["use_console"]
        assert chat_core.TOOL_NOTICE.strip() in captured["messages"][0]["content"]

    def test_the_shipped_chat_agent_is_a_tools_off_agent(self, route_client,
                                                        monkeypatch):
        # am-00's two ``chat`` bullets against the agents users actually get: the
        # persona's "you have no tools here" is a fact about the request, not a
        # request, and it comes from the seeded row rather than a hand-written
        # one.
        chat = next(
            mode for mode in modes_defaults.default_modes()
            if mode.id == modes_defaults.CHAT_MODE_ID
        )
        assert (chat.mcptools, chat.lsptools) == (False, False)
        client, _root, hub, captured = route_client
        monkeypatch.setattr(routes, "_active_server_ids", lambda: ["pyright"])
        set_workspace_hubs(client.app, _root, lsp=self.Hub())
        response = client.post(
            "/api/chat",
            json={"messages": [{"role": "user", "content": "hi"}],
                  "agentMode": modes_defaults.CHAT_MODE_ID,
                  "mcpEnabled": ["console"], "lspEnabled": ["pyright"]},
        )
        assert response.status_code == 200
        # No tool definition reaches the seam in any shape, and no iteration
        # cap reaches ``stream_chat`` at all.
        assert not captured.get("tools")
        assert "max_tool_iterations" not in captured
        system = captured["messages"][0]["content"]
        assert chat_core.TOOL_NOTICE.strip() not in system
        assert "PERSONA" not in system  # the real persona, not a stub's


class TestTheSkillsCatalogueRidesTheSystemMessage:
    """skl-04: the §5.19 gate, the route's one call site, and §5.18's freshness.

    Every case here is over the real ``POST /api/chat`` with the hubs stubbed the
    way the neighbouring classes stub them, because the gate is a fact about the
    tool set the *route* resolved: a unit test of the helper alone could not tell
    a turn that survived the three admission gates from one that only has a
    connector declared. The scan is spied on rather than stubbed, so "the gate is
    evaluated **before** the scan" (§5.19) is an assertion about the file system
    being touched, not about a return value.

    Hermeticity: each case plants its skills in its own throw-away workspace and
    pins the user scope at an empty throw-away home (``pinned_home``). skl-06's
    autouse guard now keeps every test off this machine's home; these cases keep
    their own pin because they assert an *empty* user root and so name the folder
    the guard moved — an ordinary override of it.
    """

    class Hub:
        """Answers ``active_tool_defs`` from the ids it is given, as both hubs do.

        ``tools_available=False`` is the §5.19 "declared and enabled but never
        started" connector: Settings activates its id and the conversation ticks
        it, yet it offers no tool, so it must not earn a catalogue.
        """

        installed = True

        def __init__(self, tools_available: bool = True):
            self.tools_available = tools_available
            self.requested_ids: List[List[str]] = []

        def status(self):
            return []

        def active_tool_defs(self, ids):
            self.requested_ids.append(list(ids))
            if not self.tools_available:
                return [], {}
            tools = [
                {"type": "function", "function": {"name": f"use_{cid}"}}
                for cid in ids
            ]
            return tools, {f"use_{cid}": cid for cid in ids}

        def call_tool_sync(self, cid, name, args, timeout=30.0):
            return "ok"

    @pytest.fixture
    def turn(self, client, tmp_path: Path, pinned_home: Path, monkeypatch):
        """A scratch workspace, a recording stub, and a spy on the scan."""
        (tmp_path / "AGENTS.md").write_text("# rules\n\nUse pytest.\n", encoding="utf-8")
        seen: Dict[str, Any] = {}
        scans: List[int] = []

        real_scan = skills.scan

        def spy_scan():
            # Counts the scans the *route* asks for; the real scan still runs, so
            # the block a case asserts on is the one the module rendered.
            scans.append(1)
            return real_scan()

        # The route reaches the scan through the module, so patching the module
        # attribute is patching what the route calls.
        monkeypatch.setattr(skills, "scan", spy_scan)

        def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
                 pause_event=None, api_key="none", sysprompt=None, retry_budget=None,
                 agent_instructions=None, skills_instructions=None,
                 mode_instructions=None, **tools):
            seen.clear()
            seen["agent_instructions"] = agent_instructions
            seen["skills_instructions"] = skills_instructions
            seen.update(tools)
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 0,
                  "tokensEstimated": False})

        monkeypatch.setattr(routes, "stream_chat", fake)
        # Settings activates one connector and no language server, so a case that
        # wants an LSP-only turn says so itself and the default is the MCP one.
        monkeypatch.setattr(routes, "_active_connector_ids", lambda: ["console"])
        monkeypatch.setattr(routes, "_active_server_ids", lambda: [])
        yield client, tmp_path, seen, scans

    @staticmethod
    def _post(client, **extra) -> None:
        body = {"messages": [{"role": "user", "content": "hi"}]}
        body.update(extra)
        response = client.post("/api/chat", json=body)
        assert response.status_code == 200, response.text

    # -- the gate says yes -------------------------------------------------------

    def test_the_gate_reads_the_recorded_names_and_no_hub_at_all(self):
        """The helper's own contract, with nothing to look a hub up in.

        It takes the kwargs dict and nothing else, so "it must **not re-run the
        hub lookup**" (§5.19) is a fact of its signature: the three answers below
        are the three the route relies on, and an empty dict is what a tools-off
        agent's mode gate leaves behind.
        """
        assert routes.turn_can_open_a_file({}) is False
        assert routes.turn_can_open_a_file(
            {"tool_servers": {"lsp_pyright_hover": "pyright"}}
        ) is False
        assert routes.turn_can_open_a_file(
            {routes.MCP_TOOL_NAMES_KWARG: set()}
        ) is False
        assert routes.turn_can_open_a_file(
            {routes.MCP_TOOL_NAMES_KWARG: {"read_file"}}
        ) is True

    def test_an_mcp_capable_turn_gets_the_catalogue(self, turn):
        client, root, seen, scans = turn
        write_skill(root, "pdf-processing", description="Handles PDF files.")
        hub = self.Hub()
        set_workspace_hubs(client.app, root, mcp=hub)
        self._post(client)  # ``code``: both hub flags open
        assert seen["skills_instructions"].startswith(skills.CATALOGUE_HEADING)
        assert "pdf-processing" in seen["skills_instructions"]
        # The path the model is told to open is the workspace's own (§5.11).
        assert str(root.joinpath(*skills.SKILLS_ROOT_PARTS)) in seen["skills_instructions"]
        assert scans == [1]
        # The hub was consulted **once** for the turn: the gate answers from the
        # recorded names, never from a second lookup that could disagree.
        assert hub.requested_ids == [["console"]]
        # The gate's own data is the merge's bookkeeping, not a keyword: the route
        # pops it, so nothing the helper read arrives in the splat.
        assert "mcp_tool_names" not in seen

    def test_the_gate_data_never_reaches_stream_chat_as_a_keyword(self, turn,
                                                                 monkeypatch):
        """The one shape that would break every tool-capable turn, pinned.

        ``tool_kwargs`` is splatted into the call, so a key the merge adds for the
        gate and the route forgot to drop would arrive as an unexpected keyword
        argument. This stub spells ``stream_chat``'s documented parameters out and
        takes **no** ``**kwargs``, so the leak is a ``TypeError`` — and the pump
        turns that into an ``error`` frame, which is what the assertion reads.
        """
        client, root, _seen, _scans = turn
        write_skill(root, "pdf-processing", description="Handles PDF files.")
        set_workspace_hubs(client.app, root, mcp=self.Hub())

        def strict(messages, model, server_url, emit, sampling=None,
                   cancel_event=None, pause_event=None, api_key="none",
                   sysprompt=None, tools=None, tool_executor=None,
                   tool_servers=None, max_tool_iterations=25,
                   uncapped_tool_names=None, retry_budget=None,
                   agent_instructions=None, skills_instructions=None,
                   mode_instructions=None, batch_instructions=None):
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 0,
                  "tokensEstimated": False})

        monkeypatch.setattr(routes, "stream_chat", strict)
        response = client.post(
            "/api/chat", json={"messages": [{"role": "user", "content": "hi"}]}
        )
        assert [name for name, _payload in _events(response.text)] == ["done"]

    # -- the gate says no --------------------------------------------------------

    def test_an_lsp_only_turn_gets_nothing(self, turn, monkeypatch):
        # LSP tools answer queries and never file bytes, so a catalogue would tell
        # the model to open a file it has no way to open (§5.19).
        client, root, seen, scans = turn
        write_skill(root, "pdf-processing", description="Handles PDF files.")
        monkeypatch.setattr(routes, "_active_connector_ids", lambda: [])
        monkeypatch.setattr(routes, "_active_server_ids", lambda: ["pyright"])
        set_workspace_hubs(client.app, root, mcp=NO_HUB, lsp=self.Hub())
        self._post(client)
        assert seen["skills_instructions"] == ""
        assert scans == []
        # The turn really was tool-capable, so this is the gate and not an
        # accident of an empty request.
        assert seen["tool_servers"] == {"use_pyright": "pyright"}

    def test_a_tools_off_agent_gets_nothing(self, turn):
        client, root, seen, scans = turn
        write_skill(root, "pdf-processing", description="Handles PDF files.")
        add_agent(client, "builder", "Builder", systemMessage="PERSONA TEXT",
                  mcpEnable=False, lspEnable=False)
        set_workspace_hubs(client.app, root, mcp=self.Hub())
        # The conversation ticks the connector: it is the mode's gate that empties
        # the tool set, which is what the reserved ``todoBuilder`` looks like.
        self._post(client, agentMode="builder", mcpEnabled=["console"])
        assert seen["skills_instructions"] == ""
        assert scans == []
        # AGENTS.md is unaffected — the opposite rule, and its own case above.
        assert seen["agent_instructions"].endswith("Use pytest.")

    def test_a_connector_that_offers_no_tool_earns_no_catalogue(self, turn):
        # The "survived the three admission gates" clause: declared, enabled,
        # ticked — and never started, so it has no tool to read a file with.
        client, root, seen, scans = turn
        write_skill(root, "pdf-processing", description="Handles PDF files.")
        hub = self.Hub(tools_available=False)
        set_workspace_hubs(client.app, root, mcp=hub)
        self._post(client, mcpEnabled=["console"])
        assert hub.requested_ids == [["console"]]
        assert seen["skills_instructions"] == ""
        assert scans == []

    def test_the_scan_is_never_asked_when_the_gate_is_false(self, turn):
        """§5.19's last constraint, as its own case: the cheap answer comes first."""
        client, root, _seen, scans = turn
        write_skill(root, "pdf-processing", description="Handles PDF files.")
        add_agent(client, "builder", "Builder", systemMessage="PERSONA TEXT",
                  mcpEnable=False, lspEnable=False)
        set_workspace_hubs(client.app, root, mcp=self.Hub())
        self._post(client, agentMode="builder")
        assert scans == []

    def test_a_workspace_with_no_skills_root_gets_an_empty_block(self, turn):
        # No skills anywhere: the §5.13 answer is ``""``, forwarded as-is — not a
        # heading, not a sentence about there being none.
        client, root, seen, scans = turn
        set_workspace_hubs(client.app, root, mcp=self.Hub())
        self._post(client)
        assert seen["skills_instructions"] == ""
        # The gate said yes, so the scan *did* run: an absent root is not a
        # refusal, it is just nothing found.
        assert scans == [1]

    # -- the block is the server's, and it is fresh ------------------------------

    def test_the_block_is_re_read_for_every_turn(self, turn):
        """§5.18: edit a ``SKILL.md`` and the next message sees it."""
        client, root, seen, scans = turn
        set_workspace_hubs(client.app, root, mcp=self.Hub())
        write_skill(root, "pdf-processing", description="Handles PDF files.")
        self._post(client)
        first = seen["skills_instructions"]
        assert "Handles PDF files." in first

        write_skill(root, "pdf-processing", description="Now also fills forms.")
        self._post(client)
        second = seen["skills_instructions"]
        assert "Now also fills forms." in second
        assert "Handles PDF files." not in second
        assert first != second
        assert scans == [1, 1]

    def test_no_request_body_can_add_or_remove_the_block(self, turn):
        """§5.20: the gate is the block's only condition, and it is not a field.

        The body vocabulary is what the guard case checks statically; this is the
        same claim on the wire — a field that *sounds* like the knob §5.20 forbids
        is ignored like any other unknown key, and the server's decision stands
        either way.
        """
        client, root, seen, _scans = turn
        write_skill(root, "pdf-processing", description="Handles PDF files.")
        set_workspace_hubs(client.app, root, mcp=self.Hub())

        for extra in (
            {},
            {"skillsEnabled": True},
            {"skipSkills": True},
            {"withoutSkills": True},
            {"includeSkills": False},
            {"noSkills": True},
            {"suppressSkills": True},
            {"agentsMd": False, "skills": "everything"},
            {"batchContext": "The lot: tasks 1 to 8."},
            {"batchContext": None, "mcpEnabled": ["console"]},
        ):
            self._post(client, **extra)
            assert "pdf-processing" in seen["skills_instructions"], extra

        # And the other way round: nothing a caller sends manufactures a
        # catalogue for a turn that cannot read a file.
        add_agent(client, "builder", "Builder", systemMessage="PERSONA TEXT",
                  mcpEnable=False, lspEnable=False)
        for extra in (
            {"skillsEnabled": True},
            {"includeSkills": True},
            {"batchContext": "The lot: tasks 1 to 8."},
        ):
            self._post(client, agentMode="builder", **extra)
            assert seen["skills_instructions"] == "", extra


class TestAToolCallWrittenAsTextIsRepaired:
    """A call the server could not parse must not end the reply.

    A serving runtime gives up on its tool-call parser at the first name it
    cannot match, so the call arrives as ordinary content with no
    ``tool_calls`` delta. The loop used to ``break`` there: the markup was
    painted into the conversation and nothing ran, and only a new user message
    restarted inference. The round is repaired instead.
    """

    # The Hermes spelling the reported engine actually produced.
    LEAKED = (
        "<tool_call>\n"
        '{"name": "read_files", "arguments": {"path": "AGENTS.md"}}\n'
        "</tool_call>"
    )

    def _run(self, monkeypatch, streams, tools=None, **kwargs):
        calls: List[Dict[str, Any]] = []

        def fake(**kw):
            calls.append(kw)
            return streams[len(calls) - 1]

        monkeypatch.setattr("src.core.chat.stream_completion", fake)
        events: List[Dict[str, Any]] = []
        executed: List[str] = []
        chat_core.stream_chat(
            [{"role": "user", "content": "read AGENTS.md"}],
            "m",
            "http://s/v1",
            events.append,
            tools=tools
            or [{"type": "function", "function": {"name": "read_file"}}],
            tool_executor=lambda name, args: executed.append(name) or "ok",
            **kwargs,
        )
        return events, calls, executed

    def test_the_round_does_not_end_the_reply(self, monkeypatch):
        events, calls, _ = self._run(
            monkeypatch,
            [
                FakeStream([content_chunk(self.LEAKED), finish_chunk("stop")]),
                FakeStream([content_chunk("Recovered."), finish_chunk("stop")]),
            ],
        )
        # A second round ran, and the reply ends normally on the answer it got.
        assert len(calls) == 2
        assert events[-1]["event"] == "done"
        streamed = "".join(e["text"] for e in events if e["event"] == "token")
        assert streamed == "Recovered."

    def test_the_markup_never_reaches_the_conversation_panel(self, monkeypatch):
        events, _, _ = self._run(
            monkeypatch,
            [
                FakeStream([content_chunk(self.LEAKED), finish_chunk("stop")]),
                FakeStream([content_chunk("ok"), finish_chunk("stop")]),
            ],
        )
        streamed = "".join(e["text"] for e in events if e["event"] == "token")
        assert "tool_call" not in streamed
        assert "read_files" not in streamed
        assert "AGENTS.md" not in streamed

    def test_the_correction_is_fed_back_as_a_tool_turn(self, monkeypatch):
        # The exact message the user used to type by hand, and the names the
        # model actually had: that is what it needs to self-correct.
        _, calls, executed = self._run(
            monkeypatch,
            [
                FakeStream([content_chunk(self.LEAKED), finish_chunk("stop")]),
                FakeStream([content_chunk("ok"), finish_chunk("stop")]),
            ],
        )
        assert executed == []  # never a structured call, so never executed
        messages = calls[1]["messages"]
        assert messages[-1]["role"] == "tool"
        assert chat_core.BAD_TOOL_CALL_MESSAGE in messages[-1]["content"]
        assert "read_file" in messages[-1]["content"]
        assert messages[-1]["tool_call_id"].startswith(chat_core.BAD_TOOL_CALL_ID)

    def test_the_panel_gets_one_red_badge_naming_what_it_tried(
        self, monkeypatch
    ):
        events, _, _ = self._run(
            monkeypatch,
            [
                FakeStream([content_chunk(self.LEAKED), finish_chunk("stop")]),
                FakeStream([content_chunk("ok"), finish_chunk("stop")]),
            ],
        )
        call = next(e for e in events if e["event"] == "tool_call")
        assert call["bad"] is True
        assert call["tool"] == "read_files"
        assert call["server"] == ""
        result = next(e for e in events if e["event"] == "tool_result")
        assert result["ok"] is False
        assert result["id"] == call["id"]

    def test_every_call_it_wrote_gets_an_answer(self, monkeypatch):
        # Two text-shaped calls in one round: each id must be answered, or the
        # next request carries a history the server rejects.
        two = (
            "<tool_call>\n"
            '{"name": "read_files", "arguments": {}}\n'
            "</tool_call>\n"
            "<tool_call>\n"
            '{"name": "read_file", "arguments": {"path": "x"}}\n'
            "</tool_call>"
        )
        _, calls, _ = self._run(
            monkeypatch,
            [
                FakeStream([content_chunk(two), finish_chunk("stop")]),
                FakeStream([content_chunk("ok"), finish_chunk("stop")]),
            ],
        )
        tool_turns = [m for m in calls[1]["messages"] if m["role"] == "tool"]
        assert len(tool_turns) == 2
        assert len({m["tool_call_id"] for m in tool_turns}) == 2

    def test_a_name_it_was_offered_is_asked_to_retry_not_listed(
        self, monkeypatch
    ):
        offered = (
            "<tool_call>\n"
            '{"name": "read_file", "arguments": {"path": "x"}}\n'
            "</tool_call>"
        )
        _, calls, _ = self._run(
            monkeypatch,
            [
                FakeStream([content_chunk(offered), finish_chunk("stop")]),
                FakeStream([content_chunk("ok"), finish_chunk("stop")]),
            ],
        )
        content = calls[1]["messages"][-1]["content"]
        assert "Retry it as a real tool call" in content
        assert "is not one of them" not in content

    def test_prose_with_a_stray_angle_bracket_still_streams(self, monkeypatch):
        # The filter must not eat ordinary text: "a < b" is not a call.
        events, calls, _ = self._run(
            monkeypatch,
            [
                FakeStream(
                    [content_chunk("if a < b and 3 < 4"), finish_chunk("stop")]
                ),
            ],
        )
        streamed = "".join(e["text"] for e in events if e["event"] == "token")
        assert streamed == "if a < b and 3 < 4"
        assert len(calls) == 1  # no repair round, no tool turn
        assert not [e for e in events if e["event"] == "tool_call"]

    def test_an_unterminated_opener_is_released_as_prose(self, monkeypatch):
        events, calls, _ = self._run(
            monkeypatch,
            [
                FakeStream(
                    [content_chunk("see <tool_call soon"), finish_chunk("stop")]
                ),
            ],
        )
        streamed = "".join(e["text"] for e in events if e["event"] == "token")
        assert "<tool_call soon" in streamed
        assert len(calls) == 1

    def test_a_tool_less_reply_is_untouched(self, monkeypatch):
        # With no tools offered there is no loop to repair and no markup to
        # read: the text is the answer, as it always was.
        monkeypatch.setattr(
            "src.core.chat.stream_completion",
            lambda **kw: FakeStream(
                [content_chunk(self.LEAKED), finish_chunk("stop")]
            ),
        )
        events: List[Dict[str, Any]] = []
        chat_core.stream_chat(
            [{"role": "user", "content": "hi"}],
            "m",
            "http://s/v1",
            events.append,
        )
        streamed = "".join(e["text"] for e in events if e["event"] == "token")
        assert streamed == self.LEAKED
        assert events[-1]["event"] == "done"

    def test_the_iteration_cap_bounds_the_repair(self, monkeypatch):
        # A model that keeps writing calls as text must not loop for ever: the
        # cap stops the lot exactly as it stops a real tool loop.
        leak = FakeStream([content_chunk(self.LEAKED), finish_chunk("stop")])
        events, calls, _ = self._run(
            monkeypatch,
            [leak] * 5,
            max_tool_iterations=2,
        )
        assert len(calls) <= 3
        note = "".join(e["text"] for e in events if e["event"] == "token")
        assert "maximum of 2 tool iterations" in note
