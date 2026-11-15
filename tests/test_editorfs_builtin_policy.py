"""Tests for pol-03: level A — the rules nojae has about **itself**.

Pure ``mode_for`` calls, plus the two checks that make the task a proven
non-event: the **agreement and the measured deltas** against the predicates that
are still live (the old path stays the live one until pol-06 wires the verdict),
and a route-level pin that the live path still refuses the app's own ``.env`` —
this task must not open anything.

The workspace is always the seam's **scope** — never the installation stubbed
away. Stubbing :func:`is_self_workspace` would stub away the single comparison
this task is about, so a suite that patched it could not tell a conditional
level A from an unconditional one.

Both sides of that comparison are read at call time (the scope's root and
``workspace.installation()``), so the shapes the task names — the app's parent, a
sibling copy — are built as real paths rather than mocked, which is what keeps a
live level A and a dormant one tellable apart.

The last class is appdb-05's: the settings store and its WAL sidecars, hidden
from every file surface (D10). It runs against a scratch folder made "the app"
the same way, so the three names can be planted as real files — and as real
``git`` rows — without this checkout's own database being touched.
"""

import os
import subprocess
from pathlib import Path
from typing import Iterator, List, Optional, Tuple

import pytest
from fastapi.testclient import TestClient

from mcp_connectors import policy_shared as shared

from src.api.server import create_app
from src.core import appdb
from src.core import editorfs
from src.core.editorfs import builtin_policy
from src.core.editorfs import policy_file, policy_seed
from src.core.editorfs import policy_modes
from tests.conftest import WorkspaceClient, make_the_install, scoped

APP_ROOT = os.path.realpath(str(editorfs.constants.PROJECT_ROOT))

#: The store and its two WAL sidecars, as workspace-relative names — built from
#: ``appdb``'s own constants so a rename of the store moves every assertion
#: below with it (the same reasoning ``tests/test_store_hermeticity.py`` gives
#: for the guard's tuple).
STORE_NAMES: List[str] = [appdb.DB_FILENAME] + [
    f"{appdb.DB_FILENAME}{suffix}" for suffix in appdb.WAL_SIDECAR_SUFFIXES
]

#: The level-A pattern that hides them, spelled the way the rule spells it.
STORE_RULE_PATTERN = f"**/{appdb.DB_FILENAME}*"


@pytest.fixture
def app_workspace() -> "Iterator[Path]":
    """The workspace *is* this installation — level A is live.

    clws-10: the workspace is the request scope, not an environment value, so the
    fixture enters the installation's scope for the test's duration.
    """
    with scoped(APP_ROOT):
        yield Path(APP_ROOT)


@pytest.fixture
def foreign_workspace(tmp_path: Path) -> "Iterator[Path]":
    """The workspace is somewhere else — level A is dormant."""
    with scoped(tmp_path):
        yield tmp_path


def _root_names(client: TestClient) -> List[str]:
    """The root listing's entry names — the tree half of the D8 pair."""
    return [
        entry["name"] for entry in client.get("/api/fs/tree").json()["entries"]
    ]


def copy_of_the_repo(root: Path) -> Path:
    """A directory that looks like the app, somewhere else.

    The comparison is on paths, not contents, so the stand-in needs the app's
    *shape* rather than its weight: the same leaf name, and the names level A is
    written about inside it. A rule that had been left unconditional — or written
    as a basename or prefix test — would find ``.env`` hidden here as well.
    """
    (root / "src" / "core").mkdir(parents=True)
    (root / ".env").write_text("ENDPOINT=x\n", encoding="utf-8")
    (root / "logs" / "trash").mkdir(parents=True)
    (root / "web" / "dist").mkdir(parents=True)
    return root


