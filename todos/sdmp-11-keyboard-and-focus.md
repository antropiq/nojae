# 11 — Keyboard and focus

**Read first**: `docs/settings-dialog-migration-plan.md` §8's T11, §9.1-3, §4.1's
detail strip, §4.4's `+`, §4.7's roles. Then the Agents card's own accessibility
pass in `docs/agents-dialog-rework.md` §6.16 (every slot's accessible name equals its
tooltip) and the e2e spec `web/e2e/04-agent-modes.spec.js`, whose helper functions say
how a slot and an inert slot are queried by name. Then
`todos/sdmp-00-big-picture.md`.

The dialog is usable with a keyboard alone: the tree's rows are reachable, the page
level verbs are reachable, the detail strip behaves as tabs, and the new model `+`
lands with focus on its tree row.

## Deliver

### 1. The tree's rows

- Every server row and every model row is reachable by keyboard and operable by
  `Enter` / `Space` — they are `<button>`s today, so this is a matter of not defeating
  them: no `tabindex="-1"`, no click handler on a non-focusable element, no wrapper
  that swallows the key. The disclosure button stays a separate stop before the name,
  as it is today (one control doing both would make "open without editing"
  impossible).
- **The selected row is the tabbable one.** A tree of 200 models must not be 200 tab
  stops: use a roving tabindex (the selected row `tabindex="0"`, the others `-1`) and
  let the arrow keys move the selection, matching whatever the workspace tree already
  does — read `web/src/composables/useWorkspaceTree.js` and the tree components first
  and follow the house pattern rather than inventing a second one. If the workspace
  tree has no such pattern, implement the plainest correct one and say in the change
  which you followed.
- A row's `aria-current` continues to mark the selection, as today.

### 2. `Fetch models` and every `+` in the listing

- Both are `<button>`s and reachable in tab order; the listing's `+` buttons follow the
  table in DOM order, one stop per row.
- Each carries `title` and `aria-label` from its verdict's `label` — already true after
  tasks 04 and 07; assert it here rather than re-implementing it.
- An inert `+` is `disabled`, and therefore skipped by Tab; the row is still readable.
  Do not add a `tabindex` that makes a disabled control focusable.
- The table's header cell for the `Add` column is a real header so a screen reader
  announces the column, and the `name` cell is the row's header or its text — either
  is acceptable, but the table must be a `<table>` with a `<thead>`.

### 3. The detail strip behaves as tabs

- Roles: the strip is a `tablist`, each tab is a `tab`, and the panel below it is a
  `tabpanel` associated with the selected tab by `aria-controls` / `aria-labelledby`.
  The panel is focusable (`tabindex="0"`) so a keyboard user can reach its content the
  way the tab pattern expects.
- `aria-selected="true"` on the selected tab and `false` on the other — in addition to
  (not instead of) the visible `active` styling and the `aria-current` the section
  strip uses, so the two strips stay visually consistent while this one is also a real
  tab set.
- **Arrow keys move between the two tabs** and do not wrap into the section strip; the
  roving tabindex rule applies here too (only the selected tab is a tab stop). On the
  server page there is one tab, and the arrow keys do nothing rather than escaping.
- The section strip keeps today's behaviour. Do not convert it to a tablist here — the
  spec's `T11` is about the detail strip, and the section strip's job is navigation
  between peers, not panels of one page.

### 4. Where `+` lands

Spec §9.1-3 fixes it: after a listing `+` writes the row, focus goes to **the new
model's tree row**, not to its Name field. The name is already in the field, and
focusing the row is what makes the tree's keyboard position coherent and lets Tab walk
into the form from there.

- Task 06's `addModelFromListing` selects and expands; this task adds the focus.
  Prefer a focus request the component performs after the answer lands (a `nextTick`
  after the state change, keyed on the newly selected row) over an imperative
  `.focus()` inside the composable — the composable holds no element.
- A unit test can assert the request (the component focused the element that renders
  the newly selected model row); a browser assertion belongs to task 14's spec.

### 5. The band's announcements

The band already carries `role="alert"` / `role="status"` from `messageFor`. Verify
both are reachable in the mounted DOM, that a change from one to the other does not
require a re-mount to be announced (an element whose `role` changes is not
re-announced by every screen reader — if that is a real risk, give the band a stable
`aria-live` region and set its `aria-live` from the answer instead of swapping `role`;
say in the change which you chose and why).

## Do not

- **Do not restructure the layout.** This is behaviour and ARIA; nothing moves.
- **Do not change a verdict's label.** The names are already the accessible names.
- **Do not add a keyboard shortcut.** Every action here is reachable by Tab and
  Enter/Space; a chord would be a second way to say the same thing.
- **Do not convert the section strip into a tablist**, and do not add roles to the
  toolbar's slots beyond the `role="group"` it already carries.
- **Do not touch `src/`.**

## Files

- `web/src/components/SettingsDialog.vue` — the tree rows' roving tabindex and key
  handling, the strip's roles and arrow keys, the focus request after a `+`, the
  table's header cells, the band's announcement attribute.
- `web/src/composables/useSettingsServers.js` — only if a focus or tab fact belongs
  there (it should not; the tab's selection is state, its movement is a key handler).
- `web/src/styles/theme.css` — the focus ring for a focused tree row, scoped to this
  dialog, if the house style does not already give one.
- `web/tests/settingsDetailTabs.test.js` — the strip's roles, `aria-selected` and the
  arrow-key movement.
- `web/tests/settingsKeyboard.test.js` — new: the tree's roving tabindex, the row key
  handling, and the focus landing on the new model's row after a `+`.

## Rules it must not break

- *"Desktop browsers only."* Not a mobile-accessibility task; no touch targets, no
  responsive work.
- *"`components/` and `styles/` are the widgets and the theme."* The focus ring, if
  one is added, is a theme rule.
- *"composables/ hold app-shell and stream state … components use them directly."* A
  key handler and a focus call are the component's; the selection remains the
  composable's.
- *"Tests stay hermetic"* — mounted cases with `fetch` mocked; no browser needed.
- *"A lot runs every task in one agent, read from the composer's dropdown at launch"*
  — unrelated; nothing here touches a turn.

## Depends on

Tasks 05 (the detail strip), 07 (the listing table's `+`), and 09 (the confirmation
pair, whose slots are tab stops only while rendered).

## Done when

- The tree is operable with Tab / arrows / Enter alone, one tab stop per tree, and the
  selection follows the arrows.
- `Fetch models` and each `+` are reachable by keyboard in a sensible order; an inert
  one is skipped rather than focusable.
- The detail strip exposes `tablist` / `tab` / `tabpanel`, keeps `aria-selected` in
  step, and moves between its two tabs with the arrow keys without leaking into the
  section strip.
- After a `+` in the listing, focus is on the new model's tree row.
- The band's message is announced with the right politeness in both its roles.
- `cd web && npm test` is green.

Finish by moving this file into `todos/done/`.
