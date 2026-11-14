# 09 — The read switch: a turn's connection comes from the store, and the workspace-settings file dies

## Deliver

The moment `EndpointsConfig` comes from the store, the file that used to hold it is
deleted — not deprecated. This task closes the window task 08 opened.

1. **Every model call resolves through the seam (D7).** `config.load_endpoints_config()`
   keeps its contract — `(config, None)` or `(None, sentence)` — but **takes the
   resolved agent**, because which connection answers is no longer one answer for the
   whole app. `src/api/routes.py`'s `_load_config()` and the chat route ask for the
   turn's agent; `core/chat.py` and the batch runner each change **once**: they ask the
   seam for the selected agent's connection instead of the workspace's one. Nothing
   downstream of that answer changes, and `core/llmkit` is untouched.
2. **A turn resolves once, at its start.** "A save that lands mid-turn cannot split the
   turn it is streaming." This is the invariant that replaces today's "refused while a
   chat reply streams" gate for these stores — and per §4.5, **no route gains or loses
   the existing streaming affordance**.
3. **The system prompt keeps its two levels (D8)**: an agent's `system_message` wins;
   empty means "use the model's own `sys_prompt`" — the same rule as today, except the
   fallback is now a property of the **model** rather than of the workspace.
4. **The cap becomes per-agent (D9)**: the tool loop's `maxIterations` comes from the
   resolved agent's `max_tool_iteration` (floor 1, no ceiling, MCP's knob only — LSP
   round-trips stay uncapped). The field leaves the Settings dialog's MCP section with
   this task and gets its home on the agent tab in task 11; in between it is simply not
   editable, which the spec accepts (a value the user can retype).
5. **Delete the file layer** (§4.7): `src/core/workspace_settings.py`,
   `nojae-settings.default.json`, its seeder and its boot + workspace-switch call
   sites, its per-root cache, `config.workspace_settings_refusal()` (moved to the
   store's sentence in task 03), and the `workspaceSettings` block of
   `GET`/`POST /api/path-location`. `tests/test_workspace_settings.py` and
   `tests/test_workspace_settings_seed.py` are **deleted**, their surviving rules
   re-homed as store tests (schema/validation → the store's own tests; seeding → task
   02's; the "configured vs template text" state → gone, since nothing is seeded with
   instruction sentences any more).
6. **The app bar narrows to the store-level question** (§5.4): *is the store usable,
   and does it hold at least one model?* The three per-workspace file notices are gone
   (the `workspaceSettings` one here; the other two blocks go with 07 and 10). One
   app-level notice replaces the file notice: **no model configured** — with the same
   rule as today, that the dialog shows the server's own sentence and translates
   nothing. Whether *this* turn can run is deliberately left to the composer (task 12):
   one warning in two places means two sentences to keep in step.
7. **The e2e test file is restructured and materialised** (§4.6 + D14 steps 1–2 — the
   spec moves its *shape* and its first two materialisation steps here, because this is
   when a connection can only come from a row):
   - `.nojae/nojae-test-settings.json` becomes the nested `server { … model { … } }`
     document of §4.6, with the **column names** as member names (a deliberate break
     from camelCase: the file is a store fixture, not a UI payload). It describes one
     server with one model and **never carries an id** — the harness assigns both.
     `lspEnabled` and `maxToolIteration` are **absent** (D13, D9).
   - With `NOJAE_TEST_SETTINGS` truthy the app **never opens `nojae.db`**: it creates a
     test-owned temporary database, seeds the built-ins as at boot, and inserts the
     file's server and model as rows. A missing or malformed file makes the suite
     **refuse to start** — never a fall-through to the developer's connection (T-D3's
     "no fallback in either direction" survives the move). The reader validates with
     the same strictness as the tables: an unknown key or a wrong type is a named
     failure, never a silently-defaulted sampler.
   - **Step 3 — pointing every agent row at that model — is NOT this task.** It belongs
     with task 12, the task that makes an agent without a model unrunnable. Until then
     the pytest suite stays green because its own helper already points every agent at
     the fixture model (task 04).
   - `web/playwright.config.js` keeps its loud "fixture missing" failure and its
     `NOJAE_TEST_SETTINGS=1`; update its comments, which today describe the 14 flat
     members.
