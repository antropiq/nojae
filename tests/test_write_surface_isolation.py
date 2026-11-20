"""The Editor's write routes are reachable from the browser, and from nothing else.

AGENTS.md promises *"Tools are read-only by design"*. That promise survived the
guarded write surface only because something asserts it, so this file asserts it
six ways, each one a different way the promise could rot:

* **no advertised tool names a write route** — the MCP connectors' own tool
  listings and the LSP hub's tool catalogue, both built the way the hubs build
  them (the connectors answer ``list_tools`` themselves; the LSP catalogue is
  ``TOOL_SPECS`` through ``tools_for_server``, which is what a hub would
  publish for the servers in the committed template). With
  ``NOJAE_DISABLE_MCP``/``_LSP`` the live hubs start disconnected, so the
  lists here come from the sources of truth rather than a session. The same
  lists are asked a second question (eds-04): neither carries the modes file's
  save route nor a helper spelling of it, because that file decides whether
  tools exist at all — a tool reaching it is the one leak no amount of
  read-only tool design would notice.
* **no code path spells a call to one** — a source scan for the write markers
  (``PUT /api/fs``, ``POST /api/fs``, ``DELETE /api/fs`` and the modes file's
  ``POST /api/agent-modes/save``). They may appear in ``src/api/routes.py``
  (the definition) and the composables that call them, and nowhere else. The
  read spellings (``GET /api/fs``, ``GET /api/agent-modes/document``) are
  deliberately *not* markers: the read surface's docstrings name their routes,
  and always will.
* **the model client cannot spell an app route either** — ``core/llmkit`` is
  the one core package that speaks HTTP, and *legally* so (the import scan
  covers the connectors, not ``src/core``), so its share of the promise is the
  *shape* of the URLs it builds: it appends two fixed suffixes under ``/v1``
  and can never produce a path under ``/api/``.
* **the terminal stays a human surface** — the shell is a WebSocket reached
  from the SPA, and neither hub mentions it, so it cannot become a tool by
  someone wiring the hub to ``app.state.terminal``.
* **the modes file's routes are pinned per path, and only the browser's half
  of them writes** — ``.nojae`` stays invisible to ``/api/fs/*``, so its files
  are reached through purpose-built routes rather than a path parameter (none of
  them is an ``/api/fs`` route). The dropdown's reader answers *about* the modes
  file with one verb and no argument; the editor's pair is exactly two routes,
  ``document`` a ``GET`` and ``save`` a ``POST``, and the writer behind the save
  is reached from the routes alone. What must never happen is a **tool** reaching
  that save: it is the switch that decides whether tools exist at all.
* **the Editor pane's action table is a query table too** — ``EDITOR_ACTIONS``
  is the second table of LSP methods in the app, and it is *not* a tool surface:
  adding an action there must never add a tool to a chat turn, and must never
  add a document mutation to the pane either. It is walked by the same guard,
  with the same forbidden list, as ``TOOL_SPECS`` (spec §4.2).

The last test feeds each check a deliberately poisoned input, because a guard
that cannot fail is not a guard: that is the same "assert the invariant, not
the intent" style as the file-icons sync test.
"""

import ast
import asyncio
import json
import re
from pathlib import Path
from typing import Any, Dict, List
from urllib.parse import urlsplit

import pytest

from src.core import editorfs
from src.core.llmkit.client import chat_completions_url, models_url
from src.core.lsphub import editor as lsp_editor
from src.core.lsphub import tools as lsp_tools

REPO_ROOT = Path(editorfs.constants.PROJECT_ROOT)

# The write routes, in the exact spelling a caller would use. Chosen so that a
# docstring naming a route *method* (``GET /api/fs/tree``) stays out of the
# scan, and a comment or a string naming a write is caught. Each family's
# contribution is its **write** routes only: the verb-and-path shape keeps every
# read's spelling — ``GET /api/fs``, ``GET /api/agents``, ``GET
# /api/prompt-helpers`` — out of the scan, because the readers' own docstrings
# name them and always will.
WRITE_MARKERS = (
    "PUT /api/fs",
    "POST /api/fs",
    "DELETE /api/fs",
    # appdb-07: the settings store's prompt-helper writes. Same verb-and-path
    # shape, so the read's spelling (``GET /api/prompt-helpers``) — which the
    # reader's own docstrings name, and will keep naming — stays out of the scan.
    "POST /api/prompt-helpers/add",
    "POST /api/prompt-helpers/save",
    "POST /api/prompt-helpers/delete",
    # appdb-08: the settings store's server and model writes. Same shape again, so
    # the two reads' spellings (``GET /api/servers``, ``GET /api/models``) stay out
    # of the scan for the same reason.
    "POST /api/servers/add",
    "POST /api/servers/save",
    "POST /api/servers/delete",
    "POST /api/models/add",
    "POST /api/models/save",
    "POST /api/models/delete",
    # appdb-10: the agents' writes, which replaced the modes file's whole-document
    # save. Same shape once more, so ``GET /api/agents`` (the dropdown's reader)
    # stays out of the scan.
    "POST /api/agents/add",
    "POST /api/agents/save",
    "POST /api/agents/delete",
)

# The app's own route prefix: a URL whose path holds it could address a write
# route. ``llmkit``'s URL builders are guarded on this below.
APP_ROUTE_PREFIX = "/api/"

# Where a write marker is legitimate.
ALLOWED_HOMES = {
    Path("src/api/routes.py"),          # the routes are defined here
    Path("web/src/composables/useEditorFiles.js"),   # save / delete
    Path("web/src/composables/useEditorCreate.js"),  # create
    Path("web/src/composables/useEditorRename.js"),  # rename
    # Declared with the route, before its caller exists: task mov-03 creates this
    # composable, whose ``fetch`` will name the batch-move route.
    Path("web/src/composables/useEditorMove.js"),    # move batch
}

# The agent write surface on its own, for the checks that ask only about it (the
# tool listings, the poisoned cases): the marker scan above covers them too, but
# a tool list is judged against *these* paths and nothing else. The agents decide
# whether a tool is offered at all, so a tool reaching one is the leak no amount
# of read-only tool design would notice — the same reason the modes file's save
# was pinned here before task 10 replaced it with these.
AGENTS_WRITE_MARKERS = (
    "POST /api/agents/add",
    "POST /api/agents/save",
    "POST /api/agents/delete",
)

# Spellings a connector or a tool description could use for reaching one without
# naming the route verbatim — the same "belt for the prose" the helper names are
# for the Editor's writes.
AGENTS_WRITE_HELPER_SPELLINGS = (
    "agents/add",
    "agents/save",
    "agents/delete",
    "add_agent",
    "update_agent",
    "delete_agent",
)

# A connector that could speak HTTP could call a route it never names in a
# string, so the marker scan alone would miss it. These are the clients that
# would carry one: the top-level module name is enough (``urllib.parse`` builds
# URLs and reaches nothing, ``urllib.request`` does).
HTTP_CLIENTS: frozenset[str] = frozenset({
    "httpx", "requests", "urllib3", "aiohttp", "socket",
    "urllib.request",
})

# The LSP methods that mutate a document rather than ask about it. **One list,
# for both tables**: ``TOOL_SPECS`` (what a chat turn may call) and
# ``EDITOR_ACTIONS`` (what the Editor pane may ask) are guarded by the same
# words, because a second copy is how a guard drifts from what it guards.
FORBIDDEN_LSP_METHODS = (
    "willSave", "didChange", "willCreate", "willRename",
    "willDelete", "executeCommand", "applyEdit",
)


def scan_roots() -> List[Path]:
    """The trees the marker scan walks: everything that is *not* a caller."""
    return [
        REPO_ROOT / "src" / "core",
        REPO_ROOT / "mcp_connectors",
        REPO_ROOT / "lsp_connectors",
        REPO_ROOT / "web" / "src" / "composables" / "useChat.js",
    ]


def offenders_for(markers, roots, allowed=ALLOWED_HOMES) -> List[str]:
    """Every file under ``roots`` carrying one of ``markers``, named relative to
    the repo. One implementation, shared by the guard and by its self-check
    below (a second copy of the walk is how a guard drifts from what it guards).
    """
    found: List[str] = []
    for root in roots:
        candidates = [root] if root.is_file() else sorted(root.rglob("*"))
        for path in candidates:
            if not path.is_file() or path.suffix not in (".py", ".js", ".json", ".txt"):
                continue
            if "__pycache__" in path.parts:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            if any(marker in text for marker in markers):
                label = (
                    str(path.relative_to(REPO_ROOT))
                    if path.is_relative_to(REPO_ROOT)
                    else str(path)
                )
                if Path(label) not in allowed:
                    found.append(label)
    return found


def agent_writer_callers(source_root: Path) -> List[str]:
    """Every file under ``src`` that names the store's agent write accessors.

    One implementation, shared by the guard below and by its self-check — the
    same reason ``offenders_for`` is shared. The store module is skipped (it
    *defines* them), so what is left is the list of callers: the routes alone, or
    something that should not be there.

    Asserted against ``appdb.`` because the routes reach the store through the
    module, not through an import of each name — so a hub that bound the function
    directly would not hide from this.
    """
    found: List[str] = []
    for path in source_root.rglob("*.py"):
        if "__pycache__" in path.parts or path.name == "appdb.py":
            continue  # this *defines* the writers
        text = path.read_text(encoding="utf-8")
        if any(f"appdb.{name}(" in text for name in ("add_agent", "update_agent",
                                                     "delete_agent")):
            found.append(str(path.relative_to(source_root)))
    return sorted(found)


def advertisement_offenders(listing: List[Dict[str, Any]]) -> List[str]:
    """Every advertised tool def that names one of the agent write routes.

    One implementation, shared by the MCP and LSP advertisement guards below and
    by their self-checks — the same reason ``offenders_for`` is shared: a second
    copy of the check is how a guard drifts from what it guards. Each entry is
    judged on its whole published surface (name, description, schema), which is
    what a client is actually told; the LSP defs are flattened to the same shape
    by the caller.
    """
    found: List[str] = []
    for tool in listing:
        haystack = f"{tool['name']} {tool['description']} {tool['schema']}"
        for marker in AGENTS_WRITE_MARKERS:
            if marker in haystack:
                found.append(f"{tool['name']}: {marker}")
        for spelling in AGENTS_WRITE_HELPER_SPELLINGS:
            if spelling in haystack:
                found.append(f"{tool['name']}: {spelling}")
    return found


