import json
import logging
import os
from pathlib import Path
from typing import Any, Dict

import pytest

from src.core.llmkit import client as llmkit_client
from src.core.llmkit import constants as llmkit_constants
from src.core import appdb
from src.config import (
    DEFAULT_MAX_TOOL_ITERATION,
    LLM_DEBUG_KEY,
    LEGACY_LLM_DEBUG_KEY,
    PATH_LOCATION_KEY,
    _DebugStreamHandler,
    agent_instructions_block,
    apply_llm_debug,
    agent_connection_refusal,
    llm_debug_enabled,
    load_agent_instructions,
    max_tool_iteration,
    default_path_location,
    load_endpoints_config,
    path_location,
    setup_path_location,
)
from src.core.models import DEFAULT_LLM_SYSPROMPT
from tests.conftest import neutralise_store, write_store_connection


def agent_row(agent_id: str = "code") -> Dict[str, Any]:
    """The store's row for ``agent_id``, as a turn hands it to the seam.

    A turn resolves an agent once, at its start (D7), and the seam takes that
    row: ``modelId`` says which model answers and ``maxToolIteration`` bounds the
    tool loop (D9). Every case below asks through this, so a case that wants an
    agent with **no** model clears the row itself
    (:func:`tests.conftest.clear_agent_model`).
    """
    row, _findings = appdb.resolve_agent(agent_id)
    assert row is not None, f"the seeded store has no agent {agent_id!r}"
    return row


