# 04 — The write surfaces, and a refusal that names the workspace

**Read first**: `docs/client-owned-workspace-spec.md` §3.1 (the "reply is streaming"
row and the second consequence), §5.3 rules 13–15, §5.4 rule 20, §5.6 rule 29, §9's
T3 and T8's first half. The big picture's *Interim states* (the paragraph on one
reply at a time).

Two things land here: every write answers about the request's folder, and the "a
chat reply is streaming" refusal stops being a fact about the process and becomes a
fact about the workspace it names. From the end of this task two replies can
already stream — the concurrency is *proven* in task 10.

## Deliver

### 1. The write routes take the field, and keep every rule they have

`PUT /api/fs/file`, `POST /api/fs/create`, `DELETE /api/fs/file`,
`POST /api/fs/rename`, `POST /api/fs/move-batch` — each calls
`require_workspace(request)` before anything else, then behaves exactly as it does
now: the write gate over the leaf and every ancestor, the `mtime` guard with its
object `detail`, the size caps, the pre-save backup, the atomic replace, the trash
batch and the all-or-nothing subtree check. No rule moves, no refusal sentence is
re-worded.

### 2. The trash and backup paths are the workspace's

- A delete files into **that** workspace's reserved folder, and the sweep at boot
  keeps sweeping the ones it sweeps today. `editorfs.mutate.trash_dir()` already
  builds its path per call from the root; it now builds it from the scope.
- A save's pre-save copy stays in the installation's backup directory (it is the
  app's own journal, not the workspace's), and its key is the resolved file path,
  so two workspaces never share a chain. Confirm that with a case: a save in A and
  a save in B of files with the same relative path produce two chains.
- The reserved-folder readers (`policy`, `mcpSettings`, `lspSettings`,
  `lspSettingsTemplate` in `GET /api/workspace`) answer about the requested
  workspace and still write nothing.

### 3. The in-flight reply slot becomes one per workspace

This is the change with the most consequence, so state it plainly in the code.

- Replace the single `_CHAT_HANDLE` with a map keyed by the workspace's canonical
  root. `POST /api/chat` arms its own key; the SSE generator's `finally` clears the
  same key, and only if the entry is still *its* reply (the existing
  "a newer conversation must never be un-registered by an old stream's `finally`"
  rule, per key).
- `_refuse_if_chat_streaming` answers about **one** workspace: the one the request
  names. A save in B while A streams succeeds. A save in A while A streams is
  refused, with the same sentence as today plus the workspace it is about —
  rule 14's protection, kept with the workspace as its subject.
- `_CHAT_TASKS` becomes the same shape: the set of live pumps *with their
  workspace*, so the hub-restart routes and the diagnostic checks ask "is a reply
  streaming on this workspace" instead of "is any reply streaming anywhere".
  `POST /api/mcp/restart`, `POST /api/lsp/restart` and the workspace validation ask
  the per-workspace question. Until tasks 05–06 put the hubs per workspace, those
  two routes keep restarting the one hub they have — but their gate is now the
  workspace's, which is what tasks 05 and 06 will rely on.
- **Nothing serialises turns across workspaces** (spec §5.3 rule 16). Do not add a
  lock, a queue or a "one reply at a time" guard anywhere. The only reason
  concurrency is not *proven* until task 10 is that Pause still has one target
  until then; the streaming itself is already parallel.

### 4. The client's guard says what the server says

`web/src/composables/useEditorMode.js` decides whether the pane is editable. Its
input is the chat's phase, which is a per-tab fact on the client — so it is already
correct: this tab's reply locks this tab's pane and nothing else. Verify it and add
the case, because it is the client half of rule 13 and the one place a client-side
regression would undo the server's per-workspace refusal. Change nothing about the
wording of its badge.

`web/src/composables/useEditorFiles.js` and the other write composables already
post through `withWorkspace` (task 02). Their refusals render the server's sentence,
so a 409 from A's reply and a 200 from B's save need no client branch.

### 5. Tests

- Two workspaces, two saves: one succeeds while the other is refused, in a single
  process, with no ordering requirement.
- The refusal names its workspace, and the *other* workspace's identical save
  answers 200 — the case that would have passed by accident before this task.
- A create, a rename, a delete, a move-batch and a save each answer about the
  folder named, with the folder's own policy in force: an `ro` rule in A refuses
  A's write and does not refuse B's identical path.
- Two workspaces' trash batches are two folders; two saves of one relative path
  leave two backup chains.
- `tests/test_write_surface_isolation.py` stays green untouched: this task adds no
  write surface and no tool.

## Files

- `src/api/routes.py` — the five write routes, `_CHAT_HANDLE`/`_CHAT_TASKS` and the
  guards around them, the reserved-folder blocks
- `src/core/editorfs/mutate.py` (the trash path per scope), `files.py` (the backup
  key's root, if it reads one)
- `tests/test_editorfs_write.py` — repointed at the field; the two-workspace cases
- `tests/test_api.py` — the per-workspace refusal cases
- `tests/test_batch.py` — only if its fixture pinned the refusal (batch's own
  per-workspace rules are task 09)
- `web/tests/useEditorMode.test.js`, `useEditorWrite*` — the client guard cases

## Rules it must not break

- *"Every write surface is the browser's alone — the Editor's file routes and the
  settings-store routes — and the file ones are refused while a chat reply
  streams."* Kept verbatim, with the workspace as the subject: a reply streaming
  against **that** workspace refuses writes to it, whoever asks (spec §5.3 rules 13
  and 14).
- *"No write destroys bytes: a save backs up what it replaces, a delete moves the
  file into a dated batch."* Per workspace, and unchanged.
- *"Tools are read-only by design"* — `tests/test_write_surface_isolation.py`
  asserts that no connector, tool or chat path reaches a write route. Nothing here
  adds one; a chat *tool call* still cannot reach any of these five routes.
- *"A hidden path is indistinguishable from an absent one to a reader and named to
  a writer; a read-only path is searchable but named to a writer."* Unchanged, and
  now measured per workspace's policy file.
- *"Core owns logic, the API owns transport."* The per-workspace reply bookkeeping
  is transport state and stays in `routes.py`; the trash and backup paths are core
  and stay in `core/editorfs`.
- *"Tests stay hermetic"* — the two workspaces are two `tmp_path` folders; no test
  opens the install's trash or its backups.
- **Do not add cross-tab invalidation** and **do not serialise turns.**

## Depends on

Tasks 01, 02 and 03.

## Done when

- While a reply streams in workspace A, a save in B succeeds and a save in A is
  refused, in the same process, and the refusal names A.
- A create, rename, delete and move-batch each answer about the folder named, and
  A's `ro` rule refuses A's write without touching B's.
- Two workspaces' deletes land in two different trash batches; two saves of one
  relative path leave two backup chains.
- `POST /api/mcp/restart` and `POST /api/lsp/restart` refuse only when the request's
  own workspace is streaming.
- No new lock, queue or serialisation exists between two workspaces' turns
  (`grep` finds none added).
- `pytest` and `cd web && npm test` are green. The e2e suite is **not** run.

Finish by moving this file into `todos/done/`.
