"""Suite-wide fixtures and the platform gate (win-01).

The two markers below are how the suite stays a usable signal on a platform
where some of these tests cannot run: a test whose subject the platform will
not provide is *skipped with a sentence naming the invariant it would have
checked*, never weakened. On Linux neither marker ever fires, so the whole
suite still runs there.
"""

import logging
import os
import shutil
import sys
import tempfile
import threading
from pathlib import Path
from typing import Any
from typing import Iterator
from typing import Callable
from typing import cast
from typing import Optional
from typing import Dict
from typing import List
from typing import Mapping
from typing import Tuple
from urllib.parse import urlsplit
from urllib.request import url2pathname

import pytest

from src.core import appdb
from src.core import editorfs
from src.core.termhub import drivers as termhub_drivers
from src.core.termhub import pty_conpty as termhub_conpty
from src.core.termhub import shells as termhub_shells


# --- the platform gate (win-01) ---------------------------------------------
#
# Every platform guard in the suite consults one of the ``_Probe`` objects
# below: a per-file copy of a probe is how a guard drifts from what it guards.
# A probe answers by *trying*, not by the platform's name, where a try is
# possible (symlinks, a shell through the terminal's own selection seam, a
# driver through the terminal's driver seam, ``/proc``); where it is not
# (``/etc/shadow`` exists, ``chmod`` is meaningful), the difference sits behind
# the named seam ``posix_behaviour`` instead. The attempt is lazy --
# ``bool(probe)`` runs it once and caches the verdict -- so collection-only
# commands touch no filesystem.


class _Probe:
    """A platform capability, attempted on first use and kept for the session.

    A probe is truthy while the capability *is* there. pytest calls ``bool()`` on
    a ``skipif`` condition at setup time, which is exactly where the attempt
    belongs, so a probe (or its negation, as :func:`skip_unless` builds one) is
    itself a usable condition. The guard markers below consult their probes the
    same way.
    """

    def __init__(
        self,
        attempt: Callable[[], bool],
        description: str,
        detail: Optional[Callable[[], str]] = None,
    ) -> None:
        self._attempt = attempt
        self.description = description
        # What the attempt *learned* when it failed, for the skip sentence. A
        # capability a seam refuses usually says why, and naming that is what
        # makes "Git is missing" distinguishable from "the driver is missing"
        # in a runner's output -- so the detail travels with the verdict.
        self._detail = detail
        self._verdict: Optional[bool] = None
        self._lock = threading.Lock()

    def __bool__(self) -> bool:
        with self._lock:
            if self._verdict is None:
                self._verdict = bool(self._attempt())
            return self._verdict

    def refusal_detail(self) -> str:
        """The failed attempt's own sentence, if it has one (asked only once
        the verdict is no)."""
        return "" if self._detail is None else str(self._detail())

    def clear_verdict(self) -> None:
        """Forget the cached attempt, so the next question asks again."""
        with self._lock:
            self._verdict = None

    def __repr__(self) -> str:
        # Never answers the probe -- a repr during collection must not touch the
        # filesystem, so the verdict is shown only once it is already known.
        return f"<probe: {self.description} -> {self._verdict}>"


def _symlink_probe_forms(directory: Path) -> None:
    """Create every shape of symlink a test in this suite asks for.

    All three are attempted, because the tests use all three and a platform may
    grant them differently: a plain file link, a *directory* link
    (``target_is_directory=True``), and a ``target_is_directory=True`` link to a
    name that does not exist -- the dangling form the Editor's create, rename
    and delete tests plant. Any one raising means an unprivileged process
    cannot make the link that test needs.
    """
    target_file = directory / "probe-target.txt"
    target_file.write_text("x", encoding="utf-8")
    target_dir = directory / "probe-target-dir"
    target_dir.mkdir()

    os.symlink(target_file, directory / "probe-file")
    os.symlink(target_dir, directory / "probe-dir", target_is_directory=True)
    os.symlink(
        directory / "probe-never-existed",
        directory / "probe-dangling",
        target_is_directory=True,
    )


def _symlinks_are_allowed() -> bool:
    """Try once, in a private temporary directory, to make every symlink shape."""
    try:
        with tempfile.TemporaryDirectory(
            prefix="nojae-symlink-probe-"
        ) as raw:
            _symlink_probe_forms(Path(raw))
    except OSError:
        return False
    return True


symlink_probe = _Probe(_symlinks_are_allowed, "create a symlink")
posix_probe = _Probe(lambda: os.name == "posix", "POSIX process semantics")
windows_probe = _Probe(lambda: os.name == "nt", "Windows process semantics")
proc_fs_probe = _Probe(lambda: Path("/proc").is_dir(), "a readable /proc")


# --- the volume's case answer (tst-01) ----------------------------------------
#
# Several suites pin a *pair* of verdicts by forcing ``fscase.case_folded`` and
# planting the two spellings the pair is about — ``.nojae`` and ``.NOJAE``,
# ``denied-root`` and ``Denied-Root``. That only holds where the volume can hold
# both names at once: NTFS answers one folder for both, so the second
# ``mkdir`` raises and the planted premise is false. The probe is the app's own
# question (plant a cased name, ``stat`` the other spelling, compare
# ``st_dev``/``st_ino`` — the same measurement as ``mcp_connectors/fscase``),
# so a test of a folded pair and a test that skips one cannot disagree about
# this volume. A case-sensitive volume — the Linux runner, any ext4 — keeps
# both spellings, so the marker never fires there and the whole suite runs.


