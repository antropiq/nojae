# Lot: client-owned working location

**The spec is `docs/client-owned-workspace-spec.md`. It is binding**: every
question it raised is closed (§2), its §5 is the behaviour, its §8 is the
mechanism. Read the sections your task cites before you write anything. This
file is the map and the place where this lot's own decisions are written down, so
no task has to re-derive them.

Lot prefix: `clws-`. Tasks run in the order of the table at the bottom.

## What we end with

The open browser tab — not the server process — decides which folder it works on.
Two tabs on the same address work on two folders at once, each answering as its
own agent, therefore on its own model and endpoint, while every tab draws its
agents, models, servers and prompt-helper bullets from the same installation.

The five behaviours a user can see (spec §1):

1. Two tabs, two folders.
2. Each tab answers as its own agent; moving the agent in one moves nothing in the other.
3. Neither tab obstructs the other: no frozen editor, no refused save, no re-rooting.
4. A conversation in one tab and a batch in another run at the same time. So do two conversations.
5. The catalogue is configured once and offered in both tabs.

## The mechanism, stated once

Every task depends on this, so it is fixed here.

### The workspace is a field of every workspace-scoped request

- The field's name is **`workspace`** and its value is the folder, absolute, as
  the tab holds it. It rides as a **query parameter** — `GET /api/fs/tree?workspace=…`,
  `POST /api/chat?workspace=…`, `DELETE /api/fs/file?workspace=…&path=…` — and
  for the terminal WebSocket as the socket's query string,
  `/api/terminal?workspace=…`. Nothing else carries it: not the request body of a
  route that has one, not a header, not the address bar, not a route prefix
  (spec D9). One name, one place to look.
- It is a query parameter *everywhere*, including the routes that take a body, so
  the client has one helper and the server has one reader. A path in a header
  would be mangled for a folder whose name is not latin-1; a query string is
  percent-encoded by the same rules as every other parameter.
- **Workspace-scoped routes** carry it: everything under `/api/fs`, `/api/batch`,
  `/api/workspace`, plus `/api/chat`, `/api/chat/pause`, `/api/terminal`,
  `/api/mcp`, `/api/mcp/restart`, `/api/lsp`, `/api/lsp/restart`, `/api/lsp/query`,
  `/api/lsp/log`.
- **Installation-scoped routes never carry it**: `/api/health`, `/api/config`,
  `/api/servers*`, `/api/models*`, `/api/agents*`, `/api/prompt-helpers*`. The
  catalogue is the installation's (spec D2, §4.2) and must answer even while a
  tab's folder has gone away. This is an invariant with a test, not a convention.
- An invalid value — missing, not absolute, not a folder, on the restricted-roots
  deny-list — is refused by **one** sentence builder, so the same wrong folder is
  described the same way wherever it is asked about (spec §5.2 rule 10). No
  surface falls back to a different folder (rule 12).

### The seam: `src/core/workspace.py`

One new core module owns what a workspace *is*:

- `Workspace` — a resolved folder: its canonical absolute root, and nothing else.
- `resolve(raw)` — validate, canonicalise (`realpath`, `~` expanded), answer
  `(Workspace, None)` or `(None, sentence)`. Shape, existence and the
  restricted-roots deny-list live here; the per-path read/write verdicts stay in
  `core/editorfs`.
- `installation()` — the install directory (`config.PROJECT_ROOT`). This is the
  folder a new tab lands on (spec D4), and the folder `is_self_workspace()`
  compares a workspace against (spec §5.6 rule 30).
- `current_root()` / `scope(root)` — the request-scoped workspace. The API
  resolves the field once per request and enters the scope for that request; every
  path-resolving surface under `src/core` reads `current_root()` instead of
  `config.path_location()`. There is **no** default scope: reading it outside a
  scope is an error, never the installation folder (spec §5.2 rule 12).