def http_import_offenders(roots: List[Path]) -> List[str]:
    """Every ``*.py`` under ``roots`` that imports an HTTP client, by file name.

    One implementation, used by the guard on the connector tree and by its
    self-check below — the same reason ``offenders_for`` is shared.
    """
    found: List[str] = []
    for root in roots:
        candidates = [root] if root.is_file() else sorted(root.glob("*.py"))
        for path in candidates:
            try:
                parsed = ast.parse(path.read_text(encoding="utf-8"))
            except (OSError, SyntaxError, UnicodeDecodeError):
                continue
            names: List[str] = []
            for node in ast.walk(parsed):
                if isinstance(node, ast.Import):
                    names.extend(alias.name for alias in node.names)
                elif isinstance(node, ast.ImportFrom):
                    names.append(node.module or "")
            for name in names:
                if name in HTTP_CLIENTS or name.split(".")[0] in HTTP_CLIENTS:
                    found.append(f"{path.name}: {name}")
    return found


def route_registrations(source_text: str, path_prefix: str) -> List[Dict[str, Any]]:
    """Every route ``routes.py`` registers on a path under ``path_prefix``.

    Each answer is ``{"verb", "path", "handler"}``, read out of the decorator
    call (``@router.get("/agent-modes")``) rather than matched as a substring, so
    what is reported is the *registration*: a docstring naming a route cannot
    trip a guard built on this, and a new route cannot hide from one. Both the
    verb guard and the arity guard below share this one walk.
    """
    found: List[Dict[str, Any]] = []
    for node in ast.walk(ast.parse(source_text)):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            call = decorator if isinstance(decorator, ast.Call) else None
            if call is None or not isinstance(call.func, ast.Attribute):
                continue
            if not call.args or not isinstance(call.args[0], ast.Constant):
                continue
            route_path = call.args[0].value
            if isinstance(route_path, str) and route_path.startswith(path_prefix):
                found.append(
                    {"verb": call.func.attr, "path": route_path, "handler": node}
                )
    return found


def builder_paths(builder, bases: List[str]) -> List[str]:
    """The path of every URL ``builder`` produces from ``bases``.

    One implementation, shared by the two ``llmkit`` URL guards below and by
    their self-check — the same reason ``offenders_for`` is shared.
    """
    return [urlsplit(builder(base)).path for base in bases]


def connector_tool_lists() -> Dict[str, List[Dict[str, Any]]]:
    """The tool listing each local MCP connector advertises, by connector id.

    These are the scripts referenced as ``local`` entries in
    ``mcp-settings.json``, and ``list_tools`` is exactly what the hub asks them
    for — so this is the live surface, without needing a connected session.
    """
    from mcp_connectors import console_mcp, fedit_mcp

    listings = {}
    for connector_id, module in (("console", console_mcp), ("fedit", fedit_mcp)):
        tools = asyncio.run(module.server.list_tools())
        listings[connector_id] = [
            {"name": tool.name, "description": tool.description or "",
             "schema": json.dumps(tool.input_schema or {})}
            for tool in tools
        ]
        instructions = getattr(module.server, "instructions", "") or ""
        listings[connector_id].append(
            {"name": "<instructions>", "description": instructions, "schema": ""}
        )
    return listings


def lsp_tool_defs() -> List[Dict[str, Any]]:
    """The defs the hub would publish for the servers in the committed template.

    The declaration file itself is gitignored and machine-local, so the
    template is the portable source of truth for which tools a configured
    server asks for; ``TOOL_SPECS`` supplies their descriptions.
    """
    template = json.loads(
        (REPO_ROOT / "lsp_connectors" / "lsp_servers.example.json").read_text(
            encoding="utf-8"
        )
    )
    definitions: List[Dict[str, Any]] = []
    for server_id, entry in template.items():
        if not isinstance(entry, dict) or "command" not in entry:
            continue
        declared = {**entry, "id": server_id}
        # capabilities=None: consult the declared tool list, which is what the
        # hub does before a handshake (and what it can always fall back to).
        definitions.extend(lsp_tools.tools_for_server(declared, capabilities=None))
    return definitions


def mutation_offenders(table: Dict[str, Dict[str, Any]]) -> List[str]:
    """Every entry of an LSP action table whose method mutates a document.

    One implementation, shared by the two tables' guards below and by their
    self-checks — the same reason ``offenders_for`` is shared: a second copy of
    the walk is how a guard drifts from what it guards. An entry with no method
    (``status``, which the hub's own state answers) is never an offender.
    """
    found: List[str] = []
    for action, spec in table.items():
        method = str(spec.get("method") or "")
        for word in FORBIDDEN_LSP_METHODS:
            if word in method:
                found.append(f"{action} calls {method}")
    return found


class TestNoToolNamesAWriteRoute:
    def test_no_mcp_tool_names_or_describes_a_write_route(self):
        listings = connector_tool_lists()
        assert set(listings) == {"console", "fedit"}
        for listing in listings.values():
            assert listing, "a connector with no tools publishes nothing to catch"
        for connector_id, listing in listings.items():
            for tool in listing:
                haystack = f"{tool['name']} {tool['description']} {tool['schema']}"
                for marker in WRITE_MARKERS:
                    assert marker not in haystack, f"{connector_id}: {tool['name']}"
                # Belt for the prose: no tool names a mutating editor helper.
                for helper in ("write_file", "create_path", "rename_path",
                               "trash_path", "delete_fs", "put_fs"):
                    assert helper not in tool["name"], f"{connector_id}: {helper}"

    def test_no_mcp_tool_advertises_the_modes_save(self):
        """eds-04: the save route is absent from every advertised connector surface.

        The marker scan over the connectors' *sources* cannot see this: a tool that
        *describes* a way to save the modes file would be a hub publishing a write
        route, and the file it writes is the one that decides whether the hub's
        tools exist at all. The listing here is ``list_tools`` plus the server's
        own ``instructions`` text — the whole thing a connected client is told.
        """
        offenders: List[str] = []
        for connector_id, listing in connector_tool_lists().items():
            offenders.extend(f"{connector_id}: {item}"
                             for item in advertisement_offenders(listing))
        assert offenders == [], (
            f"a connector advertises the modes file's save route: {offenders}"
        )

    def test_no_lsp_tool_names_or_describes_a_write_route(self):
        definitions = lsp_tool_defs()
        names = [d["function"]["name"] for d in definitions]
        assert names, "the LSP catalogue is the hub's whole tool surface"
        for definition in definitions:
            haystack = json.dumps(definition)
            for marker in WRITE_MARKERS:
                assert marker not in haystack, definition["function"]["name"]
        # Every published name comes from the catalogue — a name that is not
        # in TOOL_SPECS would have been added somewhere the reviewer never
        # looks.
        catalogue = {
            lsp_tools.tool_name_for(server, action)
            for server in ("pyright", "typescript", "vue")
            for action in lsp_tools.TOOL_SPECS
        }
        assert set(names) <= catalogue
        assert names, "the template declares the servers, so this cannot be empty"

    def test_no_lsp_tool_advertises_the_modes_save(self):
        """eds-04: the hub's published defs carry neither the save path nor a
        spelling of it.

        The LSP hub is the other publisher of tool defs the chat hands the model,
        so it gets the same question as the MCP connectors: does anything it
        advertises name the modes file's write route. The defs are built the way
        the hub builds them (``TOOL_SPECS`` through ``tools_for_server``,
        capabilities ``None``), so this is the catalogue a server would be given.
        """
        listing = [
            {"name": definition["function"]["name"],
             "description": definition["function"]["description"],
             "schema": json.dumps(definition["function"]["parameters"])}
            for definition in lsp_tool_defs()
        ]
        assert listing, "the hub publishes nothing to check"
        offenders = advertisement_offenders(listing)
        assert offenders == [], (
            f"an LSP tool def names the modes file's save route: {offenders}"
        )

    def test_every_lsp_method_is_a_query_not_a_document_mutation(self):
        """Both LSP tables are query tables: the model's and the pane's.

        ``TOOL_SPECS`` is the hub's whole surface for a chat turn, and
        ``EDITOR_ACTIONS`` is the Editor pane's own table (spec §4.2). They are
        deliberately not the same set, and keeping them apart is not tidiness:
        adding an action to ``TOOL_SPECS`` silently adds a tool to every chat
        turn, while adding one to the editor's table must never do that. So a
        future "format on save" cannot arrive as a model tool by accident — and
        cannot arrive as a document mutation in the editor's table either. Both
        are walked by the same forbidden list, because a second copy of it is
        how a guard drifts from what it guards.
        """
        assert lsp_tools.TOOL_SPECS, "the model's table has to exist to be guarded"
        assert lsp_editor.EDITOR_ACTIONS, "the pane's table has to exist to be guarded"
        offenders = (
            mutation_offenders(lsp_tools.TOOL_SPECS)
            + mutation_offenders(lsp_editor.EDITOR_ACTIONS)
        )
        assert offenders == [], (
            f"an LSP action table holds a document mutation: {offenders}"
        )


class TestNoCodePathCallsThem:
    def test_the_write_markers_appear_only_in_the_routes_and_the_callers(self):
        offenders = offenders_for(WRITE_MARKERS, scan_roots())
        assert offenders == [], (
            "a write route is named outside the API layer and the Editor "
            f"composables: {offenders}"
        )

    def test_no_module_under_src_core_imports_the_http_layer(self):
        """The hubs and ``core/chat.py`` run in this process, so reaching a
        route would be an import away — the wall is that there is no import."""
        offenders = []
        for path in (REPO_ROOT / "src" / "core").rglob("*.py"):
            text = path.read_text(encoding="utf-8")
            if "from src.api" in text or "import src.api" in text:
                offenders.append(str(path.relative_to(REPO_ROOT)))
        assert offenders == []

    def test_the_write_core_is_called_from_the_routes_and_nowhere_else(self):
        # ``backup_for_write`` is asked about separately, and not exempted: the
        # settings store borrows it for D12's pre-delete copy of ``nojae.db``
        # (appdb-07), which is one folder and one retention sweep for every
        # replacement the app makes. Since appdb-10 the store is the **only**
        # borrower: the routes stopped naming it when the agent writes moved
        # behind the store's accessors. Every writer of the Editor's surface
        # still stays the routes' alone, so the borrow cannot widen into a write.
        writers = ("write_file", "create_path",
                   "rename_path", "move_paths_batch", "trash_path")
        callers: List[str] = []
        for path in (REPO_ROOT / "src").rglob("*.py"):
            if path.parent.name == "editorfs":
                continue  # these *define* the helpers
            text = path.read_text(encoding="utf-8")
            if any(name in text for name in writers):
                callers.append(str(path.relative_to(REPO_ROOT)))
        assert callers == [str(Path("src") / "api" / "routes.py")]

        borrowers = sorted(
            str(path.relative_to(REPO_ROOT))
            for path in (REPO_ROOT / "src").rglob("*.py")
            if path.parent.name != "editorfs"
            and "backup_for_write" in path.read_text(encoding="utf-8")
        )
        assert borrowers == [str(Path("src") / "core" / "appdb.py")]


