"""Application configuration: .env loading and endpoint config."""

import logging
import os
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Tuple, Union

from dotenv import load_dotenv
from pydantic import ValidationError

from src.core.models import EndpointsConfig

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = PROJECT_ROOT / ".env"

# The tool-loop cap a built-in agent is seeded with (D9). It is a *per-agent
# column* now, so nothing here reads it as a fallback: it stays as the one
# number the store's seeder and its tests agree on, which is what keeps a fresh
# install behaving exactly as it did before the cap moved.
DEFAULT_MAX_TOOL_ITERATION = 25

# Managed .env keys, in the order they are written to the file. The model
# connection left this list for nojaé's own settings store, and
# the tool-loop cap left it for a per-agent column: what is left is the
# install's own scope — the debug switch, the connector interpreter and the
# model-endpoint wait's two numbers, all hand-edited like ``NOJAE_PYTHON_ROOT``
# itself.
SETTING_KEYS: Tuple[str, ...] = (
    "LLM_DEBUG",
    "NOJAE_PYTHON_ROOT",
    "NETWORK_FAIL_MAX_RETRY",
    "NETWORK_FAIL_WAIT_FOR",
)

# Names an operating system already owns, which a managed key may therefore
# never take.
#
# This joins the rule AGENTS.md states about a new or renamed key — edit
# ``SETTING_KEYS``, ``_render_env()`` and ``.env.example`` together — with a
# fourth demand: the name must be free of OS variables on *every* supported
# platform. ``load_dotenv_once`` below deliberately keeps dotenv's "existing
# environment wins" precedence, so a key that names an OS variable does not set
# a value at all: the OS value survives and the app reads something it never
# wrote. That is the whole ``TEMP`` story — on Windows ``TEMP`` is the temp
# folder, so a sampling parameter became a directory path (and a stray folder
# appeared in the working location). The check lives on the key list rather
# than inside the loader, because that precedence is the point and not a bug to
# paper over: the collision is prevented by never choosing such a name.
_RESERVED_ENV_NAMES: frozenset[str] = frozenset(
    {
        "TEMP",
        "TMP",
        "PATH",
        "HOME",
        "USER",
        "USERNAME",
        "USERPROFILE",
        "SYSTEMROOT",
        "COMSPEC",
        "PROMPT",
        "OS",
        "APPDATA",
        "LOCALAPPDATA",
        "PROGRAMFILES",
        "COMPUTERNAME",
        "HOMEDRIVE",
        "HOMEPATH",
        "NUMBER_OF_PROCESSORS",
        "PATHEXT",
    }
)

# Keys always written to .env; the others are commented out when empty.
# No key is always-written any more: the two this named were the group-1
# endpoint pair, and that whole group now lives in the workspace's settings
# file — which has its own committed template and no always-written member.
REQUIRED_SETTING_KEYS: Tuple[str, ...] = ()

# Debug switch for the in-house LLM client. When set, ``nojae.llm`` —
# the logger ``core/llmkit`` writes its request payloads to — is raised to
# DEBUG and its output reaches the server console, so a failed call can be read
# off that console: which URL was POSTed, with what payload. The *status and
# upstream body* of a refused call reach the UI's error line whether or not the
# flag is on (they are in the exception message itself); what the flag adds on
# top is the request payload.
#
# The value lives in ``.env`` (a managed ``SETTING_KEYS`` key) rather than in
# code so it can be flipped without touching the code, and it is applied to the
# live process at startup and on every settings save — which then simply
# re-applies the value the file holds, because the settings dialog stopped
# carrying the switch (spec section 7). Hand-edit it like
# ``NOJAE_PYTHON_ROOT``.
LLM_DEBUG_KEY = "LLM_DEBUG"

# The name this switch had while the calls went through litellm. It lives here
# only as the fallback in ``llm_debug_enabled``, so a hand-written ``.env``
# keeps working until the dialog rewrites that file from the template — the
# key itself is a ``.env`` key either way, which is what makes the fallback
# last exactly as long as the file that needs it.
LEGACY_LLM_DEBUG_KEY = "LITELLM_DEBUG"

TRUTHY_VALUES = frozenset({"1", "true", "yes", "on"})


