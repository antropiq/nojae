"""Tests for the Editor tab's terminal surface: the WebSocket PTY bridge and the
session registry.

Every test runs in a throw-away ``tmp_path`` workspace, entered as the seam's
scope (the ``test_editorfs``/``test_batch`` pattern), so the shell always starts
in a clean directory and no process-wide location decides it. Process tests are gated on the
machine actually offering a session — the refusal guards run unconditionally on
every platform — and the teardown grace is shortened through
``termhub.constants`` so a tree-kill assertion stays quick.

**csl-08: these are the suite's assertions for whichever driver the platform
provides** (C §6). The three guards below are conftest markers over the pane's
own seams: ``needs_shell`` answers what ``termhub.shells.select_shell()``
answers (``$SHELL`` → ``/bin/sh`` on POSIX, ``TERMINAL_SHELL`` → Git Bash on
Windows), ``needs_driver`` what ``termhub.drivers.driver_available()`` answers,
``needs_stty`` whether that shell carries ``stty``. A Windows box with Git and
the ``windows`` extra therefore runs *this file*, unchanged, against a real
pseudo-console; a skip names which capability is absent, quoting the seam's own
refusal. What genuinely is a platform fact is marked, not hidden: the procfs
session-scan half (``posix_behaviour`` — the job-member tree half lives in
``test_terminal_conpty.py``). Liveness never uses ``os.kill(pid, 0)``, which
*kills* what it inspects on Windows: it comes from csl-02's shared probe,
``proctree_jobs.process_is_gone``.
"""

import asyncio
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from tests.conftest import (
    WorkspaceClient,
    driver_probe,
    proc_fs_probe,
    skip_unless,
    scoped,
    workspace_params,
)

from src.api.server import create_app
from src.core import proctree_jobs
from src.core import termhub
from src.core import workspace as workspace_seam
from src.core.termhub import drivers as termhub_drivers
from src.core.termhub import pty_posix

WS_URL = "/api/terminal"
# The probes these markers consult live in tests/conftest.py with the rest of
# the platform guards (win-01's rule; the shell probe was re-targeted by csl-08
# to the terminal's own selection seam): a per-file copy of a probe is how a
# guard drifts from what it guards. A live session needs a shell *and* a driver,
# so a class that opens one carries both markers and a skip names which one is
# missing — with the seam's own sentence, which a marker can carry and a
# skipif reason fixed at import time cannot.


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    return tmp_path


@pytest.fixture
def client(workspace: Path):
    with TestClient(create_app()) as test_client:
        yield WorkspaceClient(test_client, workspace)


@pytest.fixture
def fast_grace(monkeypatch: pytest.MonkeyPatch) -> None:
    """Shorten the SIGTERM→SIGKILL grace so teardown tests stay quick."""
    monkeypatch.setattr(termhub.constants, "STOP_GRACE_SECONDS", 1.0)


@pytest.fixture
def hidden_driver_probes():
    """Answer "no driver" through the seam's own probes, then hand them back.

    The ``DRIVER_ABSENT_FORCED`` flag hides the seam's *answer*; patching the
    two probes ``selected_driver()`` asks is the Windows-driverless state
    forced on any runner (roadmap §9 rule 2): here no driver module is
    selected at all, exactly as on a Windows box without the ``windows`` extra.

    The patches are undone here rather than through ``monkeypatch`` on purpose:
    ``monkeypatch`` is finalised *after* a fixture that depends on it, so a
    post-``yield`` check written here would still be looking at the patched
    seam. The cache is cleared on both sides, and the answer is asserted once
    the seam is live again — a following terminal test that spawns a real shell
    proves the same thing a second time (csl-08 criterion 6).
    """
    posix_probe_was = termhub_drivers._posix_driver
    windows_probe_was = termhub_drivers._windows_driver
    seam_had_a_driver = bool(driver_probe)
    driver_probe.clear_verdict()
    termhub_drivers._posix_driver = lambda: None
    termhub_drivers._windows_driver = lambda: None
    try:
        yield
    finally:
        termhub_drivers._posix_driver = posix_probe_was
        termhub_drivers._windows_driver = windows_probe_was
        driver_probe.clear_verdict()
        assert bool(driver_probe) is seam_had_a_driver, (
            "the hidden-driver test left the driver seam changed — a following "
            "terminal test would gate on this test's patch, not the machine"
        )


def open_session(client: TestClient, **kwargs):
    """Connect and read the ``open`` frame, returning the live session."""
    session = client.websocket_connect(WS_URL, **kwargs)
    session.__enter__()
    frame = session.receive_json()
    assert frame["type"] == "open", frame
    return session


def open_session_in(client: TestClient, root: Any, **kwargs):
    """A socket naming ``root``, and the ``open`` frame it answered.

    The socket's query string is the only place a folder is named for a
    terminal (spec §8: it has no per-request body), and the field is spelled by
    the harness's helper, never here.
    """
    session = client.websocket_connect(WS_URL, params=workspace_params(root), **kwargs)
    session.__enter__()
    frame = session.receive_json()
    assert frame["type"] == "open", frame
    return session, frame


