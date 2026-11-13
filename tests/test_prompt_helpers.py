"""appdb-07 — ``core/prompt_helpers.py``: the table's read and write side.

The module keeps its name and its contract, and its **file half is gone**: there
is no path, no seeder, no document formatter, no ``SLOT_COUNT`` and no
"exactly nine" error type. What is asserted here is therefore mostly the
deletion — the count rule replaced by add/delete — plus the two constants the
routes still validate against, which are the module's own and not the store's.

Every case runs on the suite's temporary database (``tests/conftest.py``,
appdb-04), which the autouse fixture has already created and seeded, so a test
starts where a first boot leaves the app: nine empty gray rows. Nothing here
opens a file, and nothing here needs a working location — the rows are
install-scoped (D11), which is the other thing the last class pins.
"""

import os
from pathlib import Path
from typing import List

import pytest

from src.core import appdb, editorfs, prompt_helpers
from tests.conftest import store_guard_root


def ids(rows: List[dict]) -> List[int]:
    return [row["id"] for row in rows]


@pytest.fixture
def store_root(tmp_path: Path) -> Path:
    """The temporary install root this test's store lives at (conftest, appdb-04)."""
    return store_guard_root(tmp_path)


@pytest.fixture
def backup_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The app's dated backup folder, moved into this test's scratch tree.

    The same redirect ``tests/test_editorfs_write.py`` makes: the folder is
    install-scoped, so a suite that leaves copies in it would be writing into the
    developer's tree.
    """
    folder = tmp_path / "editor_backups"
    monkeypatch.setattr(editorfs.constants, "BACKUP_DIR", folder)
    return folder


class TestTheModuleIsTheTableHalf:
    """The file half is deleted, **not relaxed** (§4.5)."""

    GONE = (
        "SLOT_COUNT",
        "PROMPT_HELPERS_FILENAME",
        "PROMPT_HELPERS_VERSION",
        "PromptHelpersFileError",
        "prompt_helpers_file_path",
        "prompt_helpers_path",
        "prompt_helpers_file_state",
        "default_prompt_helpers",
        "default_prompt_helpers_text",
        "ensure_prompt_helpers_file",
        "LEGACY_PROMPT_HELPERS_PATH",
        "_write_prompt_helpers",
        "_document_text",
        "_normalize_slot",
        "_self_check",
    )

    def test_no_path_helper_no_seeder_no_document_formatter_survives(self):
        assert [name for name in self.GONE if hasattr(prompt_helpers, name)] == []

    def test_the_module_names_no_path_at_all(self):
        """It asks ``appdb`` for data and never names a file (§4.1)."""
        source = Path(prompt_helpers.__file__).read_text(encoding="utf-8")
        for marker in ("open(", "Path(", "os.path", "json.load", "write_text"):
            assert marker not in source, marker

    def test_the_failure_it_raises_is_the_stores_own(self):
        """An alias, not a second type: a route catching anything else would be
        catching a type this module cannot produce."""
        assert prompt_helpers.AppStoreError is appdb.AppStoreError

    def test_the_constants_the_routes_validate_against_are_still_here(self):
        assert prompt_helpers.COLOR_RE.match("#2ec27e")
        assert not prompt_helpers.COLOR_RE.match("green")
        assert prompt_helpers.CONTENT_MAX_CHARS == 32000
        assert prompt_helpers.DEFAULT_COLOR == "#808080"


class TestTheRead:
    def test_a_first_boot_reads_the_nine_seeded_rows(self):
        rows = prompt_helpers.load_prompt_helpers()

        assert len(rows) == 9
        assert all(row["color"] == "#808080" for row in rows)
        assert all(row["content"] == "" for row in rows)
        assert ids(rows) == list(range(1, 10))

    def test_the_payload_carries_the_rows_and_the_caps(self):
        """No cap is spelled in the client, so the read has to hand it over."""
        body = prompt_helpers.payload()

        assert set(body) == {"slots", "caps"}
        assert body["slots"] == prompt_helpers.load_prompt_helpers()
        assert body["caps"] == {
            "contentMaxChars": prompt_helpers.CONTENT_MAX_CHARS,
            "defaultColor": prompt_helpers.DEFAULT_COLOR,
        }

    def test_an_unusable_store_is_a_named_state_never_nine_empty_bullets(
        self, store_root: Path
    ):
        """The rule the file reader held for its file, now over the database.

        The store here is the suite's own temporary one and it is **already**
        valid, so the damage has to be planted rather than assumed: the bytes are
        replaced with something that is not a database, and this thread's handle
        — opened at the good file — is dropped, because a handle is a handle on
        bytes that are still there.
        """
        target = store_root / "nojae.db"
        target.write_bytes(b"not a database at all")
        appdb.close_thread_connection()

        with pytest.raises(prompt_helpers.AppStoreError) as caught:
            prompt_helpers.load_prompt_helpers()
        assert str(target) in str(caught.value)
        with pytest.raises(prompt_helpers.AppStoreError):
            prompt_helpers.add_prompt_helper("#ff0000", "x")
        with pytest.raises(prompt_helpers.AppStoreError):
            prompt_helpers.delete_prompt_helper(1)


class TestAddAndDelete:
    """The count rule's replacement: a row is a bullet, the count is the count."""

    def test_add_appends_one_row_and_answers_the_whole_list(self):
        rows = prompt_helpers.add_prompt_helper("#ff0000", "Refactor this file.")

        assert len(rows) == 10
        assert rows[-1] == {
            "id": 10,
            "color": "#ff0000",
            "content": "Refactor this file.",
        }
        assert prompt_helpers.load_prompt_helpers() == rows

    def test_add_never_fills_a_blank_row(self):
        """Eight of the nine seeded rows are empty, and an add still adds.

        This is the difference between "add" and the file's "save a slot": with
        no slot to aim at, the user's ninth bullet is a **new** row even though
        blanks sit beside it.
        """
        before = len(prompt_helpers.load_prompt_helpers())

        rows = prompt_helpers.add_prompt_helper("#00ff00", "x")

        assert len(rows) == before + 1

    def test_the_count_is_the_users_business_at_every_number_including_zero(
        self,
    ):
        """§4.5: the "exactly nine or an error" check is deleted, not relaxed."""
        for row in list(prompt_helpers.load_prompt_helpers()):
            prompt_helpers.delete_prompt_helper(row["id"])
        assert prompt_helpers.load_prompt_helpers() == []

        prompt_helpers.add_prompt_helper("#123456", "one")
        prompt_helpers.add_prompt_helper("#123456", "two")
        assert [row["content"] for row in prompt_helpers.load_prompt_helpers()] == [
            "one",
            "two",
        ]

    def test_delete_removes_one_row_and_leaves_the_others(self):
        rows = prompt_helpers.delete_prompt_helper(3)

        assert rows is not None
        assert 3 not in ids(rows)
        assert len(rows) == 8
        assert prompt_helpers.load_prompt_helpers() == rows

    def test_deleting_every_row_is_an_answer_not_an_error(self):
        for row in list(prompt_helpers.load_prompt_helpers()):
            prompt_helpers.delete_prompt_helper(row["id"])

        assert prompt_helpers.load_prompt_helpers() == []
        assert prompt_helpers.payload()["slots"] == []

    def test_a_write_that_addresses_no_row_answers_none(self):
        """The browser was holding an older list; the route turns that into a 404."""
        assert prompt_helpers.delete_prompt_helper(999) is None
        assert prompt_helpers.save_prompt_helper(999, "#ff0000", "x") is None
        assert len(prompt_helpers.load_prompt_helpers()) == 9

    def test_a_deleted_id_is_never_reused_by_an_add(self):
        """The id is the handle the browser holds, so a recycled id would edit
        the wrong bullet on a tab that has not re-read the list."""
        gone = prompt_helpers.load_prompt_helpers()[0]["id"]
        prompt_helpers.delete_prompt_helper(gone)

        rows = prompt_helpers.add_prompt_helper("#ff0000", "new")

        assert gone not in ids(rows)


