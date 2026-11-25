import math


def estimate_completion_tokens(text: str) -> int:
    """Approximate generated-token count from text when usage is unavailable.

    Heuristic only (~4 chars/token); a caller using it flags the figure as
    estimated so it is never mistaken for a server-reported count.
    """
    if not text:
        return 0
    return math.ceil(len(text) / 4)
