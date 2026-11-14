# 05 — One set of tools per folder: the pool

**Read first**: `docs/client-owned-workspace-spec.md` §3.1, §4.2, §4.3, §4.4 in
full, §5.4 rules 20–24, §5.6 rule 29, §9's T4. The big picture's *The mechanism —
The pool* and *A folder is admitted to the pool*.

A connector and a language server are bound to a folder **at birth**, so two
folders need one of each. This task builds the thing that holds them: a pool keyed
by canonical folder, where each entry owns that workspace's own MCP manager and its
own LSP manager, spawned against that folder, with a ceiling, an idle rule, a veto
and one sentence for when the ceiling is reached. The working-location placeholder
in a workspace's declaration now expands to that workspace.

This task builds the pool and its rules; task 06 puts the hub *routes* on it.

## Deliver

### 1. `src/core/hubpool.py` — the new module

House style again: a module docstring stating the invariant, no FastAPI, no
browser, every bound patchable at call time.

- **`HubSet`** — one workspace's tools: its `McpManager` and its `LspManager`,
  built for that root, started and stopped together. It carries its own creation
  time and a `last_used` stamp, and it knows how to `restart()` its two managers
  **in place** (each manager already keeps the object identity its worker threads
  hold — see `McpManager.restart`'s docstring — and the pool must not replace the
  managers either, for the same reason).
- **`HubPool`** — the map from canonical root to `HubSet`, plus the four rules
  below. `acquire(root) -> HubSet` is the one call the API makes: it admits if
  needed, stamps `last_used`, and answers. `release(root)` marks a workspace idle.
- **`status()`** — one dict per live workspace (root, whether its tools are
  `running`/`starting`/`idle`, when it was last used), for the interface task to
  render and for the tests to judge.
- **`stop_all()`** — tear every entry down on shutdown, through the hubs' own
  `stop_all`, which is the shared `proctree` teardown. The lifespan calls this
  where it calls the two hubs today.

### 2. The four rules (spec §4.4)

- **The ceiling.** A small, stated number of workspaces kept alive at once
  (`MAX_LIVE_WORKSPACES`, a module attribute so a test can patch it). Stated in one
  sentence the API can raise as a 429: it names the bound, says which workspaces
  are live, and says what to do (point another tab away, or wait for an idle one to
  be let go). It is **never** a silent eviction of the tab that just asked.
- **The idle rule.** A workspace with no tab behind it for
  `IDLE_RELEASE_SECONDS` is let go: its two managers are stopped and the entry is
  removed, freeing its ceiling slot. One background reaper on the app's own loop
  (the LSP hub already keeps one — follow that shape, at the same granularity), not
  a thread per workspace.
- **The veto.** A workspace with a streaming reply or a running batch is never let
  go. The pool asks the caller through an injected predicate rather than importing
  the API: the API registers a `busy(root) -> bool` callable at startup, exactly
  the `emit`-callable shape `AGENTS.md` describes. An idle attempt on a busy
  workspace is skipped, and the reaper tries again next tick.
- **The let-go sentence and the visible restart** (rule 23). A workspace whose
  entry was released is **restarted visibly** when a tab returns to it: `acquire`
  reports whether it built a new set, and the API carries that fact into the
  payload (task 06 exposes it; task 11 renders the line). The state is one flag on
  the answer — never a silent pause while tools come back.

### 3. Admission and seeding

`acquire(root)` on a root it has not seen is the **one** moment that folder's
reserved folder is seeded — the same four seeds the boot performs today
(`ensure_policy_file`, `ensure_mcp_settings_file`, `ensure_lsp_settings_template`,
and the LSP declaration is still never seeded), each with the "a seeding hiccup is
a note, never a failure" contract the boot already holds. A repeated `acquire` of a
live root writes nothing.

The installation folder is still admitted at boot (it is the folder a new tab lands
on), so the boot path and the admission path must be one function — the boot calls
the pool, not a copy of the pool.

**Ordering rule, kept:** the MCP declaration is seeded *before* the MCP manager
scans, because the declaration lives inside the folder the manager is spawned
against. On admission that means: seed, then build, then start.

### 4. The placeholder resolves per workspace

`config.provided_env_values()` already answers `NOJAE_PATH_LOCATION` from the seam
(task 01). This task proves the consequence: a declaration read for workspace A
expands `${NOJAE_PATH_LOCATION}` to A, one read for B expands it to B, in one
process, and `${PROJECT_ROOT}` still means the installation in both. Because
`HubSet` reads its declarations *inside its own workspace's scope*, no hub has to
take a root argument: `acquire` enters the scope before building.

### 5. The lifespan