class TestIsSelfWorkspace:
    def test_the_install_directory_itself_is_self(self, app_workspace):
        assert builtin_policy.is_self_workspace() is True

    @pytest.mark.requires_symlink(
        "is_self_workspace compares realpaths, so a working location spelled "
        "through a link to the install tree is still the app itself"
    )
    def test_a_symlinked_location_for_the_same_tree_is_still_self(
        self, tmp_path: Path, monkeypatch
    ):
        """The location may be spelled through a link; both sides resolve.

        This is why the comparison uses ``workspace_root()`` (a ``realpath``)
        rather than the raw environment value."""
        link = tmp_path / "nojae-via-link"
        link.symlink_to(APP_ROOT, target_is_directory=True)
        with scoped(link):
            assert builtin_policy.is_self_workspace() is True

    @pytest.mark.parametrize("which", ["parent", "copy", "near", "tmp"])
    def test_everything_else_is_not_self(
        self, which: str, monkeypatch, tmp_path: Path
    ):
        """Exact, not a prefix — and not merely because the path is far away."""
        candidates: List[Tuple[str, Optional[Path]]] = [
            ("parent", Path(APP_ROOT).parent),
            ("copy", copy_of_the_repo(tmp_path / "nojae-copy")),
            # A directory *inside* the app is not the app either: the comparison
            # is equality, so the parent rule cannot leak into a sub-folder.
            ("near", Path(APP_ROOT) / "src"),
            ("tmp", tmp_path),
        ]
        location = dict(candidates)[which]
        assert location is not None
        with scoped(location):
            assert builtin_policy.is_self_workspace() is False

    def test_the_installations_own_scope_is_self(self):
        """A tab rooted at the installation is the app; no environment decides it."""
        from src.core import workspace

        with scoped(workspace.installation()):
            assert builtin_policy.is_self_workspace() is True


