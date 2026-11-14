# 06 — Nothing moves: the geometry sweep, the accessible names, and the card's dead CSS

**Read first**: `docs/agents-dialog-rework.md` §3, D1's first two paragraphs and
its table, D10 in full, D11's first three bullets, §5's two closing rules, and §6
items 1, 8, 11, 15, 16, 17, 19. This is the task that proves the rework's governing
rule rather than asserting it in prose.

By now the card's shape is final; what this task buys is that the shape is
**stable** in every state §5 lists, that every slot says one thing to a reader, a
hover and a test, and that no rule of the old card is left behind pretending to
style something that no longer exists.

## Deliver

### The geometry (D10, §6.19)

Assert, by measuring in the mounted-card suite, that across every state in §5 the
following do not move:

- the **first three toolbar slots** — their x/width and the toolbar's height, with
  and without the delete pair rendered;
- **`Close`** — its x/width, with and without the close pair rendered;
- the **footer band's** height and the **list's top edge**, empty message line and
  filled message line, no confirmation and a pending one;
- the **card's** size: selecting another row, entering creation mode, and cancelling
  a confirmation all leave it exactly where it was.

Where a measurement is awkward in jsdom, measure bounding boxes of the rendered
elements as the existing suites already do; do not replace the assertion with a
comment about the stylesheet — a rule the task was written to protect is exactly the
one that drifts.

### The accessible names (§6.16)

- Every one of the five slots has an **accessible name equal to its tooltip**, and
  a test asserts the equality rather than the two strings separately, so a later
  edit to one fails. Do this in the in-flight state as well, where the save slot
  reads `Saving…` in both places — the state an equality check written only against
  the idle label would miss.
- Every disabled slot **explains itself**, and never with a tooltip describing
  behaviour that is not happening.
- Every glyph is marked decorative, so it is not announced on top of the name.
- Both confirmation pairs are **absent from the DOM** — not merely invisible — until
  their confirmation is pending (§6.17).

### The card's dead CSS

`web/src/styles/theme.css` has an `agent-modes` block written for the card this lot
has replaced. Remove what now styles nothing, and keep what still renders:

- **Remove**: the nav's create-field and create-button rules, the finding-span and
  the two finding-block rules, the per-field finding rule, the persona-finding rule,
  the form's delete/action/confirm rules and its `…-delete-yes`, the blocking-note
  rule, and the `.agent-modes-create` rule — anything whose selector no longer
  matches an element in the component.
- **Keep**: the card's two-column and scroll geometry, the nav's rows and the
  selected row's active treatment, the broken-tab colour, the `readonly` caption,
  the model line, the two hub switches, the persona counter, the message line, the
  toolbar's slots and both confirmation pairs, and the footer band.
- Whatever the block's comment says about the create affordance, the in-place delete
  confirm and the stacked findings must be brought current: it describes a card that
  no longer exists. Do not restate a size that a shared rule already sets, and do not
  size the `<dialog>` element (the existing note in that file explains why).
- **Do not touch any other block** of `theme.css`, and do not touch the tree's
  generated icon artifacts.
- **Check it mechanically rather than by eye**: list every `agent-modes` class the
  block selects, and every `agent-modes` class the component renders, and make the
  two lists agree. A rule kept for an element that no longer exists is the kind of
  leftover the next reader trusts as documentation.

## Files

- `web/src/styles/theme.css` — the `agent-modes` block only, plus its comment.
- `web/src/components/AgentModesDialog.vue` — only what the sweep proves: a missing
  slot class, a glyph not marked decorative, a name that differs from its tooltip.
- `web/tests/agentModesDialog.test.js` — the geometry, name-equality, absence and
  decorative-glyph assertions.

## Rules it must not break

From this project's instructions (`AGENTS.md`):

- *"`components/` and `styles/` are the widgets and the theme."* Measurements live in
  `theme.css`; the component carries classes only, and no inline sizing on the
  `<dialog>` element (an existing case in the unit suite asserts that).
- *"The tree's per-file-type icons are **generated**: edit the source tables and
  regenerate, never hand-edit the artifacts."* Nothing in this task touches them.
- *"`lib/` holds the single markdown renderer … never raw `v-html`."*
- *"Core owns logic, the API owns transport"* and spec **D3** / §5's closing rule: do
  not move an availability rule into CSS either — a slot is inert because a
  composable function said so, not because a selector hid it.
- *"Tests stay hermetic"* — no browser, no live hub, no store.
- **D10**'s own summary: *"a control, glyph, caption or message must not be added and
  removed in a way that shifts what the user is already aiming at."*

## Depends on

Tasks 01–05: every slot, pair and message this task measures must already exist.

## Done when

- The geometry cases pass: the first three slots, `Close`, the footer band, the
  list's top edge and the card's size hold still across every state in §5 (§6.19).
- Every slot's accessible name equals its tooltip, by assertion (§6.16), and every
  disabled slot explains itself.
- Both pairs are absent from the DOM until pending (§6.17); every glyph is
  decorative.
- No selector in the `agent-modes` block of `theme.css` matches nothing any more, and
  the block's comment describes the card as it now is.
- `git diff web/package.json` is empty.
- `pytest` and `cd web && npm test` pass. The e2e suite was **not** run: task 07
  rewrites it.

Finish by moving this file into `todos/done/`.
