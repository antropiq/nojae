"""Application configuration: the boot flags, the endpoint config an agent
resolves from the settings store, and the values the app computes for itself."""

import argparse
import logging
import os
import sys
from pathlib import Path
from typing import Any, Dict, Mapping, NamedTuple, Optional, Sequence, Tuple, Union

from pydantic import ValidationError

from src.core.models import EndpointsConfig

PROJECT_ROOT = Path(__file__).resolve().parent.parent

# The tool-loop cap a built-in agent is seeded with (D9). It is a *per-agent
# column* now, so nothing here reads it as a fallback: it stays as the one
# number the store's seeder and its tests agree on, which is what keeps a fresh
# install behaving exactly as it did before the cap moved.
DEFAULT_MAX_TOOL_ITERATION = 25

# --- the boot flags -------------------------------------------------------
#
# Everything the install used to hand-edit in ``.env`` is now either a **flag
# on the command line that booted the app** (the debug switch, the endpoint
# wait's two numbers, the port it serves on) or a value the app **computes for
# itself** at boot (:func:`python_root`). There is no fourth ``.env`` key left
# to copy, so there is no ``.env`` file: the app reads none, writes none, and
# ships no template for one.
#
# Which of the two shapes each one took is not a taste question:
#
# * a **flag** is a decision about *this run* — how loud to be, how long to
#   wait, which port to hold. It belongs to the invocation, so it is gone when
#   the process is, and two checkouts of the same install can be booted
#   differently without either one editing a file the other reads.
# * ``NOJAE_PYTHON_ROOT`` is the opposite: it is never a choice, it is a fact
#   about the running process — *which interpreter is this app*. Answering it
#   from a hand-written path was the last reason the file existed, and a wrong
#   one: the value could only ever be the interpreter that is asking.
#
# The consequence to hold onto is what "no .env" means for a **running**
# process. A flag is parsed once, by :func:`parse_boot_args`, from the
# ``argv`` of the command that started the app, and the parsed values are
# process state (``boot_flags``/``set_boot_flags``) that every consumer reads
# **at call time**. Nothing here exports a flag into the environment: an
# ``os.environ`` carrying ``LLM_DEBUG`` decides nothing any more, exactly as a
# stray ``PROJECT_ROOT`` has decided nothing since clws-10. The environment
# keeps only what it always genuinely owned — the OS's own variables, and the
# few switches a *parent* sets for a child it starts (``NOJAE_DISABLE_MCP``,
# ``NOJAE_DISABLE_LSP``, ``NOJAE_TEST_SETTINGS``), which are switches *about*
# this process written by whoever launched it, not configuration this process
# reads from its own folder.

# The endpoint wait's two defaults (spec §6). They are non-zero on purpose: the
# feature has to be on without any flag, or it would not have saved the run
# that motivated it. ``--network-max-retry 0`` is the switch that turns the
# waiting off and restores the behaviour of a refused round failing at once.
DEFAULT_NETWORK_FAIL_MAX_RETRY = 3
DEFAULT_NETWORK_FAIL_WAIT_FOR = 10

#: The **name** ``NOJAE_PYTHON_ROOT`` has in this app: the placeholder the
#: seeded connector declaration writes as the interpreter of ``console`` and
#: ``fedit``, and the key :func:`provided_env_values` answers with
#: :func:`python_root`. It is not an environment key any more and never was a
#: flag: the value is the interpreter this very process is running on, which
#: nothing outside the process can know better than the process.
PYTHON_ROOT_PLACEHOLDER = "NOJAE_PYTHON_ROOT"


def python_root() -> str:
    """The absolute path of the interpreter **this app** runs on.

    ``sys.executable``, read at call time — that is the whole answer, and it is
    the answer the ``.env`` key asked a human to type. A venv's python, a
    system python, a pyenv shim resolved by the launcher: whatever started
    ``nojae`` is what the stdio connectors must run on, because they import the
    same packages (the MCP SDK) from the same environment. Booting the app from
    another interpreter therefore moves the connectors with it, and a stale
    hand-written path — the one failure this key had, since nothing checked it —
    is now unrepresentable.

    Empty in the rare embedding where ``sys.executable`` is unset. That is not
    guessed at (a wrong interpreter names a real file and then fails inside
    it): the placeholder simply stays unresolved, and ``expand_env`` writes its
    missing-name note, which is the honest state — the app does not know which
    interpreter it is.
    """
    return sys.executable or ""


