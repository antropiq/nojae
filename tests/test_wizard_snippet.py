"""The snippet, and the three checks that make it trustworthy (§6, §7, §8).

This suite asks the questions that keep ``core/wizard/snippet`` from becoming a
second opinion rather than that its checks run:

* **loader parity, both families.** The same member is put through this module
  and through the real declaration loader, over a real ``tmp_path`` declaration
  file, and the two sentences are compared. "One validator" is then a fact about
  two answers, not a claim in a docstring.
* **only the ``member`` group reaches the JSON** (AC-21), and the one key-bearing
  catalogue entry carries exactly the canonical sentinel (AC-8a).
* **a declared id is a warning, not a stop** — both an entry of that id and a
  ``_``-prefixed note key — and the snippet is still offered (AC-11).
* **the command is resolved, never spawned.** The lookup asks the *child's* own
  environment, so a ``PATH`` the entry itself sets changes the verdict; and the
  subprocess machinery is poisoned for a whole sweep, which must still answer
  every case (AC-14).
* **no literal path, no literal secret** in any member, and every answer names
  which of the two value forms it is showing (AC-13, §8).
* **the hub's reach refusal, in the hub's own words**, forced the way the hub's
  own tests force it.
* **always a member, never a file** — for a present and an absent declaration
  file alike (AC-19).

Every declaration file exercised here is a ``tmp_path`` one inside the workspace
scope the suite's guard enters, so nothing reads this checkout's own ``.nojae``,
opens the settings store or reaches a live hub.
"""

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest

from src.core import workspace as workspace_seam
from src.core.lsphub import constants as lsp_constants
from src.core.lsphub.discovery import load_lsp_servers
from src.core.mcphub import catalogue, constants as mcp_constants
from src.core.mcphub.discovery import load_externals
from src.core.wizard import prompts, snippet

#: The two settled spellings, written as literals so the test does not read the
#: values it is checking out of the code under test.
SENTINEL = "__put_your_api_key_here__"
PATH_REFERENCE = "${NOJAE_PATH_LOCATION}"


# -- helpers -------------------------------------------------------------------


def catalogue_entries() -> Dict[str, Dict[str, Any]]:
    entries, notes = catalogue.load_catalogue()
    assert notes == [], notes
    return {entry["id"]: entry for entry in entries}


def member_leaves(member: Any) -> List[str]:
    """Every string leaf of a member, in file order."""
    found: List[str] = []
    if isinstance(member, str):
        found.append(member)
    elif isinstance(member, dict):
        for item in member.values():
            found.extend(member_leaves(item))
    elif isinstance(member, list):
        for item in member:
            found.extend(member_leaves(item))
    return found


def write_declaration(path: Path, entries: Dict[str, Any]) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(entries, indent=2), encoding="utf-8")
    return path


@pytest.fixture
def declarations(tmp_path: Path) -> Dict[str, Path]:
    """The two declaration files this suite may write — ``tmp_path`` ones."""
    folder = tmp_path / "declarations"
    folder.mkdir()
    return {
        "mcp": folder / "mcp-settings.json",
        "lsp": folder / "lsp-settings.json",
    }


def local_entry(command: List[str], **extra: Any) -> Dict[str, Any]:
    """A minimal ``local`` member — the shape both hubs' loaders judge."""
    return {"type": "local", "enable": True, "command": list(command), **extra}


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
    """An executable shim called ``name`` in ``folder`` — never run by a test."""
    folder.mkdir(parents=True, exist_ok=True)
    shim = folder / name
    shim.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
    os.chmod(shim, 0o755)
    return shim


def answer_says_replaced(warning: Optional[str]) -> bool:
    """Does the sentinel's warning say it will not authenticate until replaced?"""
    assert warning is not None
    return "will not authenticate until" in warning and SENTINEL in warning


# -- the member, and what may reach it (AC-21) ---------------------------------


