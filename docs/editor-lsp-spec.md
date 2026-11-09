# Language servers in the Editor pane

**Status**: implemented by the `lspe` lot — the query route, the core module, the
composable and the Monaco surface are in the tree, and §8's backend and frontend
suites are green. Two things stayed open: the e2e's scenario 2 (a declared server
landing the caret) is a **manual check**, because the suite's server runs with the
hub disabled and a spec cannot change another process's environment; and the
**diagnostics increment** (§4.11, §4.15) is decided but not built.
**Surface**: the Editor tab only — one new read-only route, one new core module
in `lsphub`, one new composable, one new `lib/` module, and edits to the Monaco
surface. One sentence of caption in the WorkBench LSP panel, and nothing else
outside the Editor tab. No LLM, no SSE, no new write surface, no change to what a
chat turn may call.

## 1. The need

The app already runs language servers. They are declared per workspace in
`.nojae/lsp-settings.json`, spawned by the LSP hub, and their capabilities are
turned into `lsp_<id>_<action>` tools that the **model** calls during a WorkBench
turn. So the model can ask "where is this symbol defined?" and get an answer.

The human sitting in front of the Editor tab cannot. The code pane is a Monaco
buffer with syntax colouring and nothing else: Ctrl+click on a name does
nothing, hovering a symbol shows nothing, and a type error is invisible until
the file is run. The one surface in the app that is *about* reading code is the
one surface the language servers do not reach.

That asymmetry is the whole feature. The same servers, the same workspace, the
same policy — answering the person instead of the model.

The concrete ask is Ctrl+click: put the caret on a name, hold Ctrl, click, land
on the definition. Hover and find-references are the same request shape and come
almost free. Everything else (squiggles, completion, formatting) is a separate
increment with its own costs, and §7 says which ones v1 leaves out.

## 2. What existed before this lot (verified against the code)

| piece | what it already does | what the editor needs from it |
|---|---|---|
| `core/lsphub/manager.py` — `LspManager` | one stdio child per declared server on a private asyncio thread; `call_tool_sync` bridges a sync caller onto it; `_resolve_path` confines a path to the server's `workspaceRoot`, checks the extension and the size cap; `_call_tool` stamps `last_used` so the idle reaper leaves a busy server alone | the same bridge, the same policy, the same `last_used` stamp — reached by a second entry point |
| `core/lsphub/session.py` — `DocumentStore` | the documents currently `didOpen`ed on one server, with monotonic versions | a way to sync a document from **text the browser holds**, not only from disk |
| `core/lsphub/session.py` — `DiagnosticsInbox` | the latest `publishDiagnostics` payload per URI, plus a wait-for-push step | `peek` — the latest answer, no waiting |
| `core/lsphub/actions.py` — `sync_document`, `run_action` | didOpen/didChange, then one request per catalogue action, result handed to `rendering` | the same calls, with a second rendering |
| `core/lsphub/rendering.py` | LSP structures → compact line-numbered **text for the model** | nothing — the editor needs a *structured* answer, which is a second rendering, not a change to this one |
| `core/lsphub/tools.py` — `TOOL_SPECS` | the action catalogue the model sees, intersected with each server's advertised capabilities | nothing — the editor's action set is **not** the model's tool set (§4.2) |
| `api/routes.py` — `_active_server_ids` | `enable` in the declaration **and** the id in `lspEnabled` | the same two gates, plus the Tools panel switch the browser adds (§4.3) |
| `web/src/components/MonacoEditor.vue` | one editor, one model created with no URI, one command (Ctrl+P), `revealPosition`/`focus` exposed | a model URI, provider registration, and the Ctrl+click / F12 commands |
| `web/src/composables/useEditorFiles.js` | open buffers with `path`, `text`, `baseline`, `dirty`, `language`; `openFile`, `updateText` | the buffer's path and text, and the dirty flag that decides whether text travels |
| `web/src/composables/useChat.js` — `state.lsp` | the Tools panel's per-server switches, the `loaded` flag, and the `locked` flag the first send sets | the switch values that gate the pane, and the `loaded` flag that decides whether a filter is sent (§4.3) |
| `web/src/composables/useWorkspaceTree.js` — `registerReRootHandler` | the one-way registry every holder of workspace-relative paths clears itself through | one more subscriber |
| `web/src/lib/monaco-surface.js` | the worker bootstrap, the theme mapping, the server language id → Monaco language id | the place the new provider module sits beside |

