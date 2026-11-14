# 08 — The README names the toolbar, and `AGENTS.md` stays true

**Read first**: `docs/agents-dialog-rework.md` §9's first table. Documentation only:
no code change in this task. Run it after task 07 so the suites it describes are
green.

## Deliver

1. **`README.md`, §"The agents — the pencil beside the composer's dropdown"**
   (around its "plus create and delete" sentence) — it describes the dialog as a
   list with a create field and a delete button. Name the **toolbar** and the
   **`Agents`** title instead, and say what the three verbs act on: **the selected
   agent**. Keep it the README's voice and its altitude — it tells a reader how to
   use the dialog, not how it is built, so do not enumerate the CSS, the slots'
   geometry or the message line's priority order.
2. **`README.md`'s WorkBench paragraph (the pencil)** — the same wording, kept in
   step with the line above. These two passages describe one thing; a reader who
   finds them disagreeing trusts neither.
3. **`AGENTS.md` — only if a sentence there describes the dialog's shape.** Today
   it names the mode and what a mode does to a turn, not the card's layout, so it
   may need **no change at all**. Check the two places that could have gone stale:
   - the **WorkBench** bullet, which describes the tabs and the batch mode, and
   - the **"One behavioural change"** the spec records — an incomplete form is now
     refused on click. If `AGENTS.md` says anything about how the card validates,
     make that sentence true; if it says nothing, add nothing. It is injected into
     every agent turn, so a sentence added "for completeness" is paid for on every
     turn forever.

While in these files, obey this file's own rules — they take precedence over
anything generic. Its Rules section says this file "states **what the app is and how
its pieces fit**, not how to build it", forbids "**code details that move**: no line
numbers, quoted code, exhaustive route or member lists, counts or version numbers",
asks for "a **big-picture view only**: what each part is and which invariants hold",
and closes with "Keep it **short and current** — the shorter it is, the more of it a
model actually holds. When the code a paragraph described changes, shrink or cut the
paragraph instead of appending a newer one beside it."

**Do not** put the mockup's ASCII layout, the slot table or the D-numbering into
either document: the spec is the record of the decisions, and the README describes
what a user does. A machine-specific detail (a port, a path, an install command)
belongs in the README and not in `AGENTS.md`, as today.

**§9's table is the whole of it.** It names two passages. It does **not** ask for the
dialog to be renamed wherever the README mentions it: that section's own heading,
and the two passing references to "the Agent-modes dialog" elsewhere, still name a
dialog a reader reaches by the same pencil. Leave them, and say so if you were
tempted to sweep — a wide rename in a doc nobody asked to rewrite is how a small
task grows a diff.

## Files

- `README.md`
- `AGENTS.md` (only if a sentence there is now false)

## Rules it must not break

From this project's instructions (`AGENTS.md`):

- The documentation rules quoted above — especially *shrink rather than append* and
  *no code details that move*. This lot moved controls, not invariants, so the
  likely correct edit to `AGENTS.md` is **nothing**.
- *"Setup, run and test commands live in the README; read that when you need to
  build, install or launch something on this machine."* Do not move a command into
  `AGENTS.md`, and do not put a machine-specific path in it.
- *"One idea per bullet"* (from that file's **Maintaining this file** section). If a
  README sentence is doing two jobs, split it rather than growing it.
- No secret, real key or machine-specific path in either file. The README's existing
  rule about the test settings file stands: it may hold a real key; no document
  about it may.

## Depends on

Tasks 03–07 — it documents the finished card, including the behaviour 03 (save stays
open, creation mode) and 05 (the close guard) changed.

## Done when

- Neither `README.md` nor `AGENTS.md` still describes the dialog through a "plus
  create and delete" phrasing, a create field in the list, or a `Cancel`/`Save`
  footer.
- The README names the toolbar, the three verbs acting on the selection, and the
  `Agents` title, in both passages and in the same words.
- `AGENTS.md` is **not longer** than it was, and every sentence in it is still true
  of the code as it now stands.
- `pytest` and `cd web && npm test` pass (documentation-only; confirm nothing
  asserts on the text of these two files), and `cd web && npm run test:e2e` still
  passes.

Finish by moving this file into `todos/done/`.
