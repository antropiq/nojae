# 10 — Concurrent turns, Pause per workspace, and the end of the process-wide folder

**Read first**: `docs/client-owned-workspace-spec.md` §2 (D6, D10), §3.1 (the
in-flight slot and the streaming refusal rows), §5.3 rules 13–19, §6's "A server
restart ends every tab's stream" and "Closing a tab mid-reply kills that reply",
§9's T8. The big picture's *Interim states* (the two paragraphs on one reply at a
time and the fallback).

Two replies stream at once, each on its own model, and Pause reaches the tab's own
reply. The closed tab's turn is cancelled and nobody else's. And the interim
fallback dies here: no request may answer from a folder it was not given.

## Deliver

### 1. Pause is per workspace

`POST /api/chat/pause` takes the field like every other workspace-scoped request,
calls `require_workspace(request)`, and arms the pause flag of **that workspace's**
in-flight reply. Task 04 already keyed the handles; this task makes the route use
the key.

- No reply streaming on this workspace: 409 saying so, naming nothing else — never
  "no chat reply is streaming" while another tab's reply runs.
- A reply already pausing: the idempotent "pending" answer it gives today.
- One-way, as today: the `pause_ack` puts the app back to idle and the partial turn
  stays.

`web/src/composables/useChat.js`'s `pause()` posts through `withWorkspace` (task
02). Its local-abort fallback stays exactly as it is — it is the path for an
unreachable endpoint, and it is this tab's own controller, so it was never able to
reach another tab.

### 2. Two turns at once, stated and proven

Nothing needs building — task 04 removed the process-wide slot — so this task is the
**contract and its tests**:

- Two `POST /api/chat` requests naming two workspaces, both streaming to completion
  simultaneously, each with the model its own agent resolves to. Assert both streams
  carry their own frames and neither sees the other's.
- A pause on A while B streams: A ends on its `pause_ack` and B completes normally.
- A write refused in A while A streams does not obstruct B (the task 04 case, kept
  here as the regression guard for the whole contract).

The tests drive the two streams through the existing stubbed stream shape — no test
reaches a real endpoint.

### 3. The closed tab (D10)

The behaviour already exists: the SSE generator's `finally` sets the cancel flag when
the client goes away. What this task adds is the proof, since the slot's shape
changed:

- Open a reply on A, disconnect the client, and assert A's turn is cancelled — the
  worker's cancel flag is set and its upstream stream closed — while **B's** reply is
  untouched and completes.
- Assert the same for a client that disconnects between two frames and for one that
  disconnects after the last content chunk but before the terminal frame: the turn is
  cancelled in both, and no work continues for the tab that is gone.
- The partial answer is not stored server-side anywhere (the app keeps no
  conversation state) — assert the server keeps none, which is the honest reading of
  "its partial reply is kept nowhere".

### 4. The interim fallback dies

- `src/core/workspace.py` — `default_workspace()`, `WORKSPACE_ENV_FALLBACK` and the
  fallback branch in `current_root()` are deleted. A core surface reached outside a
  scope raises, as spec §5.2 rule 12 requires.
- `src/config.py` — `path_location()`, `setup_path_location()` and
  `PATH_LOCATION_KEY` are deleted; `default_path_location()` becomes
  `workspace.installation()`, which is the one answer for "the install folder". The
  `NOJAE_PATH_LOCATION` **name** survives in exactly one place: the placeholder that
  `provided_env_values()` answers for a declaration, which is the workspace being
  served (spec §4.3). Say that in one sentence in `config.py`'s remaining docstring
  for that function.
- `src/api/server.py` — the boot no longer calls `setup_path_location()`; it admits
  the installation folder through the pool, which seeds it. Nothing else about the
  boot changes.
- The APP now requires the field on every workspace-scoped route (tasks 02–09 already
  made it read; verify none still tolerates an absent one). `GET /api/workspace`
  without the field is a 422 like any other, and `GET /api/config` still answers
  without one (installation-scoped).