def read_until(session, marker: str, frames: int = 60) -> str:
    """Accumulate ``output`` frames until ``marker`` shows up (or the budget ends)."""
    seen = ""
    for _ in range(frames):
        frame = session.receive_json()
        if frame["type"] == "output":
            seen += frame["data"]
            if marker in seen:
                break
    return seen


def cwd_probe(root: Path, label: str) -> Tuple[str, str]:
    """``(command, answer)`` proving a shell sitting in ``root``.

    The proof is a **relative** read: a file holding ``label`` is planted in
    ``root``, so the answer can only come from a process whose cwd is that
    folder. Nothing here asks the shell to spell a path, which is the part that
    cannot survive the pane's own choice of program — Git Bash answers ``pwd``
    with the MSYS spelling (``/c/temp/x``) of the one folder, while the test
    planted and the seam reports the Windows spelling (``C:\\temp\\x``). One
    folder, two spellings, and a marker no output can ever contain: the read
    then blocks on the frame that never comes.

    The wrapped markers keep the original guard against matching the **echoed
    command line** — what is matched is the expansion's result, and the typed
    line carries the unexpanded text.
    """
    (root / f"{label}.cwd-probe").write_text(label, encoding="utf-8", newline="")
    command = f'echo "::$(cat {label}.cwd-probe)::"\r'
    return command, f"::{label}::"


def wait_until(predicate, timeout=4.0, step=0.05) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        if predicate():
            return True
        time.sleep(step)
    return predicate()


def pid_gone(pid: Optional[int]) -> bool:
    """Is that pid no longer a live process? csl-02's shared cross-platform probe.

    This used to read ``/proc`` directly, which made every liveness assertion
    here vacuous on Windows. The shared probe answers ``/proc``'s state there
    too — a zombie counts as gone, it is dead and only still holds a name — and
    the OS's own exit-code answer on Windows. Nothing may use
    ``os.kill(pid, 0)``: on Windows CPython turns that into
    ``TerminateProcess`` and the probe kills what it meant to inspect.
    """
    return proctree_jobs.process_is_gone(pid)


class TestGuards:
    """Refusals that must happen before any process is spawned."""

    def test_foreign_origin_is_refused_without_spawning(self, client):
        # The refusal is a close before accept, which surfaces from __enter__.
        with pytest.raises(WebSocketDisconnect) as caught:
            with client.websocket_connect(
                WS_URL, headers={"Origin": "https://evil.example"}
            ):
                pass
        assert caught.value.code == termhub.CLOSE_CODE_POLICY
        assert client.get(WS_URL).json() == {"sessions": []}

    # The two that open a real session answer to the same two capability probes
    # as every other session test: on a machine with no driver (Windows without
    # the ``windows`` extra) the route refuses *after* accepting, and an
    # assertion about an accepted session is not a skip with a sentence.
    @pytest.mark.parametrize(
        "origin", ["http://127.0.0.1:5173", "http://localhost:8000", "http://[::1]:8000"]
    )
    @pytest.mark.needs_shell
    @pytest.mark.needs_driver
    def test_local_origin_is_allowed(self, client, origin, fast_grace):
        session = open_session(client, headers={"Origin": origin})
        try:
            assert session is not None
        finally:
            session.__exit__(None, None, None)

    @pytest.mark.needs_shell
    @pytest.mark.needs_driver
    def test_no_origin_is_allowed(self, client, fast_grace):
        # A deliberately-launched local client (wscat) sends no Origin. The
        # session must be closed, or its portal thread outlives the test and
        # hangs the suite.
        session = open_session(client)
        try:
            assert session is not None
        finally:
            session.__exit__(None, None, None)