def _volume_folds_case() -> bool:
    with tempfile.TemporaryDirectory(prefix="nojae-case-probe-") as raw:
        planted = Path(raw) / "ProbeName"
        planted.write_text("x", encoding="utf-8")
        try:
            cased = os.stat(planted)
            try:
                other = os.stat(Path(raw) / "probename")
            except OSError:
                return False
            return (cased.st_dev, cased.st_ino) == (other.st_dev, other.st_ino)
        finally:
            planted.unlink(missing_ok=True)


case_folded_probe = _Probe(_volume_folds_case, "a volume that folds name case")


# --- the terminal's capability probes (csl-08) --------------------------------
#
# The pane's own seams answer these questions, so the suite asks the seams
# rather than re-implementing them: ``termhub.shells`` decides *which program*
# the terminal would run (``$SHELL`` → ``/bin/sh`` on POSIX, ``TERMINAL_SHELL``
# → Git Bash on Windows, else a refusal naming what was looked for) and
# ``termhub.drivers`` decides *whether a pseudo-terminal mechanism exists at
# all*. The old probe (``$SHELL`` or ``/bin/sh``, judged with ``shutil.which``)
# answered "no shell" on every Windows machine, which is why a real session
# under test was impossible there. One probe per question, consulted by the
# guards *and* by the tests that want the program itself, so a test that spawns
# a session and a test that skips one can never disagree about this machine.

_selected_shell: Optional[str] = None
_shell_refusal = ""


def _offer_a_shell() -> bool:
    """Ask ``termhub.shells`` once; keep its answer for the tests and the skip."""
    global _selected_shell, _shell_refusal
    try:
        _selected_shell = termhub_shells.select_shell()[0]
    except Exception as exc:
        # Whatever the seam refuses with (no shell on the platform, no Git
        # install), it is the same refusal ``spawn()`` would raise, so this is
        # the pane's own answer rather than a second opinion on it — and its
        # sentence is what a skip gets to quote, so "Git is missing" and "the
        # driver is missing" stay tellable apart in a runner's output.
        _shell_refusal = str(exc)
        return False
    return True


shell_probe = _Probe(
    _offer_a_shell,
    "a shell this machine offers the terminal",
    lambda: _shell_refusal,
)
driver_probe = _Probe(
    termhub_drivers.driver_available,
    "a pseudo-terminal driver (the kernel PTY, or the 'windows' extra's ConPTY)",
)
# The one answer to "is the *Windows* driver installed", so a test class that
# needs a real pseudo-console and the seam's own selection cannot disagree about
# whether this box has one (the same rule as the shell probe above).
windows_driver_probe = _Probe(
    termhub_conpty.available,
    "the Windows pseudo-console driver (pywinpty, the 'windows' extra)",
)


def selected_shell() -> Optional[str]:
    """The program a terminal session would run here, or ``None``."""
    if not shell_probe:
        return None
    return _selected_shell


def _pane_can_run(tool: str) -> bool:
    """Could the *pane's* shell run ``tool``? Asked of the environment the seam
    would hand that child, not of this process's ``PATH``.

    A Git Bash session's child is given Git's own directories first
    (:func:`termhub.shells.child_environment`), so ``stty`` is reachable there
    while ``shutil.which`` in the test process answers nothing — the app itself
    is not launched from Git Bash. The child's answer is the one a terminal
    assertion needs, and asking it through the seam keeps the test and the pane
    from disagreeing about the search path.
    """
    program = selected_shell()
    if program is None:
        return False
    child = termhub_shells.child_environment((program, "-i"), 80, 24)
    for entry in child.get("PATH", "").split(os.pathsep):
        if not entry:
            continue
        for suffix in ("", ".exe"):
            if os.path.isfile(os.path.join(entry, tool + suffix)):
                return True
    return False


# C §6's resize assertion comes in two halves: the size the *driver* reports is
# platform-neutral and asserted wherever a session can open; the size the
# *shell* re-reads needs a shell carrying `stty`. Whether it does is an
# environment fact about the program the seam selected, so a probe answers it —
# the terminal twin of ``console_tool`` below, one probe for the one tool the
# suite runs through the pane.
stty_probe = _Probe(
    lambda: _pane_can_run("stty"), "`stty` on the pane shell's own search path"
)


