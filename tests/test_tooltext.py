"""Tests for the text-written tool-call recogniser (``core/tooltext``)."""

import pytest

from src.core.tooltext import (
    TextToolCallFilter,
    _MAX_BLOCK_LEN,
    find_text_tool_calls,
)


class TestTheGrammars:
    def test_the_hermes_json_wrapper(self):
        # The spelling the reported engine produced: a JSON body in a wrapper.
        text = (
            "<tool_call>\n"
            '{"name": "read_files", "arguments": {"path": "AGENTS.md"}}\n'
            "</tool_call>"
        )
        assert find_text_tool_calls(text) == [
            {"name": "read_files", "arguments": '{"path": "AGENTS.md"}'}
        ]

    def test_a_wrapper_holding_a_list_of_calls(self):
        text = (
            "<tool_call>"
            '[{"name": "a", "arguments": {}}, {"name": "b", "arguments": {}}]'
            "</tool_call>"
        )
        assert [call["name"] for call in find_text_tool_calls(text)] == ["a", "b"]

    def test_the_attribute_style_function_tags(self):
        # The second shape seen against the live engine: no JSON, one tag per
        # argument.
        text = (
            "<tool_call>\n<function=read_file>\n<parameter=path>\nAGENTS.md\n"
            "</parameter>\n</function>\n</tool_call>"
        )
        assert find_text_tool_calls(text) == [
            {"name": "read_file", "arguments": '{"path": "AGENTS.md"}'}
        ]

    def test_the_namespaced_invoke_tags(self):
        text = (
            '<antml:invoke name="read_file">\n'
            "<parameter=path>AGENTS.md</parameter>\n"
            "</antml:invoke>"
        )
        assert find_text_tool_calls(text) == [
            {"name": "read_file", "arguments": '{"path": "AGENTS.md"}'}
        ]

    def test_a_quoted_attribute_name_is_unquoted(self):
        text = "<function name='read_file'><parameter name='path'>x</parameter></function>"
        assert find_text_tool_calls(text) == [
            {"name": "read_file", "arguments": '{"path": "x"}'}
        ]

    def test_arguments_written_as_json_inside_the_tags_pass_through(self):
        text = '<function=read_file>{"path": "x"}</function>'
        assert find_text_tool_calls(text) == [
            {"name": "read_file", "arguments": '{"path": "x"}'}
        ]

    def test_both_spellings_in_one_text_keep_their_order(self):
        text = (
            "<tool_call>\n<function=a><parameter=p>1</parameter></function>\n"
            "</tool_call>\n"
            '<antml:invoke name="b"><parameter=q>2</parameter></antml:invoke>'
        )
        assert [call["name"] for call in find_text_tool_calls(text)] == ["a", "b"]


class TestWhatIsNotACall:
    @pytest.mark.parametrize(
        "text",
        [
            "plain prose with no markup",
            "if a < b and 3 < 4, that is arithmetic",
            "a < b, then c > d",
            "the <tool_call tag was never closed",
            "",
        ],
    )
    def test_prose_is_left_alone(self, text):
        assert find_text_tool_calls(text) == []

    def test_a_wrapper_with_no_usable_name_yields_nothing(self):
        assert find_text_tool_calls("<tool_call>{bad json}</tool_call>") == []
        assert find_text_tool_calls('<tool_call>{"arguments": {}}</tool_call>') == []


class TestTheStreamingFilter:
    def _stream(self, pieces):
        filter_ = TextToolCallFilter()
        shown = "".join(filter_.feed(piece) for piece in pieces)
        return shown, filter_.flush(), filter_.calls

    def test_a_block_split_across_chunks_is_never_painted(self):
        shown, _, calls = self._stream(
            [
                "Reading ",
                "<tool_ca",
                'll>\n{"name": "read_files", ',
                '"arguments": {}}',
                "</tool_call>",
                " done",
            ]
        )
        assert shown == "Reading  done"
        assert calls == [{"name": "read_files", "arguments": "{}"}]

    def test_benign_text_streams_with_no_hold_back(self):
        # Nothing is held once a `<` is known not to open a block, so the
        # panel is never delayed by ordinary prose.
        filter_ = TextToolCallFilter()
        assert filter_.feed("if a < b then c") == "if a < b then c"
        assert filter_.feed(" and d < e") == " and d < e"

    def test_an_unresolved_opener_is_held_until_it_resolves(self):
        filter_ = TextToolCallFilter()
        assert filter_.feed("see <tool") == "see "
        # Proven prose: the rest is released on the next feed.
        assert filter_.feed("_caller soon") == "<tool_call" + "er soon"

    def test_an_unterminated_opener_is_released_by_flush(self):
        shown, flushed, calls = self._stream(["see <tool_call soon"])
        assert shown + flushed == "see <tool_call soon"
        assert calls == []

    def test_an_overlong_opener_is_declared_prose(self):
        # The bound exists so one stray opener cannot freeze the answer: past
        # it, the text is released and streaming resumes.
        filter_ = TextToolCallFilter()
        head = filter_.feed("<tool_call " + "x" * (_MAX_BLOCK_LEN + 10))
        assert len(head) >= 10
        assert filter_.flush()

    def test_calls_accumulate_across_the_stream(self):
        filter_ = TextToolCallFilter()
        filter_.feed('<tool_call>{"name": "a", "arguments": {}}</tool_call>')
        filter_.feed('<tool_call>{"name": "b", "arguments": {}}</tool_call>')
        assert [call["name"] for call in filter_.calls] == ["a", "b"]
