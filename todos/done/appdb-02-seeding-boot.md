# 02 — Seeding, and a boot that survives an unusable store

## Deliver

Boot brings the store up and populates it, and an unusable store becomes a **named
state** rather than a crash or a silent empty database. Still nothing reads the store
for a model call — this task lands seeding and the boot contract only.

1. **Seed the four built-in agents** — `chat`, `code`, `architect`, `todoBuilder` —
   into `agents`, **inserted when absent**, with `model_id` **null**. Only
   `todoBuilder` is seeded `readonly = 1`. Idempotent and **run on every boot**, not
   only the first.
   - The personas, labels, hub flags and the generated lot-conventions block stay in
     the module that holds them today (`src/core/agent_modes_defaults.py`): the seeder
     reads them from there, it does not copy them. That module's stated reason for
     existing — the fallback and the seeded path share one definition — is unchanged
     by the move.
   - **For a `readonly` row, code is the source of truth for every column except
     `model_id`**: every boot re-asserts label, hub flags, persona and cap on that row
     (D4). Only the model association survives a restart. This is what makes re-seeding
     safe rather than destructive, and it keeps the generated lot-conventions block in
     exactly one place.
   - Seeded cap: **25** for all four (D9).
2. **Seed nine empty gray prompt-helper rows** — the colour and the empty content the
   file seeder writes today — **when the database is created, and never again**. A
   table that is empty afterwards is a choice the user made; a boot that refilled it
   would undo a delete the app promised to honour (D12). So the seeding pass needs to
   know whether it created the file, and that must be decided by the creation itself,
   not by "is the table empty".
3. **Never seed servers or models.** No example server, no placeholder key, no
   placeholder URL (spec §4.3). A value that cannot be dialled must not be inserted in
   order to be dialled.
4. **Wire it into boot** (`src/api/server.py`), in the order spec §4.3 gives: open or
   create → apply the schema at the current level, upgrade, or refuse → seed. Follow
   the contract every seed in that module already holds: a seed that cannot write
   **logs and returns a state dict**, it does not take the boot down. So:
   - the app starts with an unopenable, unwritable or too-new database;
   - the store's state is answerable by a later task as one sentence naming the path
     (task 03 exposes it, task 09 shows it in the app bar);
   - nothing about the failure raises into the lifespan.

## Files

- The store module from task 01 (its seeding pass).
- `src/api/server.py` — the boot sequence.
- `src/core/agent_modes_defaults.py` — read it; change it only if a built-in's data is
  not already reachable as data (it must stay the single definition).
- `tests/test_appdb_seed.py` (new).

## Rules it must not break

- **"A broken configuration is a named state with one sentence, never a silent
  default"** (spec §2, property 2). An unopenable database is reported, not treated as
  an empty one.
- **The `AGENTS.md` seeding contract**: "a declaration is created only when absent and
  changed only outside the app; a store is written by the app through its own route,
  never through a path." Seeding the store at boot is the app writing its own store —
  fine — but no route or path may reach it yet, and nothing here may write a
  **declaration** file.
- **`AGENTS.md`**: "No write destroys bytes: a save backs up what it replaces". The
  `readonly` re-assert is the one place this task overwrites a row; it is allowed
  because D4 says so in terms, and only for a `readonly` row's non-`model_id` columns.
- **Tests stay hermetic**: every test points the store at a `tmp_path` database.

## Depends on

Task 01.

## Done when

- A first boot creates the database with four agent rows (`todoBuilder` `readonly`,
  all `model_id` null, all caps 25) and nine empty gray helper rows, and no server or
  model rows.
- A **second** boot changes nothing: a test corrupts a `readonly` row's persona and
  label by hand, boots again, and finds them re-asserted while that row's `model_id`
  (set by hand too) survives; and a test deletes helper rows, boots again, and finds
  them still deleted.
- A boot where the database cannot be opened or created still serves the app: a test
  asserts the app starts and the store reports the unusable state with the path in the
  sentence.
- The backend suite passes; no existing test changed.