DEFAULT_PORT = 8001

# The network address the console script binds when it is not told otherwise.
# It is a **loopback** address on purpose, and no flag loosens it: the pane is a
# human surface with the folder's own rights, so serving it to a network is a
# decision this app does not offer (``termhub.policy``'s docstring states what
# that means for a WebSocket). Only the port is the operator's to choose.
DEFAULT_HOST = "127.0.0.1"


class BootFlags(NamedTuple):
    """What this process was booted with — the whole of the old ``.env``.

    One immutable value, so "the flags this run resolved" cannot drift
    piecewise: the only way the process runs with different numbers is for
    somebody to hand in a different ``BootFlags``, which is what
    :func:`set_boot_flags` is for. Every member has a default that is a real
    working value, because a process that never went through
    :func:`parse_boot_args` — a test's ``create_app()``, a `uvicorn` dev
    server, an embedding host — is normal, not an error, and must answer
    something honest.
    """

    #: ``--llm-debug``: log every model request's payload to the console.
    llm_debug: bool = False
    #: ``--network-max-retry``: waits one refused round may spend before failing.
    network_max_retry: int = DEFAULT_NETWORK_FAIL_MAX_RETRY
    #: ``--network-wait-for``: seconds between two attempts at the same round.
    network_wait_for: int = DEFAULT_NETWORK_FAIL_WAIT_FOR
    #: ``--port``: the port the console script serves on.
    port: int = DEFAULT_PORT


# The flags of *this* process. Module-level and replaceable rather than a
# constant, so the app's consumers keep the convention every other install
# answer here follows — read at call time through a function, so a caller can
# never hold a stale value and a test can move the whole thing with one patch.
_boot_flags = BootFlags()


def boot_flags() -> BootFlags:
    """What this process was booted with. Never reads a file or the environment.

    Every consumer of a boot value goes through this (directly or through the
    named accessors below), so the whole of "where does a run's configuration
    come from" is one function, and it answers process state — which is what
    makes a boot flag a *decision about this run* rather than machine state.
    """
    return _boot_flags


def set_boot_flags(flags: BootFlags) -> None:
    """Record what this process was booted with — the console script's call.

    Called by :func:`src.api.server.run` after :func:`parse_boot_args` and
    before the app is served. It is a **replacement of the whole value**, not a
    per-field setter: a partial update would let the debug switch be re-applied
    from one place while the retry pair still answered the default, which is
    the "mid-turn save cannot split it" rule, one level down.

    Nothing in the test suite needs it — a test that wants specific flags
    patches :data:`_boot_flags` (or calls this), and a test that does not wants
    the defaults this module's own values answer.
    """
    global _boot_flags
    _boot_flags = flags


def _non_negative_int_arg(text: str) -> int:
    """``argparse`` type: a whole number of ``0`` or more, refusing otherwise.

    This is where the old ``.env`` fallback rule went, and it went *up*: an
    unusable value used to answer the default and leave a note on the settings
    surface, because a running app must not die over a typo. A value typed on
    the command line is different — the app has not started yet, the person who
    wrote it is standing there, and booting with a number they did not type is
    the worse of the two answers. So ``ten``, ``-1``, ``1.5`` and a bare option
    all end the boot with argparse's own sentence naming the option.

    Zero stays a **value** and not a missing one: ``--network-max-retry 0`` is
    the endpoint wait switched off.
    """
    try:
        value = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(
            f"{text!r} is not a whole number of 0 or more"
        ) from None
    if value < 0:
        raise argparse.ArgumentTypeError(
            f"{text!r} is negative; 0 is the smallest accepted value"
        )
    return value


def _port_arg(text: str) -> int:
    """``argparse`` type: a port number this OS can bind."""
    try:
        port = int(text)
    except ValueError:
        raise argparse.ArgumentTypeError(f"{text!r} is not a port number") from None
    if not 1 <= port <= 65535:
        raise argparse.ArgumentTypeError(
            f"{port} is outside the 1-65535 range of bindable ports"
        )
    return port