class TestSelfWorkspaceRules:
    """The rules that only apply while nojae edits itself."""

    @pytest.mark.parametrize(
        "rel,pattern",
        [
            (".env", "**/.env**"),
            (".env.test", "**/.env**"),
            (".env.example", "**/.env**"),
            ("src/.env", "**/.env**"),
            ("web/.env.local", "**/.env**"),
            ("logs/trash/a/b.txt", "logs/**"),
            ("logs/editor_backups/x.orig", "logs/**"),
            ("web/dist/index.html", "web/dist/**"),
            ("web/dist/assets/app.js", "web/dist/**"),
            (appdb.DB_FILENAME, STORE_RULE_PATTERN),
            (f"{appdb.DB_FILENAME}{appdb.WAL_SIDECAR_SUFFIXES[0]}",
             STORE_RULE_PATTERN),
            (f"{appdb.DB_FILENAME}{appdb.WAL_SIDECAR_SUFFIXES[1]}",
             STORE_RULE_PATTERN),
        ],
    )
    def test_an_app_owned_path_carries_its_rule_verbatim(
        self, app_workspace, rel: str, pattern: str
    ):
        verdict = policy_modes.mode_for(rel)
        assert verdict.level == shared.LEVEL_BUILTIN
        assert verdict.pattern == pattern

    @pytest.mark.parametrize(
        "rel,mode",
        [
            (".env", shared.HIDDEN),
            (".env.test", shared.HIDDEN),
            ("web/.env.local", shared.HIDDEN),
            ("logs/trash/x", shared.HIDDEN),
            ("web/dist/index.html", shared.READ_ONLY),
            (appdb.DB_FILENAME, shared.HIDDEN),
            (f"{appdb.DB_FILENAME}{appdb.WAL_SIDECAR_SUFFIXES[0]}", shared.HIDDEN),
            (f"{appdb.DB_FILENAME}{appdb.WAL_SIDECAR_SUFFIXES[1]}", shared.HIDDEN),
        ],
    )
    def test_the_mode_each_rule_gives(self, app_workspace, rel: str, mode: str):
        assert policy_modes.mode_for(rel).mode == mode

    def test_the_reason_is_the_authors_own_sentence(self, app_workspace):
        verdict = policy_modes.mode_for(".env")
        assert verdict.reason
        message = policy_modes.refusal_message(verdict, for_write=True)
        assert "nojae's own rules for this workspace" in message
        assert verdict.reason in message

    def test_the_store_rule_says_what_the_store_holds(self, app_workspace):
        """D10's reason, spelled the way the other rules spell theirs.

        The sentence is the one the spec dictates, because a refusal that only
        says "hidden" sends the reader to a file they cannot edit for an answer
        they cannot use: the store holds the model credentials, and the app is
        its only editor.
        """
        verdict = policy_modes.mode_for(appdb.DB_FILENAME)
        assert verdict.reason == (
            "nojaé's own settings store, which holds the model credentials"
        )
        message = policy_modes.refusal_message(verdict, for_write=True)
        assert "nojae's own rules for this workspace" in message
        assert verdict.reason in message

    def test_the_sidecars_are_the_stores_own_names_not_a_suffix_rule(
        self, app_workspace
    ):
        """The trailing ``*`` reaches ``-wal``/``-shm``; a ``.db`` rule would not.

        The sidecars hold committed bytes and the write-ahead index, so hiding
        the main file alone would leave a reader one ``stat`` away from the
        store's contents. And the rule is a *name*, so an unrelated database of
        the same extension is untouched — the same argument the connector floor
        makes for listing the three names instead of a ``.db`` suffix.
        """
        for name in STORE_NAMES:
            assert policy_modes.mode_for(name).pattern == STORE_RULE_PATTERN, name
        for rel in ("app.db", "data.sqlite", "notesdb", "backup/app.db"):
            assert policy_modes.mode_for(rel).mode == shared.READ_WRITE, rel
        # The prefix shape, kept on purpose exactly as ``.env**`` keeps it: a
        # name that *starts* with the store's name is one of them, so a stray
        # ``nojae.db.journal`` cannot be read while the real file cannot.
        assert policy_modes.mode_for("nojae.db.bak").mode == shared.HIDDEN

    @pytest.mark.parametrize("rel", ["notes.env", "src/environment.py", "a/env/x"])
    def test_a_name_only_shaped_like_env_is_not_app_owned(self, app_workspace, rel: str):
        """``.env`` is a name, not a substring — and nothing here hides ``logs``
        in someone else's tree, so an unrelated ``.env``-ish file is left alone."""
        assert policy_modes.mode_for(rel) == shared.Verdict(
            shared.READ_WRITE, None, None, None
        )

    @pytest.mark.parametrize("rel", [".environment", "src/.envsh", "a/.envrc/x"])
    def test_a_name_starting_with_the_letters_env_is_taken_as_one_of_them(
        self, app_workspace, rel: str
    ):
        """The prefix shape, kept on purpose: today's floor is
        ``name.startswith(".env")`` (``path_policy.py:73``), so ``.envrc`` is
        already refused. ``.env**`` says the same thing in the pattern language —
        the ``**`` is the subtree rule, not a separator."""
        assert policy_modes.mode_for(rel).mode == shared.HIDDEN

    def test_an_extension_sounding_env_file_is_not_app_owned(self, app_workspace):
        """What the prefix does *not* reach: a name that only ends in ``.env``."""
        assert policy_modes.mode_for("notes.env").mode == shared.READ_WRITE

    def test_the_rules_apply_to_the_folder_they_name(self, app_workspace):
        """``logs`` itself, not only what is under it — the app owns the folder."""
        assert policy_modes.mode_for("logs").mode == shared.HIDDEN
        assert policy_modes.mode_for("web/dist").mode == shared.READ_ONLY

    def test_there_is_no_git_rule_at_this_level(self, app_workspace):
        """D6: ``.git`` is a workspace-policy concern, present in every seeded
        file — not an app rule. Level A is about files *this app writes*."""
        assert not any(".git" in rule[0] for rule in builtin_policy.BUILTIN_RULES)
        assert builtin_policy.builtin_rules(".git/config") == []

    def test_a_git_rule_arrives_from_the_seeded_file_not_from_here(
        self, app_workspace
    ):
        """The other half of D6, and what pol-05 made observable.

        ``.git`` is hidden in this workspace — but by level B, the seeded file,
        not by code. A test that only asserted "level A says nothing" would pass
        even if the workspace had no policy at all, so the winning level is
        named: if a ``.git`` rule ever moves into ``BUILTIN_RULES`` (making it
        unconfigurable, which D6 forbids), the level changes and this fails.
        """
        assert policy_seed.ensure_policy_file(APP_ROOT)["state"] in (
            "created",
            "existing",
        )
        policy_file.invalidate_policy_cache()
        verdict = policy_modes.mode_for(".git/config")
        assert verdict.mode == shared.HIDDEN
        assert verdict.level == shared.LEVEL_WORKSPACE
        assert verdict.pattern == ".git"

    def test_level_a_is_narrow(self, app_workspace):
        assert policy_modes.mode_for("src/config.py").mode == shared.READ_WRITE

    def test_the_old_helpers_path_is_ordinary_here_too(self, app_workspace):
        """The behaviour change this task makes (D7), on nojae's own tree.

        It used to be ``ro``: browsable, and refused writes. Now no level-A rule
        mentions it at all, because what protects the helpers is the **reserved
        folder** the file moved into, not a pattern for one name. A leftover copy
        of the old path is therefore an ordinary file (the app never reads it
        again, and removing it is the user's own business).
        """
        old = "resources/memory_registration.json"
        verdict = policy_modes.mode_for(old)
        assert verdict.mode == shared.READ_WRITE
        assert verdict.level is None
        assert builtin_policy.builtin_rules(old) == []


