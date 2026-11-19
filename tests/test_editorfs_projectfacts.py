"""The connector wizard's read-only scan: derived facts, never file bytes.

The workspace is always a throw-away ``tmp_path``, entered through the seam's
scope (``tests.conftest.scoped``) because a call that is not a request has to say
which folder it is about. Visibility is exercised by **writing policy rules**,
never by patching a name list — the policy is the only exclusion mechanism, which
is the point of the rule. The cap is exercised by patching
``editorfs.constants.MAX_QUICKOPEN_FILES``, never by writing thousands of files.

Three answers that must not be confused, and each has its own class below:

* a ``hidden`` path is absent **and uncounted** from every part of the answer
  (counting it would be an observation of the name);
* an ``ro`` manifest is a name without its dependencies — listed, never read;
* a file whose name is not on the allow-list is never opened at all, which the
  poisoned-file row proves rather than asserts by convention.
"""

import json
import os
from pathlib import Path
from typing import Any, Dict, List

import pytest

from src.core import editorfs
from src.core.editorfs import policy_file, policy_seed
from src.core.editorfs import projectfacts as projectfacts_module
from tests.conftest import scoped


def write(root: Path, rel: str, body: str = "x\n") -> Path:
    """One file of the throw-away workspace, with its folders."""
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body, encoding="utf-8", newline="")
    return target


def write_policy(root: Path, rules: List[Dict[str, str]]) -> Path:
    """Leave ``root`` a policy file of exactly ``rules``, as a user would have."""
    from tests.test_editorfs import write_policy as shared_writer

    return shared_writer(root, rules)


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    """An empty tree, seeded with the policy a real workspace starts with.

    The seeding is what makes ``node_modules`` ``ro`` and ``.git``/``__pycache__``
    ``hidden`` the way a project a user opened would be — so a row that plants one
    of those names is measuring the policy and not a test-only decoration.
    """
    policy_seed.ensure_policy_file(str(tmp_path))
    policy_file.invalidate_policy_cache()
    return tmp_path


def facts(root: Path, declared: Any = None) -> Dict[str, Any]:
    """The scan, asked about ``root`` — the scope a request would enter."""
    with scoped(root):
        return projectfacts_module.project_facts(declared)


def settle_the_policies_own_reads(root: Path) -> None:
    """One scan before a spy is installed: the policy file and the case probe.

    Neither open belongs to this module — :mod:`editorfs.policy_file` reads the
    workspace's policy once per root and the case probe writes and removes its own
    two names in the root (see :mod:`mcp_connectors.fscase`). Both are cached, so
    a scan that follows opens **nothing but a manifest**, which is what a spy over
    ``open`` can then assert without filtering names.
    """
    facts(root)


def extensions(payload: Dict[str, Any]) -> Dict[str, int]:
    """The extension counts as ``{extension: count}``, order-free."""
    return {
        item["extension"]: item["count"] for item in payload["extensions"]
    }


def manifest_paths(payload: Dict[str, Any]) -> List[str]:
    return [item["path"] for item in payload["manifests"]]


def manifest(payload: Dict[str, Any], path: str) -> Dict[str, Any]:
    for item in payload["manifests"]:
        if item["path"] == path:
            return item
    raise AssertionError(f"{path} is not in the scan's manifests: {manifest_paths(payload)}")


