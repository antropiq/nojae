# Agents dialog — toolbar-driven editing

**Status**: **decided** — every question this draft raised has an answer, recorded
in §8. Nothing here is implemented yet.
**Mockup**: [`imgs/dialog-agents.png`](imgs/dialog-agents.png) — the layout this
spec describes.
**Surface**: one existing dialog (`AgentModesDialog`) and its rules composable
(`useAgentModes`), plus the e2e spec that drives them (§9). No new route, no
backend change, no change to what an agent does to a chat turn, no change to when
the dialog can be opened, no icon dependency.
**One behavioural change beyond layout**: an incomplete form no longer disables
`Save` — it is refused on click, with its reason in a single message line (D11).
Everything else here moves controls, wording and state; it does not change what a
write does.

---

## 1. The need

The dialog today does three things in three different places. Its left column
carries the agent list **and** a "New agent label" field with a `+ Create agent`
button underneath it; its right column carries the form **and**, at the bottom
of that form, a Delete button with an in-place confirm; its footer carries
`Cancel` and `Save`.

So an action taken on *an agent* sits inside the agent's own form (Delete), an
action taken on *the list* sits under the list (Create), and the action that
finishes everything sits in the footer next to the one that abandons it. The
three are never visible together, and Delete moves around as the form's content
grows.

The same scattering applies to everything the card *says*: a read failure and the
loader's findings at the top, a red line under each offending field, the delete
refusal under the form, a problem count in the footer. Each of them pushes
different content down at a different moment, so the card moves under the pointer
every time the user fixes something.

The mockup fixes that with the shape every list-plus-form editor has: **one
toolbar over the list holding the three verbs**, and a single `Close` button in
the footer. Verbs act on the selection; nothing is triggered by a mode.

## 2. What exists today (verified against the code)

| piece | where | what it does today |
|---|---|---|
| the card | `web/src/components/AgentModesDialog.vue` | a fixed-size two-column dialog: a nav of one button per agent, and every agent's form (`v-show`), so each agent's in-memory edits survive switching between them. |
| the nav | same, `.agent-modes-nav` | the agent buttons, then a **"New agent label"** field and a **`+ Create agent`** button. Creating appends a *tab* immediately and writes nothing. **Both go away in this rework** — adding becomes the toolbar's `+` and the label is typed in the form itself. |
| the form | same, per entry `<section>` | Label, Id (new entries only), MCP/LSP switches, System prompt with its byte counter, Max tool iterations, Model, a quiet model line, then **Delete** with an in-place confirm. |
| the footer | same, `.settings-actions` | `Cancel` (closes, writes nothing) and `Save` (writes the selected agent, then **closes the card**). |
| the messages | same | **five separate sites**: a loading/error line and the findings at the top of the card, a `role="alert"` line under each offending field, the delete refusal under the form, and a problem count in the footer. All five move into one line (D11). |
| the rules | `web/src/composables/useAgentModes.js` | every verdict as a plain function: `saveDisabledFor`, `deleteOfferedFor`, `entryProblems`, `tabCaptionFor`, `slugForDraft`, plus the draft shape (`entries`, `caps`, `findings`) and the four calls (`fetchAgentDraft`, `saveAgent`, `deleteAgent`). **The component decides nothing** — a test asserts it. |
| the routes | `GET /api/agents`, `POST /api/agents/{add,save,delete}` | unchanged by this spec: a write answers the **whole new list**, which is how the card re-baselines on the store rather than on what it sent. |
| the store's order | `resolve_agents()` | insertion order, with nojae's own app-owned agent moved **last** whatever the table says. A created agent therefore lands just before it. |
| deletion rules | `deleteOfferedFor`, `built_in_agent_ids()` | Delete is offered for **user-created** rows only; every built-in refuses deletion, and the app-owned agent refuses every write but its model. Both answers are **flags in the payload** (`deletable`, `readonly`) — the client never names an agent id. |
| the title | same, `<h2>` | `Agent modes`. |

Two consequences of the current shape that this rework must not lose: per-agent
in-memory edits survive switching rows, and every rule above stays in the
composable rather than moving into the template.

## 3. The target layout

