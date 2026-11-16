"""appdb-08 — the servers and models routes, over HTTP.

The connection becomes a **catalogue** the browser can edit: purpose-built routes
over the store's ``servers`` and ``models`` tables, in the pattern the reserved
folder's files established — never a path parameter, never an ``/api/fs`` route,
never reachable from a tool.

What this file asserts, in the order the task names it:

* the read answers **servers with their models and nothing else** — no fourth
  store and no "app defaults" surface, and the API key present because the dialog
  that edits it is the only thing that reads this route;
* create / update / delete at both levels, each answering the whole list so the
  dialog re-baselines on the store's rows rather than on what it sent;
* **the file reader's strictness, in words that name the field**: a sampler
  outside its range, a reasoning level the app does not know, a duplicate server
  name, a duplicate model name under one server — the app refuses before the
  database does;
* **the cascade and the set-null** (§4.2): deleting a server takes its models
  with it and leaves the agents that pointed at them with a null ``model_id``;
  deleting a model does the same to its own agents;
* **D12's copy before a destructive write**: every ``DELETE`` is preceded by a
  copy of the whole ``nojae.db`` into the app's dated backup folder, through the
  same helper and the same retention sweep every file replacement already uses,
  and an ``UPDATE`` keeps none;
* the **unassigned count** (§5.1) — the one place the two stores talk.

Hermeticity: every test runs on the suite's temporary database
(``tests/conftest.py``, appdb-04), which arrives created and seeded — four agents
with a null ``model_id`` and no servers, the state a first boot leaves.
"""

import time
from pathlib import Path
from typing import Any, Dict, Iterator, List

import pytest
from fastapi.testclient import TestClient

