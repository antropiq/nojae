# 02 — The verdicts the toolbar will need, and the per-entry baseline

**Read first**: `docs/agents-dialog-rework.md` §5 (the whole table and the two
notes under it), D3's rename table, D5, D7 (points 1, 3, 5, 6), D8's paragraph on
`Q2 = B` and the baseline, §8's closing bullets, and §6 items 9, 10, 13, 14, 15.

Nothing the user sees changes in this task: every function here is new, and the
card keeps calling what it already calls. Task 03 onwards consumes them. The
point is that by the time the toolbar exists, **no condition has to be invented in
a template** — §5's closing rule: *"an action's availability is a composable
function, never a condition written in the template, and every inert control
carries the reason in its tooltip."*

## Deliver

### Slot verdicts, in `web/src/composables/useAgentModes.js`

One plain function per verb, each answering two things: is the slot inert, and —
when it is — the reason sentence its tooltip shows. A slot's **accessible name and
its tooltip are the same string**, so put the names where the card can read them
as one value rather than repeating a label beside a title.

| slot | the one word (name **and** tooltip) when usable | the reason when inert |
|---|---|---|
| add | `Add agent` | already in creation mode; or a write is in flight |
| save | `Save agent` | nothing to act on |
| delete | `Delete agent` | nojae owns it; nothing is stored to delete; or a write is in flight |
| cancel delete | `Cancel delete` | never inert |
| confirm delete | `Confirm delete` | never inert |

**The one word `Saving…`, and how it keeps §6.16 true.** D1's table gives save a
`Saving…` tooltip while a write is in flight, and §6.16 demands every slot's
accessible name *equal* its tooltip. Both hold if the **pair moves together**:
while a save is in flight that slot's name and its tooltip both read `Saving…`, and
when the write lands both go back to `Save agent`. Never change one without the
other — that is the whole difference between an honest label and a name a screen
reader hears disagreeing with a hover. (The close pair, in task 05, has no such
word: `Keep editing` / `Discard and close` in every state.)

Every row of §5 must be answerable by these functions, including the ones the
card cannot reach yet (creation mode, a pending close, an empty list). Take the
card's state as an argument — what is selected, whether a creation is being typed,
whether a write is in flight, whether a confirmation is pending — so the functions
are complete and testable before any of it is wired.

Two rules from §5 that a simple "is anything selected" test gets wrong:

- **The app-owned row's Save is inert until its model actually changes.** That is
  the one deliberate exception to "no dirty gating", and it is *not* the general
  rule coming back: for that row the model is the only field the user owns, and a
  save that could only rewrite what is already stored has nothing to offer. Judge
  it off the row's own flags and its baseline, never off an agent id.
- **"Nothing selected" means two different states.** In creation mode Save is live
  and Delete is not; with a list that came back empty, Save is inert too — there is
  no form to type into. Never collapse them.

### The confirmation pair is absent, not hidden

The delete pair — and, in task 05, the close pair — is **not rendered at all**
until a confirmation is pending (§6.17): not focusable, not announced, not
`visibility: hidden`. The verdict that says whether it is pending is a
composable function; the template only renders its answer.

### The creation form's shape

A plain function that answers *what an empty new-agent form holds*, so the card
never builds one field-by-field in the template: no label, no persona, both hub
switches off, the tool loop at its floor (from the payload's `caps`, never a
literal), no model, its id derived by the slug rule the client already has. It
carries the flags a not-yet-stored row needs — not new-in-the-list, not deletable,
not readonly — so the same slot verdicts answer for it without a second branch. An
empty label must yield the neutral placeholder id the existing slug rule produces,
still correctable.

The **creation state itself** is one more state the card holds through a verdict:
*is a form being typed that has no row?* Every slot verdict takes it as an
argument, and the close verdict treats it as unsaved work by definition (nothing
was ever written).

### The delete successor

A plain function for D7.5: given the list's order and the row being deleted, the
row to select afterwards is the **next** one in display order, or the **previous**
one when the deleted row was last, or nothing when the list comes back empty. It
takes the order it is given and adds no ordering of its own — the store's order is
`resolve_agents()`'s, with nojae's own app-owned agent last.

### The per-entry baseline, and the close verdict

- **One baseline per entry**, captured where a draft is built from a payload —
  the read and both writes, since the card adopts the store's answer rather than
  splicing what it sent. That single place is the invariant: the baseline is
  always *what the store last said*, never what the user typed.
- **`closeWouldLoseFor`** — would closing lose something? The baseline comparison,
  **plus always yes while in creation mode**, where nothing was ever written.
- **The baseline is never consulted by any save verdict** (D8, and the spec's "One
  tension that was resolved"). Keep the two answers visibly separate in the code:
  *may this be saved* is the form's completeness, *would closing lose something*
  is the baseline. A single function serving both would undo Q2.

## Files

- `web/src/composables/useAgentModes.js`
- `web/tests/agentModes.test.js` — the cases for the verdict matrix, the
  app-owned exception, the two "nothing selected" states, the successor rule and
  the baseline. Mirror the rows of §5 one case each, so a row that later loses its
  answer fails here.

## Rules it must not break

From this project's instructions (`AGENTS.md`):

- *"Core owns logic, the API owns transport."* These are decisions, so they live in
  the composable — spec **D3**: *"The component still decides nothing: every
  verdict above is a function in the composable, and the existing test that
  asserts it stays the rule."*
- **No reserved agent id in the client, and no id comparison.** No `AGENTS.md`
  sentence states this; two tests enforce it — the scan in
  `tests/test_write_surface_isolation.py` and the source scan in
  `web/tests/agentModes.test.js`, which also forbids an `id === '…'` test in this
  component and this composable. The app-owned row is recognised by its `readonly`
  and `deletable` flags and by its baseline, never by an id. Do not weaken either
  scan.
- **No cap is spelled in the client.** The composable's own note at the top of the
  editor section says it: *"No cap is spelled here: the id pattern and length, the
  label cap, the persona byte cap and the tool-iteration floor all arrive in the
  payload's `caps`"* — and that is also what the server refuses against. Nothing in
  this task reads a number; the iteration floor a new form starts at comes from
  `caps`.
- *"Tests stay hermetic"* — pure functions, stubbed payloads, no store.
- *"Every WorkBench turn runs in an agent mode … It only ever narrows what settings
  and the conversation already allow."* Saving an agent changes no permission;
  these functions decide availability, not authority.

## Depends on

Task 01, whose `writeBlockedFor` this task completes (the app-owned model
exception) and whose `messageFor` it must not extend with a second priority list.

## Done when

- Every row of §5 has a composable function's answer and a passing case in
  `web/tests/agentModes.test.js`, including: an incompletely filled form keeps Save
  **live**; the app-owned row's Save is inert until its model changes and live
  after; Add is inert in creation mode; Delete is inert with nothing stored; a
  write in flight makes every verb inert.
- Each inert slot's reason is the sentence its tooltip shows, and the accessible
  name and the tooltip come from one value.
- The successor rule answers next / previous / nothing, from the order it is given.
- `closeWouldLoseFor` is true after a keystroke, true in creation mode, false for a
  freshly read entry — and no save verdict reads the baseline.
- While a write is in flight the save slot's name and tooltip both read `Saving…`;
  a case asserts both together, so changing one without the other fails.
- The creation-form function answers an empty form with the payload's iteration
  floor, no model, both switches off, a neutral id from the existing slug rule, and
  the flags that make delete inert for it; a case asserts each of those.
- `cd web && npm test` and `pytest` pass. The card's own behaviour is unchanged by
  this task, and the e2e suite is not run.

Finish by moving this file into `todos/done/`.