class TestTheMemberIsBuiltFromTheMemberGroup:
    def test_an_mcp_member_is_the_catalogue_member_and_nothing_else(self):
        """Only the ``member`` group becomes JSON — AC-21, the task-level trap.

        The check is the guidance the other three groups carry: the install
        line, the docs link, the signals, the description and the listing's
        name. (A ``requires.package`` may legitimately spell the same name the
        argv does — it is the same package — so the *install line* is the field
        that must never reach a member.)
        """
        for entry_id, entry in catalogue_entries().items():
            built = snippet.build_member(entry)
            assert built == entry["member"], entry_id
            # And none of the other three groups' values can be found in it.
            leaks = {
                "install": [
                    item["install"]
                    for item in entry["requirements"]["requires"].values()
                ],
                "inputs": entry["requirements"]["inputs"],
                "signals": entry["relevance"]["signals"],
                "docs": entry["identity"]["docs"],
                "description": entry["identity"]["description"],
                "name": entry["identity"]["name"],
            }
            leaves = member_leaves(built)
            for group, value in leaks.items():
                for text in member_leaves(value):
                    assert text not in leaves, f"{entry_id}: {group} leaked {text!r}"

    def test_no_member_carries_a_guidance_field_name(self):
        """The *field names* of the other groups are absent too, not just values."""
        forbidden = {"requires", "inputs", "signals", "docs", "relevance", "identity"}
        for entry_id, entry in catalogue_entries().items():
            built = snippet.build_member(entry)
            assert not forbidden & set(built), entry_id
            for nested in built.values():
                if isinstance(nested, dict):
                    assert not forbidden & set(nested), entry_id

    def test_every_snippet_is_rendered_from_its_member_group_alone(self, declarations):
        """AC-21, entry by entry, on the **text the user copies**.

        ``build_member`` is checked above; this is the same rule one step further
        out, where it actually matters: the snippet string page 3 prints and the
        copy button puts on the clipboard. Each of the nine is put through
        :func:`snippet.assess` and its ``snippet`` text is parsed back, so the
        claim is about the rendered JSON and not about a dict that never reached
        the user.

        The comparison is leaf-for-leaf rather than substring-for-substring on
        purpose: a signal like ``api`` is a substring of the ``CONTEXT7_API_KEY``
        header the member legitimately carries, and a guard that flags that is a
        guard somebody turns off.
        """
        path = write_declaration(declarations["mcp"], {})
        for entry_id, entry in catalogue_entries().items():
            answer = snippet.assess(
                "mcp",
                entry_id,
                snippet.build_member(entry),
                declaration_path=path,
                install={"any": "the-guidance-install-line"},
            )
            decoded = json.loads("{" + answer["snippet"] + "}")
            # One key, and it is the entry's id: a member, never a whole file.
            assert list(decoded) == [entry_id], entry_id
            assert decoded[entry_id] == entry["member"], entry_id

            # The text holds the member's own keys and leaf values and nothing
            # else. Compared as *values*, never as substrings of the serialised
            # text: a signal like ``api`` is a substring of the
            # ``CONTEXT7_API_KEY`` header the member legitimately carries, and a
            # guard that flags a correct snippet is a guard somebody turns off.
            leaves = member_leaves(decoded[entry_id])
            assert set(leaves) <= set(member_leaves(entry["member"])), entry_id
            guidance = {
                "install": [
                    item["install"]
                    for item in entry["requirements"]["requires"].values()
                ],
                "inputs": entry["requirements"]["inputs"],
                "signals": entry["relevance"]["signals"],
                "docs": entry["identity"]["docs"],
                "description": entry["identity"]["description"],
                "name": entry["identity"]["name"],
            }
            for group, value in guidance.items():
                for text in member_leaves(value):
                    assert text not in leaves, f"{entry_id}: {group} leaked {text!r}"
            # And the install line the caller handed over stays *beside* the
            # snippet, which is what makes it guidance rather than JSON. It is a
            # value this test invented, so it appears nowhere in any member and
            # its absence from the text is a fact rather than a coincidence.
            assert "the-guidance-install-line" not in answer["snippet"], entry_id
            assert answer["install"] == {"any": "the-guidance-install-line"}, entry_id

    def test_a_key_bearing_entry_carries_exactly_the_sentinel(self):
        entry = catalogue_entries()["context7"]
        built = snippet.build_member(entry)
        assert built["headers"] == {"CONTEXT7_API_KEY": SENTINEL}
        # Exactly the one canonical spelling: not a second variant of it.
        spellings = [v for v in member_leaves(built) if "put_your_api_key" in v]
        assert spellings == [SENTINEL]

    def test_a_prepared_answer_is_read_the_same_way(self):
        """The LSP half: an answer's ``member``, and none of its siblings.

        ``install``, ``requiresInstall``, ``decisions`` and the answer's own
        ``id`` are the wizard's material, exactly as the catalogue's guidance is.
        """
        prepared = {
            "id": "pyright",
            "member": lsp_member(),
            "install": {"any": "npm install -g pyright"},
            "requiresInstall": True,
            "decisions": ["the workspace root is the project root"],
        }
        built = snippet.build_member(prepared)
        assert built == prepared["member"]
        leaves = member_leaves(built)
        for guidance in (
            "npm install -g pyright",
            "the workspace root is the project root",
        ):
            assert guidance not in leaves, guidance
        assert "requiresInstall" not in built
        assert "decisions" not in built

    def test_a_source_without_a_member_has_no_snippet(self):
        with pytest.raises(ValueError):
            snippet.build_member({"identity": {}})
        with pytest.raises(ValueError):
            snippet.build_member({"member": {}})


