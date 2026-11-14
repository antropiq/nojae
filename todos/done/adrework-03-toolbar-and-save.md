# 03 — The toolbar over the list: add, save, house glyphs, and a title that reads `Agents`

**Read first**: `docs/agents-dialog-rework.md` §3, D1 (all four paragraphs and the
table), D2, D4, D5, D6, D9, D10, and §6 items 1, 2, 3, 4, 5, 18. The mockup is
`docs/imgs/dialog-agents.png` — the layout this task builds.

This task gives the card its new skeleton — a left column of heading, toolbar and
scrollable list, a right column whose fields start at the toolbar's height, the
title `Agents` — and lands the **add** and **save** verbs with creation mode,
because removing the nav's create field and giving the toolbar's `+` something to
do are the same move. It also replaces the footer's `Cancel` with `Close`, so the
card's exit stops being the twin of a `Save` that now stays open; the guard that
makes `Close` ask before discarding work is task 05, and the **delete** verb is
task 04.

## Deliver

### Layout (§3)

- **Left column**: a small heading reading `Agents`, then the toolbar, then the
  agent list in **its own bounded scroll area**. The toolbar must not scroll away
  with the list.
- **Right column**: the selected agent's form, scrolling independently, its fields
  starting at the same height as the toolbar. It gains **no caption line and no
  per-field message** — §3's rule, and by now task 01 has already moved every
  message to the footer band. That forbids a caption announcing the card's *state*
  (the form is being created, a confirmation is pending); the **field rules stay
  exactly as they are** (§7): the `readonly` explanation, the persona's byte counter
  under the prompt, and the quiet model line naming what the agent runs on. D4 below
  depends on that last one.
- **Footer**: the message line on the left (already there from task 01), then the
  two reserved confirmation slots, then `Close` on the right, occupying the place
  `Cancel` holds today. `Close` closes the card and writes nothing, exactly as
  `Cancel` does; the guard that makes it ask first is task 05, and `Save` leaves the
  footer here.
- The card **keeps the size it has today**, so switching selection never resizes
  the dialog.
- **Title**: the dialog's heading becomes `Agents` and its accessible name follows
  it (D9). It reads `Agents` in every state and is never restyled into another
  word. Nothing about how the card opens changes: same pencil, same enablement,
  same landing rule.
- **The rename is exactly the title and the name that follows it.** Other labels in
  the card — the list's own grouping label, the two hub switches' wording, the field
  labels — are not the dialog's name and §9 does not move them. Do not widen the
  rename into a wording sweep.
- **The rename touches a comment in `web/src/components/WorkBenchInput.vue`.** That
  file mounts this card under a `v-if` and explains why: the closed card's
  accessible name used to be a substring of the composer select's own name, so a
  `getByLabel` query in the pinned e2e spec would have matched two elements. The
  `v-if` stays — a closed `<dialog>` in the DOM is still findable, and the canvas
  keeps that habit — but the reason it gives is now stale. Bring the comment current
  rather than leaving a justification for a collision that no longer exists, and
  change nothing else in that component: its pencil, its enablement rule and its
  mount point are out of scope (§7).

### The toolbar (D1)

- Laid out as **five fixed-width slots** — add, save, delete at the left, the
  confirmation pair at the right — **not** as a flex row that grows. The two right
  slots keep their width whether or not a pair is in them, so revealing the pair
  moves nothing and the toolbar never changes height (D10).
- Each present slot is a **small icon button in the app's existing house style**:
  an inline stroke SVG at the button icon size, coloured from the theme tokens
  (`--bi-icon`, `--bi-danger`, `--bi-success`), with the glyph marked decorative.
  Follow `web/src/components/SoundToggle.vue` and `ThemeToggle.vue`, which draw
  theirs the same way. **No icon package**: `web/package.json` gains no dependency.
- **Accessible name and tooltip are the same words**, and both come from task 02's
  verdict so they cannot drift — which is also what makes the `Saving…` word safe:
  it replaces the name and the tooltip together, never one of them. A disabled slot
  shows **why**, and never a tooltip describing behaviour that is not happening.
- **Slots render from the verdicts**, never from a condition written in the
  template.
