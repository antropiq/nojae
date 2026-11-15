# Settings dialog — Servers tab, toolbar-driven editing

**Status**: **ready to be split into tasks** — the layout is fixed by the mockups,
the corrections in §2 closed the gaps in them, and every design question is settled
(§9 for the minor points, §12 for the ones that shaped §4). Nothing here is
implemented yet; §8 is the task list, and **no backend or schema change is
involved** — including the delete cascade, which is deliberately left as the schema
declares it.

**Mockups**

| file | what it shows |
|---|---|
| [`imgs/Settings-Dialog-Servers_01.png`](imgs/Settings-Dialog-Servers_01.png) | the Servers tab with a **server** selected (and the same shape with no server configured) |
| [`imgs/Settings-Dialog-models_01.png`](imgs/Settings-Dialog-models_01.png) | the Servers tab with a **model** selected — inner tab **Settings** |
| [`imgs/Settings-Dialog-models_02.png`](imgs/Settings-Dialog-models_02.png) | the same, inner tab **System prompt**, and the dashed **message band** at the bottom |

**Surface**: one existing dialog (`web/src/components/SettingsDialog.vue`), its
state and rules in `web/src/composables/useAppShell.js`, and the settings block
of `web/src/styles/theme.css`. Plus the same toolbar idiom that
`AgentModesDialog.vue` + `useAgentModes.js` already established (§3.2 of
`docs/agents-dialog-rework.md`).

**No backend change.** Everything the rework needs is already served:

