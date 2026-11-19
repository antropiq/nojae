# Task 07 — The dialog: three pages, rendering answers only

## Deliver

`web/src/components/ConnectorWizardDialog.vue` — the one modal both families share
(§3, §11), mounted once where the other app-level dialogs are mounted (in
`App.vue`, beside `BatchModeDialog`, so it survives a tab switch and is not owned
by either panel). It renders task 06's answers; **it decides nothing**.

**Page 1 — choose.** Scrollable candidate list. MCP: the catalogue's entries (name
+ one line of what it is good for), identical on every machine and in every folder
because no model has run. LSP: the proposed servers, best first, each with its
evidence line beneath it. Exactly one selection, one "continue" button, disabled
until a candidate is chosen. A waiting line while the proposal is in flight — a
status line, never a token stream: this dialog never streams. The empty answer
renders the stop sentence and nothing else: no entry, no field, no link to the
JSON.

**Page 2 — prepare.** The waiting state, then the answer: the **complete JSON
member** shown in full (every value the model resolved — an executable path, a
workspace root, a key's variable name — shown as part of the member, never
summarised away), the readiness line (`looks installed` / `not installed`) with
the install line ready to copy beside it when something is missing, the
per-platform install lines where they differ, and the decision lines — one line
each, "anything platform- or project-specific it had to decide", so the reasoning
that shaped the member is visible. A local candidate the hub would refuse shows the
hub's own sentence here, not after a restart. A `not installed` candidate is
present, flagged, never dropped.

**Page 3 — apply.** The member **verbatim** in a read-only block, the copy action
as the **primary** button (through the app's one clipboard helper, so the fallback
path is shared and the button says whether it landed), and beside it: the verdict
in the loader's words; the duplicate-id warning if it fired; the sentinel warning
when a slot carries it; the absolute path of the declaration file it belongs in;
the missing-file variant of that sentence when the file does not exist; and the one
sentence that the app reads the declaration only at start-up, so a **restart** is
what applies it — pointing at the panel's own restart button. **No restart control
in this dialog.**

**On every page, from the moment the dialog opens**: the header line naming agent,
server and model. And on every page, no token count, no cost, no timing.

Follow the app's dialog conventions (the `SettingsDialog` / `RegistrationMemoryDlg`
/ `BatchModeDialog` / `AgentModesDialog` family): the same close behaviour and
native-close sync, an `aria-label`led dialog, one message line rather than a
banner, and focus kept where a keyboard user expects it. The snippet block is a
plain `<pre>`/`<code>` through the app's own escape path — **no `v-html` anywhere**;
if it wants markdown highlighting it goes through `lib/`'s single renderer, and
plain text is the honest default here.

## Files it touches

- creates `web/src/components/ConnectorWizardDialog.vue`
- edits `web/src/App.vue` (one import, one mount, beside `BatchModeDialog`)
- edits `web/src/styles/theme.css` — **new rules only**, namespaced (`.wizard-*`),
  reusing the existing dialog classes; no change to a rule another component is
  counted on
- creates `web/tests/connectorWizardDialog.test.js`
- **does not** touch the two panels, the composable, `useChat.js`, or the other
  dialogs' components.

## Rules it must not break

- The template decides nothing: every sentence, every disabled state and every
  verdict arrives from task 06. If this file grows an `if` that judges readiness,
  an id, a family or a value, move it to the composable.
- **"lib/ holds the single markdown renderer — all rendered HTML goes through it,
  never raw `v-html`"** (AGENTS.md). The snippet is text: paste it as text.
- No control that writes: no save, no "remember", no apply-to-file, no restart, no
  toggle. Copy is the only action that changes anything, and it changes only the
  clipboard.
- The install hand-over button **fills the composer and nothing else** — it calls
  the composable's hand-over and never a send, never a focus on a send control.
- Nothing here names a hub route, a declaration path or a package name: the path
  and the member come from the payload. (No wizard sentence may tell the user to
  put a key in `.env` — `.env` is regenerated from a fixed template on every
  settings save.)
- Geometry: this task adds no rule to the panels' column width or head layout —
  `web/tests/workbenchToolsColumnWidth.test.js` pins that both panels and the dock
  are independent of what the declaration files hold, and it must stay green
  untouched.
- Tests stay hermetic: `fetch` is stubbed, no spec here talks to a real endpoint.

## Depends on

- **06** — everything it shows is that module's answer; building against an absent
  composable means rewriting this file.

## Done when

1. `cd web && npm test -- connectorWizardDialog` passes, and that file asserts, at
   minimum:
   - the header line is present on all three pages, and the rendered dialog text
     contains **no token or cost number** anywhere (assert the whole rendered text
     for each page, not just the header);
   - page 1 shows the catalogue list without any post being issued, and the LSP
     list with each item's evidence line; selecting one is what starts the work;
   - an empty candidate answer renders the stop sentence and **no** input, textarea
     or free-text control exists in the dialog (AC-18);
   - a failure state renders its sentence and a way to press again, and it is not
     the empty-list sentence (AC-7);
   - page 3's block text is the member verbatim (compare to the payload's string),
     it is read-only, the copy button is the primary action and the copy confirmation
     appears only after the clipboard helper answers;
   - a `not installed` candidate is shown with the install line and the hand-over
     control; the reach refusal sentence appears when the payload carries it;
   - the missing-file variant prints the path and the "create it, member at its top
     level" sentence, and the block is still a member, never a file (AC-19);
   - the sentinel warning appears exactly when the payload says a slot carries the
     sentinel (AC-8a), and no field for typing a secret exists anywhere;
   - the restart **sentence** is present and no control in the dialog issues a
     restart, a toggle or any write (assert no fetch reaches `/api/mcp`,
     `/api/lsp`, `/api/fs` or the settings-store writes);
   - close leaves no state behind for a re-open (AC: no draft, no cached snippet).
2. `cd web && npm test` passes unchanged — including
   `workbenchToolsColumnWidth.test.js` and both panel tests.
3. `git status` shows no change outside the files listed above.
4. **Move this file to `todos/done/`** as the very last step.