# The marker names, each answering to one probe plus the sentence a bare marker
# skips with. A skipped test must say which invariant it would have checked, so
# a test whose own name does not say it passes its own sentence as the marker's
# argument:
# ``@pytest.mark.requires_symlink("a symlinked lot file must never be read")``.
_GUARD_MARKERS: Dict[str, Tuple[_Probe, str]] = {
    "requires_symlink": (
        symlink_probe,
        "the invariant needs a symlink this platform will not let an "
        "unprivileged process create",
    ),
    "posix_behaviour": (
        posix_probe,
        "the invariant is a POSIX-only fact with no probe that answers it",
    ),
    "windows_behaviour": (
        windows_probe,
        "the invariant is a Windows-only fact (the Windows trees, the Windows "
        "environment values, Git's toolset) with no probe that answers it",
    ),
    # The terminal's capabilities (csl-08), marked rather than skipif-ed so the
    # sentence can carry what the probe *learned* — the seam's own refusal —
    # which a skipif reason, fixed at import time, cannot. A session test names
    # the ones it opens through; a skip then says which capability is absent
    # rather than repeating a sentence that could describe any of them.
    "needs_shell": (
        shell_probe,
        "the terminal's own shell selection (termhub.shells: POSIX $SHELL -> "
        "/bin/sh, Windows TERMINAL_SHELL -> Git Bash) names no program here",
    ),
    "needs_driver": (
        driver_probe,
        "no pseudo-terminal driver answers available (the kernel PTY, or the "
        "'windows' extra's ConPTY), so no session can spawn at all",
    ),
    "needs_stty": (
        stty_probe,
        "the invariant is that the *shell* re-reads the window the server set, "
        "which needs `stty` on the pane shell's own search path",
    ),
    "needs_windows_driver": (
        windows_driver_probe,
        "the invariant can only be measured on a real pseudo-console, which "
        "needs the 'windows' extra installed",
    ),
    # A pair of verdicts obtained by forcing ``fscase.case_folded`` while both
    # spellings sit on disk as two folders. On a volume that folds case they are
    # one folder, so the "not folded" half is no longer the pair's other answer
    # — it describes a name that cannot exist there.
    "case_sensitive_volume": (
        _Probe(
            lambda: not bool(case_folded_probe),
            "a volume that keeps two names differing only in case apart",
        ),
        "the test plants both spellings of one name and asks the fold probe to "
        "answer each way, which only a case-sensitive volume can hold",
    ),
}


def skip_unless(probe: _Probe, reason: str) -> pytest.MarkDecorator:
    """A ``skipif`` for one platform capability a test needs, with its sentence.

    A fact that a named marker does not cover (``/proc`` only, not all of
    POSIX) keeps its own guard, but built on this one helper so the probe and
    the reason live together. ``skipif(not probe)`` would answer the probe at
    import time; the wrapper below defers the verdict to the test's setup.
    """
    absent = _Probe(lambda: not bool(probe), f"absence of {probe.description}")
    # ``cast`` only for the stub: pytest's own skipif signature wants a plain
    # bool, and it evaluates the condition by calling bool() on it.
    return pytest.mark.skipif(cast(bool, absent), reason=reason)


# A few tests can only observe the rule they pin by *running* a program (the
# console connector's decoder, its timeout, its output cap). Whether that
# program is on PATH is an environment fact, so a probe answers it rather than a
# platform name — the same answer on Windows and on a Linux box with a thin
# PATH. One probe per tool, cached, so the tests asking about `printf` attempt
# it once.
_tool_probes: Dict[str, _Probe] = {}


def console_tool(tool: str, reason: str) -> pytest.MarkDecorator:
    """Skip a test whose subject can only be seen through ``tool``.

    ``reason`` names the invariant the test would have checked, as every skip's
    sentence must.
    """
    probe = _tool_probes.get(tool)
    if probe is None:
        probe = _Probe(lambda: shutil.which(tool) is not None, f"`{tool}` on PATH")
        _tool_probes[tool] = probe
    return skip_unless(probe, reason)


def pytest_configure(config: pytest.Config) -> None:
    """Register the guard markers, so ``--strict-markers`` stays clean."""
    for name, (_, default_reason) in _GUARD_MARKERS.items():
        config.addinivalue_line("markers", f"{name}(reason=None): {default_reason}")


def pytest_runtest_setup(item: pytest.Item) -> None:
    """Turn a guard marker into the skip its probe says the platform needs."""
    for name, (probe, default_reason) in _GUARD_MARKERS.items():
        for mark in item.iter_markers(name=name):
            if probe:
                continue
            reason = str(mark.args[0]) if mark.args else default_reason
            detail = probe.refusal_detail()
            if detail:
                reason = f"{reason} ({detail})"
            pytest.skip(f"{name}: {reason}")


@pytest.fixture
def _hermetic() -> Iterator[pytest.MonkeyPatch]:
    """A ``MonkeyPatch`` a guard owns, so a test's ``undo()`` cannot lift the guard.

    Every hermeticity guard below used to patch through the test's own
    ``monkeypatch``. That is the same instance a test body can call ``undo()``
    on, and ``undo()`` reverts *everything* recorded on it — the test's patches
    **and** every autouse guard's. The suite then read the developer's machine
    for the rest of the test: the working location fell back to the install
    directory, so the modes and settings lookups answered from this checkout's
    own ``.nojae`` — a real model connection, a real API key, and whatever
    agents that developer happens to have defined today. A test asserting a
    fixed list of mode ids therefore failed or passed on the contents of a file
    no test wrote, which is the machine-dependence ``test_env_isolation.py``
    exists to forbid.

    So a guard patches on an instance of its own and undoes it in its own
    teardown. A test still overrides a guard by patching the same key on its own
    ``monkeypatch`` (guards set up first, test body later), and the override is
    still reverted before the guard's own undo — the ordering is unchanged.
    """
    guard = pytest.MonkeyPatch()
    try:
        yield guard
    finally:
        guard.undo()


