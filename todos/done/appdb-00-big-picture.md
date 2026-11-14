# Lot: app-level settings database — `nojae.db`

**The spec is `docs/app-settings-db-spec.md`. It is the authority for every number,
sentence and decision named here. Read the sections your task cites before you
write code.** This file is the map: what the lot builds, the invariants that hold in
every intermediate state, and where each task sits.

## What we end with

One SQLite file at the install root — `nojae.db` — holds what three per-workspace
JSON files hold today: the model connection (as `servers` + `models` tables), the
agent personas (as `agents`), and the prompt helpers (as `prompt_helpers`). The
other four `.nojae/*.json` files stay exactly as they are. The Settings dialog and
the Agent-modes dialog become editors over the database. There is **no migration**:
the flat files stop being read and are deleted along with their seeders, templates
and per-workspace state blocks.

Four decisions shape everything else, and each deletes a concept rather than moving
it:

- **D5** — no `app_config` table, no default model, no default agent. An agent whose
  `model_id` is null **cannot run**: it refuses with one sentence naming the agent.
  The last-used agent is `localStorage`, like the theme.
- **D7** — one resolution seam: agent → its model + its server → the connection, or
  the refusal sentence. A turn resolves **once, at its start**.
- **D9** — the tool-loop cap is a per-agent column (`agents.max_tool_iteration`,
  seeded 25, floor 1, no ceiling), MCP's knob only.
- **D13** — LSP activation has one gate: the declaration's `enable` flag. The
  workspace-settings member `lspEnabled` dies. **The name does not**: the chat
  payload and the Editor query route keep a `lspEnabled` field that is the
  conversation-scoped allowlist. Only the workspace-settings member dies.

## The store's shape (spec §4.2)

Four tables — `servers`, `models`, `agents`, `prompt_helpers` — and no key/value bag.
`PRAGMA user_version` carries the schema level: boot creates, upgrades, or **refuses
to touch** a newer file. Columns are `snake_case`; the JSON crossing to the browser
keeps the app's `camelCase` convention, and the translation lives in the one module
that owns the store. `agents.id` is the slug (session files on disk depend on it);
`agents.label` is unique; deleting a server cascades to its models; deleting a model
nulls the agents that pointed at it.

## Invariants that hold in EVERY task, including the intermediate ones

Quoted or paraphrased from `AGENTS.md`; a task that breaks one is not done.

- **One LLM layer.** "Every model call — every chat reply, a batch task's turns
  included — goes through `core/llmkit`, the only seam that speaks HTTP to an
  OpenAI-compatible endpoint." Re-pointing `EndpointsConfig` at the store leaves
  `core/llmkit` untouched.
- **Core owns logic, the API owns transport.** "the streaming endpoint is the only
  thing that turns them into frames"; "nothing under `core` may import the API
  layer." The store module is core: it takes no FastAPI types and raises no
  `HTTPException`.
- **Every write surface is the browser's alone** — the new store routes included,
  "and each is refused while a chat reply streams" applies to the routes that
  already carry that affordance and to no new one (spec §4.5: the settings and
  helper writes were never gated and still are not).
- **Tools are read-only by design.** `tests/test_write_surface_isolation.py` asserts
  it; extend it for every new write route rather than trusting this sentence.
- **No write destroys bytes.** For the store that means D12: a copy of the whole
  `nojae.db` into the app's existing dated backup folder before a **destructive**
  write (a `DELETE`), reusing the existing backup helper and its retention sweep. An
  `UPDATE` needs no copy.
- **Path rules come from two levels, one verdict: the strictest match wins.**
  `nojae.db` and its `-wal`/`-shm` sidecars get a level-A rule (workspace-conditional
  like `.env**` and `logs/**`) and the connectors' own deny-list entries. A hidden
  path is "indistinguishable from an absent one to a reader and named to a writer".
- **Tests stay hermetic.** "no test reads a real model connection or reaches a live
  hub". No test may open the real `nojae.db`: the suite gets a test-owned temporary
  database the way it already gets a test-owned `.env` and working location.
- **`web/src` never contains a reserved agent id.** The client reads `readonly` as
  **data**; the existing test that no reserved id appears in `web/src` survives and
  is extended to assert the flag — not an id — drives disabled rendering.
- **SSE is the UI's only source of truth**, timing is app-side, and cost and rate are
  different numbers. Nothing in this lot changes any streaming or measurement rule.
