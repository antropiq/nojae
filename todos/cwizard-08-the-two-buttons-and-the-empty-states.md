# Task 08 — The two buttons, and the two empty states

## Deliver

The entry points (§2 of the spec), one line each in the two panel heads:

1. **A `Set me up!` button in `WorkBenchMcpPanel.vue`, and its sibling in
   `WorkBenchLspPanel.vue`** — each at the **left of that panel's existing restart
   button**, in the same head row. Its tooltip **and** accessible name are the same
   string, `Set me up!`, like every icon button in the app. The glyph is a
   sparkle/wand inline SVG with `aria-hidden="true"`, in the same 1.5rem box as the
   restart glyph beside it (reuse `.chat-hub-restart`'s box or add a sibling class
   of identical size). Clicking it opens the wizard **on its own family** and nothing
   else: it sets no toggle, restarts nothing, sends nothing.
   - Its enablement is task 06's gate verdict and its disabled reason is that
     verdict's sentence — the panel adds no rule of its own.
2. **The two empty states reworded** so each invites the click instead of only
   naming the file: the MCP panel's `.chat-hub-empty` line and the LSP panel's keep
   their current information (which file, and that the servers get switched on) and
   add that **that button** sets one up. Keep the `.nojae/mcp-settings.json` /
   `.nojae/lsp-settings.template.json` mentions those tests already look for.
3. **Deliberate test updates**: `web/tests/workbenchLspPanel.test.js` pins "one
   switch per server and the restart button, nothing else" with a button count of
   exactly 1, and `.chat-hub-restart`'s title text. This task **changes that
   promise on purpose** — the second button is the feature. Update those rows to
   name both buttons and to pin the new one's tooltip/accessible name, and update
   `workbenchToolsColumnWidth.test.js`'s empty-state rows only as far as the reword
   requires. State that change in the commit message: an updated contract is fine,
   a silently loosened one is not.

## Files it touches

- edits `web/src/components/WorkBenchMcpPanel.vue`, `web/src/components/WorkBenchLspPanel.vue`
- edits `web/src/styles/theme.css` — only if the head row needs a rule for the
  second button's box (prefer reusing the restart's existing class)
- edits `web/tests/workbenchLspPanel.test.js`, `web/tests/workbenchToolsColumnWidth.test.js`,
  and adds `web/tests/connectorWizardButtons.test.js`
- **does not** touch the composable, the dialog, `App.vue`, `useChat.js`, the dock
  or the column's geometry rules.

## Rules it must not break

- "The family comes from the button that opened the dialog and is never a question."
  One dialog, two entry points, no chooser inside it.
- **Both panels keep their current width, height and head layout, and this button
  never changes either** (§2, AC-1). No new row, no changed flex basis, no renamed
  class another test counts on. `.chat-hub-head` already lays the row out with a
  gap and `flex: 0 0 auto` on the 1.5rem box — the second button joins it as
  exactly that.
- The panel's other promises are untouched: the restart button's own tooltip,
  enablement and spin animation stay word-for-word as they are; the route's error
  line stays verbatim; the row switches and their titles do not change; a hub with
  nothing declared is still "a panel that says so, never a panel that leaves the
  dock".
- The button is **live** during a streaming reply, during a batch, while the
  toggles are locked and while the mode has that hub off — the panel's existing
  `locked` / `gatedByMode` / `canRestart` computations must **not** be reused for
  it (they are the restart's rules). Only the model gate applies, and it comes from
  task 06.
- No sentence is spelled in the template: the tooltip, the disabled reason and the
  empty-state text come from the composable.
- Nothing here writes, restarts or toggles (the panels already own the only writes
  their hubs make — leave that alone).

## Depends on

- **06** (the gate verdict and every string) and **07** (the dialog it opens).

## Done when

1. `cd web && npm test` passes, with:
   - `connectorWizardButtons.test.js` asserting, per panel: exactly one
     `Set me up!` button, positioned **before** that panel's `.chat-hub-restart` in
     the head row; `title` and accessible name equal to `Set me up!`; its glyph SVG
     `aria-hidden`; a click opens the wizard on that family and issues no write, no
     restart and no toggle; with no resolvable model it is `disabled` and its
     accessible name is the existing refusal string, **not** `Set me up!`; it stays
     live with a reply streaming, with a batch running, with the toggles locked and
     with the mode switching that hub off;
   - both empty-state rows asserting the reworded line invites the button **and**
     still names its file;
   - the updated `workbenchLspPanel.test.js` pinning both buttons by name rather
     than a bare count of one, and `.chat-hub-restart`'s title still exactly what it
     was;
   - `workbenchToolsColumnWidth.test.js` green — the panels, the dock body and the
     column carry no width variant and stay independent of the declaration files'
     contents.
2. A visual check of the dock in a browser (both panels, one entry each, head rows
   unchanged in height) — desktop browsers only, per the project's scope.
3. `git status` shows no change outside the files listed above.
4. **Move this file to `todos/done/`** as the very last step.