def parse_boot_args(argv: Optional[Sequence[str]] = None) -> BootFlags:
    """The command line the app was booted with, as :class:`BootFlags`.

    ``argv`` defaults to the process's own arguments; it is a parameter because
    the flags are a *parse* and not a side effect — the suite asserts on the
    parser (its spellings, its defaults, what it refuses) without touching this
    process's real ``sys.argv``, which belongs to whatever started the run.

    Every flag is **optional**: with no arguments at all the app boots on the
    documented defaults, which is what keeps `uvicorn src.api.server:app` (the
    dev path docs/SETUP.md gives) exactly as it was — that command is
    ``uvicorn``'s own parser, so it *cannot* carry these names, and nothing may
    need it to. The debug switch is off there and the wait runs on its
    defaults; a developer who wants them runs the ``nojae`` console script.
    """
    parser = argparse.ArgumentParser(
        prog="nojae",
        description="nojae — the workspace where a coding agent works in front of you.",
    )
    parser.add_argument(
        "--llm-debug",
        action="store_true",
        help="log every model request's payload (URL, model, body) to this "
        "console at DEBUG, so a failed call can be read off it. The refused "
        "call's status and upstream body reach the UI's error line whether or "
        "not this is on; what the flag adds is the payload. Verbose, so switch "
        "it back off by booting without it.",
    )
    parser.add_argument(
        "--network-max-retry",
        type=_non_negative_int_arg,
        metavar="N",
        default=DEFAULT_NETWORK_FAIL_MAX_RETRY,
        help="how many times a refused model round is asked again before the "
        f"failure is final (default {DEFAULT_NETWORK_FAIL_MAX_RETRY}). 0 "
        "switches the waiting off, so a refused round fails on its first "
        "attempt as it did before.",
    )
    parser.add_argument(
        "--network-wait-for",
        type=_non_negative_int_arg,
        metavar="SECONDS",
        default=DEFAULT_NETWORK_FAIL_WAIT_FOR,
        help="seconds to wait between two attempts at the same round "
        f"(default {DEFAULT_NETWORK_FAIL_WAIT_FOR}). 0 asks again at once, "
        "spending the same budget with no pause.",
    )
    parser.add_argument(
        "--port",
        type=_port_arg,
        metavar="PORT",
        default=DEFAULT_PORT,
        help=f"port to serve the UI and the API on (default {DEFAULT_PORT}). "
        "The address stays this machine's own, always.",
    )
    parsed = parser.parse_args(list(argv) if argv is not None else None)
    return BootFlags(
        llm_debug=parsed.llm_debug,
        network_max_retry=parsed.network_max_retry,
        network_wait_for=parsed.network_wait_for,
        port=parsed.port,
    )


TRUTHY_VALUES = frozenset({"1", "true", "yes", "on"})


def env_flag(key: str) -> bool:
    """True when an env var is set to a truthy value (1/true/yes/on)."""
    return (os.environ.get(key) or "").strip().lower() in TRUTHY_VALUES


def llm_debug_enabled() -> bool:
    """True when this run was booted with ``--llm-debug``.

    ``nojae.llm`` — the logger ``core/llmkit`` writes its request payloads to —
    is raised to DEBUG for such a run, and its output reaches the server
    console, so a failed call can be read off it: which URL was POSTed, with
    what payload. The *status and upstream body* of a refused call reach the
    UI's error line whether or not the flag is on (they are in the exception
    message itself); what the flag adds on top is the request payload.

    The answer is **this process's**, read from :func:`boot_flags` at call
    time. It is not a file, not an environment key, and not a settings-store
    column, so there is nothing to re-read mid-run and nothing that could make
    two workspaces of one process answer differently: the switch describes the
    console the payloads would be printed to, which is one per process.
    """
    return boot_flags().llm_debug


def network_fail_budget() -> Tuple[int, int]:
    """The effective ``(max_retry, wait_seconds)`` of the endpoint-wait guard.

    The pair this run booted with — ``--network-max-retry`` and
    ``--network-wait-for``, or the module's defaults when neither was given.

    Still a **function** answering at call time, and still the thing the chat
    route hands to ``stream_chat`` (spec §6): the decision it answers belongs to
    the moment a refused round is about to be retried, so the guard asks rather
    than being handed a number at import. What changed is only where the answer
    comes from — the parsed command line, not a file — and a value that has to
    be right *now* is no reason to re-parse ``argv`` per attempt.

    ``_non_negative_int_arg`` is what guarantees the pair is usable, and it
    guarantees it **before the app is serving**: an unusable flag stops the boot
    with a sentence naming the option instead of reaching a running app that
    would need a note to explain the default. That is why no read-out of "the
    key fell back" travels with these two any more — a state the parser makes
    unrepresentable needs no reporting surface. The effective pair is still
    answered to ``GET /api/config`` so a run can be read off the screen.
    """
    flags = boot_flags()
    return flags.network_max_retry, flags.network_wait_for