class TestTheSnippetIsAlwaysAMemberNeverAFile:
    def test_the_rendered_text_is_one_key_and_parses(self):
        entry = catalogue_entries()["fetch"]
        built = snippet.build_member(entry)
        text = snippet.render_member("fetch", built)

        decoded = json.loads("{" + text + "}")
        assert list(decoded) == ["fetch"]
        assert decoded["fetch"] == built
        assert text.startswith('"fetch": {')

    def test_a_present_declaration_file_changes_no_shape(
        self, declarations: Dict[str, Path]
    ):
        """The file existing is a sentence, not a different output (AC-19)."""
        write_declaration(declarations["mcp"], {})
        entry = catalogue_entries()["fetch"]
        built = snippet.build_member(entry)
        absent = snippet.assess(
            "mcp", "fetch", built, declaration_path=declarations["mcp"] / "nope.json"
        )
        present = snippet.assess(
            "mcp", "fetch", built, declaration_path=declarations["mcp"]
        )

        assert absent["snippet"] == present["snippet"]
        assert absent["snippet"] == snippet.render_member("fetch", built)
        assert absent["declarationExists"] is False
        assert present["declarationExists"] is True
        assert absent["declarationPath"].endswith("nope.json")
        assert present["declarationPath"].endswith("mcp-settings.json")

    def test_the_answer_names_the_hubs_own_declaration_file(self):
        """The path is each hub's own resolver's answer, never a guess."""
        assert snippet.declaration_file("mcp") == Path(
            mcp_constants.mcp_settings_path()
        ).absolute()
        assert snippet.declaration_file("lsp") == Path(
            lsp_constants.lsp_settings_path()
        ).absolute()
        assert Path(snippet.declaration_file("mcp")).is_absolute()
        with pytest.raises(ValueError):
            snippet.declaration_file("css")


# -- check 1: the loader's verdict, in the loader's own words (AC-9) -----------


