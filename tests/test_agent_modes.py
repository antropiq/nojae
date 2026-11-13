"""``core/agent_modes.py`` — the agents' read model over the settings store.

The file this module used to read is gone with its seeder, its mtime token and
its conflict guard (spec §4.7, task 10). What is left is the **read model**: the
vocabulary the chat route and the prompt assembly consume, plus the two
guarantees that are about behaviour rather than storage —

* **it never raises**: a row the store cannot render is a finding, and the rest of
  the list still renders (the dropdown is what has to stay usable);
* **the app-owned agent is last**, rendered from code whatever the table says.

Two answers changed with D5, and both are asserted here: the payload carries **no
``default`` key**, and :func:`resolve_mode` narrows to "an id in, a row or
nothing out" — a missing id resolves to nothing, because a turn with none is the
422 that names the field.

Hermeticity: every test runs against the temporary database the suite's autouse
fixture pins, and drives rows through :func:`src.core.appdb` and the routes. No
test opens the install's own store, and no test reads a file for a persona.
"""

import ast
import re
import sqlite3
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from src.core import agent_modes, batch
from src.core import agent_modes_defaults as defaults
from src.core import appdb


# -- helpers --------------------------------------------------------------------

def rows_by_id() -> Dict[str, Dict[str, Any]]:
    """Every agent the store's read answers, by id."""
    return {agent["id"]: agent for agent in appdb.resolve_agents()["agents"]}


def ids() -> List[str]:
    return [mode.id for mode in resolved()["modes"]]


def resolved() -> Dict[str, Any]:
    return agent_modes.resolve_modes()


def mode_of(mode_id: str) -> agent_modes.AgentMode:
    for mode in resolved()["modes"]:
        if mode.id == mode_id:
            return mode
    raise AssertionError(f"no agent {mode_id!r} in {ids()}")


def errors() -> List[str]:
    return [f.message for f in resolved()["findings"] if f.kind == agent_modes.KIND_ERROR]


def damage(statement: str, params: tuple = ()) -> None:
    """Write a row the app would never write, to break one column.

    The handle has foreign keys **off** and no transaction: the states this suite
    plants (a column holding the wrong affinity, a ``model_id`` naming no row) are
    exactly the ones the schema's declarations and ``ON DELETE SET NULL`` keep the
    app from reaching, so a handle that enforced them could not create them.
    """
    path = appdb.database_path()
    conn = sqlite3.connect(path.as_uri() + "?mode=rw", uri=True)
    try:
        conn.execute("PRAGMA foreign_keys = OFF")
        conn.execute(statement, params)
        conn.commit()
    finally:
        conn.close()


def add(agent_id: str, label: str, **fields: Any) -> None:
    """Create one agent through the store's own accessor.

    Not the route: this suite is about the *read* model, so the write it judges is
    the plainest one available. The route's refusals live in
    ``tests/test_api.py``.
    """
    appdb.add_agent(agent_id, label, **fields)


# -- the shape of the answer -----------------------------------------------------

