# 06 — The hub routes and panels follow the request

**Read first**: `docs/client-owned-workspace-spec.md` §5.4 rules 20–23, §5.3 rule
13, §10's item 5 ("Repository A's own connectors are offered in A and not in B"),
§9's T4's second half. Task 05's file describes the pool this task routes onto.

The two hubs' routes now answer the request's workspace, and the pool is the only
thing they reach. `app.state.mcp` / `app.state.lsp` stop being the app's hubs.

## Deliver

### 1. Every hub route names its workspace

`GET /api/mcp`, `POST /api/mcp`, `POST /api/mcp/restart`, `GET /api/lsp`,
`POST /api/lsp`, `POST /api/lsp/restart`, `POST /api/lsp/query`, `GET /api/lsp/log`
— each calls `require_workspace(request)`, then `hubpool.acquire(root)` (or its
already-acquired set), then behaves as it does today **about that workspace's own
declarations**: `load_externals()` reads A's `.nojae/mcp-settings.json` inside A's
scope, `all_servers()` reads A's `.nojae/lsp-settings.json`, and the statuses come
from A's managers, not from a process-wide pair.

The `enable`-flag writes (`set_externals_enabled`, `set_lsp_enabled`) already build
their path per call from the root, so they write A's file when asked in A's scope.
Nothing about their contract changes.

### 2. The restart routes restart that workspace's set

`POST /api/mcp/restart` and `POST /api/lsp/restart` rebuild **the request's**
`HubSet` in place: fresh declaration scan in that workspace's scope, the same two
managers, their internals rebuilt. A restart in A must leave B's tools untouched —
that is rule 13's hub half, and the case to assert.

Their gate is the per-workspace one task 04 put in place: refusal only when a reply
streams on *this* workspace.

### 3. The visible restart (rule 23)

Every hub payload carries whether this workspace's tools were **just rebuilt** — the
`built` flag task 05's `acquire` answers — plus the pool's own summary
(`GET /api/workspace`'s `hubs` block): which workspaces are live and whether the
ceiling has been reached, with the pool's one sentence when it has. Nothing renders
it in this task; task 11 draws the line and the sentence. The data is the point of
the deliverable.

A workspace the pool cannot admit (the ceiling) answers the pool's sentence with
**429**, from the hub routes as well as from `/api/workspace`. Never a silent empty
catalogue: an empty connector list and "your tools are not running here" are two
different answers.

### 4. The shim goes

Delete the `app.state.mcp` / `app.state.lsp` read-through task 05 left. Every
caller goes through the pool. `grep -rn 'app.state.mcp\\|app.state.lsp' src` must
come back empty.

### 5. The client

`useAppShell.js`'s `loadMcp` / `saveMcp` / `restartMcp`, `loadLsp` / `saveLsp` /
`restartLsp`, and `useChat.js`'s `loadChatMcp` / `loadChatLsp` and the restart
handlers are already wrapped by `withWorkspace` (task 02). This task is where that
starts *mattering*: a panel now shows A's connectors in A and B's in B. Verify with
a unit case that the panel's fetch carries the tab's folder and that switching the
folder re-reads rather than keeping the previous list. `useEditorLsp.js`'s
`POST /api/lsp/query` already carries it too.

**Do not** add a "this workspace's tools are restarting" line here: task 11 owns the
wording and its place in the interface. Render nothing new.

### 6. Tests

- Two folders, each with its own `.nojae/mcp-settings.json` declaring one differently
  named connector: `GET /api/mcp` in A offers A's, in B offers B's, and neither
  offers the other's.
- Same for `GET /api/lsp` with two declarations.
- A restart in A rebuilds A's set and leaves B's statuses and tools alone.
- The ceiling's sentence reaches a hub route as 429, with the bound named.
- `GET /api/workspace`'s `hubs` block reports both live workspaces and the ceiling
  state.
- `grep` finds no `app.state.mcp` / `app.state.lsp`.
- The client case: a panel fetch carries the tab's folder; a folder change re-reads.

## Files

- `src/api/routes.py` — the eight routes, the rewritten `_mcp_payload` /
  `_lsp_payload` (they take a workspace now), the `hubs` block, the shim's removal
- `src/api/server.py` — only if the shim lived there
- `src/core/hubpool.py` — only if the `built` flag needs exposing differently
- `tests/test_mcp.py`, `tests/test_lsp.py`, `tests/test_api.py`,
  `tests/test_hubpool.py` — the two-workspace cases and the ceiling case
- `web/tests/chatHubs.test.js`, `workbenchLspPanel.test.js`,
  `settingsModelsSection.test.js` — the panel cases

## Rules it must not break

- *"Both read their declarations from the working location's reserved folder and are
  hot-toggled from the UI."* Per workspace, and the toggle stays hot.
- *"The declaration files are the only source of truth for what runs. Their
  `enable` flag is the switch; their secrets never leave the server."* Every payload
  keeps stripping `headers`/`env` (and `initializationOptions` on the LSP side),
  per workspace. A new field must not smuggle a secret out.
- *"A declared-but-unconnected language server is still published from its declared
  tools and revived by its first call; only being switched off or errored keeps it
  out of the catalogue."* Unchanged, per workspace.
- *"Every write surface is the browser's alone"* — the two `enable`-flag routes are
  the workspace's declaration writes and were never gated on a reply; they stay
  ungated, and `tests/test_write_surface_isolation.py` keeps asserting what it
  asserts.
- *"Core owns logic, the API owns transport."* The payload shaping stays in the API;
  the pool owns the lifecycle.
- *"Tests stay hermetic"* — the two declarations are two `tmp_path` folders; the
  disable flags (or stub managers) keep every connector and server process out.
- **Do not render the restart or ceiling line in this task** (task 11), and **do not
  add cross-tab invalidation**.

## Depends on

Tasks 01–05.

## Done when

- `GET /api/mcp?workspace=A` offers A's connectors and `…=B` B's, with neither
  offering the other's, in one process.
- `GET /api/lsp` answers the same way.
- A restart in A leaves B's tools and statuses alone.
- A hub route on a folder the pool cannot admit answers 429 with the pool's
  sentence naming the bound.
- `GET /api/workspace` reports the live workspaces and the ceiling state.
- `grep -rn 'app.state.mcp\\|app.state.lsp' src` finds nothing.
- `pytest` and `cd web && npm test` are green. The e2e suite is **not** run.

Finish by moving this file into `todos/done/`.
