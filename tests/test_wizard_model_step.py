"""The wizard's model step: one call per step, no conversation, no numbers.

These are the app's first model calls that belong to **no conversation** (§5 of
``docs/mcp-lsp-connector-wizard.md``), so this suite asks the questions that keep
them honest rather than that they run:

* **one seam, tool-less and non-streaming** — the request body the real
  ``core.llmkit.chat_completion`` builds is captured through an
  ``httpx.MockTransport`` handler (the way ``tests/test_llmkit_client.py``
  captures it), and it carries no ``tools`` key and no ``stream`` key. The seam
  function is ``modelstep.send``, so a test re-points one attribute instead of
  patching ``llmkit`` globally;
* **one attempt** — a refused call is not waited on, for a status in
  ``TRANSIENT_STATUSES`` included, which the chat turn *would* wait out: the
  patched seam is called once, nothing sleeps, and the answer is the endpoint's
  own sentence;
* **three outcomes that must never read the same** — ``empty`` (the model
  answered and found nothing), ``failed`` by refusal, ``failed`` by transport and
  ``failed`` by an unparseable answer are four different sentences;
* **the order is the model's**, and a proposal missing one of its five facts is
  **dropped with a note**, never repaired into shape;
* **no numbers** — the response's ``usage`` reaches no return value and no
  counter, and no request asks the server for it.

Hermetic by construction: the only socket is an ``httpx.MockTransport`` handler, no
test reads ``.env``, the settings store or a live endpoint, and the connection the
step receives is built in the test.
"""

import json
import time
from typing import Any, Dict, List, Optional

import httpx
import pytest

from src.core.llmkit.client import TRANSIENT_STATUSES
from src.core.wizard import modelstep, prompts

#: The two settled spellings, written as literals here so the test does not read
#: the values it is checking out of the code under test.
SENTINEL = "__put_your_api_key_here__"
PATH_REFERENCE = "${NOJAE_PATH_LOCATION}"

SERVER = "http://model.test:8080/v1"
URL = "http://model.test:8080/v1/chat/completions"
MODEL = "wizard-test-model"
API_KEY = "test-key-not-a-secret"

#: The token block a live server answers with — the numbers the wizard must never
#: carry anywhere.
USAGE = {"prompt_tokens": 12345, "completion_tokens": 6789, "total_tokens": 19134}