def env_flag(key: str) -> bool:
    """True when an env var is set to a truthy value (1/true/yes/on)."""
    return (os.environ.get(key) or "").strip().lower() in TRUTHY_VALUES


def llm_debug_enabled() -> bool:
    """True when the in-house LLM client's debug logging was requested.

    ``LLM_DEBUG`` is the key; the legacy name above is still honoured while the
    new key is unset, so a ``.env`` written by hand before the rename keeps
    working until the settings dialog regenerates that file from its template.
    The new key wins when both are set.
    """
    # *Which* name answers, then one truthiness rule for both: the new key is
    # the one asked while it holds something, so an explicit "0" under it means
    # off even while the legacy name still says on.
    key = (
        LLM_DEBUG_KEY
        if (os.environ.get(LLM_DEBUG_KEY) or "").strip()
        else LEGACY_LLM_DEBUG_KEY
    )
    return env_flag(key)


# The model-endpoint wait's two numbers (spec §6). Both are managed ``.env``
# keys, hand-edited like ``NOJAE_PYTHON_ROOT`` — the settings dialog carries no
# ``.env`` key any more — and neither name collides with an OS variable, so the
# ``_RESERVED_ENV_NAMES`` rule above is satisfied.
#
# ``NETWORK_FAIL_MAX_RETRY`` is how many waits one *round* of the tool loop may
# spend before the failure is final; a written ``0`` switches the whole guard
# off and restores today's behaviour exactly. ``NETWORK_FAIL_WAIT_FOR`` is the
# seconds between two attempts. The defaults are non-zero on purpose: the
# feature has to be on without configuration, or it would not have saved the run
# that motivated it.
NETWORK_FAIL_MAX_RETRY_KEY = "NETWORK_FAIL_MAX_RETRY"
NETWORK_FAIL_WAIT_FOR_KEY = "NETWORK_FAIL_WAIT_FOR"
DEFAULT_NETWORK_FAIL_MAX_RETRY = 3
DEFAULT_NETWORK_FAIL_WAIT_FOR = 10


def _non_negative_int(raw: Optional[str], default: int) -> Tuple[int, bool]:
    """``(value, fell_back)`` for one key's raw text (``None`` when unset).

    A written value must be a whole number of ``0`` or more; anything else —
    blank, ``ten``, ``-1``, ``1.5`` — is **not** coerced silently but answered
    as the default for this key, and ``fell_back`` says so. Zero is a real
    value, never a missing one: ``0`` retries is the feature switched off.

    An **unset** key is not a mistake and answers the default quietly; one that
    is *written* but blank is, because a hand-edited line saying nothing is a
    value somebody meant to fill in.
    """
    if raw is None:
        return default, False
    text = raw.strip()
    if not text:
        return default, True
    try:
        value = int(text)
    except ValueError:
        return default, True
    if value < 0:
        return default, True
    return value, False


def network_fail_budget() -> Tuple[int, int]:
    """The effective ``(max_retry, wait_seconds)`` of the endpoint-wait guard.

    Read from ``os.environ`` **at call time**, never cached at boot (spec §6):
    the decision this answers belongs to the moment a refused round is about to
    be retried, which is why the chat route passes this function itself into
    ``stream_chat`` rather than a number. A hand-edit of ``.env`` still waits for
    a restart like every other key there, because that is when the file is read.

    Never raises. Each key is coerced on its own, so one unusable value leaves
    the other key's written value in force.
    """
    max_retry, _ = _non_negative_int(
        os.environ.get(NETWORK_FAIL_MAX_RETRY_KEY),
        DEFAULT_NETWORK_FAIL_MAX_RETRY,
    )
    wait_seconds, _ = _non_negative_int(
        os.environ.get(NETWORK_FAIL_WAIT_FOR_KEY),
        DEFAULT_NETWORK_FAIL_WAIT_FOR,
    )
    return max_retry, wait_seconds


