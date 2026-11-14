# 09 — The acceptance sweep: §6's twenty items, asserted and grepped

**Read first**: `docs/agents-dialog-rework.md` §6 in full, then §5's table. This is
the last task: it proves the lot delivered the spec, and it fixes what is left.

Nothing new is designed here. Work item by item, and for each one either find the
assertion that already covers it (tasks 01–07 wrote most of them) or add it. A
procedure with no assertion counts as undelivered.

## Deliver — the twenty items, and where they are likely to be covered

| # | item | expected home |
|---|---|---|
| 1 | titled `Agents`, toolbar above the list, one `Close`, no Save in the footer | 03, 06 |
| 2 | selecting a row is the only way into editing | 03 |
| 3 | add clears the selection, empties the form, focuses Label, writes nothing; no row; no caption/banner/badge | 03 |
| 4 | typing a label and saving creates, re-baselines, selects the new row; the card stays open | 03, 07 |
| 5 | clicking an agent during creation abandons it without asking | 03, 07 |
| 6 | Save on an incomplete form writes nothing, one message, slot not disabled | 01, 07 |
| 7 | every message in the one line, bottom-left, on `Close`'s band, nowhere else | 01 |
| 8 | the line holds its place when empty; nothing reflows | 01, 06 |
| 9 | no `Nothing to save` state, no dirty gating; re-saving untouched is allowed | 05 |
| 10 | delete disabled with a reason for a built-in, nothing selected, a write in flight | 02, 04 |
| 11 | delete reveals exactly two slots; the first three do not move; no sentence added | 04, 06 |
| 12 | cancel delete restores nothing and changes nothing | 04 |
| 13 | confirm deletes and selects next / previous / nothing | 02, 04 |
| 14 | selecting another agent while confirming cancels it, deletes nothing | 04 |
| 15 | unsaved work makes `Close`, Escape and backdrop click ask; `Close` never moves | 05, 06 |
| 16 | every slot's accessible name equals its tooltip; a disabled slot explains itself | 02, 06 |
| 17 | both pairs absent from the DOM until pending | 04, 05, 06 |
| 18 | switching rows and back preserves each form's typing | 03 |
| 19 | no affordance shifts another control's position | 06 |
| 20 | `web/src` names no reserved id; the component derives every verdict from the composable | existing scans + 06 |

## What to do with an item that is not covered

Add the assertion where its behaviour lives — the composable's verdicts in
`web/tests/agentModes.test.js`, what is on screen and where it sits in
`web/tests/agentModesDialog.test.js`, the driven flows in `web/e2e/04-agent-modes.spec.js`.
Prefer the layer that can fail for the right reason: a rule belongs in the
composable's suite, a position in the mounted-card suite, a flow in the e2e spec.

## Then the greps

Each must come back empty, or come back with a hit that is provably about something
else — in which case the case or the comment you add says which, so the next reader
does not have to re-run the grep to find out:

- `saveDisabledFor` — the renamed verdict must be gone.
- `agent-modes-create`, `agent-modes-blocking-note`, `agent-modes-field-finding`,
  `agent-modes-delete-refusal`, `agent-modes-file-findings`,
  `agent-modes-server-findings` — in `web/src` and `web/src/styles`, the old card's
  names must be gone from both the component and the stylesheet.
- `Nothing to save` — the dropped state must not exist anywhere.
- A reserved agent id in `web/src` — already two scans' job; re-run them rather than
  trusting this line.
- `v-html` in `AgentModesDialog.vue`.
- `/api/` in `AgentModesDialog.vue`.
- `New agent label` and `+ Create agent` — in `web/` and `README.md`.
- `getByRole('button', { name: 'Cancel' })` in `web/e2e/04-agent-modes.spec.js`.
- A `title=` that differs from the same button's accessible name — read the toolbar
  and the footer once, by eye, and confirm every one of the seven buttons
  (add, save, delete, cancel delete, confirm delete, keep editing, discard and
  close) says one thing in both places.

Also confirm, by reading rather than grepping, that **`git diff web/package.json` is
empty** (`@playwright/test` and the tree's icon generator are the only icon-adjacent
things this project has, and neither moved), and that nothing under `src/` changed
in this lot (`git diff --stat src/`), because §7 puts every backend rule out of
scope.

## Files

- Whatever the sweep proves missing: the two vitest suites, the e2e spec, and — only
  if an acceptance item is genuinely undelivered — the component, its composable or
  its stylesheet.
- This task file is not a report: leave no notes in the lot; the move into `done/`
  is the whole record.

## Rules it must not break

From this project's instructions (`AGENTS.md`):

- *"`tests/test_write_surface_isolation.py` asserts that instead of trusting this
  sentence: no connector, tool or chat path reaches a write route, and the terminal
  is never a tool."* Run it; do not weaken it to accommodate a shortcut taken in an
  earlier task.
- *"Tests stay hermetic"* — and the e2e suite reads `.env.test` and the suite's own
  temporary store, never a developer's connection.
- *"No **machine-specific setup**"* in `AGENTS.md`, and *"no document about it may"*
  spell a secret — if the sweep touches documentation, both still hold.
- *"Core owns logic, the API owns transport"*, and spec **D3**: no acceptance item is
  satisfied by a verdict written into the template. If an item is green only because
  a `v-if` decided it, it is not delivered.
- **§7's out-of-scope list** is a boundary, not a suggestion: no new route, no
  reordering, no id rename, no duplicate-an-agent feature, no change to the pencil's
  label, enablement or mount point, no keyboard shortcut beyond Tab/Escape and the
  confirmation's focus rule. If an item's fix seems to need one of those, the item is
  misread.

## Depends on

Tasks 01–08. Run it last: it reports on the whole lot.

## Done when

- All twenty items of §6 have a passing assertion, and each one is at the layer that
  can fail for the right reason.
- Every grep above is empty or explained.
- `git diff --stat src/` is empty and `git diff web/package.json` is empty.
- `pytest`, `cd web && npm test` and `cd web && npm run test:e2e` all pass, with no
  skipped case in `04-agent-modes.spec.js`.
- Nothing in `docs/` was rewritten: the spec is the record of the decisions and this
  lot implemented it.

Finish by moving this file into `todos/done/`.
