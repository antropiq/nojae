from src.core.utils import estimate_completion_tokens


class TestEstimateCompletionTokens:
    def test_empty_text_returns_zero(self):
        assert estimate_completion_tokens("") == 0

    def test_rounds_up_quarter_length(self):
        assert estimate_completion_tokens("abcd") == 1
        assert estimate_completion_tokens("abcde") == 2
        assert estimate_completion_tokens("a" * 10) == 3

