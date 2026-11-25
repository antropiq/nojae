"""Tool calls a model wrote as *text* instead of as structured ``tool_calls``.

Some serving runtimes parse a tool call against the declared tool list and, at
the first name they cannot match, give up on the structured path entirely: the
markup arrives as ordinary assistant text and no ``tool_calls`` delta is ever
produced. The chat loop keys its tool round off those deltas, so such a round
ended the reply with the markup painted into the panel and nothing executed.

This module is the recogniser for that text, and answers two questions only:
what tool calls does a piece of answer text spell out, and how much of a
still-arriving text may be painted before that is decided. Both grammars seen
in the wild are read:

* a ``<tool_call>`` wrapper holding either the JSON body Hermes-style models
  emit (``name`` / ``arguments``) or the attribute-style inner tags;
* an ``invoke``-style block (optionally ``antml:``-namespaced) holding
  ``parameter`` tags.

The streaming twin is :class:`TextToolCallFilter`, and it is why this is a
module rather than two functions: markup straddles chunk borders, so a
per-chunk pass would paint the first half of a call and only then recognise it.
Text is handed over only once it provably starts no block, and the hold-back is
bounded by ``_MAX_BLOCK_LEN``, so a stray opener in ordinary prose delays the
panel by that window instead of freezing the answer.

Deliberately *not* handled: a complete, well-formed block fenced as a code
example is still read as a call. Telling a demonstration apart from a real call
is not decidable here, and the case only arises on the turns this module exists
to repair.
"""

import json
import re
from typing import Dict, List

# An attribute value: quoted or bare, and never empty. Quoting is stripped by
# :func:`_unquote` rather than by the pattern, so one spelling covers both.
_ATTR = r"""["']?[A-Za-z_][A-Za-z0-9_.\-]*["']?"""

# Any one complete block, in either grammar. The wrapper alternative comes first
# and starts earlier than what it holds, so a wrapped call matches whole instead
# of being found again as its inner tag.
_BLOCK = re.compile(
    r"<\s*tool_calls?\s*>(?P<wrapper>.*?)<\s*/\s*tool_calls?\s*>"
    r"|<\s*function\s*(?:name\s*=\s*|=\s*)(?P<function_name>" + _ATTR + r")\s*>"
    r"(?P<function_body>.*?)<\s*/\s*function\s*>"
    r"|<\s*(?:antml:)?invoke\s*(?:name\s*=\s*|=\s*)(?P<invoke_name>" + _ATTR + r")\s*>"
    r"(?P<invoke_body>.*?)<\s*/\s*(?:antml:)?invoke\s*>",
    re.S,
)

# One argument of the attribute-style inner tags: ``parameter=path`` and
# ``parameter name="path"`` spell the same thing.
_PARAMETER = re.compile(
    r"<\s*(?:antml:)?parameter\s*(?:name\s*=\s*|=\s*)(" + _ATTR + r")\s*>"
    r"(.*?)<\s*/\s*(?:antml:)?parameter\s*>",
    re.S,
)

# The block openings a call can start with. Each may be followed by whitespace
# or its ``>``, and :data:`_OPENER_MORE` lists what its tag allows beyond that
# (the plural wrapper's ``s``, the ``=`` an attribute needs). The streaming
# filter holds text from a possible opening until the block completes or is
# disproven. Without the continuation table, a tag merely *beginning* with a
# name -- ``<tool_caller>`` -- would be held until the length bound gave up.
_OPENER_NAMES = ("antml:invoke", "tool_calls", "tool_call", "function", "invoke")
_OPENER_MORE = {
    "antml:invoke": "=",
    "tool_calls": "",
    "tool_call": "s",
    "function": "=",
    "invoke": "=",
}

# How much text one call's markup may hold back before it is declared prose.
# A real call fits comfortably; the bound only fires on an opener that never
# closes, which is not a call at all.
_MAX_BLOCK_LEN = 4096


def _unquote(value: str) -> str:
    """An attribute value with its surrounding quotes, if any, removed."""
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _dsl_arguments(body: str) -> str:
    """The argument JSON string of one attribute-style block body.

    ``parameter`` tags become an object keyed by their name. A body holding no
    tag is passed through when it is already an argument JSON object, so the
    ``{"path": "x"}`` spelling some models use inside these tags still reaches
    the executor; anything else is no arguments at all.
    """
    args: Dict[str, str] = {}
    for match in _PARAMETER.finditer(body):
        args[_unquote(match.group(1))] = match.group(2).strip()
    if args:
        return json.dumps(args, ensure_ascii=False)
    stripped = body.strip()
    if not stripped.startswith("{"):
        return "{}"
    try:
        json.loads(stripped)
    except json.JSONDecodeError:
        return "{}"
    return stripped


