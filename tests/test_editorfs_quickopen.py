"""The quick-open finder's candidate list: the core walk and its payload.

The workspace is always a throw-away ``tmp_path``. Since clws-03 the **route**
rows name it through the ``workspace`` field (the client from
``tests/conftest.py``), and the rows that call the core walk directly run inside
``workspace.scope`` of it — the seam has no default folder, so a call that is not
a request has to say which folder it is about. Either way nothing here reads the
repository's own checkout. Visibility is exercised by **writing rules**, never by
patching a name list — the policy is the only exclusion mechanism, which is the
point of the feature. The cap is exercised by patching
``editorfs.constants.MAX_QUICKOPEN_FILES``, never by writing thousands of files.

The two answers that must not be confused: a ``hidden`` path is absent **and
uncounted** (counting it would be an observation of the name), while an ``ro``
one is absent from the list but still a real file the tree shows.
"""

from pathlib import Path
from typing import List

import pytest
from fastapi.testclient import TestClient

from src.api.server import create_app
from src.core import editorfs
from src.core.editorfs import policy_file, policy_seed
from src.core.editorfs import quickopen as quickopen_module
from tests.conftest import WorkspaceClient, scoped, workspace_params


def write(root: Path, rel: str, body: str = "x\n") -> None:
    """One file of the throw-away workspace, with its folders."""
    target = root / rel
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(body, encoding="utf-8", newline="")


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    """An empty tree the walk is asked about, seeded like a real one.

    Each test writes exactly the files its assertion is about, so an expected
    list here is a complete answer rather than a subset of a decoration. The
    seeded policy is what makes ``node_modules`` ``ro`` and ``.git`` ``hidden``
    the way a project a user opened would be.
    """
    policy_seed.ensure_policy_file(str(tmp_path))
    policy_file.invalidate_policy_cache()
    return tmp_path


def listing(root: Path) -> dict:
    """The core walk, asked about ``root`` — the scope a request would enter."""
    with scoped(root):
        return quickopen_module.list_workspace_files()


def paths(root: Path) -> List[str]:
    return listing(root)["files"]


class TestFlatList:
    def test_nested_files_are_workspace_relative(self, workspace: Path):
        write(workspace, "src/core/job.py")
        write(workspace, "README.md")
        # Depth-first, directories first: the nested file precedes the root one.
        assert paths(workspace) == ["src/core/job.py", "README.md"]

    def test_deterministic_and_in_the_trees_order(self, workspace: Path):
        write(workspace, "b/one.txt")
        write(workspace, "a/two.txt")
        write(workspace, "a/Z.txt")
        write(workspace, "top.txt")
        first = paths(workspace)
        assert first == paths(workspace)
        # Directories first depth-first, then files, ``(name.lower(), name)``
        # per directory — the tree's own ordering, so a truncated list is the
        # same first N paths every run.
        assert first == ["a/two.txt", "a/Z.txt", "b/one.txt", "top.txt"]


class TestPolicy:
    def test_hidden_folder_pruned_and_uncounted(self, workspace: Path):
        write(workspace, "secret/inner.txt")
        write(workspace, "visible.txt")
        from tests.test_editorfs import write_policy

        write_policy(workspace, [{"path": "secret/**", "mode": "hidden"}])
        payload = listing(workspace)
        assert payload["files"] == ["visible.txt"]
        assert payload["fileCount"] == 1

    def test_hidden_file_omitted(self, workspace: Path):
        write(workspace, "keep.txt")
        write(workspace, "drop.txt")
        from tests.test_editorfs import write_policy

        write_policy(workspace, [{"path": "drop.txt", "mode": "hidden"}])
        assert paths(workspace) == ["keep.txt"]

    def test_ro_file_excluded(self, workspace: Path):
        write(workspace, "frozen.txt")
        write(workspace, "live.txt")
        from tests.test_editorfs import write_policy

        write_policy(workspace, [{"path": "frozen.txt", "mode": "ro"}])
        assert paths(workspace) == ["live.txt"]

    def test_ro_folder_not_descended(self, workspace: Path):
        write(workspace, "vendor/lib/dep.py")
        write(workspace, "src/app.py")
        from tests.test_editorfs import write_policy

        write_policy(workspace, [{"path": "vendor/**", "mode": "ro"}])
        assert paths(workspace) == ["src/app.py"]

    def test_nojae_never_listed(self, workspace: Path):
        write(workspace, ".nojae/nojae-settings.json")
        write(workspace, "app.py")
        assert paths(workspace) == ["app.py"]

    def test_seeded_ro_and_hidden_names_absent(self, workspace: Path):
        # The seeded policy a real workspace starts with: ``node_modules`` is
        # ``ro`` and ``.git`` is ``hidden`` — neither may reach the list.
        write(workspace, "node_modules/left-pad/index.js")
        write(workspace, ".git/config")
        write(workspace, "main.py")
        assert paths(workspace) == ["main.py"]