class TestTheConnectorsWorkspacePolicyChecksStayInTheirLane:
    """pol-08 gave the connectors a new reason to refuse a path — not a new route.

    The two checks (``fedit_mcp._workspace_policy_reason`` and
    ``console_mcp.workspace_policy_error``, both built on
    ``mcp_connectors.policy_file.workspace_policy_reason``) answer the same
    question the Editor pane answers, and the tempting shortcut is to ask the
    *app* — an HTTP call to a `/api/fs` route, which would hand a connector a
    write surface it has never had. Pinned three ways: the functions are still
    there (a rename that drops the check would otherwise pass every other test
    in this file), the shared loader reads a file rather than a socket, and no
    connector module can reach a route at all.
    """

    def test_the_three_new_functions_exist(self):
        from mcp_connectors import console_mcp, fedit_mcp, policy_file

        assert callable(fedit_mcp._workspace_policy_reason)
        assert callable(console_mcp.workspace_policy_error)
        assert callable(policy_file.workspace_policy_reason)

    def test_no_connector_module_imports_an_http_client(self):
        """A refusal path that cannot speak HTTP cannot reach a write route.

        The marker scan looks for a route *named in a string*; this one looks for
        the transport that could call a route without ever naming it. pol-08 is
        the moment that matters: the connectors now answer a question the app
        also answers, and "just ask the running app" is the shortcut that would
        turn a refusal path into a client of the write surface.
        """
        assert http_import_offenders([REPO_ROOT / "mcp_connectors"]) == []

    def test_the_verdict_comes_from_a_file_on_disk_not_from_a_transport(self):
        """The check answers locally: an unreadable root yields no verdict.

        A root with no policy file is the state a connector reaches when its
        workspace was never seeded, and the answer is "no rules" — a None, not a
        refusal fetched from the app. If the connector ever asked the running app
        instead, this is where it would show up.
        """
        from mcp_connectors import policy_file as connector_policy

        assert connector_policy.workspace_policy_reason(
            "web/vendor/x.js", root="/definitely-not-a-workspace", for_write=True,
        ) is None
        text = (REPO_ROOT / "mcp_connectors" / "policy_file.py").read_text(
            encoding="utf-8"
        )
        for marker in ("httpx", "requests.", "urllib.request", "socket"):
            assert marker not in text, marker


class TestTheTerminalStaysHumanOnly:
    def test_neither_hub_mentions_the_terminal(self):
        """The shell is one WebSocket per session, reached from the SPA."""
        offenders = []
        for folder in ("mcphub", "lsphub"):
            for path in (REPO_ROOT / "src" / "core" / folder).rglob("*.py"):
                text = path.read_text(encoding="utf-8")
                for marker in ("termhub", "/api/terminal", "TerminalHub"):
                    if marker in text:
                        offenders.append(f"{path.relative_to(REPO_ROOT)}: {marker}")
        assert offenders == []

    def test_the_terminal_route_is_a_websocket_and_not_a_tool(self):
        routes = (REPO_ROOT / "src" / "api" / "routes.py").read_text(encoding="utf-8")
        assert '@router.websocket("/terminal")' in routes
        # Nothing outside termhub itself holds a session handle, so no hub or
        # chat path can drive a shell: the registry is reached from the SPA and
        # from the lifespan teardown only.
        assert offenders_for(
            ("app.state.terminal",),
            [
                REPO_ROOT / "src" / "core" / "mcphub",
                REPO_ROOT / "src" / "core" / "lsphub",
                REPO_ROOT / "src" / "core" / "chat.py",
                REPO_ROOT / "src" / "core" / "batch.py",
                REPO_ROOT / "src" / "core" / "llm.py",
            ],
        ) == []

    def test_the_modes_save_is_not_a_side_door_through_the_shell(self):
        """The agents became app-writable; the shell is not the way in.

        The personas are rows of the install's store now (appdb-10), and the
        tempting route for a tool to reach them is the one surface that can *edit
        any file* — the Editor's terminal. It stays a human surface: no hub, chat
        or batch path names an agent write route or the accessor behind it, and
        the connectors' own sources carry neither (the marker scan covers those
        trees, so this asks only the in-process paths that could reach one an
        import away).
        """
        markers = (*AGENTS_WRITE_MARKERS, "appdb.add_agent", "appdb.update_agent",
                   "appdb.delete_agent")
        assert offenders_for(
            markers,
            [
                REPO_ROOT / "src" / "core" / "mcphub",
                REPO_ROOT / "src" / "core" / "lsphub",
                REPO_ROOT / "src" / "core" / "chat.py",
                REPO_ROOT / "src" / "core" / "batch.py",
                REPO_ROOT / "src" / "core" / "llm.py",
                REPO_ROOT / "src" / "core" / "termhub",
            ],
        ) == []


class TestTheAgentRoutesStayPinnedToTheirPaths:
    """The agents' routes: one argument-free reader, three pinned writes.

    The personas moved from a workspace file into the install's store (appdb-10),
    and that store is invisible to ``/api/fs/*`` — so every route that reaches it
    is one this guard has to name, because none of them is an ``/api/fs`` route
    and the marker scan above cannot see any of them.

    What is pinned is the whole surface, path by path and verb by verb: (a) the
    dropdown's reader keeps exactly one verb and **zero arguments**, (b) the three
    writes are the store's whole writable reach with exactly their verbs, and
    (c) the accessors behind them have one caller, the routes. A fourth route —
    or a second verb on one of these — is a change to the store's reach and has
    to be made here, on purpose.
    """

    #: The whole surface ``/agents`` may ever answer. The reader answers the list
    #: the dropdown, the dialog and the hub gray-out all read; the three writes
    #: are create, update and delete (§4.5).
    AGENT_VERBS = {
        "/agents": ["get"],
        "/agents/add": ["post"],
        "/agents/save": ["post"],
        "/agents/delete": ["post"],
    }

    def _registered(self):
        routes_source = (REPO_ROOT / "src" / "api" / "routes.py").read_text(
            encoding="utf-8"
        )
        return route_registrations(routes_source, "/agents")

    def test_the_reader_path_has_one_verb_and_no_argument(self):
        """The arity is what pins "no ``?path=``", because a signature cannot hide one.

        A query parameter is how a purpose-built store reader turns into a general
        way to reach the database — which is invisible to ``/api/fs`` and to both
        connectors precisely because its only door is this route.
        """
        handlers = [
            entry for entry in self._registered() if entry["path"] == "/agents"
        ]
        assert [entry["verb"] for entry in handlers] == ["get"], (
            "a verb on the dropdown's reader path would put the personas that "
            "decide whether tools exist behind a route no marker scan sees"
        )
        assert [entry["handler"].name for entry in handlers] == ["get_agents"]
        assert handlers[0]["handler"].args.args == []

    def test_the_writes_are_pinned_to_post_and_take_one_body(self):
        """The three writes are the store's whole writable reach, verbs and all."""
        registered = self._registered()
        by_path: Dict[str, List[str]] = {}
        for entry in registered:
            by_path.setdefault(entry["path"], []).append(entry["verb"])
        assert by_path == self.AGENT_VERBS, (
            f"the /agents surface is {by_path}, expected {self.AGENT_VERBS}"
        )
        for entry in registered:
            if entry["verb"] == "get":
                continue
            args = entry["handler"].args.args
            assert [arg.arg for arg in args] == ["body"], entry["path"]
            assert len(args) == 1, entry["path"]

    def test_the_client_reads_readonly_as_data_never_as_a_reserved_id(self):
        """``web/src`` holds no reserved id, and ``readonly`` is what drives it.

        AGENTS.md: "``web/src`` never contains a reserved agent id. The client
        recognises the app-owned mode by a data flag, not by its name." Two
        halves, and both are asserted here because the second is the one this
        task could break by rendering a field from ``id === '…'``:

        * no file under ``web/src`` carries an id ``agent_modes`` marks reserved
          (read out of the module that owns them, never restated here);
        * the two files that render an agent's tab decide from the payload's
          flags — ``readonly``/``deletable`` — and hold no id comparison at all.

        The jsdom suite carries the same scan over ``web/src`` (its own walk,
        with its extension filter asserted); this half is the backend's, because
        the ids it guards are *this* package's.
        """
        from src.core import agent_modes

        reserved = agent_modes.RESERVED_MODE_IDS
        assert reserved, "no reserved agent id declared"

        scanned = [
            path
            for path in (REPO_ROOT / "web" / "src").rglob("*")
            if path.is_file() and path.suffix in (".js", ".vue", ".css", ".json")
        ]
        assert scanned, "the scan found nothing to scan under web/src"
        for path in scanned:
            text = path.read_text(encoding="utf-8")
            for agent_id in reserved:
                assert agent_id not in text, (
                    f"{path.relative_to(REPO_ROOT)} names the reserved agent id "
                    f"{agent_id!r} — the client must recognise it by `readonly`"
                )

        for name in ("components/AgentModesDialog.vue",
                     "composables/useAgentModes.js"):
            source = (REPO_ROOT / "web" / "src" / name).read_text(encoding="utf-8")
            assert "readonly" in source, name
            assert not re.search(r"id\s*===\s*['\"]", source), (
                f"{name} compares an agent id — `readonly` is the flag that drives "
                "the rendering"
            )

    def test_the_store_accessors_are_called_from_the_routes_and_nowhere_else(self):
        """Nothing under ``src/core`` but the store names an agent write.

        Same shape as ``test_the_store_writers_are_called_from_the_routes_and_nowhere_else``
        above, applied to the agents: a hub, a tool or a chat path that named one
        would be a tool editing the personas that decide whether tools exist, and
        no scan of ``/api/fs`` markers would ever notice.
        """
        assert agent_writer_callers(REPO_ROOT / "src") == [
            str(Path("api") / "routes.py")
        ]


