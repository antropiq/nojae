# 02 — The tab owns its workspace

**Read first**: the big picture's *The mechanism, stated once* (all of it) and
*Interim states*; then `docs/client-owned-workspace-spec.md` §2 (D4, D9, D11),
§5.1 rules 1–9, §8 in full, §6's "A remembered folder is convenience, not a
guarantee". Task 01's file describes the seam this task builds on.

This task makes the folder belong to the tab, in both directions: the client holds
it per tab and sends it with every workspace-scoped request, and the app bar's
field points *this tab only*. It retires `POST /api/path-location`, which set
process state, and replaces `GET /api/path-location` with `GET /api/workspace`.

**The app must be usable at the end of this task, one tab or two.** That is the
acceptance rule for it: open a second tab, point it at another folder, and both
tabs work.

## Deliver

### 1. `web/src/composables/useWorkspaceSession.js` — the tab's own memory

A calm, house-style composable (`useChatLayout.js` and `useAgentModes.js` are the
shape: a module-level `reactive` state plus plain functions, no component
coupling).

- **Storage is `sessionStorage`, not `localStorage`.** That is the whole
  requirement: a reload keeps the folder, a new tab starts without one, and a
  closed tab forgets it (spec D4, D11). Say so in the module's docstring, and say
  why: `localStorage` is browser-wide, which is exactly the bug being fixed.
- Two keys, one per thing the tab owns: its workspace and (from task 08) its
  agent. Name them in one place, `nojae:*`, beside a comment saying they are
  **tab** state and not configuration — nothing here belongs in the settings store.
- **Tolerant on read**, like the theme and layout keys: a missing key, a cleared
  storage, a private-mode throw and a value that is not a string all mean the same
  thing — no remembered workspace.
- `state` holds the tab's workspace (the canonical text the server answered), the
  text the field is editing, and the same loading/saving/error/note slots the app
  bar reads today. `state.workspace` is the one value every request is built from
  — one value, not two that can drift (spec §5.1 rule 9).
- **`withWorkspace(url)`** — the single place the field's name is spelled. It adds
  the parameter to a URL that already has a query (`?` vs `&` handled), and is the
  only function in `web/src` that writes `workspace=`. Every call site goes through
  it, including the terminal's socket URL and the chat request.
- `setWorkspaceFromField()` — the one gesture. It asks `GET /api/workspace` for the
  typed folder; on success it adopts the server's canonical answer, stores it, and
  lets the caller re-root; on a refusal it shows the server's sentence **and keeps
  the previous folder** — a refusal is an answer, never a silent substitution
  (spec §5.2 rules 10–12).
