"""The committed MCP catalogue, and the read that loads it.

``mcp_connectors/catalog-mcp.json`` is the wizard's only source of a package
name (§9), so this suite asks the questions a reviewer would ask of the file
itself and of the reader beside it:

* the file carries **exactly** the nine settled entries, and offers neither
  ``console`` nor ``fedit`` (they ship seeded, so offering them invites a
  duplicate id);
* every entry parses into its four groups, and every ``member`` is accepted by
  the hub's **own** loader when it is written into a declaration file — a
  snippet built from it therefore cannot be refused for shape;
* the one key-bearing entry carries the one canonical sentinel, and nothing in
  any member is a literal secret or a machine-specific absolute path;
* the read is through ``mcphub.constants`` at call time (a poisoned attribute in
  a temporary tree redirects it), and a damaged file is a named state rather
  than a crash or a silent empty list.

Tests stay hermetic: the catalogue is a committed text file, so nothing here
opens the settings store, reaches a hub or talks to an endpoint.
"""

import json
import re
from pathlib import Path
from typing import Any, Dict, List

import pytest

from src.core import editorfs
from src.core.mcphub import catalogue, constants
from src.core.mcphub.discovery import load_externals

#: The whole Python tree the "no package name in code" rule covers.
SOURCE_ROOT = Path(editorfs.constants.PROJECT_ROOT) / "src"

#: The first pass, settled by §9 of the spec: exactly these nine, in this file.
SETTLED_IDS = [
    "playwright",
    "chrome-devtools",
    "context7",
    "filesystem",
    "fetch",
    "git",
    "memory",
    "sequential-thinking",
    "sqlite",
]

#: The one canonical spelling of "fill this in", defined here as a literal so
#: the test does not read the value it is checking out of the code under test.
SENTINEL = "__put_your_api_key_here__"

#: A member's own field names — the whole of what may reach a snippet. Anything
#: from ``identity``/``requirements``/``relevance`` inside a member would be a
#: value the user's file has no business holding. ``description`` is shared with
#: ``identity`` on purpose: a declaration member may carry one too.
MEMBER_FIELDS = {
    "type", "enable", "url", "command", "args", "headers", "env", "description",
}

#: The member fields a guidance group may never hold: the shape of the JSON a
#: user pastes, which belongs to ``member`` alone.
MEMBER_ONLY_FIELDS = {"type", "enable", "url", "command", "args", "headers", "env"}

#: ``${NAME}``, optionally followed by a sub-folder — the only shape a path may
#: take in a member (§8).
ENV_REFERENCE_RE = re.compile(r"\$\{[A-Za-z_][A-Za-z0-9_]*\}(/.*)?")

#: Values that look like a credential rather than a name. A catalogue is data a
#: user pastes, so a leaf value shaped like one of these is a leak, not a style
#: question.
SECRET_MARKERS = (
    "Bearer ",
    "sk-",
    "ghp_",
    "api_key=",
    "apikey=",
    "token=",
)


@pytest.fixture
def committed() -> Dict[str, Any]:
    """The committed file, decoded — the reviewer's view of it."""
    return json.loads(constants.MCP_CATALOGUE_PATH.read_text(encoding="utf-8"))


def member_strings(member: Any) -> List[str]:
    """Every string leaf of a member group, in file order."""
    found: List[str] = []

    def walk(value: Any) -> None:
        if isinstance(value, str):
            found.append(value)
        elif isinstance(value, list):
            for item in value:
                walk(item)
        elif isinstance(value, dict):
            for item in value.values():
                walk(item)

    walk(member)
    return found


def entry_ids() -> List[str]:
    entries, notes = catalogue.load_catalogue()
    assert notes == [], f"the committed catalogue answered notes: {notes}"
    return [entry["id"] for entry in entries]


def _group_dicts(value: Any) -> List[Dict[str, Any]]:
    """Every JSON object nested inside a group, the group itself included."""
    if not isinstance(value, dict):
        return []
    found = [value]
    for item in value.values():
        if isinstance(item, dict):
            found.extend(_group_dicts(item))
        elif isinstance(item, list):
            for entry in item:
                found.extend(_group_dicts(entry))
    return found


