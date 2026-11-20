"""The connector wizard's transport: five routes that read, and two that think.

The wizard's rules live in core (the catalogue, the scan, the two prompts, the
three snippet checks) and in the composable; this file asks what the *routes* owe
the rest of the app, which is a short list and every line of it a promise:

* **the connection is resolved once per request, from the named agent**, and its
  refusal is ``config.agent_connection_refusal``'s sentence — asserted against the
  **chat route's own answer** for the same agent, so "reused verbatim, never
  rewritten for this feature" is a fact about two strings rather than a claim.
  An agent id that names no row is a 422 naming ``agentMode``.
* **workspace scope**: the scan and both posts answer about the folder the request
  names — two ``tmp_path`` folders side by side, each answered about its own — and
  a folder that was named and refused is the seam's 422 with nothing scanned.
* **installation scope**: the catalogue and the connection reads answer exactly the
  same when the named folder is garbage, which is what lets a tab whose folder has
  gone still open the dialog and be told who it runs as.
* **no hub, ever**: the declared ids come from the loaders directly, so a folder
  the pool would refuse — or one with no declaration file at all — still gets a
  scan, a proposal and a prepared snippet. The pool's admission is poisoned to
  prove it is never asked.
* **nothing writes**: over a workspace whose reserved folder, declarations and
  manifests are snapshotted, every endpoint leaves the tree byte-identical,
  mtime included.
* **no secret leaves**: no answer carries the store's ``api_key``, and the
  key-bearing catalogue entry produces exactly the canonical sentinel.
* **a member, never a file**, with the declaration file's absolute path and its
  exists flag, in both the present and the absent case.
* **one attempt**: a refused model call is a ``failed`` outcome with its sentence
  at **200**, and the seam was called exactly once.

Hermetic by construction: both hubs are disabled by the suite's guard, every
folder is a ``tmp_path`` one, and the only model is ``modelstep.send`` re-pointed
at a recorder — no test reads a real connection or opens the install's store.
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

import pytest
from fastapi.testclient import TestClient

from src.api import routes
from src.api.server import create_app
from src.config import agent_connection_refusal
from src.core import appdb
from src.core.mcphub import constants as mcp_constants
from src.core.wizard import modelstep
from tests.conftest import neutralise_store, workspace_params

#: The one canonical spelling of "fill this in" (§8) — written as a literal so the
#: test does not read the value it is checking out of the code under test.
SENTINEL = "__put_your_api_key_here__"

#: The credential the test store holds. It must appear in **no** answer: §8's
#: "the dialog never asks for, and never displays, a secret".
API_KEY = "sk-the-store-holds-this-and-no-answer-may-carry-it"

#: The workspace reference a snippet writes instead of a machine's own path.
PATH_REFERENCE = "${NOJAE_PATH_LOCATION}"

#: The agent a wizard request names in these tests — one of the seeded rows.
AGENT = "code"


# -- the model seam, re-pointed ------------------------------------------------


class Seam:
    """``modelstep.send`` replaced by a recorder with a scripted answer.

    The wizard package's own seam function is the one patchable name (task 03 left
    it for exactly this), so a test captures the request and chooses the answer
    without patching ``llmkit`` for the whole process.
    """

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.calls: List[Dict[str, Any]] = []
        self.answer: Any = {"servers": []}
        self.failure: Optional[BaseException] = None
        monkeypatch.setattr(modelstep, "send", self._send)

    def _send(self, **kwargs: Any) -> Dict[str, Any]:
        self.calls.append(kwargs)
        if self.failure is not None:
            raise self.failure
        text = (
            self.answer
            if isinstance(self.answer, str)
            else json.dumps(self.answer)
        )
        return {"choices": [{"message": {"role": "assistant", "content": text}}]}

    def facts(self, index: int = -1) -> Dict[str, Any]:
        """The scan facts the model was handed on call ``index``."""
        content = self.calls[index]["messages"][1]["content"]
        marker = "The scan's facts, as JSON:\n"
        return json.loads(content.split(marker, 1)[1])

    def candidate(self, index: int = -1) -> Dict[str, Any]:
        """The chosen candidate the prepare step was handed on call ``index``."""
        content = self.calls[index]["messages"][1]["content"]
        marker = "The chosen candidate, as JSON:\n"
        block = content.split(marker, 1)[1].split("\n\nThe scan's facts", 1)[0]
        return json.loads(block)


@pytest.fixture
def seam(monkeypatch: pytest.MonkeyPatch) -> Seam:
    return Seam(monkeypatch)


# -- the app, on a store and folders this test owns ----------------------------


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[TestClient]:
    """The app on this test's own store, with a connection that carries a key.

    The store is the suite's temporary one (:func:`neutralise_store` writes rows
    into it), and the key it holds is the literal :data:`API_KEY` so "no answer
    carries it" is an assertion rather than a hope.
    """
    neutralise_store(
        monkeypatch,
        tmp_path,
        serverUrl="http://wizard.test:8080/v1",
        serverApiKey=API_KEY,
        endpoint="wizard-model",
    )
    with TestClient(create_app()) as test_client:
        yield test_client


def locate(root: Path) -> Dict[str, str]:
    """The field a request names its folder with."""
    return workspace_params(root)


def a_project(root: Path, *files: str) -> Path:
    """One ``tmp_path`` folder holding ``files`` (relative names)."""
    root.mkdir(parents=True, exist_ok=True)
    for name in files:
        target = root / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"# {name}\n", encoding="utf-8")
    return root


def write_json(path: Path, data: Any) -> Path:
    """Write one declaration file — the **test's** act, never the app's."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, indent=2), encoding="utf-8")
    return path