- `tests/conftest.py` — the autouse working-location guard becomes an autouse
  **workspace scope** of a temporary folder, so a core-level test that calls a
  surface directly runs inside a scope and never reads the checkout. Its docstring
  says what it replaced and why the guarantee is the same: no test touches this
  repository's own `.nojae`.
- `tests/test_env_isolation.py` — the case that asserted
  `config.path_location()` is now the guard root becomes the case that asserts
  `workspace.installation()` is the install directory and the autouse folder is not
  it; every other case in the file keeps its subject.
- `tests/test_config.py` — the `setup_path_location` / `path_location` cases are
  deleted with their subjects, and the `provided_env_values` cases move to
  `tests/test_workspace_seam.py` if they are not already there.
- The guard test (task 01) loses its allowance: no module under `src` names
  `path_location` any more, so the scan asserts the name is absent entirely.

### 5. Tests

- The concurrency, Pause and disconnected-client cases above.
- `GET /api/workspace` and every workspace-scoped route answer 422 with the seam's
  sentence when the field is absent — one parameterised case over the route list, so
  a route added later without the field fails it.
- `grep`-shaped assertions: `path_location`, `WORKSPACE_ENV_FALLBACK` and
  `PATH_LOCATION_KEY` appear nowhere under `src` except the placeholder's own
  docstring; the guard test asserts it.
- `NOJAE_DISABLE_MCP` / `NOJAE_DISABLE_LSP` still keep the suite hermetic.

## Files

- `src/api/routes.py` — `post_chat_pause`, and the absent-field refusal on every
  scoped route
- `src/core/workspace.py` — the fallback's removal
- `src/config.py` — the three names' removal, the placeholder's docstring
- `src/api/server.py` — the boot
- `tests/conftest.py`, `tests/test_env_isolation.py`, `tests/test_config.py`,
  `tests/test_workspace_seam.py`, `tests/test_chat.py`, `tests/test_api.py`
- `web/src/composables/useChat.js` — the pause URL (verification)
- `web/tests/` — any suite stubbing `/api/chat/pause`

## Rules it must not break

- *"SSE is the UI's only source of truth … Each stream has its own channel and closes
  with exactly one terminal event; a reply the user paused still ends on its own ack,
  keeping its partial turn."* Both properties hold per stream and per workspace.
- *"The honest signal is whether a real finish marker was ever seen, read after the
  loop is drained. A truncated chat reply ends as an error."* Unchanged — this task
  does not touch `core/chat.py`.
- *"Cost and rate are different numbers: token/s uses completion tokens only, the
  displayed cost is prompt + completion."* Unchanged.
- *"A server restart ends every tab's stream"* (§6) — nothing here hides that; each
  tab reconnects to its own workspace afterwards, which the client already does.
- *"Every write surface is the browser's alone … and the file ones are refused while
  a chat reply streams."* The refusal is per workspace (task 04) and now has the
  concurrency contract beside it.
- *"Nothing under `core` may import the API layer."* Deleting the fallback makes
  this easier, not harder: the seam stays the only reader.
- *"Tests stay hermetic: no test reads a real model connection, reaches a live hub or
  opens the install's settings store."* The concurrency and disconnect cases drive
  the existing stubbed stream; the autouse scope is what keeps a core-level test off
  this checkout.
- **Do not serialise turns**, and **do not persist a partial reply server-side**.

## Depends on

Tasks 01–09.

## Done when

- Two replies stream at once, each on its own model, neither disturbed by the other.
- `POST /api/chat/pause` reaches this workspace's reply only, and 409s when this
  workspace has none — even while another tab is streaming.
- A disconnected client cancels its own turn and leaves the other's running.
- No workspace-scoped route answers without the field; each answers 422 with the
  seam's one sentence.
- `path_location()`, `setup_path_location()`, `PATH_LOCATION_KEY` and
  `WORKSPACE_ENV_FALLBACK` are gone; `NOJAE_PATH_LOCATION` survives only as the
  per-workspace placeholder.
- `pytest` and `cd web && npm test` are green. The e2e suite is **not** run.

Finish by moving this file into `todos/done/`.