```
+----------------------------------------------------------------+
|  Agents                                                        |
+----------------------------------------------------------------+
|  [ + ]  [save]  [delete]              [ x ]  [ v ]             |
|  +----------------------------+  +--------------------------+  |
|  | Agent list                 |  | Label        Model       |  |
|  |  Chat                      |  | [________]   [ select v ] |  |
|  |  Code                      |  |                          |  |
|  |  Architect                 |  | MCP [on]   LSP [on]      |  |
|  |  Todo builder              |  |                          |  |
|  |                            |  | Max tool iterations [  ] |  |
|  |                            |  | System prompt            |  |
|  |                            |  | [______________________] |  |
|  +----------------------------+  +--------------------------+  |
+----------------------------------------------------------------+
| [ the one message line ]         [x] [v]          [ Close ]   |
+----------------------------------------------------------------+
```

The toolbar belongs to the **left column only** — it sits above the list it acts
on, in the column the list occupies, and the right column's fields start at the
same height as it. The two confirmation slots are at that toolbar's right end, so
they land just left of the form rather than at the card's edge.

- **Left column**: the heading `Agents`, then the toolbar, then the agent list in
  its own bounded scroll area. The toolbar never scrolls away with the list.
- **Right column**: the selected agent's form, scrolling independently. It
  carries **no caption line and no per-field message** — everything the card has
  to say is in the message line below (D11).
- **Footer band**, left to right: the **message line** (D11, always present, empty
  when it has nothing to say), then the reserved confirmation slot holding the
  close pair when one is pending (D8), then `Close`. Every one of those three
  keeps its place and width in every state, so the band never reflows.
- The card keeps the size it has today, so switching selection never resizes
  the dialog.

## 4. Decisions

### D1 — Five toolbar slots, three always visible, two only during a confirmation

Left to right: **add**, **save**, **delete**, then — at the far right — **cancel
delete** and **confirm delete**. The last two are not rendered at all until a
delete is being confirmed (not merely invisible), so they are neither focusable
nor announced before they mean something.

The toolbar is laid out as **five fixed-width slots** (`+` / save / delete at
the left, the pair at the right), not as a flex row that grows. The two right
slots keep their width whether or not the pair is in them, so revealing the pair
moves **nothing**: the first three keep their exact position and the toolbar
never changes height (D10).

Each slot is a small **icon button**, in the app's existing house style: an
inline stroke SVG at the button icon size, coloured from the theme tokens
(`--bi-icon`, `--bi-danger`, `--bi-success`), with the glyph marked decorative.

**No icon package is added.** The app draws every icon it owns as an inline SVG
today, and five glyphs do not justify a dependency with its own font, bundle
cost and theming rules that would then disagree with the rest of the app.

Every slot carries both an accessible name and a tooltip, and the two are the
same words, so a reader, a hover and a test say one thing:

| slot | glyph | name + tooltip | tooltip while disabled |
|---|---|---|---|
| add | plus | `Add agent` | already in creation mode (D5), or a write is in flight |
| save | disk | `Save agent` | `Saving…` while a write is in flight |
| delete | bin | `Delete agent` | the reason: nojae owns it, nothing is stored to delete, or a write is in flight |
| cancel delete | red cross | `Cancel delete` | — (never disabled) |
| confirm delete | green check | `Confirm delete` | — (never disabled) |