def snapshot(root: Path) -> Dict[str, Tuple[int, bytes]]:
    """Every file under ``root``: its relative name, its mtime and its bytes."""
    found: Dict[str, Tuple[int, bytes]] = {}
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        stat = path.stat()
        found[str(path.relative_to(root))] = (stat.st_mtime_ns, path.read_bytes())
    return found


def poison_hub_acquisition(monkeypatch: pytest.MonkeyPatch, client: TestClient) -> None:
    """Make every admission a failure, so "the hub was never asked" is provable."""

    def refuse(*_args: Any, **_kwargs: Any) -> Any:
        raise AssertionError(
            "a wizard route acquired a hub set: discovery must read the loaders"
        )

    pool = client.app.state.hubpool
    monkeypatch.setattr(pool, "acquire", refuse)
    monkeypatch.setattr(pool, "acquire_sync", refuse)


# -- what the model answers ----------------------------------------------------


def a_proposal(**extra: Any) -> Dict[str, Any]:
    """One LSP proposal in the shape task 03's parser accepts."""
    return {
        "id": "fake-langserver",
        "command": ["fake-langserver", "--stdio"],
        "extensions": [".py"],
        "workspaceRoot": PATH_REFERENCE,
        "evidence": "3 .py files and no Python language server declared",
        **extra,
    }


def a_prepared(member: Dict[str, Any], declared_id: str = "fake") -> Dict[str, Any]:
    """One prepared answer: the member plus the guidance that must not enter it."""
    return {
        "id": declared_id,
        "member": member,
        "install": {"any": "a-line-the-model-invented"},
        "requiresInstall": True,
        "decisions": ["the workspace root is the project root"],
    }


def lsp_member(root: str = PATH_REFERENCE, **extra: Any) -> Dict[str, Any]:
    """A minimal LSP declaration member pointing at the workspace."""
    return {
        "command": ["fake-langserver", "--stdio"],
        "workspaceRoot": root,
        "extensions": [".py"],
        "enable": True,
        **extra,
    }


def plant_shim(folder: Path, name: str = "fake-langserver") -> Path:
    """Both spellings of one command in ``folder`` — never run by a test.

    The extensionless file is the POSIX program (its executable bit is what the
    lookup honours there); the ``.cmd`` beside it is what Windows can resolve,
    since ``shutil.which`` matches only ``PATHEXT`` forms. A folder with just the
    script is the *not-installed* case on Windows, so the tests that mean
    "installed" plant the pair — Volta's shape, and the one the hub spawns.
    """
    folder.mkdir(parents=True, exist_ok=True)
    shim = folder / name
    shim.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    os.chmod(shim, 0o755)  # the POSIX half; a no-op on NTFS
    (folder / f"{name}.cmd").write_text("@echo off\r\nexit /b 0\r\n", encoding="utf-8")
    return shim


# -- the connection, resolved once, in the app's existing words ----------------


