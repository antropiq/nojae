"""The acceptance sweep for the client-owned working location (clws-14).

This file turns the spec's §10 — behaviour written so a person can perform it —
into assertions wherever a server process can honestly show the fact. Each
class below is one §10 item, and each case quotes the item it proves.

**The two items a person still has to run** are stated here so this file never
pretends to cover them:

1. two replies streaming on two **real** models, with each turn's tool answers
   naming its own folder;
2. Pause in A stopping A only, on those real streams.

Both are items of the manual checklist written by clws-13:
``docs/client-owned-workspace-smoke-checklist.md``. Everything else that can be
asserted hermetically is asserted here: stubbed ``stream_chat``, the pool's
disabled hubs, and a temporary settings store.

Items 6 and 10 keep their older homes where one exists:

* item 6 (a batch in A while a conversation runs in B) is the conjunction of
  ``tests/test_batch.py::TestTheLotIsTheFoldersOwn`` (each folder's own lot) and
  ``tests/test_chat.py::TestTwoTurnsAtOnce`` (two concurrent turns). This file
  restates the conjunction once, because no existing case joins them.
* item 10 (a closed tab cancels its own turn only) is
  ``tests/test_chat.py::TestAClosedTabCancelsItsOwnTurnOnly``. It is **not**
  duplicated here; that class is the home of the item.

Every folder named below is a ``tmp_path`` one, every model is a stub, and the
invariant scans read the source the way ``tests/test_write_surface_isolation.py``
does: each one is fed a deliberately poisoned input so the guard is shown to
have teeth.
"""

import ast
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

import pytest
from fastapi.testclient import TestClient

from src import config as config_module
from src.api import routes
from src.api.server import create_app
from src.core import editorfs
from src.core import workspace
from src.core.models import EndpointsConfig
from tests.conftest import neutralise_store, workspace_params

REPO_ROOT = Path(config_module.PROJECT_ROOT).resolve()


# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
    """The app on this test's own store, with the one outbound probe stubbed.

    ``GET /api/config`` asks the configured server for a context window; that is
    a real endpoint, so the probe is replaced here exactly as ``tests/test_api.py``
    replaces it. Everything else the app answers comes from rows this test wrote.
    """
    neutralise_store(monkeypatch, tmp_path)
    monkeypatch.setattr(
        routes, "_context_window", lambda server_url, api_key, model: None
    )
    with TestClient(create_app()) as http:
        yield http


def folder(root: Path, *names: str) -> Path:
    """Create ``root`` with one file per name (parents included)."""
    root.mkdir(parents=True, exist_ok=True)
    for name in names:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(f"{name}\n", encoding="utf-8", newline="")
    return root


def tree_names(client: TestClient, root: Path) -> List[str]:
    """The root listing of one workspace, by name."""
    response = client.get("/api/fs/tree", params=workspace_params(root))
    assert response.status_code == 200, response.text
    return [entry["name"] for entry in response.json()["entries"]]


def write_policy(root: Path, rules: List[Dict[str, str]]) -> None:
    """Leave ``root`` the read/write policy file a user would have written."""
    reserved = root / editorfs.constants.POLICY_DIRNAME
    reserved.mkdir(parents=True, exist_ok=True)
    (reserved / editorfs.constants.POLICY_FILENAME).write_text(
        json.dumps(
            {"version": editorfs.constants.POLICY_VERSION, "policies": rules},
        ),
        encoding="utf-8",
    )


def write_connectors(root: Path, document: Dict[str, Any]) -> None:
    """Leave ``root`` its own MCP declaration, so admission does not seed one."""
    reserved = root / editorfs.constants.POLICY_DIRNAME
    reserved.mkdir(parents=True, exist_ok=True)
    (reserved / "mcp-settings.json").write_text(
        json.dumps(document), encoding="utf-8"
    )


def connection(agent_id: str) -> EndpointsConfig:
    """A stub server and a distinct model for one agent — never a real endpoint."""
    return EndpointsConfig(
        serverUrl=f"http://stub-{agent_id}.invalid/v1",
        endpoint=f"model-{agent_id}",
    )


def events(body: str) -> List[Tuple[str, Dict[str, Any]]]:
    """The ``(event, payload)`` frames of one SSE response."""
    parsed: List[Tuple[str, Dict[str, Any]]] = []
    for frame in body.strip().split("\n\n"):
        name = None
        data = None
        for line in frame.split("\n"):
            if line.startswith("event: "):
                name = line[len("event: "):]
            elif line.startswith("data: "):
                data = json.loads(line[len("data: "):])
        if name is not None:
            parsed.append((name, data or {}))
    return parsed


def post_chat(
    client: TestClient,
    root: Path,
    agent_mode: str,
    *,
    batch_context: Optional[str] = None,
):
    """One chat request naming ``root`` and answering as ``agent_mode``."""
    body: Dict[str, Any] = {
        "messages": [{"role": "user", "content": "hi"}],
        "agentMode": agent_mode,
    }
    if batch_context is not None:
        body["batchContext"] = batch_context
    return client.post("/api/chat", params=workspace_params(root), json=body)


