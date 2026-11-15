# 03 — The Servers section's rules become functions

**Read first**: `docs/settings-dialog-migration-plan.md` §4.3 (the "rules that hold
across that table"), §5.1, §5.2, §6.1 ("Extract a rules composable, don't add one
more component"), §7.12, §8's T3. Then
`web/src/composables/useAgentModes.js` — its `slotLive` / `slotInert` /
`slotContext`, `addSlotFor`, `saveSlotFor`, `deleteSlotFor`,
`deleteConfirmationFor`, `messageFor` — which is the pattern to copy.
Then `todos/sdmp-00-big-picture.md`.

Today this dialog writes its enablement conditions **in the template**:
`state.settingsSaving`, `state.serverDraft.id === null`,
`state.modelDraft.id !== null`, `state.fetchedModelsLoading === draftKey(...)`,
`state.selectedServerId === null`. This task moves every one of them into plain
exported functions and leaves the template rendering answers. **No layout changes,
no wording of a visible label changes, and no new control appears** — the toolbar
that consumes these verdicts is task 04.

## Deliver

### 1. The new module: `web/src/composables/useSettingsServers.js`

Plain exported functions, no component, no state of its own. Each verdict answers
`{ disabled, label }`: `label` is the control's name when it is live and **the reason
it is inert when it is not**, because one value read as both is what stops a label
drifting from an enablement (spec §4.3, §6.1). Restate `slotLive` / `slotInert` /
`slotContext` **inside this module** — `useAgentModes.js` does not export them and
must not be made to, because a shared private becomes a second authority.

Every function takes the state facts it judges as **one `context` object** (the
pattern `useAgentModes` uses) and, where a row is involved, that row's draft. The
component builds the context from `state` in a computed and passes nothing else —
that keeps the template free of conditions.

The context carries exactly these facts, all read from `useAppShell`'s `state`:
`loaded` (the servers read answered and did not fail), `saving`
(`state.settingsSaving`), `confirming` (a delete confirmation is pending — task 09
adds the flag; until then it is simply absent and reads falsy), and `listing`
(`state.fetchedModelsLoading`).

The exports, and what each judges:

- **`addSlotFor(draft, context)`** — the add verb. Inert when the read is not
  loaded (`The servers have not been read.`), when a write is in flight
  (`A write is in flight — wait for it to finish.`), when a confirmation is pending
  (`A confirmation is pending — answer it first.`), and when a **new server** is
  already being typed (`A new server is being typed — save it or select a server.`).
  Live and labelled `Add` otherwise — including when a model page is visible, where
  it means *new model under this server* (spec §4.3).
- **`saveSlotFor(subject, context)`** — the save verb. Labelled `Saving…` and inert
  while a write is in flight; inert when the read is not loaded; inert with
  `Nothing is selected to save.` when no row at all is showing; inert with
  `A confirmation is pending — answer it first.` while one is. Live and labelled
  `Save` otherwise. **A form with a problem does not land here** (spec §4.3): the
  click refuses and the message band says why, so no verdict may encode an
  incomplete-field test.
- **`deleteSlotFor(subject, context)`** — the delete verb. Inert when the read is
  not loaded; inert with `Nothing is selected to delete.` when no row is showing;
  inert with `Save the server before it can be deleted.` while a new **server** is
  being typed; inert with `Save the model before it can be deleted.` while a new
  **model** draft is showing; inert while a write is in flight; inert while a
  confirmation is pending. Live and labelled `Delete` for a saved server and a saved
  model — and **no parent guard**: a server that still has models is deletable
  (spec §4.8; the cascade is the schema's).
- **`deleteConfirmationFor(subject, context)`** — `{ rendered, cancel, confirm }`,
  each of the two answered like a slot. `rendered` is true only while a confirmation
  is pending *and* the subject is a row delete can remove; the pair is **absent from
  the DOM** otherwise, never hidden. Labels `Cancel delete` and `Confirm delete`; a
  write in flight makes both inert rather than queueing them.
- **`fetchSlotFor(serverDraft, context)`** — `Fetch models`. Inert with
  `Save the server before fetching its models.` when the draft has **no id** — this
  is the one gate that covers fetching and adding together (spec §4.4), and it is
  the dialog's existing "Save the server before adding a model to it" rule turned
  from a sentence into a disabled control. Inert with
  `This server has no URL yet, so there is nothing to ask.` when the URL field is
  empty. Inert and labelled `Fetching…` while this row's own listing is in flight.
  Inert while a write is in flight. Live and labelled `Fetch models` otherwise.
- **`addListingSlotFor(name, serverDraft, context)`** — one row's `+` in the listing
  table (task 07 renders it). Inert with `Already added` when that server already
  has a child model of that name — a comparison against the tree the client already
  holds, and no new route. Inert while this row's listing is in flight
  (`This server's models are still being listed.`), while a write is in flight, and
  while a confirmation is pending. Live and labelled `Add <name>` otherwise. It is
  inert, never absent, for the reason the toolbar's slots are: a column whose
  control appeared only on some rows would make the table's widths jump.
- **`saveRefusalFor(subject, draft)`** — why a **click** on the live save slot is
  refused, as one sentence naming what is missing, or `null` when the form may be
  written. This is the answer the message band says (spec §4.3: "the click is
  refused and the reason lands in the message band"), and it is here rather than in
  the template for the same reason every other verdict is. It judges only the
  fields the server would refuse: a server needs a **name** and a **URL that starts
  with `http://` or `https://`** (`GET /api/models` and the store both refuse
  otherwise); a model needs a **name**. A sampler outside its bound is the same
  kind of answer — name the field and its bound, read from `samplerBounds`. It
  returns `null` for a complete form, and it is **not** read by any slot verdict:
  `saveSlotFor` stays live for a form with a problem, which is the whole point.

Every sentence above is fixed **here**, so tasks 04, 07, 08 and 09 render these
strings instead of inventing their own variants.

### 2. The template renders the verdicts

Replace every inline enablement condition in the Servers section with a verdict —
for the controls that exist today:

- the two save buttons (`Save model`, `Save server`) → `saveSlotFor`;
- the two remove buttons (`Remove model`, `Remove server`) → `deleteSlotFor`, and
  both `v-if="…id !== null"` guards with the verdict's own inert answer, so a row
  that cannot be deleted shows why instead of vanishing;
- `Fetch models` → `fetchSlotFor`;
- `Add server` / `Add model` → `addSlotFor`. `Add model`'s old
  `state.selectedServerId === null` refusal is now part of `addSlotFor`'s answer;
- **`window.confirm` stays** for now: task 09 replaces it. Do not add the
  confirmation pair here, but do build `deleteConfirmationFor` so task 09 has
  nothing to design.

Bind each verdict's `disabled` to the control and its `label` to that control's
`title` (and, where the control is a glyph, its accessible name — task 04). A text
button keeps its visible text in this task, so nothing a user sees changes except a
tooltip that now explains an inert control.

### 3. The tests

Extend `web/tests/settingsModelsSection.test.js` — or add
`web/tests/settingsServersRules.test.js`, whichever reads better; the verdicts
themselves belong in a file a reader can find by name — with one case per row of
spec §5.1 and §5.2:

- every slot in every situation that table lists, asserted as
  `{ disabled, label }`, including the exact reason strings above;
- the confirmation pair absent (not merely disabled) while nothing is pending;
- `deleteSlotFor` live on a server that still has models — the parent-guard
  assertion, so a later "tidier" change cannot add one;
- no verdict's inert answer mentions an incomplete field, i.e. `saveSlotFor` is
  live for a draft with an empty name and an empty URL. Assert it by giving the
  verdict such a draft and expecting `disabled === false`;
- `saveRefusalFor` answers `null` for a complete server and a complete model, and a
  sentence naming the field for a blank name, a URL that is not `http(s)://…`, and a
  sampler below or above its bound from `samplerBounds`.

Keep the mounted-dialog cases the file already has green by updating how they reach
a control (their `Remove server` / `Remove model` buttons are now never absent).

## Do not

- **Do not build the toolbar, the detail strip, the listing table or the message
  band.** Tasks 04, 05, 07 and 08 do.
- **Do not write `messageFor`** — task 08 does, once.
- **Do not change `useAgentModes.js`.** Its functions are the model, not a
  dependency.
- **Do not touch `src/`.**

## Files

- `web/src/composables/useSettingsServers.js` — new: the ctx helpers, the six slot
  verdicts and the save-refusal sentence.
- `web/src/components/SettingsDialog.vue` — the Servers section's `<script setup>`
  imports and the five condition sites in its template.
- `web/tests/settingsServersRules.test.js` (or the existing
  `settingsModelsSection.test.js`) — the verdict cases and the parent-guard case.
- `web/src/composables/useAppShell.js` — **only** if a fact the verdicts need is not
  already on `state`. Prefer reading what is there; do not add state this task does
  not need.

## Rules it must not break

- *"composables/ hold app-shell and stream state and own each live stream and its
  abort; components use them directly."* The verdicts are a composable's plain
  functions; the component imports them.
- *"Core owns logic, the API owns transport."* These rules are client rules about
  controls; no route is consulted and none is added.
- *"A form with a problem does not disable Save. The click is refused and the reason
  lands in the message band. Taking the button away hides the answer."* Encoded
  above as the "no incomplete-field test" rule, and asserted.
- *"Tools are read-only by design."* Nothing here reaches a connector or a tool;
  `tests/test_write_surface_isolation.py` is untouched.
- *"Tests stay hermetic"* — a verdict test mounts nothing and mocks no route, and a
  mounted case mocks `fetch`.

## Depends on

Tasks 01 and 02.

## Done when

- `web/src/composables/useSettingsServers.js` exists and exports exactly
  `addSlotFor`, `saveSlotFor`, `deleteSlotFor`, `deleteConfirmationFor`,
  `fetchSlotFor`, `addListingSlotFor` — each returning `{ disabled, label }` (or,
  for the confirmation, the object described above) — plus `saveRefusalFor`, which
  returns a sentence or `null`.
- `grep -n 'settingsSaving' web/src/components/SettingsDialog.vue` finds no hit in
  the Servers section's template — the condition lives in the verdict.
- Every reason string above appears in the module and nowhere else in the
  component.
- The dialog looks and behaves as it did, including a server with models being
  deletable and a form with a problem still offering its Save.
- `cd web && npm test` is green.

Finish by moving this file into `todos/done/`.