from src.api.server import create_app
from src.core import appdb, editorfs


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[TestClient]:
    """The app, on the suite's own store, with the hubs redirected.

    The declaration files are redirected the way ``tests/test_api.py``'s
    ``hub_client`` does, so nothing here reaches a live hub or seeds this
    checkout.
    """
    from src.core import lsphub, mcphub

    empty = tmp_path / "mcp-settings.json"
    empty.write_text("{}", encoding="utf-8")
    monkeypatch.setattr(mcphub.constants, "MCP_SETTINGS_PATH", empty)
    servers_dir = tmp_path / "lsp_connectors"
    servers_dir.mkdir()
    (servers_dir / "restricted-paths.txt").write_text("/etc\n", encoding="utf-8")
    monkeypatch.setattr(lsphub.constants, "LSP_CONNECTORS_DIR", servers_dir)
    monkeypatch.setattr(
        lsphub.constants, "LSP_SETTINGS_PATH", servers_dir / "lsp-settings.json"
    )
    monkeypatch.setattr(
        lsphub.constants,
        "LSP_RESTRICTED_PATHS",
        servers_dir / "restricted-paths.txt",
    )
    app = create_app()
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def backup_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The app's dated backup folder, moved into this test's scratch tree."""
    folder = tmp_path / "editor_backups"
    monkeypatch.setattr(editorfs.constants, "BACKUP_DIR", folder)
    return folder


# -- what a test reaches for -----------------------------------------------------

def add_server(client: TestClient, name: str = "Local",
               url: str = "http://x/v1", api_key: str = "sekrit") -> Dict[str, Any]:
    """One server through the route, answered as the row the read gives back."""
    response = client.post(
        "/api/servers/add", json={"name": name, "url": url, "apiKey": api_key}
    )
    assert response.status_code == 200, response.json()
    return response.json()["servers"][-1]


def add_model(client: TestClient, server_id: int,
              name: str = "gpt-test", **columns: Any) -> Dict[str, Any]:
    """One model under ``server_id``, answered as the row the read gives back."""
    response = client.post(
        "/api/models/add", json={"serverId": server_id, "name": name, **columns}
    )
    assert response.status_code == 200, response.json()
    for server in response.json()["servers"]:
        for model in server["models"]:
            if model["serverId"] == server_id and model["name"] == name:
                return model
    raise AssertionError("the write answered no such model")


def servers(client: TestClient) -> List[Dict[str, Any]]:
    return client.get("/api/servers").json()["servers"]


def unassigned(client: TestClient) -> Dict[str, int]:
    return client.get("/api/servers").json()["unassigned"]


def pin_agent_to_model(agent_id: str, model_id: int) -> None:
    """Point one agent row at a model — the state task 11's dialog will create.

    Done through the store rather than through a route on purpose: the agent
    write routes are task 10's, and what this file needs is the **row**, so the
    cascade and the set-null can be observed.
    """
    appdb.connection().execute(
        "UPDATE agents SET model_id = ? WHERE id = ?", (model_id, agent_id)
    )


def agent_model_id(agent_id: str) -> Any:
    for agent in appdb.resolve_agents()["agents"]:
        if agent["id"] == agent_id:
            return agent["modelId"]
    raise AssertionError(f"no agent row {agent_id!r}")


# -- the read --------------------------------------------------------------------

class TestTheRead:
    def test_a_first_boot_answers_no_servers_and_the_caps(self, client: TestClient):
        """Nothing is seeded into the two tables (§4.3), and an empty answer is honest."""
        response = client.get("/api/servers")

        assert response.status_code == 200
        body = response.json()
        assert set(body) == {"servers", "caps", "unassigned"}
        assert body["servers"] == []
        # No range and no level is spelled in the client, so the read is where
        # they come from.
        assert body["caps"]["reasoningLevels"] == [
            "off", "low", "medium", "high", "xhigh",
        ]
        assert body["caps"]["samplerRanges"]["topP"] == {"min": 0.0, "max": 1.0}
        # A bound the app does not state answers null rather than an invented one.
        assert body["caps"]["samplerRanges"]["presencePenalty"] == {
            "min": None, "max": None,
        }

    def test_a_write_answers_the_same_envelope_as_the_read(
        self, client: TestClient
    ):
        """A write must not blank the caps or the unassigned count the form reads."""
        server = add_server(client)

        response = client.post(
            "/api/models/add", json={"serverId": server["id"], "name": "alpha"}
        )

        assert response.status_code == 200
        body = response.json()
        assert set(body) == {"servers", "caps", "unassigned"}
        assert body["caps"] == client.get("/api/servers").json()["caps"]
        assert body["unassigned"] == {"agentsWithoutModel": 4, "agents": 4}

    def test_a_server_comes_back_with_its_models_and_nothing_else(
        self, client: TestClient
    ):
        server = add_server(client)
        add_model(client, server["id"], "alpha")
        add_model(client, server["id"], "beta")

        body = client.get("/api/servers").json()

        assert set(body["servers"][0]) == {"id", "name", "url", "apiKey", "models"}
        assert [model["name"] for model in body["servers"][0]["models"]] == [
            "alpha", "beta",
        ]
        assert set(body["servers"][0]["models"][0]) == {
            "id", "serverId", "name", "sysPrompt", "temperature", "topP", "topK",
            "minP", "repeatPenalty", "presencePenalty", "reasoning",
            "supportsVision",
        }

    def test_the_api_key_is_returned_because_the_dialog_edits_it(
        self, client: TestClient
    ):
        """§4.5: never to a connector, a log or a tool listing — this is none of them."""
        add_server(client, api_key="sk-live-token")

        assert servers(client)[0]["apiKey"] == "sk-live-token"

    def test_the_read_takes_no_path_and_no_id(self, client: TestClient):
        """A purpose-built reader, not a way to reach the store by argument."""
        assert client.get("/api/servers", params={"path": "/etc"}).status_code == 200
        assert client.get("/api/servers", params={"id": 3}).status_code == 200

    def test_an_unusable_store_is_422_naming_the_path_never_an_empty_list(
        self, client: TestClient
    ):
        target = appdb.database_path()
        target.write_bytes(b"not a database at all")
        appdb.close_thread_connection()

        response = client.get("/api/servers")

        assert response.status_code == 422
        assert str(target) in response.json()["detail"]


# -- the servers -----------------------------------------------------------------

class TestServerWrites:
    def test_add_appends_a_row_and_answers_the_whole_list(self, client: TestClient):
        response = client.post(
            "/api/servers/add",
            json={"name": "Local", "url": "http://127.0.0.1:8080/v1", "apiKey": ""},
        )

        assert response.status_code == 200
        assert response.json()["servers"] == [{
            "id": 1, "name": "Local", "url": "http://127.0.0.1:8080/v1",
            "apiKey": "", "models": [],
        }]
        assert servers(client) == response.json()["servers"]

    def test_add_takes_no_id(self, client: TestClient):
        """The id is the store's to assign; a body naming one cannot aim at a row.

        The same discipline the bullet add holds: the body model has no ``id``
        field, so the only thing an ``id`` in the payload can do is be ignored.
        """
        first = add_server(client, "Local")

        response = client.post(
            "/api/servers/add",
            json={"id": first["id"], "name": "Second", "url": "http://y/v1",
                  "apiKey": ""},
        )

        assert response.status_code == 200
        assert [server["id"] for server in response.json()["servers"]] == [
            first["id"], first["id"] + 1,
        ]
        # The row that was named is untouched.
        assert servers(client)[0]["name"] == "Local"

    def test_save_rewrites_every_field_so_a_cleared_key_clears(
        self, client: TestClient
    ):
        server = add_server(client, api_key="old-key")

        response = client.post(
            "/api/servers/save",
            json={"id": server["id"], "name": "Renamed",
                  "url": "http://other:9/v1", "apiKey": ""},
        )

        assert response.status_code == 200
        assert response.json()["servers"] == [{
            "id": server["id"], "name": "Renamed", "url": "http://other:9/v1",
            "apiKey": "", "models": [],
        }]

    def test_save_keeps_the_models_it_was_not_given(self, client: TestClient):
        """A server save writes the server, not the tree under it."""
        server = add_server(client)
        add_model(client, server["id"], "alpha")

        client.post("/api/servers/save", json={
            "id": server["id"], "name": "Local", "url": "http://y/v1", "apiKey": "k",
        })

        assert [m["name"] for m in servers(client)[0]["models"]] == ["alpha"]

    def test_an_id_that_names_no_row_is_404_naming_the_id(self, client: TestClient):
        response = client.post(
            "/api/servers/save",
            json={"id": 999, "name": "Ghost", "url": "http://x/v1", "apiKey": ""},
        )

        assert response.status_code == 404
        assert "999" in response.json()["detail"]
        assert servers(client) == []

    def test_a_server_save_keeps_no_copy(self, client: TestClient,
                                         backup_dir: Path):
        """D12: an update replaces a field the user can retype."""
        server = add_server(client)
        client.post("/api/servers/save", json={
            "id": server["id"], "name": "Renamed", "url": "http://x/v1", "apiKey": "k",
        })

        assert not backup_dir.exists()


class TestServerDelete:
    def test_delete_removes_the_server_and_answers_what_is_left(
        self, client: TestClient
    ):
        first = add_server(client, "One")
        add_server(client, "Two")

        response = client.post("/api/servers/delete", json={"id": first["id"]})

        assert response.status_code == 200
        assert [server["name"] for server in response.json()["servers"]] == ["Two"]

    def test_deleting_a_server_removes_its_models_and_nulls_the_agents(
        self, client: TestClient
    ):
        """The cascade and the set-null, in one delete (§4.2, acceptance 8)."""
        server = add_server(client)
        model = add_model(client, server["id"], "alpha")
        add_model(client, server["id"], "beta")
        pin_agent_to_model("chat", model["id"])
        assert agent_model_id("chat") == model["id"]

        response = client.post("/api/servers/delete", json={"id": server["id"]})

        assert response.json()["servers"] == []
        assert agent_model_id("chat") is None
        # The persona survives: only its model association went (D7).
        assert appdb.resolve_agent("chat")[0]["label"]

    def test_a_delete_keeps_a_copy_of_the_store_first(self, client: TestClient,
                                                      backup_dir: Path):
        server = add_server(client)

        client.post("/api/servers/delete", json={"id": server["id"]})

        chain = sorted(backup_dir.glob("*.orig"))
        assert len(chain) == 1
        assert chain[0].read_bytes()[:16].startswith(b"SQLite format 3")

    def test_the_copy_is_kept_for_a_cascade_too(self, client: TestClient,
                                                backup_dir: Path):
        """One delete destroys more rows than the one named — so the copy matters more."""
        server = add_server(client)
        add_model(client, server["id"], "alpha")

        client.post("/api/servers/delete", json={"id": server["id"]})

        assert len(list(backup_dir.glob("*.orig"))) == 1

    def test_an_id_that_names_no_row_is_404_and_keeps_no_copy(
        self, client: TestClient, backup_dir: Path
    ):
        response = client.post("/api/servers/delete", json={"id": 999})

        assert response.status_code == 404
        assert not backup_dir.exists()

    def test_a_delete_body_carries_no_writable_field(self, client: TestClient):
        """The route that removes a row is not a second way to write one.

        The body model has no field a name, a URL or a key could arrive through,
        so the extra keys are ignored rather than applied: the row that survives
        still holds what it held, and the named row is simply gone.
        """
        doomed = add_server(client, "Doomed", api_key="kept")
        add_server(client, "Spared", "http://spared/v1", "spared-key")

        response = client.post(
            "/api/servers/delete",
            json={"id": doomed["id"], "apiKey": "sneaked", "name": "Rewritten"},
        )

        assert response.status_code == 200
        assert response.json()["servers"] == [{
            "id": 2, "name": "Spared", "url": "http://spared/v1",
            "apiKey": "spared-key", "models": [],
        }]

    def test_the_retention_sweep_applies_to_the_stored_copy(
        self, client: TestClient, backup_dir: Path
    ):
        """The copy is not special: it ages out under the same window as any backup.

        Asked from the sweep's own clock rather than by waiting — "older than the
        retention window" is what the helper decides, and the copy lands in the
        same folder with the same ``.orig`` name, so it is in what that decision
        walks.
        """
        server = add_server(client)
        client.post("/api/servers/delete", json={"id": server["id"]})
        assert len(list(backup_dir.glob("*.orig"))) == 1

        removed = editorfs.files.prune_old_backups(
            older_than_days=1, now=time.time() + 2 * 86400,
        )

        assert removed == 1
        assert not list(backup_dir.glob("*.orig"))


# -- the models ------------------------------------------------------------------

class TestModelWrites:
    def test_add_appends_under_its_server_and_answers_the_whole_list(
        self, client: TestClient
    ):
        server = add_server(client)

        response = client.post(
            "/api/models/add",
            json={"serverId": server["id"], "name": "gpt-test",
                  "sysPrompt": "Be terse.", "temperature": 0.2, "topK": 20,
                  "reasoning": "low", "supportsVision": True},
        )

        assert response.status_code == 200
        model = response.json()["servers"][0]["models"][0]
        assert model["name"] == "gpt-test"
        assert model["sysPrompt"] == "Be terse."
        assert model["temperature"] == 0.2
        assert model["topK"] == 20
        assert model["reasoning"] == "low"
        assert model["supportsVision"] is True

    def test_an_omitted_sampler_is_a_null_column_not_a_zero(self, client: TestClient):
        """§4.2: "not set" and ``0`` are different values and must not converge."""
        server = add_server(client)

        model = add_model(client, server["id"], "alpha")

        assert model["temperature"] is None
        assert model["topK"] is None
        assert model["reasoning"] is None
        assert model["supportsVision"] is False

    def test_a_cleared_sampler_clears_to_null_on_save(self, client: TestClient):
        """The "member absent means" the file's reader held, now per column."""
        server = add_server(client)
        model = add_model(client, server["id"], "alpha", temperature=0.2)

        response = client.post(
            "/api/models/save",
            json={"id": model["id"], "name": "alpha", "temperature": ""},
        )

        assert response.status_code == 200
        assert response.json()["servers"][0]["models"][0]["temperature"] is None
        # A ``0`` stays a ``0`` through the same save.
        zero = client.post(
            "/api/models/save",
            json={"id": model["id"], "name": "alpha", "temperature": 0},
        ).json()["servers"][0]["models"][0]
        assert zero["temperature"] == 0

    def test_a_model_save_never_moves_it_between_servers(self, client: TestClient):
        """No route asks for it: a move would silently re-point every agent."""
        one = add_server(client, "One")
        two = add_server(client, "Two")
        model = add_model(client, one["id"], "alpha")

        response = client.post(
            "/api/models/save",
            json={"id": model["id"], "name": "alpha", "serverId": two["id"]},
        )

        assert response.status_code == 200
        assert servers(client)[0]["models"][0]["serverId"] == one["id"]

    def test_an_id_that_names_no_row_is_404_naming_the_id(self, client: TestClient):
        response = client.post(
            "/api/models/save", json={"id": 999, "name": "ghost"}
        )

        assert response.status_code == 404
        assert "999" in response.json()["detail"]

    def test_an_empty_system_prompt_is_a_value_not_an_unset(self, client: TestClient):
        """The column is ``NOT NULL``, and an empty one means the configured prompt.

        The samplers clear to ``NULL``; this one must not, or the read would
        answer a row the schema does not allow.
        """
        server = add_server(client)

        model = add_model(client, server["id"], "alpha", sysPrompt="")

        assert model["sysPrompt"] == ""

    def test_a_server_id_that_names_no_row_is_404_naming_it(self, client: TestClient):
        """The browser was adding to a server that has since been deleted."""
        response = client.post(
            "/api/models/add", json={"serverId": 999, "name": "orphan"}
        )

        assert response.status_code == 404
        assert "999" in response.json()["detail"]
        assert servers(client) == []