def network_fail_readout() -> Dict[str, Dict[str, Any]]:
    """Per key: the raw text found in the environment, and whether it fell back.

    ``{"NETWORK_FAIL_MAX_RETRY": {"raw": "ten", "fellBack": True}, …}`` — the
    data ``GET /api/config`` reports so a written ``10`` can be told from a
    written ``ten``, which is what spec §6 means by "the settings surface
    reports the key's effective value so the mistake is visible". ``raw`` is
    empty when the key is unset (or blank), and ``fellBack`` is true only when a
    written value was unusable and the default answered instead.
    """
    readout: Dict[str, Dict[str, Any]] = {}
    for key, default in (
        (NETWORK_FAIL_MAX_RETRY_KEY, DEFAULT_NETWORK_FAIL_MAX_RETRY),
        (NETWORK_FAIL_WAIT_FOR_KEY, DEFAULT_NETWORK_FAIL_WAIT_FOR),
    ):
        raw = os.environ.get(key)
        _value, fell_back = _non_negative_int(raw, default)
        readout[key] = {"raw": raw or "", "fellBack": fell_back}
    return readout


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

    Called at app startup (right after the .env is read) and again on every
    settings save, where it re-applies the value the file holds — the dialog
    stopped carrying the switch, so a hand-edit lands on the next save or
    restart, not by itself. The off path is just as explicit: the level goes
    back to ``NOTSET``
    — which inherits WARNING from the root logger, exactly where it stood
    before the switch was ever on — and the handler comes off, so a process
    never stays chatty (nor silent) after the flag is cleared.

    What the flag adds is the *request payload* of every model call: the URL,
    the model, and the body as it goes out. Never the ``Authorization`` header,
    so the API key cannot reach the console from here. The status and upstream
    body of a *refused* call need no flag at all: they are in the exception
    message the two consuming loops emit into the UI's error line.

    It also points ``core/llmkit``'s debug hook at this predicate, so payload
    logging follows the switch: ``llmkit`` is core and must not import the
    layer that owns the setting, while ``config`` sits below both. Returns
    whether the switch is now on.
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


def load_dotenv_once() -> None:
    """Load the .env file once; existing environment variables take precedence."""
    if ENV_PATH.exists():
        load_dotenv(ENV_PATH)


# Values the app provides for ``${NAME}`` references in the hub declaration
# files (see ``mcphub.validation.expand_env``). Both names here are **computed**,
# never read back from the environment, and the two must not be confused:
#
# * ``NOJAE_PATH_LOCATION`` is the **folder being served** — the workspace of the
#   call doing the expansion, read through the seam
#   (:func:`src.core.workspace.provided_path_location`) rather than from
#   ``os.environ``. That is what makes one declaration file correct in two
#   workspaces at once: a tab on A gets A's connectors rooted at A, a tab on B
#   gets B's (spec §4.3). Reading the environment here would answer "which
#   folder does this *process* hold", which is the question this lot retires.
# * ``PROJECT_ROOT`` is the **installation**, in every workspace and always.
#
# Neither is *exported* into the environment either: the app computes both, so
# the values are always right, and a generic name like ``PROJECT_ROOT`` exported
# process-wide would collide with whatever a shell, a CI runner or one of the
# connectors' own scripts calls its project root — the ``TEMP`` lesson in
# ``_RESERVED_ENV_NAMES``, seen from the other side: a name the world already
# uses cannot become an export of ours either. Both therefore reach expansion
# from this computation alone, and a stray value in the environment cannot
# redirect connectors away from this install or away from the workspace asked
# about. An unresolved ``${NAME}`` still stays written as-is with a note (the
# rule ``expand_env`` holds); these two simply always resolve.


#: The **name** ``NOJAE_PATH_LOCATION`` has in this app: the placeholder a
#: workspace's declaration file writes (``--root-dir`` / ``workspaceRoot``) and
#: the key :func:`provided_env_values` answers with the workspace being served
#: (spec §4.3). It is not an environment key any more — clws-10 deleted the
#: process-wide value, its accessor and the boot seed that wrote it, so this
#: constant and that one answer are the whole of the name's life in ``src``.
PATH_PLACEHOLDER = "NOJAE_PATH_LOCATION"


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


def load_settings() -> Dict[str, str]:
    """Return the effective value of every managed .env key (empty if unset).

    ``os.environ`` already reflects the .env file loaded at startup (real
    environment variables keep precedence) and is refreshed on every save.
    Every managed key answers empty when unset — no managed key defaults here:
    the *raw* text is what a save must keep, so the endpoint-wait pair's
    effective values come from :func:`network_fail_budget` instead.
    """
    return {key: os.environ.get(key) or "" for key in SETTING_KEYS}