- `loadWorkspace()` — the boot read: the stored folder if there is one, otherwise
  the installation folder the server reports as `default`. A stored folder that no
  longer resolves is reported through the same error slot and left in place; the
  tab does not repair it silently (spec §6's last bullet).

### 2. The field points this tab alone

- `web/src/components/AppBar.vue` reads and writes the composable above instead of
  the app shell's `pathLocation*` slots. The visible behaviour is unchanged: type,
  press **Set**, the folder moves; the lock explanation stays one line; the
  warning from the policy seed stays a note and never an error.
- `web/src/composables/useAppShell.js` drops the `pathLocation*` slots and
  `loadPathLocation` / `setPathLocation`, and keeps only what the app bar still
  needs about the *policy note* the switch reports. Its `setPathLocation` also
  re-rooted the tree and closed the editor's tabs of the root being left — that
  behaviour **moves** to the new composable's owner (the app bar calls it), it is
  not dropped: moving a tab's workspace still invalidates what is genuinely
  workspace-scoped, and never the settings store (spec §4.2's closing rule).
- The address bar is never touched. Add the short comment that says so, because
  the next reader will wonder where the folder went (spec D9).

### 3. Every workspace-scoped call names it

Mechanical, one line per site, and the point of the whole task: `withWorkspace`
wraps the URL at every existing call site of a workspace-scoped route. The list is
the big picture's: `/api/fs/*`, `/api/batch/*`, `/api/workspace`, `/api/chat`,
`/api/chat/pause`, and the terminal socket — plus `/api/mcp*`, `/api/lsp*`,
`/api/lsp/query`, `/api/lsp/log` even though those routes are only *made*
per-workspace by tasks 05–06: sending the field now means those tasks have no
client-side work to do.

Sites live in the tree/editor/search/quick-open/git composables, `useChat.js`,
`useBatch.js`, `useTerminal.js`, `useEditorLsp.js`, the editor's file and rename
composables, and the app shell's settings loads. Do not add a wrapper to the
installation-scoped calls (`/api/config`, `/api/servers*`, `/api/models*`,
`/api/agents*`, `/api/prompt-helpers*`) — the catalogue is the installation's and a
tab's folder must not travel with it.

### 4. The chat turn is about this tab's workspace

`useChat.js`'s `startTurn` opens the request through `withWorkspace`. That is the
whole change: the server already answers the system prompt's project-instructions
block from the request's workspace, because task 01 pointed
`config.agent_instructions_block` at the seam. Add a unit case pinning that a
request posted from a tab carries its folder, and that two tabs' requests carry
theirs.

The stream's own behaviour is untouched: same body, same SSE, same
cancellation-on-disconnect (spec D10). A reply the user paused still ends on its
`pause_ack` and keeps its partial turn.

### 5. The server side of the switch: one route in, one route out

In `src/api/routes.py`:

- **Delete `POST /api/path-location`** and its request model. Nothing sets the
  process's folder any more. The seeds it performed belong to the pool's admission
  (task 05); until then the installation folder is seeded at boot as it is today,
  and a foreign folder gets its `.nojae` in task 05.
- **Delete `GET /api/path-location`.** `GET /api/workspace` (task 01) is the read,
  and it must now report the **seeded-or-not** state of the requested folder
  without writing anything — the four reserved-folder blocks are read-only reports
  and stay read-only.
- The reserved-folder blocks, the policy block and the project-instructions
  lookup all answer about `require_workspace(request)`, not the process default.
- `web/src/lib/path-location-policy.js` keeps its wording; only the payload's
  route changes. A refusal sentence reaches the app bar verbatim.

### 6. Tests

- `tests/test_api.py` — the `TestPathLocationEndpoint` class is **replaced**: the
  cases that pinned the POST's validation (missing, relative, absent, deny-listed,
  the fold, the symlink canonicalisation) move onto `GET /api/workspace`'s field,
  keeping every assertion they can; the ones about restarts and environment
  mutation are deleted with the route (their subject moved to the pool, task 05).
- New cases: two different folders named in two requests, each answered about
  itself, with no environment set between them and **no ordering** — the second
  request must answer about its own folder whether or not the first ran.
- `web/tests/`: a new `useWorkspaceSession.test.js` (storage is `sessionStorage`;
  a missing value means the server's default; a refusal keeps the old folder;
  `withWorkspace` builds `?` and `&` correctly and is the only speller), and the
  existing app-bar/switch suites updated to the composable. `useWorkspaceSwitch`,
  `appBarConnectionOnSwitch`, `useWorkspaceTreeCommands` and `useEditorWrite*`
  suites build their URLs through `withWorkspace` now — update their stubs, keep
  their assertions.

## Files

- `web/src/composables/useWorkspaceSession.js` (new)
- `web/src/composables/useAppShell.js`, `useChat.js`, `useBatch.js`,
  `useTerminal.js`, `useEditorLsp.js`, `useEditorFiles.js`, `useEditorMove.js`,
  `useEditorCreate.js`, `useEditorRename.js`, `useWorkspaceTree.js`,
  `useWorkspaceSearch.js`, `useQuickOpen.js`, `useGitStatus.js`
- `web/src/components/AppBar.vue`
- `web/src/App.vue` — the boot read
- `src/api/routes.py` — the two routes, the blocks read through the workspace
- `tests/test_api.py`, `tests/test_workspace_seam.py` (the `GET /api/workspace`
  cases the route change touches)
- `web/tests/useWorkspaceSession.test.js` (new), and the suites the URL change
  invalidates

## Rules it must not break

- *"Every write surface is the browser's alone … and the file ones are refused
  while a chat reply streams."* This task adds no write and no write route. The
  write refusal becomes per workspace in task 04; until then it keeps its present,
  process-wide behaviour and **no client guard is removed** to compensate.
- *"The address bar stays free of it"* (spec D9) — the composable never writes a
  URL, a query string, a hash or `history.replaceState`. Two tabs on the same
  address are the point.
- *"No server-side memory, no browser-wide memory"* (spec §8) — `sessionStorage`
  only; `localStorage` gains no workspace key, and the server keeps nothing about
  which tab is where between requests.
- *"A refusal is an answer, never a silent substitution"* (spec §5.2 rule 12) — a
  refused folder leaves the previous one in place and says so. No catch-all that
  falls back to the installation folder.
- *"composables/ hold app-shell and stream state and own each live stream and its
  abort; components use them directly."* The new composable is state plus plain
  functions; `AppBar.vue` renders its answers and derives no verdict of its own.
- *"Core owns logic, the API owns transport."* No validation rule is re-spelled in
  the client: the field's refusals are the server's sentences, shown verbatim.
- *"Tests stay hermetic"* — every new test names a `tmp_path` folder through
  `tests/conftest.py`'s `workspace_params`; nothing reads this checkout's `.nojae`.
- **Do not add cross-tab invalidation** (spec D7). No `storage` event listener, no
  broadcast channel: two tabs on one folder are last-write-wins and a stale tree
  until the user refreshes.

## Depends on

Task 01 — the seam, `GET /api/workspace`, and `workspace_params`.

## Done when

- Typing a folder in the app bar and pressing Set moves **this tab** there: the
  tree, the editor's writes, the chat's tools and the terminal all answer about it,
  and a second tab stays where it was.
- A reload returns the tab to its own folder; a **new** tab lands on the
  installation folder, and the address bar is identical in both.
- `grep -r 'workspace=' web/src` finds it only inside
  `useWorkspaceSession.js`. `grep -r 'path-location' web/src src` finds no route
  reference.
- `GET /api/workspace` is the only route the app bar calls for the folder, and
  `POST /api/path-location` no longer exists (a request to it answers 404/405).
- Two `TestClient` requests naming two `tmp_path` folders are answered about
  themselves, in either order, with no environment writes in between.
- `pytest` and `cd web && npm test` are green.
- The e2e suite is **not** run: it reads `/api/path-location` and is rewritten once
  in task 12.

Finish by moving this file into `todos/done/`.