`src/api/server.py` builds one `HubPool` instead of the two managers, keeps it on
`app.state.hubpool`, seeds and admits the installation folder through it, registers
the veto predicate, and stops the pool in the shutdown block. `app.state.mcp` and
`app.state.lsp` **stay** as read-through properties onto the *installation*
workspace's set (or the set of whatever workspace the request names, once task 06
lands the routes) so the routes that still say `request.app.state.mcp` keep
working for one more task. Do not leave that shim in the lot: task 06 removes it.

`NOJAE_DISABLE_MCP` / `NOJAE_DISABLE_LSP` keep working exactly as they do — a
hermetic test still reaches no hub, per workspace.

### 6. Tests

New `tests/test_hubpool.py`, hermetic (the two hub managers are stubbed or the
disable flags are set — the pool's rules are the subject, not the connectors):

- Two roots admit two sets; each set was built with its own root, and neither
  manager is the other's.
- Acquiring a live root twice builds nothing the second time and writes nothing.
- The ceiling: the `N+1`th distinct root answers the one sentence, names the bound,
  and the workspaces already live are untouched.
- The idle rule: a root past its idle window is stopped and its slot freed; the
  callback the stop used is the managers' own `stop_all`.
- The veto: a root whose `busy()` predicate answers true is never released, however
  long it idles, and is released once it answers false.
- The visible restart: release then acquire answers "built", with the flag set;
  a plain acquire answers "reused".
- Admission seeds: a fresh root gains its four reserved files on first acquire and
  none on the second. Exactly four — the LSP declaration itself is still absent.
- Placeholder per workspace: a declaration in A referencing
  `${NOJAE_PATH_LOCATION}` expands to A, one in B to B, and `${PROJECT_ROOT}` in
  both to the installation.
- Shutdown: `stop_all` stops every set, one call per manager.

Also update `tests/test_api.py`'s hub fixtures and `tests/test_mcp.py` /
`tests/test_lsp.py` where they reach `app.state.mcp`/`app.state.lsp`: the shim
above means most keep working; the ones that enumerated a hub's *lifetime* now
reach into the pool.

## Files

- `src/core/hubpool.py` (new)
- `src/core/workspace.py` — only if admission needs a hook there; the pool is
  normally the door
- `src/api/server.py` — one pool, one boot admission, one shutdown
- `src/api/routes.py` — the read-through shim, and the veto registration
- `src/core/mcphub/manager.py`, `src/core/lsphub/manager.py` — only if a manager
  needs a way to be built for a root without reading the process default; they
  already take their declarations from `constants.*_settings_path()`, which reads
  the scope, so the expected answer is "no change"
- `tests/test_hubpool.py` (new), `tests/test_api.py`, `tests/test_mcp.py`,
  `tests/test_lsp.py`, `tests/conftest.py`

## Rules it must not break

- *"Hubs are long-lived singletons. A restart rebuilds a hub's internals but never
  replaces the object the app holds, because worker threads keep the reference
  across a request."* The app holds **the pool**; a `HubSet`'s managers are
  rebuilt in place and never replaced while a worker holds them. State this in
  the module docstring — it is the reason the pool, not the manager, is the
  singleton.
- *"core/mcphub/ and core/lsphub/ — the MCP and language-server hubs. They mirror
  each other (discovery, manager, seed) — keep that symmetry when touching either
  one."* `HubSet` treats them symmetrically: same lifecycle, same status shape,
  same restart. If the two halves must differ, the difference is stated once and in
  one place.
- *"Both read their declarations from the working location's reserved folder and
  are hot-toggled from the UI."* Per workspace; the reserved folder is that of the
  root the set was born against.
- *"Inside the reserved folder a declaration is created only when absent and
  changed only outside the app."* Admission seeds only when absent, and a repeated
  acquire never writes.
- *"Teardown kills process trees, not wrappers"* — the pool's stop path is the
  managers' own `stop_all`; do not add a second teardown.
- *"Core owns logic, the API owns transport."* The pool takes a `busy` callable;
  it never imports the API.
- *"Tests stay hermetic"* — the pool's suite reaches no process; the disable flags
  and stubbed managers are how it stays honest.
- **Do not add cross-tab invalidation**: a folder created in another tab is
  invisible until the user refreshes (spec D7). The pool knows roots, not events.

## Depends on

Tasks 01–04.

## Done when

- `HubPool.acquire(root)` answers that root's own two managers, built for that root;
  two roots in one process have two of each.
- The ceiling answers one sentence naming the bound, and the `N+1`th root is the
  one refused — never a live one evicted.
- An idle root is stopped and its slot freed; a busy one never is; a returning tab's
  restart is flagged on the answer.
- A fresh root gains its four reserved files on first acquire and none on the
  second.
- `${NOJAE_PATH_LOCATION}` expands to each workspace's own root, `${PROJECT_ROOT}`
  to the installation, in one process.
- `app.state.hubpool` exists, is built in the lifespan, and is stopped there;
  `pytest` and `cd web && npm test` are green. The e2e suite is **not** run.

Finish by moving this file into `todos/done/`.