- **The working location.** One setting roots every file-touching part of the app. A
  workspace switch invalidates only what is genuinely workspace-scoped (hubs, policy,
  tree caches) — **nothing in the database** (D11). The per-root caches in the
  settings and modes readers are deleted, not re-pointed.

## Task order and the interim states it creates

| # | task | lands |
|---|---|---|
| 01 | the store module | schema, connection lifecycle, version refusal. Nothing reads it. |
| 02 | seeding and boot | built-ins + nine empty helpers, the unusable-store named state. |
| 03 | accessors and the resolution seam | new functions, still unused by any route. |
| 04 | the test harness | temporary-database fixtures, the restructured e2e file. |
| 05 | `nojae.db` invisibility | level-A rule, connector deny-lists, policy tests. |
| 06 | one LSP gate (D13) | route, panel and inverted assertions as one unit. |
| 07 | prompt helpers | the whole vertical: table, routes, bullets, tests. |
| 08 | servers/models routes + the Models section | the dialog edits the store. |
| 09 | the read switch | chat/config read the store; the workspace-settings file dies. |
| 10 | agents backend | the `agents` table is the modes source; the modes file dies. |
| 11 | agents frontend | the modes dialog and the composer's lock. |
| 12 | the model gate | composer warning, `localStorage`, the lot's launch checks. |
| 13 | the e2e specs | they stop reading store bytes; both suites green. |
| 14 | documentation | README, `AGENTS.md`, superseded pointers on the two old specs. |
| 15 | the acceptance sweep | the spec's §7 list, asserted, and the leftovers grepped. |

Two interim states are deliberate, and each is closed by the task named:

- **After 08, before 09**: the dialog writes the store while a chat turn still reads
  the old file. Nothing is lost and nothing is broken — the file is still the
  authority until 09 flips the read and deletes it. Do not leave it this way.
- **After 10, before 11**: the pencil's dialog cannot load, because its file and its
  two routes are gone. 11 lands the dialog against the store. Task 10 must not
  delete the composer's lock predicate or the payload's `default` key silently
  without noting them; 11 removes them. (The cap's editable field likewise has no
  home between 09 and 11 — it is a value the user can retype, and 11 puts it on the
  agent tab.)

The spec's §9 forbids three splits, and this lot honours them: the store lands alone
(01–03); the connection's read switch and its dialog are adjacent and both present by
the end of 09; and everything D5 makes one behaviour — the visible `todoBuilder`, the
per-agent model, the composer's gate, the `localStorage` choice, the lot's two launch
checks, and the deletion of `editable`, the lock predicate and the payload's `default`
key — is complete by the end of 12.

## Where things live

- New backend: `src/core/appdb/` (or one module that owns the database and nothing
  else — spec §4.1: "Every other module asks that module for data; nobody else opens
  a file, nobody else writes SQL, and no core function accepts a path to the
  database").
- Rewired: `src/config.py` (the resolution seam, the refusal sentence, the cap),
  `src/core/models.py` (`EndpointsConfig.from_store`), `src/core/agent_modes.py` (the
  read model), `src/core/prompt_helpers.py` (the table half), `src/api/routes.py`,
  `src/api/server.py` (boot), `mcp_connectors/path_policy.py`,
  `src/core/editorfs/builtin_policy.py`.
- Deleted outright: `src/core/workspace_settings.py`, `nojae-settings.default.json`,
  `src/core/agent_modes_write.py`, the three per-workspace seeders and their boot and
  switch call sites, the `workspaceSettings`/`agentModes`/`promptHelpers` blocks of
  `GET`/`POST /api/path-location`, `config.lsp_enabled_ids()`, the modes payload's
  `editable` and `default`, `prompt_helpers.SLOT_COUNT` and its count rule.
- Frontend: `SettingsDialog.vue`, `AgentModesDialog.vue`, `MemoryBullets.vue`,
  `RegistrationMemoryDlg.vue`, `WorkBenchInput.vue`, `AppBar.vue`, and the
  `useAppShell` / `useAgentModes` / `usePromptHelpers` / `useBatch` composables.
  "Every decision lives in a composable as a plain function, so a component only
  renders answers."
- Tests: `tests/conftest.py` is load-bearing — its neutralising fixture is what most
  of the backend suite calls. `web/tests/*` for the composables and dialogs,
  `web/e2e/03`, `04`, `08` for the specs that read store bytes.

Run both suites the README names (backend and frontend) for every task that touches
them. The e2e suite needs a reachable test model and is run in task 13.

## How the lot is finished

Every task file has moved into `done/`, and task 15 has walked the spec's §7
acceptance list item by item with both suites green.
