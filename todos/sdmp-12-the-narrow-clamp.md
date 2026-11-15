# 12 — The narrow clamp

**Read first**: `docs/settings-dialog-migration-plan.md` §8's T12, §4.4's scroll
bullet, §4.5's three-column grid, the card's `max-width: 94vw` rule in
`web/src/styles/theme.css`, and the existing `@media` rules that collapse
`.models-body` and `.settings-grid` at `640px` / `560px`. Then
`todos/sdmp-00-big-picture.md`.

The app is desktop-only, but the card is clamped to `94vw`, so a narrow desktop window
still has to be usable. This task checks the three places the rework made wide — the
tree column, the samplers' three columns and the listing's scroll area — and writes
down the collapse order explicitly instead of leaving it to whichever `@media` rule
happens to exist.

## Deliver

1. **Check the clamp at its narrowest.** The card is `900×600` with
   `max-width: 94vw`; at a 94vw narrower than the two columns need, the Servers
   section must still be usable. Decide and **write in the CSS's own comment**, in the
   section's block, the **collapse order** — which of the three gives way first, and
   what each becomes:
   - the samplers' three-column grid → two → one;
   - the master–detail two columns → one (the existing `640px` rule already does this
     for `.models-body`; confirm it still fires with the toolbar's grid placement and
     the detail strip in place, since a `grid-area`-placed child can survive a
     `grid-template-columns` change that a wrapper would not);
   - the listing table's scroll area (it must keep its own scrollbar at every width and
     never push the column wider — long ids wrap or truncate).
2. **Make the order explicit in the rules.** Today `@media (max-width: 640px)` and
   `@media (max-width: 560px)` exist for the two-column bodies. If the Servers
   section's new three-column sampler grid needs its own breakpoint, add it scoped to
   this section, and make the section's block's comment state the order in one
   sentence — the same way `.agent-modes-body`'s comment states its flexible row.
3. **The toolbar, the detail strip and the band hold at every width.** They are fixed
   geometry, so they should need nothing; confirm it and say so. If a slot's fixed
   36px no longer fits beside a name at the narrowest width, the fix is the tree's
   column, not the slot's width — a slot that grew would break the reserved-geometry
   rule.
4. **The table's `Add` column keeps its width** at every width: the `+` is a fixed box,
   and the `name` cell takes whatever is left. State that in the rule's comment.
5. **No horizontal scrollbar** anywhere in the card at the narrowest clamp. If one
   appears, it is the signature of a `min-width` or an unwrapped id, and it is this
   task's bug.

## Do not

- **Do not redesign for mobile.** No touch targets, no stacked-only layout, no
  hamburger. Desktop-only is `AGENTS.md`'s statement of the app; this task keeps the
  narrow desktop window usable.
- **Do not change the card's fixed size** (`900×600`) or the dialog element's own
  sizing.
- **Do not add a second breakpoint system.** Extend the ones in this file, scoped.
- **Do not move a control to make it fit.** If something does not fit, the column
  collapses; a verb does not leave the toolbar.
- **Do not touch `src/`.**

## Files

- `web/src/styles/theme.css` — this section's block and the `@media` rules it owns.
- `web/tests/settingsNarrowClamp.test.js` — new, assertions a unit test can make about
  the CSS as written: the `94vw` clamp is still the card's only width rule for this
  dialog; the section's three-column sampler grid and its collapse breakpoints exist
  and are scoped to this dialog; the table's scroll container's rule carries both the
  `min-height: 0` / `minmax(0, 1fr)` pair and its overflow. (This is the same
  source-reading technique `web/tests/agentModesDialog.test.js` uses for `theme.css`.)
- `web/tests/settingsListingTable.test.js` — only if a case asserts a container's
  shape that this task renames.

## Rules it must not break

- *"Desktop browsers only."* Kept: this makes a narrow **desktop** window work; it
  does not add a phone layout.
- *"`components/` and `styles/` are the widgets and the theme."* Every rule added is in
  `theme.css`, scoped through `.settings-dialog`.
- *"Reserved geometry is the acceptance criterion, not a nice-to-have"* (spec §6.3):
  the collapse order must not shrink a slot, the strip's row or the band.
- *"The listing table's scroll container is the one place a naive implementation
  fails"* (spec §6.4): the `min-height: 0` / `minmax(0, 1fr)` pair is what this task
  re-verifies, not what it should have to add.
- *"Tests stay hermetic"* — the cases read files and mount nothing that reaches a
  route.

## Depends on

Tasks 05 (the three-column grid) and 07 (the table and its scroll container).

## Done when

- The section's CSS block states the collapse order in a sentence, and the rules
  implement exactly that order.
- At the narrowest clamp the card shows no horizontal scrollbar, the listing scrolls
  inside itself, the samplers are readable, and the toolbar, the detail strip and the
  band are unchanged in size.
- The `Add` column keeps a fixed width and the `name` column absorbs the rest.
- The new test asserts the clamp, the three-column grid, the breakpoints and the
  scroll container's pair, and fails if any is removed.
- `cd web && npm test` is green.

Finish by moving this file into `todos/done/`.