class TestThePromptHelperRoutesStayPinnedToTheirPaths:
    """The settings store's bullet routes: one reader, three pinned writes.

    appdb-07 moved the bullets out of ``.nojae/prompt-helpers.json`` and into
    ``nojae.db``, which is invisible to ``/api/fs/*`` for the same reason the
    reserved folder is — so these routes are reached by no path parameter, and
    the ``/api/fs`` marker scan cannot see any of them. What is pinned is the
    whole surface, path by path and verb by verb: a fourth route, or a second
    verb on one of these, is a change to the store's reach and has to be made
    here, on purpose.

    The writes are the browser's alone (D12). Nothing under ``src/core`` but the
    module that wraps them names a write accessor, so no hub, tool or chat path
    reaches one — which would be a tool editing the user's bullets mid-turn, and
    no scan of ``/api/fs`` would ever notice.
    """

    #: The whole ``/prompt-helpers`` surface. The reader answers the count the
    #: store holds; the three writes are create, update-one and delete (§4.5).
    PROMPT_HELPER_VERBS = {
        "/prompt-helpers": ["get"],
        "/prompt-helpers/add": ["post"],
        "/prompt-helpers/save": ["post"],
        "/prompt-helpers/delete": ["post"],
    }

    #: Spellings a connector or a tool description could use for reaching the
    #: writes without naming a route verbatim — the belt the modes save has.
    HELPER_WRITE_SPELLINGS = (
        "prompt_helpers.add",
        "prompt_helpers.delete",
        "add_prompt_helper",
        "delete_prompt_helper",
        "prompt-helpers/add",
        "prompt-helpers/delete",
    )

    def _registered(self):
        routes_source = (REPO_ROOT / "src" / "api" / "routes.py").read_text(
            encoding="utf-8"
        )
        return route_registrations(routes_source, "/prompt-helpers")

    def test_the_surface_is_exactly_the_reader_and_the_three_writes(self):
        by_path: Dict[str, List[str]] = {}
        for entry in self._registered():
            by_path.setdefault(entry["path"], []).append(entry["verb"])
        assert by_path == self.PROMPT_HELPER_VERBS, (
            f"the /prompt-helpers surface is {by_path}, expected "
            f"{self.PROMPT_HELPER_VERBS}"
        )

    def test_no_route_under_the_prefix_takes_a_path_or_an_index(self):
        """The arity is what pins "no ``?path=``", because a signature cannot hide one.

        The reader takes nothing at all; each write takes exactly its body model.
        A query parameter would turn a purpose-built store route into a general
        way to reach the database.
        """
        for entry in self._registered():
            args = entry["handler"].args.args
            if entry["verb"] == "get":
                assert args == [], entry["path"]
            else:
                assert [arg.arg for arg in args] == ["body"], entry["path"]
                assert len(args) == 1, entry["path"]

    def test_no_tool_advertises_a_prompt_helper_write(self):
        offenders: List[str] = []
        for connector_id, listing in connector_tool_lists().items():
            for tool in listing:
                haystack = f"{tool['name']} {tool['description']} {tool['schema']}"
                offenders.extend(
                    f"{connector_id}: {item}"
                    for item in self.HELPER_WRITE_SPELLINGS
                    if item in haystack
                )
        for definition in lsp_tool_defs():
            haystack = json.dumps(definition)
            offenders.extend(
                f"lsp:{definition['function']['name']}: {item}"
                for item in self.HELPER_WRITE_SPELLINGS
                if item in haystack
            )
        assert offenders == [], (
            f"a tool advertises a prompt-helper write: {offenders}"
        )

    def test_the_store_writers_are_called_from_the_routes_and_their_wrapper(self):
        """Nothing under ``src/core`` but the helpers module names the writes.

        ``prompt_helpers.py`` is the wrapper the routes call, and it is the only
        core module allowed to: a hub, a chat or a batch path naming one of them
        would be a tool writing the user's bullets, reached through the store
        rather than through the browser.
        """
        names = ("add_prompt_helper", "save_prompt_helper", "delete_prompt_helper")
        callers: List[str] = []
        for path in (REPO_ROOT / "src" / "core").rglob("*.py"):
            if path.name in ("appdb.py", "prompt_helpers.py"):
                continue  # these *define* the accessors
            text = path.read_text(encoding="utf-8")
            if any(name in text for name in names):
                callers.append(str(path.relative_to(REPO_ROOT)))
        assert callers == []

    def test_the_verb_guard_catches_a_poisoned_surface(self):
        """Fed to the same walk the guard uses, so the check above is a guard."""
        poisoned = (
            "@router.get(\"/prompt-helpers\")\n"
            "def get_prompt_helpers():\n"
            "    return {}\n\n"
            "@router.post(\"/prompt-helpers\")\n"
            "def post_prompt_helpers(body: PromptHelperSlotIn):\n"
            "    return {}\n\n"
            "@router.post(\"/prompt-helpers/add\")\n"
            "def post_prompt_helpers_add(body: PromptHelperCreateIn):\n"
            "    return {}\n\n"
            "@router.get(\"/prompt-helpers/delete\")\n"
            "def get_prompt_helpers_delete():\n"
            "    return {}\n\n"
            "@router.post(\"/prompt-helpers/delete\")\n"
            "def post_prompt_helpers_delete(body: PromptHelperDeleteIn):\n"
            "    return {}\n"
        )
        by_path: Dict[str, List[str]] = {}
        for entry in route_registrations(poisoned, "/prompt-helpers"):
            by_path.setdefault(entry["path"], []).append(entry["verb"])
        assert by_path == {
            "/prompt-helpers": ["get", "post"],
            "/prompt-helpers/add": ["post"],
            "/prompt-helpers/delete": ["get", "post"],
        }
        with pytest.raises(AssertionError):
            assert by_path == self.PROMPT_HELPER_VERBS
        # And the arity guard sees the reader's signature even with a poisoned
        # neighbour: the read stays argument-free, the writes keep one body.
        reader = [e for e in route_registrations(poisoned, "/prompt-helpers")
                  if e["path"] == "/prompt-helpers"]
        assert reader[0]["handler"].args.args == []


class TestTheServerAndModelRoutesStayPinnedToTheirPaths:
    """The settings store's connection routes: two readers, six pinned writes.

    appdb-08 moved the model connection into ``nojae.db``, so the same discipline
    that pins the bullets pins the catalogue: no path parameter, no ``/api/fs``
    route, and every verb on every path stated here. The ``/models`` entry is the
    **live listing** (``GET /api/models`` — dial a server's URL, read its model
    ids), which is a read and stays one; the store's model writes are the three
    under ``/models/``.

    The writes are the browser's alone (D12). Nothing under ``src/core`` but the
    store module names a write accessor, so no hub, tool or chat path reaches one
    — which would be a tool editing the connection a turn runs on.
    """

    #: The whole ``/servers`` and ``/models`` surface, verbs and all.
    CONNECTION_VERBS = {
        "/servers": ["get"],
        "/servers/add": ["post"],
        "/servers/save": ["post"],
        "/servers/delete": ["post"],
        "/models": ["get"],
        "/models/add": ["post"],
        "/models/save": ["post"],
        "/models/delete": ["post"],
    }

    #: Spellings a connector or a tool description could use for reaching the
    #: writes without naming a route verbatim — the belt the other two surfaces have.
    CONNECTION_WRITE_SPELLINGS = (
        "appdb.add_server",
        "appdb.delete_server",
        "appdb.add_model",
        "appdb.delete_model",
        "servers/add",
        "servers/delete",
        "models/add",
        "models/delete",
    )

    def _registered(self):
        routes_source = (REPO_ROOT / "src" / "api" / "routes.py").read_text(
            encoding="utf-8"
        )
        return route_registrations(routes_source, "/servers") + (
            route_registrations(routes_source, "/models")
        )

    def test_the_surface_is_exactly_the_two_reads_and_the_six_writes(self):
        by_path: Dict[str, List[str]] = {}
        for entry in self._registered():
            by_path.setdefault(entry["path"], []).append(entry["verb"])
        assert by_path == self.CONNECTION_VERBS, (
            f"the connection surface is {by_path}, expected "
            f"{self.CONNECTION_VERBS}"
        )

    def test_no_route_under_either_prefix_takes_a_path_or_an_id(self):
        """The arity is what pins "no ``?path=``", because a signature cannot hide one."""
        for entry in self._registered():
            args = entry["handler"].args.args
            if entry["verb"] == "get":
                # ``GET /api/models`` takes the URL and key to dial; the store's
                # reader takes nothing at all.
                assert all(
                    arg.arg in ("serverUrl", "apiKey") for arg in args
                ), entry["path"]
            else:
                assert [arg.arg for arg in args] == ["body"], entry["path"]
                assert len(args) == 1, entry["path"]

    def test_no_tool_advertises_a_connection_write(self):
        offenders: List[str] = []
        for connector_id, listing in connector_tool_lists().items():
            for tool in listing:
                haystack = f"{tool['name']} {tool['description']} {tool['schema']}"
                offenders.extend(
                    f"{connector_id}: {item}"
                    for item in self.CONNECTION_WRITE_SPELLINGS
                    if item in haystack
                )
        for definition in lsp_tool_defs():
            haystack = json.dumps(definition)
            offenders.extend(
                f"lsp:{definition['function']['name']}: {item}"
                for item in self.CONNECTION_WRITE_SPELLINGS
                if item in haystack
            )
        assert offenders == [], (
            f"a tool advertises a connection write: {offenders}"
        )

    def test_the_store_writers_are_called_from_the_routes_and_nowhere_else(self):
        """Nothing under ``src/core`` names a connection write.

        Unlike the bullets, the connection has no wrapper module: the routes call
        :mod:`src.core.appdb` directly, so the store module itself is the only
        core file allowed to name these functions — it *defines* them.
        """
        names = ("add_server", "update_server", "delete_server",
                 "add_model", "update_model", "delete_model")
        callers: List[str] = []
        for path in (REPO_ROOT / "src" / "core").rglob("*.py"):
            if path.name == "appdb.py":
                continue
            text = path.read_text(encoding="utf-8")
            if any(f"appdb.{name}(" in text for name in names):
                callers.append(str(path.relative_to(REPO_ROOT)))
        assert callers == []

    def test_the_verb_guard_catches_a_poisoned_surface(self):
        """Fed to the same walk the guard uses, so the check above is a guard."""
        poisoned = (
            "@router.get(\"/servers\")\n"
            "def get_servers():\n"
            "    return {}\n\n"
            "@router.post(\"/servers\")\n"
            "def post_servers(body: ServerIn):\n"
            "    return {}\n\n"
            "@router.get(\"/models/delete\")\n"
            "def get_models_delete():\n"
            "    return {}\n\n"
            "@router.post(\"/models/delete\")\n"
            "def post_models_delete(body: ModelDeleteIn):\n"
            "    return {}\n"
        )
        by_path: Dict[str, List[str]] = {}
        for entry in route_registrations(poisoned, "/servers") + (
            route_registrations(poisoned, "/models")
        ):
            by_path.setdefault(entry["path"], []).append(entry["verb"])
        assert by_path == {
            "/servers": ["get", "post"],
            "/models/delete": ["get", "post"],
        }
        with pytest.raises(AssertionError):
            assert by_path == self.CONNECTION_VERBS


