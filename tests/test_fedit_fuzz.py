"""Fuzz semantics of the fedit diff engine.

``fuzz`` lets a hunk whose *context* moved still apply: the engine trims edge
context lines and searches for what is left. The bug these tests pin is that
the trimmed edges were trimmed from the **match** only, never from the
**replacement** -- so the hunk's full new body was written over the shorter
matched span, re-inserting the ignored context as new text. The result was a
silently corrupt file: a duplicated trailing context line, and (because the
body was written at the trimmed start) text the file never had.

The contract is GNU patch's: an ignored context line is left **untouched** in
the file, and only context lines may be ignored -- never a ``-``/``+`` line,
which is the change itself.
"""
from typing import List, Optional

import pytest

from mcp_connectors import fedit_mcp as f


@pytest.fixture(autouse=True)
def _backups_go_to_tmp(tmp_path, monkeypatch):
    """Keep the one ``apply_edit`` test's backups out of the developer's tree."""
    monkeypatch.setattr(f, "BACKUP_DIR", tmp_path / "fedit-backups")


def apply(before: str, diff: str, fuzz: Optional[int] = 1) -> str:
    after, _warnings = f.apply_diff_to_text(before, diff, fuzz=fuzz)
    return after


SRC = "def f():\n    x = 1\n    return x\n\ndef g():\n    y = 2\n    return y\n"


def hunk(old_start: int, body: List[str]) -> str:
    """A one-hunk diff whose declared context is ``body``."""
    return "--- a/t.py\n+++ b/t.py\n@@ -{},{} +1,1 @@\n".format(
        old_start, len(body)
    ) + "\n".join(body) + "\n"


class TestTrimmedContextIsLeftAlone:
    def test_stale_leading_context_is_not_written_into_the_file(self):
        """The reported bug: a wrong context line must not replace real code."""
        diff = hunk(5, [" STALE CONTEXT LINE", "-    y = 2", "+    y = 99",
                        "     return y"])
        after = apply(SRC, diff, fuzz=1)

        assert "STALE CONTEXT LINE" not in after
        assert "def g():" in after
        assert "y = 99" in after

    def test_ignored_context_is_not_duplicated(self):
        """The other half: the trailing context must appear exactly once."""
        diff = hunk(5, [" STALE CONTEXT LINE", "-    y = 2", "+    y = 99",
                        "     return y"])
        after = apply(SRC, diff, fuzz=1)

        assert after.count("    return y") == 1

    def test_the_untouched_line_keeps_its_own_bytes(self):
        """An ignored edge line is left alone, not restated from the hunk.

        Only the *edge* is ignored, so the trim has to reach a line the hunk
        got wrong; here the leading context is, and the file's own line stays.
        """
        diff = hunk(5, [" STALE", " def g():", "-    y = 2", "+    y = 99"])
        assert apply(SRC, diff, fuzz=1) == SRC.replace("    y = 2", "    y = 99")


class TestFuzzStillRepositions:
    def test_a_hunk_that_only_moved_still_applies(self):
        """The legitimate use of fuzz: same context, different line."""
        before = "pad\npad\n" + SRC
        diff = hunk(5, [" def g():", "-    y = 2", "+    y = 99", "     return y"])
        after = apply(before, diff, fuzz=2)

        assert "y = 99" in after
        assert after.count("def g():") == 1

    def test_the_move_is_reported(self):
        before = "pad\npad\n" + SRC
        diff = hunk(5, [" def g():", "-    y = 2", "+    y = 99", "     return y"])
        _after, warnings = f.apply_diff_to_text(before, diff, fuzz=2)

        assert any("applied at line" in w for w in warnings)

    def test_exact_match_needs_no_warning(self):
        diff = hunk(5, [" def g():", "-    y = 2", "+    y = 99", "     return y"])
        _after, warnings = f.apply_diff_to_text(SRC, diff, fuzz=2)

        assert not any("applied at line" in w for w in warnings)


class TestOnlyContextMayBeIgnored:
    def test_a_removed_line_is_never_trimmed_away(self):
        """Trimming past a '-' line would drop part of the change.

        With no context at either edge there is nothing fuzz may ignore, so a
        large fuzz must not turn this into a hunk that lands anywhere.
        """
        diff = hunk(5, ["-    y = 2", "+    y = 99"])
        assert apply(SRC, diff, fuzz=3) == SRC.replace("    y = 2", "    y = 99")

    def test_a_hunk_with_a_wrong_body_is_refused_not_guessed(self):
        """With no matching context anywhere, fuzz must not invent a landing."""
        diff = hunk(5, [" NOT IN FILE", "- also not in file", "+ nope"])
        with pytest.raises(f.FeditError):
            apply(SRC, diff, fuzz=3)


class TestFuzzDisabled:
    def test_fuzz_zero_applies_only_where_declared(self):
        """The documented contract: 0 disables repositioning entirely."""
        before = "pad\n" + SRC
        # The context is real, but one line below where the hunk declares it:
        # fuzz=0 must refuse rather than search the file and jump there.
        diff = hunk(5, [" def g():", "-    y = 2", "+    y = 99", "     return y"])
        with pytest.raises(f.FeditError):
            apply(before, diff, fuzz=0)

    def test_the_same_hunk_applies_once_fuzz_is_allowed(self):
        before = "pad\n" + SRC
        diff = hunk(5, [" def g():", "-    y = 2", "+    y = 99", "     return y"])
        assert "y = 99" in apply(before, diff, fuzz=1)


class TestSearchReplaceUnaffected:
    def test_the_ordinary_edit_path_is_unchanged(self, tmp_path):
        """The fix lives in the diff engine; SEARCH/REPLACE must not shift."""
        target = tmp_path / "t.py"
        target.write_text(SRC, encoding="utf-8")

        f.apply_edit(str(target),
                     "<<<<<<< SEARCH\n    y = 2\n=======\n    y = 99\n>>>>>>> REPLACE",
                     format="search_replace")

        after = target.read_text(encoding="utf-8")
        assert "y = 99" in after and "y = 2" not in after
        assert after.count("    return y") == 1
