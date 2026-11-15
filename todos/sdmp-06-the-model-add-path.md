# 06 — The model-add path: `+` writes the row

**Read first**: `docs/settings-dialog-migration-plan.md` §2.7, §4.4 (the "`+` writes
the row (decided)" and "A name the server already has" bullets), §4.6, §7.7, §8's
T7, §9.1-3, §12's "Does `+` write, or stage a draft?" row. Then
`web/src/composables/useAppShell.js`'s `postConnectionWrite`, `adoptServers`,
`selectModel`, `toggleServerExpanded`. Then `todos/sdmp-00-big-picture.md`.

This task puts the **write** behind the listing's `+` in place now, so the table that
lands in task 07 has a live action from its first render. Nothing renders the `+`
column yet; the composable function and its tests are the deliverable. The focusing
half of spec §9.1-3 is task 11's.

## Deliver

### 1. `addModelFromListing(name)` on `useAppShell`

One function, exported from the composable's return object beside the other writes:

- Subjects: the **selected server's** row, and the listed `name` handed to it.
- Posts **`{ name, serverId }` and nothing else** to `POST /api/models/add`. The six
  samplers are omitted, their columns stay null, and the model runs on the endpoint's
  own defaults until someone edits them (spec §4.4). Do not reuse
  `modelWritePayload` here — that would send `sysPrompt: ''`, `reasoning: null`,
  `supportsVision: false` and six explicit nulls, which is a different body and a
  different claim about "unset".
- It goes through the **same in-flight guard as Save and Delete**: it sets
  `state.settingsSaving` for the duration, the way `postConnectionWrite` does, so a
  second click on another row waits rather than racing (spec §4.4). Reuse
  `postConnectionWrite` if its shape allows the different body; if it does not, add
  the guard around the call rather than a second copy of the error handling.
- On failure, the store's refusal lands in `state.serversError`, which is where a
  write failure is reported (the band is task 08's).
- On success the write answers the **whole tree**, which `adoptServers` already
  adopts wholesale, so there is no merge: then
  - **expand the parent** (it must be open in the tree),
  - **select the new model** — found in the answered tree by its name under that
    server, the way `saveModelDraft` already looks a saved row up in the tree the
    write answered,
  - **set `state.detailTab` to `settings`** through task 05's setter, so the model's
    Settings page is what appears. Do **not** focus the row here; task 11 does.
- It returns enough for its caller to know it happened (a boolean, as
  `postConnectionWrite` does), and it does nothing at all when the selected server
  has no id or the name is empty.

### 2. The path from the server page

`addModelFromListing` is called from the listing table (task 07). Write the tests now
so a reader can see the contract, and leave the UI call to task 07 — that is the one
place this task names a function no template calls yet.

### 3. The tests

New `web/tests/settingsAddModel.test.js`, with `fetch` mocked to answer the whole
tree:

1. The posted body is **exactly** `{ name, serverId }` — assert the parsed body's key
   set, not a `toMatchObject`, so a sampler sneaking in fails.
2. The route is `POST /api/models/add`.
3. The parent is expanded afterwards and the new model is the selection
   (`state.selectedModelId` is the id the answered tree gave it).
4. `state.detailTab` is `settings` afterwards, whatever it was before.
5. The write sets the in-flight flag for its duration (resolve a deferred `fetch` and
   assert `state.settingsSaving` is `true` before the answer, `false` after).
6. A refusal (`422` with a `detail`) leaves `state.serversError` carrying the store's
   sentence, leaves the selection where it was, and sets the flag back to false.
7. Called with an unsaved server draft, it posts nothing.

## Do not

- **Do not render the listing table or its `+` column** — that is task 07. Do not add
  the table's scroll container either.
- **Do not focus anything.** Focusing the new model's tree row is task 11, and spec
  §9.1-3 fixed which element it is.
- **Do not change `saveModelDraft`.** A model typed into the form and saved still
  posts `modelWritePayload` plus `serverId`.
- **Do not add a confirmation step.** The row is empty of consequence and the model
  page can delete it (spec §4.4).
- **Do not touch `src/`.** The route exists; `ModelCreateIn` is the model's fields
  plus `serverId`, and an omitted sampler stays a null column.

## Files

- `web/src/composables/useAppShell.js` — `addModelFromListing`, its guard, and its
  place in the returned object.
- `web/tests/settingsAddModel.test.js` — new, the seven cases above.

## Rules it must not break

- *"Every write surface is the browser's alone — the Editor's file routes and the
  settings-store routes."* This write is a settings-store route and stays the
  browser's; no tool, connector or chat path gains anything.
- *"`nojae.db` … Written only through its own routes, never through a path"* —
  `POST /api/models/add` is that route.
- *"Configuration is edited from the UI and takes effect hot."* The answer is the
  whole tree, adopted wholesale, so the composer's and the agents' view of the
  catalogue is right without a reload.
- *"A lot runs every task in one agent, read from the composer's dropdown at launch"*
  — unrelated to this write, and unchanged by it: no agent is re-pointed here.
- *"Tests stay hermetic: no test reads a real model connection … and each test runs
  on a temporary store of its own."* `fetch` is mocked; the body is asserted, no
  route is reached.

## Depends on

Tasks 03 (the verdicts name the guard this write shares) and 05 (`state.detailTab`
and its setter).

## Done when

- `addModelFromListing` is exported from `useAppShell` and posts exactly
  `{ name, serverId }` to `POST /api/models/add`.
- After a successful call the parent is expanded, the new model is selected and
  `state.detailTab` is `settings`.
- The call is covered by `state.settingsSaving` for its duration, and a refusal
  lands in `state.serversError` with the selection unchanged.
- An unsaved server posts nothing.
- `cd web && npm test` is green, and no existing test broke.

Finish by moving this file into `todos/done/`.
