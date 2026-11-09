"""SSE frame serialisation for the chat stream."""

import json
from typing import Any, Dict

Event = Dict[str, Any]


def sse_format(seq: int, event: Event) -> str:
    """Serialize one event as an SSE frame."""
    name = event.get("event", "message")
    data = json.dumps(event, ensure_ascii=False)
    return f"id: {seq}\nevent: {name}\ndata: {data}\n\n"
