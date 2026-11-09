from types import SimpleNamespace

from src.core.llm import (
    _extract_reasoning,
    _extract_usage,
    close_llm_stream,
    safe_get_choice_content,
    saw_finish_reason,
)
# The chunk builders come from the shared double (``tests/llmkit_fakes``) so the
# stubs and ``llmkit.client.ChatStream`` are held to one interface.
from tests.llmkit_fakes import FakeStream, content_chunk, finish_chunk


class TestSawFinishReason:
    """The one signal a cut stream and a finished one differ on.

    Their chunks are indistinguishable, so the reader asks the stream itself:
    ``saw_finish_reason`` is what ``llmkit.client.ChatStream`` records while it
    is iterated. The chat loop reads it after draining the stream and ends the
    reply on ``error`` when it is false (``tests/test_chat.py``, and the
    end-to-end case in ``tests/test_llmkit_client.py``).
    """

    def test_a_stream_shape_without_the_attribute_fails_open(self):
        # A false alarm on a complete answer would be its own bug, so an
        # unrecognised shape (a bare iterable, ``None``, a stub) reads as
        # finished.
        assert saw_finish_reason(object()) is True  # attribute absent
        assert saw_finish_reason(None) is True
        assert saw_finish_reason(iter([content_chunk("whole answer")])) is True

    def test_a_stream_that_never_carried_a_reason_is_cut(self):
        cut = FakeStream([content_chunk("half an "), content_chunk("answer")])
        list(cut)
        assert saw_finish_reason(cut) is False

    def test_a_received_reason_leaves_the_stream_alone(self):
        finished = FakeStream([content_chunk("done"), finish_chunk("stop")])
        list(finished)
        assert saw_finish_reason(finished) is True

    def test_a_late_finish_reason_counts_as_received(self):
        # The reason may arrive on any chunk, not the first: the flag is a
        # whole-stream fact, settled only once the loop has drained it.
        late = FakeStream([
            content_chunk("ok"),
            content_chunk(" still going"),
            finish_chunk("length"),
        ])
        list(late)
        assert saw_finish_reason(late) is True

    def test_the_flag_is_only_settled_once_the_stream_is_drained(self):
        # Reading it before the loop has pulled the finish chunk would answer
        # about the part seen so far, not about the stream.
        stream = FakeStream([content_chunk("x"), finish_chunk("tool_calls")])
        it = iter(stream)
        next(it)
        assert saw_finish_reason(stream) is False
        next(it)
        assert saw_finish_reason(stream) is True


class TestCloseLlmStream:
    def test_none_generator_is_noop(self):
        close_llm_stream(None)

    def test_closes_the_stream_once(self):
        stream = FakeStream([content_chunk("x")])
        close_llm_stream(stream)
        assert stream.close_calls == 1

    def test_swallows_close_errors(self):
        stream = FakeStream([], close_error=RuntimeError("socket already gone"))
        close_llm_stream(stream)
        assert stream.closed

    def test_missing_close_is_noop(self):
        close_llm_stream(iter([]))


class TestSafeGetChoiceContent:
    def test_dict_with_delta_content(self):
        chunk = {"choices": [{"delta": {"content": "hello"}}]}
        assert safe_get_choice_content(chunk) == "hello"

    def test_dict_missing_delta_returns_empty(self):
        chunk = {"choices": [{}]}
        assert safe_get_choice_content(chunk) == ""

    def test_dict_with_no_choices_returns_empty(self):
        chunk = {}
        assert safe_get_choice_content(chunk) == ""

    def test_non_dict_chunk_returns_empty(self):
        assert safe_get_choice_content("string") == ""
        assert safe_get_choice_content(123) == ""

    def test_dict_with_empty_choices_returns_empty(self):
        chunk = {"choices": [], "usage": {"total_tokens": 12}}
        assert safe_get_choice_content(chunk) == ""


class TestExtractUsage:
    def test_dict_chunk_with_full_usage(self):
        chunk = {"usage": {"prompt_tokens": 10, "completion_tokens": 5,
                           "total_tokens": 15}}
        assert _extract_usage(chunk) == {
            "prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15,
        }

    def test_missing_fields_are_none(self):
        chunk = {"usage": {"completion_tokens": 4}}
        assert _extract_usage(chunk) == {
            "prompt_tokens": None, "completion_tokens": 4, "total_tokens": None,
        }

    def test_chunk_without_usage_returns_none(self):
        assert _extract_usage({"choices": [{"delta": {"content": "hi"}}]}) is None

    def test_empty_usage_returns_none(self):
        assert _extract_usage({"usage": {}}) is None

    def test_null_usage_returns_none(self):
        assert _extract_usage({"usage": None}) is None

    def test_non_dict_chunk_returns_none(self):
        assert _extract_usage("not a chunk") is None


class TestChunksAreReadAsMappings:
    """The extractors read the *mapping protocol*, not ``isinstance(chunk, dict)``.

    The attribute branch (``chunk.choices[0].delta.content``) is gone for good
    (D2). What stays is a ``.get`` read, which a plain chunk dict and a non-dict
    chunk object that answers ``.get`` both satisfy — so the loop reads a chunk
    the same way whatever produced it. That is what a dict-only guard would
    break: a chunk carrying its fields through ``.get`` alone would read as
    empty and hand the caller an answer that ends on a tidy ``done``, which is
    the lie the truncation rules exist to prevent — pinned here by the non-dict
    stub below, since a dict-only read passes every dict-feeding test in this
    file.
    """

    class MappingChunk:
        """Not a dict, but answers ``.get`` with the same fields."""

        def __init__(self, fields):
            self._fields = fields

        def get(self, name, default=None):
            return self._fields.get(name, default)

    class AttributeChunk:
        """The deleted shape: attributes only, no mapping protocol."""

        def __init__(self):
            delta = SimpleNamespace(content="world", reasoning_content="thinking")
            self.choices = [SimpleNamespace(delta=delta)]
            self.usage = None

    def test_a_non_dict_mapping_chunk_is_still_read(self):
        chunk = self.MappingChunk({"choices": [{"delta": {"content": "hi"}}]})
        assert safe_get_choice_content(chunk) == "hi"
        # The usage block is a nested object of its own, not a dict, exactly as
        # a server's nested block arrives: the read is a ``.get``, not a type.
        usage = self.MappingChunk(
            {"usage": self.MappingChunk({"total_tokens": 9, "prompt_tokens": 4})})
        assert _extract_usage(usage) == {
            "prompt_tokens": 4, "completion_tokens": None, "total_tokens": 9,
        }
        reasoning = self.MappingChunk(
            {"choices": [{"delta": {"reasoning_content": "deep"}}]}
        )
        assert _extract_reasoning(reasoning) == "deep"

    def test_the_attribute_branch_is_gone(self):
        # Attributes without a mapping protocol read as absent: no code path
        # reaches chunk.choices[0].delta.content any more.
        chunk = self.AttributeChunk()
        assert safe_get_choice_content(chunk) == ""
        assert _extract_usage(chunk) is None
        assert _extract_reasoning(chunk) == ""