| need | already there |
|---|---|
| the servers tree with each server's models | `GET /api/servers` (the whole payload **is** the servers tree) |
| a server's live model listing | `GET /api/models?serverUrl=&apiKey=` → `{ models: [id, …] }`, sorted and de-duplicated (`_model_ids`) |
| add a model under a server | `POST /api/models/add` (`ModelCreateIn` = the model's fields + `serverId`) |
| two-column listing | the route answers plain string ids, so the table is built client-side |
| duplicate name under one server | the store refuses it: `UNIQUE (server_id, name)`, and "a duplicate under the same server is a mistake" |
| a model added with **default samplers** | `ModelCreateIn` is `SamplerFieldsMixin` + `serverId`; an omitted sampler stays a null column, so `{ name, serverId }` is a complete and correct body |

---

## 1. The need

The dialog already has a horizontal section nav, but the Servers section (named
**Models** today) puts its verbs where the Agents card used to put its own: a
`Save model` / `Remove model` pair at the foot of the model form, a `Save server`
/ `Fetch models` / `Remove server` trio at the foot of the server form, and `Add
server` / `Add model` in a further pair at the bottom of the whole detail column.

Four consequences, all of which the mockups remove:

- **The verbs move with the content.** Save and Delete sit at the end of a form
  whose height depends on how many fetched model names happen to be listed, so
  they drift.
- **Nothing says what a verb acts on.** `Add server` and `Add model` sit under
  both forms, `Save server` and `Save model` are named by their *form*, and a
  user reading the column cannot see the scope without reading each label.
- **The listing has no home.** What *Fetch models* answered is today an unbounded
  `<ul>` under the server's own buttons: the list grows, the server form grows,
  the buttons move, and the detail column gains a scrollbar of its own.
- **Messages are scattered.** The settings error sits under the `<header>`, the
  store notice and the servers error sit above the master–detail, the fetch
  refusal and the "no listing yet" note sit under the server's buttons, the same
  refusal *again* sits under the model-name field, the unassigned line sits at the
  top, and per-connector errors sit inside the MCP and LSP panels. Six sites, each
  pushing different content down at a different moment.

The target shape is the one the Agents dialog settled on: **one toolbar over the
list, holding only verbs; a second tab strip inside the detail column; one
reserved message band at the bottom.**

## 2. Corrections to the mockups (decided, not proposed)

These override the pictures; the mockups stay valid for geometry and placement.

1. **The API key belongs to a server only.** `Settings-Dialog-models_01.png`
   shows an *API key* field on the model's Settings page — that is an error. The
   model page has no such field and never writes one; the credential stays on the
   server row (schema: `api_key` is a `servers` column; `models` has none).
2. **The Servers tab's first tab label is `Servers`, not `Models`.** The left
   tree's root object is a server, and the toolbar's heading in the mockups reads
   `Servers`. The tab label follows it (§4.1).
3. **The server page gains a model listing.** Under API key: a **Fetch models**
   action whose answer is a **two-column table** — a `name` column and an `Add`
   column holding a `+` per row. Clicking `+` adds that name as a **child model of
   the selected server**, selects it, focuses it, and shows the model's property
   page (§4.4).
4. **Every toolbar verb is scoped to the page that is active.** On the server page
   it acts on the server; on the model page it acts on that model (§4.3).
5. **Fetch models is not a toolbar verb.** It belongs to the server page, under the
   API key field, and it is **inert while that server has no backend row** (no id).
   Listing and adding therefore need the same thing — a saved server — and one rule
   covers both (§4.4).
6. **A server delete takes its models with it, as it does today.** No parent-guard,
   no "delete the children first" refusal. `models.server_id ON DELETE CASCADE` is
   the schema's declared intent and `delete_server` backs the store up before it
   lands, so the behaviour is kept and the confirmation sentence is where it is
   explained (§4.8).
7. **`+` writes the model.** It creates the child with its name, its parent's id and
   the default samplers, then opens the model page with the name already in the
   field — an edit of a row that exists, not a staged draft (§4.4).

## 3. What exists today (verified against the code)

| piece | where | what it does today |
|---|---|---|
| the card | `SettingsDialog.vue` | `900×600` fixed card shared with the Agents dialog (`.settings-dialog > article`); a horizontal `.settings-nav` of three buttons, then `.settings-body`, then `.settings-actions` |
| the section nav | same, `SECTIONS` | `Models`, `MCP`, `LSP`; `activeSection` is **local component state** — nothing deep-links it |
| the tree | same, `.models-tree` | servers, each with a disclosure button and a `[n]` model count; children listed when expanded; `Loading servers…` / `No server configured yet.` as list items |
| the detail column | same, `.models-detail` | shows the model form when a model is selected, else the server form, else `Select a server or a model to edit it.`; then the `Add server` / `Add model` pair |
| the model form | same | name (a `datalist` over the fetched listing), **the fetched listing's note and error repeated here**, system prompt `textarea rows="3"`, the six samplers in `.settings-grid`, reasoning level, vision tick, then Save / Remove |
| the server form | same | name, url, `ApiKeyField`, then Save / Fetch models / Remove, then the fetch error, the "no listing yet" note, or an unbounded `<ul>` of fetched names |
| the fetched listing | `useAppShell.js` | `fetchedModelIds` / `fetchedModelsErrors` keyed by `draftKey` (saved id, `'new'` sentinel for an unsaved row); `fetchServerModels()` dials the **draft's** url+key, so an unsaved server can be listed; each fetch **clears** the previous answer first |
| selection | `useAppShell.js` | `selectServer` / `selectModel` put a **copy** in the draft; selecting a model also selects its parent. There is no "no selection" state when a server exists — opening the settings reads servers and selects the first one |
| a new row | same | `addServerRow` / `addModelRow` create an **unsaved draft row** (null id) and Save picks the route from that (`/add` vs `/save`) |
| the writes | same, `postConnectionWrite` | six routes, all answered with the **new whole tree**; a failure lands in the single `state.serversError` |
| the deletes | `SettingsDialog.vue` | `window.confirm(serverDeleteSentence(...))` / `modelDeleteSentence(...)` — a native blocking dialog, named what else goes with the row |
| the footer | `.settings-actions` | `Close`, plus a `Save` for the MCP and LSP sections only. The Servers section has no footer verb at all |
| the rules | scattered | the enablement conditions are written **in the template** (`state.settingsSaving`, `state.selectedServerId === null`, …) — unlike the Agents card, where every verdict is a composable function and a test asserts the component decides nothing |
| the e2e specs | `web/e2e/` | **no spec drives this dialog** (specs are 01–10, none for Settings). Nothing breaks here; the rework should *gain* one |

Two properties of today's behaviour, one to keep and one that changes:

- **kept** — a model's in-column edits are a **draft copy**: switching rows does not
  write, and Close has nothing to undo;
- **changed on purpose** — a fetch today dials **what is typed**, not what is
  stored, so a URL can be listed before its server has a row. Listing is now gated
  on the row existing (§4.4), which retires that draft-only path. The URL and key
  still travel as query parameters on `GET /api/models`, so the request itself is
  unchanged; only *when the button is live* changes.

## 4. The target layout

```
+--------------------------------------------------------------------------+
|  Settings                                                                |
+--------------------------------------------------------------------------+
|  [ Servers ]  [ MCP ]  [ LSP ]                       section strip (D1)  |
+--------------------------------------------------------------------------+
|  Servers                                     +--------------------------+|
|  [+][save][delete]             [x][v]        | [ Settings ][System prmpt]||
|  +------------------------+                  +--------------------------+|
|  | hpz [2]                |                  | Model name   Reasoning   ||
|  |   qwen3.8-flash-next   |                  | [________]   [ select v ]||
|  |   humanizer-12b-q8  ◀──|--- selected      |                          ||
|  | alpc [1]               |                  | Temperature Top-p  Top-k ||
|  |   ...                  |                  | ...                      ||
|  +------------------------+                  |                          ||
|                                              |                          ||
+--------------------------------------------------------------------------+
|  all warnings, errors, contextual help                                    |
|                                                       [ Close ]           |
+--------------------------------------------------------------------------+
```

For the server page, the detail column's body is:

```
| [ Settings ]                                    (strip: one tab, reserved) |
| Name            [____________________]                                    |
| Server URL      [____________________]                                    |
| API key         [____________________]                                    |
| [ Fetch models ]                ← inert while this server has no row       |
| model listing                       ← the table, own vertical scrollbar    |
|   name                        | +                                         |
|   qwen3.8-flash-next          | +                                         |
|   deepseek-v4.3-flash-1017    | +   ← scrolls here, never the column       |
```

### 4.1 Three levels of tab, and who owns each

| strip | position | state lives in | tabs |
|---|---|---|---|
| section strip | under the title, full width | component-local (`activeSection`) | `Servers` · `MCP` · `LSP` |
| detail strip | top of the detail column | app-shell state (§4.6) | `Settings` · `System prompt` — **only on the model page**; the server page renders the strip with a single reserved `Settings` tab |
| toolbar | above the tree, left column | app-shell state (the selection) | not tabs — verbs (§4.3) |

The section strip already exists and already renders horizontally for this
dialog (`.settings-dialog .settings-nav ul { flex-direction: row }`); the change
is the label and the fact that the Agents card must keep its own vertical nav.
The detail strip is new and reuses `.settings-nav button`'s look, the way
`.models-name` already reuses it for tree rows.

### 4.2 The heading above the toolbar reads `Servers`, in every state

Same rule the Agents card settled on (`agents-dialog-rework.md` D4.4): a small
heading above the toolbar that **never changes wording with state** — not
`Models`, not `New server`, not `Editing`. It is not the dialog's accessible name.
The mockup's literal box caption `Servers toolbar` is read as that heading plus
the toolbar row beneath it; a caption that spells the word "toolbar" is not
something a user needs to read (§9.1-1).

### 4.3 The toolbar: three verb slots, meaning follows the page

Mirror `AgentModesDialog` exactly: fixed-width slots in a flex row, a flexible
spacer, then the confirmation pair's two reserved slots. Slots keep their size
whether or not they hold a button, so revealing a pair moves nothing and the
toolbar never changes height.

| slot | on the **server** page | on the **model** page | nothing selected |
|---|---|---|---|
| `+` | new server (empty form, nothing written) | new model under the selected server | new server |
| save | save the server | save the model | inert |
| delete | delete the server — **and, as today, the models under it** | delete the model | inert |
| `×` `✓` | the delete confirmation pair, **absent from the DOM** until asked | same | same |

**Fetch models is deliberately *not* a fourth slot.** It belongs under the API key
field on the server page, because what it answers — the listing table — is the body
of that page, not a result announced from above. Keeping the verb next to its
answer is also what makes its disabled state legible: it is disabled *about this
server*, and the field above it is the server (§4.4). A toolbar slot would sit
beside a model page that has no listing at all and spend its tooltip explaining
that it is the wrong page.

The rules that hold across that table, copied from the Agents dialog because they
are what made it work:

- **Every verdict is a composable function, never a condition in the template.**
  Today this dialog writes its conditions inline; moving them next to the verbs is
  the single biggest correctness win in the rework (T4).
- **An inert slot carries its reason in its tooltip**, and that string is also the
  slot's accessible name — one value read as both, so a label cannot drift from an
  enablement.
- **A form with a problem does not disable Save.** The click is refused and the
  reason lands in the message band. Taking the button away hides the answer.
- **Save does not close the dialog.**
- **The scope is never spelled in a toolbar label.** The three slots read `Add`,
  `Save`, `Delete`; the *page that is visible* is the scope. This is the user's
  decision, and it is only honest because the page and the verb are always on
  screen together. Fetch models is the exception in form, not in spirit: it is a
  **text-labelled button inside the page** (`Fetch models`), because it is not one
  of the scoped row verbs.

### 4.4 Fetch models, the listing table, and what `+` does

- The **listing lives under API key on the server page**, per the mockups and the
  request. It is a real table: a `name` column and an `Add` column holding one `+`
  per row, header row `name | Add`.
- **The table owns its scrollbar.** A `max-height` on the table's own scroll
  container and `min-height: 0` on the column, so a 200-name listing scrolls
  inside the table and the detail column gains no scrollbar of its own. This is the
  same shape as `.agent-modes-nav` (the list is the grid's only flexible row, so
  the toolbar above it never scrolls away).
- **The listing is not cleared by a re-fetch until an answer arrives.** Today each
  fetch blanks the previous answer first, which would make a 200-row table
  collapse to nothing for a second and then re-grow — the exact reflow the layout
  is meant to prevent. While `fetchedModelsLoading` names this row, the previous
  rows stay and the fetch verb reads `Fetching…`. An **empty answer is still an
  answer**, so it does replace the rows and the band says so (§9.1-2): the rule is
  about not blanking before the reply, not about refusing to blank after it.
- **`+` writes the row (decided).** One click posts `POST /api/models/add` with
  `name` = that listed id and `serverId` = the selected server, and **nothing else**:
  the six samplers are omitted, the columns stay null, and the model runs with the
  endpoint's own defaults until someone edits them. On success the write answers the
  whole tree, so the client needs no merge: **expand the parent, select the new
  model, focus its tree row, and open the model's Settings page**, where the name
  field already holds the name just added. Every later keystroke there is an edit of
  a real row and Save means Save — there is no staged, half-existing model anywhere
  in the flow.
  - Consequence worth stating to whoever reviews the copy: **`+` is a write**, so it
    belongs in the same in-flight guard as Save and Delete (`settingsSaving`), and a
    second click on another row waits rather than racing. It also means the table is
    the one place in this dialog where a click creates a row without the form's
    Save being pressed; the confirmation pair is not involved, because the row is
    empty of consequence and the model page can delete it.
- **One gate for both verbs: the server must have a row.** *Fetch models* is
  **inert until the server has an id**, tooltip `Save the server before fetching
  its models.` Since the listing cannot be reached without a saved server, the `+`
  column can never be shown for an unsaved one, and the "can I add to an unsaved
  server" question disappears with its first half. Two rules become one, and the
  unsaved-row flow is: type name and URL, Save, *then* fetch and add — which is the
  order the fields are already stacked in.
- **A name the server already has is not a surprise.** The store refuses it
  (`UNIQUE (server_id, name)`). Rather than let the user click into a refusal: a
  fetched name that is already a child of that server renders with its `+` slot
  **inert, tooltip `Already added`** — and a refused add lands in the message band,
  not under the table (§4.7). This costs a comparison against the tree the client
  already holds, and no new route.
  - `+` stays inert, it does not disappear, for the same reason the toolbar's slots
    do not: a row that answers differently per row would make the table's column
    widths jump.
- **The model-name `datalist` and its duplicate copy of the fetch error go away.**
  The listing now lives on the server page, where it is visible while it is being
  fetched; the model's name field becomes a plain text input. One fact, said once.

### 4.5 The model page's two tabs

- **Settings**: model name + reasoning level side by side, then the six samplers in
  a three-column grid (the mockups show three per row, `.settings-grid` is two —
  widen it for this column only), then the vision tick. **No API key.**
- **System prompt**: one textarea filling the column. The current
  `rows="3"` cannot be the target; the textarea is `height: 100%` of a column whose
  row is flexible, with `resize: vertical` relaxed so it can fill it.
- **Switching tabs must not lose a keystroke.** Both pages edit **one shared
  `state.modelDraft`**, so the tab is presentation only: typing in the textarea,
  clicking Settings, and seeing the samplers must show nothing stale. (The Agents
  card solved the same problem by keeping every form mounted with `v-show`; here
  one draft object plus two sub-templates is enough, but the acceptance test
  belongs in either case.)
- The strip is **reserved** on the server page with its single `Settings` tab, so
  selecting a model does not push the first field down by one row (no layout
  shift when the second tab appears).

### 4.6 The detail-tab selection is app-shell state

`activeSection` is component-local today, which is fine for a section strip. The
**detail tab should live in `useAppShell`** next to the selection, for one reason:
the flow in §4.4 has to *set* it ("show the model property page") from a click on
the server page, and `selectModel` is where that belongs. A model that is
selected from the tree with the detail tab left on *System prompt* is a fine and
predictable outcome; a model created by `+` explicitly opens *Settings*.

### 4.7 One message band at the bottom of the dialog

The dashed rectangle in `Settings-Dialog-models_02.png` is a **reserved footer
band**: the message area fills the row left of `Close`, exactly the shape
`.agent-modes-dialog .settings-actions` + `.agent-modes-message` already give the
Agents card. It is always there, so filling or emptying it moves nothing.

Everything the dialog says comes out of it, with the role that announces it
(`role="alert"` for a failure or refusal, `role="status"` for progress and for the
incomplete-form sentence). Chosen by **fixed priority**, not recency:

1. a write in flight (`Saving…`)
2. a model listing in flight (`Listing this server's models…`)
3. a refusal from the store / an unusable store (`state.storeState`, verbatim — it
   already names what is wrong)
4. this section's write failure (`state.serversError`)
5. the fetch refusal for the row being edited (`fetchedModelsErrorFor`)
6. a refused action explained (incomplete form, a name the server already has)
7. a read failure (`state.settingsError`, `state.serversError`)
8. the read's findings, joined as **one** message
9. the cross-store line — `2 of 4 agents have no model — assign one`, still a
   button that opens the Agent-modes dialog

**These sites are removed**, and their content moves into the band:

| today | where it sits now |
|---|---|
| `state.settingsError` | under the `<header>` |
| `storeNotice` and `state.serversError` | above the master–detail |
| the unassigned line | above the master–detail |
| the fetch error + "no listing yet" note | under the server's buttons |
| the **same** fetch error + the same note | under the model-name field |
| `Save the server before adding a model to it.` | under the server's buttons |

That last line is worth noticing: the dialog **already refuses to add a model to an
unsaved server**, in prose, under the buttons. Gating *Fetch models* on the same
condition (§4.4) does not add a rule — it moves an existing one from a sentence the
user has to read into a button they can see is disabled.

The MCP and LSP panels keep their **per-row** status badges and per-row errors:
those describe one connector, not one action, and a single band cannot say six
things about six connectors at once. What moves for those sections is their
top-level lines only (package-not-installed, the read failure). This is a
deliberate exception to "everything at the bottom", and it is worth naming
explicitly so the implementation does not over-apply the rule (settled, §12).

### 4.8 Destructive verbs drop `window.confirm`

`window.confirm` cannot be styled, cannot land in the message band, and its copy
is the only place today where a cascade is explained. Replace it with the Agents
card's **inline confirmation pair** in the toolbar's two reserved slots: the delete
verb asks, `×`/`✓` answer, the pair is absent from the DOM until asked, and a write
in flight makes it inert rather than queueing it. The sentences stay
(`serverDeleteSentence` / `modelDeleteSentence` name what else goes with the row —
the part nobody can retype), and the store still keeps its own copy of the database
before either delete lands.

**The cascade is kept, unchanged.** A server delete takes its models with it today,
and that is deliberate: `models.server_id` is declared `ON DELETE CASCADE`, the
comment beside it says *"the models under a deleted server are meaningless, and an
orphan row is one the dialog cannot render"*, `PRAGMA foreign_keys = ON` is set per
connection so the schema really enforces it, and `delete_server` returns what it is
about to lose after having copied the store. So there is **no parent-guard** — no
inert delete button on a server that still has children, and no "delete the children
first" refusal. Deleting a whole endpoint in one click is the shorter and the more
useful action, and the sentence that explains it is already written.

What does move is **where the sentence is said**. The Agents card keeps its toolbar
height fixed and its confirmation pair glyph-only, which works there because a
persona delete loses nothing the user cannot retype. Here it does — a server delete
loses its models — so the copy is kept **verbatim** and the **band carries it**.
`serverDeleteSentence` already says both halves — `Delete hpz and the 2 models under
it? Agents running on them will have no model.` — and its shorter form for a child-
less server is already handled there. The model's own sentence does the same for one
agent. Re-deriving either is a regression risk for no gain: the delete verb puts the
sentence in the band, the two slots carry the answers. Cheaper than a second dialog,
and it survives the fixed toolbar height.

### 4.9 `Close` is the only footer verb

The footer holds the message band and `Close`. The MCP and LSP `Save` buttons move
into those sections' **own toolbars**, on the same row logic as the Servers tab, so
the footer is one shape for all three sections.

## 5. States every control must handle

### 5.1 The three toolbar slots and the confirmation pair

| situation | add | save | delete | cancel / confirm |
|---|---|---|---|---|
| read in flight, or read failed | inert | inert | inert | not rendered |
| servers read, **server** page active | live | live | live | not rendered |
| **model** page active | live | live | live | not rendered |
| a new, unsaved **server** is being typed | inert (one at a time) | live | inert (`Save the server before it can be deleted.`) | not rendered |
| a new model draft under a saved server | live | live | live | not rendered |
| form holds a problem (bad URL, name empty) | live | **live — refuses, and the band says why** | live | not rendered |
| a write in flight (save, delete, or a `+` add) | inert | inert, `Saving…` | inert | inert |
| delete confirmation pending | inert | inert | inert | **both live** |
| the store is unusable | inert | inert | inert | not rendered |

### 5.2 The page-level verbs on the server page

| situation | Fetch models | a row's `+` |
|---|---|---|
| server has **no backend row** (unsaved) | **inert** — `Save the server before fetching its models.` | the table is empty, because it could never have been filled |
| server saved, URL field filled | live | live, or inert `Already added` for a name the server already has |
| server saved, URL field empty | inert — it would dial nothing | inert |
| listing in flight | inert, reads `Fetching…` | inert (one write at a time) |
| a write in flight | inert | inert |
| **model** page active | the button is not rendered — it belongs to the other page | same |

Two rules across both tables, lifted from the Agents card: an action's availability
is a **composable function**, never a condition in the template; and every inert
control carries its reason in its tooltip — including `Fetch models`, whose reason is
the one sentence a user otherwise has no way to discover.

## 6. Design advice worth stating, because it prevents the wrong implementation

1. **Extract a rules composable, don't add one more component.** The Agents card
   proved the pattern in this codebase: `useAgentModes.js` holds every verdict as
   a plain exported function (`addSlotFor`, `saveSlotFor`, `deleteSlotFor`,
   `deleteConfirmationFor`, `messageFor`) returning `{ disabled, label }`, and the
   `.vue` file renders answers. Do the same here: a `useSettingsServers.js` (or
   functions added to `useAppShell`) exporting `serverSlot` / `modelSlot` verdicts
   and one `messageFor(...)`. **The dialog template must end up deciding nothing** —
   that is the property worth testing, and it is the one this dialog currently
   violates.
2. **Copy the CSS idiom, not new geometry.** `.agent-modes-toolbar`,
   `.agent-modes-slot`, `.agent-modes-toolbar-space`, the `grid-template-rows: auto
   auto minmax(0,1fr)` body, and the message band already exist and already survived
   Pico's `[role="group"] button { width: auto }` trap (documented in the theme
   file). Share the slot classes rather than re-declaring them; scope anything new
   through `.settings-dialog`, because the Agents card shares these classes by
   design.
