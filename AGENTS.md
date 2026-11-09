# AGENTS.md — nojae

## What it is

A self-hosted FastAPI + Vue 3 workspace where a coding agent works on a real
checkout: a streaming chat with the configured model, an editor over the same
folder, and everything reaching the browser live over Server-Sent Events.
Desktop browsers only.

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

Setup, run and test commands live in the README; read that when you need to
build, install or launch something on this machine.

## Shape of the app

The tabs share one LLM configuration and one streaming layer:

- **WorkBench** — interactive streaming chat with the configured model,
  optionally augmented with MCP connectors and language servers, plus a batch
  mode that works through a folder of task files.
- **Editor** — the working location as a file tree, a code pane and a terminal.
  Its writes form one bounded surface, reachable from the browser only, never
  from a hub or a tool. The code pane is served by the same language servers,
  the same declaration and the same path policy as the WorkBench tools, and
  answers queries only — never file bytes. The terminal is a human surface,
  never an agent tool.

## Code layout

### Backend (`src/`)

A UI-free **core** and the **API** in front of it. Core functions never touch
FastAPI — they take an injected `emit(event: dict)` callable and report progress
through it.

- `config` — `.env` and the workspace's model connection loaded into one
  configuration, and the project-instructions block injected into chat.
- `api` — the REST and SSE endpoints under one route prefix, and the chat
  stream's own SSE channel: one worker thread feeding it, one terminal frame
  closing it.
- `core` — the streamed chat reply with its shared tool-call loop; the
  batch-mode lot listing; the agent modes.
- `core/mcphub/` and `core/lsphub/` — the MCP and language-server hubs. They
  mirror each other (discovery, manager, seed) — keep that symmetry when
  touching either one. Both read their declarations from the **working
  location's** reserved folder and are hot-toggled from the UI.
- `core/editorfs/` — the Editor's file surface. Paths are relative to the
  working location and every call answers from the workspace policy's verdict.
  Reads are bounded, writes to `ro`/`hidden` are refused, and no write destroys
  bytes. What the tree lists, what search can answer about, and what is
  invisible to both are the same set of paths.
- `core/termhub/` — one shell per WebSocket, on the platform's pseudo-terminal.
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
`.env` or of the workspace's model connection, which waits for a restart.

## How a request flows

The exact route list belongs to the API module; what matters architecturally:

- **Chat**: one request per reply, streamed back over SSE. The client re-posts
  the whole history each time; the server keeps no conversation state.
- **Every WorkBench turn runs in an agent mode** — a workspace-owned persona
  that replaces the configured system prompt and may switch a whole hub off.
  A mode only ever narrows what settings and the conversation already allow;
  it never grants anything. This file is injected into every chat turn
  whatever the mode.

### SSE is the UI's only source of truth

Core emits plain dicts; the streaming endpoint is the only thing that turns
them into frames. Each stream has its own channel and closes with exactly one
terminal event; a reply the user paused still ends on its own ack, keeping its
partial turn.

Measurement rules hold across every stream:

- **Timing is app-side**, anchored to content-chunk arrivals — tool execution
  never enters the numbers.
- **Cost and rate are different numbers**: token/s uses completion tokens only,
  the displayed cost is prompt + completion.

## Data files

| File | Role |
|---|---|
| `.env` | Install-scoped technical keys. |
| `.nojae/nojae-settings.json` | This workspace's model connection and which language servers it activates. |
| `.env.test`, `.nojae/nojae-test-settings.json` | The e2e suite's own configuration and model connection, read only under the test switch. |
| Connector and language-server declarations | Which ones exist and how to reach them — files in the workspace's reserved folder. |
| Reserved workspace folder | This workspace's read/write policy, its hub declarations, and the stores the app writes. |

Those files may hold secrets, so they are gitignored, and each has a committed
template. These rules tie them together:

- **`.env` is regenerated from a fixed template on every save** — a new or
  renamed key means changing the template and its committed example together.
- **The declaration files are the only source of truth for what runs.** Their
  `enable` flag is the switch; their secrets never leave the server. A value may
  reference an environment variable so one declaration works on every machine;
  an unresolved name is kept verbatim with a note, never blanked.