class TestTheShellIsBornInItsTabsFolder:
    """clws-07: a socket names a folder, and that folder is the shell's ``cwd``.

    The terminal is the one surface with no per-request body, so its workspace
    arrives **when the socket opens** (spec §8). Everything here is that one
    fact and its limit: two sockets naming two folders are two shells in two
    folders, at once, and neither moves when the other's tab re-points — "a live
    shell keeps the folder it was born in".

    The registry is deliberately *not* per workspace (spec §3.1: "the registry is
    shared"), so both sessions live in the one map and the cap stays the app's.
    """

    @pytest.mark.needs_shell
    @pytest.mark.needs_driver
    def test_two_sockets_name_two_folders_and_spawn_two_shells_there(
        self, client, tmp_path: Path, fast_grace
    ):
        first = tmp_path / "project-alpha"
        second = tmp_path / "project-beta"
        first.mkdir()
        second.mkdir()

        left, left_frame = open_session_in(client, first)
        try:
            right, right_frame = open_session_in(client, second)
            try:
                # The frame the pane renders, and the folder the *process* got:
                # each shell reads a marker out of its own folder, so the answer
                # can only have come from a shell born there — and neither
                # answer can be the other's.
                assert left_frame["cwd"] == str(first)
                assert right_frame["cwd"] == str(second)
                left_command, left_answer = cwd_probe(first, "alpha")
                right_command, right_answer = cwd_probe(second, "beta")
                left.send_json({"type": "input", "data": left_command})
                right.send_json({"type": "input", "data": right_command})
                assert left_answer in read_until(left, left_answer)
                assert right_answer in read_until(right, right_answer)

                # One registry, both sessions, each reporting its own folder.
                rows = {row["cwd"]: row for row in client.get(WS_URL).json()["sessions"]}
                assert set(rows) == {str(first), str(second)}
                assert rows[str(first)]["pid"] != rows[str(second)]["pid"]
            finally:
                right.__exit__(None, None, None)
        finally:
            left.__exit__(None, None, None)

    @pytest.mark.needs_shell
    @pytest.mark.needs_driver
    def test_a_live_shell_keeps_the_folder_it_was_born_in(
        self, client, tmp_path: Path, fast_grace
    ):
        """A later socket naming another folder moves neither process nor row."""
        first = tmp_path / "stays-here"
        second = tmp_path / "the-other-tab"
        first.mkdir()
        second.mkdir()

        def identity_rows(root: Path) -> List[Dict[str, Any]]:
            """The session rows in ``root``, minus what a live shell advances.

            ``bytesOut`` is a running total, so it legitimately grows between two
            reads; the fields that must never move are the id, the pid, the
            ``cwd`` and the moment it started.
            """
            return [
                {key: row[key] for key in ("id", "pid", "cwd", "startedAt")}
                for row in client.get(WS_URL).json()["sessions"]
                if row["cwd"] == str(root)
            ]

        left, left_frame = open_session_in(client, first)
        try:
            before = identity_rows(first)
            assert before, "the first shell was not listed in its own folder"

            # Another tab's socket, naming another folder. Nothing about the
            # first session may move — no re-root, no kill, no relaunch.
            right, _frame = open_session_in(client, second)
            try:
                after = identity_rows(first)
                assert after == before
                assert left_frame["cwd"] == str(first)
                # And the live shell still answers, in the folder it was born
                # in — the marker it reads is the one planted there.
                command, answer = cwd_probe(first, "stays")
                left.send_json({"type": "input", "data": command})
                assert answer in read_until(left, answer)
            finally:
                right.__exit__(None, None, None)
        finally:
            left.__exit__(None, None, None)

    @pytest.mark.needs_shell
    @pytest.mark.needs_driver
    def test_a_new_socket_for_the_same_tab_starts_in_the_new_folder(
        self, client, tmp_path: Path, fast_grace
    ):
        """The pane's own reconnect: a **new** shell follows the tab."""
        first = tmp_path / "before-the-move"
        second = tmp_path / "after-the-move"
        first.mkdir()
        second.mkdir()

        before, _frame = open_session_in(client, first)
        before.__exit__(None, None, None)
        assert wait_until(lambda: client.get(WS_URL).json() == {"sessions": []})

        after, frame = open_session_in(client, second)
        try:
            assert frame["cwd"] == str(second)
        finally:
            after.__exit__(None, None, None)

    @pytest.mark.needs_shell
    @pytest.mark.needs_driver
    def test_the_registry_reports_each_sessions_own_cwd(
        self, client, tmp_path: Path, fast_grace
    ):
        """``GET /api/terminal`` is every session's row, each naming its folder."""
        roots = []
        for name in ("one", "two"):
            root = tmp_path / name
            root.mkdir()
            roots.append(root)
        sessions = []
        try:
            for root in roots:
                session, frame = open_session_in(client, root)
                sessions.append(session)
                assert frame["cwd"] == str(root)
            listed = client.get(
                WS_URL, params=workspace_params(roots[0])
            ).json()["sessions"]
            assert sorted(row["cwd"] for row in listed) == sorted(str(r) for r in roots)
        finally:
            for session in sessions:
                session.__exit__(None, None, None)