Two facts about the current hub matter more than the rest:

- **It answers text.** `rendering.py` exists to make an LSP answer readable by a
  model. A location rendered as `src/app.py:12:5` is exactly what Monaco cannot
  use. The editor needs `{path, line, character}`.
- **It syncs from disk.** `sync_document` reads the file. The Editor's buffer is
  routinely *dirtier* than the file — that is what a buffer is for — so a query
  answered from disk would point at the wrong line the moment the user has typed.

## 3. The options considered

### 3.1 A real LSP client in the browser

The standard answer in the wider ecosystem: run `monaco-languageclient` in the
page and give it a WebSocket to the language server, so Monaco's own LSP client
does the work.

**Rejected.** Three reasons, in order of weight:

1. **It would bypass the path policy.** The hub's `_resolve_path` is what stops
   "read `~/.ssh/id_rsa` through the Python server". A raw JSON-RPC pipe from
   the browser to a language server has no such gate — the browser would be
   asking the server directly, and the server's own idea of its root is the only
   bound left.
2. **It would double the processes.** The hub already owns one child per server.
   A second client means a second child, or a multiplexing layer that does not
   exist.
3. **It is a large dependency** in an app that is plain JavaScript and Pico.css,
   and it would put a second, differently-shaped LSP client in the codebase
   beside the one the hub already is.

### 3.2 The server proxies LSP frames to the browser

The browser becomes a genuine LSP client; the server forwards frames to the
hub's session. Faithful, and it is the only shape that gets *push* diagnostics
for free.

**Rejected for v1.** The hub's `pygls` client is the one client of each server.
Proxying a second client onto it means two writers of `didOpen`/`didChange` with
competing version counters on one `DocumentStore` — the version bookkeeping that
makes the tool loop correct would stop being correct. And the browser would need
a full LSP client anyway, which is 3.1's cost without 3.1's simplicity.

### 3.3 The browser asks the hub one question at a time — **chosen**

One route. The browser sends "definition at this position in this file, and here
is the buffer's text if it differs from disk". The hub picks the server, applies
the policy, syncs the document, asks, and answers **structured JSON**. Monaco
providers call it.

This is the app's existing shape: core owns the logic, the API owns the
transport, the browser owns the presentation. It reuses the hub, the policy, the
document store and the reaper, and it adds no process and no dependency.

Its honest costs, stated once so nobody is surprised later:

- **No push.** Nothing is streamed to the browser; every answer is a reply to a
  question. Diagnostics, when they land, are pulled from the inbox rather than
  pushed (§4.11).
- **No incremental sync.** Each query sends a full-text change. For a file at
  the editor's size cap that is a megabyte on the wire; for ordinary source
  files it is nothing.
- **Completion would need debouncing**, which is why it is not in v1.

## 4. Decisions taken

### 4.1 The browser never speaks LSP

It asks the hub a question in the app's own vocabulary — `definition`, `hover`
and `references` in v1, plus `status` — and gets an answer in the app's own
shape. No JSON-RPC crosses the browser boundary, no LSP method name appears in
`web/src`, and the hub stays the only thing that talks to a language server.

The consequence worth naming: **the route returns positions and hover text,
never file bytes.** It is not a second file reader. A hover answer may quote a
docstring — that is the server's answer, not a read of the file.

### 4.2 The editor's action set is not the model's tool set

`TOOL_SPECS` is what the model may call. The editor's actions live in their own
table in their own module. They overlap — `definition`, `hover`, `references`,
and `diagnostics` once that increment lands — and they are not the same set: the
model also gets `document_symbols`, `workspace_symbols` and `formatting`, which
the editor does not need in v1.

Keeping them apart is not tidiness. Adding an action to `TOOL_SPECS` silently
adds a tool to every chat turn; adding one to the editor's table must never do
that. The guard suite already asserts that every `TOOL_SPECS` method is a query
and not a document mutation; the editor's table gets the same assertion, so a
future "format on save" cannot arrive as a model tool by accident.

### 4.3 The gate is Settings activation plus the Tools panel switch

A server answers the editor when **both** of these hold:

1. its `enable` flag in `.nojae/lsp-settings.json` is true **and** its id is in
   `lspEnabled` in `.nojae/nojae-settings.json` — the two gates
   `_active_server_ids` already applies, enforced server-side;
2. its switch in the WorkBench **Tools panel** is on — `state.lsp.enabled[id]`
   in `useChat`, enforced in the browser.