class TestModelDelete:
    def test_delete_removes_the_model_and_nulls_the_agents_pointing_at_it(
        self, client: TestClient
    ):
        server = add_server(client)
        model = add_model(client, server["id"], "alpha")
        pin_agent_to_model("code", model["id"])
        assert agent_model_id("code") == model["id"]

        response = client.post("/api/models/delete", json={"id": model["id"]})

        assert response.status_code == 200
        assert response.json()["servers"][0]["models"] == []
        assert agent_model_id("code") is None
        assert appdb.resolve_agent("code")[0]["label"]

    def test_a_delete_keeps_a_copy_of_the_store_first(self, client: TestClient,
                                                      backup_dir: Path):
        server = add_server(client)
        model = add_model(client, server["id"], "alpha")

        client.post("/api/models/delete", json={"id": model["id"]})

        chain = sorted(backup_dir.glob("*.orig"))
        assert len(chain) == 1
        assert chain[0].read_bytes()[:16].startswith(b"SQLite format 3")

    def test_an_id_that_names_no_row_is_404_and_keeps_no_copy(
        self, client: TestClient, backup_dir: Path
    ):
        response = client.post("/api/models/delete", json={"id": 999})

        assert response.status_code == 404
        assert not backup_dir.exists()


# -- validation is the file reader's strictness -----------------------------------

