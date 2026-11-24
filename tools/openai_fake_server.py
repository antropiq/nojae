#!/usr/bin/env python3
"""An OpenAI-compatible stub model server, so a test suite needs no real model.

The e2e suite pointed its fixture at a real endpoint, which made it depend on a
server nobody owned: a reachable host and a hand-written model id had to exist
before any spec could run, and every answer varied with that model's sampling.
This script answers the two routes :mod:`src.core.llmkit` speaks and nothing
else, so the suite is hermetic and a streamed reply has an exactly-known shape.

Run it, then point a test connection's URL at it::

    python tools/openai_fake_server.py --port 8199
    # connection url: http://127.0.0.1:8199/v1

The ``/v1`` half of the URL is optional — :func:`llmkit.client._v1_base` appends
it. The fixture's model name may be **anything**: the stub serves whichever name
it is asked for and advertises ``--model`` at ``/v1/models``, so a harness that
writes both sides of the pair never has to keep two spellings in step.

The surface (everything the app asks a model server for):

``GET /v1/models``
    One entry whose ``id`` is ``--model`` and whose ``meta.n_ctx`` is the context
    window — the only path ``routes._context_window`` reads for the occupancy
    badge.
``POST /v1/chat/completions``
    Streaming when the body says ``stream``, otherwise one JSON body.

Each streamed answer is made of these frames, and the last two are load-bearing:

1. one ``delta.content`` frame per word, so the reassembled answer is exactly
   :attr:`FakeServerConfig.reply` and the panel sees a real token cadence;
2. a frame carrying ``finish_reason`` — **the honest-completion signal**.
   ``core.chat`` reads a stream that never carried one as a server that cut the
   reply short and ends the turn with a truncation error, so a stub that omitted
   it could never pass a streaming spec;
3. when asked (``stream_options.include_usage``), a frame holding only ``usage``;
4. ``data: [DONE]``, on which :mod:`llmkit.sse` stops iterating.

Token counts are a **word and character count, not a tokenizer's**: the stub has
no vocabulary. They are shaped like the app's own last-resort estimate (see
:func:`core.utils.estimate_completion_tokens`, ~4 chars/token) so the tok/s
figure and the cost line are plausible and stable. A spec should assert on the
*shape* of a stream, never on these numbers being a real model's.

Deliberately absent: reasoning deltas (the fixture pins ``"reasoning": "off"``,
so emitting them would contradict the connection it serves), tool calls (no spec
needs one, and a round with none is a complete answer to the tool loop), and any
auth check (:mod:`llmkit` always sends a bearer header, substituting a
placeholder when the connection holds no key — so there is nothing to verify).

Stdlib only, like the rest of ``tools/``: this starts *before* the app does, which
would be the worst possible moment to discover a missing dependency.
"""

from __future__ import annotations

import argparse
import json
import math
import re
import sys
import threading
import time
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional, Tuple

#: The answer a request gets when the caller asked for none. Fifty-odd words on
#: purpose: split per word and paced by the chunk gap, it streams for a couple of
#: seconds, which is long enough for a spec to catch a turn in flight (the two-tab
#: spec closes a tab mid-reply) and short enough to cost a run nothing.
DEFAULT_REPLY = (
    "A stub answers this test, so the answer is fixed and its shape is the point. "
    "It arrives in word-sized frames with a finish reason at the end and a usage "
    "block after that. Nothing about it varies between runs, so what a spec "
    "asserts is the stream the app builds, never the wording a model chose."
)

#: The two routes, built off the same ``/v1`` root the client builds its URLs on.
MODELS_ROUTE = "/v1/models"
COMPLETIONS_ROUTE = "/v1/chat/completions"

#: The sentinel :mod:`llmkit.sse` stops iterating on.
DONE = "[DONE]"

#: The SSE field name the parser reads, spelled here so this file and
#: ``llmkit.constants.DATA_PREFIX`` hold one meaning in one place.
DATA_PREFIX = "data:"

#: One word with whatever whitespace followed it, so concatenating the frames
#: reproduces the reply byte for byte.
WORD_FRAME = re.compile(r"\S+\s*")