The second gate is the right one: the Tools panel is where a person says "these
are the language servers I am using right now", and the Editor is another place
that uses them. One switch, two consumers.

Three consequences follow, and none is obvious:

- **The switch is browser state, so the browser enforces it.** `state.lsp.enabled`
  is never persisted and never sent except in a chat payload. The editor route
  therefore takes the same conversation-scoped allowlist the chat body does
  (`_lsp_tool_kwargs`'s `enabled`), intersected with Settings activation — the
  app's established pattern, so a stale or unknown id silently drops and Settings
  stays the authority. The route never answers from a server the caller did not
  allow.
- **A failed snapshot means "all activated servers", not "none".** When
  `GET /api/lsp` fails, `state.lsp.loaded` is false and the panel is hidden; chat
  then omits the filter and keeps working with every Settings-activated server.
  The Editor mirrors that exactly: no snapshot, no filter. A failed load must not
  silently blind the pane.
- **The switches freeze when a conversation starts.** `state.lsp.locked` is set
  by the first accepted send, so the Editor's set freezes with them until the hub
  is restarted. That is a real consequence of sharing the switch, and it is the
  predictable one: the pane and the conversation agree, and a restart unfreezes
  both. **Decided: the Editor freezes with the conversation** (§10.2). The
  alternative — the pane reading the switches live while chat reads a frozen
  copy — is two answers to one question, and the pane would then disagree with
  the conversation it is sitting beside.

Two gates deliberately do **not** apply:

- **The agent mode's `lsptools` flag.** A mode with `lsptools: false` says the
  *model* gets no language-server schemas. It says nothing about what the human
  may see in their own editor. A mode narrows the conversation, never the pane.
  The panel shows those switches inert while such a mode is selected, but their
  *values* do not change — and the values are what the Editor reads.
- **The batch-mode lock.** A running lot disables the switches; it does not
  disable reading code.

So there is no new switch. The Settings dialog decides which servers exist, the
Tools panel decides which are in use, and the Editor obeys both.

### 4.4 The server is chosen by extension and root containment, in declaration order

A file is served by the first declared server that is active, whose
`extensions` list contains the file's suffix, and whose `workspaceRoot` contains
the file. Declaration order is the tie-break, and it is the order the Settings
panel already shows, so the answer is visible rather than mysterious.

Two consequences that are correct and worth stating:

- **The same extension can be served by different servers in different
  folders.** `typescript`'s root is `<workspace>/web`, so a `.json` file under
  `web/` is its business and a `.json` file at the workspace root is nobody's.
- **A server with an empty `extensions` list serves no file.** It can still be
  a chat tool; it just cannot be picked by suffix.

No match is a **quiet** answer, not an error (§4.10).

### 4.5 The buffer is the source of truth, so a dirty buffer sends its text

The query carries the buffer's text **when the buffer is dirty**, and omits it
when the buffer matches disk. The hub then either syncs the given text or reads
the file — one rule, and the common case (a clean buffer) stays cheap.

This is the decision that makes the feature correct rather than approximately
correct. A user who has typed three lines and then Ctrl+clicks is asking about
*what is on screen*; answering from disk would resolve the name at the position
it used to occupy.

It also settles the interaction with the tool loop: both paths sync a full-text
change before asking, so whichever ran last is what the server analyses, and
each question is answered against the text its own caller meant. The cost is a
redundant `didChange` when the two alternate, which is a few kilobytes.

### 4.6 A cold server answers "starting"; the click never blocks on a handshake

A lazy server (`"lazy": true`, which is how tsserver and Volar are declared)
spawns on its first call, and a cold start is multi-second — the hub's own
handshake budget is a minute. A Ctrl+click that hangs for twenty seconds is
worse than a Ctrl+click that says "starting".

So the route answers immediately with a `starting` status and the browser
retries **once**, after a short delay, then stops. The gesture stays responsive,
the answer stays honest, and the second attempt is what actually lands the
definition on a cold project.

### 4.7 The answer is structured, and it is a second rendering

`rendering.py` stays exactly as it is: it is what the model reads. The editor's
answers are built beside it — a location becomes `{path, line, character}`, a
hover becomes `{markdown, range}`, references become a list of locations, a
diagnostic becomes `{line, character, endLine, endCharacter, severity, message,
source, code}` — that last shape belonging to the diagnostics increment, and
listed here so the module's shape is decided once rather than twice.

Both LSP location shapes — `Location` and `LocationLink` — are absorbed **here**,
where they arrive, so the wire carries the one normalised shape and the browser
maps that shape alone.

Two renderings of one LSP structure, one per consumer, is the honest split. The
alternative — teaching `rendering.py` to answer both shapes — would put a
`for_monaco` flag through the module whose whole point is that it has one job.

### 4.8 Positions are 0-based on the wire and 1-based in the browser, converted once

LSP counts lines and characters from zero; Monaco counts lines and columns from
one. Both count characters in UTF-16 code units, so the conversion is exactly
`+1` in each axis and nothing else — no encoding step, no surrogate handling.

It is stated because it is the kind of thing that silently breaks on the first
emoji, and because the conversion must live in **one** place (the `lib/` module
that maps answers to Monaco types), not be re-derived at each provider.

### 4.9 Hover markdown is rendered by Monaco with HTML support off

A hover answer is markdown, and Monaco renders it into its own DOM. The app's
rule is that all rendered HTML goes through `lib/markdown.js` and never through
raw `v-html`; Monaco's hover is not app markup, so the rule is honoured by
configuration instead: the markdown string is handed over with HTML support
**off**, so the server's text is escaped rather than interpreted.

That is the safe default and it costs nothing — language servers emit markdown,
not HTML.

### 4.10 No server is a quiet answer, and the gesture falls through

A file no server claims, a server that is off, a server that errored: all three
answer `server: null` with a one-line reason, and the pane does nothing visible.
Ctrl+click then falls through to whatever Monaco would have done on its own —
which for TypeScript and JavaScript is the built-in worker's definition, i.e.
exactly today's behaviour.

The feature must degrade to the status quo, never to an error. A toast saying
"no language server for this file" on every Ctrl+click in a Markdown file would
be worse than the feature is good.

The one place the absence is *said* is the pane's own status line (§6), which is
where a user looks to find out why a gesture did nothing.

### 4.11 Diagnostics are pulled from the inbox, never pushed — **next increment**

This section is decided but **not built in v1** (§7). It is written down now
because the decision shapes the route's vocabulary, and because the built-in
worker question (§4.15) only makes sense beside it.

The hub already receives `publishDiagnostics` and keeps the latest payload per
URI. The editor asks for it — `peek`, no waiting — and draws the result.

The cadence is three moments, and no others:

- when a buffer becomes the active tab (the first look at a file);
- after a save (the file changed, so the server will re-analyse);
- on an explicit "re-check" gesture in the pane.

**Not on every keystroke.** A `didChange` per keystroke is a request storm
against a single-threaded hub loop, and it would compete with the chat tool loop
for the same server.

A file the server has never opened has no diagnostics yet, and the honest answer
is "not analysed yet" rather than an empty list that reads as "clean". The pane
says which.

### 4.12 An editor query counts as use

The idle reaper tears a server down after `idleShutdownSeconds` without a tool
call. A user reading code in the Editor for ten minutes is using the server, and
must not have it reaped out from under them — so the editor's entry point stamps
`last_used` exactly as `_call_tool` does.

### 4.13 A working-location switch clears the editor's LSP state with the buffers

`POST /api/path-location` restarts both hubs, and the frontend's `reRoot()`
closes every buffer through `registerReRootHandler`. The editor's LSP state
joins that registry: the last answer, the status line and any in-flight request
are dropped, because a location that no longer exists makes every one of them a
lie.

### 4.14 Nothing here writes

The route is a read. It opens documents on a language server (which is not a
write to disk), it asks questions, and it answers positions and text.

`textDocument/formatting` is the one LSP action that produces edits, and it is
**out of v1** (§7). If it lands later, the rule is already decided: it edits the
**buffer**, never the file, so the change goes through the existing dirty flag
and the existing guarded save route. The Editor's write surface stays exactly
where it is — the browser's, and one route wide.

### 4.15 The built-in TypeScript/JavaScript worker keeps its markers in v1

Monaco ships a TypeScript worker that already draws its own squiggles for
`.ts`/`.js`, and the app never configures it — no `setDiagnosticsOptions`
anywhere in `web/src`. Suppressing it is therefore possible, and the decision is
to do it **when diagnostics land**, not before.

The reason is that the two answers collide. Diagnostics are out of v1 (§7), so
suppressing the built-in worker's markers today would delete the only squiggles
the pane has and put nothing in their place — a regression dressed as a
preparation. The suppression belongs to the increment that brings a replacement.

Two facts to carry into that increment:

- **The switch is per language, not per file.** `setDiagnosticsOptions` is
  global for `typescript`/`javascript`, so it cannot be scoped to "files a
  language server owns". A `.ts` file outside the server's `workspaceRoot`
  (§4.4) would lose its markers with nothing to replace them. The increment has
  to decide whether that is acceptable or whether the server's root is widened.
- **Suppressing diagnostics does not touch definition or hover.** Those are
  separate providers, so v1's Ctrl+click is unaffected either way.

In v1 the built-in worker is left exactly as it is, and it is also the
fall-through target of §4.10.

## 5. What it builds on

| existing piece | reused for |
|---|---|
| `LspManager.call_tool_sync` and its private loop | the sync bridge, unchanged in shape |
| the workspace policy (`editorfs.policy`) | the path's verdict, with the tree's own answer |
| `manager._resolve_path`'s size cap constant | the same bound on a document read from disk |
| `manager._call_tool`'s `last_used` stamp | keeping the reaper off a server in use |
| `actions.sync_document` | didOpen/didChange, gaining an optional text argument |
| `DiagnosticsInbox.peek` | the latest diagnostics, no wait — the next increment (§4.11) |
| `_active_server_ids` | the two activation gates |
| `useChat`'s `state.lsp.enabled` / `loaded` | the Tools panel switch, and whether a filter is sent at all (§4.3) |
| `useEditorFiles`' buffer records | the path, the text, the dirty flag |
| `useWorkspaceTree.registerReRootHandler` | clearing state on a location switch |
| `lib/monaco-surface.js` | the language-id mapping and the worker bootstrap |
| `useEditorMode`'s badge | the pane's "why did that do nothing?" answer, which now names the language server |
| `useEditorNotices` | the one place a *refusal* would be reported, if one ever is |
| `tests/fake_langserver.py` | a hermetic server that advertises definition, hover and references |

## 6. Shape and files of the new pieces

### `src/core/lsphub/editor.py` (new)

Core-only, no FastAPI — the discipline of the rest of `lsphub/`. Holds the
editor's action table (which action, which LSP method, which capability gates
it) and the structured answers built from the LSP result. Exported through
`lsphub/__init__.py` beside the tool catalogue.