class TestValidationStaysAsStrict:
    """"A database column does not make a bad value less bad" (§4.5)."""

    @pytest.mark.parametrize("field,value", [
        ("temperature", -0.1),
        ("topP", 1.5),
        ("topP", -1),
        ("topK", -1),
        ("minP", -0.5),
        ("repeatPenalty", -0.5),
    ])
    def test_a_sampler_outside_its_range_is_refused_naming_the_field(
        self, client: TestClient, field: str, value: float
    ):
        server = add_server(client)
        model = add_model(client, server["id"], "alpha")

        for route, body in (
            ("/api/models/add", {"serverId": server["id"], "name": "beta",
                                 field: value}),
            ("/api/models/save", {"id": model["id"], "name": "alpha",
                                  field: value}),
        ):
            response = client.post(route, json=body)

            assert response.status_code == 422, (route, field, value)
            detail = response.json()["detail"]
            assert any(field in str(item.get("loc")) for item in detail), detail
        # Nothing landed.
        assert [m["name"] for m in servers(client)[0]["models"]] == ["alpha"]

    def test_a_presence_penalty_may_be_negative(self, client: TestClient):
        """The app states no bound there, so inventing one would refuse a real value."""
        server = add_server(client)

        model = add_model(client, server["id"], "alpha", presencePenalty=-1.8)

        assert model["presencePenalty"] == -1.8

    def test_a_reasoning_value_the_app_does_not_know_is_refused_naming_the_field(
        self, client: TestClient
    ):
        server = add_server(client)
        model = add_model(client, server["id"], "alpha")

        for route, body in (
            ("/api/models/add", {"serverId": server["id"], "name": "beta",
                                 "reasoning": "ultra"}),
            ("/api/models/save", {"id": model["id"], "name": "alpha",
                                  "reasoning": "ultra"}),
        ):
            response = client.post(route, json=body)

            assert response.status_code == 422, (route, body)
            detail = response.json()["detail"]
            assert any("reasoning" in str(item.get("loc")) for item in detail), detail
            assert any("off, low, medium, high, xhigh" in str(item.get("msg"))
                       for item in detail), detail
        assert [m["name"] for m in servers(client)[0]["models"]] == ["alpha"]

    def test_a_reasoning_level_is_accepted_whatever_its_spelling(
        self, client: TestClient
    ):
        """The file reader lower-cased it; the column holds the canonical word."""
        server = add_server(client)

        model = add_model(client, server["id"], "alpha", reasoning="  HIGH ")

        assert model["reasoning"] == "high"

    def test_a_model_with_no_name_is_refused_naming_the_field(self, client: TestClient):
        server = add_server(client)

        response = client.post(
            "/api/models/add", json={"serverId": server["id"], "name": "   "}
        )

        assert response.status_code == 422
        detail = response.json()["detail"]
        assert any("name" in str(item.get("loc")) for item in detail), detail

    def test_a_server_with_no_name_or_no_url_is_refused_naming_the_field(
        self, client: TestClient
    ):
        for field in ("name", "url"):
            response = client.post(
                "/api/servers/add",
                json={"name": "Local", "url": "http://x/v1", field: "  "},
            )

            assert response.status_code == 422, field
            detail = response.json()["detail"]
            assert any(field in str(item.get("loc")) for item in detail), detail
        assert servers(client) == []

    def test_a_server_url_that_is_not_http_is_refused_naming_the_field(
        self, client: TestClient
    ):
        """The same rule the live model listing already holds its URL to."""
        response = client.post(
            "/api/servers/add",
            json={"name": "Local", "url": "ftp://nowhere/v1", "apiKey": ""},
        )

        assert response.status_code == 422
        detail = response.json()["detail"]
        assert any("url" in str(item.get("loc")) for item in detail), detail
        assert any("http" in str(item.get("msg")) for item in detail), detail


