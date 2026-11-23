"""Seeding ``.nojae/lsp-settings.template.json`` when a workspace becomes active.

The language-server declaration moved into the reserved folder, but — unlike
the MCP one — it is **never seeded as a working file**: every entry names
machine-local paths (``workspaceRoot``, interpreter shims), so what the seed
leaves behind is the *template* and the operator writes
``lsp-settings.json`` from it by hand. This suite has the shape of
``tests/test_mcp_settings_seed.py``; what differs is exactly that asymmetry,
plus the absence of the MCP ordering rule (nothing reads the template, so
no restart waits on the seed).

The promises this change exists to keep:

* **the declaration is read from the working location** — the resolver
  answers ``<root>/.nojae/lsp-settings.json`` and a switched location moves
  it; the old ``lsp_connectors/lsp_servers.json`` is not read any more;
* **the template is the example verbatim** — one ``O_CREAT | O_EXCL`` copy,
  its ``${NAME}`` references resolved on every read, never substituted at
  seed time;
* **never overwrites** — a hand-edited template survives every later seed;
* **seeding never creates the declaration** — only the operator writes that;
* **the switch seeds and reports** — both at ``GET`` (state only) and
  ``POST /path-location`` (seed result), so the Settings → LSP panel can
  point at the template;
* **a failure is a note** and **a reader never writes** — same as the other
  reserved-folder seeds.
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, Iterator, List

import pytest
from fastapi.testclient import TestClient

from src.api.server import create_app
from src.core import lsphub
from src.core.lsphub import constants, seed
from src.core.lsphub.discovery import load_lsp_servers, set_lsp_enabled
from tests.conftest import make_the_install, scoped


@pytest.fixture
def workspace(tmp_path: Path) -> Iterator[Path]:
    """A scratch workspace with no declaration file yet."""
    with scoped(tmp_path):
        yield tmp_path


def seeded_template(root: Path) -> Path:
    return root / constants.POLICY_DIRNAME / constants.LSP_SETTINGS_TEMPLATE_FILENAME


def settings_file(root: Path) -> Path:
    return root / constants.POLICY_DIRNAME / constants.LSP_SETTINGS_FILENAME


class TestTheResolver:
    def test_the_declaration_answers_from_the_working_location(
        self, workspace: Path
    ):
        assert constants.LSP_SETTINGS_PATH is None
        assert constants.lsp_settings_path() == settings_file(workspace)

    def test_a_switched_location_moves_the_read(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """One resolver, two roots: the file the hub loads follows the location."""
        first = tmp_path / "first"
        second = tmp_path / "second"
        for root, server_id in ((first, "alpha"), (second, "beta")):
            (root / constants.POLICY_DIRNAME).mkdir(parents=True)
            (root / constants.POLICY_DIRNAME / constants.LSP_SETTINGS_FILENAME).write_text(
                json.dumps({server_id: _entry(root)}), encoding="utf-8"
            )

        with scoped(first):
            servers, errors = load_lsp_servers()
        assert [server["id"] for server in servers] == ["alpha"]
        assert errors == []

        with scoped(second):
            servers, errors = load_lsp_servers()
        assert [server["id"] for server in servers] == ["beta"]
        assert errors == []

    def test_an_absent_declaration_is_no_servers_and_no_note(self, workspace: Path):
        assert load_lsp_servers() == ([], [])


class TestThePinStillPins:
    def test_the_pin_wins_over_the_workspace(self, workspace: Path, monkeypatch):
        pinned = workspace / "elsewhere" / "pinned.json"
        pinned.parent.mkdir()
        pinned.write_text(json.dumps({"only": _entry(workspace)}), encoding="utf-8")
        monkeypatch.setattr(constants, "LSP_SETTINGS_PATH", pinned)

        assert constants.lsp_settings_path() == pinned
        servers, errors = load_lsp_servers()
        assert [server["id"] for server in servers] == ["only"]
        assert errors == []
        assert set_lsp_enabled({"only": False}) == []
        assert json.loads(pinned.read_text(encoding="utf-8"))["only"]["enable"] is False


def _entry(root: Path) -> Dict[str, Any]:
    """The smallest entry the loader accepts: a command and an existing root."""
    return {
        "enable": True,
        "command": ["/bin/true"],
        "workspaceRoot": str(root),
        "extensions": [".py"],
    }


class TestTheSeedLands:
    def test_it_creates_the_template_byte_for_byte_from_the_example(
        self, workspace: Path
    ):
        result = seed.ensure_lsp_settings_template(str(workspace))
        assert result["state"] == "created"
        assert result["error"] is None
        assert result["path"] == str(seeded_template(workspace))
        assert seeded_template(workspace).read_bytes() == (
            constants.LSP_SETTINGS_TEMPLATE.read_bytes()
        )

    def test_seeding_never_creates_the_declaration_itself(self, workspace: Path):
        """The asymmetry versus MCP: the app hands out the copy-me template only."""
        seed.ensure_lsp_settings_template(str(workspace))
        assert not settings_file(workspace).exists()

    def test_never_overwrites_a_hand_edited_template(self, workspace: Path):
        seeded_template(workspace).parent.mkdir(parents=True)
        handwritten = '{"_note": "mine"}\n'
        seeded_template(workspace).write_text(handwritten, encoding="utf-8")

        result = seed.ensure_lsp_settings_template(str(workspace))
        assert result["state"] == "existing"
        assert seeded_template(workspace).read_text(encoding="utf-8") == handwritten

    def test_a_folder_at_the_path_is_failed_not_created(self, workspace: Path):
        seeded_template(workspace).parent.mkdir(parents=True)
        seeded_template(workspace).mkdir()

        result = seed.ensure_lsp_settings_template(str(workspace))
        assert result["state"] == "failed"
        assert "folder" in (result["error"] or "")

    def test_a_missing_example_is_a_note_with_no_half_written_file(
        self, workspace: Path, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(
            constants, "LSP_SETTINGS_TEMPLATE", workspace / "gone.example.json"
        )
        result = seed.ensure_lsp_settings_template(str(workspace))
        assert result["state"] == "failed"
        assert not seeded_template(workspace).exists()

    def test_a_reader_never_writes(self, workspace: Path):
        absent = seed.lsp_settings_template_state(str(workspace))
        assert absent["state"] == "absent"
        assert not (workspace / constants.POLICY_DIRNAME).exists()

        seed.ensure_lsp_settings_template(str(workspace))
        assert seed.lsp_settings_template_state(str(workspace))["state"] == "existing"

    def test_the_declaration_reader_reports_the_handwritten_file(
        self, workspace: Path
    ):
        assert seed.lsp_settings_file_state(str(workspace))["state"] == "absent"
        settings_file(workspace).parent.mkdir(parents=True)
        settings_file(workspace).write_text("{}", encoding="utf-8")
        assert seed.lsp_settings_file_state(str(workspace))["state"] == "existing"
        # Reading reports; it never seeds and never creates.
        assert seed.lsp_settings_template_state(str(workspace))["state"] == "absent"
        assert not seeded_template(workspace).exists()


# -- the two entry points, through the app ---------------------------------------


class _RecordingHub:
    """Minimal hub double: records restarts, answers what the payload needs."""

    installed = True

    def __init__(self) -> None:
        self.restarts: List[Any] = []

    async def restart(self, *args) -> None:
        self.restarts.append(args)

    def status(self) -> List[Dict[str, Any]]:
        return []


@pytest.fixture
def seed_client(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    """A live app on a scratch root, declaration paths unpinned, no legacy lift."""
    from src.core import mcphub

    # Unpin both declaration lookups: these tests assert the resolvers follow
    # the *working location*, which a pin would defeat.
    monkeypatch.setattr(mcphub.constants, "MCP_SETTINGS_PATH", None)
    monkeypatch.setattr(lsphub.constants, "LSP_SETTINGS_PATH", None)
    # Hermetic LSP side (the switch restarts that hub too): the machine's own
    # deny-list must not be read.
    servers_dir = tmp_path / "lsp_connectors"
    servers_dir.mkdir()
    (servers_dir / "restricted-paths.txt").write_text("/etc\n", encoding="utf-8")
    monkeypatch.setattr(lsphub.constants, "LSP_CONNECTORS_DIR", servers_dir)
    monkeypatch.setattr(
        lsphub.constants, "LSP_RESTRICTED_PATHS", servers_dir / "restricted-paths.txt"
    )
    root = tmp_path / "boot-root"
    root.mkdir()
    make_the_install(monkeypatch, root)
    with TestClient(create_app()) as client:
        # The doubles ride on the **boot workspace's** set: a hub route resolves
        # the folder its request named and reaches that folder's managers
        # (clws-06 deleted the ``app.state.mcp`` read-through).
        from tests.conftest import set_workspace_hubs

        set_workspace_hubs(client.app, root, mcp=_RecordingHub(), lsp=_RecordingHub())
        yield client, root


class TestTheEntryPoints:
    """The route half of the entry points, as clws-02 leaves them.

    The switch that seeded a folder and restarted both hubs in one call is gone:
    nothing sets the process's working location any more, so no route seeds.
    Boot is the only entry point until task 05 makes the pool's **admission** of
    a workspace the second. What the switch used to answer — the two blocks of
    the folder it moved to — is now what the read answers about the folder a
    request **names**, which is the same promise with a different subject.
    """

    def test_boot_leaves_the_template_behind(self, seed_client):
        from tests.conftest import workspace_params

        client, root = seed_client
        assert seeded_template(root).is_file()
        body = client.get(
            "/api/workspace", params=workspace_params(root)
        ).json()
        assert body["lspSettingsTemplate"]["state"] == "existing"
        # And the declaration is not seeded — boot has none, and says so.
        assert body["lspSettings"]["state"] == "absent"

    def test_the_read_never_seeds(self, seed_client, tmp_path: Path):
        """A tab may name a folder it only wants to browse, twice or a hundred
        times, and the folder stays as it was."""
        from tests.conftest import workspace_params

        client, _ = seed_client
        other = tmp_path / "browsed"
        other.mkdir()
        for _ in range(2):
            body = client.get(
                "/api/workspace", params=workspace_params(other)
            ).json()
            assert body["lspSettingsTemplate"]["state"] == "absent"
            assert body["lspSettings"]["state"] == "absent"
        assert not seeded_template(other).exists()
        assert not other.joinpath(constants.POLICY_DIRNAME).exists()

    def test_the_read_reports_a_seeded_template_and_no_declaration(
        self, seed_client, tmp_path: Path
    ):
        """The payload shape the Settings → LSP panel renders, per workspace."""
        from tests.conftest import workspace_params

        from src.core.lsphub import ensure_lsp_settings_template

        client, _ = seed_client
        target = tmp_path / "fresh-root"
        target.mkdir()
        assert ensure_lsp_settings_template(str(target))["state"] == "created"

        body = client.get(
            "/api/workspace", params=workspace_params(target)
        ).json()
        expanded = os.path.realpath(str(target))
        # ``existing``, not ``created``: the read reports the file the seed
        # landed, it did not land it itself (the read-never-writes rule above).
        assert body["lspSettingsTemplate"] == {
            "state": "existing",
            "path": os.path.join(
                expanded,
                constants.POLICY_DIRNAME,
                constants.LSP_SETTINGS_TEMPLATE_FILENAME,
            ),
            "error": None,
        }
        assert body["lspSettings"] == {
            "state": "absent",
            "path": os.path.join(
                expanded, constants.POLICY_DIRNAME, constants.LSP_SETTINGS_FILENAME
            ),
            "error": None,
        }
        assert seeded_template(target).read_bytes() == (
            constants.LSP_SETTINGS_TEMPLATE.read_bytes()
        )

    def test_the_read_reports_an_existing_template_and_declaration_untouched(
        self, seed_client, tmp_path: Path
    ):
        from tests.conftest import workspace_params

        client, _ = seed_client
        target = tmp_path / "owned-root"
        (target / constants.POLICY_DIRNAME).mkdir(parents=True)
        template_text = '{"_note": "mine"}\n'
        declaration_text = "{}\n"
        seeded_template(target).write_text(template_text, encoding="utf-8")
        settings_file(target).write_text(declaration_text, encoding="utf-8")

        body = client.get(
            "/api/workspace", params=workspace_params(target)
        ).json()
        assert body["lspSettingsTemplate"]["state"] == "existing"
        assert body["lspSettings"]["state"] == "existing"
        assert seeded_template(target).read_text(encoding="utf-8") == template_text
        assert settings_file(target).read_text(encoding="utf-8") == declaration_text

    def test_a_failing_seed_is_a_note_not_a_refusal(self, seed_client, tmp_path: Path):
        """A folder whose template could not land is still a workspace.

        The read answers 200 and says ``failed``: the panel gets its sentence,
        and nothing about the folder is refused because one file could not be
        written.
        """
        from tests.conftest import workspace_params

        from src.core.lsphub import ensure_lsp_settings_template

        client, _ = seed_client
        target = tmp_path / "locked-root"
        target.mkdir()
        (target / constants.POLICY_DIRNAME).mkdir()
        seeded_template(target).mkdir()  # a folder where the template belongs
        assert ensure_lsp_settings_template(str(target))["state"] == "failed"

        response = client.get(
            "/api/workspace", params=workspace_params(target)
        )
        assert response.status_code == 200
        assert response.json()["lspSettingsTemplate"]["state"] == "failed"
        assert response.json()["lspSettingsTemplate"]["error"]