The action table is deliberately **not** `TOOL_SPECS` (§4.2).

### `src/core/lsphub/actions.py` (edit)

`sync_document` gains an optional text argument: given text is synced as a
full-text change, absent text is read from disk as today. One function, one
behaviour, both callers.

### `src/core/lsphub/manager.py` (edit)

One new entry point for an editor query: choose the server (§4.4), apply the
policy, stamp `last_used`, run the action, answer the structured result or the
`starting` / `no server` status. It shares the timeout constants with the tool
path rather than re-deriving them, and it asks the **workspace policy** for the
path's verdict rather than `_resolve_path` — the tool path's gate requires the
file to be on disk, while a dirty buffer is the whole point of the feature
(§4.5), so a file the user has emptied or deleted still has text to ask about.
The extension check `_resolve_path` also makes is the server choice, and its
size cap is applied with the same constant.

### `POST /api/lsp/query` (new route in `api/routes.py`)

Body: the action, the workspace-relative path, the position (for the actions
that need one), the buffer text when the buffer is dirty, and the
conversation-scoped server allowlist the Tools panel holds (§4.3). Answer: the
structured result plus which server answered.

The allowlist is intersected with Settings activation exactly as
`_lsp_tool_kwargs` does for chat, so the route can never answer from a server
the caller did not switch on. An absent allowlist means "no filter" — the
failed-snapshot case, which must not blind the pane.

