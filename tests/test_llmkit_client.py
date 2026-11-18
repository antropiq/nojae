"""The transport layer of the in-house LLM client (llmh-03, spec §4.3).

Everything here runs through ``httpx.MockTransport``: the client's own
request building, streaming and teardown are exercised for real, and only
the socket is a handler. The assertions are step 5's list -- the measured
§2.1 body against llmh-01's fixture, the placeholder bearer header, the
bare model name, the sampler keys verbatim, the ``tools`` rule, the
chunk-level finish-reason recording (D3), the error surface that names the
status and the upstream message with the debug flag off (D8), the close
semantics, and the one URL rule for both endpoint shapes (D9).

Hermetic by construction: a call whose test installed no handler fails the
test instead of reaching a network, and nothing here reads ``.env``.
"""

import asyncio
import json
import logging
from typing import Any, Dict, List

import httpx
import pytest

from src.core import chat as chat_core
from src.core import llmkit
from src.core.llm import TRUNCATION_EVENT_FLAG, TRUNCATION_MESSAGE
from src.core.llmkit import client as client_module
from src.core.llmkit import constants
from src.core.llmkit.client import (
    ChatStream,
    LLMRequestError,
    TRANSIENT_STATUSES,
    another_attempt_may_help,
    chat_completion,
    chat_completions_url,
    models_url,
    stream_completion,
)
from tests.llmkit_fakes import (
    CLOSE_DELIM,
    OPEN_DELIM,
    PIPE,
    content_chunk,
    finish_chunk,
    special_token,
    tool_call_chunk,
    usage_chunk,
)
from tests.test_llmkit_contract import (
    EXPECTED_STREAM_BODY,
    MAX_TOKENS,
    MODEL,
    SAMPLING,
)

SERVER = "http://model.test:8080/v1"
BARE_HOST = "http://model.test:8080"
URL = "http://model.test:8080/v1/chat/completions"


# --- the MockTransport seam --------------------------------------------------
#
# The client owns its httpx client per call (D11), so what a test injects is
# the transport, not the client: the code under test still builds the real
# request, streams the real way and closes the real way.


class _Wire:
    """Every ``httpx.Client`` the client builds answers from ``serve``."""

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.requests: List[httpx.Request] = []
        self.clients: List[httpx.Client] = []
        self.client_kwargs: List[Dict[str, Any]] = []
        self.handler = None
        self._real_client = httpx.Client
        monkeypatch.setattr(httpx, "Client", self._factory)

    def _factory(self, *args, **kwargs):
        self.client_kwargs.append(dict(kwargs))
        kwargs["transport"] = httpx.MockTransport(self._dispatch)
        client = self._real_client(*args, **kwargs)
        self.clients.append(client)
        return client

    def _dispatch(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        assert self.handler is not None, "this test installed no handler"
        return self.handler(request)

    @property
    def request(self) -> httpx.Request:
        assert len(self.requests) == 1, "expected exactly one request"
        return self.requests[0]

    def json_body(self) -> Dict[str, Any]:
        return json.loads(self.request.content)

    def serve_stream(
        self,
        chunks: List[Dict[str, Any]],
        done: bool = True,
        status: int = 200,
    ) -> None:
        """Answer with an SSE body, as the live server writes one."""
        lines = [": keep-alive"]  # the live server emits comment lines
        for chunk in chunks:
            lines.append("data: " + json.dumps(chunk))
            lines.append("")  # blank line as frame separator
        if done:
            lines.append("data: " + "[DONE]")
            lines.append("")
        body = "\n".join(lines).encode("utf-8")

        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                status,
                headers={"content-type": "text/event-stream"},
                content=body,
            )

        self.handler = handler

    def serve_json(self, payload: Any, status: int = 200) -> None:
        self.serve_raw(json.dumps(payload), status, "application/json")

    def serve_raw(
        self, body: str, status: int = 200, content_type: str = "text/plain"
    ) -> None:
        def handler(request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                status,
                headers={"content-type": content_type},
                content=body.encode("utf-8"),
            )

        self.handler = handler


@pytest.fixture
def wire(monkeypatch: pytest.MonkeyPatch) -> _Wire:
    return _Wire(monkeypatch)


