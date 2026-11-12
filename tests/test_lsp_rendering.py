"""The pure rendering/config-answer helpers of lsphub.

Split from test_lsp.py because these are unit tests over fixtures: no
language server process, no asyncio loop, no policy. They cover the three
bugs that made the css/html tools lie:

* ``apply_whole_line_edits`` re-emitted the last line when a format edit
  ended past it (``</html></html>`` in the diff), and fabricated a newline
  when an edit started past it.
* ``workspace/configuration`` answered ``null`` for the language-settings
  sections, which makes ``vscode-css-languageservice`` throw inside its
  validator and publish NO diagnostics at all.
* ``language_id_for_suffix`` knew no ``.css``/``.html``, so those documents
  were opened as ``plaintext`` — and the html server skips validation
  entirely for anything that is not ``html``.
"""

from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List

import pytest
from lsprotocol import types as lsp

from src.core.lsphub import register_features
from src.core.lsphub.rendering import (
    apply_whole_line_edits,
    language_id_for_suffix,
    render_formatting,
)


def edit(start_line: int, start_char: int, end_line: int, end_char: int, new_text: str):
    return lsp.TextEdit(
        range=lsp.Range(
            start=lsp.Position(line=start_line, character=start_char),
            end=lsp.Position(line=end_line, character=end_char),
        ),
        new_text=new_text,
    )


class TestApplyWholeLineEdits:
    def test_whole_document_edit_ending_past_the_last_line(self):
        # What prettier/vscode-css-languageservice actually send: one edit
        # covering every line, ending at (line_count, 0). Clamping the end to
        # the last line used to re-emit that line, so the proposed content
        # ended with a duplicate of it.
        assert apply_whole_line_edits("a\nb\n", [edit(0, 0, 2, 0, "X\nY\n")]) == "X\nY\n"

    def test_whole_document_edit_on_text_without_trailing_newline(self):
        assert apply_whole_line_edits("a\nb", [edit(0, 0, 2, 0, "X\nY\n")]) == "X\nY\n"

    def test_edit_starting_past_the_last_line_adds_no_newline(self):
        # An insertion at (1, 0) of "a\n" is an append, not an append of a
        # blank line: the old code padded the line list to reach that line.
        assert apply_whole_line_edits("a\n", [edit(1, 0, 1, 0, "b\n")]) == "a\nb\n"

    def test_edit_into_an_empty_document(self):
        assert apply_whole_line_edits("", [edit(0, 0, 0, 0, "x\n")]) == "x\n"

    def test_mid_document_edit_is_unchanged(self):
        assert apply_whole_line_edits("a\nb\nc\n", [edit(1, 0, 2, 0, "B\n")]) == "a\nB\nc\n"

    def test_range_ending_mid_line(self):
        assert apply_whole_line_edits("a\nb\nc\n", [edit(0, 1, 1, 1, "ZZ")]) == "aZZ\nc\n"

    def test_deletion(self):
        assert apply_whole_line_edits("a\nb\nc\n", [edit(1, 0, 2, 0, "")]) == "a\nc\n"

    def test_several_edits_apply_bottom_up(self):
        edits = [edit(0, 0, 1, 0, "A\n"), edit(1, 0, 2, 0, "B\n")]
        assert apply_whole_line_edits("a\nb\nc\n", edits) == "A\nB\nc\n"

    def test_character_past_the_end_of_a_line_clamps_to_the_line(self):
        # A character beyond the line's length must not index into the next
        # one; the range then runs to the end of line 1.
        assert apply_whole_line_edits("ab\ncd\n", [edit(0, 99, 1, 99, "Z")]) == "ab\nZ"

    def test_reversed_edit_order_still_applies(self):
        forward = [edit(1, 0, 2, 0, "B\n"), edit(0, 0, 1, 0, "A\n")]
        assert apply_whole_line_edits("a\nb\nc\n", forward) == "A\nB\nc\n"


class TestRenderFormatting:
    def test_diff_does_not_duplicate_the_last_line(self):
        # A whole-document edit that ends at (3, 0) on a three-line file.
        # Before the fix the proposed content was "A\nB\n</html>\n</html>\n":
        # the diff showed a closing tag the file never had.
        edits = [edit(0, 0, 3, 0, "A\nB\n</html>\n")]
        rendered = render_formatting("p.html", "a\nb\n</html>\n", edits)
        assert rendered.count("</html>") == 1
        assert "+</html>" not in rendered
        assert "+A" in rendered and "+B" in rendered

    def test_no_edits_is_reported_as_already_formatted(self):
        assert render_formatting("p.css", "a {}\n", []) == (
            "Already formatted (no edits proposed)."
        )

    def test_edits_that_change_nothing_are_reported_as_such(self):
        edits = [edit(0, 0, 1, 0, "a\n")]
        assert render_formatting("p.css", "a\n", edits) == (
            "Already formatted (no visible change)."
        )