8. **`GET /api/config`** keeps answering what the two views read (the model list, the
   vision flag, the occupancy gauge's context-window cap) **without inventing a default
   model**: the cap is the context window of the model the turn runs on. Choose the
   route's shape so no answer implies "the" model; the composer's selection is wired to
   it in task 12.

## Files

- `src/config.py`, `src/core/models.py`, `src/core/chat.py`, `src/api/routes.py`,
  `src/api/server.py`, `src/core/batch.py` if it reads the cap.
- Deleted: `src/core/workspace_settings.py`, `nojae-settings.default.json`,
  `tests/test_workspace_settings.py`, `tests/test_workspace_settings_seed.py`.
- `.nojae/nojae-test-settings.json` (restructured — it is gitignored and hand-authored,
  so also update `.env.test.example`-adjacent documentation only in task 14),
  `web/playwright.config.js`.
- `tests/conftest.py` (the test-mode switch's new meaning), `tests/test_config.py`,
  `tests/test_chat.py`, `tests/test_api.py`, `tests/test_env_isolation.py`,
  `web/tests/appBarConnectionOnSwitch.test.js`, `web/tests/settingsWorkspaceFileNote.test.js`,
  `web/tests/useAppShellRetry.test.js`.

## Rules it must not break

- **`AGENTS.md`**: "Every model call — every chat reply, a batch task's turns included —
  goes through `core/llmkit`." Do not add a second HTTP seam; do not touch `llmkit`.
- **`AGENTS.md`**: "Core owns logic, the API owns transport. The blocking model call
  runs in a worker thread publishing events… nothing under `core` may import the API
  layer." The resolve-once-at-turn-start happens before the worker is handed its
  connection.
- **`AGENTS.md`**: "A stream cut by the server looks like a finished answer at the chunk
  level… Token counts… Cost and rate are different numbers." No streaming or
  measurement rule changes here.
- **`AGENTS.md`**: "A test run takes its endpoint from the test files, never from a
  developer's." AC-7 is this task's core assertion.
- **`AGENTS.md`**: "`.env` is regenerated from a fixed template on every save — a new or
  renamed key means changing the template and its committed example together." If any
  `.env` key's meaning or presence changes here, the template and `.env.example` move
  with it; the spec's scope says `.env`'s contents do **not** change, so the expected
  answer is that they do not.
- **A broken configuration is a named state with one sentence** (spec §2).

## Depends on

Tasks 03, 04, 06 (the file's `lspEnabled` reader must be gone before the file is), and
08 (the dialog must already edit the store — a dialog that writes a file nothing reads
is worse than one that does not exist).

## Done when

- A chat turn's connection comes from the store: a test asserts that changing the agent's
  model row changes the next turn's server URL, and that a save landing mid-turn does
  not change the streaming one.
- An agent with a null `model_id` refuses with the one sentence naming the agent, from
  the chat route, and the same sentence is what the app bar and the dialog show.
- `grep` for `workspace_settings` / `nojae-settings` in `src/` and `tests/` returns
  nothing; the two test modules are gone and their rules re-homed.
- A test asserts that with the test switch on, the real `nojae.db` path is never opened,
  and that a malformed test settings file stops the harness with a named failure.
- Backend and frontend suites pass.

**Known window this task opens**: on a real install, until task 11 gives an agent a model
dropdown, a chat turn refuses with the "no model" sentence — the intended fresh-install
state (D7), which task 12's composer warning makes visible. Do not paper over it with a
fallback.

## Notes from the implementation

**The seam is one function, not two.** `load_endpoints_config(agent)` replaces both the
old file reader *and* task 03's `load_agent_endpoints_config`. Two builders answering
"which connection" would be two authorities on a turn, and the deleted one is the thing
§4.7 asks for.

**A turn's two facts come from two places, and that is deliberate until task 10.** The
modes read answers the persona and hub flags (a file today); the store's row of the same
id answers `model_id` and `max_tool_iteration`. `routes._agent_row_for` is that join, and
it is the one place a mode id becomes a store row. A mode with no row (only reachable by
declaring one in the file before task 10) is answered as an agent with no model — which
is exactly what D7 says it is. The harness grew `write_agent_row` for the suites that
declare such a mode, so a test of a *persona* does not also have to test the seam.

**Test mode moves the path, not a branch.** `appdb.database_path()` answers
`appdb.test_root()`'s file when the switch is on, so a switched-on process has no name
for the install's store at all — "no fallback in either direction" is mechanical rather
than argued. The fixture's own reader (`_read_test_fixture`) is what validates it, and
the boot's transaction is what materialises it, so a bad fixture rolls back to the
unusable state rather than leaving a server with no model.

**One deliberate deviation, reported rather than resolved silently.**
`tests/test_env_isolation.py`'s test-switch class used a *module-scoped* autouse fixture
to export `NOJAE_TEST_SETTINGS=1`, because that runs before the function-scoped guards
and is therefore a real leak test. It cannot any more: the store fixture also reads the
switch, so an export around the module would make `_every_test_gets_its_own_store` boot
from this checkout's own hand-authored fixture — the very leak the case exists to
forbid. The guard's one line was therefore pulled out into
`conftest.clear_test_settings_mode(patch)` and the case runs it against its own export.
The assertion (an ambient `1` does not survive into a test body) is unchanged.

**Three things the task did not name, found by running the suites:**

1. `/api/settings` had no reader left once the dialog was on the store, so it is **gone**
   (`GET` and `POST`), not deprecated — the same §4.7 rule as the files. Its tests'
   surviving rules moved to the store routes' own suites.
2. The MCP section lost its `maxIterations` in **both** directions (payload and body),
   which task 10 does not cover: D9 moves the cap to the agent tab, so leaving the MCP
   write in place would have been a second writer of a value that belongs to an agent.
3. `GET /api/config` answers `{models: [...], store: {usable, sentence}}` — a list, so no
   answer implies "the" model. The two views that read a per-model flag (the attach
   button's vision gate and the occupancy gauge's context-window cap) go through the one
   plain function `useAppShell.modelInView`, which task 12 re-points at the composer's
   selection; until then it answers the first entry, which is the shape those views had
   while one connection served the whole app.

**`.env` untouched**: the spec's scope says its contents do not change, and they did not.
Its *comment block* did — it pointed at `nojae-settings.json`, which no longer exists —
so the renderer, `.env.example` and the parity test moved together, as `AGENTS.md` asks.