class _DebugStreamHandler(logging.StreamHandler):
    """The one handler the debug switch owns, marked by its own class.

    Identified by class rather than remembered on the logger, so "exactly one of
    ours" holds by construction: an attach clears every handler of this class it
    finds, whoever attached it. Boot plus one attach per settings save would
    otherwise be free to stack one per save, printing each payload again.
    """


def _attach_debug_handler(logger: logging.Logger) -> None:
    """Give the client's logger exactly one stderr handler.

    Raising the level alone would log nothing: uvicorn configures handlers for
    its own loggers only, so a ``nojae.*`` record has nowhere to go. While
    the switch is on the logger therefore carries a handler of its own, with
    ``propagate`` off so a deployment that *does* configure a root logger is not
    printed twice. ``core/llmkit`` deliberately attaches no handler, so this is
    the one place those payload lines reach the server console from — and the
    fresh one per call is what binds that console as it is now (a replaced
    ``sys.stderr`` included) rather than one built long before.
    """
    _detach_debug_handler(logger)
    handler = _DebugStreamHandler()
    handler.setLevel(logging.DEBUG)
    handler.setFormatter(logging.Formatter("%(levelname)s: %(name)s: %(message)s"))
    logger.addHandler(handler)
    logger.propagate = False


def _detach_debug_handler(logger: logging.Logger) -> None:
    """Remove every handler of ours and restore propagation.

    Clears by class, so it also removes what an earlier boot attached: the
    switch never leaves more than one behind, and its off path is a no-op on a
    logger it never touched (``propagate`` stays as its other owner left it).
    """
    mine = [h for h in logger.handlers if isinstance(h, _DebugStreamHandler)]
    for handler in mine:
        logger.removeHandler(handler)
    if mine:
        logger.propagate = True


def apply_llm_debug() -> bool:
    """Raise the in-house LLM client's logger to DEBUG when ``LLM_DEBUG`` is on.

    Called once per app creation, from ``create_app()``. There is no second
    moment for it: the switch is a **boot flag**, so the only way its value
    changes is for the process to be booted again — and a new process calls
    this again with the answer of its own parse. The off path stays explicit
    rather than "do nothing", because a value that cannot change mid-run is
    still a value that must leave the logger exactly as it found it when the
    flag was not given: the level goes back to ``NOTSET`` — which inherits
    WARNING from the root logger, exactly where it stood before the switch was
    ever on — and the handler comes off.

    What the flag adds is the *request payload* of every model call: the URL,
    the model, and the body as it goes out. Never the ``Authorization`` header,
    so the API key cannot reach the console from here. The status and upstream
    body of a *refused* call need no flag at all: they are in the exception
    message the two consuming loops emit into the UI's error line.

    It also points ``core/llmkit``'s debug hook at this predicate, so payload
    logging follows the switch: ``llmkit`` is core and must not import the
    layer that owns the flag, while ``config`` sits below both. Returns whether
    the switch is now on.
    """
    # Imported lazily and from the layer below (never from ``api``): this module
    # is also imported by code paths that never call an LLM.
    from src.core.llmkit import client as llmkit_client
    from src.core.llmkit import constants as llmkit_constants

    enabled = llm_debug_enabled()
    logger = logging.getLogger(llmkit_constants.DEBUG_LOGGER_NAME)
    if enabled:
        _attach_debug_handler(logger)
        logger.setLevel(logging.DEBUG)
    else:
        logger.setLevel(logging.NOTSET)
        _detach_debug_handler(logger)
    llmkit_client.debug_enabled = llm_debug_enabled
    return enabled