def start(**overrides: Any) -> ChatStream:
    """One streamed call with the contract fixture's own values."""
    kwargs: Dict[str, Any] = {
        "model": MODEL,
        "server_url": SERVER,
        "messages": [],
    }
    kwargs.update(overrides)
    return stream_completion(**kwargs)


# --- the §2.1 request body, against llmh-01's fixture -------------------------


class TestRequestBodyIsTheMeasuredWire:
    def test_the_streaming_body_equals_the_measured_wire(self, wire: _Wire):
        # The fixture's ``max_tokens`` is one of the call's own values (the
        # other is the model name); on the streaming shape the caller's
        # ``sampling`` dict is the route any call value takes, so it travels
        # that way here. Everything else in the body the client itself puts
        # there -- and the equality says it puts *exactly* that, nothing
        # dropped and nothing invented.
        wire.serve_stream([])
        stream = start(sampling=dict(SAMPLING, max_tokens=MAX_TOKENS))
        list(stream)
        assert wire.json_body() == EXPECTED_STREAM_BODY

    def test_the_stream_shape_adds_stream_and_include_usage(self, wire: _Wire):
        wire.serve_stream([])
        list(start(sampling=dict(SAMPLING)))
        body = wire.json_body()
        assert body["stream"] is True
        assert body["stream_options"] == {"include_usage": True}
        # Without a max_tokens in the caller's dict none appears: the client
        # adds the two streaming keys and nothing else.
        assert "max_tokens" not in body

    def test_the_post_goes_to_the_chat_completions_url(self, wire: _Wire):
        wire.serve_stream([])
        list(start())
        assert wire.request.method == "POST"
        assert str(wire.request.url) == chat_completions_url(SERVER) == URL

    def test_the_model_name_reaches_the_body_bare(self, wire: _Wire):
        # A leftover ``openai/`` prefix reaches llama-swap as
        # ``openai/qwen3.8-...`` and comes back 404 no router for model.
        wire.serve_stream([])
        list(start(model="qwen3.8-flash-next-iq3_xxs"))
        body = wire.json_body()
        assert body["model"] == "qwen3.8-flash-next-iq3_xxs"
        assert not any("openai/" in str(v) for v in body.values())

    def test_an_unknown_sampler_key_appears_verbatim(self, wire: _Wire):
        # The lot's first invariant: the sampling dict is merged unexamined.
        # This server answers a bogus key with 200 (spec §2.2), so a client
        # that filtered it would change the sampling with nothing to see.
        wire.serve_stream([])
        list(start(sampling={"dys_tfs": 0.9, "typo_k": 20, "top_k": 20}))
        body = wire.json_body()
        assert body["dys_tfs"] == 0.9
        assert body["typo_k"] == 20
        assert body["top_k"] == 20


class TestAuthorizationHeader:
    def test_bearer_none_is_sent_with_no_key_configured(self, wire: _Wire):
        # Spec §2.1: the header goes out even with the placeholder -- that is
        # what the endpoint sees today and it accepts it.
        wire.serve_stream([])
        list(start())
        assert wire.request.headers["authorization"] == "Bearer none"

    def test_an_empty_key_falls_back_to_the_placeholder(self, wire: _Wire):
        wire.serve_stream([])
        list(start(api_key="  "))
        assert wire.request.headers["authorization"] == "Bearer none"

    def test_a_configured_key_is_sent_as_bearer(self, wire: _Wire):
        wire.serve_stream([])
        list(start(api_key="sk-local"))
        assert wire.request.headers["authorization"] == "Bearer sk-local"


class TestToolsKeyRule:
    """``tools`` is absent rather than empty (the rule in tests/test_chat.py)."""

    def test_no_tools_key_when_tools_is_none(self, wire: _Wire):
        wire.serve_stream([])
        list(start(tools=None))
        assert "tools" not in wire.json_body()

    def test_no_tools_key_when_tools_is_an_empty_list(self, wire: _Wire):
        wire.serve_stream([])
        list(start(tools=[]))
        assert "tools" not in wire.json_body()

    def test_tools_present_when_non_empty(self, wire: _Wire):
        tools = [{"type": "function", "function": {"name": "read_file"}}]
        wire.serve_stream([])
        list(start(tools=tools))
        assert wire.json_body()["tools"] == tools


# --- the content sanitizer at the seam -------------------------------------------