class TestLanguageIdForSuffix:
    @pytest.mark.parametrize(
        "suffix, expected",
        [
            (".css", "css"),
            (".CSS", "css"),
            (".scss", "scss"),
            (".sass", "sass"),
            (".less", "less"),
            (".html", "html"),
            (".htm", "html"),
            (".ts", "typescript"),
            (".tsx", "typescriptreact"),
            (".js", "javascript"),
            (".json", "json"),
            (".vue", "vue"),
            (".py", "python"),
            (".rs", "rust"),
            (".txt", ""),
        ],
    )
    def test_suffix_maps_to_the_language_the_server_expects(self, suffix, expected):
        # The html server validates only documents whose languageId is
        # 'html', and the css server logs 'Document type is plaintext, using
        # css instead' for anything else, so an unmapped suffix silently
        # degrades the document.
        assert language_id_for_suffix(suffix) == expected


def _configuration_handler(info: Dict[str, Any]):
    """The hub's workspace/configuration handler, bound to a stub client."""
    captured: Dict[str, Any] = {}

    class StubClient:
        def feature(self, method: str):
            def decorator(func):
                captured[method] = func
                return func

            return decorator

    register_features(
        StubClient(),
        {"id": "stub", "workspaceRoot": "/tmp", **info},
        Path("/tmp/stub.log"),
        {},
        lambda path, line: None,
        lambda session, file_name: None,
    )
    return captured["workspace/configuration"]


def _ask(handler, sections: List[str]) -> List[Any]:
    params = SimpleNamespace(items=[{"section": s} for s in sections])
    return handler(params)


class TestWorkspaceConfigurationAnswers:
    def test_language_settings_sections_answer_an_object(self):
        # vscode-css-languageservice does
        # ``new LintConfigurationSettings(settings && settings.lint)`` and
        # that constructor's ``conf = {}`` default fires only for undefined:
        # a null answer reaches ``this.conf[setting.id]`` and throws
        # "Cannot read properties of null (reading 'validProperties')", which
        # the css server swallows while publishing no diagnostics at all.
        handler = _configuration_handler({"settings": {}})
        answers = _ask(handler, ["css", "scss", "sass", "less", "html", "javascript", "json"])
        assert answers == [{} for _ in answers]

    def test_js_ts_section_answers_null_not_an_object(self):
        # The html server's embedded-JS mode reads
        # ``settings?.['js/ts']?.implicitProjectConfig.strictNullChecks``: the
        # ``['js/ts']`` lookup is guarded but the ``.implicitProjectConfig``
        # deref is not, so a truthy ``{}`` survives the guards and then
        # ``undefined.strictNullChecks`` throws, killing validation for the
        # whole document (no diagnostics published at all). ``null``
        # short-circuits the chain instead.
        handler = _configuration_handler({"settings": {}})
        assert _ask(handler, ["js/ts"]) == [None]

    def test_declared_js_ts_settings_still_win(self):
        # An explicit settings block is the user's own answer, so it is
        # returned verbatim even for a section that defaults to null.
        handler = _configuration_handler(
            {"settings": {"js/ts": {"implicitProjectConfig": {"strictNullChecks": True}}}}
        )
        assert _ask(handler, ["js/ts"]) == [
            {"implicitProjectConfig": {"strictNullChecks": True}}
        ]

    def test_dotted_sections_still_answer_null(self):
        # Volar does ``getConfiguration('html.customData') ?? []`` and then
        # iterates the answer: {} is not nullish and not iterable, so it must
        # stay null (this is the crash test_configuration_answers_are_null_not
        # _empty_objects guards in test_lsp.py).
        handler = _configuration_handler({"settings": {}})
        assert _ask(handler, ["html.customData", "fake", ""]) == [None, None, None]

    def test_declared_settings_win_over_the_object_default(self):
        handler = _configuration_handler({"settings": {"css": {"validate": False}}})
        assert _ask(handler, ["css", "html"]) == [{"validate": False}, {}]

    def test_items_may_be_objects_or_namespaces(self):
        handler = _configuration_handler({"settings": {}})
        params = SimpleNamespace(items=[SimpleNamespace(section="css")])
        assert handler(params) == [{}]