class TestForeignWorkspace:
    """The point of the task: another project's files are its own."""

    @pytest.mark.parametrize("rel", [".env", ".env.test", "src/.env.local"])
    def test_a_foreign_env_is_an_ordinary_file(self, foreign_workspace, rel: str):
        verdict = policy_modes.mode_for(rel)
        assert verdict == shared.Verdict(shared.READ_WRITE, None, None, None)
        assert builtin_policy.builtin_rules(rel) == []

    @pytest.mark.parametrize("rel", ["logs/x", "web/dist/app.js"])
    def test_a_foreign_folder_of_the_same_name_is_ordinary(
        self, foreign_workspace, rel: str
    ):
        assert policy_modes.mode_for(rel).mode == shared.READ_WRITE

    @pytest.mark.parametrize("rel", STORE_NAMES)
    def test_a_foreign_database_of_the_same_name_is_an_ordinary_file(
        self, foreign_workspace, rel: str
    ):
        """D10's negative half: the rule is about *whose* file it is.

        A project that happens to keep a SQLite file called ``nojae.db`` — or a
        copy of this repo this process did not boot from — has no reason for the
        pane to hide it, so the verdict is the ordinary one and level A
        contributes no rule at all. This is the row that fails the moment the
        rule is made unconditional or moved into the seeded policy.
        """
        verdict = policy_modes.mode_for(rel)
        assert verdict == shared.Verdict(shared.READ_WRITE, None, None, None), rel
        assert builtin_policy.builtin_rules(rel) == [], rel

    def test_the_app_owned_names_are_ordinary_too(self, foreign_workspace):
        """``resources/memory_registration.json`` is the *old* app file: here it
        is a stale leftover of somebody else's tree, so nothing about it is a
        built-in verdict. The prompt helpers moved into the reserved folder,
        which level A answers in **every** workspace (D7)."""
        for rel in ("resources/memory_registration.json", "web/dist"):
            assert policy_modes.mode_for(rel).level != shared.LEVEL_BUILTIN
        assert (
            policy_modes.mode_for("resources/memory_registration.json").mode
            == shared.READ_WRITE
        )

    def test_the_prompt_helpers_file_is_hidden_in_a_foreign_workspace(
        self, foreign_workspace
    ):
        """The reservation is unconditional, so a leftover helper file is hidden.

        D7's rule, and appdb-07 leaves it standing: the app neither seeds nor
        reads ``.nojae/prompt-helpers.json`` any more, but a workspace opened
        before the move still has the file, and it is a name inside the reserved
        folder — so it is invisible there exactly as it is in nojae's own tree.
        The name is spelled here rather than taken from a module, because no
        module owns it any more.
        """
        verdict = policy_modes.mode_for(".nojae/prompt-helpers.json")
        assert verdict.mode == shared.HIDDEN
        assert verdict.level == shared.LEVEL_BUILTIN
        assert verdict.reason == builtin_policy.reserved_reason()

    def test_a_copy_of_the_repo_is_not_the_app(self, tmp_path: Path, monkeypatch):
        """The same file names, in a checkout this process did not boot from:
        dormant. The failing test if level A ever moves back to unconditional."""
        copy = copy_of_the_repo(tmp_path / "nojae-copy")
        with scoped(copy):
            assert builtin_policy.is_self_workspace() is False
            for rel in (".env", "logs/trash/x", "web/dist/index.html"):
                assert policy_modes.mode_for(rel).mode == shared.READ_WRITE


