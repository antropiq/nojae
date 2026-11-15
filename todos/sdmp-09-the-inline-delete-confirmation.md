# 09 — The inline delete confirmation

**Read first**: `docs/settings-dialog-migration-plan.md` §2.6, §4.8 in full, §4.7's
rung 6, §5.1's last two rows, §7.11, §8's T9, §12's "Deleting a server that still has
models" and "Delete confirmation copy" rows. Then
`web/src/composables/useAgentModes.js`'s `deleteConfirmationFor` and the toolbar pair
in `web/src/components/AgentModesDialog.vue`, plus the comments above
`.agent-modes-slot .agent-modes-confirm` / `.agent-modes-cancel` in `theme.css`.
Then `todos/sdmp-00-big-picture.md`.

`window.confirm` cannot be styled, cannot land in the message band, and its copy is
the only place today where the cascade is explained. It goes. The toolbar's two
reserved slots carry the answers, and the band carries the question.

## Deliver

### 1. The pending-delete state

A component-local `pendingDelete` flag (the same shape the Agents card uses for its
pending delete) — *which* row is being asked about is not needed, because the row is
the current selection and the toolbar acts on the page that is visible.

- The delete slot sets it (`askDelete`), and does nothing else — no write.
- `×` clears it (`dismissDelete`), and writes nothing.
- `✓` performs the delete the row already had a function for: `deleteServerRow` on a
  server page, `deleteModelRow` on a model page. Then it clears the flag.
- Selecting another row, switching a section, closing the dialog, or a click on the
  save or add slot clears it too — a question asked about one row must never be
  answered against another. A write in flight makes the pair **inert**, not queued
  (spec §4.8); do not clear the flag on a failed write, or the user loses the
  question and its answer.
- The pending state is passed into `deleteConfirmationFor` and into every slot
  verdict as the `confirming` fact task 03's context already carries, so the other
  three verbs go inert while a question is open — and that is a **verdict's** answer,
  not a template condition.

### 2. The pair in the toolbar's reserved slots

Render the two buttons into the two slots task 04 reserved, from
`deleteConfirmationFor`'s answer: `{ rendered, cancel, confirm }`.

- **`rendered` is `false`** while nothing is being confirmed, and the pair is then
  **absent from the DOM** — not hidden. That is the same rule the Agents card
  follows, and it is why neither button is focusable or announced while it means
  nothing.
- Each button carries `:title` **and** `:aria-label` bound to its verdict's `label`,
  as the three verbs do.
- The glyphs are the house ones: `×` for cancel, `✓` for confirm, in the same colours
  the Agents card's pair uses (the destructive answer red, the confirming one green).
- **No sentence is rendered in the toolbar.** The toolbar's height is fixed and the
  copies here name what a delete costs; the sentence goes to the band.

### 3. The question in the band

While a delete is pending, rung 6 of `messageFor` (task 08) says the row's sentence
**verbatim**, as `alert`:

- `serverDeleteSentence(server)` on a server page — it already names the models going
  with it and the agents left without one, and already has its shorter form for a
  child-less server.
- `modelDeleteSentence(model)` on a model page.

**Do not re-derive either sentence.** They stay in `useAppShell.js`, word for word;
the band only says them. `deleteSlotFor` being live is what offers the question, and
the sentence being in the band is what explains the cascade — there is no second
confirmation dialog, no toast, and no parent guard.

### 4. The cascade is untouched

A server delete takes its models with it, exactly as today: the store declares
`ON DELETE CASCADE`, `delete_server` copies the database before it lands, and the
write answers the whole tree so the client needs no cascade rule of its own. **Do not
add** an inert delete on a server that still has children, a "delete the models
first" refusal, or a client-side check of the child count — the sentence names the
consequence and that is the whole of it.

### 5. The tests

Extend `web/tests/settingsModelsSection.test.js`'s "the destructive confirmations"
block (it currently spies on `window.confirm`) and/or
`web/tests/settingsServersRules.test.js`:

- A delete click **asks**: nothing is posted, the pair appears, the save/add/delete
  slots go inert, and `window.confirm` is never called — assert the spy exists and
  has no calls, so a reintroduced `window.confirm` fails loudly.
- `×` dismisses: pair gone from the DOM, nothing posted, the verbs live again.
- `✓` posts the delete route once: `/api/servers/delete` with `{ id }` from a server
  page, `/api/models/delete` with `{ id }` from a model page; the pair then goes.
- The band carries `serverDeleteSentence`'s text on a server page and
  `modelDeleteSentence`'s on a model page, and each is the composable's own string —
  assert by comparing against the exported function's answer, not a literal.
- A server that still has models is deletable: the delete slot is live and nothing
  refuses it (the parent-guard assertion, repeated here because this is the task
  where "one click deletes a whole endpoint" becomes visible).
- While the delete's write is in flight, both answers are inert.
- Selecting another row while the question is open dismisses it and posts nothing.

## Do not

- **Do not change `serverDeleteSentence` / `modelDeleteSentence`.**
- **Do not add a parent guard** anywhere: not in `useSettingsServers.js`, not in the
  template, not in `useAppShell`.
- **Do not add a close-confirmation pair.** The Agents card asks before discarding
  typed work because a save is the only way to keep it; here every write lands as it
  is made and Close has nothing to undo, so Close stays a plain button (spec §4.9,
  §7.9: `Close` is the footer's only verb).
- **Do not add a second message site** for the sentence: it is rung 6 of the one band.
- **Do not touch `src/`** — the store's copy and its cascade are already right.

## Files

- `web/src/components/SettingsDialog.vue` — `askDelete` / `dismissDelete` /
  `confirmDelete`, the pair rendered into task 04's reserved slots, the two
  `window.confirm` calls removed.
- `web/src/composables/useSettingsServers.js` — rung 6 of `messageFor` learns the
  pending sentence; `deleteConfirmationFor` is consumed as task 03 wrote it (extend it
  only if a fact is missing).
- `web/src/composables/useAppShell.js` — only if the pending flag can only be kept
  correctly there (prefer component-local, as the Agents card does — the flag is
  presentation, not store state).
- `web/tests/settingsModelsSection.test.js`, `web/tests/settingsServersRules.test.js`
  — the confirmation cases as above.

## Rules it must not break

- *"A server delete takes its models with it, as it does today. No parent-guard, no
  'delete the children first' refusal. `models.server_id ON DELETE CASCADE` is the
  schema's declared intent and `delete_server` backs the store up before it lands."*
  Quoted from the spec, and it is `AGENTS.md`'s *"no write destroys bytes"* family:
  the store's own backup is the safety, and it is unchanged.
- *"Every write surface is the browser's alone."* The two delete routes stay the
  browser's; `tests/test_write_surface_isolation.py` still finds no tool or connector
  reaching them.
- *"Configuration is edited from the UI and takes effect hot."* A delete still answers
  the whole tree.
- *"A declaration is created only when absent and changed only outside the app"* —
  unrelated; nothing here writes a declaration file.
- *"Tests stay hermetic"* — the delete is asserted with `fetch` mocked.

## Depends on

Tasks 03 (`deleteConfirmationFor`, `deleteSlotFor` and the `confirming` fact), 04 (the
two reserved slots), and 08 (the band, rung 6).

## Done when

- Clicking delete never calls `window.confirm` and posts nothing; the pair appears in
  the toolbar's two reserved slots and the other three verbs are inert.
- `×` dismisses, `✓` deletes once and closes the question; while the delete's write is
  in flight both answers are inert.
- The band says `serverDeleteSentence`'s or `modelDeleteSentence`'s sentence verbatim
  while the question is open, and the toolbar holds no copy of it.
- A server that still has models is deletable in one click, and the store's pre-delete
  copy still happens (unchanged on the server side).
- The toolbar's geometry is unchanged in every one of those states: revealing the pair
  moves the three verbs by nothing.
- `cd web && npm test` is green.

Finish by moving this file into `todos/done/`.