#: A client that hung up mid-write, which is a cancelled turn rather than a
#: failure: ``core.chat`` closes the stream on Stop and expects nothing back.
DISCONNECTED = (BrokenPipeError, ConnectionResetError)


@dataclass
class FakeServerConfig:
    """Everything the stub is willing to vary, and its one default answer."""

    reply: str = DEFAULT_REPLY
    model: str = "fake-model"
    chunk_gap: float = 0.05
    first_token_delay: float = 0.0
    context_window: int = 8192
    quiet: bool = False

    @property
    def frames(self) -> List[str]:
        """The reply as the word frames it streams."""
        return WORD_FRAME.findall(self.reply)


class Handler(BaseHTTPRequestHandler):
    """The two routes, plus the silence a cancelled client leaves behind.

    HTTP/1.0 with one response per connection: the body is close-delimited, so a
    streamed answer needs no chunked-encoding framing of its own — which is what
    lets the reply be written as plain ``data:`` lines and the socket be the only
    end-of-stream signal besides the sentinel.
    """

    server_version = "nojae-fake-model/1.0"
    protocol_version = "HTTP/1.0"

    @property
    def config(self) -> FakeServerConfig:
        return self.server.config  # type: ignore[attr-defined,no-any-return]

    def log_message(self, fmt: str, *args: Any) -> None:
        """One line per request, on ``--quiet``'s say-so, and never at a cost.

        Both halves matter:

        * ``--quiet`` silences this, not only the startup banner — a harness that
          asked for quiet asked for it.
        * The write is guarded because **a log line must never be able to fail a
          request**. When stdout is a pipe whose reader has gone, a bare write
          raises, and since the base class calls this from *inside* the request
          handler, that exception lands after the status line and headers have
          been sent: the client then sees a response with no body, which is the
          most confusing failure this file could produce.
        """
        if self.config.quiet:
            return
        try:
            print(f"{self.address_string()} {fmt % args}", flush=True)
        except (OSError, ValueError):
            # A log line that cannot be written is not a reason to fail the
            # request it describes. See the docstring above.
            pass

    # --- routing -----------------------------------------------------------
    def do_GET(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        if self._route() == MODELS_ROUTE:
            self._send_json(models_payload(self.config))
            return
        self._send_json(error_payload(f"no GET route for {self._route()}", 404), 404)

    def do_POST(self) -> None:  # noqa: N802 - name fixed by BaseHTTPRequestHandler
        if self._route() != COMPLETIONS_ROUTE:
            self._send_json(
                error_payload(f"no POST route for {self._route()}", 404), 404
            )
            return
        try:
            body = self._read_json_body()
        except ValueError as exc:
            self._send_json(error_payload(str(exc), 400), 400)
            return
        if body.get("stream"):
            self._send_stream(body)
        else:
            self._send_json(completion_payload(self.config, body))

    def _route(self) -> str:
        """This request's path, query string and trailing slash removed."""
        return self.path.split("?", 1)[0].rstrip("/") or "/"

    # --- the completion ----------------------------------------------------
    def _send_stream(self, body: Dict[str, Any]) -> None:
        """One streamed completion: the frames, the sentinel, a closed socket."""
        config = self.config
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        chunk_id = completion_id()
        model = model_name(config, body)

        if config.first_token_delay > 0:
            # What a real endpoint spends before its *first* byte — the wait the
            # app's timeout deliberately leaves unbounded, and the one a
            # time-to-first-token assertion needs to not be instant.
            time.sleep(config.first_token_delay)

        for word in config.frames:
            if not self._write_data(
                chunk_payload(chunk_id, model, content=word)
            ):
                return
            if config.chunk_gap > 0:
                time.sleep(config.chunk_gap)

        # The completion signal. Without it every answer looks cut short, which
        # is the one thing a stub may not get wrong.
        if not self._write_data(
            chunk_payload(chunk_id, model, finish_reason="stop")
        ):
            return
        if wants_usage(body) and not self._write_data(usage_payload(chunk_id, model, config, body)):
            return
        self._write_raw(f"{DATA_PREFIX} {DONE}\n\n")
        self.close_connection = True

    # --- writing -----------------------------------------------------------
    def _send_json(self, payload: Dict[str, Any], status: int = 200) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(raw)))
        self.end_headers()
        self._write_raw_bytes(raw)

    def _write_data(self, payload: Dict[str, Any]) -> bool:
        """One ``data:`` frame. ``False`` when the client is gone."""
        try:
            body = json.dumps(payload, ensure_ascii=False) + "\n\n"
        except (TypeError, ValueError):  # pragma: no cover - payloads are local
            return False
        return self._write_raw(f"{DATA_PREFIX} {body}")

    def _write_raw(self, text: str) -> bool:
        return self._write_raw_bytes(text.encode("utf-8"))

    def _write_raw_bytes(self, raw: bytes) -> bool:
        try:
            self.wfile.write(raw)
            self.wfile.flush()
            return True
        except DISCONNECTED:
            return False

    def _read_json_body(self) -> Dict[str, Any]:
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        if not raw:
            return {}
        try:
            parsed = json.loads(raw)
        except ValueError as exc:
            raise ValueError(f"the request body is not valid JSON ({exc})") from exc
        if not isinstance(parsed, dict):
            raise ValueError("the request body is not a JSON object")
        return parsed