3. **Reserved geometry is the acceptance criterion, not a nice-to-have.** The
   toolbar's slots, the detail strip and the message band all hold their size when
   empty. That is what makes a fetch answer, a confirmation pair and an error
   sentence non-moving.
4. **The listing table's scroll container is the one place a naive implementation
   fails.** `overflow-y: auto` alone is not enough inside a grid: the column needs
   `min-height: 0` and the flexible row needs `minmax(0, 1fr)`, or the table grows
   and the column scrolls instead.
5. **Don't invent a backend route.** The listing exists, the add exists, the
   duplicate rule exists. This is a client-side re-shape.

## 7. Acceptance

1. The section strip reads **`Servers` · `MCP` · `LSP`** at the top; the Servers
   section's tree and detail column are as in the mockups.
2. A **server** selected shows Name, Server URL, API key, **Fetch models** under the
   key, and the listing table. A **model** selected shows the `Settings` / `System
   prompt` strip; **no API key field appears on a model's page anywhere**, and no
   model request body carries a credential.
3. The toolbar holds exactly **three** verb slots plus two reserved confirmation
   slots; it keeps its height and position in every state in §5.1, including while a
   confirmation pair is rendered and while a listing of any length is loaded.
4. Save/Delete on the model page touch **only** that model; on the server page
   **only** that server — its models going with it, as today. A model write never
   posts `apiKey`; a server write never posts a sampler.