def start_concurrently(
    jobs: Dict[str, Any]
) -> Tuple[List[threading.Thread], Dict[str, Any], Dict[str, BaseException]]:
    """Start one callable per label on its own thread; join them separately.

    ``run_concurrently`` is for turns that finish by themselves. A case that has
    to act **while** the turns are in flight (a save, a Pause) starts them here,
    acts, and only then joins.
    """
    results: Dict[str, Any] = {}
    errors: Dict[str, BaseException] = {}

    def run(label: str, job: Any) -> None:
        try:
            results[label] = job()
        except BaseException as exc:  # noqa: BLE001 — surfaced by the caller
            errors[label] = exc

    threads = [
        threading.Thread(target=run, args=(label, job))
        for label, job in jobs.items()
    ]
    for thread in threads:
        thread.start()
    return threads, results, errors


def join_concurrently(threads: List[threading.Thread], timeout: float = 20) -> None:
    for thread in threads:
        thread.join(timeout=timeout)
        assert thread.is_alive() is False, "a concurrent turn never finished"


def run_concurrently(jobs: Dict[str, Any]) -> Tuple[Dict[str, Any], Dict[str, BaseException]]:
    """Run one callable per label on its own thread; collect answers and errors."""
    threads, results, errors = start_concurrently(jobs)
    join_concurrently(threads)
    return results, errors


def two_agent_streams(
    client: TestClient,
    monkeypatch: pytest.MonkeyPatch,
    first: Path,
    second: Path,
) -> Tuple[List[Dict[str, Any]], Dict[str, Any], List[str]]:
    """Stream two turns at once, each naming its own folder and its own agent.

    ``first`` answers as ``chat`` and ``second`` as ``code``. The stub records
    the resolved agent, model, server URL and the turn's ``current_root()``, and
    a barrier makes the two workers overlap — a serialised app turns the reply
    into an error rather than a flaky pass.
    """
    barrier = threading.Barrier(2, timeout=10)
    records: List[Dict[str, Any]] = []
    seen_agents: List[str] = []

    def load(agent: Dict[str, Any]) -> Tuple[EndpointsConfig, Optional[str]]:
        seen_agents.append(agent["id"])
        return connection(agent["id"]), None

    def fake(
        messages,
        model,
        server_url,
        emit,
        sampling=None,
        cancel_event=None,
        pause_event=None,
        api_key="none",
        sysprompt=None,
        agent_instructions=None,
        mode_instructions=None,
        **tool_kwargs,
    ):
        records.append(
            {
                "model": model,
                "server_url": server_url,
                "root": workspace.current_root(),
                "batch_instructions": tool_kwargs.get("batch_instructions"),
            }
        )
        barrier.wait()
        emit({"event": "token", "text": f"{model}:0"})
        emit({"event": "token", "text": f"{model}:1"})
        emit(
            {
                "event": "done",
                "took": 0.0,
                "ttft": 0.0,
                "tokens": 2,
                "tokensEstimated": False,
            }
        )

    monkeypatch.setattr(routes, "load_endpoints_config", load)
    monkeypatch.setattr(routes, "stream_chat", fake)

    results, errors = run_concurrently(
        {
            "first": lambda: post_chat(client, first, "chat"),
            "second": lambda: post_chat(client, second, "code"),
        }
    )
    assert not errors, errors
    return records, results, seen_agents


# ---------------------------------------------------------------------------
# §10 item 1 — two folders, one process
# ---------------------------------------------------------------------------


class TestItemOneTwoFoldersOneProcess:
    """§10.1: two tabs on the same address, pointed at two repositories."""

    def test_each_tree_lists_its_own_folder(self, client: TestClient, tmp_path: Path):
        """§10.1: "Point one at repository A and the other at repository B."

        The two requests name two different folders and each answer is about the
        folder it named: A's tree lists A's files, B's lists B's.
        """
        first = folder(tmp_path / "project-a", "a-only.txt", "shared.txt")
        second = folder(tmp_path / "project-b", "b-only.txt", "shared.txt")

        assert set(tree_names(client, first)) == {"a-only.txt", "shared.txt"}
        assert set(tree_names(client, second)) == {"b-only.txt", "shared.txt"}

    def test_the_two_requests_write_no_environment_value(
        self, client: TestClient, tmp_path: Path
    ):
        """§10.1's mechanism: no process-wide location is read or written.

        The folder travels in the request, so the environment a request starts
        and ends with is byte-identical — the process holds no "current folder"
        that a second tab could move.
        """
        first = folder(tmp_path / "project-a", "a-only.txt")
        second = folder(tmp_path / "project-b", "b-only.txt")
        before = dict(os.environ)

        tree_names(client, first)
        tree_names(client, second)

        assert dict(os.environ) == before


