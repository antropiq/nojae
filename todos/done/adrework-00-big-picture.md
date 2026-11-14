# Lot: Agents dialog — toolbar-driven editing

**The spec is `docs/agents-dialog-rework.md`. It is binding: every question it
raised is answered there (§8), and this file only maps the work.** Read the
sections your task cites before you write anything. The mockup is
`docs/imgs/dialog-agents.png`.

## What we end with

One existing card (`web/src/components/AgentModesDialog.vue`) gets the shape every
list-plus-form editor has: **one toolbar over the list holding the three verbs**,
and **one `Close`** in the footer. Among other things this lot removes the card's
five separate message sites and replaces them with **one reserved message line**.

Nothing else moves:

- **No new route, no backend change, no store change.** The three writes
  (`/api/agents/add`, `/api/agents/save`, `/api/agents/delete`) keep their shapes
  and their refusals, and each still answers the whole new list — which is how the
  card re-baselines on the store rather than on what it sent.
- **No change to what an agent does to a chat turn**, to when the card can be
  opened, or to the pencil's own label, enablement and mount point (§7).
- **No icon package.** The five toolbar glyphs are inline stroke SVGs, as every
  icon the app owns already is (D1, Q6).
- **One behavioural change beyond layout**: an incomplete form no longer disables
  `Save`. The click is refused and its reason goes in the card's one message line
  (D11). Everything else here moves controls, wording and state.

The rules composable (`web/src/composables/useAgentModes.js`) keeps every verdict
as a plain function and the component keeps deciding nothing — the spec's D3 says
so and an existing test asserts it. One verdict is **renamed rather than reused**
(its old answer is exactly what the rework drops, so keeping the name would keep the
lie) and a handful are new; their names are part of the contract:

| today | after |
|---|---|
| `saveDisabledFor` | `writeBlockedFor` (nothing to act on, or a write in flight — the only reasons the slot is *disabled*) **and** `saveRefusalFor` (why a click is refused, for the message line) |
| `entryProblems` | kept unchanged, read only to build `saveRefusalFor`'s sentence; nothing renders it per field |
| — | one verdict per toolbar slot: is it inert, and its reason (§5's table) |
| — | the empty new-agent form, and the creation state that goes with it (D4) |
| — | `closeWouldLoseFor`, plus the card's pending-close state (D8) |
| — | `messageFor`, the one message and how it is announced, by D11's fixed priority |
| — | the row to select after a delete: next, else previous, else none (D7.5) |

`addAgentToDraft` — the call that appended a tab and made a not-yet-stored row an
entry of the list — is **deleted with the nav's create field** (task 03): a new agent
goes straight to the write (D4). The unit cases that used it only as a fixture
("give me a new entry to judge") move to the creation-form function; the ones that
pinned the appending are deleted with it.

## The target layout (§3)

```
+----------------------------------------------------------------+
|  Agents                                                        |
+----------------------------------------------------------------+
|  [ + ]  [save]  [delete]              [ x ]  [ v ]             |
|  +----------------------------+  +--------------------------+  |
|  | Agent list                 |  | Label        Model       |  |
|  |  Chat                      |  | [________]   [ select v ] |  |
|  |  Code                      |  |                          |  |
|  |  Architect                 |  | MCP [on]   LSP [on]      |  |
|  |  Todo builder              |  |                          |  |
|  |                            |  | Max tool iterations [  ] |  |
|  |                            |  | System prompt            |  |
|  |                            |  | [______________________] |  |
|  +----------------------------+  +--------------------------+  |
+----------------------------------------------------------------+
| [ the one message line ]         [x] [v]          [ Close ]   |
+----------------------------------------------------------------+
```

The toolbar belongs to the **left column only** and never scrolls away with the
list; the two confirmation slots sit at that toolbar's right end, so they land just
left of the form. The footer band holds, left to right, the message line, a
reserved confirmation slot, then `Close`. The card keeps the size it has today, so
switching selection never resizes it.

## The decisions, one line each

The spec's word is the authority; this is the index.

- **D1 — five fixed-width toolbar slots**, three always rendered (add, save,
  delete) and two only while a delete is being confirmed. Each is an icon button
  with an accessible name **equal to its tooltip**, and a disabled slot always says
  why. Save is never disabled by an incomplete form.
- **D2 — the list is the selection, and the selection is the edit mode.** No Edit
  button, no mode. Per-agent in-memory edits survive switching rows.
- **D3 — mostly positional**, four added states (creation mode, a per-entry
  baseline, a pending close, the one message), and the save-path change above.
- **D4 — adding clears the selection, empties the form, focuses Label, and writes
  nothing.** The list gains no row; the heading still reads `Agents`; no caption,
  banner or badge appears. A new agent is not an entry until it is saved.
- **D5 — add is live whenever the list is loaded**, inert only while a write is in
  flight and while already in creation mode (both stated in its tooltip).
- **D6 — saving does not close the card.** It writes exactly one agent (the
  selected one), re-baselines, keeps the saved agent selected, and leaves other
  agents' unsaved edits alone. A refused save keeps the card open with the store's
  own sentence.
- **D7 — delete asks inline, in the toolbar's right slots, after the click.** No
  sentence, no label: the pair's presence is the question and its two tooltips are
  the answers. Focus lands on **Cancel**. Cancel restores nothing (nothing was
  written); confirm selects the **next** row, else the **previous**, else nothing;
  moving the selection cancels the pending confirmation.
- **D8 — `Close` is the only way out and it asks in place** when anything would be
  lost. The footer's reserved slot holds `Keep editing` / `Discard and close`.
  Escape and a backdrop click count as `Close` in every respect.
- **D9 — the title is `Agents`, in every state**, and the accessible name follows
  it. How the card opens is unchanged.
- **D10 — nothing appears or disappears in a way that moves the layout.** The test
  to apply to any new affordance: *if this appears while the pointer is already
  moving toward something, what moved?*
- **D11 — every message lives in one reserved line**, bottom-left, on `Close`'s
  horizontal band, by a fixed priority: a write in flight, then a store refusal,
  then the incomplete-form message, then a read failure, then the read's findings.
  `role="alert"` for a refusal or failure, `role="status"` for progress and the
  incomplete-form sentence. It is never a tooltip's replacement and it clears when
  its cause goes away.

Nothing here widens an agent. `AGENTS.md`'s rule stands untouched: an agent "only
ever narrows what settings and the conversation already allow". The README's summary
of the card — that it "holds the personas the composer offers" — stays true too, and
task 08 only brings its description of the *controls* up to date.

## Invariants that hold in EVERY task, including the intermediate ones

Quoted from this project's instructions; a task that breaks one is not done.

- **No backend work at all.** "Core owns logic, the API owns transport"; "nothing
  under `core` may import the API layer". This lot touches `web/` and documents
  only. A task that finds itself editing `src/` has misread its file.
- **"Core owns logic, the API owns transport"** applied to the frontend: the spec's
  D3 — *the component decides nothing*. Every verdict is a plain function in the
  composable; a condition spelled in the template is a defect even when it is
  right.
- **"`composables/` hold app-shell and stream state and own each live stream and
  its abort; components use them directly."** The card keeps reading the editor
  state and the write calls through the composable, and through no route of its
  own (a scan asserts the component spells no `/api/`).
- **"`lib/` holds the single markdown renderer — all rendered HTML goes through it,
  never raw `v-html`."** The message line, the tooltips and the list render text
  only. `v-html` stays absent from this component.
- **"Every write surface is the browser's alone** — the Editor's file routes and the
  settings-store routes — and the file ones are refused while a chat reply
  streams." This lot adds no write surface: the three agent routes are used exactly
  as they are today.
- **"Tests stay hermetic**: no test reads a real model connection, reaches a live
  hub or opens the install's settings store — the hubs are disabled by an
  environment flag and each test runs on a temporary store of its own." The e2e
  spec still names no real connection; it reads the suite's own temporary store
  through `/api/agents` and sweeps the rows it created.
- **"The tree's per-file-type icons are **generated**: edit the source tables and
  regenerate, never hand-edit the artifacts."** The five toolbar glyphs are **not**
  file-type icons and do not go in those tables: they are inline SVGs in the
  component, in the house style (`SoundToggle.vue` / `ThemeToggle.vue`), marked
  decorative, coloured from the theme tokens. Regenerating the tree's icon
  artifacts is out of scope.
- **`web/src` names no reserved agent id, and the client recognises the app-owned
  agent by a flag.** No sentence in `AGENTS.md` states this one; two tests do:
  the scan in `tests/test_write_surface_isolation.py` and the source scan in
  `web/tests/agentModes.test.js` (which also forbids an `id === '…'` comparison in
  this component and its composable). `readonly` and `deletable` are the whole
  vocabulary, and a new toolbar verb is disabled by a **flag**, never by comparing
  an id.
- **No cap, count or number is spelled in the client**: the persona byte cap, the
  id pattern and length, and the tool-loop floor all arrive in the payload's `caps`.

## Task order

| # | task | lands |
|---|---|---|
| 01 | the one message line, and Save that refuses instead of disappearing | D11's five sites collapse into one; the `writeBlockedFor` / `saveRefusalFor` split |
| 02 | the verdicts the toolbar will need: every §5 row, the baseline, the successor | slot availability as composable functions, still unwired |
| 03 | the toolbar over the list: add, save, house glyphs, `Agents` title, creation mode, save stays open | D1, D2, D4, D5, D6, D9; the nav's label field goes |
| 04 | delete as a toolbar verb with its inline confirmation | D7; the form's delete block goes |
| 05 | the close guard behind the `Close` task 03 landed | D8 |
| 06 | the geometry sweep, the accessible names, and the card's dead CSS | D10, §3, §5's closing rules, §6's stability items |
| 07 | the e2e spec | §9's selector table and its two new assertions |
| 08 | the README and `AGENTS.md` | §9's docs table |
| 09 | the acceptance sweep | §6's twenty items, asserted |

## Interim states, and the one accepted red

- **Suite state per task.** `pytest` and `cd web && npm test` are **green at the end
  of every task** — each task updates the unit tests its change invalidates in the
  same change. Read the README for the commands; do not invent them.
- **The e2e suite is red from 03 until 07, by design.** `web/e2e/04-agent-modes.spec.js`
  drives exactly the affordances 03–05 move: its close helper clicks `Cancel`, it
  creates through the nav's label field, it saves through the footer's `Save`, and
  it reads messages that move and a card that used to close after a save. It is
  rewritten **once**, in 07, after the UI has settled — not piecemeal, and no task
  between 03 and 06 may "fix" it by adding compatibility hooks to the component
  (an old class kept alongside a new one, a hidden `Cancel`, a second message).
  Tasks 03–06 therefore do not run it, and say so.
- **After 02, before 03**: the slot verdicts exist and are exercised, and the card
  still calls only the two it already needed. The rest are wired by 03–05. Do not
  leave a verdict with no caller at the end of 05.
- **After 03, before 05**: `Close` already sits in the footer where `Cancel` was —
  both close and write nothing, so nothing regresses, and `Cancel` is **replaced**,
  never kept beside the new button. What is missing for one task is the guard: a
  card holding unsaved work still closes without asking. The guard is `Close`'s
  whole point once it is the only exit, so it lands in the very next task. Do not
  ship the lot without it.

## Two apparent tensions, resolved here so no task has to re-decide them

- **The baseline is not a dirty test on Save (Q2 dropped, D8).** A per-entry
  baseline exists *only* to answer "would closing lose something?", and must never
  leak into the save slot's enablement. The one exception is the **app-owned row**
  (§5), where the model is the only field the user owns: there, save stays inert
  until that one field actually changes, because a save that could only rewrite
  what is already stored has nothing to offer. That is a rule about one row's one
  field, not a general "dirty" gate — keep the two apart.
- **"No caption line in the right column" (§3) is not a deletion order.** The
  `readonly` explanation, the persona's byte counter and the quiet model line are
  **field rules**, and §7 keeps every field rule unchanged; D4 relies on the model
  line. They stay. What §3 forbids is a caption that announces the card's *state*
  (creation mode, a pending confirmation), and D11's five message sites are the
  only messages that move into the message line.

## How a task is finished

Write the change, leave the two hermetic suites green (the e2e exception above),
and **move your own file from `todos/` into `todos/done/`**. That move is the only
acknowledgement the runner reads — it never reads the body again. A file left in
`todos/` is relaunched.