class TestTheConnectionIsResolvedOncePerRequest:
    def test_an_agent_with_no_model_is_refused_in_the_chats_own_sentence(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """§10's one real gate, proven against the string the chat answers with.

        "Reused verbatim, never rewritten for this feature" is only true if the
        two routes say the same thing, so the two answers are compared rather than
        each being compared to a builder.
        """
        from tests.conftest import clear_agent_model, write_store_connection

        write_store_connection(tmp_path, serverUrl="http://x/v1", endpoint="m")
        clear_agent_model(AGENT)
        root = a_project(tmp_path / "project", "main.py")

        wizard = client.post(
            "/api/wizard/propose",
            params=locate(root),
            json={"agentMode": AGENT},
        )
        chat = client.post(
            "/api/chat",
            params=locate(root),
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "agentMode": AGENT,
            },
        )

        assert wizard.status_code == 422, wizard.text
        assert chat.status_code == 422, chat.text
        assert wizard.json()["detail"] == chat.json()["detail"]
        assert wizard.json()["detail"] == agent_connection_refusal(
            appdb.resolve_agent(AGENT)[0]
        )
        # And no model was asked, because the refusal arrives before the step.
        assert seam.calls == []

    def test_the_connection_read_reports_the_refusal_the_same_way(
        self, client: TestClient, tmp_path: Path
    ):
        """The buttons' gate reads one verdict and one sentence, not a paraphrase."""
        from tests.conftest import clear_store_connection

        clear_store_connection()
        root = a_project(tmp_path / "project", "main.py")

        body = client.get(
            "/api/wizard/connection", params={**locate(root), "agentMode": AGENT}
        ).json()

        assert body["canRun"] is False
        assert body["refusal"] == agent_connection_refusal(
            appdb.resolve_agent(AGENT)[0]
        )
        assert body["model"] is None

    def test_a_resolvable_agent_answers_three_names_and_no_numbers(
        self, client: TestClient, tmp_path: Path
    ):
        """The header line's whole source: agent, server and model — nothing else."""
        root = a_project(tmp_path / "project", "main.py")

        body = client.get(
            "/api/wizard/connection", params={**locate(root), "agentMode": AGENT}
        ).json()

        assert body["canRun"] is True
        assert body["refusal"] is None
        assert body["agent"] == appdb.resolve_agent(AGENT)[0]["label"]
        assert body["server"] is not None
        assert body["model"] == "wizard-model"
        # No credential, no URL, no sampler: the dialog shows three names (§8).
        text = json.dumps(body)
        assert API_KEY not in text
        assert "http://" not in text
        for key in ("apiKey", "api_key", "serverUrl", "temperature", "topP"):
            assert key not in body, key

    def test_the_connection_is_resolved_exactly_once_per_post(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, seam: Seam,
        tmp_path: Path,
    ):
        """One resolution at the step's start — the chat's rule, per request.

        Counted at the seam the route calls, so "once" is measured rather than
        assumed: a second resolution inside a step would be the drift a mid-dialog
        settings save would exploit.
        """
        calls: List[Dict[str, Any]] = []
        real = routes.load_endpoints_config

        def counting(agent: Any) -> Any:
            calls.append(dict(agent))
            return real(agent)

        monkeypatch.setattr(routes, "load_endpoints_config", counting)
        root = a_project(tmp_path / "project", "main.py")
        seam.answer = {"servers": [a_proposal()]}

        response = client.post(
            "/api/wizard/propose", params=locate(root), json={"agentMode": AGENT}
        )

        assert response.status_code == 200, response.text
        assert len(calls) == 1
        assert calls[0]["id"] == AGENT
        # The connection the one resolution produced is the one the seam saw.
        assert seam.calls[0]["model"] == "wizard-model"
        assert seam.calls[0]["api_key"] == API_KEY

    def test_an_agent_id_naming_no_row_is_a_422_naming_the_field(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """Never a silent default agent (D5): the field is named, the list offered."""
        root = a_project(tmp_path / "project", "main.py")

        for path, body in (
            ("/api/wizard/propose", {"agentMode": "ghost"}),
            (
                "/api/wizard/prepare",
                {"agentMode": "ghost", "family": "mcp", "candidate": {"id": "fetch"}},
            ),
        ):
            response = client.post(path, params=locate(root), json=body)
            assert response.status_code == 422, (path, response.text)
            detail = response.json()["detail"]
            assert detail.startswith("agentMode:"), (path, detail)
            assert "'ghost'" in detail
            # The message lists what *is* available, so the fix is in it.
            assert AGENT in detail
        assert seam.calls == []

    def test_an_unknown_family_is_a_422_naming_the_field(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        root = a_project(tmp_path / "project", "main.py")

        response = client.post(
            "/api/wizard/prepare",
            params=locate(root),
            json={"agentMode": AGENT, "family": "css", "candidate": {}},
        )

        assert response.status_code == 422
        assert response.json()["detail"].startswith("family:")
        assert seam.calls == []


# -- workspace scope: the folder the request names -----------------------------


class TestTheScanAndBothPostsAnswerAboutTheFoldersTheyName:
    def test_two_folders_are_scanned_about_themselves(
        self, client: TestClient, tmp_path: Path
    ):
        """Two ``tmp_path`` folders side by side, each answered about its own."""
        first = a_project(tmp_path / "python-project", "a.py", "b.py", "c.py")
        second = a_project(tmp_path / "css-project", "one.css", "two.css")

        first_facts = client.get("/api/wizard/scan", params=locate(first)).json()[
            "facts"
        ]
        second_facts = client.get("/api/wizard/scan", params=locate(second)).json()[
            "facts"
        ]

        assert first_facts["extensions"][0] == {
            "extension": ".py", "count": 3, "servers": []
        }
        assert second_facts["extensions"][0] == {
            "extension": ".css", "count": 2, "servers": []
        }
        assert first_facts["fileCount"] == 3
        assert second_facts["fileCount"] == 2

    def test_the_posts_hand_the_model_the_named_folders_facts(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """The facts a step receives are this request's folder's, in either order."""
        first = a_project(tmp_path / "python-project", "a.py", "b.py")
        second = a_project(tmp_path / "css-project", "one.css")
        seam.answer = {"servers": [a_proposal()]}

        for root, extension in ((first, ".py"), (second, ".css")):
            response = client.post(
                "/api/wizard/propose", params=locate(root), json={"agentMode": AGENT}
            )
            assert response.status_code == 200, response.text
            facts = seam.facts()
            assert facts["extensions"][0]["extension"] == extension
            # The declaration file named is that folder's own.
            assert response.json()["declarationPath"].startswith(str(root))

        assert len(seam.calls) == 2

    def test_a_refused_folder_is_the_seams_422_and_nothing_was_scanned(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """The field is asked first, so no answer is ever about another folder."""
        ghost = tmp_path / "no-such-project"
        seam.answer = {"servers": [a_proposal()]}

        scan = client.get("/api/wizard/scan", params=locate(ghost))
        propose = client.post(
            "/api/wizard/propose", params=locate(ghost), json={"agentMode": AGENT}
        )
        prepare = client.post(
            "/api/wizard/prepare",
            params=locate(ghost),
            json={"agentMode": AGENT, "family": "mcp", "candidate": {"id": "fetch"}},
        )

        for response in (scan, propose, prepare):
            assert response.status_code == 422, response.text
            assert "no-such-project" in response.json()["detail"]
        assert seam.calls == []
        # And the refusal is the seam's own sentence, not a new one here.
        from src.core import workspace as workspace_seam

        _resolved, sentence = workspace_seam.resolve(str(ghost))
        assert scan.json()["detail"] == sentence

    def test_the_scan_fills_the_declared_ids_in_from_the_loaders(
        self, client: TestClient, tmp_path: Path
    ):
        """A route is the one that joins the hubs' loaders to the scan's data."""
        root = a_project(tmp_path / "project", "main.py")
        write_json(
            root / ".nojae" / "mcp-settings.json",
            {"console": {"type": "local", "enable": False,
                         "command": ["python", "console_mcp.py"]}},
        )
        write_json(
            root / ".nojae" / "lsp-settings.json",
            {"python": {"command": ["python", "-m", "pylsp"],
                        "workspaceRoot": str(root),
                        "extensions": [".py"]}},
        )

        facts = client.get("/api/wizard/scan", params=locate(root)).json()["facts"]

        assert facts["declared"]["mcp"] == ["console"]
        assert facts["declared"]["lsp"] == [{"id": "python", "extensions": [".py"]}]
        # The already-served language is named as served, which is the gap rule.
        assert facts["extensions"][0]["servers"] == ["python"]

    def test_the_gap_and_the_served_language_reach_the_model_apart(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """AC-4/5's provable half: the model is *given* the distinction it ranks on.

        The ranking itself is the model's judgement, and no test can make a model
        rank — what can be asserted, and is asserted here, is that the payload the
        propose step receives states the two facts the spec's ordering rule reads:
        a language the folder holds and nothing serves (``servers: []``, the gap
        that leads), and a language something already covers (which must not lead).
        If the route's join dropped the extensions, both would look like gaps and
        the rule would be unimplementable — so this is the row that keeps AC-4/5
        reachable at all.
        """
        root = a_project(tmp_path / "mixed-project", "a.py", "b.py", "site.css")
        write_json(
            root / ".nojae" / "lsp-settings.json",
            {"python": {"command": ["python", "-m", "pylsp"],
                        "workspaceRoot": str(root),
                        "extensions": [".py"]}},
        )
        seam.answer = {"servers": [a_proposal()]}

        response = client.post(
            "/api/wizard/propose", params=locate(root), json={"agentMode": AGENT}
        )
        assert response.status_code == 200, response.text

        by_extension = {
            item["extension"]: item for item in seam.facts()["extensions"]
        }
        # The gap: CSS here, nothing declared for it — the case AC-4 names.
        assert by_extension[".css"] == {"extension": ".css", "count": 1, "servers": []}
        # The served language: named as served, so it cannot lead.
        assert by_extension[".py"]["servers"] == ["python"]
        # And the count ordering the gap rule reads off: Python leads the list.
        assert [item["extension"] for item in seam.facts()["extensions"]][0] == ".py"


# -- installation scope: a vanished folder cannot break these reads ------------


class TestTheCatalogueAndTheConnectionAreTheInstallations:
    def test_both_reads_answer_about_a_folder_that_is_not_one(
        self, client: TestClient, tmp_path: Path
    ):
        """A tab whose folder was deleted must still open the dialog (§4.2)."""
        garbage = tmp_path / "was-a-project"
        for params in (
            {"workspace": "a-folder-that-cannot-be-one"},
            locate(garbage),
            locate("relative/name"),
        ):
            catalogue = client.get("/api/wizard/catalogue", params=params)
            connection = client.get(
                "/api/wizard/connection", params={**params, "agentMode": AGENT}
            )
            assert catalogue.status_code == 200, catalogue.text
            assert connection.status_code == 200, connection.text
            assert "entries" in catalogue.json()
            assert connection.json()["canRun"] is True

    def test_the_catalogue_is_the_committed_nine_and_no_model_ran(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """Page 1's MCP list is a file read: opening it runs nothing."""
        root = a_project(tmp_path / "project", "main.py")

        body = client.get("/api/wizard/catalogue", params=locate(root)).json()

        assert len(body["entries"]) == 9
        assert {"playwright", "context7", "sqlite"} <= {
            entry["id"] for entry in body["entries"]
        }
        assert body["notes"] == []
        for entry in body["entries"]:
            assert set(entry) == {
                "id", "identity", "member", "requirements", "relevance"
            }
        assert seam.calls == [], "opening the MCP list ran a model"

    def test_an_unusable_store_still_answers_a_sentence(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """A damaged store is a named state beside the refusal, never a 500.

        The button reads this route to explain why it is inert, so a store this
        read cannot open is exactly when it must answer rather than crash — the
        same rule the agents read holds.
        """
        from src.core import appdb as store

        def broken(*_args: Any, **_kwargs: Any) -> Any:
            raise store.AppStoreError("nojae's settings store is not readable")

        monkeypatch.setattr(store, "model_row", broken)
        root = a_project(tmp_path / "project", "main.py")

        response = client.get(
            "/api/wizard/connection", params={**locate(root), "agentMode": AGENT}
        )

        assert response.status_code == 200, response.text
        body = response.json()
        # A read that cannot name the model says so through the refusal it
        # already answered with — never by leaving `canRun` true beside two nulls,
        # which would hide the reason the button is inert.
        assert body["model"] is None
        assert body["server"] is None
        assert body["canRun"] is False
        assert body["refusal"]

    def test_an_unreadable_catalogue_is_a_sentence_not_a_silent_empty_list(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """A damaged install is a named state, the loader's own convention."""
        oops = tmp_path / "catalog-mcp.json"
        oops.write_text("{ not json", encoding="utf-8")
        monkeypatch.setattr(mcp_constants, "MCP_CATALOGUE_PATH", oops)

        body = client.get(
            "/api/wizard/catalogue", params=locate(tmp_path / "project")
        ).json()

        assert body["entries"] == []
        assert len(body["notes"]) == 1
        assert "catalog-mcp.json" in body["notes"][0]


# -- no hub is acquired --------------------------------------------------------


class TestDiscoveryNeedsNoHub:
    def test_a_folder_with_no_declaration_file_at_all_still_answers(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, seam: Seam,
        tmp_path: Path,
    ):
        """The hub-free path: scan, propose and prepare over an unseeded folder.

        The pool's admission is poisoned, so a route that reached for a hub set —
        the panel routes' habit — fails here instead of starting a process.
        """
        root = a_project(tmp_path / "virgin-project", "main.py")
        poison_hub_acquisition(monkeypatch, client)
        seam.answer = {"servers": [a_proposal()]}

        scan = client.get("/api/wizard/scan", params=locate(root))
        propose = client.post(
            "/api/wizard/propose", params=locate(root), json={"agentMode": AGENT}
        )
        assert scan.status_code == 200, scan.text
        assert propose.status_code == 200, propose.text
        assert propose.json()["outcome"] == "ok"
        assert [item["id"] for item in propose.json()["proposals"]] == [
            "fake-langserver"
        ]
        # And the app left no reserved folder behind: a scan writes nothing.
        assert not (root / ".nojae").exists()

        seam.answer = a_prepared(lsp_member(), declared_id="fake-langserver")
        prepare = client.post(
            "/api/wizard/prepare",
            params=locate(root),
            json={
                "agentMode": AGENT,
                "family": "lsp",
                "candidate": a_proposal(),
            },
        )
        assert prepare.status_code == 200, prepare.text
        assert prepare.json()["outcome"] == "ok"
        assert prepare.json()["snippet"]

    def test_a_folder_whose_hub_was_refused_is_still_preparable(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, seam: Seam,
        tmp_path: Path,
    ):
        """The pool may refuse a folder; a declaration can always be prepared.

        The refusal is planted on the pool's own admission answer — the state a
        workspace at the ceiling is in — and every wizard route still answers,
        because discovery reads the loaders rather than a hub set.
        """
        root = a_project(tmp_path / "crowded-project", "main.py")
        pool = client.app.state.hubpool

        def refused(*_args: Any, **_kwargs: Any) -> Any:
            from src.core.hubpool import Acquisition

            return Acquisition(None, built=False, refusal="too many workspaces")

        async def refused_async(*_args: Any, **_kwargs: Any) -> Any:
            return refused()

        monkeypatch.setattr(pool, "acquire", refused_async)
        monkeypatch.setattr(pool, "acquire_sync", refused)
        seam.answer = a_prepared(lsp_member(), declared_id="fake-langserver")

        scan = client.get("/api/wizard/scan", params=locate(root))
        prepare = client.post(
            "/api/wizard/prepare",
            params=locate(root),
            json={"agentMode": AGENT, "family": "lsp", "candidate": a_proposal()},
        )

        assert scan.status_code == 200, scan.text
        assert prepare.status_code == 200, prepare.text
        assert prepare.json()["outcome"] == "ok"


# -- nothing writes ------------------------------------------------------------


class TestNoRouteWrites:
    #: ``(verb, path, query, body)`` — the query half is only ever ``agentMode``,
    #: which the connection read takes as a parameter because a GET has no body.
    ENDPOINTS: Tuple[Tuple[str, str, Dict[str, str], Optional[Dict[str, Any]]], ...] = (
        ("get", "/api/wizard/catalogue", {}, None),
        ("get", "/api/wizard/connection", {"agentMode": AGENT}, None),
        ("get", "/api/wizard/scan", {}, None),
        ("post", "/api/wizard/propose", {}, {"agentMode": AGENT}),
        (
            "post",
            "/api/wizard/prepare",
            {},
            {"agentMode": AGENT, "family": "mcp", "candidate": {"id": "fetch"}},
        ),
        (
            "post",
            "/api/wizard/prepare",
            {},
            {"agentMode": AGENT, "family": "lsp", "candidate": a_proposal()},
        ),
    )

    def test_every_endpoint_leaves_the_tree_byte_identical(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """Bytes **and** mtimes: a read that touched a file would show here.

        The workspace is fully furnished first — a policy file, both declarations,
        a manifest — so a route that rewrote one, seeded one or backed one up
        changes the snapshot. Nothing is created where nothing existed either.
        """
        root = a_project(tmp_path / "furnished-project", "main.py", "package.json")
        write_json(root / ".nojae" / "read-write-policy.json", {"version": 1, "rules": []})
        write_json(
            root / ".nojae" / "mcp-settings.json",
            {"console": {"type": "local", "enable": True,
                         "command": ["python", "console_mcp.py"]}},
        )
        write_json(root / ".nojae" / "lsp-settings.json", {})
        before = snapshot(root)
        assert before, "the fixture wrote nothing to snapshot"

        seam.answer = {"servers": [a_proposal()]}
        for verb, path, query, body in self.ENDPOINTS:
            if path == "/api/wizard/prepare":
                seam.answer = a_prepared(lsp_member(), declared_id="fake-langserver")
            response = getattr(client, verb)(
                path,
                params={**locate(root), **query},
                **({"json": body} if body is not None else {}),
            )
            assert response.status_code == 200, (path, response.text)

        assert snapshot(root) == before


# -- no secret leaves the server -----------------------------------------------


class TestNoAnswerCarriesTheCredential:
    def test_no_wizard_answer_contains_the_stores_api_key(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """§8: the dialog never asks for, and never displays, a secret."""
        root = a_project(tmp_path / "project", "main.py")
        seam.answer = {"servers": [a_proposal()]}

        bodies: List[str] = []
        bodies.append(client.get("/api/wizard/catalogue", params=locate(root)).text)
        bodies.append(
            client.get(
                "/api/wizard/connection", params={**locate(root), "agentMode": AGENT}
            ).text
        )
        bodies.append(client.get("/api/wizard/scan", params=locate(root)).text)
        bodies.append(
            client.post(
                "/api/wizard/propose", params=locate(root), json={"agentMode": AGENT}
            ).text
        )
        seam.answer = a_prepared(lsp_member(), declared_id="fake-langserver")
        bodies.append(
            client.post(
                "/api/wizard/prepare",
                params=locate(root),
                json={"agentMode": AGENT, "family": "lsp", "candidate": a_proposal()},
            ).text
        )

        for text in bodies:
            assert API_KEY not in text

    def test_a_key_bearing_entry_carries_only_the_sentinel(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """AC-8a: the canonical sentinel in the slot, and the page says so."""
        root = a_project(tmp_path / "project", "main.py")
        catalogue = client.get("/api/wizard/catalogue", params=locate(root)).json()
        context7 = next(
            entry for entry in catalogue["entries"] if entry["id"] == "context7"
        )
        seam.answer = a_prepared(context7["member"], declared_id="context7")

        response = client.post(
            "/api/wizard/prepare",
            params=locate(root),
            json={
                "agentMode": AGENT,
                "family": "mcp",
                "candidate": {"id": "context7"},
            },
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["valueForm"] == "sentinel"
        assert SENTINEL in body["snippet"]
        assert SENTINEL in json.dumps(body["member"])
        assert "will not authenticate until" in body["valueWarning"]
        assert SENTINEL in body["valueWarning"]
        assert API_KEY not in response.text
        # The model was handed the catalogue's member, not a body's own copy.
        assert seam.candidate() == context7["member"]


# -- the member, the path, and the verdict -------------------------------------


class TestPrepareAnswersWithAMemberAndAPath:
    def test_a_present_declaration_yields_its_absolute_path_and_existence(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        root = a_project(tmp_path / "project", "main.py")
        declaration = write_json(root / ".nojae" / "mcp-settings.json", {})
        seam.answer = a_prepared(
            {"type": "local", "enable": True, "command": ["uvx", "mcp-server-fetch"]},
            declared_id="fetch",
        )

        body = client.post(
            "/api/wizard/prepare",
            params=locate(root),
            json={"agentMode": AGENT, "family": "mcp", "candidate": {"id": "fetch"}},
        ).json()

        assert Path(body["declarationPath"]).is_absolute()
        assert Path(body["declarationPath"]) == declaration.absolute()
        assert body["declarationExists"] is True
        # A **member**, never a file: one key, and it parses inside a top level.
        decoded = json.loads("{" + body["snippet"] + "}")
        assert list(decoded) == ["fetch"]
        assert decoded["fetch"] == body["member"]

    def test_a_missing_declaration_is_a_path_and_a_flag_not_a_new_file(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """AC-19: the shape never changes; only the sentence about the file does."""
        root = a_project(tmp_path / "project", "main.py")
        seam.answer = a_prepared(lsp_member(), declared_id="fake-langserver")

        body = client.post(
            "/api/wizard/prepare",
            params=locate(root),
            json={"agentMode": AGENT, "family": "lsp", "candidate": a_proposal()},
        ).json()

        assert body["declarationExists"] is False
        assert Path(body["declarationPath"]).is_absolute()
        assert body["declarationPath"].endswith("lsp-settings.json")
        decoded = json.loads("{" + body["snippet"] + "}")
        assert list(decoded) == ["fake-langserver"]
        assert not Path(body["declarationPath"]).exists()

    def test_a_refused_member_is_refused_in_the_loaders_own_words(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """AC-9: the verdict is the loader's, and it names the field."""
        root = a_project(tmp_path / "project", "main.py")
        seam.answer = a_prepared(
            lsp_member(workspaceRoot="a/relative/root"), declared_id="broken"
        )

        body = client.post(
            "/api/wizard/prepare",
            params=locate(root),
            json={"agentMode": AGENT, "family": "lsp", "candidate": a_proposal()},
        ).json()

        assert body["accepted"] is False
        assert body["offered"] is False
        assert "workspaceRoot" in body["verdict"]
        assert "lsp-settings.json" in body["verdict"]
        # The member is still handed back: the user edits it, the page shows it.
        assert json.loads("{" + body["snippet"] + "}")["broken"] == {
            **lsp_member(workspaceRoot="a/relative/root")
        }

    def test_a_program_that_is_not_on_the_path_is_not_installed(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """AC-8: readiness, resolved the way the hub resolves it — never spawned."""
        root = a_project(tmp_path / "project", "main.py")
        empty = tmp_path / "empty-bin"
        empty.mkdir()
        seam.answer = a_prepared(
            lsp_member(env={"PATH": str(empty)}), declared_id="fake-langserver"
        )

        body = client.post(
            "/api/wizard/prepare",
            params=locate(root),
            json={"agentMode": AGENT, "family": "lsp", "candidate": a_proposal()},
        ).json()

        assert body["readiness"] == "not installed"
        assert body["program"] is None
        assert body["searched"] == str(empty)
        assert body["offered"] is True, "a not-installed candidate is still offered"

    def test_a_program_on_the_childs_path_looks_installed(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        root = a_project(tmp_path / "project", "main.py")
        bin_dir = tmp_path / "bin"
        plant_shim(bin_dir)
        seam.answer = a_prepared(
            lsp_member(env={"PATH": str(bin_dir)}), declared_id="fake-langserver"
        )

        body = client.post(
            "/api/wizard/prepare",
            params=locate(root),
            json={"agentMode": AGENT, "family": "lsp", "candidate": a_proposal()},
        ).json()

        assert body["readiness"] == "looks installed"
        assert Path(body["program"]).name.lower().startswith("fake-langserver")
        assert body["searched"] is None

    def test_a_duplicate_id_is_a_warning_and_the_snippet_is_still_offered(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """AC-11: nothing changes until the user pastes it."""
        root = a_project(tmp_path / "project", "main.py")
        write_json(
            root / ".nojae" / "lsp-settings.json",
            {"fake": {"command": ["other"], "workspaceRoot": str(root)}},
        )
        seam.answer = a_prepared(lsp_member(), declared_id="fake")

        body = client.post(
            "/api/wizard/prepare",
            params=locate(root),
            json={"agentMode": AGENT, "family": "lsp", "candidate": a_proposal()},
        ).json()

        assert body["duplicate"] is not None
        assert "already declares an entry of that id" in body["duplicate"]
        assert body["offered"] is True
        assert body["snippet"]

    def test_the_catalogues_install_line_wins_for_mcp(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """Never invents a line: a curated entry's install line is the curated one."""
        root = a_project(tmp_path / "project", "main.py")
        catalogue = client.get("/api/wizard/catalogue", params=locate(root)).json()
        fetch = next(entry for entry in catalogue["entries"] if entry["id"] == "fetch")
        seam.answer = a_prepared(fetch["member"], declared_id="fetch")

        body = client.post(
            "/api/wizard/prepare",
            params=locate(root),
            json={"agentMode": AGENT, "family": "mcp", "candidate": {"id": "fetch"}},
        ).json()

        assert body["install"] == {
            platform: item["install"]
            for platform, item in fetch["requirements"]["requires"].items()
        }
        assert "a-line-the-model-invented" not in json.dumps(body)
        assert body["requiresInstall"] is True
        assert body["decisions"] == ["the workspace root is the project root"]

    def test_an_unknown_catalogue_entry_is_a_422_naming_the_candidate(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """The catalogue is the only source of a package name, so it is looked up."""
        root = a_project(tmp_path / "project", "main.py")

        response = client.post(
            "/api/wizard/prepare",
            params=locate(root),
            json={"agentMode": AGENT, "family": "mcp", "candidate": {"id": "mine"}},
        )

        assert response.status_code == 422
        assert response.json()["detail"].startswith("candidate:")
        assert seam.calls == []


# -- the three outcomes, and one attempt ---------------------------------------


class TestTheModelStepsAnswerAtTwoHundred:
    def test_a_failed_call_is_a_failed_outcome_and_a_sentence_at_200(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """A 5xx would read like the app's fault and invite a retry loop (§5)."""
        from src.core.llmkit import LLMRequestError

        root = a_project(tmp_path / "project", "main.py")
        seam.failure = LLMRequestError(
            503, "upstream is warming up", "http://wizard.test:8080/v1/chat/completions"
        )

        response = client.post(
            "/api/wizard/propose", params=locate(root), json={"agentMode": AGENT}
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["outcome"] == "failed"
        assert "503" in body["sentence"]
        assert body["proposals"] == []
        # **One** attempt at the transport too — no waiting, no second call.
        assert len(seam.calls) == 1

    def test_an_empty_answer_is_its_own_sentence_not_a_failure(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """AC-7: "nothing fits" and "the model could not be reached" must differ."""
        root = a_project(tmp_path / "project", "main.py")
        seam.answer = {"servers": []}
        empty = client.post(
            "/api/wizard/propose", params=locate(root), json={"agentMode": AGENT}
        ).json()

        from src.core.llmkit import LLMRequestError

        seam.failure = LLMRequestError(
            400, "the model is not loaded", "http://wizard.test:8080/v1/chat/completions"
        )
        failed = client.post(
            "/api/wizard/propose", params=locate(root), json={"agentMode": AGENT}
        ).json()

        assert empty["outcome"] == "empty"
        assert failed["outcome"] == "failed"
        assert empty["sentence"] != failed["sentence"]
        assert empty["declarationPath"] == failed["declarationPath"]

    def test_a_garbage_answer_is_a_third_sentence(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        root = a_project(tmp_path / "project", "main.py")
        seam.answer = "I could not decide, here is prose instead"

        body = client.post(
            "/api/wizard/propose", params=locate(root), json={"agentMode": AGENT}
        ).json()

        assert body["outcome"] == "failed"
        assert "could not be read" in body["sentence"]
        assert len(seam.calls) == 1

    def test_a_failed_prepare_still_names_the_declaration_file(
        self, client: TestClient, seam: Seam, tmp_path: Path
    ):
        """The stop sentence needs a path even when no member came back."""
        root = a_project(tmp_path / "project", "main.py")
        seam.answer = "no member for you"

        response = client.post(
            "/api/wizard/prepare",
            params=locate(root),
            json={"agentMode": AGENT, "family": "mcp", "candidate": {"id": "fetch"}},
        )

        assert response.status_code == 200, response.text
        body = response.json()
        assert body["outcome"] == "failed"
        assert body["snippet"] is None
        assert Path(body["declarationPath"]).is_absolute()
        assert body["declarationExists"] is False


# -- the write-surface promise, as this file's own shape -----------------------


class TestTheWizardRoutesAreNotAWriteSurface:
    """AC-14's route half: values arrive, statuses leave, nothing is written.

    The structural guard lives in ``tests/test_write_surface_isolation.py``; this
    is the local statement of the same promise, so a reader of these routes' tests
    sees it beside them: no wizard route names a declaration writer, a ``/api/fs``
    write, the seeding path, a subprocess spawn or a settings-store write.
    """

    #: The declaration writers, the Editor's write core, the seeding path, a
    #: spawn, the store's writes, and the Editor's write routes — spelled the way
    #: a caller would, so prose naming a *read* stays out of the scan.
    FORBIDDEN = (
        "set_externals_enabled",
        "set_lsp_enabled",
        "ensure_mcp_settings_file",
        "write_file",
        "create_path",
        "trash_path",
        "rename_path",
        "move_paths_batch",
        "subprocess",
        "Popen",
        "appdb.add_",
        "appdb.update_",
        "appdb.delete_",
        "PUT /api/fs",
        "POST /api/fs",
        "DELETE /api/fs",
    )

    def test_no_wizard_handler_names_a_write_or_a_spawn(self):
        source = Path(routes.__file__).read_text(encoding="utf-8")
        start = source.index("# -- the connector wizard's routes")
        end = source.index("# -- the agents routes (appdb-10)")
        block = source[start:end]
        for marker in self.FORBIDDEN:
            assert marker not in block, marker

    def test_the_five_routes_are_reads_and_two_conversationless_posts(self):
        """The surface is exactly what §11 names: three reads, two model posts."""
        registrations = {
            (verb, path)
            for verb, path in _wizard_registrations()
        }
        assert registrations == {
            ("get", "/wizard/catalogue"),
            ("get", "/wizard/connection"),
            ("get", "/wizard/scan"),
            ("post", "/wizard/propose"),
            ("post", "/wizard/prepare"),
        }

    def test_the_write_marker_scan_leaves_the_wizard_out(self):
        """The guard is *shown* to leave these routes out of the write surface.

        ``tests/test_write_surface_isolation.py``'s marker scan walks
        ``src/core`` and the connectors, and its markers are the write routes'
        **verb-and-path** spellings. This asks that scan about the wizard's own
        files, and asks each wizard route's spelling against the markers: no
        match either way, which is what makes "a read is invisible to the scan" a
        fact rather than a hope. Had this task needed a marker it would have been
        a marker scan change, not a wizard route added to an allow-list.
        """
        from tests.test_write_surface_isolation import WRITE_MARKERS, offenders_for

        wizard_package = Path(routes.__file__).parents[1] / "core" / "wizard"
        assert (wizard_package / "snippet.py").is_file(), wizard_package
        assert offenders_for(WRITE_MARKERS, [wizard_package]) == []
        for _verb, path in _wizard_registrations():
            for marker in WRITE_MARKERS:
                assert marker not in f"/api{path}", (path, marker)


def _wizard_registrations() -> List[Tuple[str, str]]:
    """Every wizard route ``routes.py`` registers, read out of its decorators."""
    import ast

    source = Path(routes.__file__).read_text(encoding="utf-8")
    found: List[Tuple[str, str]] = []
    for node in ast.walk(ast.parse(source)):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            call = decorator if isinstance(decorator, ast.Call) else None
            if call is None or not isinstance(call.func, ast.Attribute):
                continue
            if not call.args or not isinstance(call.args[0], ast.Constant):
                continue
            path = call.args[0].value
            if isinstance(path, str) and path.startswith("/wizard"):
                found.append((call.func.attr, path))
    return sorted(found)