class TestMessageContentIsSanitizedAtTheSeam:
    """No delimiter-wrapped control-token run leaves the app in a body.

    Both call shapes pass their ``messages`` through ``llmkit.sanitize``
    before the body is built, so every caller of the seam — chat and the
    batch turns that ride it — is covered here and nowhere else.
    """

    def test_a_control_token_never_reaches_the_stream_request_body(
        self, wire: _Wire
    ):
        wire.serve_stream([])
        list(start(messages=[{"role": "user",
                              "content": f"q: {special_token('evil')} answer"}]))
        assert wire.json_body()["messages"][0]["content"] == "q:  answer"

    def test_a_spliced_run_never_reaches_the_wire(self, wire: _Wire):
        # The fixed point, checked on the bytes that would go out:
        # removing the inner run must not splice an outer one together.
        wire.serve_stream([])
        smuggled = f"a{OPEN_DELIM}im_{special_token('x')}start{CLOSE_DELIM}b"
        list(start(messages=[{"role": "user", "content": smuggled}]))
        assert wire.json_body()["messages"][0]["content"] == "ab"

    def test_the_non_streaming_shape_sanitizes_too(self, wire: _Wire):
        # The pass is not the streaming shape's private favour: every
        # call shape of the seam makes it.
        wire.serve_json({})
        chat_completion(model=MODEL, server_url=SERVER,
                        messages=[{"role": "user",
                                   "content": special_token("verdict") + "yes"}])
        assert wire.json_body()["messages"][0]["content"] == "yes"

    def test_the_caller_s_messages_are_not_mutated(self, wire: _Wire):
        # The same history object is what the UI renders: it shows what
        # the user typed, while the wire carries the sanitized copy.
        wire.serve_stream([])
        original = "keep " + special_token("evil")
        messages = [{"role": "user", "content": original}]
        list(start(messages=messages))
        assert messages[0]["content"] == original
        assert wire.json_body()["messages"][0]["content"] == "keep "

    def test_delimiters_that_form_no_run_survive_to_the_body(self, wire: _Wire):
        # Sanitizing must not become stripping: a pipe inside the name is
        # not what any template tokenises as one control token, and an
        # unterminated half of a pair is not a run either. Such text --
        # and a user message carrying it -- reaches the server
        # byte for byte.
        wire.serve_stream([])
        text = (
            f"compare a{OPEN_DELIM}b{PIPE}c{CLOSE_DELIM}d "
            f"and x{OPEN_DELIM}y{PIPE}w and z{CLOSE_DELIM}v"
        )
        list(start(messages=[{"role": "user", "content": text}]))
        assert wire.json_body()["messages"][0]["content"] == text

    def test_a_run_in_tool_call_arguments_never_reaches_the_wire(self, wire: _Wire):
        # The tool loop re-posts the assistant's own tool_calls each
        # round, and the template interpolates the function text raw --
        # an argument run smuggles a turn close as surely as content.
        wire.serve_stream([])
        list(start(messages=[{
            "role": "assistant",
            "content": None,
            "tool_calls": [{
                "id": "c1",
                "type": "function",
                "function": {
                    "name": "search",
                    "arguments": f'{{"q": "{special_token("im")}"}}',
                },
            }],
        }]))
        fn = wire.json_body()["messages"][0]["tool_calls"][0]["function"]
        assert fn["arguments"] == '{"q": ""}'
        assert fn["name"] == "search"

    def test_the_logged_payload_is_the_sanitized_body(
        self,
        wire: _Wire,
        caplog: pytest.LogCaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ):
        # The debug payload is the body as it goes out -- so what the
        # operator sees is what the server receives, token or not.
        monkeypatch.setattr(client_module, "debug_enabled", lambda: True)
        wire.serve_json({})
        with caplog.at_level(logging.DEBUG, logger=constants.DEBUG_LOGGER_NAME):
            chat_completion(model=MODEL, server_url=SERVER,
                            messages=[{"role": "user",
                                       "content": special_token("evil") + "ok"}])
        text = "\n".join(record.getMessage() for record in caplog.records)
        assert '"ok"' in text
        assert OPEN_DELIM not in text


# --- what the stream records (D3) ----------------------------------------------


