# 10 — MCP and LSP save from their own toolbars

**Read first**: `docs/settings-dialog-migration-plan.md` §4.7's MCP/LSP exception
paragraph, §4.9, §7.9, §7.10, §8's T10. Then
`web/src/composables/useAppShell.js`'s `loadMcp` / `saveMcp` / `toggleMcp` and
`loadLsp` / `saveLsp` / `toggleLsp`, and the MCP and LSP sections of
`web/src/components/SettingsDialog.vue`. Then `todos/sdmp-00-big-picture.md`.

The footer becomes one shape for all three sections: a message band and `Close`. The
MCP and LSP `Save` buttons move into **their own sections' toolbars**, on the same row
logic the Servers section uses, and their **top-level** lines move into the band.

## Deliver

### 1. A section toolbar for MCP and LSP

Each of those two sections gains a toolbar over its list, of the same shape the
Servers section's has: a heading that never changes wording (`MCP connectors` and
`LSP language servers`, the titles those sections already carry — move the title into
the heading position, do not add a second one), then one **save slot** at the left.

- One verb is enough here, and it is the section's own: `Save` — it writes the
  `enable` flags (`saveMcp` / `saveLsp`). There is no add and no delete: a connector
  and a language server are declared in a file, not created from this dialog, and
  their rows are switched, not removed.
- The slots are the same fixed-width boxes the Servers toolbar uses, so all three
  sections share one geometry and one idiom (spec §4.9).
- The save slot's verdict is a plain function in `useSettingsServers.js` returning
  `{ disabled, label }` — the section's read state and its own in-flight flag decide
  it, exactly the way the Servers section's slots are decided. Labels: `Saving…` while
  a save is in flight; a reason naming the read when the list is not loaded; `Save`
  otherwise. **No condition in the template**, same rule as everywhere else in this
  lot.
- The lists themselves take the flexible row under the toolbar, so they scroll in
  their own bounded area and the toolbar never scrolls away — the `.agent-modes-nav`
  shape, which the Servers section already has.

The MCP and LSP panels keep their `role="switch"` toggles, their badges, their
descriptions and their per-row errors exactly as they are. This is a verb move, not a
redesign of a connector row.

### 2. Their top-level lines go to the band

Move these into `messageFor`'s existing priority list, as the **read's findings** rung
(rung 8) or the **read failure** rung (rung 7), whichever the line is — they are the
same kinds of fact the Servers section's lines are:

| line | rung |
|---|---|
| `The mcp package is not installed. Run …` (`state.mcpInstalled`) | a read finding |
| `state.mcpExternalsError` (the declaration file's validation errors) | a read failure |
| `Loading connectors…` (`state.mcpLoading`) | progress |
| `Nothing declared in .nojae/mcp-settings.json…` (the empty list) | a read finding |
| the same four for LSP (`state.lspInstalled`, `state.lspError`, `state.lspServersError`, `state.lspLoading`, the empty list) | the same rungs |

- **These lines are only said when their section is the visible one.** The band is one
  box for three sections, so it must speak about the section on screen — an MCP error
  must not appear while the Servers tab is open. Feed the section into `messageFor` (or
  into the context it reads) and keep the priorities inside each section's own group;
  do not add a second band.
- The Servers section's own messages keep their priority above these where the two
  would collide (a write in flight is still first).

**Per-row badges and per-row errors stay exactly where they are.** This is a
deliberate exception to "everything at the bottom", settled in spec §4.7 and §12: a
band carrying six connector errors is a list, not a message. Do not move
`connector.error` / `server.error`, do not move the badges, and do not aggregate them
into the band.

### 3. The footer

`<footer class="settings-actions">` keeps the band and `Close`, and the two
`v-if="activeSection === …"` Save buttons go. After this task the footer is one shape
in all three sections: band, then `Close`.

### 4. The tests

- Extend `web/tests/settingsMessageBand.test.js`: with MCP active, an MCP top-level
  line appears in the band; with Servers active it does not. Same for LSP. And the
  two per-row errors still render inside their own panel — assert both halves, so a
  later "tidy-up" cannot sweep them into the band.
- New or extended case for the toolbar: with the MCP section active, its save slot is
  present, carries its verdict's label as both `title` and `aria-label`, and posts
  `POST /api/lsp` / `POST /api/mcp` with exactly the payload it posted before
  (`settingsLspNoIterationsField.test.js` already pins the LSP body — keep it green).
- `web/tests/settingsLspNoIterationsField.test.js` finds its sections by their `h3`
  titles; if a title moves into a heading element, update that finder and nothing
  else. Its two assertions ("no iteration input", "the tick is the whole decision")
  must keep passing unchanged in meaning.
- The footer: no `Save` outside the band and `Close`, in any section.

## Do not

- **Do not add an add or a delete verb** to either section. Declarations are files;
  the dialog switches them.
- **Do not move a per-row badge or a per-row error.** They are the exception named in
  the spec, and it is named so an implementation does not over-apply the rule.
- **Do not change `saveMcp` / `saveLsp`'s payloads.** The ticks are the whole
  decision and the LSP body is the ids and nothing else.
- **Do not add a second message area** for these two sections.
- **Do not touch `src/`.** The `enable`-flag routes already behave.

## Files

- `web/src/components/SettingsDialog.vue` — the two section toolbars, the moved
  titles, the removed footer buttons, the removed top-level lines.
- `web/src/composables/useSettingsServers.js` — the MCP/LSP save verdict and the
  section-aware facts `messageFor` now reads.
- `web/src/styles/theme.css` — this dialog's block: the two sections' toolbar rows and
  list rows, reusing the Servers section's placement.
- `web/tests/settingsMessageBand.test.js`, `web/tests/settingsLspNoIterationsField.test.js`
  — the cases above.

## Rules it must not break

- *"`core/mcphub/` and `core/lsphub/` — the MCP and language-server hubs. They mirror
  each other (discovery, manager, seed) — keep that symmetry when touching either
  one."* The two sections in the dialog mirror each other the same way: same toolbar,
  same verdict shape, same rungs. Do not give one a shape the other lacks.
- *"The declaration files are the only source of truth for what runs. Their `enable`
  flag is the switch; their secrets never leave the server."* The save still writes
  exactly the `enable` flags; the panels still show only what the API sent, which
  carries no `headers` / `env`.
- *"Both read their declarations from the working location's reserved folder and are
  hot-toggled from the UI."* Unchanged: a save is hot and the list re-reads.
- *"Every write surface is the browser's alone … A save backs up what it replaces, a
  delete moves the file into a dated batch."* These two saves are declaration writes
  the browser already owned; nothing here widens them.
- *"Tests stay hermetic: … the hubs are disabled by an environment flag"* — the unit
  cases mount the component with `fetch` mocked; the hub payloads are fixture objects.
- *"Core owns logic, the API owns transport."* No change under `src/`.

## Depends on

Task 08 (the band, and `messageFor`'s rungs).

## Done when

- With the MCP section active its title sits over a toolbar whose one slot saves it;
  the LSP section has the same shape, and both keep their own list scrolling under the
  toolbar.
- The footer holds the message band and `Close` in all three sections, with no `Save`
  anywhere else.
- Each section's top-level lines appear in the band only while that section is
  visible.
- Per-row badges and per-row errors are still inside their own panels.
- `saveMcp` and `saveLsp` post the payloads they posted before.
- `cd web && npm test` is green.

Finish by moving this file into `todos/done/`.