def save_settings(values: Dict[str, str]) -> None:
    """Persist managed settings to the .env file and refresh ``os.environ``.

    Empty optional values are written as commented-out lines and removed from
    the environment (``REQUIRED_SETTING_KEYS`` is empty, so no key is
    always-written). The file is regenerated from a fixed template mirroring
    ``.env.example``.
    """
    clean: Dict[str, str] = {
        key: (values.get(key) or "").strip() for key in SETTING_KEYS
    }
    ENV_PATH.write_text(_render_env(clean), encoding="utf-8")
    for key in SETTING_KEYS:
        if clean[key]:
            os.environ[key] = clean[key]
        else:
            os.environ.pop(key, None)
    # The fallback key goes with them: the regenerated file no longer holds it,
    # so an environment still carrying the legacy name the boot loaded would
    # keep the switch on through a save that unticked it. Dropping it here is
    # what makes the fallback last exactly as long as the hand-written .env it
    # exists for — no longer.
    if not clean[LLM_DEBUG_KEY]:
        os.environ.pop(LEGACY_LLM_DEBUG_KEY, None)
    # Re-apply the debug switch from the values just written, so ticking the
    # box in the settings dialog takes effect on the *current* process (the
    # next call is what gets the extra logging) instead of waiting for a
    # server restart.
    apply_llm_debug()


def _render_env(values: Dict[str, str]) -> str:
    """Render the .env file content from the managed values."""

    def line(key: str) -> str:
        value = values.get(key, "")
        if not value:
            return f"#{key}="
        return f"{key}={_encode_value(value)}"

    lines = [
        "# Nojaé configuration (managed by the settings dialog).",
        "# Real environment variables take precedence over the values defined here.",
        "",
        "# LLM_DEBUG=1 logs every request's payload (URL, model, body) to the",
        "# server console at DEBUG, so a failed call can be read off it. The",
        "# refused call's status and upstream body reach the UI's error line",
        "# whether or not this is on; what the flag adds is the payload.",
        "# Verbose, so switch it back off once the failure has been read.",
        line("LLM_DEBUG"),
        "",
        "# MCP connectors (Chat tab only) are declared only in",
        "# .nojae/mcp-settings.json at the working location: seeded from",
        "# mcp_connectors/mcp-settings.default.json when a folder becomes the",
        "# working location, their per-entry ``enable`` flag is the single",
        "# source of truth, no .env key is involved.",
        "# The model connection — servers, their models, the key, the system",
        "# prompt, sampling and the vision flag — and the tool-loop cap (one",
        "# number per agent) live in nojae's settings store at the install",
        "# root, edited from the Settings dialog. It is a database, not a file",
        "# to hand-edit, and no .env key is involved.",
        "",
        "# Absolute path to the python interpreter the stdio connectors run",
        "# on (the console and fedit commands in .nojae/mcp-settings.json",
        "# expand ${NOJAE_PYTHON_ROOT} from it). Unset leaves their",
        "# commands unresolved — the MCP panel names the key.",
        line("NOJAE_PYTHON_ROOT"),
        "",
        "# How many times a refused model round is asked again before the",
        "# failure is final (default 3). 0 switches the waiting off, so a",
        "# refused round fails on its first attempt as it did before.",
        line("NETWORK_FAIL_MAX_RETRY"),
        "",
        "# Seconds to wait between two attempts at the same round (default",
        "# 10). 0 asks again at once, spending the same budget with no pause.",
        line("NETWORK_FAIL_WAIT_FOR"),
        "",
    ]
    return "\n".join(lines)


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


def _encode_value(value: str) -> str:
    """Quote a .env value when it contains characters dotenv would misread."""
    if any(char in value for char in '#"$\\ \n\t') or "\n" in value:
        escaped = value.replace("\\", "\\\\").replace('"', '\\"')
        escaped = escaped.replace("\n", "\\n").replace("\t", "\\t")
        return f'"{escaped}"'
    return value