class TestStreamRecording:
    def test_a_late_finish_reason_flips_the_flag_as_its_chunk_is_yielded(
        self, wire: _Wire
    ):
        wire.serve_stream(
            [content_chunk("half an "), content_chunk("answer"), finish_chunk("stop")]
        )
        stream = start()
        it = iter(stream)
        next(it)
        next(it)
        assert stream.saw_finish_reason is False
        assert stream.finish_reason is None
        next(it)  # the finish chunk: recorded as it is handed over
        assert stream.saw_finish_reason is True
        assert stream.finish_reason == "stop"

    def test_a_stream_ending_on_done_with_no_finish_chunk_is_still_cut(
        self, wire: _Wire
    ):
        # D3: ``data: [DONE]`` is transport framing. Whether it survives an
        # upstream disconnect is unverified, so it proves nothing.
        wire.serve_stream([content_chunk("half an ")], done=True)
        stream = start()
        list(stream)
        assert stream.saw_finish_reason is False
        assert stream.finish_reason is None

    def test_a_null_finish_reason_is_not_a_signal(self, wire: _Wire):
        wire.serve_stream([finish_chunk(None)])
        stream = start()
        list(stream)
        assert stream.saw_finish_reason is False
        assert stream.finish_reason is None

    def test_finish_reason_is_the_first_non_null_one_seen(self, wire: _Wire):
        wire.serve_stream([finish_chunk("length"), finish_chunk("stop")])
        stream = start()
        list(stream)
        assert stream.finish_reason == "length"

    def test_usage_is_the_last_usage_block_seen(self, wire: _Wire):
        wire.serve_stream(
            [
                usage_chunk(prompt=10, total=12),
                finish_chunk("stop", usage={"prompt_tokens": 10,
                                            "completion_tokens": 2,
                                            "total_tokens": 12}),
            ]
        )
        stream = start()
        list(stream)
        assert stream.usage == {
            "prompt_tokens": 10,
            "completion_tokens": 2,
            "total_tokens": 12,
        }

    def test_usage_is_none_when_no_chunk_carried_one(self, wire: _Wire):
        wire.serve_stream([content_chunk("a")])
        stream = start()
        list(stream)
        assert stream.usage is None


# --- the socket's own teardown --------------------------------------------------


class _RaisingClose:
    """A response or client whose close fails -- the socket is already gone."""

    def __init__(self) -> None:
        self.close_calls = 0

    def close(self) -> None:
        self.close_calls += 1
        raise OSError("socket already gone")


class TestStreamTeardown:
    def test_exhausting_the_iteration_closes_the_client(self, wire: _Wire):
        wire.serve_stream([content_chunk("a"), finish_chunk("stop")])
        stream = start()
        list(stream)
        assert stream.closed is True
        assert wire.clients[-1].is_closed

    def test_close_mid_stream_returns_and_closes_the_client(self, wire: _Wire):
        # The cancel path: close() is called blind, and llama.cpp must see
        # the socket die instead of streaming into it nobody reads.
        wire.serve_stream([content_chunk("a"), content_chunk("b")])
        stream = start()
        it = iter(stream)
        next(it)
        stream.close()
        assert stream.closed is True
        assert wire.clients[-1].is_closed

    def test_close_twice_is_a_no_op(self):
        client, response = _RaisingClose(), _RaisingClose()
        stream = ChatStream(client, response)  # type: ignore[arg-type]
        stream.close()
        stream.close()
        assert stream.closed is True
        assert client.close_calls == 1  # the second call never got through
        assert response.close_calls == 1

    def test_a_failing_underlying_close_never_propagates(self):
        client, response = _RaisingClose(), _RaisingClose()
        stream = ChatStream(client, response)  # type: ignore[arg-type]
        stream.close()  # the cancel path calls this blind; it must not raise
        assert stream.closed is True
        assert client.close_calls == 1
        assert response.close_calls == 1

    def test_a_refused_call_closes_its_client_before_raising(self, wire: _Wire):
        wire.serve_json({"error": {"message": "no router for requested model"}},
                        status=404)
        with pytest.raises(LLMRequestError):
            start()
        assert wire.clients[-1].is_closed


# --- the error surface (D8) -----------------------------------------------------


