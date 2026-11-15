"""appdb-09 — the e2e fixture materialised into a temporary store (D14, §4.6).

With ``NOJAE_TEST_SETTINGS`` truthy the app **never opens** the install's own
``nojae.db``: :func:`src.core.appdb.database_path` answers a throw-away root's
file, and the boot inserts the suite's flat connection fixture into it as rows.
Three properties make that safe, and this file asserts each of them:

1. **the switch moves the path itself**, so there is no fallback in either
   direction — a switched-on process cannot reach the developer's store even if
   it wanted to (AC-7);
2. **the fixture is validated with the tables' strictness** — an unknown member
   or a wrong type is a named failure, never a silently-defaulted sampler,
   because a green suite that measured a default is worse than a red one;
3. **a missing or malformed fixture stops the run** rather than falling through
   to whatever this machine happens to have configured.

The fixture file is written by hand, so every case here writes its own: nothing
reads this checkout's ``.nojae/nojae-test-settings.json``.
"""

import json
from pathlib import Path
from typing import Any, Dict

import pytest

from src.core import appdb


def fixture_document(**overrides: Any) -> Dict[str, Any]:
    """The §4.6 document: one server holding one model, in the **column** names."""
    document: Dict[str, Any] = {
        "server": {
            "name": "test-local",
            "url": "http://test-host:8080/v1",
            "api_key": "",
            "model": {
                "name": "test-model",
                "sys_prompt": "You are a helpful assistant.",
                "temperature": 1,
                "top_p": 0.95,
                "top_k": 20,
                "min_p": 0,
                "repeat_penalty": 1.0,
                "presence_penalty": 0,
                "reasoning": "off",
                "supports_vision": False,
            },
        }
    }
    server = dict(document["server"])
    server.update(overrides.pop("server", {}))
    server["model"] = {**document["server"]["model"], **overrides.pop("model", {})}
    document["server"] = server
    document.update(overrides)
    return document