# Values the app provides for ``${NAME}`` references in the hub declaration
# files (see ``mcphub.validation.expand_env``). All three names here are
# **computed**, never read back from the environment, and they must not be
# confused with one another:
#
# * ``NOJAE_PATH_LOCATION`` is the **folder being served** — the workspace of the
#   call doing the expansion, read through the seam
#   (:func:`src.core.workspace.provided_path_location`) rather than from
#   ``os.environ``. That is what makes one declaration file correct in two
#   workspaces at once: a tab on A gets A's connectors rooted at A, a tab on B
#   gets B's (spec §4.3). Reading the environment here would answer "which
#   folder does this *process* hold", which is the question this lot retires.
# * ``PROJECT_ROOT`` is the **installation**, in every workspace and always.
# * ``NOJAE_PYTHON_ROOT`` is the **interpreter this process runs on** — the same
#   answer in every workspace and always, and one no file could state correctly
#   for two machines. It left the ``.env`` key set with this: the app knows which
#   interpreter it is, so a human no longer has to say.
#
# None is *exported* into the environment either: the app computes all three, so
# the values are always right, and a generic name like ``PROJECT_ROOT`` exported
# process-wide would collide with whatever a shell, a CI runner or one of the
# connectors' own scripts calls its project root — the ``TEMP`` lesson, seen from
# the other side: a name the world already uses cannot become an export of ours
# either. All three therefore reach expansion from this computation alone, and a
# stray value in the environment cannot redirect connectors away from this
# install, away from the workspace asked about, or onto another interpreter. An
# unresolved ``${NAME}`` still stays written as-is with a note (the rule
# ``expand_env`` holds); these three simply always resolve.


#: The **name** ``NOJAE_PATH_LOCATION`` has in this app: the placeholder a
#: workspace's declaration file writes (``--root-dir`` / ``workspaceRoot``) and
#: the key :func:`provided_env_values` answers with the workspace being served
#: (spec §4.3). It is not an environment key any more — clws-10 deleted the
#: process-wide value, its accessor and the boot seed that wrote it, so this
#: constant and that one answer are the whole of the name's life in ``src``.
PATH_PLACEHOLDER = "NOJAE_PATH_LOCATION"


#: The three names the **app** owns, as opposed to the ones the OS and the
#: invoking shell own. Expansion treats the two groups differently, which is why
#: this is a set and not prose: for a name in it, :func:`provided_env_values` is
#: the **only** source, consulted even when the app has no answer right now (the
#: location outside a workspace's scope, an embedding with no
#: ``sys.executable``) — an unresolved reference then stays written with a note,
#: rather than being answered by a stale export that would silently redirect a
#: connector off this install, off the served workspace, or onto another
#: interpreter. Every other ``${NAME}`` is the environment's to answer.
#: ``PROJECT_ROOT`` carries no constant of its own: it is not a placeholder this
#: app defines, it is the name of the module-level value it expands to.
PROVIDED_ENV_NAMES = frozenset(
    {"PROJECT_ROOT", PYTHON_ROOT_PLACEHOLDER, PATH_PLACEHOLDER}
)


def provided_env_values() -> Dict[str, str]:
    """The app-computed ``${NAME}`` values for hub declaration expansion.

    Read at call time through this module, so a patched ``PROJECT_ROOT`` (a
    test does exactly that) moves the answer — same convention as every other
    patchable name. ``NOJAE_PATH_LOCATION`` is read through the seam, so the
    answer follows the workspace in scope; see the block above for why the two
    names must stay two.

    Outside a scope there is **no** workspace being served, so the placeholder
    is simply absent: expansion leaves ``${NOJAE_PATH_LOCATION}`` written as-is
    with a missing-name note (the rule ``expand_env`` holds for every unresolved
    reference) rather than raising. That matters because some reads happen while
    the workspace itself is still being resolved — the LSP root deny-list is
    expanded through this function before a request's scope exists — and a
    validator for one folder must not need a different folder to already be in
    scope.
    """
    # Lazy: ``src.core.workspace`` imports this module (it reads
    # ``PROJECT_ROOT`` from here), so a module-level import would be a cycle —
    # the same shape as the ``appdb`` imports below.
    from src.core import workspace

    values = {"PROJECT_ROOT": str(PROJECT_ROOT)}
    # Absent rather than empty when the embedding has no ``sys.executable``:
    # an empty argv[0] would expand to an empty *interpreter*, which is the
    # blanking-out ``expand_env`` exists to prevent. Left unresolved, the
    # reference stays visible and the entry's note names the placeholder.
    if python_root():
        values[PYTHON_ROOT_PLACEHOLDER] = python_root()
    try:
        values[PATH_PLACEHOLDER] = workspace.provided_path_location()
    except workspace.WorkspaceNotScoped:
        pass
    return values


