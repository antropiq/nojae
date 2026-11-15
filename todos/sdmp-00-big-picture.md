# Lot: the Settings dialog's Servers tab, toolbar-driven

**The spec is `docs/settings-dialog-migration-plan.md`. It is binding.** Its §2
corrects the mockups, its §4 is the layout, §5 the states every control must
handle, §7 the acceptance list, §8 the task list this lot is cut from, §9 and §12
the decisions already taken. Read the sections your task cites before you write
anything. This file is the map, and the place where this lot's own decisions are
written down so no task has to re-derive them.

The mockups (`docs/imgs/Settings-Dialog-Servers_01.png`,
`docs/imgs/Settings-Dialog-models_01.png`,
`docs/imgs/Settings-Dialog-models_02.png`) are **geometry**, not truth: §2
overrides them where they disagree, and §2 always wins.

Lot prefix: `sdmp-`. Tasks run in the order of the table at the bottom.

## What we end with

One existing dialog — `web/src/components/SettingsDialog.vue` — with its Servers
section shaped the way the Agents card already is. A user sees:

1. **A section strip reading `Servers` · `MCP` · `LSP`.**
2. **A toolbar over the tree, holding only verbs**: three fixed slots (add, save,
   delete), a flexible spacer, then two reserved slots for a confirmation pair.
   Each verb acts on **the page that is visible** — the server selected, or the
   model selected.
3. **A detail strip inside the detail column**: `Settings` and `System prompt` on
   a model page; the same strip with one reserved `Settings` tab on a server page.
4. **The server page owning its listing**: `Fetch models` under the API key, and
   the `name` | `Add` table it answers, scrolling inside itself; a row's `+`
   writes that model under this server.
5. **One reserved message band at the bottom**, left of `Close` — everything the
   dialog says comes out of it, nothing else in the dialog says anything.
6. **Delete asking in place**: the confirmation pair appears in the toolbar's two
   reserved slots, and `window.confirm` is gone from this dialog.

## What does not change

- **No backend, no schema, no new route** (spec §6.5, §11). Every route the
  rework needs is already served: `GET /api/servers` (the whole tree),
  `GET /api/models?serverUrl=&apiKey=`, `POST /api/models/add` (whose body is the
  model's fields plus `serverId`; an omitted sampler stays a null column, so
  `{ name, serverId }` is a complete body). **No task touches `src/`.** A task that
  thinks it needs a route there has misread §4.
- **A model's in-column edits stay a draft copy**: switching rows does not write,
  and Close has nothing to undo.
- **The cascade stays**: deleting a server takes its models with it, exactly as
  `models.server_id ON DELETE CASCADE` declares. No parent-guard, no "delete the
  children first" refusal, and `tests/test_write_surface_isolation.py` keeps
  asserting that no connector or tool reaches a write route.
- **Save does not close the dialog, and `Close` is the footer's only verb** in all
  three sections.
- **The Agents card is not changed in appearance or behaviour.** It shares the
  `settings-*` classes, the fixed card size and now the toolbar idiom; every rule
  this lot adds is scoped through `.settings-dialog`, and the Agents card keeps its
  vertical nav (`docs/agents-dialog-rework.md` D4.4, its §3.2).

## The three levels of tab, and who owns each

| strip | position | state lives in | tabs |
|---|---|---|---|
| section strip | under the title, full width | component-local, as today | `Servers` · `MCP` · `LSP` |
| detail strip | top of the detail column | **app-shell state** (`useAppShell`) | `Settings` · `System prompt` on a model page; one reserved `Settings` on a server page |
| toolbar | above the tree, left column | app-shell state (the selection) | not tabs — verbs |

The section's internal id stays what it is today; only the visible words become
`Servers`. The section strip is unchanged in position: it already renders
horizontally for this dialog, and only the Agents card keeps the vertical nav.

## The fixed names this lot reads

Later tasks must not invent synonyms for these; they are the seams between the
tasks.

