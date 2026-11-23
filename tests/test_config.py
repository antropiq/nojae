import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Dict

import pytest

from src import config as config_module
from src.core.llmkit import client as llmkit_client
from src.core.llmkit import constants as llmkit_constants
from src.core import appdb
from src.core import workspace as workspace_seam
from src.config import (
    DEFAULT_MAX_TOOL_ITERATION,
    DEFAULT_NETWORK_FAIL_MAX_RETRY,
    DEFAULT_NETWORK_FAIL_WAIT_FOR,
    DEFAULT_PORT,
    BootFlags,
    PYTHON_ROOT_PLACEHOLDER,
    _DebugStreamHandler,
    agent_instructions_block,
    apply_llm_debug,
    agent_connection_refusal,
    boot_flags,
    llm_debug_enabled,
    load_agent_instructions,
    max_tool_iteration,
    load_endpoints_config,
    network_fail_budget,
    parse_boot_args,
    provided_env_values,
    python_root,
    set_boot_flags,
)
from src.core.models import DEFAULT_LLM_SYSPROMPT
from tests.conftest import neutralise_store, scoped, write_store_connection


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
        #
        # The handle is dropped **first**. `connection()` re-opens on use, so
        # what makes the read refuse is the absent path, not the closed handle.
        # POSIX lets a delete happen with a handle still open (an unlinked file
        # stays reachable through it); Windows refuses to remove a file a handle
        # is on, so the other order fails there with a sharing violation on an
        # assertion about nothing of the sort.
        appdb.close_thread_connection()
        appdb.database_path().unlink()

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

    def test_resolves_the_workspace_in_scope(self, tmp_path: Path):
        """No explicit location: the seam's scope answers, read at call time."""
        root = tmp_path / "in-scope"
        root.mkdir()
        (root / "AGENTS.md").write_text("from the scope", encoding="utf-8")
        with scoped(root):
            assert load_agent_instructions() == "from the scope"

    def test_block_frames_the_text_with_the_workspace_root(self, tmp_path: Path):
        root = tmp_path / "framed"
        root.mkdir()
        with scoped(root):
            block = agent_instructions_block("mind the conventions")
        assert f"The current project root is {root}" in block
        assert block.endswith("mind the conventions")
        assert "AGENTS.md" in block

    def test_block_is_empty_without_instructions(self, tmp_path: Path):
        # No file (and no text) means the system prompt is left untouched.
        with scoped(tmp_path):
            assert agent_instructions_block() == ""
            assert agent_instructions_block("   ") == ""

    def test_block_reads_the_file_when_no_text_is_given(self, tmp_path: Path):
        (tmp_path / "AGENTS.md").write_text("body text", encoding="utf-8")
        with scoped(tmp_path):
            assert agent_instructions_block().endswith("body text")

    def test_a_renamed_file_is_not_picked_up(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        (tmp_path / "AGENTS.md").write_text("nope", encoding="utf-8")
        monkeypatch.setattr("src.config.agent_instructions_filename", lambda: "OTHER.md")
        with scoped(tmp_path):
            assert load_agent_instructions() == ""


def _llm_logger() -> logging.Logger:
    """The logger ``core/llmkit`` writes its request payloads to."""
    return logging.getLogger(llmkit_constants.DEBUG_LOGGER_NAME)


def _switch_handlers(logger: logging.Logger) -> list:
    """Only the handlers the debug switch itself attaches.

    Asked by class, because the logger legitimately carries others: the one an
    app boot attached when the run was given ``--llm-debug``, and pytest's own
    capture handlers. A total over ``logger.handlers`` would make an assertion
    here depend on the machine and on the tests that ran before it.
    """
    return [h for h in logger.handlers if isinstance(h, _DebugStreamHandler)]


class TestTheParserOfTheCommandLine:
    """``parse_boot_args``: what the four flags answer, and what they refuse.

    The parser is a pure function of its ``argv`` argument, so no case here needs
    this process's real ``sys.argv`` — and none may use it: the arguments that
    started pytest belong to pytest.
    """

    def test_no_arguments_at_all_answer_the_documented_defaults(self):
        """``uvicorn src.api.server:app`` carries none of these names, so a
        process that never parsed anything must answer the same numbers."""
        assert parse_boot_args([]) == BootFlags(
            llm_debug=False,
            network_max_retry=DEFAULT_NETWORK_FAIL_MAX_RETRY,
            network_wait_for=DEFAULT_NETWORK_FAIL_WAIT_FOR,
            port=DEFAULT_PORT,
        )

    def test_llm_debug_is_presence_itself_not_a_value(self):
        """A store-true flag: writing a value after it is a parse error.

        There is no spelling of ``--llm-debug off`` that means off — off is the
        absence of the flag, which is what stops the switch being mis-set by an
        argument that does not mean what it looks like.
        """
        assert parse_boot_args(["--llm-debug"]).llm_debug is True
        assert parse_boot_args([]).llm_debug is False
        with pytest.raises(SystemExit):
            parse_boot_args(["--llm-debug", "off"])

    def test_the_two_network_flags_are_independent_numbers(self):
        flags = parse_boot_args(["--network-max-retry", "5"])
        assert (flags.network_max_retry, flags.network_wait_for) == (5, 10)
        flags = parse_boot_args(["--network-wait-for", "2"])
        assert (flags.network_max_retry, flags.network_wait_for) == (3, 2)

    def test_zero_is_a_value_and_not_an_absence(self):
        """``--network-max-retry 0`` is the wait switched off, not omitted."""
        flags = parse_boot_args(["--network-max-retry", "0", "--network-wait-for", "0"])
        assert (flags.network_max_retry, flags.network_wait_for) == (0, 0)

    @pytest.mark.parametrize("raw", ["ten", "-1", "1.5", "0x10", "1e3", "", "  "])
    def test_an_unusable_number_refuses_the_boot_instead_of_falling_back(
        self, capsys: pytest.CaptureFixture, raw: str
    ):
        """The one rule that did not survive unchanged, and its reason.

        A ``.env`` typo answered the default and left a note, because a running
        app must not die over a slipped key. A command line is read **before**
        anything is served and by the person who just typed it, so booting with a
        number they did not write is the worse answer: argparse exits, naming the
        option and the offending value.
        """
        for option in ("--network-max-retry", "--network-wait-for"):
            with pytest.raises(SystemExit):
                parse_boot_args([option, raw])
            assert option in capsys.readouterr().err

    def test_non_ascii_digits_are_the_number_they_are(self):
        """``\u0663`` parses as ``3``, and that is inherited from ``int()``.

        Pinned rather than refused, because it is the whole rule of the accessor
        this replaced (which read these values with ``int()`` too): a number in
        another digit system **is** the number, so a value that parses is never
        treated as a typo. Refusing it would be a new rule nobody asked for.
        """
        flags = parse_boot_args(["--network-max-retry", "\u0663"])
        assert flags.network_max_retry == 3

    def test_a_bare_option_refuses_too(self):
        """``--network-wait-for`` with nothing after it names no number."""
        with pytest.raises(SystemExit):
            parse_boot_args(["--network-wait-for"])

    def test_an_unknown_option_refuses_the_boot(self):
        """Silently ignoring a flag would let a run boot unconfigured."""
        with pytest.raises(SystemExit):
            parse_boot_args(["--llmdebug"])

    @pytest.mark.parametrize("raw", ["8001", "80", "65535"])
    def test_a_bindable_port_is_taken_verbatim(self, raw: str):
        assert parse_boot_args(["--port", raw]).port == int(raw)

    @pytest.mark.parametrize("raw", ["0", "-1", "65536", "http", "80.1"])
    def test_a_port_the_os_cannot_bind_refuses_the_boot(self, raw: str):
        with pytest.raises(SystemExit):
            parse_boot_args(["--port", raw])

    def test_the_flags_together_are_one_immutable_value(self):
        assert parse_boot_args(
            [
                "--llm-debug",
                "--network-max-retry",
                "1",
                "--network-wait-for",
                "30",
                "--port",
                "9000",
            ]
        ) == BootFlags(
            llm_debug=True, network_max_retry=1, network_wait_for=30, port=9000
        )


class TestTheFlagsOfThisProcess:
    """``boot_flags``/``set_boot_flags``: the parsed values as process state.

    The consumers read this, not ``argv``, so what they answer at call time is
    what this holds. The ``conftest`` autouse fixture pins the value to the
    defaults around every test of the suite, so the cases below move it and leave
    no residue to leak.
    """

    def test_a_process_that_never_parsed_answers_the_defaults(self):
        assert boot_flags() == BootFlags()
        assert boot_flags().port == DEFAULT_PORT

    def test_the_whole_value_is_replaced_never_one_field(self):
        """``set_boot_flags`` takes a :class:`BootFlags`, and no member is partial.

        The API matters, not just the behaviour: with per-field setters, a
        mid-run change could re-apply the debug switch while the retry pair still
        answered the default — the "a mid-turn save cannot split the connection"
        rule, one level down. Here the only way to move one number is to hand in
        all four.
        """
        set_boot_flags(BootFlags(llm_debug=True, network_max_retry=1))
        assert boot_flags() == BootFlags(
            llm_debug=True,
            network_max_retry=1,
            network_wait_for=DEFAULT_NETWORK_FAIL_WAIT_FOR,
            port=DEFAULT_PORT,
        )

    def test_a_consumer_reading_later_sees_the_later_value(self):
        """Read at call time — and inside one run, always the same answer.

        The chat route calls ``network_fail_budget()`` per refused round and the
        logger predicate per request; neither caches. Nothing in a run *changes*
        the flags (there is no route that writes them), so a process answers the
        same pair from its first refused round to its last.
        """
        assert network_fail_budget() == (
            DEFAULT_NETWORK_FAIL_MAX_RETRY,
            DEFAULT_NETWORK_FAIL_WAIT_FOR,
        )
        set_boot_flags(BootFlags(network_max_retry=5, network_wait_for=2))
        assert network_fail_budget() == (5, 2)
        assert llm_debug_enabled() is False
        set_boot_flags(BootFlags(llm_debug=True, network_max_retry=0))
        assert llm_debug_enabled() is True
        assert network_fail_budget() == (0, 10)


class TestLLMDebugFlag:
    """The ``--llm-debug`` switch: how it is read, what it does to ``nojae.llm``.

    The flags are pinned off, and the logger and the client's payload hook
    restored, around every test of the suite
    (``conftest._no_debug_switch_leak``), so each case states only the flag it
    cares about and the switch's writes to process-wide state stay inside the
    test that made them.
    """

    def test_the_answer_is_the_flag_and_nothing_else(self):
        """No file, no environment key, no store column can turn it on.

        The whole point of moving the switch out of ``.env``: the environment is
        the one place an install, a shell and a CI runner all write, and a debug
        switch that answered them could be on for a run nobody booted for
        debugging — printing payloads nobody asked to see.
        """
        set_boot_flags(BootFlags(llm_debug=True))
        assert llm_debug_enabled() is True
        set_boot_flags(BootFlags())
        assert llm_debug_enabled() is False

    def test_the_environment_cannot_enable_it(self, monkeypatch):
        """Every old spelling of the old keys is inert bytes in the environment.

        ``LLM_DEBUG``, its pre-rename name ``LITELLM_DEBUG``, and the truthy
        spellings that used to turn them on: a machine that still carries one in
        its shell (or in a ``.env`` nobody cleaned up) now runs the default, and
        only ``--llm-debug`` changes that.
        """
        for name in ("LLM_DEBUG", "LITELLM_DEBUG"):
            for raw in ("1", "true", "on", "yes"):
                monkeypatch.setenv(name, raw)
                assert llm_debug_enabled() is False

    def test_apply_on_raises_the_clients_logger_and_owns_its_hook(self):
        set_boot_flags(BootFlags(llm_debug=True))
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

    def test_apply_off_leaves_the_logger_as_it_was_found(self):
        set_boot_flags(BootFlags(llm_debug=True))
        logger = _llm_logger()

        apply_llm_debug()
        # A process re-creating its app (the harness does) must not stack a
        # second handler, or every payload is printed once per creation.
        apply_llm_debug()
        assert len(_switch_handlers(logger)) == 1

        set_boot_flags(BootFlags())
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


class TestTheNetworkFailBudget:
    """``network_fail_budget()``: the endpoint wait's ``(max_retry, seconds)``.

    Spec §6 is the authority on what the pair *does*; what changed here is where
    it comes from — this run's command line, never a file. The flags are pinned
    to the defaults around every test (``conftest``), so each case states the
    flags it wants and an ambient command line cannot answer for the test.
    """

    def test_the_defaults_are_three_waits_of_ten_seconds(self):
        """Non-zero on purpose: the feature is on without any flag."""
        assert DEFAULT_NETWORK_FAIL_MAX_RETRY == 3
        assert DEFAULT_NETWORK_FAIL_WAIT_FOR == 10
        assert network_fail_budget() == (3, 10)

    def test_a_flag_of_zero_is_honoured_as_zero(self):
        """Zero is a value, not a missing one: it switches the guard off."""
        set_boot_flags(BootFlags(network_max_retry=0, network_wait_for=0))
        assert network_fail_budget() == (0, 0)

    def test_the_two_flags_answer_their_own_member(self):
        """The pair is two independent numbers, one per flag."""
        set_boot_flags(BootFlags(network_max_retry=7))
        assert network_fail_budget() == (7, 10)
        set_boot_flags(BootFlags(network_wait_for=25))
        assert network_fail_budget() == (3, 25)

    def test_it_is_read_at_call_time_not_at_import(self):
        """Spec §6: read when the retry decision is made, never cached at boot.

        The last line is the same invariant seen from the consumer's side: one
        replacement carries all four members, so a flag that is not restated
        answers its default rather than the previous run's number.
        """
        assert network_fail_budget() == (3, 10)
        set_boot_flags(BootFlags(network_max_retry=5, network_wait_for=2))
        assert network_fail_budget() == (5, 2)
        set_boot_flags(BootFlags(network_max_retry=0))
        assert network_fail_budget() == (0, DEFAULT_NETWORK_FAIL_WAIT_FOR)

    def test_the_environment_cannot_set_the_budget(self, monkeypatch):
        """The old keys, in every spelling, decide nothing.

        ``NETWORK_FAIL_MAX_RETRY`` / ``NETWORK_FAIL_WAIT_FOR`` were read from the
        environment while ``.env`` was the source; a machine that still exports
        them runs the flags' answer, which is the pair every run of this build
        agrees on.
        """
        monkeypatch.setenv("NETWORK_FAIL_MAX_RETRY", "99")
        monkeypatch.setenv("NETWORK_FAIL_WAIT_FOR", "1")
        assert network_fail_budget() == (
            DEFAULT_NETWORK_FAIL_MAX_RETRY,
            DEFAULT_NETWORK_FAIL_WAIT_FOR,
        )

    def test_there_is_nothing_left_to_report_as_a_fallback(self):
        """The budget accessor is the only read-out these two numbers have.

        The trio used to answer a ``(max_retry, seconds)`` **plus** a per-key note
        about a written value that fell back, and the settings surface showed
        those notes. A parser that refuses an unusable value before the app is
        serving makes that state unrepresentable, so a permanently-empty notes
        field is worse than no field: it advertises a safety net that cannot
        fire. The API therefore answers the pair alone, and this asserts the
        accessor's shape is the pair and nothing else.
        """
        budget = network_fail_budget()
        assert isinstance(budget, tuple) and len(budget) == 2
        assert all(isinstance(value, int) for value in budget)
        assert not hasattr(config_module, "network_fail_readout")


class TestTheInstallHasNoConfigurationFile:
    """The ``.env`` key set is gone from the module that owned it.

    Not a tidy-up: an accessor left behind would be a second way to set something
    the command line now owns, and the next reader of this module could not tell
    which one the app follows.
    """

    def test_the_module_exports_no_env_file_surface(self):
        for name in (
            "ENV_PATH",
            "SETTING_KEYS",
            "REQUIRED_SETTING_KEYS",
            "LLM_DEBUG_KEY",
            "NETWORK_FAIL_MAX_RETRY_KEY",
            "NETWORK_FAIL_WAIT_FOR_KEY",
            "load_dotenv_once",
            "load_settings",
            "save_settings",
            "network_fail_readout",
        ):
            assert not hasattr(config_module, name), name

    def test_nothing_in_the_app_still_reads_dotenv(self):
        """The dependency went with the last thing that needed it.

        Scanned over the sources rather than the imports, because a leftover
        ``import dotenv`` in a dead branch is exactly the residue a renamed
        accessor would leave.
        """
        offenders = []
        for path in sorted((config_module.PROJECT_ROOT / "src").rglob("*.py")):
            if "dotenv" in path.read_text(encoding="utf-8"):
                offenders.append(str(path.relative_to(config_module.PROJECT_ROOT)))
        assert offenders == []

    def test_the_install_ships_no_env_template(self):
        assert not (config_module.PROJECT_ROOT / ".env.example").exists()


class TestTheInterpreterOfThisProcess:
    """``python_root()``: the answer ``NOJAE_PYTHON_ROOT`` used to ask a human.

    The one key of the old set that was never a *choice*: it named which
    interpreter this app is, and only the process can answer that. So it became a
    computation, and the last reason to hand-write a file went with it.
    """

    def test_the_answer_is_the_running_interpreter(self):
        assert python_root() == sys.executable
        # And a real file: a connector is exec'd with it, so a path that names
        # nothing is a connector that fails at spawn time with nothing to read.
        assert Path(python_root()).is_file()

    def test_it_is_not_read_from_the_environment(self, monkeypatch):
        """A stale export must not move the connectors onto another interpreter.

        The old failure this retires: a hand-written ``NOJAE_PYTHON_ROOT`` that
        outlived the venv it described, which nothing checked and which failed
        inside a path that exists but is not this install's.
        """
        monkeypatch.setenv(PYTHON_ROOT_PLACEHOLDER, "/opt/some/other/python")
        assert python_root() == sys.executable

    def test_the_placeholder_reaches_expansion_from_the_computation(self):
        """What the seeded declaration writes, and what expansion must answer.

        ``expand_env`` consults :func:`provided_env_values` first, so the name in
        the seeded connector declaration resolves to this interpreter in every
        workspace on this machine — no file states it, so no file can state it
        wrongly.
        """
        values = provided_env_values()
        assert values[PYTHON_ROOT_PLACEHOLDER] == sys.executable
