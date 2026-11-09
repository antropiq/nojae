"""The Editor pane's language-server surface: table, answers, hub, route.

Covers the editor's action table and its structured answers, the optional text
argument ``sync_document`` gained, the hub's editor entry point and
``POST /api/lsp/query`` — the last two driven against
``tests/fake_langserver.py`` exactly as ``tests/test_lsp.py`` drives
``call_tool_sync``, so there is one way to stand a hub up.

Hermetic: the working location is the test's own ``tmp_path``, the declaration
file is patched through ``lsphub.constants``, and nothing here reads the
developer's ``.nojae/lsp-settings.json`` or a real model connection.

The invariant this file exists for: **a file no server claims is a quiet
answer, never an error** (spec §4.10). Every "nothing to answer" case below is
``server: null`` with a one-line reason — never a raise, never a 500 — because
the gesture has to fall through to whatever Monaco would have done on its own.
"""

import asyncio
import json
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Dict, List, Optional

import pytest
from fastapi.testclient import TestClient
from lsprotocol import types as lsp
from pygls import uris

from src.core.editorfs import policy_file
from src.core.editorfs.policy import WorkspacePathError, resolve_in_workspace
from src.core.lsphub import (
    EDITOR_ACTIONS,
    DocumentStore,
    LspManager,
    hover_answer,
    location_answer,
    references_answer,
    supports_action,
    sync_document,
)
from src.core.lsphub.constants import MAX_DOCUMENT_BYTES

# The hub-level rows stand a hub up exactly the way ``tests/test_lsp.py`` does:
# its entry builder, its declaration helper and its bridge helper, imported
# rather than copied. Only the ``hub`` fixture itself is re-declared, because
# pytest resolves a fixture in the module that uses it — a second *shape* of
# hub is what this import exists to prevent.
from tests.test_lsp import (
    FAKE_SERVER,
    _declare,
    _entry,
    _fake_server_entry,
    _servers_doc,
    _start,
)

WORKSPACE = Path("/tmp/nojae-editor-workspace")


def _uri(relative: str) -> str:
    return uris.from_fs_path(str(WORKSPACE / relative)) or ""


def _range(
    line: int,
    character: int,
    end_line: Optional[int] = None,
    end_character: Optional[int] = None,
) -> lsp.Range:
    return lsp.Range(
        start=lsp.Position(line=line, character=character),
        end=lsp.Position(
            line=line if end_line is None else end_line,
            character=character if end_character is None else end_character,
        ),
    )


def _location(relative: str, line: int, character: int) -> lsp.Location:
    return lsp.Location(uri=_uri(relative), range=_range(line, character))


class TestEditorActions:
    def test_holds_exactly_the_four_editor_actions(self):
        assert set(EDITOR_ACTIONS) == {"status", "definition", "hover", "references"}

    def test_every_entry_names_its_method_capability_and_position_need(self):
        for action, spec in EDITOR_ACTIONS.items():
            assert set(spec) == {"method", "capability", "needs_position"}, action
            assert isinstance(spec["needs_position"], bool), action

    def test_status_is_answered_by_the_hub_not_by_a_request(self):
        assert EDITOR_ACTIONS["status"]["method"] is None
        assert EDITOR_ACTIONS["status"]["capability"] is None
        assert EDITOR_ACTIONS["status"]["needs_position"] is False

    def test_the_query_actions_map_to_their_lsp_methods(self):
        assert EDITOR_ACTIONS["definition"]["method"] == "textDocument/definition"
        assert EDITOR_ACTIONS["hover"]["method"] == "textDocument/hover"
        assert EDITOR_ACTIONS["references"]["method"] == "textDocument/references"
        for action in ("definition", "hover", "references"):
            assert EDITOR_ACTIONS[action]["needs_position"] is True

    def test_the_editor_table_is_not_the_models_tool_table(self):
        """Adding an action here must never add a tool to a chat turn.

        The two sets overlap and are not the same: ``status`` is the editor's
        alone, and the model gets actions the pane does not need in v1.
        """
        from src.core.lsphub import TOOL_SPECS

        assert set(EDITOR_ACTIONS) != set(TOOL_SPECS)
        assert "status" not in TOOL_SPECS
        assert {"document_symbols", "workspace_symbols", "formatting"} <= set(TOOL_SPECS)
        assert not {"document_symbols", "workspace_symbols", "formatting"} & set(
            EDITOR_ACTIONS
        )


