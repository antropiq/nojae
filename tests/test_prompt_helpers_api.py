"""appdb-07 — the prompt-helper routes, over HTTP.

The bullets stop being a per-workspace file and become rows of ``nojae.db``, so
the routes stop addressing a *slot* and start addressing a *row id*: read, create,
update-one, delete — the shape §4.5 gives the store's routes, in the pattern the
reserved folder's files established (never a path parameter, never an ``/api/fs``
route, never reachable from a tool).

Three of the file's behaviours are **not** carried over, because they were deleted
on purpose (§4.5):

* the "exactly nine" refusal — the read answers whatever count the store holds,
  including zero;
* the field coercion on a read (a bad colour rewritten to gray) — nothing is
  coerced, because the request model refuses a bad colour the way the file reader
  refused a bad document, in a message naming the field;
* the per-workspace seed and the app bar's ``promptHelpers`` block — the rows are
  install-scoped (D11), so a working location has no helper file to report on.

Every test runs on the suite's temporary database (``tests/conftest.py``,
appdb-04), which arrives created and seeded: nine empty gray rows, the state a
first boot leaves.
"""

from pathlib import Path
from typing import Any, Dict, Iterator, List

import pytest
from fastapi.testclient import TestClient

from src.api import routes
from src.api.server import create_app
from src.core import appdb, editorfs, prompt_helpers


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[TestClient]:
    """The app, on the suite's own store, with the hubs redirected.

    The declaration files are redirected the way ``tests/test_api.py``'s
    ``hub_client`` does, so the working-location switch below restarts nothing
    real and seeds nothing into this checkout.
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


def ids(body: Dict[str, Any]) -> List[int]:
    return [row["id"] for row in body["slots"]]


# -- the read -------------------------------------------------------------------

class TestGetPromptHelpers:
    def test_a_first_boot_answers_the_nine_seeded_rows_and_the_caps(
        self, client: TestClient
    ):
        response = client.get("/api/prompt-helpers")

        assert response.status_code == 200
        body = response.json()
        assert set(body) == {"slots", "caps"}
        assert len(body["slots"]) == 9
        assert body["slots"][0] == {"id": 1, "color": "#808080", "content": ""}
        # No cap is spelled in the client, so the read is where it comes from.
        assert body["caps"] == {"contentMaxChars": 32000, "defaultColor": "#808080"}

    def test_the_read_answers_whatever_count_the_store_holds(
        self, client: TestClient
    ):
        for _ in range(2):
            client.post("/api/prompt-helpers/add", json={"color": "#ff0000"})
        assert len(client.get("/api/prompt-helpers").json()["slots"]) == 11

        for row in ids(client.get("/api/prompt-helpers").json()):
            client.post("/api/prompt-helpers/delete", json={"id": row})

        body = client.get("/api/prompt-helpers").json()
        assert body["slots"] == []
        assert body["caps"]["contentMaxChars"] == 32000

    def test_an_unusable_store_is_422_naming_the_path_never_nine_empty_bullets(
        self, client: TestClient, tmp_path: Path
    ):
        target = appdb.database_path()
        target.write_bytes(b"not a database at all")
        appdb.close_thread_connection()

        response = client.get("/api/prompt-helpers")

        assert response.status_code == 422
        assert str(target) in response.json()["detail"]

    def test_the_route_takes_no_path_and_no_index(self, client: TestClient):
        """A purpose-built reader, not a way to reach the store by argument."""
        assert client.get("/api/prompt-helpers", params={"path": "/etc"}).status_code == 200
        assert client.get("/api/prompt-helpers", params={"index": 3}).status_code == 200


# -- the writes -----------------------------------------------------------------

class TestAdd:
    def test_add_appends_a_row_and_answers_the_whole_list(self, client: TestClient):
        response = client.post(
            "/api/prompt-helpers/add",
            json={"color": "#2ec27e", "content": "Run the tests."},
        )

        assert response.status_code == 200
        body = response.json()
        assert len(body["slots"]) == 10
        assert body["slots"][-1] == {
            "id": 10,
            "color": "#2ec27e",
            "content": "Run the tests.",
        }
        assert client.get("/api/prompt-helpers").json()["slots"] == body["slots"]

    def test_add_defaults_the_content_to_empty(self, client: TestClient):
        response = client.post("/api/prompt-helpers/add", json={"color": "#ff0000"})

        assert response.status_code == 200
        assert response.json()["slots"][-1]["content"] == ""

    def test_add_takes_no_id(self, client: TestClient):
        """The id is the store's to assign; a body naming one is ignored.

        The body model has no ``id`` field and ignores extras, so the only row
        with id 1 is the seeded one — the add cannot aim at it, and the new row
        gets the next id the store hands out.
        """
        response = client.post(
            "/api/prompt-helpers/add", json={"id": 1, "color": "#ff0000"}
        )

        assert response.status_code == 200
        body = response.json()
        assert len(body["slots"]) == 10
        assert body["slots"][-1]["id"] == 10
        assert body["slots"][0]["id"] == 1
        assert body["slots"][0]["color"] == "#808080"


class TestSave:
    def test_save_rewrites_one_row_and_answers_the_whole_list(self, client: TestClient):
        response = client.post(
            "/api/prompt-helpers/save",
            json={"id": 2, "color": "#0000ff", "content": "hello"},
        )

        assert response.status_code == 200
        assert response.json()["slots"][1] == {
            "id": 2,
            "color": "#0000ff",
            "content": "hello",
        }

    def test_empty_content_clears_the_bullet_and_keeps_its_color(
        self, client: TestClient
    ):
        client.post(
            "/api/prompt-helpers/save", json={"id": 2, "color": "#00ff00", "content": "x"}
        )

        response = client.post(
            "/api/prompt-helpers/save", json={"id": 2, "color": "#00ff00", "content": ""}
        )

        assert response.json()["slots"][1] == {"id": 2, "color": "#00ff00", "content": ""}

    def test_an_id_that_names_no_row_is_404_naming_the_id(self, client: TestClient):
        """The browser was holding an older list — say so, do not pretend."""
        response = client.post(
            "/api/prompt-helpers/save", json={"id": 999, "color": "#ff0000", "content": "x"}
        )

        assert response.status_code == 404
        assert "999" in response.json()["detail"]
        assert len(client.get("/api/prompt-helpers").json()["slots"]) == 9


class TestDelete:
    def test_delete_removes_one_row_and_answers_what_is_left(self, client: TestClient):
        response = client.post("/api/prompt-helpers/delete", json={"id": 3})

        assert response.status_code == 200
        assert 3 not in ids(response.json())
        assert len(response.json()["slots"]) == 8
        assert client.get("/api/prompt-helpers").json()["slots"] == response.json()["slots"]

    def test_a_delete_keeps_a_copy_of_the_store_first(self, client: TestClient,
                                                       backup_dir: Path):
        """D12 at the route: the destructive write is the one that copies."""
        client.post("/api/prompt-helpers/delete", json={"id": 1})

        chain = sorted(backup_dir.glob("*.orig"))
        assert len(chain) == 1
        assert chain[0].read_bytes()[:16].startswith(b"SQLite format 3")

    def test_an_id_that_names_no_row_is_404_and_keeps_no_copy(
        self, client: TestClient, backup_dir: Path
    ):
        response = client.post("/api/prompt-helpers/delete", json={"id": 999})

        assert response.status_code == 404
        assert not backup_dir.exists()

    def test_a_delete_body_carries_no_writable_field(self, client: TestClient):
        """The route that removes a row is not a second way to write one."""
        client.post("/api/prompt-helpers/delete", json={"id": 4, "content": "sneaked"})

        assert client.get("/api/prompt-helpers").json()["slots"][3]["content"] == ""


class TestValidationStaysAsStrict:
    """"A database column does not make a bad value less bad" (§4.5)."""

    @pytest.mark.parametrize("color", ("red", "#12345", "#1234567", "#GGGGGG", ""))
    def test_a_color_that_is_not_a_hex_triplet_is_refused_naming_the_field(
        self, client: TestClient, color: str
    ):
        for route in ("/api/prompt-helpers/add", "/api/prompt-helpers/save"):
            body: Dict[str, Any] = {"color": color}
            if route.endswith("save"):
                body["id"] = 1
            response = client.post(route, json=body)

            assert response.status_code == 422, (route, color)
            detail = response.json()["detail"]
            assert any("color" in str(item.get("loc")) for item in detail), detail
            assert any("6-digit hex" in str(item.get("msg")) for item in detail), detail
        assert len(client.get("/api/prompt-helpers").json()["slots"]) == 9

    def test_oversized_content_is_refused_naming_the_field_and_the_cap(
        self, client: TestClient
    ):
        oversized = "x" * (prompt_helpers.CONTENT_MAX_CHARS + 1)

        response = client.post(
            "/api/prompt-helpers/add", json={"color": "#ff0000", "content": oversized}
        )

        assert response.status_code == 422
        detail = str(response.json()["detail"])
        assert "content" in detail
        assert str(prompt_helpers.CONTENT_MAX_CHARS) in detail

    def test_content_at_the_cap_is_accepted(self, client: TestClient):
        capped = "x" * prompt_helpers.CONTENT_MAX_CHARS

        response = client.post(
            "/api/prompt-helpers/add", json={"color": "#ff0000", "content": capped}
        )

        assert response.status_code == 200

    @pytest.mark.parametrize("id_", (0, -1, "one", None))
    def test_an_id_that_is_not_a_row_id_is_refused_naming_the_field(
        self, client: TestClient, id_: Any
    ):
        response = client.post("/api/prompt-helpers/delete", json={"id": id_})

        assert response.status_code == 422
        assert len(client.get("/api/prompt-helpers").json()["slots"]) == 9


class TestTheStreamingGateStaysAsItIs:
    """§4.5: the helper writes were never gated and still are not.

    D7's resolve-once-at-turn-start makes a mid-turn bullet save harmless by
    construction, so the gate the Editor's writes and the modes save ask does not
    belong here — and no new route gains it.
    """

    def test_a_write_lands_while_a_reply_streams(self, client: TestClient):
        armed = object()
        routes._CHAT_TASKS.add(armed)
        try:
            assert client.post(
                "/api/prompt-helpers/add", json={"color": "#ff0000", "content": "mid-turn"}
            ).status_code == 200
            assert client.post(
                "/api/prompt-helpers/save",
                json={"id": 1, "color": "#00ff00", "content": "mid-turn"},
            ).status_code == 200
            assert client.post(
                "/api/prompt-helpers/delete", json={"id": 2}
            ).status_code == 200
        finally:
            routes._CHAT_TASKS.discard(armed)


class TestTheFileIsGone:
    """The workspace's ``.nojae/prompt-helpers.json`` answers nothing any more."""

    def test_the_old_slot_write_is_not_served(self, client: TestClient):
        response = client.post(
            "/api/prompt-helpers", json={"index": 0, "color": "#ff0000", "content": "x"}
        )
        # 404 when there is no built SPA to fall back on; with ``web/dist`` the
        # catch-all static mount answers instead, and a mount accepts no write
        # verb, so 405. Either way nothing serves the old shape, and nothing
        # writes.
        assert response.status_code in (404, 405)

    def test_the_working_location_payload_carries_no_helpers_block(
        self, client: TestClient, tmp_path: Path
    ):
        target = tmp_path / "another-project"
        target.mkdir()

        body = client.get("/api/path-location").json()
        assert "promptHelpers" not in body

        switched = client.post("/api/path-location", json={"path": str(target)})
        assert switched.status_code == 200
        assert "promptHelpers" not in switched.json()

    def test_a_switch_leaves_no_helpers_file_behind(self, client: TestClient,
                                                    tmp_path: Path):
        target = tmp_path / "seeded-project"
        target.mkdir()

        assert client.post("/api/path-location", json={"path": str(target)}).status_code == 200

        helpers = list(target.rglob("prompt-helpers.json"))
        assert helpers == []

    def test_the_bullets_are_the_same_in_every_workspace(self, client: TestClient,
                                                         tmp_path: Path):
        """D11, at the route: the row is the user's, not the tree's."""
        client.post("/api/prompt-helpers/save", json={"id": 1, "color": "#ff0000", "content": "mine"})
        target = tmp_path / "next-project"
        target.mkdir()

        client.post("/api/path-location", json={"path": str(target)})

        assert client.get("/api/prompt-helpers").json()["slots"][0]["content"] == "mine"
