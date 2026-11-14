# 15 — The acceptance sweep: prove §7, and hunt the leftovers

## Deliver

Nothing new is built here. This task walks the spec's §7 acceptance list against the
running app and the suites, and hunts the debris the earlier tasks would have missed —
the dead branches the spec warns about by name ("the code stays behind looking useful").
Anything that fails is fixed in this task, in the layer that is wrong.

**A. The acceptance list, item by item** (`docs/app-settings-db-spec.md` §7). For each,
say in the answer how it was proven — a test name, a spec name, or the manual step taken
in the app:

1. Configure a server with two models, pin one agent to each, in workspace A; switch to
   workspace B — everything there, unchanged, no setup step.
2. A fresh workspace's `.nojae/` holds no settings, modes or helpers file, and nothing
   looks for them.
3. An agent with no model cannot be sent to: the composer's warning beside the pencil, its
   tooltip, Send disabled, **and** the same state refusing a request made directly against
   the chat route with one sentence naming the agent; assigning a model clears all of it.
4. `todoBuilder` is visible in the dropdown and the dialog, can be given a model, and
   refuses every other edit — including one attempted directly against its route.
5. Prompt helpers can be added and deleted; the row renders whatever count the store holds.
6. `nojae.db` and its sidecars are absent from the Editor tree, from search, from git
   status, and unreachable by both connectors, when the working location is the install.
7. A test run with the test switch on never opens `nojae.db`; its connection comes from the
   restructured test file materialised into a temporary database, every agent resolves a
   model from it, and the run refuses to start when that file is absent or malformed.
8. Deleting a server removes its models and leaves the pointing agents with no model —
   visible as the composer's warning and the Settings dialog's unassigned count, not as a
   silent failure — and a copy of the database precedes the delete in the backup folder.
9. A language server declared `enable: true` runs with no other switch ticked, and an agent
   with `lsp_enable` false still cannot reach it.
10. A chat thread can switch agent after it has turned, from any agent to any other,
    including `todoBuilder`; a running lot still cannot be moved.
11. The four built-in agents cannot be deleted, from the dialog or from the route; a
    user-created agent can.
12. The existing suites pass with the changes §4.10 and §5.6 name, including the write-surface
    isolation test extended to the new routes.

**B. The leftovers the spec names as traps**, each checked with a grep and, where dead code
remains, deleted here:

- **`editable`** — after the lock died, "every branch that reads it is dead code that still
  looks load-bearing". Nothing in `src/` or `web/src` reads it.
- **the `default` key** — "the key is read by the composer, the lot and the modes dialog.
  Deleting the setting but leaving the key returning a value invites someone to wire it
  back up." No payload returns it and no client reads it.
- **the lock predicate** and its call sites — gone, with the tooltip sentence about a fixed
  mode.
- **`lspEnabled`** — the sweep must have left the *conversation-scoped* occurrences alone.
  Grep `src/` and `web/src/` and confirm every remaining occurrence is the allowlist (chat
  payload, Editor query route), and that no comment lets the two meanings converge on one
  word.
- **the three deleted stores** — `grep -r` for `nojae-settings`, `agent-modes.json`,
  `prompt-helpers.json`, `workspace_settings`, `agent_modes_write`, `SLOT_COUNT` across
  `src/`, `web/src/`, `tests/`, `web/tests/`, `web/e2e/`, `mcp_connectors/`, `lsp_connectors/`,
  `README.md`, `AGENTS.md`. Every hit is either a legitimate historical reference (a
  superseded spec's body, a changelog-style sentence) or debris to delete.
- **the per-root caches** — no cache keyed by workspace survives anywhere in the settings or
  modes read path (D11).
- **the three `path-location` state blocks** — absent from the route payloads and from
  `useAppShell`.
- **the reserved-id rule** — grep `web/src/` for the four built-in agent ids; the only
  acceptable hit is the lot's own pin constant, which names `code` because the lot contract
  names it (check whether the existing test already carves that out, and keep whatever
  carve-out it uses rather than inventing a second one).
- **the store module's boundary** — grep for `sqlite3` and for raw SQL strings outside the
  store module: "nobody else opens a file, nobody else writes SQL, and no core function
  accepts a path to the database" (§4.1).
- **`.env` untouched** — the diff for `.env.example` and the `.env` template renderer is
  empty; the spec's scope says `.env`'s contents do not change.

**C. Run everything one last time**, in the order the README gives: the backend suite, the
frontend unit suite, the e2e suite. Report the counts.

**D. A fresh-install smoke**, by hand or by a spec if one already covers it: point the app
at an empty state, confirm it boots with four agents and no models, that every agent shows
as unrunnable, that the Settings dialog's count line says all four, and that adding one
server with one model and assigning it makes that agent sendable. This is D7's "the refusal
is reachable in normal use, not only after damage" — the state a first-time user actually
meets, and the one the whole lot exists to make work.

## Files

Whatever the sweep proves wrong. Expect small fixes across the layers, not new features; if
a fix turns out to be large, stop and report it rather than growing this task.

## Rules it must not break

- Everything in the big picture's "Invariants" section — this task is the last place that
  can catch a violation.
- **`AGENTS.md`**: "Tests stay hermetic." A fix added here gets a test in the same style as
  the ones it touches.
- **`AGENTS.md`**: "`tests/test_write_surface_isolation.py` asserts that instead of trusting
  this sentence." If a leftover fix touches a route, re-run that test and extend it if the
  route's shape changed.
- Do not add a feature the spec put out of scope (§6): no reordering, no per-workspace
  override, no import of the old files, no settings history, no task-runner agent.

## Depends on

All of 01–14.

## Done when

- Every §7 item has a named proof in the answer.
- Every grep in part B is clean or its hits are explained as legitimate.
- All three suites pass, and the fresh-install smoke behaves as D7 describes.
- The lot is finished: every `appdb-NN-*.md` file has moved into `done/`.