def _calls_from_json(body: str) -> List[Dict[str, str]]:
    """Calls of a ``<tool_call>`` wrapper holding a JSON body.

    Accepts one object or a list of them, in the shape models emit: a ``name``
    plus either an ``arguments`` object or the same text the wire would carry.
    An entry without a usable name is skipped rather than guessed at.
    """
    stripped = body.strip()
    if not stripped.startswith(("{", "[")):
        return []
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError:
        return []
    items = data if isinstance(data, list) else [data]
    calls: List[Dict[str, str]] = []
    for item in items:
        if not isinstance(item, dict):
            continue
        name = item.get("name")
        if not isinstance(name, str) or not name:
            continue
        arguments = item.get("arguments", {})
        if not isinstance(arguments, str):
            try:
                arguments = json.dumps(arguments, ensure_ascii=False)
            except (TypeError, ValueError):
                arguments = "{}"
        calls.append({"name": name, "arguments": arguments})
    return calls


def _calls_of(match: "re.Match[str]") -> List[Dict[str, str]]:
    """The calls one matched block spells out (possibly none)."""
    wrapper = match.group("wrapper")
    if wrapper is not None:
        # A wrapper either holds inner tags or the JSON body that is written
        # instead of them: read the tags to find out, and fall back to the JSON
        # so the Hermes spelling resolves through the same function.
        calls: List[Dict[str, str]] = []
        for inner in _BLOCK.finditer(wrapper):
            calls.extend(_calls_of(inner))
        return calls or _calls_from_json(wrapper)
    function_name = match.group("function_name")
    if function_name is not None:
        return [
            {
                "name": _unquote(function_name),
                "arguments": _dsl_arguments(match.group("function_body")),
            }
        ]
    return [
        {
            "name": _unquote(match.group("invoke_name")),
            "arguments": _dsl_arguments(match.group("invoke_body")),
        }
    ]


def find_text_tool_calls(text: str) -> List[Dict[str, str]]:
    """Every tool call ``text`` spells out, in the order it writes them.

    A whole-string convenience over :class:`TextToolCallFilter`, which is what
    the streaming loop uses.
    """
    filter_ = TextToolCallFilter()
    filter_.feed(text)
    filter_.flush()
    return filter_.calls


def _could_open(text: str, p: int) -> bool:
    """Whether a block could still open at ``text[p]``, which is a ``<``.

    Undecided counts as an opening: a lone ``<``, a partial name, or a name with
    no character after it yet may all still become a tag, so the text from there
    is held. Anything that settled otherwise -- ``<b>``, ``<tool_caller>``, a
    finished name followed by a character its tag cannot take -- is dead for
    good and released, which is what keeps ordinary prose unheld.
    """
    rest = text[p + 1:].lstrip()
    if not rest:
        return True
    for name in _OPENER_NAMES:
        if rest.startswith(name):
            following = rest[len(name):len(name) + 1]
            return (
                following in ("", ">", " ", "=", "\t", "\n")
                or following in _OPENER_MORE[name]
            )
        if name.startswith(rest):
            return True
    return False


class TextToolCallFilter:
    """The streaming twin of :func:`find_text_tool_calls`.

    Text may be handed over only once it provably starts no call, so a block
    split across chunks is never painted in half. Each :meth:`feed` removes
    every complete block it now holds, then releases up to the earliest position
    where a block could still open. The held remainder is bounded by
    :data:`_MAX_BLOCK_LEN`, so an unterminated opener costs a delay of that many
    characters instead of the whole reply.

    ``calls`` accumulates across the stream: it is what the tool loop reads
    after the round to build the failing tool turn.
    """

    def __init__(self) -> None:
        self._held = ""
        self.calls: List[Dict[str, str]] = []

    def feed(self, text: str) -> str:
        """The part of the stream that is now provably free of a call."""
        self._held += text
        released: List[str] = []
        while True:
            match = _BLOCK.search(self._held)
            if match is None:
                break
            released.append(self._held[: match.start()])
            self.calls.extend(_calls_of(match))
            self._held = self._held[match.end():]
        boundary = len(self._held)
        for p, char in enumerate(self._held):
            if char == "<" and _could_open(self._held, p):
                boundary = p
                break
        if len(self._held) - boundary > _MAX_BLOCK_LEN:
            # The candidate outgrew any real call, so it was not one: release all
            # but the newest window a block could still complete through.
            boundary = len(self._held) - _MAX_BLOCK_LEN
        released.append(self._held[:boundary])
        self._held = self._held[boundary:]
        return "".join(released)

    def flush(self) -> str:
        """The held remainder, when the stream has ended."""
        held, self._held = self._held, ""
        return held