class TestSymlinks:
    @pytest.mark.requires_symlink(
        "a symlinked directory inside the workspace is not descended, so no "
        "name from outside the working location enters the list"
    )
    def test_symlinked_dir_not_followed(self, workspace: Path, tmp_path_factory):
        outside = tmp_path_factory.mktemp("outside")
        (outside / "leak.txt").write_text("secret", encoding="utf-8")
        (workspace / "link").symlink_to(outside, target_is_directory=True)
        write(workspace, "inside.txt")
        assert paths(workspace) == ["inside.txt"]


class TestCap:
    def test_cap_truncates_with_honest_count(
        self, workspace: Path, monkeypatch: pytest.MonkeyPatch
    ):
        for i in range(5):
            write(workspace, f"f{i}.txt")
        monkeypatch.setattr(
            quickopen_module.constants, "MAX_QUICKOPEN_FILES", 3
        )
        payload = listing(workspace)
        assert payload["files"] == ["f0.txt", "f1.txt", "f2.txt"]
        assert payload["fileCount"] == 5
        assert payload["truncated"] is True

    def test_under_cap_not_truncated(
        self, workspace: Path, monkeypatch: pytest.MonkeyPatch
    ):
        write(workspace, "a.txt")
        monkeypatch.setattr(
            quickopen_module.constants, "MAX_QUICKOPEN_FILES", 3
        )
        payload = listing(workspace)
        assert payload["truncated"] is False
        assert payload["fileCount"] == 1


class TestEmpty:
    def test_empty_workspace(self, workspace: Path):
        payload = listing(workspace)
        assert payload == {"files": [], "fileCount": 0, "truncated": False}


class TestRoute:
    """``GET /api/fs/files`` — the finder's list, about the folder named.

    The rules are the core's and are asserted above; these rows are about the one
    thing only the route can show: the list is built from **the folder the request
    named**, so two tabs opening the dialog over one folder each get their own
    candidates (clws-03).
    """

    @pytest.fixture
    def client(self, workspace: Path):
        with TestClient(create_app()) as test_client:
            yield WorkspaceClient(test_client, workspace)

    def test_the_listing_is_the_named_folders(self, workspace: Path, client):
        write(workspace, "src/app.py")
        payload = client.get("/api/fs/files").json()
        assert payload["files"] == ["src/app.py"]

    @pytest.mark.parametrize("first", ["a", "b"], ids=["a-first", "b-first"])
    def test_two_named_folders_answer_their_own_lists(
        self, tmp_path: Path, client, first: str
    ):
        """One client, two folders, both orders, no invalidation in between.

        The list is what the dialog offers for *opening*, so a stale answer would
        be the other tab's files put in front of this tab's editor — the one
        failure mode of this surface that ends in a write to the wrong folder.
        """
        alpha = tmp_path / "alpha"
        beta = tmp_path / "beta"
        write(alpha, "src/alpha.py")
        write(beta, "src/beta.py")
        write(beta, "src/extra.py")
        expected = {alpha: ["src/alpha.py"], beta: ["src/beta.py", "src/extra.py"]}

        order = (alpha, beta) if first == "a" else (beta, alpha)
        for root in order:
            payload = client.get(
                "/api/fs/files", params=workspace_params(root)
            ).json()
            assert payload["files"] == expected[root]
            assert payload["fileCount"] == len(expected[root])

    def test_a_refused_folder_is_422_and_lists_nothing(
        self, client, tmp_path: Path
    ):
        ghost = tmp_path / "not-a-project"
        response = client.get("/api/fs/files", params=workspace_params(ghost))
        assert response.status_code == 422
        assert str(ghost) in response.json()["detail"]


class TestContract:
    def test_exported_from_package(self):
        assert editorfs.list_workspace_files is quickopen_module.list_workspace_files

    def test_no_fastapi_import(self):
        # The honest check: importing the module fresh must not pull FastAPI in.
        import subprocess as sp
        import sys

        code = (
            "import sys; import src.core.editorfs.quickopen; "
            "assert not [m for m in sys.modules if m.startswith('fastapi')]"
        )
        proc = sp.run(
            [sys.executable, "-c", code],
            capture_output=True, text=True,
            cwd=str(Path(quickopen_module.__file__).parents[3]),
        )
        assert proc.returncode == 0, proc.stderr