class TestErrorSurface:
    def test_a_404_raises_naming_status_and_upstream_message_with_debug_off(
        self, wire: _Wire
    ):
        # The exact llama-swap answer to a prefixed model name. The debug flag
        # is *off* here on purpose (the hook's own default): str() is what the
        # two consuming loops emit into the UI's error line, so the diagnosis
        # has to be complete without the flag -- the flag only adds the payload
        # on top (D8).
        assert client_module.debug_enabled() is False
        wire.serve_json(
            {"error": {"message": "no router for requested model",
                       "type": "invalid_request_error"}},
            status=404,
        )
        with pytest.raises(LLMRequestError) as excinfo:
            start()
        error = excinfo.value
        assert error.status == 404
        assert error.message == "no router for requested model"
        assert error.url == URL
        text = str(error)
        assert "404" in text
        assert "no router for requested model" in text

    def test_a_non_json_error_body_is_included_raw_truncated(
        self, wire: _Wire, monkeypatch: pytest.MonkeyPatch
    ):
        # A test that wants another body limit patches the constant, never a
        # literal in the module under test.
        monkeypatch.setattr(constants, "ERROR_BODY_LIMIT", 24)
        wire.serve_raw("<html><body>502 Bad Gateway</body>" + "x" * 5000,
                       status=503)
        with pytest.raises(LLMRequestError) as excinfo:
            start()
        message = excinfo.value.message
        assert message == "<html><body>502 Bad Gate"  # exactly the limit
        assert len(message) == 24
        assert "xxxx" not in message

    def test_an_error_body_that_does_not_decode_never_raises_a_decode_error(
        self, wire: _Wire
    ):
        wire.serve_raw("", status=500)
        with pytest.raises(LLMRequestError) as excinfo:
            start()
        assert excinfo.value.status == 500

    def test_the_non_streaming_shape_raises_the_same_error(self, wire: _Wire):
        wire.serve_json({"error": {"message": "context length exceeded"}},
                        status=400)
        with pytest.raises(LLMRequestError) as excinfo:
            chat_completion(model=MODEL, server_url=SERVER, messages=[])
        assert excinfo.value.status == 400
        assert "context length exceeded" in str(excinfo.value)


# --- the verdict on a failed call (ereco-02, spec §3, §5.2, §5.3, D1) ----------
#
# The one judgement the wait feature hangs on, asserted where it lives. Every
# case builds the exception the seam itself raises -- from its ``status`` field
# or its type -- and never from a sentence: an assertion that only holds by
# finding "502" inside ``str(exc)`` is the bug this predicate exists to
# prevent. Nothing here acts on the answer: task 03 is what asks the question.


def refused(status: int, message: str = "upstream said no") -> LLMRequestError:
    """The seam's own refusal, built from its fields and nothing else."""
    return LLMRequestError(status=status, message=message, url=URL)


class TestTheRetryableSetIsWrittenOutPositively:
    @pytest.mark.parametrize("status", [408, 429, 500, 502, 503, 504])
    def test_a_transient_status_says_another_attempt_may_help(self, status: int):
        # spec §3's list, and §1's motivating 502: the provider's gateway
        # could not reach its upstream, which is a blip, not a diagnosis.
        assert another_attempt_may_help(refused(status)) is True

    @pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
    def test_a_status_that_names_the_request_as_wrong_is_final(self, status: int):
        # spec §5.2: a revoked key or a renamed model must never be waited on.
        assert another_attempt_may_help(refused(status)) is False

    @pytest.mark.parametrize("status", [405, 409, 413, 418, 451, 501, 505, 599])
    def test_a_status_outside_the_list_is_final(self, status: int):
        # D1: the set is positive, so an invented code -- including a 5xx a
        # provider may introduce tomorrow -- falls through to final.
        assert another_attempt_may_help(refused(status)) is False

    def test_the_status_field_is_what_decides_never_the_wording(self):
        # The anti-string-parsing case, in both directions at once: a 400
        # whose text quotes a 502 is final, and a 502 whose text never says
        # 502 is retryable.
        decoy = refused(400, message="upstream reported 502 Bad Gateway")
        assert "502" in str(decoy)
        assert another_attempt_may_help(decoy) is False

        mute = refused(502, message="Bad Gateway")
        assert "502" not in mute.message
        assert another_attempt_may_help(mute) is True

    def test_the_positive_set_is_the_six_statuses_the_spec_names(self):
        # Pinned as data: adding a status here is a spec decision, not a
        # local convenience, and this is where a drift becomes visible.
        assert set(TRANSIENT_STATUSES) == {408, 429, 500, 502, 503, 504}


