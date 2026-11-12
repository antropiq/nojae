#!/usr/bin/env python3
"""Regenerate the Rust port's parity fixtures from this (legacy) implementation.

Run it from anywhere; it touches only this repo's own source and the output
directory you name. It is a **tool, not a test** -- the file name does not start
with ``test_``, so pytest never collects it -- and it is hermetic: no socket, no
``.env``, no workspace settings file. Every import below is pure string/dict
code (the sanitizer, the parser, the wire constants, and the two test modules
that hold the shared builders and the measured-wire fixture); nothing here can
reach a network.

Why it exists (``docs/llmkit-rust-port-spec.md`` §7.4): for a port, the strongest
guard is not a translated test but a **shared data set**. Both implementations
are held to the same vectors, so a later drift shows up as a failing fixture
instead of as a difference between two hand-maintained test files. That is why
every ``expected`` value below is **computed by calling the legacy code**: the
fixture is a record of what the Python does, not of what anyone believes it does.

The committed copies live in the Rust repo at
``crates/llmkit/tests/fixtures/{sanitizer,sse,request_body}.json`` and are read
by ``crates/llmkit/tests/parity.rs``. They are **generated, never hand-edited**;
the ``_meta`` block at the top of each file says so and names this script.

Usage::

    python3 .../tests/dump_parity_fixtures.py                # JSON on stdout
    python3 .../tests/dump_parity_fixtures.py path/to/dir    # one file per family

The output is deterministic: regenerating twice must produce byte-identical
files (``diff`` them -- task 12's "Done when" list requires exactly that).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

# The script is run from the *Rust* repo (or from anywhere), so it puts this
# repo's root on the import path itself instead of relying on `python -m` from
# the legacy folder.
LEGACY_ROOT = Path(__file__).resolve().parent.parent
if str(LEGACY_ROOT) not in sys.path:
    sys.path.insert(0, str(LEGACY_ROOT))

from src.core.llmkit import constants  # noqa: E402
from src.core.llmkit.sanitize import (  # noqa: E402
    neutralize,
    sanitize_content,
    sanitize_messages,
)
from src.core.llmkit.sse import (  # noqa: E402
    SSEFrameError,
    iter_chunks,
    parse_frame,
)
from tests.llmkit_fakes import (  # noqa: E402
    DONE_FRAME,
    content_chunk,
    finish_chunk,
    reasoning_chunk,
    usage_chunk,
)
from tests.test_llmkit_contract import (  # noqa: E402
    EXPECTED_STREAM_BODY,
    MAX_TOKENS,
    MODEL,
    SAMPLING,
)

# --- where the fixtures go --------------------------------------------------
#
# Named in every fixture header so the next person finds the command without
# having to search for it, and so a reader of the JSON knows its provenance.

GENERATOR = "/mnt/bigfoot/dev/nojae/tests/dump_parity_fixtures.py"
OUTPUT_DIR_IN_RUST_REPO = "crates/llmkit/tests/fixtures"


def meta(family: str) -> Dict[str, Any]:
    """The provenance header every fixture file carries (§7.4)."""
    return {
        "family": family,
        "generated": True,
        "generator": GENERATOR,
        "regenerate": f"python3 {GENERATOR} {OUTPUT_DIR_IN_RUST_REPO}",
        "do_not_edit": (
            "generated, never hand-edited: every `expected` value below was "
            "computed by calling the legacy Python implementation, so this file "
            "is a record of what it does, not an opinion about it. A hand-edited "
            "case silently becomes a third opinion about the truth. If a Rust "
            "test fails against this file, the Rust is wrong or this generator "
            "is wrong -- fix one of those and regenerate; do not edit the JSON."
        ),
    }


# --- control-token pieces, assembled from single characters ------------------
#
# Never spell a complete delimiter-wrapped run as literal text in this file
# either: the run the sanitizer exists to remove must not appear in the code
# that records its removal. Same three pieces (and the same rule) as
# ``src/core/llmkit/sanitize.py`` and ``tests/llmkit_fakes.py``.

PIPE = "|"
OPEN_DELIM = f"<{PIPE}"
CLOSE_DELIM = f"{PIPE}>"


def special_token(name: str) -> str:
    """One delimiter-wrapped control token, spelled from its characters."""
    return f"{OPEN_DELIM}{name}{CLOSE_DELIM}"


# --- multi-byte characters, named -------------------------------------------
#
# Written as escapes rather than as their glyphs so the source stays readable on
# any terminal, and named so the cases below read as what they are. The point of
# every one of them is D-R13: Python slices by character, so a byte-indexed port
# is only caught by vectors where bytes and characters disagree.

E_ACUTE = "\u00e9"  # 2 bytes
U_UMLAUT = "\u00fc"  # 2 bytes
UMLAUTED = "\u00fcn\u00efc\u00f6d\u00e9"  # 8 characters, 14 bytes
JAPANESE = "\u65e5\u672c\u8a9e"  # 3 characters, 9 bytes
KATAKANA = "\u30c6\u30b9\u30c8"  # 4 characters, 12 bytes
KANJI_NAME = "\u540d\u524d"  # 2 characters, 6 bytes
SNOWMAN = "\u26c4"  # 3 bytes
EMOJI = "\U0001f642"  # 4 bytes (astral: a surrogate pair in UTF-16)


# --- one SSE line, as the server writes it ----------------------------------

DATA_PREFIX = constants.DATA_PREFIX


def frame(payload: Any) -> str:
    """One ``data:`` line, exactly as the server writes it (space included).

    ``ensure_ascii=False`` so a multi-byte payload reaches the fixture as UTF-8
    text rather than as ``\\uXXXX`` escapes: the point of the multi-byte cases
    (D-R13) is that a reader can *see* the bytes are not characters.
    """
    return DATA_PREFIX + " " + json.dumps(payload, ensure_ascii=False)


def done_line() -> str:
    return DATA_PREFIX + " " + DONE_FRAME


def final_frame() -> Dict[str, Any]:
    """The measured final frame: finish reason, usage block and llama timings."""
    chunk = finish_chunk(
        "stop",
        content="",
        usage={
            "prompt_tokens": 42,
            "completion_tokens": 7,
            "total_tokens": 49,
            "prompt_tokens_details": {"cached_tokens": 0},
        },
    )
    chunk["timings"] = {"predicted_ms": 233.1, "predicted_per_second": 30.05}
    return chunk


# --- family 1: the sanitizer ------------------------------------------------
#
# Inputs drawn from the legacy suites' own cases: ``test_llmkit_sanitize.py``
# and the sanitizer-at-the-seam block of ``test_llmkit_client.py``. The
# multi-byte entries are the family the whole exercise exists to cross-check
# (D-R13): Python indexes characters by construction, so a byte-indexed Rust
# port would only be caught by vectors where the two disagree.

NEUTRALIZE_INPUTS: List[str] = [
    # Plain prose carries nothing to remove -- and one deliberately awkward
    # line: pipes and lone angle brackets around them, all benign.
    "The capital of France is Paris.\nCode: a|b, x<y, p|q>.",
    "plain <>| text only",
    # A lone delimiter half is not a run: the sanitizer removes runs, not
    # characters.
    f"a{OPEN_DELIM}b",
    f"a{CLOSE_DELIM}b",
    f"lone close {CLOSE_DELIM} and lt < there",
    # A pipe inside the name is not the shape any template tokenises as one
    # control token, so such text survives byte for byte.
    f"compare a{OPEN_DELIM}b{PIPE}c{CLOSE_DELIM}d "
    f"and x{OPEN_DELIM}y{PIPE}w and z{CLOSE_DELIM}v",
    # The run this module exists to remove.
    f"ok {special_token('im_start')} still ok",
    special_token("a") + "x" + special_token("b") + "y" + special_token("c"),
    special_token(""),  # an empty name is still a run
    special_token("sys tem"),  # whitespace does not save it
    special_token("im\nstart"),  # and neither does a newline
    special_token("x" * 80),  # the one-way pass removes a run of any length
    # The splice: deleting the inner run joins the outer fragments into a
    # complete run, which a single pass would hand back.
    f"{OPEN_DELIM}im_{special_token('x')}start{CLOSE_DELIM}",
    f"x{OPEN_DELIM}im_{special_token('q')}start{CLOSE_DELIM}y",
    f"nested {OPEN_DELIM}a{special_token('b')}c{CLOSE_DELIM}!",
    # An unterminated opening is not a run.
    f"ends with an open {OPEN_DELIM}",
    f"{OPEN_DELIM}pend",
    # Multi-byte (D-R13): every character here is wider than one byte, so a
    # byte-indexed walk would slice a character in half or land on the wrong
    # bound. (Concatenated rather than f-stringed: a backslash inside an
    # f-string expression needs Python 3.12, and this repo still supports 3.10.)
    "no\u00ebl " + special_token(E_ACUTE) + " " + UMLAUTED,
    JAPANESE + special_token(KANJI_NAME) + KATAKANA,
    special_token(E_ACUTE) + special_token(U_UMLAUT),
    EMOJI + special_token("x") + EMOJI,
    SNOWMAN * 3 + special_token("snow") + SNOWMAN * 3,
    # A run whose name is 20 characters but 80 bytes, so the whole run spans
    # more bytes than the 64-character hold bound and fewer characters: an
    # implementation counting bytes would measure a different length here than
    # the one the Python counts (D-R13).
    special_token(EMOJI * 20),
]

SANITIZE_CONTENT_INPUTS: List[Any] = [
    # A string is sanitized outright.
    "clean content",
    f"a{special_token('evil')}b",
    "no\u00ebl " + special_token(E_ACUTE) + " done",
    # Anything else passes through for the server to judge.
    None,
    42,
    {"plain": "object"},
    # A list of content parts: each part's ``text`` is sanitized, other parts
    # and other keys pass through.
    [
        {
            "type": "text",
            "text": f"a{special_token('evil')}b",
            "custom": 1,
        },
        {"type": "image_url", "image_url": {"url": "http://x/y.png"}},
    ],
    [{"type": "text", "text": "clean"}],
    [
        {
            "type": "text",
            "text": JAPANESE + special_token(KANJI_NAME),
            "tags": ["a", "b"],
        }
    ],
    [{"text": 7}],  # a part whose ``text`` is not a string
    ["not a part"],  # a non-dict part
]

SANITIZE_MESSAGES_INPUTS: List[List[Any]] = [
    # Every string a server template renders is walked, not just ``content``.
    [{"role": "user", "content": f"q: {special_token('evil')} answer"}],
    [
        {"role": "system", "content": "calm"},
        {"role": "user", "content": special_token("evil")},
    ],
    [
        {
            "role": "assistant",
            "content": "ok",
            "name": f"a{special_token('x')}b",
            "reasoning_content": special_token("think") + "deep",
        }
    ],
    [
        {
            "role": "assistant",
            "content": None,
            "tool_calls": [
                {
                    "id": "c1",
                    "type": "function",
                    "function": {
                        "name": f"too{special_token('x')}l",
                        "arguments": special_token("evil") + '{"q": 1}',
                    },
                }
            ],
        }
    ],
    # A clean message round-trips equal (D-R4): the walker must neither reorder
    # keys nor reserialize numbers.
    [
        {
            "role": "assistant",
            "content": "hi",
            "tool_calls": [{"id": "c1", "function": {"name": "f", "arguments": "{}"}}],
            "usage": {"prompt_tokens": 10, "total_tokens": 12},
            "flag": True,
            "score": 0.5,
        }
    ],
    [{"role": "assistant", "tool_calls": [{"id": "c1"}]}],  # no content key
    [{"role": "user", "content": [{"type": "text", "text": f"a{special_token('evil')}b", "custom": 1}]}],
    [{"role": "user", "content": f"a{OPEN_DELIM}im_{special_token('x')}start{CLOSE_DELIM}b"}],
    [
        {
            "role": "user",
            "content": JAPANESE + special_token(KANJI_NAME) + KATAKANA,
            "name": KANJI_NAME,
        }
    ],
    # Benign halves survive: sanitizing must not become stripping.
    [{"role": "user", "content": "keep " + special_token("evil")}, {"role": "user", "content": f"keep {OPEN_DELIM}h\u00e4lf"}],
    ["not a message"],  # a non-dict entry passes through
    [],  # the empty history
]
#
# Deliberately absent: a tool-call ``function`` that carries ``arguments`` but
# no ``name``. The legacy ``_sanitize_tool_call`` copies the function dict and
# then assigns *both* fields, so such a call comes back with ``"name": null``
# invented into the request body. The Rust port removes runs without adding
# keys (task 04's documented divergence), so a case here would pin the legacy
# behaviour and hold the port to something it deliberately does not reproduce.


def sanitizer_fixture() -> Dict[str, Any]:
    """The sanitizer family: one record per input, ``expected`` from the code."""
    return {
        "_meta": meta("sanitizer"),
        "neutralize": [
            {"input": text, "expected": neutralize(text)} for text in NEUTRALIZE_INPUTS
        ],
        "sanitize_content": [
            {"input": value, "expected": sanitize_content(value)}
            for value in SANITIZE_CONTENT_INPUTS
        ],
        "sanitize_messages": [
            {"input": messages, "expected": sanitize_messages(messages)}
            for messages in SANITIZE_MESSAGES_INPUTS
        ],
    }


# --- family 2: the SSE parser -----------------------------------------------
#
# Inputs drawn from ``test_llmkit_sse.py``. ``expected_error`` is ``None`` for
# every case that parses and a **marker** (the exception class's name, never its
# message) for the cases that raise: the Rust side asserts *that* the run fails,
# not how the failure is worded (AGENTS.md's wording rule).

ERROR_MARKER = SSEFrameError.__name__

PARSE_FRAME_LINES: List[str] = [
    # The ``data:`` prefix, with and without its optional space.
    frame(content_chunk("hel")),
    DATA_PREFIX + json.dumps(content_chunk("hel"), ensure_ascii=False),
    frame(content_chunk("o")) + "\n",  # a line iterator that keeps the terminator
    DATA_PREFIX,
    DATA_PREFIX + " ",
    # Everything that is not an event carrying a JSON object.
    ": keep-alive",
    ": ping",
    ":",
    ":no-spaces-here",
    "",
    "\n",
    "   ",
    "event: message",
    "id: 42",
    "retry: 1000",
    # ``[DONE]`` is transport framing, with and without the space (D3).
    done_line(),
    DATA_PREFIX + DONE_FRAME,
    # The chunk shapes that must pass through untouched.
    frame(usage_chunk(prompt=11, completion=3, total=14)),
    frame(final_frame()),
    frame(content_chunk(JAPANESE)),
    # A JSON scalar or array is not a chunk -- and not a half-read frame either.
    "data: [1, 2, 3]",
    'data: "hello"',
    "data: 42",
    # A ``data:`` payload that should be a chunk but does not parse (D3).
    "data: {not json}",
    'data: {"choices": [{"delta": {"content": "half an',
    'data: {"choices": [oops]}',
    # ... including a multi-byte one, where the 80-character excerpt is capped
    # in characters and not in bytes (D-R13).
    DATA_PREFIX + " " + E_ACUTE * 90,
]

ITER_CHUNKS_LINES: List[List[str]] = [
    # A whole stream parses in order.
    [frame(content_chunk("Hello")), "", frame(content_chunk(" there")), done_line()],
    # ``[DONE]`` ends iteration and is never yielded: the frame after it is not
    # read at all.
    [frame(content_chunk("a")), done_line(), frame(content_chunk("b"))],
    # Comments and blank lines are skipped between frames.
    [
        ": keep-alive",
        "",
        frame(reasoning_chunk("think")),
        ": keep-alive",
        frame(usage_chunk(prompt=5, completion=1, total=6)),
        done_line(),
        ": keep-alive",
    ],
    # A stream cut before ``[DONE]`` still yields every frame it got.
    [frame(content_chunk("half an "))],
    # An empty input yields nothing.
    [],
    # A malformed frame fails through iteration, after the chunks before it.
    [frame(content_chunk("a")), "data: {oops", done_line()],
    # The sentinel without the space ends the stream too.
    [frame(content_chunk("a")), DATA_PREFIX + DONE_FRAME, frame(content_chunk("b"))],
    # Frames that carry nothing between two that do.
    [frame(content_chunk("x")), "event: message", "data: 42", frame(content_chunk("y"))],
    # Multi-byte content streams through intact.
    [
        frame(content_chunk(JAPANESE)),
        frame(content_chunk(" " + UMLAUTED)),
        frame(final_frame()),
        done_line(),
    ],
]


def chunks_before_error(lines: Sequence[str]) -> Tuple[List[Any], Optional[str]]:
    """What ``iter_chunks`` yields from ``lines``, and whether it then raised.

    The partial list matters: a cut stream's frames are still the caller's, so
    the Rust side compares the chunks it got before the failure as well as the
    failure itself.
    """
    yielded: List[Any] = []
    try:
        for chunk in iter_chunks(lines):
            yielded.append(chunk)
    except SSEFrameError:
        return yielded, ERROR_MARKER
    return yielded, None


def sse_fixture() -> Dict[str, Any]:
    """The SSE family: ``parse_frame`` cases and ``iter_chunks`` cases."""
    parse_cases: List[Dict[str, Any]] = []
    for line in PARSE_FRAME_LINES:
        try:
            chunk = parse_frame(line)
            parse_cases.append(
                {
                    "lines": [line],
                    "expected_chunks": [] if chunk is None else [chunk],
                    "expected_error": None,
                }
            )
        except SSEFrameError:
            parse_cases.append(
                {"lines": [line], "expected_chunks": [], "expected_error": ERROR_MARKER}
            )
    iter_cases: List[Dict[str, Any]] = []
    for lines in ITER_CHUNKS_LINES:
        yielded, error = chunks_before_error(lines)
        iter_cases.append(
            {"lines": lines, "expected_chunks": yielded, "expected_error": error}
        )
    return {
        "_meta": meta("sse"),
        "parse_frame": parse_cases,
        "iter_chunks": iter_cases,
    }


# --- family 3: the measured request body ------------------------------------
#
# §7.4: "the measured request body, byte for byte" -- the body
# ``tests/test_llmkit_contract.py::EXPECTED_STREAM_BODY`` pins, which is the same
# constant the legacy client suite diffs the real client against. It is taken
# from there rather than retyped: a copy here would be a third opinion.
#
# The call inputs travel with it because the Rust side cannot reach the private
# body assembly (D-R8): it drives ``stream_completion`` against the task 08 seam
# with exactly these arguments and compares what the far end received. The
# streaming shape takes ``max_tokens`` through the sampling map (it is one of the
# call's own values, not part of the wire contract), which is the route the
# legacy contract test uses as well.


def request_body_fixture() -> Dict[str, Any]:
    sampling = dict(SAMPLING)
    sampling["max_tokens"] = MAX_TOKENS
    return {
        "_meta": meta("request_body"),
        "stream": {
            "model": MODEL,
            "messages": [],
            "api_key": None,
            "sampling": sampling,
            "tools": None,
            "expected_body": EXPECTED_STREAM_BODY,
        },
    }


# --- entry point ------------------------------------------------------------


def dump_json(payload: Any) -> str:
    """Serialize a family, with the delimiter characters written as escapes.

    The Rust crate this feeds keeps one rule everywhere: a complete
    delimiter-wrapped control-token run is **never written as literal text** in
    any source or test file, because the run those files exist to remove must not
    appear in them. A fixture full of attack strings would break that rule in the
    very file that records the removal.

    So the three characters are escaped (``\\u003c``, ``\\u003e``, ``\\u007c``).
    They can only occur inside JSON *strings* -- none of them is JSON syntax --
    so escaping them globally is safe, and it changes nothing about the decoded
    value: the Rust side reads exactly the same text back. ``ensure_ascii=False``
    keeps the multi-byte cases (D-R13) visible as the UTF-8 they are.
    """
    text = json.dumps(payload, indent=2, ensure_ascii=False)
    for character, escape in (("<", "\\u003c"), (">", "\\u003e"), ("|", "\\u007c")):
        text = text.replace(character, escape)
    return text + "\n"


def families() -> Dict[str, Dict[str, Any]]:
    """The three families, in a fixed order so the output is byte-stable."""
    return {
        "sanitizer": sanitizer_fixture(),
        "sse": sse_fixture(),
        "request_body": request_body_fixture(),
    }


def main(argv: Sequence[str]) -> int:
    if len(argv) > 2:
        print(
            "usage: dump_parity_fixtures.py [output-directory]",
            file=sys.stderr,
        )
        return 2
    payloads = families()
    if len(argv) == 2:
        target = Path(argv[1])
        target.mkdir(parents=True, exist_ok=True)
        for name, payload in payloads.items():
            path = target / f"{name}.json"
            path.write_text(dump_json(payload), encoding="utf-8")
            print(f"wrote {path}", file=sys.stderr)
        return 0
    sys.stdout.write(dump_json(payloads))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
