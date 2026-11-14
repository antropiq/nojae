# 07 — The e2e spec, in step with the card it drives

**Read first**: `docs/agents-dialog-rework.md` §9's second half, "The e2e spec is
part of this work, not a follow-up" — its table and the two assertions it asks the
rework to gain — and the acceptance items it reaches (§6.3, §6.4, §6.5, §6.6).

`web/e2e/04-agent-modes.spec.js` reaches the dialog through things tasks 03–05
moved: its close helper clicks `Cancel`, it creates by filling the nav's label
field, it saves through the footer's `Save`, and it expects a save to close the
card. It has been red since task 03 **on purpose**. This task makes it true of the
new card, in one pass.

## Deliver

Update `web/e2e/04-agent-modes.spec.js`, following §9's table. Every row is a
selector or a flow, not a rewrite of what the spec measures — the dropdown, the
hub gate, the `readonly` agent's refusals and the store's order are all still the
subject.

| today | after |
|---|---|
| `getByRole('button', { name: 'Cancel' })` as the close helper | the footer's `Close`, plus the close guard's pair when the test left unsaved work |
| `.agent-modes-create` / `.agent-modes-create-button` | the toolbar's add slot |
| `.agent-modes-save` | the toolbar's save slot |
| `.agent-modes-delete-button` / `.agent-modes-delete-yes` | the toolbar's delete slot, then the confirm slot |
| creating by filling the nav field | creation mode: click add, then type in the form's Label field |
| any assertion reading a message **under a field** or **at the top of the card** | the one message line |

Also, in the same file and for the same reason:

- **A save no longer closes the card** (§6.4, D6). The flows that asserted the
  dialog had gone after a create or an edit now assert it is still open, that the
  new/edited row is selected, and that its row is in the list.
- **Its own "writes nothing on Cancel" assertions still hold**, expressed as
  *"`Close` with unsaved work, then `Keep editing`"* — the same guarantee through
  the new exit. Keep the `afterEach` sweep that deletes rows labelled with the
  suite's prefix: the store is shared by the whole suite.
- **Add the two assertions §9 asks for**, because both are easy to regress:
  - clicking `Save` on an incomplete form writes nothing, leaves the dialog open,
    and puts **exactly one** message in the message line;
  - clicking the add slot and then an agent in the list discards the creation
    without a prompt, and **no row was ever added for it**.
- Reach the toolbar's slots by their **accessible names** (`Add agent`,
  `Save agent`, `Delete agent`, `Cancel delete`, `Confirm delete`, `Keep editing`,
  `Discard and close`) rather than by CSS class wherever the name is unique — that
  is the vocabulary D1 guarantees, and a name query is what a reader would use.
- Keep the spec's own conventions: it names no real model connection, it reads the
  suite's temporary store only through `/api/agents`, and it still recognises the
  app-owned agent by its `readonly` flag and **never by its id**.
- **Everything not in the table stays as it is.** The field-level selectors the spec
  reads — a `readonly` agent's explanation, the persona byte counter, the model line,
  the per-agent section — select rules §7 keeps unchanged, and task 03 was told to
  keep those class hooks for exactly this reason. A selector that is neither in the
  table nor still matching is a gap to report, not a rewrite to make quietly.

## Files

- `web/e2e/04-agent-modes.spec.js` only. If a selector the table names does not
  exist on the finished card, the card is wrong, not the spec — fix it in the
  component and say so, but do not weaken an assertion to match a gap.

## Rules it must not break

From this project's instructions (`AGENTS.md`):

- *"Tests stay hermetic … each test runs on a temporary store of its own."* The e2e
  suite takes its connection from `.env.test` and `.nojae/nojae-test-settings.json`
  and never from a developer's `.env`; the spec must not spell a URL, a key or a
  model name.
- **The client names no reserved agent id** — and by extension the spec recognises
  the app-owned agent by `readonly`, as it does today.
- *"Every write surface is the browser's alone — the Editor's file routes and the
  settings-store routes — and the file ones are refused while a chat reply
  streams."* The spec drives the agent routes through the card; it does not add a
  shortcut around the confirmation, except where it already posts to a route directly
  to prove a refusal (the `readonly` case) — that stays as it is.
- **§9**: the spec is *part of this work, not a follow-up*. Do not leave a skipped
  test, a `fixme`, or an assertion relaxed to "eventually visible".

## Depends on

Tasks 01–06. The card must be at its final shape, because this spec is only written
once.

## Done when

- `cd web && npm run test:e2e` passes, `04-agent-modes.spec.js` included, with no
  skipped or relaxed case.
- Every row of §9's table is handled, and the spec's helper for leaving the card
  goes through `Close` (and the guard's `Keep editing` when work is unsaved).
- The two new assertions are present and fail when the behaviour they guard is
  removed.
- No CSS-class selector remains where the slot has a unique accessible name.
- The rows the spec creates are still swept by its `afterEach`, and the store is
  left as the spec found it.
- `pytest` and `cd web && npm test` still pass.

Finish by moving this file into `todos/done/`.
