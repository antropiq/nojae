# 14 — The acceptance sweep

**Read first**: `docs/client-owned-workspace-spec.md` §10 in full, then §5 (every
rule), §6 and §4.2. This task exists because §10 is written as behaviour a person can
perform, and behaviour that only a person can perform is behaviour that rots. Every
item that **can** be asserted is asserted here; the two that need two real models are
named and left to the checklist task 13 wrote.

## Deliver

A new `tests/test_workspace_acceptance.py` — one class per §10 item, one case per
assertion, each case's docstring quoting the item it proves. Two `tmp_path` folders
throughout, and the temporary store the suite already owns.

### Item 1 — two folders, one process

Two `TestClient` requests, each naming its own folder, answered about itself: the
tree lists A's files for A and B's for B. No environment write anywhere.

### Item 2 — two agents, two models

Two workspaces, two agents with two different models on two different stub servers —
the suite's existing stubbed `stream_chat` shape, so no real endpoint is reached.
Both requests stream; each carries its own `agentMode`, its own model id, and each
turn's tool-visible folder is its own (assert through the seam's `current_root()`
inside the turn, or through a tool executor the test supplies, whichever the existing
chat test shape makes honest).

### Item 3 — the write, per folder

While both stream, a save in B succeeds and the same save in A is refused naming A.
The task 04 case, restated as the acceptance item.

### Item 4 — Pause

Pause against A stops A only; B closes on its own `done`. Task 10's case, restated.

### Item 5 — the tree and the connectors

A's tree lists A's files under A's rules and B's lists B's (with two different policy
files, so the rules are visibly different); A's connector, declared only in A,
is offered in A and not in B.

### Items 6 and 10 — a batch and a closed tab

A batch in A while a conversation runs in B: both progress; and closing a tab
mid-reply cancels its own turn only. Both already exist in the suites tasks 09 and 10
built — this task **imports their cases or restates them here**, whichever keeps one
home for each assertion. If a case already exists, do not duplicate it: name it in
the new file's docstring as the home of that item.

### Items 7, 8 and 9 — reload, a peer tab, a new tab

These are browser facts, so their *server* halves are asserted here and their browser
halves are task 12's:

- the tab's state is per tab: nothing on the server remembers which tab is where, so
  two identical requests are answered identically and the answer depends only on the
  field;
- a third tab naming A gets A's answers with its own agent (a second request with a
  different `agentMode` and A's field);
- a request naming nothing is refused by the seam's sentence — which is the server
  half of "a new tab lands on the installation folder and the user points it".

### Item 11 — the catalogue, once

The agent list, the model list and the helper bullets are byte-identical before and
after two requests naming two folders, and neither response carries a `workspace`
field. The invariant from the big picture, as the acceptance item.

### The invariant sweep

One case per invariant that would otherwise be prose, scanned from the source the way
`tests/test_write_surface_isolation.py` does it:

- no route under the installation-scoped prefixes takes the field
  (`/api/config`, `/api/servers*`, `/api/models*`, `/api/agents*`,
  `/api/prompt-helpers*`) — a param added to one of them fails this case;
- every route under the workspace-scoped prefixes takes it (the task 10 list, kept
  here as the place it is enumerated);
- no module under `src` names `path_location` (task 10's guard, restated as the
  acceptance sweep's own entry so the file stands alone);
- `sessionStorage`, not `localStorage`, holds the tab's two keys (a client-source
  scan, the shape `web/tests/agentModes.test.js` already uses for its own rules);
- `web/src` spells `workspace=` nowhere but the session composable.

### The two the human runs

State them at the top of the file, in a comment: two replies streaming on two real
models with each tool answer naming its own folder, and Pause in A stopping A only,
are the checklist's items — `docs/client-owned-workspace-smoke-checklist.md`, written
by task 13. The file must not pretend to cover them.

## Files

- `tests/test_workspace_acceptance.py` (new)
- `tests/conftest.py` — only if the sweep needs a fixture the harness does not yet
  have; prefer reusing `workspace_params`

## Rules it must not break

- *"Tests stay hermetic: no test reads a real model connection, reaches a live hub or
  opens the install's settings store — the hubs are disabled by an environment flag
  and each test runs on a temporary store of its own."* Every case here obeys it: the
  stub stream, the disable flags, the temporary store.
- *"`tests/test_write_surface_isolation.py` asserts"* its invariants instead of
  trusting a sentence — this file follows that habit for its own invariants, and
  **does not weaken or duplicate** the existing file's assertions.
- *"Core owns logic, the API owns transport."* A case that has to reach a core surface
  directly runs inside `workspace.scope(root)`; a case that goes through a route names
  the field. No case mixes the two to get around a refusal.
- *"A test that exists to enforce an invariant is worth naming as a pointer."* Each
  scan case says in its docstring which invariant it holds.
- No new dependency, no new fixture framework, no test that needs a browser: the
  browser half is task 12's and the human half is the checklist's.

## Depends on

Tasks 01–13.

## Done when

- Every §10 item that can be asserted is, in one file, with the item quoted.
- Items 2 and 4 name the checklist as their home and assert only what a stub can
  honestly show.
- The four invariant scans pass, and each one fails when deliberately poisoned (the
  poison-and-detect pattern the existing guard suite uses).
- No existing suite lost a case: where this file restates one, the older home is
  named in the docstring and the duplication is deliberate, or the case moved.
- `pytest`, `cd web && npm test` and `cd web && npm run test:e2e` are all green.

Finish by moving this file into `todos/done/`.
