# 09 — Batch mode follows the tab

**Read first**: `docs/client-owned-workspace-spec.md` §2 (D8), §5.7 rules 32–35,
§10 item 6, §9's T7. The big picture's *The mechanism* and the invariants (the lot
runs in one mode **and** one workspace).

A batch run belongs to one workspace: its lot is that folder's lot, listed through
the same path policy as everything else, and its agent is pinned from the tab that
launched it.

## Deliver

### 1. The listing is that folder's

`GET /api/batch/tasks` and `GET /api/batch/prefixes` call
`require_workspace(request)` first; `core/batch.py` already answers about the seam
(task 01), so its three locks, its `..` check, its prefix shape, its numbering and
its caps are all measured against the request's folder. The `dir` parameter stays
relative, exactly as it is — the folder travels in the field, not in `dir`.

### 2. The client's dialog follows the tab

`web/src/composables/useBatch.js` already wraps both calls through `withWorkspace`
(task 02). Verify the consequences and add the cases:

- Opening the dialog in tab A lists A's lot; the prefix dropdown offers A's prefixes;
  a folder B tab offers B's. No list is carried across a folder change — the dialog's
  re-read on open is what keeps a stale lot from being launched.
- A launch in A lists A's lot again (`relistLot`) and a task's `taskLocation` is
  relative to A, so the model's tools open A's file.

### 3. The lot pins its workspace and its agent

`launch()` in `useBatch.js` records the tab's workspace **and** resolves the pinned
agent (`pinLotMode`) once, at launch, and passes both to every task turn. The
workspace rides on the chat request (it already does, task 02); the agent rides as
`agentMode` (it already does). What this task adds is the explicit statement and the
refusals below:

- **A lot's workspace is part of its pin.** A folder change by the user during a run
  does not re-root the running lot: the run keeps the folder it started on, because
  every turn it sends names it. That is the same rule the mode pin already holds
  (`AGENTS.md`: "A lot runs every task in one mode, pinned at launch"), read one
  level wider — say so in `useBatch.js`'s docstring beside the mode pin's own
  sentence.
- **The refusals are keyed per workspace.** "A batch is running" stays a fact about
  a workspace (rule 35): starting a lot in A must not block a lot or a conversation
  in B. `useBatch.js`'s `batchGuard` (which the chat and the hub restarts consult) is
  per tab already, because the composable is per tab — verify it and say so; the
  server-side counterpart is task 10's, and it is already keyed by workspace through
  task 04's `_CHAT_TASKS`.
- **A lot cannot start on a workspace whose tools are not running.** If the pool
  refused the folder (the ceiling), the launch refuses with the pool's sentence
  rather than starting a run whose tools are absent. The dialog shows it in its
  message line.

### 4. The server side keeps listing only

Batch mode still never reads or writes a task body: `core/batch.py` lists, and the
model opens the file with the connectors. Nothing here adds a read, a write or a
route. `tests/test_write_surface_isolation.py` keeps asserting it.

### 5. Tests

- `tests/test_batch.py` — two `tmp_path` folders with two different lots (different
  prefixes, different task counts): each listing answers its own, the prefixes differ,
  and `dir` stays relative in both. A refused folder answers 422 with the seam's
  sentence.
- The lot folder still cannot escape: `..` and an absolute `dir` are refused in a
  workspace that is not the installation, with the same sentences as before.
- `web/tests/batchPrefixDropdown.test.js`, `batchRetries.test.js` and any suite that
  stubs the batch routes — the URL carries the tab's folder; a folder change re-reads
  rather than reusing a list; a launch pins the folder it started on.
- A case proving two tabs' guards are independent (the unit suite simulates the
  second tab by resetting module state, as task 08's does — say so).

## Files

- `src/api/routes.py` — the two batch routes
- `web/src/composables/useBatch.js` — the pin's docstring, the pool-refusal path
- `web/src/components/BatchModeDialog.vue` — only if the refusal line needs the pool's
  sentence rendered; keep the change minimal
- `tests/test_batch.py`
- `web/tests/batchPrefixDropdown.test.js`, `batchRetries.test.js`,
  `web/tests/useWorkspaceSession.test.js` (only if a key is shared)

## Rules it must not break

- *"A lot runs every task in one mode, pinned at launch"* — and in one workspace, for
  the same reason. A change of agent or of folder in any tab afterwards reaches no
  task in the run (spec §5.7 rule 33).
- *"Batch mode lists its lot through the shared path policy but never reads or writes
  its contents — only the connectors do."* Unchanged; no route and no read is added.
- *"A task is finished when its file leaves the lot folder; that move is the agent's
  own acknowledgement, and re-listing is the only way the loop can see it."* The
  re-list is now the workspace's re-list; the rule is unchanged.
- *"Every write surface is the browser's alone … and the file ones are refused while
  a chat reply streams."* A batch's turns are replies on that workspace, so its own
  file writes stay refused for the run's duration — which is the existing behaviour
  and is now the right one per workspace.
- *"Core owns logic, the API owns transport."* The listing rules stay in
  `core/batch.py`; the pin stays a client fact and the thread identity stays in the
  API.
- *"Tests stay hermetic"* — two `tmp_path` folders; no test lists this checkout's
  `todos/`.
- **Do not add cross-tab invalidation** — a lot folder created in another tab becomes
  visible on the next re-read and not before.

## Depends on

Tasks 01–06.

## Done when

- Two workspaces' `GET /api/batch/tasks` and `/api/batch/prefixes` answer about
  themselves, `dir` staying relative, and a refused folder answers 422 with the seam's
  sentence from both routes.
- A launch pins the tab's folder and agent, and a folder change mid-run reaches no
  task.
- A lot in A does not block a lot or a conversation in B.
- A launch on a folder the pool refused answers with the pool's sentence in the
  dialog's message line.
- `pytest` and `cd web && npm test` are green. The e2e suite is **not** run.

Finish by moving this file into `todos/done/`.