class TestARefusedFolderSpawnsNothing:
    """Spec §5.2 rules 10–12 on the socket: one sentence, no process, no slot.

    The refusal is the seam's own words — the same ones the 422 routes answer —
    so the pane shows what every other surface would have said. It arrives
    **before** a session is reserved, so the registry and the cap see nothing.
    """

    @staticmethod
    def _refusal(root: Any) -> str:
        """The sentence the seam answers for ``root`` — never a second spelling."""
        _workspace, sentence = workspace_seam.resolve(str(root))
        assert sentence is not None
        return sentence

    def test_a_socket_that_names_no_workspace_is_refused_in_the_seams_words(
        self, client
    ):
        """The socket has no default folder either (clws-10).

        The field is the socket's query string (spec §8); absent, it draws the
        same empty-name sentence every HTTP workspace-scoped route answers, in
        the pane's ``error`` frame and as the bounded close reason. The raw
        client is used deliberately: the suite's wrapper would add the field.
        """
        with client.http.websocket_connect(WS_URL) as socket:
            assert socket.receive_json() == {
                "type": "error",
                "message": workspace_seam.EMPTY_REFUSAL,
            }
            with pytest.raises(WebSocketDisconnect) as caught:
                socket.receive_json()
        assert caught.value.code == termhub.CLOSE_CODE_POLICY
        assert caught.value.reason == termhub.close_reason(
            workspace_seam.EMPTY_REFUSAL
        )

    def test_a_missing_folder_closes_with_the_seams_sentence(
        self, client, tmp_path: Path
    ):
        ghost = tmp_path / "not-a-project"
        sentence = self._refusal(ghost)
        with client.websocket_connect(
            WS_URL, params=workspace_params(ghost)
        ) as socket:
            frame = socket.receive_json()
            assert frame == {"type": "error", "message": sentence}
            with pytest.raises(WebSocketDisconnect) as caught:
                socket.receive_json()
        # The policy close code (the same one a refused Origin gets) and the
        # seam's sentence as the reason, bounded to what a close frame may hold.
        assert caught.value.code == termhub.CLOSE_CODE_POLICY
        assert caught.value.reason == termhub.close_reason(sentence)
        assert sentence.startswith(caught.value.reason)

    @pytest.mark.parametrize("raw", ["relative/name", ""], ids=["relative", "empty"])
    def test_the_other_refusals_answer_the_same_way(self, client, raw: str):
        sentence = self._refusal(raw)
        with client.websocket_connect(WS_URL, params={"workspace": raw}) as socket:
            assert socket.receive_json() == {"type": "error", "message": sentence}
            with pytest.raises(WebSocketDisconnect) as caught:
                socket.receive_json()
        assert caught.value.code == termhub.CLOSE_CODE_POLICY
        assert caught.value.reason == termhub.close_reason(sentence)

    def test_a_refused_folder_spawns_no_process_and_takes_no_slot(
        self, client, tmp_path: Path
    ):
        """The registry and the cap are untouched by a refusal."""
        hub = client.app.state.terminal
        before = (hub.count(), client.get(WS_URL).json()["sessions"])
        assert before == (0, [])

        with client.websocket_connect(
            WS_URL, params=workspace_params(tmp_path / "no-such-folder")
        ) as socket:
            socket.receive_json()
            with pytest.raises(WebSocketDisconnect):
                socket.receive_json()

        assert hub.count() == 0
        assert client.get(WS_URL).json() == {"sessions": []}

    def test_the_workspace_guard_comes_before_the_cap(
        self, client, monkeypatch, tmp_path: Path
    ):
        """The pinned guard order: origin, workspace, driver, cap.

        With the cap at zero a refused folder still answers the **workspace**
        refusal, so the pane is told which folder is wrong rather than that the
        app is full.
        """
        monkeypatch.setattr(termhub.constants, "MAX_SESSIONS", 0)
        ghost = tmp_path / "no-such-folder"
        with client.websocket_connect(
            WS_URL, params=workspace_params(ghost)
        ) as socket:
            frame = socket.receive_json()
            assert frame["message"] == self._refusal(ghost)
            with pytest.raises(WebSocketDisconnect) as caught:
                socket.receive_json()
        assert caught.value.code == termhub.CLOSE_CODE_POLICY

    def test_a_long_folder_name_still_reaches_the_peer_as_a_reason(
        self, client, tmp_path: Path
    ):
        """A refusal names the folder, and a folder name can be long.

        A close reason is capped at 123 bytes by the protocol; over it, the
        frame cannot be serialized and the peer sees a bare 1006 with nothing to
        show. The bounded reason keeps the code and the start of the sentence.
        """
        # Long, and **absent**: the sentence names it, which is what makes it
        # longer than a close reason may be.
        deep = tmp_path / ("nested-" + "x" * 40) / ("project-" + "y" * 60)
        sentence = self._refusal(deep)
        assert len(sentence.encode()) > termhub.MAX_CLOSE_REASON_BYTES
        with client.websocket_connect(
            WS_URL, params=workspace_params(deep)
        ) as socket:
            # The frame carries the whole sentence; only the close reason is cut.
            assert socket.receive_json()["message"] == sentence
            with pytest.raises(WebSocketDisconnect) as caught:
                socket.receive_json()
        assert caught.value.code == termhub.CLOSE_CODE_POLICY
        assert caught.value.reason
        assert caught.value.reason == termhub.close_reason(sentence)
        assert len(caught.value.reason.encode()) <= termhub.MAX_CLOSE_REASON_BYTES
        assert sentence.startswith(caught.value.reason)

    def test_the_listing_refuses_the_same_folder_the_same_way(
        self, client, tmp_path: Path
    ):
        """``GET /api/terminal`` is workspace-scoped like every other route."""
        ghost = tmp_path / "not-a-project"
        response = client.get(WS_URL, params=workspace_params(ghost))
        assert response.status_code == 422
        assert response.json()["detail"] == self._refusal(ghost)


