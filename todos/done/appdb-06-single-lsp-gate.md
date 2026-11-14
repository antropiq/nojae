# 06 — One LSP gate: the workspace declaration's `enable` flag (D13)

## Deliver

LSP activation stops being a pair of gates that must agree and becomes **one gate**:
the per-entry `enable` flag in the workspace's `.nojae/lsp-settings.json`. The
workspace-settings member `lspEnabled` stops being read, and `config.lsp_enabled_ids()`
— the function that implemented the second gate — is deleted. This is the only part of
the lot that **alters behaviour** rather than relocating it, so the spec's §9 forbids
splitting it: the route change, the panel change and the inverted assertions land
together.

1. **The single gate.** Everywhere the app decided "is this server running here?", the
   answer is the declaration's `enable` flag alone: `config.lsp_enabled_ids()` deleted,
   and its call sites (the LSP hub's active-id computation in `src/api/server.py`, the
   `_lsp_payload` / `POST /api/lsp` / restart paths in `src/api/routes.py`) reduced to
   the declaration flag. This makes the two hubs **symmetric** — MCP has had one gate
   since before this change, "single source of truth, no `.env` key involved", and the
   code comments already name that as the precedent the LSP file follows.
2. **`POST /api/lsp` changes shape, not just storage.** Its payload drops
   `maxIterations`; it writes the declaration's `enable` flag **only** (no more
   `lspEnabled` into the workspace settings file); and the `active` flag its response
   reports per server becomes the declaration's `enable` alone. `GET /api/lsp` stops
   reporting a shared `maxIterations` that this route can no longer set — check what
   the MCP payload still carries and leave that to task 09, which moves the cap
   per-agent (D9).
3. **The LSP section of the Settings dialog**: the checkboxes now drive the
   declaration's `enable` flag alone, so a ticked row means "this server runs here"
   with no further agreement required. **The row's tooltip has to say that plainly**,
   because the meaning of a tick changed.
4. **The behaviour change, stated where a user will read it** (the spec insists on
   this rather than leaving it a side effect): a cloned or freshly-authored workspace
   with `enable: true` declarations starts those servers on first open. That is the
   honest reading of a file that says "enabled", and it is what makes the declaration
   file the single source of truth the app's rules already claim it is.
5. **The tests invert.** The pair of assertions in `tests/test_lsp.py` that says
   "declared `enable: true` but not in `lspEnabled`, so nothing runs" becomes "the
   declaration alone decides". The spec calls these the tests to read first when
   implementing D13. Add the second half of AC-9: an agent whose `lsp_enable` is false
   still cannot reach a running server — that is a **different axis** and it survives.
6. **What must NOT be swept.** The name `lspEnabled` does not free up: the chat payload
   and the Editor's query route already carry a `lspEnabled` field that is the
   *conversation*-scoped allowlist the Tools panel holds. That field is untouched, and
   it is still intersected with the now-single activation gate. Code and comments must
   not let the two meanings converge on one word — a sweep that deletes every occurrence
   of the word breaks the Editor pane. Name the two things distinctly in any comment
   you touch.

## Files

- `src/config.py` (`lsp_enabled_ids()` deleted), `src/api/routes.py`,
  `src/api/server.py`, and whatever in `src/core/lsphub/` consulted the second gate.
- `web/src/composables/useAppShell.js` (the LSP save payload),
  `web/src/components/SettingsDialog.vue` (the row's tooltip).
- `tests/test_lsp.py`, `tests/test_lsp_editor.py`, `web/tests/settingsLspNoIterationsField.test.js`,
  `web/tests/workbenchLspPanel.test.js`, `web/tests/useEditorLsp.test.js` as needed.

## Rules it must not break

- **`AGENTS.md`**: "Both read their declarations from the **working location's**
  reserved folder and are hot-toggled from the UI" and "The declaration files are the
  only source of truth for what runs. Their `enable` flag is the switch". This task is
  that rule, applied to LSP.
- **`AGENTS.md`**: "`core/mcphub/` and `core/lsphub/` mirror each other … keep that
  symmetry when touching either one."
- **A mode only narrows**: `agents.lsp_enable` (today's `mode.lsptools`) stays exactly
  as it is — a persona that may not reach the hub is an independent fact from a
  workspace that activates a server, and the pair expresses them without a third store.
- **The conversation-scoped allowlist is untouched** (point 6 above).
- **The hub's teardown is untouched**: "Teardown kills process *trees*, not wrappers."

## Depends on

None of the store tasks, strictly — but it lands after 04 so the suite is already
store-shaped. It must land **before** 09 deletes the workspace-settings file, because
it removes the file's last reader-side use of `lspEnabled`.

## Done when

- `grep` for `lsp_enabled_ids` returns nothing, and `grep` for `lspEnabled` in `src/`
  returns only the conversation-scoped allowlist (chat payload, Editor query route) —
  each of those occurrences still means the allowlist.
- The inverted LSP tests pass, plus the new assertion that an agent with `lsp_enable`
  false cannot reach a server that is running (AC-9).
- `POST /api/lsp` accepts no `maxIterations` and writes only the declaration file; a
  test asserts the declaration's `enable` flag is what changed on disk.
- Backend and frontend suites pass.