class TestTheLoaderIsTheOnlyValidator:
    def test_an_accepted_mcp_member_is_accepted_by_the_real_loader(
        self, declarations: Dict[str, Path]
    ):
        """Run the real file walk over the member and compare the two answers."""
        for entry_id, entry in catalogue_entries().items():
            built = snippet.build_member(entry)
            path = write_declaration(declarations["mcp"], {entry_id: built})

            ours = snippet.loader_verdict("mcp", entry_id, built, path)
            _connectors, errors = load_externals(path=path)

            assert ours["accepted"] is True, (entry_id, ours)
            assert errors == [], (entry_id, errors)

    def test_a_refused_mcp_member_is_refused_in_the_loaders_own_words(
        self, declarations: Dict[str, Path]
    ):
        path = declarations["mcp"]
        # A ``local`` entry with no command: the loader's own refusal.
        refused: Dict[str, Any] = {"type": "local", "enable": True}
        write_declaration(path, {"broken": refused})

        ours = snippet.loader_verdict("mcp", "broken", refused, path)
        _connectors, errors = load_externals(path=path)

        assert ours["accepted"] is False
        assert errors
        assert ours["sentence"] == errors[-1]
        # And it names the field to change — AC-9's second half.
        assert "command" in ours["sentence"]

    def test_an_accepted_lsp_member_is_accepted_by_the_real_loader(
        self, declarations: Dict[str, Path]
    ):
        path = declarations["lsp"]
        member = lsp_member()
        write_declaration(path, {"pyright": member})

        ours = snippet.loader_verdict("lsp", "pyright", member, path)
        servers, errors = load_lsp_servers(path=path)

        assert ours["accepted"] is True, ours
        assert errors == []
        assert [server["id"] for server in servers] == ["pyright"]

    def test_a_refused_lsp_member_is_refused_in_the_loaders_own_words(
        self, declarations: Dict[str, Path]
    ):
        path = declarations["lsp"]
        refused = lsp_member(workspaceRoot="a/relative/root")
        write_declaration(path, {"broken": refused})

        ours = snippet.loader_verdict("lsp", "broken", refused, path)
        _servers, errors = load_lsp_servers(path=path)

        assert ours["accepted"] is False
        assert errors
        assert ours["sentence"] == errors[-1]
        assert "workspaceRoot" in ours["sentence"]

    def test_a_reach_refusal_is_a_note_in_the_hubs_own_words(
        self, declarations: Dict[str, Path], monkeypatch: pytest.MonkeyPatch
    ):
        """A ``local`` candidate the hub would refuse says so, verbatim.

        Forced the way the hub's own tests force it: one attribute on the hub's
        ``constants`` module, which is the predicate's single named seam. The
        member is still offered, because an entry can be pasted before the
        capability exists — and the user reads the sentence *before* a restart.
        """
        monkeypatch.setattr(
            mcp_constants, "guardrails_speak_here", lambda prefixes=None: False
        )
        path = declarations["mcp"]
        member = local_entry(["some-program"])
        write_declaration(path, {"local_live": member})

        answer = snippet.assess("mcp", "local_live", member, declaration_path=path)
        _connectors, errors = load_externals(path=path)

        # The loader's own note, verbatim — prefix and all, which is the point:
        # this module paraphrases nothing the app already says.
        assert any(mcp_constants.LOCAL_REACH_REFUSAL in note for note in answer["notes"])
        assert answer["notes"] == errors
        assert answer["verdict"] == snippet.ACCEPTED_SENTENCE
        # Still offered: the reach is a deployment fact, not a broken member.
        assert answer["offered"] is True

    def test_the_lsp_hub_refuses_in_the_same_words(
        self, declarations: Dict[str, Path], monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(
            lsp_constants, "guardrails_speak_here", lambda prefixes=None: False
        )
        path = declarations["lsp"]
        member = lsp_member()
        write_declaration(path, {"local_live": member})

        answer = snippet.assess("lsp", "local_live", member, declaration_path=path)

        assert any(lsp_constants.LOCAL_REACH_REFUSAL in note for note in answer["notes"])
        assert lsp_constants.LOCAL_REACH_REFUSAL == mcp_constants.LOCAL_REACH_REFUSAL


# -- check 2: the command is resolved, never spawned (AC-14) -------------------


class TestTheCommandIsResolved:
    def test_a_program_on_the_childs_path_looks_installed(self, tmp_path: Path):
        bin_dir = tmp_path / "bin"
        plant_shim(bin_dir)
        member = lsp_member(env={"PATH": str(bin_dir)})

        answer = snippet.readiness(member, project_root=tmp_path)

        assert answer["readiness"] == snippet.READY
        assert answer["readiness"] == "looks installed"
        assert Path(answer["program"]).name.lower().startswith("fake-langserver")
        assert answer["searched"] is None

    def test_a_program_that_resolves_to_nothing_is_not_installed(
        self, tmp_path: Path
    ):
        empty = tmp_path / "empty-bin"
        empty.mkdir()
        member = lsp_member(env={"PATH": str(empty)})

        answer = snippet.readiness(member, project_root=tmp_path)

        assert answer["readiness"] == snippet.NOT_INSTALLED
        assert answer["readiness"] == "not installed"
        assert answer["program"] is None
        # The refusal names what was actually looked in, not the app's PATH.
        assert answer["searched"] == str(empty)

    def test_a_path_the_entry_itself_sets_changes_the_verdict(self, tmp_path: Path):
        """The trap: the child's environment is asked, never the app's.

        Same member, same ``argv[0]``, two ``env.PATH`` values — the answer
        follows the entry's own ``PATH``, which is what the hub spawns with.
        """
        carry = tmp_path / "bin-carries-it"
        absent = tmp_path / "bin-lacks-it"
        plant_shim(carry)
        absent.mkdir()

        carries = snippet.readiness(
            lsp_member(env={"PATH": str(carry)}), project_root=tmp_path
        )
        lacks = snippet.readiness(
            lsp_member(env={"PATH": str(absent)}), project_root=tmp_path
        )

        assert carries["readiness"] == snippet.READY
        assert lacks["readiness"] == snippet.NOT_INSTALLED
        assert lacks["searched"] == str(absent)
        # And the app's own PATH never answers for a bare name.
        assert carries["program"] is not None
        assert str(absent) not in (carries["program"] or "")

    def test_the_hubs_own_lookup_is_the_one_asked(self, tmp_path: Path):
        """The verdict *is* the hub's — one function, one search, one verdict.

        The identity is the assertion: this module and ``LspManager`` bind the
        same two functions, so there is no second implementation that could
        answer differently. Re-pointing one name would be the drift this checks
        against.
        """
        from src.core.lsphub.manager import LspManager
        from src.core.mcphub import process as process_module

        assert snippet.resolve_command is process_module.resolve_command
        assert snippet.child_environment is process_module.child_environment
        assert snippet.searched_paths is process_module.searched_paths

        # And the hub's own two helpers are that same pair, not copies: ask the
        # hub for its environment and compare it with the one this module asks
        # about, for one member.
        hub = LspManager([], logs_dir=tmp_path / "logs")
        member = lsp_member(env={"PATH": str(tmp_path / "bin")})
        assert hub._environment(member) == process_module.child_environment(
            hub._project_root, member["env"]
        )
        assert hub._resolve_command("no-such-program", {"PATH": ""}) is None
        assert snippet.readiness(member, project_root=tmp_path)["readiness"] == (
            snippet.NOT_INSTALLED
        )

    def test_a_remote_member_has_nothing_to_resolve(self):
        member = {"type": "remote", "url": "https://example.test/mcp"}
        assert snippet.readiness(member)["readiness"] is None

    def test_a_not_installed_candidate_is_still_offered_with_its_install_line(
        self, declarations: Dict[str, Path], tmp_path: Path
    ):
        path = declarations["mcp"]
        empty = tmp_path / "empty-bin"
        empty.mkdir()
        member = local_entry(["no-such-program"], env={"PATH": str(empty)})
        write_declaration(path, {})

        answer = snippet.assess(
            "mcp",
            "missing",
            member,
            declaration_path=path,
            install={"any": "npm install -g no-such-program"},
        )

        assert answer["readiness"] == snippet.NOT_INSTALLED
        assert answer["install"] == {"any": "npm install -g no-such-program"}
        assert answer["member"] == member
        assert answer["offered"] is True


class TestNothingIsEverSpawned:
    """Poison the process machinery and answer every case above anyway."""

    @pytest.fixture
    def no_processes(self, monkeypatch: pytest.MonkeyPatch):
        def refuse(*args: Any, **kwargs: Any):
            raise AssertionError("a process was started")

        for name in ("run", "call", "check_call", "check_output", "Popen"):
            monkeypatch.setattr(subprocess, name, refuse)
        for name in (
            "system", "execv", "execve", "execvp", "spawnv", "spawnve", "fork",
            "posix_spawn", "posix_spawnp",
        ):
            if hasattr(os, name):
                monkeypatch.setattr(os, name, refuse)

    def test_the_whole_module_answers_with_the_machinery_poisoned(
        self, no_processes, declarations: Dict[str, Path], tmp_path: Path
    ):
        bin_dir = tmp_path / "bin"
        plant_shim(bin_dir)
        empty = tmp_path / "empty-bin"
        empty.mkdir()
        path = write_declaration(declarations["mcp"], {})

        installed = snippet.assess(
            "mcp",
            "here",
            local_entry(["fake-langserver"], env={"PATH": str(bin_dir)}),
            declaration_path=path,
        )
        missing = snippet.assess(
            "mcp",
            "gone",
            local_entry(["no-such-program"], env={"PATH": str(empty)}),
            declaration_path=path,
        )
        remote = snippet.assess(
            "mcp",
            "docs",
            catalogue_entries()["context7"]["member"],
            declaration_path=path,
        )

        assert installed["readiness"] == snippet.READY
        assert missing["readiness"] == snippet.NOT_INSTALLED
        assert remote["readiness"] is None
        for answer in (installed, missing, remote):
            assert answer["snippet"]
            assert answer["verdict"]

    def test_the_module_imports_no_process_machinery(self):
        """The guard behind the sweep: the source spells no spawner at all."""
        text = Path(snippet.__file__).read_text(encoding="utf-8")
        body = text.split('"""', 2)[-1]  # skip the module docstring's prose
        for marker in (
            "subprocess", "Popen", "os.system", "os.spawn", "create_subprocess",
        ):
            assert marker not in body, marker

    def test_resolving_is_not_starting(self, tmp_path: Path):
        """The one act that is allowed, stated as its own contrast."""
        bin_dir = tmp_path / "bin"
        plant_shim(bin_dir)
        answer = snippet.readiness(
            lsp_member(env={"PATH": str(bin_dir)}), project_root=tmp_path
        )
        assert answer["program"] is not None


# -- check 3: a declared id is a warning, not a stop (AC-11) -------------------


class TestADuplicateIdIsAWarning:
    def test_an_id_already_declared_produces_the_warning_and_the_snippet(
        self, declarations: Dict[str, Path]
    ):
        path = write_declaration(
            declarations["mcp"], {"git": local_entry(["uvx", "mcp-server-git"])}
        )
        entry = catalogue_entries()["git"]

        answer = snippet.assess(
            "mcp", "git", snippet.build_member(entry), declaration_path=path
        )

        assert answer["duplicate"] is not None
        assert "git" in answer["duplicate"]
        assert "mcp-settings.json" in answer["duplicate"]
        # The snippet is offered anyway — a warning never stops (AC-11).
        assert answer["offered"] is True
        assert answer["member"] == entry["member"]

    def test_an_underscore_note_key_of_that_name_warns_too(
        self, declarations: Dict[str, Path]
    ):
        """A comment key there would make the pasted member a duplicate of it."""
        path = write_declaration(
            declarations["mcp"], {"_git": "a note about the git server"}
        )
        entry = catalogue_entries()["git"]

        answer = snippet.assess(
            "mcp", "git", snippet.build_member(entry), declaration_path=path
        )

        assert answer["duplicate"] is not None
        assert "_git" in answer["duplicate"]
        assert answer["offered"] is True

    def test_a_fresh_id_has_no_warning(self, declarations: Dict[str, Path]):
        path = write_declaration(declarations["mcp"], {"other": {"type": "remote"}})
        answer = snippet.assess(
            "mcp",
            "fetch",
            catalogue_entries()["fetch"]["member"],
            declaration_path=path,
        )
        assert answer["duplicate"] is None

    def test_an_absent_file_is_not_a_warning(self, tmp_path: Path):
        missing = tmp_path / "not-here" / "mcp-settings.json"
        assert snippet.duplicate_warning("git", missing) is None

    def test_reading_the_declaration_file_writes_nothing(
        self, declarations: Dict[str, Path]
    ):
        """The read names its path and never touches the file (AC-14)."""
        path = write_declaration(declarations["mcp"], {"git": {"type": "remote"}})
        before = (path.read_bytes(), path.stat().st_mtime_ns)

        snippet.assess(
            "mcp", "git", catalogue_entries()["git"]["member"], declaration_path=path
        )

        assert path.read_bytes() == before[0]
        assert path.stat().st_mtime_ns == before[1]


# -- the values (§8, AC-13) ----------------------------------------------------


class TestTheValues:
    def test_every_catalogue_member_is_offered_with_no_finding(
        self, declarations: Dict[str, Path]
    ):
        path = write_declaration(declarations["mcp"], {})
        for entry_id, entry in catalogue_entries().items():
            answer = snippet.assess(
                "mcp", entry_id, snippet.build_member(entry), declaration_path=path
            )
            assert answer["valueFindings"] == [], entry_id
            assert answer["offered"] is True, entry_id

    def test_no_member_carries_the_workspace_spelled_absolutely(
        self, declarations: Dict[str, Path]
    ):
        root = workspace_seam.current_root()
        path = write_declaration(declarations["mcp"], {})
        for entry_id, entry in catalogue_entries().items():
            answer = snippet.assess(
                "mcp", entry_id, snippet.build_member(entry), declaration_path=path
            )
            for value in member_leaves(answer["member"]):
                assert root not in value, f"{entry_id}: {value!r}"

    def test_a_literal_workspace_path_is_a_finding(self, tmp_path: Path):
        root = workspace_seam.current_root()
        member = local_entry(["npx", "some-server", str(Path(root) / "sub")])

        findings = snippet.value_findings(member, workspace_root=root)

        assert findings
        assert PATH_REFERENCE in findings[0]
        answer = snippet.assess(
            "mcp", "loud", member, declaration_path=tmp_path / "mcp-settings.json"
        )
        assert answer["offered"] is False

    def test_the_reference_form_is_what_a_path_should_be(self):
        root = workspace_seam.current_root()
        member = local_entry(["npx", "some-server", PATH_REFERENCE])
        assert snippet.value_findings(member, workspace_root=root) == []
        member = local_entry(["npx", "some-server", PATH_REFERENCE + "/web"])
        assert snippet.value_findings(member, workspace_root=root) == []

    def test_a_literal_secret_is_a_finding(self):
        member = {
            "type": "remote",
            "url": "https://example.test/mcp",
            "headers": {"CONTEXT7_API_KEY": "sk-live-0123456789"},
        }
        findings = snippet.value_findings(member)
        assert findings
        assert SENTINEL in findings[0]

    def test_the_sentinel_and_a_reference_are_both_clean(self):
        for value in (SENTINEL, "${CONTEXT7_API_KEY}"):
            member = {
                "type": "remote",
                "url": "https://example.test/mcp",
                "headers": {"CONTEXT7_API_KEY": value},
            }
            assert snippet.value_findings(member) == [], value

    def test_the_answer_says_which_value_form_it_shows(self):
        """The sentinel is the default, and the two forms never read the same."""
        sentinel = snippet.assess(
            "mcp", "docs", catalogue_entries()["context7"]["member"]
        )
        assert sentinel["valueForm"] == snippet.VALUE_FORM_SENTINEL
        assert answer_says_replaced(sentinel["valueWarning"])

        reference = snippet.assess(
            "mcp",
            "docs",
            {
                "type": "remote",
                "url": "https://example.test/mcp",
                "headers": {"CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}"},
            },
        )
        assert reference["valueForm"] == snippet.VALUE_FORM_REFERENCE
        assert reference["valueWarning"] != sentinel["valueWarning"]

        neither = snippet.assess(
            "mcp", "fetch", catalogue_entries()["fetch"]["member"]
        )
        assert neither["valueForm"] == snippet.VALUE_FORM_NONE
        assert neither["valueWarning"] is None

    def test_a_key_slot_filled_with_neither_form_is_a_finding_not_a_form(self):
        """A literal key is refused, never dressed up as a reference (§8)."""
        member = {
            "type": "remote",
            "url": "https://example.test/mcp",
            "headers": {"CONTEXT7_API_KEY": "sk-live-0123456789"},
        }
        assert snippet.value_form(member) == snippet.VALUE_FORM_NONE
        answer = snippet.assess("mcp", "docs", member)
        assert answer["offered"] is False
        assert answer["valueWarning"] is None

    def test_the_sentinel_wins_when_a_member_carries_both_forms(self):
        member = {
            "type": "remote",
            "url": "https://example.test/mcp",
            "headers": {
                "CONTEXT7_API_KEY": SENTINEL,
                "GITHUB_TOKEN": "${GITHUB_TOKEN}",
            },
        }
        assert snippet.value_form(member) == snippet.VALUE_FORM_SENTINEL

    def test_the_forms_are_distinct_strings_and_cover_every_member(self):
        forms = {
            snippet.VALUE_FORM_SENTINEL,
            snippet.VALUE_FORM_REFERENCE,
            snippet.VALUE_FORM_NONE,
        }
        assert len(forms) == 3
        for form in forms:
            assert snippet.value_warning(form) == snippet.value_warning(form)


# -- the one answer page 3 renders ---------------------------------------------


class TestTheAnswer:
    def test_it_carries_no_number(self, declarations: Dict[str, Path]):
        """§5 / AC-17: the wizard shows whose reasoning, never how much of it."""
        path = write_declaration(declarations["mcp"], {})
        answer = snippet.assess(
            "mcp",
            "fetch",
            catalogue_entries()["fetch"]["member"],
            declaration_path=path,
            install={"any": "pip install mcp-server-fetch"},
        )
        # Booleans are answers, not measurements, and the three of them are the
        # only non-text values: everything else is a string, a member or a list
        # of sentences. A token count or a cost would land here and fail.
        flags = {
            key for key, value in answer.items() if isinstance(value, bool)
        }
        assert flags == {"accepted", "declarationExists", "offered"}
        for key, value in answer.items():
            if key in flags:
                continue
            assert not isinstance(value, (int, float)), key

    def test_every_expected_key_is_present(self, declarations: Dict[str, Path]):
        path = write_declaration(declarations["mcp"], {})
        answer = snippet.assess(
            "mcp",
            "fetch",
            catalogue_entries()["fetch"]["member"],
            declaration_path=path,
        )
        assert set(answer) == {
            "family", "id", "member", "snippet", "accepted", "verdict", "notes",
            "readiness", "program", "searched", "install", "duplicate",
            "valueForm", "valueWarning", "valueFindings", "declarationPath",
            "declarationExists", "offered",
        }

    def test_it_refuses_a_member_the_loader_refuses(
        self, declarations: Dict[str, Path]
    ):
        path = write_declaration(declarations["lsp"], {})
        answer = snippet.assess(
            "lsp",
            "broken",
            lsp_member(workspaceRoot="relative"),
            declaration_path=path,
        )
        assert answer["accepted"] is False
        assert answer["offered"] is False
        assert "workspaceRoot" in answer["verdict"]

    def test_an_unknown_family_is_an_error_not_a_fallback(self, tmp_path: Path):
        with pytest.raises(ValueError):
            snippet.assess("css", "x", local_entry(["prog"]))
        with pytest.raises(ValueError):
            snippet.loader_verdict("css", "x", local_entry(["prog"]), tmp_path / "x")

    def test_an_empty_id_is_an_error(self):
        with pytest.raises(ValueError):
            snippet.assess("mcp", "  ", catalogue_entries()["fetch"]["member"])

    def test_the_families_are_the_prompts_own_two(self):
        assert set(prompts.FAMILIES) == {"mcp", "lsp"}
        # And the two settled spellings come from that one module, never a
        # second literal: the snippet imports them.
        source = Path(snippet.__file__).read_text(encoding="utf-8")
        assert SENTINEL not in source.split('"""', 2)[-1]
        assert "NOJAE_PATH_LOCATION" not in source.split('"""', 2)[-1]


class TestTheModuleLeavesTheLoaderAlone:
    """``${NAME}`` expansion is the loader's job and stays there (§8)."""

    def test_an_unresolved_reference_is_kept_verbatim_with_a_note(
        self, declarations: Dict[str, Path], monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.delenv("NOT_SET_ANYWHERE_MARKER", raising=False)
        path = write_declaration(declarations["mcp"], {})
        member = local_entry(["some-program", "${NOT_SET_ANYWHERE_MARKER}/x"])

        answer = snippet.assess("mcp", "typo", member, declaration_path=path)

        # Kept exactly as written — never blanked, never resolved here — and the
        # note is the loader's own, because the loader is what said it.
        assert answer["member"]["command"][1] == "${NOT_SET_ANYWHERE_MARKER}/x"
        assert any("is not set in the environment" in note for note in answer["notes"])

    def test_the_module_writes_and_expands_nothing(self):
        """The *code* spells no writer and no expander at all.

        Prose may name what is forbidden — the docstrings say "no backup", "no
        ``${NAME}`` expansion" — so the scan reads the AST's names and string
        constants, which is what a call would have to go through.
        """
        import ast

        tree = ast.parse(Path(snippet.__file__).read_text(encoding="utf-8"))
        spellings = set()
        for node in ast.walk(tree):
            if isinstance(node, ast.Name):
                spellings.add(node.id)
            elif isinstance(node, ast.Attribute):
                spellings.add(node.attr)
            elif isinstance(node, (ast.Import, ast.ImportFrom)):
                spellings.update(
                    (alias.asname or alias.name).split(".")[0]
                    for alias in node.names
                )
        for marker in (
            "write_text", "write_bytes", "open", "expand_env", "environ",
            "unlink", "mkdir", "shutil", "backup", "remove", "rename",
            "subprocess", "Popen", "system", "spawn",
        ):
            assert marker not in spellings, marker

    def test_an_absent_declaration_file_is_named_not_created(self, tmp_path: Path):
        path = tmp_path / "reserved" / "mcp-settings.json"
        answer = snippet.assess(
            "mcp",
            "fetch",
            catalogue_entries()["fetch"]["member"],
            declaration_path=path,
        )
        assert answer["declarationExists"] is False
        assert answer["declarationPath"] == str(path)
        assert not path.exists()
        assert not path.parent.exists()