class TestTheCommittedFile:
    def test_it_is_the_nine_settled_entries(self):
        assert entry_ids() == SETTLED_IDS

    def test_it_offers_neither_console_nor_fedit(self, committed):
        """They ship seeded and always present, so an entry would invite a
        duplicate id in every workspace."""
        assert "console" not in committed
        assert "fedit" not in committed

    def test_it_lives_beside_the_committed_connector_data(self):
        assert constants.MCP_CATALOGUE_PATH == (
            constants.MCP_CONNECTORS_DIR / "catalog-mcp.json"
        )
        assert constants.MCP_CATALOGUE_PATH.is_file()

    def test_every_entry_holds_the_four_groups_and_nothing_else(self, committed):
        for entry_id, raw in committed.items():
            assert set(raw) == {"identity", "member", "requirements", "relevance"}, (
                entry_id
            )
            assert set(raw["identity"]) == {"name", "description", "docs"}, entry_id
            assert set(raw["member"]) <= MEMBER_FIELDS, entry_id
            assert set(raw["requirements"]) == {"requires", "inputs"}, entry_id
            assert set(raw["relevance"]) == {"signals"}, entry_id

    def test_the_identity_lines_read_as_a_listing(self, committed):
        """A name and one line of what it is good for — what page 1 shows."""
        for entry_id, raw in committed.items():
            assert raw["identity"]["name"].strip(), entry_id
            description = raw["identity"]["description"].strip()
            assert description, entry_id
            assert "\n" not in description, entry_id
            assert raw["identity"]["docs"].startswith("https://"), entry_id


class TestTheFourGroupsParse:
    def test_every_entry_loads_with_all_four_groups(self):
        entries, notes = catalogue.load_catalogue()
        assert notes == []
        assert [entry["id"] for entry in entries] == SETTLED_IDS
        for entry in entries:
            assert set(entry) == {
                "id", "identity", "member", "requirements", "relevance",
            }
            assert entry["identity"]["name"]
            assert entry["member"]["type"] in ("local", "remote")
            assert isinstance(entry["requirements"]["requires"], dict)
            assert isinstance(entry["requirements"]["inputs"], list)
            assert isinstance(entry["relevance"]["signals"], list)

    def test_every_local_member_names_a_command_and_every_remote_a_url(self):
        entries, _ = catalogue.load_catalogue()
        for entry in entries:
            if entry["member"]["type"] == "local":
                assert entry["member"]["command"], entry["id"]
            else:
                assert entry["member"]["url"].startswith("https://"), entry["id"]

    def test_only_the_member_group_carries_the_members_shape(self, committed):
        """The split is the point: an install line is not a member field."""
        for entry_id, raw in committed.items():
            for group in ("identity", "requirements", "relevance"):
                leaked = MEMBER_ONLY_FIELDS & set(raw[group])
                assert leaked == set(), f"{entry_id}: {group} holds {leaked}"
                for nested in _group_dicts(raw[group]):
                    assert not MEMBER_ONLY_FIELDS & set(nested), f"{entry_id}: {nested}"