class Wire:
    """Every ``httpx.Client`` the seam builds answers from one handler here.

    The real ``chat_completion`` still builds the real request and the real body,
    which is the point: what a test asserts about the body is what would go over
    the socket. ``calls`` counts the requests that were actually dispatched, so
    "one attempt" is measurable rather than assumed.
    """

    def __init__(self, monkeypatch: pytest.MonkeyPatch) -> None:
        self.bodies: List[Dict[str, Any]] = []
        self.requests: List[httpx.Request] = []
        self.handler: Optional[Any] = None
        self._real_client = httpx.Client
        monkeypatch.setattr(httpx, "Client", self._factory)

    def _factory(self, *args, **kwargs):
        kwargs["transport"] = httpx.MockTransport(self._dispatch)
        return self._real_client(*args, **kwargs)

    def _dispatch(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        self.bodies.append(json.loads(request.content))
        assert self.handler is not None, "this test installed no handler"
        return self.handler(request)

    @property
    def calls(self) -> int:
        return len(self.requests)

    @property
    def body(self) -> Dict[str, Any]:
        assert len(self.bodies) == 1, f"expected exactly one request: {self.bodies}"
        return self.bodies[0]

    def answer(self, content: Any, status: int = 200) -> None:
        """Answer with a chat-completion body carrying ``content``."""
        text = content if isinstance(content, str) else json.dumps(content)

        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(
                status,
                json={
                    "choices": [
                        {"index": 0, "message": {"role": "assistant", "content": text}}
                    ],
                    "usage": USAGE,
                },
            )

        self.handler = handler

    def refuse(self, status: int = 400, message: str = "bad request") -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            return httpx.Response(status, json={"error": {"message": message}})

        self.handler = handler

    def blow_up(self, error: BaseException) -> None:
        def handler(_request: httpx.Request) -> httpx.Response:
            raise error

        self.handler = handler


@pytest.fixture
def wire(monkeypatch: pytest.MonkeyPatch) -> Wire:
    return Wire(monkeypatch)


@pytest.fixture
def connection() -> modelstep.Connection:
    """The resolved connection a step receives — the store's values, handed in."""
    return modelstep.Connection(
        model=MODEL,
        server_url=SERVER,
        api_key=API_KEY,
        sampling={"temperature": 0.2, "top_k": 20},
    )


@pytest.fixture
def facts() -> Dict[str, Any]:
    """A scan's payload, in the shape ``projectfacts.project_facts`` answers."""
    return {
        "extensions": [
            {"extension": ".py", "count": 12, "servers": []},
            {"extension": ".css", "count": 3, "servers": []},
        ],
        "manifests": [{"path": "pyproject.toml", "dependencies": ["fastapi"]}],
        "declared": {"mcp": [], "lsp": []},
        "frontEnd": "",
        "fileCount": 15,
        "truncated": False,
    }


DECLARATION = "/workspace/.nojae/lsp-settings.json"


def a_proposal(proposal_id: str = "python") -> Dict[str, Any]:
    return {
        "id": proposal_id,
        "command": ["pyright-langserver", "--stdio"],
        "extensions": [".py", ".pyi"],
        "workspaceRoot": PATH_REFERENCE,
        "evidence": "12 .py files, a pyproject.toml, and no Python server declared",
    }


def a_prepared() -> Dict[str, Any]:
    return {
        "id": "python",
        "member": {
            "command": ["pyright-langserver", "--stdio"],
            "workspaceRoot": PATH_REFERENCE,
            "extensions": [".py"],
        },
        "install": {"any": "npm install -g pyright"},
        "requiresInstall": True,
        "decisions": ["workspaceRoot is the workspace itself: no sub-folder here"],
    }


def assert_no_numbers(value: Any, path: str = "") -> None:
    """No number anywhere in a step's answer: no token count, no cost, no time."""
    if isinstance(value, dict):
        for key, item in value.items():
            assert_no_numbers(item, f"{path}.{key}")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            assert_no_numbers(item, f"{path}[{index}]")
        return
    assert isinstance(value, (str, bool, type(None))), (
        f"a number reached the wizard's answer at {path}: {value!r}"
    )


def no_sleep(monkeypatch: pytest.MonkeyPatch) -> List[float]:
    """Record every ``time.sleep`` call, so "no waiting" is measured."""
    slept: List[float] = []
    monkeypatch.setattr(time, "sleep", lambda seconds: slept.append(seconds))
    return slept


class TestTheCallGoesThroughTheOneSeam:
    """One seam, tool-less and non-streaming, with the connection handed in."""

    def test_propose_posts_no_tools_and_no_stream_key(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.answer({"servers": [a_proposal()]})
        modelstep.propose(connection, facts, DECLARATION)

        body = wire.body
        assert "tools" not in body
        assert "stream" not in body
        assert "stream_options" not in body
        assert body["model"] == MODEL
        # The connection's sampler values travel verbatim; nothing is re-resolved
        # and nothing is dropped on the way.
        assert body["temperature"] == 0.2
        assert body["top_k"] == 20
        assert wire.requests[0].headers["Authorization"] == f"Bearer {API_KEY}"
        assert str(wire.requests[0].url) == URL

    def test_prepare_posts_no_tools_and_no_stream_key(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.answer(a_prepared())
        modelstep.prepare("lsp", connection, a_proposal(), facts, DECLARATION)

        body = wire.body
        assert "tools" not in body
        assert "stream" not in body
        assert "stream_options" not in body

    def test_both_steps_send_this_modules_own_messages(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.answer({"servers": []})
        modelstep.propose(connection, facts, DECLARATION)
        assert wire.body["messages"] == prompts.propose_messages(facts, DECLARATION)

    def test_prepare_sends_the_family_s_own_messages(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.answer(a_prepared())
        modelstep.prepare("mcp", connection, {"type": "remote"}, facts, DECLARATION)
        assert wire.body["messages"] == prompts.prepare_messages(
            "mcp", {"type": "remote"}, facts, DECLARATION
        )

    def test_the_family_reaches_the_question(self):
        """The two families are told whose command line they are handling."""
        mcp = prompts.prepare_messages("mcp", {}, {}, DECLARATION)
        lsp = prompts.prepare_messages("lsp", {}, {}, DECLARATION)
        assert mcp != lsp
        assert "catalogue" in mcp[1]["content"]
        assert "proposed for this project" in lsp[1]["content"]
        with pytest.raises(ValueError):
            prompts.prepare_messages("css", {}, {}, DECLARATION)

    def test_a_test_re_points_one_attribute_not_llmkit(
        self,
        monkeypatch: pytest.MonkeyPatch,
        connection: modelstep.Connection,
        facts: Dict[str, Any],
    ):
        """The package's own seam, the way the LSP hub's resolution is patched."""
        seen: List[Dict[str, Any]] = []

        def fake_send(**kwargs):
            seen.append(kwargs)
            return {
                "choices": [{"message": {"content": json.dumps({"servers": []})}}]
            }

        monkeypatch.setattr(modelstep, "send", fake_send)
        modelstep.propose(connection, facts, DECLARATION)
        assert len(seen) == 1
        assert seen[0]["model"] == MODEL
        assert seen[0]["server_url"] == SERVER
        assert seen[0]["api_key"] == API_KEY
        assert seen[0]["messages"] == prompts.propose_messages(facts, DECLARATION)

    def test_the_module_never_names_the_streaming_shape_or_the_wait_verdict(self):
        """No second call shape, and nothing here consults a retryability verdict."""
        from pathlib import Path

        source = Path(modelstep.__file__).read_text(encoding="utf-8")
        for marker in (
            "stream_completion",
            "another_attempt_may_help",
            "src.api",
            "src.config",
            "appdb",
            "fastapi",
            "time.sleep",
        ):
            assert marker not in source, marker


class TestOneAttempt:
    """One call, one answer, and no waiting — not even for a transient status."""

    def test_a_refused_round_is_not_waited_on(
        self,
        wire: Wire,
        monkeypatch: pytest.MonkeyPatch,
        connection: modelstep.Connection,
        facts: Dict[str, Any],
    ):
        slept = no_sleep(monkeypatch)
        wire.refuse(429, "rate limited")
        result = modelstep.propose(connection, facts, DECLARATION)

        assert wire.calls == 1, "the wizard made more than one attempt"
        assert slept == [], "the wizard slept between attempts"
        assert result["outcome"] == modelstep.FAILED

    @pytest.mark.parametrize("status", sorted(TRANSIENT_STATUSES))
    def test_every_status_the_chat_would_wait_out_is_answered_at_once(
        self,
        status: int,
        wire: Wire,
        monkeypatch: pytest.MonkeyPatch,
        connection: modelstep.Connection,
        facts: Dict[str, Any],
    ):
        """The deliberate exception: the chat waits these out, the wizard does not."""
        slept = no_sleep(monkeypatch)
        wire.refuse(status, "try again")
        result = modelstep.prepare(
            "lsp", connection, a_proposal(), facts, DECLARATION
        )

        assert wire.calls == 1
        assert slept == []
        assert result["outcome"] == modelstep.FAILED

    @pytest.mark.parametrize("status", [400, 429, 503])
    def test_the_patched_seam_is_called_exactly_once(
        self,
        status: int,
        monkeypatch: pytest.MonkeyPatch,
        connection: modelstep.Connection,
        facts: Dict[str, Any],
    ):
        """Counted at the seam itself, not only at the socket."""
        from src.core.llmkit import LLMRequestError

        calls: List[int] = []

        def counting_send(**_kwargs):
            calls.append(status)
            raise LLMRequestError(status, "try again later", URL)

        monkeypatch.setattr(modelstep, "send", counting_send)
        result = modelstep.propose(connection, facts, DECLARATION)

        assert calls == [status], "the seam was called more than once"
        assert result["outcome"] == modelstep.FAILED
        assert str(status) in result["sentence"]

    def test_the_refusal_sentence_is_the_endpoints_own(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.refuse(503, "upstream is warming up")
        result = modelstep.propose(connection, facts, DECLARATION)
        assert result["sentence"] == (
            f"the model endpoint answered HTTP 503 for {URL}: upstream is warming up"
        )


class TestTheThreeOutcomes:
    """``ok``, ``empty`` and ``failed`` — and each failure names itself."""

    def test_an_empty_answer_is_a_stop_of_its_own(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.answer({"servers": []})
        result = modelstep.propose(connection, facts, DECLARATION)
        assert result["outcome"] == modelstep.EMPTY
        assert result["sentence"] == modelstep.EMPTY_SENTENCE
        assert result["proposals"] == []

    def test_a_refusal_a_transport_failure_and_a_garbage_answer_all_differ(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.answer({"servers": []})
        empty = modelstep.propose(connection, facts, DECLARATION)["sentence"]

        wire.handler = None
        wire.refuse(400, "the model is not loaded")
        refused = modelstep.propose(connection, facts, DECLARATION)["sentence"]

        wire.handler = None
        wire.blow_up(httpx.ConnectError("connection refused"))
        unreachable = modelstep.propose(connection, facts, DECLARATION)["sentence"]

        wire.handler = None
        wire.answer("I could not decide, here is prose instead")
        unreadable = modelstep.propose(connection, facts, DECLARATION)["sentence"]

        sentences = [empty, refused, unreachable, unreadable]
        assert len(set(sentences)) == 4, sentences
        assert "no language server" in empty.lower()
        assert "HTTP 400" in refused
        assert unreachable.startswith(modelstep.UNREACHABLE_LEAD.strip())
        assert "connection refused" in unreachable
        assert unreadable.startswith(modelstep.UNREADABLE_LEAD.strip())
        assert "JSON object" in unreadable

    def test_an_unreadable_answer_is_a_failure_not_an_empty_list(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.answer("no server fits this folder, sorry")
        result = modelstep.propose(connection, facts, DECLARATION)
        assert result["outcome"] == modelstep.FAILED
        assert result["sentence"] != modelstep.EMPTY_SENTENCE

    def test_a_refusal_and_a_transport_failure_are_failed_at_both_steps(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.blow_up(httpx.ConnectTimeout("no answer head"))
        proposed = modelstep.propose(connection, facts, DECLARATION)
        assert proposed["outcome"] == modelstep.FAILED
        assert modelstep.UNREACHABLE_LEAD.strip() in proposed["sentence"]

        wire.handler = None
        wire.refuse(401, "bad key")
        prepared = modelstep.prepare(
            "lsp", connection, a_proposal(), facts, DECLARATION
        )
        assert prepared["outcome"] == modelstep.FAILED
        assert "HTTP 401" in prepared["sentence"]

    def test_a_preparation_without_a_member_is_a_named_failure(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.answer({"id": "python", "member": {}})
        result = modelstep.prepare(
            "lsp", connection, a_proposal(), facts, DECLARATION
        )
        assert result["outcome"] == modelstep.FAILED
        assert "member" in result["sentence"]


class TestTheProposals:
    """The model's order survives, and a short item is dropped, never guessed."""

    def test_the_order_is_the_models_own(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.answer(
            {"servers": [a_proposal("css"), a_proposal("python"), a_proposal("rust")]}
        )
        result = modelstep.propose(connection, facts, DECLARATION)
        assert result["outcome"] == modelstep.OK
        assert [item["id"] for item in result["proposals"]] == [
            "css",
            "python",
            "rust",
        ]

    def test_every_item_carries_the_five_facts(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.answer({"servers": [a_proposal()]})
        item = modelstep.propose(connection, facts, DECLARATION)["proposals"][0]
        assert set(item) == set(prompts.PROPOSAL_FIELDS)
        assert item["command"] == ["pyright-langserver", "--stdio"]
        assert item["extensions"] == [".py", ".pyi"]
        assert item["workspaceRoot"].startswith(PATH_REFERENCE)
        assert item["evidence"]

    def test_an_item_missing_a_fact_is_dropped_with_a_note(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        short = a_proposal("no-evidence")
        del short["evidence"]
        no_argv = a_proposal("no-argv")
        no_argv["command"] = []
        absolute = a_proposal("absolute-root")
        absolute["workspaceRoot"] = "/home/someone/project"
        wire.answer({"servers": [a_proposal("python"), short, no_argv, absolute]})
        result = modelstep.propose(connection, facts, DECLARATION)

        assert [item["id"] for item in result["proposals"]] == ["python"]
        assert len(result["notes"]) == 3
        assert any("evidence" in note for note in result["notes"])
        assert any("command" in note for note in result["notes"])
        assert any("environment reference" in note for note in result["notes"])

    def test_every_item_dropped_is_an_empty_answer_not_a_failure(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.answer({"servers": [{"id": "guess"}]})
        result = modelstep.propose(connection, facts, DECLARATION)
        assert result["outcome"] == modelstep.EMPTY
        assert result["notes"]

    def test_a_text_block_around_the_object_is_tolerated(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.answer(
            "Here is what I would declare:\n"
            + json.dumps({"servers": [a_proposal()]})
            + "\nTell me if you want the other one."
        )
        result = modelstep.propose(connection, facts, DECLARATION)
        assert result["outcome"] == modelstep.OK

    def test_an_answer_without_the_servers_list_is_unreadable(self):
        with pytest.raises(prompts.AnswerShapeError):
            prompts.parse_proposals('{"candidates": []}')
        assert prompts.parse_proposals('{"servers": []}') == ([], [])


class TestThePreparedAnswer:
    """The complete member, the install lines and the decision lines."""

    def test_the_whole_member_comes_back(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.answer(a_prepared())
        result = modelstep.prepare(
            "lsp", connection, a_proposal(), facts, DECLARATION
        )
        assert result["outcome"] == modelstep.OK
        prepared = result["prepared"]
        assert prepared["id"] == "python"
        assert prepared["member"] == a_prepared()["member"]
        assert prepared["install"] == {"any": "npm install -g pyright"}
        assert prepared["requiresInstall"] is True
        assert prepared["decisions"] == a_prepared()["decisions"]

    def test_per_platform_install_lines_are_kept_apart(self):
        prepared, notes = prompts.parse_prepared(
            json.dumps(
                {
                    "id": "x",
                    "member": {"type": "local", "command": ["x"]},
                    "install": {
                        "posix": "brew install x",
                        "windows": "choco install x",
                    },
                    "requiresInstall": True,
                    "decisions": [],
                }
            )
        )
        assert prepared["install"] == {
            "posix": "brew install x",
            "windows": "choco install x",
        }
        assert notes == []

    def test_an_answer_that_installs_nothing_may_say_so_by_omission(self):
        prepared, _notes = prompts.parse_prepared(
            json.dumps({"id": "x", "member": {"type": "remote", "url": "https://x"}})
        )
        assert prepared["install"] == {}
        assert prepared["requiresInstall"] is False
        assert prepared["decisions"] == []

    def test_a_malformed_install_block_is_a_named_shape_error(self):
        with pytest.raises(prompts.AnswerShapeError):
            prompts.parse_prepared(
                json.dumps(
                    {"id": "x", "member": {"a": 1}, "install": ["pip install x"]}
                )
            )


class TestNoNumberEver:
    """No token, no cost, no timing: the wizard is not part of the session."""

    def test_usage_reaches_no_return_value(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.answer({"servers": [a_proposal()]})
        assert_no_numbers(modelstep.propose(connection, facts, DECLARATION))

    def test_a_prepared_answer_carries_no_token_or_cost_field(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.answer(a_prepared())
        result = modelstep.prepare(
            "lsp", connection, a_proposal(), facts, DECLARATION
        )
        assert_no_numbers(result)
        text = json.dumps(result).lower()
        for marker in ("token", "cost", "usage", "seconds"):
            assert marker not in text, marker

    def test_the_module_keeps_no_accounting_state(self):
        for name in dir(modelstep):
            assert "token" not in name.lower()
            assert "cost" not in name.lower()
            assert "usage" not in name.lower()

    def test_the_request_never_asks_the_server_for_usage(
        self, wire: Wire, connection: modelstep.Connection, facts: Dict[str, Any]
    ):
        wire.answer({"servers": []})
        modelstep.propose(connection, facts, DECLARATION)
        assert "include_usage" not in json.dumps(wire.body)


class TestThePromptsAreTheModulesOwnData:
    """A prompt is data here, so what it demands is assertable by name."""

    def test_propose_demands_the_gap_leads_ordering(self):
        text = prompts.PROPOSE_PROMPT
        assert "clearly lacks" in text
        assert "leads" in text
        assert "already serves" in text
        assert "does not lead" in text

    def test_propose_asks_for_the_five_facts(self):
        text = prompts.PROPOSE_PROMPT
        for field in prompts.PROPOSAL_FIELDS:
            assert field in text, field

    def test_prepare_demands_environment_references_and_the_sentinel(self):
        text = prompts.PREPARE_PROMPT
        assert PATH_REFERENCE in text
        assert SENTINEL in text
        assert "absolute path" in text
        assert "never a key you have seen" in text

    def test_prepare_forbids_inventing_a_version_or_a_registry_name(self):
        text = prompts.PREPARE_PROMPT
        assert (
            "Never invent a version pin, a registry name or a documentation URL"
            in text
        )
        assert "checked against this machine" in text

    def test_the_settled_spellings_are_the_ones_the_spec_states(self):
        assert prompts.SECRET_SENTINEL == SENTINEL
        assert prompts.PATH_REFERENCE == PATH_REFERENCE
        assert prompts.FAMILIES == ("mcp", "lsp")

    def test_the_facts_ride_into_the_question_as_plain_data(self):
        """The scan's payload is rendered, never re-derived and never quoted."""
        messages = prompts.propose_messages(
            {"extensions": [{"extension": ".css", "count": 3, "servers": []}]},
            DECLARATION,
        )
        assert DECLARATION in messages[1]["content"]
        assert '".css"' in messages[1]["content"]
        assert messages[0]["role"] == "system"
        assert messages[1]["role"] == "user"
