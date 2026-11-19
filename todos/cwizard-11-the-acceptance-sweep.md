# Task 11 — The acceptance sweep

## Deliver

Walk spec §12 **end to end** and close every gap it finds. This is the lot's last
task and its only job: make the twenty-two numbered rows true **and guarded**, then
report. You are the first reader who has the whole feature at once, so a row that
cannot be demonstrated is a defect you name — not a row you reword.

For each row, in order:

1. Find the assertion that already proves it (the tests tasks 01–09 added).
2. If none proves it, **add the assertion** — in the file that owns that surface
   (a catalogue row goes in `tests/test_mcp_catalogue.py`, a gate row in
   `web/tests/connectorWizardRules.test.js`, a browser fact in
   `web/e2e/13-connector-wizard.spec.js`, and so on), never in a new catch-all file.
3. If the row is true but unprovable from the code (an AC about a real package
   existing on a registry, for instance, which the spec puts out of reach), record
   it in the report as verified by task 01's hand check and say where.

Rows that need a **new guard** rather than a new example — these are the lot's
"asserted, not intended" promises, so treat them as the sweep's main work:

- **AC-14** — nothing writes a declaration, starts a process or installs a package.
  Extend `tests/test_write_surface_isolation.py` in its own style (one walker,
  shared by the guard and its self-check, plus a poisoned input, "because a guard
  that cannot fail is not a guard"): no route, core module or client file of the
  wizard reaches a declaration **writer**, a `/api/fs` write, a settings-store
  write, the seeding path or a subprocess spawn; and the wizard's own posts appear
  nowhere in `web/src` next to a send or an arming call. The existing
  `WRITE_MARKERS` shape is what makes a read invisible to the scan — add the wizard's
  routes to the guard's **expected-absent** list, do not add them to the write list.
- **AC-15** — the scan never reports a hidden path and never returns bytes (the
  poisoned-file row in `tests/test_editorfs_projectfacts.py` must be the real
  thing: a file whose contents would appear in the answer if anything read them).
- **AC-16** — the wizard's model calls enter neither the session clock nor the cost
  badges: assert, over a completed wizard walk with a stubbed answer carrying a
  plausible `usage`, that the session's state is untouched (`useSessionStats` /
  `useChat`'s session numbers before and after identical).
- **AC-22** — no panel, tool list or hub gained a sentinel check or an auth
  pre-check: a scan over `src/core/mcphub`, `src/core/lsphub`, the two panels and
  the tool-list surfaces asserting the sentinel constant appears **nowhere** in
  them (it is the snippet module's and the catalogue's, and nothing else), plus a
  poisoned hub file that names it and is refused.
- **AC-21** — the catalogue carries exactly the nine, and each snippet is built from
  its `member` group alone: prove it for **all nine**, entry by entry, so a later
  entry that leaks a `requires` value into its member fails here.

Then run the three suites, read what they printed, and finish the lot's own record:

```
pytest
cd web && npm test
cd web && npm run test:e2e
```

## Files it touches

- the test files listed above, and any test file a row shows to be lying
- `src/`, `web/src/` **only** to fix a defect an AC row proves real — a fix you make
  here gets its own commit and its own note in the report, and never widens what the
  feature may do (no new capability is licensed by this task)
- nothing else. Not `AGENTS.md`, not `README.md` (task 10 owns those) unless a fix
  you made here made one of their sentences untrue — then correct that sentence and
  say so.

## Rules it must not break

- Every rule in the big picture still binds a fix made here — above all: never
  writes a declaration, never starts a process, never installs, one LLM layer, one
  attempt with no waiting, no numbers in the dialog, no downstream verification, and
  "the connectors answer the workspace level for their own root … app and connector
  reach one verdict with one matcher."
- A failing test is information, not an obstacle: fix the code or the claim, never
  the bar. Do not delete or skip an assertion to get green, and do not loosen
  `tests/test_write_surface_isolation.py`, `tests/test_workspace_seam.py` or the
  hermeticity guards (`tests/test_store_hermeticity.py`, `tests/test_env_isolation.py`)
  — those files exist to refuse exactly the shortcuts this task is tempted by.
- "Tests stay hermetic": if a sweep row tempts you toward a live hub, a real store or
  a real endpoint, that row is satisfied by an assertion about the app's own answer,
  not by a live call.
- The sweep adds no feature: an AC row that needs one is out of scope by §15, so
  report it instead of building it.

## Depends on

All of **01–10**.

## Done when

1. The three suites above pass, on this machine, with no skipped or silenced row.
2. A table exists in your final report: **one row per AC (1–22, 8a included)**, and
   for each the file and test name that proves it — or the fix you made to make it
   true, or why it cannot be proven from the code. Every reference you print you have
   opened and confirmed: "a test that enforces an invariant is worth naming as a
   pointer — the invariant stays the point."
3. `git diff` since task 01's first commit contains no path outside: the catalogue
   file, `src/core/wizard/`, `src/core/mcphub/`, `src/core/lsphub/`,
   `src/core/editorfs/`, `src/api/routes.py`, `web/src/`, `tests/`, `web/tests/`,
   `web/e2e/`, `README.md`, `AGENTS.md`. Anything else (a `.nojae/`, `nojae.db`,
   `.env`) is the lot's own leak: name it in the report and remove it.
4. **Move this file to `todos/done/`** as the very last step — an empty `todos/`
   (besides `.gitkeep`) is the lot being finished.