- **The list keeps the class hooks it has.** §9's table names what moves, and the
  list's own hooks are not on it: the rows stay the same kind of button with the same
  two classes, so the e2e spec's helper that finds a row by label keeps working.
  Renaming them would be a rename with no reason, and would put a selector rewrite
  into task 07 that the spec never asked for.

### D2 — the list is the selection, and the selection is the edit mode

Clicking a row loads that agent's form; there is no Edit button and no mode to
enter. The selected row is visibly marked with the app's active-row treatment, and
the list keeps the mark it already has for an entry holding problems. Each agent's
form is still held per entry, so selecting another row **never discards what was
typed** in the one you left (§6.18) — a case in the unit suite must assert it.

### D6 — saving does not close the card

The write is one agent, and the card has a `Close` for leaving, so a successful
save keeps it open: re-baseline the list on the store's answer, keep the saved
agent **selected**, and leave any other agent's unsaved edits alone. A save writes
**exactly one** agent — the selected one: creating when its form is pending,
updating when it is stored. There is no "save all". A refused save keeps the card
open and puts the store's own sentence in the message line, unchanged in wording.

### D4 and D5 — creation mode, and the nav's create field goes

- Adding **clears the selection, empties the form, focuses Label, and writes
  nothing**. No row carries the selected mark; the list keeps showing exactly what
  the store holds and gains nothing. This is creation mode. An empty form is not
  mistakable for a failed read, because a read that failed says so in the card's
  message line and a form that loaded says nothing there.
- The emptied form is the shape a new entry already has: no label, no persona, both
  hub switches off, the tool loop at its floor, no model. Task 02's creation-form
  function owns that shape — do not build a second one in the component.
- **No wording changes to announce it** (§6.3). The heading above the toolbar reads
  `Agents` in every state and the dialog's title reads `Agents` too. No `New agent`
  caption, no banner, no badge: the cleared selection and the empty form *are* the
  signal.
- The id is derived from the label as it is typed, as today; an empty label yields
  the neutral placeholder id, correctable in the Id field, which is shown **only on
  a new agent** exactly as it is now.
- **Save writes it, and only when the form is complete.** An incomplete form is
  refused with a message in the line and nothing is written (task 01's rule, now
  applied to a form with no row). On success the list re-baselines on the store's
  answer, the new agent's row appears **selected**, and the form stays open on it.
- **Clicking any agent in the list ends creation mode**, cancelling the creation
  **by design**: nothing was written, so nothing needs confirming, and the agent
  clicked is shown instead (§6.5). No prompt.
- **Leaving the card ends it too**, discarding the half-typed form. Task 05's close
  guard asks first, because by then creation mode counts as unsaved work.
- **Add is inert in creation mode and while a write is in flight**, and both
  reasons are in its tooltip (D5). It is live whenever the list is loaded — adding
  is not dangerous and writes nothing. In creation mode add is the only control that
  can be inert while nothing is selected; that is the single case where "nothing
  selected" does not mean "nothing is happening".
- **A new agent is not an entry until it is saved.** Creation is a form-only state:
  no row, no id in the list, nothing for the toolbar to delete. Adding no longer
  runs through the draft-appending function; a new agent goes straight to the write.
  The creation state is task 02's; the card only renders and holds it.
- **A new agent may be saved without a model.** That is legal and unchanged: the
  agent exists, cannot be sent to, and the form's quiet model line says so.
- The **`New agent label` field and `+ Create agent` button are removed** from the
  nav. The label is typed in the form, which is where it is read back.
- **`addAgentToDraft` goes with them.** It appended a tab and made a not-yet-stored
  row an entry of the list, which is exactly the behaviour D4 removes, so delete it
  from the composable rather than leaving an unused export — that is how the
  new-agent-in-the-list rule would grow back.