class TestReservedFolderIsUnconditional:
    """The one level-A rule that does not care which workspace this is (D5)."""

    PATHS = [
        ".nojae",
        ".nojae/read-write-policy.json",
        "a/.nojae/b",
        "src/deep/.nojae/x/y",
    ]

    @pytest.mark.parametrize("workspace", ["app_workspace", "foreign_workspace"])
    @pytest.mark.parametrize("rel", PATHS)
    def test_hidden_in_every_workspace(self, workspace: str, rel: str, request):
        request.getfixturevalue(workspace)
        verdict = policy_modes.mode_for(rel)
        assert verdict.mode == shared.HIDDEN
        assert verdict.level == shared.LEVEL_BUILTIN
        assert verdict.pattern == editorfs.constants.POLICY_DIRNAME

    @pytest.mark.parametrize("rel", [".nojaeer", "nojae/x", "x.nojae/y"])
    def test_a_name_only_similar_to_it_is_untouched(self, rel: str, foreign_workspace):
        assert policy_modes.mode_for(rel).mode == shared.READ_WRITE

    def test_it_holds_without_a_policy_file_on_disk(self, foreign_workspace: Path):
        """The answer is about the name, so an absent folder is still hidden —
        and ``mode_for`` never asks whether the file loaded."""
        assert not (foreign_workspace / ".nojae").exists()
        assert policy_modes.mode_for(".nojae/x").mode == shared.HIDDEN

    def test_the_reserved_name_is_patchable_through_constants(
        self, foreign_workspace, monkeypatch: pytest.MonkeyPatch
    ):
        monkeypatch.setattr(editorfs.constants, "POLICY_DIRNAME", ".policydir")
        assert policy_modes.mode_for(".policydir/x").mode == shared.HIDDEN
        assert policy_modes.mode_for(".nojae/x").mode == shared.READ_WRITE

    def test_a_looser_workspace_rule_cannot_lift_it(
        self, foreign_workspace, monkeypatch: pytest.MonkeyPatch
    ):
        """D5 through the merge: a ``rw`` rule for the reserved folder loses to
        the unconditional ``hidden``, whatever its level or order."""
        monkeypatch.setattr(
            policy_modes,
            "list_workspace_rules",
            lambda rel, *, fold=False: [
                shared.Rule(
                    mode=shared.READ_WRITE,
                    pattern=".nojae",
                    reason=None,
                    index=99,
                    level=shared.LEVEL_WORKSPACE,
                )
            ],
        )
        verdict = policy_modes.mode_for(".nojae/read-write-policy.json")
        assert verdict.mode == shared.HIDDEN
        assert verdict.level == shared.LEVEL_BUILTIN
        assert verdict.pattern == ".nojae"


class TestRulesAreWrittenInThePatternLanguage:
    """The list itself: order, spelling and the shape of each entry."""

    def test_it_is_a_tuple_of_pattern_mode_reason_triples(self):
        assert isinstance(builtin_policy.BUILTIN_RULES, tuple)
        for rule in builtin_policy.BUILTIN_RULES:
            assert isinstance(rule, tuple) and len(rule) == 3
            pattern, mode, reason = rule
            assert isinstance(pattern, str) and pattern
            assert mode in shared.MODES
            assert isinstance(reason, str) and reason.strip()

    def test_the_index_that_merges_them_is_their_position(self, app_workspace):
        # ``app_workspace`` because level A exists only while the working
        # location *is* the install: with the location elsewhere the list is
        # empty by design, and the index below would be a fact about nothing.
        assert [rule.index for rule in builtin_policy.builtin_rules(".env")] == [0]
        matched = [
            rule.pattern for rule in builtin_policy.builtin_rules(".env")
        ]
        assert matched == [builtin_policy.BUILTIN_RULES[0][0]]

    def test_no_rule_is_a_pattern_the_matcher_rejects(self):
        from mcp_connectors import policy_glob

        for pattern, _, _ in builtin_policy.BUILTIN_RULES:
            assert policy_glob.pattern_error(pattern) is None, pattern

    def test_no_rule_names_the_reserved_folder(self):
        reserved = editorfs.constants.POLICY_DIRNAME
        for pattern, _, _ in builtin_policy.BUILTIN_RULES:
            assert reserved not in pattern.split("/")