@pytest.fixture(autouse=True)
def _no_mcp_processes(_hermetic: pytest.MonkeyPatch) -> None:
    """Never spawn real MCP connector subprocesses from app lifespans in tests."""
    _hermetic.setenv("NOJAE_DISABLE_MCP", "1")


@pytest.fixture(autouse=True)
def _no_lsp_processes(_hermetic: pytest.MonkeyPatch) -> None:
    """Never spawn real language servers from app lifespans in tests."""
    _hermetic.setenv("NOJAE_DISABLE_LSP", "1")


@pytest.fixture(autouse=True)
def _no_test_settings_mode(_hermetic: pytest.MonkeyPatch) -> None:
    """Pin the e2e **store** switch off for the whole backend suite (D14).

    ``NOJAE_TEST_SETTINGS`` puts a process in the e2e suite's mode, where the
    store is a temporary database materialised from
    ``.nojae/nojae-test-settings.json`` instead of this install's ``nojae.db``.
    That fixture is hand-authored and the app never seeds it, so an exported
    ``1`` in the runner's shell would leave the *whole* suite failing en masse
    for a reason no traceback explains. Clearing it here is what keeps the
    suite's answer independent of the machine it runs on; the e2e suite is the
    only thing that turns it on, through ``web/playwright.config.js``. A unit
    test that wants the mode flips it itself with ``monkeypatch.setenv`` — the
    switch is read per call.
    """
    clear_test_settings_mode(_hermetic)


def clear_test_settings_mode(patch: pytest.MonkeyPatch) -> None:
    """The guard's one line, as a function a test can run against its own export.

    Pulled out of the fixture above so ``tests/test_env_isolation.py`` can ask
    the question without arranging a module-scoped export: that would be read by
    :func:`_every_test_gets_its_own_store` too, and the store fixture would boot
    from this checkout's own hand-authored fixture — the leak being forbidden.
    """
    patch.delenv(appdb.TEST_SETTINGS_KEY, raising=False)


@pytest.fixture(autouse=True)
def _no_trash_of_its_own(_hermetic: pytest.MonkeyPatch,
                         tmp_path: Path) -> None:
    """Keep every test's sweep off the app repo's legacy ``logs/trash``.

    ``sweep_trash`` prunes that folder as well as the workspace's own, and the
    app sweeps once at boot — so without this pin, running the suite would
    expire the developer's real old batches. Tests that assert about batches
    patch ``TRASH_DIR``/``LEGACY_TRASH_DIR`` themselves (the ``trash`` /
    ``legacy_trash`` fixtures); this only closes the paths that never ask.
    """
    _hermetic.setattr(
        editorfs.constants, "LEGACY_TRASH_DIR", tmp_path / "legacy-trash-unused"
    )


@pytest.fixture(autouse=True)
def _no_legacy_tool_cap(_hermetic: pytest.MonkeyPatch) -> None:
    """Keep a stale ``.env`` entry from deciding a test's answer.

    ``create_app()`` loads the developer's own ``.env`` once, so a key this file
    *used* to own would leak into every test and depend on the machine it runs
    on. ``MAX_TOOL_ITERATION`` became a per-agent column (D9) and ``LSP_ENABLED``
    the declaration's ``enable`` flag (D13), so a stale entry in a developer's
    ``.env`` is read by nothing; clearing them is what keeps that true even if a
    template ever rendered one again. The value a test actually runs on comes
    from the temporary database :func:`_every_test_gets_its_own_store` pins.
    ``MCP_ENABLED`` is gone from the config entirely (connectors activate only
    through their ``enable`` flag in ``mcp-settings.json``); clearing it keeps a
    stale entry in a developer's ``.env`` from confusing the suite.
    """
    _hermetic.delenv("MAX_TOOL_ITERATION", raising=False)
    _hermetic.delenv("LSP_ENABLED", raising=False)
    _hermetic.delenv("MCP_ENABLED", raising=False)


# --- the store harness (appdb-04) ---------------------------------------------
#
# ``<install root>/nojae.db`` is where the model connection, the agent personas
# and the prompt helpers live (spec §4.1), so the suite owns a database the same
# way it owns a ``.env`` and a working location: one autouse fixture gives every
# test a temporary one, one helper serves the test that owns its own root, and
# the guard below makes the install's own file **unopenable** rather than merely
# unlikely to be reached. ``tests/test_store_hermeticity.py`` is that invariant
# as a test, poisoned on purpose — the same style as the write-surface isolation
# guard: a guard that cannot fail is not a guard.

#: The install's own database, captured **at import**. Every fixture below moves
#: ``appdb.PROJECT_ROOT``, so asking later would ask about the moved path and the
#: real one would have no name left to refuse it by.
REAL_DATABASE_PATH: Path = (Path(appdb.PROJECT_ROOT) / appdb.DB_FILENAME).resolve()

#: The store, as the guard has to refuse it: the file **and its WAL sidecars**.
#: ``appdb`` calls them part of the store — they hold committed bytes and the
#: write-ahead index — so a test that could open ``nojae.db-wal`` could damage a
#: developer's settings through a door that does not go near the main file. The
#: names are spelled here rather than taken from ``appdb.sidecar_paths()``,
#: because that function answers about the *patched* root the moment a fixture
#: has moved it, and this tuple must keep naming the real one.
REAL_STORE_PATHS: Tuple[Path, ...] = (
    REAL_DATABASE_PATH,
    *(
        Path(f"{REAL_DATABASE_PATH}{suffix}").resolve()
        for suffix in appdb.WAL_SIDECAR_SUFFIXES
    ),
)

