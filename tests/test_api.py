import json
import os
import re
import threading
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx
import pytest
from fastapi.testclient import TestClient

from src.api.server import create_app
from src.core.models import EndpointsConfig
from src.api import routes
from src.core import agent_modes
from src.core import agent_modes_defaults as modes_defaults
from src.core import appdb
from src.core import batch as batch_core
from src.core import editorfs
from src.core import workspace as workspace_seam
from tests.conftest import workspace_params


def _config() -> EndpointsConfig:
    return EndpointsConfig(
        serverUrl="http://localhost:8080/v1",
        endpoint="model-a",
    )


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """The app, with the connection coming from this test's own store.

    No seam is stubbed here any more: ``load_endpoints_config`` reads the rows the
    store fixture seeded, so a route's answer is about real rows rather than
    about a monkeypatch.
    """
    from tests.conftest import neutralise_store

    neutralise_store(
        monkeypatch,
        tmp_path,
        serverUrl="http://localhost:8080/v1",
        endpoint="model-a",
    )
    app = create_app()
    # The context-window probe hits the configured LLM server: keep the
    # suite hermetic; the real function is unit-tested directly.
    monkeypatch.setattr(
        routes, "_context_window", lambda server_url, api_key, model: None
    )
    # Context-managed so the app event loop lives across requests, which the
    # streaming chat routes need.
    with TestClient(app) as test_client:
        yield test_client


