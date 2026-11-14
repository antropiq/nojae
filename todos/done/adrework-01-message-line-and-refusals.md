# 01 — The card says one thing, in one place: the message line and the refusal verdicts

**Read first**: `docs/agents-dialog-rework.md` §1, §2, D1 (the Save paragraph),
D3 (the rename table), D10's closing paragraphs, D11 in full, and §6 items 6, 7
and 8. Task 02 lands the verdicts the toolbar's other slots will need; this task
lands the one behavioural change the rework has.

## Deliver

### In `web/src/composables/useAgentModes.js`

Three plain functions. Each answers a question; none of them is a check written
in a template afterwards.

- **`writeBlockedFor`** — replaces `saveDisabledFor`, which is **renamed, not
  reused**: its old answer (an incomplete form blocks Save) is exactly what this
  rework drops, so keeping the name would keep the lie. It answers two things
  only: is there something for Save to act on, and is a write already in flight.
  Its final shape includes the app-owned row's model exception (§5's last
  paragraph), which task 02 adds; land here what the card can already answer.
- **`saveRefusalFor`** — `null` when this form may be written, otherwise one
  sentence saying the form must be completed and **naming what is missing**. It
  is built by reading `entryProblems` (which stays exactly as it is, and is
  rendered by nothing any more). Do not move the per-field wording into the
  template and do not re-derive the rules here.
- **`messageFor`** — the card's single message: its text, or nothing, plus
  whether it is announced as an alert or as a status. The choice is by **D11's
  fixed priority, never by recency**: a write in flight, then a refusal from the
  store (its own sentence, unchanged in wording), then the incomplete-form
  sentence, then a read failure, then the read's findings — the loader's and the
  server's, said as one message. `alert` for a refusal or a failure, `status` for
  progress and for the incomplete-form sentence.

### In `web/src/components/AgentModesDialog.vue`

- **One message line**, on the footer's left side, sharing the band the `Cancel`
  and `Save` buttons sit on. It is always present — empty when it has nothing to
  say — so filling or emptying it reflows nothing (§6.8). Its role comes from
  `messageFor`; there is no second message anywhere in the card.
- **The five sites go** (D11's table): the `Reading the agents…` / error line at
  the top, the two findings blocks, the per-field problem paragraphs, the
  delete-refusal caption under the form, and the problem count in the footer.
- **The save slot refuses instead of disappearing**: its `:disabled` is
  `writeBlockedFor`'s answer, and a click consults `saveRefusalFor` — on a
  refusal nothing is written, the card stays open, and the sentence goes in the
  message line. `entryProblems` no longer blocks anything.
- **The in-form Delete button** (which task 04 moves into the toolbar) keeps its
  reason in its **tooltip**, per D1: nojae owns it, nothing is stored to delete,
  or a write is in flight. It is never disabled silently.
- **The line clears when its cause goes away**: typing the missing label empties
  the incomplete-form sentence, and a successful save empties a refusal.

### In `web/src/styles/theme.css`

Only what the reserved band needs: the footer lays out the line on its left, the
buttons at its right, and the line's height is the buttons' from the start. The
full audit and the removal of the card's dead rules are task 06 — do not sweep
the stylesheet now.

## Files

- `web/src/composables/useAgentModes.js`
- `web/src/components/AgentModesDialog.vue`
- `web/src/styles/theme.css` (the footer band only)
- `web/tests/agentModes.test.js` — the verdict functions replace the
  `saveDisabledFor` cases; the new priority order and the clearing rule get
  cases.
- `web/tests/agentModesDialog.test.js` — every case that read a message under a
  field, at the top of the card or in the footer now reads the one line; the
  cases asserting `saveButton.disabled` for an incomplete form become "live, and
  a click writes nothing while the line says why".

## Rules it must not break

From this project's instructions (`AGENTS.md`):

- *"Core owns logic, the API owns transport."* And, for the card, spec **D3**: the
  component decides nothing. Every sentence on screen comes out of a composable
  function; no message is assembled in the template.
- *"`lib/` holds the single markdown renderer — all rendered HTML goes through it,
  never raw `v-html`."* The message line renders text; `v-html` stays absent from
  this component.
- *"`composables/` hold app-shell and stream state and own each live stream and
  its abort; components use them directly."* The card reaches the store only
  through the composable's own calls — it spells no route.
- *"Every write surface is the browser's alone — the Editor's file routes and the
  settings-store routes — and the file ones are refused while a chat reply
  streams."* This task adds no write and no route; the three agent routes keep their
  shapes and their refusals, and the guard the sentence describes is about the file
  routes, not these.
- *"Tests stay hermetic: no test reads a real model connection, reaches a live hub
  or opens the install's settings store."* The vitest suite mounts the card over
  a stubbed `fetch`, as it already does.
- The spec's **D1**, last line: *"A disabled slot always says why … and never in a
  tooltip that describes behaviour that is not happening."* The save slot is
  therefore not disabled for an incomplete form; it refuses and explains.

## Depends on

Nothing. This is the lot's first task.

## Done when

- `grep saveDisabledFor` finds nothing outside git history; `writeBlockedFor`,
  `saveRefusalFor` and `messageFor` exist and are exercised in
  `web/tests/agentModes.test.js`.
- With an incomplete form the save slot is **enabled**, a click posts nothing,
  the card stays open, and exactly one message — the incomplete-form sentence,
  announced as a status — is in the line (§6.6).
- A refused store write puts the store's own sentence in the line, announced as
  an alert; nothing appears at the top of the card and no field carries its own
  message (§6.7).
- The line occupies its band while empty: the card's body, the fields and the
  footer buttons sit exactly where they do with a message in it (§6.8).
- No element in the card still renders a finding, a per-field problem, a problem
  count or a delete-refusal caption.
- `pytest` and `cd web && npm test` pass. The e2e suite is not run by this task
  and is untouched by it.

Finish by moving this file into `todos/done/`.