- **`web/src/composables/useSettingsServers.js`** (new, task 03) — every verdict as
  a plain exported function returning `{ disabled, label }`, the shape
  `useAgentModes.js` uses. The exports:
  `addSlotFor`, `saveSlotFor`, `deleteSlotFor`, `deleteConfirmationFor`,
  `fetchSlotFor`, `addListingSlotFor`, `saveRefusalFor` (all task 03), and
  `messageFor` (task 08).
  `useAgentModes.js`'s `slotLive` / `slotInert` / `slotContext` are module-private:
  restate that shape here, never import another module's privates.
- **`state.detailTab`** on `useAppShell`'s state (task 05), with the two values
  `settings` and `prompt`, plus one setter the strip and the composable both use.
  Selecting a model from the tree leaves it as it is; only task 06's `+` sets it to
  `settings`.
- **`addModelFromListing(name)`** on `useAppShell` (task 06) — the one write the
  `+` performs.

## The toolbar, stated once

- Three **fixed-width** slots, then a flexible spacer, then **two reserved slots**
  for the confirmation pair. A slot keeps its size whether or not it holds a button,
  so revealing a pair moves nothing and the toolbar never changes height.
- The three verbs stay the same on both pages and are **never scoped in their
  labels**: their accessible names, and their tooltips, are `Add`, `Save`, `Delete`.
  The visible page is the scope.
- **An inert slot carries its reason in `label`**, and that one value is both its
  `title` and its accessible name, so a label cannot drift from an enablement.
- **A form with a problem does not disable Save.** The click is refused and the
  reason lands in the message band; taking the button away hides the answer.
- **Every verdict is a function** (the module above), never a condition in the
  template. That the dialog template decides nothing is an acceptance item
  (spec §7.12) with its own task (13) and assertion.
- **`Fetch models` is deliberately not a fourth slot**: it is a text-labelled
  button inside the server page, under the API key, because what it answers is that
  page's body.

## The server page's two page-level verbs

- **`Fetch models` is inert until the selected server has a backend row** (an id),
  with the reason `Save the server before fetching its models.` It is also inert
  while the URL field is empty (it would dial nothing), while its own listing is in
  flight (reading `Fetching…`), and while a write is in flight.
- **One gate therefore covers listing and adding**: the listing cannot be reached
  without a saved server, so no `+` can be shown for an unsaved one.
- **A row's `+` writes the model**: `POST /api/models/add` with `{ name, serverId }`
  and nothing else — the samplers are omitted, their columns stay null, and the
  endpoint's defaults apply. It runs under the same in-flight guard as Save and
  Delete (`state.settingsSaving`), and a second click waits rather than racing.
- **`+` stays inert, it never disappears**, with the reason `Already added` for a
  name the server is already a parent of — that costs a comparison against the tree
  the dialog already holds, and no new route.
- **A re-fetch does not blank the previous rows before the answer arrives**: while
  `state.fetchedModelsLoading` names this row, the rows stay and the verb reads
  `Fetching…`. An **empty answer is still an answer**: it replaces the rows, and the
  message band says `This server lists no models.`

## The one message band

A reserved footer band, the message area filling the row left of `Close`, exactly
the shape `.agent-modes-dialog`'s `.settings-actions` + `.agent-modes-message`
already give the Agents card. It is always there, so filling or emptying it moves
nothing. Everything the dialog says comes out of it, chosen by **fixed priority,
never by recency** (spec §4.7):

1. a write in flight (`Saving…`)
2. a model listing in flight (`Listing this server's models…`)
3. a refusal from the store / an unusable store (`state.storeState`, verbatim)
4. this section's write failure (`state.serversError`)
5. the fetch refusal for the row being edited (`fetchedModelsErrorFor`)
6. a refused action explained (incomplete form, a name the server already has, and
   — from task 09 — the delete sentence awaiting its answer)
7. a read failure (`state.settingsError`, then `state.serversError`)
8. the read's findings, joined as **one** message (this is where
   `This server lists no models.` sits)