class TestACountedFolder:
    def test_python_leads_and_the_manifest_is_parsed(self, workspace: Path):
        """The example the feature exists for: ".py leading, a pyproject"."""
        for index in range(4):
            write(workspace, f"src/mod_{index}.py")
        write(workspace, "README.md")
        write(
            workspace,
            "pyproject.toml",
            '[project]\nname = "demo"\ndependencies = ["fastapi[all]>=0.110", "httpx"]\n',
        )
        payload = facts(workspace)
        assert payload["extensions"][0] == {
            "extension": ".py",
            "count": 4,
            "servers": [],
        }
        assert extensions(payload) == {".py": 4, ".md": 1, ".toml": 1}
        assert manifest_paths(payload) == ["pyproject.toml"]
        assert manifest(payload, "pyproject.toml")["dependencies"] == [
            "fastapi",
            "httpx",
        ]
        assert payload["fileCount"] == 6
        assert payload["truncated"] is False

    def test_extension_order_is_count_then_extension(self, workspace: Path):
        write(workspace, "a.py")
        write(workspace, "b.py")
        write(workspace, "a.ts")
        write(workspace, "b.ts")
        write(workspace, "a.css")
        payload = facts(workspace)
        assert [item["extension"] for item in payload["extensions"]] == [
            ".py",
            ".ts",
            ".css",
        ]

    def test_an_empty_folder_answers_empty_facts(self, workspace: Path):
        payload = facts(workspace)
        assert payload["extensions"] == []
        assert payload["manifests"] == []
        assert payload["fileCount"] == 0
        assert payload["truncated"] is False
        assert payload["frontEnd"] is None
        assert payload["declared"] == {"mcp": [], "lsp": []}

    def test_a_file_with_no_extension_is_counted_but_not_an_extension(
        self, workspace: Path
    ):
        write(workspace, "Makefile")
        write(workspace, "app.py")
        payload = facts(workspace)
        assert payload["extensions"] == [
            {"extension": ".py", "count": 1, "servers": []}
        ]
        assert payload["fileCount"] == 2