#: ---------------------------------------------------------------------------
#: cwizard-11 (AC-22): the sentinel stays the wizard's word and the catalogue's.
#:
#: §8 spends a whole trap on this: ``__put_your_api_key_here__`` is **not** a
#: reference, so an unreplaced slot is sent upstream as the key and fails at
#: authentication, far from its cause. The design's answer is one canonical
#: spelling and one honest sentence on page 3 — and the deliberate *absence* of
#: anything else: "Nothing downstream re-checks it. The panel is not taught to
#: recognise the sentinel: once pasted, an unfilled slot surfaces exactly as a
#: wrong value does today, in the connector's own error."
#:
#: An absence is the easiest thing in the world to add by accident, so it is
#: asserted: the constant may appear in ``wizard.prompts`` (which owns it), in
#: ``wizard.snippet`` (which quotes it in its sentences) and in the committed
#: catalogue (which carries it in a value slot) — and in no hub, no panel and no
#: tool list. A hub that learned to spot it would be a second validator, which is
#: the one thing this feature's §4 forbids twice.
#: ---------------------------------------------------------------------------

#: The one canonical spelling, restated as a literal here so the guard does not
#: read the value it is checking out of the module under test — the same rule
#: ``tests/test_mcp_catalogue.py`` and ``tests/test_wizard_snippet.py`` hold to.
SECRET_SENTINEL = "__put_your_api_key_here__"

#: The surfaces AC-22 says must stay untaught: the two hubs whole, the two panels
#: that show their connectors, and the tool-list surfaces that render a hub's
#: tools. The wizard's own three files are *not* in this list — they own it.
UNTAUGHT_SURFACES = (
    Path("src/core/mcphub"),
    Path("src/core/lsphub"),
    Path("web/src/components/WorkBenchMcpPanel.vue"),
    Path("web/src/components/WorkBenchLspPanel.vue"),
    Path("web/src/components/WorkBenchToolPanel.vue"),
    Path("web/src/components/WorkBenchToolsDock.vue"),
    Path("web/src/lib/chat-hubs.js"),
)

#: The only files in the app that hold the sentinel **as text**, and why each one
#: holds it. A fourth name here is a new downstream reader of the sentinel and has
#: to be argued about in this file, not added quietly. ``wizard.snippet`` is
#: deliberately absent: it quotes the spelling through ``prompts.SECRET_SENTINEL``
#: rather than restating it (``test_the_families_are_the_prompts_own_two`` in
#: ``tests/test_wizard_snippet.py`` pins that), so it holds no literal to find.
SENTINEL_HOMES = {
    # it owns the one canonical spelling (§8)
    "src/core/wizard/prompts.py",
    # the one catalogue entry that needs a key carries it in the value slot (§9)
    "mcp_connectors/catalog-mcp.json",
}


def sentinel_bearers(roots: List[Path]) -> List[str]:
    """Every file under ``roots`` that spells the sentinel, repo-relative.

    One implementation, shared by the guard below and by its self-check — the same
    reason ``offenders_for`` is shared. Text files only, and the byte-compiled
    mirrors of a module are skipped: the question is what the app's *sources*
    teach, and a ``.pyc`` is that same source seen twice.
    """
    found: List[str] = []
    for root in roots:
        candidates = [root] if root.is_file() else sorted(root.rglob("*"))
        for path in candidates:
            if not path.is_file() or path.suffix not in (".py", ".js", ".vue", ".json"):
                continue
            if "__pycache__" in path.parts:
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except (OSError, UnicodeDecodeError):
                continue
            if SECRET_SENTINEL in text:
                # ``as_posix``, because SENTINEL_HOMES spells its names with
                # forward slashes; the separator a walk reports in is the
                # separator its comparisons are written in.
                found.append(
                    path.relative_to(REPO_ROOT).as_posix()
                    if path.is_relative_to(REPO_ROOT)
                    else str(path)
                )
    return found


class TestTheSentinelStopsWithTheWizard:
    """AC-22: no panel, tool list or hub gained a sentinel check or an auth pre-check.

    The static half is the scan; the behavioural half lives with the loader that
    proves it (``tests/test_mcp.py``: a declaration carrying the sentinel is
    **loaded**, and the sentinel travels through verbatim — surfacing as a wrong
    value does today, in the connector's own error, and nowhere earlier).
    """

    def test_no_hub_panel_or_tool_list_names_the_sentinel(self):
        offenders = sentinel_bearers(
            [REPO_ROOT / rel for rel in UNTAUGHT_SURFACES]
        )
        assert offenders == [], (
            "a hub, panel or tool list was taught to recognise the sentinel, which "
            f"would be the downstream check §8 forbids: {offenders}"
        )

    def test_the_sentinel_appears_nowhere_else_in_the_app(self):
        """The homes are exactly the three, so a fourth is a new reader.

        Walked over the whole app rather than a list, because the point is that
        *nothing else* learned the word — a check added to a composable, a route
        or the editor would hide from a list of the obvious suspects.
        """
        scanned = [
            REPO_ROOT / "src",
            REPO_ROOT / "web" / "src",
            REPO_ROOT / "mcp_connectors",
            REPO_ROOT / "lsp_connectors",
        ]
        found = set(sentinel_bearers(scanned))
        assert found == SENTINEL_HOMES, (
            f"the sentinel is held by {sorted(found)}, expected {sorted(SENTINEL_HOMES)}"
        )

    def test_the_two_hubs_hold_no_auth_pre_check_of_any_shape(self):
        """The wider half of AC-22: not just the word, the *idea*.

        A hub that refuses an entry for a missing key, or marks it not-ready, is
        the same forbidden check under a different name — and it would be a hub
        that changed how a declaration is read, which §15 puts out of reach for
        this feature entirely.
        """
        markers = (
            "will not authenticate", "needs a key", "api key missing",
            "missing api key", "not ready", "placeholder key", "needs_key",
            "key_required", "auth_precheck", "precheck",
        )
        offenders: List[str] = []
        for folder in ("mcphub", "lsphub"):
            for path in (REPO_ROOT / "src" / "core" / folder).rglob("*.py"):
                text = path.read_text(encoding="utf-8").lower()
                offenders.extend(
                    f"{path.relative_to(REPO_ROOT)}: {marker}"
                    for marker in markers
                    if marker in text
                )
        assert offenders == [], (
            f"a hub grew a readiness or auth check for a pasted entry: {offenders}"
        )

    def test_the_sentinel_scan_catches_a_poisoned_hub_file(self, tmp_path):
        """Fed to the same walker the guard uses, so the check above is a guard.

        A hub module that learned the word is exactly the leak the scan exists
        for, and a clean file beside it answers nothing — which is what makes the
        empty answer above a verdict rather than a walk that flags everything.
        """
        fake = tmp_path / "manager.py"
        fake.write_text(
            f'NOT_READY = "{SECRET_SENTINEL}"  # a hub taught to spot the slot\n',
            encoding="utf-8",
        )
        clean = tmp_path / "seed.py"
        clean.write_text("ENABLE = \"enable\"\n", encoding="utf-8")
        assert sentinel_bearers([tmp_path]) == [str(fake)]


class TestTheSearchReaderStaysARead:
    """The same verb guard as ``/agent-modes``, for the surface it does not cover.

    ``test_editorfs.py``'s verb map already lists ``/api/fs/search`` as ``["get"]``;
    this is the sibling of the ``/agent-modes`` guard — the *verb* read out of the
    AST, so a mutation added to the same path trips it even before the OpenAPI map
    is consulted.
    """

    def test_no_fs_search_route_accepts_a_mutation(self):
        routes_source = (REPO_ROOT / "src" / "api" / "routes.py").read_text(
            encoding="utf-8"
        )
        registered = route_registrations(routes_source, "/fs/search")
        assert registered, "the search route has to exist for this to mean anything"
        assert [entry["verb"] for entry in registered] == ["get"]


class TestTheModelClientCannotReachAWriteRoute:
    """``core/llmkit`` is the one core package that speaks HTTP, and legally.

    The import scan above covers ``mcp_connectors/`` only, so ``httpx`` under
    ``llmkit`` is *legal* — widening that scan to ``src/core`` would condemn
    the app's own model client, a different decision. And the passive marker
    scan over ``src/core`` already means ``llmkit``'s sources never spell a
    ``PUT /api/fs``. What neither scan answers is the URL *shape*: an HTTP
    client that builds its own URLs could reach a route it never names in a
    string. The answer pinned here is that the two builders append only their
    two fixed suffixes, so no configured ``SERVER_URL`` turns the model client
    into a caller of an app route.
    """

    # Every shape ``SERVER_URL`` actually takes (D9): with and without the
    # ``/v1`` tail, with and without a trailing slash.
    SERVER_URL_SHAPES = [
        "http://host:8080/v1",
        "http://host:8080/v1/",
        "http://host:8080",
        "http://host:8080/",
    ]

    # The two suffixes the client may ever append, keyed by the builder that
    # owns each one.
    BUILDER_SUFFIXES = {
        chat_completions_url: "/v1/chat/completions",
        models_url: "/v1/models",
    }

    def test_each_builder_appends_only_its_one_fixed_suffix(self):
        for builder, suffix in self.BUILDER_SUFFIXES.items():
            paths = builder_paths(builder, self.SERVER_URL_SHAPES)
            assert paths and all(path.endswith(suffix) for path in paths), (
                f"{builder.__name__} appends more than {suffix}: {paths}"
            )

    def test_no_builder_path_reaches_under_api(self):
        """The invariant spec step 6 states: the model client cannot write-route.

        ``/api/`` is the app's own route prefix, so a builder whose path holds
        it could address a write route. It cannot: each appends its suffix to
        the ``/v1`` root of ``SERVER_URL``. A hostile ``SERVER_URL`` that itself
        embeds ``/api/fs`` still yields a chat-completions *POST* under that
        path, never a ``PUT /api/fs`` — the suffix lock keeps the shape honest
        even then, which is why this guard pins the builders rather than
        policing ``SERVER_URL``, which is user config.
        """
        for builder in self.BUILDER_SUFFIXES:
            paths = builder_paths(builder, self.SERVER_URL_SHAPES)
            assert not any(APP_ROUTE_PREFIX in path for path in paths), (
                f"{builder.__name__} reaches {APP_ROUTE_PREFIX}: {paths}"
            )

    def test_the_shape_guard_catches_a_builder_drifted_onto_an_app_route(self):
        """Both halves trip on a builder that drifts onto an app route.

        Fed to the same walker the guards use (a scratch builder, not an edit
        to ``client.py``), so what is checked is that the *guard* sees the
        drift — the ``TestTheGuardsActuallyFail`` pattern, applied to these.
        The drifted spelling names the **agent write** surface: the guard is
        shown to see *this* path, not merely some app path, so a builder that
        drifts onto a route that decides whether tools exist trips both
        halves exactly like any other write route.
        """
        def drifted(server_url: str) -> str:
            return f"{server_url.rstrip('/')}/api/agents/save"

        paths = builder_paths(drifted, ["http://host:8080/v1"])
        with pytest.raises(AssertionError):
            assert all(path.endswith("/v1/chat/completions") for path in paths), paths
        with pytest.raises(AssertionError):
            assert not any(APP_ROUTE_PREFIX in path for path in paths), paths
        assert any("/api/agents/save" in path for path in paths), (
            "the drift named is an agent write itself: the shape guard is shown "
            "to see this route, not just some app route"
        )

    def test_the_marker_scan_still_catches_llmkit_spelling_a_write(self, tmp_path):
        """The passive scan's own teeth, shown on a scratch copy of the package.

        ``llmkit`` lives under the roots ``scan_roots()`` walks, so a source
        file there naming a write route is an offender like any other, and no
        allowed home excuses it; the poisoned module below proves the shared
        walker sees it (reusing ``offenders_for`` — a second copy of the walk
        is how a guard drifts).
        """
        fake = tmp_path / "llmkit" / "cheeky.py"
        fake.parent.mkdir(parents=True)
        fake.write_text(
            'def leak(path, text):  # a model client wired to PUT /api/fs/file\n'
            '    return client.put("/api/fs/file", json={"path": path, "text": text})\n',
            encoding="utf-8",
        )
        assert offenders_for(WRITE_MARKERS, [fake.parent]) == [str(fake)]