- `provided_env_values()` gains `NOJAE_PATH_LOCATION` = the scope's root, so the
  placeholder in a workspace's declaration files expands to *that* workspace
  (spec §4.3). `${PROJECT_ROOT}` keeps meaning the installation.

### The API's one reader

`src/api/routes.py` gets **one** router-level dependency that reads the field,
resolves it, keeps the answer on `request.state`, and enters/clears the scope for
the request. One helper, `require_workspace(request)`, raises the refusal as a 422;
**workspace-scoped routes call it, installation-scoped routes never do**. No route
spells the parameter or the refusal itself.

### The pool: one set of tools per workspace

`src/core/hubpool.py` holds, per canonical folder, that workspace's own MCP
connector manager and language-server manager — a hub is bound to a folder at
birth, so two folders take one of each (spec §3.1, §4.3). The app holds the **pool**
as the long-lived singleton; a pool entry's hubs are rebuilt inside it and the
object the app holds is never replaced (`AGENTS.md`, "Hubs are long-lived
singletons"). The pool carries the ceiling, the idle rule, the veto and the
one-sentence answer when the ceiling is reached (spec §4.4, §5.4 rules 22–24).

### The tab's own memory: `web/src/composables/useWorkspaceSession.js`

- The tab's workspace and the tab's agent live in **`sessionStorage`** — per tab,
  kept across a reload, gone with the tab (spec D4, D11, §8).
- One exported `withWorkspace(url)` adds the parameter to a request URL. **No call
  site spells `workspace=`**, so the name cannot drift and a new call cannot
  forget it.
- The address bar is never touched: two tabs on the same address may be on two
  folders (spec D9).

## The three scopes, and what belongs to each

| Scope | Contents | Lifetime |
|---|---|---|
| **Installation** | servers, models, agents, prompt-helper bullets, technical keys, the settings store | the install; every tab |
| **Workspace** | the folder's reserved declarations, its read/write policy, its project instructions, its connectors, its language servers, its cached tree/search answers | while at least one tab is on it, and not longer |
| **Tab** | open buffers, tree expansion, scroll, transcript, active tab, **its workspace**, **its agent** | the tab |

A folder is *admitted* to the pool the first time a request in this process names
it; admission is the one-off moment that seeds the reserved folder (spec's old
boot + folder-switch pair), so a repeated read never writes.

## What this retires

- the process-wide working location, `NOJAE_PATH_LOCATION` as a *value the server
  reads* — after task 10 the name survives only as the placeholder in a
  workspace's declaration files;
- `POST /api/path-location`, which sets process state, replaced by
  `GET /api/workspace` (a read: it validates and reports, and writes nothing);
- the single in-flight reply slot and the process-wide "a reply is streaming"
  refusal — both become facts about a workspace;
- the browser-wide remembered agent.

## Invariants that hold in EVERY task, including the intermediate ones

Quoted from this project's instructions (`AGENTS.md`); a task that breaks one is
not done.

- **"Core owns logic, the API owns transport."** And: "nothing under `core` may
  import the API layer". The seam, the pool and every hub live under `src/core`
  and take plain arguments; `src/api` resolves requests and turns errors into
  statuses. A core module that imports FastAPI is a defect.
- **"core functions never touch FastAPI — they take an injected `emit(event: dict)` callable and report progress through it."** Nothing this lot adds changes that shape.
- **"Hubs are long-lived singletons. A restart rebuilds a hub's internals but never replaces the object the app holds, because worker threads keep the reference across a request."** Applied one level up: the app holds the **pool**; a workspace's hubs are rebuilt inside the pool and the pool object never changes.
- **"Every path the app holds is relative to it, so moving it invalidates what is genuinely workspace-scoped — hubs, policy, cached views, unsaved work reported rather than dropped — and never the settings store, which is the install's."** Read one level up: moving *a tab's* workspace invalidates that workspace's things and nothing of the installation's.
- **"Path rules come from two levels, one verdict: the strictest match wins. The app's own rules apply only while the working location is the app's directory."** With a set of workspaces this is a **per-workspace** comparison: a tab rooted at the install directory is stricter than a tab rooted elsewhere (spec §5.6 rule 30).
- **"Every write surface is the browser's alone — the Editor's file routes and the settings-store routes — and the file ones are refused while a chat reply streams."** Kept, with the workspace as the subject of the refusal: refused while a reply streams **on that workspace** (spec §5.3 rule 14).
- **"A lot runs every task in one mode, pinned at launch"** — and in one workspace, pinned from the tab that started it (spec §5.7 rules 32–35).
- **"The project-instructions file is injected into every chat turn and re-read per request."** The workspace the request names, never another tab's (spec §5.6 rule 31).
- **"The declaration files are the only source of truth for what runs. Their `enable` flag is the switch; their secrets never leave the server. A value may reference an environment variable so one declaration works on every machine; an unresolved name is kept verbatim with a note, never blanked."** A declaration read is always a read *of one workspace*, in that workspace's scope.
- **"Tools are read-only by design."** This lot adds no tool and no write path. `tests/test_write_surface_isolation.py` stays green, and it is the test that says so.
- **"Teardown kills process trees, not wrappers"** — a pool entry that is let go is torn down through the same `proctree` entry point the hubs use today.
- **"SSE is the UI's only source of truth … Each stream has its own channel and closes with exactly one terminal event; a reply the user paused still ends on its own ack, keeping its partial turn."** The chat stream keeps its shape; only *which* workspace it is about and *which* tab may pause it change.
- **"composables/ hold app-shell and stream state and own each live stream and its abort; components use them directly."** The new session composable is a composable, not a store the components reach around.
- **"`lib/` holds the single markdown renderer — all rendered HTML goes through it, never raw `v-html`."** Nothing this lot adds renders HTML.
- **"Tests stay hermetic: no test reads a real model connection, reaches a live hub or opens the install's settings store — the hubs are disabled by an environment flag and each test runs on a temporary store of its own."** Every new test names a `tmp_path` folder as its workspace and never the checkout it runs in. `tests/conftest.py` gains the helper that builds that field (`workspace_params`), and a test that names the installation folder as a workspace is a test that has escaped its sandbox.

## Interim states, and the one accepted red

- **Suite state per task.** `pytest` and `cd web && npm test` are **green at the end
  of every task** — each task updates the unit tests its change invalidates in the
  same change. Read the README for the commands; do not invent them.
- **The interim environment fallback.** Task 01 lands the seam while a request that
  names no workspace still answers from `NOJAE_PATH_LOCATION`
  (`workspace.WORKSPACE_ENV_FALLBACK`). That is the only thing that keeps one tab
  behaving exactly as today during the move. Every task that moves a surface makes
  *its own* routes require the field; **task 10 deletes the fallback and the
  accessor behind it**, and the guard test's allowance with them. No task between
  02 and 10 may widen the fallback, add a second site for it, or read
  `config.path_location()` from anywhere but the seam.
- **Seeding is admitted late.** The installation folder is still seeded at boot.
  Another folder is seeded when the pool admits it (task 05). Between tasks 02 and
  04 a tab pointed at a brand-new folder therefore has no `.nojae` folder of its
  own yet — the Editor and the conversation work, its declarations and its policy
  file are absent until 05. Do not paper over it: the compartment is filled in 05.
- **The e2e suite is red from task 02 until task 12, by design.**
  `web/e2e/01-app-boot.spec.js`, `02-editor-write.spec.js`,
  `03-workspace-switch.spec.js`, `06-tree-search.spec.js`,
  `07-quick-open.spec.js` and `08-editor-lsp.spec.js` all read or set the working
  location through `/api/path-location`, which task 02 replaces. It is rewritten
  **once**, in task 12, after the interface has settled — not piecemeal, and no
  task between 02 and 11 may keep a compatibility route alive for it. Tasks 02–11
  therefore do not run it, and say so.
- **One reply at a time is over before it is proven.** Task 04 keys the in-flight
  slot by workspace, which already lets two replies stream. Task 10 is where the
  concurrency becomes a stated, tested contract (Pause reaches this tab's reply
  only, a closed tab cancels its own turn and nobody else's). Do not add a
  serialisation guard between 04 and 10, and do not leave one behind.

## Two things a task must not do

- **Do not add cross-tab invalidation.** A folder created or deleted on disk stays
  invisible in the other tab until the user refreshes (spec D7). No broadcast
  channel, no storage event, no polling.
- **Do not invent a second instance, a second address, a route prefix, a URL
  scheme or a bookmark per workspace** (spec D9, §6). If a task finds itself
  wanting one, it has misread the mechanism above.

## Task order

| # | task | lands |
|---|---|---|
| 01 | the seam, and the route that reports a workspace | `src/core/workspace.py`, every `src/core` read off `path_location()`, the API's one resolver, `GET /api/workspace`, the guard test, the test harness helper |
| 02 | the tab's own workspace | `useWorkspaceSession.js`, the app bar's field, the chat and pause requests naming it, the policy and instruction blocks per workspace, `POST /api/path-location` deleted |
| 03 | the read surfaces | tree, file read, stat, search, quick-open, git status and diff — each answering about the named folder, proven with two folders side by side |
| 04 | the write surfaces, and the refusal per workspace | every `/api/fs` write, the reserved-folder readers, the trash and backup paths, the in-flight slot keyed by workspace, the hub restarts keyed with it |
| 05 | one set of tools per folder | `src/core/hubpool.py`, admission and seeding, MCP *and* LSP per workspace, ceiling, idle rule, veto, the let-go sentence, the placeholder per workspace |
| 06 | the hub routes and panels | `/api/mcp*` and `/api/lsp*` following the request's workspace; A's connectors offered in A and not in B |
| 07 | the terminal | a new shell in its tab's folder; a live shell keeps the folder it was born in |
| 08 | the agent per tab | the remembered agent becomes per tab, and a turn still resolves it once, at start |
| 09 | batch per workspace | listing, prefix dropdown, the agent pinned from the starting tab, refusals keyed per workspace |
| 10 | concurrent turns, and the end of the process-wide folder | two replies at once, Pause per workspace, the closed-tab test, the interim fallback deleted |
| 11 | the interface | one visible workspace per tab, the field's lock scoped to this tab, the restarting line, the ceiling sentence, the entry point and the reload |
| 12 | the e2e specs | the six specs that read or set the location, and the two-tab run |
| 13 | the project's own words | `AGENTS.md` per spec §7, the README, a smoke checklist for the two-tab run |
| 14 | the acceptance sweep | spec §10's eleven items, asserted where they can be |

## Where the spec's names went

The spec's suggested breakdown (§9) is advisory; this table is how this lot maps
onto it, so a reader holding both is not confused by the numbering.

| spec | this lot |
|---|---|
| T1 the seam | 01 |
| T2 read surfaces | 03 (and 02, which makes the tab's workspace real first) |
| T3 write surfaces | 04 |
| T4 per-workspace hubs | 05 (the pool) and 06 (the routes) |
| T5 per-workspace terminal | 07 |
| T6 per-tab agent | 08 |
| T7 batch per workspace | 09 |
| T8 concurrent turns | 04 (the keyed slot) and 10 (the contract) |
| T9 the interface | 02 (the field itself) and 11 (what the tab shows) |
| T10 the project's own words | 13 (and 12 for the e2e half) |

## How a task is finished

Write the change, leave `pytest` and `cd web && npm test` green (each task says
whether the e2e suite is in scope — mostly it is not), and **move your own file
from `todos/` into `todos/done/`**. That move is the only acknowledgement the
runner reads; it never reads the body again. A file left in `todos/` is
relaunched.
