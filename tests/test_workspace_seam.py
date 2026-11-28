"""The seam, as the invariant the rest of the lot leans on (clws-01).

Three things are asserted here, each one a way the seam could rot into a
comment:

* **one owner of "which folder"** — a source scan over ``src/core/**`` and
  ``src/api/**`` (plus ``src/config.py``) asserting the retired process-wide
  accessor ``path_location`` is **absent entirely**. The interim fallback is
  gone (clws-10), so the name has no owner and no allowance: a second reader is
  exactly the drift this scan refuses.
* **one sentence per wrong folder** — :func:`src.core.workspace.resolve` is the
  only builder of the refusals, and the route that refuses a workspace says the
  same words (spec §5.2 rule 10). A folder that is missing, relative, a file, or
  on the restricted-roots deny-list is refused the same way wherever it is asked
  about, and the refusal names the folder and the rule — never what it declined
  to look at (rule 11).
* **the field is the folder** — ``GET /api/workspace`` answers about the folder
  the request names, proven with two folders side by side whose reserved files
  differ, and the **installation-scoped** routes keep answering when the folder
  they are handed is garbage (spec §4.2: the catalogue is the install's, and a
  tab whose folder vanished must still be able to configure itself).

The scan is written the way ``tests/test_write_surface_isolation.py`` writes its
own — one walker, shared by the guard and by its self-check, plus a poisoned
module planted in a temporary tree — because a guard that cannot fail is not a
guard.

Every folder named here is a ``tmp_path`` one. Nothing opens the install's
settings store, reaches a live hub, or reads a real model connection.
"""

import ast
import contextlib
import os
import re
from pathlib import Path
from typing import Any, Dict, Iterable, Iterator, List, Optional, Tuple

import pytest
from fastapi.testclient import TestClient

from src import config as config_module
from src.api import routes
from src.api.routes import chat as api_chat
from src.api.server import create_app
from src.core import workspace
from src.core import lsphub
from tests.conftest import workspace_params

REPO_ROOT = Path(config_module.PROJECT_ROOT).resolve()

#: The accessor that answered "which folder does this **process** hold" — the
#: question this lot retired. Matched on word boundaries, so the names that
#: legitimately survive (``provided_path_location`` and ``PATH_PLACEHOLDER``)
#: are not it: those name the *request's* workspace, a different question.
PROCESS_LOCATION_RE = re.compile(r"\bpath_location\b")

#: No module may name it any more (clws-10 deleted the fallback, its accessor
#: and the boot seed that wrote it). The empty tuple is the point, not an
#: oversight: the scan's other half is that a poisoned scratch module is caught.
PROCESS_LOCATION_ALLOWED: Tuple[Path, ...] = ()

#: The trees the scan walks. ``src/config.py`` is added per file rather than by
#: walking ``src``, so the scan's roots are exactly the surfaces the invariant
#: covers plus the one module that defines the accessor.
SCAN_ROOTS = ("src/core", "src/api")


def scan_roots() -> List[Path]:
    """The files the scan reads: every ``*.py`` under the two trees, plus config."""
    files: List[Path] = []
    for relative in SCAN_ROOTS:
        files.extend(
            path
            for path in sorted((REPO_ROOT / relative).rglob("*.py"))
            if "__pycache__" not in path.parts
        )
    files.append(REPO_ROOT / "src" / "config.py")
    return files


def routes_tree_source() -> str:
    """The text of every ``*.py`` under ``src/api``, sorted and joined.

    The seam's structural guards read the API this way rather than one module,
    so a registration is seen wherever it lives. The walk is the one
    :func:`scan_roots` uses.
    """
    files = sorted(
        path
        for path in (REPO_ROOT / "src" / "api").rglob("*.py")
        if "__pycache__" not in path.parts
    )
    return "\n".join(path.read_text(encoding="utf-8") for path in files)


def process_location_offenders(
    files: Iterable[Path], allowed: Tuple[Path, ...] = PROCESS_LOCATION_ALLOWED
) -> List[str]:
    """Every file in ``files`` naming the process-wide accessor, by repo path.

    One implementation, shared by the guard below and by its self-check — the
    same reason ``test_write_surface_isolation.offenders_for`` is shared: a second
    copy of the walk is how a guard drifts from what it guards.
    """
    found: List[str] = []
    for path in files:
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        if not PROCESS_LOCATION_RE.search(text):
            continue
        label = (
            str(path.relative_to(REPO_ROOT))
            if path.is_relative_to(REPO_ROOT)
            else str(path)
        )
        if Path(label) not in allowed:
            found.append(label)
    return found


def route_registrations(source_text: str) -> List[Dict[str, Any]]:
    """Every route the API router registers, as ``{"verb", "path", "handler"}``.

    Read out of the decorator call (``@router.get("/workspace")``) rather than
    matched as a substring, so what is judged is the *registration*: a docstring
    naming a route cannot trip a guard built on this, and a new route cannot hide
    from one. Only ``router``'s decorators count — the app's own ``/api/health``
    is registered on the ``FastAPI`` object and spells its path with the prefix
    already on it. Same shape as the helper of that name in
    ``tests/test_write_surface_isolation.py``.
    """
    found: List[Dict[str, Any]] = []
    for node in ast.walk(ast.parse(source_text)):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            call = decorator if isinstance(decorator, ast.Call) else None
            if call is None or not isinstance(call.func, ast.Attribute):
                continue
            if getattr(call.func.value, "id", None) != "router":
                continue
            if not call.args or not isinstance(call.args[0], ast.Constant):
                continue
            route_path = call.args[0].value
            if isinstance(route_path, str):
                found.append(
                    {"verb": call.func.attr, "path": route_path, "handler": node}
                )
    return found


# -- the scan ------------------------------------------------------------------