9. the cross-store line — `2 of 4 agents have no model — assign one`, still a
   button that opens the Agent-modes dialog

The role is part of the answer: `alert` for a failure or a refusal, `status` for
progress and for the incomplete-form sentence. `state.serversError` carries both a
write's and a read's failure; the write's is the higher priority, and the ordering
above is the spec's — do not re-derive it.

**These six sites are removed by task 08** and their content moves into the band:
`state.settingsError` under the header; `storeNotice` and `state.serversError`
above the master–detail; the unassigned line above it; the fetch error and the "no
listing yet" note under the server's buttons; **the same** error and note under the
model-name field, with the `datalist`; and `Save the server before adding a model
to it.`

**MCP and LSP keep their per-row badges and per-row errors** — those describe one
connector, not one action, and a band cannot say six things about six connectors at
once. What moves for those sections is their **top-level** lines only (package not
installed, the read failure).

## Reserved geometry is the acceptance criterion

The toolbar's slots, the detail strip and the message band all hold their size when
empty. That is what makes a fetch answer, a confirmation pair and an error sentence
non-moving, and it is asserted in task 14's spec.

**The listing table's scroll container is where a naive implementation fails.**
`overflow-y: auto` alone is not enough inside a grid: the column needs
`min-height: 0` and the flexible row needs `minmax(0, 1fr)`, or the table grows and
the column scrolls instead. The same shape `.agent-modes-nav` already has.

**Copy the CSS idiom, not new geometry**: `.agent-modes-toolbar`,
`.agent-modes-slot`, `.agent-modes-toolbar-space`, the
`grid-template-rows: auto auto minmax(0,1fr)` body and the message band already
exist and already survive Pico's `[role="group"] button { width: auto }` trap
(documented in `theme.css`). Share them rather than re-declaring them; scope
anything new through `.settings-dialog`, because the Agents card shares these
classes by design.

## Invariants that hold in EVERY task

Quoted from this project's instructions (`AGENTS.md`); a task that breaks one is
not done.

- *"Every write surface is the browser's alone — the Editor's file routes and the
  settings-store routes — and the file ones are refused while a chat reply
  streams."* This lot adds no write surface: it re-shapes the browser's own.
- *"`nojae.db` … The install's settings store: its model connections, its agents and
  its prompt helpers. Written only through its own routes, never through a path;
  never hand-edited, so it has no committed template."* No task reads the store's
  bytes, and no test opens the install's.
- *"composables/ hold app-shell and stream state and own each live stream and its
  abort; components use them directly."* The detail tab, the verdicts and the
  listing answers are the composables'; the component renders answers.
- *"`components/` and `styles/` are the widgets and the theme."* Layout goes in
  `web/src/styles/theme.css` beside the block it belongs to, not in scoped styles.
- *"Configuration is edited from the UI and takes effect hot — except a hand-edit of
  `.env`, which waits for a restart."* Every write this lot makes is a hot one and
  gives the whole tree back.
- *"Core owns logic, the API owns transport."* No task under `src/` at all — and
  nothing here adds an event, a frame or a stream.
- *"Tests stay hermetic: no test reads a real model connection, reaches a live hub
  or opens the install's settings store — the hubs are disabled by an environment
  flag and each test runs on a temporary store of its own."* Unit tests mock
  `fetch`; the e2e spec runs on the suite's own temporary store and its own
  endpoint, and reaches no other.
- *"Setup, run and test commands live in the README; read that when you need to
  build, install or launch something on this machine."* Do not invent commands:
  README → Tests gives `cd web && npm test`, and README → "Setting up tests for
  nojae" gives the e2e suite's own connection.

## Interim rules, so the tree is never broken

- **The dialog keeps working at every step.** A layout task lands with its buttons
  wired; nothing is left in the DOM promising an action that does not happen.
  That is why the `+`'s write lands (task 06) **before** the table that holds it
  (task 07) — the pair is one reviewable unit either way, and the spec itself
  offers that grouping.