class TestTheCloseReasonStaysInsideTheProtocol:
    """A refusal sentence names a folder, and the protocol caps a close reason.

    ``termhub.close_reason`` is the one place that bound is applied, so what is
    asserted here is the rule itself rather than one route's luck: a reason over
    123 bytes does not serialize, and the peer then sees a bare 1006 close with
    no sentence at all.
    """

    def test_a_short_reason_is_untouched(self):
        text = "Working location must not be empty"
        assert termhub.close_reason(text) == text

    def test_a_long_reason_is_cut_to_the_cap(self):
        text = "Working location is not an existing directory: /" + "a" * 200
        cut = termhub.close_reason(text)
        assert len(cut.encode()) <= termhub.MAX_CLOSE_REASON_BYTES
        assert text.startswith(cut)
        assert cut  # never the empty answer in place of the sentence

    def test_a_multibyte_character_is_never_cut_in_half(self):
        # Every character here is 3 bytes, so the cap lands mid-character unless
        # the boundary is walked back — and a close reason must be valid UTF-8.
        text = "Working location is not an existing directory: /" + "日" * 60
        cut = termhub.close_reason(text)
        assert len(cut.encode()) <= termhub.MAX_CLOSE_REASON_BYTES
        cut.encode("utf-8")  # decoding is the assertion: nothing half-written
        assert text.startswith(cut)


class TestDriverSeam:
    """The refusal ``spawn()`` and the route share (csl-04): the terminal asks
    *"is a driver available?"*, and the driver-absent answer is a **tested**
    behaviour on this runner too — forced through the seam's own patch-point
    (roadmap §9 rule 3), never left as a Windows-only fallback.
    ``monkeypatch`` restores the flag, so later tests keep their driver."""

    def test_hiding_both_driver_probes_refuses_the_way_a_windows_box_does(
        self, client, hidden_driver_probes
    ):
        """The same refusal with the *probes* hidden, not just the flag.

        ``DRIVER_ABSENT_FORCED`` hides the seam's answer; here the seam has to
        ask both drivers and hear no twice — the state of a Windows install
        without the ``windows`` extra — so the selection itself, not just the
        message, is proven on this runner (roadmap §9 rule 2). The fixture's
        tail re-answers the probe, and the session tests that follow spawn a
        real shell, which is the proof the seam came back."""
        assert termhub_drivers.selected_driver() is None
        with client.websocket_connect(WS_URL) as ws:
            frame = ws.receive_json()
            assert frame == {"type": "error", "message": termhub.NO_DRIVER_MESSAGE}
            with pytest.raises(WebSocketDisconnect) as caught:
                ws.receive_json()
        assert caught.value.code == termhub.CLOSE_CODE_UNSUPPORTED
        assert caught.value.reason == termhub.NO_DRIVER_MESSAGE
        assert client.get(WS_URL).json() == {"sessions": []}

    def test_spawn_refuses_without_a_driver(self, monkeypatch):
        monkeypatch.setattr(termhub.constants, "DRIVER_ABSENT_FORCED", True)

        async def emit(event):  # never reached — the refusal precedes any pump
            pass

        session = termhub.TerminalSession(emit)
        with pytest.raises(termhub.TerminalUnsupported) as caught:
            session.spawn(cols=termhub.DEFAULT_COLS, rows=termhub.DEFAULT_ROWS)
        # The sentence is written once (termhub.constants) and names what was
        # looked for; nothing was left behind.
        assert str(caught.value) == termhub.NO_DRIVER_MESSAGE
        assert session.process is None and session.pty is None

    def test_websocket_answers_the_sentence_then_closes_4501(self, client, monkeypatch):
        monkeypatch.setattr(termhub.constants, "DRIVER_ABSENT_FORCED", True)
        # The refusal is accept → one ``error`` frame → 4501, the shape the
        # pane already renders (useTerminal.js needs no change).
        with client.websocket_connect(WS_URL) as ws:
            frame = ws.receive_json()
            assert frame == {"type": "error", "message": termhub.NO_DRIVER_MESSAGE}
            with pytest.raises(WebSocketDisconnect) as caught:
                ws.receive_json()
        assert caught.value.code == termhub.CLOSE_CODE_UNSUPPORTED
        assert caught.value.reason == termhub.NO_DRIVER_MESSAGE
        # The refusal happened before any process: nothing to name.
        assert client.get(WS_URL).json() == {"sessions": []}

    def test_the_driver_guard_comes_before_the_capacity_guard(
        self, client, monkeypatch
    ):
        # The order C §7 pins: origin, driver, capacity. With the cap at zero,
        # a driverless runner still answers 4501 (the missing mechanism),
        # never 4429.
        monkeypatch.setattr(termhub.constants, "DRIVER_ABSENT_FORCED", True)
        monkeypatch.setattr(termhub.constants, "MAX_SESSIONS", 0)
        with client.websocket_connect(WS_URL) as ws:
            ws.receive_json()  # the error frame (accepted, then refused)
            with pytest.raises(WebSocketDisconnect) as caught:
                ws.receive_json()
        assert caught.value.code == termhub.CLOSE_CODE_UNSUPPORTED

    def test_hiding_a_driver_probe_takes_that_driver_out_of_the_seam(
        self, monkeypatch
    ):
        # Selection follows the probe, never the platform's name: pty_posix is
        # the seam's answer exactly while its own availability probe answers,
        # on either runner. Forcing the probe True here selects the module
        # without opening anything (nothing spawns), so the Windows runner can
        # prove the same half the Linux runner proves.
        monkeypatch.setattr(pty_posix, "available", lambda: False)
        assert termhub_drivers.selected_driver() is not pty_posix
        monkeypatch.setattr(pty_posix, "available", lambda: True)
        assert termhub_drivers.selected_driver() is pty_posix


