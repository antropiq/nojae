"""Seeding ``.nojae/mcp-settings.json`` when a workspace becomes active.

The declaration file joined the reserved folder's family, so this suite has
the shape of ``tests/test_agent_modes_seed.py``: scratch workspaces on disk,
the helpers exercised directly, and the two entry points checked through the
app. What differs is only what a *missing* file costs — a workspace with no
declaration has no MCP connectors — and the one asymmetry of this seed: the
MCP restart *reads* the very file the switch seeds, so the seed must land
first.

The promises this change exists to keep:

* **never overwrites** — one ``O_CREAT | O_EXCL``, so a hand-edited
  declaration survives every later seed byte for byte;
* **the seed is the template verbatim** — the ``${NAME}`` references are
  resolved on every read (``expand_env``), never substituted at seed time,
  which is what keeps one file correct across switches and machines;
* **``${PROJECT_ROOT}`` and ``${NOJAE_PYTHON_ROOT}`` answer from the app's own
  computation** — a stray name in the environment can redirect nothing;
  ``${NOJAE_PYTHON_ROOT}`` is the interpreter this process runs on, and an
  answer the process cannot give is a note, not a blank;
* **the switch seeds before it restarts** — a fresh root comes up holding
  ``console`` and ``fedit``, not zero connectors;
* **a failure is a note** and **a reader never writes** — same as the policy
  and modes seeds.
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, Iterator, List

import pytest
from fastapi.testclient import TestClient

from src import config as config_module
from src.api.server import create_app
from src.config import python_root
from src.core.mcphub import constants, seed
from src.core.mcphub.discovery import load_externals, set_externals_enabled
from src.core.mcphub.validation import expand_env
from tests.conftest import make_the_install, scoped


@pytest.fixture
def workspace(tmp_path: Path) -> Iterator[Path]:
    """A scratch workspace with no declaration file yet."""
    with scoped(tmp_path):
        yield tmp_path


def seeded_path(root: Path) -> Path:
    return root / constants.POLICY_DIRNAME / constants.MCP_SETTINGS_FILENAME


class TestTheSeedLands:
    def test_it_creates_the_file_byte_for_byte_from_the_template(
        self, workspace: Path
    ):
        result = seed.ensure_mcp_settings_file(str(workspace))
        assert result["state"] == "created"
        assert result["error"] is None
        assert result["path"] == str(seeded_path(workspace))
        assert seeded_path(workspace).read_bytes() == (
            constants.MCP_SETTINGS_TEMPLATE.read_bytes()
        )

    def test_the_seeded_file_loads_as_the_two_shipped_connectors(
        self, workspace: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """The point of seeding: a fresh workspace's hub is console + fedit."""
        # The interpreter is the app's own answer, so it is pinned by moving the
        # answer and not by exporting the name (which decides nothing).
        monkeypatch.setattr(config_module, "python_root", lambda: "/opt/py/python")
        seed.ensure_mcp_settings_file(str(workspace))
        connectors, errors = load_externals()
        assert errors == []
        assert [connector["id"] for connector in connectors] == ["console", "fedit"]
        console = connectors[0]
        # The declaration spells a path by joining tokens with ``/``, and
        # ``${PROJECT_ROOT}`` answers as the install root's own text, so the
        # resolved script element is that text followed by the template's
        # slash. Expansion is substitution, never a path rewrite (the rule
        # ``tests/test_mcp.py`` pins), so the expected element is spelled the
        # way the template spells it — same as the expansion test below.
        from src.config import PROJECT_ROOT

        assert console["command"] == [
            "/opt/py/python",
            f"{PROJECT_ROOT}/mcp_connectors/console_mcp.py",
            "--root-dir",
            str(workspace),
            "--transport",
            "stdio",
        ]

    def test_the_template_is_not_a_working_file(self):
        """The committed template keeps its tokens and ships exactly two entries."""
        raw = constants.MCP_SETTINGS_TEMPLATE.read_text(encoding="utf-8")
        assert "${NOJAE_PYTHON_ROOT}" in raw
        assert "${PROJECT_ROOT}" in raw
        assert "${NOJAE_PATH_LOCATION}" in raw
        assert list(json.loads(raw)) == ["console", "fedit"]

    def test_never_overwrites_a_hand_edited_declaration(self, workspace: Path):
        seeded_path(workspace).parent.mkdir(parents=True)
        handwritten = '{"console": {"type": "local", "enable": false, "command": ["x"]}}\n'
        seeded_path(workspace).write_text(handwritten, encoding="utf-8")

        result = seed.ensure_mcp_settings_file(str(workspace))
        assert result["state"] == "existing"
        assert seeded_path(workspace).read_text(encoding="utf-8") == handwritten

    def test_a_folder_at_the_path_is_failed_not_created(self, workspace: Path):
        seeded_path(workspace).parent.mkdir(parents=True)
        seeded_path(workspace).mkdir()

        result = seed.ensure_mcp_settings_file(str(workspace))
        assert result["state"] == "failed"
        assert "folder" in (result["error"] or "")

    def test_a_missing_template_is_a_note_with_no_half_written_file(
        self, workspace: Path, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(
            constants, "MCP_SETTINGS_TEMPLATE", workspace / "gone.default.json"
        )
        result = seed.ensure_mcp_settings_file(str(workspace))
        assert result["state"] == "failed"
        assert not seeded_path(workspace).exists()

    def test_a_reader_never_writes(self, workspace: Path):
        absent = seed.mcp_settings_file_state(str(workspace))
        assert absent["state"] == "absent"
        assert not (workspace / constants.POLICY_DIRNAME).exists()

        seed.ensure_mcp_settings_file(str(workspace))
        assert seed.mcp_settings_file_state(str(workspace))["state"] == "existing"


class TestTheInterpolation:
    def test_project_root_answers_from_the_app_not_the_environment(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """A stray ``PROJECT_ROOT`` must not redirect connectors elsewhere."""
        monkeypatch.setenv("PROJECT_ROOT", "/someone/elses/checkout")
        from src.config import PROJECT_ROOT

        expanded, missing = expand_env("${PROJECT_ROOT}/mcp_connectors/fedit_mcp.py")
        assert missing == []
        assert expanded == f"{PROJECT_ROOT}/mcp_connectors/fedit_mcp.py"

    def test_python_root_answers_the_running_interpreter(self, monkeypatch):
        """The name resolves to **this** process, whatever the environment says.

        The app-level ``.env`` key is gone, so the only answer is the
        computation — and it wins over an ambient export of the same name on
        purpose: a connector must run on the interpreter that loaded the SDK, not
        on one a shell happens to export.
        """
        monkeypatch.setenv("NOJAE_PYTHON_ROOT", "/opt/py/python")
        expanded, missing = expand_env("${NOJAE_PYTHON_ROOT}")
        assert missing == []
        assert expanded == python_root()
        assert expanded != "/opt/py/python"

    def test_an_interpreter_the_process_does_not_know_is_a_note_not_a_blank(self, monkeypatch):
        """The one shape with no value: leave the name written, say so.

        Only an embedding with no ``sys.executable`` gets here. An empty
        *interpreter* would be the blanking-out this rule exists to prevent (a
        connector spawn of ``[""]``), so the reference stays visible and the
        entry's note names the placeholder.
        """
        monkeypatch.setenv("NOJAE_PYTHON_ROOT", "/opt/py/python")
        monkeypatch.setattr(config_module, "python_root", lambda: "")
        expanded, missing = expand_env("${NOJAE_PYTHON_ROOT}")
        assert expanded == "${NOJAE_PYTHON_ROOT}"
        assert missing == ["NOJAE_PYTHON_ROOT"]

    def test_the_workspace_switch_moves_the_expanded_root_dir(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """One seeded file, two roots: ``--root-dir`` follows the location."""
        first = tmp_path / "first"
        second = tmp_path / "second"
        for root in (first, second):
            root.mkdir()
            with scoped(root):
                seed.ensure_mcp_settings_file(str(root))

        with scoped(first):
            connectors, _ = load_externals()
            assert connectors[0]["command"][3] == str(first)

        with scoped(second):
            connectors, _ = load_externals()
            assert connectors[0]["command"][3] == str(second)


class TestThePinStillPins:
    def test_the_pin_wins_over_the_workspace(self, workspace: Path, monkeypatch):
        pinned = workspace / "elsewhere" / "pinned.json"
        pinned.parent.mkdir()
        pinned.write_text(
            json.dumps({"only": {"type": "local", "enable": True, "command": ["x"]}}),
            encoding="utf-8",
        )
        monkeypatch.setattr(constants, "MCP_SETTINGS_PATH", pinned)

        assert constants.mcp_settings_path() == pinned
        connectors, errors = load_externals()
        assert [connector["id"] for connector in connectors] == ["only"]
        assert errors == []
        assert set_externals_enabled({"only": False}) == []
        assert json.loads(pinned.read_text(encoding="utf-8"))["only"]["enable"] is False

    def test_unpinned_the_workspace_file_answers(self, workspace: Path):
        assert constants.MCP_SETTINGS_PATH is None
        assert constants.mcp_settings_path() == seeded_path(workspace)


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
    from src.core import lsphub

    # Unpin the declaration lookup: these tests assert the resolver follows the
    # *working location*, which a pin would defeat.
    monkeypatch.setattr(constants, "MCP_SETTINGS_PATH", None)
    # Hermetic LSP side (the switch restarts that hub too): the machine's own
    # deny-list and server file must not be read.
    servers_dir = tmp_path / "lsp_connectors"
    servers_dir.mkdir()
    (servers_dir / "restricted-paths.txt").write_text("/etc\n", encoding="utf-8")
    monkeypatch.setattr(lsphub.constants, "LSP_CONNECTORS_DIR", servers_dir)
    monkeypatch.setattr(
        lsphub.constants, "LSP_SETTINGS_PATH", servers_dir / "lsp-settings.json"
    )
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
    """The route half of the two entry points, as clws-02 leaves them.

    The switch that used to seed a folder and restart both hubs in one call is
    gone: nothing sets the process's working location any more, so there is no
    longer a route that seeds. Boot is the only entry point until task 05 makes
    the pool's **admission** of a workspace the second — including the
    seed-before-the-first-restart order that the switch used to pin, which no
    route can express in between. The seed's own promises (never overwrites, a
    failure is a note) stay asserted directly in ``TestTheSeedLands``.
    """

    def test_boot_leaves_the_declaration_behind(self, seed_client):
        from tests.conftest import workspace_params

        client, root = seed_client
        assert seeded_path(root).is_file()
        body = client.get(
            "/api/workspace", params=workspace_params(root)
        ).json()
        assert body["mcpSettings"]["state"] == "existing"

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
            assert body["mcpSettings"]["state"] == "absent"
        assert not seeded_path(other).exists()
        assert not other.joinpath(constants.POLICY_DIRNAME).exists()

    def test_a_restart_reads_the_named_workspaces_declaration(
        self, seed_client, tmp_path: Path, monkeypatch
    ):
        """The half of the old switch order a route can still express, per workspace.

        The switch read the folder it had *just* seeded, and that ordering is
        what kept a fresh root from coming up with zero connectors. No route
        seeds on a request any more, so seeding the folder directly is the
        honest way to ask the surviving half: does a restart of **this**
        workspace hand **its own** hub the connectors of **its** declaration
        file? The double therefore goes on the target workspace's set, not the
        boot one's — which is the same fact clws-06 makes of every hub route.
        """
        from tests.conftest import set_workspace_hubs, workspace_params

        client, _ = seed_client
        monkeypatch.delenv("NOJAE_DISABLE_MCP")
        target = tmp_path / "fresh-root"
        target.mkdir()
        assert seed.ensure_mcp_settings_file(str(target))["state"] == "created"
        hub = _RecordingHub()
        set_workspace_hubs(client.app, target, mcp=hub)

        response = client.post("/api/mcp/restart", params=workspace_params(target))
        assert response.status_code == 200
        assert len(hub.restarts) == 1
        handed = list(hub.restarts[0][0])
        assert [connector["id"] for connector in handed] == ["console", "fedit"]
        # Proof the expansion ran on the seeded bytes: every entry's interpreter
        # is **this** process's, which is the one thing the seeded file could not
        # have known when it was written. (It used to be the opposite proof — an
        # unresolved ``${NOJAE_PYTHON_ROOT}`` note, because nothing in the
        # environment answered that name here.)
        assert response.json()["externalsError"] is None
        for connector in handed:
            assert connector["command"][0] == python_root()