- **A sentence is written once, where its task needs it.** Until the band exists
  (task 08), a message a later task routes into it is rendered at the nearest site
  the current layout has — and the task that lands the band deletes those sites.
  A string is never invented twice, and `messageFor` is written once, in task 08.
- **Each task updates the unit tests its change invalidates in the same change.**
  `cd web && npm test` is green at the end of every task. No task touches `src/`,
  so the backend suite is unaffected.
- **The e2e suite is in scope only for task 14.** It needs the suite's own model
  connection (README → "Setting up tests for nojae"); tasks 01–13 do not run it and
  do not bend the app to make it pass.
- **Two tasks must not be merged into one file**: 06 and 07, and 12 and 13, stay
  separate files even though each pair is small — task 07 is where the listing's
  writes become reachable and task 13 is where the template's last condition goes.

## Task order

| # | task | spec | lands |
|---|---|---|---|
| 01 | the section is called `Servers` | T1 | the tab label, the section title, the always-`Servers` heading over the tree, the CSS block's heading comment |
| 02 | a model write never carries a credential | T2 | the reading that proves it, and the guard that keeps it true |
| 03 | the Servers section's rules become functions | T3 | `useSettingsServers.js`, every inline condition out of the template, no visual change |
| 04 | the toolbar over the tree | T4 | the three slots, the spacer, the two reserved ones, page-scoped verbs, the old verb rows gone |
| 05 | the detail strip and the model's two pages | T5 | `detailTab`, one shared `modelDraft`, samplers in three columns, a textarea that fills the column |
| 06 | the model-add path (`+`'s write) | T7 | `addModelFromListing`, expand/select/open-Settings, under the write guard |
| 07 | fetch models and the listing table | T6 | the button under the key with its gate, the `name`/`Add` table, its own scrollbar, no mid-fetch blanking, the `+` wired to 06 |
| 08 | one message band | T8 | `messageFor`, the band in the shared footer, the six old sites deleted, the `datalist` gone |
| 09 | the inline delete confirmation | T9 | the pair in the toolbar, the sentences in the band, `window.confirm` gone, cascade untouched |
| 10 | MCP and LSP save from their own toolbars | T10 | their `Save` out of the footer, their top-level lines into the band, per-row lines kept |
| 11 | keyboard and focus | T11 | tree rows focusable, `Fetch models` and every `+` keyboard-reachable, the strip behaving as tabs, the `+` focusing the new row |
| 12 | the narrow clamp | T12 | the `94vw` clamp checked, the collapse order decided and written down |
| 13 | the dialog decides nothing | §7.12 | the assertion that the Servers section's template holds no enablement rule, and the last inline condition removed |
| 14 | the e2e spec `11-settings-servers.spec.js` | T13 | §7 items 3–10 driven in a real browser |
| 15 | the project's own words | T14 | README, the two doc pointers |

## Where the spec's task numbers went

The spec's §8 breakdown is advisory; this table keeps a reader holding both from
confusing the two numberings.

| spec | this lot |
|---|---|
| T1 | 01 |
| T2 | 02 |
| T3 | 03 |
| T4 | 04 |
| T5 | 05 |
| T6 (the listing table) | 07 — **after** the write, so no live `+` is ever a no-op |
| T7 (the `+` write) | 06, minus the focus, which is 11 (§9.1-3) |
| T8 | 08 |
| T9 | 09 |
| T10 | 10 |
| T11 | 11 |
| T12 | 12 |
| T13 | 14 |
| T14 | 15 |
| — (spec §7.12, no task in §8) | 13 |

## How a task is finished

Do the work, leave `cd web && npm test` green (and, only in task 14, the new e2e
spec green too), and **move your own file from `todos/` into `todos/done/`**. That
move is the only acknowledgement the runner reads; it never reads the body again. A
file left in `todos/` is relaunched.