class TestConfigEndpoint:
    """``GET /api/config`` answers **per model**, never "the" model (D5)."""

    def test_returns_expected_shape(self, client: TestClient):
        body = client.get("/api/config").json()
        # A **list**, because which model a view is on is the composer's answer.
        assert [model["name"] for model in body["models"]] == ["model-a"]
        model = body["models"][0]
        assert model["serverUrl"] == "http://localhost:8080/v1"
        assert model["supportsVision"] is False
        # Hermetic fixture stubs the probe: the key must always be present.
        assert model["contextWindow"] is None
        assert set(model) == {
            "id",
            "name",
            "serverId",
            "serverName",
            "serverUrl",
            "supportsVision",
            "contextWindow",
        }
        # The store-level question, and no answer that would imply "the" model.
        assert body["store"] == {"usable": True, "sentence": None}
        assert set(body) == {"models", "store", "retryBudget"}
        for absent in ("serverUrl", "samplingSummary", "supportsVision",
                       "contextWindow"):
            assert absent not in body

    def test_the_retry_budget_block_answers_the_effective_pair(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ):
        """Spec §6's read-out: the pair the endpoint-wait guard runs on now.

        The route answers the flags **this run** was booted with, so a case moves
        them through the same whole-value replacement the console script uses —
        the route has no way to set them itself, which is the point.
        """
        from src import config as config_module

        block = client.get("/api/config").json()["retryBudget"]
        # Both defaults, and nothing else: a run that passed neither flag still
        # has a budget, and there is no written value to be confused about.
        assert block == {"maxRetry": 3, "waitSeconds": 10}

        config_module.set_boot_flags(
            config_module.BootFlags(network_max_retry=0, network_wait_for=25)
        )
        block = client.get("/api/config").json()["retryBudget"]
        # Zero is a value someone chose, not a missing one.
        assert block == {"maxRetry": 0, "waitSeconds": 25}

    def test_the_retry_budget_block_carries_no_fallback_note(
        self, client: TestClient
    ):
        """The block's shape is the pair and **nothing else**.

        It used to answer a ``notes`` list, one sentence per ``.env`` key whose
        written value was unusable and the default answered for. An unusable
        ``--network-max-retry`` stops the boot in the parser instead, so a
        running app can be in no such state — and a field that is always empty
        advertises a read-out that cannot report anything.
        """
        block = client.get("/api/config").json()["retryBudget"]
        assert set(block) == {"maxRetry", "waitSeconds"}

    def test_supports_vision_rides_with_the_model_it_describes(
        self, client, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        from tests.conftest import neutralise_store

        neutralise_store(monkeypatch, tmp_path, supportsVision=True)

        body = client.get("/api/config").json()
        assert body["models"][0]["supportsVision"] is True

    def test_no_model_configured_answers_an_empty_list_not_a_default(self, client):
        """A fresh install: nothing is "the" model, so nothing is offered (D5)."""
        from tests.conftest import clear_store_connection

        clear_store_connection()

        body = client.get("/api/config").json()

        assert body["models"] == []
        assert body["store"] == {"usable": True, "sentence": None}

    def test_an_unusable_store_answers_422_naming_the_path(
        self, client, monkeypatch: pytest.MonkeyPatch
    ):
        from src.core import appdb

        def refuse():
            raise appdb.AppStoreError(
                "nojae's settings store at /nowhere cannot be read."
            )

        monkeypatch.setattr(routes.appdb, "load_servers", refuse)

        response = client.get("/api/config")

        assert response.status_code == 422
        assert "/nowhere" in response.json()["detail"]


class TestContextWindow:
    """Unit tests for the /api/config n_ctx probe (real function, stubbed httpx)."""

    class _Response:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    def _patch(self, monkeypatch, payload=None, error=None):
        captured = {}

        class FakeClient:
            def __init__(self, *args, **kwargs):
                pass

            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

            def get(self, url, headers=None):
                captured["url"] = url
                captured["headers"] = headers
                if error is not None:
                    raise error
                return TestContextWindow._Response(payload)

        monkeypatch.setattr(routes.httpx, "Client", FakeClient)
        return captured

    def test_reads_n_ctx_from_the_matching_model_entry(self, monkeypatch):
        captured = self._patch(
            monkeypatch,
            {
                "data": [
                    {"id": "other", "meta": {"n_ctx": 4096}},
                    {"id": "model-a", "meta": {"n_ctx": 262144}},
                ]
            },
        )
        got = routes._context_window("http://ctx-test:9/v1", "sk-1", "model-a")
        assert got == 262144
        assert captured["url"] == "http://ctx-test:9/v1/models"
        assert captured["headers"] == {"Authorization": "Bearer sk-1"}

    def test_a_model_the_server_does_not_list_is_none(self, monkeypatch):
        self._patch(monkeypatch, {"data": [{"id": "x", "meta": {"n_ctx": 8192}}]})
        assert routes._context_window("http://ctx-first:9/v1", "", "model-a") is None
        # The stranger's window must not stick under the requested key either.
        assert routes._context_window("http://ctx-first:9/v1", "", "model-a") is None

    def test_missing_meta_or_bad_server_is_none(self, monkeypatch):
        self._patch(monkeypatch, {"data": [{"id": "model-a"}]})
        assert routes._context_window("http://ctx-nometa:9/v1", "", "model-a") is None
        self._patch(monkeypatch, None, error=httpx.ConnectError("boom"))
        assert routes._context_window("http://ctx-down:9/v1", "", "model-a") is None

    def test_success_is_cached_across_failures(self, monkeypatch):
        self._patch(monkeypatch, {"data": [{"id": "m", "meta": {"n_ctx": 32768}}]})
        assert routes._context_window("http://ctx-cache:9/v1", "", "m") == 32768
        self._patch(monkeypatch, None, error=httpx.ConnectError("gone"))
        # Same (url, model) key: the stale success answers while the server is away.
        assert routes._context_window("http://ctx-cache:9/v1", "", "m") == 32768
        # A different key has no cache to fall back on.
        assert routes._context_window("http://ctx-cache:9/v1", "", "other") is None

    def test_empty_server_url_is_none(self, monkeypatch):
        assert routes._context_window("", "none", "model-a") is None


class TestTheSettingsSurfaceIsTheStore:
    """`GET /api/settings` is gone: the dialog edits the store's own routes (§4.5).

    Pinned as an absence rather than left implicit, because a route that kept
    answering a file the app no longer reads would be a second authority on the
    connection — and `test_write_surface_isolation.py` already pins that the
    store's writes are the browser's own.
    """

    def test_the_old_settings_routes_are_gone(self, client: TestClient):
        assert client.get("/api/settings").status_code in (404, 405)
        assert client.post("/api/settings", json={}).status_code in (404, 405)

    def test_a_saved_server_is_what_the_config_endpoint_answers(
        self, client: TestClient
    ):
        """Read-your-write across the store: a route's write is a turn's read."""
        created = client.post(
            "/api/servers/add",
            json={"name": "Local", "url": "http://target:8080/v1", "apiKey": ""},
        )
        assert created.status_code == 200
        # The write answers the **whole list**, so the new row is looked up by
        # the name this test gave it rather than by its position.
        server_id = next(
            server["id"]
            for server in created.json()["servers"]
            if server["name"] == "Local"
        )
        added = client.post(
            "/api/models/add", json={"serverId": server_id, "name": "model-b"}
        )
        assert added.status_code == 200

        body = client.get("/api/config").json()

        assert [model["name"] for model in body["models"]] == ["model-a", "model-b"]
        # The new model arrives under the server it belongs to, with that
        # server's own URL — a model is never offered without its server.
        added_model = next(m for m in body["models"] if m["name"] == "model-b")
        assert added_model["serverName"] == "Local"
        assert added_model["serverUrl"] == "http://target:8080/v1"


class TestTheBootFlagsMoveTogether:
    """The install-level configuration surface, as one parity check.

    It replaced the ``.env`` trio rule (``SETTING_KEYS``, the renderer and
    ``.env.example`` had to agree). The same kind of drift is still possible
    among the three places a boot flag now lives — the
    :class:`src.config.BootFlags` members, the parser's options, and what
    ``/api/health`` names — and a flag added to one and not the others is the
    same bug the old class existed to catch: a value with no way in, or a read-out
    of a thing nobody can set.
    """

    def test_every_flag_is_parsed_and_reported(self):
        """Every member of the value has a name in the health payload.

        The two spellings differ on purpose — the flags are Python names, the
        payload is the browser's — so the check is the **mapping** and the
        count, not identical strings: a member nobody can read off the screen, or
        a reported field nobody can set, is the drift this class exists to catch.
        """
        from src import config as config_module

        boot = TestClient(create_app()).get("/api/health").json()["boot"]
        assert len(boot) == len(config_module.BootFlags._fields)
        # Every reported key is a flag's own name in camelCase, and no key is an
        # invented one.
        for key in boot:
            snake = re.sub(r"([A-Z])", lambda m: "_" + m.group(1).lower(), key)
            assert snake in config_module.BootFlags._fields, key

    def test_the_run_entry_point_hands_the_port_to_the_server(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """``run`` is the console script: the flag must reach the bind.

        Everything else here tests a *value*; this tests the one function that
        turns a command line into a served app. ``uvicorn.run`` is replaced, so
        nothing binds a port — what is asserted is the call it would have made,
        which is the whole of ``--port``'s effect.
        """
        from src import config as config_module
        from src.api import server as server_module

        calls: List[Dict[str, Any]] = []
        monkeypatch.setattr(
            server_module.uvicorn, "run", lambda app, **kw: calls.append({"app": app, **kw})
        )
        server_module.run(["--port", "9137"])

        assert len(calls) == 1
        # The address is never the operator's to choose: loopback, always.
        assert calls[0]["port"] == 9137
        assert calls[0]["host"] == config_module.DEFAULT_HOST
        assert config_module.boot_flags().port == 9137

    def test_an_unusable_flag_stops_before_anything_is_served(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The reason the flags are parsed **first**.

        A typo must end the boot with argparse's sentence, not start an app on a
        number nobody typed: ``uvicorn.run`` is patched to raise, so a serve after
        a refused parse is visible as a failure rather than as a quiet default.
        """
        from src.api import server as server_module

        def no_serve(*args, **kwargs):
            raise AssertionError("the app was served despite a refused flag")

        monkeypatch.setattr(server_module.uvicorn, "run", no_serve)
        for bad in (["--port", "0"], ["--network-max-retry", "ten"]):
            with pytest.raises(SystemExit):
                server_module.run(bad)

    def test_the_parser_offers_exactly_the_flags_the_value_holds(
        self, capsys: pytest.CaptureFixture
    ):
        """``--help`` spells every member, and no member is missing from it."""
        from src import config as config_module

        with pytest.raises(SystemExit):
            config_module.parse_boot_args(["--help"])
        text = capsys.readouterr().out
        for field in config_module.BootFlags._fields:
            assert "--" + field.replace("_", "-") in text

    def test_the_health_boot_block_is_the_effective_run_state(self):
        """Not a second source: what it answers is what the consumers read.

        The port, the switch and the pair are reported from the same
        :func:`src.config.boot_flags` every other consumer calls, so a screen and
        a refused round cannot disagree about the run they are both part of.
        """
        from src import config as config_module

        config_module.set_boot_flags(
            config_module.BootFlags(llm_debug=True, port=9123, network_max_retry=1)
        )
        boot = TestClient(create_app()).get("/api/health").json()["boot"]
        assert boot == {
            "llmDebug": True,
            "networkMaxRetry": 1,
            "networkWaitFor": config_module.DEFAULT_NETWORK_FAIL_WAIT_FOR,
            "port": 9123,
        }
        assert boot["port"] == config_module.boot_flags().port


class TestModelsEndpoint:
    class _FakeResponse:
        def __init__(self, payload, status_code=200):
            self._payload = payload
            self.status_code = status_code

        def raise_for_status(self):
            if self.status_code >= 400:
                import httpx

                raise httpx.ConnectError("boom")

        def json(self):
            return self._payload

    class _FakeClient:
        def __init__(self, captured, response):
            self.captured = captured
            self.response = response

        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

        async def get(self, url, headers=None):
            self.captured["url"] = url
            self.captured["headers"] = headers or {}
            self.response.raise_for_status()
            return self.response

    def _patch_httpx(self, monkeypatch, response):
        captured: Dict[str, Any] = {}
        fake_cls = self._FakeClient(captured, response)

        def factory(*args, **kwargs):
            return fake_cls

        monkeypatch.setattr(routes.httpx, "AsyncClient", factory)
        return captured

    def test_lists_models_from_v1_url(self, client, monkeypatch):
        payload = {"data": [{"id": "b"}, {"id": "a"}, {"id": "a"}, {"nope": 1}]}
        captured = self._patch_httpx(monkeypatch, self._FakeResponse(payload))
        body = client.get(
            "/api/models", params={"serverUrl": "http://llm:8080/v1"}
        ).json()
        assert body == {"models": ["a", "b"]}
        assert captured["url"] == "http://llm:8080/v1/models"
        assert captured["headers"] == {}

    def test_sends_authorization_header_with_api_key(self, client, monkeypatch):
        captured = self._patch_httpx(monkeypatch, self._FakeResponse({"data": []}))
        client.get(
            "/api/models",
            params={"serverUrl": "http://llm:8080/v1", "apiKey": "sk-42"},
        )
        assert captured["headers"] == {"Authorization": "Bearer sk-42"}

    def test_blank_api_key_sends_no_header(self, client, monkeypatch):
        captured = self._patch_httpx(monkeypatch, self._FakeResponse({"data": []}))
        client.get(
            "/api/models",
            params={"serverUrl": "http://llm:8080/v1", "apiKey": "  "},
        )
        assert captured["headers"] == {}

    def test_appends_v1_models_for_base_url(self, client, monkeypatch):
        captured = self._patch_httpx(monkeypatch, self._FakeResponse({"data": []}))
        response = client.get(
            "/api/models", params={"serverUrl": "http://llm:8080/"}
        )
        assert response.json() == {"models": []}
        assert captured["url"] == "http://llm:8080/v1/models"

    def test_empty_url_returns_422(self, client):
        assert client.get("/api/models").status_code == 422
        assert client.get("/api/models", params={"serverUrl": "  "}).status_code == 422

    def test_non_http_scheme_returns_422(self, client):
        response = client.get(
            "/api/models", params={"serverUrl": "file:///etc/passwd"}
        )
        assert response.status_code == 422

    def test_upstream_failure_returns_502(self, client, monkeypatch):
        self._patch_httpx(monkeypatch, self._FakeResponse({}, status_code=500))
        response = client.get(
            "/api/models", params={"serverUrl": "http://llm:8080/v1"}
        )
        assert response.status_code == 502


class _RecordingHub:
    """Minimal hub double: records restarts, answers what the payload needs."""

    installed = True

    def __init__(self) -> None:
        self.restarts: List[Any] = []

    async def restart(self, *args) -> None:
        self.restarts.append(args)

    async def stop_all(self) -> None:
        """No processes behind this double; shutdown must still find the hook."""

    def status(self) -> List[Dict[str, Any]]:
        return []


@pytest.fixture
def hub_client(client, monkeypatch, tmp_path):
    """``client`` with recording hubs and the declaration files redirected.

    The two doubles go onto a **test-owned workspace's** set through the pool
    (clws-06): a hub route now resolves the request's folder and reaches that
    folder's managers, so the client names that folder on every request and a
    double the route cannot reach would make every restart assertion below
    measure nothing.
    """
    from src.core import lsphub
    from src.core import mcphub
    from tests.conftest import WorkspaceClient, set_workspace_hubs

    empty = tmp_path / "mcp-settings.json"
    empty.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(mcphub.constants, "MCP_SETTINGS_PATH", empty)
    servers_dir = tmp_path / "lsp_connectors"
    servers_dir.mkdir()
    # Hermetic copy of the workspace-root deny-list: the real file's contents
    # belong to the developer's machine, /etc is the stand-in tests assert on.
    (servers_dir / "restricted-paths.txt").write_text("/etc\n", encoding="utf-8")
    monkeypatch.setattr(lsphub.constants, "LSP_CONNECTORS_DIR", servers_dir)
    monkeypatch.setattr(
        lsphub.constants, "LSP_SETTINGS_PATH", servers_dir / "lsp-settings.json"
    )
    monkeypatch.setattr(
        lsphub.constants, "LSP_RESTRICTED_PATHS", servers_dir / "restricted-paths.txt"
    )
    root = tmp_path / "hub-workspace"
    root.mkdir()
    set_workspace_hubs(
        client.app, root=root, mcp=_RecordingHub(), lsp=_RecordingHub()
    )
    return WorkspaceClient(client, root)


class TestWorkspaceEndpoint:
    """``GET /api/workspace`` — the app bar's one read of a folder (clws-02).

    The validation half of the retired ``POST /api/path-location`` lives here
    now, on the field: a folder that is missing, relative, absent or denied is
    refused with the seam's sentence, and a folder that is a workspace is
    answered about **itself**. What went with the route are the cases about
    *setting* the process's location — the environment mutation and the two hub
    restarts — whose subject moved to the pool's admission (task 05).
    """

    def test_the_payload_reports_the_folder_and_the_reserved_files(self, hub_client, tmp_path):
        from src.core import workspace as workspace_seam

        root = tmp_path / "reported"
        root.mkdir()
        body = hub_client.get(
            "/api/workspace", params=workspace_params(root)
        ).json()
        assert body["workspace"] == str(root)
        assert body["default"] == workspace_seam.installation()
        assert set(body) == {
            "workspace", "default", "policy", "mcpSettings",
            "lspSettings", "lspSettingsTemplate", "hubs",
        }
        # appdb-07 and appdb-10: neither the helpers block nor the modes block is
        # in that answer any more — the bullets and the agents are rows of the
        # install's settings store, so a workspace has no such file to report.
        assert "promptHelpers" not in body
        assert "agentModes" not in body

    @pytest.mark.parametrize("raw", ["", "rel", "not-an-absolute-name"])
    def test_an_empty_or_relative_field_is_refused(self, hub_client, raw):
        response = hub_client.get("/api/workspace", params=workspace_params(raw))
        assert response.status_code == 422
        _resolved, sentence = workspace_seam.resolve(raw)
        assert response.json()["detail"] == sentence

    def test_an_absent_folder_is_refused(self, hub_client, tmp_path):
        ghost = tmp_path / "ghost"
        response = hub_client.get("/api/workspace", params=workspace_params(ghost))
        assert response.status_code == 422
        _resolved, sentence = workspace_seam.resolve(str(ghost))
        assert response.json()["detail"] == sentence

    def test_a_denied_folder_is_refused(
        self, hub_client, tmp_path, monkeypatch
    ):
        """A folder the list holds is refused by **that** rule.

        The seam asks its four questions in order — existence before the
        deny-list — so the folder has to be one that exists. ``/etc`` was the
        name written here, and it is a directory on POSIX only: on a Windows
        runner the request is refused by the **existence** sentence, so the
        assertion below fails on a folder that is not on any list. Not because
        the deny-list stopped binding — because the name planted was one this
        filesystem cannot hold.
        """
        from src.core import lsphub

        # The ``hub_client`` list holds ``/etc``, which is a directory only on
        # POSIX; this case needs a denied folder that **exists** here, so it
        # states its own one entry — the same arrangement the two tests below
        # this one make for the other halves of the list.
        denied = tmp_path / "system-tree"
        denied.mkdir()
        list_file = tmp_path / "restricted-paths.txt"
        list_file.write_text(f"{denied}\n", encoding="utf-8")
        monkeypatch.setattr(lsphub.constants, "LSP_RESTRICTED_PATHS", list_file)

        response = hub_client.get(
            "/api/workspace", params=workspace_params(denied)
        )
        assert response.status_code == 422
        assert "deny-list" in response.json()["detail"]

    @pytest.mark.requires_symlink(
        "the field is canonicalised to the realpath, so a folder spelled "
        "through a link and through `.` is one workspace"
    )
    def test_the_field_is_canonicalised_through_links_and_dots(self, hub_client, tmp_path):
        real = tmp_path / "real"
        real.mkdir()
        link = tmp_path / "link"
        link.symlink_to(real, target_is_directory=True)
        response = hub_client.get(
            "/api/workspace", params=workspace_params(f"{link}/.")
        )
        assert response.status_code == 200
        assert response.json()["workspace"] == str(real.resolve())

    def test_the_deny_list_expands_at_read_time_for_the_field_too(
        self, hub_client, tmp_path, monkeypatch
    ):
        r"""Consumer 4 of ``restricted-paths.txt`` honours ``${NAME}`` as well.

        The seam asks the same ``restricted_lsp_roots()`` the hub and the tree
        call, so the one expansion at read time reaches all three: a line naming
        this profile's credential store refuses a workspace inside it, and
        refuses nothing outside it.
        """
        from src.core import lsphub

        monkeypatch.setenv("NOJAE_TEST_PROFILE", str(tmp_path / "home"))
        store = tmp_path / "home" / ".ssh"
        store.mkdir(parents=True)
        list_file = tmp_path / "restricted-paths.txt"
        list_file.write_text("${NOJAE_TEST_PROFILE}/.ssh\n", encoding="utf-8")
        monkeypatch.setattr(lsphub.constants, "LSP_RESTRICTED_PATHS", list_file)

        refused = hub_client.get(
            "/api/workspace", params=workspace_params(store)
        )
        assert refused.status_code == 422
        assert "deny-list" in refused.json()["detail"]

        other = tmp_path / "project"
        other.mkdir()
        ok = hub_client.get("/api/workspace", params=workspace_params(other))
        assert ok.status_code == 200

    @pytest.mark.case_sensitive_volume(
        "the deny-list names the *other* spelling of the target folder, which "
        "has to stay a name that does not exist for its ``realpath`` to keep "
        "the text; on a volume that folds case the two spellings are one "
        "folder and the exact half of the pair is not the pair's other answer"
    )
    def test_the_deny_list_compare_folds_for_the_folder_being_named(
        self, hub_client, tmp_path, monkeypatch
    ):
        r"""win-06 §4: the field asks the same helper as the tree, with the fold.

        A ``restricted-paths.txt`` line naming one spelling of a folder refuses
        the other spelling of it on a volume where they are one folder — and
        refuses nothing where they are two. The probe consulted is the one for
        the folder *being named*, so both halves run against this target.
        """
        from src.core.editorfs import fscase
        from src.core import lsphub

        target = tmp_path / "project"
        target.mkdir()
        list_file = tmp_path / "restricted-paths.txt"
        # The other spelling, a path that does not exist here, so its realpath
        # keeps the text as written.
        list_file.write_text(f"{tmp_path / 'Project'}\n", encoding="utf-8")
        monkeypatch.setattr(lsphub.constants, "LSP_RESTRICTED_PATHS", list_file)

        monkeypatch.setattr(fscase, "case_folded", lambda _root: True)
        refused = hub_client.get(
            "/api/workspace", params=workspace_params(target)
        )
        assert refused.status_code == 422
        assert "deny-list" in refused.json()["detail"]

        monkeypatch.setattr(fscase, "case_folded", lambda _root: False)
        accepted = hub_client.get(
            "/api/workspace", params=workspace_params(target)
        )
        assert accepted.status_code == 200
        assert accepted.json()["workspace"] == str(target.resolve())

    def test_two_folders_are_answered_about_themselves_in_either_order(
        self, hub_client, tmp_path
    ):
        """The lot's whole point, at the route: no process state in between.

        Two scratch folders whose reserved files differ, named one after the
        other **in both orders**, with no environment write anywhere: each
        request answers about its own folder whichever one ran first.
        """
        from src.core.editorfs import constants as editorfs_constants

        first = tmp_path / "first-project"
        second = tmp_path / "second-project"
        for root in (first, second):
            root.mkdir()
        (first / editorfs_constants.POLICY_DIRNAME).mkdir()
        (first / editorfs_constants.POLICY_DIRNAME / editorfs_constants.POLICY_FILENAME
         ).write_text('{"policies": []}\n', encoding="utf-8")

        for order in ((first, second), (second, first)):
            answers = [
                hub_client.get("/api/workspace", params=workspace_params(root)).json()
                for root in order
            ]
            assert [answer["workspace"] for answer in answers] == [
                str(order[0]), str(order[1])
            ]
            assert answers[0]["policy"]["state"] == (
                "existing" if order[0] == first else "absent"
            )
            assert answers[1]["policy"]["state"] == (
                "existing" if order[1] == first else "absent"
            )

    @pytest.mark.parametrize("verb", ["GET", "POST", "PUT", "DELETE"])
    def test_the_working_location_route_pair_is_gone(self, hub_client, verb):
        """Nothing sets the process's folder any more (spec §5.1 rule 7).

        A request to the retired route answers 404 when there is no built SPA to
        fall back on; with ``web/dist`` present the catch-all static mount
        answers instead, and a mount accepts no write verb, so 405. Either way
        nothing sets a folder.
        """
        response = hub_client.request(
            verb, "/api/path-location", json={"path": "/tmp/whatever"}
        )
        assert response.status_code in (404, 405)


class TestTheAppHoldsTheHubPool:
    """``app.state.hubpool`` is the singleton, and it is the **only** hub name.

    clws-05 moved the two hubs into a pool keyed by workspace, and the app holds
    **the pool** — the thing a worker thread's reference must survive. clws-06
    deleted the interim read-through that kept ``app.state.mcp`` / ``app.state.lsp``
    answering about the boot workspace: a hub is bound to a folder at birth, so a
    process-wide name for "the" hub could only ever describe one workspace, and
    every hub route now asks the pool for the request's own.
    """

    def test_the_pool_is_built_by_the_lifespan(self, client):
        from src.core.hubpool import HubPool

        pool = client.app.state.hubpool
        assert isinstance(pool, HubPool)
        # The boot workspace is admitted, so the folder a new tab lands on has
        # its own tools before the first request names it.
        assert pool.boot_root in pool.roots()
        assert pool.live(pool.boot_root) is not None

    def test_the_app_state_carries_no_process_wide_hub(self, client):
        """The shim is gone, and nothing may re-introduce a name for "the" hub.

        Asserted as a refusal rather than a grep: the attribute must not answer,
        so a route that reached for it would fail loudly instead of quietly
        serving the boot workspace to a tab that named another folder.
        """
        for name in ("mcp", "lsp"):
            with pytest.raises(AttributeError):
                getattr(client.app.state, name)

    def test_the_pool_is_stopped_by_the_shutdown_block(self, monkeypatch, tmp_path):
        """Shutdown tears every workspace down, through the pool."""
        from src.api.server import create_app
        from src.core import hubpool as hubpool_module
        from tests.conftest import make_the_install

        boot = tmp_path / "boot-shutdown"
        boot.mkdir()
        # The boot folder is the **installation** (clws-10): no environment
        # value decides it any more, so the test moves the one source the seam
        # reads rather than setting the retired variable.
        make_the_install(monkeypatch, boot)
        stopped: List[Any] = []

        async def record_stop(self) -> None:
            stopped.append(self.roots())

        monkeypatch.setattr(hubpool_module.HubPool, "stop_all", record_stop)
        with TestClient(create_app()):
            pass
        assert stopped == [[str(boot.resolve())]]


class TestHubListingsAreModeBlind:
    """am-05 §4: the hub panels answer the *global* state, never per mode.

    A user who ticks connectors in Settings and picks Chat gets no tools, and
    the panels are where they would look for the reason. The answer is *not* a
    per-mode listing — that would make Settings a function of the dropdown and
    two routes would report two truths. So the mode question is answered once,
    by ``GET /api/agent-modes`` (am-06) carrying ``mcptools``/``lsptools``, and
    these routes gain nothing at all: same payload, and no mode parameter.
    """

    def test_hub_listings_take_no_mode_parameter(self, hub_client):
        spec = hub_client.get("/openapi.json").json()["paths"]
        for route in ("/api/mcp", "/api/lsp"):
            operation = spec[route]["get"]
            names = {p["name"] for p in operation.get("parameters", [])}
            assert names == set(), names

    def test_hub_listing_payload_has_no_mode_dependent_field(self, hub_client):
        # The payload keys are exactly the pre-mode set (plus clws-06's ``built``,
        # which is a fact about the *workspace*, not about a mode): the panel's
        # ``active`` flag is the Settings verdict, which a mode can only narrow,
        # so nothing in here can depend on which mode the composer happens to
        # hold.
        mcp = hub_client.get("/api/mcp").json()
        lsp = hub_client.get("/api/lsp").json()
        assert set(mcp) == {
            "installed", "connectors", "externalsError", "built",
        }
        # Neither payload carries a tool-loop cap any more: it left the LSP
        # section with the second gate (D13) and the MCP section with the store
        # (D9), where it is a per-agent column. A `maxIterations` here would be a
        # second writer of a value these panels no longer edit.
        assert set(lsp) == {
            "installed", "servers", "serversError", "built",
        }
        assert "maxIterations" not in mcp

    def test_the_mode_flags_are_reported_once_by_the_mode_reader(self, hub_client):
        # One route answers the agent question: the two booleans are on the mode
        # objects this module resolves, which is all the frontend needs to gray a
        # panel out — so no hub route has to know about agents.
        resolved = agent_modes.resolve_modes()["modes"]
        assert resolved, "the built-in agents must always resolve"
        for mode in resolved:
            assert isinstance(mode.mcptools, bool)
            assert isinstance(mode.lsptools, bool)
        # And the hub listings carry no mode anywhere (keys pinned above).
        assert "mode" not in str(hub_client.get("/api/mcp").json()).lower()
        assert "mode" not in str(hub_client.get("/api/lsp").json()).lower()


# -- the agents routes (appdb-10) -----------------------------------------------
#
# The personas are rows of the install's ``nojae.db`` now, so these tests assert
# what the routes do to those rows: the store's own read, the ``readonly``
# refusal, the field-naming validations and the pre-delete copy. The seeding
# itself belongs to ``tests/test_appdb_seed.py`` and ``tests/test_appdb_store.py``.


def _agent_rows(client) -> Dict[str, Dict[str, Any]]:
    """Every agent the ``GET /api/agents`` route answers, by id."""
    body = client.get("/api/agents").json()
    return {agent["id"]: agent for agent in body["agents"]}


class TestAgentsEndpoint:
    """``GET /api/agents`` is the app's whole read of the ``agents`` table."""

    def test_the_four_built_ins_answer_in_order(self, client):
        response = client.get("/api/agents")
        assert response.status_code == 200
        body = response.json()
        assert [agent["id"] for agent in body["agents"]] == [
            modes_defaults.CHAT_MODE_ID, modes_defaults.CODE_MODE_ID,
            modes_defaults.ARCHITECT_MODE_ID, modes_defaults.TODO_BUILDER_MODE_ID,
        ]
        assert [agent["label"] for agent in body["agents"]] == [
            modes_defaults.CHAT_LABEL, modes_defaults.CODE_LABEL,
            modes_defaults.ARCHITECT_LABEL, modes_defaults.TODO_BUILDER_LABEL,
        ]

    def test_readonly_replaces_editable_and_the_app_owned_agent_is_last(self, client):
        """§4.4: one flag, and the app-owned agent is now *visible*."""
        agents = client.get("/api/agents").json()["agents"]
        assert [agent["readonly"] for agent in agents] == [False, False, False, True]
        assert "editable" not in json.dumps(agents)

    def test_the_payload_has_no_default_key(self, client):
        """D5: a key that always answered "nothing" would be read as meaningful."""
        assert "default" not in client.get("/api/agents").json()

    def test_each_row_says_whether_its_delete_is_offered(self, client):
        """D4, as a flag: the dialog's Delete is offered per row, not per id.

        ``readonly`` cannot answer this — three of the four built-ins refuse
        deletion without being ``readonly`` — so the payload carries the answer
        itself and the client never has to hold an agent id to compare against
        (§5.2, AC-11).
        """
        agents = client.get("/api/agents").json()["agents"]
        assert [agent["deletable"] for agent in agents] == [False, False, False, False]

        client.post("/api/agents/add", json={"id": "scribe", "label": "Scribe"})
        users = {a["id"]: a for a in client.get("/api/agents").json()["agents"]}
        assert users["scribe"]["deletable"] is True

    def test_each_row_carries_whether_it_can_run(self, client, tmp_path: Path):
        """The composer's warning reads a field, not a rule over two tables."""
        from tests.conftest import write_store_connection

        write_store_connection(tmp_path)
        agents = _agent_rows(client)
        assert agents["code"]["modelId"] is not None
        assert agents["code"]["modelName"] is not None

    def test_an_agent_with_no_model_reports_none(self, client):
        from tests.conftest import clear_agent_model

        clear_agent_model("chat")
        assert _agent_rows(client)["chat"]["modelId"] is None
        assert _agent_rows(client)["chat"]["modelName"] is None

    def test_the_caps_ride_with_the_rows(self, client):
        body = client.get("/api/agents").json()
        assert body["caps"]["maxIdChars"] == agent_modes.MAX_MODE_ID_CHARS
        assert body["caps"]["idPattern"] == agent_modes.MODE_ID_PATTERN
        assert body["caps"]["maxPersonaBytes"] == (
            agent_modes.MAX_MODE_SYSTEM_MESSAGE_BYTES
        )
        assert body["caps"]["minToolIteration"] == agent_modes.MIN_TOOL_ITERATION

    def test_the_route_takes_no_query_parameter(self, client):
        spec = client.get("/openapi.json").json()["paths"]
        operation = spec["/api/agents"]["get"]
        assert {p["name"] for p in operation.get("parameters", [])} == set()


class TestAgentCreate:
    def test_a_user_created_agent_lands_and_is_editable(self, client):
        response = client.post("/api/agents/add", json={
            "id": "scribe", "label": "Scribe", "systemMessage": "Write it down.",
        })
        assert response.status_code == 200
        agents = {a["id"]: a for a in response.json()["agents"]}
        assert agents["scribe"]["label"] == "Scribe"
        assert agents["scribe"]["readonly"] is False
        assert agents["scribe"]["systemMessage"] == "Write it down."

    def test_the_cap_defaults_to_the_seeded_number(self, client):
        client.post("/api/agents/add", json={"id": "a1", "label": "One"})
        assert _agent_rows(client)["a1"]["maxToolIteration"] == (
            appdb.SEEDED_MAX_TOOL_ITERATION
        )

    @pytest.mark.parametrize("cap", [1, 999])
    def test_the_cap_floor_is_one_and_there_is_no_ceiling(self, client, cap):
        """D9, in both directions: 1 is legal, and so is an absurdly large one."""
        response = client.post("/api/agents/add", json={
            "id": "capped", "label": "Capped", "maxToolIteration": cap,
        })
        assert response.status_code == 200
        assert _agent_rows(client)["capped"]["maxToolIteration"] == cap

    def test_a_cap_below_one_is_422_naming_the_field(self, client):
        response = client.post("/api/agents/add", json={
            "id": "zero", "label": "Zero", "maxToolIteration": 0,
        })
        assert response.status_code == 422
        assert "maxToolIteration" in response.json()["detail"]

    @pytest.mark.parametrize("bad_id", ["Nope", "9lives", "has space", "x" * 33])
    def test_an_id_outside_the_slug_pattern_is_422_naming_the_field(
        self, client, bad_id
    ):
        response = client.post("/api/agents/add", json={
            "id": bad_id, "label": "Whatever",
        })
        assert response.status_code == 422
        assert "id" in response.json()["detail"]

    def test_a_duplicate_id_is_422_naming_the_field(self, client):
        response = client.post("/api/agents/add", json={
            "id": "code", "label": "Another coder",
        })
        assert response.status_code == 422
        assert "id" in response.json()["detail"]

    def test_a_duplicate_label_is_422_in_the_slug_collision_words(self, client):
        """A label is what the dialog derives the id from, so a clash is refused."""
        response = client.post("/api/agents/add", json={
            "id": "another", "label": modes_defaults.CODE_LABEL,
        })
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert "label" in detail
        assert modes_defaults.CODE_MODE_ID in detail
        assert "already exists" in detail

    def test_an_empty_label_is_422_naming_the_field(self, client):
        response = client.post("/api/agents/add", json={"id": "nothing", "label": ""})
        assert response.status_code == 422
        assert "label" in response.json()["detail"]

    def test_an_omitted_label_is_the_same_422_not_a_crash(self, client):
        """A create states its label; the route's own guard says so in words.

        The body model defaults ``label`` to ``None``, and a create must refuse
        that as a 422 naming the field — which is what makes the label the route
        then hands the store a stated one.
        """
        response = client.post("/api/agents/add", json={"id": "nothing"})
        assert response.status_code == 422
        assert "label" in response.json()["detail"]

    def test_a_persona_over_the_byte_cap_is_422_naming_the_field(
        self, client, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(agent_modes, "MAX_MODE_SYSTEM_MESSAGE_BYTES", 16)
        response = client.post("/api/agents/add", json={
            "id": "long", "label": "Long", "systemMessage": "x" * 32,
        })
        assert response.status_code == 422
        assert "systemMessage" in response.json()["detail"]

    def test_a_create_cannot_make_a_readonly_agent(self, client):
        """D4: `readonly` is not a body field, so no route may create one."""
        response = client.post("/api/agents/add", json={
            "id": "sneaky", "label": "Sneaky", "readonly": True,
        })
        assert response.status_code == 200
        assert _agent_rows(client)["sneaky"]["readonly"] is False


class TestAgentUpdate:
    def test_a_user_created_agent_can_be_edited(self, client):
        client.post("/api/agents/add", json={"id": "scribe", "label": "Scribe"})
        response = client.post("/api/agents/save", json={
            "id": "scribe",
            "label": "Scribe II",
            "systemMessage": "Write it twice.",
            "mcpEnable": False,
            "lspEnable": True,
            "maxToolIteration": 7,
        })
        assert response.status_code == 200
        agent = {a["id"]: a for a in response.json()["agents"]}["scribe"]
        assert (agent["label"], agent["systemMessage"]) == ("Scribe II", "Write it twice.")
        assert (agent["mcpEnable"], agent["lspEnable"]) == (False, True)
        assert agent["maxToolIteration"] == 7

    def test_an_unknown_id_is_404_naming_it(self, client):
        response = client.post("/api/agents/save", json={
            "id": "ghost", "label": "Ghost",
        })
        assert response.status_code == 404
        assert "ghost" in response.json()["detail"]

    def test_a_readonly_agent_refuses_every_field_but_its_model(self, client, tmp_path: Path):
        """D4 in both halves, through the route."""
        before = _agent_rows(client)[modes_defaults.TODO_BUILDER_MODE_ID]

        refused = client.post("/api/agents/save", json={
            "id": modes_defaults.TODO_BUILDER_MODE_ID,
            "systemMessage": "my own lot rules",
        })
        assert refused.status_code == 422
        assert appdb.READONLY_AGENT_REFUSAL in refused.json()["detail"]
        assert _agent_rows(client)[modes_defaults.TODO_BUILDER_MODE_ID] == before

        # ...and the model association is the one field that lands.
        from tests.conftest import write_store_connection

        write_store_connection(tmp_path)
        model_id = _agent_rows(client)["code"]["modelId"]
        allowed = client.post("/api/agents/save", json={
            "id": modes_defaults.TODO_BUILDER_MODE_ID, "modelId": model_id,
        })
        assert allowed.status_code == 200
        assert _agent_rows(client)[
            modes_defaults.TODO_BUILDER_MODE_ID
        ]["modelId"] == model_id

    def test_resending_an_unchanged_field_on_a_readonly_agent_is_still_refused(
        self, client
    ):
        """The refusal is about *what was supplied*, not about what differs."""
        row = _agent_rows(client)[modes_defaults.TODO_BUILDER_MODE_ID]
        refused = client.post("/api/agents/save", json={
            "id": modes_defaults.TODO_BUILDER_MODE_ID, "label": row["label"],
        })
        assert refused.status_code == 422
        assert appdb.READONLY_AGENT_REFUSAL in refused.json()["detail"]

    def test_a_readonly_agent_refuses_deletion_with_one_sentence(self, client):
        response = client.post("/api/agents/delete", json={
            "id": modes_defaults.TODO_BUILDER_MODE_ID,
        })
        assert response.status_code == 422
        assert appdb.BUILT_IN_AGENT_REFUSAL in response.json()["detail"]
        assert modes_defaults.TODO_BUILDER_MODE_ID in _agent_rows(client)

    def test_a_duplicate_label_on_an_update_is_refused(self, client):
        client.post("/api/agents/add", json={"id": "scribe", "label": "Scribe"})
        response = client.post("/api/agents/save", json={
            "id": "scribe", "label": modes_defaults.CHAT_LABEL,
        })
        assert response.status_code == 422
        assert "label" in response.json()["detail"]

    def test_an_update_may_keep_its_own_label(self, client):
        client.post("/api/agents/add", json={"id": "scribe", "label": "Scribe"})
        response = client.post("/api/agents/save", json={
            "id": "scribe", "label": "Scribe",
        })
        assert response.status_code == 200

    def test_clearing_the_model_is_a_legal_save(self, client, tmp_path: Path):
        """§5.2's empty option: an unrunnable agent is a choice, not an error."""
        from tests.conftest import write_store_connection

        write_store_connection(tmp_path)
        response = client.post("/api/agents/save", json={
            "id": "code", "modelId": None,
        })
        assert response.status_code == 200
        assert _agent_rows(client)["code"]["modelId"] is None

    def test_omitting_the_model_leaves_the_association_alone(self, client, tmp_path: Path):
        """A body that never mentions `modelId` must not null it by accident."""
        from tests.conftest import write_store_connection

        write_store_connection(tmp_path)
        before = _agent_rows(client)["code"]["modelId"]
        response = client.post("/api/agents/save", json={
            "id": "code", "systemMessage": "Implement it.",
        })
        assert response.status_code == 200
        assert _agent_rows(client)["code"]["modelId"] == before


class TestAgentDelete:
    def test_a_user_created_agent_can_be_deleted(self, client):
        client.post("/api/agents/add", json={"id": "scribe", "label": "Scribe"})
        response = client.post("/api/agents/delete", json={"id": "scribe"})
        assert response.status_code == 200
        assert "scribe" not in {a["id"] for a in response.json()["agents"]}

    def test_an_unknown_id_is_404(self, client):
        response = client.post("/api/agents/delete", json={"id": "ghost"})
        assert response.status_code == 404

    @pytest.mark.parametrize("built_in", [
        modes_defaults.CHAT_MODE_ID, modes_defaults.CODE_MODE_ID,
        modes_defaults.ARCHITECT_MODE_ID, modes_defaults.TODO_BUILDER_MODE_ID,
    ])
    def test_the_built_ins_refuse_deletion(self, client, built_in):
        """D4: nojae's own rows cannot be deleted, from the dialog or the route."""
        response = client.post("/api/agents/delete", json={"id": built_in})
        assert response.status_code == 422
        assert appdb.BUILT_IN_AGENT_REFUSAL in response.json()["detail"]
        assert built_in in _agent_rows(client)

    def test_a_delete_is_preceded_by_a_copy_of_the_database(
        self, client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """D12: the store is copied into the app's dated backup folder first."""
        backups = tmp_path / "app-backups"
        monkeypatch.setattr(editorfs.constants, "BACKUP_DIR", backups)
        client.post("/api/agents/add", json={"id": "scribe", "label": "Scribe"})

        response = client.post("/api/agents/delete", json={"id": "scribe"})
        assert response.status_code == 200

        assert editorfs.files.list_backups(appdb.database_path()), (
            "a destructive write must keep a copy of the whole store"
        )

    def test_a_delete_of_nothing_takes_no_copy(
        self, client, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        backups = tmp_path / "app-backups"
        monkeypatch.setattr(editorfs.constants, "BACKUP_DIR", backups)
        assert client.post("/api/agents/delete", json={"id": "ghost"}).status_code == 404
        assert not editorfs.files.list_backups(appdb.database_path())




class _ChatHubDouble:
    """Hub double answering ``active_tool_defs`` from the ids it is given."""

    installed = True

    def __init__(self) -> None:
        self.requested_ids: List[List[str]] = []

    def status(self) -> List[Dict[str, Any]]:
        return []

    def active_tool_defs(self, ids):
        self.requested_ids.append(list(ids))
        tools = [{"type": "function", "function": {"name": f"use_{cid}"}}
                 for cid in ids]
        return tools, {f"use_{cid}": cid for cid in ids}

    def call_tool_sync(self, cid, name, args, timeout=30.0):
        return "ok"

    async def stop_all(self) -> None:
        """No processes behind this double; shutdown must still find the hook."""



@pytest.fixture
def chat_stub(client, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """``client`` with a live MCP hub and a ``stream_chat`` that records kwargs.

    The recording shape mirrors ``tests/test_chat.py``'s stubs: the five named
    instruction/prompt keywords plus whatever tool kwargs the route passes, so
    the *absence* of a key is as observable as its value — which is the whole
    point of the tool-gate assertions below.

    The client is bound to a **test-owned workspace**: every chat request names
    its folder now (clws-02), so a call that named none would be the 422 rather
    than the turn these cases are about. The doubles ride on that same folder's
    set, so the route reaches them through the pool.
    """
    from tests.conftest import WorkspaceClient, set_workspace_hubs

    root = tmp_path / "chat-workspace"
    root.mkdir()
    hub = _ChatHubDouble()
    set_workspace_hubs(client.app, root=root, mcp=hub, lsp=_ChatHubDouble())
    monkeypatch.setattr(routes, "_active_connector_ids", lambda: ["console"])
    monkeypatch.setattr(routes, "_active_server_ids", lambda: [])
    seen: Dict[str, Any] = {}
    asked: List[Optional[str]] = []

    real_resolve = agent_modes.resolve_mode

    def spy_resolve(mode_id):
        asked.append(mode_id)
        return real_resolve(mode_id)

    def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
             pause_event=None, api_key="none", sysprompt=None,
             retry_budget=None,
             agent_instructions=None, mode_instructions=None, **tools):
        seen["sysprompt"] = sysprompt
        if mode_instructions is not None:
            seen["mode_instructions"] = mode_instructions
        seen.update(tools)
        emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 0,
              "tokensEstimated": False})

    monkeypatch.setattr(routes.agent_modes, "resolve_mode", spy_resolve)
    monkeypatch.setattr(routes, "stream_chat", fake)
    return WorkspaceClient(client, root), seen, hub, asked


def _chat(client, **extra):
    body = {"messages": [{"role": "user", "content": "hi"}]}
    body.update(extra)
    return client.post("/api/chat", json=body)


class TestChatAgentModeField:
    """``ChatIn.agentMode`` selects an agent, and both refusals are asserted.

    Two rules, and D5 made the first new: a **missing** id is a 422 naming the
    field (there is no server-side default agent to fall back to), and an
    **unknown** one is a 422 listing what is available. The middle assertion is
    the one the feature exists for: the agent's two hub flags narrow the tool
    set, so a client that could pick an agent which changed the *prompt* but not
    the *tools* would get half an agent.
    """

    def test_an_unknown_mode_is_422_naming_it_and_listing_the_real_ones(
        self, chat_stub
    ):
        client, seen, _hub, _asked = chat_stub
        response = _chat(client, agentMode="nope")
        assert response.status_code == 422
        detail = response.json()["detail"]
        assert "'nope'" in detail
        for mode_id in ("chat", "code", "architect",
                        modes_defaults.TODO_BUILDER_MODE_ID):
            assert mode_id in detail
        # Nothing streamed: the worker never ran.
        assert seen == {}

    def test_a_missing_agent_mode_is_422_naming_the_field(self, chat_stub):
        """D5: no server-side default agent any more, so omitting it is a refusal."""
        client, seen, _hub, asked = chat_stub
        response = _chat(client)
        assert response.status_code == 422
        assert "agentMode" in json.dumps(response.json()["detail"])
        assert seen == {}
        assert asked == []

    def test_a_blank_agent_mode_is_the_same_422(self, chat_stub):
        client, _seen, _hub, _asked = chat_stub
        assert _chat(client, agentMode="   ").status_code == 422

    def test_a_refused_mode_does_not_own_the_pause_handle(self, chat_stub):
        # The 422 is raised *before* ``_arm_chat_handle``, so a request that
        # will never stream cannot leave a stale handle for the next one. The
        # slot is keyed per workspace (clws-04), so "no handle" is now "no
        # workspace holds one" — the same fact, one level up.
        client, _seen, _hub, _asked = chat_stub
        assert routes._CHAT_HANDLES == {}
        assert _chat(client, agentMode="nope").status_code == 422
        assert routes._CHAT_HANDLES == {}
        assert _chat(client, agentMode="code").status_code == 200
        # The reply that *did* stream cleared its own key on the way out, so the
        # map is empty again rather than holding a stale entry for its folder.
        assert routes._CHAT_HANDLES == {}

    def test_a_mode_id_of_the_wrong_shape_is_422_from_the_model(self, chat_stub):
        # The *shape* check lives in the model (cheap, static); existence lives
        # in ``resolve_mode``. An id that could never be an agent id never even
        # reaches the store.
        client, seen, _hub, _asked = chat_stub
        for bad in ("Nope", "9lives", "has space", "x" * 33):
            assert _chat(client, agentMode=bad).status_code == 422, bad
        assert seen == {}
        # It is the *shape* only: none of these reached the store, so none of
        # them can be repaired by renaming an agent, unlike the 422 above.
        assert _asked == []

    def test_the_selected_agent_supplies_the_old_tool_kwargs(self, chat_stub):
        # `code` is the agent that behaves as the app always has: its gate is
        # open, so the tool arguments are exactly what they were before agents
        # existed. They are *not* identical on ``sysprompt`` — an agent supplies
        # a persona, which is the point of the feature — so the persona is
        # asserted separately, never as prose.
        client, seen, hub, asked = chat_stub
        assert _chat(client, agentMode="code").status_code == 200
        assert asked == ["code"]
        # ``skills_instructions`` is in the set because the route now always
        # forwards the catalogue block (its value here is ``""``: this stub's hub
        # is reached, but the test workspace holds no skills). It is an
        # instruction block, not a tool argument — the tool kwargs below are
        # exactly what they were.
        assert set(seen) == {
            "sysprompt", "tools", "tool_executor", "tool_servers",
            "max_tool_iterations", "skills_instructions",
        }
        assert hub.requested_ids == [["console"]]
        assert seen["tool_servers"] == {"use_console": "console"}
        # ...identical in *content* too, not just in keys.
        assert seen["tools"] == [
            {"type": "function", "function": {"name": "use_console"}}
        ]
        assert callable(seen["tool_executor"])
        assert seen["max_tool_iterations"] == routes.max_tool_iteration(
            appdb.resolve_agent("code")[0]
        )
        # The agent itself, asserted separately from the prose that carries it.
        resolved = agent_modes.resolve_mode("code")[0]
        assert resolved is not None
        assert resolved.id == modes_defaults.CODE_MODE_ID
        assert seen["sysprompt"] == resolved.system_message

    def test_the_selected_mode_narrows_the_tool_set_as_well_as_the_prompt(
        self, chat_stub
    ):
        client, seen, hub, asked = chat_stub
        assert _chat(client, agentMode="chat").status_code == 200
        assert asked == ["chat"]
        # D3: no ``tools`` key at all (never ``tools=[]``), and the hub was
        # narrowed to an empty allowlist rather than skipped.
        assert "tools" not in seen
        assert "tool_executor" not in seen
        assert hub.requested_ids == [[]]
        assert seen["sysprompt"] == agent_modes.resolve_mode("chat")[0].system_message

        seen.clear()
        assert _chat(client, agentMode="code").status_code == 200
        assert "tools" in seen
        assert hub.requested_ids == [[], ["console"]]

    def test_the_app_owned_mode_is_reachable_and_its_blocks_arrive(
        self, chat_stub
    ):
        # The whole reason the app-owned agent is published: a user can pick it.
        client, seen, _hub, asked = chat_stub
        response = _chat(client, agentMode=modes_defaults.TODO_BUILDER_MODE_ID)
        assert response.status_code == 200
        assert asked == [modes_defaults.TODO_BUILDER_MODE_ID]
        assert seen["mode_instructions"] == "\n\n".join(
            modes_defaults.todo_builder_mode().instructions
        )
        assert modes_defaults.lot_conventions_block() in seen["mode_instructions"]

    def test_a_selected_agent_is_resolved_against_the_store_as_it_is_now(
        self, chat_stub
    ):
        # Hot edit through the HTTP edge: the same client, two saves, two
        # personas — no restart and no cache (D11).
        client, seen, _hub, _asked = chat_stub
        model_id = _agent_rows(client)["code"]["modelId"]
        assert client.post("/api/agents/add", json={
            "id": "planner", "label": "Planner", "systemMessage": "PERSONA ONE",
            "modelId": model_id,
        }).status_code == 200
        assert _chat(client, agentMode="planner").status_code == 200
        assert seen["sysprompt"] == "PERSONA ONE"
        assert client.post("/api/agents/save", json={
            "id": "planner", "systemMessage": "PERSONA TWO",
        }).status_code == 200
        assert _chat(client, agentMode="planner").status_code == 200
        assert seen["sysprompt"] == "PERSONA TWO"