class TestNoPathResolvingSurfaceReadsTheProcessLocation:
    def test_only_the_seam_and_its_owner_name_the_accessor(self):
        offenders = process_location_offenders(scan_roots())
        assert offenders == [], (
            "a surface reads the process-wide working location instead of the "
            f"seam's scope: {offenders}"
        )

    def test_the_retired_accessor_is_absent_from_the_seam_and_its_owner(self):
        """The scan's other half after clws-10: there is no accessor left.

        An empty offender list is also what a scan that matches nothing
        produces, so the two modules that used to carry the name are asked
        directly: the seam must not read a process-wide location, and
        ``config.py`` must not define one. What survives is the placeholder
        ``PATH_PLACEHOLDER``, a different name for a different question.
        """
        for relative in ("src/core/workspace.py", "src/config.py"):
            text = (REPO_ROOT / relative).read_text(encoding="utf-8")
            assert not PROCESS_LOCATION_RE.search(text), relative
        assert config_module.PATH_PLACEHOLDER == "NOJAE_PATH_LOCATION"

    def test_the_retired_fallback_names_are_absent_from_src(self):
        """clws-10 deleted the fallback, not merely stopped calling it.

        ``path_location`` is covered by the word-boundary scan above (which must
        not flag the surviving ``provided_path_location``); these two names have
        no legitimate survivor at all, so they are asserted absent everywhere
        under ``src``. A docstring or a dead branch reintroducing either would
        be the second mechanism rule 12 forbids.
        """
        retired = re.compile(r"\b(?:WORKSPACE_ENV_FALLBACK|PATH_LOCATION_KEY)\b")
        offenders = [
            str(path.relative_to(REPO_ROOT))
            for path in sorted((REPO_ROOT / "src").rglob("*.py"))
            if "__pycache__" not in path.parts
            and retired.search(path.read_text(encoding="utf-8"))
        ]
        assert offenders == [], (
            f"a retired process-wide location name survived under src: {offenders}"
        )

    def test_the_scan_catches_a_poisoned_module(self, tmp_path: Path):
        """The guard's teeth, on a scratch tree: a second reader is caught."""
        fake = tmp_path / "core" / "cheeky.py"
        fake.parent.mkdir(parents=True)
        fake.write_text(
            "from src.config import path_location\n"
            "\n"
            "def root():  # a second site for the process-wide folder\n"
            "    return path_location()\n",
            encoding="utf-8",
        )
        assert process_location_offenders([fake], allowed=()) == [str(fake)]

    def test_the_scan_ignores_the_names_that_are_not_the_accessor(
        self, tmp_path: Path
    ):
        """The scan's own precision: a *different* question is not an offender.

        The retired ``default_path_location`` / ``setup_path_location`` pair and
        the payload helper were separate names, and the successor
        ``provided_path_location`` is one too. Had the pattern been a plain
        substring, the guard would have flagged them and someone would have
        widened the allow-list to make it green — which is how a guard stops
        guarding.
        """
        fake = tmp_path / "kept.py"
        fake.write_text(
            "from src.config import default_path_location, setup_path_location\n"
            "\n"
            "def _path_location_payload():\n"
            "    setup_path_location()\n"
            "    return default_path_location()\n",
            encoding="utf-8",
        )
        assert process_location_offenders([fake], allowed=()) == []


# -- resolve()'s refusals -------------------------------------------------------