class TestManifests:
    """Every allow-listed reader answers **names**, never file contents."""

    def test_package_json_lists_all_four_blocks(self, workspace: Path):
        write(
            workspace,
            "package.json",
            json.dumps(
                {
                    "name": "demo",
                    "dependencies": {"vue": "^3.4.0"},
                    "devDependencies": {"vite": "^5.0.0"},
                    "peerDependencies": {"pino": "^9.0.0"},
                    "optionalDependencies": {"fsevents": "^2.3.0"},
                }
            ),
        )
        payload = facts(workspace)
        assert manifest(payload, "package.json")["dependencies"] == [
            "fsevents",
            "pino",
            "vite",
            "vue",
        ]

    def test_requirements_txt_answers_names_not_specifiers(self, workspace: Path):
        write(
            workspace,
            "requirements.txt",
            "# a comment\nfastapi[all]>=0.110\nhttpx\n-r other.txt\n"
            "ruff==0.4.0  # inline\n",
        )
        payload = facts(workspace)
        assert manifest(payload, "requirements.txt")["dependencies"] == [
            "fastapi",
            "httpx",
            "ruff",
        ]

    def test_go_mod_answers_both_forms(self, workspace: Path):
        write(
            workspace,
            "go.mod",
            "module demo\n\nrequire (\n\tgithub.com/foo/bar v1.2.3\n"
            "\tgithub.com/baz/qux v0.1.0\n)\n\nrequire github.com/one/two v2.0.0\n",
        )
        payload = facts(workspace)
        assert manifest(payload, "go.mod")["dependencies"] == [
            "github.com/baz/qux",
            "github.com/foo/bar",
            "github.com/one/two",
        ]

    def test_composer_gemfile_and_gradle_answer_their_siblings(self, workspace: Path):
        write(
            workspace,
            "composer.json",
            json.dumps({"require": {"php": ">=8.1", "monolog/monolog": "^3.0"}}),
        )
        write(workspace, "Gemfile", 'source "https://rubygems.org"\ngem "rails", "~> 7.1"\n')
        write(
            workspace,
            "build.gradle",
            "repositories { mavenCentral() }\n"
            'maven { url "https://repo.example.com/releases" }\n'
            "dependencies {\n"
            "    implementation 'org.springframework:spring-core:6.1.0'\n"
            "}\n",
        )
        payload = facts(workspace)
        assert manifest(payload, "composer.json")["dependencies"] == [
            "monolog/monolog",
            "php",
        ]
        assert manifest(payload, "Gemfile")["dependencies"] == ["rails"]
        # Neither a repository block nor a URL beside one reads as a coordinate.
        assert manifest(payload, "build.gradle")["dependencies"] == [
            "org.springframework:spring-core"
        ]

    def test_a_linter_config_is_present_with_no_dependency_names(
        self, workspace: Path
    ):
        write(workspace, "tsconfig.json", json.dumps({"compilerOptions": {}}))
        write(workspace, ".eslintrc.json", json.dumps({"extends": ["eslint:recommended"]}))
        payload = facts(workspace)
        # Presence is the fact; a config declares no dependency of its own. The
        # order is the tree's (alphabetical within one folder).
        assert manifest_paths(payload) == [".eslintrc.json", "tsconfig.json"]
        assert all(item["dependencies"] == [] for item in payload["manifests"])

    @pytest.mark.skipif(
        projectfacts_module.tomllib is None,
        reason="no stdlib TOML reader on this interpreter: a TOML manifest is "
        "reported as present with no dependency names, which is the documented "
        "3.10 answer and is asserted below",
    )
    def test_cargo_and_poetry_dependency_tables(self, workspace: Path):
        write(
            workspace,
            "Cargo.toml",
            '[package]\nname = "demo"\n[dependencies]\nserde = "1"\n'
            '[dev-dependencies]\ntempfile = "3"\n',
        )
        write(
            workspace,
            "pyproject.toml",
            '[tool.poetry]\nname = "demo"\n'
            '[tool.poetry.dependencies]\npython = "^3.11"\nhttpx = "^0.27"\n',
        )
        payload = facts(workspace)
        assert manifest(payload, "Cargo.toml")["dependencies"] == ["serde", "tempfile"]
        assert manifest(payload, "pyproject.toml")["dependencies"] == ["httpx", "python"]

    def test_a_damaged_manifest_is_present_and_declares_nothing(
        self, workspace: Path
    ):
        write(workspace, "package.json", "{ this is not json ")
        payload = facts(workspace)
        assert manifest(payload, "package.json")["dependencies"] == []

    def test_a_manifest_past_the_read_cap_is_not_parsed_in_a_fragment(
        self, workspace: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """The cap is read at call time, so a fragment cannot be reported as a file."""
        write(workspace, "package.json", json.dumps({"dependencies": {"vue": "3"}}))
        monkeypatch.setattr(
            projectfacts_module.constants, "MAX_EDITOR_BYTES", 4
        )
        payload = facts(workspace)
        assert manifest(payload, "package.json")["dependencies"] == []


class TestPolicy:
    def test_hidden_folder_absent_and_uncounted(self, workspace: Path):
        write(workspace, "secret/inner.py")
        write(workspace, "secret/requirements.txt", "internal-lib\n")
        write(workspace, "visible.py")
        write_policy(workspace, [{"path": "secret", "mode": "hidden"}])
        payload = facts(workspace)
        # Not a path, not an extension, not a count — and no dependency name
        # from a manifest inside it, which is how a hidden name would leak.
        assert extensions(payload) == {".py": 1}
        assert payload["manifests"] == []
        assert payload["fileCount"] == 1
        assert "secret" not in json.dumps(payload)

    def test_hidden_file_absent_and_uncounted(self, workspace: Path):
        write(workspace, "keep.py")
        write(workspace, "drop.py")
        write_policy(workspace, [{"path": "drop.py", "mode": "hidden"}])
        payload = facts(workspace)
        assert extensions(payload) == {".py": 1}
        assert payload["fileCount"] == 1
        assert "drop.py" not in json.dumps(payload)

    def test_ro_manifest_is_named_and_never_parsed(self, workspace: Path):
        write(workspace, "frozen/package.json", json.dumps({"dependencies": {"vue": "3"}}))
        write_policy(workspace, [{"path": "frozen/package.json", "mode": "ro"}])
        payload = facts(workspace)
        # Its name counts toward the extension total — the tree shows it — and
        # the manifest is listed, but nothing inside it was read.
        assert extensions(payload) == {".json": 1}
        assert manifest_paths(payload) == ["frozen/package.json"]
        assert manifest(payload, "frozen/package.json")["dependencies"] == []
        assert "vue" not in json.dumps(payload)

    def test_an_ro_folder_is_not_descended(self, workspace: Path):
        """A vendor tree cannot spend the walk budget or name the front end."""
        write(workspace, "vendor/lib/package.json", json.dumps({"dependencies": {"dep": "1"}}))
        write(workspace, "vendor/lib/deep.py")
        write(workspace, "app.py")
        write_policy(workspace, [{"path": "vendor/**", "mode": "ro"}])
        payload = facts(workspace)
        assert extensions(payload) == {".py": 1}
        assert payload["manifests"] == []
        assert payload["frontEnd"] is None
        assert payload["fileCount"] == 1

    def test_reserved_folder_never_appears(self, workspace: Path):
        write(workspace, ".nojae/mcp-settings.json", json.dumps({"x": {"type": "remote"}}))
        write(workspace, ".nojae/lsp-settings.json", json.dumps({"x": {"command": "x"}}))
        write(workspace, "app.py")
        payload = facts(workspace)
        assert extensions(payload) == {".py": 1}
        assert payload["manifests"] == []
        assert ".nojae" not in json.dumps(payload)

    def test_seeded_ro_and_hidden_names_are_not_walked(self, workspace: Path):
        """The policy a real workspace starts with, on a real checkout's names.

        ``node_modules`` is ``ro`` (not descended, so its vendor manifests never
        appear) and ``.git``/``__pycache__`` are ``hidden`` (pruned, so not even a
        name arrives) — which is what keeps a scan of a working checkout about the
        project instead of its dependencies.
        """
        write(workspace, "node_modules/left-pad/package.json",
              json.dumps({"dependencies": {"inner-dep": "1"}}))
        write(workspace, ".git/config", "[core]\n")
        write(workspace, "src/__pycache__/job.pyc", "binary")
        write(workspace, "src/job.py")
        payload = facts(workspace)
        assert extensions(payload) == {".py": 1}
        assert payload["manifests"] == []
        assert payload["frontEnd"] is None
        assert "inner-dep" not in json.dumps(payload)
        assert ".git" not in json.dumps(payload)
        assert "__pycache__" not in json.dumps(payload)


class TestAllowList:
    def test_a_credential_file_is_never_opened(self, workspace: Path, monkeypatch):
        """The poisoned-file proof: content that would be reported if it were read."""
        write(workspace, ".env", "SECRET_TOKEN=poison\n")
        write(workspace, "credentials.json", json.dumps({"SECRET_TOKEN": "poison"}))
        write(workspace, "id_rsa", "poison")
        write(workspace, "app.py")

        # The policy's own reads happen on the first scan; the one under the spy
        # then opens nothing at all.
        settle_the_policies_own_reads(workspace)
        opened: List[str] = []
        real_open = open

        def spying_open(path, *args, **kwargs):
            opened.append(os.path.basename(str(path)))
            return real_open(path, *args, **kwargs)

        monkeypatch.setattr("builtins.open", spying_open)
        payload = facts(workspace)
        assert opened == []
        assert "poison" not in json.dumps(payload)
        assert "SECRET_TOKEN" not in json.dumps(payload)
        assert payload["manifests"] == []
        # The credential file still counts toward its extension — the tree shows
        # that name, and a count is not a read. What cannot happen is a path to
        # it or anything from inside it.
        assert extensions(payload) == {".json": 1, ".py": 1}
        assert "credentials.json" not in json.dumps(payload)
        assert ".env" not in json.dumps(payload)
        assert "id_rsa" not in json.dumps(payload)

    def test_only_an_allow_listed_manifest_is_opened(self, workspace: Path, monkeypatch):
        write(workspace, "package.json", json.dumps({"dependencies": {"vue": "3"}}))
        write(workspace, "notes.txt", "read-me-not\n")
        write(workspace, "data.json", json.dumps({"dependencies": {"poison": "1"}}))

        settle_the_policies_own_reads(workspace)
        opened: List[str] = []
        real_open = open

        def spying_open(path, *args, **kwargs):
            opened.append(str(path))
            return real_open(path, *args, **kwargs)

        monkeypatch.setattr("builtins.open", spying_open)
        payload = facts(workspace)
        assert [os.path.basename(name) for name in opened] == ["package.json"]
        # ``data.json`` is not on the list, so its dependency name never appears —
        # even though it has exactly the shape the npm reader would parse.
        assert "poison" not in json.dumps(payload)

    def test_a_symlinked_manifest_is_listed_but_not_read(
        self, workspace: Path, tmp_path_factory
    ):
        outside = tmp_path_factory.mktemp("outside")
        target = outside / "package.json"
        target.write_text(json.dumps({"dependencies": {"leaked": "1"}}), encoding="utf-8")
        try:
            (workspace / "package.json").symlink_to(target)
        except OSError:  # pragma: no cover - platform without symlink permission
            pytest.skip("this host does not allow creating a symlink")
        payload = facts(workspace)
        assert manifest_paths(payload) == ["package.json"]
        assert manifest(payload, "package.json")["dependencies"] == []
        assert "leaked" not in json.dumps(payload)


class TestShape:
    """No value in the payload is file content — asserted structurally."""

    def test_every_value_is_a_count_a_name_a_path_or_a_flag(self, workspace: Path):
        write(workspace, "pyproject.toml", '[project]\ndependencies = ["fastapi"]\n')
        write(workspace, "package.json", json.dumps({"dependencies": {"vue": "3"}}))
        write(workspace, "src/app.py")
        payload = facts(workspace, {"lsp": [{"id": "py", "extensions": [".py"]}]})

        assert set(payload) == {
            "extensions",
            "manifests",
            "declared",
            "frontEnd",
            "fileCount",
            "truncated",
        }
        for item in payload["extensions"]:
            assert set(item) == {"extension", "count", "servers"}
            assert isinstance(item["count"], int)
            assert isinstance(item["extension"], str) and item["extension"].startswith(".")
            assert isinstance(item["servers"], list)
        for item in payload["manifests"]:
            assert set(item) == {"path", "dependencies"}
            assert isinstance(item["path"], str)
            assert isinstance(item["dependencies"], list)
            assert all(isinstance(name, str) for name in item["dependencies"])
        assert set(payload["declared"]) == {"mcp", "lsp"}
        assert isinstance(payload["fileCount"], int)
        assert isinstance(payload["truncated"], bool)
        assert payload["frontEnd"] is None or isinstance(payload["frontEnd"], str)

    def test_no_absolute_path_and_no_file_body_anywhere(self, workspace: Path):
        body = "the manifest body that must never travel"
        write(workspace, "pyproject.toml", f'[project]\ndescription = "{body}"\n')
        write(workspace, "src/app.py", body)
        payload = facts(workspace)
        serialised = json.dumps(payload)
        assert body not in serialised
        assert str(workspace) not in serialised

    def test_manifest_paths_are_workspace_relative(self, workspace: Path):
        write(workspace, "web/package.json", json.dumps({"dependencies": {"vue": "3"}}))
        payload = facts(workspace)
        assert manifest_paths(payload) == ["web/package.json"]
        assert payload["frontEnd"] == "web"


class TestCap:
    def test_cap_truncates_with_the_honest_total(
        self, workspace: Path, monkeypatch: pytest.MonkeyPatch
    ):
        for index in range(5):
            write(workspace, f"f{index}.py")
        monkeypatch.setattr(
            projectfacts_module.constants, "MAX_QUICKOPEN_FILES", 3
        )
        payload = facts(workspace)
        assert payload["truncated"] is True
        assert payload["fileCount"] == 5
        assert extensions(payload) == {".py": 3}

    def test_under_cap_not_truncated(self, workspace: Path, monkeypatch):
        write(workspace, "a.py")
        monkeypatch.setattr(
            projectfacts_module.constants, "MAX_QUICKOPEN_FILES", 3
        )
        payload = facts(workspace)
        assert payload["truncated"] is False
        assert payload["fileCount"] == 1

    def test_a_truncated_scan_repeats_itself(self, workspace: Path, monkeypatch):
        """Deterministic order: the same first N facts every run, not inode order."""
        for index in range(6):
            write(workspace, f"dir{index}/mod.py")
            write(workspace, f"dir{index}/package.json", json.dumps({"dependencies": {"d": "1"}}))
        monkeypatch.setattr(
            projectfacts_module.constants, "MAX_QUICKOPEN_FILES", 4
        )
        first = facts(workspace)
        again = facts(workspace)
        assert first == again
        assert first["truncated"] is True
        # Two files per directory, directories first: dir0 and dir1 were walked.
        assert manifest_paths(first) == ["dir0/package.json", "dir1/package.json"]


class TestSymlinks:
    def test_a_symlinked_directory_is_not_descended(
        self, workspace: Path, tmp_path_factory
    ):
        outside = tmp_path_factory.mktemp("outside")
        (outside / "leak.py").write_text("x\n", encoding="utf-8")
        (outside / "package.json").write_text(
            json.dumps({"dependencies": {"leaked": "1"}}), encoding="utf-8"
        )
        try:
            (workspace / "link").symlink_to(outside, target_is_directory=True)
        except OSError:  # pragma: no cover - platform without symlink permission
            pytest.skip("this host does not allow creating a symlink")
        write(workspace, "inside.py")
        payload = facts(workspace)
        assert extensions(payload) == {".py": 1}
        assert payload["manifests"] == []
        assert "leak" not in json.dumps(payload)


class TestFrontEnd:
    def test_the_web_manifest_names_the_folder(self, workspace: Path):
        write(workspace, "web/package.json", json.dumps({"name": "web"}))
        write(workspace, "src/app.py")
        payload = facts(workspace)
        assert payload["frontEnd"] == "web"

    def test_the_root_manifest_is_the_root(self, workspace: Path):
        write(workspace, "package.json", json.dumps({"name": "root"}))
        payload = facts(workspace)
        assert payload["frontEnd"] == ""

    def test_a_project_with_no_front_end_answers_none(self, workspace: Path):
        write(workspace, "src/app.py")
        write(workspace, "pyproject.toml", '[project]\nname = "demo"\n')
        payload = facts(workspace)
        assert payload["frontEnd"] is None

    def test_a_tsconfig_alone_names_its_folder(self, workspace: Path):
        write(workspace, "ui/tsconfig.json", json.dumps({"compilerOptions": {}}))
        payload = facts(workspace)
        assert payload["frontEnd"] == "ui"

    def test_the_shallowest_front_end_folder_wins(self, workspace: Path):
        """A vendor's nested manifest is not where the project's front end is."""
        write(workspace, "web/node_modules/dep/package.json", json.dumps({"name": "dep"}))
        write(workspace, "web/package.json", json.dumps({"name": "web"}))
        payload = facts(workspace)
        assert payload["frontEnd"] == "web"

    def test_a_read_only_front_end_manifest_still_names_its_folder(
        self, workspace: Path
    ):
        """An ``ro`` manifest is a name without its dependencies, not an absence."""
        write(workspace, "ui/package.json", json.dumps({"name": "ui"}))
        write_policy(workspace, [{"path": "ui/package.json", "mode": "ro"}])
        payload = facts(workspace)
        assert payload["frontEnd"] == "ui"
        assert manifest(payload, "ui/package.json")["dependencies"] == []


class TestDeclaredServers:
    def test_a_covered_language_is_already_served(self, workspace: Path):
        write(workspace, "src/app.py")
        write(workspace, "web/App.vue")
        payload = facts(
            workspace,
            {
                "mcp": ["filesystem"],
                "lsp": [{"id": "python", "extensions": [".py"]}],
            },
        )
        by_extension = {item["extension"]: item for item in payload["extensions"]}
        # Served: the extension still counts, and names the server that covers it.
        assert by_extension[".py"]["servers"] == ["python"]
        # The gap: a language nothing is declared for, which is what leads.
        assert by_extension[".vue"]["servers"] == []
        assert payload["declared"] == {
            "mcp": ["filesystem"],
            "lsp": [{"id": "python", "extensions": [".py"]}],
        }

    def test_two_servers_on_one_extension_are_both_named(self, workspace: Path):
        write(workspace, "src/app.ts")
        payload = facts(
            workspace,
            {
                "lsp": [
                    {"id": "typescript", "extensions": [".ts"]},
                    {"id": "eslint", "extensions": [".ts"]},
                ]
            },
        )
        assert payload["extensions"][0]["servers"] == ["eslint", "typescript"]

    def test_a_bare_id_and_an_uppercase_extension_are_normalised(self, workspace: Path):
        write(workspace, "src/app.PY")
        payload = facts(workspace, {"mcp": ["context7"], "lsp": [{"id": "python", "extensions": [".PY"]}]})
        assert payload["extensions"] == [
            {"extension": ".py", "count": 1, "servers": ["python"]}
        ]
        assert payload["declared"]["mcp"] == ["context7"]

    def test_a_meaningless_argument_answers_no_declarations(self, workspace: Path):
        write(workspace, "src/app.py")
        for poisoned in (None, "nonsense", 7, {"lsp": "nope"}):
            payload = facts(workspace, poisoned)
            assert payload["declared"] == {"mcp": [], "lsp": []}
            assert payload["extensions"][0]["servers"] == []


class TestContract:
    def test_exported_from_package(self):
        assert editorfs.project_facts is projectfacts_module.project_facts

    def test_nothing_is_written(self, workspace: Path):
        """The scan leaves the tree byte-identical, ``.nojae`` included."""
        write(workspace, "pyproject.toml", '[project]\ndependencies = ["fastapi"]\n')
        write(workspace, "src/app.py")

        before = sorted(
            (str(path), path.stat().st_mtime_ns)
            for path in workspace.rglob("*")
        )
        facts(workspace, {"lsp": [{"id": "python", "extensions": [".py"]}]})
        after = sorted(
            (str(path), path.stat().st_mtime_ns)
            for path in workspace.rglob("*")
        )
        assert after == before

    def test_no_hub_and_no_api_import(self):
        """Core's rule: no hub (a cycle), no API layer, no process machinery."""
        import subprocess as sp
        import sys

        code = (
            "import sys; import src.core.editorfs.projectfacts; "
            "bad = [m for m in sys.modules if m.startswith(('fastapi', 'src.api'))"
            " or m.endswith(('.lsphub', '.mcphub'))"
            " or m in ('src.core.lsphub', 'src.core.mcphub')]; "
            "assert not bad, bad"
        )
        proc = sp.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            cwd=str(Path(projectfacts_module.__file__).parents[3]),
        )
        assert proc.returncode == 0, proc.stderr

    def test_the_allow_list_names_no_credential_file(self):
        """The list is the rule, so its whole reach is assertable in one place."""
        forbidden = (
            ".env",
            ".env.local",
            "id_rsa",
            "id_ed25519",
            ".netrc",
            ".npmrc",
            "credentials",
            "credentials.json",
            "secrets.json",
        )
        for name in forbidden:
            assert name not in projectfacts_module.MANIFESTS
        for name in (
            "package.json",
            "pyproject.toml",
            "requirements.txt",
            "go.mod",
            "Cargo.toml",
            "composer.json",
            "Gemfile",
            "build.gradle",
        ):
            assert name in projectfacts_module.MANIFESTS
