"""Which shell the pane runs, and what the child's environment says.

The session asks this module one question at spawn — *what program, with which
argv, in which environment?* — and never decides by itself. The answer is
patchable end to end — the candidates, the override name and the selection
platform are module attributes, the environment is an argument — so a test forces
either platform's answer on either runner without trusting a path it computed.

**POSIX.** ``$SHELL`` (``constants.SHELL_KEY``) when it names an absolute,
executable program, else ``constants.FALLBACK_SHELL``; the flag is ``-i``, so
``~/.bashrc`` is read but not ``~/.profile``.

**Windows — Git Bash.** The order is

1. ``TERMINAL_SHELL`` (``constants.TERMINAL_SHELL_KEY``) — accepted only when it
   is **drive-qualified** and executable;
2. **Git Bash**, the install the console connector's probe already finds
   (:func:`mcp_connectors.gitbash.discover_git_install`, then
   :func:`mcp_connectors.gitbash.git_shell_program`);
3. else **refuse**, with a sentence naming what was looked for.

``cmd.exe``/``%COMSPEC%`` is **not consulted at all**, deliberately: this app's
Windows console story is already Git's toolset, and a ``cmd.exe`` pane would give
one working location two tool vocabularies. ``pwsh``/``powershell`` are never
auto-selected either — the app does not decide a user's shell.

**A POSIX-shaped spec is never a Windows shell.** ``TERMINAL_SHELL=/bin/bash``
(or ``/c/Program Files/Git/bin/bash.exe``) is what the environment holds when the
app was launched *from* a Git Bash window, and on Windows
``os.path.isabs("/bin/bash")`` answering ``False`` is luck rather than a rule. So
the accepted shape is **drive-qualified**, asked of
:func:`mcp_connectors.path_norm.is_qualified` and pinned by a test; a spec that is
not is refused **by name** rather than spawned, and the same rule stops an
MSYS-mount path ever reaching a Windows ``Popen``. A present-but-unusable spec is
refused instead of falling through to Git Bash: a silent fallback is how the one
knob stops being honest.

The ``-i`` flag belongs to the shell spec, not to ``session.py``: interactive and
non-login reads ``~/.bashrc`` — the prompt, aliases and colours a user expects in
a pane — without re-running the profile's setup once per tab.

*Not here:* the child's ``cwd`` — the session's, the workspace in scope when it
was born (``src.core.workspace.current_root``), never a path from the client; the
pseudo-terminal itself — :mod:`termhub.drivers`; any permission question. A shell
is reachable only from the Editor's WebSocket, never from a hub, a tool or a chat
turn: the console connector still refuses a command named ``bash``, and finding a
shell program here is not permission to run one there.
"""

import ntpath
import os
from typing import Dict, List, Mapping, Optional, Tuple

# The shared probe lives in ``mcp_connectors/`` because a connector runs in its
# own process and cannot import ``src``; ``src`` may import it (the precedent is
# ``editorfs/fscase.py`` re-exporting ``mcp_connectors/fscase.py``). One probe
# answers "where is Git" for both, so the two cannot disagree about a path.
# Never fork its logic.
from mcp_connectors import gitbash
from mcp_connectors.path_norm import is_qualified

from . import constants

# The selected shell: the program plus its own interactive flag.
ShellSpec = Tuple[str, ...]

# Where a Windows install of Git may be when the probe finds nothing on PATH —
# the terminal's own patch-point, seeded from the shared probe's list.
GIT_INSTALL_CANDIDATES: List[str] = list(gitbash.GIT_INSTALL_CANDIDATES)

# The override's name, same process-environment-only reasoning as the console
# connector's: a run's own configuration is what the boot flags carry, and this
# only names a folder for one child process.
GIT_ENV_OVERRIDE: str = gitbash.GIT_ENV_OVERRIDE

