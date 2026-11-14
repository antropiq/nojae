# 01 — The store module: schema, connection lifecycle, version refusal

## Deliver

One module under `src/core/` that owns the SQLite database and **nothing else**, so
that every later task asks it for data instead of opening a file. After this task the
module exists, is importable, is unit-tested, and is read by no route and no other
core function: the app behaves exactly as before.

It must provide:

- **The path.** `<install root>/nojae.db`, computed the way every other
  install-scoped path in this app is computed (see how `src/config.py` and
  `src/core/editorfs/constants.py` each derive `PROJECT_ROOT` from their own file's
  location). No platform branch, no separator spelled, no drive assumption, no `~`
  expansion anywhere near this code (spec §4.9). The path is a module-level answer a
  test can move, not a constant baked into a query.
- **Opening.** Read-write, **one connection per worker thread**, with a busy timeout,
  WAL journal mode on, and no text-mode translation. The reason for WAL is the app's
  shape — a request thread that may be saving while a chat worker thread reads — and
  the busy timeout covers the writer-writer case (two browser tabs). Say both in the
  module docstring; they are the reason the code looks the way it does.
- **The schema, verbatim from spec §4.2**: the four tables `servers`, `models`,
  `agents`, `prompt_helpers`, with every column, default, `UNIQUE`, `REFERENCES` and
  `ON DELETE` behaviour exactly as the spec writes them, and **no fifth table and no
  key/value bag** (D5). Re-read §4.2's list of "invariants the schema itself must
  express" before writing: each one is there for a stated reason, and the nullable
  samplers in particular must keep `0` and "not set" distinguishable.
- **The version gate (D6).** `PRAGMA user_version` records the schema level. Boot
  either creates the schema at the current level, upgrades an older one, or
  **refuses to touch** a file whose level the app does not understand. The refusal is
  a returned value / raised store-level error naming the path and the level found —
  never a silent read with older rules, and never a traceback.
- **A store-level error type** for "the database cannot be opened or used", carrying
  the sentence that names the path. Task 02 turns that into the app's named state;
  this task only has to be able to report it.

## Files

- New: the store module (and a package folder under it if you split schema /
  connection / accessors — that is your call, but the module boundary is the one the
  spec asks for: nobody else writes SQL).
- New: `tests/test_appdb_store.py` (or the name you prefer for the store's own tests).
- Read for context, do not change: `docs/app-settings-db-spec.md` §4.1, §4.2, §4.9,
  D1, D6, D11.

## Rules it must not break

- **"Core functions never touch FastAPI"** and **"nothing under `core` may import the
  API layer"** (`AGENTS.md`, Key patterns). No `HTTPException`, no request/response
  types in this module.
- **"No new dependency: the Python standard library ships SQLite"** (D1). `sqlite3`
  only; do not add anything to `pyproject.toml`.
- **Tests stay hermetic** (`AGENTS.md`, Gotchas): every test in this task builds its
  database under `tmp_path`. Nothing may open the real `<install root>/nojae.db`.
- **No write destroys bytes** — nothing in this task deletes anything, and no route
  exists yet, so D12's pre-delete copy is *not* this task's job (task 08 adds it with
  the first destructive route).

## Depends on

None. This is the lot's first task.

## Done when

- The module creates the four tables at the current `user_version`, and a test asserts
  the schema by reading it back (table and column names, the two `UNIQUE`
  constraints, both `ON DELETE` clauses, the nullable samplers).
- Tests cover: a fresh file is created and versioned; an older version is upgraded; a
  **newer** version is refused and its bytes are untouched; an unopenable path (a
  directory where the file would be, or an unreadable file) reports the store-level
  error naming the path instead of raising out of the module.
- Two connections on two threads: one holds a write transaction while the other reads,
  and the reader does not raise (the spec asks for this test explicitly in §4.10;
  land it here, where the thing it measures is the only thing that exists).
- The whole backend suite passes, unchanged — no existing test was touched, because
  nothing reads the store yet.