5. **Fetch models is inert while the server has no backend row**, and its tooltip
   says why; it becomes live as soon as the row is saved.
6. Fetch models fills the two-column table. The table scrolls **inside itself** with
   any number of names, and the detail column shows **no** scrollbar.
7. Clicking `+` sends `{ name, serverId }` and nothing else, then expands and
   selects the new model in the tree, focuses its tree row, and shows that model's
   **Settings** page with the name already in the field. A name the server already
   has shows an inert `+`, and no click on it can reach a store refusal.
8. Switching between the model's two tabs preserves every unsaved edit in both
   directions, and neither tab switch writes anything.
9. Save does not close the dialog. The only footer verb is `Close`.
10. Every message the dialog produces — read failure, write refusal, fetch refusal,
    in-flight state, cross-store line — appears **only** in the bottom band, with
    the right `role`, and the band's height and `Close`'s position never move.
11. A destructive verb renders the inline pair instead of calling `window.confirm`,
    and the band carries the existing sentence naming what else goes with the row;
    the store's pre-delete copy still happens.
12. No rule about enablement is expressed in the template: an assertion shows the
    dialog reads verdicts from the composable.

## 8. Task breakdown

Each task is independently reviewable; the order keeps the dialog working at every
step. Effort in relative sizes (S / M / L), not hours.