# Which selection runs. Named and patchable rather than read inline at the call,
# so a test forces the Windows half's answers **on the Linux runner** and the
# POSIX half's on a Windows one. This module decides the shell by what the
# platform's environment can name; the *driver* seam beside it answers the
# mechanism by capability probe (see :mod:`termhub.drivers`).
SELECTION_PLATFORM: str = os.name


def select_shell(
    platform: Optional[str] = None,
    environ: Optional[Mapping[str, str]] = None,
) -> ShellSpec:
    """The program argv for this runner's shell. Raises when there is none.

    ``platform`` and ``environ`` default to the process's own answers; a test
    hands in the other pair (or patches the candidate lists) and gets that
    platform's decision without pretending to be on it.
    """
    name = SELECTION_PLATFORM if platform is None else platform
    env = os.environ if environ is None else environ

    if name == "posix":
        return _select_posix(env)
    return _select_windows(env)


def child_environment(
    shell: ShellSpec,
    cols: int,
    rows: int,
    environ: Optional[Mapping[str, str]] = None,
) -> Dict[str, str]:
    """The environment for ``shell``: the inherited one plus what a terminal needs.

    ``TERM`` (``constants.TERM_VALUE``, so vim, less and top can paint), and
    ``COLUMNS``/``LINES`` at the size the window was opened with.

    The process environment is inherited **verbatim** otherwise: whatever the
    process carries, the child carries too. Nothing the app configures itself with
    is in there — its technical settings are boot flags and its workspace
    placeholder is computed per request — so what leaks is only what the OS and
    the shell own.

    For the Git Bash case, ``PATH`` gets Git's directories **prepended in Windows
    form** (:func:`mcp_connectors.gitbash.git_child_env`): a bash started with
    only the ambient Windows ``PATH`` answers "command not found" for ``stty``,
    ``tput`` and ``which`` — the tools the pane's resize and a user's
    ``vim``/``less`` depend on.

    ``environ`` defaults to the process environment, exactly as the session
    hands it today; a test passes its own base and sees the same answer.
    """
    base: Dict[str, str] = dict(os.environ if environ is None else environ)
    # The probe decides, not the platform's name: the child gets Git's search
    # order exactly when the selected program *is* a shell inside a verified Git
    # install, which is a question the shared marker answers on either runner.
    root = _git_root_of(shell[0])
    if root is not None:
        base = gitbash.git_child_env(base, root)
    base["TERM"] = constants.TERM_VALUE
    base["COLUMNS"] = str(cols)
    base["LINES"] = str(rows)
    return base


# -- the POSIX answer --------------------------------------------------------


def _select_posix(env: Mapping[str, str]) -> ShellSpec:
    """``$SHELL`` when it is an absolute executable, else ``/bin/sh``."""
    configured = (env.get(constants.SHELL_KEY) or "").strip()
    if configured and os.path.isabs(configured) and os.access(configured, os.X_OK):
        return (configured, "-i")
    return (constants.FALLBACK_SHELL, "-i")


# -- the Windows answer (Git Bash, no cmd.exe) -------------------------------


def _select_windows(env: Mapping[str, str]) -> ShellSpec:
    """``TERMINAL_SHELL`` if drive-qualified and executable, else Git Bash, else refuse."""
    # Reached lazily: :mod:`termhub.session` asks *this* module for the shell and
    # owns the refusal class this module raises, so importing it here would be a
    # cycle — the same shape as ``editorfs.policy``'s lazy import of the error
    # class ``editorfs.policy_file`` needs from it.
    from .session import TerminalUnsupported

    configured = (env.get(constants.TERMINAL_SHELL_KEY) or "").strip().strip('"')
    if configured:
        program, why = _windows_shell_program(configured)
        if program is None:
            raise TerminalUnsupported(
                "the configured shell is not usable on Windows: "
                f"{constants.TERMINAL_SHELL_KEY}='{configured}' {why}. Set it to "
                "a full Windows path (a drive-qualified one such as "
                "C:\\Program Files\\Git\\bin\\bash.exe), or leave it unset to "
                "use Git Bash."
            )
        return (program, "-i")

    root = _discover_git_install(env)
    program = gitbash.git_shell_program(root)
    if program is None:
        raise TerminalUnsupported(_no_shell_refusal(env))
    return (program, "-i")


