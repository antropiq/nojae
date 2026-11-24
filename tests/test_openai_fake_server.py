"""e2e-hermetic — ``tools/openai_fake_server.py`` must satisfy the real seam.

The e2e suite's model connection points at this stub, so what matters is not the
bytes it writes but **whether :mod:`src.core.llmkit` and ``core.chat`` accept
them**: the body the client sends, the frames the SSE parser stops on, the
finish-reason check that decides *finished* versus *cut short*, and the usage
block the meters read. Every case here therefore drives the stub through the
production seam rather than reading its JSON back by hand — a stub tested against
its own idea of the protocol proves nothing.

It binds 127.0.0.1 on a port the OS chooses, so cases stay local and parallel-safe
and nothing reaches a real endpoint. The tool lives outside the package, so it is
loaded by path, exactly as ``test_file_icons.py`` loads its generator.
"""

from __future__ import annotations

import importlib.util
import json
import re
import socket
import subprocess
import sys
import threading
import time
from http.server import ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Iterator, Optional

import httpx
import pytest

from src.core.chat import _extract_usage, safe_get_choice_content
from src.core.llmkit.client import (
    LLMRequestError,
    chat_completions_url,
    chat_completion,
    models_url,
    stream_completion,
)

ROOT = Path(__file__).resolve().parent.parent

#: The answer these cases serve: two things a spec relies on — it reassembles to
#: exactly this, and it is long enough to still be streaming a moment in.
REPLY = (
    "The stub answer is fixed so that a frame lost on the wire is a failure and "
    "not a coincidence. It has enough words in it to stay in flight for a moment."
)


