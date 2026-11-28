"""The app bar's one read of a workspace: the folder, and the reserved files in it.

It reports and seeds nothing: a folder someone only meant to browse is left
exactly as it was, and its tools are read from the pool, never admitted.
"""

from typing import Any, Dict

from fastapi import APIRouter, Request

from src.core.mcphub import mcp_settings_file_state
from src.core.lsphub import lsp_settings_file_state, lsp_settings_template_state
from src.core.editorfs import policy_seed
from src.core import workspace as workspace_seam

from src.api.routes.hubs import _hub_pool, _lsp_payload, _mcp_payload, _read_hub_set
from src.api.routes.seam import require_workspace

router = APIRouter()


def _policy_block(root: str) -> Dict[str, Any]:
    """What the workspace's policy file looks like, **read-only**.

    The pool seeds a default ``.nojae/read-write-policy.json`` when it admits
    a folder, so this reader must not write one: the app bar reads a folder
    far more often than the pool admits it, and a read that leaves a folder
    in someone's project is the mistake the seeding rules forbid. ``state``
    is ``existing`` / ``absent`` / ``failed`` here, and the app bar leaves
    ``absent`` as the plain fact it is.

    ``root`` is the folder being reported on, spelled by the caller.
    """
    return policy_seed.policy_file_state(root)


def _mcp_settings_block(root: str) -> Dict[str, Any]:
    """What the workspace's MCP declaration file looks like, **read-only**.

    A reserved-folder reader: the MCP seed runs at admission, so a GET
    reports the file instead of leaving one behind. ``absent`` is a plain
    fact — a workspace whose seed failed has no MCP connectors, and the
    Settings → MCP panel says so.
    """
    return mcp_settings_file_state(root)


def _lsp_settings_block(root: str) -> Dict[str, Any]:
    """What the workspace's LSP declaration file looks like, **read-only**.

    The declaration is hand-written — only its *template* is seeded (its
    entries are per-machine) — so this report is the panel's way to say
    "no language servers declared yet" and point at the template.
    """
    return lsp_settings_file_state(root)


def _lsp_template_block(root: str) -> Dict[str, Any]:
    """What the workspace's LSP template file looks like, **read-only**.

    A reserved-folder reader: the template seed runs at admission, so a GET
    reports the file instead of leaving one behind. ``absent`` is a plain
    fact — the example is still committed, the workspace just lost the
    copy-me shortcut.
    """
    return lsp_settings_template_state(root)


@router.get("/workspace")
def get_workspace(request: Request) -> Dict[str, Any]:
    """Report **one workspace**: the folder, and the four reserved files in it.

    The app bar's only read of a folder, and the one the tab's field asks
    before adopting what it typed. Two tabs on two folders each see their own
    policy and their own declarations. It is a **read**: it validates and
    reports, and seeds nothing — a folder someone only meant to browse is
    left as it was.

    ``{"workspace", "default", "policy", "mcpSettings", "lspSettings",
    "lspSettingsTemplate", "hubs"}``: ``workspace`` is the resolved root,
    ``default`` the installation folder a new tab lands on, the four blocks
    the reserved folder's read-only state, and ``hubs`` the pool's answer
    about this folder — the two hub payloads of **this workspace's** own set
    plus :meth:`src.core.hubpool.HubPool.summary`.

    The hub half is a **read of the pool, not an admission**: this route is
    asked far more often than a folder is admitted, and admission seeds a
    reserved folder and starts processes. A folder whose tools are not alive
    is therefore answered with an empty catalogue and ``installed: false`` —
    a different answer from the ceiling's sentence, and the two must not be
    merged. The panel routes themselves do admit, which is where a returning
    tab's tools come back visibly.

    A folder that cannot be a workspace answers 422 with the seam's sentence
    and nothing else: no answer here is ever about a *different* folder. A
    folder the pool cannot admit answers 429 with the pool's sentence, from
    here as from the hub routes.
    """
    resolved = require_workspace(request)
    root = resolved.root
    hub_set, built = _read_hub_set(request)
    return {
        "workspace": root,
        "default": workspace_seam.installation(),
        "policy": _policy_block(root),
        "mcpSettings": _mcp_settings_block(root),
        "lspSettings": _lsp_settings_block(root),
        "lspSettingsTemplate": _lsp_template_block(root),
        "hubs": {
            "mcp": _mcp_payload(hub_set.mcp if hub_set else None, built),
            "lsp": _lsp_payload(hub_set.lsp if hub_set else None, built),
            "pool": _hub_pool(request).summary(),
        },
    }