| # | task | depends on | size |
|---|---|---|---|
| **T1** | **Rename the section**: tab label `Models` → `Servers`, section title and the heading above the toolbar read `Servers` in every state, and fix the CSS block's heading comment (`-- the Models section`). | — | S |
| **T2** | **Strip the model page of its API key** — confirm by reading `modelRowDraft` / `modelWritePayload` that a model never carries a credential, and add the guard that it never starts doing so. | — | S |
| **T3** | **Introduce the rules composable**: move every inline enablement condition in the Servers section out of the template into exported verdict functions returning `{ disabled, label }` (reuse the `slotLive` / `slotInert` / `slotContext` shape from `useAgentModes`). No visual change in this task. | — | M |
| **T4** | **Build the toolbar**: three fixed slots + spacer + two reserved confirmation slots, using the shared slot classes; verbs scoped to the active page (§4.3); tooltips carry the reason. Remove `Add server` / `Add model`, and the Save / Fetch / Remove groups inside both forms — **keeping Fetch models**, which moves into the server page under the key rather than out of existence. | T3 | L |
| **T5** | **Add the detail tab strip** (`Settings` / `System prompt`), strip reserved with a single tab on the server page; model page split into the two sub-pages over **one shared draft**; samplers to three columns; the System prompt textarea fills the column. | T4 | M |
| **T6** | **Fetch models and the listing table**: the button under the API key, inert with its reason until the server has an id; two columns (`name`, `Add` with a `+`); its own scroll container with the `min-height: 0` / `minmax(0,1fr)` pair; no clearing of the previous answer mid-fetch; already-added rows inert with a reason. | T4 | M |
| **T7** | **`+` adds the model**: `POST /api/models/add` with `{ name, serverId }` only, under the shared write-in-flight guard; then expand/select/focus the tree row and open the model's Settings page. `selectModel` (or a wrapper) owns the detail-tab choice. | T6, T5 | M |
| **T8** | **The message band**: one `messageFor` priority list, the band styled like `.agent-modes-message` in the shared footer, and **delete the six old message sites** (§4.7) — including the duplicated fetch error/note under the model's name field and the `datalist`. | T3 | M |
| **T9** | **Inline destructive confirmation**: replace both `window.confirm`s with the toolbar pair; keep `serverDeleteSentence` / `modelDeleteSentence` verbatim, and put the sentence in the band. The cascade itself is untouched. | T4 | M |
| **T10** | **MCP and LSP sections**: their `Save` leaves the footer for a section toolbar of the same shape; their top-level lines move to the band; per-row badges and errors stay put. | T8 | S |
| **T11** | **Focus and keyboard**: tree rows focusable and reachable, `Fetch models` and every `+` reachable by keyboard, the detail strip behaves as tabs (arrow keys, `aria-selected`), and the band announces politely/assertively as appropriate. | T5 | M |
| **T12** | **Responsive**: desktop-only, but the card is clamped to `94vw`; confirm the tree column, the samplers at three columns, and the listing's scroll area all survive the narrow clamp (the existing `@media` rule collapses `.models-body` to one column — decide the collapse order explicitly). | T5, T6 | S |
| **T13** | **e2e spec `11-settings-servers.spec.js`** — this dialog has none today. Cover §7 items 3, 4, 5, 6, 7, 8, 9, 10: no scrollbar on the column with a long listing, Fetch models inert for an unsaved server, `+` lands on the model's Settings page, tab switch preserves an edit, save leaves the dialog open, one band holds the message. | all | L |
| **T14** | **Docs** (§10). | — | S |