class TestDuplicateNames:
    """The app refuses before the database does, in words (§4.5)."""

    def test_a_second_server_of_the_same_name_is_422_naming_the_field(
        self, client: TestClient
    ):
        add_server(client, "Local")

        response = client.post(
            "/api/servers/add",
            json={"name": "Local", "url": "http://y/v1", "apiKey": ""},
        )

        assert response.status_code == 422
        detail = response.json()["detail"]
        assert "name" in detail
        assert "Local" in detail
        assert len(servers(client)) == 1

    def test_renaming_a_server_onto_another_ones_name_is_422(self, client: TestClient):
        add_server(client, "Local")
        other = add_server(client, "Other")

        response = client.post(
            "/api/servers/save",
            json={"id": other["id"], "name": "Local", "url": "http://y/v1",
                  "apiKey": ""},
        )

        assert response.status_code == 422
        assert "name" in response.json()["detail"]
        assert [s["name"] for s in servers(client)] == ["Local", "Other"]

    def test_a_server_keeping_its_own_name_is_not_a_duplicate(self, client: TestClient):
        """Saving a server whose name did not change is the ordinary case."""
        server = add_server(client, "Local")

        response = client.post(
            "/api/servers/save",
            json={"id": server["id"], "name": "Local", "url": "http://new/v1",
                  "apiKey": "k"},
        )

        assert response.status_code == 200
        assert servers(client)[0]["url"] == "http://new/v1"

    def test_a_second_model_of_the_same_name_under_one_server_is_422(
        self, client: TestClient
    ):
        server = add_server(client)
        add_model(client, server["id"], "alpha")

        response = client.post(
            "/api/models/add", json={"serverId": server["id"], "name": "alpha"}
        )

        assert response.status_code == 422
        detail = response.json()["detail"]
        assert "name" in detail
        assert "alpha" in detail
        assert len(servers(client)[0]["models"]) == 1

    def test_the_same_model_name_under_two_servers_is_allowed(self, client: TestClient):
        """Uniqueness is per server — which is what "a model is chosen from its own
        server's list" means (§4.2)."""
        one = add_server(client, "One")
        two = add_server(client, "Two")
        add_model(client, one["id"], "alpha")

        response = client.post(
            "/api/models/add", json={"serverId": two["id"], "name": "alpha"}
        )

        assert response.status_code == 200
        assert len(servers(client)[1]["models"]) == 1

    def test_renaming_a_model_onto_another_ones_name_under_the_same_server_is_422(
        self, client: TestClient
    ):
        server = add_server(client)
        add_model(client, server["id"], "alpha")
        beta = add_model(client, server["id"], "beta")

        response = client.post(
            "/api/models/save", json={"id": beta["id"], "name": "alpha"}
        )

        assert response.status_code == 422
        assert [m["name"] for m in servers(client)[0]["models"]] == ["alpha", "beta"]

    def test_a_model_keeping_its_own_name_is_not_a_duplicate(self, client: TestClient):
        server = add_server(client)
        model = add_model(client, server["id"], "alpha", temperature=0.2)

        response = client.post(
            "/api/models/save",
            json={"id": model["id"], "name": "alpha", "temperature": 0.7},
        )

        assert response.status_code == 200
        assert servers(client)[0]["models"][0]["temperature"] == 0.7