class TestTheVerdictIsWhatTheRoutesNowAnswerWith:
    """pol-06 landed: the predicates this class used to compare against are gone.

    What remains worth pinning is the same split, stated against the **routes**
    rather than against two booleans that no longer exist: on the app's own repo
    the pane answers with the verdict, and the paths that used to be refused by
    the connector floor instead of by level A are the interesting ones — some of
    them opened on purpose (this task's visible change), and the ones that stayed
    closed did so because a rule says so, not because code does.
    """

    # Ordinary files of this checkout: unchanged, and listed, and writable.
    ORDINARY: List[str] = [
        "src/config.py",
        "src/core/editorfs/policy.py",
        "tests/test_api.py",
        "src/core/models.py",
    ]

    @pytest.fixture
    def route_client(self, app_workspace: Path):
        """A client bound to the installation workspace this class asserts about."""
        from contextlib import contextmanager

        @contextmanager
        def make():
            with TestClient(create_app()) as http:
                yield WorkspaceClient(http, app_workspace)

        return make

    @pytest.mark.parametrize("rel", ORDINARY)
    def test_an_ordinary_path_of_the_app_is_still_an_ordinary_file(
        self, app_workspace, route_client, rel: str
    ):
        """The refactor's cost, checked: nothing that was editable got locked."""
        assert policy_modes.mode_for(rel).mode == shared.READ_WRITE
        with route_client() as client:
            body = client.get("/api/fs/file", params={"path": rel})
            assert body.status_code == 200, rel
            listed = client.get("/api/fs/tree").json()
            assert rel.split("/")[0] in [
                entry["name"] for entry in listed["entries"]
            ], rel

    # Level A's rows, now live at the routes: hidden answers a look with absence
    # (404) and a touch with the rule (422).
    @pytest.mark.parametrize(
        "rel,pattern",
        [
            (".env", "**/.env**"),
            (".env.test", "**/.env**"),
            (".env.example", "**/.env**"),
            ("logs/trash/x", "logs/**"),
            ("logs/editor_backups/y", "logs/**"),
        ],
    )
    def test_an_app_owned_path_is_absent_to_a_read_and_named_to_a_write(
        self, app_workspace, route_client, rel: str, pattern: str
    ):
        """The D8 asymmetry, on nojae's own workspace, at the routes."""
        with route_client() as client:
            read = client.get("/api/fs/file", params={"path": rel})
            assert read.status_code == 404, rel
            assert pattern not in read.text
            if "/" not in rel:
                assert rel not in _root_names(client), rel

            write = client.put(
                "/api/fs/file", json={"path": rel, "text": "overwritten\n"}
            )
            assert write.status_code == 422, rel
            detail = write.json()["detail"]
            assert f'"{pattern}"' in detail, rel
            assert "nojae's own rules" in detail, rel

    def test_the_prompt_helpers_file_is_absent_to_a_read_and_named_to_a_write(
        self, app_workspace, route_client
    ):
        """The reservation at the routes, on the file the app no longer owns.

        D7's rule, kept by appdb-07 for the state a real tree can still be in: a
        workspace opened before the helpers moved into the store still holds
        ``.nojae/prompt-helpers.json``, and the app neither seeds nor reads it —
        so the only thing that can happen to it is the reservation's verdict.

        This is deliberately not another row of the list above: that list asserts
        the matched *pattern* is quoted in the 422 and never appears in the 404,
        and neither holds for a reserved path. The 422 quotes the folder name
        (``.nojae``), and the 404 is the ordinary absence sentence, which echoes
        the requested path — so a hidden name inside a reserved folder is
        indistinguishable from absence all the same, exactly as
        ``tests/test_editorfs_write.py`` pins for a batch under ``.nojae/trash``.
        """
        rel = ".nojae/prompt-helpers.json"
        reserved = '".nojae"'
        with route_client() as client:
            read = client.get("/api/fs/file", params={"path": rel})
            assert read.status_code == 404
            assert "does not exist" in read.json()["detail"]
            assert ".nojae" not in _root_names(client)

            write = client.put(
                "/api/fs/file", json={"path": rel, "text": "hand-edited\n"}
            )
            assert write.status_code == 422
            detail = write.json()["detail"]
            assert reserved in detail
            assert "nojae's own rules" in detail
            assert "reserved by nojae" in detail

    @pytest.mark.parametrize("rel", ["web/dist/index.html"])
    def test_an_app_owned_build_or_data_file_is_readable_and_locked_from_writes(
        self, app_workspace, route_client, rel: str
    ):
        """``ro`` at the routes: the tree and the read keep working, the save does not."""
        verdict = policy_modes.mode_for(rel)
        assert verdict.level == shared.LEVEL_BUILTIN
        assert verdict.mode == shared.READ_ONLY
        with route_client() as client:
            assert client.get("/api/fs/file", params={"path": rel}).status_code == 200
            write = client.put(
                "/api/fs/file", json={"path": rel, "text": "hand-edited\n"}
            )
            assert write.status_code == 422
            assert "nojae's own rules" in write.json()["detail"]

    @pytest.mark.parametrize(
        "rel", [".git/config", ".ssh/id_rsa", "web/src/id_rsa", "secrets/aws.pem"]
    )
    def test_what_the_connector_floor_used_to_close_is_now_a_workspaces_business(
        self, app_workspace, rel: str
    ):
        """The listed deltas, restated now that the swap has happened.

        These four names were refused by the deny-list and are *not* level-A
        rules: ``.git`` is D6's workspace concern, arriving from the seeded file,
        and the credential names belong to the connector floor, which guards its
        own surface and is not what level A is for. So the pane's answer comes
        from a rule a user can read and change — and pol-08 is what layers the
        connector floor back on top for the agents.
        """
        verdict = policy_modes.mode_for(rel)
        assert verdict.level != shared.LEVEL_BUILTIN, rel
        assert verdict.level == shared.LEVEL_WORKSPACE or verdict.mode == shared.READ_WRITE

    def test_the_apps_own_env_is_no_longer_refused_by_a_code_list(
        self, app_workspace, route_client
    ):
        """The inversion this task exists to make visible.

        Before pol-06, the app's ``.env`` was closed by a hardcoded ``.env``
        prefix check that closed every other project's ``.env`` with it. Now the
        refusal is level A's rule — conditional on this workspace *being* the app,
        quoted by name when it fires, and loosened to a normal file the moment
        the location points elsewhere.

        ``app_workspace`` states that condition instead of inheriting it: the
        suite's autouse guard gives every test a throw-away working location (so
        no test can read the developer's ``.nojae/nojae-settings.json``), and this
        assertion is about the workspace *being* the install — the fact the file's
        own fixture exists to declare.
        """
        with route_client() as client:
            read = client.get("/api/fs/file", params={"path": ".env"})
        assert read.status_code == 404
        assert "connector path policy" not in read.text
        verdict = policy_modes.mode_for(".env")
        assert verdict.level == shared.LEVEL_BUILTIN
        assert policy_modes.refusal_message(verdict, for_write=True)