A `POST` because the buffer text travels with it and can be large — a `GET`
would put a megabyte in a query string. It is a **read**: it names no write
route, and the guard suite's marker scan stays green because it is not one.

The route is a plain `def`, so FastAPI runs it in a threadpool: the hub bridge
blocks on a future, and blocking the event loop would stall every other request.

### `web/src/lib/monaco-lsp.js` (new)

The pure half: LSP position ↔ Monaco position (§4.8), a wire location
`{path, line, character}` → a Monaco location, a hover answer → a Monaco hover,
and (with the diagnostics increment) a diagnostic → a Monaco marker. Pure
functions, testable in jsdom without mounting an editor — the same split
`lib/monaco-surface.js` already makes for the reveal clamp.

The two LSP location shapes are **not** absorbed here: `Location` and
`LocationLink` both arrive at the hub, so `core/lsphub/editor.py` normalises them
into the one wire shape and this module maps that shape alone. A `null` answer is
a no-op, never a throw.

### `web/src/composables/useEditorLsp.js` (new)

The stateful half: one request per gesture, the `starting` retry (§4.6), the
status line's answer, the re-root handler (§4.13), and the read of
`useChat`'s `state.lsp` that builds the allowlist (§4.3). A singleton, like the
other Editor composables.

It reads `useChat`'s state rather than owning a copy: two switches for one
server would drift, and the Tools panel is the one the user sees.