def _load_tool():
    """Import tools/openai_fake_server.py (it lives outside the package)."""
    path = ROOT / "tools" / "openai_fake_server.py"
    spec = importlib.util.spec_from_file_location("openai_fake_server", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules["openai_fake_server"] = module
    spec.loader.exec_module(module)
    return module


def _free_port() -> int:
    """A port the OS just released — close enough for a child to grab next."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        return probe.getsockname()[1]


_BANNER = re.compile(r"http://127\.0\.0\.1:(?P<port>\d+)/v1")


def _wait_for_banner(stub: subprocess.Popen, expected_port: int) -> None:
    """Block until the started stub has announced the port it bound."""
    for _ in range(100):
        line = stub.stdout.readline()
        found = _BANNER.search(line or "")
        if found and int(found.group("port")) == expected_port:
            return
        time.sleep(0.1)
    raise AssertionError(f"the stub never announced port {expected_port}")


module = _load_tool()


class RunningStub:
    """The stub on a real socket, with the URL a fixture would hold."""

    def __init__(self, config: Any) -> None:
        self.config = config
        self.server: Optional[ThreadingHTTPServer] = None
        self.thread: Optional[threading.Thread] = None
        self.base = ""

    @property
    def url(self) -> str:
        """The ``/v1`` URL — the shape a connection's ``server_url`` carries."""
        return f"{self.base}/v1"

    def start(self) -> "RunningStub":
        # Port 0 and 127.0.0.1: the OS picks a free port, so two of these never
        # collide, and nothing here can be reached from outside the machine.
        self.server = module.FakeModelServer(("127.0.0.1", 0), self.config)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        host, port = self.server.server_address[0], self.server.server_address[1]
        self.base = f"http://{host}:{port}"
        return self

    def stop(self) -> None:
        assert self.server is not None and self.thread is not None
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def __enter__(self) -> "RunningStub":
        return self.start()

    def __exit__(self, *exc: Any) -> None:
        self.stop()


@pytest.fixture(scope="module")
def stub() -> Iterator[RunningStub]:
    config = module.FakeServerConfig(reply=REPLY, model="served-model", chunk_gap=0.0)
    with RunningStub(config) as running:
        yield running


def stream_reply(
    url: str, *, model: str = "served-model", messages: Optional[list] = None
):
    """Drive one streamed completion the way ``core.chat`` does, and gather it."""
    stream = stream_completion(
        model=model,
        server_url=url,
        messages=messages or [{"role": "user", "content": "say something"}],
    )
    text = ""
    usage: Optional[Dict[str, Optional[int]]] = None
    for chunk in stream:
        text += safe_get_choice_content(chunk)
        found = _extract_usage(chunk)
        if found is not None:
            usage = found
    return text, usage, stream


class TestTheSeamAcceptsIt:
    """The three things that would break a spec for the stub's own reasons."""

    def test_a_streamed_answer_arrives_whole_and_honestly(self, stub):
        text, usage, stream = stream_reply(stub.url)

        # Frames reassemble to the configured reply exactly: a lost or doubled
        # frame would show up as a spec that intermittently mis-counts.
        assert text == REPLY
        # The signal the truncation check turns on. A stream that never carried a
        # finish reason is reported to the user as a cut reply, so a stub that
        # omitted it could not pass a streaming spec at all.
        assert stream.saw_finish_reason is True
        assert stream.finish_reason == "stop"
        assert usage is not None

    def test_the_stream_carries_one_frame_per_word(self, stub):
        # The cadence is the point of a stub: a spec that watches tokens arrive
        # needs several of them, not one body.
        words = len(REPLY.split())
        bodies = []
        with httpx.Client(timeout=10) as client:
            with client.stream(
                "POST",
                chat_completions_url(stub.url),
                json={
                    "model": "served-model",
                    "messages": [{"role": "user", "content": "hi"}],
                    "stream": True,
                },
            ) as response:
                for line in response.iter_lines():
                    if line.startswith("data: ") and line != "data: [DONE]":
                        bodies.append(json.loads(line[len("data: ") :]))
        contents = [
            (chunk.get("choices") or [{}])[0].get("delta", {}).get("content")
            for chunk in bodies
            if (chunk.get("choices") or [{}])[0].get("delta", {}).get("content")
        ]
        assert len(contents) == words

    def test_the_client_asks_for_usage_and_gets_it(self, stub):
        # ``stream_options.include_usage`` is what the seam sends; the frame the
        # meters read exists only because the stub honoured that ask.
        _, usage, _ = stream_reply(stub.url)
        assert usage is not None
        assert usage["completion_tokens"] > 0
        assert usage["prompt_tokens"] > 0
        assert usage["total_tokens"] == (
            usage["prompt_tokens"] + usage["completion_tokens"]
        )

    def test_a_non_streaming_completion_carries_the_same_answer(self, stub):
        body = chat_completion(
            model="served-model",
            server_url=stub.url,
            messages=[{"role": "user", "content": "hi"}],
        )
        assert body["choices"][0]["message"]["content"] == REPLY
        assert body["choices"][0]["finish_reason"] == "stop"
        assert body["usage"]["completion_tokens"] > 0


class TestTheFixtureCannotBeMisconfigured:
    """What lets a harness write the fixture without guessing at a name.

    A connection fixture must name a server *and* a model. A stub that insisted
    on being told the model id in advance would make those two spellings something
    to keep in step by hand — which is how a suite ends up pointed at a model that
    does not exist.
    """

    def test_any_model_name_the_fixture_invents_is_served(self, stub):
        for name in ("whatever", "test-model", "qwen3.8-40b", "served-model"):
            text, _, stream = stream_reply(stub.url, model=name)
            assert text == REPLY
            assert stream.saw_finish_reason is True

    def test_the_models_listing_advertises_the_configured_id(self, stub):
        payload = httpx.get(models_url(stub.url), timeout=5).json()
        assert [entry["id"] for entry in payload["data"]] == ["served-model"]

    def test_the_context_window_is_reported_where_the_app_reads_it(self, stub):
        # ``routes._context_window`` reads meta.n_ctx; without it the occupancy
        # badge shows a used side and no limit, which a spec reads as an app bug.
        payload = httpx.get(models_url(stub.url), timeout=5).json()
        assert payload["data"][0]["meta"]["n_ctx"] == stub.config.context_window

    def test_a_url_written_without_the_v1_suffix_still_works(self, stub):
        # ``_v1_base`` appends /v1, so either spelling a developer might put in
        # the fixture resolves to the same two routes.
        bare = stub.base
        assert chat_completions_url(bare) == chat_completions_url(stub.url)
        text, _, stream = stream_reply(bare)
        assert text == REPLY
        assert stream.finish_reason == "stop"


class TestItRefusesWhatItIsNot:
    """A stub that guesses is worse than one that names the mistake.

    These are the shapes that would otherwise turn a harness error into a passing
    spec, or into one nobody can explain.
    """

    def test_an_unknown_route_refuses_with_an_openai_shaped_error(self, stub):
        response = httpx.post(f"{stub.base}/v1/completions", json={}, timeout=5)
        assert response.status_code == 404
        # The shape ``llmkit._error_message`` reads first, so the UI gets a
        # sentence rather than a truncated body.
        assert response.json()["error"]["message"]

    def test_a_body_that_is_not_json_is_named_as_such(self, stub):
        response = httpx.post(
            chat_completions_url(stub.url),
            content=b"not json",
            headers={"Content-Type": "application/json"},
            timeout=5,
        )
        assert response.status_code == 400
        assert "not valid JSON" in response.json()["error"]["message"]

    def test_a_refusal_is_final_so_the_suite_never_waits_on_it(self, stub):
        # A path the stub does not serve answers 404, which llmkit's table calls
        # *final*: a mistake in the harness has to surface as an error line, not
        # three silent rounds of the retry wait.
        from src.core.llmkit.client import another_attempt_may_help

        with pytest.raises(LLMRequestError) as caught:
            chat_completion(
                model="served-model",
                # `chat_completion` builds `{url}/v1/chat/completions`, so this
                # reaches a path the stub has no handler for.
                server_url=f"{stub.base}/not-the-root",
                messages=[{"role": "user", "content": "hi"}],
            )
        assert caught.value.status == 404
        assert another_attempt_may_help(caught.value) is False

    def test_an_empty_reply_still_finishes_honestly(self):
        # The zero-frame edge: with nothing to say, the stream must still carry a
        # finish reason, or a spec reads it as a server that died mid-word.
        config = module.FakeServerConfig(reply="", chunk_gap=0.0)
        with RunningStub(config) as quiet:
            text, _, stream = stream_reply(quiet.url)
        assert text == ""
        assert stream.saw_finish_reason is True


class TestALogLineCannotBreakARequest:
    """A log line must never be able to fail a request.

    How the harness starts this stub — a child whose stdout it reads — means a
    leftover process from an interrupted run ends up writing to a pipe with no
    reader left. Every request then raises while logging, and because the standard
    library logs from *inside* the handler, after the status line and headers are
    already on the wire, the client gets a response with no body. That reads like a
    broken model server, and it is the one failure here that would send someone
    looking at the app instead of at this file.
    """

    def test_requests_survive_a_stdout_no_one_reads(self):
        port = _free_port()
        # Logging stays ON: `--quiet` would hide the bug rather than fix it, and
        # the harness that hit it passed --quiet for its own reasons.
        stub = subprocess.Popen(
            [
                sys.executable,
                str(ROOT / "tools" / "openai_fake_server.py"),
                "--port",
                str(port),
                "--n-ctx",
                "4096",
            ],
            cwd=ROOT,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
        )
        _wait_for_banner(stub, port)
        # Close our read end: from here every log write faces a dead pipe.
        stub.stdout.close()
        try:
            response = httpx.get(f"http://127.0.0.1:{port}/v1/models", timeout=10)
            assert response.status_code == 200
            # The body, not just the status: an empty 200 is the actual bug.
            assert response.json()["data"][0]["meta"]["n_ctx"] == 4096
        finally:
            stub.terminate()
            stub.wait(timeout=10)

    def test_quiet_writes_nothing_and_answers_anyway(self, capsys):
        config = module.FakeServerConfig(
            reply=REPLY, chunk_gap=0.0, model="served-model", quiet=True
        )
        with RunningStub(config) as quiet:
            assert httpx.get(models_url(quiet.url), timeout=5).status_code == 200
        assert capsys.readouterr().out == ""


class TestACancelledTurnIsNotAnError:
    """The app's Stop path closes the socket mid-stream; the stub must survive it.

    Not a nicety: the two-tab spec closes a page while a reply is in flight, so a
    stub that dropped its listener, or answered the next request from a broken
    handler, would fail a spec that had done nothing wrong.
    """

    def test_hanging_up_mid_stream_leaves_the_server_serving(self, stub):
        with httpx.Client(timeout=10) as client:
            with client.stream(
                "POST",
                chat_completions_url(stub.url),
                json={
                    "model": "served-model",
                    "messages": [{"role": "user", "content": "hi"}],
                    "stream": True,
                    "stream_options": {"include_usage": True},
                },
            ) as response:
                next(iter(response.iter_lines()))
                # Left without reading the rest: the server's write half now
                # faces a closed socket, which is a cancelled turn, not a fault.
        text, _, stream = stream_reply(stub.url)
        assert text == REPLY
        assert stream.saw_finish_reason is True
