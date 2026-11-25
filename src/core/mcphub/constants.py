"""Static configuration of the MCP hub: paths, retry policy, refusal wording.

Everything here is a *module attribute* read at call time (same idea as
``lsphub.constants``), so pointing the hub at another folder is one attribute
patch instead of an import dance. The declaration belongs to the *workspace*,
so ``mcp_settings_path()`` is built per call out of the active working location;
the install-level file beside the connector scripts is the committed
*template* the seed copies when a folder becomes the working location.
"""

import sys
from pathlib import Path
from typing import Optional

# The one reach-capability seam, re-exported through *this* module so both hubs
# answer the question with the same function and a test forces it the same way
# it redirects any other hub constant.
from .process import guardrails_speak_here  # noqa: F401 — bound as a hub attribute
from src.core import workspace

# The reserved folder's name comes from ``mcp_connectors/policy_shared`` — a
# module outside ``src`` so the stdio connectors can read it too. Two constants
# for one folder name is how the folder stops being one folder.
try:
    from mcp_connectors import policy_shared as shared
except ImportError:  # pragma: no cover - depends on how the app is started
    _root = str(Path(__file__).resolve().parents[3])
    if _root not in sys.path:
        sys.path.insert(0, _root)
    from mcp_connectors import policy_shared as shared  # type: ignore[no-redef]

POLICY_DIRNAME: str = shared.POLICY_DIRNAME

PROJECT_ROOT = Path(__file__).resolve().parents[3]
MCP_CONNECTORS_DIR = PROJECT_ROOT / "mcp_connectors"

# The workspace's connector declaration file (kilo.json-style, keyed by id),
# inside the reserved folder at the working location: the one and only source
# of MCP connectors. It may hold API keys in ``headers``/``env``, so it is
# gitignored and its contents are never returned by the API. The ``enable``
# toggles do write back into it — the folder's "edited only outside the app"
# rule bends for the switch the UI owns.
MCP_SETTINGS_FILENAME = "mcp-settings.json"

# The committed install-level template the seed copies, byte for byte, when a
# folder becomes the working location. Its ``${NAME}`` references are *not*
# substituted at seed time: every one resolves on every read
# (``validation.expand_env``), which is what keeps one seeded file correct on
# every machine and across every workspace switch.
MCP_SETTINGS_TEMPLATE = MCP_CONNECTORS_DIR / "mcp-settings.default.json"

# The committed catalogue of well-known connectors the wizard offers —
# *catalogue*, never declaration: no hub reads it, no process starts because of
# it, and it is never copied into a workspace. Looked up through this attribute
# at call time, so a test redirects the read by patching one name.
MCP_CATALOGUE_PATH = MCP_CONNECTORS_DIR / "catalog-mcp.json"

# **A pin, not the default.** When not ``None`` it wins over the computed path
# below — one patchable override keeps the tests' one-attribute redirect
# without re-introducing an import-time constant.
MCP_SETTINGS_PATH: Optional[Path] = None


def mcp_settings_path() -> Path:
    """The active workspace's ``.nojae/mcp-settings.json`` (may not exist).

    Built per call, so the pin above, a patched filename, or a different
    workspace each move the lookup the same way. The root comes from the seam
    (:func:`src.core.workspace.current_root`), so a declaration read is always a
    read **of one workspace**, in that workspace's scope — which is what a
    second tab on a second folder needs.
    """
    if MCP_SETTINGS_PATH is not None:
        return MCP_SETTINGS_PATH
    return Path(workspace.current_root()) / POLICY_DIRNAME / MCP_SETTINGS_FILENAME

# Connection retry policy for a freshly launched connector session.
CONNECT_RETRIES = 20
# Local externals launch through a package runner (``npx``), whose cold start
# (download + Node boot) can far exceed the built-in connectors' window.
EXTERNAL_CONNECT_RETRIES = 60
CONNECT_INTERVAL = 0.5
# Grace given to a connector process between SIGTERM and SIGKILL.
STOP_GRACE_SECONDS = 5.0

# How long a synchronous caller waits for one tool call before giving up
# (``McpManager.call_tool_sync``). **A safety net, not a budget**: the connector
# owns the real limit (``execute_command``'s own ``timeout`` argument) and hands
# back what the command had already printed when *it* fires. A caller that knows
# better (the chat side, for a language server's cold start) passes its own;
# patch this attribute to move the net.
TOOL_CALL_TIMEOUT: Optional[float] = 3600.0

CONNECTORS_MISSING_HINT = (
    'The "mcp" package is not installed — run: pip install -e ".[mcp]"'
)

# A `local` (stdio) connector's reach is bounded by the deny-prefixes of
# ``mcp_connectors/path_policy``, which speak both platforms' path forms. Where
# they speak *nothing* — a working location whose form no prefix can name — the
# bound is a claim the app must not make, and the entry is refused instead: same
# channel as an unresolved ``${NAME}``, with a sentence naming the gap. The
# sentence diagnoses what an operator can fix: a guardrail list with no entry in
# this filesystem's path form. Asserted identical to ``lsphub.constants``' copy,
# because the two hubs refuse on one and the same fact — an inert guardrail list.
LOCAL_REACH_REFUSAL = (
    "its reach cannot be bounded on this filesystem: no guardrail entry speaks "
    "this working location's path form"
)
