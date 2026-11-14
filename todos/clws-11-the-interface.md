# 11 — The interface: one workspace per tab, and one sentence for each refusal

**Read first**: `docs/client-owned-workspace-spec.md` §5.1 rules 5–9, §5.2, §5.3
rules 13 and 19, §5.4 rules 22–23, §6's limits, §10 items 7–10, §9's T9. The big
picture's *The tab's own memory* and *What we end with*.

Every behaviour is already in place; what is left is what the user *sees*: one
visible workspace per tab, the field's lock scoped to this tab, the line that says a
workspace's tools are restarting, the sentence for the ceiling, and the entry
point — a new tab lands on the installation folder, a reload returns to its own.

## Deliver

### 1. One visible workspace, and it is the one the tools use

`web/src/components/AppBar.vue` shows the tab's workspace in exactly one place, and
it is the value every request is built from (spec §5.1 rule 9). The field, its `Set`
button, its lock line and its policy note stay where they are. The `title` of the
field is the canonical value (it already is today's shape) and it never shows a
value the tab is not using.

No second readout anywhere: no badge, no second field, no footer line repeating the
path. A tab whose stored folder no longer resolves shows the refusal in the field's
note line and **keeps the stale text**, so the user can fix it rather than retype it
(spec §6's last bullet).

### 2. The lock is this tab's only

`web/src/components/AppBar.vue`'s `locationLocked` reads this tab's chat phase and
this tab's batch state — both already per tab. Verify and add the case:

- A reply streaming in another tab never disables this tab's `Set`.
- This tab's own reply or batch does disable it, with the one-line explanation it
  gives today.

A second tab's state cannot reach this one: the composables hold per-tab state, and
`sessionStorage` is per tab. That is the whole mechanism — say it in the comment,
because a reader coming from the server's old global guard will look for a
broadcast.

### 3. The restarting line

When the payload says this workspace's tools were just rebuilt (`built`, task 06),
the bar shows one line: **this workspace's tools are restarting**. It is a
`role="status"` note, it sits in the field's note band (where the policy note
already lives), it is not an error, and it clears when the next fetch says the tools
are up. A workspace that was let go and is being restarted is the same case: the user
never sees an empty tool catalogue without the line.

If the note band already holds something, the wording that wins is the refusal (an
error outranks a status, exactly as today's `pathLocationError` vs.
`pathLocationPolicyNote` pair does). Add the case.

### 4. The ceiling sentence

When the pool refused to admit this workspace, the bar shows the pool's sentence —
the one `GET /api/workspace` and the hub routes raise — with `role="alert"`, and the
panel that asked shows the same sentence. Nothing is invented in the client: the
sentence comes from the server, verbatim (spec §4.4, "never a silent eviction of the
tab that just asked").

The pool's own summary (which workspaces are live) is **not** rendered as a list.
One sentence, naming the bound and what to do, is the whole of it.

### 5. The entry point

- A **new** tab lands on the installation folder: no stored folder, so
  `loadWorkspace()` answers the server's `default`, and the field shows it. Assert
  that no `localStorage` key and no server-side memory can make it land anywhere
  else.
- A **reload** returns the tab to its own folder and its own agent: both come out of
  `sessionStorage`, and the first requests carry them. This is the acceptance item
  that most easily rots, so pin it in a unit case (the real browser proof is task
  12).
- A **closed** tab forgets both, which is the same statement read backwards — no
  test can observe a closed tab, so the case asserts the keys are the tab's
  (`sessionStorage`) and that nothing writes a browser-wide copy.

### 6. Two smaller things the interface says

- The `Editor` pane's empty state and the tree's own root label read the tab's
  folder. They already read `workspace_root()`'s answer through the tree payload;
  verify both show the tab's folder and not the installation's (spec §5.1 rule 2).
- The Settings dialog gains **no** workspace control. It is the installation's
  (spec D2), and a folder field there would say the opposite. Check that nothing in
  it reads or writes the workspace, and say so in the dialog's own comment.

### 7. Tests

`web/tests/` — mounted cases for the bar: the lock scoped to this tab, the
restarting line, the ceiling sentence, the refusal keeping the stale text, the entry
point and the reload; and the tree/editor root label. Nothing new on the server side
in this task.

## Files

- `web/src/components/AppBar.vue`
- `web/src/composables/useWorkspaceSession.js` — the note/error slots and their
  precedence, as plain verdicts
- `web/src/components/SettingsDialog.vue` — verification only
- `web/src/components/WorkspaceNavigator.vue`, `EditorView.vue` — the root label
- `web/src/styles/theme.css` — the note band's second line, if it needs one
- `web/tests/` — the bar's cases, the tree label's case

## Rules it must not break

- *"`components/` and `styles/` are the widgets and the theme."* Geometry and colour
  live in `theme.css`; the component renders classes.
- *"composables/ hold app-shell and stream state …; components use them directly."*
  Every verdict ("is Set disabled", "which note wins", "is the ceiling in force") is
  a plain function in a composable; a condition spelled in the template is a defect.
- *"`lib/` holds the single markdown renderer — all rendered HTML goes through it,
  never raw `v-html`."* Everything here is text.
- *"A refusal names the folder and the rule that fired. It never confirms what it
  refused to look at"* (spec §5.2 rule 11) — the client renders the server's
  sentence and composes none of its own.
- *"No cross-tab invalidation"* (spec D7) — no `storage` event listener, no polling,
  no broadcast. A stale tree is accepted behaviour.
- *"Tests stay hermetic"* — the mounted suite stubs `fetch`; no real folder, no real
  server.

## Depends on

Tasks 01–10.

## Done when

- The bar shows one workspace — this tab's — and no second readout exists.
- A reply or batch in another tab never disables this tab's `Set`; this tab's own
  does, with its one-line reason.
- A rebuilt workspace's tools show as "restarting", as a status, cleared when up, and
  a refusal outranks it.
- The pool's ceiling shows as one alert sentence, verbatim, in the bar and in the
  panel that asked.
- A new tab opens on the installation folder; a reload returns to the tab's own
  folder and agent; nothing writes a browser-wide copy.
- The tree and the editor name the tab's folder; the Settings dialog holds no
  workspace control.
- `pytest` and `cd web && npm test` are green. The e2e suite is **not** run.

Finish by moving this file into `todos/done/`.