Suggested grouping for the first PR: **T1 + T2 + T3** (rename, remove the wrong
field, extract rules) — no layout risk, and everything after that reads cleanly.
T6 and T7 are one reviewable pair if the reviewer prefers the listing and its `+`
landed together, but they stay separate tasks because T6 can be checked for
geometry alone and T7 is where the writes are.

## 9. Details resolved in place

These four were too small to shape a task, so they are decided here rather than
asked. The numbering is kept because §4.2 and §4.4 point at items 1 and 2.

### 9.1 Resolved as recommended

1. **The toolbar's caption.** The mockup labels the box `Servers toolbar`. Decided:
   the always-`Servers` heading plus the toolbar row beneath it — no literal caption
   spelling the word "toolbar" for a user to read.
2. **A re-fetch that returns nothing.** Today a fetch clears the listing before
   asking. Decided: keep that — an empty list **is** an answer, so the table clears
   and the band says `This server lists no models.` Neither choice re-grows the
   table, because the scroll area is reserved either way.
3. **Which element is focused** when `+` lands: the new model's **tree row**, not
   its Name field. The request says "focus on it", and the name is already in the
   field, so focusing the row is what makes the tree's keyboard position coherent
   and lets Tab walk into the form from there. T11 implements this and does not have
   to guess.