class TestAnUnrecognisedFailureIsFinal:
    @pytest.mark.parametrize(
        "exc",
        [RuntimeError("a bug in the loop"), ValueError("bad literal"),
         KeyError("model"), OSError("disk went away")],
    )
    def test_an_exception_the_seam_does_not_own_is_final(self, exc: BaseException):
        # spec §5.3: a feature that retries by default would eventually retry
        # a bug, so unknown means today's error path.
        assert another_attempt_may_help(exc) is False

    @pytest.mark.parametrize(
        "exc",
        [asyncio.CancelledError(), KeyboardInterrupt(), SystemExit()],
    )
    def test_a_control_exception_is_final(self, exc: BaseException):
        # Stop and shutdown ride on exceptions too; none of them is an
        # endpoint refusing to answer.
        assert another_attempt_may_help(exc) is False


class TestTheTransportHalfIsWhatTheCallCanActuallyRaise:
    @pytest.mark.parametrize(
        "exc",
        [httpx.ConnectError("connection refused"),
         httpx.ConnectTimeout("connect timed out"),
         httpx.ReadTimeout("no response head"),
         httpx.WriteTimeout("body never written"),
         httpx.PoolTimeout("no connection in the pool"),
         httpx.ReadError("socket died before the head"),
         httpx.RemoteProtocolError("head never came")],
    )
    def test_a_failure_before_the_response_head_says_try_again(
        self, exc: BaseException
    ):
        # spec §3's connect/read failures: all of them are
        # ``httpx.TransportError`` subclasses, and all of them can only come
        # from the eager ``client.send(...)`` of ``stream_completion``.
        assert isinstance(exc, httpx.TransportError)
        assert another_attempt_may_help(exc) is True

    def test_a_dead_endpoint_raises_the_family_the_verdict_covers(
        self, wire: _Wire
    ):
        # Not a hand-built exception: the real call, the real client, the
        # real send -- the transport refuses and the seam lets the transport
        # type through untouched (task 02 wraps nothing).
        def refuse(request: httpx.Request) -> httpx.Response:
            raise httpx.ConnectError("connection refused", request=request)

        wire.handler = refuse
        with pytest.raises(httpx.TransportError) as excinfo:
            start()
        assert another_attempt_may_help(excinfo.value) is True
        assert wire.clients[-1].is_closed  # the refused call still closed

    def test_the_same_family_raised_mid_stream_never_reaches_the_verdict(
        self, wire: _Wire
    ):
        # D2's boundary, from the seam's side: a socket that dies after the
        # head raises while the *caller iterates*, so the ``except`` around
        # the call -- the only place this verdict is asked -- never sees it.
        # The predicate is honest about the call, not about the whole turn.
        class _Cut(httpx.SyncByteStream):
            def __iter__(self):
                yield b'data: {"choices":[{"delta":{"content":"half an"}}]}\n\n'
                raise httpx.ReadError("the socket died mid-reply")

        wire.handler = lambda request: httpx.Response(
            200,
            headers={"content-type": "text/event-stream"},
            stream=_Cut(),
        )
        stream = start()  # the call itself succeeded: bytes did arrive
        with pytest.raises(httpx.TransportError) as excinfo:
            list(stream)
        assert another_attempt_may_help(excinfo.value) is True  # the data says so
        assert stream.saw_finish_reason is False  # and it is still a cut stream


class TestTheVerdictIsThePackageSurface:
    def test_the_package_exports_the_predicate(self):
        # The seam owns the judgement (spec §4), so a caller reaches it
        # through the package's own surface -- the name task 03 asks.
        assert "another_attempt_may_help" in llmkit.__all__
        assert llmkit.another_attempt_may_help is client_module.another_attempt_may_help


# --- the non-streaming shape -----------------------------------------------------