### `web/src/components/MonacoEditor.vue` (edit)

Three changes, each load-bearing:

- the model is created **with a URI** derived from the buffer's workspace path,
  so a provider can map a model back to a path. A synthetic scheme, not
  `file://`: a `file://` URI makes Monaco's built-in TypeScript worker try to
  resolve imports across files it does not have, which is a behaviour change
  nobody asked for. Monaco has no "rename a model's URI" call, so a buffer swap
  creates a model for the new path and disposes the old one — the *editor* is
  still created once and takes the new model through `setModel`;
- the providers are registered once, at mount, and disposed with the editor;
- F12 is registered through the command API, beside the existing Ctrl+P — the
  one path that beats Monaco's keybinding service. Ctrl+click needs no
  keybinding: it is Monaco's own gesture, so it is claimed through the editor
  opener instead, which is also the seam that lets a target in another file
  reach the pane. Both run the same definition path, so the two cannot disagree.

### `web/src/components/EditorArea.vue` (edit)

Passes the buffer's path to the surface, and renders the pane's status line:
which server is serving this file, or that none is. It is a caption, not a
control — there is nothing to click, and no second switch to disagree with the
Tools panel.

### `web/src/components/WorkBenchLspPanel.vue` (edit)

One sentence in the panel's caption, no new control (§10.2). The panel's title
is "LSP tools" and its rows read as conversation-scoped; once the Editor obeys
the same switches, that wording is narrower than the truth. The caption gains
that the Editor's code pane uses these servers too, so a user who switches one
off and then finds Ctrl+click dead in the Editor has been told why.

The rows themselves do not change, and no per-consumer control is added: one
switch, two consumers, said once.

### `web/src/composables/useEditorMode.js` (edit)

The read-only badge's title gains one sentence naming the language server, so
the pane's existing "why did that do nothing?" answer covers this too.

## 7. Out of scope for v1

- **Diagnostics squiggles.** The highest-value increment after Ctrl+click, and
  the one with a real collision: Monaco's built-in TypeScript/JavaScript worker
  already draws its own markers, so an LSP set beside it means two squiggles on
  one line. §4.11 has the cadence and §4.15 has the collision; both are decided
  and neither is built here.
- **Completion.** Async, per-keystroke, and it needs debouncing and
  cancellation — machinery whose only cause would be the wrong split of work.
- **Formatting.** The one action that produces edits; §4.14 says where it would
  have to go.
- **Rename, code actions, signature help.** All either write or need a UI.
- **The diff viewer and the markdown preview.** A diff has two models and no
  single path; a preview has no model at all.
- **Push diagnostics over SSE.** §3.2's cost, and not worth paying for v1.
- **A per-file or per-server switch in the Editor.** §4.3: the Tools panel is
  the switch, and a second one in the pane would be a second thing to disagree
  with it.
- **Any change to what a chat turn may call.** The model's tool set is
  untouched.

## 8. Verification

### Backend (`tests/test_lsp_editor.py`, new)

Hermetic, `tmp_path` workspace, `tests/fake_langserver.py` as the server — the
pattern `tests/test_lsp.py` already uses.