class TestTheMembersPassTheHubsOwnLoader:
    """Each member, written into a declaration file, is accepted by the loader
    the panel would have run after a restart — the shape is one validator's
    verdict, not this suite's second opinion."""

    @pytest.fixture
    def declaration(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
        # The reach seam is the deployment's answer, not this file's shape; forced
        # the way the hub's own tests force it, so a refused-reach note cannot
        # read as a shape refusal.
        monkeypatch.setattr(
            constants, "guardrails_speak_here", lambda prefixes=None: True
        )
        return tmp_path / "mcp-settings.json"

    def test_all_nine_load_as_declarations(self, declaration: Path):
        entries, _ = catalogue.load_catalogue()
        declaration.write_text(
            json.dumps({entry["id"]: entry["member"] for entry in entries}),
            encoding="utf-8",
        )

        connectors, errors = load_externals(path=declaration)

        assert errors == []
        # The loader walks the file's keys in sorted order; the catalogue keeps
        # the order a reviewer reads. Both are the same nine.
        ids = sorted(connector["id"] for connector in connectors)
        assert ids == sorted(SETTLED_IDS)
        assert len(connectors) == len(SETTLED_IDS)
        by_id = {connector["id"]: connector for connector in connectors}
        # And the loader read the same kind and endpoint the catalogue declares.
        catalogue_entries = {entry["id"]: entry for entry in entries}
        for connector_id, connector in by_id.items():
            member = catalogue_entries[connector_id]["member"]
            assert connector["kind"] == member["type"]
            if member["type"] == "remote":
                assert connector["endpoint"] == member["url"]
            else:
                assert connector["command"][0] == member["command"][0]

    def test_each_member_alone_is_accepted(self, declaration: Path):
        """Entry by entry, so a later entry cannot hide behind its neighbour."""
        entries, _ = catalogue.load_catalogue()
        for entry in entries:
            declaration.write_text(
                json.dumps({entry["id"]: entry["member"]}), encoding="utf-8"
            )
            connectors, errors = load_externals(path=declaration)
            assert errors == [], f"{entry['id']}: {errors}"
            assert [connector["id"] for connector in connectors] == [entry["id"]]


class TestTheAppKnowsNoPackageName:
    """The catalogue is the only source of a package name (§9), so the app
    itself must not spell one. This is the invariant behind "adding a connector
    is a data change and a review" — a name in code would be a second source."""

    def test_no_catalogue_package_name_appears_under_src(self, committed):
        names = {
            item["package"]
            for raw in committed.values()
            for item in raw["requirements"]["requires"].values()
        }
        assert len(names) >= len(committed) - 1, names
        offenders = [
            str(path.relative_to(SOURCE_ROOT))
            for path in SOURCE_ROOT.rglob("*.py")
            if "__pycache__" not in path.parts
            and any(name in path.read_text(encoding="utf-8") for name in names)
        ]
        assert offenders == []

    def test_the_reader_holds_no_package_name_of_its_own(self):
        text = Path(catalogue.__file__).read_text(encoding="utf-8")
        for marker in ("@playwright/", "mcp-server-", "@modelcontextprotocol/",
                       "chrome-devtools-mcp"):
            assert marker not in text, marker


class TestTheSecretsAndThePaths:
    def test_context7_carries_the_one_canonical_sentinel(self, committed):
        member = committed["context7"]["member"]
        assert member["type"] == "remote"
        assert member["headers"] == {"CONTEXT7_API_KEY": SENTINEL}

    def test_context7_is_the_only_entry_with_a_required_input(self, committed):
        holding = {
            entry_id: raw["requirements"]["inputs"]
            for entry_id, raw in committed.items()
            if raw["requirements"]["inputs"]
        }
        assert list(holding) == ["context7"]
        inputs = holding["context7"]
        assert [item["name"] for item in inputs] == ["CONTEXT7_API_KEY"]
        assert inputs[0]["slot"] == "headers.CONTEXT7_API_KEY"
        assert inputs[0]["required"] is True

    def test_no_member_holds_another_sentinel_spelling(self, committed):
        for entry_id, raw in committed.items():
            for value in member_strings(raw["member"]):
                if "put_your_api_key_here" not in value:
                    continue
                assert value == SENTINEL, f"{entry_id}: {value!r}"

    def test_no_member_holds_a_literal_secret(self, committed):
        for entry_id, raw in committed.items():
            for value in member_strings(raw["member"]):
                for marker in SECRET_MARKERS:
                    assert marker not in value, f"{entry_id}: {value!r} holds {marker}"

    def test_no_member_holds_a_literal_absolute_path(self, committed):
        """Every path a member names is an environment reference (§8)."""
        for entry_id, raw in committed.items():
            for value in member_strings(raw["member"]):
                if value.startswith(("http://", "https://")):
                    continue
                if not _looks_absolute(value):
                    continue
                assert ENV_REFERENCE_RE.fullmatch(value), f"{entry_id}: {value!r}"

    def test_the_workspace_reference_is_the_settled_spelling(self, committed):
        references = [
            value
            for raw in committed.values()
            for value in member_strings(raw["member"])
            if "${" in value
        ]
        assert references, "no member references the workspace at all"
        for value in references:
            assert value.startswith("${NOJAE_PATH_LOCATION}"), value


def _looks_absolute(value: str) -> bool:
    """A path-shaped literal, on either platform's spelling."""
    if value.startswith("/"):
        return True
    return bool(re.match(r"[A-Za-z]:[\\/]", value))


class TestTheReadNeverRaises:
    def _redirect(self, monkeypatch: pytest.MonkeyPatch, path: Path) -> None:
        monkeypatch.setattr(constants, "MCP_CATALOGUE_PATH", path)

    def test_an_absent_file_is_a_sentence_never_a_silent_empty_list(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """The catalogue ships with the install: its absence is a damaged
        install, and reads as one rather than as "there is nothing to offer"."""
        self._redirect(monkeypatch, tmp_path / "catalog-mcp.json")

        entries, notes = catalogue.load_catalogue()

        assert entries == []
        assert len(notes) == 1
        assert "catalog-mcp.json" in notes[0]

    def test_invalid_json_is_one_file_level_sentence(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        path = tmp_path / "catalog-mcp.json"
        path.write_text("{ not json", encoding="utf-8")
        self._redirect(monkeypatch, path)

        entries, notes = catalogue.load_catalogue()

        assert entries == []
        assert len(notes) == 1
        assert "not readable JSON" in notes[0]

    def test_a_top_level_array_is_one_file_level_sentence(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        path = tmp_path / "catalog-mcp.json"
        path.write_text('[{"id": "x"}]', encoding="utf-8")
        self._redirect(monkeypatch, path)

        entries, notes = catalogue.load_catalogue()

        assert entries == []
        assert len(notes) == 1
        assert "object of entries" in notes[0]

    def test_undecodable_bytes_are_one_sentence_not_a_traceback(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        path = tmp_path / "catalog-mcp.json"
        path.write_bytes(b"\xff\xfe\x00catalog")
        self._redirect(monkeypatch, path)

        entries, notes = catalogue.load_catalogue()

        assert entries == []
        assert len(notes) == 1

    def test_a_folder_at_the_path_is_a_sentence(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        path = tmp_path / "catalog-mcp.json"
        path.mkdir()
        self._redirect(monkeypatch, path)

        entries, notes = catalogue.load_catalogue()

        assert entries == []
        assert len(notes) == 1

    def test_one_malformed_entry_is_skipped_and_the_rest_load(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        path = tmp_path / "catalog-mcp.json"
        path.write_text(
            json.dumps(
                {
                    "kept": _entry(),
                    "no-member": {**_entry(), "member": {"type": "carrier-pigeon"}},
                    "no-identity": {
                        "member": _entry()["member"],
                        "requirements": {"requires": {}, "inputs": []},
                        "relevance": {"signals": []},
                    },
                    "also-kept": _entry(),
                }
            ),
            encoding="utf-8",
        )
        self._redirect(monkeypatch, path)

        entries, notes = catalogue.load_catalogue()

        assert [entry["id"] for entry in entries] == ["kept", "also-kept"]
        assert notes and all("skipped" in note for note in notes)
        assert len(notes) == 2

    def test_a_malformed_guidance_group_is_a_note_and_the_entry_still_loads(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """``requirements``/``relevance`` are the wizard's material, not the
        snippet's — so a broken one costs the entry its guidance, never its
        member."""
        broken = _entry()
        broken["requirements"] = {"requires": "npm install x", "inputs": "nope"}
        broken["relevance"] = {"signals": "everything"}
        path = tmp_path / "catalog-mcp.json"
        path.write_text(json.dumps({"kept": broken}), encoding="utf-8")
        self._redirect(monkeypatch, path)

        entries, notes = catalogue.load_catalogue()

        assert [entry["id"] for entry in entries] == ["kept"]
        assert entries[0]["member"]["type"] == "local"
        assert entries[0]["requirements"] == {"requires": {}, "inputs": []}
        assert entries[0]["relevance"] == {"signals": []}
        assert len(notes) == 3

    def test_the_real_file_still_answers_after_a_poisoned_redirect(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """The path is a module attribute read at call time, proved by a
        poisoned tree rather than by intent."""
        poisoned = tmp_path / "catalog-mcp.json"
        poisoned.write_text(json.dumps({"poison": _entry()}), encoding="utf-8")
        self._redirect(monkeypatch, poisoned)
        assert [entry["id"] for entry in catalogue.load_catalogue()[0]] == ["poison"]

        monkeypatch.undo()
        assert [entry["id"] for entry in catalogue.load_catalogue()[0]] == SETTLED_IDS

    def test_an_explicit_path_beats_the_attribute(
        self, tmp_path: Path
    ):
        elsewhere = tmp_path / "mine.json"
        elsewhere.write_text(json.dumps({"mine": _entry()}), encoding="utf-8")

        entries, notes = catalogue.load_catalogue(path=elsewhere)

        assert notes == []
        assert [entry["id"] for entry in entries] == ["mine"]


def _entry() -> Dict[str, Any]:
    """A shape-valid entry, the base every malformed case deforms."""
    return {
        "identity": {
            "name": "Playwright",
            "description": "Browser automation.",
            "docs": "https://github.com/microsoft/playwright-mcp",
        },
        "member": {
            "type": "local",
            "enable": True,
            "command": ["npx", "-y", "@playwright/mcp@latest"],
        },
        "requirements": {
            "requires": {
                "any": {
                    "package": "@playwright/mcp",
                    "install": "npm install -g @playwright/mcp",
                }
            },
            "inputs": [],
        },
        "relevance": {"signals": ["browser"]},
    }