@pytest.mark.needs_shell
@pytest.mark.needs_driver
class TestRegistry:
    """Both need a session that really opens, so both answer to the same two
    capability probes as ``TestSession`` — a refusal to spawn is a skip naming
    the missing capability, never a failing assertion."""

    def test_live_session_is_listed_and_empties_after_teardown(self, client, fast_grace):
        assert client.get(WS_URL).json() == {"sessions": []}
        session = open_session(client)
        listed = client.get(WS_URL).json()["sessions"]
        assert len(listed) == 1
        entry = listed[0]
        assert entry["pid"] and entry["cwd"]
        assert entry["shell"] and isinstance(entry["startedAt"], float)
        session.__exit__(None, None, None)
        assert wait_until(lambda: client.get(WS_URL).json() == {"sessions": []})

    def test_session_cap_refuses_the_next_upgrade(self, client, monkeypatch, fast_grace):
        monkeypatch.setattr(termhub.constants, "MAX_SESSIONS", 1)
        first = open_session(client)
        # The second upgrade is refused before accept: the close surfaces from
        # __enter__, and no shell is spawned for it.
        with pytest.raises(WebSocketDisconnect) as caught:
            with client.websocket_connect(WS_URL):
                pass
        assert caught.value.code == termhub.CLOSE_CODE_CAPACITY
        # Only the first session is registered — the refused one spawned nothing.
        assert len(client.get(WS_URL).json()["sessions"]) == 1
        first.__exit__(None, None, None)

    def test_the_default_cap_refuses_the_fifth_websocket(self, client, fast_grace):
        """C §6's named figure, on the app's own cap rather than a patched one.

        Every session here is a real shell the platform can open, so this runs
        wherever a session does; the fifth upgrade is refused *before* accept
        with 4429 and spawns nothing.
        """
        cap = termhub.constants.MAX_SESSIONS
        sessions = [open_session(client) for _ in range(cap)]
        try:
            assert len(client.get(WS_URL).json()["sessions"]) == cap
            with pytest.raises(WebSocketDisconnect) as caught:
                with client.websocket_connect(WS_URL):
                    pass
            assert caught.value.code == termhub.CLOSE_CODE_CAPACITY
            # The refused socket added no process.
            assert len(client.get(WS_URL).json()["sessions"]) == cap
        finally:
            for session in sessions:
                session.__exit__(None, None, None)
        assert wait_until(lambda: client.get(WS_URL).json() == {"sessions": []})


