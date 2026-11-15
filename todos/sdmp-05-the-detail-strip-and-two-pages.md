# 05 — The detail strip and the model's two pages

**Read first**: `docs/settings-dialog-migration-plan.md` §4.1 (the detail strip row),
§4.5, §4.6, §7.2, §7.8, §8's T5, §9.1-4. Then
`web/src/composables/useAppShell.js`'s `modelRowDraft`, `selectServer`,
`selectModel`, `addModelRow`. Then `todos/sdmp-00-big-picture.md`, whose "The three
levels of tab" section is this task's contract.

The detail column gains a tab strip at its top, and the model page splits into two
sub-pages over **one shared draft**. The server page renders the same strip with a
single reserved `Settings` tab, so selecting a model does not push the first field
down by one row.

## Deliver

### 1. `state.detailTab` lives on the app shell

- Add `detailTab` to `useAppShell`'s `state`, with exactly two values: `settings`
  and `prompt`. Its default is `settings`.
- Export one setter for it next to `selectServer` / `selectModel`, and let the strip's
  click go through that setter rather than writing `state.detailTab` from the
  template — a component that assigns app-shell state directly is the shape this lot
  is removing.
- **`selectModel` does not change the tab.** A model picked from the tree with the
  strip left on `System prompt` showing its prompt is a fine and predictable result
  (spec §4.6). Only the `+` flow explicitly opens `Settings`, and that is task 06's
  call, made through the same setter.
- `selectServer` does not need to touch it either: the server page renders one
  reserved tab, and the strip's selection is meaningfully `settings` there. If it
  reads more honest to reset it to `settings` when a server is selected, do that —
  but **do not add a third value** and do not let the strip disappear in any state.

### 2. The strip itself

At the top of the detail column, in both states:

- **On a model page**: two tabs, `Settings` and `System prompt`, styled with the
  look `.settings-nav button` already gives this dialog's nav and the tree's rows
  (spec §4.1). The selected one carries `aria-current`, like the section strip does
  today.
- **On the server page**: the same strip, holding **one** tab reading `Settings`.
  It is reserved, not conditional: rendering the strip in both states is what stops
  the first field from moving by a row when a model is selected. The single tab is
  inert or simply current — either is acceptable, but it must not be a `v-if` that
  removes the strip's row.
- With nothing selected at all, the strip still occupies its row (the page below it
  says `Select a server or a model to edit it.`).
- Full tab semantics (arrow keys, `aria-selected`, roles) are **task 11**; here the
  strip is reachable by click and reads as the section strip does.

### 3. The model page's two sub-pages, over one draft

Both sub-pages edit the **same `state.modelDraft` object**. The tab is presentation
only. Two sub-templates over one object is enough — every field keeps its binding, so
typing in the textarea, clicking `Settings`, and seeing the samplers shows nothing
stale, and neither direction of the switch writes anything.

- **Settings**: the model name and the reasoning level **side by side**, then the six
  samplers in a **three-column** grid, then the vision tick. The current
  `.settings-grid` is two columns and is shared; widen it **for this column only**
  (a rule scoped to this section's grid), not globally.
- **The reasoning level** stays the current control: the empty option plus the
  server's declared reasoning levels. Do not re-derive an empty option or invent
  levels — the mockup's `Option 1` is a placeholder, not a new list (spec §9.1-4).
- **System prompt**: one textarea filling the column. Today's `rows="3"` cannot be
  the target: it is `height: 100%` of a column whose row is flexible, with
  `resize: vertical` relaxed so it can fill it. The column's flexible row needs
  `min-height: 0` so the textarea shrinks as well as grows.
- **No API key on either sub-page** — task 02's guard already asserts this; do not
  reintroduce it.
- The model page's `New model` / model-name title line may stay as the page's
  heading, but the strip sits **above** it, so nothing jumps when a title's length
  changes.

### 4. The block's CSS

The Servers section's grid already has three left-column rows from task 04. The
detail column gains one more: its own strip row (fixed) and its page body (flexible,
`min-height: 0`). Place it with `grid-template-rows` / `grid-area` in this section's
`theme.css` block rather than nesting wrappers, the way
`.agent-modes-body` / `.agent-modes-editor` do. The textarea's fill rule is scoped to
this section, so no other `textarea` in either card changes.

## Do not

- **Do not build the toolbar, the listing table or the message band.** Tasks 04, 07
  and 08 own them.
- **Do not change what a save writes.** The two sub-pages are one draft and one
  `saveModelDraft`; the payload is `modelWritePayload`'s, unchanged.
- **Do not invent a verdict in the template.** The strip's state is state, not a
  verdict; anything else belongs in `useSettingsServers.js`.
- **Do not touch `src/`.**

## Files

- `web/src/composables/useAppShell.js` — `state.detailTab` and its setter in the
  returned object.
- `web/src/components/SettingsDialog.vue` — the strip, the model page split into two
  sub-templates, the samplers' three columns, the textarea.
- `web/src/styles/theme.css` — this section's block: the detail column's rows, the
  strip's look reusing the nav's, the three-column grid for this column only, the
  textarea's fill.
- `web/tests/settingsModelsSection.test.js` — its "offers the six samplers, the
  reasoning levels and the vision box on a model" case now finds the samplers on the
  Settings sub-page (they are still in the DOM unless the implementation uses
  `v-for` over the visible tab — see below), plus the new preservation case.
- `web/tests/settingsDetailTabs.test.js` — new: the tab state and the preservation
  acceptance case.

**One implementation freedom, stated so the test is written to the rule and not to
the markup**: mounting both sub-templates and hiding one, or rendering only the
active one, are both acceptable, because the draft is shared state and the binding is
the same either way. The **acceptance** is what must hold: type into the textarea,
switch to `Settings`, and the samplers show what the draft holds; edit a sampler,
switch to `System prompt`, and the textarea shows what the draft holds; no write is
issued by either click.

## Rules it must not break

- *"composables/ hold app-shell and stream state and own each live stream and its
  abort; components use them directly."* The tab is app-shell state because the `+`
  flow has to set it — write it there, not in the component.
- *"`components/` and `styles/` are the widgets and the theme."* Layout in
  `theme.css`, scoped through `.settings-dialog`.
- *"A model's in-column edits are a **draft copy**: switching rows does not write,
  and Close has nothing to undo."* A tab switch is not a row switch: the same draft
  object is read by both sub-pages, so a switch preserves every unsaved edit and
  writes nothing.
- *"Configuration is edited from the UI and takes effect hot."* Unchanged: a save is
  still the only write.
- *"Tests stay hermetic"* — mounted cases mock `fetch`.

## Depends on

Task 04 (the detail column's grid placement and the toolbar it sits beside).

## Done when

- A model page shows a strip reading `Settings` · `System prompt`; a server page
  shows the same strip with a single `Settings` tab, and the first field below it
  starts at the same height in both states.
- The Settings sub-page holds the name and the reasoning level side by side, the six
  samplers in three columns and the vision tick; it holds **no** API key field.
- The System prompt sub-page holds one textarea that fills its column.
- Typing in one sub-page and switching to the other and back loses no keystroke, in
  both directions, and neither switch issues a request.
- The reasoning-level select still offers `None` plus the read's declared levels.
- `cd web && npm test` is green.

Finish by moving this file into `todos/done/`.
