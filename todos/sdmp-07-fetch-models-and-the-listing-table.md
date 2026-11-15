# 07 — Fetch models and the listing table

**Read first**: `docs/settings-dialog-migration-plan.md` §2.3, §2.5, §4.4 in full,
§4.7's "the fetch error + no-listing note" rows, §5.2, §6.4, §7.5, §7.6, §7.7, §8's
T6, §9.1-2, §12's "Where does the Fetch models button live?" row. Then
`web/src/composables/useAppShell.js`'s `fetchServerModels`,
`fetchedModelIdsFor`, `fetchedModelsErrorFor`, `draftKey` and the
`fetchedModelIds` / `fetchedModelsLoading` / `fetchedModelsErrors` state.
Then `todos/sdmp-00-big-picture.md`.

The server page owns its listing: `Fetch models` under the API key, and the
`name` | `Add` table it answers, scrolling inside itself. A row's `+` calls task 06's
write.

## Deliver

### 1. `Fetch models` on the server page, with its one gate

It already sits under the API key after task 04. In this task:

- Its disabled state and its `title` come from `fetchSlotFor` (task 03) and from
  nothing else — no condition in the template.
- **The gate is the server having a backend row.** An unsaved server cannot be
  listed, with the tooltip `Save the server before fetching its models.` This
  **retires the draft-only path**: `fetchServerModels` no longer dials a draft that
  has no id. It dials the URL and key of the row being edited, which, because of the
  gate, is always a saved server's. Keep the request itself as it is —
  `GET /api/models?serverUrl=&apiKey=` with the key added only when one is set.
- While its own listing is in flight the verb reads `Fetching…` and is inert.

### 2. A re-fetch must not blank the rows before the answer

`fetchServerModels` today clears `state.fetchedModelIds[key]` *before* asking, so a
long table collapses to nothing for a second and re-grows — exactly the reflow the
layout exists to prevent. Change it: **the previous rows stay while the next answer
is in flight**, and are replaced only when it arrives.

- An **empty answer is still an answer**: it replaces the rows with an empty list.
- Today a blank URL clears the rows and returns silently. With the gate in §1 a blank
  URL is never reachable through the button, so that branch either goes or remains as
  a defensive no-op with no user-visible effect. Do not leave it as a path a click
  can reach.
- A refusal still lands in `state.fetchedModelsErrors` keyed by that row, as today.

### 3. The table

Under `Fetch models`, replacing today's `<ul class="models-fetched-list">`:

- A real table with a header row `name | Add`, one row per listed id, and in the
  `Add` cell one `+` glyph button per row.