class TestTheUpdate:
    def test_save_rewrites_one_row_and_answers_the_whole_list(self):
        rows = prompt_helpers.save_prompt_helper(2, "#0000ff", "hello")

        assert rows is not None
        assert rows[1] == {"id": 2, "color": "#0000ff", "content": "hello"}
        assert prompt_helpers.load_prompt_helpers() == rows

    def test_empty_content_clears_the_bullet_and_keeps_its_color(self):
        prompt_helpers.save_prompt_helper(2, "#00ff00", "y")

        rows = prompt_helpers.save_prompt_helper(2, "#00ff00", "")

        assert rows is not None
        assert rows[1] == {"id": 2, "color": "#00ff00", "content": ""}

    def test_saving_a_row_back_unchanged_is_still_a_save(self):
        """The row exists, so the write landed — "nothing changed" is not "no row".

        Worth pinning because the answer distinguishes the two by the statement's
        row count: a database that reported 0 for a write of identical values
        would make the route answer 404 about a bullet that is sitting there.
        """
        first = prompt_helpers.save_prompt_helper(2, "#00ff00", "same")

        again = prompt_helpers.save_prompt_helper(2, "#00ff00", "same")

        assert again is not None
        assert again == first


class TestTheBackupBeforeADelete:
    """D12: "a save backs up what it replaces", and a DELETE is the one thing a
    user cannot retype."""

    def test_a_delete_copies_the_whole_store_into_the_dated_backup_folder(
        self, backup_dir: Path
    ):
        prompt_helpers.delete_prompt_helper(1)

        chain = sorted(backup_dir.glob("*.orig"))
        assert len(chain) == 1, "the delete kept no copy of the store"
        # The copy is of the **store** — a database file the app made, in the
        # folder and the naming rule every file replacement already uses.
        assert chain[0].read_bytes()[:16].startswith(b"SQLite format 3")
        assert chain[0].name.startswith(
            editorfs.files.backup_key(appdb.database_path())
        )

    def test_the_retention_sweep_applies_to_the_copy(self, backup_dir: Path):
        """Reusing the helper means reusing its sweep, so the copy expires."""
        prompt_helpers.delete_prompt_helper(1)
        copy = next(iter(backup_dir.glob("*.orig")))
        # Backdate it past the window the app itself declares, then delete again:
        # the second delete's sweep is what removes the first copy.
        stale = copy.stat().st_mtime - (editorfs.constants.BACKUP_PRUNE_DAYS + 1) * 86400
        os.utime(copy, (stale, stale))

        prompt_helpers.delete_prompt_helper(2)

        assert copy.exists() is False
        assert len(list(backup_dir.glob("*.orig"))) == 1

    def test_an_update_takes_no_copy(self, backup_dir: Path):
        """The row it replaces is a field the user can retype."""
        prompt_helpers.save_prompt_helper(1, "#ff0000", "edited")
        prompt_helpers.add_prompt_helper("#ff0000", "added")

        assert not backup_dir.exists()

    def test_a_delete_of_no_row_takes_no_copy(self, backup_dir: Path):
        """Nothing was destroyed, so there is nothing to keep."""
        assert prompt_helpers.delete_prompt_helper(999) is None

        assert not backup_dir.exists()


class TestTheStoreIsNotTheWorkspace:
    """D11: a bullet is a habit of the user, so a switch changes nothing here."""

    def test_the_rows_survive_a_working_location_switch(self, monkeypatch):
        prompt_helpers.save_prompt_helper(1, "#ff0000", "mine")

        monkeypatch.setenv("NOJAE_PATH_LOCATION", "/somewhere/else")

        assert prompt_helpers.load_prompt_helpers()[0]["content"] == "mine"

    def test_nothing_in_the_module_reads_the_working_location(self):
        source = Path(prompt_helpers.__file__).read_text(encoding="utf-8")
        assert "path_location" not in source
        assert "POLICY_DIRNAME" not in source