- **A test run takes its endpoint from the test files, never from a developer's.**
- **One setting defines the working location** that every file-touching part of
  the app roots itself at, and it is held outside the settings file. Every path
  the app holds is relative to it, so moving it invalidates them all at once:
  cached views are discarded, unsaved work is reported rather than dropped.
- **Inside the reserved folder, declarations and stores differ**: a declaration
  is created only when absent and changed only outside the app; a store is
  written by the app through its own route, never through a path. The folder is
  hidden from the tree, from reads and from git status. No write destroys bytes:
  a save backs up what it replaces, a delete moves the file into a dated batch.
- **Path rules come from two levels, one verdict: the strictest match wins.** The
  app's own rules apply only while the working location is the app's directory;
  the workspace's file is always active and can tighten them but never loosen
  them. A hidden path is indistinguishable from an absent one to a reader and
  named to a writer; a read-only path is searchable but named to a writer.
- **The connectors answer the workspace level for their own root**, each reading
  that policy in its own process, so a read-only folder is uneditable by an agent
  too — app and connector share one parser, one matcher and one refusal sentence.
  The deny-lists guarding everything outside a root stay separate from the
  workspace's rules: merging them would move secrets into a per-project file.

## Key patterns

- **One LLM layer.** Every model call — every chat reply, a batch task's turns
  included — goes through `core/llmkit`, the only seam that speaks HTTP to an
  OpenAI-compatible endpoint, so adding a model is configuration, never new
  code.
- **Core owns logic, the API owns transport.** The blocking model call runs in a
  worker thread publishing events; the streaming endpoint consumes them. That
  worker-plus-cancellation pattern is the chat's, and nothing under `core` may
  import the API layer.
- **Hubs are long-lived singletons.** A restart rebuilds a hub's internals but
  never replaces the object the app holds, because worker threads keep the
  reference across a request.
- **A declared-but-unconnected language server is still published** from its
  declared tools and revived by its first call; only being switched off or
  errored keeps it out of the catalogue.
- **Teardown kills process *trees*, not wrappers**, on either platform and by
  either mechanism, so children a hub or the terminal spawned of their own never
  outlive the app that started them.
- **Tools are read-only by design.** Every tool returns information, the shell
  connector execs a single command with no shell (so command chains, pipes and
  redirections are unrepresentable), and each connector's reach is bounded by its
  own deny-list. `tests/test_write_surface_isolation.py` asserts that instead of
  trusting this sentence: no connector, tool or chat path reaches a write route,
  and the terminal is never a tool.
- **Every write surface is the browser's alone** — the Editor's file routes and
  the routes that write a reserved-folder store — and each is refused while a
  chat reply streams. Batch mode lists its lot through the shared path policy but
  never reads or writes its contents — only the connectors do.
- **A lot runs every task in one mode, pinned at launch** — the workspace's coding
  mode, so moving the composer's choice mid-lot reaches no task. A workspace with
  no such mode falls back to the server's default and says so rather than being
  refused.
- **A task is finished when its file leaves the lot folder**; that move is the
  agent's own acknowledgement, and re-listing is the only way the loop can see it.
  A file still there is relaunched up to the loop's budget, then the lot aborts.
- **This file feeds the chat**: when the working location carries it, it is
  injected into every chat turn and re-read per request. The model acts on it, so
  accuracy matters more than volume.
- **Tests stay hermetic**: no test reads a real model connection or reaches a
  live hub — the hubs are disabled by an environment flag and their declared
  file locations are patched per test.

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
  The honest signal is whether a real finish marker was ever seen, read after the
  loop is drained. A truncated chat reply ends as an error, which also stops a
  half-streamed tool call from being executed.
- **Token counts can look server-reported when they are not**: a stream that dies
  before any usage chunk gets a re-counted back-fill, so a reported figure is not
  evidence of where it came from. Keep the estimated flag honest.
- **Adding a connector is never a module under `src/`** — it is a script plus an
  entry in the workspace's declaration file naming it. Both halves are needed.

## Maintaining this file

Apply the rules above whenever you edit it: keep the big picture, cut what the
code already says, and name the invariant rather than the implementation a
routine change would move. One idea per bullet. A test that exists to enforce an
invariant is worth naming as a pointer — the invariant stays the point.