# Project agent instructions: when present at the root of the working
# location, their text is appended to the Chat system prompt so a new
# conversation starts already knowing the project's conventions.
AGENT_INSTRUCTIONS_FILENAME = "AGENTS.md"


def agent_instructions_filename() -> str:
    """Name of the agent-instructions file looked for at the location root.

    Read through a function (not the constant) so a test can point the lookup
    at another filename without rewriting the module.
    """
    return AGENT_INSTRUCTIONS_FILENAME


def _served_root() -> str:
    """The folder the call in progress is about — read through the seam.

    The request's workspace, and the same answer ``${NOJAE_PATH_LOCATION}``
    expands to for the declaration files. With several tabs on several folders,
    the instructions a turn receives are the ones at *that* tab's root, never
    another tab's (spec §5.6 rule 31).
    """
    # Lazy, for the same reason as ``provided_env_values``: the seam imports this
    # module, so a module-level import here would be a cycle.
    from src.core import workspace

    return workspace.provided_path_location()


def load_agent_instructions(location: Optional[str] = None) -> str:
    """Text of the workspace's ``AGENTS.md``, "" when absent/unreadable.

    Resolved against the folder the request names (the seam's scope — the same
    one every file-touching surface answers about) at call time. Read per chat
    request rather than cached: editing ``AGENTS.md`` then takes effect on the
    very next message.
    """
    root = Path(location) if location else Path(_served_root())
    try:
        return (root / agent_instructions_filename()).read_text(encoding="utf-8").strip()
    except (OSError, ValueError):
        return ""


def agent_instructions_block(text: Optional[str] = None) -> str:
    """The instructions rendered as a system-prompt block ("" when no text).

    The framing tells the model these are the project's own instructions —
    they win over generic wording for anything project-specific — and pins
    the project root to the **request's workspace**, which is what makes the paths
    the instructions mention (``src/``, ``tests/``, ``web/``) and the tool
    UIDs they describe resolve to the real project — and keeps two tabs on two
    folders from receiving each other's instructions.
    """
    body = load_agent_instructions() if text is None else (text or "").strip()
    if not body:
        return ""
    return (
        "The current project root is {root}\n\n"
        "The following are this project's own instructions (AGENTS.md at that "
        "root). Follow them for anything project-specific; they take "
        "precedence over generic wording.\n\n{body}"
    ).format(root=_served_root(), body=body)


def agent_connection_refusal(agent: Optional[Mapping[str, Any]]) -> Optional[str]:
    """The one sentence naming why this agent cannot reach a model (spec D7).

    ``None`` when the agent can run. Otherwise the sentence, which covers the
    three states that answer has to name and no others — there is no ladder
    behind it, because ``agent.model_id`` set means *that* model and *its*
    server, and null means this sentence:

    1. **the agent has no model** — the sentence **names the agent**, because
       "which agent" is the part the user can act on; a sentence about a missing
       *default* would describe a setting that no longer exists (D5);
    2. **the model's server row is missing** — the same refusal, not a crash.
       The schema's ``ON DELETE SET NULL`` makes that state unreachable through
       the app, so reaching it means a hand-edited database, which is exactly
       when a named state matters most;
    3. **the store itself is unusable** — the sentence naming the path, which is
       the one the boot kept (:func:`src.core.appdb.store_state`), so the app
       bar and the chat refusal cannot disagree.

    This is the single builder of that sentence: the chat route, the Settings
    dialog and the app bar all reuse it, and none of them writes a sentence of
    its own. It answers a **sentence**, never an HTTP status — the route decides
    what the refusal costs.

    A caller that goes on to build the connection from the same agent uses
    :func:`load_endpoints_config`, which reads the rows **once** and hands them
    to the same builder, so the sentence and the configuration can never be about
    two different reads.
    """
    return _resolve_agent_rows(agent)[2]


