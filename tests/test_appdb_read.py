"""appdb-03 — the store's read side: accessors, the resolution seam, the refusal.

The functions every later task calls instead of a file reader. They exist and
they are tested. They were written with **no route or chat path calling any of
them**, so the app's behaviour was unchanged at the end of that task; task 09
then flipped the read onto this seam and deleted the file layer it replaced,
which the last class below asserts.

The promises asserted here, in the order the module states them:

* **servers with their models**, and single-row lookups — the store's equivalent
  of the workspace-settings reader this store replaces, in insertion order, with
  the ``snake_case``
  → ``camelCase`` translation living in this one module (§4.2);
* **the reads are uncached** (D11): a row written by anyone is in the next
  answer, with nothing to invalidate;
* **``EndpointsConfig.from_store``** — the same output object, the same pydantic
  validation, the same "absent means" table, and a ``NULL`` sampler column
  **omitted** from the request body while a ``0`` column is kept (§4.2);
* **the one refusal sentence** (D7) and its three states: no model (naming the
  agent), a model whose server row is gone (a refusal, not a traceback), an
  unusable store (naming the path);
* **the resolution seam**: ``(config, None)`` or ``(None, sentence)``, per agent;
* **the per-agent cap** (D9): floor of 1, no ceiling;
* **the agents read model**: it never raises, a damaged row is reported and the
  rest still render, the app-owned agent is last, there is no ``default`` key,
  and an id in answers a row or nothing;
* **the helper rows at any count**, including zero — no count rule (§4.5).

Hermeticity: every test runs against a database under its own ``tmp_path``, by
patching ``appdb.PROJECT_ROOT``. The real ``<install root>/nojae.db`` is never
opened, and no test needs a model, a hub or a network.
"""

import ast
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterator, List, Optional, Tuple

import pytest
from pydantic import ValidationError

import src.config as config_module
from src.core import appdb
from src.core.models import DEFAULT_LLM_SYSPROMPT, EndpointsConfig
from tests.test_workspace_seam import routes_tree_source

#: The four built-in ids, in the order the seeder writes them — which is also
#: the dropdown's order, with the app-owned agent last (§4.4).
BUILT_IN_IDS: Tuple[str, ...] = ("chat", "code", "architect", "todoBuilder")


def store_sources() -> List[Path]:
    """Every ``*.py`` of the store package, the thing the shape guards read."""
    return sorted(Path(appdb.__file__).resolve().parent.glob("*.py"))


#: The read-side names that answer "which connection does **this turn** run on",
#: or what a turn is bounded by. Nothing may call them until task 09 wires the
#: seam in, because a turn resolving through the store while every other reader
#: still answers from the file is two answers at once.
#:
#: The store's other reads are deliberately **not** listed: ``load_servers``,
#: ``server_row``, ``model_row``, ``load_prompt_helpers`` and ``resolve_agents``
#: are plain reads of rows the Settings dialog edits, and its routes call them
#: from task 08 on. ``resolve_agents`` in particular is a read of the ``agents``
#: table (the unassigned count reads it), not the seam that picks a turn's
#: connection — which is what separates it from ``resolve_agent``.
RESOLUTION_NAMES: Tuple[str, ...] = (
    "resolve_agent",
    "agent_max_tool_iteration",
)



# -- the fixtures ---------------------------------------------------------------

@pytest.fixture
def store_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Iterator[Path]:
    """An install root whose ``nojae.db`` does not exist yet."""
    root = tmp_path / "install"
    root.mkdir()
    monkeypatch.setattr(appdb, "PROJECT_ROOT", root)
    yield root
    appdb.close_thread_connection()


@pytest.fixture
def seeded(store_root: Path) -> Path:
    """An install root that has been booted once — four agents, nine bullets."""
    result = appdb.boot()
    assert result["state"] == "ok", result["sentence"]
    return store_root


def raw(path: Path) -> sqlite3.Connection:
    """A connection that is **not** the module's — for writing what the app
    would never write, and for reading a row back without the accessor's help.

    Foreign keys are **off** on purpose: the damaged states this suite plants
    (a model naming a server that is gone, an agent naming a model that is gone)
    are exactly the ones the schema's ``ON DELETE`` clauses prevent the app from
    reaching, so a handle that enforced them could not create them.
    """
    conn = sqlite3.connect(path.as_uri(), uri=True)
    conn.execute("PRAGMA foreign_keys = OFF")
    return conn


def add_server(path: Path, name: str = "Local", url: str = "http://x/v1",
               api_key: str = "sekrit") -> int:
    """One server row, written the way the dialog will write it. Returns its id."""
    conn = raw(path)
    try:
        conn.execute(
            "INSERT INTO servers (name, url, api_key) VALUES (?, ?, ?)",
            (name, url, api_key),
        )
        conn.commit()
        return int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
    finally:
        conn.close()


