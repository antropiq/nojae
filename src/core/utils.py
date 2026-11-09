import math


def estimate_completion_tokens(text: str) -> int:
    """Approximate generated-token count from text when usage is unavailable.

    Heuristic only (~4 chars/token); results using it are flagged as
    estimated so they are never mistaken for server-reported counts.
    """
    if not text:
        return 0
    return math.ceil(len(text) / 4)