def _resolve_agent_rows(
    agent: Optional[Mapping[str, Any]],
) -> Tuple[Optional[Dict[str, Any]], Optional[Dict[str, Any]], Optional[str]]:
    """``(model_row, server_row, sentence)`` — the seam's one read of the store.

    The two answers are the two branches of D7 and nothing else: either both
    rows are there and the sentence is ``None``, or the sentence names the state
    and at least one row is missing. Split out of
    :func:`agent_connection_refusal` so the refusal stays the single builder of
    the sentence while the seam gets the rows it just checked.
    """
    # Local import, the reason every caller of this module's bottom rung has:
    # ``appdb`` reads ``PROJECT_ROOT`` *from* this module.
    from src.core import appdb

    row: Mapping[str, Any] = agent or {}
    who = str(row.get("label") or row.get("id") or "").strip() or "the selected agent"

    state = appdb.store_state()
    if state["state"] != "ok":
        return (
            None,
            None,
            state["sentence"]
            or f"nojae's settings store at {state['path']} is unusable.",
        )

    model_id = row.get("modelId")
    if model_id is None:
        return (
            None,
            None,
            f"Agent {who} has no model to run with. Please assign a model in "
            "the Agent modes dialog.",
        )

    try:
        model = appdb.model_row(model_id)
        server = None if model is None else appdb.server_row(model["serverId"])
    except appdb.AppStoreError as exc:
        # The store was usable at boot and is not now — the sentence the failure
        # itself carries, naming the path, is the honest one.
        return (None, None, str(exc))

    if model is None:
        return (
            None,
            None,
            f"Agent {who} has no model to run with: the model it names is not in "
            f"nojae's settings store at {appdb.database_path()}. Please assign a "
            "model in the Agent modes dialog.",
        )
    if server is None:
        return (
            None,
            None,
            f"Agent {who} has no model to run with: the model it names "
            f"({model['name']!r}) belongs to a server that is not in nojae's "
            f"settings store at {appdb.database_path()}.",
        )
    return (model, server, None)


def load_endpoints_config(
    agent: Optional[Mapping[str, Any]],
) -> Tuple[Optional[EndpointsConfig], Optional[Union[ValidationError, str]]]:
    """The model connection **one agent** runs on, or the sentence why it cannot.

    The contract this function has always held — ``(config, None)`` or
    ``(None, sentence)`` — but **per agent**, because which connection answers is
    no longer one answer for the whole app (D7). The three answers are:

    * ``(config, None)`` — the agent has a model, its server is there, and the
      sampler columns validated;
    * ``(None, ValidationError)`` — a column pydantic rejects;
    * ``(None, sentence)`` — any of :func:`agent_connection_refusal`'s three
      states: no model, a model whose server row is missing, an unusable store.

    **A turn resolves once, at its start**, and this is where it resolves: the
    caller holds the answer for the whole turn, so a save that lands mid-turn
    cannot split the turn that is streaming. That is the invariant that replaces
    today's "refused while a chat reply streams" gate for these stores.

    A missing agent — no id, or an id the store does not hold — is the caller's
    **422 naming the field** (D5), answered before this is reached; there is no
    server-side default to fall back to, so nothing here resolves one.

    Never a silent default: an agent with no model refuses rather than dialling a
    model nobody chose for it (D5).
    """
    model, server, refusal = _resolve_agent_rows(agent)
    if refusal is not None:
        return None, refusal
    try:
        return EndpointsConfig.from_store(server, model), None
    except ValidationError as exc:
        return None, exc


def max_tool_iteration(agent: Optional[Mapping[str, Any]] = None) -> int:
    """The **resolved agent's** tool-iteration cap (D9), or the seeded number.

    The cap counts **MCP tool rounds only**, as it always has: a round that used
    nothing but language-server tools does not advance it, so LSP usage is never
    bounded here (the Editor's LSP queries aren't a tool loop at all).

    It is a per-agent column now, so the value comes from the agent a turn
    resolved at its start — :func:`src.core.appdb.agent_max_tool_iteration`,
    which is the one accessor for the floor. ``None`` (no agent handed in) is the
    seeded number, which is what a caller with no turn to speak of gets.
    """
    # Local import: ``appdb`` reads ``PROJECT_ROOT`` *from* this module.
    from src.core import appdb

    if agent is None:
        return DEFAULT_MAX_TOOL_ITERATION
    return appdb.agent_max_tool_iteration(agent)