class TestLoadEndpointsConfig:
    """The one reader of a **turn's** model connection.

    Every case here points the store at a database of its own (the ``conftest``
    helper) and writes its own rows, because the alternative — an ambient answer
    — would make the assertions about this machine's model connection rather
    than about the function.
    """

    def test_reads_the_model_connection_from_the_agents_row(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        neutralise_store(
            monkeypatch,
            tmp_path,
            serverUrl="http://localhost:8080/v1",
            serverApiKey="sk-target",
            endpoint="model-a",
            sysprompt="Answer briefly.",
            supportsVision=True,
            temperature=0.7,
            reasoning="low",
        )

        config, error = load_endpoints_config(agent_row())
        assert error is None
        assert config is not None
        assert config.serverUrl == "http://localhost:8080/v1"
        assert config.apiKey == "sk-target"
        assert config.model_list() == ["model-a"]
        assert config.sysprompt == "Answer briefly."
        assert config.supports_vision is True
        assert config.temperature == 0.7
        assert config.reasoning_effort == "low"

    def test_a_group_one_value_only_in_the_env_is_not_picked_up(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """D2: a ``.env`` line left behind is dead bytes — no fallback."""
        neutralise_store(
            monkeypatch, tmp_path, serverUrl="", serverApiKey="", endpoint=""
        )
        monkeypatch.setenv("SERVER_URL", "http://left-over:9/v1")
        monkeypatch.setenv("SERVER_URL_API_KEY", "sk-left-over")
        monkeypatch.setenv("ENDPOINT", "left-over-model")
        monkeypatch.setenv("TEMPERATURE", "0.9")

        config, error = load_endpoints_config(agent_row())
        assert error is None
        assert config is not None
        assert config.serverUrl == ""
        assert config.apiKey == ""
        assert config.model_list() == []
        # The row's own 0.2 answers, never the env's 0.9.
        assert config.temperature == 0.2

    def test_a_null_sampler_column_omits_the_key_from_the_request_body(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """§4.2: a ``NULL`` sampler is "unset" and is omitted; a ``0`` is kept."""
        neutralise_store(monkeypatch, tmp_path)
        conn = appdb.connection()
        conn.execute("UPDATE models SET temperature = NULL, top_k = 0")

        config, error = load_endpoints_config(agent_row())
        assert error is None
        assert config is not None
        assert config.temperature is None
        assert "temperature" not in config.to_kwargs()
        # The zero is a value someone chose, so it stays in the body.
        assert config.top_k == 0
        assert config.to_kwargs()["top_k"] == 0

    def test_the_native_vision_flag_is_true(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """The native path: a stored ``1`` reaches pydantic as ``True``."""
        neutralise_store(monkeypatch, tmp_path, supportsVision=True)
        config, error = load_endpoints_config(agent_row())
        assert error is None
        assert config is not None
        assert config.supports_vision is True

    def test_an_agent_with_no_model_is_a_sentence_naming_the_agent(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """D5/D7: the refusal names the agent, because that is what a user can act on."""
        neutralise_store(monkeypatch, tmp_path, agents_without_model=("code",))

        config, error = load_endpoints_config(agent_row())
        assert config is None
        assert isinstance(error, str)
        # It names the agent by the human-facing label, which is the part a user
        # can act on; a sentence about a *default* would describe nothing.
        assert agent_row()["label"] in error
        assert "no model" in error
        # And the single builder answers the same sentence.
        assert agent_connection_refusal(agent_row()) == error

    def test_an_unusable_store_is_a_sentence_naming_the_path(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """An unopenable store refuses, never answers on defaults (§4.3)."""
        neutralise_store(monkeypatch, tmp_path)
        row = agent_row()
        # Move the store out from under the read: the file is gone, so every
        # answer has to come from the named state rather than from empty rows.
        appdb.database_path().unlink()
        appdb.close_thread_connection()

        config, error = load_endpoints_config(row)
        assert config is None
        assert isinstance(error, str)
        assert str(appdb.database_path()) in error

    def test_the_refusal_sentence_is_built_in_one_place(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """``load_endpoints_config`` and ``agent_connection_refusal`` agree.

        The Settings dialog and the app bar reuse that function; if the two
        sentences could differ, they would disagree about the same agent.
        """
        neutralise_store(monkeypatch, tmp_path)
        assert agent_connection_refusal(agent_row()) is None
        assert load_endpoints_config(agent_row())[1] is None

        write_store_connection(tmp_path, endpoint="model-b")
        neutralise_store(monkeypatch, tmp_path, agents_without_model=("code",))
        sentence = agent_connection_refusal(agent_row())
        assert sentence
        assert load_endpoints_config(agent_row())[1] == sentence


class TestThePerAgentCap:
    """``max_tool_iteration()`: the resolved agent's column (D9).

    Its sibling — the reader of the workspace file's ``lspEnabled`` array — is
    gone rather than re-pointed: D13 made the declaration file's ``enable`` flag
    the only LSP gate, so there is no second list of ids for a config helper to
    read.
    """

    def test_the_agents_column_wins_over_the_code_default(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        neutralise_store(monkeypatch, tmp_path)
        conn = appdb.connection()
        conn.execute("UPDATE agents SET max_tool_iteration = 9 WHERE id = 'code'")
        assert max_tool_iteration(agent_row()) == 9

    def test_no_agent_answers_the_seeded_number(self):
        """A caller with no turn to speak of gets the number a built-in is seeded with."""
        assert max_tool_iteration() == DEFAULT_MAX_TOOL_ITERATION

    def test_zero_or_negative_clamps_to_one(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """A floor of 1 and **no ceiling** — what today's reader already enforces."""
        neutralise_store(monkeypatch, tmp_path)
        conn = appdb.connection()
        for value in (0, -5):
            conn.execute(
                "UPDATE agents SET max_tool_iteration = ? WHERE id = 'code'", (value,)
            )
            assert max_tool_iteration(agent_row()) == 1

    def test_a_huge_cap_is_a_value_not_a_limit(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """The 500 found in a live file was typed, not imposed; nothing bounds it."""
        neutralise_store(monkeypatch, tmp_path)
        appdb.connection().execute(
            "UPDATE agents SET max_tool_iteration = 5000 WHERE id = 'code'"
        )
        assert max_tool_iteration(agent_row()) == 5000

    def test_the_env_names_are_ignored(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """``MAX_TOOL_ITERATION`` / ``MAX_MCP_ITERATION`` reach nothing.

        The first left ``.env`` with the rest of group 1 (D2: no fallback); the
        second was the hand-written-``.env`` escape hatch for a file that no
        longer holds the key, so it stopped being honoured (spec section 5).
        """
        neutralise_store(monkeypatch, tmp_path)
        conn = appdb.connection()
        conn.execute("UPDATE agents SET max_tool_iteration = 4 WHERE id = 'code'")
        monkeypatch.setenv("MAX_TOOL_ITERATION", "7")
        monkeypatch.setenv("MAX_MCP_ITERATION", "7")
        assert max_tool_iteration(agent_row()) == 4


class TestPathLocation:
    """The boot default of NOJAE_PATH_LOCATION (the hubs' working dir)."""

    def test_seeded_from_the_install_dir_when_unset(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.delenv(PATH_LOCATION_KEY, raising=False)
        setup_path_location()
        assert os.environ[PATH_LOCATION_KEY] == default_path_location()
        assert path_location() == default_path_location()

    def test_an_existing_value_wins(self, monkeypatch: pytest.MonkeyPatch):
        # Exported by the launcher or written in .env: boot must not clobber
        # it, which is what lets an operator pin the location.
        monkeypatch.setenv(PATH_LOCATION_KEY, "/somewhere/else")
        setup_path_location()
        assert path_location() == "/somewhere/else"

    def test_blank_value_is_treated_as_unset(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv(PATH_LOCATION_KEY, "   ")
        setup_path_location()
        assert path_location() == default_path_location()

    def test_is_idempotent(self, monkeypatch: pytest.MonkeyPatch):
        # create_app() runs per test; re-seeding must not drift the value.
        monkeypatch.delenv(PATH_LOCATION_KEY, raising=False)
        setup_path_location()
        first = os.environ[PATH_LOCATION_KEY]
        setup_path_location()
        assert os.environ[PATH_LOCATION_KEY] == first

    def test_read_live_after_an_api_style_change(self, monkeypatch: pytest.MonkeyPatch):
        # The endpoint mutates os.environ directly; path_location() must see it
        # without any reload, which is what makes the tool restart pick it up.
        monkeypatch.setenv(PATH_LOCATION_KEY, "/before")
        assert path_location() == "/before"
        monkeypatch.setenv(PATH_LOCATION_KEY, "/after")
        assert path_location() == "/after"


class TestAgentInstructions:
    """The project instructions (AGENTS.md) injected into the Chat prompt."""

    def test_reads_the_file_at_the_location_root(self, tmp_path: Path):
        (tmp_path / "AGENTS.md").write_text("# rules\n\nUse pytest.\n", encoding="utf-8")
        assert load_agent_instructions(str(tmp_path)) == "# rules\n\nUse pytest."

    def test_missing_file_yields_empty(self, tmp_path: Path):
        assert load_agent_instructions(str(tmp_path)) == ""

    def test_unreadable_file_yields_empty(self, tmp_path: Path):
        # A directory named AGENTS.md raises OSError: never propagate it, a
        # chat request must work even when the lookup is broken.
        (tmp_path / "AGENTS.md").mkdir()
        assert load_agent_instructions(str(tmp_path)) == ""

    def test_resolves_the_location_live(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
        # No explicit location: the working location is read at call time, so
        # moving it through the settings dialog moves the lookup too.
        (tmp_path / "AGENTS.md").write_text("from the env", encoding="utf-8")
        monkeypatch.setenv(PATH_LOCATION_KEY, str(tmp_path))
        assert load_agent_instructions() == "from the env"

    def test_block_frames_the_text_with_the_project_root(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setenv(PATH_LOCATION_KEY, "/srv/proj")
        block = agent_instructions_block("mind the conventions")
        assert "The current project root is /srv/proj" in block
        assert block.endswith("mind the conventions")
        assert "AGENTS.md" in block

    def test_block_is_empty_without_instructions(self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path):
        # No file (and no text) means the system prompt is left untouched.
        monkeypatch.setenv(PATH_LOCATION_KEY, str(tmp_path))
        assert agent_instructions_block() == ""
        assert agent_instructions_block("   ") == ""

    def test_block_reads_the_file_when_no_text_is_given(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        (tmp_path / "AGENTS.md").write_text("body text", encoding="utf-8")
        monkeypatch.setenv(PATH_LOCATION_KEY, str(tmp_path))
        assert agent_instructions_block().endswith("body text")

    def test_a_renamed_file_is_not_picked_up(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        (tmp_path / "AGENTS.md").write_text("nope", encoding="utf-8")
        monkeypatch.setattr("src.config.agent_instructions_filename", lambda: "OTHER.md")
        monkeypatch.setenv(PATH_LOCATION_KEY, str(tmp_path))
        assert load_agent_instructions() == ""


def _llm_logger() -> logging.Logger:
    """The logger ``core/llmkit`` writes its request payloads to."""
    return logging.getLogger(llmkit_constants.DEBUG_LOGGER_NAME)


def _switch_handlers(logger: logging.Logger) -> list:
    """Only the handlers the debug switch itself attaches.

    Asked by class, because the logger legitimately carries others: the one an
    app boot attached when the developer's ``.env`` turns the switch on, and
    pytest's own capture handlers. A total over ``logger.handlers`` would make an
    assertion here depend on the machine and on the tests that ran before it.
    """
    return [h for h in logger.handlers if isinstance(h, _DebugStreamHandler)]


class TestLLMDebugFlag:
    """The LLM_DEBUG switch: how it is read, what it does to ``nojae.llm``.

    Both keys are unset, and the logger and the client's payload hook restored,
    around every test of the suite (``conftest._no_debug_switch_leak``), so each
    case states only the key it cares about and the switch's writes to
    process-wide state stay inside the test that made them.
    """

    def test_truthy_spellings_enable_it(self, monkeypatch):
        for raw in ("1", "true", "TRUE", " on "):
            monkeypatch.setenv(LLM_DEBUG_KEY, raw)
            assert llm_debug_enabled() is True
        for raw in ("", "0", "false", "off", "yes please"):
            monkeypatch.setenv(LLM_DEBUG_KEY, raw)
            assert llm_debug_enabled() is False

    def test_unset_means_off(self):
        assert llm_debug_enabled() is False

    def test_the_fallback_key_is_the_pre_rename_name(self):
        """The one place the old name is spelled outside ``config`` itself.

        The whole D6 fallback hangs on this exact string, so renaming the
        constant would be a behaviour change and not a tidy-up — which is what
        makes it worth pinning by value, not by the constant's own name.
        """
        assert LEGACY_LLM_DEBUG_KEY == "LITELLM_DEBUG"
        assert LLM_DEBUG_KEY == "LLM_DEBUG"

    def test_the_legacy_key_alone_still_enables_it(self, monkeypatch):
        # A .env written by hand before the rename keeps working until the
        # settings dialog regenerates that file from its template.
        monkeypatch.setenv(LEGACY_LLM_DEBUG_KEY, "1")
        assert llm_debug_enabled() is True

    def test_the_new_key_wins_when_both_are_set(self, monkeypatch):
        monkeypatch.setenv(LLM_DEBUG_KEY, "0")
        monkeypatch.setenv(LEGACY_LLM_DEBUG_KEY, "1")
        assert llm_debug_enabled() is False
        monkeypatch.setenv(LLM_DEBUG_KEY, "1")
        monkeypatch.setenv(LEGACY_LLM_DEBUG_KEY, "off")
        assert llm_debug_enabled() is True

    def test_apply_on_raises_the_clients_logger_and_owns_its_hook(self, monkeypatch):
        monkeypatch.setenv(LLM_DEBUG_KEY, "1")
        logger = _llm_logger()

        assert apply_llm_debug() is True
        assert logger.level == logging.DEBUG
        # Exactly one handler *of ours*, counted as such rather than as a total:
        # an app that booted with the switch on, and pytest's own capture, also
        # put handlers on this logger and the switch must not disturb them. The
        # handler is what makes the flag observable at all — a level alone would
        # print nothing, since uvicorn attaches handlers to its own loggers only.
        assert len(_switch_handlers(logger)) == 1
        assert logger.propagate is False
        # The payload hook follows the switch (the payload half of D8).
        assert llmkit_client.debug_enabled is llm_debug_enabled
        assert llmkit_client.debug_enabled() is True

    def test_apply_off_leaves_the_logger_as_it_was_found(self, monkeypatch):
        monkeypatch.setenv(LLM_DEBUG_KEY, "1")
        logger = _llm_logger()

        apply_llm_debug()
        # Boot plus one call per settings save: a second must not stack another,
        # or every payload is printed once per save.
        apply_llm_debug()
        assert len(_switch_handlers(logger)) == 1

        monkeypatch.setenv(LLM_DEBUG_KEY, "")
        assert apply_llm_debug() is False
        # Ours gone (whichever of them the boot had attached), the level back to
        # NOTSET — inherited from the root logger, as it stood before the switch
        # existed — and propagation restored, so a process is never left chatty
        # (nor silent) after the flag is cleared.
        assert _switch_handlers(logger) == []
        assert logger.level == logging.NOTSET
        assert logger.propagate is True
        assert llmkit_client.debug_enabled is llm_debug_enabled
        assert llmkit_client.debug_enabled() is False
