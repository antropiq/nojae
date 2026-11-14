# 05 — `Close` asks in place before it discards anything

**Read first**: `docs/agents-dialog-rework.md` D8 in full (including the
`Q2 = B` paragraph), Q5 in §8, §3's footer band, D10's second bullet, and §6 items
15 and 17. The spec's *"One tension that was resolved, not left implicit"* is the
reason this task exists at all: the save slot was decided not to care about
dirtiness, and the close guard cannot ask a question it cannot answer, so the
baseline lives in exactly one place.

## Deliver

### The footer's single `Close`

Task 03 already put `Close` where `Cancel` was, and it closes the card and writes
nothing. What this task adds is the guard, and it must hold for **every** way out:

- **Escape and a backdrop click count as `Close` in every respect**, and so take
  the same guard — otherwise they are a silent bypass. That includes the card's
  native `<dialog>` close path and its existing backdrop handler, and the pencil's
  own `@close` handler upstream, which must not be reachable while a close
  confirmation is pending.

### The guard

- **While the card holds unsaved work, `Close` asks first, in place**: the
  two-glyph pair appears in the footer's **reserved slot**, left of `Close`, and no
  sentence is added, no dialog is nested, and the footer's height and `Close`'s
  position do not move. With nothing unsaved, `Close` closes immediately and the
  pair never appears.
- The pair reuses the delete confirmation's idiom, so the card teaches it once:
  a red-cross **`Keep editing`** and a green-check **`Discard and close`**, each
  glyph's tooltip being its accessible name. It is absent from the DOM — not merely
  invisible — until a close is being confirmed (§6.17).
- **Would closing lose something?** is task 02's `closeWouldLoseFor`: the per-entry
  baseline comparison, plus **always yes in creation mode**, where nothing was ever
  written. Nothing else contributes.
- While a close confirmation is pending, the toolbar's three verbs are inert
  (§5's last two rows). One destructive decision at a time.
- **If a delete confirmation is pending when `Close` is clicked, the delete is
  abandoned** (nothing was written) and the close guard answers on its own terms.
- Focus lands on **`Keep editing`** — the safe answer — when the pair appears, the
  same way the delete pair lands on its cancel.
- `Discard and close` closes the card without writing. `Keep editing` hides the pair
  and changes nothing else, including anything typed.

### The baseline stays off the save path

There is **no `Nothing to save` state and no dirty gating on the save slot**
(§6.9): re-saving an untouched agent is allowed, and a case must assert it, because
this is exactly the invariant the baseline's presence invites an implementer to
break. If a change to the save verdict looks convenient while wiring the guard, do
not make it: the spec dropped that gating deliberately (Q2).

## Files

- `web/src/components/AgentModesDialog.vue`
- `web/src/composables/useAgentModes.js` — only if a close verdict needs a shape
  task 02 did not give it; task 02 owns `closeWouldLoseFor` and the baseline.
- `web/src/styles/theme.css` — the footer's reserved slot and the pair's look, if
  task 03 did not already leave the slot reserved and empty-ready.
- `web/tests/agentModesDialog.test.js` — with unsaved work `Close` asks and the pair
  is in the reserved slot without `Close` moving; with none it closes at once;
  Escape and a backdrop click take the guard; `Keep editing` restores nothing and
  changes nothing; a pending delete is abandoned when `Close` is clicked; re-saving
  an untouched agent still saves.

## Rules it must not break

From this project's instructions (`AGENTS.md`):

- *"Every write surface is the browser's alone — the Editor's file routes and the
  settings-store routes"*, and *"Every WorkBench turn runs in an agent mode … It only
  ever narrows what settings and the conversation already allow."* Closing a card
  writes nothing and changes no agent; `Discard and close` in particular must **not**
  issue any write or reset any store row — it drops the in-memory form only.
- *"Core owns logic, the API owns transport"* and spec **D3**: the pending-close
  state and the "would closing lose something" answer are composable functions; the
  template renders their answers, and the two pairs' labels come from one value each
  so name and tooltip cannot drift.
- *"`lib/` holds the single markdown renderer … never raw `v-html`."*
- *"Tests stay hermetic."*
- **The client names no reserved agent id** — nothing here reads an id, and the two
  scans that assert it stay untouched.
- **D10**: *"The footer reserves the pair's slot, so `Close` never moves."* Assert it
  by measuring, not by reading the stylesheet.

## Depends on

Tasks 01 (the message line the same band holds), 02 (the close verdict and the
baseline), 03 (creation mode, which counts as unsaved work) and 04 (the pair idiom
this one reuses, and the "one destructive decision at a time" rule).

## Done when

- With unsaved work, `Close` — and Escape, and a backdrop click — reveals
  `Keep editing` / `Discard and close` in the footer's reserved slot, and `Close`
  does not move when they appear (§6.15).
- With nothing unsaved, `Close` closes immediately and the pair is never rendered.
- Both buttons of the pair are absent from the DOM until a close is pending
  (§6.17), and focus lands on `Keep editing` when they appear.
- `Discard and close` closes the card and posts nothing; `Keep editing` leaves the
  form exactly as it was.
- A pending delete is abandoned when `Close` is clicked, and nothing was written for
  it.
- Re-saving an untouched agent is still allowed — no `Nothing to save` state, no
  dirty gate on the save slot (§6.9).
- `pytest` and `cd web && npm test` pass. The e2e suite was **not** run: task 07
  rewrites it.

Finish by moving this file into `todos/done/`.