class TestSupportsAction:
    def test_an_advertised_capability_is_supported(self):
        capabilities = lsp.ServerCapabilities(
            hover_provider=True, definition_provider=True, references_provider=True
        )
        for action in ("definition", "hover", "references"):
            assert supports_action(capabilities, action) is True

    def test_absent_false_and_none_all_mean_no(self):
        capabilities = lsp.ServerCapabilities(
            hover_provider=False, definition_provider=None
        )
        assert supports_action(capabilities, "hover") is False
        assert supports_action(capabilities, "definition") is False
        assert supports_action(capabilities, "references") is False

    def test_status_needs_no_capability(self):
        assert supports_action(None, "status") is True
        assert supports_action(lsp.ServerCapabilities(), "status") is True

    def test_an_unknown_action_is_not_supported(self):
        assert supports_action(lsp.ServerCapabilities(hover_provider=True), "rename") is False


class TestLocationAnswer:
    def test_a_location_becomes_path_line_character_zero_based(self):
        answer = location_answer(WORKSPACE, _location("web/src/app.ts", 2, 4))
        assert answer == {"path": "web/src/app.ts", "line": 2, "character": 4}

    def test_a_location_link_uses_its_target_selection_range(self):
        link = lsp.LocationLink(
            target_uri=_uri("web/src/app.ts"),
            target_range=_range(10, 0, 20, 0),
            target_selection_range=_range(12, 3, 12, 8),
        )
        assert location_answer(WORKSPACE, link) == {
            "path": "web/src/app.ts",
            "line": 12,
            "character": 3,
        }

    def test_the_path_is_relative_to_the_working_location_not_the_server_root(self):
        """A server rooted at ``<workspace>/web`` must answer ``web/src/app.ts``."""
        answer = location_answer(WORKSPACE, _location("web/src/app.ts", 0, 0))
        assert answer is not None
        assert answer["path"] == "web/src/app.ts"

    def test_a_list_of_locations_answers_with_the_first(self):
        """A definition response is often a list; a click lands on one place."""
        locations = [_location("a.py", 3, 1), _location("b.py", 4, 2)]
        assert location_answer(WORKSPACE, locations) == {
            "path": "a.py",
            "line": 3,
            "character": 1,
        }
        assert location_answer(WORKSPACE, []) is None

    def test_no_answer_is_none_rather_than_a_throw(self):
        assert location_answer(WORKSPACE, None) is None

    def test_a_shape_carrying_neither_uri_nor_range_is_none(self):
        assert location_answer(WORKSPACE, object()) is None


class TestReferencesAnswer:
    def test_a_list_of_locations_keeps_the_servers_order(self):
        locations = [
            _location("b.py", 5, 1),
            _location("a.py", 1, 0),
            _location("c.py", 9, 7),
        ]
        assert references_answer(WORKSPACE, locations) == [
            {"path": "b.py", "line": 5, "character": 1},
            {"path": "a.py", "line": 1, "character": 0},
            {"path": "c.py", "line": 9, "character": 7},
        ]

    def test_no_references_is_an_empty_list(self):
        assert references_answer(WORKSPACE, None) == []
        assert references_answer(WORKSPACE, []) == []

    def test_a_single_location_is_wrapped_rather_than_dropped(self):
        assert references_answer(WORKSPACE, _location("a.py", 1, 2)) == [
            {"path": "a.py", "line": 1, "character": 2}
        ]


class TestHoverAnswer:
    def test_markup_content_becomes_markdown_plus_a_range(self):
        hover = lsp.Hover(
            contents=lsp.MarkupContent(kind=lsp.MarkupKind.Markdown, value="**doc**"),
            range=_range(1, 2, 1, 5),
        )
        assert hover_answer(hover) == {
            "markdown": "**doc**",
            "range": {
                "start": {"line": 1, "character": 2},
                "end": {"line": 1, "character": 5},
            },
        }

    def test_a_plain_string_is_the_markdown(self):
        assert hover_answer(lsp.Hover(contents="plain text")) == {
            "markdown": "plain text",
            "range": None,
        }

    def test_the_legacy_marked_string_list_is_joined(self):
        hover = lsp.Hover(
            contents=[
                "first",
                lsp.MarkedStringWithLanguage(language="python", value="x = 1"),
            ]
        )
        answer = hover_answer(hover)
        assert answer is not None
        assert answer["markdown"] == "first\nx = 1"

    def test_no_answer_is_none_rather_than_a_throw(self):
        assert hover_answer(None) is None
        assert hover_answer(SimpleNamespace(contents=None)) is None


class _RecordingClient:
    """A pygls client stand-in that records the sync notifications it is sent."""

    def __init__(self) -> None:
        self.opened: List[Any] = []
        self.changed: List[Any] = []
        #: The text of the most recent notification, in arrival order.
        self.last_text: Optional[str] = None

    def text_document_did_open(self, params: Any) -> None:
        self.opened.append(params)
        self.last_text = params.text_document.text

    def text_document_did_change(self, params: Any) -> None:
        self.changed.append(params)
        self.last_text = params.content_changes[0].text


