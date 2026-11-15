# 08 — One message band

**Read first**: `docs/settings-dialog-migration-plan.md` §4.7 in full (the priority
list, the six removed sites, and the MCP/LSP exception), §7.10, §8's T8, §9.1-2.
Then `web/src/composables/useAgentModes.js`'s `messageFor` and the
`.agent-modes-dialog .settings-actions` / `.agent-modes-message` rules plus their
comments in `web/src/styles/theme.css`. Then `todos/sdmp-00-big-picture.md`, whose
"The one message band" section is this task's contract.

The dialog says everything it has to say in **one reserved band at the bottom**, left
of `Close`. Every scattered message site goes.

## Deliver

### 1. `messageFor` on `useSettingsServers.js`

One exported function, answering `{ text, role }`, always an object so the band is a
slot that is always there (an empty `text` means nothing to say; filling or emptying
it reflows nothing). The role is part of the answer: `alert` for a failure or a
refusal, `status` for progress and for the incomplete-form / refused-action sentence.
The dialog therefore needs no class-choosing condition of its own.

It reads the state it judges from the same facts the slot verdicts take, plus the
section's own fields, and applies **exactly this priority, never recency** (spec §4.7):

1. a write in flight → `Saving…`, `status`
2. a model listing in flight → `Listing this server's models…`, `status`
3. a refusal from the store / an unusable store → `state.storeState.sentence`,
   verbatim, `alert` — it already names what is wrong, so it is neither translated
   nor prefixed
4. this section's write failure → `state.serversError`, `alert`
5. the fetch refusal for the row being edited → `fetchedModelsErrorFor`'s answer,
   `alert`
6. a refused action explained → `alert` when it is the store's or a name the server
   already has; `status` for an incomplete form. Task 03's `saveRefusalFor` is where
   the incomplete-form sentence comes from; **task 09 adds the delete sentence here**
   and nothing else about this rung changes
7. a read failure → `state.settingsError`, then `state.serversError`, `alert`
8. the read's findings, joined as **one** message with ` · `, `alert` — this is where
   an empty listing's `This server lists no models.` sits, and where the store's
   "no model is configured yet" sentence sits, both as findings rather than as
   separate banner lines
9. the cross-store line → `unassignedLine(state.unassigned)` plus the band's
   affordance to open the Agent-modes dialog, `status`

Notes the implementation must respect:

- `state.serversError` carries both a write's and a read's failure; the write's is
  rung 4 and the read's is rung 7. If both are set, the write's is the one said —
  that is what the ordering above means, and it must be honored, not re-derived.
- Rung 9's line is **still a button** that opens the Agent-modes dialog, which closes
  this one on the way (today's `requestAgentModes` behaviour, unchanged). The band
  therefore needs to know whether what it is showing is that actionable line: answer
  it in the same object (`actionable: true`, or an equivalent named field) rather
  than a second condition in the template.

### 2. The band

- In the shared footer (`<footer class="settings-actions">`), the message area
  **stretches to the row left of `Close`**, exactly the shape the Agents card has:
  scoped through `.settings-dialog` the way `.agent-modes-dialog .settings-actions`
  and `.agent-modes-message` are scoped through their card. Reuse the
  `agent-modes-message` class if it lands identically, or add an equivalently
  documented class for this card — but do not restate the shared geometry twice.
- It is **always rendered**: an empty band and a filled band are the same box, so
  `Close` never moves.
- Its `role` is the answer's `role`; its colour follows the role the way
  `.agent-modes-message[role='alert']` does.
- `Close` stays the footer's **only** verb (the MCP/LSP `Save` buttons move out in
  task 10; if this task lands first, leave them alone — this task touches the Servers
  section's messages only).

### 3. The six sites are deleted

Delete all of these from `SettingsDialog.vue`, their content now coming from the
band:

| today | where it sits now |
|---|---|
| `state.settingsError` | the alert under the `<header>` |
| `storeNotice` (and its `computed`) | above the master–detail |
| `state.serversError` | above the master–detail |
| the unassigned line (and its `computed`) | above the master–detail |
| the fetch error and the "no listing yet" / in-flight note under the server's page | inside the server page |
| **the same** fetch error and note under the model-name field | inside the model page |
| `Save the server before adding a model to it.` | inside the server page (deleted in task 04 if it was still there) |

Also delete, with them:

- the model name field's `datalist` over `fetchedIds` and the `fetchedIds` computed
  (if task 07 has not already: spec §4.4's last bullet says one fact said once, and
  the listing now lives on the server page). The field becomes a plain text input.
- the in-page captions task 07 added for the table's three facts — the band says them
  now — **except** nothing that describes a row's own state (a row's refusal is rung
  5 of the band, and the table itself stays where it is).