@pytest.fixture
def test_mode_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A switched-on process on a workspace of its own, with its own fixture file.

    The switch is the product's own predicate, so this is what a real e2e run
    sees: ``database_path`` answers the throw-away root, and the fixture is read
    from the workspace's reserved folder.
    """
    root = tmp_path / "e2e-workspace"
    folder = root / ".nojae"
    folder.mkdir(parents=True)
    monkeypatch.setenv(appdb.TEST_SETTINGS_KEY, "1")
    # A fresh store per case: the switch's root is per process, and the boot
    # below is what this case's rows come from.
    monkeypatch.setattr(appdb, "_test_root", tmp_path / "e2e-store")
    (tmp_path / "e2e-store").mkdir()
    appdb.close_thread_connection()
    from tests.conftest import scoped

    with scoped(root):
        yield root
    appdb.close_thread_connection()


def write_fixture(root: Path, document: Dict[str, Any]) -> Path:
    path = root / ".nojae" / appdb.TEST_SETTINGS_FILENAME
    path.write_text(json.dumps(document), encoding="utf-8")
    return path


class TestTheSwitchMovesTheStoreOffTheInstall:
    def test_the_path_is_the_temporary_roots_not_the_installs(self, test_mode_root: Path):
        """The mechanical half of AC-7: the install's file has *no name* here."""
        install_path = Path(appdb.PROJECT_ROOT) / appdb.DB_FILENAME

        assert appdb.test_mode() is True
        assert appdb.database_path() != install_path
        assert appdb.database_path().parent == appdb.test_root()

    def test_with_the_switch_off_the_install_path_is_back(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.delenv(appdb.TEST_SETTINGS_KEY, raising=False)

        assert appdb.test_mode() is False
        assert appdb.database_path() == Path(appdb.PROJECT_ROOT) / appdb.DB_FILENAME


class TestTheFixtureBecomesRows:
    def test_the_boot_inserts_one_server_and_one_model(self, test_mode_root: Path):
        """D14's steps 1-2: the temporary store exists, and the fixture is in it."""
        write_fixture(test_mode_root, fixture_document())

        state = appdb.boot()

        assert state["state"] == "ok", state["sentence"]
        servers = appdb.load_servers()
        assert len(servers) == 1
        assert servers[0]["name"] == "test-local"
        assert servers[0]["url"] == "http://test-host:8080/v1"
        assert [model["name"] for model in servers[0]["models"]] == ["test-model"]
        model = servers[0]["models"][0]
        assert model["temperature"] == 1
        assert model["topP"] == 0.95
        assert model["reasoning"] == "off"
        # The ids were assigned by the harness, never carried by the file.
        assert state["testFixture"] == {
            "serverId": servers[0]["id"],
            "modelId": model["id"],
        }

    def test_the_built_in_agents_are_seeded_first(self, test_mode_root: Path):
        """Step 1 is the boot's own seeding; step 2 adds the connection."""
        write_fixture(test_mode_root, fixture_document())

        state = appdb.boot()

        agents = appdb.resolve_agents()["agents"]
        assert [agent["id"] for agent in agents] == [
            "chat", "code", "architect", "todoBuilder",
        ]
        # Step 3: every agent the seed wrote now runs on the fixture's one model.
        model_id = state["testFixture"]["modelId"]
        assert all(agent["modelId"] == model_id for agent in agents)
        assert all(agent["modelName"] == "test-model" for agent in agents)

    def test_clearing_one_rows_model_id_reaches_the_one_seam(
        self, test_mode_root: Path
    ):
        """The only way an unrunnable agent exists here is clearing its row (D14).

        The refusal then comes from the same builder production uses, naming the
        agent — there is no test-mode branch in the resolution seam that would
        make the suite exercise a different path.
        """
        from src.config import agent_connection_refusal

        write_fixture(test_mode_root, fixture_document())
        appdb.boot()

        conn = appdb.connection()
        conn.execute("UPDATE agents SET model_id = NULL WHERE id = 'code'")
        agent = appdb.resolve_agent("code")[0]

        assert agent["modelId"] is None
        assert agent_connection_refusal(agent) == (
            "Agent Code has no model to run with. Please assign a model in the "
            "Agent modes dialog."
        )


class TestAMissingOrMalformedFixtureStopsTheRun:
    """T-D3's "no fallback in either direction", moved from the file to the store."""

    def test_a_missing_fixture_is_the_unusable_state(self, test_mode_root: Path):
        state = appdb.boot()

        assert state["state"] == "unusable"
        assert str(appdb.test_settings_path()) in state["sentence"]
        assert state["testFixture"] is None

    def test_a_malformed_document_is_a_named_failure(self, test_mode_root: Path):
        write_fixture(
            test_mode_root,
            {"server": {"name": "x", "url": "http://x/v1", "api_key": ""}},
        )

        state = appdb.boot()

        assert state["state"] == "unusable"
        assert "server.model" in state["sentence"]

    def test_invalid_json_is_a_named_failure(self, test_mode_root: Path):
        (test_mode_root / ".nojae" / appdb.TEST_SETTINGS_FILENAME).write_text(
            "{oops", encoding="utf-8"
        )

        state = appdb.boot()

        assert state["state"] == "unusable"
        assert "not valid JSON" in state["sentence"]


class TestTheFixtureIsCheckedLikeTheTables:
    """§4.5's strictness, applied to the file: a typo is a failure, not a default."""

    @pytest.mark.parametrize(
        "changes, expected",
        [
            # An unknown member at the top level.
            ({"extra": 1}, 'unknown member "extra"'),
            # An unknown member inside the server.
            ({"server": {"endpoint": "m"}}, "unknown member"),
            # The member names are the *columns*, so the payload spelling is a typo.
            ({"model": {"sysPrompt": "hi"}}, "unknown member"),
            # A sampler that is not a number.
            (
                {"model": {"temperature": "0.2"}},
                "server.model.temperature as a string, expected a number",
            ),
            # A boolean that is not a boolean.
            (
                {"model": {"supports_vision": 1}},
                "server.model.supports_vision as a number, expected a boolean",
            ),
            # An integer column given a float.
            (
                {"model": {"top_k": 20.5}},
                "server.model.top_k as a number, expected an integer",
            ),
        ],
    )
    def test_a_bad_fixture_is_refused_by_name(
        self, test_mode_root: Path, changes: Dict[str, Any], expected: str
    ):
        write_fixture(test_mode_root, fixture_document(**changes))

        with pytest.raises(appdb.TestFixtureError) as caught:
            appdb._read_test_fixture(appdb.test_settings_path())

        assert expected in str(caught.value)

    def test_every_column_is_required(self, test_mode_root: Path):
        """A partial fixture would default a sampler, which is the failure mode."""
        document = fixture_document()
        del document["server"]["model"]["reasoning"]
        write_fixture(test_mode_root, document)

        with pytest.raises(appdb.TestFixtureError) as caught:
            appdb._read_test_fixture(appdb.test_settings_path())

        assert "server.model.reasoning" in str(caught.value)