class FakeModelServer(ThreadingHTTPServer):
    """The stub: threaded, and gone when its process is.

    Both flags are about *leaving*. ``daemon_threads`` lets the process exit while
    a stream is mid-flight (Playwright kills this when the suite ends, often
    during an answer nobody was waiting for any more), and ``block_on_close`` has
    to be off for the same reason — the standard library joins handler threads in
    ``server_close`` even when they are daemons, so a half-written answer would
    hold up shutdown while the harness waited on it.
    """

    daemon_threads = True
    block_on_close = False
    allow_reuse_address = True

    def __init__(self, address: Tuple[str, int], config: FakeServerConfig) -> None:
        super().__init__(address, Handler)
        self.config = config


# --- the payloads -------------------------------------------------------------


def model_name(config: FakeServerConfig, body: Dict[str, Any]) -> str:
    """Whichever model the request asked for.

    Serving the name it is *given* is what lets a fixture name its model anything
    at all: the stub never refuses an id it has not been told about, so a
    mis-typed name cannot look like an app bug — and cannot silently answer a
    different model than the connection claims either, because there is only one.
    """
    asked = body.get("model")
    return asked if isinstance(asked, str) and asked else config.model


def chunk_payload(
    chunk_id: str,
    model: str,
    *,
    content: Optional[str] = None,
    finish_reason: Optional[str] = None,
) -> Dict[str, Any]:
    """One streamed chunk: a content delta, a finish reason, or both."""
    delta: Dict[str, Any] = {}
    if content is not None:
        delta["content"] = content
    return {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }


def wants_usage(body: Dict[str, Any]) -> bool:
    """Whether the request asked for a usage block on its stream.

    The seam always asks (``stream_options.include_usage``), but the stub answers
    the request it was actually given, so a caller that did not ask is not handed
    a frame it has to skip.
    """
    options = body.get("stream_options")
    return isinstance(options, dict) and bool(options.get("include_usage"))


def usage_payload(
    chunk_id: str,
    model: str,
    config: FakeServerConfig,
    body: Dict[str, Any],
) -> Dict[str, Any]:
    """The final streamed frame: usage and no choices."""
    return {
        "id": chunk_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [],
        "usage": usage(config, body),
    }


def completion_payload(
    config: FakeServerConfig, body: Dict[str, Any]
) -> Dict[str, Any]:
    """The non-streaming shape of the same answer."""
    return {
        "id": completion_id(),
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model_name(config, body),
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": config.reply},
                "finish_reason": "stop",
            }
        ],
        "usage": usage(config, body),
    }


