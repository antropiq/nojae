# AGENTS.md — nojae

## What it is

A self-hosted FastAPI + Vue 3 app where a coding agent works on a real checkout:
a streaming chat with the configured model, an editor over the same folder, all
live over Server-Sent Events. Desktop browsers only.

## Rules

- This file states **what the app is and how its pieces fit**, not how to build
  it. It is injected into every agent turn, so every line is paid for there.
- No **machine-specific setup**: no virtualenv manager, package-manager or
  browser-install commands, no ports or paths tied to one machine. That differs
  between machines and belongs in the README.
- No **code details that move**: no line numbers, quoted code, exhaustive route
  or member lists, counts or version numbers. The code and its tests are the
  source of truth for those.
- A **big-picture view only**: what each part is and which invariants hold.
  Feature-by-feature detail belongs in the README, route-level detail in the
  code and its doc comments.
- Keep it **short and current** — the shorter it is, the more of it a model
  actually holds. When the code a paragraph described changes, shrink or cut the
  paragraph instead of appending a newer one beside it.

Setup, run and test commands live in the README, never here.

## Shape of the app

The tabs share one settings store and one streaming layer:

- **WorkBench** — interactive streaming chat with the configured model,
  optionally augmented with MCP connectors and language servers, plus a batch
  mode that works through a folder of task files.
- **Editor** — the tab's folder as a file tree, a code pane and a terminal, all
  one bounded write surface. The code pane is served by the same language servers,
  the same declaration and the same path policy as the WorkBench tools, and
  answers queries only — never file bytes. The terminal is a human surface, never
  an agent tool.

## Code layout

### Backend (`src/`)

A UI-free **core** and the **API** in front of it. Core functions report progress
through an injected `emit(event: dict)` callable.

- `config` — `.env`, the connection an agent resolves from the settings store, and
  the project-instructions block for chat; `core/workspace.py` answers which folder.
- `api` — the REST and SSE endpoints under one route prefix.
- `core` — the streamed chat reply with its shared tool-call loop; the
  batch-mode lot listing; the agent modes; `appdb`, the store's only opener.
- `core/mcphub/` and `core/lsphub/` — the MCP and language-server hubs, one per
  workspace and held in a pool. They mirror each other (discovery, manager, seed) —
  keep that symmetry when touching either one. Both read their declarations from
  that workspace's reserved folder and are hot-toggled from the UI.
- `core/editorfs/` — the Editor's file surface. Paths are relative to the
  request's workspace, reads are bounded, no write destroys bytes, and every call
  answers from the workspace policy's verdict. What the tree lists, what search
  answers about, and what is invisible to both are the same set of paths.
- `core/termhub/` — one shell per WebSocket, on the platform's pseudo-terminal; a
  new shell starts in its tab's folder, and a live one keeps the folder it was born in.
- `core/proctree.py` — the process-tree teardown the hubs and the terminal share.

### Frontend (`web/src/`)

Vite + Vue 3, plain JavaScript, Pico.css.

- `composables/` hold app-shell and stream state and own each live stream and
  its abort; components use them directly.
- `lib/` holds the single markdown renderer — all rendered HTML goes through it,
  never raw `v-html`.
- `components/` and `styles/` are the widgets and the theme.
- The tree's per-file-type icons are **generated**: edit the source tables and
  regenerate, never hand-edit the artifacts.

Configuration is edited from the UI and takes effect hot — except a hand-edit of
`.env`, which waits for a restart.

## How a request flows

The exact route list belongs to the API module; what matters architecturally:

- **Chat**: one request per reply, streamed over SSE and naming the tab's workspace
  and its remembered agent. The client re-posts the history; the server keeps no state.
- **Every WorkBench turn runs in an agent mode** — an install-owned persona that
  replaces the configured system prompt, names the model the turn runs on, and may
  switch a whole hub off. It only narrows what settings and the conversation allow.