# -- the unassigned count (§5.1) ---------------------------------------------------

class TestTheUnassignedCount:
    def test_a_fresh_install_reports_every_agent_unassigned(self, client: TestClient):
        """Four agents, no models, every one of them unrunnable (D7)."""
        assert unassigned(client) == {"agentsWithoutModel": 4, "agents": 4}

    def test_pinning_an_agent_moves_the_count(self, client: TestClient):
        server = add_server(client)
        model = add_model(client, server["id"], "alpha")

        pin_agent_to_model("chat", model["id"])

        assert unassigned(client) == {"agentsWithoutModel": 3, "agents": 4}

    def test_deleting_the_model_it_pointed_at_moves_the_count_back(
        self, client: TestClient
    ):
        """Acceptance 8's "not as a silent failure": the line is the visible half."""
        server = add_server(client)
        model = add_model(client, server["id"], "alpha")
        pin_agent_to_model("chat", model["id"])
        assert unassigned(client)["agentsWithoutModel"] == 3

        client.post("/api/models/delete", json={"id": model["id"]})

        assert unassigned(client) == {"agentsWithoutModel": 4, "agents": 4}

    def test_the_count_answers_no_agent_text(self, client: TestClient):
        """The one cross-store line is a number, not a second view of the agents."""
        body = client.get("/api/servers").json()

        assert set(body["unassigned"]) == {"agentsWithoutModel", "agents"}
        assert "systemMessage" not in str(body)


# -- the window task 08 opened, closed by 09 --------------------------------------

class TestTheWindowIsClosed:
    """The dialog writes the store **and** a turn reads it (§9, step 2).

    Task 08 opened a deliberate window: the dialog wrote rows while a chat turn
    still read the workspace's settings file, with nothing kept in sync between
    them (there is no migration, D3). Task 09 closed it by flipping the read and
    deleting the file, so these cases assert the closed state rather than the
    window.
    """

    def test_a_server_written_through_the_route_is_what_the_config_reads(
        self, client: TestClient
    ):
        server_id = add_server(client, "Local", "http://written-to-the-store/v1")
        add_model(client, server_id["id"], "on-the-new-server")

        body = client.get("/api/config").json()

        assert [model["serverUrl"] for model in body["models"] if
                model["name"] == "on-the-new-server"] == [
            "http://written-to-the-store/v1"
        ]
        assert appdb.load_servers()[0]["url"] == "http://written-to-the-store/v1"

    def test_the_settings_route_is_gone(self, client: TestClient):
        """One surface, one authority: the store's own routes (§4.5, §4.7)."""
        response = client.get("/api/settings")

        assert response.status_code in (404, 405)