- `storeNotice`'s "No model is configured yet…" sentence: it is rung 8's finding when
  the store is usable and holds no models. Keep the wording; do not paraphrase it.

**MCP and LSP are untouched in this task.** Their per-row badges and per-row errors
stay, and their top-level lines stay until task 10 (which is scoped `T10` and depends
on this task). Do not move them here.

### 4. The tests

- New `web/tests/settingsMessageBand.test.js`: one case per rung of the priority
  list, each asserting `{ text, role }`, plus two cases that prove the priority is
  fixed rather than recent — set a write in flight *and* a read failure and expect
  the write's word; set a fetch refusal *and* a read failure and expect the fetch
  refusal. Include: an empty answer's `This server lists no models.`; the store's
  unusable sentence shown **verbatim**; the unassigned line answered as actionable
  with the count sentence.
- New or extended mounted case: with each of the six old sites' conditions set in
  turn, the sentence appears **only** in the footer band, and the element that used
  to hold it is gone from the DOM. The existing `settingsWorkspaceFileNote.test.js`
  asserts that a store-level notice appears inside
  `.settings-editor > section` — retarget it to the band, keeping what it asserts
  (the sentence is verbatim, the server's, and nothing is invented) and dropping only
  where it sits.
- A band-height case: the band holds `Close`'s row whether it is empty or holds a
  sentence, asserted the way a unit test can (the element is present with `Close` in
  the same footer in both states, and no other footer child is added when it fills).

## Do not

- **Do not move MCP's or LSP's lines.** Task 10 does, from this band's shape.
- **Do not add the delete sentence's presence** to rung 6 — task 09 does; here it
  exists only if task 03 already had a way to say it. What must be true after this
  task is the **priority list** and the **one site**.
- **Do not change `requestAgentModes`.** The band's actionable line calls it.
- **Do not add a second band, a toast, a stack or a log.** One box, one message.
- **Do not touch `src/`.**

## Files

- `web/src/composables/useSettingsServers.js` — `messageFor` and whatever field makes
  rung 9 actionable.
- `web/src/components/SettingsDialog.vue` — the band in the footer, the six sites
  removed, the `storeNotice` / `unassignedNote` / `fetchedIds` computeds removed with
  them, the `datalist` removed if task 07 did not.
- `web/src/styles/theme.css` — this section's block: the band's scoping, and the
  removal of any rule left styling a deleted site (`.models-unassigned`,
  `.models-unassigned-link` if nothing else uses them, the alert rules used only
  here).
- `web/tests/settingsMessageBand.test.js` — new.
- `web/tests/settingsWorkspaceFileNote.test.js` — retargeted to the band.
- `web/tests/settingsModelsSection.test.js` — its "the unassigned count line" cases
  now find the link in the footer band and still assert the count, the request and the
  dialog stepping aside; its fetch-refusal cases now read the band.

## Rules it must not break

- *"SSE is the UI's only source of truth … Each stream has its own channel and closes
  with exactly one terminal event."* Nothing here is a stream; the band draws client
  state that the composables already hold.
- *"Every write surface is the browser's alone."* Unchanged.
- *"`components/` and `styles/` are the widgets and the theme."* The band's geometry
  lives in `theme.css`, scoped through `.settings-dialog`.
- *"A form with a problem does not disable Save. The click is refused and the reason
  lands in the message band."* This task is where that reason finally has its home;
  the click refusal itself is wired here for the save slot, using `saveRefusalFor`.
- *"MCP and LSP keep their per-row badges and per-row errors"* — reinforced above as
  a Do-not.
- *"Tests stay hermetic"* — every case mounts with a mocked `fetch`.

## Depends on

Tasks 03 (`saveRefusalFor` and the slot verdicts), 05 (the model page's two
sub-pages, both of whose message sites this task removes) and 07 (the in-page
captions this task deletes).

## Done when

- The footer holds one message area left of `Close`, always present, its text and its
  `role` both `messageFor`'s answer.
- Each rung of the priority list is reachable and asserted, and the two
  priority-over-recency cases pass.
- None of the six old message sites exists any more: searching
  `SettingsDialog.vue` for `settingsError`, `serversError`, `unassigned` and
  `storeNotice` finds nothing outside the footer band's own bindings.
- The model name field is a plain text input with no `datalist`.
- The MCP and LSP panels still show their per-row badges and per-row errors, and
  their top-level lines are still where task 10 will find them.
- `cd web && npm test` is green.

Finish by moving this file into `todos/done/`.