- Several existing cases in the two unit suites use it only as a *fixture*: they
  need "a new entry" to judge (`idEditableFor`, `idValidityProblem`,
  `deleteOfferedFor`'s refusal). Repoint those at task 02's creation-form function,
  which produces exactly that shape without touching the draft, and keep their
  assertions as they are. The cases that asserted the *appending* itself are deleted,
  since the behaviour they pinned is the one this task removes.

**Do not** run the e2e spec in this task; it is rewritten in 07.

## Files

- `web/src/components/AgentModesDialog.vue`
- `web/src/composables/useAgentModes.js` — only if a slot verdict needs a shape
  task 02 did not give it. Task 02 is the owner of those functions; keep the change
  there and minimal.
- `web/src/styles/theme.css` — the card's new column geometry and the toolbar's
  fixed slots. Do not sweep the card's dead rules yet; task 06 does that.
- `web/tests/agentModesDialog.test.js` — the mounted card: the toolbar's slots and
  their names/tooltips, the save-stays-open case, the title, the per-entry edit
  retention, the removal of the nav's create field, creation mode entering and
  abandoning, and the new agent saved from an empty form (still open afterwards,
  with the new row selected).
- `web/tests/agentModes.test.js` — the creation-form cases only, if task 02 left a
  gap. Task 02 owns those functions.

## Rules it must not break

From this project's instructions (`AGENTS.md`):

- *"The tree's per-file-type icons are **generated**: edit the source tables and
  regenerate, never hand-edit the artifacts."* The toolbar's glyphs are not
  file-type icons: they are inline SVGs in this component, and the tree's icon
  source tables and artifacts are **not** touched.
- *"`components/` and `styles/` are the widgets and the theme."* Geometry lives in
  `theme.css`; the component renders classes, not measurements.
- *"Core owns logic, the API owns transport."* And spec **D3** / §5's closing rule:
  *"an action's availability is a composable function, never a condition written in
  the template."* A `v-if` that decides whether a verb is usable is a defect.
- *"`lib/` holds the single markdown renderer … never raw `v-html`."* The names and
  tooltips are plain text.
- *"Every write surface is the browser's alone** — the Editor's file routes and the
  settings-store routes — and the file ones are refused while a chat reply
  streams."* The three agent writes keep their shapes and their refusals; this task
  changes when the card closes and what the toolbar shows, not what a write does.
  The agent routes were never gated on a reply and still are not.
- *"Tests stay hermetic"* — the mounted-card suite stubs `fetch`.
- **The client names no reserved agent id, and compares none.** Enforced by the
  scan in `tests/test_write_surface_isolation.py` and the source scan in
  `web/tests/agentModes.test.js` (no `id === '…'` in this component or its
  composable). `readonly` / `deletable` drive every verdict, including the delete
  slot that lands next.

## Depends on

Tasks 01 and 02. Task 01 owns the message line and the refusal verdicts; task 02
owns every slot verdict, the creation form and the baseline.

## Done when

- The card is titled `Agents`, its accessible name follows, and a toolbar sits
  above the agent list in the left column while the form's fields start at the
  toolbar's height (§6.1).
- The footer holds one `Close` on the right and no `Save`; `Close` writes nothing
  and closes the card (the guard is task 05).
- Add and save are icon buttons with a house inline SVG, an accessible name equal
  to their tooltip, and a reason when inert; no dependency was added to
  `web/package.json`, and the tree's icon tables are untouched.
- Clicking a row shows that agent's form and the toolbar acts on it — no Edit
  button exists (§6.2).
- `Add agent` clears the selection, empties the form, focuses the Label field, and
  writes nothing; the list gains no row, the heading still reads `Agents`, and no
  caption, banner or badge appeared anywhere (§6.3).
- Typing a label and saving creates the agent, re-baselines the list and selects
  the new row; the card stays open (§6.4).
- Clicking an agent in the list while a new agent is being typed abandons the
  creation without asking and shows the clicked agent (§6.5).
- A successful save of a stored agent re-baselines the list, keeps it selected, and
  preserves another agent's typed edits (§6.18).
- The `New agent label` field, the `+ Create agent` button and the draft-appending
  call they used are gone from the card, not merely hidden.
- `grep` finds no `v-html` in the component and no `/api/` spelling in it.
- `pytest` and `cd web && npm test` pass. The e2e suite was **not** run: it drives
  the affordances this task moved and is rewritten in task 07.

Finish by moving this file into `todos/done/`.
