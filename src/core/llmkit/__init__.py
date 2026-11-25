"""The in-house LLM client: the one place in the app that speaks HTTP to a
model endpoint.

Core-only transport: no FastAPI, no event bus, no ``.env`` read — a caller
passes ``model`` / ``server_url`` / ``api_key`` / ``sampling`` in. Layout
mirrors ``core/mcphub`` and ``core/lsphub``:

* :mod:`llmkit.constants` -- the tuning numbers (timeouts, wire sentinels)
* :mod:`llmkit.sanitize` -- neutralising delimiter-wrapped control-token runs
  in outgoing content, applied by both call shapes
* :mod:`llmkit.sse` -- SSE lines to parsed chat-completion chunk dicts
* :mod:`llmkit.client` -- the two call shapes, the error type, the verdict on
  a failed call, the URL rules
"""

from .client import (
    ChatStream,
    LLMRequestError,
    another_attempt_may_help,
    chat_completion,
    chat_completions_url,
    models_url,
    stream_completion,
)

__all__ = [
    "ChatStream",
    "LLMRequestError",
    "another_attempt_may_help",
    "chat_completion",
    "chat_completions_url",
    "models_url",
    "stream_completion",
]
