# 11 — The Agent-modes dialog and the composer, over the store

## Deliver

The dialog stops being a file editor and becomes a store editor, and the composer drops
the lock that died with `editable`. This closes the window task 10 opened: after this
task the pencil works again, the dropdown never freezes, and the composer has a selection
of its own.

**The dialog** (§5.2) keeps its shape — one tab per agent, create-by-label — and loses
the file and its Common tab:

| today | after |
|---|---|
| reads a file document, saves the whole document | reads the agent list, saves per agent |
| mtime conflict line, "saving will create this file" | gone |
| findings that name a JSON pointer | form-level validation messages that name a field |
| app-owned agent absent everywhere | **shown**, as a tab whose fields are disabled |

- **Per-agent tab**: label, id (editable only while new, as today), MCP switch, LSP
  switch, system prompt with the byte counter, **max tool iterations** (new here, D9),
  and **Model** — a dropdown over every configured model, grouped by server.
- The model dropdown has **no "use the default" entry**. Its empty option is an explicit
  choice with a visible cost: *"— no model: this agent cannot run —"*. Selecting it is a
  legal save; the composer then refuses to send (task 12).
- **For a `readonly` agent**: every field rendered but disabled, the model dropdown
  live, and one caption saying why — the fields are nojaé's own, the model is the user's.
  `todoBuilder` shows the same dropdown with the same empty option and the same
  consequence. The client decides all of this from the `readonly` flag and **never from
  the agent's id**.
- **The Common tab is deleted** — its only control edited the setting D5 removed. The
  dialog's existing "open on the composer's current agent" rule becomes the landing
  rule, with the first agent as the fallback it already falls back to.
- Each tab carries a quiet line naming the model it will run on — server and model — or,
  when it has none, the same "cannot run" wording the dropdown uses.
- **Delete** is offered for user-created agents only; a built-in's tab says it cannot be
  deleted.

**The composer** (§5.4): the dropdown offers the same agents in every workspace, and
`todoBuilder` is now in the list. **The mode lock is gone**: a thread that has turned can
switch agent freely, from any agent to any other, including `todoBuilder`. Deleting the
lock deletes its call sites — the lock predicate, the option-disable rule, and the "the
selection did not move" branch of the after-save reset decision (what is left of that
decision is the lot pin alone) — and the tooltip sentence about a fixed mode goes with
them: "a message describing behaviour that no longer happens is worse than no message".
What remains of the dropdown's disabling rules is unchanged: a running lot still renders
the select inert, and the per-hub gray-out of the Tools panels still follows
`mcp_enable` / `lsp_enable`.

**The selected agent is remembered in `localStorage`** (D5, §5.4): the last one chosen,
restored on load, validated against the loaded list, falling back to the first entry when
it is gone. Copy the theme composable's shape — a key constant, a tolerant read, a write
on change — and note the two consequences: a second browser on the same installation can
open on a different agent, and a workspace switch no longer changes it (the agent list is
the same everywhere now, so there is nothing to re-resolve). A session file that carries
an `agentMode` still overrides the remembered choice on resume, exactly as today: the file
describes the conversation, `localStorage` describes the browser, and the more specific
one wins.

**`useAgentModes.js`**: keeps the rules it owns that survive (slug, tab caption,
findings→field mapping — now form-level field messages); the lock rule, the default-mode
rule, the document/draft machinery and the mtime handling are removed; the draft becomes
the agent list. Add the two new plain functions §5.5 names, because both are decisions
rather than rendering: *"can the selected agent run?"* (read the agent row's own field —
task 03 put it there — and the server's sentence; do not re-derive the rule) and
*"remember / restore the chosen agent"* around the key.

## Files

- `web/src/components/AgentModesDialog.vue`, `web/src/composables/useAgentModes.js`,
  `web/src/components/WorkBenchInput.vue` (the dropdown, the pencil, the removed lock),
  `web/src/composables/useAppShell.js` (drop the per-switch reload of modes and helpers —
  they no longer change on a switch — and the `agentModes` state block).
- `web/tests/agentModes.test.js`, `web/tests/agentModesDialog.test.js`,
  `web/tests/agentModesPencil.test.js`, `web/tests/useWorkspaceSwitch.test.js`,
  `web/tests/appBarConnectionOnSwitch.test.js`, `web/tests/batchPrefixDropdown.test.js`.
- `tests/test_write_surface_isolation.py` — the test that `web/src` holds no reserved id
  is **extended** to assert the flag, not an id, drives disabled rendering.

## Rules it must not break

- **`AGENTS.md`**: "`web/src` never contains a reserved agent id. The client recognises
  the app-owned mode by a data flag, not by its name." This is the task where it is most
  likely to be broken — the temptation is to write `id === 'todoBuilder'`.
- **`AGENTS.md`**: "composables/ hold app-shell and stream state"; "every decision lives
  in a composable as a plain function, so a component only renders answers"; "no cap is
  spelled in the client: the caps still arrive in the payload" (the byte counter and the
  iteration floor come from the payload).
- **`AGENTS.md`**: "The tabs share one LLM configuration and one streaming layer" and the
  composer's own rules about streaming/paused states — the pencil's disabled rule
  (`batch.active || streaming`) is unchanged.
- **The lot pin is untouched here**: a running lot still renders the select inert. The
  lot's launch-gate changes are task 12.

## Depends on

Task 10 (the routes and the payload), and task 08 (the model list the dropdown reads).

## Done when

- The dialog reads and saves per agent; the mtime/conflict/"will create this file" paths
  are gone from the code, not just unused.
- `todoBuilder` appears in the dropdown and as a dialog tab with disabled fields and a
  live model dropdown, driven by `readonly`; `grep` for the reserved ids in `web/src`
  returns nothing.
- A thread can switch agent after it has turned, including into and out of `todoBuilder`;
  a running lot still cannot be moved.
- The chosen agent survives a reload, and a remembered id that names a deleted agent
  falls back to the first entry; a session file's `agentMode` still wins on resume.
- The lock tests and the default-mode tests are **deleted, not rewritten**, and replaced
  by a positive assertion that switching agent after a turn is allowed (§5.6).
- Backend and frontend suites pass.