def _git(repo: Path, *args: str) -> str:
    """One hermetic git command in ``repo`` (the ``test_editorfs_git.py`` form).

    The global/system config is ignored and the identity comes from the
    environment, so a developer's ``~/.gitconfig`` cannot change what a row
    here asserts.
    """
    env = {
        **os.environ,
        "GIT_CONFIG_GLOBAL": os.devnull,
        "GIT_CONFIG_SYSTEM": os.devnull,
        "GIT_AUTHOR_NAME": "test",
        "GIT_AUTHOR_EMAIL": "test@example.invalid",
        "GIT_COMMITTER_NAME": "test",
        "GIT_COMMITTER_EMAIL": "test@example.invalid",
    }
    proc = subprocess.run(
        ["git", *args], cwd=repo, env=env,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    assert proc.returncode == 0, f"git {' '.join(args)}: {proc.stderr.decode()}"
    return proc.stdout.decode()


class TestTheStoreIsInvisibleToEveryFileSurface:
    """D10 as a test rather than a sentence: the store answers *absence*.

    The workspace is a scratch folder made "the app" by moving both sides of
    :func:`builtin_policy.is_self_workspace` (the repo's own ``app_like``
    pattern), so the three names can be planted as real files — including a
    dirty git row — without touching this checkout's own database. Every
    surface the task names is asserted here: the tree, the read, the search,
    ``git status``, and a write attempt, which must be **named** to refusal
    rather than silently absent (pol-00 D8's asymmetry).
    """

    @pytest.fixture
    def app_like(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
        """A scratch *repository* that is also "the install", holding the store."""
        root = tmp_path / "app"
        root.mkdir()
        # Text, not the real binary: the search's binary sniff would hide these
        # rows on its own, and the assertion is about the *policy* filter.
        for name in STORE_NAMES:
            (root / name).write_text("sqlite format marker\n", encoding="utf-8")
        (root / "keep.py").write_text("needle here\n", encoding="utf-8")
        make_the_install(monkeypatch, root)
        policy_file.invalidate_policy_cache()
        with scoped(root):
            assert builtin_policy.is_self_workspace() is True
            yield root

    @pytest.fixture
    def repo(self, app_like: Path) -> Path:
        """The same folder as a committed repository, so status has rows to hide."""
        _git(app_like, "init", "-q")
        _git(app_like, "add", "keep.py")
        _git(app_like, "commit", "-qm", "seed")
        return app_like

    @pytest.fixture
    def client(self, repo: Path):
        with TestClient(create_app()) as test_client:
            yield WorkspaceClient(test_client, repo)

    @pytest.mark.parametrize("name", STORE_NAMES)
    def test_the_tree_does_not_list_it(self, repo: Path, client, name: str):
        assert name not in _root_names(client)

    @pytest.mark.parametrize("name", STORE_NAMES)
    def test_a_read_answers_absence_without_naming_the_rule(
        self, repo: Path, client, name: str
    ):
        response = client.get("/api/fs/file", params={"path": name})
        assert response.status_code == 404, name
        assert STORE_RULE_PATTERN not in response.text, name

    @pytest.mark.parametrize("name", STORE_NAMES)
    def test_a_write_is_refused_and_names_the_rule(self, repo: Path, client, name: str):
        response = client.put(
            "/api/fs/file", json={"path": name, "text": "overwritten\n"}
        )
        assert response.status_code == 422, name
        detail = response.json()["detail"]
        assert f'"{STORE_RULE_PATTERN}"' in detail, name
        assert "nojae's own rules" in detail, name
        assert "settings store" in detail, name

    @pytest.mark.parametrize("name", STORE_NAMES)
    def test_creating_over_it_is_refused_the_same_way(
        self, repo: Path, client, name: str
    ):
        """A create asks the whole chain, so the leaf's rule fires there too."""
        response = client.post("/api/fs/create", json={"path": name, "dir": False})
        assert response.status_code == 422, name
        assert f'"{STORE_RULE_PATTERN}"' in response.json()["detail"], name

    def test_the_search_never_opens_it_and_never_names_it(
        self, repo: Path, client
    ):
        """The store's bytes are not a match row, and its name is not a scope.

        The planted sidecar contents include a needle the same scan finds in
        ``keep.py``, so an empty row list is the policy and not a broken scan.
        """
        found = client.get("/api/fs/search", params={"q": "sqlite format"})
        assert found.status_code == 200
        assert [row["path"] for row in found.json()["matches"]] == []
        scanned = client.get("/api/fs/search", params={"q": "needle"})
        assert [row["path"] for row in scanned.json()["matches"]] == ["keep.py"]
        for name in STORE_NAMES:
            scope = client.get("/api/fs/search", params={"path": name, "q": "sqlite"})
            assert scope.status_code == 404, name
            body = scope.json()["detail"]
            assert STORE_RULE_PATTERN not in body, name

    def test_git_status_lists_no_row_for_it(self, repo: Path, client):
        """The status list may never name a file the tree refuses to show.

        The three names are *untracked* here, which is exactly the shape a
        ``.gitignore`` miss would leave in the real checkout — so the row's
        absence is the policy filter doing its job, and ``keep.py``'s presence
        (modified, unstaged) proves the query itself is alive.
        """
        (repo / "keep.py").write_text("needle here\nchanged\n", encoding="utf-8")
        paths = [entry["path"] for entry in client.get("/api/fs/status").json()["entries"]]
        assert paths == ["keep.py"]

    def test_the_install_ignores_the_store_in_source_control(self):
        """The other half of "absent from git status" in the real checkout.

        The policy filter hides a row from *this app's* status endpoint; only a
        ``.gitignore`` entry keeps ``git status`` on the command line quiet, and
        the app creates the file in a checkout someone may commit from. Asserted
        as text (the ``.nojae/`` check's style) rather than by running git here,
        so the test does not depend on this checkout's own dirty state.
        """
        lines = [
            line.strip()
            for line in (
                Path(editorfs.constants.PROJECT_ROOT) / ".gitignore"
            ).read_text(encoding="utf-8").splitlines()
        ]
        for name in STORE_NAMES:
            assert name in lines, name

    def test_the_foreign_folder_of_the_same_names_is_an_ordinary_triple(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """The negative case, at the same surfaces.

        One tree, one set of files, one difference: ``PROJECT_ROOT`` stays where
        the real install is, so this workspace is *not* the app. All three names
        are listed, readable, searchable, and get their ``git status`` rows —
        the failing test if the rule ever becomes unconditional.
        """
        foreign = tmp_path / "someone-elses-project"
        foreign.mkdir()
        for name in STORE_NAMES:
            (foreign / name).write_text("sqlite format marker\n", encoding="utf-8")
        (foreign / "keep.py").write_text("needle here\n", encoding="utf-8")
        policy_file.invalidate_policy_cache()
        with scoped(foreign):
            assert builtin_policy.is_self_workspace() is False
        _git(foreign, "init", "-q")
        _git(foreign, "add", "keep.py")
        _git(foreign, "commit", "-qm", "seed")

        with TestClient(create_app()) as http:
            client = WorkspaceClient(http, foreign)
            names = _root_names(client)
            for name in STORE_NAMES:
                assert name in names, name
                assert client.get(
                    "/api/fs/file", params={"path": name}
                ).status_code == 200, name
            assert [
                row["path"]
                for row in client.get(
                    "/api/fs/search", params={"q": "sqlite format"}
                ).json()["matches"]
            ] == sorted(STORE_NAMES)
            rows = sorted(
                entry["path"] for entry in client.get("/api/fs/status").json()["entries"]
            )
            # ``keep.py`` is committed and clean, so its absence from the rows
            # says nothing; the three names being *present* is the assertion.
            assert rows == sorted(STORE_NAMES)