- **A workspace's `.agents/skills` and the home folder's user-level one are
  catalogued into the same system message** — name and description only; a
  skill's body is read by the agent, on the model's own judgement, never by the
  app. The catalogue is offered only to a turn that has a connector to read with.
- **A refused round waits, and only it does.** An endpoint answer that says *try
  again* is waited out and the identical request re-sent — nothing had streamed,
  so an outage resumes instead of ending a run. That is the tool loop's only
  waiting site: a final refusal or an unknown failure ends the turn as before. A
  wait is a status line, never transcript; the session clock excludes it, the
  turn's span keeps it.

### SSE is the UI's only source of truth

Core emits plain dicts; the streaming endpoint alone turns them into frames. Each
channel closes with exactly one terminal event; a paused reply ends on its own
ack, keeping its partial turn. The measurement rules hold for every stream:

- **Timing is app-side**, anchored to content-chunk arrivals — tool execution
  never enters the numbers.
- **Cost and rate are different numbers**: token/s uses completion tokens only,
  the displayed cost is prompt + completion.

## Data files

| File | Role |
|---|---|
| `.env` | Install-scoped technical keys. |
| `nojae.db` | The install's settings store: its model connections, its agents and its prompt helpers. Written only through its own routes, never through a path; never hand-edited, so it has no committed template. |
| `.env.test`, `.nojae/nojae-test-settings.json` | The e2e suite's own configuration and model connection, read only under the test switch. |
| Connector and language-server declarations | Which ones exist and how to reach them — files in the workspace's reserved folder. |
| Reserved workspace folder | This workspace's read/write policy and its hub declarations. |
| `.agents/skills/*/SKILL.md` | Packaged know-how, catalogued into chat turns on this workspace. The user's files: no app path writes them. |

Those files may hold secrets, so they are gitignored. These rules tie them
together:

- **`.env` is regenerated from a fixed template on every save** — a new or
  renamed key means changing the template and its committed example together.
- **The declaration files are the only source of truth for what runs.** Their
  `enable` flag is the switch; their secrets never leave the server. A value may
  reference an environment variable so one declaration works on every machine;
  an unresolved name is kept verbatim with a note, never blanked.
- **A test run takes its endpoint from the test files, never from a developer's.**
- **The folder is the tab's, not the process's.** Each workspace-scoped request
  names one; the server holds it for that request only, so tabs work on several
  folders. Moving a tab's folder invalidates that folder's hubs, policy, cached
  views and unsaved work — reported, not dropped — never the settings store.
  `${NOJAE_PATH_LOCATION}` means the workspace served; `tests/test_workspace_seam.py`
  guards the seam.
- **Inside the reserved folder a declaration is created only when absent and
  changed only outside the app.** The folder is hidden from the tree, from reads
  and from git status. No write destroys bytes: a save backs up what it replaces,
  a delete moves the file into a dated batch.
- **Path rules come from two levels, one verdict: the strictest match wins.** The
  app's own rules apply only while a workspace is the app's own directory; the
  workspace's file is always active and can tighten them but never loosen them.
  A hidden path is indistinguishable from an absent one to a reader and named to a
  writer; a read-only path is searchable but named to a writer.
- **The connectors answer the workspace level for their own root**, so a
  read-only folder is uneditable by an agent too — app and connector reach one
  verdict with one matcher. The deny-lists guarding everything outside a root stay
  separate from the workspace's rules: merging them would move secrets into a
  per-project file.

## Key patterns

- **One LLM layer.** Every model call — every chat reply, a batch task's turns
  included — goes through `core/llmkit`, the only seam that speaks HTTP to an
  OpenAI-compatible endpoint, so adding a model is configuration, never new code;
  that seam also owns the verdict on whether a refused round may be waited out.
  The connection comes from the settings store, resolved per agent **once, at a
  turn's start**, so a mid-turn save cannot split it.
- **Core owns logic, the API owns transport.** The blocking model call runs in a
  worker thread publishing events, which the streaming endpoint consumes; that
  worker-plus-cancellation pattern is the chat's, and nothing under `core` may
  import the API layer.