4. **`Reasoning level` stays the current control** — the empty option plus the
   server's declared reasoning levels — rendered in the select shape the mockup
   shows. The mockup's `Option 1` is a placeholder, not a new list of values; nobody
   should re-derive an empty option or invent levels.

### 9.2 Settled by the requester

**Does `+` write or pre-fill**, **where Fetch models belongs**, **per-connector
errors in MCP/LSP** and **what the delete confirmation says** are recorded in §12
and reflected in §4.3, §4.4, §4.7 and §4.8.

## 10. Docs to update once this lands

| file | change |
|---|---|
| `README.md`, §"The model connection — Settings → **Models**" | the heading becomes **Servers**; step 1's "the names it answers with are listed under the button and fill the name list the model field completes from" becomes the **`name` / `Add` table and its `+`**, and states that adding there writes the model under that server. |
| `README.md`, data-files table row for `nojae.db` | if the row describes the dialog's shape, it names the toolbar. |
| `AGENTS.md` | only if a sentence describes the dialog's shape. Today it names the store and its routes ("Written only through its own routes"), not the card, so it likely needs **no change** — do not add one. |
| `docs/nojae-settings-workspace-spec.md` | it pins the dialog's sections and footer (the group-1 fields, the MCP/LSP `Save`). Add a pointer to this document rather than rewriting §5. |
| `docs/agents-dialog-rework.md` | its toolbar and message-band rules are now a shared house idiom used by two dialogs; worth one line saying so, so the third list-editor reuses it instead of inventing a third. |