class TestTheGuardsActuallyFail:
    """A guard that cannot fail is decoration, so each is shown catching one.

    Same purpose as the acceptance's ``verify locally by exposing a write route
    to a fixture tool and by calling one from src/core, then revert`` — done as
    a test instead of as a note, so the check is repeated on every run rather
    than remembered.
    """

    def test_the_marker_scan_catches_a_poisoned_module(self, tmp_path):
        fake = tmp_path / "core" / "cheeky.py"
        fake.parent.mkdir(parents=True)
        fake.write_text(
            'def leak(path, text):  # a tool wired to PUT /api/fs/file\n'
            '    return http.put("/api/fs/file", json={"path": path, "text": text})\n',
            encoding="utf-8",
        )
        assert offenders_for(WRITE_MARKERS, [fake.parent]) == [str(fake)]

    def test_the_marker_scan_catches_a_poisoned_connector_script(self, tmp_path):
        fake = tmp_path / "some_connector.py"
        fake.write_text('URL = "DELETE /api/fs/file"\n', encoding="utf-8")
        assert offenders_for(WRITE_MARKERS, [tmp_path]) == [str(fake)]

    def test_the_marker_scan_catches_a_module_naming_an_agent_write(self, tmp_path):
        """The new markers have their own teeth: the scan sees these routes spelled.

        A scratch file under a scratch root spelling a write the way a caller
        would — the same walker the real guard runs over ``src/core``, the two
        connector trees and ``useChat.js``. No allowed home is passed here
        (``allowed=set()``), because what is being proven is that the marker
        itself is caught, not that a declared caller is excused.
        """
        fake = tmp_path / "core" / "cheeky.py"
        fake.parent.mkdir(parents=True)
        fake.write_text(
            'def leak(body):\n'
            '    # a core path wired to POST /api/agents/save\n'
            '    return client.post("/api/agents/save", json=body)\n',
            encoding="utf-8",
        )
        assert offenders_for(WRITE_MARKERS, [fake.parent], allowed=set()) == [str(fake)]
        # And the *read* spelling of the pair stays out of the scan, which is what
        # keeps every agent-read docstring from becoming an offender: the same
        # reason ``GET /api/fs`` is not a marker.
        read = tmp_path / "core" / "reader.py"
        read.write_text(
            '"""The dropdown read (``GET /api/agents``)."""\n',
            encoding="utf-8",
        )
        assert offenders_for(WRITE_MARKERS, [tmp_path], allowed=set()) == [str(fake)]

    def test_the_tool_scan_catches_a_poisoned_tool_list(self):
        poisoned = [{"name": "fs_delete", "description": "POST /api/fs/file",
                     "schema": "{}"}]
        haystack = " ".join(
            f"{tool['name']} {tool['description']} {tool['schema']}"
            for tool in poisoned
        )
        assert any(marker in haystack for marker in WRITE_MARKERS)

    def test_the_agent_write_tool_guard_catches_a_poisoned_connector_list(self):
        """A connector advertising an agent write trips the advertisement guard.

        Fed to the same walker the guards use (a scratch listing, not an edit to
        a connector), so what is checked is that the *guard* sees these routes:
        first a verbatim path, then a helper spelling that names the write
        without spelling the verb — the shape the pinned helper list exists to
        catch. A clean listing answers nothing, which is what makes the empty
        answer of the guards above a verdict rather than an absence of checking.
        """
        poisoned = [
            {"name": "agents_save", "description": "Call POST /api/agents/save.",
             "schema": "{}"},
            {"name": "save_agent", "description": "Writes a persona.",
             "schema": json.dumps({"helper": "appdb.update_agent"})},
            {"name": "clean_tool", "description": "Reads a file.", "schema": "{}"},
        ]
        assert advertisement_offenders(poisoned) == [
            "agents_save: POST /api/agents/save",
            "agents_save: agents/save",
            "save_agent: update_agent",
        ]

    def test_the_agent_write_tool_guard_catches_a_poisoned_lsp_spec(self, monkeypatch):
        """The LSP half trips too: a poisoned catalogue def names a write route.

        The poisoning goes into a spec the committed template *declares* (every
        server there asks for ``diagnostics``), because the hub publishes the
        declared list — a spec no server declares would never be published, and
        a guard that only sees unpublished specs is not guarding the surface.
        """
        monkeypatch.setitem(
            lsp_tools.TOOL_SPECS,
            "diagnostics",
            {**lsp_tools.TOOL_SPECS["diagnostics"],
             "description": "Save an agent (POST /api/agents/save)."},
        )
        listing = [
            {"name": definition["function"]["name"],
             "description": definition["function"]["description"],
             "schema": json.dumps(definition["function"]["parameters"])}
            for definition in lsp_tool_defs()
        ]
        offenders = advertisement_offenders(listing)
        assert offenders, "the poisoned def is published, so the guard has to see it"
        with pytest.raises(AssertionError):
            assert offenders == [], offenders

    def test_the_agent_writer_caller_scan_catches_a_second_caller(self, tmp_path):
        """A second caller of a store accessor is named by the caller scan.

        A scratch ``src`` tree with the routes and a hub that names the accessor:
        the guard's answer is *both*, which is what makes the real guard's
        one-entry answer a verdict. The store module itself is skipped by the
        shared walker, exactly as it is for the real tree.
        """
        (tmp_path / "api").mkdir()
        (tmp_path / "api" / "routes.py").write_text(
            "from src.core import appdb\n\n"
            "def route(body):\n"
            "    return appdb.update_agent(body.id, label=body.label)\n",
            encoding="utf-8",
        )
        (tmp_path / "core" / "mcphub").mkdir(parents=True)
        (tmp_path / "core" / "mcphub" / "manager.py").write_text(
            "from src.core import appdb\n\n"
            "def tool_save(agent_id):\n"
            "    return appdb.delete_agent(agent_id)\n",
            encoding="utf-8",
        )
        (tmp_path / "core" / "appdb.py").write_text(
            "def update_agent(*args, **kwargs):\n    return []\n\n"
            "def delete_agent(*args, **kwargs):\n    return []\n",
            encoding="utf-8",
        )
        assert agent_writer_callers(tmp_path) == [
            str(Path("api") / "routes.py"),
            str(Path("core") / "mcphub" / "manager.py"),
        ]

    def test_the_shell_side_door_guard_catches_a_poisoned_hub(self, tmp_path):
        """A hub naming an agent write trips the terminal-stays-human-only scan.

        The same walker the guard uses, over a scratch hub file: the point is that
        the *guard* sees a hub wiring itself to the writers of the personas that
        decide whether tools exist — which is how this class's other checks are
        proven.
        """
        fake = tmp_path / "cheeky_hub.py"
        fake.write_text(
            "# a hub wiring its tools to POST /api/agents/save\n"
            "from src.core import appdb\n",
            encoding="utf-8",
        )
        markers = (*AGENTS_WRITE_MARKERS, "appdb.add_agent", "appdb.update_agent",
                   "appdb.delete_agent")
        assert offenders_for(markers, [tmp_path], allowed=set()) == [str(fake)]

    def test_the_http_import_scan_catches_a_poisoned_connector(self, tmp_path):
        """The new guard sees an HTTP client, and the marker scan sees the route."""
        fake = tmp_path / "cheeky_connector.py"
        fake.write_text(
            "import httpx\n\n"
            "def save(rel, text):  # a refusal path wired to PUT /api/fs\n"
            "    return httpx.put('http://127.0.0.1:8000/api/fs/file',\n"
            "                   json={'path': rel, 'text': text})\n",
            encoding="utf-8",
        )
        assert http_import_offenders([tmp_path]) == [f"{fake.name}: httpx"]
        assert offenders_for(WRITE_MARKERS, [tmp_path], allowed=set()) == [str(fake)]

    def test_the_lsp_method_guard_catches_a_write_shaped_spec(self, monkeypatch):
        spec = {
            "capability": None,
            "method": "textDocument/willSaveWaitUntil",
            "schema": {"type": "object"},
            "description": "Rewrite the document.",
        }
        assert mutation_offenders({"poison": spec}) == [
            "poison calls textDocument/willSaveWaitUntil"
        ]

        # And through the real guard: a poisoned catalogue makes the test above
        # fail, which is what makes it a guard rather than a comment.
        monkeypatch.setitem(lsp_tools.TOOL_SPECS, "poison", spec)
        with pytest.raises(AssertionError):
            assert mutation_offenders(lsp_tools.TOOL_SPECS) == []

    def test_the_lsp_method_guard_catches_a_poisoned_editor_table(self, monkeypatch):
        """The pane's table gets the same teeth as the model's (spec §4.2).

        A "format on save" arriving in ``EDITOR_ACTIONS`` is exactly the drift
        this guards: the pane reads code and never writes it, and an action
        there must never become a document mutation — nor, by being added to the
        wrong table, a tool in every chat turn. Fed to the same walker the guard
        uses (a monkeypatched table, not an edit to ``editor.py``), so what is
        checked is that the *guard* sees it; the offender is named.
        """
        spec = {
            "method": "textDocument/willSaveWaitUntil",
            "capability": None,
            "needs_position": True,
        }
        monkeypatch.setitem(lsp_editor.EDITOR_ACTIONS, "format_on_save", spec)
        assert mutation_offenders(lsp_editor.EDITOR_ACTIONS) == [
            "format_on_save calls textDocument/willSaveWaitUntil"
        ]
        with pytest.raises(AssertionError):
            assert mutation_offenders(lsp_editor.EDITOR_ACTIONS) == []
        # The clean entries are not offenders, which is what makes the answer
        # above a verdict rather than a walk that flags everything.
        assert mutation_offenders(
            {k: v for k, v in lsp_editor.EDITOR_ACTIONS.items()
             if k != "format_on_save"}
        ) == []

    def test_the_agents_verb_guard_catches_a_poisoned_surface(self):
        """A verb moved onto any agents path trips the rewritten guard.

        Fed to the same walk the guard uses (a string, not an edit to the real
        file), so the check is that the *guard* sees a mutation — which is what
        makes the assertions in the class above guards rather than comments. Two
        poisonings, because the surface has two halves: a ``post`` on the
        dropdown's **read** path (a second way to write the store, on a path the
        dialog only reads) and a ``get`` on a **write** path (a reader that shares
        a writer's path, so the pinned verb set is what refuses it).
        """
        poisoned = (
            "@router.get(\"/agents\")\n"
            "def get_agents():\n"
            "    return {}\n\n"
            "@router.post(\"/agents\")\n"
            "def post_agents(body: AgentIn):\n"
            "    return {}\n\n"
            "@router.get(\"/agents/save\")\n"
            "def get_agents_save():\n"
            "    return {}\n\n"
            "@router.post(\"/agents/save\")\n"
            "def post_agents_save(body: AgentIn):\n"
            "    return {}\n"
        )
        registered = route_registrations(poisoned, "/agents")
        by_path: Dict[str, List[str]] = {}
        for entry in registered:
            by_path.setdefault(entry["path"], []).append(entry["verb"])
        assert by_path == {
            "/agents": ["get", "post"],
            "/agents/save": ["get", "post"],
        }
        with pytest.raises(AssertionError):
            assert by_path == TestTheAgentRoutesStayPinnedToTheirPaths.AGENT_VERBS
        # And the arity guard still sees the reader's signature: the dropdown's
        # path stays argument-free even while the poisoned neighbours carry bodies.
        reader = [entry for entry in registered if entry["path"] == "/agents"
                  and entry["verb"] == "get"]
        assert [entry["handler"].args.args for entry in reader] == [[]]
        assert registered[1]["handler"].args.args != []


