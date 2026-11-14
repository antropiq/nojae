# 04 — The test harness: a store-shaped neutraliser for the whole suite

## Deliver

`tests/conftest.py` is the load-bearing file of this lot: its neutralising fixture is
what most of the backend suite calls, so replacing it with a store-shaped equivalent
unblocks most of the rest. After this task **every test runs against a test-owned
temporary database**, and the real `<install root>/nojae.db` is never opened by a test
— while the old file readers still exist and still answer, so no test's *assertions*
change yet.

1. **One autouse fixture** that points the store at a per-run temporary database, in
   the same style as the existing autouse fixtures that redirect `.env`, the working
   location, and the two hub switches. It creates the schema and runs the seeding pass
   (task 02), so a test starts from four built-in agents and nine empty helper rows.
2. **One helper a test calls when it owns its own root** — the store-shaped twin of
   today's `neutralise_workspace_settings` / `write_workspace_settings` pair. It takes
   what those take (a server URL, a key, a model name, samplers, and — for the tests
   that need one — an agent with **no** model) and writes rows instead of a file.
   - A test that wants an agent with no model **clears that row's `model_id` itself**:
     that is the only way such a state is reachable, which is what makes it a deliberate
     fixture rather than an accident (D14's closing paragraph).
   - The helper's default document is a *configured* connection, as today's default is,
     so the tests that only wanted "not the developer's settings" keep wanting that.
3. **Retire the file-shaped autouse guard** (`_no_workspace_settings_leak` and its
   guard-root fixture) in favour of the store guard, and keep the invariant it exists
   to assert: a test that does not ask still cannot reach a real configuration. Where
   today's guard checks the file is absent from a folder of the fixture's own, the new
   one checks the real database path was never opened.
4. **A test that asserts the hermeticity**, not a sentence in a docstring: the suite
   never opens `<install root>/nojae.db`. Same style as the existing write-surface
   isolation test — assert the invariant, do not trust the intent.
5. **Migrate the call sites** of the old fixtures across the suite. The spec measures
   the blast radius: the workspace-settings file is touched by a dozen test modules
   (its own two, plus the LSP, chat, API, config, MCP and editorfs suites, and
   `conftest.py`), and agent modes by a similar set including the write-surface
   isolation test. Change **how those tests neutralise**, not what they assert — with
   one exception: the three modules that test the file layer itself
   (`test_workspace_settings.py`, `test_workspace_settings_seed.py`,
   `test_agent_modes_write.py`) are **left alone here**; they are deleted by the task
   that deletes the layer they test, and their surviving rules re-homed as store tests.

## Files

- `tests/conftest.py` (the fixtures and the helper).
- Every backend test module that calls the old fixtures — the neutralising calls only.
- New: the hermeticity test (a name of your choosing, beside the other guard tests).

## Rules it must not break

- **`AGENTS.md`, Gotchas — "Tests stay hermetic"**: "no test reads a real model
  connection or reaches a live hub — the hubs are disabled by an environment flag and
  their declared file locations are patched per test." The store joins that list of
  things a test owns.
- **The e2e switch stays pinned off for the pytest suite** (the existing
  `_no_test_settings_mode` fixture). Task 09 gives that switch its new meaning; this
  task must not weaken it.
- **Do not change an assertion to make a migration pass.** If a test's assertion cannot
  survive the move, that is information: report it in the task's answer rather than
  quietly loosening it.

## Depends on

Tasks 01, 02, 03.

## Done when

- `pytest` passes with the whole suite running on a temporary database.
- The hermeticity test fails when pointed at the real path (feed it a deliberately
  poisoned input, the way the isolation test does — a guard that cannot fail is not a
  guard).
- `grep` for the old neutraliser's name in `tests/` returns only the three
  file-layer modules that task 09 or 10 deletes.
- No production code changed.

## Notes from the implementation

**Nothing was loosened to make the migration pass.** Every assertion of every migrated
module survived unchanged; only the neutralising calls moved. The three file-layer
modules named above never called the old neutraliser at all (they build their own
documents through `workspace_settings` / `agent_modes` directly), so the grep now
returns **nothing** — stricter than the criterion asked.

**Two things the harness needed that the task did not name**, both found by asserting
the guard rather than trusting it:

1. **The audit event for an open is `open`, not `os.open`.** A hook keyed on the
   function's name never runs, so the create-time half of the guard — the half that
   stops a bypassed harness leaving the developer's file *behind* — was dead code.
   `test_the_open_event_is_refused_at_the_create_too` asserts both the live name and
   the dead one, so the mistake cannot come back.
2. **The `open` event carries no `dir_fd`**, so a *relative* name there cannot be
   judged: resolving it against the working directory made the guard refuse pytest's
   own temp-dir cleanup, which walks a leftover `nojae.db` with
   `os.open(name, ..., dir_fd=...)`. Relative names are therefore judged on
   `sqlite3.connect` (where the driver resolves them against the CWD, and which is the
   half that would read or write the rows) and left alone on `open`. Asserted as a
   choice, not left as a silent gap.

**The guard refuses the WAL sidecars too** (`nojae.db-wal`, `nojae.db-shm`), because
`appdb` calls them part of the store — a test that could open one could damage a
developer's settings without ever naming the main file. Task 05 gives the same three
names the path-policy rule and the connector deny-list; this is the test-side half.

**One deliberate deviation, reported rather than resolved silently.** The task asks for
the file-shaped autouse guard to be *retired* in favour of the store guard. It was
**renamed instead** (`_no_workspace_settings_leak` → `_no_ambient_workspace_settings`)
and kept, because retiring it here would break the very invariant the task's own rules
list: the file readers are still the app's until task 09 flips the read, so the
developer's `.nojae/nojae-settings.json` is still a live answer. Measured, not argued —
with that one `setenv` removed, `tests/test_env_isolation.py` fails nine cases and the
leak is this checkout's own configuration: a real connection, `maxToolIteration` 500, and
three enabled language servers reaching every test. The store guard the task asks for is
in place and asserted; the file guard now dies with the file layer it guards, in task 09.
The old *name* is gone from `tests/`, which is what the "Done when" grep asks for.

**The harness writes both stores on purpose** (rows, and the same values into the file)
until task 09. That is the interim state the lot's table predicts for 08→09, one task
early for the *write* side, and it is what lets every existing assertion survive
unchanged. `lspEnabled` and `maxToolIteration` have no column — the first dies with D13
in task 06, the second becomes a per-agent column in 09 — so they go to the file only,
except that the cap also lands on every agent row so the value is already in the store
when the read flips.
