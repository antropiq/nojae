# 14 — The e2e spec `11-settings-servers.spec.js`

**Read first**: `docs/settings-dialog-migration-plan.md` §7 (the twelve acceptance
items) and §8's T13, which scopes this spec to items 3, 4, 5, 6, 7, 8, 9 and 10. Then
`web/e2e/04-agent-modes.spec.js` — the house style for a dialog spec: it reaches every
control by its **accessible name**, queries an inert slot by a fragment of its
**reason**, drives the store through its routes rather than through its bytes, and
sweeps what it created in `afterEach`. Then `web/playwright.config.js` and README →
"Setting up tests for nojae" for the suite's own connection. Then
`todos/sdmp-00-big-picture.md`.

**This dialog has no e2e spec today** (the suite is specs 01–10). This is the one
task in the lot that runs the e2e suite; tasks 01–13 do not.

## Deliver

New `web/e2e/11-settings-servers.spec.js`, level: UI state, over the suite's temporary
store. Cover these, one test per bullet, each named for the acceptance item it proves:

1. **Reserved geometry (item 3).** Open Settings, then the `Servers` section. The
   toolbar holds its five slot boxes; measure the three verbs' bounding boxes, then
   fill a listing with a long answer (see the routing note below) and re-measure: the
   boxes have not moved and the toolbar's height is unchanged. Then open a delete's
   confirmation pair and measure again — still unmoved, and the pair occupies the two
   reserved slots' width.
2. **Scope (item 4).** On a **model** page, `Save` posts a model route
   (`/api/models/save`) and its body carries no credential; on a **server** page,
   `Save` posts `/api/servers/save` and its body carries `apiKey` and no sampler. Do
   it by intercepting the requests with `page.route`/`waitForRequest` and reading the
   bodies — asserting the request is the honest way, since a successful save would
   otherwise be indistinguishable from a no-op.
3. **Fetch models' gate (item 5).** With `+` add a **new, unsaved** server (name and
   URL typed, nothing saved): `Fetch models` is disabled, its accessible name is its
   reason (`Save the server before fetching its models.`), and no request reaches
   `/api/models` when it is clicked. Save the server; it becomes live, labelled
   `Fetch models`.
4. **The long listing (item 6).** With the saved server selected, intercept
   `GET /api/models` and answer 200 names. `Fetch models` fills the two-column table;
   the table's own scroll container scrolls and the detail column has **no**
   scrollbar — assert the column's `scrollHeight` is not greater than its
   `clientHeight` while the table's container is. Assert the headers read `name` and
   `Add`.
5. **`+` lands on the Settings page (item 7).** Click a row's `+` for a name the server
   does not have yet. The request body is exactly `{ name, serverId }` — read the
   intercepted request. Then: the parent is expanded, the new model's tree row is
   selected **and focused**, the detail strip shows `Settings`, and the Name field
   holds the name just added. Then assert the duplicate half: the same name's `+` is
   now inert with `Already added`, and clicking it posts nothing.
