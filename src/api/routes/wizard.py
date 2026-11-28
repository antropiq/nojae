"""The connector wizard's transport: it reads, it thinks, it writes nothing."""

from pathlib import Path
from typing import Any, Dict, Optional, Tuple

from fastapi import APIRouter, HTTPException, Request

from src.config import agent_connection_refusal
from src.core.mcphub import load_externals
from src.core.mcphub import catalogue as mcp_catalogue
from src.core.lsphub import all_servers
from src.core import editorfs
from src.core import agent_modes
from src.core import appdb
from src.core import wizard as wizard_core

from src.api.routes.config import _agent_row_for, _load_config
from src.api.routes.inputs import WizardPrepareIn, WizardProposeIn
from src.api.routes.seam import require_workspace

# -- the connector wizard's routes ------------------------------------------
#
# One dialog, two families, and every route here is **transport**: it resolves
# the workspace and the connection, calls core, and turns the answer into a
# status. No rule about the wizard lives in this file — the catalogue, the
# scan, the two prompts and the three snippet checks each own their half, and
# these functions only join them.
#
# What none of them may do: nothing here writes a declaration, starts a
# connector or a language server, installs a package, or reaches a declaration
# writer, a `/api/fs` write, the seeding path or a settings-store write.
# Discovery therefore acquires no hub set either — the declared ids come from
# the loaders directly, which is also why a folder the pool refused is still
# scannable and still preparable.

router = APIRouter()


def _wizard_agent(agent_id: str) -> Dict[str, Any]:
    """The store's row for the agent the panel is showing, or a 422 naming it.

    Never a silent default agent: an id that names no row is a typo, and
    answering it with another agent would answer the user's question with the
    wrong one. The detail lists what *is* available, in the chat route's own
    words, with the field's name in front so the client can place it.
    """
    raw = (agent_id or "").strip()
    mode, _mode_findings = agent_modes.resolve_mode(raw)
    if mode is None:
        available = ", ".join(
            entry.id for entry in agent_modes.resolve_modes()["modes"]
        )
        raise HTTPException(
            status_code=422,
            detail=(
                f"agentMode: unknown agent mode {raw!r}. "
                f"Available: {available}"
            ),
        )
    return _agent_row_for(mode)


def _wizard_connection(agent: Dict[str, Any]) -> wizard_core.modelstep.Connection:
    """The connection **this request** runs on, resolved once and held.

    Exactly the chat turn's rule: one resolution at the step's start, so a
    settings save landing mid-dialog cannot split it. The refusal is
    :func:`src.config.agent_connection_refusal`'s sentence, reused verbatim,
    and it costs 422 here because a dialog opened on a live button must not
    then answer with a model the user never chose.
    """
    config = _load_config(agent)
    models = config.model_list()
    if not models:
        raise HTTPException(
            status_code=400, detail="No models configured (ENDPOINT)"
        )
    return wizard_core.modelstep.Connection(
        model=models[0],
        server_url=config.serverUrl,
        api_key=config.apiKey,
        sampling=config.to_kwargs(),
    )


def _wizard_names(
    agent: Dict[str, Any]
) -> Tuple[Optional[str], Optional[str]]:
    """``(model name, server name)`` for the header line, or ``(None, None)``.

    The read must answer even when the store is damaged — that is exactly the
    state in which the button has to explain itself rather than 500. So an
    unusable row, a model whose server is gone and an unopenable store all
    degrade to "this is not known", beside the refusal
    :func:`agent_connection_refusal` already answered with.
    """
    model_id = agent.get("modelId")
    if model_id is None:
        return None, None
    try:
        model = appdb.model_row(model_id)
        server = appdb.server_row(model["serverId"]) if model else None
    except appdb.AppStoreError:
        # The refusal already names the store's path; this read adds nothing
        # to it, and a 500 here would hide the sentence behind a stack trace.
        return None, None
    return (
        model["name"] if model else None,
        server["name"] if server else None,
    )


def _wizard_declared() -> Dict[str, Any]:
    """This workspace's declared servers, as :func:`project_facts` wants them.

    Read from the two hubs' **loaders**, not from a hub set: the scan takes
    the declared ids as data (``editorfs`` must not import a hub — the LSP hub
    already reaches into ``editorfs.policy``), and joining them is exactly what
    a route is for. Nothing is started by reading a declaration, and a
    declaration file that does not exist is ``([], [])``, never an error.
    """
    connectors, _connector_errors = load_externals()
    servers, _server_errors = all_servers()
    return {
        "mcp": [connector["id"] for connector in connectors],
        "lsp": [
            {
                "id": server["id"],
                "extensions": list(server.get("extensions") or []),
            }
            for server in servers
        ],
    }