def add_model(path: Path, server_id: int, name: str = "gpt-test",
              **columns: Any) -> int:
    """One model row under ``server_id``, with any columns overridden."""
    conn = raw(path)
    try:
        conn.execute(
            "INSERT INTO models (server_id, name, sys_prompt, temperature, top_p,"
            " top_k, min_p, repeat_penalty, presence_penalty, reasoning,"
            " supports_vision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                server_id,
                name,
                columns.get("sys_prompt", ""),
                columns.get("temperature"),
                columns.get("top_p"),
                columns.get("top_k"),
                columns.get("min_p"),
                columns.get("repeat_penalty"),
                columns.get("presence_penalty"),
                columns.get("reasoning"),
                columns.get("supports_vision", 0),
            ),
        )
        conn.commit()
        return int(conn.execute("SELECT last_insert_rowid()").fetchone()[0])
    finally:
        conn.close()


def pin_agent(path: Path, agent_id: str, model_id: Optional[int]) -> None:
    """Give an agent its model — the one column of a ``readonly`` row the user owns."""
    conn = raw(path)
    try:
        conn.execute("UPDATE agents SET model_id = ? WHERE id = ?", (model_id, agent_id))
        conn.commit()
    finally:
        conn.close()


# -- servers with their models ---------------------------------------------------