@pytest.mark.needs_shell
@pytest.mark.needs_driver
class TestSession:
    """C §6's both-platforms list, against whichever driver the platform
    provides: output round-trips, an ``exit`` frame carries the code, the
    window size round-trips through the driver, a ``kill`` frame and a
    disconnect end the shell, and a teardown lands inside the grace."""

    def test_input_produces_output_and_shell_stays_open(self, client, fast_grace):
        session = open_session(client)
        session.send_json({"type": "input", "data": "echo nojae-marker\r"})
        # Read output frames until the marker shows up (the shell echoes and
        # re-prompts, so scan across frames rather than expecting one).
        found = False
        for _ in range(60):
            frame = session.receive_json()
            if frame["type"] == "output" and "nojae-marker" in frame["data"]:
                found = True
                break
        assert found, "no output frame carried the echoed marker"
        # Still open: the registry still lists it.
        assert len(client.get(WS_URL).json()["sessions"]) == 1
        session.__exit__(None, None, None)

    def test_exit_frame_reports_the_code(self, client, fast_grace):
        session = open_session(client)
        pid = next(s["pid"] for s in client.get(WS_URL).json()["sessions"])
        session.send_json({"type": "input", "data": "exit 7\r"})
        frame = None
        for _ in range(60):
            frame = session.receive_json()
            if frame["type"] == "exit":
                break
        assert frame and frame["type"] == "exit"
        assert frame["code"] == 7
        assert wait_until(lambda: pid_gone(pid))
        session.__exit__(None, None, None)

    @pytest.mark.needs_stty
    def test_resize_updates_the_window_size(self, client, fast_grace):
        """The client-side half of the resize: the shell sees the new size.

        csl-06's measurement to keep honest about: on a ConPTY the resize agent
        emits a device-attribute query and swallows keystrokes until the pane
        answers it, so the ``resize`` and the command are deliberately separate
        frames with the shell's first output drained between them — which is
        also how xterm.js sends them.
        """
        session = open_session(client)
        # Drain the prompt the open produced, *then* resize: the two frames must
        # not land in the same tick (see above).
        for _ in range(20):
            frame = session.receive_json()
            if frame["type"] == "output":
                break
        session.send_json({"type": "resize", "cols": 132, "rows": 41})
        time.sleep(0.3)
        session.send_json({"type": "input", "data": "stty size\r"})
        seen = ""
        for _ in range(80):
            frame = session.receive_json()
            if frame["type"] == "output":
                seen += frame["data"]
                if "41 132" in seen:  # `stty size` prints "rows cols"
                    break
        assert "41 132" in seen, f"resize not seen by the shell: {seen[-200:]!r}"
        session.__exit__(None, None, None)

    def test_the_size_the_session_opens_with_round_trips_a_resize(
        self, workspace, fast_grace
    ):
        """The server-side half of the resize, on the platform's own driver.

        C §6's "the first output arrives at the right width (C-D4's *size
        before spawn*)" plus "*``terminal_size()`` round-trips a ``resize``*":
        the pair is opened at the default size and the driver reports that size
        before anything is typed, then the new one after a resize. It is driven
        on the session rather than the socket because the size is the server's
        number — the shell's view of it is the test above.
        """

        async def emit(_event) -> None:  # frames are not what this asserts about
            pass

        session = termhub.TerminalSession(emit)
        session.spawn(
            cols=termhub.constants.DEFAULT_COLS, rows=termhub.constants.DEFAULT_ROWS
        )
        try:
            assert session.terminal_size() == (
                termhub.constants.DEFAULT_COLS,
                termhub.constants.DEFAULT_ROWS,
            ), "the window was not sized before the shell started"
            session.resize(132, 41)
            assert session.terminal_size() == (132, 41)
        finally:
            asyncio.run(session.teardown())

    def test_kill_frame_closes_session_and_kills_pid(self, client, fast_grace):
        session = open_session(client)
        pid = next(s["pid"] for s in client.get(WS_URL).json()["sessions"])
        session.send_json({"type": "kill"})
        assert wait_until(lambda: pid_gone(pid)), f"shell {pid} survived the kill frame"
        assert wait_until(lambda: client.get(WS_URL).json() == {"sessions": []})
        session.__exit__(None, None, None)

    # csl-08's platform-free tree assertion: the *shell* names the backgrounded
    # child, so the test never reaches into procfs to find it.
    #
    # The task's premise was ``$!``; the observation on this lot's Windows shell
    # (measured again here, and recorded by csl-07) is that Git Bash's ``$!`` is
    # an MSYS-namespace pid, which the Windows liveness probe and the job's
    # member list do not know. The premise is kept in the shape it can hold:
    # the shell prints ``$!`` where that *is* the OS pid (Linux), and asks its
    # own ``ps`` for the WINPID column where it is not (MSYS/MINGW/CYGWIN).
    # Either way the number that reaches the frame is one the shared liveness
    # probe can be asked about, and the same test shape runs on both platforms.
    # A failed translation falls back to ``$!``, which the liveness pre-check
    # below then reports loudly rather than letting the test go vacuous.
    CHILD_MARKER = "NOJAE-CHILD-"
    # The space before the `;` after `$!` is what makes this work on macOS, and
    # it costs nothing anywhere else. The pane's shell is an *interactive* one,
    # so bash answers a history-expansion question about every line typed into
    # it, and `$!;` is a designator it cannot resolve: the line is refused
    # outright (`sh: !: event not found`) before the shell ever runs it, so the
    # marker never arrives and this test blocks reading for it. Bash skips the
    # expansion when `!` is followed by whitespace, which `$! ;` is. Linux is
    # unaffected because its /bin/sh is dash, which has no history expansion;
    # the Windows runner is unaffected as observed, whatever its shell's setting
    # -- the space is legal in every POSIX shell, so it is free insurance.
    CHILD_COMMAND = (
        "sleep 40 >/dev/null 2>&1 & c=$! ; "
        "case $(uname) in "
        'MINGW*|MSYS*|CYGWIN*) o=$(ps -aW | awk -v p=$c "\\$1==p {print \\$4}");; '
        "*) o=$c;; "
        f"esac; echo {CHILD_MARKER}${{o:-$c}}\r"
    )

    @skip_unless(
        proc_fs_probe,
        "kills a backgrounded job that leads a process group of its own, which "
        "only the /proc scan that names a session's members can reach (see "
        "proctree.session_members); a job-controlling shell is torn down with "
        "the session, not with its own group",
    )
    def test_disconnect_tears_down_the_whole_session_tree(self, client, fast_grace):
        # The tree-kill assertion, same shape as the hub teardown tests: start a
        # *backgrounded* job, drop the socket, and require the child to die too.
        session = open_session(client)
        session.send_json({"type": "input", "data": self.CHILD_COMMAND})
        child_pid = self.read_child_pid(session)
        # The number the shell printed names a process this runner can see —
        # otherwise the assertion below would be about a pid that never existed
        # (a MSYS pid on Git Bash is exactly that, hence the winpid form).
        assert not pid_gone(child_pid), (
            f"the child pid {child_pid} the shell named is not a live process "
            "here — the printout is not the OS pid the teardown reaches"
        )
        shell_pid = next(s["pid"] for s in client.get(WS_URL).json()["sessions"])
        session.__exit__(None, None, None)  # client disconnect

        assert wait_until(lambda: pid_gone(shell_pid)), "shell survived disconnect"
        assert wait_until(lambda: pid_gone(child_pid), timeout=3.0), (
            f"the backgrounded child {child_pid} the shell named survived the "
            "disconnect — the teardown killed the shell but not its tree"
        )

    def read_child_pid(self, session) -> int:
        """The pid the shell printed for its own backgrounded job."""
        seen = ""
        for _ in range(80):
            frame = session.receive_json()
            if frame["type"] != "output":
                continue
            seen += frame["data"]
            found = re.search(rf"{re.escape(self.CHILD_MARKER)}(\d+)", seen)
            if found:
                return int(found.group(1))
        raise AssertionError(f"the shell never named its child: {seen[-200:]!r}")

    def test_a_teardown_ends_the_pump_inside_the_grace_with_no_leaked_task(
        self, workspace, fast_grace
    ):
        """C §6's grace promise on the platform's own driver and shell.

        Driven through ``run()`` — the loop the route uses — so what is measured
        is the real exit path: a live backgrounded child, a dropped frame
        (disconnect), and the teardown's whole escalation inside the grace the
        app named. ``_finish_pump`` is allowed the extra second it holds for the
        blocked read to return; beyond that the shell's *tree* would be what
        outlives the pane. The reader task having resolved is the "no leaked
        task" half: a task still pending on a driver read is a worker thread
        still reading a descriptor the next session may own.
        """
        grace = termhub.constants.STOP_GRACE_SECONDS

        async def scenario() -> Tuple[str, List[Any]]:
            incoming: asyncio.Queue = asyncio.Queue()

            async def receive_frame():
                return await incoming.get()

            async def emit(_event) -> None:  # frames are not what this asserts
                pass

            session = termhub.TerminalSession(emit)
            session.spawn(
                cols=termhub.constants.DEFAULT_COLS,
                rows=termhub.constants.DEFAULT_ROWS,
            )
            run = asyncio.ensure_future(session.run(receive_frame))
            await incoming.put(
                {"type": "input", "data": "sleep 40 &\r"}
            )
            await asyncio.sleep(0.3)  # the read is genuinely blocked by then
            started = time.monotonic()
            await incoming.put(None)  # the socket drops
            try:
                reason = await asyncio.wait_for(run, timeout=grace + 2.0)
            except (asyncio.TimeoutError, TimeoutError):
                run.cancel()
                pytest.fail(
                    f"the session did not end inside {grace + 2.0}s — the "
                    "teardown never reached the pump on this driver"
                )
            elapsed = time.monotonic() - started
            assert elapsed < grace + 1.0, (
                f"the teardown took {elapsed:.2f}s against a {grace}s grace plus "
                "the reader drain"
            )
            leftover = [
                task for task in asyncio.all_tasks() if task is not asyncio.current_task()
            ]
            return reason, leftover

        reason, leftover = asyncio.run(scenario())
        assert reason == "disconnect"
        assert not leftover, f"a reader task outlived the teardown: {leftover}"