#: Every database this process **opened** — recorded after the guard's check, so
#: an attempt it refused is not in here, because it never reached the driver.
#: ``tests/test_store_hermeticity.py`` reads it: "never opened" is only
#: assertable if the opens are kept, and a trail that recorded a poisoned call
#: the test made on purpose would make "none of these is the install's file"
#: false for the very case that exists to prove the guard works. The trail's own
#: liveness is asserted separately, so the emptiness of a refused call cannot
#: hide behind an assertion that passes on nothing.
SQLITE_OPENS: List[str] = []


def opened_path(raw: Any, *, relative_to_cwd: bool = True) -> Optional[Path]:
    """The file a driver or ``open`` argument names, or ``None`` for no file.

    Both spellings the app uses are handled: the plain path, and the ``file:``
    URI :func:`src.core.appdb._uri` builds (percent-encoded, with a ``?mode=``
    query on the end). ``url2pathname`` is the platform's own converter, so the
    Windows ``file:///C:/...`` form resolves here exactly as SQLite opens it.

    ``relative_to_cwd`` is whether a *relative* name can be judged at all, and
    it differs by event — which is why the caller passes it rather than this
    function guessing:

    * ``sqlite3.connect`` resolves a relative filename against the process's own
      working directory, so resolving it the same way is the faithful answer.
    * the ``open`` event carries ``(path, mode, flags)`` and **no ``dir_fd``**,
      so a relative name there is relative to a directory this hook cannot see,
      and guessing the CWD is wrong in the way that matters: pytest's own
      temp-dir cleanup walks a leftover ``nojae.db`` with
      ``os.open(name, ..., dir_fd=...)``, which would then resolve to *this*
      checkout's file and refuse a file the guard has no business refusing.

    Nothing is lost for the store itself: :func:`src.core.appdb.database_path`
    is built from a resolved ``PROJECT_ROOT``, so every path the app hands the
    driver is absolute, and an absolute name is judged on both events.
    """
    if isinstance(raw, int):
        # ``open`` with a dir_fd: the path is relative to a handle this process
        # already holds, which is not how the store is ever reached.
        return None
    text = str(raw)
    if text.startswith("file:"):
        text = url2pathname(urlsplit(text).path)
    if text in ("", ":memory:"):
        # The driver's two names for "not a file": an anonymous temporary
        # database and an in-memory one.
        return None
    if not relative_to_cwd and not Path(text).is_absolute():
        return None
    return Path(text).expanduser().resolve()


def refuse_the_real_store(target: Optional[Path]) -> None:
    """The guard's one question, as a function a test can feed a poisoned path.

    Raises rather than returning a verdict, because the caller is an audit hook
    on the open itself: the only answer that keeps the file unopened is an
    exception out of the call that would open it.
    """
    if target is not None and target in REAL_STORE_PATHS:
        raise RuntimeError(
            "the test suite may not open nojae's own settings store at "
            f"{target}: tests/conftest.py gives every test a temporary "
            "database (appdb-04), so reaching this path means the harness was "
            "bypassed."
        )


def store_guard_audit_hook(event: str, args: Tuple[Any, ...]) -> None:
    """Refuse the install's own database, at the open and at the create.

    Both events, because :func:`src.core.appdb.prepare` creates the file with
    ``os.open`` *before* it connects: a guard on the connect alone would let a
    bypassed harness leave the developer's file behind. The open event's name is
    ``open``, not ``os.open`` — it is the event ``os.open`` and ``open()`` both
    fire, so a hook keyed on the function's name would never run and the create
    would go unwatched. The hook cannot be removed once installed — which is the
    point: it is not a ``monkeypatch``, so a test's ``undo()`` cannot lift it
    (the leak ``conftest._hermetic`` exists for is exactly this one).

    The one spelling left unjudged is a **relative** name on the ``open`` event,
    which the event cannot answer (see :func:`opened_path`). That costs nothing
    the app can spend: the store is reached only through ``appdb``, whose path
    comes from a resolved ``PROJECT_ROOT``, and a relative name handed to
    ``sqlite3.connect`` — the half that would read or write the rows — *is*
    judged. Refusing a relative name here would instead refuse every unrelated
    ``nojae.db`` the runner walks, which is a guard that reports the harness as
    the leak.
    """
    if event not in ("sqlite3.connect", "open") or not args:
        return
    raw = args[0]
    if event == "sqlite3.connect":
        target = opened_path(raw)
    elif isinstance(raw, int) or appdb.DB_FILENAME not in str(raw):
        # ``open`` fires for every file the process touches, pytest's own
        # included, so the cheap name test comes first: resolving a path per
        # open would make the guard the slowest thing in the suite.
        return
    else:
        target = opened_path(raw, relative_to_cwd=False)
    refuse_the_real_store(target)
    if event == "sqlite3.connect":
        SQLITE_OPENS.append(str(raw))