| test | asserts |
|---|---|
| definition answer | a location comes back as `{path, line, character}`, 0-based, workspace-relative |
| hover answer | the markdown and the answering server id are both present |
| references answer | a list of locations, in the server's order |
| outside the server's root | a path under the workspace but outside `workspaceRoot` answers `server: null` |
| unclaimed extension | a suffix no active server lists answers `server: null` |
| hidden / read-only path | refused by the workspace policy, with the same verdict the tree gives |
| a server switched off in the Tools panel | answers `server: null` even though Settings activates it — the allowlist is honoured |
| no allowlist sent | every Settings-activated server is eligible — the failed-snapshot case |
| dirty buffer | the text sent with the query is what the server analysed, not the disk copy |
| clean buffer | no text is sent, and the disk copy is used |
| cold server | a stopped lazy server answers `starting` and does not block |
| the reaper | a query stamps `last_used`, so an idle sweep leaves the server up |
| the action table | holds no mutation method — the same assertion the guard suite makes over `TOOL_SPECS` |
| the route | names no write route; the marker scan stays green |

### Frontend (Vitest + jsdom)

- `monacoLsp.test.js` — position mapping both ways, the wire location shape, a
  hover answer's shape, and that a `null` answer is a no-op rather than a
  throw.
- `useEditorLsp.test.js` — one request per gesture; a `starting` answer retries
  exactly once; a `server: null` answer raises no notice; a re-root clears the
  state and drops an in-flight answer.
- `useEditorLsp.test.js`, the allowlist — a server switched off in the Tools
  panel is not sent; a failed snapshot (`loaded: false`) sends no filter at all;
  a locked conversation's frozen set is what travels.

### e2e (Playwright, own server, endpoint from `.env.test`)

1. a buffer no server claims: Ctrl+click changes nothing and raises no notice —
   the degradation path, which is the one that must never regress;
2. a buffer a declared server claims: Ctrl+click lands the caret on the
   definition's line, and the pane's status line names that server.

The second needs a language server in the test workspace's declaration. If that
proves too heavy for the suite, it stays a manual check and the e2e keeps only
the first — said here rather than discovered later. **It did prove too heavy**:
the suite's server runs with the hub disabled, and a spec cannot change another
process's environment, so the e2e automates the first and the second is the
manual check the spec file's header spells out.

## 9. The `AGENTS.md` clause

Landed as one clause beside the Editor's file-surface sentence:

> The Editor's code pane is served by the same language servers the WorkBench
> tools use — the same declaration, the same Tools panel switch, the same path
> policy — through one read-only query route that answers positions and hover
> text, never file bytes. A file no server claims is a quiet no-op, not an
> error.

## 10. Decisions, and what they raised

### 10.1 The seven questions, answered

1. **v1 scope** — definition, hover and references only. Diagnostics is the
   second increment (§4.11, §7).
2. **The gate** — Settings activation **and** the Tools panel switch, the same
   switch chat uses. The agent mode's `lsptools` flag and the batch lock do not
   apply (§4.3).
3. **Dirty buffers** — the buffer's text travels with the query (§4.5).
4. **Cold start** — answer `starting` and retry once, never block (§4.6).
5. **Formatting** — out of v1, and buffer-only if it ever lands (§4.14).
6. **The built-in TypeScript/JavaScript worker** — suppress its diagnostics
   once an LSP replacement exists, i.e. with the diagnostics increment, not
   before (§4.15).
7. **The diff viewer** — out of scope (§7).

### 10.2 Three questions answer 2 raised, answered

Answer 2 moved the gate from Settings-only onto conversation-scoped browser
state, which is a different kind of thing. These follow from it:

1. **Does the Editor's set freeze with the conversation?** **Yes — freeze
   together.** `state.lsp.locked` is set by the first accepted send, so the
   Tools panel switches stop moving until the hub restarts, and the Editor's set
   freezes with them (§4.3). The alternative — the pane reading the switches
   live while chat reads a frozen copy — is two answers to one question, and the
   pane would disagree with the conversation beside it.
2. **Is a locked conversation's frozen set the right one for a file opened
   later?** **Yes, accepted.** A user who starts a chat and then opens a `.py`
   file gets the servers that were on when the chat started. That is defensible
   — one workspace, one set of tools — and the pane's status line names the
   serving server, so the answer is visible rather than mysterious (§4.10). A
   restart unfreezes both.
3. **Should the Tools panel say the Editor is a consumer?** **Yes — one
   sentence in the panel's caption, no new control** (§6,
   `WorkBenchLspPanel.vue`). The rows stay as they are: one switch, two
   consumers, said once.

With these three settled, nothing in this document was left open, and the lot
built it as written — bar the two corrections now made in place: the two LSP
location shapes are absorbed in the core (§4.7, §6), and §8's test table says
0-based, which is what §4.8 always meant. Two things stayed open: the e2e's
second scenario, which is a manual check, and the diagnostics increment.