class TestServerAndModelRows:
    def test_a_server_comes_back_with_its_models(self, seeded: Path):
        server_id = add_server(seeded / "nojae.db")
        first = add_model(seeded / "nojae.db", server_id, "model-one")
        second = add_model(seeded / "nojae.db", server_id, "model-two")

        servers = appdb.load_servers()

        assert [server["name"] for server in servers] == ["Local"]
        assert [model["id"] for model in servers[0]["models"]] == [first, second]

    def test_the_columns_leave_with_the_names_the_browser_uses(self, seeded: Path):
        """§4.2: the translation lives in this module, so a route has none to write.

        Asserted as the **whole** key set of each row, not just the renamed ones:
        a column that leaked through in its stored spelling would be a second
        vocabulary the client had to know about.
        """
        server_id = add_server(seeded / "nojae.db")
        add_model(seeded / "nojae.db", server_id)

        server = appdb.load_servers()[0]
        model = server["models"][0]

        assert sorted(server) == sorted(
            {"id", "name", "url", "apiKey", "models"}
        )
        assert sorted(model) == sorted(
            {
                "id", "serverId", "name", "sysPrompt", "temperature", "topP",
                "topK", "minP", "repeatPenalty", "presencePenalty", "reasoning",
                "supportsVision",
            }
        )

    def test_the_flags_are_booleans_and_the_key_is_the_key(self, seeded: Path):
        server_id = add_server(seeded / "nojae.db", api_key="sk-live-abcdef")
        add_model(seeded / "nojae.db", server_id, supports_vision=1)

        server = appdb.load_servers()[0]

        assert server["apiKey"] == "sk-live-abcdef"
        assert server["models"][0]["supportsVision"] is True

    def test_a_server_with_no_models_still_answers_with_an_empty_list(
        self, seeded: Path
    ):
        add_server(seeded / "nojae.db")

        assert appdb.load_servers()[0]["models"] == []

    def test_an_empty_store_answers_no_servers(self, seeded: Path):
        """§4.3: servers and models are never seeded, so a fresh install is empty."""
        assert appdb.load_servers() == []

    def test_both_single_row_lookups_answer_the_same_row_as_the_list(
        self, seeded: Path
    ):
        server_id = add_server(seeded / "nojae.db")
        model_id = add_model(seeded / "nojae.db", server_id)

        listed = appdb.load_servers()[0]
        assert appdb.server_row(server_id) == {
            key: value for key, value in listed.items() if key != "models"
        }
        assert appdb.model_row(model_id) == listed["models"][0]

    def test_a_lookup_of_an_id_that_is_not_there_answers_nothing(self, seeded: Path):
        assert appdb.server_row(4242) is None
        assert appdb.model_row(4242) is None

    def test_a_lookup_of_a_non_integer_answers_nothing_without_touching_the_store(
        self, seeded: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """The ids arrive from a row or from a request; neither may reach SQL.

        ``True`` is refused as well, because Python reads it as ``1`` and would
        otherwise answer the first row of the table for a caller that passed a
        flag by mistake. The handle is made to raise, so the test proves the
        guard answers **before** the query rather than that the query was safe.
        """
        add_server(seeded / "nojae.db")

        def never(_self: Any = None) -> Any:
            raise AssertionError("a non-integer id must not reach the store")

        monkeypatch.setattr(appdb, "connection", never)

        for junk in (None, "", "1", 1.0, True, [1], {"id": 1}):
            assert appdb.server_row(junk) is None
            assert appdb.model_row(junk) is None


class TestTheReadsAreUncached:
    """D11: "the database is the cache" — so there is nothing to invalidate."""

    def test_a_row_written_after_a_read_is_in_the_next_answer(self, seeded: Path):
        assert appdb.load_servers() == []

        add_server(seeded / "nojae.db", name="Second")

        assert [server["name"] for server in appdb.load_servers()] == ["Second"]

    def test_a_file_that_opens_but_holds_no_schema_is_the_named_failure(
        self, store_root: Path
    ):
        """A boot killed between the create and the migration leaves this file.

        SQLite opens it happily — the failure is the first statement — so without
        one read seam the accessors would answer a raw ``OperationalError`` and
        the never-raises promise of the agents read would not hold. Every read
        here goes through the same seam, so the answer is the module's own
        failure naming the path.
        """
        (store_root / "nojae.db").touch()

        with pytest.raises(appdb.AppStoreError) as caught:
            appdb.load_servers()
        assert str(store_root / "nojae.db") in str(caught.value)

        with pytest.raises(appdb.AppStoreError):
            appdb.load_prompt_helpers()

        resolved = appdb.resolve_agents()
        assert resolved["agents"] == []
        assert str(store_root / "nojae.db") in resolved["findings"][0]["message"]

    def test_every_read_goes_through_the_one_failure_seam(self):
        """The accessors never hold a handle themselves.

        Pinned as code: an accessor that called :func:`connection` directly would
        answer a driver error the module has not named, which is the difference
        between a reported store and a traceback in the chat path.
        """
        for path in store_sources():
            tree = ast.parse(path.read_text(encoding="utf-8"))
            for node in tree.body:
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                if node.name.startswith("_") or node.name == "connection":
                    continue
                held = [
                    ast.unparse(call.func)
                    for call in ast.walk(node)
                    if isinstance(call, ast.Call)
                    and (
                        isinstance(call.func, ast.Name)
                        and call.func.id == "connection"
                        or isinstance(call.func, ast.Attribute)
                        and call.func.attr == "connection"
                    )
                ]
                assert not held, f"{node.name} opens a handle instead of using _read"

    def test_the_read_path_holds_no_per_root_key(self):
        """The per-root caches of the settings and modes readers are not rebuilt.

        Checked as code, not as a sentence: a cache keyed on a root is invisible
        to a behaviour test until the day it answers a stale row. The store is
        install-scoped, so the names the workspace-scoped readers use for that
        key — a cache holding a resolved root, and the invalidation that clears
        one — must not appear in this module at all.

        The seam is not mentioned here **at all**, and that is the assertion: the
        e2e suite's flat connection fixture used to be the one exception, read
        from the workspace's reserved folder (D14). It lives with the specs that
        boot it (``web/tests``), so the store reads the installation and nothing
        in it reaches a tab's folder — the same single-owner rule
        ``tests/test_workspace_seam.py`` asserts over the whole of ``src/core``.
        """
        source = "\n".join(p.read_text(encoding="utf-8") for p in store_sources())

        assert not re.search(r"\b_CACHE\b|\binvalidate_", source), (
            "D11: the database is the cache, so there is nothing to invalidate"
        )
        assert not any(
            isinstance(node, ast.Name) and node.id.endswith("_CACHE")
            for node in ast.walk(ast.parse(source))
        )
        assert "current_root" not in source, (
            "the store is install-scoped: nothing in it may read the workspace"
        )


# -- EndpointsConfig.from_store --------------------------------------------------

class TestFromStore:
    def test_the_rows_build_the_same_object_the_file_used_to(self, seeded: Path):
        server_id = add_server(seeded / "nojae.db", url="http://host:9/v1", api_key="k")
        model_id = add_model(
            seeded / "nojae.db",
            server_id,
            name="llama-70b",
            sys_prompt="Be terse.",
            temperature=0.2,
            top_p=0.9,
            top_k=20,
            min_p=0.05,
            repeat_penalty=1.1,
            presence_penalty=0.0,
            reasoning="low",
            supports_vision=1,
        )

        server = appdb.server_row(server_id)
        model = appdb.model_row(model_id)
        assert server and model
        config = EndpointsConfig.from_store(server, model)

        assert config.serverUrl == "http://host:9/v1"
        assert config.apiKey == "k"
        assert config.endpoint == "llama-70b"
        assert config.sysprompt == "Be terse."
        assert config.supports_vision is True
        assert config.to_kwargs() == {
            "temperature": 0.2,
            "top_p": 0.9,
            "top_k": 20,
            "min_p": 0.05,
            "repeat_penalty": 1.1,
            "presence_penalty": 0.0,
            "reasoning_effort": "low",
        }
        assert config.model_list() == ["llama-70b"]

    def test_a_null_sampler_column_is_omitted_from_the_request_body(
        self, seeded: Path
    ):
        """The two values that must not converge, in one assertion each.

        ``NULL`` means "the user never set it", so the server's own default
        applies; ``0`` means "set it to zero", which is a different request. A
        builder that turned one into the other would send a sampling parameter
        nobody asked for, or drop one someone did.
        """
        server_id = add_server(seeded / "nojae.db")
        unset = add_model(seeded / "nojae.db", server_id, name="unset")
        zeroed = add_model(
            seeded / "nojae.db", server_id, name="zeroed", temperature=0, min_p=0
        )

        server = appdb.server_row(server_id)
        unset_model = appdb.model_row(unset)
        zeroed_model = appdb.model_row(zeroed)
        assert server and unset_model and zeroed_model

        assert EndpointsConfig.from_store(server, unset_model).to_kwargs() == {}
        assert EndpointsConfig.from_store(server, zeroed_model).to_kwargs() == {
            "temperature": 0,
            "min_p": 0,
        }

    def test_an_empty_sys_prompt_column_means_the_configured_prompt(self, seeded: Path):
        """D8's second level: the model's own prompt, and the app's when it has none."""
        server_id = add_server(seeded / "nojae.db")
        model_id = add_model(seeded / "nojae.db", server_id, sys_prompt="")
        server = appdb.server_row(server_id)
        model = appdb.model_row(model_id)
        assert server and model

        assert EndpointsConfig.from_store(server, model).sysprompt == DEFAULT_LLM_SYSPROMPT

    def test_a_reasoning_value_the_model_rejects_is_a_validation_error(
        self, seeded: Path
    ):
        """Same strictness as the file reader: a column does not make a bad value less bad."""
        server_id = add_server(seeded / "nojae.db")
        model_id = add_model(seeded / "nojae.db", server_id, reasoning="sideways")
        server = appdb.server_row(server_id)
        model = appdb.model_row(model_id)
        assert server and model

        with pytest.raises(ValidationError):
            EndpointsConfig.from_store(server, model)

    def test_two_missing_rows_answer_an_empty_configuration_not_a_crash(
        self, seeded: Path
    ):
        """The caller that has already decided to refuse gets a valid nothing."""
        config = EndpointsConfig.from_store(None, None)

        assert config.serverUrl == ""
        assert config.endpoint is None
        assert config.model_list() == []


# -- the one refusal sentence (D7) -----------------------------------------------

class TestTheRefusalSentence:
    def test_an_agent_with_a_model_is_not_refused(self, seeded: Path):
        model_id = add_model(seeded / "nojae.db", add_server(seeded / "nojae.db"))
        pin_agent(seeded / "nojae.db", "code", model_id)
        agent = appdb.resolve_agent("code")[0]
        assert agent

        assert config_module.agent_connection_refusal(agent) is None

    def test_the_no_model_sentence_names_the_agent(self, seeded: Path):
        """D7: "which agent" is the part the user can act on.

        The label is what the dialog's tabs and the composer's dropdown show, so
        it is the name the sentence has to carry; a sentence about a missing
        *default* would describe a setting D5 deleted.
        """
        agent = appdb.resolve_agent("code")[0]
        assert agent

        sentence = config_module.agent_connection_refusal(agent)

        assert sentence is not None
        assert "Code" in sentence
        assert "no model" in sentence
        assert "default" not in sentence.lower()

    def test_a_model_whose_server_row_is_gone_answers_the_refusal_not_a_traceback(
        self, seeded: Path
    ):
        """Reachable only through a hand-edited database — which is when it matters.

        The schema's ``ON DELETE CASCADE`` makes the app unable to produce this
        state, so the test writes the row out from under the model with foreign
        keys off, the way a hand edit does.
        """
        server_id = add_server(seeded / "nojae.db")
        model_id = add_model(seeded / "nojae.db", server_id)
        pin_agent(seeded / "nojae.db", "code", model_id)
        conn = raw(seeded / "nojae.db")
        try:
            conn.execute("DELETE FROM servers")
            conn.commit()
        finally:
            conn.close()

        agent = appdb.resolve_agent("code")[0]
        assert agent and agent["modelId"] == model_id

        sentence = config_module.agent_connection_refusal(agent)

        assert sentence is not None
        assert "Code" in sentence
        assert str(seeded / "nojae.db") in sentence

    def test_an_unusable_store_answers_the_sentence_naming_the_path(
        self, store_root: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """The third state, and the one the boot already found (§4.3).

        A folder standing where the file belongs makes the store unopenable, so
        the boot records the named state and the refusal quotes it — the same
        sentence the app bar shows, because both read the one the boot kept.
        """
        (store_root / "nojae.db").mkdir()
        result = appdb.boot()
        assert result["state"] == "unusable"
        agent = {"id": "code", "label": "Code", "modelId": None}

        sentence = config_module.agent_connection_refusal(agent)

        assert sentence == result["sentence"]
        assert str(store_root / "nojae.db") in sentence

    def test_a_store_that_became_unusable_mid_request_is_refused_not_raised(
        self, seeded: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """The boot said ``ok``; the read says otherwise. Still one sentence.

        The seam's contract is ``(config, None)`` or ``(None, sentence)``, so a
        failure that arrives after the boot's verdict has to join the refusal
        rather than escape as an exception the SSE path would lose.
        """
        model_id = add_model(seeded / "nojae.db", add_server(seeded / "nojae.db"))
        pin_agent(seeded / "nojae.db", "code", model_id)
        agent = appdb.resolve_agent("code")[0]
        assert agent

        def unusable(_model_id: Any) -> Any:
            raise appdb.AppStoreError(
                f"nojae's settings store at {seeded / 'nojae.db'} cannot be opened."
            )

        monkeypatch.setattr(appdb, "model_row", unusable)

        sentence = config_module.agent_connection_refusal(agent)

        assert sentence is not None and "cannot be opened" in sentence

    def test_the_three_states_are_the_only_ones_the_sentence_names(self, seeded: Path):
        """No ladder: a model set means that model and its server, or the sentence.

        Enumerated rather than trusted: the seam's whole point is that it has two
        branches, and a fourth answer would be a silent default wearing a
        sentence's clothes.
        """
        good_model = add_model(seeded / "nojae.db", add_server(seeded / "nojae.db"))
        cases: List[Tuple[str, Optional[int], Optional[str]]] = [
            ("no model", None, "no model"),
            ("dangling model", 999999, "no model"),
            ("runnable", good_model, None),
        ]

        for _title, model_id, expected in cases:
            pin_agent(seeded / "nojae.db", "code", model_id)
            agent = appdb.resolve_agent("code")[0]
            assert agent
            sentence = config_module.agent_connection_refusal(agent)
            if expected is None:
                assert sentence is None, _title
            else:
                assert sentence is not None and expected in sentence, _title


# -- the resolution seam ---------------------------------------------------------

class TestTheResolutionSeam:
    def test_a_runnable_agent_resolves_its_own_connection(self, seeded: Path):
        """The happy branch, and the per-agent part: two agents, two connections."""
        first_server = add_server(seeded / "nojae.db", name="A", url="http://a/v1")
        second_server = add_server(seeded / "nojae.db", name="B", url="http://b/v1")
        first_model = add_model(seeded / "nojae.db", first_server, name="m-a")
        second_model = add_model(seeded / "nojae.db", second_server, name="m-b")
        pin_agent(seeded / "nojae.db", "code", first_model)
        pin_agent(seeded / "nojae.db", "chat", second_model)

        code, code_error = config_module.load_endpoints_config(
            appdb.resolve_agent("code")[0]
        )
        chat, chat_error = config_module.load_endpoints_config(
            appdb.resolve_agent("chat")[0]
        )

        assert code_error is None and chat_error is None
        assert code and chat
        assert (code.serverUrl, code.endpoint) == ("http://a/v1", "m-a")
        assert (chat.serverUrl, chat.endpoint) == ("http://b/v1", "m-b")

    def test_an_unrunnable_agent_resolves_to_the_sentence(self, seeded: Path):
        agent = appdb.resolve_agent("code")[0]
        assert agent

        config, error = config_module.load_endpoints_config(agent)

        assert config is None
        assert isinstance(error, str)
        assert error == config_module.agent_connection_refusal(agent)

    def test_a_sampler_value_pydantic_rejects_answers_a_validation_error(
        self, seeded: Path
    ):
        """The seam keeps the third shape the old one had, so the route keeps its 422."""
        server_id = add_server(seeded / "nojae.db")
        model_id = add_model(seeded / "nojae.db", server_id, reasoning="sideways")
        pin_agent(seeded / "nojae.db", "code", model_id)
        agent = appdb.resolve_agent("code")[0]
        assert agent

        config, error = config_module.load_endpoints_config(agent)

        assert config is None
        assert isinstance(error, ValidationError)

    def test_the_seam_reads_the_rows_once(self, seeded: Path, monkeypatch: pytest.MonkeyPatch):
        """The refusal check and the builder see the **same** rows.

        A save that lands between two reads would otherwise let the seam clear
        the refusal on one model and build the connection from another — the one
        way a turn that resolves once at its start could still be split.
        """
        server_id = add_server(seeded / "nojae.db")
        model_id = add_model(seeded / "nojae.db", server_id)
        pin_agent(seeded / "nojae.db", "code", model_id)
        agent = appdb.resolve_agent("code")[0]
        assert agent

        reads: List[Tuple[str, Any]] = []
        real_model_row = appdb.model_row
        real_server_row = appdb.server_row

        def counted_model_row(value: Any) -> Any:
            reads.append(("model", value))
            return real_model_row(value)

        def counted_server_row(value: Any) -> Any:
            reads.append(("server", value))
            return real_server_row(value)

        monkeypatch.setattr(appdb, "model_row", counted_model_row)
        monkeypatch.setattr(appdb, "server_row", counted_server_row)

        config, error = config_module.load_endpoints_config(agent)

        assert error is None and config
        assert reads == [("model", model_id), ("server", server_id)]

    def test_the_seam_answers_a_sentence_and_never_an_http_status(self):
        """Core owns logic, the API owns transport (AGENTS.md).

        Checked as code: the seam lives in ``config``, which imports no web
        framework, and nothing it returns is an HTTP exception.
        """
        source = Path(config_module.__file__).read_text(encoding="utf-8")
        assert "HTTPException" not in source
        assert "fastapi" not in source.lower()
        assert "status_code" not in source

    def test_the_seam_is_the_only_one(self, seeded: Path):
        """Task 09 moved the callers and deleted the file-only function.

        ``load_endpoints_config`` takes the resolved agent, and there is no
        second seam beside it: two functions answering "which connection" would
        be two authorities on a turn (D7).
        """
        assert callable(config_module.load_endpoints_config)
        assert callable(config_module.agent_connection_refusal)
        assert callable(config_module.max_tool_iteration)


# -- the per-agent cap (D9) ------------------------------------------------------

class TestThePerAgentCap:
    def test_the_cap_comes_from_the_agent_row(self, seeded: Path):
        conn = raw(seeded / "nojae.db")
        try:
            conn.execute("UPDATE agents SET max_tool_iteration = 7 WHERE id = 'code'")
            conn.commit()
        finally:
            conn.close()

        agent = appdb.resolve_agent("code")[0]
        assert agent

        assert appdb.agent_max_tool_iteration(agent) == 7

    def test_the_floor_is_one_and_there_is_no_ceiling(self, seeded: Path):
        """Today's reader enforces only the floor, and nothing here adds a bound.

        The 500 found in a live settings file is a value someone typed, not a
        limit the app imposed.
        """
        for stored, expected in ((0, 1), (-5, 1), (1, 1), (500, 500), (100000, 100000)):
            conn = raw(seeded / "nojae.db")
            try:
                conn.execute(
                    "UPDATE agents SET max_tool_iteration = ? WHERE id = 'code'",
                    (stored,),
                )
                conn.commit()
            finally:
                conn.close()
            agent = appdb.resolve_agent("code")[0]
            assert agent
            assert appdb.agent_max_tool_iteration(agent) == expected, stored

    def test_the_built_ins_are_seeded_at_their_own_two_numbers(
        self, seeded: Path
    ):
        """A fresh install behaves exactly as it did before the column existed —
        except the app-owned agent, whose lot-building turn is capped higher."""
        for agent in appdb.resolve_agents()["agents"]:
            expected = (
                appdb.SEEDED_RESERVED_MAX_TOOL_ITERATION
                if agent["readonly"]
                else config_module.DEFAULT_MAX_TOOL_ITERATION
            )
            assert appdb.agent_max_tool_iteration(agent) == expected, agent["id"]

    def test_the_cap_is_read_from_the_agent_and_not_from_the_workspace(self):
        """The accessor takes the resolved agent: no workspace, no file, no default.

        Which number bounds a turn is now a property of the persona the turn runs
        as, so the signature is the rule — a caller cannot ask for "the" cap.
        """
        import inspect

        signature = inspect.signature(appdb.agent_max_tool_iteration)

        assert list(signature.parameters) == ["agent"]


# -- the agents read model -------------------------------------------------------

class TestTheAgentsReadModel:
    def test_the_answer_holds_no_default_key(self, seeded: Path):
        """D5: a key that always answered "nothing" would be read as meaningful."""
        resolved = appdb.resolve_agents()

        assert "default" not in resolved
        assert sorted(resolved) == ["agents", "findings"]

    def test_the_agents_come_back_in_insertion_order_with_the_app_owned_last(
        self, seeded: Path
    ):
        assert [agent["id"] for agent in appdb.resolve_agents()["agents"]] == list(
            BUILT_IN_IDS
    )

    def test_the_app_owned_agent_is_last_whatever_the_table_says(self, seeded: Path):
        """The modes read's rule, kept: the reserved agent is appended, not sorted in."""
        conn = raw(seeded / "nojae.db")
        try:
            conn.execute("DELETE FROM agents")
            for agent_id, label in (
                ("todoBuilder", "Todo builder"),
                ("code", "Code"),
                ("chat", "Chat"),
            ):
                conn.execute(
                    "INSERT INTO agents (id, label, system_message) VALUES (?, ?, ?)",
                    (agent_id, label, ""),
                )
            conn.commit()
        finally:
            conn.close()

        assert [agent["id"] for agent in appdb.resolve_agents()["agents"]] == [
            "code",
            "chat",
            "todoBuilder",
        ]

    def test_a_hand_corrupted_row_is_reported_and_the_rest_still_render(
        self, seeded: Path
    ):
        """The never-raises promise: a bad row is a finding, not a dead dropdown.

        SQLite's type affinity is what makes this reachable at all — a column
        declared ``INTEGER NOT NULL`` holds the text ``"lots"`` in a file someone
        edited by hand, because the declaration is a preference SQLite applies
        only when it can.
        """
        conn = raw(seeded / "nojae.db")
        try:
            conn.execute("UPDATE agents SET max_tool_iteration = 'lots' WHERE id = 'code'")
            conn.commit()
        finally:
            conn.close()

        resolved = appdb.resolve_agents()

        assert [agent["id"] for agent in resolved["agents"]] == [
            "chat",
            "architect",
            "todoBuilder",
        ]
        assert len(resolved["findings"]) == 1
        finding = resolved["findings"][0]
        assert finding["kind"] == appdb.FINDING_ERROR
        assert "code" in finding["message"]
        assert "max_tool_iteration" in finding["message"]

    def test_the_read_never_raises_for_any_of_the_ways_a_row_can_be_damaged(
        self, seeded: Path
    ):
        """One damaged column per row, and every row is reported.

        The values are the ones SQLite actually stores: a ``NOT NULL`` column
        refuses an explicit ``NULL`` before the reader ever sees it, so the
        realistic hand edit is the empty string or the wrong affinity. And a row
        is dropped **as a unit**, so four damaged rows are four findings and no
        agent — a persona with tools and no label is the thing this feature
        exists to prevent, not a row to render.
        """
        conn = raw(seeded / "nojae.db")
        try:
            for statement in (
                "UPDATE agents SET label = '' WHERE id = 'chat'",
                "UPDATE agents SET mcp_enable = 'yes' WHERE id = 'code'",
                "UPDATE agents SET readonly = 2.5 WHERE id = 'architect'",
                "UPDATE agents SET model_id = 'first' WHERE id = 'todoBuilder'",
            ):
                conn.execute(statement)
            conn.commit()
        finally:
            conn.close()

        resolved = appdb.resolve_agents()

        assert resolved["agents"] == []
        assert len(resolved["findings"]) == 4
        for agent_id in ("chat", "code", "architect", "todoBuilder"):
            assert any(agent_id in finding["message"] for finding in resolved["findings"])

    def test_an_unopenable_store_answers_no_agents_and_the_sentence(self, store_root: Path):
        (store_root / "nojae.db").mkdir()

        resolved = appdb.resolve_agents()

        assert resolved["agents"] == []
        assert [finding["kind"] for finding in resolved["findings"]] == [
            appdb.FINDING_ERROR
        ]
        assert str(store_root / "nojae.db") in resolved["findings"][0]["message"]

    def test_each_row_carries_whether_it_can_run_at_all(self, seeded: Path):
        """The composer's warning (task 12) reads a field, not a rule over two tables."""
        model_id = add_model(seeded / "nojae.db", add_server(seeded / "nojae.db"), name="gpt")
        pin_agent(seeded / "nojae.db", "code", model_id)

        agents = {agent["id"]: agent for agent in appdb.resolve_agents()["agents"]}

        assert agents["code"]["modelId"] == model_id
        assert agents["code"]["modelName"] == "gpt"
        assert agents["chat"]["modelId"] is None
        assert agents["chat"]["modelName"] is None

    def test_a_row_naming_a_model_that_is_not_there_is_reported_and_cannot_run(
        self, seeded: Path
    ):
        conn = raw(seeded / "nojae.db")
        try:
            conn.execute("UPDATE agents SET model_id = 999999 WHERE id = 'code'")
            conn.commit()
        finally:
            conn.close()

        agents = {agent["id"]: agent for agent in appdb.resolve_agents()["agents"]}
        findings = appdb.resolve_agents()["findings"]

        assert agents["code"]["modelId"] == 999999
        assert agents["code"]["modelName"] is None
        assert any("code" in finding["message"] for finding in findings)

    def test_the_read_invents_no_persona_and_no_capability(self, seeded: Path):
        """A mode only narrows what settings and the conversation already allow.

        Every field of a row is a column, so nothing here can add a persona or a
        hub a row does not state: the answer's keys are the columns plus the
        resolved model's name, and the built-ins' text is the module that holds
        it, read rather than rewritten.
        """
        agent = appdb.resolve_agent("code")[0]
        assert agent

        assert sorted(agent) == sorted(
            {
                "id", "label", "maxToolIteration", "mcpEnable", "lspEnable",
                "systemMessage", "readonly", "modelId", "modelName",
            }
        )
        from src.core import agent_modes_defaults as defaults

        declared = {mode.id: mode for mode in defaults.default_modes()}
        assert agent["systemMessage"] == declared["code"].system_message
        assert agent["mcpEnable"] is declared["code"].mcptools
        assert agent["lspEnable"] is declared["code"].lsptools


class TestResolvingOneAgent:
    def test_an_id_in_answers_that_row(self, seeded: Path):
        agent, findings = appdb.resolve_agent("architect")

        assert agent and agent["id"] == "architect"
        assert findings == []

    def test_a_missing_id_resolves_to_nothing(self, seeded: Path):
        """D5: no server-side default to fall back to, so the contract narrows.

        Today ``None`` means "the file's default"; a turn with no ``agentMode``
        is now the 422 naming the field, so the function answers nothing and the
        caller says so.
        """
        for missing in (None, "", "   "):
            agent, _findings = appdb.resolve_agent(missing)
            assert agent is None, repr(missing)

    def test_an_unknown_id_resolves_to_nothing(self, seeded: Path):
        agent, _findings = appdb.resolve_agent("nope")

        assert agent is None

    def test_the_ids_a_message_lists_are_the_ones_the_read_answers(self, seeded: Path):
        """The unknown-id branch's message is unchanged, so its source must be there.

        The route builds it from the list of ids; the read model is what supplies
        that list, in the same order the dropdown shows.
        """
        _agent, _findings = appdb.resolve_agent("nope")

        available = ", ".join(agent["id"] for agent in appdb.resolve_agents()["agents"])

        assert available == "chat, code, architect, todoBuilder"

    def test_the_findings_ride_along(self, seeded: Path):
        conn = raw(seeded / "nojae.db")
        try:
            conn.execute("UPDATE agents SET label = '' WHERE id = 'code'")
            conn.commit()
        finally:
            conn.close()

        agent, findings = appdb.resolve_agent("chat")

        assert agent and agent["id"] == "chat"
        assert len(findings) == 1


# -- the prompt-helper rows ------------------------------------------------------

class TestTheHelperRows:
    def test_a_created_store_starts_with_nine_empty_gray_rows(self, seeded: Path):
        """The nine bullets a first boot draws today, so the move is invisible."""
        helpers = appdb.load_prompt_helpers()

        assert len(helpers) == 9
        assert all(row["color"] == "#808080" for row in helpers)
        assert all(row["content"] == "" for row in helpers)

    def test_a_row_is_a_bullet_and_the_count_is_simply_the_count(self, seeded: Path):
        """§4.5: the "exactly nine or an error" rule is deleted, not relaxed."""
        conn = raw(seeded / "nojae.db")
        try:
            conn.execute("DELETE FROM prompt_helpers WHERE id > 2")
            conn.execute(
                "INSERT INTO prompt_helpers (color_code, content) VALUES (?, ?)",
                ("#ff0000", "Refactor this file."),
            )
            conn.commit()
        finally:
            conn.close()

        helpers = appdb.load_prompt_helpers()

        assert len(helpers) == 3
        assert helpers[-1]["content"] == "Refactor this file."

    def test_zero_rows_is_an_answer_not_an_error(self, seeded: Path):
        """A user who deleted every bullet made the table empty, and that stands."""
        conn = raw(seeded / "nojae.db")
        try:
            conn.execute("DELETE FROM prompt_helpers")
            conn.commit()
        finally:
            conn.close()

        assert appdb.load_prompt_helpers() == []

    def test_the_rows_carry_the_id_the_writes_address_them_by(self, seeded: Path):
        """No slot index survives a count the user owns, so the id is the handle."""
        assert sorted(appdb.load_prompt_helpers()[0]) == sorted(
            {"id", "color", "content"}
        )

    def test_the_rows_come_back_in_insertion_order(self, seeded: Path):
        assert [row["id"] for row in appdb.load_prompt_helpers()] == list(range(1, 10))


# -- the interim state the lot leaves behind -------------------------------------

class TestTheTurnResolvesThroughTheStore:
    """Task 09's switch, pinned as code rather than claimed.

    The store is the only authority on which connection answers a turn (D7):
    the seam takes the resolved agent, the routes and the chat route call it
    with that agent's row, and the file-based reader is **gone** rather than
    left beside it — two seams would be two authorities on a turn.
    """

    def test_the_routes_and_the_chat_route_resolve_through_the_seam(self):
        routes_source = routes_tree_source()
        config_source = Path(config_module.__file__).read_text(encoding="utf-8")

        # The seam reads the agent's row, and it is the one builder.
        assert "appdb.model_row(" in config_source
        assert "appdb.server_row(" in config_source
        assert "EndpointsConfig.from_store(" in config_source
        # The routes ask the seam *per agent*, and the chat route resolves one.
        assert "load_endpoints_config(agent)" in routes_source
        assert "appdb.resolve_agent(" in routes_source

    def test_the_file_based_reader_is_gone(self):
        """Deleted, not deprecated: no compatibility reader, no second builder."""
        root = Path(appdb.__file__).resolve().parents[3]
        models_source = (root / "src/core/models.py").read_text(encoding="utf-8")
        config_source = Path(config_module.__file__).read_text(encoding="utf-8")

        assert "def from_store" in models_source
        assert "from_workspace" not in models_source
        for name in ("workspace_settings", "nojae-settings"):
            assert name not in config_source, (
                f"config still names {name}: the file layer is deleted, not "
                "deprecated (spec §4.7)"
            )

    def test_the_store_module_is_the_only_module_that_names_the_file(self):
        """§4.1: nobody else opens a file, and nobody else writes SQL.

        Guarded on the *call*, not the word: ``sqlite3`` is what opens a file,
        and :func:`src.core.appdb.database_path` is the only function that hands
        one out. Prose about where the store lives, and the level-A rule that
        hides it, name neither.
        """
        root = Path(appdb.__file__).resolve().parents[3]
        store_package = (root / "src" / "core" / "appdb").resolve()
        offenders: List[str] = []
        for path in (root / "src").rglob("*.py"):
            if store_package in path.resolve().parents:
                continue  # the store package *is* the one that speaks SQL
            text = path.read_text(encoding="utf-8")
            if re.search(r"^\s*(?:import|from)\s+sqlite3\b", text, re.MULTILINE):
                offenders.append(f"{path.relative_to(root)}: imports sqlite3")
            if re.search(r"sqlite3\.connect\(", text):
                offenders.append(f"{path.relative_to(root)}: opens a database")

        # ``appdb.database_path()`` is *named* outside the store by the refusal
        # sentence (which must name the store it could not use), never handed
        # to a driver. That is a sentence, not an open, so it stays.
        # And no *public* core function takes a path to the database: the
        # module's private helpers spell one because they are the ones building
        # it (``_uri``, ``_describe``), which is the seam's own business.
        store_source = "\n".join(p.read_text(encoding="utf-8") for p in store_sources())
        public_defs = re.findall(r"^def (\w+)\((.*?)\)", store_source, re.MULTILINE)
        for function, params in public_defs:
            if function.startswith("_"):
                continue
            assert "db_path" not in params and "target" not in params, (
                f"appdb.{function} accepts a database path (§4.1)"
            )
        assert offenders == []