class TestChatCompletion:
    def test_it_returns_the_parsed_body(self, wire: _Wire):
        payload = {"choices": [{"message": {"content": "True"}}]}
        wire.serve_json(payload)
        assert chat_completion(model=MODEL, server_url=SERVER, messages=[]) == payload

    def test_the_body_carries_no_stream_keys(self, wire: _Wire):
        wire.serve_json({})
        chat_completion(model=MODEL, server_url=SERVER, messages=[])
        body = wire.json_body()
        assert "stream" not in body
        assert "stream_options" not in body
        assert "max_tokens" not in body

    def test_max_tokens_and_sampling_reach_the_body(self, wire: _Wire):
        wire.serve_json({})
        chat_completion(model=MODEL, server_url=SERVER, messages=[],
                        max_tokens=1, sampling=dict(SAMPLING))
        body = wire.json_body()
        assert body["max_tokens"] == 1
        for key, value in SAMPLING.items():
            assert body[key] == value

    def test_it_posts_to_the_same_url_with_the_bearer_header(self, wire: _Wire):
        wire.serve_json({})
        chat_completion(model=MODEL, server_url=SERVER, messages=[])
        assert wire.request.method == "POST"
        assert str(wire.request.url) == URL
        assert wire.request.headers["authorization"] == "Bearer none"


# --- the URL rule (D9) ------------------------------------------------------------


class TestUrlRuleIsOneRule:
    @pytest.mark.parametrize(
        "base",
        [SERVER, SERVER + "/", BARE_HOST, BARE_HOST + "/", f"  {BARE_HOST}  "],
    )
    def test_both_builders_follow_one_rule_for_both_shapes(self, base: str):
        # ``SERVER_URL`` usually already ends in ``/v1`` (it is the historical
        # api_base); a bare host gets it added. One rule, asserted for both
        # URL shapes so the two can never drift.
        assert chat_completions_url(base) == f"{SERVER}/chat/completions"
        assert models_url(base) == f"{SERVER}/models"

    def test_the_output_is_always_a_model_endpoint_path(self):
        # The write-surface guard formalises the wider rule in llmh-04; the
        # builders spell theirs here: whatever the base, the path is the
        # endpoint's own under ``/v1``, never an app route's shape.
        for base in (SERVER, BARE_HOST):
            assert chat_completions_url(base).endswith("/v1/chat/completions")
            assert models_url(base).endswith("/v1/models")


# --- the timeout (D10) -------------------------------------------------------------