# Installed once, at import, and **never removed**: an audit hook cannot be
# uninstalled (there is no ``sys.getaudithooks`` to find it with, by design),
# which is exactly the property the guard needs — it is not a ``monkeypatch``,
# so a test's ``undo()`` cannot lift it. That is the leak
# ``tests/test_env_isolation.py``'s last class is about, closed here for the
# store. ``conftest`` is imported once per run, so the hook is installed once;
# a second install would cost nothing anyway, since the check it performs is
# idempotent.
sys.addaudithook(store_guard_audit_hook)


@pytest.fixture(autouse=True)
def _every_test_gets_its_own_store(_hermetic: pytest.MonkeyPatch,
                                   tmp_path: Path) -> Iterator[Path]:
    """A test-owned temporary database, created and seeded, for every test.

    The store's path is the install root's, so without this pin the app's
    lifespan would bring up — and seed — a real ``nojae.db`` in this checkout on
    every suite run. The move is the one the module itself offers: patching
    ``appdb.PROJECT_ROOT`` moves every path answer the module has, because
    :func:`src.core.appdb.database_path` is where all of them are built.

    It then **boots** the store, so a test starts from what a first boot leaves:
    the four built-in agents (``todoBuilder`` readonly and capped at 500, the
    other three capped at 25, every ``model_id`` null) and nine empty
    prompt-helper rows, and no server or model
    (§4.3). A test that wants a connection calls :func:`neutralise_store`; one
    that wants an agent with **no** model clears that row's ``model_id`` itself,
    which is the only way that state is reachable (D14).

    The root is a **sibling** of ``tmp_path`` rather than a folder inside it:
    several suites pin that a folder they point at stayed empty
    (``assert list(workspace.iterdir()) == []`` is how "a reader never writes" is
    checked), so a guard folder of the fixture's own would falsify the assertion
    those tests exist to make.
    """
    root = store_guard_root(tmp_path)
    root.mkdir(exist_ok=True)
    _hermetic.setattr(appdb, "PROJECT_ROOT", root)
    # A thread's handle is opened *at* a path, so it must not outlive the test
    # that made it: the next one's store is a different file.
    appdb.close_thread_connection()
    state = appdb.boot()
    assert state["state"] == "ok", (
        "the suite's temporary store did not come up: "
        f"{state['sentence'] or state['path']}"
    )
    try:
        yield root
    finally:
        appdb.close_thread_connection()


