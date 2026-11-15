# 01 — The section is called `Servers`

**Read first**: `docs/settings-dialog-migration-plan.md` §2.2, §4.1, §4.2, §7.1,
§8's T1, §9.1-1 and §9.1-4. Then `todos/sdmp-00-big-picture.md`.

The Servers tab's section strip is relabelled, the section's own title follows it,
and a heading over the tree reads `Servers` in every state. Nothing else moves.

## Deliver

1. **The section strip's first tab reads `Servers`, not `Models`.** The left tree's
   root object is a server, and the toolbar's heading in the mockup reads `Servers`.
   The section's internal id stays what it is today — `useAppShell` and the tests
   key off it, and nothing deep-links a section, so an id rename would be churn.
   Position is unchanged: this dialog's nav already renders horizontally.
2. **The section's own title reads `Servers`.** Today it is the `h3` at the top of
   the Servers section. It is not the dialog's accessible name (that follows the
   title `Settings` above), so the two may say different things without one naming
   the card twice.
3. **A small heading above the tree reads `Servers` in every state** — same rule the
   Agents card settled on (`docs/agents-dialog-rework.md` D4.4): not `Models`, not
   `New server`, not `Editing`. It never changes wording with the selection or with
   whether a row is being typed, because a heading that changed with state is
   exactly the reflow the layout forbids. Its caption in the mockup reads
   `Servers toolbar`; a heading spelling the word "toolbar" is not something a user
   needs to read, so it does not (spec §9.1-1). Give it the same quiet treatment the
   Agents card's heading has (`.agent-modes-heading`), scoped to this dialog if a new
   class is needed, or reuse that class if it lands identically. Its exact placement
   is the layout task's (task 04); here it only has to exist and read `Servers`.
   If a heading is not yet meaningful without the toolbar under it, still add it —
   task 04 places it in the grid without changing its words.
4. **The CSS block's heading comment.** `web/src/styles/theme.css` opens this
   section's block with a comment naming it `-- the Models section (appdb-08)`.
   Change the words to `Servers`. Change no rule in this task; the block's rules are
   tasks 04, 05, 07, 08 and 12.
5. **Leave the reasoning-level select, the sidebar tree, the two forms and the
   `Add server` / `Add model` pair exactly as they are.** They are later tasks'
   business. The sampler list and textarea are task 05; the verbs are task 04.

## Do not

- **Do not rename the section's internal id**, `state.selectedServerId`,
  `state.serverDraft` or any route. This is a wording task.
- **Do not change the `Agents` card.** It shares the nav classes; only this
  dialog's first tab label changes.
- **Do not re-derive the reasoning levels** (spec §9.1-4): the select keeps its
  empty `None` option plus the server's declared list. The mockup's `Option 1` is a
  placeholder, not a new source of values.
- **Do not touch `src/`.**

## Files

- `web/src/components/SettingsDialog.vue` — the `SECTIONS` label, the section's
  `h3`, the new heading.
- `web/src/styles/theme.css` — the block's heading comment, plus one rule only if
  the heading needs one.
- `web/tests/settingsModelsSection.test.js` — its `section()` helper finds the
  section by its `h3` text, so it moves with the title. Its own name and comments
  may keep saying "Models section" only if they still describe the store's models;
  where a comment names the *tab*, say `Servers`.
- `web/tests/settingsLspNoIterationsField.test.js` and
  `web/tests/settingsWorkspaceFileNote.test.js` — only if either finds a section by
  a label this task changes (`settingsWorkspaceFileNote.test.js` takes the *first*
  section, so it needs nothing; `settingsLspNoIterationsField.test.js` finds its
  sections by `MCP connectors` / `LSP language servers`, so it needs nothing).

## Rules it must not break

- *"Keep it short and current … When the code a paragraph described changes, shrink
  or cut the paragraph instead of appending a newer one beside it."* A label
  changed is the label changed — no second label left behind for compatibility.
- *"`components/` and `styles/` are the widgets and the theme."* The heading's
  look belongs in `theme.css`, not in a scoped style.
- *"The tree's per-file-type icons are **generated**: edit the source tables and
  regenerate, never hand-edit the artifacts."* Nothing here touches them; the
  sentence is here so no later task in this lot looks for a generated asset.
- *"Tests stay hermetic"* — the tests here mount the component with a mocked
  `fetch`.

## Depends on

Nothing. This is the lot's first task.

## Done when

- The section strip reads `Servers` · `MCP` · `LSP`.
- The Servers section's title and the heading above the tree both read `Servers`,
  and neither changes with the selection, with a new row being typed, or with a
  server having no models.
- The Agents card still shows its vertical nav and its `Agents` heading, unchanged.
- `grep -n 'the Models section' web/src/styles/theme.css` finds the section's block
  describing itself as `Servers`.
- `cd web && npm test` is green.

Finish by moving this file into `todos/done/`.