class TestTimeoutComesFromConstants:
    def test_the_call_timeout_is_the_constants_one(self, wire: _Wire):
        wire.serve_json({})
        chat_completion(model=MODEL, server_url=SERVER, messages=[])
        timeout = wire.client_kwargs[-1]["timeout"]
        assert isinstance(timeout, httpx.Timeout)
        assert timeout.connect == pytest.approx(constants.CONNECT_TIMEOUT)
        assert timeout.read is None  # D10: no read deadline on a live stream
        assert timeout.write == pytest.approx(constants.WRITE_TIMEOUT)
        assert timeout.pool == pytest.approx(constants.POOL_TIMEOUT)

    def test_a_patched_constant_reaches_the_next_call(
        self, wire: _Wire, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(constants, "CONNECT_TIMEOUT", 3.5)
        wire.serve_stream([])
        list(start())
        assert wire.client_kwargs[-1]["timeout"].connect == 3.5


# --- the debug hook (payload half of D8) --------------------------------------------


class TestDebugPayloadLogging:
    def test_the_hook_defaults_to_off_and_nothing_is_logged(
        self, wire: _Wire, caplog: pytest.LogCaptureFixture
    ):
        assert client_module.debug_enabled() is False
        wire.serve_json({})
        with caplog.at_level(logging.DEBUG, logger=constants.DEBUG_LOGGER_NAME):
            chat_completion(model=MODEL, server_url=SERVER, messages=[])
        assert caplog.records == []

    def test_the_hook_on_logs_the_request_line_and_payload_but_never_the_key(
        self,
        wire: _Wire,
        caplog: pytest.LogCaptureFixture,
        monkeypatch: pytest.MonkeyPatch,
    ):
        monkeypatch.setattr(client_module, "debug_enabled", lambda: True)
        wire.serve_json({})
        with caplog.at_level(logging.DEBUG, logger=constants.DEBUG_LOGGER_NAME):
            chat_completion(model=MODEL, server_url=SERVER, messages=[],
                            api_key="sk-secret")
        text = "\n".join(record.getMessage() for record in caplog.records)
        assert URL in text
        assert MODEL in text
        assert '"model"' in text  # the JSON payload itself
        assert "Authorization" not in text
        assert "sk-secret" not in text


# --- truncation end-to-end through the real transport (llmh-10, spec §6.3.6) ----
#
# The AGENTS.md invariant -- *a stream cut by the server looks like a finished
# answer at the chunk level, and a truncated chat reply ends as an error, which
# also stops a half-streamed tool call from being executed* -- is usually
# asserted per layer: a fake stream that raises, a stub that reports no finish
# reason. Asserted below is the whole chain with no stub in the middle: the
# bytes a cut server would have written go through the real SSE parse, the real
# stream recording and the real chat loop. Only the socket is a handler, and
# the tool executor is a spy that records whether it was reached.
# Spec §6.3.6 names this the one check that must be repeated after any change
# to ``sse.py``.


class TestTruncationReachesTheTerminalFrameThroughTheRealParse:
    MESSAGES = [{"role": "user", "content": "What is the capital of France?"}]

    def serve_cut_reply(self, wire: _Wire, done: bool) -> None:
        """Answer chunks, then the stream dies: never a finish_reason frame."""
        wire.serve_stream(
            [content_chunk("Paris is "), content_chunk("the capital")],
            done=done,
        )

    def ask(self, **overrides: Any) -> List[Dict[str, Any]]:
        """One chat reply over whatever the wire serves."""
        events: List[Dict[str, Any]] = []
        chat_core.stream_chat(
            list(self.MESSAGES),
            MODEL,
            SERVER,
            events.append,
            dict(SAMPLING),
            api_key="none",
            **overrides,
        )
        return events

    @pytest.mark.parametrize("done", [False, True], ids=["cut socket", "done frame"])
    def test_a_cut_stream_is_truncated_and_its_error_is_emitted(
        self, wire: _Wire, done: bool
    ):
        # D3 earns its keep here: whether the server got as far as writing
        # ``data: [DONE]`` changes nothing -- framing is not a finish reason,
        # so both shapes of the cut stream are truncation.
        self.serve_cut_reply(wire, done)
        events = self.ask()

        terminal = events[-1]
        assert terminal["event"] == "error"
        assert terminal["message"] == TRUNCATION_MESSAGE
        assert terminal[TRUNCATION_EVENT_FLAG] is True
        # Exactly one terminal frame: the cut reply does not also get a tidy
        # ``done`` the client could settle to idle on.
        assert [e["event"] for e in events if e["event"] in ("done", "pause_ack")] == []
        # The fragment still streamed as tokens: the pane shows what arrived,
        # and the error that follows it is what marks it incomplete.
        streamed = "".join(e["text"] for e in events if e["event"] == "token")
        assert streamed == "Paris is the capital"

    @pytest.mark.parametrize("done", [False, True], ids=["cut socket", "done frame"])
    def test_a_cut_tool_call_is_never_executed(
        self, wire: _Wire, done: bool
    ):
        # The dangerous case, through the real parse: the arguments stopped
        # streaming mid-JSON, so running them would execute a command the
        # model never finished writing.
        wire.serve_stream(
            [
                tool_call_chunk(index=0, call_id="call-1",
                                name="execute_command",
                                arguments='{"command": "ls -l'),
            ],
            done=done,
        )
        executed: List[str] = []
        events = self.ask(
            tools=[{"type": "function",
                    "function": {"name": "execute_command"}}],
            tool_executor=lambda name, args: executed.append(name) or "ok",
        )

        assert executed == []
        assert not [e for e in events if e["event"] == "tool_call"]
        assert events[-1]["event"] == "error"

    def test_a_stream_that_did_finish_is_not_truncated(self, wire: _Wire):
        # The same chain, one frame different: a chunk that carries a
        # finish_reason. Without this case the tests above could be passing
        # because everything reads as truncated.
        wire.serve_stream([
            content_chunk("Paris is the capital"),
            finish_chunk("stop", usage={"prompt_tokens": 10,
                                        "completion_tokens": 4,
                                        "total_tokens": 14}),
        ])
        events = self.ask()

        terminal = events[-1]
        assert terminal["event"] == "done"
        assert [e for e in events if e["event"] == "error"] == []
        # And the measurement that rides on a finished reply is still the
        # server's, not a re-count (the timing/token rules this lot must not
        # move): completion tokens only, and the occupancy figure is the
        # round's server-reported total.
        assert terminal["tokens"] == 4
        assert terminal["tokensEstimated"] is False
        assert terminal["contextTokens"] == 14
        assert terminal["contextEstimated"] is False
        assert terminal["took"] >= terminal["ttft"] >= 0.0