def _session() -> SimpleNamespace:
    """The two attributes ``sync_document`` reads, and nothing else."""
    return SimpleNamespace(
        info={"languageId": "python"},
        client=_RecordingClient(),
        documents=DocumentStore(),
    )


def _synced_text(session: SimpleNamespace) -> Optional[str]:
    """The text the last didOpen/didChange carried."""
    return session.client.last_text


class TestSyncDocumentText:
    """``sync_document(session, path, text=None)`` — one function, both callers."""

    @pytest.mark.anyio
    async def test_absent_text_reads_the_file_as_before(self, tmp_path):
        document = tmp_path / "a.py"
        document.write_text("from disk\n", encoding="utf-8")
        session = _session()
        uri = await sync_document(session, document)
        assert uri == uris.from_fs_path(str(document))
        assert _synced_text(session) == "from disk\n"
        assert len(session.client.opened) == 1
        assert session.client.changed == []

    @pytest.mark.anyio
    async def test_given_text_is_synced_and_the_file_is_not_read(self, tmp_path):
        document = tmp_path / "a.py"
        document.write_text("from disk\n", encoding="utf-8")
        session = _session()
        await sync_document(session, document, text="from the buffer\n")
        assert _synced_text(session) == "from the buffer\n"
        # Nothing here writes: the file still holds what it held.
        assert document.read_text(encoding="utf-8") == "from disk\n"

    @pytest.mark.anyio
    async def test_given_text_wins_over_a_file_that_cannot_be_read(self, tmp_path):
        """A dirty buffer answers even when the file is gone from disk."""
        document = tmp_path / "gone.py"
        session = _session()
        await sync_document(session, document, text="x = 1\n")
        assert _synced_text(session) == "x = 1\n"

    @pytest.mark.anyio
    async def test_an_empty_string_is_a_buffer_not_a_fallback_to_disk(self, tmp_path):
        document = tmp_path / "a.py"
        document.write_text("from disk\n", encoding="utf-8")
        session = _session()
        await sync_document(session, document, text="")
        assert _synced_text(session) == ""

    @pytest.mark.anyio
    async def test_a_second_sync_of_the_same_document_is_a_didChange(self, tmp_path):
        document = tmp_path / "a.py"
        document.write_text("from disk\n", encoding="utf-8")
        session = _session()
        await sync_document(session, document, text="first\n")
        await sync_document(session, document, text="second\n")
        assert len(session.client.opened) == 1
        assert len(session.client.changed) == 1
        assert _synced_text(session) == "second\n"

    @pytest.mark.anyio
    async def test_text_over_the_cap_is_refused_and_nothing_is_synced(self, tmp_path):
        document = tmp_path / "a.py"
        document.write_text("from disk\n", encoding="utf-8")
        session = _session()
        oversized = "x" * (MAX_DOCUMENT_BYTES + 1)
        with pytest.raises(RuntimeError) as refusal:
            await sync_document(session, document, text=oversized)
        assert str(MAX_DOCUMENT_BYTES) in str(refusal.value)
        assert "cap" in str(refusal.value)
        assert session.client.opened == []
        assert session.client.changed == []
        assert session.documents.version(uris.from_fs_path(str(document)) or "") is None


# ---------------------------------------------------------------------------
# The hub entry point, against the fake language server
# ---------------------------------------------------------------------------
#
# The rows below drive ``LspManager.query_editor_sync`` the way
# ``TestLspToolCalls`` drives ``call_tool_sync``: a real hub on its own thread,
# a real stdio child, and the answer read off the returned envelope. Nothing is
# mocked, so what is asserted is what a Ctrl+click would actually get.


@pytest.fixture
async def hub(tmp_path):
    """``LspManager`` with its hub thread up — ``tests/test_lsp.py``'s fixture.

    Re-declared rather than imported because pytest resolves a fixture in the
    module that uses it; the *shape* is the imported one, so there is still one
    way to stand a hub up.
    """
    manager = LspManager([], logs_dir=tmp_path / "logs")
    await manager.start_all()
    try:
        yield manager
    finally:
        await manager.stop_all()


@pytest.fixture
def workspace(tmp_path, monkeypatch):
    """The working location, made the fake server's own ``workspaceRoot``.

    ``_fake_server_entry`` roots its server at ``tmp_path/workspace``, so
    pointing the working location there is what makes a workspace-relative
    answer and a server-relative one the same string — and what lets the
    "outside the server's root" test move the location one level up instead.
    """
    root = tmp_path / "workspace"
    root.mkdir(exist_ok=True)
    monkeypatch.setenv("NOJAE_PATH_LOCATION", str(root))
    policy_file.invalidate_policy_cache()
    yield root
    policy_file.invalidate_policy_cache()