def _wizard_facts() -> Dict[str, Any]:
    """The scan's derived facts about the folder this request named."""
    return editorfs.project_facts(_wizard_declared())


def _wizard_declaration_path(family: str) -> Path:
    """The **absolute** path of the declaration file this family's entry
    belongs in, resolved through the family's own hub at call time.

    A :class:`pathlib.Path`, because page 3 needs both halves: the text to
    print and whether the file is there at all. Never created — a file that
    is missing is reported, not fixed.
    """
    return wizard_core.snippet.declaration_file(family)


def _catalogue_entry(entry_id: Any) -> Dict[str, Any]:
    """One catalogue entry by id, or a 422 naming ``candidate``.

    The catalogue is the **only** source of a package name, so the entry is
    looked up again here rather than trusted from the request: a body that
    carried its own member could hand the model — and then the user — a
    command line no reviewer ever saw.
    """
    entries, notes = mcp_catalogue.load_catalogue()
    for entry in entries:
        if entry["id"] == entry_id:
            return entry
    reason = notes[0] if notes else "the catalogue holds no entry of that id"
    raise HTTPException(
        status_code=422,
        detail=f"candidate: unknown catalogue entry {entry_id!r} — {reason}",
    )


def _catalogue_install(entry: Dict[str, Any]) -> Dict[str, str]:
    """The install lines the catalogue itself carries, per platform.

    The entry's ``requires`` group and nothing else: it is guidance, so it
    never becomes part of the member, and the app never invents a line of its
    own. ``any`` is the line where no platform differs, and a platform's own
    key beside it overrides that one.
    """
    requires = (entry.get("requirements") or {}).get("requires") or {}
    return {
        platform: item["install"]
        for platform, item in requires.items()
        if isinstance(item, dict) and isinstance(item.get("install"), str)
    }


@router.get("/wizard/catalogue")
def get_wizard_catalogue() -> Dict[str, Any]:
    """The committed MCP catalogue, for page 1's list — **installation-scoped**.

    No model runs and no folder is read, so a tab whose folder has been deleted
    can still open the wizard. A catalogue that cannot be read answers an empty
    list **and the sentence naming it**, never a silent empty list.
    """
    entries, notes = mcp_catalogue.load_catalogue()
    return {"entries": entries, "notes": notes}


@router.get("/wizard/connection")
def get_wizard_connection(agentMode: str = "") -> Dict[str, Any]:
    """What the dialog's header line and the buttons' gate are built from.

    **Installation-scoped**, like the catalogue above: a tab whose folder has
    gone must still be able to say who it would run as.

    Three **names** and one verdict travel; no ``api_key``, no URL and no
    sampler value, because the credential never leaves the server. ``canRun``
    false carries :func:`src.config.agent_connection_refusal`'s sentence
    verbatim — the chat route's and the app bar's own words, reused.
    """
    agent = _wizard_agent(agentMode)
    refusal = agent_connection_refusal(agent)
    model, server = _wizard_names(agent)
    return {
        "agentMode": agent["id"],
        "agent": agent.get("label") or agent["id"],
        "server": server,
        "model": model,
        "canRun": refusal is None,
        "refusal": refusal,
    }


@router.get("/wizard/scan")
def get_wizard_scan(request: Request) -> Dict[str, Any]:
    """The derived facts about **this request's** folder, and never its bytes.

    Every rule (the policy verdict per path, the allow-list, the cap, the
    one-level symlink rule) is
    :func:`src.core.editorfs.projectfacts.project_facts`'s — this route only
    fills in the declared ids, which the scan takes as data because
    ``editorfs`` must not import a hub.

    The field is asked for **first** (``require_workspace``), so a folder that
    was named and refused is the seam's 422 and never a scan of some other
    folder. Nothing is cached, so moving a tab's folder invalidates this answer
    by construction.
    """
    require_workspace(request)
    return {"facts": _wizard_facts()}