class TestTheAnswerShape:
    def test_the_four_built_ins_answer_in_order(self):
        assert ids() == ["chat", "code", "architect", "todoBuilder"]

    def test_there_is_no_default_key(self):
        """D5: a key that always answered "nothing" would be read as meaningful."""
        assert "default" not in resolved()
        assert sorted(resolved()) == ["caps", "findings", "modes"]

    def test_each_mode_is_the_row_the_store_holds(self):
        agent = rows_by_id()["code"]
        mode = mode_of("code")
        assert (mode.id, mode.label) == (agent["id"], agent["label"])
        assert mode.system_message == agent["systemMessage"]
        assert (mode.mcptools, mode.lsptools) == (
            agent["mcpEnable"], agent["lspEnable"]
        )
        assert mode.readonly is agent["readonly"]

    def test_readonly_replaces_editable_and_names_no_agent(self):
        """§4.4: one flag, answering one question — which fields are disabled."""
        modes = resolved()["modes"]
        assert [mode.readonly for mode in modes] == [False, False, False, True]
        # The flag is data: nothing here compares an id to name the app-owned one.
        assert not hasattr(agent_modes, "APP_OWNED_MODE_ID")

    def test_the_caps_ride_with_the_answer(self):
        """No cap is spelled in the client, so they travel with the read."""
        caps = resolved()["caps"]
        assert caps["maxIdChars"] == agent_modes.MAX_MODE_ID_CHARS
        assert caps["idPattern"] == agent_modes.MODE_ID_PATTERN
        assert caps["maxPersonaBytes"] == agent_modes.MAX_MODE_SYSTEM_MESSAGE_BYTES
        assert caps["minToolIteration"] == agent_modes.MIN_TOOL_ITERATION

    def test_a_patched_cap_moves_the_payload(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(agent_modes, "MAX_MODE_LABEL_CHARS", 7)
        assert resolved()["caps"]["maxLabelChars"] == 7


class TestTheOrder:
    def test_insertion_order_is_the_dropdown_order(self):
        add("alpha", "Alpha")
        add("zulu", "Zulu")
        assert ids() == ["chat", "code", "architect", "alpha", "zulu", "todoBuilder"]

    def test_the_app_owned_agent_is_last_whatever_the_table_says(self):
        """The modes read's rule, kept: the reserved agent is sorted last."""
        damage("DELETE FROM agents WHERE id = 'todoBuilder'")
        appdb.add_agent("todoBuilder", "Todo builder")
        damage("UPDATE agents SET label = label || ' (renamed)' WHERE id = 'chat'")
        assert ids()[-1] == "todoBuilder"

    def test_a_reserved_agent_whose_row_is_gone_is_still_rendered(self):
        """Code — not a row, not a file — is where that agent is defined (D4)."""
        damage("DELETE FROM agents WHERE id = 'todoBuilder'")
        builder = mode_of("todoBuilder")
        assert builder.readonly is True
        assert builder.instructions


# -- the never-raises promise ----------------------------------------------------

class TestItNeverRaises:
    def test_a_damaged_row_is_reported_and_the_rest_still_render(self):
        damage("UPDATE agents SET max_tool_iteration = 'lots' WHERE id = 'code'")
        payload = resolved()
        assert [mode.id for mode in payload["modes"]] == [
            "chat", "architect", "todoBuilder",
        ]
        assert len(payload["findings"]) == 1
        finding = payload["findings"][0]
        assert finding.kind == agent_modes.KIND_ERROR
        assert "code" in finding.message

    def test_every_way_a_row_can_be_damaged_is_reported(self):
        for statement in (
            "UPDATE agents SET label = '' WHERE id = 'chat'",
            "UPDATE agents SET mcp_enable = 'yes' WHERE id = 'code'",
            "UPDATE agents SET readonly = 2.5 WHERE id = 'architect'",
            "UPDATE agents SET model_id = 'first' WHERE id = 'todoBuilder'",
        ):
            damage(statement)
        payload = resolved()
        # Every row is dropped as a unit — a persona with tools and no label is
        # the thing this feature exists to prevent — and the app-owned agent is
        # still there from code, so the composer has something to show.
        assert [mode.id for mode in payload["modes"]] == ["todoBuilder"]
        assert len(payload["findings"]) == 4

    def test_an_unopenable_store_answers_the_code_definitions_and_the_sentence(
        self, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ):
        """A store that cannot be read still leaves the composer something to show."""
        broken = tmp_path / "broken-install"
        broken.mkdir()
        (broken / "nojae.db").mkdir()
        monkeypatch.setattr(appdb, "PROJECT_ROOT", broken)

        payload = resolved()

        # The rows are unreadable, so the *code* definitions answer — including the
        # three editable ones, which are only rows otherwise. That is the point:
        # the composer always has a list, and the finding names the path.
        assert [mode.id for mode in payload["modes"]] == ["todoBuilder"]
        assert len(payload["findings"]) == 1
        assert str(broken / "nojae.db") in payload["findings"][0].message

    def test_the_read_never_raises_for_anything_planted(self):
        damage("UPDATE agents SET system_message = 42 WHERE id = 'chat'")
        damage("UPDATE agents SET mcp_enable = 'yes' WHERE id = 'code'")
        resolved()  # answers, does not raise


# -- resolve_mode ----------------------------------------------------------------

class TestResolvingOneAgent:
    def test_an_id_in_answers_that_mode(self):
        mode, findings = agent_modes.resolve_mode("architect")
        assert mode is not None and mode.id == "architect"
        assert findings == []

    def test_a_missing_id_resolves_to_nothing(self):
        """D5: no server-side default to fall back to, so the contract narrows."""
        for missing in (None, "", "   "):
            mode, _findings = agent_modes.resolve_mode(missing)
            assert mode is None, repr(missing)

    def test_an_unknown_id_resolves_to_nothing(self):
        mode, _findings = agent_modes.resolve_mode("nope")
        assert mode is None

    def test_the_ids_a_message_lists_are_the_ones_the_read_answers(self):
        available = ", ".join(ids())
        assert available == "chat, code, architect, todoBuilder"

    def test_the_findings_ride_along(self):
        damage("UPDATE agents SET label = '' WHERE id = 'code'")
        mode, findings = agent_modes.resolve_mode("chat")
        assert mode is not None and mode.id == "chat"
        assert len(findings) == 1


# -- the validator (the rules the editor's form and the route share) -------------

class TestTheValidator:
    def test_the_slug_pattern(self):
        assert agent_modes._mode_id_problem("code") is None
        assert agent_modes._mode_id_problem("my-helper_2") is None
        for bad in ("", "Nope", "9lives", "has space", "x" * 33, None, 7):
            assert agent_modes._mode_id_problem(bad) is not None, repr(bad)

    def test_the_id_pattern_is_patchable(self, monkeypatch: pytest.MonkeyPatch):
        monkeypatch.setattr(agent_modes, "MODE_ID_PATTERN", r"^[A-Z]+$")
        assert agent_modes._mode_id_problem("ABC") is None
        assert agent_modes._mode_id_problem("code") is not None

    def test_the_label_rules(self):
        assert agent_modes._label_problem("Code") is None
        for bad in ("", "   ", None, 7, "x" * 41):
            assert agent_modes._label_problem(bad) is not None, repr(bad)

    def test_an_empty_persona_is_a_value_not_a_problem(self):
        """D8: empty means "use the model's own prompt", which is a choice."""
        assert agent_modes._persona_problem("") is None

    def test_a_persona_over_the_byte_cap_is_a_problem(self):
        assert agent_modes._persona_problem(
            "x" * (agent_modes.MAX_MODE_SYSTEM_MESSAGE_BYTES + 1)
        ) is not None
        assert agent_modes._persona_problem(42) is not None

    def test_the_cap_floor_is_one_and_there_is_no_ceiling(self):
        """D9, in both directions."""
        assert agent_modes._tool_iteration_problem(1) is None
        assert agent_modes._tool_iteration_problem(500) is None
        assert agent_modes._tool_iteration_problem(0) is not None
        assert agent_modes._tool_iteration_problem(-3) is not None
        assert agent_modes._tool_iteration_problem(True) is not None
        assert agent_modes._tool_iteration_problem("5") is not None


# -- the module's boundaries -----------------------------------------------------

class TestTheReaderIsAlone:
    def test_no_connector_reads_the_agents(self):
        connectors = Path(agent_modes.__file__).resolve().parents[2] / "mcp_connectors"
        offenders = [
            path.name
            for path in connectors.glob("*.py")
            if "agent_modes" in path.read_text(encoding="utf-8")
            or "agent-modes" in path.read_text(encoding="utf-8")
        ]
        assert offenders == []

    def test_it_imports_no_transport_no_model_and_no_hub(self):
        """Pure core: FastAPI, the LLM transport and the hubs belong elsewhere."""
        tree = ast.parse(Path(agent_modes.__file__).read_text(encoding="utf-8"))
        forbidden = ("fastapi", "litellm", "src.api", "mcphub", "lsphub", "termhub",
                     "editorfs", "chat", "batch", "llmkit")
        offenders: List[str] = []
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                offenders.extend(
                    alias.name for alias in node.names
                    if alias.name.split(".")[-1] in forbidden
                    or alias.name.startswith(tuple(f"{f}." for f in forbidden))
                )
            elif isinstance(node, ast.ImportFrom):
                module = node.module or ""
                if module.split(".")[-1] in forbidden:
                    offenders.append(module)
        assert offenders == []

    def test_it_opens_no_file_and_writes_nothing(self):
        """The store module owns both; a read model that touched disk would be a
        second answer to where the agents live (§4.1)."""
        source = Path(agent_modes.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        writers = {"write_text", "write_bytes", "mkdir", "makedirs", "unlink",
                   "rename", "remove", "rmdir", "chmod", "symlink", "fdopen"}
        offenders: List[str] = []
        for node in ast.walk(tree):
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                continue
            for call in ast.walk(node):
                if isinstance(call, ast.Call) and isinstance(call.func, ast.Attribute):
                    if call.func.attr in writers:
                        offenders.append(f"{node.name}.{call.func.attr}")
        assert offenders == []
        assert "O_CREAT" not in source
        assert not re.search(r"^\s*(?:import|from)\s+sqlite3\b", source, re.MULTILINE)
        assert "sqlite3.connect(" not in source

    def test_it_holds_no_per_root_cache(self):
        """D11: the database is the cache, so there is nothing to invalidate."""
        source = Path(agent_modes.__file__).read_text(encoding="utf-8")
        assert not re.search(r"\b_CACHE\b|\binvalidate_", source)
        assert "path_location" not in source


class TestConstantsAreSane:
    def test_the_documented_values(self):
        assert agent_modes.MAX_MODE_ID_CHARS == 32
        assert agent_modes.MAX_MODE_LABEL_CHARS == 40
        assert agent_modes.MAX_MODE_SYSTEM_MESSAGE_BYTES == 16 * 1024
        assert agent_modes.MAX_MODE_PERSONA_LINES == 16
        assert agent_modes.MIN_TOOL_ITERATION == 1
        assert agent_modes.RESERVED_MODE_IDS == ("todoBuilder",)
        assert agent_modes.MODE_ID_PATTERN == r"^[a-z][A-Za-z0-9_-]*$"

    def test_the_reserved_id_is_a_valid_agent_id(self):
        for reserved in agent_modes.RESERVED_MODE_IDS:
            assert agent_modes._mode_id_problem(reserved) is None
            assert re.match(agent_modes.MODE_ID_PATTERN, reserved)

    def test_the_persona_line_budget_is_a_positive_int(self):
        budget = agent_modes.MAX_MODE_PERSONA_LINES
        assert isinstance(budget, int) and not isinstance(budget, bool)
        assert budget > 0

    def test_the_self_check_refuses_a_cap_typed_as_a_string(self):
        """The reader promises never to raise about a row; a bad *cap* is different."""
        original = agent_modes.MAX_MODE_ID_CHARS
        agent_modes.MAX_MODE_ID_CHARS = "32"
        try:
            with pytest.raises(ValueError, match="MAX_MODE_ID_CHARS"):
                agent_modes._self_check()
        finally:
            agent_modes.MAX_MODE_ID_CHARS = original
        agent_modes._self_check()


# -- the content module, against the real read model ----------------------------

#: Every mention of an agent inside persona prose, as ``"<Label> mode"``. The
#: test that uses it asks that each such name is one the code actually defines.
MODE_MENTION_RE = re.compile(r"\b([A-Z][A-Za-z]*(?: [a-z][A-Za-z]*)?) mode\b")

PERSONA_TUPLES = (
    ("CHAT_PERSONA", defaults.CHAT_MODE_ID),
    ("CODE_PERSONA", defaults.CODE_MODE_ID),
    ("ARCHITECT_PERSONA", defaults.ARCHITECT_MODE_ID),
    ("TODO_BUILDER_PERSONA", defaults.TODO_BUILDER_MODE_ID),
)


def persona_lines(attribute: str) -> List[str]:
    """The lines of one persona, looked up by its module attribute name."""
    return list(getattr(defaults, attribute))


class TestTheSeededDefinition:
    """The one-object argument: the rows a first boot writes and the fallback a
    damaged row answers are the same definition."""

    def test_default_modes_is_the_built_in_list_not_a_second_copy(self):
        modes = defaults.default_modes()
        assert [mode.id for mode in modes] == [
            defaults.CHAT_MODE_ID, defaults.CODE_MODE_ID,
            defaults.ARCHITECT_MODE_ID,
        ]
        assert [mode.label for mode in modes] == [
            defaults.CHAT_LABEL, defaults.CODE_LABEL, defaults.ARCHITECT_LABEL,
        ]
        for mode in modes:
            assert mode.readonly is False

    def test_the_app_owned_agent_is_readonly_and_carries_the_conventions(self):
        builder = defaults.todo_builder_mode()
        assert builder.readonly is True
        assert builder.instructions == (defaults.lot_conventions_block(),)

    def test_the_seeded_definition_does_not_name_the_reserved_agent(self):
        for reserved in agent_modes.RESERVED_MODE_IDS:
            assert reserved not in [mode.id for mode in defaults.default_modes()]

    def test_the_seeded_flags_match_the_design(self):
        """The coarse reach of each persona — the table D4 starts from."""
        expected = {
            "chat": (False, False),
            "code": (True, True),
            "architect": (True, False),
            "todoBuilder": (True, False),
        }
        for mode_id, flags in expected.items():
            mode = mode_of(mode_id)
            assert (mode.mcptools, mode.lsptools) == flags
            assert mode.system_message, f"{mode_id} has no persona"

    def test_every_persona_is_the_module_constant_join(self):
        """The row, the constants and the resolved mode say one text."""
        lines_by_id = {
            mode_id: persona_lines(attribute)
            for attribute, mode_id in PERSONA_TUPLES
        }
        for mode_id, lines in lines_by_id.items():
            assert mode_of(mode_id).system_message == "\n".join(lines)

    def test_only_the_reserved_agent_carries_generated_blocks(self):
        builder = mode_of("todoBuilder")
        assert len(builder.instructions) == 1
        assert builder.instructions[0].strip()
        for mode in resolved()["modes"]:
            if mode.id != defaults.TODO_BUILDER_MODE_ID:
                assert mode.instructions == ()


class TestLotConventionsBlock:
    """The block that cannot be allowed to go stale: the runner enforces these."""

    def test_it_quotes_the_live_batch_constants(self):
        block = defaults.lot_conventions_block()
        assert batch.DEFAULT_LOT_DIR in block
        assert batch.PREFIX_PATTERN in block
        assert str(batch.MAX_BATCH_TASKS) in block
        assert str(batch.MAX_BATCH_LOT_BYTES) in block
        assert batch.DONE_SUBFOLDER in block
        for separator in batch.NUMBER_SEPARATORS:
            assert f"`{separator}`" in block

    def test_a_patched_constant_changes_the_text(self, monkeypatch):
        """The drift guard: pasting the numbers back in as literals fails here."""
        before = defaults.lot_conventions_block()
        monkeypatch.setattr(batch, "MAX_BATCH_TASKS", 7)
        monkeypatch.setattr(batch, "DEFAULT_LOT_DIR", "tasks")
        monkeypatch.setattr(batch, "DONE_SUBFOLDER", "completed")
        after = defaults.lot_conventions_block()
        assert after != before
        assert "At most 7 tasks" in after
        assert "`tasks/`" in after
        assert "`completed/`" in after
        # The values that were live when the *other* text was rendered are gone,
        # so the block is re-rendered per call rather than frozen at import.
        assert "`todos/`" not in after and "At most 100 tasks" not in after

    def test_the_reserved_agent_carries_it(self):
        assert defaults.todo_builder_mode().instructions == (
            defaults.lot_conventions_block(),)

    def test_the_persona_points_at_the_block_it_does_not_restate(self):
        """The persona says "the lot conventions below"; the block is below it."""
        assert "conventions below" in defaults.todo_builder_mode().system_message
        assert "MAX_BATCH_TASKS" not in "\n".join(defaults.TODO_BUILDER_PERSONA)


class TestPersonaProse:
    """Prose is the part of this feature a later edit rots without noticing."""

    def test_no_persona_is_over_half_the_byte_cap(self):
        cap = agent_modes.MAX_MODE_SYSTEM_MESSAGE_BYTES
        for attribute, mode_id in PERSONA_TUPLES:
            size = len("\n".join(persona_lines(attribute)).encode("utf-8"))
            assert size < cap // 2, f"{mode_id} persona is {size} bytes of {cap}"

    def test_an_editable_persona_stays_inside_its_line_budget(self):
        """The line budget the module sets for the personas a user rewrites.

        The app-owned persona is longer (it carries the whole lot discipline) and
        is bounded by the byte cap instead — the assertion above.

        The number is :data:`core.agent_modes.MAX_MODE_PERSONA_LINES`, not a
        literal here: the modes editor shows that same budget as the "remaining
        line cap" label under its persona field, and a budget spelled in two
        places is a budget one of them will contradict.
        """
        budget = agent_modes.MAX_MODE_PERSONA_LINES
        for attribute, mode_id in PERSONA_TUPLES:
            if mode_id == defaults.TODO_BUILDER_MODE_ID:
                continue
            lines = persona_lines(attribute)
            assert len(lines) <= budget, f"{mode_id} persona is {len(lines)} lines"

    def test_no_persona_claims_to_have_read_agents_md(self):
        """No persona names the instructions file — the block frames it.

        ``config.agent_instructions_block`` frames AGENTS.md as the project's own
        instructions, and every agent receives it, so a persona that names the
        *file* makes a claim about the working location it cannot verify and
        duplicates the thing the block already states.
        """
        for attribute, mode_id in PERSONA_TUPLES:
            joined = " ".join("\n".join(persona_lines(attribute)).split())
            assert "AGENTS.md" not in joined, f"{mode_id} persona names the file"

    def test_every_mode_mention_in_the_prose_is_a_label_the_code_defines(self):
        """A renamed label leaves stale prose behind; this is the tripwire."""
        labels = {
            defaults.CHAT_LABEL, defaults.CODE_LABEL, defaults.ARCHITECT_LABEL,
            defaults.TODO_BUILDER_LABEL,
        }
        mentioned = set()
        for attribute, _ in PERSONA_TUPLES:
            mentioned.update(MODE_MENTION_RE.findall(
                "\n".join(persona_lines(attribute))))
        assert mentioned, "no persona names its own agent — the framing is gone"
        assert mentioned <= labels, mentioned - labels

    def test_a_persona_never_hardcodes_a_mode_mention(self):
        """A *mode mention* in the prose interpolates the label constant.

        A mention — ``"<Label> mode"`` — is a claim about a dropdown entry, and a
        spelled-out one survives a rename as a lie. The names are read off the
        **source**, not the live objects: an f-string's interpolated value would
        hide the literal either way.
        """
        source = ast.parse(Path(defaults.__file__).read_text(encoding="utf-8"))
        wanted = {name for name, _ in PERSONA_TUPLES}
        tuples: Dict[str, ast.Tuple] = {}
        for node in ast.walk(source):
            if (not isinstance(node, ast.AnnAssign)
                    or not isinstance(node.value, ast.Tuple)):
                continue
            target = node.target
            if isinstance(target, ast.Name) and target.id in wanted:
                tuples[target.id] = node.value
        # A vacuous pass is worse than no test: these are annotated assignments,
        # and a refactor that drops the annotations must not silence the check.
        assert set(tuples) == wanted, sorted(wanted - set(tuples))

        labels = [
            defaults.CHAT_LABEL, defaults.CODE_LABEL, defaults.ARCHITECT_LABEL,
            defaults.TODO_BUILDER_LABEL,
        ]
        for attribute, tuple_node in tuples.items():
            for element in tuple_node.elts:
                if isinstance(element, ast.Constant):
                    literal = str(element.value)
                elif isinstance(element, ast.JoinedStr):
                    literal = "".join(
                        part.value for part in element.values
                        if isinstance(part, ast.Constant)
                    )
                else:
                    continue
                for label in labels:
                    assert f"{label} mode" not in literal, (
                        f"{attribute} spells out the mention {label!r} mode; "
                        "interpolate the label constant instead")


class TestTheContentModuleIsStillCoreOnly:
    """It stays the words: no transport, no model, no second reader."""

    def test_it_reads_no_file_and_writes_none(self):
        source = Path(defaults.__file__).read_text(encoding="utf-8")
        tree = ast.parse(source)
        called = {
            node.func.attr
            for node in ast.walk(tree)
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        }
        writers = {"write_text", "write_bytes", "mkdir", "makedirs", "unlink",
                   "open", "remove", "rename"}
        assert writers & called == set()
        assert "O_CREAT" not in source
        assert "ensure_agent_modes_file" not in source

    def test_it_imports_only_the_read_model_batch_and_the_standard_library(self):
        """The seam is ``agent_modes``, the constants are ``core.batch``.

        ``from src.core import agent_modes, batch`` is one ``ImportFrom`` of
        ``src.core``, so the pinned set names the package, not each submodule —
        the point is that no route, hub, model client or config module appears.
        """
        tree = ast.parse(Path(defaults.__file__).read_text(encoding="utf-8"))
        imported: set = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Import):
                imported.update(alias.name for alias in node.names)
            elif isinstance(node, ast.ImportFrom) and node.module:
                imported.add(node.module)
        assert imported == {"typing", "src.core", "src.core.agent_modes"}
        forbidden = ("fastapi", "litellm", "src.api", "mcphub", "lsphub",
                     "termhub", "editorfs", "config", "llmkit", "appdb")
        assert not any(any(part in name for part in forbidden) for name in imported)

    def test_the_read_model_is_the_only_thing_that_builds_the_shape(self):
        """``AgentMode`` comes from ``agent_modes``: no local copy of the dataclass."""
        source = Path(defaults.__file__).read_text(encoding="utf-8")
        assert "@dataclass" not in source
        assert defaults.AgentMode is agent_modes.AgentMode

    def test_the_words_have_exactly_one_home_in_the_tree(self):
        """No second copy of a persona line or the conventions.

        A paste somewhere else is a second source of truth that drifts on the next
        edit, so the longest literals the module holds may appear in this file and
        nowhere else under ``src/``.
        """
        own_path = Path(defaults.__file__).resolve()
        src_root = own_path.parent.parent
        own = own_path.relative_to(src_root).as_posix()

        own_source = own_path.read_text(encoding="utf-8")
        tree = ast.parse(own_source)
        doc_nodes = {
            id(node.body[0].value)
            for node in ast.walk(tree)
            if isinstance(node, (ast.Module, ast.FunctionDef, ast.ClassDef))
            and node.body
            and isinstance(node.body[0], ast.Expr)
            and isinstance(node.body[0].value, ast.Constant)
            and isinstance(node.body[0].value.value, str)
        }
        literals = sorted(
            (node.value for node in ast.walk(tree)
             if isinstance(node, ast.Constant) and isinstance(node.value, str)
             and len(node.value) > 60 and id(node) not in doc_nodes),
            key=len,
            reverse=True,
        )
        probes = [value for value in literals if value in own_source][:8]
        assert probes, "the module holds no findable long literals to probe for"

        haystacks = {
            path.relative_to(src_root).as_posix(): path.read_text(encoding="utf-8")
            for path in list(src_root.rglob("*.py")) + list(src_root.rglob("*.json"))
            if "__pycache__" not in path.parts
        }
        assert own in haystacks
        for probe in probes:
            holders = [name for name, text in haystacks.items() if probe in text]
            assert holders == [own], f"{probe[:40]!r} also lives in {holders}"

    def test_its_self_check_refuses_a_persona_over_the_cap(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The import-time guarantee is a real check, not a sentence."""
        monkeypatch.setattr(agent_modes, "MAX_MODE_SYSTEM_MESSAGE_BYTES", 64)
        try:
            with pytest.raises(ValueError, match="chat persona"):
                defaults._self_check()
        finally:
            monkeypatch.undo()
        defaults._self_check()

    def test_its_self_check_refuses_a_reserved_agent_that_is_not_readonly(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """D4 as a content rule: the app-owned agent cannot be editable."""
        original = defaults.todo_builder_mode
        monkeypatch.setattr(
            defaults, "todo_builder_mode",
            lambda: agent_modes.AgentMode(
                id=defaults.TODO_BUILDER_MODE_ID,
                label=defaults.TODO_BUILDER_LABEL,
                system_message=defaults.todo_builder_persona(),
                mcptools=True,
                lsptools=False,
                readonly=False,
            ),
        )
        try:
            with pytest.raises(ValueError, match="readonly"):
                defaults._self_check()
        finally:
            monkeypatch.setattr(defaults, "todo_builder_mode", original)
        defaults._self_check()