@pytest.fixture
def hermetic_deny_list(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> Path:
    """A workspace-root deny-list this test owns, naming one scratch folder.

    The real ``restricted-paths.txt`` belongs to the machine, so the seam is asked
    about a list written here — the same redirect ``tests/test_api.py`` uses for
    the switch's own deny-list check.
    """
    denied = tmp_path / "denied-root"
    denied.mkdir()
    list_file = tmp_path / "restricted-paths.txt"
    list_file.write_text(f"{denied}\n", encoding="utf-8")
    monkeypatch.setattr(lsphub.constants, "LSP_RESTRICTED_PATHS", list_file)
    return denied


def refusal(raw: Optional[str]) -> str:
    """The sentence ``resolve`` answers for a value that is not a workspace.

    Fails the test when the value was **accepted**: every caller below is about
    a refusal, so an acceptance is not a missing sentence to assert on but the
    rule having stopped firing. Returning the text (rather than each case
    unpacking the pair and narrowing it itself) is what lets the assertions read
    as sentences about the sentence.
    """
    resolved, sentence = workspace.resolve(raw)
    assert resolved is None, f"{raw!r} was accepted as a workspace"
    assert sentence is not None, f"{raw!r} was refused without a sentence"
    return sentence


def accepted(raw: str) -> str:
    """The canonical root ``resolve`` answers for a value that is a workspace."""
    resolved, sentence = workspace.resolve(raw)
    assert sentence is None, f"{raw!r} was refused: {sentence}"
    assert resolved is not None
    return resolved.root


class TestResolveRefusals:
    """Each refusal names the folder and the rule, and answers no answer."""

    def test_an_empty_value_is_refused(self):
        assert refusal("") == workspace.EMPTY_REFUSAL

    def test_a_whitespace_value_is_refused_like_an_empty_one(self):
        assert refusal("   ") == workspace.EMPTY_REFUSAL

    def test_a_relative_value_is_refused(self):
        sentence = refusal("somewhere/relative")
        assert "absolute" in sentence
        assert "somewhere/relative" in sentence

    def test_a_file_is_refused_as_not_a_directory(self, tmp_path: Path):
        a_file = tmp_path / "not-a-folder.md"
        a_file.write_text("x\n", encoding="utf-8")
        sentence = refusal(str(a_file))
        assert "directory" in sentence
        assert str(a_file) in sentence

    def test_an_absent_folder_is_refused(self, tmp_path: Path):
        ghost = tmp_path / "ghost"
        sentence = refusal(str(ghost))
        assert "directory" in sentence
        assert str(ghost) in sentence

    def test_a_denied_folder_is_refused_and_names_the_entry(
        self, hermetic_deny_list: Path
    ):
        sentence = refusal(str(hermetic_deny_list))
        assert "deny-list" in sentence
        assert str(hermetic_deny_list) in sentence

    def test_a_folder_under_a_denied_folder_is_refused(
        self, hermetic_deny_list: Path
    ):
        inside = hermetic_deny_list / "project"
        inside.mkdir()
        assert "deny-list" in refusal(str(inside))

    def test_a_folder_beside_a_denied_one_is_accepted(
        self, hermetic_deny_list: Path, tmp_path: Path
    ):
        """The deny-list is a prefix rule, not a name rule: ``/a/bc`` is not ``/a/b``."""
        sibling = tmp_path / "denied-root-twin"
        sibling.mkdir()
        assert accepted(str(sibling)) == str(sibling)

    def test_a_home_reference_is_expanded(self, tmp_path: Path, monkeypatch):
        """``~`` is expanded before the absolute test, so a tab may name it."""
        monkeypatch.setenv("HOME", str(tmp_path))
        monkeypatch.setenv("USERPROFILE", str(tmp_path))
        project = tmp_path / "project"
        project.mkdir()
        assert accepted("~/project") == str(project)

    def test_a_symlinked_spelling_is_one_workspace(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ):
        """Two spellings of one folder are one workspace, and one cache key."""
        real = tmp_path / "real"
        real.mkdir()
        link = tmp_path / "link"
        try:
            link.symlink_to(real, target_is_directory=True)
        except OSError:
            pytest.skip("this platform will not let an unprivileged process symlink")
        assert accepted(str(link / ".")) == accepted(str(real)) == str(real)

    def test_the_refusal_never_narrates_the_refusal(self, tmp_path: Path):
        """Rule 11: the sentence is the folder and the rule, and nothing else."""
        sentence = refusal(str(tmp_path / "ghost"))
        assert "\n" not in sentence
        assert len(sentence) < 200


# -- the scope -----------------------------------------------------------------


class TestTheScope:
    def test_a_scope_answers_and_leaves_nothing_behind(self, tmp_path: Path):
        root = tmp_path / "a"
        root.mkdir()
        assert workspace.current_root() != str(root)
        with workspace.scope(str(root)) as entered:
            assert workspace.current_root() == str(root)
            assert workspace.current_workspace() == entered
        assert workspace.current_root() != str(root)

    def test_nested_scopes_restore_the_outer_answer(self, tmp_path: Path):
        outer, inner = tmp_path / "outer", tmp_path / "inner"
        outer.mkdir()
        inner.mkdir()
        with workspace.scope(str(outer)):
            with workspace.scope(str(inner)):
                assert workspace.current_root() == str(inner)
            assert workspace.current_root() == str(outer)

    def test_an_exception_inside_a_scope_clears_it(self, tmp_path: Path):
        root = tmp_path / "raised"
        root.mkdir()
        before = workspace.current_root()
        with pytest.raises(ZeroDivisionError):
            with workspace.scope(str(root)):
                raise ZeroDivisionError("a route that failed")
        assert workspace.current_root() == before

    def test_outside_a_scope_no_answer_is_an_error(self):
        """Rule 12, as the seam implements it: no default folder, ever.

        A bare context has no value for the seam's ``ContextVar``, which is
        the honest "nobody said which workspace" state. The suite's autouse
        fixture normally keeps a scope open, so this must not rely on the
        fixture's own context to observe the refusal.
        """
        import contextvars

        with pytest.raises(workspace.WorkspaceNotScoped):
            contextvars.Context().run(workspace.current_root)

    def test_a_thread_started_inside_a_scope_sees_it(self, tmp_path: Path):
        """The mechanism the seam relies on, stated as a fact.

        FastAPI runs a sync route in a worker thread that inherits a **copy** of
        the caller's context, which is what lets one router-level dependency
        scope a whole request. A plain ``threading.Thread`` starts with an empty
        context, so it must not see the caller's folder: that is the half that
        keeps two concurrent requests on two folders.
        """
        import threading

        root = tmp_path / "worker"
        root.mkdir()
        answers: Dict[str, Any] = {}

        def ask(key: str, enter: bool) -> None:
            try:
                if enter:
                    with workspace.scope(str(root)):
                        answers[key] = workspace.current_root()
                else:
                    answers[key] = workspace.current_root()
            except workspace.WorkspaceNotScoped as exc:
                answers[key] = exc

        with workspace.scope(str(root)):
            inside = threading.Thread(target=ask, args=("inside", True))
            inside.start()
            inside.join()

        outside = threading.Thread(target=ask, args=("outside", False))
        outside.start()
        outside.join()

        assert answers["inside"] == str(root)
        assert isinstance(answers["outside"], workspace.WorkspaceNotScoped)


class TestProvidedEnvValues:
    """The two placeholders, kept two (spec §4.3)."""

    def test_the_location_expands_to_the_scope(self, tmp_path: Path):
        root = tmp_path / "served"
        root.mkdir()
        with workspace.scope(str(root)):
            assert config_module.provided_env_values()[
                config_module.PATH_PLACEHOLDER
            ] == str(root)

    def test_the_location_follows_the_scope_from_one_request_to_the_next(
        self, tmp_path: Path
    ):
        first, second = tmp_path / "first", tmp_path / "second"
        first.mkdir()
        second.mkdir()
        values = {}
        for name, root in (("a", first), ("b", second), ("c", first)):
            with workspace.scope(str(root)):
                values[name] = config_module.provided_env_values()[
                    config_module.PATH_PLACEHOLDER
                ]
        assert values == {"a": str(first), "b": str(second), "c": str(first)}

    def test_the_location_outside_a_scope_is_absent(self):
        """No workspace is being served, so the placeholder has no answer.

        It is omitted rather than guessed from the installation: ``PROJECT_ROOT``
        is the install's name, and making the two converge would let one
        workspace's declaration expand to another folder.
        """
        import contextvars

        provided = contextvars.Context().run(config_module.provided_env_values)
        assert config_module.PATH_PLACEHOLDER not in provided
        assert provided["PROJECT_ROOT"] == str(config_module.PROJECT_ROOT)

    def test_the_installation_is_the_installation_inside_and_outside(
        self, tmp_path: Path
    ):
        """``${PROJECT_ROOT}`` never follows the workspace — the two must not converge."""
        root = tmp_path / "workspace"
        root.mkdir()
        install = str(config_module.PROJECT_ROOT)
        assert config_module.provided_env_values()["PROJECT_ROOT"] == install
        with workspace.scope(str(root)):
            provided = config_module.provided_env_values()
            assert provided["PROJECT_ROOT"] == install
            assert provided[config_module.PATH_PLACEHOLDER] == str(root)
            assert provided["PROJECT_ROOT"] != provided[
                config_module.PATH_PLACEHOLDER
            ]

    def test_the_declaration_expansion_sees_the_scope(self, tmp_path: Path):
        """The consumer's side: a declaration's ``${NOJAE_PATH_LOCATION}``."""
        from src.core.mcphub.validation import expand_env

        root = tmp_path / "declared"
        root.mkdir()
        with workspace.scope(str(root)):
            expanded, missing = expand_env("${NOJAE_PATH_LOCATION}/x")
        assert missing == []
        assert expanded == f"{root}/x"

    def test_an_unresolved_name_is_still_left_written_as_is(self):
        """The expansion's own rule survives gaining a provided value."""
        from src.core.mcphub.validation import expand_env

        expanded, missing = expand_env("${NOJAE_NOT_A_NAME_AT_ALL}/x")
        assert missing == ["NOJAE_NOT_A_NAME_AT_ALL"]
        assert expanded == "${NOJAE_NOT_A_NAME_AT_ALL}/x"

    def test_a_stray_export_never_answers_the_workspaces_own_name(
        self, monkeypatch: pytest.MonkeyPatch
    ):
        """The app owns its three names outright: no environment fallback.

        The rule that matters when there is **no** answer: outside a scope, an
        ambient ``NOJAE_PATH_LOCATION`` (which clws-10 stopped exporting, but a
        developer's shell or an old launcher may still carry) must not stand in
        for the served folder — that would silently root one workspace's
        connectors at another. The reference stays unresolved and the note names
        it, which is the honest state: this call is about no folder at all.
        """
        import contextvars

        from src.core.mcphub.validation import expand_env

        monkeypatch.setenv(config_module.PATH_PLACEHOLDER, "/another/checkout")
        expanded, missing = contextvars.Context().run(
            expand_env, "${NOJAE_PATH_LOCATION}/x"
        )
        assert missing == [config_module.PATH_PLACEHOLDER]
        assert expanded == "${NOJAE_PATH_LOCATION}/x"


# -- the API's one reader -------------------------------------------------------


@pytest.fixture
def workspace_client(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> Iterator[TestClient]:
    """The app, on this test's own store, with a deny-list of this test's own.

    Built the way ``tests/test_api.py`` builds its client — the suite's autouse
    fixtures already give the test a temporary settings store and disable both
    hubs, so the app answers from rows nothing here shares with a developer's
    machine. The one addition is the hermetic restricted-roots file, redirected
    the way that suite redirects it for the switch's own deny-list check: the
    committed list belongs to the machine, and the seam's deny-list refusal is
    asserted against a list this file wrote.

    Context-managed so the app lifespan runs across the requests, which is what
    brings the hub objects onto ``app.state`` for the ``hubs`` block.
    """
    from tests.conftest import neutralise_store

    neutralise_store(monkeypatch, tmp_path)
    list_file = tmp_path / "restricted-paths.txt"
    list_file.write_text("/etc\n", encoding="utf-8")
    monkeypatch.setattr(lsphub.constants, "LSP_RESTRICTED_PATHS", list_file)
    with TestClient(create_app()) as test_client:
        yield test_client


class TestTheRouteRefusesWithTheSeamsSentence:
    """Rule 10: the same wrong folder is described the same way everywhere."""

    @pytest.mark.parametrize(
        "raw",
        ["", "rel/path", "not-an-absolute-name"],
        ids=["empty", "relative", "relative-2"],
    )
    def test_a_bad_field_answers_422_with_the_seams_sentence(
        self, workspace_client: TestClient, raw: str
    ):
        sentence = refusal(raw)
        response = workspace_client.get(
            "/api/workspace", params=workspace_params(raw)
        )
        assert response.status_code == 422
        assert response.json()["detail"] == sentence

    def test_an_absent_folder_answers_the_same_sentence(
        self, workspace_client: TestClient, tmp_path: Path
    ):
        ghost = tmp_path / "gone"
        sentence = refusal(str(ghost))
        response = workspace_client.get(
            "/api/workspace", params=workspace_params(ghost)
        )
        assert response.status_code == 422
        assert response.json()["detail"] == sentence

    def test_a_denied_folder_answers_the_same_sentence(
        self, workspace_client: TestClient, tmp_path: Path, monkeypatch
    ):
        denied = tmp_path / "credential-store"
        denied.mkdir()
        list_file = tmp_path / "restricted.txt"
        list_file.write_text(f"{denied}\n", encoding="utf-8")
        monkeypatch.setattr(lsphub.constants, "LSP_RESTRICTED_PATHS", list_file)
        sentence = refusal(str(denied))
        response = workspace_client.get(
            "/api/workspace", params=workspace_params(denied)
        )
        assert response.status_code == 422
        assert response.json()["detail"] == sentence
        assert "deny-list" in sentence

    def test_a_refusal_answers_about_no_other_folder(
        self, workspace_client: TestClient
    ):
        """Rule 12: a refusal is an answer, never a silent substitution."""
        response = workspace_client.get(
            "/api/workspace", params=workspace_params("relative")
        )
        assert response.status_code == 422
        assert "workspace" not in response.json()


class TestTheResolverEntersNoScopeOnRefusal:
    """The mechanism behind rule 12, driven on the dependency itself.

    A folder that was **named and refused** enters no scope: entering one for a
    different folder would be the substitution the rule forbids, and it would
    leave an installation-scoped route answering about a workspace nobody asked
    about. No route reads the scope of a refused request in this task, so the
    only thing that can be observed is the scope itself — hence the dependency is
    driven directly, with the two answers the seam can give.
    """

    @staticmethod
    def _drive(raw: Optional[str], *, as_socket: bool = False) -> Dict[str, Any]:
        """Run the dependency through one request, reporting what the seam said."""
        import asyncio
        from types import SimpleNamespace

        async def one_request() -> Dict[str, Any]:
            connection = SimpleNamespace(state=SimpleNamespace())
            # The one dependency serves both kinds of connection, so both are
            # driven here: the terminal's socket names its folder in the socket's
            # query string and has no per-request body, which is why the resolver
            # cannot be HTTP-only (spec §8).
            # ``cast`` for the two parameters only: the dependency touches
            # nothing of a connection but its ``state``, so a stand-in is the
            # honest argument — and the real transports are covered end to end by
            # every other case in this file and by ``tests/test_terminal.py``.
            # Held as ``Any`` because the signature's other half is the ``None``
            # default FastAPI needs to inject the right transport: naming the
            # stand-in's type would fight that, and the two real transports are
            # exercised end to end elsewhere.
            http: Any = None if as_socket else connection
            socket: Any = connection if as_socket else None
            generator = routes._workspace_scope(
                request=http,
                websocket=socket,
                workspace=raw,
            )
            yielded = await generator.__anext__()
            # Read inside the same context: ``asyncio.run`` executes the
            # coroutine in a *copy* of the caller's, so a read after it returns
            # would answer the test's context, not the request's.
            answers = {
                "yielded": yielded,
                "root": workspace.current_root(),
                "state": getattr(connection.state, "workspace", None),
            }
            with contextlib.suppress(StopAsyncIteration):
                # The generator has nothing second to yield; running it out is
                # what executes the dependency's teardown, i.e. the scope exit.
                await generator.__anext__()
            answers["after"] = workspace.current_root()
            return answers

        return asyncio.run(one_request())

    @pytest.mark.parametrize("as_socket", [False, True], ids=["request", "socket"])
    def test_an_accepted_folder_is_the_scope(
        self, tmp_path: Path, as_socket: bool
    ):
        root = tmp_path / "accepted"
        root.mkdir()
        answers = self._drive(str(root), as_socket=as_socket)
        assert answers["root"] == str(root)
        assert answers["state"] == workspace.Workspace(str(root))
        # Cleared on the way out, so nothing leaks into the next request.
        assert answers["after"] != str(root)

    @pytest.mark.parametrize("as_socket", [False, True], ids=["request", "socket"])
    def test_a_refused_folder_leaves_the_seam_answering_no_scope(
        self, as_socket: bool
    ):
        before = workspace.current_root()
        answers = self._drive("a-relative-name", as_socket=as_socket)
        assert answers["yielded"] is None
        assert answers["state"] is None
        # No scope was entered: the answer is still the outer one (the suite's
        # own guard), never the refused folder and never a substituted one. The
        # interim fallback would have answered a process-wide folder here; it is
        # gone (clws-10).
        assert answers["root"] == before
        assert answers["after"] == before

    def test_the_two_connections_of_one_folder_answer_alike(self, tmp_path: Path):
        """One reader, both transports: the socket and the request agree."""
        root = tmp_path / "shared"
        root.mkdir()
        assert self._drive(str(root)) == self._drive(str(root), as_socket=True)

class TestGetWorkspaceReportsTheNamedFolder:
    """Two folders in turn, each answered about itself."""

    @pytest.fixture
    def two_workspaces(self, tmp_path: Path) -> Tuple[Path, Path]:
        """Two scratch folders, with **different** reserved files.

        Folder A holds a policy file and an MCP declaration; folder B holds
        neither. That difference is what proves the blocks are about the folder
        named rather than about whichever folder the process happens to hold.
        """
        from src.core.editorfs import constants as editorfs_constants

        first = tmp_path / "project-a"
        second = tmp_path / "project-b"
        for root in (first, second):
            root.mkdir()
        reserved = editorfs_constants.POLICY_DIRNAME
        (first / reserved).mkdir()
        (first / reserved / editorfs_constants.POLICY_FILENAME).write_text(
            '{"policies": []}\n', encoding="utf-8"
        )
        (first / reserved / "mcp-settings.json").write_text("{}\n", encoding="utf-8")
        return first, second

    def test_each_folder_is_answered_about_itself(
        self, workspace_client: TestClient, two_workspaces: Tuple[Path, Path]
    ):
        from src.core.editorfs import constants as editorfs_constants

        first, second = two_workspaces
        answers = {}
        for name, root in (("a", first), ("b", second), ("again-a", first)):
            response = workspace_client.get(
                "/api/workspace", params=workspace_params(root)
            )
            assert response.status_code == 200, (name, response.text)
            answers[name] = response.json()

        assert answers["a"]["workspace"] == str(first)
        assert answers["b"]["workspace"] == str(second)
        # The four reserved-folder blocks are about the folder named: A has a
        # policy file and a declaration, B has neither.
        assert answers["a"]["policy"]["state"] == "existing"
        assert answers["a"]["policy"]["path"] == str(
            first / editorfs_constants.POLICY_DIRNAME
            / editorfs_constants.POLICY_FILENAME
        )
        assert answers["b"]["policy"]["state"] == "absent"
        assert str(second) in answers["b"]["policy"]["path"]
        assert answers["a"]["mcpSettings"]["state"] == "existing"
        assert answers["b"]["mcpSettings"]["state"] == "absent"
        assert answers["a"]["lspSettings"]["state"] == "absent"
        assert answers["a"]["lspSettingsTemplate"]["state"] == "absent"
        # And the same folder answers the same way twice: the read wrote nothing
        # and cached nothing about the other one. The pool block's stamps are
        # wall-clock facts about *when* the read happened, so they are compared
        # by shape; everything else must be byte-identical.
        pool_a = answers["a"].pop("hubs").pop("pool")
        pool_again = answers["again-a"].pop("hubs").pop("pool")
        assert answers["again-a"] == answers["a"]
        assert pool_a["limit"] == pool_again["limit"]
        assert pool_a["atLimit"] == pool_again["atLimit"]
        assert [row["root"] for row in pool_a["workspaces"]] == [
            row["root"] for row in pool_again["workspaces"]
        ]

    def test_a_read_leaves_no_reserved_folder_behind(
        self, workspace_client: TestClient, tmp_path: Path
    ):
        """Reporting is not seeding: a folder someone only browsed stays as it was."""
        browsed = tmp_path / "only-browsed"
        browsed.mkdir()
        response = workspace_client.get(
            "/api/workspace", params=workspace_params(browsed)
        )
        assert response.status_code == 200
        assert response.json()["policy"]["state"] == "absent"
        assert list(browsed.iterdir()) == []

    def test_the_default_is_the_installation_folder(
        self, workspace_client: TestClient, tmp_path: Path
    ):
        """``default`` is where a new tab lands (spec D4), whatever is in scope."""
        root = tmp_path / "named"
        root.mkdir()
        body = workspace_client.get(
            "/api/workspace", params=workspace_params(root)
        ).json()
        assert body["default"] == workspace.installation()
        assert body["default"] != body["workspace"]

    def test_the_absent_field_answers_the_installation(
        self, workspace_client: TestClient
    ):
        """The boot read: no field answers the folder a new tab lands on.

        This is the **one** workspace-scoped route a tab may ask without naming
        a folder, because it is how a tab that remembers nothing learns which
        folder to name next (spec D4). The answer is the installation, and it
        enters that folder's scope like any other workspace read — no process
        default is involved (clws-10 deleted it), and every other scoped route
        still refuses an absent field.
        """
        response = workspace_client.get("/api/workspace")
        assert response.status_code == 200
        body = response.json()
        assert body["workspace"] == workspace.installation()
        assert body["default"] == workspace.installation()

    def test_the_hubs_block_is_the_two_hub_payloads(
        self, workspace_client: TestClient, tmp_path: Path
    ):
        """``hubs`` is the pool's answer: the two payloads plus the pool summary.

        clws-06 filled the placeholder task 01 left: the two hub payloads of
        **this workspace's own** set, and the pool's summary (the live
        workspaces, the bound, whether it is reached, and its one sentence).

        The read does **not** admit, so a folder whose tools are not alive yet
        is answered with an empty catalogue rather than a started hub — which is
        the same shape as "no connectors are declared here" but a different fact,
        and the reason the panel routes admit on their own.
        """
        root = tmp_path / "hubbed"
        root.mkdir()
        params = workspace_params(root)
        body = workspace_client.get("/api/workspace", params=params).json()
        assert set(body["hubs"]) == {"mcp", "lsp", "pool"}
        # The pool summary is the interface's data (task 11 renders it).
        assert set(body["hubs"]["pool"]) == {
            "workspaces", "limit", "atLimit", "sentence",
        }
        # A folder nobody admitted is not alive, and says so without a process.
        assert body["hubs"]["mcp"]["installed"] is False
        assert body["hubs"]["mcp"]["connectors"] == []
        assert body["hubs"]["mcp"]["built"] is False
        assert str(root) not in [
            row["root"] for row in body["hubs"]["pool"]["workspaces"]
        ]
        # The payload **keys** are the hub routes' own, so a panel can render
        # either answer with one renderer. (`built` differs per request: the
        # panel route admits, this read does not.)
        mcp = workspace_client.get("/api/mcp", params=params).json()
        lsp = workspace_client.get("/api/lsp", params=params).json()
        assert set(body["hubs"]["mcp"]) == set(mcp)
        assert set(body["hubs"]["lsp"]) == set(lsp)
        # And the panel route did admit, so the folder is live now.
        assert mcp["built"] is True
        assert str(root) in [
            row["root"] for row in
            workspace_client.get(
                "/api/workspace", params=params
            ).json()["hubs"]["pool"]["workspaces"]
        ]

    def test_the_field_is_not_advertised_as_a_route_parameter(
        self, workspace_client: TestClient
    ):
        """One helper spells it, so the schema does not need to offer it.

        The field is a uniform transport detail of every workspace-scoped route,
        not a per-route argument: keeping it out of the OpenAPI schema is what
        lets the pins that assert a route takes **no** argument (the hub panels'
        mode-blindness, the agents' addressed-by-body-only reads) keep their
        meaning after the resolver became router-level.
        """
        spec = workspace_client.get("/openapi.json").json()["paths"]
        for path, operations in spec.items():
            for operation in operations.values():
                if not isinstance(operation, dict):
                    continue
                names = {
                    parameter["name"] for parameter in operation.get("parameters", [])
                }
                assert "workspace" not in names, path


class TestEveryReadRouteRefusesWithTheSeamsSentence:
    """The seven Editor reads, asked about a folder that is not a workspace.

    clws-03 moved each of them behind :func:`src.api.routes.require_workspace`,
    and this is the pair that keeps them there: the **behaviour** (one sentence,
    the same 422, from every route) and the **structure** (every one of those
    handlers really makes the call, so a route added beside them cannot answer
    about the interim default instead).

    The behaviour half is what rule 10 asks for — the same wrong folder described
    the same way wherever it is asked about — and the structural half is what
    stops the sentence from being true only of the routes that happened to be
    tested.
    """

    #: The read routes, with the parameters each one needs beyond the field. The
    #: values are ordinary: the refusal must arrive **before** any of them is
    #: looked at, so a path that exists nowhere is exactly the right input.
    READ_ROUTES = {
        "/api/fs/tree": {},
        "/api/fs/file": {"path": "README.md"},
        "/api/fs/stat": {"path": "README.md"},
        "/api/fs/search": {"q": "needle"},
        "/api/fs/files": {},
        "/api/fs/status": {},
        "/api/fs/diff": {"path": "README.md"},
    }

    @pytest.mark.parametrize(("path", "extra"), sorted(READ_ROUTES.items()))
    def test_a_refused_folder_is_the_same_422_from_every_read(
        self, workspace_client: TestClient, tmp_path: Path, path: str, extra: Dict[str, str]
    ):
        ghost = tmp_path / "not-a-project"
        sentence = refusal(str(ghost))
        response = workspace_client.get(
            path, params={**workspace_params(ghost), **extra}
        )
        assert response.status_code == 422, (path, response.text)
        assert response.json()["detail"] == sentence

    @pytest.mark.parametrize(("path", "extra"), sorted(READ_ROUTES.items()))
    def test_a_relative_folder_is_the_same_422_from_every_read(
        self, workspace_client: TestClient, path: str, extra: Dict[str, str]
    ):
        """The other refusal shape, on the same seven routes."""
        response = workspace_client.get(
            path, params={**workspace_params("relative/name"), **extra}
        )
        assert response.status_code == 422, (path, response.text)
        assert response.json()["detail"] == refusal("relative/name")

    def test_every_read_handler_asks_for_the_workspace(self):
        """Structure: the seven handlers each call the one reader.

        Checked as code because a route that skipped the call would still answer
        — about the interim default — and the two cases above would only catch
        that for the folders they happen to name.
        """
        source = routes_tree_source()
        handlers = {
            registration["path"]: registration["handler"]
            for registration in route_registrations(source)
            if registration["verb"] == "get"
            and f"/api{registration['path']}" in self.READ_ROUTES
        }
        assert set(handlers) == {
            path.removeprefix("/api") for path in self.READ_ROUTES
        }, "the walk saw fewer read registrations than the list names"
        for path, handler in handlers.items():
            called = {
                node.func.id
                for node in ast.walk(handler)
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            }
            assert "require_workspace" in called, f"/api{path}"

    def test_no_read_route_invalidates_a_per_root_cache(self):
        """The per-root caches key on the root, so a read has nothing to clear.

        ``policy_file._CACHE`` and ``fscase._CACHE`` are keyed on the resolved
        root, which is why two workspaces answer independently with no
        coordination at all. An ``invalidate_*()`` call in a read route would be
        a **second** mechanism for the same job — and a worse one, because it
        would make one workspace's answer depend on another tab's traffic.
        """
        source = routes_tree_source()
        offenders = [
            f"/api{registration['path']}"
            for registration in route_registrations(source)
            if registration["verb"] == "get"
            and f"/api{registration['path']}" in self.READ_ROUTES
            for node in ast.walk(registration["handler"])
            if isinstance(node, ast.Call)
            and isinstance(node.func, ast.Attribute)
            and node.func.attr.startswith("invalidate_")
        ]
        assert offenders == [], (
            "a read route cleared a cache another workspace also uses: "
            f"{offenders}"
        )


class TestTheCatalogueIsNeverScopedToAFolder:
    """Spec §4.2: the installation-scoped routes answer even about a bad folder.

    A tab whose workspace was moved or deleted must still be able to read the
    servers, models, agents and bullets it is configured with — otherwise the
    one thing the user could do to fix the tab is the thing the tab cannot do.
    """

    #: The catalogue reads that must answer, and the key that says they did.
    #: ``GET /api/models`` is deliberately **not** here: it is a live probe of a
    #: caller-supplied server URL, so calling it would reach outside the suite
    #: (AGENTS.md, "tests stay hermetic"). Its scope is asserted structurally
    #: below, where every installation-scoped route is checked for the one call
    #: that would make it workspace-scoped.
    ROUTES = {
        "/api/config": "models",
        "/api/servers": "servers",
        "/api/agents": "agents",
        "/api/prompt-helpers": "slots",
    }

    @pytest.mark.parametrize(("path", "key"), sorted(ROUTES.items()))
    def test_an_installation_route_needs_no_field(
        self, workspace_client: TestClient, path: str, key: str
    ):
        """The catalogue answers with no folder at all (spec §4.2).

        The other side of the absent-field contract: ``GET /api/config`` and its
        siblings are the installation's, so they must not acquire the
        workspace-scoped 422 merely because the tab has not named a folder yet.
        """
        response = workspace_client.get(path)
        assert response.status_code == 200, (path, response.text)
        assert key in response.json()

    @pytest.mark.parametrize(("path", "key"), sorted(ROUTES.items()))
    def test_an_installation_route_answers_about_a_refused_folder(
        self, workspace_client: TestClient, path: str, key: str
    ):
        response = workspace_client.get(
            path, params={"workspace": "a-folder-that-cannot-be-one"}
        )
        assert response.status_code == 200, (path, response.text)
        assert key in response.json()

    @pytest.mark.parametrize(("path", "key"), sorted(ROUTES.items()))
    def test_an_installation_route_answers_about_a_deleted_folder(
        self, workspace_client: TestClient, tmp_path: Path, path: str, key: str
    ):
        gone = tmp_path / "was-a-project"
        gone.mkdir()
        response = workspace_client.get(path, params=workspace_params(gone))
        gone.rmdir()
        assert response.status_code == 200, (path, response.text)
        assert key in response.json()

    def test_the_health_route_needs_no_field_at_all(self, workspace_client: TestClient):
        assert workspace_client.get("/api/health").status_code == 200


class TestTheFieldIsSpelledInOnePlace:
    """No route spells the parameter's name, and no route enters the scope.

    Checked as code, the way the suite checks the other single-owner rules: a
    second spelling of ``workspace=`` in a call site, or a second
    ``scope(...)`` entry, is exactly the drift the lot cannot review by hand.
    """

    def test_the_query_name_is_spelled_once_in_the_api(self):
        source = routes_tree_source()
        # The field's name is bound exactly once, as the dependency's ``alias``.
        # Read as an AST rather than as a substring count because the word also
        # appears as a payload key and in prose — a count would flag those and
        # get widened, which is how a guard stops guarding. A second ``Query``
        # on the same name is a second reader, and that is the drift: a route
        # that spells the parameter itself can disagree with the resolver about
        # what was named.
        tree = ast.parse(source)
        aliases = [
            keyword
            for node in ast.walk(tree)
            if isinstance(node, ast.Call)
            and getattr(node.func, "id", getattr(node.func, "attr", "")) == "Query"
            for keyword in node.keywords
            if keyword.arg == "alias"
            and isinstance(keyword.value, ast.Name)
            and keyword.value.id == "WORKSPACE_QUERY"
        ]
        assert len(aliases) == 1, (
            "the workspace field must be declared once, by the router-level "
            f"dependency: {len(aliases)} declaration(s)"
        )
        assert routes.WORKSPACE_QUERY == "workspace"
        # And no route reads the query string by hand to get the folder.
        assert "query_params" not in source, (
            "a route read the workspace out of the query string itself instead "
            "of calling require_workspace"
        )

    def test_no_installation_scoped_route_asks_for_a_workspace(self):
        """Spec §4.2, as code: the catalogue's routes never call the helper.

        A route that did would answer 422 about a folder the catalogue has no
        business with — and a tab whose folder had been deleted could no longer
        read the servers, models, agents or bullets it needs to fix itself.
        """
        source = routes_tree_source()
        checked = 0
        for registration in route_registrations(source):
            # The decorators spell their paths without the router's prefix, while
            # ``INSTALLATION_SCOPED_PATHS`` names them as the browser reaches
            # them — one leading ``/api`` is the difference.
            path = f"/api{registration['path']}"
            if not any(
                path == scoped or path.startswith(f"{scoped}/")
                for scoped in routes.INSTALLATION_SCOPED_PATHS
            ):
                continue
            checked += 1
            names = {
                node.func.id
                for node in ast.walk(registration["handler"])
                if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)
            }
            assert "require_workspace" not in names, path
        # Liveness: a guard over an empty selection passes on nothing, so the
        # walk is shown to have found the routes it claims to have judged.
        assert checked >= len(routes.INSTALLATION_SCOPED_PATHS), (
            "the walk saw fewer installation-scoped registrations than the list "
            f"names: {checked}"
        )

    def test_only_the_resolver_and_the_pool_enter_the_scope(self):
        """Two owners of a scope, and no third.

        The router-level dependency is the one that answers a **request**. The
        hub pool (clws-05) is the second, and for a reason of its own: a
        workspace's connectors and language servers read their declarations
        through ``constants.*_settings_path()``, which reads the scope, so the
        pool must enter the folder's scope around the seeding, the scan and the
        build — that is what makes ``${NOJAE_PATH_LOCATION}`` mean *that*
        workspace in one process serving two.

        Anything else that enters a scope is a surface deciding which folder to
        answer about for someone else's request, which is the substitution rule
        12 forbids.

        ``src/api/server.py`` is the third and last: the boot enters the
        **installation** folder's scope around the install-scoped store's own
        boot, because in test mode the suite's connection fixture is a file in
        that folder's reserved subfolder (clws-12). It is not a request deciding
        a folder — it is the one boot moment, and it enters the folder the app
        itself is rooted at.
        """
        allowed = {
            str(Path("src/api/routes/seam.py")),
            str(Path("src/api/server.py")),
            str(Path("src/core/hubpool.py")),
        }
        offenders: List[str] = []
        for path in scan_roots():
            if path.name == "workspace.py":
                continue
            text = path.read_text(encoding="utf-8")
            if re.search(r"\.scope\(", text):
                label = str(path.relative_to(REPO_ROOT))
                if label not in allowed:
                    offenders.append(label)
        assert offenders == [], (
            "a surface other than the router-level dependency and the hub pool "
            f"enters a workspace scope: {offenders}"
        )

    def test_the_installation_scoped_routes_are_the_named_ones(self):
        """The list is the invariant, so it is asserted to be the list."""
        assert set(routes.INSTALLATION_SCOPED_PATHS) == {
            "/api/config",
            "/api/prompt-helpers",
            "/api/servers",
            "/api/models",
            "/api/agents",
            # The connector wizard's two reads: page 1's committed list and the
            # header line's names. Both are about the install, so a tab whose
            # folder has gone can still open the dialog and be told who it runs
            # as. Its scan and its two posts are workspace-scoped, and stay out.
            "/api/wizard/catalogue",
            "/api/wizard/connection",
        }


#: Every **workspace-scoped HTTP** route, with the inputs it needs besides the
#: field. This is the route list the absent-field contract is over: a route
#: added later is absent here until its body and parameters are named, which is
#: what makes the structural half below fail rather than silently skip it. The
#: terminal's WebSocket is the one scoped connection that answers with a close
#: reason instead of a 422; ``tests/test_terminal.py`` holds its case.
SCOPED_HTTP_REQUESTS: Dict[Tuple[str, str], Dict[str, Any]] = {
    ("GET", "/api/mcp"): {},
    ("POST", "/api/mcp"): {"json": {"enabled": []}},
    ("POST", "/api/mcp/restart"): {},
    ("GET", "/api/lsp"): {},
    ("POST", "/api/lsp"): {"json": {"enabled": []}},
    ("POST", "/api/lsp/restart"): {},
    ("POST", "/api/lsp/query"): {
        "json": {"action": "status", "path": "README.md"}
    },
    ("GET", "/api/workspace"): {},
    ("GET", "/api/fs/tree"): {},
    ("GET", "/api/fs/file"): {"params": {"path": "README.md"}},
    ("GET", "/api/fs/search"): {"params": {"q": "needle"}},
    ("GET", "/api/fs/files"): {},
    ("PUT", "/api/fs/file"): {
        "json": {"path": "README.md", "text": "x"}
    },
    ("POST", "/api/fs/create"): {"json": {"path": "new.txt"}},
    ("DELETE", "/api/fs/file"): {"params": {"path": "README.md"}},
    ("POST", "/api/fs/rename"): {
        "json": {"from": "README.md", "to": "notes.md"}
    },
    ("POST", "/api/fs/move-batch"): {
        "json": {"paths": [], "to_parent": ""}
    },
    ("GET", "/api/fs/stat"): {},
    ("GET", "/api/fs/status"): {},
    ("GET", "/api/fs/diff"): {"params": {"path": "README.md"}},
    ("GET", "/api/terminal"): {},
    ("GET", "/api/lsp/log"): {"params": {"server": "x"}},
    ("GET", "/api/batch/tasks"): {},
    ("GET", "/api/batch/prefixes"): {},
    # The connector wizard's workspace-scoped half: the scan about this folder and
    # the two model steps, which answer about *this* folder's facts whatever the
    # dialog's installation-scoped reads said.
    ("GET", "/api/wizard/scan"): {},
    ("POST", "/api/wizard/propose"): {"json": {"agentMode": "code"}},
    ("POST", "/api/wizard/prepare"): {
        "json": {"agentMode": "code", "family": "mcp", "candidate": {"id": "fetch"}}
    },
    ("POST", "/api/chat"): {
        "json": {
            "messages": [{"role": "user", "content": "hi"}],
            "agentMode": "code",
        }
    },
    ("POST", "/api/chat/pause"): {},
}


def scoped_http_registrations(source_text: str) -> set:
    """The HTTP registrations that are **not** installation-scoped.

    Read from the decorators, not from this file's list, so the pair below has
    a liveness check: the map has to name every route the router actually
    registers, and every route registered has to answer without a folder.
    """
    found = set()
    for registration in route_registrations(source_text):
        verb = registration["verb"].upper()
        if verb not in ("GET", "POST", "PUT", "DELETE", "PATCH"):
            continue
        path = f"/api{registration['path']}"
        if any(
            path == scoped or path.startswith(f"{scoped}/")
            for scoped in routes.INSTALLATION_SCOPED_PATHS
        ):
            continue
        found.add((verb, path))
    return found


class TestEveryWorkspaceScopedRouteNeedsTheField:
    """clws-10: no route answers about a folder it was not given (rule 12).

    The interim environment fallback is gone, so every workspace-scoped request
    without the field has to answer the seam's own empty-name sentence. The
    parametrised half is the behaviour; the structural half is what stops the
    list from going stale and quietly stopping covering a new route.
    """

    def test_the_list_names_every_scoped_http_route(self):
        source = routes_tree_source()
        assert scoped_http_registrations(source) == set(SCOPED_HTTP_REQUESTS)

    @pytest.mark.parametrize(
        ("method", "path", "kwargs"),
        [
            (method, path, kwargs)
            for (method, path), kwargs in sorted(SCOPED_HTTP_REQUESTS.items())
        ],
        ids=[
            f"{method} {path}"
            for (method, path) in sorted(SCOPED_HTTP_REQUESTS)
        ],
    )
    def test_an_absent_field_is_the_seams_422(
        self, workspace_client: TestClient, method: str, path: str,
        kwargs: Dict[str, Any],
    ):
        response = workspace_client.request(method, path, **kwargs)
        if path == "/api/workspace":
            # The **boot read** is the deliberate exception (clws-12): a tab
            # with no remembered folder asks this route with no field to learn
            # the installation folder. Every other scoped route, and every
            # route that *writes*, still draws the seam's empty-name sentence.
            assert response.status_code == 200, (path, response.text)
            assert response.json()["workspace"] == workspace.installation()
            return
        assert response.status_code == 422, (path, response.text)
        assert response.json()["detail"] == workspace.EMPTY_REFUSAL


class TestAChatTurnIsAboutTheFolderItNames:
    """Spec §5.6 rule 31, at the route the tab's chat request reaches.

    The client's half is one line (``withWorkspace`` around ``POST /api/chat``);
    this is the answer it buys: the project-instructions block a turn receives is
    the one at **that** request's root, and two requests naming two folders are
    served two different instructions — in either order, with no environment
    write between them. Before the seam this pair was unreachable: one process
    held one folder, so the second tab necessarily received the first one's
    ``AGENTS.md``.
    """

    @pytest.fixture
    def instructions_stub(self, workspace_client: TestClient, monkeypatch):
        """The chat route with the model call replaced by a recorder."""
        seen: List[Dict[str, Any]] = []

        def fake(messages, model, server_url, emit, sampling=None, cancel_event=None,
                 pause_event=None, api_key="none", sysprompt=None,
                 agent_instructions=None, mode_instructions=None, **tools):
            seen.append({"agent_instructions": agent_instructions})
            emit({"event": "done", "took": 0.0, "ttft": 0.0, "tokens": 0,
                  "tokensEstimated": False})

        monkeypatch.setattr(api_chat, "stream_chat", fake)
        return workspace_client, seen

    @staticmethod
    def _post(client: TestClient, root: Path) -> None:
        response = client.post(
            "/api/chat",
            params=workspace_params(root),
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "agentMode": "code",
            },
        )
        assert response.status_code == 200, response.text

    def test_a_refused_folder_is_422_and_starts_no_turn(
        self, instructions_stub, tmp_path: Path
    ):
        """A turn names a folder or it does not run (spec §5.2 rule 12).

        The refusal arrives **before** the pause handle is armed, so a request
        that never streams cannot own the handle a later reply needs — and the
        model is never called for a folder the app would not browse.
        """
        client, seen = instructions_stub
        response = client.post(
            "/api/chat",
            params=workspace_params(tmp_path / "no-such-project"),
            json={
                "messages": [{"role": "user", "content": "hi"}],
                "agentMode": "code",
            },
        )
        assert response.status_code == 422
        assert response.json()["detail"] == refusal(str(tmp_path / "no-such-project"))
        assert seen == []

    def test_pause_names_a_folder_or_says_nothing(self, workspace_client: TestClient):
        """The same rule on the pause route: the field is validated there too."""
        response = workspace_client.post(
            "/api/chat/pause", params=workspace_params("relative/name")
        )
        assert response.status_code == 422
        assert response.json()["detail"] == refusal("relative/name")

    def test_two_folders_each_receive_their_own_instructions(
        self, instructions_stub, tmp_path: Path
    ):
        client, seen = instructions_stub
        first = tmp_path / "project-first"
        second = tmp_path / "project-second"
        for name, root in (("FIRST", first), ("SECOND", second)):
            root.mkdir()
            (root / "AGENTS.md").write_text(f"# rules {name}\n", encoding="utf-8")

        for order in ((first, second), (second, first)):
            seen.clear()
            for root in order:
                self._post(client, root)
            assert len(seen) == 2
            for answer, root in zip(seen, order):
                block = answer["agent_instructions"]
                marker = "FIRST" if root is first else "SECOND"
                assert f"# rules {marker}" in block
                assert str(root) in block
                # And never the other folder's: the block names one root.
                other = second if root is first else first
                assert str(other) not in block


class TestTheHarnessNamesFoldersByValue:
    """``workspace_params`` is the harness's one spelling, and it is the real one."""

    def test_the_helper_builds_the_field_the_server_reads(self, tmp_path: Path):
        root = tmp_path / "named-by-the-harness"
        root.mkdir()
        params = workspace_params(root)
        assert params == {"workspace": str(root)}
        # And the server reads what the helper writes: a folder named through the
        # helper is the folder the answer is about.
        with TestClient(create_app()) as test_client:
            body = test_client.get("/api/workspace", params=params).json()
        assert body["workspace"] == str(root)
