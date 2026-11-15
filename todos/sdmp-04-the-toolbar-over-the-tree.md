# 04 — The toolbar over the tree

**Read first**: `docs/settings-dialog-migration-plan.md` §4.3, §5.1, §6.2, §6.3,
§7.3, §7.4, §8's T4. Then `web/src/components/AgentModesDialog.vue`'s toolbar block
and the `-- agent-modes dialog` block in `web/src/styles/theme.css` (the slot rules
and the note on Pico's `[role="group"] button { width: auto }` trap). Then
`todos/sdmp-00-big-picture.md`, whose "The toolbar, stated once" section is this
task's contract.

The section's verbs leave both forms and the bottom of the detail column and become
**one toolbar over the tree**: three fixed slots, a flexible spacer, two reserved
slots for the confirmation pair. Each verb acts on **the page that is visible**.

## Deliver

### 1. The toolbar

Above the tree, in the left column, under the always-`Servers` heading task 01
added:

- **Three slots, in this order**: add, save, delete. Fixed width, glyph buttons,
  each with `:title` **and** `:aria-label` bound to the same `label` value its
  verdict answered (task 03) — one value read as both, never a second field.
- **A flexible spacer** whose only job is to push the next two slots to the right
  end of the left column.
- **Two more fixed slots**, always present and always the same width, empty until a
  confirmation pair is rendered in them. The pair itself arrives in task 09; in
  this task the slots are reserved and hold nothing, which is what makes task 09's
  arrival move nothing.
- The toolbar keeps its height and its position in **every** state in spec §5.1,
  including while a write is in flight and while a listing of any length is loaded.
- Its glyphs are the house icons: a plus for add, the save/floppy for save, the bin
  for delete — the same three shapes the Agents card uses, so the two dialogs do not
  teach two vocabularies.

**Shared classes, not new geometry.** Use the slot and toolbar classes the Agents
card already has (`agent-modes-toolbar`, `agent-modes-slot`,
`agent-modes-toolbar-space`, and the slot-scoped `.icon-btn` reset that survives Pico
— see the comment above `.agent-modes-slot .icon-btn`). Where a rule is needed only
for this card, add it **scoped through `.settings-dialog`**, beside this section's
block in `theme.css`; do not restate a shared rule and do not edit the Agents card's
block. If reusing the `agent-modes-*` names verbatim reads badly for a second card,
add a short note in `theme.css` saying the two share them on purpose — the file
already documents shared classes that way.

### 2. The verbs, scoped to the visible page

- **add**: on the server page, a new server (an empty form, **nothing written** —
  `addServerRow` as today); on a model page, a new model under the selected server
  (`addModelRow` as today). With no selection, a new server.
- **save**: saves the server on the server page, the model on the model page.
- **delete**: deletes the server on the server page — **and, as today, the models
  under it** — and the model on the model page. The `window.confirm` stays until
  task 09; this task only moves the button that asks it.
- **No label spells the scope.** The three read `Add`, `Save`, `Delete` in both
  states; the visible page is the scope (spec §4.3).

### 3. The verbs leave the forms, and the old rows go

Remove, as controls, all of:

- `Save model` / `Remove model` at the foot of the model form;
- `Save server` / `Remove server` at the foot of the server form;
- `Add server` / `Add model` at the bottom of the detail column;
- the `Save the server before adding a model to it.` caption under the server's
  buttons — its rule is now `fetchSlotFor`'s inert reason (task 03) and its
  sentence is the band's (task 08). Do not print it twice meanwhile: it goes.
- the CSS rules that styled those rows (`.models-detail-actions`, `.models-add`), with
  the controls they styled. `Fetch models` was one of those buttons and stays one, so
  either keep a rule for the row it now sits in under the API key or give it its own;
  do not leave a rule styling a control that no longer exists.

**Keep `Fetch models`.** It must not be deleted with the row around it: it stays the
server page's own button, and in this task it sits where the mockups put it — under
the API key field, at the end of the server's fields, still a text-labelled button
reading `Fetch models`. Its gate is `fetchSlotFor`'s answer, already written in task
03 (the "save the server first" reason becomes live as soon as the row exists). The
listing it answers keeps today's shape in this task; the table is task 07.

### 4. The geometry

The Servers section's body adopts the Agents card's shape rather than inventing one:
the heading, the toolbar and the tree take the left column's three rows
(`auto auto minmax(0, 1fr)`), and the tree's row is the only flexible one, so the
tree scrolls in its own bounded area and the toolbar above it never scrolls away.
The detail column sits beside them, spanning the toolbar's row and the tree's. The
right column keeps its own vertical room for its page body (task 05 puts the detail
strip at its top and splits the rest from it). No wrapper element may be introduced
in a way that lets the toolbar scroll with the tree.

**Nothing in this task may change the fixed card size** (`900×600`, clamped to
`94vw`) or the dialog element's own sizing.


## Do not

- **Do not add the detail tab strip** (task 05), **the listing table** (task 07) or
  **the message band** (task 08).
- **Do not replace `window.confirm`** (task 09) and do not render the confirmation
  pair: reserve its two slots and fill them in task 09.
- **Do not invent a verdict in the template.** If a new condition is needed, it
  belongs in `useSettingsServers.js`.
- **Do not touch `src/`.**

## Files

- `web/src/components/SettingsDialog.vue` — the Servers section's markup: the new
  toolbar, the removed verb rows, `Fetch models`' new place under the API key.
- `web/src/styles/theme.css` — this section's block: the body's grid placement, the
  scoped slot rules if any, and the removal of `.models-detail-actions` /
  `.models-add`.
- `web/src/composables/useSettingsServers.js` — only if a verdict is missing a fact
  the toolbar needs (extend it, do not bypass it).
- `web/tests/settingsModelsSection.test.js`, `web/tests/settingsServersRules.test.js`
  — the cases that reached a control by its old text (`Remove server`,
  `Remove model`, the `Add server` pair, `Fetch models` by its old title) now reach
  it in the toolbar, by its verdict's label; plus one case asserting the toolbar
  holds five reserved slot boxes in every state, including with no server
  configured.

## Rules it must not break

- *"`components/` and `styles/` are the widgets and the theme."* The toolbar's look
  lives in `theme.css`; no scoped style block in the component.
- *"Configuration is edited from the UI and takes effect hot."* Every verb still
  writes through the composable's existing calls; the answer is still the whole
  tree, adopted wholesale.
- *"A form with a problem does not disable Save. The click is refused and the reason
  lands in the message band. Taking the button away hides the answer."* The save
  slot stays live for an incomplete form in this task; the refusal is said where
  `state.serversError` is said today (the band arrives in task 08).
- *"Every write surface is the browser's alone."* No new write, no new route: the
  same three server routes and three model routes.
- *"The connectors answer the workspace level for their own root"* — untouched; this
  dialog edits the installation's store, not a workspace file.
- *"Tests stay hermetic"* — mounted cases mock `fetch`.

## Depends on

Task 03 (the verdicts the toolbar renders).

## Done when

- The tree has one toolbar above it holding exactly five fixed slot boxes in every
  state, three of which hold the add/save/delete glyphs, and two of which are empty
  until task 09.
- Every one of those three controls carries a `title` **and** an `aria-label` equal
  to its verdict's `label`, in both the live and the inert state.
- Neither form and no column carries a Save or a Remove control any more, and the
  `Add server` / `Add model` pair is gone.
- `Fetch models` is still present and now sits under the API key field on the server
  page.
- With no server configured at all, the toolbar is present, correctly sized, and
  reports its state through its slots rather than vanishing.
- The tree scrolls in its own area; the toolbar above it does not scroll away.
- `cd web && npm test` is green.

Finish by moving this file into `todos/done/`.