def _windows_shell_program(spec: str) -> Tuple[Optional[str], str]:
    r"""``spec`` as a Windows shell program, or ``(None, why not)``.

    The accepted shape is **drive-qualified** — a drive spec (``C:\…``,
    ``C:/…``) or a UNC root (``\\srv\share\…``) — rather than left to
    ``os.path.isabs``, which answers ``False`` for ``/bin/bash`` on Windows by
    luck rather than by rule. Both questions below are needed:

    * :func:`mcp_connectors.path_norm.is_qualified` refuses a bare ``bash`` and
      any relative name, but not ``/bin/bash``: a leading slash is qualified.
    * ``ntpath.splitdrive`` on the spec as written — a non-empty drive part is
      what a Windows child can be started from. Asking it of the raw text, not the
      canonical form, because the canonical form folds a UNC root's leading
      separators away.
    """
    if not is_qualified(spec):
        return (None, "is a relative name, not a path")
    if not ntpath.splitdrive(spec)[0]:
        return (
            None,
            "names no Windows drive or share, so it is a POSIX-shaped path — "
            "the kind a Git Bash window carries, not a program this app can "
            "start as a Windows child (use a drive-qualified one such as "
            "C:\\Program Files\\Git\\bin\\bash.exe)",
        )
    if not _program_is_runnable(spec):
        return (None, "is not an existing executable file")
    return (spec, "")


def _program_is_runnable(spec: str) -> bool:
    """Does ``spec`` name a file this runner could start?

    Named, so a test can hand the selection order a yes for a spec it never plants
    on disk: a Linux runner can only fake the filesystem answer, not the
    qualification rule."""
    return os.path.isfile(spec) and os.access(spec, os.X_OK)


def _discover_git_install(env: Mapping[str, str]) -> Optional[str]:
    """The Git install root, asked of the shared probe with this module's inputs."""
    return gitbash.discover_git_install(GIT_INSTALL_CANDIDATES, GIT_ENV_OVERRIDE, env)


def _git_root_of(program: str) -> Optional[str]:
    r"""The Git root a selected ``…\bin\bash.exe`` belongs to, or None.

    The root is the verified install whose ``bin\bash.exe`` this is (the parent of
    ``bin``), confirmed by the same ``usr\bin\ls.exe`` marker discovery used, so a
    ``TERMINAL_SHELL`` outside a Git install keeps the ambient ``PATH`` untouched
    rather than borrowing a toolset.
    """
    if not program:
        return None
    directory = os.path.dirname(os.path.abspath(program))
    if os.path.basename(directory).lower() != "bin":
        return None
    root = os.path.dirname(directory)
    return gitbash.has_git_toolset(root)


def _no_shell_refusal(env: Mapping[str, str]) -> str:
    """The sentence for "no shell here", naming what was looked for.

    It also names the two things that are **not** and will not be tried, so the
    absence is not mistaken for an unfinished lookup: ``%COMSPEC%``/``cmd.exe``
    (one working location, one tool vocabulary) and ``pwsh``/``powershell`` (the
    app does not decide a user's shell).
    """
    searched = ", ".join(GIT_INSTALL_CANDIDATES)
    shell_key = constants.TERMINAL_SHELL_KEY
    return (
        f"the terminal found no shell to run: {shell_key} is not set, `git` was "
        "not on PATH, none of the Git install candidates "
        f"({searched}) carries usr\\bin\\ls.exe, and {GIT_ENV_OVERRIDE} names no "
        "usable install. This pane runs Git Bash; install Git for Windows, point "
        f"{GIT_ENV_OVERRIDE} at its install root, or set {shell_key} to a "
        "drive-qualified shell path. cmd.exe and pwsh/powershell are not "
        "started here."
    )
