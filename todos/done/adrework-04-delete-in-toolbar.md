# 04 — Delete becomes a toolbar verb, and it asks in the toolbar's own slots

**Read first**: `docs/agents-dialog-rework.md` §3 (the two right slots), D1's
table, D7 in full, §8's Q4 and Q7 (with its follow-up), and §6 items 10, 11, 12,
13, 14. D10's third bullet is the reason this task adds no sentence anywhere.

Today Delete sits at the bottom of the form with an in-place confirm under it, so
it moves as the form grows and it is never visible at the same time as Create or
Save. This task moves it to the toolbar, and moves the thing that decides it to the
composable — task 02 already wrote that verdict.

## Deliver

### The delete slot

- **Offered only for a selected agent that can be deleted** — a user-created,
  already-stored row. Otherwise the slot is **disabled with its reason** in its
  tooltip (§6.10): nojae owns it, nothing is stored to delete, or a write is in
  flight. It is never hidden and never silently inert.
- The verdict is task 02's function. The component renders its answer and names no
  agent id (`readonly` and `deletable` are the whole vocabulary).

### The confirmation (D7)

- Clicking delete reveals the **cancel** and **confirm** slots at the right end of
  the same toolbar. The selection and the form do not change.
- The pair is **not rendered at all** until a delete is being confirmed (§6.17): not
  focusable, not announced, not merely invisible. It reuses the two slots the
  toolbar already reserves, so the first three buttons do not move by a pixel and
  the toolbar's height does not change (§6.11).
- **The confirmation is carried by the two glyphs and their tooltips alone.** No
  sentence, no agent label in the toolbar, no inserted caption: the pair's presence
  is the question; `Cancel delete` and `Confirm delete` are its answers. Focus lands
  on **Cancel** — the safe answer — when the pair appears, so a keyboard user is
  told what a pointer user reads in the tooltip.
- **While a confirmation is pending, add / save / delete are inert**: one
  destructive action is decided at a time. A save or delete in flight disables the
  pair rather than queueing it (§8's third small point).
- **Cancel** hides the pair and changes nothing else. Nothing was written, so
  nothing needs restoring — including whatever the user typed (Q4, §6.12).
- **Confirm** deletes the agent, re-baselines the list on the answer, and selects
  **the next row in display order**, falling back to the **previous** one when the
  deleted agent was last, and to no selection when the list came back empty (§6.13).
  That successor rule is task 02's function — do not re-derive the ordering.
- **Selecting a different agent while the confirmation is pending cancels the
  confirmation.** The destructive action never survives the selection moving
  (§6.14). Escape leaves the card as it does today and therefore abandons the
  pending delete too: nothing was written. (Task 05 puts the close guard in front of
  that exit; the guard must abandon the delete the same way, since a close and a
  delete are never both pending.)

### The form loses its delete block

The Delete button, the in-place confirm (`Delete` / `Keep it`), and the refusal
caption under the form are **removed** from the per-agent section. The refusal
wording survives in the slot's tooltip. The store still copies the database before
a destructive write, so the toolbar's confirmation is the only guard the user
needs.

## Files

- `web/src/components/AgentModesDialog.vue`
- `web/src/composables/useAgentModes.js` — only if a delete verdict needs a shape
  task 02 did not give it; task 02 owns those functions.
- `web/src/styles/theme.css` — the two reserved slots' styling; the form's
  delete-block rules are **kept for now** and removed in task 06, so no rule is
  orphaned silently before the sweep.
- `web/tests/agentModesDialog.test.js` — the delete cases move from the per-agent
  section to the toolbar: offered/disabled with a reason, the pair absent until
  clicked, cancel restoring nothing, confirm posting and selecting the successor,
  and a selection change cancelling the pending confirmation.
- `web/tests/agentModes.test.js` — nothing new is expected; if task 02's cases do
  not cover the successor and the flags, extend them there rather than duplicating
  the rule in the dialog suite.

## Rules it must not break

From this project's instructions (`AGENTS.md`):

- **No write destroys bytes, and for a destructive store write that means a copy
  first.** `AGENTS.md` states the rule for the reserved folder ("a save backs up
  what it replaces, a delete moves the file into a dated batch"); for the settings
  store the README states its form — deleting an agent copies the whole database into
  the app's dated backup folder before the write. That guarantee is the *store's* and
  does not change here: the delete route copies first, exactly as today. This task
  adds no write and no route.
- *"Every write surface is the browser's alone — the Editor's file routes and the
  settings-store routes."* Confirming a delete must remain reachable only from this
  card. Do not add a route, a query parameter or a keyboard shortcut that performs
  the delete without the confirmation.
- *"Core owns logic, the API owns transport"* and spec **D3** / §5's closing rule:
  the availability of every slot and the pending-confirmation state are composable
  functions; the template renders their answers.
- *"`composables/` hold app-shell and stream state … components use them directly."*
  The card still reaches the store only through the composable's calls.
- **The client names no reserved agent id, and compares none** (asserted by the
  scan in `tests/test_write_surface_isolation.py` and the source scan in
  `web/tests/agentModes.test.js`). The delete offer and the refusal reason both come
  from the row's `deletable` / `readonly` flags.
- *"Tests stay hermetic."*
- **D10**: *"The delete confirmation adds no sentence — the toolbar's height is
  fixed, so the list's top edge does not jump when a delete is asked."*

## Depends on

Tasks 01, 02 and 03. 03 owns the toolbar's five-slot geometry and the reserved right
slots; 02 owns the delete verdict and the successor rule; 01 owns the message line,
where a refused delete (a store error) now reports itself.

## Done when

- `Delete agent` is disabled with a reason for a built-in agent, while nothing is
  selected, and while a write is in flight (§6.10).
- Clicking it adds exactly two slots at the toolbar's right end; the first three do
  not move and the toolbar's height does not change — assert it by measuring, as
  the card's geometry suite does — and no sentence or label was added anywhere
  (§6.11).
- `Cancel delete` removes the pair and leaves the selection, the form and
  everything typed in it exactly as it was (§6.12).
- `Confirm delete` removes the agent and selects the next row, or the previous one
  when the deleted agent was last, or nothing when the list is empty (§6.13).
- Selecting another agent while the confirmation is pending cancels it and deletes
  nothing (§6.14).
- The pair is absent from the DOM — not merely invisible — until a confirmation is
  pending (§6.17).
- No Delete button, in-place confirm or refusal caption remains in the per-agent
  section of the component.
- `pytest` and `cd web && npm test` pass. The e2e suite was **not** run: task 07
  rewrites it.

Finish by moving this file into `todos/done/`.