def models_payload(config: FakeServerConfig) -> Dict[str, Any]:
    """One advertised model, with the one extra field the app reads."""
    return {
        "object": "list",
        "data": [
            {
                "id": config.model,
                "object": "model",
                "created": int(time.time()),
                "owned_by": "nojae-fake",
                # llama.cpp spells the context window this way and
                # routes._context_window reads exactly this path; a listing
                # without it leaves the occupancy badge showing no limit.
                "meta": {"n_ctx": config.context_window},
            }
        ],
    }


def usage(config: FakeServerConfig, body: Dict[str, Any]) -> Dict[str, int]:
    """The token block, counted in words and characters.

    There is no tokenizer here, so the prompt side is the same ~4-chars-per-token
    estimate the app itself falls back to when a server reports nothing. Honest
    as an estimate, stable as a fixture: the numbers never move between runs.
    """
    prompt_chars = 0
    messages = body.get("messages")
    if isinstance(messages, list):
        for message in messages:
            if isinstance(message, dict):
                prompt_chars += len(str(message.get("content") or ""))
    prompt = max(1, math.ceil(prompt_chars / 4))
    completion = max(1, len(config.frames))
    return {
        "prompt_tokens": prompt,
        "completion_tokens": completion,
        "total_tokens": prompt + completion,
    }


def error_payload(message: str, status: int) -> Dict[str, Any]:
    """An OpenAI-shaped error — the shape ``llmkit._error_message`` reads first.

    A body that is not this shape still reaches the UI, but as a truncated blob
    instead of a sentence, so the stub spells it the way a real server would.
    """
    return {"error": {"message": message, "type": "invalid_request_error", "code": status}}


#: A per-response id. Nothing in the app reads it; a completion without one is
#: merely odd, and monotonic ids make a captured log easy to read.
_ID_LOCK = threading.Lock()
_ID_SEQ = 0


def completion_id() -> str:
    global _ID_SEQ
    with _ID_LOCK:
        _ID_SEQ += 1
        return f"chatcmpl-fake-{_ID_SEQ}"


# --- running it ---------------------------------------------------------------


def parse_args(argv: Optional[List[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="An OpenAI-compatible stub model server, for tests.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    parser.add_argument("--host", default="127.0.0.1", help="bind address")
    parser.add_argument(
        "--port",
        type=int,
        default=8199,
        help="bind port; 0 takes any free port and prints the answer",
    )
    parser.add_argument("--model", default="fake-model", help="id at /v1/models")
    parser.add_argument("--reply", default=DEFAULT_REPLY, help="the answer")
    parser.add_argument(
        "--chunk-gap",
        type=float,
        default=0.05,
        help="seconds between content frames; 0 streams as fast as it can",
    )
    parser.add_argument(
        "--first-token-delay",
        type=float,
        default=0.0,
        help="seconds before the first frame, for a slow-first-token test",
    )
    parser.add_argument(
        "--n-ctx", type=int, default=8192, help="context window at /v1/models"
    )
    parser.add_argument(
        "--quiet", action="store_true", help="log nothing: not the banner, not requests"
    )
    return parser.parse_args(argv)


def build_config(args: argparse.Namespace) -> FakeServerConfig:
    return FakeServerConfig(
        reply=args.reply,
        model=args.model,
        chunk_gap=max(0.0, args.chunk_gap),
        first_token_delay=max(0.0, args.first_token_delay),
        context_window=args.n_ctx,
        quiet=args.quiet,
    )


def main(argv: Optional[List[str]] = None) -> int:
    args = parse_args(argv)
    config = build_config(args)
    try:
        server = FakeModelServer((args.host, args.port), config)
    except OSError as exc:
        sys.stderr.write(
            f"the fake model server cannot bind {args.host}:{args.port}: {exc}\n"
        )
        return 1
    bound = server.server_address[:2]
    if not args.quiet:
        print(
            f"fake model server on http://{bound[0]}:{bound[1]}/v1 "
            f"(model {config.model}, {len(config.frames)} frames, "
            f"{config.chunk_gap}s apart)",
            flush=True,
        )
    try:
        server.serve_forever(poll_interval=0.1)
    except KeyboardInterrupt:
        pass
    finally:
        server.shutdown()
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