#: ---------------------------------------------------------------------------
#: cwizard-11 (AC-14): the connector wizard's own surface.
#:
#: The wizard *prepares* a declaration entry, so the promise it keeps is the
#: loudest one in the app: it writes no declaration, starts no process and
#: installs no package. "Asserted, not intended" means a scan here, and the scan
#: has to be call-shaped for the same reason the marker scan is verb-and-path
#: shaped — the wizard's own docstrings name every one of these forbidden things
#: in order to forbid it (``snippet.py``'s says it imports no ``subprocess``), so
#: a substring scan would read honest prose as an offender. The Python half
#: therefore reads the AST's names; the client half reads identifier-followed-by-
#: paren spellings.
#:
#: The wizard's routes join the **expected-absent** list below and nothing else:
#: ``WRITE_MARKERS`` is what the app can write, and a wizard route is a read or a
#: conversationless post, so adding one to the marker list would make the guard
#: stop refusing it.
#: ---------------------------------------------------------------------------

# The wizard's client files: the rules, the dialog and the two buttons. One file
# under ``web/src`` names the wizard's two posts (the composable), and that is the
# file the install hand-over must not be able to arm or send a turn from.
WIZARD_CLIENT_FILES = (
    Path("web/src/composables/useConnectorWizard.js"),
    Path("web/src/components/ConnectorWizardDialog.vue"),
    Path("web/src/components/WorkBenchMcpPanel.vue"),
    Path("web/src/components/WorkBenchLspPanel.vue"),
)

# The wizard's two posts, in the spelling the client uses.
WIZARD_POST_ROUTES = ("/api/wizard/propose", "/api/wizard/prepare")

# The whole surface ``/wizard`` may ever answer: three reads and two
# conversationless posts. A fourth route, or a write verb on one of these, is a
# change to what the wizard may do and has to be made here, on purpose.
WIZARD_VERBS = {
    "/wizard/catalogue": ["get"],
    "/wizard/connection": ["get"],
    "/wizard/scan": ["get"],
    "/wizard/propose": ["post"],
    "/wizard/prepare": ["post"],
}

# Every writer of a declaration, of the Editor's file surface, or of the settings
# store, plus the seeding path — spelled as the *identifier a call would use*, so
# prose naming one stays invisible to the scan.
WIZARD_FORBIDDEN_WRITERS = (
    # the hubs' two declaration writers, and the seeding path that creates one
    "set_externals_enabled", "set_lsp_enabled",
    "ensure_mcp_settings_file", "ensure_lsp_settings_template",
    # the Editor's write core (AGENTS.md: every write surface is the browser's)
    "write_file", "create_path", "rename_path", "move_paths_batch", "trash_path",
    "backup_for_write",
    # the settings store's writes
    "add_server", "update_server", "delete_server",
    "add_model", "update_model", "delete_model",
    "add_agent", "update_agent", "delete_agent",
    "add_prompt_helper", "save_prompt_helper", "delete_prompt_helper",
    # writing bytes at all
    "write_text", "write_bytes", "mkdir", "unlink", "shutil",
)

# The spawn machinery. ``resolve_command`` / ``child_environment`` /
# ``searched_paths`` are deliberately **absent**: resolving a program's path is
# not starting it (§7), and that one act is the feature's whole readiness check.
WIZARD_SPAWN_SPELLINGS = (
    "subprocess", "Popen", "spawn", "fork", "execv", "execve", "posix_spawn",
    "create_subprocess", "system", "kill", "terminate",
)

# The composer's verbs that would make the install hand-over more than a draft
# (§7, AC-20): sending, arming the strip, or taking focus to the composer.
# ``setDraft`` is the one surface the hand-over may touch, and the wizard's own
# ``reset`` (its memory wipe, not the composer's) is not a composer verb — so
# neither is in this list.
COMPOSER_ARMING_CALLS = (
    "send", "sendBatchTurn", "stage", "removeStaged", "pullBackStaged",
    "appendDraft", "registerDraftInput", "editLast", "stop", "pause",
)


def wizard_python_files() -> List[Path]:
    """The wizard's Python surface: its package, and the scan it is grounded in.

    One implementation, shared by the guard below and by its self-check — the same
    reason ``offenders_for`` is shared. ``projectfacts`` is included because AC-15
    is the same promise from the other side: the scan is the wizard's eyes, and it
    may not become a writer either.
    """
    files = sorted((REPO_ROOT / "src" / "core" / "wizard").glob("*.py"))
    files.append(REPO_ROOT / "src" / "core" / "editorfs" / "projectfacts.py")
    return files


def python_spellings(source: str) -> set:
    """Every identifier a module *could* call: names, attributes, import roots.

    Docstrings and comments are not part of this set, which is the point: the
    wizard's modules name their own forbidden machinery in order to forbid it, and
    a guard that flinched at that would have to be loosened — the one thing this
    file refuses to do.
    """
    found = set()
    for node in ast.walk(ast.parse(source)):
        if isinstance(node, ast.Name):
            found.add(node.id)
        elif isinstance(node, ast.Attribute):
            found.add(node.attr)
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            for alias in node.names:
                found.add((alias.asname or alias.name).split(".")[0])
                if isinstance(node, ast.ImportFrom) and node.module:
                    found.add(node.module.split(".")[-1])
    return found


def wizard_route_block(source_text: str) -> str:
    """The wizard's routes and their helpers, as source text.

    Read out of the AST — the handlers registered under ``/wizard`` plus the
    private helpers named for it — so the block is the *code*, and neither a
    docstring elsewhere in ``routes.py`` nor a route added elsewhere can widen or
    narrow what is scanned.
    """
    tree = ast.parse(source_text)
    wanted = set()
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        named = node.name.startswith("_wizard_") or node.name.startswith("_catalogue_")
        registered = any(
            isinstance(d, ast.Call) and d.args
            and isinstance(d.args[0], ast.Constant)
            and isinstance(d.args[0].value, str)
            and d.args[0].value.startswith("/wizard")
            for d in node.decorator_list
        )
        if named or registered:
            wanted.add(node.name)
    chunks = [
        ast.get_source_segment(source_text, node) or ""
        for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        and node.name in wanted
    ]
    assert chunks, "no wizard route found in routes.py — the guard has nothing to scan"
    return "\n".join(chunks)


def wizard_write_offenders(python_files: List[Path], route_block: str) -> List[str]:
    """Every forbidden writer or spawn spelling the wizard's code could call.

    One implementation, shared by the guard and by both poisoned self-checks
    below, so what is proven is that *this* walk sees the leak.
    """
    found: List[str] = []
    forbidden = set(WIZARD_FORBIDDEN_WRITERS) | set(WIZARD_SPAWN_SPELLINGS)
    for path in python_files:
        try:
            spellings = python_spellings(path.read_text(encoding="utf-8"))
        except (OSError, SyntaxError, UnicodeDecodeError):
            continue
        label = (
            str(path.relative_to(REPO_ROOT))
            if path.is_relative_to(REPO_ROOT)
            else str(path)
        )
        found.extend(f"{label}: {name}" for name in sorted(spellings & forbidden))
    for name in sorted(python_spellings(route_block) & forbidden):
        found.append(f"src/api/routes.py (wizard block): {name}")
    return found


def strip_js_comments(text: str) -> str:
    """The file's code with its comments gone — the JS/Vue side of ``python_spellings``.

    Same reason the Python half reads the AST instead of the bytes: this feature's
    own comments *recite* the verbs it must not call ("no send, no stage, no
    appendDraft"), so a scan over the raw text reads honest prose as an offender —
    and a guard that cries wolf is a guard somebody loosens. Only a comment that
    starts a line is dropped, which is how every comment in these files is written;
    a trailing comment after code is left in, so the strip can err only toward
    refusing, never toward missing a call.
    """
    text = re.sub(r"<!--.*?-->", "", text, flags=re.DOTALL)
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    return "\n".join(
        "" if line.lstrip().startswith("//") else line
        for line in text.splitlines()
    )


