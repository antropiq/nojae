# 07 — A new shell starts in its tab's folder

**Read first**: `docs/client-owned-workspace-spec.md` §3.1 (the terminal row), §8's
"Two surfaces cannot simply take a field" (the terminal bullet), §5.1 rule 2, §9's
T5. The big picture's *The mechanism*.

The terminal connection is a persistent socket with no per-request body, so its
workspace is supplied **when the socket opens**. This socket's `sessionStorage` tab
holds a folder, and that folder is the shell's `cwd`; a live session keeps the
folder it was born in, exactly as today.

## Deliver

### 1. The socket carries the field

`web/src/composables/useTerminal.js` opens
`ws(s)://<host>/api/terminal?workspace=…` through `withWorkspace` (task 02 already
wrapped it; verify it, and verify the socket is opened from the session composable's
current value rather than a captured one).

### 2. The server reads it, before anything spawns

`terminal_ws` in `src/api/routes.py`, in the current guard order and **before** the
`hub.create` that reserves a session:

1. Origin check (unchanged),
2. **the workspace**: read the socket's query string, resolve it through the seam;
   a refusal closes the socket with a policy close code and a message carrying the
   seam's sentence — the client shows it in the pane's error line, which
   `useTerminal.js` already does for `{"type": "error"}` frames and for a close with
   a reason;
3. the driver check (unchanged),
4. the concurrent-session cap (unchanged).

Do not take a path from the frame stream and do not add a `cd` affordance: `cd`
inside the shell remains the user's own business (the existing policy docstring's
argument, which stays true).

### 3. The session records its birth folder

`TerminalSession.spawn` sets `self.cwd` from the seam today (task 01). It now
records the folder it was **born in** for the life of the session, and reports it in
its `open` frame and in `GET /api/terminal`'s rows — which it already does, so the
observable behaviour is unchanged for one tab. What changes is that two sessions
born in two workspaces report two `cwd`s and neither moves when the other's tab
re-points.

The `TerminalHub` (one registry, one cap) keeps being one registry: sessions are
not per workspace, and the cap stays the app's (spec §3.1: "the registry is shared").
Do not key the hub by workspace and do not add a per-workspace cap.

### 4. What a tab's folder change does *not* do

It does not re-root a live shell, kill it, or relaunch it. A live shell keeps its
folder; a **new** shell (the pane's own reconnect, or a fresh mount) starts in the
tab's current folder. Say so in the pane's docstring, so the next reader does not
"fix" it.

### 5. Tests

- `tests/test_terminal.py` (and the ConPTY half where it asserts the same) — a
  socket opened naming folder A spawns a shell whose `cwd` is A; one naming B spawns
  B's; both live at once.
- A refused folder closes with the seam's sentence and spawns **no** process (the
  cap and the registry are unchanged by the refusal — assert both).
- A live session's `cwd` does not change when a later socket names another folder.
- `GET /api/terminal` reports each session's own `cwd`.
- Client: `web/tests/` — the socket URL carries the tab's folder, and a folder
  change reconnects on the next open but never moves an open shell.

## Files

- `src/api/routes.py` — `terminal_ws`'s guard order and the workspace
- `src/core/termhub/session.py` — the birth folder
- `src/core/termhub/manager.py` — only if `list_sessions` needs the field (it
  already reports `cwd`)
- `src/core/termhub/policy.py`, `__init__.py` — docstrings that say the server takes
  no path from the client (still true, but the sentence now says where the folder
  *does* come from)
- `web/src/composables/useTerminal.js`, `web/src/components/EditorTerminal.vue` —
  the URL through `withWorkspace`, and the docstring about a live shell
- `tests/test_terminal.py`, `tests/test_terminal_conpty.py`, web terminal tests

## Rules it must not break

- *"core/termhub/ — one shell per WebSocket, on the platform's pseudo-terminal."*
  Still one per socket; the hub is still one registry with one cap.
- *"The terminal is a human surface, never an agent tool."* Nothing here makes it
  reachable from a tool, and *"`tests/test_write_surface_isolation.py`"* keeps
  asserting the route is a WebSocket and not a tool.
- *"Teardown kills process trees, not wrappers"* — unchanged; a session's teardown is
  the shared entry point.
- *"Every write surface is the browser's alone"* — the terminal stays a human
  surface and the file routes keep their own gate.
- *"A refusal names the folder and the rule that fired"* (spec §5.2 rule 11) — the
  socket's close message carries the seam's one sentence, not a fresh one.
- *"Tests stay hermetic"* — every folder named is under `tmp_path`; the suite's
  driver checks and cap keep a real shell out of the way where they already do.
- **Do not re-root or restart a live shell.**

## Depends on

Tasks 01, 02 and 04.

## Done when

- Two sockets naming two `tmp_path` folders spawn two shells with those two `cwd`s,
  and both report their own in `GET /api/terminal`.
- A socket naming a refused folder closes with the seam's sentence and spawns
  nothing.
- A live shell's `cwd` never changes when another socket names another folder.
- The pane's docstring says a live shell keeps the folder it was born in.
- `pytest` and `cd web && npm test` are green. The e2e suite is **not** run.

Finish by moving this file into `todos/done/`.