@pytest.fixture(autouse=True)
def _no_ambient_path_location(
    _hermetic: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """Keep the working location off this checkout for every test.

    The store is install-scoped, so it is the guard above that keeps a test off
    this machine's servers, agents and key (D11). The **working location** is
    still the developer's own, though: it decides where ``AGENTS.md`` is read
    from, where the hubs' declaration files are looked for, and where the e2e
    suite's connection fixture lives. So unless a test names its own location it
    gets a fresh folder rather than this checkout, and every one of those lookups
    can only find a file that test wrote.

    A test that picks its own location (the folder's own style,
    ``monkeypatch.setenv("NOJAE_PATH_LOCATION", str(tmp_path))``) overrides this,
    because its own fixture or body runs later; one that deliberately clears the
    key asks for the boot default and gets it. ``tests/conftest`` is the only
    place this is done, and ``tests/test_env_isolation.py`` is the invariant
    stated as a test rather than trusted as a fixture.

    The throw-away root is a **sibling** of ``tmp_path``, for the reason the
    fixture above gives for the same choice.
    """
    from src import config as config_module

    root = workspace_guard_root(tmp_path)
    root.mkdir(exist_ok=True)
    _hermetic.setenv(config_module.PATH_LOCATION_KEY, str(root))


@pytest.fixture(autouse=True)
def _no_debug_switch_leak(_hermetic: pytest.MonkeyPatch) -> Iterator[None]:
    """Keep the LLM debug switch off, and process state clean, for every test.

    Two leaks would make that switch machine-dependent otherwise:
    ``create_app()`` loads the developer's own ``.env`` (which may carry
    ``LLM_DEBUG``, or the legacy key it falls back to), and ``save_settings``
    writes the key straight into ``os.environ``, which ``monkeypatch`` never
    undoes. The switch itself also mutates what no fixture can undo on its own —
    the level and handler of the ``nojae.llm`` logger, and the payload
    hook of ``core/llmkit/client``, which an app boot re-points at ``config``.

    So both keys are cleared up front, and the logger and the hook are handed
    back as they were found — except the handler the switch itself attaches,
    which is the switch's own state to rebuild and must not come back bound to a
    stream that has since gone (and never without the ``propagate`` off that
    belongs to it). Without this, a test asserting the client's hook defaults to
    off would pass or fail on the order the settings tests ran in.
    """
    from src import config as config_module
    from src.core.llmkit import client as llmkit_client
    from src.core.llmkit import constants as llmkit_constants

    logger = logging.getLogger(llmkit_constants.DEBUG_LOGGER_NAME)
    saved = (
        logger.level,
        list(logger.handlers),
        logger.propagate,
        llmkit_client.debug_enabled,
    )
    _hermetic.delenv(config_module.LLM_DEBUG_KEY, raising=False)
    _hermetic.delenv(config_module.LEGACY_LLM_DEBUG_KEY, raising=False)
    yield
    level, handlers, propagate, hook = saved
    kept = [
        handler
        for handler in handlers
        if not isinstance(handler, config_module._DebugStreamHandler)
    ]
    logger.setLevel(level)
    logger.handlers[:] = kept
    # The handler being dropped takes its ``propagate = False`` with it: leaving
    # that behind would silence a logger that now has nowhere to write.
    logger.propagate = propagate or len(kept) != len(handlers)
    llmkit_client.debug_enabled = hook


def store_guard_root(tmp_path: Path) -> Path:
    """The throw-away install root :func:`_every_test_gets_its_own_store` pins."""
    return tmp_path.parent / f"{tmp_path.name}-store"


def workspace_guard_root(tmp_path: Path) -> Path:
    """The throw-away working location :func:`_no_ambient_path_location` pins."""
    return tmp_path.parent / f"{tmp_path.name}-workspace"


#: The server name the harness gives the one server row it writes. The store
#: requires a name (``servers.name`` is unique and the dialog lists servers by
#: it, §4.2) while the flat file the harness replaces had none, so the value is the
#: harness's own — no test asserts on it.
TEST_SERVER_NAME = "test-server"

#: The connection a call that names no values gets. The file-shaped helper
#: defaulted to these two; they stay the harness's defaults because no test
#: asserts on them and a case that cares names its own.
DEFAULT_SERVER_URL = "http://test-server:8080/v1"
DEFAULT_MODEL_NAME = "test-model"

#: The member a call site spells → the column that holds it (§4.2 names the
#: columns; the member names are the app's payload names, which is what a call
#: site writes).
_SERVER_MEMBERS: Dict[str, str] = {
    "serverUrl": "url",
    "serverApiKey": "api_key",
}

_MODEL_MEMBERS: Dict[str, str] = {
    "endpoint": "name",
    "sysprompt": "sys_prompt",
    "temperature": "temperature",
    "topP": "top_p",
    "topK": "top_k",
    "minP": "min_p",
    "repeatPenalty": "repeat_penalty",
    "presencePenalty": "presence_penalty",
    "reasoning": "reasoning",
    "supportsVision": "supports_vision",
}

#: The values the six samplers and the prompt default to when a call site names
#: none — today's file template's numbers, kept so a case that only wants "some
#: configured connection" measures what it used to.
DEFAULT_CONNECTION: Dict[str, Any] = {
    "sysprompt": "You are a helpful assistant.",
    "temperature": 0.2,
    "topP": 0.95,
    "topK": 20,
    "minP": 0,
    "repeatPenalty": 1.0,
    "presencePenalty": 0,
    "reasoning": "off",
    "supportsVision": False,
}


def _store_values(members: Mapping[str, Any]) -> Dict[str, Any]:
    """The defaults, with the caller's overrides on top."""
    raw = dict(DEFAULT_CONNECTION)
    raw["serverUrl"] = DEFAULT_SERVER_URL
    raw["serverApiKey"] = ""
    raw["endpoint"] = DEFAULT_MODEL_NAME
    raw.update(members)
    return raw


def write_store_connection(root: Path, **members: Any) -> Path:
    """Say "the model connection is these values", as **rows**.

    The suite's way of saying "the connection is these values": it takes the
    members a call site spells (a server URL, a key, a model name, the samplers,
    and — for a case that wants one — ``maxToolIteration``) and writes one
    ``servers`` row with one ``models`` row under it, pointing **every** agent
    row at that model. That last part is D14's step 3 and the reason a turn can
    run at all under D5: an agent with no model refuses.

    ``maxToolIteration`` is a per-agent column (D9), so it lands on every agent
    row rather than on a connection — which is where the cap lives now.

    Returns ``root``, the working location the rows belong to, so a call site
    that chains (``neutralise_store`` does) spells the store's home once. The
    rows themselves come back through :func:`src.core.appdb`'s reads.
    """
    raw = _store_values(members)

    conn = appdb.connection()
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("DELETE FROM models")
        conn.execute("DELETE FROM servers")
        columns = ["name", *(_SERVER_MEMBERS[member] for member in _SERVER_MEMBERS)]
        cursor = conn.execute(
            f"INSERT INTO servers ({', '.join(columns)}) VALUES "
            f"({', '.join(['?'] * len(columns))})",
            [TEST_SERVER_NAME, *(raw[member] for member in _SERVER_MEMBERS)],
        )
        server_id = int(cursor.lastrowid or 0)
        model_values: Dict[str, Any] = {
            column: raw[member]
            for member, column in _MODEL_MEMBERS.items()
            if member in raw
        }
        model_values["supports_vision"] = 1 if raw.get("supportsVision") else 0
        columns = ["server_id", *model_values]
        placeholders = ", ".join(["?"] * len(columns))
        cursor = conn.execute(
            f"INSERT INTO models ({', '.join(columns)}) VALUES ({placeholders})",
            [server_id, *model_values.values()],
        )
        model_id = int(cursor.lastrowid or 0)
        statement = "UPDATE agents SET model_id = ?"
        params: List[Any] = [model_id]
        if isinstance(raw.get("maxToolIteration"), int):
            statement += ", max_tool_iteration = ?"
            params.append(max(1, int(raw["maxToolIteration"])))
        conn.execute(statement, params)
        conn.execute("COMMIT")
    except Exception:
        appdb._rollback(conn)
        raise
    return root


def clear_agent_model(agent_id: str) -> None:
    """Put one agent row back to **no model**, deliberately (D14's closing note).

    The harness pins every agent to the model it writes, because D5 made "the
    agent has a model" the only way a turn can run — so the state a test of the
    refusal or the composer's warning needs is reachable *only* by clearing this
    column, which is what makes it a fixture rather than an accident.
    """
    conn = appdb.connection()
    conn.execute("UPDATE agents SET model_id = NULL WHERE id = ?", (agent_id,))


def write_agent_row(agent_id: str, label: str = "", **columns: Any) -> None:
    """Plant one ``agents`` row, so a mode declared outside the store resolves.

    Until the agents table is the modes source (task 10), a mode can be declared
    in the workspace's modes file. D7 asks the **row** which model a turn runs
    on, so a mode with no row is an agent with no model — and refuses. A test
    that wants such a mode to chat therefore plants the row, which is what a
    seeded store already has for the four built-ins.

    ``columns`` are the schema's own names; ``model_id`` defaults to the single
    model the harness wrote, so a caller that only cares about the persona does
    not have to spell it.
    """
    conn = appdb.connection()
    values: Dict[str, Any] = {
        "id": agent_id,
        "label": label or agent_id.title(),
        "max_tool_iteration": appdb.SEEDED_MAX_TOOL_ITERATION,
        "mcp_enable": columns.pop("mcp_enable", 1),
        "lsp_enable": columns.pop("lsp_enable", 0),
        "system_message": columns.pop("system_message", ""),
        "readonly": columns.pop("readonly", 0),
        "model_id": columns.pop("model_id", None),
    }
    values.update(columns)
    if values["model_id"] is None:
        models = conn.execute("SELECT id FROM models ORDER BY id").fetchall()
        if len(models) == 1:
            values["model_id"] = int(models[0][0])
    names = list(values)
    conn.execute(
        f"INSERT INTO agents ({', '.join(names)}) VALUES "
        f"({', '.join(['?'] * len(names))})",
        [values[name] for name in names],
    )


def clear_store_connection() -> None:
    """Remove every server and model, leaving every agent unrunnable.

    The state an unconfigured install is in (D5): four agents and no models. A
    test that wants "the store holds nothing to run" asks this rather than
    writing a fresh database, so it keeps the agents the boot seeded.
    """
    conn = appdb.connection()
    conn.execute("BEGIN IMMEDIATE")
    try:
        conn.execute("DELETE FROM models")
        conn.execute("DELETE FROM servers")
        conn.execute("UPDATE agents SET model_id = NULL")
        conn.execute("COMMIT")
    except Exception:
        appdb._rollback(conn)
        raise


def neutralise_store(
    monkeypatch: pytest.MonkeyPatch,
    root: Path,
    absent: bool = False,
    agents_without_model: Tuple[str, ...] = (),
    **members: Any,
) -> Path:
    """Point the connection lookups at ``root``, on rows this test owns.

    For the test or fixture that owns its own working root: the autouse
    :func:`_every_test_gets_its_own_store` already gives every test a temporary
    database, and this adds the location pin plus the rows the connection is
    made of.

    By default the write is a *configured* connection
    (:func:`write_store_connection` — the defaults plus ``members``), because a
    test about values needs values. ``absent=True`` writes nothing at all, which
    is how a test asks what an unconfigured install answers: no server, no
    model, and every agent left with a null ``model_id`` — the state D7 refuses
    with one sentence naming the agent. ``agents_without_model`` is the same
    state for one row of a configured store, spelled as an argument.
    """
    from src import config as config_module

    monkeypatch.setenv(config_module.PATH_LOCATION_KEY, str(root))
    if absent:
        clear_store_connection()
    else:
        write_store_connection(root, **members)
    for agent_id in agents_without_model:
        clear_agent_model(agent_id)
    return root


@pytest.fixture(autouse=True)
def _pane_shell_is_the_apps_default(_hermetic: pytest.MonkeyPatch) -> None:
    """Pin the terminal pane's shell to the app's own default for every test.

    On POSIX the pane runs ``$SHELL`` when it names an executable program
    (:mod:`src.core.termhub.shells`), so the suite would otherwise drive each
    test shell in whatever the developer has as a login shell — and a configured
    interactive shell loads that developer's own startup files. A zsh with a
    prompt theme was measured to swallow a keystroke of whatever it types first
    (here, the redraw ate the ``s`` of ``sleep`` in the command a tree test
    types), so a session assertion can fail on one machine and pass on another.
    Same class as the cap leak above: the environment, not the code, decides the
    outcome.

    Clearing the key asks the selection seam its documented POSIX question,
    whose answer is the fallback shell — no test computes a path. It is *not* a
    skip condition: every platform's own answer still runs (Windows names Git
    Bash and ignores this key entirely), and a runner that offers no fallback
    keeps skipping with the seam's own sentence through ``shell_probe``.
    """
    _hermetic.delenv(termhub_shells.constants.SHELL_KEY, raising=False)
    # The probe caches its verdict for the session, and the markers consult it;
    # a verdict taken from the ambient shell is the machine's, not this test's.
    shell_probe.clear_verdict()