## 11. Out of scope

- Any backend or schema change, and any new route.
- What a model connection does to a chat turn, and when the dialog may be opened.
- The MCP and LSP sections' content beyond moving a verb and their top-level lines.
- The Prompt-helpers surface, and the Agent-modes dialog itself (only the
  "assign one" link's target band changes).
- Editor or terminal surfaces — no write route is touched, and
  `tests/test_write_surface_isolation.py` still asserts the browser owns them.

---

## 12. Decisions taken (from the requester)

| point | answer |
|---|---|
| Section tabs move to the top, horizontally | `Servers` · `MCP` · `LSP`; this work is the first tab only |
| Models settings gain a two-tab horizontal layout | `Settings` and `System prompt` |
| All action buttons go in a dedicated toolbar in the "Servers toolbar" area | yes, following `AgentModesDialog.vue`'s recently updated logic |
| All messages, warnings and errors at the bottom of the dialog | yes — the dashed band in `Settings-Dialog-models_02.png` |
| The model page's API key field | **an error** — API key belongs to the server only |
| Missing requirement: a Fetch models button on the server page, under the API key | adds a two-column listing (`name`, `Add` with a `+`) that **scrolls inside itself**, and `+` adds a child model of the selected server, focuses it, opens the model's property page |
| Toolbar verbs are scoped to the active page | yes — editing a model means Save saves that model |
| Does `+` write, or stage a draft? | **writes**: the model is created in the backend with its name, its parent id and the default sampler values; the tree gains the child node and the model form opens with the name pre-filled |
| Can a model be added to a server that has no backend row? | **no** — and stronger: **Fetch models itself is disabled** until the server is saved (has an id), so the situation cannot be reached |
| Where does the Fetch models button live? | **under the API key field on the server page**, not in the toolbar; disabled until the server is saved |
| Deleting a server that still has models | **unchanged** — the schema's `ON DELETE CASCADE` stands, no parent-guard and no "delete the children first" refusal; the existing confirmation sentence explains the loss |
| MCP/LSP per-connector errors | left to the implementation, resolved here: **they stay beside the connector they describe** (§4.7). A band that carries six connector errors is a list, not a message; the top-level lines of those sections do move to the band |
| Delete confirmation copy | keep `serverDeleteSentence` / `modelDeleteSentence` **verbatim**, and say them in the band rather than in a `window.confirm` |
| Which element does `+` focus | the new model's **tree row** — the follow-up recommendations were accepted as given, so §9.1 records all four as decided |