- The `+`'s availability and tooltip are `addListingSlotFor(name, serverDraft,
  context)`'s answer (task 03): inert with `Already added` for a name that server is
  already a parent of, inert while the listing is in flight or a write is in flight,
  and live otherwise. **It stays in the DOM in every one of those states** — a column
  whose control appeared only on some rows would make the widths jump.
- Clicking it calls task 06's `addModelFromListing(name)` and nothing else. Because
  that write takes `state.settingsSaving`, a second click on another row is inert
  until it finishes.
- The table replaces the old `<ul>`; the `.models-fetched-list` rules in
  `theme.css` go with it.
- **What the page says when the table has no rows.** Today the server column shows
  `No listing yet — ask this server what it offers…` or the in-flight note, and a
  refusal as its own alert. The refusal's sentence and the empty-answer sentence
  (`This server lists no models.`) are task 08's message band. Until then, render the
  same three facts where the table sits — no listing yet, listing in flight, this
  server lists no models — as the plainest caption, and leave the refusal line where
  it is. Task 08 deletes those lines and moves the strings into the band; **do not
  invent a second wording** for any of them, and do not add a site the band's
  priority list does not already cover.

### 4. The table's own scrollbar

The table must scroll **inside itself**, with any number of names, and the detail
column must gain **no** scrollbar of its own. In a grid this needs three things
together, and two of them are easy to leave out:

- the detail column's page row is the flexible one and is declared
  `minmax(0, 1fr)`;
- the column itself carries `min-height: 0`;
- the table's own container carries a `max-height` (or is the flexible row of a
  column with the fixed parts above it) plus `overflow-y: auto`.

The same shape `.agent-modes-nav` already has, and the reason is the same one
`theme.css` gives there: the list is the grid's only flexible row, so the controls
above it never scroll away. Long names must not widen the column or force a
horizontal scrollbar; the `name` cell wraps or truncates rather than pushing the
`Add` column out.

### 5. The model page loses its copy

The model name field's `datalist` over `fetchedIds`, its duplicate fetch-error line
and its "no listing yet" note are **task 08's** to delete together with the rest of
the message sites. Do not delete them here and do not extend them; if keeping them
until task 08 leaves them reading oddly because the server page no longer offers the
listing in the same shape, delete only what task 08 would delete anyway — the
spec's own §4.4 last bullet says the `datalist` and the duplicate copy go with the
band, and deleting them here is acceptable if the model field is left a plain text
input with no leftover reference to `fetchedIds`. Say in the change which of the two
you did.

## Do not

- **Do not add a message band.** Task 08 does, with `messageFor`.
- **Do not add a fourth toolbar slot.** `Fetch models` is a page-level verb and stays
  under the API key (spec §4.3).
- **Do not focus the new model's tree row.** Task 11 owns focus; this task's `+` only
  writes and lets task 06's selection stand.
- **Do not add a route, a merge or a second listing cache.** The route answers plain
  string ids, the table is built client-side, and the answer replaces the list
  wholesale.
- **Do not touch `src/`.**

## Files

- `web/src/components/SettingsDialog.vue` — the server page: the `Fetch models`
  button's verdict binding, the table, the empty/in-flight/empty-answer captions.
- `web/src/composables/useAppShell.js` — `fetchServerModels`' no-blanking change and
  its unsaved-row retirement.
- `web/src/composables/useSettingsServers.js` — only if `fetchSlotFor` or
  `addListingSlotFor` needs a fact not in the context.
- `web/src/styles/theme.css` — this section's block: the table's rules, the scroll
  container, the removed `.models-fetched-list` rules.
- `web/tests/settingsModelsSection.test.js` — the cases that assert a fetch still
  dials a draft with no row (`fetches from a server that is not saved yet, from the
  URL being typed`) now asserts the opposite: the button is inert with its reason,
  and no request is made. The cases reading `ul.models-fetched-list li` read the
  table's `name` column instead, and the "clears a row's refusal when its next fetch
  works" case keeps its meaning.
- `web/tests/settingsListingTable.test.js` — new: the table's shape, the `+`'s
  verdicts and its write, the no-blanking rule, and the scroll container's shape at
  the level a unit test can see (the classes/rows the CSS is written against).

## Rules it must not break

- *"Configuration is edited from the UI and takes effect hot — except a hand-edit of
  `.env`, which waits for a restart."* A `+` write is hot and answers the whole tree.
- *"Every write surface is the browser's alone."* The `+` posts the settings store's
  own route; no tool or connector gains a write.
- *"`components/` and `styles/` are the widgets and the theme."* The table's look is
  in `theme.css`.
- *"Reserved geometry is the acceptance criterion, not a nice-to-have"* (spec §6.3):
  the table region holds its size, and the column gains no scrollbar.
- *"Tests stay hermetic"* — `fetch` mocked; no real endpoint is dialled, and the test
  that asserts a refusal does so from a mocked `502`.

## Depends on

Tasks 04 (the button's place and the detail column's geometry), 03 (the verdicts
this task renders) and 06 (`addModelFromListing`, which the `+` calls).

## Done when

- `Fetch models` is inert with `Save the server before fetching its models.` while
  the edited server has no id, and becomes live as soon as the row is saved; no click
  on an unsaved server reaches the network.
- The answer is a two-column table with a `name` header, an `Add` header and one `+`
  per row; a name the server already has shows an inert `+` with `Already added`.
- Clicking a live `+` posts exactly `{ name, serverId }` and lands on that model's
  Settings page (task 06's behaviour), with the parent expanded and the model
  selected.
- Re-fetching keeps the previous rows visible until the answer arrives; an empty
  answer replaces them.
- A 200-name listing scrolls inside the table and the detail column shows no
  scrollbar of its own.
- `cd web && npm test` is green.

Finish by moving this file into `todos/done/`.