- **The app holds one hub pool, keyed by folder.** A workspace's own hubs are
  rebuilt in place inside it and never replaced while a worker thread holds them,
  because something other than a single request owns the object.
- **A declared-but-unconnected language server is still published** from its
  declared tools and revived by its first call; only off or errored hides it.
- **Teardown kills process *trees*, not wrappers**, on either platform and by
  either mechanism, so nothing a hub or the terminal spawned outlives the app.
- **Tools are read-only by design.** Every tool returns information, the shell
  connector execs one command with no shell (chains, pipes and redirections are
  unrepresentable), and each connector's reach is bounded by its own deny-list.
  `tests/test_write_surface_isolation.py` asserts it: no connector, tool or chat
  path reaches a write route, and the terminal is never a tool.
- **Every write surface is the browser's alone** — the Editor's file routes and
  the settings-store routes — and the file ones are refused while a chat reply
  streams **on that workspace**. Batch mode lists its lot through the shared path
  policy but never reads or writes its contents — only the connectors do.
- **A lot runs every task in one agent and one workspace, both pinned at launch**
  — the agent the composer shows, the folder of the tab that started it — so
  moving either mid-lot reaches no task. An unresolvable selection, or one with no
  model, stops the lot.
- **A task is finished when its file leaves the lot folder**; that move is the
  agent's own acknowledgement, and re-listing is the only way the loop can see it.
  A file still there is relaunched up to the loop's budget, then the lot aborts.
- **This file feeds the chat**: when the workspace the request names carries it,
  it is injected into every chat turn whatever the mode, and re-read per request.
  The model acts on it, so accuracy matters more than volume.
- **Tests stay hermetic**: no test reads a real model connection, reaches a live
  hub or opens the settings store — the hubs are disabled by an environment flag
  and each test runs on a temporary store of its own.

## Tool use

The two connectors an agent edits and runs through. Their limits are enforced,
not advisory — read the refusal, it names the rule that fired.

**Console** execs one command per call, directly, with no shell: no pipes,
chains, redirections or backgrounding, and no variable, glob or home expansion.

- stdout and stderr are reported separately, so redirection between them does
  nothing; output is truncated at both ends, so ask for the slice you want.
- The working directory is a per-call argument, bounded by the same workspace
  policy as paths. Inside the root any command runs; outside it, only the
  allow-listed ones do.
- **These limits are the connector's contract, not a sandbox**: an allow-listed
  interpreter can start a shell and regain every operator above.

**Fedit** writes only through a backup, so no edit destroys bytes:

- Read the file first and quote it verbatim; whitespace counts. An edit is
  atomic — one unmatched block writes nothing.
- A payload holding a line that looks like its own SEARCH/REPLACE marker must be
  sent as a diff, which tokenises no markers.
- Inside the root the **workspace policy** decides; the connector's own
  deny-lists apply only outside it.

## Gotchas

- **A stream cut by the server looks like a finished answer** at the chunk level.
  The honest signal is whether a real finish marker was seen after the loop drains.
  A truncated reply ends as an error, stopping a half-streamed tool call — bytes
  arrived, so it is never waited on, unlike a round refused before the first one.
- **Token counts can look server-reported when they are not**: a stream that dies
  before any usage chunk gets a re-counted back-fill, so keep the estimated flag honest.
- **A core surface reached outside a workspace scope is an error, never a fallback**
  to the installation folder or the previous one.
- **A workspace the pool refused is a named refusal, never an empty catalogue.**
- **Adding a connector is never a module under `src/`** — it is a script plus an
  entry in the workspace's declaration file naming it. Both halves are needed.

## Maintaining this file

Apply the rules above: keep the big picture, cut what the code already says, and
name the invariant rather than the implementation a routine change moves. One
idea per bullet. A test that enforces an invariant is worth naming as a pointer —
the invariant stays the point.