def _write_policy(root: Path, rules: List[Dict[str, Any]]) -> None:
    """Write this workspace's ``.nojae/read-write-policy.json`` and drop the cache."""
    from src.core.editorfs import constants as editorfs_constants

    folder = root / editorfs_constants.POLICY_DIRNAME
    folder.mkdir(parents=True, exist_ok=True)
    (folder / editorfs_constants.POLICY_FILENAME).write_text(
        json.dumps(
            {"version": editorfs_constants.POLICY_VERSION, "policies": rules},
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    policy_file.invalidate_policy_cache()


async def _published_diagnostics(
    hub: LspManager, server_id: str, uri: str, timeout: float = 5.0
) -> Optional[List[Any]]:
    """The diagnostics the fake server last published for ``uri``.

    The fake publishes one diagnostic per line containing ``BUG``, computed
    from the text it was ``didOpen``ed/``didChange``d with — so this *is* the
    server's own record of what it analysed, not a mock of it.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        session = hub._sessions.get(server_id)
        if session is not None:
            entry = session.inbox.peek(uri)
            if entry is not None:
                return entry[1]
        await asyncio.sleep(0.02)
    return None


def _diagnostic_lines(diagnostics: Optional[List[Any]]) -> List[int]:
    return [item.range.start.line for item in diagnostics or []]


class TestEditorDefinitionAnswer:
    @pytest.mark.anyio
    async def test_a_location_comes_back_zero_based_and_workspace_relative(
        self, hub, workspace
    ):
        """The wire is LSP-native: 0-based, and relative to the working location.

        The ``+1`` that turns these into Monaco's coordinates happens once, in
        the browser's ``lib/`` module — never here.
        """
        await _start(hub, _fake_server_entry(workspace.parent))
        (workspace / "a.py").write_text("x = 1\n", encoding="utf-8")

        answer = hub.query_editor_sync(
            "definition", "a.py", position={"line": 0, "character": 0}
        )

        assert answer["status"] == "ok"
        assert answer["server"] == "fake"
        assert answer["reason"] is None
        assert answer["action"] == "definition"
        # The fake answers line 2, character 0 — 0-based, as LSP counts.
        assert answer["result"] == {"path": "a.py", "line": 2, "character": 0}

    @pytest.mark.anyio
    async def test_a_server_rooted_below_the_workspace_still_answers_the_full_path(
        self, hub, tmp_path, monkeypatch
    ):
        """A server rooted at ``<workspace>/web`` must answer ``web/src/app.ts``.

        The browser's buffers are keyed by workspace-relative paths, so a
        server-relative answer would name a file the pane does not have.
        """
        root = tmp_path / "workspace"
        (root / "web" / "src").mkdir(parents=True)
        monkeypatch.setenv("NOJAE_PATH_LOCATION", str(root))
        policy_file.invalidate_policy_cache()
        entry = _fake_server_entry(tmp_path)
        entry["workspaceRoot"] = str(root / "web")
        await _start(hub, entry)
        (root / "web" / "src" / "app.py").write_text("x = 1\n", encoding="utf-8")

        answer = hub.query_editor_sync(
            "definition", "web/src/app.py", position={"line": 0, "character": 0}
        )

        assert answer["status"] == "ok", answer["reason"]
        assert answer["result"]["path"] == "web/src/app.py"


class TestEditorHoverAnswer:
    @pytest.mark.anyio
    async def test_the_markdown_and_the_answering_server_are_both_present(
        self, hub, workspace
    ):
        await _start(hub, _fake_server_entry(workspace.parent))
        (workspace / "a.py").write_text("x = 1\n", encoding="utf-8")

        answer = hub.query_editor_sync(
            "hover", "a.py", position={"line": 0, "character": 0}
        )

        assert answer["status"] == "ok"
        assert answer["server"] == "fake"
        assert answer["result"]["markdown"] == "hover at 0"
        # The range is the ``{start, end}`` shape, both ends 0-based.
        assert answer["result"]["range"] == {
            "start": {"line": 0, "character": 0},
            "end": {"line": 0, "character": 1},
        }


class TestEditorReferencesAnswer:
    @pytest.mark.anyio
    async def test_the_list_keeps_the_servers_order(self, hub, workspace):
        """The fake answers lines 5, 1, 9 — deliberately unsorted.

        Sorting by path or position would be the pane inventing an order the
        server did not give, so the order is asserted as it arrives.
        """
        await _start(hub, _fake_server_entry(workspace.parent))
        (workspace / "a.py").write_text("x = 1\n", encoding="utf-8")

        answer = hub.query_editor_sync(
            "references", "a.py", position={"line": 0, "character": 0}
        )

        assert answer["status"] == "ok"
        assert answer["result"] == [
            {"path": "a.py", "line": 5, "character": 2},
            {"path": "a.py", "line": 1, "character": 0},
            {"path": "a.py", "line": 9, "character": 4},
        ]


class TestEditorQuietAnswers:
    """Every "no server" row: ``server: null`` and a reason, never an error."""

    @pytest.mark.anyio
    async def test_a_path_outside_the_servers_root_answers_no_server(
        self, hub, tmp_path, monkeypatch
    ):
        """The working location is the parent; the server is rooted below it."""
        root = tmp_path / "workspace"
        root.mkdir(exist_ok=True)
        monkeypatch.setenv("NOJAE_PATH_LOCATION", str(tmp_path))
        policy_file.invalidate_policy_cache()
        await _start(hub, _fake_server_entry(tmp_path))
        (tmp_path / "outside.py").write_text("x = 1\n", encoding="utf-8")

        answer = hub.query_editor_sync(
            "definition", "outside.py", position={"line": 0, "character": 0}
        )

        assert answer["status"] == "no_server"
        assert answer["server"] is None
        assert answer["result"] is None
        assert answer["reason"] == "no active language server handles .py"

    @pytest.mark.anyio
    async def test_an_unclaimed_extension_answers_no_server(self, hub, workspace):
        await _start(hub, _fake_server_entry(workspace.parent))
        (workspace / "notes.txt").write_text("hi\n", encoding="utf-8")

        answer = hub.query_editor_sync(
            "definition", "notes.txt", position={"line": 0, "character": 0}
        )

        assert answer["status"] == "no_server"
        assert answer["server"] is None
        assert answer["reason"] == "no active language server handles .txt"

    @pytest.mark.anyio
    async def test_a_server_switched_off_in_the_tools_panel_answers_no_server(
        self, hub, workspace
    ):
        """The allowlist is honoured even though Settings activates the server."""
        await _start(hub, _fake_server_entry(workspace.parent))
        (workspace / "a.py").write_text("x = 1\n", encoding="utf-8")

        answer = hub.query_editor_sync(
            "definition",
            "a.py",
            position={"line": 0, "character": 0},
            allowed_ids=["some-other-server"],
        )

        assert answer["status"] == "no_server"
        assert answer["server"] is None
        assert answer["result"] is None

    @pytest.mark.anyio
    async def test_an_empty_allowlist_answers_no_server(self, hub, workspace):
        await _start(hub, _fake_server_entry(workspace.parent))
        (workspace / "a.py").write_text("x = 1\n", encoding="utf-8")

        answer = hub.query_editor_sync(
            "definition",
            "a.py",
            position={"line": 0, "character": 0},
            allowed_ids=[],
        )

        assert answer["status"] == "no_server"
        assert answer["server"] is None

    @pytest.mark.anyio
    async def test_no_allowlist_sent_leaves_every_activated_server_eligible(
        self, hub, workspace
    ):
        """The failed-snapshot case: no filter must not blind the pane."""
        await _start(hub, _fake_server_entry(workspace.parent))
        (workspace / "a.py").write_text("x = 1\n", encoding="utf-8")

        answer = hub.query_editor_sync(
            "definition", "a.py", position={"line": 0, "character": 0}
        )

        assert answer["status"] == "ok"
        assert answer["server"] == "fake"

    @pytest.mark.anyio
    async def test_the_first_declared_server_that_claims_the_file_answers(
        self, hub, workspace
    ):
        """Declaration order is the tie-break, and the allowlist narrows it."""
        await _start(hub, _fake_server_entry(workspace.parent, "alpha"))
        await _start(hub, _fake_server_entry(workspace.parent, "beta"))
        (workspace / "a.py").write_text("x = 1\n", encoding="utf-8")

        first = hub.query_editor_sync(
            "definition", "a.py", position={"line": 0, "character": 0}
        )
        assert first["server"] == "alpha"

        narrowed = hub.query_editor_sync(
            "definition",
            "a.py",
            position={"line": 0, "character": 0},
            allowed_ids=["beta"],
        )
        assert narrowed["server"] == "beta"


class TestEditorWorkspacePolicy:
    """The policy decides the path, with the tree's own verdict."""

    @pytest.mark.anyio
    async def test_a_hidden_path_is_absent_not_a_refusal_that_confirms_it(
        self, hub, workspace
    ):
        """A hidden path must be indistinguishable from an absent one.

        So the answer is the tree's own 404 sentence — never a refusal naming
        the rule, which would confirm the file is there.
        """
        await _start(hub, _fake_server_entry(workspace.parent))
        (workspace / "secret.py").write_text("x = 1\n", encoding="utf-8")
        _write_policy(workspace, [{"path": "secret.py", "mode": "hidden"}])

        with pytest.raises(WorkspacePathError) as tree_verdict:
            resolve_in_workspace("secret.py")
        assert tree_verdict.value.status_code == 404

        answer = hub.query_editor_sync(
            "definition", "secret.py", position={"line": 0, "character": 0}
        )

        assert answer["status"] == "no_server"
        assert answer["server"] is None
        assert answer["result"] is None
        assert answer["reason"] == tree_verdict.value.detail
        assert "hidden" not in answer["reason"]

    @pytest.mark.anyio
    async def test_a_read_only_path_is_answered_normally(self, hub, workspace):
        """``ro`` refuses a write, not a read — the tree shows the file."""
        await _start(hub, _fake_server_entry(workspace.parent))
        (workspace / "locked.py").write_text("x = 1\n", encoding="utf-8")
        _write_policy(workspace, [{"path": "locked.py", "mode": "ro"}])

        answer = hub.query_editor_sync(
            "definition", "locked.py", position={"line": 0, "character": 0}
        )

        assert answer["status"] == "ok", answer["reason"]
        assert answer["server"] == "fake"
        assert answer["result"] == {"path": "locked.py", "line": 2, "character": 0}


class TestEditorBufferIsTheSourceOfTruth:
    """A dirty buffer sends its text; a clean one lets the hub read the file."""

    @pytest.mark.anyio
    async def test_the_text_sent_with_the_query_is_what_the_server_analysed(
        self, hub, workspace
    ):
        """The fake publishes a diagnostic per line holding ``BUG``.

        The disk copy is clean and the buffer is not, so a diagnostic at the
        buffer's line is the server's own record that it analysed the buffer.
        """
        await _start(hub, _fake_server_entry(workspace.parent))
        document = workspace / "a.py"
        document.write_text("clean\nclean\n", encoding="utf-8")

        answer = hub.query_editor_sync(
            "hover",
            "a.py",
            position={"line": 0, "character": 0},
            text="clean\nclean\nBUG in the buffer\n",
        )
        assert answer["status"] == "ok", answer["reason"]

        uri = uris.from_fs_path(str(document)) or ""
        published = await _published_diagnostics(hub, "fake", uri)
        assert _diagnostic_lines(published) == [2]
        # Nothing here writes: the file still holds what it held.
        assert document.read_text(encoding="utf-8") == "clean\nclean\n"

    @pytest.mark.anyio
    async def test_no_text_sent_means_the_disk_copy_is_used(self, hub, workspace):
        await _start(hub, _fake_server_entry(workspace.parent))
        document = workspace / "b.py"
        document.write_text("clean\nBUG on disk\n", encoding="utf-8")

        answer = hub.query_editor_sync(
            "hover", "b.py", position={"line": 0, "character": 0}
        )
        assert answer["status"] == "ok", answer["reason"]

        uri = uris.from_fs_path(str(document)) or ""
        published = await _published_diagnostics(hub, "fake", uri)
        assert _diagnostic_lines(published) == [1]


class TestEditorColdServer:
    @pytest.mark.anyio
    async def test_a_stopped_lazy_server_answers_starting_without_blocking(
        self, hub, workspace
    ):
        """A Ctrl+click must not hang on a multi-second handshake (spec §4.6).

        ``--slow-init`` holds the handshake open, so a blocking implementation
        would take at least that long. The bound is generous on purpose: the
        point is "did not wait", not a performance number.
        """
        entry = _fake_server_entry(workspace.parent, "fake", "--slow-init", "2.0",
                                   lazy=True)
        _declare(hub, entry)
        (workspace / "a.py").write_text("x = 1\n", encoding="utf-8")

        started = time.monotonic()
        answer = hub.query_editor_sync(
            "definition", "a.py", position={"line": 0, "character": 0}
        )
        elapsed = time.monotonic() - started

        assert answer["status"] == "starting"
        assert answer["server"] == "fake"
        assert answer["result"] is None
        assert answer["reason"] == "fake is starting"
        assert elapsed < 1.0, f"the click waited {elapsed:.2f}s for the handshake"

        # Let the dispatched start finish, so the fixture's teardown has a
        # session to close rather than a child it never saw.
        for _ in range(200):
            if hub.server_status("fake") in ("running", "error"):
                break
            await asyncio.sleep(0.05)
        assert hub.server_status("fake") == "running", hub._servers["fake"]["error"]


class TestEditorQueryCountsAsUse:
    @pytest.mark.anyio
    async def test_a_query_stamps_last_used_so_the_reaper_leaves_the_server_up(
        self, hub, workspace
    ):
        """A human reading code for ten minutes is using the server (§4.12)."""
        entry = _fake_server_entry(workspace.parent)
        entry["idleShutdownSeconds"] = 1
        await _start(hub, entry)
        (workspace / "a.py").write_text("x = 1\n", encoding="utf-8")
        # Stale, as a server nobody has touched since it came up would be.
        hub._servers["fake"]["last_used"] = 0.0

        answer = hub.query_editor_sync(
            "definition", "a.py", position={"line": 0, "character": 0}
        )
        assert answer["status"] == "ok", answer["reason"]
        assert hub._servers["fake"]["last_used"] > 0.0

        hub._reap()
        await asyncio.sleep(0.2)
        assert hub.server_status("fake") == "running"
        assert "fake" in hub._sessions


# ---------------------------------------------------------------------------
# POST /api/lsp/query, end to end through the app
# ---------------------------------------------------------------------------


@pytest.fixture
def editor_client(monkeypatch, tmp_path):
    """The app with a real hub behind it, on a ``tmp_path`` workspace.

    Driven the way ``tests/test_lsp.py``'s ``TestLspEndpoints`` drives the LSP
    routes — ``neutralise_workspace_settings`` for the model connection and the
    activation gate, ``lsphub.constants`` for the declaration file — with one
    difference: the hub is a real ``LspManager`` running the fake server, so the
    route's answer is a real answer rather than a stub's.
    """
    from src import config as config_module
    from src.api import routes
    from src.api.server import create_app
    from src.core import mcphub
    from src.core.lsphub import constants as lsp_constants
    from tests.conftest import neutralise_workspace_settings

    for key in config_module.SETTING_KEYS:
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setattr(config_module, "ENV_PATH", tmp_path / ".env")

    root = tmp_path / "workspace"
    root.mkdir(exist_ok=True)
    neutralise_workspace_settings(monkeypatch, root, lspEnabled=["fake"])

    servers_dir = tmp_path / "lsp_connectors"
    servers_dir.mkdir()
    servers_path = servers_dir / "lsp-settings.json"
    servers_path.write_text(
        _servers_doc(
            fake=_entry(
                [sys.executable, FAKE_SERVER],
                workspaceRoot=str(root),
                extensions=[".py"],
            )
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(lsp_constants, "LSP_CONNECTORS_DIR", servers_dir)
    monkeypatch.setattr(lsp_constants, "LSP_SETTINGS_PATH", servers_path)
    monkeypatch.setattr(
        lsp_constants, "LSP_RESTRICTED_PATHS", servers_dir / "restricted-paths.txt"
    )
    # Keep the MCP hub off the developer's own declaration file.
    monkeypatch.setattr(
        mcphub.constants, "MCP_SETTINGS_PATH", servers_dir / "mcp-settings.json"
    )
    monkeypatch.setattr(
        routes,
        "load_endpoints_config",
        lambda: (
            SimpleNamespace(
                serverUrl="http://x/v1", endpoint="m", model_list=lambda: ["m"],
                to_kwargs=lambda: {}, apiKey="", sysprompt=None,
            ),
            None,
        ),
    )

    manager = LspManager([_fake_server_entry(tmp_path, "fake")], logs_dir=tmp_path / "logs")
    asyncio.run(manager.start_all())
    app = create_app()
    try:
        with TestClient(app) as client:
            # The lifespan's own hub is the disabled one (the autouse switch);
            # this is the hub the route must answer from.
            app.state.lsp = manager
            yield client, app, manager
    finally:
        asyncio.run(manager.stop_all())


class TestEditorQueryRoute:
    def test_the_route_answers_the_envelope_end_to_end(self, editor_client, tmp_path):
        client, _app, _manager = editor_client
        (tmp_path / "workspace" / "a.py").write_text("x = 1\n", encoding="utf-8")

        response = client.post(
            "/api/lsp/query",
            json={
                "action": "definition",
                "path": "a.py",
                "line": 0,
                "character": 0,
            },
        )

        assert response.status_code == 200
        assert response.json() == {
            "status": "ok",
            "server": "fake",
            "reason": None,
            "action": "definition",
            "result": {"path": "a.py", "line": 2, "character": 0},
        }

    def test_the_route_answers_a_hover_with_markdown_and_no_file_bytes(
        self, editor_client, tmp_path
    ):
        """Positions and hover text, never file bytes: it is not a file reader."""
        client, _app, _manager = editor_client
        (tmp_path / "workspace" / "a.py").write_text("x = 1\n", encoding="utf-8")

        body = client.post(
            "/api/lsp/query",
            json={"action": "hover", "path": "a.py", "line": 0, "character": 0},
        ).json()

        assert body["status"] == "ok"
        assert body["result"]["markdown"] == "hover at 0"
        assert "x = 1" not in json.dumps(body)

    def test_a_file_no_server_claims_is_a_quiet_answer_not_an_error(
        self, editor_client, tmp_path
    ):
        """The degradation path: the gesture falls through, nothing is raised."""
        client, _app, _manager = editor_client
        (tmp_path / "workspace" / "notes.md").write_text("hi\n", encoding="utf-8")

        response = client.post(
            "/api/lsp/query",
            json={"action": "definition", "path": "notes.md", "line": 0, "character": 0},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "no_server"
        assert body["server"] is None
        assert body["result"] is None
        assert body["reason"] == "no active language server handles .md"

    def test_the_route_honours_the_tools_panel_allowlist(self, editor_client, tmp_path):
        client, _app, _manager = editor_client
        (tmp_path / "workspace" / "a.py").write_text("x = 1\n", encoding="utf-8")

        body = client.post(
            "/api/lsp/query",
            json={
                "action": "definition",
                "path": "a.py",
                "line": 0,
                "character": 0,
                "lspEnabled": [],
            },
        ).json()

        assert body["status"] == "no_server"
        assert body["server"] is None

    def test_the_route_is_not_refused_while_a_chat_reply_streams(
        self, editor_client, tmp_path, monkeypatch
    ):
        """It is a read, so the chat lock does not apply to it (§4.14)."""
        from src.api import routes

        client, _app, _manager = editor_client
        (tmp_path / "workspace" / "a.py").write_text("x = 1\n", encoding="utf-8")
        monkeypatch.setattr(routes, "_CHAT_TASKS", {"a-streaming-reply"})

        response = client.post(
            "/api/lsp/query",
            json={"action": "definition", "path": "a.py", "line": 0, "character": 0},
        )

        assert response.status_code == 200
        assert response.json()["status"] == "ok"

    def test_the_route_answers_quietly_when_the_hub_is_absent(
        self, editor_client, tmp_path
    ):
        """A hub that is not there must not become a 500 on every Ctrl+click."""
        client, app, _manager = editor_client
        app.state.lsp = None

        response = client.post(
            "/api/lsp/query",
            json={"action": "status", "path": "a.py"},
        )

        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "no_server"
        assert body["server"] is None
        assert body["result"] is None


class TestTheTwoGatesThatMustNotApply:
    """A mode narrows the conversation, never the pane; a lot locks switches, not reading.

    Both are proved by **behaviour**, not by a grep (spec §4.3): a mode whose
    ``lsptools`` flag is false and a running lot each leave the pane answering,
    and the route's body carries no mode id at all — so there is nothing for
    either gate to travel on.
    """

    def test_a_mode_with_lsptools_false_leaves_the_pane_answering(
        self, editor_client, tmp_path
    ):
        """The flag says the *model* gets no schemas. It says nothing about the human."""
        from src.core import agent_modes

        client, _app, _manager = editor_client
        root = tmp_path / "workspace"
        (root / "a.py").write_text("x = 1\n", encoding="utf-8")
        folder = root / agent_modes.POLICY_DIRNAME
        folder.mkdir(parents=True, exist_ok=True)
        (folder / agent_modes.AGENT_MODES_FILENAME).write_text(
            json.dumps(
                {
                    "version": agent_modes.AGENT_MODES_VERSION,
                    "default": "code",
                    "agents": {
                        "code": {
                            "label": "Code",
                            "mcptools": True,
                            "lsptools": False,
                            "systemMessage": "implement it",
                        }
                    },
                },
                indent=2,
            ),
            encoding="utf-8",
        )
        agent_modes.invalidate_agent_modes_cache()
        try:
            # The mode really is the one in force, and its flag really is off —
            # otherwise the assertion below would pass for the wrong reason.
            mode, _findings = agent_modes.resolve_mode(None)
            assert mode is not None and mode.id == "code"
            assert mode.lsptools is False

            response = client.post(
                "/api/lsp/query",
                json={"action": "definition", "path": "a.py", "line": 0, "character": 0},
            )

            assert response.status_code == 200
            assert response.json()["status"] == "ok"
            assert response.json()["server"] == "fake"
        finally:
            agent_modes.invalidate_agent_modes_cache()

    def test_a_busy_app_leaves_the_pane_answering(self, editor_client, tmp_path, monkeypatch):
        """The route consults no busy flag: reading code is not a write.

        The *lot* lock itself is browser state (``useBatch.state.active``), so
        its proof is ``useEditorLsp.test.js``'s — the composable reads no batch
        flag. What this row pins is the backend half: the app's own "something
        is running" state — the streaming reply every write route refuses on —
        does not reach this route.
        """
        from src.api import routes

        client, _app, _manager = editor_client
        (tmp_path / "workspace" / "a.py").write_text("x = 1\n", encoding="utf-8")
        monkeypatch.setattr(routes, "_CHAT_TASKS", {"a-streaming-reply"})

        response = client.post(
            "/api/lsp/query",
            json={"action": "definition", "path": "a.py", "line": 0, "character": 0},
        )

        assert response.status_code == 200
        assert response.json()["status"] == "ok"

    def test_the_route_body_carries_no_mode_id_and_no_batch_flag(self):
        """There is nothing for either gate to travel on, which is the design."""
        from src.api.routes import LspQueryIn

        members = set(LspQueryIn.model_fields)
        assert members == {"action", "path", "line", "character", "text", "lspEnabled"}
        assert not members & {"agentMode", "mode", "batch", "batchActive"}