@pytest.mark.needs_shell
@pytest.mark.needs_driver
@pytest.mark.posix_behaviour(
    "the session id is a POSIX idea: ``/proc``'s scan is how a job-controlling "
    "shell's other process groups are named, and on Windows the equivalent is "
    "the session's job (test_terminal_conpty.py's real-console tree test)"
)
def test_the_disconnected_shell_leads_no_live_session_member(client, fast_grace):
    """The procfs half of the tree promise, kept as the POSIX fact it is.

    The session-scoped kill (``proctree.session_members``) is what a group
    ``killpg`` cannot do, and only procfs can answer "who is in that session".
    The platform-free tree assertion above covers the same outcome on both
    platforms through the shell's own printout; this one pins the *scope*.
    """
    session = open_session(client)
    session.send_json({"type": "input", "data": "sleep 40 &\r"})
    time.sleep(0.4)
    shell_pid = next(s["pid"] for s in client.get(WS_URL).json()["sessions"])
    session.__exit__(None, None, None)

    assert wait_until(lambda: pid_gone(shell_pid)), "shell survived disconnect"
    assert wait_until(lambda: not termhub_session_members(shell_pid), timeout=3.0), (
        "a member of the disconnected shell's session survived — the teardown "
        "killed the shell but not its session"
    )


def termhub_session_members(sid: int):
    """Live members of process session ``sid`` (test-local, mirrors proctree)."""
    from src.core import proctree

    return [p for p in proctree.session_members(sid) if not pid_gone(p)]