A disabled slot always says **why** (the app's rule for every disabled control),
and never in a tooltip that describes behaviour that is not happening.

**Save is not disabled by an incomplete form** — it is clicked, refuses, and says
why in the card's message line (D11). A field the user has not filled yet is not
a reason to take the button away; the click is how they find out what is missing.

### D2 — The list is the selection, and the selection is the edit mode

Clicking a row loads that agent's form. There is no Edit button and no mode to
enter: which row is selected *is* which agent the toolbar acts on.

The selected row is visibly marked (the app's active-row treatment), and the
list keeps the mark it already has for an entry holding problems.

Because each agent's form is still held per entry, selecting another row
**never discards what was typed** in the one you left.

### D3 — Mostly a layout change; four state additions, named

The draft keeps its shape: one in-memory form per agent, plus the caps and
findings the read answered with, exactly as today. The toolbar acts on the
selected one, and `deleteOfferedFor` is called unchanged for that entry. The save
path does change shape — from *disabled while wrong* to *refuses on click and
reports in the message line* (D11) — and that is the one behavioural change in
this rework that is not positional.

Mostly positional: the create affordance, the delete confirm's home, the footer's
buttons, the title. But the decisions do add state, and honesty is cheaper than
an implementer discovering it:

| added state | why | decided in |
|---|---|---|
| "creation mode: nothing selected, an empty form" | add no longer creates a draft entry | D4, D5 |
| a per-entry baseline, for the close guard only | `Close` must know whether anything would be lost | D8 |
| "a close confirmation is pending", with its own pair | the footer asks in place | D8 |
| "the card's one message", with a priority order | every message consolidates into one line | D11 |

None of them changes how a write is shaped or what the store's payload carries.
One verdict changes meaning and must be renamed honestly rather than reused:

| today | after |
|---|---|
| `saveDisabledFor` — the save slot's enablement | split: `writeBlockedFor` (nothing to act on, or a write in flight — the only reasons the slot is *disabled*) and `saveRefusalFor` (the reason a click is refused, for the message line) |
| `entryProblems` — a list rendered under fields | kept, but read only to build `saveRefusalFor`'s sentence; nothing renders it per field |
| — (new) | `closeWouldLoseFor`, and the pending-close state, for D8 |

The component still decides nothing: every verdict above is a function in the
composable, and the existing test that asserts it stays the rule. The message
line's *content* is one more such function — `messageFor`, whose priority order
D11 states — not a chain of `v-if`s in the template.

### D4 — Adding an agent: the selection clears, the form empties, nothing is worded

1. The user clicks **add**.
2. **The selection clears.** No row carries the selected mark any more, so no
   stored agent is being edited. The list keeps showing exactly what the store
   holds — it gains no row for something that does not exist yet. This state is
   **creation mode**.
3. The form on the right is **emptied** — no label, no persona, both hub
   switches off, the tool loop at its floor, no model — and **focus lands on the
   Label field**.
4. **No wording changes anywhere to announce it.** The heading above the toolbar
   reads `Agents` in every state and never becomes something else, and the
   dialog's title reads `Agents` too (D9). There is no `New agent` caption, no
   banner, no badge: the cleared selection and the empty form *are* the signal.
   An empty form is not mistakable for a failed read, because a read that failed
   says so in the card's single message line (D11) — and a form that loaded says
   nothing there.
5. Nothing is written. The agent's id is derived from its label as it is typed,
   as today; an empty label yields the neutral placeholder id, which stays
   correctable in the Id field — shown, as today, **only on a new agent**.
6. **Save** writes it, and only when the form is complete. An incomplete form is
   refused with a message in the card's message line (D11) and nothing is
   written. On success the list re-baselines on the store's answer, the new
   agent's row appears **selected**, and the form stays open on it (D6).
7. **Clicking any agent in the list ends creation mode**, cancelling the creation
   **by design**: nothing was written, so nothing needs confirming, and the agent
   clicked is shown instead.
8. Leaving the dialog ends it too, discarding the half-typed form (Close, or the
   close guard of D8). Nothing was ever written.

Two consequences, stated so they are not discovered during implementation:

- **A new agent is not an entry until it is saved.** Creation is a form-only
  state with no row, no id in the list and nothing for the toolbar to delete.
  Adding no longer runs through `addAgentToDraft`; a new agent goes straight to
  the write.
- **The toolbar still needs a subject.** In creation mode save acts on the form
  being typed while delete has nothing to act on (§5), and the delete pair is
  never reachable from here.

A new agent may be saved **without a model**. That is legal and unchanged: the
agent exists, cannot be sent to, and the form's quiet model line says so.

The separate "New agent label" field and `+ Create agent` button are **removed**;
the label is typed in the form, which is where it is read back.

### D5 — Add is available whenever the dialog can be used

Adding is not dangerous and writes nothing, so it is live whenever the list is
loaded. Its two exceptions are narrow, and both are stated in its tooltip: a
write already in flight, and **already being in creation mode** — pressing add
again would empty a form the user may have started typing into, so it is inert
until that creation is saved or abandoned.

Because a new agent has no row (D4), add is the only control that can be *inert*
while nothing is selected. That is the single case where "nothing selected" does
not mean "nothing is happening".

### D6 — Saving does not close the dialog

The write is one agent; the dialog now has a `Close` for leaving. A successful
save keeps the card open, re-baselines the list on the store's answer, keeps the
saved agent selected, and leaves any other agent's unsaved edits alone.

A save writes **exactly one** agent — the selected one: creating when its form is
pending, updating when it is stored. There is no "save all".

A refused save keeps the card open and puts the store's own sentence in the
message line (D11), unchanged in wording.

### D7 — Delete: one confirmation, inline, asked after the click

1. **Delete** is offered only for a selected agent that can be deleted — a
   user-created, already-stored row — and is otherwise **disabled** with its
   reason.
2. Clicking it reveals the **cancel** and **confirm** slots at the right end of
   the same toolbar. The selection and the form do not change.
3. While a confirmation is pending, add / save / delete are inert: one
   destructive action is decided at a time.
4. **Cancel** hides the pair and changes nothing else. Nothing was written, so
   nothing needs restoring — including whatever the user typed.
5. **Confirm** deletes the agent (the store copies the database first, so the
   action is recoverable), re-baselines the list on the answer, and selects
   **the next row in display order**, falling back to the **previous** one when
   the deleted agent was last, and to no selection when the list came back
   empty.
6. Selecting a different agent while the confirmation is pending cancels the
   confirmation. The destructive action never survives the selection moving.

The confirmation is **carried by the two glyphs and their tooltips alone**. No
sentence appears, no agent label is added to the toolbar, and no caption is
inserted under it: the pair's presence is the question, `Cancel delete` and
`Confirm delete` are its answers. Focus lands on **Cancel** — the safe answer —
when the pair appears, so a keyboard user is told the same thing a pointer user
reads in the tooltip.

### D8 — Close is the only way out, and it asks in place

The footer's single `Close` button closes the dialog and writes nothing. Escape
and a backdrop click do the same, as today.

Because it is now the *only* exit — the footer no longer offers a Cancel/Save
pair — it must not silently discard typing. **While the card holds unsaved work,
Close asks first, in place**: the two-glyph pair of D7 appears in the footer's
reserved slot, left of `Close`. No sentence is added, no dialog is nested, and
the footer's height and `Close`'s position do not move. With nothing unsaved,
Close closes immediately and the pair never appears.

The pair reuses the delete confirmation's idiom so the card teaches it once:

| slot | glyph | tooltip (the accessible name) |
|---|---|---|
| cancel close | red cross | `Keep editing` |
| confirm close | green check | `Discard and close` |

Escape and a backdrop click count as `Close` in every respect, and so take the
same guard — otherwise they would be a silent bypass of it.

**`Q2 = B` and this guard need each other, so the resolution is explicit.** There
is no "dirty" test on the save slot and no `Nothing to save` state (**dropped by
decision**, §8): re-saving an untouched agent is allowed. The guard, however,
cannot ask a question it cannot answer — so the card keeps **one baseline per
entry, used *only* to tell "differs from what was read", never consulted by the
save slot**. The two are separate answers on purpose:

- *May this be saved?* — the form's completeness (D11), not its dirtiness.
- *Would closing lose something?* — the baseline comparison, plus *always yes*
  while in creation mode, where nothing was ever written.

That keeps the requirement off the save path (where the decision dropped it) and
puts it only where it is load-bearing. Recognising "nothing unsaved" also means
the common case — open the dialog, click `Close` — costs no extra click.

One destructive decision at a time: if a delete confirmation is pending when
Close is clicked, the delete is abandoned (nothing was written) and the close
guard answers on its own terms.

### D9 — The title is `Agents`, and it never changes

The dialog's heading becomes `Agents`, and its accessible name follows it. It
reads `Agents` in **every** state — nothing selected, creation mode, a
confirmation pending — and is never restyled into a different word to describe
what the card is currently doing (D4.4, D10).

Nothing else about how the card opens changes: same pencil, same enablement,
same landing rule (the composer's current agent, else the first row).

### D10 — Nothing appears and disappears in a way that moves the layout

The governing rule for this rework, and the reason several obvious affordances
are absent: **a control, glyph, caption or message must not be added and removed
in a way that shifts what the user is already aiming at.** Wording that comes and
goes is a layout change, and a layout change under the pointer costs a click.

Applied here, it means:

- **The five toolbar slots keep their width whether or not their button is
  rendered**, so the pair's appearance shifts nothing (§3, D1).
- **The footer reserves the pair's slot**, so `Close` never moves (D8).
- **The delete confirmation adds no sentence** — the toolbar's height is fixed,
  so the list's top edge does not jump when a delete is asked (D7).
- **Creation mode is shown by the cleared selection and the empty form**, never by
  a caption or a badge (D4.4, D9).
- **A save does not close the card** (D6), so no layout is torn down and rebuilt
  after an ordinary write.

What it does **not** forbid: a *disabled* control's tooltip explaining itself, and
**the card's message line** (D11) — because that line occupies a slot that is
always there, so filling it moves nothing.

The test to apply when a new affordance is proposed: *if this appears while the
pointer is already moving toward something, what moved?*

### D11 — Every message lives in one reserved line, bottom-left

Everything the card needs to *say* — a failed read, a refusal from the store, an
incomplete form, a save or delete in flight — appears in **one line**, placed at
the bottom of the card, left-aligned, on the same horizontal band as the `Close`
button (the footer's left side, the slot §3's footer reserves). Nothing is said
anywhere else.

That replaces today's five separate message sites, which this rework **removes**:

| today | where it sits now | after |
|---|---|---|
| `Reading the agents…` / the read's error | top of the card | the message line |
| the loader's file findings and the server's findings | top of the card | the message line |
| a problem under each field (`label`, `id`, `systemMessage`, `maxToolIteration`) | under that field | the message line |
| `Save this agent before it can be deleted.` / `nojae owns this agent…` | under the form | the delete slot's tooltip (D1) and, on a refused delete, the message line |
| `N problems in this agent must be fixed…` (the footer's count) | in the footer | the message line, naming what is missing |

Rules for the line:

- **It always occupies its band**, whether or not it holds text, so a message
  appearing never reflows the card, the form or `Close` (D10). This is the whole
  reason it is a reserved slot rather than a line that grows.
- **It holds exactly one message**, chosen by a fixed priority rather than by
  recency, so two truths never fight for the line: a write in flight, then a
  refusal from the store, then the incomplete-form message, then a read failure,
  then the read's findings.
- **It is announced, not just drawn**: `role="alert"` for a refusal or a failure,
  `role="status"` for progress and for the incomplete-form sentence, so a screen
  reader hears what a reader sees.
- **It is never a tooltip's replacement**: a disabled slot still explains itself
  (D1). The line reports what *happened*; a tooltip explains what a control
  *would do*.
- **It clears when its cause goes away** — typing a missing label empties the
  incomplete-form message, and a successful save empties a refusal.

An incomplete save is the case that motivated it: the user clicks **Save** on a
form missing its label, nothing is written, and the line says the form must be
completed. The label field itself gains no message and does not change size —
which is exactly the shifting the old per-field lines caused.

## 5. States the toolbar must handle

| situation | add | save | delete | cancel / confirm |
|---|---|---|---|---|
| nothing loaded (read failed, still loading) | inert | inert | inert | not rendered |
| a stored agent selected, untouched | live | live | live if the row is deletable | not rendered |
| a stored agent selected, edited, no problems | live | live | live if deletable | not rendered |
| a stored agent selected, form holds a problem | live | **live — it refuses and says why in the message line** (D11) | live if deletable | not rendered |
| app-owned agent selected (fields locked) | live | live only if its model changed | inert (`nojae owns this agent`) | not rendered |
| **nothing selected — creation mode** (D4) | inert (D5) | **live — it refuses while the form is incomplete** (D11) | inert (nothing stored to delete) | not rendered |
| a save or a delete in flight | inert | inert, `Saving…` | inert | inert |
| a delete confirmation pending | inert | inert | inert | both live |
| a close confirmation pending (D8) | inert | inert | inert | not rendered |
| the list came back empty | live | inert | inert | not rendered |

Two rules hold across the table: an action's availability is a **composable
function**, never a condition written in the template, and every inert control
carries the reason in its tooltip.

Note the row that reads "nothing selected": in creation mode a new agent occupies
the form but not the list, so *save is live and delete is not* is the signature of
that state. The two must never be confused with "the list came back empty", which
is a **read that answered nothing** — there is no form to type into and save
stays inert.

Two rows deliberately keep save **live** where the form is wrong: an incomplete
or conflicting form is refused on click, with its reason in the message line
(D11), rather than being prevented. The click is how the user learns what is
missing, and taking the button away would hide the answer.

One row is a genuine exception to "no dirty gating", and it is not a contradiction
of Q2: for the **app-owned agent** only the model is the user's, so save stays
inert until that one field actually changes. There, disabling is the honest
signal — there is exactly one thing to change, and a save that could only rewrite
what is already stored has nothing to offer.

## 6. Acceptance

1. The dialog is titled `Agents`, its toolbar sits above the agent list, and its
   footer holds one `Close` button on the right. The footer holds no Save.
2. Selecting a row is the only way into editing: the form shows that agent, and
   the toolbar acts on it.
3. `Add agent` clears the selection, empties the form, focuses the Label field,
   and writes nothing. The **list gains no row**, the heading still reads
   `Agents`, and **no caption, banner or badge appears anywhere** to announce the
   new state.
4. Typing a label and saving creates the agent, re-baselines the list, and
   selects the new row. Saving does **not** close the dialog.
5. Clicking an agent in the list while a new agent is being typed **abandons the
   creation without asking** and shows the clicked agent.
6. Clicking `Save` on an incomplete form writes nothing and puts one message in
   the card's message line saying the form must be completed. The save slot is
   not disabled for an incomplete form.
7. Every message — incomplete form, store refusal, read failure, progress —
   appears in that **one line at the bottom-left of the card, on `Close`'s
   horizontal band**, and nowhere else. No field renders its own message, and no
   message appears at the top of the card.
8. That line holds its place when empty: filling or emptying it moves no control
   and changes no other row's height.
9. There is **no `Nothing to save` state and no dirty gating**; re-saving an
   untouched agent is allowed.
10. `Delete agent` is disabled, with a reason in its tooltip, for a built-in
    agent, while nothing is selected, and while a write is in flight.
11. Clicking `Delete agent` reveals exactly two extra slots at the right end of
    the toolbar; the first three do not move by a single pixel, the toolbar's
    height does not change, and **no sentence or label is added anywhere**.
12. `Cancel delete` hides them and leaves the selection, the form and everything
    typed in it exactly as it was.
13. `Confirm delete` removes the agent and selects the next row, or the previous
    one when the deleted agent was last, or nothing when the list is empty.
14. While a confirmation is pending, selecting another agent cancels it and
    deletes nothing.
15. With unsaved work, `Close` — and Escape, and a backdrop click — asks in the
    footer's reserved slot (`Keep editing` / `Discard and close`); with none, it
    closes immediately. `Close` never moves when the pair appears.
16. Every toolbar slot has an accessible name equal to its tooltip, and a
    disabled slot always explains itself.
17. The two confirmation pairs are absent from the DOM — not merely invisible —
    until a confirmation is pending.
18. Switching rows and back preserves what was typed in each form.
19. No affordance in this rework adds or removes content in a way that shifts
    another control's position (D10): the toolbar, the footer band and the list's
    top edge are geometrically stable across every state in §5.
20. `web/src` still names no reserved agent id, and the component still derives
    every verdict from the composable: the existing assertions still pass, with
    the e2e selectors updated (§9).

## 7. Out of scope

- Any new route, backend rule or store change. The three writes keep their
  shapes and their refusals.
- Reordering the list, renaming an existing agent's id, duplicating an agent.
- The pencil's own label and tooltip (`Edit modes`), its enablement, and where
  the card is mounted from.
- The persona's byte counter, the tool-loop cap and every other field rule — all
  unchanged. The counter stays under the System prompt field even though the
  mockup does not draw it.
- Session files that name an agent that has since been deleted: the existing
  fallback-with-a-notice behaviour stands.
- Keyboard shortcuts beyond Tab/Escape and the confirmation's own focus rule.

## 8. Decisions taken (previously open questions)

Each was put to the product owner and answered; the answer is binding on the
implementation.

| # | question | answer | where it landed |
|---|---|---|---|
| Q1 | Keep the dialog open after a save? | **Yes.** A save is a write, not an exit. | D6 |
| Q2 | Gate the save slot on the form being "dirty"? | **Dropped.** No `Nothing to save` state, and save is not disabled by an incomplete form either — it refuses on click and explains itself in the message line. The baseline is kept **only** for the close guard. | D8, D11, §5 |
| Q3 | Does a new agent get a row in the list before it is saved? | **No.** Clicking `+` clears the selection and enters creation mode; the list gains nothing until a save succeeds. Clicking an agent during creation abandons it without asking. | D4 |
| Q4 | What does `Cancel delete` restore? | **Nothing needs restoring** — the form keeps the typed edits and stays where it was. | D7.4 |
| Q5 | Does `Close` with unsaved work ask? | **Yes**, in place, in the footer's reserved slot. | D8 |
| Q6 | Icons: house SVGs or an npm package? | **House inline SVGs.** No icon package is added. | D1 |
| Q7 | Where is the delete confirmation explained? | **The two buttons' tooltips only** — no sentence, no label, no inserted caption. | D7 |

Three answers were given together and are recorded as one rule, because they say
the same thing about wording:

| # | decision |
|---|---|
| Q3 (follow-up) | The heading **never** changes: it reads `Agents` in every state, including creation mode. No `New agent` caption, no badge, no banner. |
| Q7 (follow-up) | The confirmation pair is explained by **its own two tooltips** (`Cancel delete` / `Confirm delete`), not by surrounding text. |
| — (standing rule) | **Wording must not appear and disappear unless it is genuinely needed**, because text arriving and leaving reflows the layout and costs a click. When a message *is* needed, it goes in the card's one reserved message line (D11). |

All of them are settled, so this document no longer carries recommendations to
answer.

### One tension that was resolved, not left implicit

**Q2 = dropped** and **Q5 = ask** pull in opposite directions: the close guard
needs to know whether anything would be lost, while the save slot was decided not
to care. The resolution (D8) keeps both literally: the save slot's enablement is
decided by nothing but *is there something to act on, and is a write already in
flight*. A per-entry baseline exists *only* to answer the close question, and must
not leak back into the save slot's enablement — that would undo Q2. It is also not
a "validate" concept: an incomplete form is refused on click, never pre-blocked.

Three smaller points, decided by the same reasoning (D10):

- **Creation mode is not announced in words** — the cleared selection and the
  empty form are the signal (D4.4, D9).
- **Every message shares one reserved line** at the bottom-left (D11), instead of
  appearing under the field each one is about.
- A save or delete in flight disables the confirmation pair rather than queueing
  it, so a pending destructive action never outlives the state it was asked in.

## 9. Docs to update once this lands

| file | change |
|---|---|
| `README.md` §"The agents — the pencil beside the composer's dropdown" | it describes the dialog as "plus create and delete"; name the toolbar and the `Agents` title instead. |
| `README.md` WorkBench paragraph (the pencil) | the same wording, kept in step with the line above. |
| `AGENTS.md` | only if a sentence there describes the dialog's shape; today it names the mode, not the card, so it may need no change. |

### The e2e spec is part of this work, not a follow-up

`web/e2e/04-agent-modes.spec.js` reaches the dialog through things this rework
moves. It must be updated in the same change:

| today | after |
|---|---|
| `getByRole('button', { name: 'Cancel' })` (its close helper) | the footer's `Close`, plus the close guard's pair when the test left unsaved work |
| `.agent-modes-create` / `.agent-modes-create-button` | the toolbar's add slot |
| `.agent-modes-save` | the toolbar's save slot |
| `.agent-modes-delete-button` / `.agent-modes-delete-yes` | the toolbar's delete slot, then the confirm slot |
| `.agent-modes-create`'s typed label (creating by filling the nav field) | creation mode: click add, then type in the form's Label field |
| any assertion reading a message **under a field** or **at the top of the card** | the one message line (D11) |

Its own assertions about writing nothing on Cancel still hold, expressed as
"`Close` with unsaved work, then keep editing". Any test that relied on a save
closing the card needs the new stay-open behaviour (D6).

Two new assertions this rework should gain, because both are easy to regress:

- Clicking `Save` on an incomplete form writes nothing, leaves the dialog open,
  and puts exactly one message in the message line.
- Clicking `+` then an agent in the list discards the creation without a prompt,
  and no row was ever added for it.