def arming_offenders(files: List[Path]) -> List[str]:
    """Every composer arming verb spelled as a *call* in a wizard client file.

    The hand-over fills and only fills (§7), so the client that names the wizard's
    posts must hold no send, no stage and no composer-focus call. The scan is
    call-shaped (``name`` then ``(``) over comment-stripped text, so what it sees
    is a call and nothing else.
    """
    # One alternation, and the **matched** verb is what gets reported: searching
    # the whole alternation once per verb would report all ten for any one call,
    # which is a guard that names the wrong thing.
    call = re.compile(
        r"\b(" + "|".join(sorted(COMPOSER_ARMING_CALLS, key=len, reverse=True)) + r")\s*\("
    )
    found: List[str] = []
    for path in files:
        text = strip_js_comments(path.read_text(encoding="utf-8"))
        label = (
            str(path.relative_to(REPO_ROOT))
            if path.is_relative_to(REPO_ROOT)
            else str(path)
        )
        for verb in sorted({match.group(1) for match in call.finditer(text)}):
            found.append(f"{label}: {verb}(")
    return found


def wizard_verbs(routes_source: str) -> Dict[str, List[str]]:
    """The ``/wizard`` surface as ``{path: [verb]}``, read out of the decorators."""
    by_path: Dict[str, List[str]] = {}
    for entry in route_registrations(routes_source, "/wizard"):
        by_path.setdefault(entry["path"], []).append(entry["verb"])
    return by_path


class TestTheWizardWritesNothingStartsNothingInstallsNothing:
    """AC-14: the wizard's promise, asserted rather than intended.

    Every one of its surfaces — the two routes' block, its core package, the scan
    it is grounded in, and its client — is asked the same questions: does it reach
    a **declaration writer**, a **`/api/fs` write**, a **settings-store write**,
    the **seeding path**, or a **subprocess spawn**? And the client is asked the
    fifth: does the install hand-over stop at the draft?

    Two of these are already covered elsewhere and are re-asked here on purpose,
    because the point is that *this* file — the app's standing write-surface
    guard — owns the wizard too. What the existing scans cannot see is a call
    spelled without a route string (``ensure_mcp_settings_file(root)``), and that
    is the leak this class exists for.
    """

    def test_the_wizard_core_and_routes_name_no_writer_and_no_spawn(self):
        routes_source = (REPO_ROOT / "src" / "api" / "routes.py").read_text(
            encoding="utf-8"
        )
        offenders = wizard_write_offenders(
            wizard_python_files(), wizard_route_block(routes_source)
        )
        assert offenders == [], f"the wizard reaches a write or a spawn: {offenders}"

    def test_resolving_a_program_is_the_only_child_facing_thing_it_does(self):
        """The one allowed edge, pinned by name so it cannot grow.

        ``resolve_command`` and the environment it resolves against are the
        readiness check (§6 check 2), and they are the *only* child-facing names the
        wizard may hold. A ``start``/``spawn``/``kill`` arriving beside them is the
        feature starting a connector it was told not to start, and it trips this
        line rather than a review.
        """
        allowed = {"resolve_command", "child_environment", "searched_paths"}
        child_facing = allowed | {"start_connector", "start_server", "spawn_connector"}
        held = set()
        for path in wizard_python_files():
            held |= python_spellings(path.read_text(encoding="utf-8")) & child_facing
        assert held <= allowed, held - allowed

    def test_the_wizard_surface_is_three_reads_and_two_posts(self):
        """The expected-absent list: no wizard path is a write route.

        The verb set is pinned whole, and each path is then asked against
        ``WRITE_MARKERS`` — the answer must be *no match*, which is what makes "a
        read is invisible to the write scan" a fact rather than an assumption.
        """
        routes_source = (REPO_ROOT / "src" / "api" / "routes.py").read_text(
            encoding="utf-8"
        )
        by_path = wizard_verbs(routes_source)
        assert by_path == WIZARD_VERBS, (
            f"the /wizard surface is {by_path}, expected {WIZARD_VERBS}"
        )
        for path, verbs in by_path.items():
            for verb in verbs:
                spelling = f"{verb.upper()} /api{path}"
                for marker in WRITE_MARKERS:
                    assert not spelling.startswith(marker), (path, marker)

    def test_the_wizard_routes_are_not_added_to_the_write_marker_list(self):
        """The guard's own shape is the promise: the wizard stays out of it.

        ``WRITE_MARKERS`` is what the app can *write*. A wizard route belongs to
        the expected-absent list, never to this one — adding one would silently
        license a write the feature does not have.
        """
        for path in WIZARD_VERBS:
            for marker in WRITE_MARKERS:
                assert path not in marker, (path, marker)
        assert not any("wizard" in marker.lower() for marker in WRITE_MARKERS), (
            "a wizard route became a write marker: the guard would stop refusing it"
        )

    def test_the_wizard_client_reaches_no_write_route(self):
        """The browser half: the wizard's files name no ``/api/fs`` write."""
        offenders = offenders_for(
            WRITE_MARKERS,
            [REPO_ROOT / f for f in WIZARD_CLIENT_FILES],
            allowed=set(),
        )
        assert offenders == [], (
            f"a wizard client file names a write route: {offenders}"
        )

    def test_the_install_hand_over_fills_the_composer_and_never_arms_it(self):
        """AC-20, statically: no send, stage or composer-focus call exists there.

        The dynamic half is the jsdom suite and the e2e spec; this is the shape
        guard, so a later edit cannot add ``send()`` beside ``setDraft()`` and still
        pass a test that only reads the draft back.
        """
        files = [REPO_ROOT / f for f in WIZARD_CLIENT_FILES]
        naming = [
            path.relative_to(REPO_ROOT).as_posix()
            for path in files
            if any(
                route in path.read_text(encoding="utf-8")
                for route in WIZARD_POST_ROUTES
            )
        ]
        assert naming == ["web/src/composables/useConnectorWizard.js"], (
            "the wizard's posts are named by its one rule module and by nothing "
            f"else in web/src: {naming}"
        )
        offenders = arming_offenders(files)
        assert offenders == [], f"the wizard's client arms or sends a turn: {offenders}"

    def test_the_wizard_posts_are_named_nowhere_else_in_the_app(self):
        """No other client file can post a wizard step, armed or otherwise.

        One caller is what makes the previous row's verdict about *the* hand-over
        rather than about one file among several.
        """
        found = [
            path.relative_to(REPO_ROOT).as_posix()
            for path in (REPO_ROOT / "web" / "src").rglob("*")
            if path.is_file()
            and path.suffix in (".js", ".vue")
            and any(
                route in path.read_text(encoding="utf-8")
                for route in WIZARD_POST_ROUTES
            )
        ]
        assert found == ["web/src/composables/useConnectorWizard.js"], found


class TestTheWizardGuardActuallyFails:
    """The new guards fed a poisoned input, in this file's own style.

    A guard that cannot fail is decoration, and these are the guards the lot's
    "asserted, not intended" promise rests on — so each is shown catching the leak
    it exists for, over a scratch tree rather than by editing a real file.
    """

    def test_the_writer_scan_catches_a_poisoned_wizard_module(self, tmp_path):
        fake = tmp_path / "snippet.py"
        fake.write_text(
            "from src.core.mcphub.seed import ensure_mcp_settings_file\n\n"
            "def save_it(root):  # a wizard that wrote the declaration itself\n"
            "    return ensure_mcp_settings_file(root)\n",
            encoding="utf-8",
        )
        assert wizard_write_offenders([fake], "") == [
            f"{fake}: ensure_mcp_settings_file"
        ]

    def test_the_writer_scan_catches_a_poisoned_spawn_in_the_routes_block(self):
        poisoned = (
            "def post_wizard_prepare(body, request):\n"
            "    import subprocess\n"
            "    return subprocess.run(body.candidate['command'])\n"
        )
        assert wizard_write_offenders([], poisoned) == [
            "src/api/routes.py (wizard block): subprocess"
        ]

    def test_the_writer_scan_ignores_prose_that_names_the_forbidden_thing(self):
        """The AST half is what makes honest docstrings invisible to the guard.

        ``snippet.py`` says in prose that it imports no ``subprocess``; a module
        whose *only* mention of it is a docstring must still answer clean, or the
        guard would be loosened the first time somebody wrote that sentence.
        """
        prose = (
            '"""This module never imports subprocess and never calls Popen."""\n\n'
            "def resolve(command):\n"
            "    return command.strip()\n"
        )
        assert python_spellings(prose) == {"command", "strip"}
        assert wizard_write_offenders([], prose) == []

    def test_the_arming_scan_catches_a_hand_over_that_sends(self, tmp_path):
        fake = tmp_path / "useConnectorWizard.js"
        fake.write_text(
            "const chat = useChat()\n"
            "export function handOver(line) {\n"
            "  chat.setDraft(line)\n"
            "  return chat.send()\n"
            "}\n",
            encoding="utf-8",
        )
        assert arming_offenders([fake]) == [f"{fake}: send("]
        # And the clean shape — fill, and nothing else — answers nothing, which is
        # what makes the row above a verdict rather than a walk that flags all. The
        # comment recites the forbidden verbs; the scan reads calls, so it cannot
        # trip the guard.
        clean = tmp_path / "clean.js"
        clean.write_text(
            "export function handOver(chat, line) {\n"
            "  // no send, no stage, no appendDraft here — prose names them, the\n"
            "  // scan reads calls, so this line cannot trip the guard.\n"
            "  return chat.setDraft(line)\n"
            "}\n",
            encoding="utf-8",
        )
        assert arming_offenders([clean]) == []

    def test_the_verb_guard_catches_a_wizard_route_that_writes(self):
        poisoned = (
            "@router.get(\"/wizard/scan\")\n"
            "def get_wizard_scan(request):\n"
            "    return {}\n\n"
            "@router.post(\"/wizard/scan\")\n"
            "def post_wizard_scan(body):\n"
            "    return {}\n\n"
            "@router.post(\"/wizard/apply\")\n"
            "def post_wizard_apply(body):\n"
            "    return {}\n"
        )
        by_path = wizard_verbs(poisoned)
        assert by_path == {
            "/wizard/scan": ["get", "post"],
            "/wizard/apply": ["post"],
        }
        with pytest.raises(AssertionError):
            assert by_path == WIZARD_VERBS