@router.post("/wizard/propose")
def post_wizard_propose(body: WizardProposeIn, request: Request) -> Dict[str, Any]:
    """The LSP flow's first step: the servers this folder lacks, best first.

    A **plain JSON post**, not SSE: one answer, no frames, no terminal event,
    nothing entering the stream layer. The connection is resolved once, from
    the agent the panel is showing, and held for this one call.

    A model step that failed answers **200** with its sentence — the client
    renders it and the user presses the button again — because a 5xx would read
    like the app's own fault. Only a bad request (an unknown agent, a folder
    that was refused) is a 4xx.
    """
    require_workspace(request)
    connection = _wizard_connection(_wizard_agent(body.agentMode))
    declaration_path = _wizard_declaration_path("lsp")
    answer = wizard_core.modelstep.propose(
        connection, _wizard_facts(), str(declaration_path)
    )
    return {**answer, "declarationPath": str(declaration_path)}


@router.post("/wizard/prepare")
def post_wizard_prepare(body: WizardPrepareIn, request: Request) -> Dict[str, Any]:
    """Both families' second step: the complete member, and page 3's verdict.

    The same resolution as the propose post — one call, one answer, a plain
    JSON body, no frames — then the three checks: the hubs' **own loader's**
    verdict, the command *resolved* (never spawned), and a duplicate id as a
    warning rather than a stop.

    Nothing is written: the declaration file is read (to warn and to name its
    path) and never touched, and no connector or language server is started.
    """
    resolved = require_workspace(request)
    family = (body.family or "").strip()
    if family not in wizard_core.prompts.FAMILIES:
        raise HTTPException(
            status_code=422,
            detail=(
                f"family: unknown wizard family {body.family!r} — expected "
                f"one of {', '.join(wizard_core.prompts.FAMILIES)}"
            ),
        )
    connection = _wizard_connection(_wizard_agent(body.agentMode))
    declaration_path = _wizard_declaration_path(family)
    install: Dict[str, str] = {}
    if family == "mcp":
        # Which connector this is comes from the catalogue and nowhere else,
        # so the candidate is looked up here and the model is handed the
        # reviewed entry's own member group.
        entry = _catalogue_entry((body.candidate or {}).get("id"))
        candidate: Dict[str, Any] = dict(entry["member"])
        install = _catalogue_install(entry)
    else:
        candidate = dict(body.candidate or {})
    answer = wizard_core.modelstep.prepare(
        family, connection, candidate, _wizard_facts(), str(declaration_path)
    )
    # One **shape** whatever happened, so the dialog renders answers only:
    # a failed step answers the same keys as a prepared one, with the member
    # and the verdict empty. A second shape for the failure would put an
    # "which one is this" test in the template, which is the rule this
    # feature is built on not doing.
    page: Dict[str, Any] = {
        "family": family,
        "outcome": answer["outcome"],
        "sentence": answer["sentence"],
        "notes": answer["notes"],
        "declarationPath": str(declaration_path),
        "declarationExists": declaration_path.is_file(),
        "id": None,
        "member": None,
        "snippet": None,
        "accepted": None,
        "verdict": None,
        "verdictNotes": [],
        "readiness": None,
        "program": None,
        "searched": None,
        "install": install,
        "requiresInstall": False,
        "decisions": [],
        "duplicate": None,
        "valueForm": None,
        "valueWarning": None,
        "valueFindings": [],
        "offered": False,
    }
    prepared = answer["prepared"]
    if prepared is None:
        return page
    assessed = wizard_core.snippet.assess(
        family,
        prepared["id"],
        prepared["member"],
        declaration_path=declaration_path,
        # The catalogue's install lines win for MCP: they are reviewed data,
        # and the app inventing an install line is what must never happen.
        # LSP has no catalogue, so the model's own line stands.
        install=install or prepared["install"],
        workspace_root=resolved.root,
    )
    return {
        **page,
        "id": prepared["id"],
        "member": assessed["member"],
        "snippet": assessed["snippet"],
        "accepted": assessed["accepted"],
        "verdict": assessed["verdict"],
        "verdictNotes": assessed["notes"],
        "readiness": assessed["readiness"],
        "program": assessed["program"],
        "searched": assessed["searched"],
        "install": assessed["install"],
        "requiresInstall": prepared["requiresInstall"],
        "decisions": prepared["decisions"],
        "duplicate": assessed["duplicate"],
        "valueForm": assessed["valueForm"],
        "valueWarning": assessed["valueWarning"],
        "valueFindings": assessed["valueFindings"],
        "offered": assessed["offered"],
    }