6. **Tab switching preserves an edit (item 8).** On a model page, type a distinctive
   sentence into the `System prompt` textarea, click `Settings`, click
   `System prompt` again, and read the textarea — the sentence is there. Change a
   sampler and come back the other way the same way. Assert no request was made by
   either click (`page.route` counting, or a `page.on('request')` counter for the
   store's routes).
7. **Save does not close (item 9), and `Close` is the footer's only verb.** Save a
   model and assert the dialog is still open and shows the row; assert the footer's
   buttons are `Close` alone in all three sections.
8. **One band (item 10).** With an unsaved server typed, click `Save` on an incomplete
   form: the dialog stays open, nothing is written, and the sentence appears in the
   footer band only — assert the band element holds it, has role `alert` (or the
   action's own role), and that no other element in the dialog contains the same text.
   Then `Close` is still in the same place as it was before the sentence arrived
   (measure its box before and after).

## The rules this spec runs under

- **Its own connection only.** The suite points the server at
  `.nojae/nojae-test-settings.json`; a spec may read `/api/servers` and write through
  the store's routes, and may never reach another endpoint. Nothing here dials a model.
- **`GET /api/models` is intercepted, not dialled.** The long listing comes from
  `page.route`, the way `04-agent-modes.spec.js` fakes `/api/agents`, so the spec does
  not depend on what a developer's endpoint happens to list. Name the route predicate
  on the pathname, not on a full URL.
- **`+` writes a real row into the suite's store, so the spec sweeps it.** Use an
  `E2e ` prefix on every name the spec types or adds, and in `afterEach` delete any
  model whose name starts with `E2e ` (and any server it created) through
  `/api/models/delete` and `/api/servers/delete` — so a failure between a create and
  its delete cannot pollute a later spec or a later run. Deleting the created server
  takes its models with it, which is the cascade behaving as documented.
- **Reach controls by accessible name.** `Add`, `Save`, `Delete`, `Cancel delete`,
  `Confirm delete`, `Fetch models`, `Close` — and an inert one by a fragment of its
  reason. Do not key on a class for a control's meaning; classes are for the
  containers the geometry assertions need (the toolbar, the table, the band), and the
  spec should say so in a comment the way `04-agent-modes.spec.js` does.
- **Assert on state, not on sleeps.** No fixed timeout beyond the config's
  `expect.timeout`; use `expect.poll` / visibility assertions for a write's outcome.
- **The dialog is opened from the app bar** (the settings button), and it is available
  only when idle — no chat reply and no batch. Nothing here sends a turn, so nothing
  conflicts.
- **Clean up before asserting a count.** The suite's store already holds one server
  and one model from the fixture; every assertion about "the listing", "the tree" or
  "the table" is written relative to what the fixture provides, not to a fixed count.

## Do not

- **Do not add a spec for the other sections** beyond item 9's footer assertion. MCP
  and LSP are task 10's, and this spec is about the Servers tab.
- **Do not loosen the e2e environment** (`NOJAE_TEST_SETTINGS`, the two hub flags) to
  make a case pass. README's "Setting up tests for nojae" is the whole configuration.
- **Do not write, or expect, a real model reply.** Nothing here needs a turn; a spec
  that sends one would be about the chat, not this dialog.
- **Do not edit `.env.test` or `.nojae/nojae-test-settings.json`.** Both are
  hand-authored and gitignored; if either is missing, the run stops with its own
  message and that is the answer.
- **Do not touch `src/`.**

## Files

- `web/e2e/11-settings-servers.spec.js` — new, the eight tests above plus the
  `afterEach` sweep.

## Rules it must not break

- *"Tests stay hermetic: no test reads a real model connection, reaches a live hub or
  opens the install's settings store — the hubs are disabled by an environment flag
  and each test runs on a temporary store of its own."* The suite's switch gives the
  temporary store; `GET /api/models` is intercepted rather than dialled; no turn is
  sent; the sweep leaves nothing behind.
- *"Every write surface is the browser's alone … and the file ones are refused while a
  chat reply streams."* The spec drives the store's own routes from the browser's
  session, exactly as a user does.
- *"A server delete takes its models with it."* The `afterEach` sweep relies on that,
  and it is the behaviour under test, not an assumption about the client.
- *"Setup, run and test commands live in the README"* — `cd web && npm run test:e2e`
  (optionally with `-g` to run this file alone while developing it); do not invent a
  command, and do not add a `playwright.config.js` change.
- *"Desktop browsers only."* One viewport (`1440×900` from the config); a narrow-window
  assertion is task 12's, in CSS.

## Depends on

All of tasks 01–13. In particular: 04 (the toolbar's five slots), 05 (the detail
strip), 07 (the table and `Fetch models`), 08 (the band), 09 (the confirmation pair)
and 06 (the `+` write).

## Done when

- `cd web && npm run test:e2e -g "settings"` (or the whole suite) runs
  `11-settings-servers.spec.js` green against the suite's own store.
- Each of the eight tests names the acceptance item it proves in its title or its
  leading comment.
- The spec sweeps every row it created: a second run in the same session starts from
  the same store state as the first.
- The spec asserts the two click-created rows' bodies exactly (`{ name, serverId }`
  for `+`, no credential in a model save) rather than inferring them from a UI change.
- Nothing outside `web/e2e/` changed.

Finish by moving this file into `todos/done/`.
