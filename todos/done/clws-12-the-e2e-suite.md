# 12 — The e2e suite, rewritten once, and the two-tab run

**Read first**: `docs/client-owned-workspace-spec.md` §10 in full (all eleven items),
§8's first three paragraphs, §6's limits. The big picture's *Interim states* (the e2e
paragraph).

The suite has been red since task 02: `01-app-boot`, `02-editor-write`,
`03-workspace-switch`, `06-tree-search`, `07-quick-open` and `08-editor-lsp` all read
or set the working location through `/api/path-location`, and
`web/playwright.config.js` resolves the suite's own connection fixture from
`NOJAE_PATH_LOCATION`. This task brings all of it onto the new mechanism **in one
change**, and adds the two-tab run the spec's acceptance is written in.

No other task may touch these files; nothing here is piecemeal.

## Deliver

### 1. `web/playwright.config.js`

The suite's connection fixture is resolved from the **installation folder**, which is
the folder a new tab lands on and the folder the server boots with — so
`nojaé-test-settings.json` is still found where it is committed
(`<repo>/.nojae/`). Replace the `NOJAE_PATH_LOCATION` lookup with the installation
folder, and keep the loud failure when the file is absent, unchanged in wording
except for the sentence naming where it looked.

Do not introduce a second way to name a folder in the config: the specs name their
own workspaces per request, and the config names none.

### 2. The specs' own helpers

Each spec that needs a folder gets it the new way:

- The root the app boots on: `GET /api/workspace` (no field) answers `default`, which
  is the installation folder.
- A scratch folder: created as a directory under the repo with node's `fs` (as
  `03-workspace-switch` already does), then **named in every request** that needs it.
  There is no switch call any more: pointing a tab at it is a browser gesture
  (typing into the app bar's field and pressing Set), and an API call is a request
  that carries the field.
- Clean up with node's `fs`, exactly as today: switching into a scratch folder seeds
  its `.nojae`, and that folder is reserved, so the app will not delete the subtree.

The specs keep asserting on app state the composables own, never on a sleep.

### 3. The six specs, updated

- `01-app-boot` — the app bar's field shows the tab's workspace, which on a fresh
  browser is the installation folder; the payload it reads is `GET /api/workspace`.
- `02-editor-write` — the tree, the read, the write and the delete all name the
  scratch folder; the write refusal while a reply streams is asserted **on the
  folder that is streaming**, which is the new subject.
- `03-workspace-switch` — becomes the folder-move spec: type a scratch folder into
  the field, press Set, and the tree, the editor's tabs and the panels all move; the
  installation's catalogue (agents, models, helper bullets) is untouched by the move.
  Its `currentRoot()` helper becomes a read of the tab's workspace, not of the
  process's.
- `06-tree-search`, `07-quick-open`, `08-editor-lsp` — the moved folder is carried on
  each request; the assertions are unchanged.

### 4. The new spec: two tabs

`web/e2e/11-two-tabs.spec.js`, driving the spec's acceptance items that need a
browser:

- Two pages on the same URL. Point one at scratch folder A and the other at B
  (through the field, as a user would). Assert each tab's tree lists its own files,
  and that the address bar is identical in both.
- In tab A select an agent whose model is the suite's configured one; in tab B
  select another agent. Assert the two tabs' selects differ and neither moved the
  other's.
- Reload each tab: each returns to its own folder and its own agent.
- Open a third tab: it lands on the installation folder — not on A's and not on B's —
  and its address bar is the same. Its tree lists the installation's files.
- A third tab pointed at A sees A's answers, with its own agent.
- Close a tab mid-reply and assert the other tab's reply completes.
- Nothing about the catalogue was configured twice: the agent list read in both tabs
  is the same list.

**Two items need a real model and are therefore the human half**: two replies
streaming at once with each naming its own folder in its tool answers, and Pause in
A stopping A only. The spec may drive the streaming *shape* against the suite's own
model where it can do so without a timing assumption; where it cannot, it asserts
the state transitions and leaves the framing to the human list. **Write those two
items down in this task**, as a short commented list at the top of the new spec, so
task 13 has something to carry into the checklist rather than re-deriving it.

### 5. Nothing else moves

- `fullyParallel: false` and `workers: 1` **stay**. Two pages inside one spec is how
  the two-tab run is deterministic; two specs racing over one server would not be,
  and the spec's D7 explicitly refuses an invalidation channel that would make it
  safe.
- Every spec still runs against the stub-free, connector-free server the config
  spawns.

## Files

- `web/playwright.config.js`
- `web/e2e/01-app-boot.spec.js`, `02-editor-write.spec.js`,
  `03-workspace-switch.spec.js`, `06-tree-search.spec.js`, `07-quick-open.spec.js`,
  `08-editor-lsp.spec.js`
- `web/e2e/11-two-tabs.spec.js` (new)
- `web/e2e/global-setup.js` — only if the build step needs a word

## Rules it must not break

- *"A test run takes its endpoint from the test files, never from a developer's."*
  The config keeps forcing the suite's own connection and keeps `NOJAE_TEST_SETTINGS`
  on, so no spec reaches the install's store.
- *"Tests stay hermetic"* — every scratch folder is created and removed by the spec,
  under the repo, outside anything the app's own rules hide; no spec names a
  developer's checkout as a workspace.
- *"The end-to-end suite has its own model connection"* (README) — the two items that
  need a real model are named in the checklist, not faked here.
- *"Each request names the workspace … the address bar stays free of it"* (spec D9) —
  no spec builds a URL containing the folder for a *page*; only API requests carry
  it, and the folder is typed into the field.
- *"No cross-tab invalidation"* (spec D7) — a spec that expects tab B to see a file
  created in A must refresh, and says so.
- *"composables/ hold … and own each live stream and its abort"* — the specs assert on
  composable state (phases, counts), never on rendered prose.

## Depends on

Tasks 01–11.

## Done when

- `cd web && npm run test:e2e` is green, with the six updated specs and the new
  two-tab spec.
- The two-tab spec proves: two tabs on one address on two folders, each with its own
  agent, the address bar identical, a reload restoring each, and a fourth tab landing
  on the installation folder.
- A tab closed mid-reply stops its own turn and the other's completes.
- No spec reads `NOJAE_PATH_LOCATION` and no spec calls `/api/path-location`.
- The two items that need a real model are written down in task 13's checklist with
  the sentence saying why they are human.
- `pytest` and `cd web && npm test` remain green.

Finish by moving this file into `todos/done/`.