# ---------------------------------------------------------------------------
# §10 item 2 — two agents, two models
# ---------------------------------------------------------------------------


class TestItemTwoTwoAgentsTwoModels:
    """§10.2: both stream at once, each on its own agent's model.

    The two *human* halves — two real models, and each tool answer naming its own
    folder — are the smoke checklist's. What a stub can honestly show is here:
    two concurrent streams, two resolved agents, two stub servers, and the folder
    each worker sees.
    """

    def test_each_turn_runs_on_its_own_agents_model_and_server(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """§10.2: "Both stream at the same time, each on its own model." """
        first = folder(tmp_path / "project-a")
        second = folder(tmp_path / "project-b")

        records, results, _ = two_agent_streams(
            client, monkeypatch, first, second
        )

        for label in ("first", "second"):
            frames = events(results[label].text)
            assert [name for name, _payload in frames] == ["token", "token", "done"]
        by_model = {record["model"]: record for record in records}
        assert set(by_model) == {"model-chat", "model-code"}
        assert by_model["model-chat"]["server_url"] == "http://stub-chat.invalid/v1"
        assert by_model["model-code"]["server_url"] == "http://stub-code.invalid/v1"

    def test_each_request_carries_its_own_agent_mode(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """§10.2: "In tab A select an agent ... in tab B an agent ..." """
        first = folder(tmp_path / "project-a")
        second = folder(tmp_path / "project-b")

        _, _, seen_agents = two_agent_streams(client, monkeypatch, first, second)

        assert sorted(seen_agents) == ["chat", "code"]

    def test_each_turn_sees_its_own_folder(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """§10.2: "each naming its own folder in its tools' answers."

        Read through the seam inside the turn, which is the value the agent's
        tools resolve against (spec §5.1 rule 9).
        """
        first = folder(tmp_path / "project-a")
        second = folder(tmp_path / "project-b")

        records, _, _ = two_agent_streams(client, monkeypatch, first, second)

        roots = {record["model"]: record["root"] for record in records}
        assert roots == {
            "model-chat": str(first.resolve()),
            "model-code": str(second.resolve()),
        }


# ---------------------------------------------------------------------------
# §10 item 3 — the write, per folder
# ---------------------------------------------------------------------------


class TestItemThreeTheWritePerFolder:
    """§10.3: while A streams, B's save succeeds and A's is refused naming A.

    §10.3's sentence says "while both stream"; the behaviour it is checking is
    §5.3 rules 13–14, and those make the refusal the **workspace's**. A second
    live reply in B would refuse B's save too, so the case that shows both halves
    is A streaming and B idle — the task 04 case, restated here. B is a peer: its
    save is not obstructed by A's reply.
    """

    def test_a_save_in_b_succeeds_while_a_save_in_a_is_refused_naming_a(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """§10.3: "Saving the same way in repository A is refused, naming the reason." """
        first = folder(tmp_path / "project-a", "note.txt")
        second = folder(tmp_path / "project-b", "note.txt")

        started = threading.Event()
        release = threading.Event()

        def fake(
            messages,
            model,
            server_url,
            emit,
            sampling=None,
            cancel_event=None,
            pause_event=None,
            **kwargs,
        ):
            started.set()
            assert release.wait(timeout=10)
            emit(
                {
                    "event": "done",
                    "took": 0.0,
                    "ttft": 0.0,
                    "tokens": 1,
                    "tokensEstimated": False,
                }
            )

        monkeypatch.setattr(
            routes,
            "load_endpoints_config",
            lambda agent: (connection(agent["id"]), None),
        )
        monkeypatch.setattr(routes, "stream_chat", fake)

        threads, results, errors = start_concurrently(
            {"a": lambda: post_chat(client, first, "chat")}
        )
        assert started.wait(timeout=10), "A's turn never started"

        written_b = client.put(
            "/api/fs/file",
            params=workspace_params(second),
            json={"path": "note.txt", "text": "changed in B\n"},
        )
        assert written_b.status_code == 200, written_b.text
        assert (second / "note.txt").read_text(encoding="utf-8") == "changed in B\n"

        refused_a = client.put(
            "/api/fs/file",
            params=workspace_params(first),
            json={"path": "note.txt", "text": "changed in A\n"},
        )
        assert refused_a.status_code == 409, refused_a.text
        assert "while a chat reply is streaming" in refused_a.json()["detail"]
        assert str(first.resolve()) in refused_a.json()["detail"]
        assert (first / "note.txt").read_text(encoding="utf-8") == "note.txt\n"

        release.set()
        join_concurrently(threads)
        assert not errors, errors
        assert [name for name, _p in events(results["a"].text)] == ["done"]


# ---------------------------------------------------------------------------
# §10 item 4 — Pause
# ---------------------------------------------------------------------------


class TestItemFourPause:
    """§10.4: "Pause in tab A stops A's reply only." """

    def _run(self, client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
        first = folder(tmp_path / "project-a")
        second = folder(tmp_path / "project-b")
        started_first = threading.Event()
        started_second = threading.Event()
        acked = threading.Event()
        release_second = threading.Event()

        def fake(
            messages,
            model,
            server_url,
            emit,
            sampling=None,
            cancel_event=None,
            pause_event=None,
            **kwargs,
        ):
            if model == "model-chat":
                assert pause_event is not None
                started_first.set()
                while not pause_event.is_set():
                    time.sleep(0.01)
                emit({"event": "token", "text": "alpha-partial"})
                emit({"event": "pause_ack", "partial": True})
                acked.set()
                return
            started_second.set()
            assert release_second.wait(timeout=10)
            emit({"event": "token", "text": "beta-answer"})
            emit(
                {
                    "event": "done",
                    "took": 0.0,
                    "ttft": 0.0,
                    "tokens": 2,
                    "tokensEstimated": False,
                }
            )

        monkeypatch.setattr(
            routes,
            "load_endpoints_config",
            lambda agent: (connection(agent["id"]), None),
        )
        monkeypatch.setattr(routes, "stream_chat", fake)

        threads, results, errors = start_concurrently(
            {
                "a": lambda: post_chat(client, first, "chat"),
                "b": lambda: post_chat(client, second, "code"),
            }
        )
        assert started_first.wait(timeout=10), "A's turn never started"
        assert started_second.wait(timeout=10), "B's turn never started"

        paused = client.post("/api/chat/pause", params=workspace_params(first))
        assert paused.status_code == 200, paused.text
        assert paused.json() == {"paused": "requested"}
        assert acked.wait(timeout=10), "A's pause_ack never arrived"
        assert not release_second.is_set()

        release_second.set()
        join_concurrently(threads)
        assert not errors, errors
        return first, second, results

    def test_a_ends_on_its_own_pause_ack(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """§10.4: A's partial turn closes on its own ack, with no ``done``."""
        _, _, results = self._run(client, monkeypatch, tmp_path)
        frames = events(results["a"].text)
        assert [name for name, _payload in frames] == ["token", "pause_ack"]
        assert frames[0][1]["text"] == "alpha-partial"

    def test_b_closes_on_its_own_done(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """§10.4: "stops A's reply only." B continues to its own finish."""
        _, _, results = self._run(client, monkeypatch, tmp_path)
        frames = events(results["b"].text)
        assert [name for name, _payload in frames] == ["token", "done"]
        assert frames[0][1]["text"] == "beta-answer"


# ---------------------------------------------------------------------------
# §10 item 5 — the tree and the connectors
# ---------------------------------------------------------------------------


class TestItemFiveTheTreeAndTheConnectors:
    """§10.5: A's files under A's rules; A's connector offered in A, not B."""

    @staticmethod
    def _pair(tmp_path: Path) -> Tuple[Path, Path]:
        first = folder(
            tmp_path / "project-a", "a-only.txt", "shared.txt", "hidden-in-a.txt"
        )
        second = folder(
            tmp_path / "project-b", "b-only.txt", "shared.txt", "hidden-in-b.txt"
        )
        write_policy(first, [{"path": "hidden-in-a.txt", "mode": "hidden"}])
        write_policy(second, [{"path": "hidden-in-b.txt", "mode": "hidden"}])
        return first, second

    def test_each_tree_lists_its_own_files_under_its_own_policy(
        self, client: TestClient, tmp_path: Path
    ):
        """§10.5: "Tab A's tree lists A's files under A's read/write rules." """
        first, second = self._pair(tmp_path)

        listed_a = set(tree_names(client, first))
        listed_b = set(tree_names(client, second))

        assert listed_a == {"a-only.txt", "shared.txt"}
        assert listed_b == {"b-only.txt", "shared.txt"}
        assert "hidden-in-a.txt" not in listed_a
        assert "hidden-in-b.txt" not in listed_b
        assert "b-only.txt" not in listed_a
        assert "a-only.txt" not in listed_b

    def test_a_connector_declared_in_a_is_offered_in_a_and_not_b(
        self, client: TestClient, tmp_path: Path
    ):
        """§10.5: "Repository A's own connectors are offered in A and not in B." """
        first = folder(tmp_path / "project-a")
        second = folder(tmp_path / "project-b")
        write_connectors(
            first,
            {
                "only-in-a": {
                    "type": "remote",
                    "url": "https://a.invalid/mcp",
                    "enable": True,
                }
            },
        )
        write_connectors(second, {})

        offered_a = client.get("/api/mcp", params=workspace_params(first))
        offered_b = client.get("/api/mcp", params=workspace_params(second))
        assert offered_a.status_code == 200, offered_a.text
        assert offered_b.status_code == 200, offered_b.text

        assert [row["id"] for row in offered_a.json()["connectors"]] == ["only-in-a"]
        assert offered_b.json()["connectors"] == []


# ---------------------------------------------------------------------------
# §10 item 6 — a batch and a conversation
# ---------------------------------------------------------------------------


class TestItemSixABatchAndAConversation:
    """§10.6: a batch in A while B holds a normal conversation.

    The listing half of batch-per-workspace is
    ``tests/test_batch.py::TestTheLotIsTheFoldersOwn`` and the concurrent-turn
    half is ``tests/test_chat.py::TestTwoTurnsAtOnce``. This case is the §10
    conjunction asserted once: one task turn of a lot, one ordinary turn, both
    in flight.
    """

    def test_a_batch_in_a_and_a_conversation_in_b_both_progress(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """§10.6: "Both progress; neither blocks the other." """
        first = folder(tmp_path / "project-a")
        second = folder(tmp_path / "project-b")
        barrier = threading.Barrier(2, timeout=10)
        records: List[Dict[str, Any]] = []

        def fake(
            messages,
            model,
            server_url,
            emit,
            sampling=None,
            cancel_event=None,
            pause_event=None,
            agent_instructions=None,
            mode_instructions=None,
            **tool_kwargs,
        ):
            records.append(
                {
                    "model": model,
                    "batch_instructions": tool_kwargs.get("batch_instructions"),
                }
            )
            barrier.wait()
            emit({"event": "token", "text": f"{model}:task"})
            emit(
                {
                    "event": "done",
                    "took": 0.0,
                    "ttft": 0.0,
                    "tokens": 1,
                    "tokensEstimated": False,
                }
            )

        monkeypatch.setattr(
            routes,
            "load_endpoints_config",
            lambda agent: (connection(agent["id"]), None),
        )
        monkeypatch.setattr(routes, "stream_chat", fake)

        results, errors = run_concurrently(
            {
                "batch": lambda: post_chat(
                    client, first, "code", batch_context="The lot: 2 tasks."
                ),
                "conversation": lambda: post_chat(client, second, "chat"),
            }
        )
        assert not errors, errors
        assert [name for name, _p in events(results["batch"].text)] == [
            "token",
            "done",
        ]
        assert [name for name, _p in events(results["conversation"].text)] == [
            "token",
            "done",
        ]
        by_model = {record["model"]: record for record in records}
        assert by_model["model-code"]["batch_instructions"] == "The lot: 2 tasks."
        assert by_model["model-chat"]["batch_instructions"] is None


# ---------------------------------------------------------------------------
# §10 items 7–9 — reload, a peer tab, a new tab
# ---------------------------------------------------------------------------


class TestItemSevenReload:
    """§10.7: a reload returns the tab to its own folder.

    The browser half is ``web/e2e/11-two-tabs.spec.js``. The server half is that
    nothing remembers which tab is where: the answer is a function of the field.
    """

    def test_two_identical_requests_are_answered_identically(
        self, client: TestClient, tmp_path: Path
    ):
        """§10.7: "Each returns to its own folder and its own agent." """
        first = folder(tmp_path / "project-a", "a-only.txt")
        params = workspace_params(first)

        once = client.get("/api/fs/tree", params=params)
        twice = client.get("/api/fs/tree", params=params)

        assert once.status_code == twice.status_code == 200
        assert once.content == twice.content

    def test_the_answer_depends_only_on_the_field(
        self, client: TestClient, tmp_path: Path
    ):
        """§10.7: nothing server-side remembers a tab, so only the field differs."""
        first = folder(tmp_path / "project-a", "a-only.txt")
        second = folder(tmp_path / "project-b", "b-only.txt")

        first_again = client.get("/api/fs/tree", params=workspace_params(first))
        other = client.get("/api/fs/tree", params=workspace_params(second))
        first_once_more = client.get("/api/fs/tree", params=workspace_params(first))

        assert first_again.content == first_once_more.content
        assert first_again.content != other.content


class TestItemEightAPeerTab:
    """§10.8: a third tab on repository A sees A's answers, with its own agent."""

    def test_a_second_request_naming_a_gets_as_answers_with_its_own_agent(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """§10.8: "A third tab on repository A sees the same answers as tab A." """
        first = folder(tmp_path / "project-a", "a-only.txt")
        seen: List[Dict[str, str]] = []

        def load(agent: Dict[str, Any]):
            seen.append({"agent": agent["id"], "model": f"model-{agent['id']}"})
            return connection(agent["id"]), None

        def fake(
            messages,
            model,
            server_url,
            emit,
            sampling=None,
            cancel_event=None,
            pause_event=None,
            **kwargs,
        ):
            seen.append({"root": workspace.current_root(), "model": model})
            emit(
                {
                    "event": "done",
                    "took": 0.0,
                    "ttft": 0.0,
                    "tokens": 0,
                    "tokensEstimated": False,
                }
            )

        monkeypatch.setattr(routes, "load_endpoints_config", load)
        monkeypatch.setattr(routes, "stream_chat", fake)

        answered_chat = post_chat(client, first, "chat")
        answered_code = post_chat(client, first, "code")

        assert answered_chat.status_code == answered_code.status_code == 200
        turns = [row for row in seen if "root" in row]
        assert [row["root"] for row in turns] == [str(first.resolve())] * 2
        assert [row["model"] for row in turns] == ["model-chat", "model-code"]
        # And the tree is the same answer tab A receives, whatever agent the tab
        # answers as.
        assert set(tree_names(client, first)) == {"a-only.txt"}


class TestItemNineANewTab:
    """§10.9: a new tab lands on the installation folder, not another tab's.

    Browser half: not inheriting a sibling tab's ``sessionStorage``, task 12's.
    Server half: the boot read's answer, and the seam's refusal for every other
    request that names nothing.
    """

    def test_a_request_naming_no_folder_is_refused_by_the_seams_sentence(
        self, client: TestClient
    ):
        """§10.9: no other tab's folder is ever inferred from an absent field."""
        response = client.get("/api/fs/tree")
        assert response.status_code == 422, response.text
        assert response.json()["detail"] == workspace.EMPTY_REFUSAL

    def test_the_boot_read_lands_on_the_installation_folder(
        self, client: TestClient
    ):
        """§10.9: "It lands on the installation folder ... and the user points it." """
        response = client.get("/api/workspace")
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["workspace"] == workspace.installation()
        assert body["default"] == workspace.installation()


# ---------------------------------------------------------------------------
# §10 item 11 — the catalogue, once
# ---------------------------------------------------------------------------


class TestItemElevenTheCatalogueOnce:
    """§10.11: nothing about the catalogue had to be configured twice."""

    CATALOGUE = ("/api/agents", "/api/config", "/api/prompt-helpers")

    @staticmethod
    def _before_and_after(
        client: TestClient, tmp_path: Path
    ) -> Dict[str, Tuple[bytes, bytes]]:
        first = folder(tmp_path / "project-a", "a-only.txt")
        second = folder(tmp_path / "project-b", "b-only.txt")
        before = {path: client.get(path).content for path in
                  TestItemElevenTheCatalogueOnce.CATALOGUE}
        # Two workspace-scoped requests naming two folders, between the reads.
        assert client.get(
            "/api/fs/tree", params=workspace_params(first)
        ).status_code == 200
        assert client.get(
            "/api/fs/tree", params=workspace_params(second)
        ).status_code == 200
        assert client.get(
            "/api/workspace", params=workspace_params(first)
        ).status_code == 200
        after = {path: client.get(path).content for path in
                 TestItemElevenTheCatalogueOnce.CATALOGUE}
        return {path: (before[path], after[path]) for path in before}

    @pytest.mark.parametrize("path", CATALOGUE)
    def test_the_catalogue_is_byte_identical_before_and_after(
        self, client: TestClient, tmp_path: Path, path: str
    ):
        """§10.11: the agents, models and bullets are the installation's own."""
        pairs = self._before_and_after(client, tmp_path)
        assert pairs[path][0] == pairs[path][1], path

    @pytest.mark.parametrize("path", CATALOGUE)
    def test_a_catalogue_response_carries_no_workspace_field(
        self, client: TestClient, path: str
    ):
        """§10.11: the catalogue is never scoped to a folder."""
        body = client.get(path).json()
        assert "workspace" not in body, path
        if path == "/api/config":
            for model in body["models"]:
                assert "workspace" not in model


# ---------------------------------------------------------------------------
# The invariant sweep
# ---------------------------------------------------------------------------

#: The prefixes §4.2 says are the installation's: a route under one of them that
#: asked for the workspace field would let a vanished folder break the catalogue.
INSTALLATION_SCOPED_PREFIXES = (
    "/api/config",
    "/api/servers",
    "/api/models",
    "/api/agents",
    "/api/prompt-helpers",
)

#: Every workspace-scoped HTTP route and socket from the lot's mechanism list.
#: This is clws-10's route list, kept here as the acceptance sweep's own
#: enumeration so the file stands alone.
WORKSPACE_SCOPED_PREFIXES = (
    "/api/fs",
    "/api/batch",
    "/api/workspace",
    "/api/chat",
    "/api/chat/pause",
    "/api/terminal",
    "/api/mcp",
    "/api/mcp/restart",
    "/api/lsp",
    "/api/lsp/restart",
    "/api/lsp/query",
    "/api/lsp/log",
)

#: The calls that mean "this route is about the workspace its request named".
#: ``require_workspace`` is every HTTP route's; ``workspace_refusal`` is the
#: terminal socket's, which answers a refusal as a close reason rather than a 422.
#: The three hub helpers are the same reader one call down — a panel route asks
#: them for its workspace's set, and they refuse on the route's behalf — so a
#: route reaching one has taken the field.
TAKES_THE_FIELD = frozenset(
    {
        "require_workspace",
        "workspace_refusal",
        "_acquire_hub_set",
        "_acquire_hub_set_async",
        "_read_hub_set",
    }
)


def route_registrations(source_text: str) -> List[Dict[str, Any]]:
    """Every route ``routes.py`` registers, as ``{"verb", "path", "handler"}``.

    Read out of the decorator call, not matched as a substring, so a docstring
    naming a route cannot satisfy a guard built on this. Same shape as the helper
    in ``tests/test_workspace_seam.py`` and ``tests/test_batch.py``.
    """
    found: List[Dict[str, Any]] = []
    for node in ast.walk(ast.parse(source_text)):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            call = decorator if isinstance(decorator, ast.Call) else None
            if call is None or not isinstance(call.func, ast.Attribute):
                continue
            if not call.args or not isinstance(call.args[0], ast.Constant):
                continue
            path = call.args[0].value
            if isinstance(path, str):
                found.append(
                    {"verb": call.func.attr.upper(), "path": path, "handler": node}
                )
    return found


def under_prefix(path: str, prefixes: Iterable[str]) -> bool:
    """Whether a registered path is the prefix or one of its children."""
    return any(path == prefix or path.startswith(f"{prefix}/") for prefix in prefixes)


def called_names(handler: Any) -> frozenset:
    """Every plain function a handler's body calls, as a name set."""
    return frozenset(
        node.func.id
        for node in ast.walk(handler)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
    )


def installation_routes_taking_the_field(source_text: str) -> List[str]:
    """Installation-scoped registrations that wrongly call the workspace reader."""
    return sorted(
        f"{registration['verb']} /api{registration['path']}"
        for registration in route_registrations(source_text)
        if under_prefix(
            f"/api{registration['path']}", INSTALLATION_SCOPED_PREFIXES
        )
        and called_names(registration["handler"]) & TAKES_THE_FIELD
    )


def workspace_routes_without_the_field(source_text: str) -> List[str]:
    """Workspace-scoped registrations that never name the field's reader."""
    return sorted(
        f"{registration['verb']} /api{registration['path']}"
        for registration in route_registrations(source_text)
        if under_prefix(
            f"/api{registration['path']}", WORKSPACE_SCOPED_PREFIXES
        )
        and not called_names(registration["handler"]) & TAKES_THE_FIELD
    )


def routes_source() -> str:
    return (REPO_ROOT / "src" / "api" / "routes.py").read_text(encoding="utf-8")


class TestInvariantInstallationRoutesNeverTakeTheField:
    """§4.2: the catalogue is the installation's and answers about no folder."""

    def test_no_installation_scoped_route_takes_the_field(self):
        """A parameter added to one of them fails this case — the invariant."""
        assert installation_routes_taking_the_field(routes_source()) == []

    def test_the_scan_catches_a_poisoned_route(self):
        """A guard that cannot fail is not a guard: a poisoned source is caught."""
        poisoned = '''
@router.get("/config")
def poisoned(request):
    require_workspace(request)
    return {}
'''
        assert installation_routes_taking_the_field(poisoned) == ["GET /api/config"]


def path_location_offenders(files: Iterable[Path]) -> List[str]:
    """Every file naming the retired process-wide accessor, by repo path."""
    pattern = re.compile(r"\bpath_location\b")
    found: List[str] = []
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if pattern.search(text):
            found.append(
                str(path.relative_to(REPO_ROOT))
                if path.is_relative_to(REPO_ROOT)
                else str(path)
            )
    return found


def src_python_files() -> List[Path]:
    return [
        path
        for path in sorted((REPO_ROOT / "src").rglob("*.py"))
        if "__pycache__" not in path.parts
    ]


class TestInvariantNoModuleNamesTheProcessWideLocation:
    """No module under ``src`` names ``path_location``; the seam owns the folder."""

    def test_no_module_under_src_names_path_location(self):
        """The retired accessor's name has no survivor and no allowance."""
        assert path_location_offenders(src_python_files()) == []

    def test_the_scan_catches_a_poisoned_module(self, tmp_path: Path):
        poisoned = tmp_path / "cheeky.py"
        poisoned.write_text(
            "from src.config import path_location\n"
            "def root():\n"
            "    return path_location()\n",
            encoding="utf-8",
        )
        assert path_location_offenders([poisoned]) == [str(poisoned)]


class TestInvariantEveryWorkspaceRouteTakesTheField:
    """Rule 12: no workspace-scoped surface answers about a folder it was not given."""

    def test_every_workspace_scoped_route_takes_the_field(self):
        """Every route under the mechanism list's prefixes calls the reader."""
        assert workspace_routes_without_the_field(routes_source()) == []

    def test_the_scan_catches_a_poisoned_route(self):
        """A route added without the reader is caught, not silently skipped."""
        poisoned = '''
@router.get("/fs/tree")
def poisoned():
    return {"entries": []}
'''
        assert workspace_routes_without_the_field(poisoned) == [
            "GET /api/fs/tree"
        ]


#: The tab's two pieces of identity, named together (spec D5, D11).
TAB_STORAGE_KEYS = ("WORKSPACE_STORAGE_KEY", "AGENT_STORAGE_KEY")

#: A browser-wide write of one of the tab's keys. Other ``localStorage`` keys
#: (theme, layout) are not the tab's identity and are deliberately not matched.
WIDE_STORAGE_RE = re.compile(
    r"localStorage\.(?:get|set|remove)Item\(\s*(WORKSPACE|AGENT)_STORAGE_KEY"
)

#: A per-tab access of one of them: the shape the invariant requires.
SESSION_STORAGE_RE = re.compile(
    r"sessionStorage\.(?:get|set|remove)Item\(\s*(WORKSPACE|AGENT)_STORAGE_KEY"
)


def client_source_files() -> List[Path]:
    return [
        path
        for path in sorted((REPO_ROOT / "web" / "src").rglob("*"))
        if path.is_file() and path.suffix in (".js", ".vue")
    ]


def wide_storage_offenders(sources: Iterable[Tuple[str, str]]) -> List[str]:
    found: List[str] = []
    for label, text in sources:
        for line in text.splitlines():
            if WIDE_STORAGE_RE.search(line):
                found.append(f"{label}: {line.strip()}")
    return found


def session_storage_keys(sources: Iterable[Tuple[str, str]]) -> set:
    found = set()
    for _label, text in sources:
        found.update(match.group(1) for match in SESSION_STORAGE_RE.finditer(text))
    return found


def read_sources(paths: Iterable[Path]) -> List[Tuple[str, str]]:
    sources = []
    for path in paths:
        sources.append(
            (
                str(path.relative_to(REPO_ROOT))
                if path.is_relative_to(REPO_ROOT)
                else str(path),
                path.read_text(encoding="utf-8"),
            )
        )
    return sources


class TestInvariantTabKeysLiveInSessionStorage:
    """``sessionStorage`` holds the tab's folder and agent; ``localStorage`` never."""

    def test_no_browser_wide_storage_holds_a_tab_key(self):
        """A reload keeps the folder and a new tab does not inherit it (D4, D11)."""
        assert wide_storage_offenders(read_sources(client_source_files())) == []

    def test_both_tab_keys_are_held_in_session_storage(self):
        """And the positive half: both keys really are per-tab state."""
        keys = session_storage_keys(read_sources(client_source_files()))
        assert keys == {"WORKSPACE", "AGENT"}

    def test_the_scan_catches_a_poisoned_client_file(self, tmp_path: Path):
        poisoned = (
            "window.localStorage.setItem(WORKSPACE_STORAGE_KEY, '/srv/proj')\n"
        )
        assert wide_storage_offenders([("poisoned.js", poisoned)]) == [
            "poisoned.js: window.localStorage.setItem(WORKSPACE_STORAGE_KEY, "
            "'/srv/proj')"
        ]
        assert session_storage_keys([("poisoned.js", poisoned)]) == set()


#: The JS suites' own rule, kept in Python here: a query spelling is the field
#: introduced by a query separator or sitting inside a string literal. Prose
#: that merely names the field (``… spelled workspace= …``) is not a call site.
WORKSPACE_QUERY_SPELLING_RE = re.compile(r"""(?:\?|&|["'`])workspace=""")

#: The one file allowed to name the field: the session composable is the client's
#: ``withWorkspace``, the twin of the server's one reader.
WORKSPACE_FIELD_HOME = "useWorkspaceSession.js"


def workspace_field_offenders(sources: Iterable[Tuple[str, str]]) -> List[str]:
    found: List[str] = []
    for label, text in sources:
        if Path(label).name == WORKSPACE_FIELD_HOME:
            continue
        for line in text.splitlines():
            if "workspace=" in line and WORKSPACE_QUERY_SPELLING_RE.search(line):
                found.append(f"{label}: {line.strip()}")
    return found


class TestInvariantTheFieldIsSpelledOnceOnTheClient:
    """``web/src`` spells ``workspace=`` nowhere but the session composable."""

    def test_no_other_client_file_spells_the_field(self):
        """No call site can forget the field and no name can drift (spec D9)."""
        assert workspace_field_offenders(read_sources(client_source_files())) == []

    def test_the_scan_catches_a_poisoned_call_site(self, tmp_path: Path):
        poisoned = "fetch('/api/fs/tree?workspace=' + root)\n"
        assert workspace_field_offenders([("caller.js", poisoned)]) == [
            "caller.js: fetch('/api/fs/tree?workspace=' + root)"
        ]
