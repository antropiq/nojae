import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The working location is what every workspace-relative path in the app is
// measured from, so moving **a tab's** folder invalidates all of them at once —
// including the file an Editor tab is showing. The bug this spec pins: after a
// move the tab strip kept the README.md of the *previous* root while the tree
// had moved on, so the two halves of the Editor disagreed about which project
// was open. A move now closes the tabs of the root it leaves.
//
// **The move is a tab's, not the process's** (clws-12). The gesture is the app
// bar's field and its Set button; the tab adopts the server's canonical answer
// and every workspace-scoped request of that tab carries it. There is no
// process-wide location to restore, so the teardown only removes the scratch
// folder: a reload keeps the tab's folder, and a new tab enters on the
// installation folder because this one never wrote a browser-wide value.
//
// The other half of the same rule, and the point of the app-level store: a move
// changes **nothing** about the model connection, the agents or the prompt
// helpers. Those are rows of the installation's `nojae.db`, so the servers,
// models, agents and bullets a user built once are there in every workspace with
// no setup step (D11, AC-1) — and a fresh workspace's `.nojae/` holds only what is
// genuinely workspace-declared (D2, AC-2).
//
// No LLM call is needed except in the one streaming check at the end. The new
// root is a scratch folder under the repo, created and removed by this spec with
// node's `fs` — not through `/api/fs/file`: admitting it seeds a `.nojae/` there,
// and that folder is reserved, so the Editor will not delete the subtree that
// holds it.
const SCRATCH = 'e2e-ws-root'
const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
// The folder as **the server canonicalises it** (win-01): `resolve()` answers
// `realpath`, so a canonical root carries the host separator on every request
// the browser builds from it. Comparisons that must survive both spellings
// fold both sides (`fold`, below) — that is what it is for.
const WORKSPACE = path.join(REPO_ROOT, SCRATCH)
const WS = { workspace: WORKSPACE }

// The app-level bullet this spec adds and removes again. It is the witness that
// the prompt helpers are the installation's, not the workspace's.
const SENTINEL_HELPER = 'the install store survives a move'

// The folder a new tab lands on: `GET /api/workspace` with no field answers the
// installation, and that answer is the boot root this spec moves away from and
// back to. **No process state is read or written** — the field on each request is
// the only thing that decides which folder an answer is about.
async function installationRoot(request) {
  const res = await request.get('/api/workspace')
  expect(res.ok(), `GET /api/workspace failed: ${await res.text()}`).toBe(true)
  return (await res.json()).workspace
}

// The move as a user performs it: the app bar's field, then its Set button. The
// wait is for the **response**, not for the field — `fill()` has already put the
// target there, so polling the field alone would be satisfied whether or not the
// server answered. A refused move leaves the field holding what was typed, so the
// status is checked and its sentence reported.
async function setRoot(page, target) {
  const field = page.locator('.appbar-location-input')
  await field.fill(target)
  const button = page.locator('.appbar-location-set')
  await expect(button).toBeEnabled()
  const applied = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/workspace' &&
      res.request().method() === 'GET' &&
      res.url().includes('workspace='),
  )
  await button.click()
  const res = await applied
  expect(res.ok(), `the workspace move failed: ${await res.text()}`).toBe(true)
  await expect
    .poll(async () => fold(await field.inputValue()))
    .toContain(fold(target))
}

// Admitting a folder is what seeds its reserved files. The hub route is the
// panel's read, named for the tab's folder; it starts no process with the suite's
// two disable flags on. A read of `GET /api/workspace` deliberately seeds nothing,
// so a spec that wants the seeded state asks the same question a panel does.
async function admit(request) {
  const res = await request.get('/api/mcp', { params: WS })
  expect(res.ok(), `could not admit the scratch workspace: ${await res.text()}`).toBe(true)
}

// A failed run must not leave the install's bullet list changed for the specs
// after it. The store is app-level and shared by the whole suite, so the
// cleanup goes through the same route the user's dialog does.
async function removeSentinelHelper(request) {
  const res = await request.get('/api/prompt-helpers')
  if (!res.ok()) return
  const { slots } = await res.json()
  for (const slot of slots ?? []) {
    if (slot.content === SENTINEL_HELPER) {
      await request.post('/api/prompt-helpers/delete', { data: { id: slot.id } })
    }
  }
}

// The suite's own model connection: the flat fixture the server under test
// materialises into its temporary database at boot, because
// `playwright.config.js` exports `NOJAE_TEST_SETTINGS` and refuses to start the
// suite without it. It lives in **`web/tests`**, beside that config and this
// spec — the third spelling of the path is `appdb.TEST_SETTINGS_DIR`, and
// `tests/test_appdb_test_fixture.py` pins that they agree.
const TEST_SETTINGS_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'tests',
  'nojae-test-settings.json',
)
function testSettingsDocument() {
  return JSON.parse(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8'))
}

// The app's own spelling of a path — `os.path.realpath`'s answer, which spells
// the host separator (win-01). A comparison with a `/`-shaped value folds both
// sides, which is what lets one assertion work whatever the host.
const fold = (p) => p.replaceAll('\\', '/')

// The reserved folder is kept **between the tests of this file**: one admission
// seeds it, and the later tests assert about moves and deletes rather than about a
// fresh seed. Everything the tests created beside it is cleared; the folder
// itself is removed by the suite's teardown, once the pool no longer needs it.
function clearVisibleEntries() {
  fs.mkdirSync(WORKSPACE, { recursive: true })
  for (const entry of fs.readdirSync(WORKSPACE)) {
    if (entry === '.nojae') continue
    fs.rmSync(path.join(WORKSPACE, entry), { recursive: true, force: true })
  }
}

test.beforeAll(() => {
  fs.rmSync(WORKSPACE, { recursive: true, force: true })
})

test.beforeEach(async () => {
  clearVisibleEntries()
})

test.afterEach(async ({ request }) => {
  await removeSentinelHelper(request)
  clearVisibleEntries()
})


test('a move closes the tabs of the root it leaves', async ({ page, request }) => {
  const original = await installationRoot(request)
  // The same relative name on both sides of the move, so a surviving tab cannot
  // be mistaken for a correctly re-opened one.
  fs.writeFileSync(path.join(WORKSPACE, 'README.md'), '# scratch\n', 'utf8')

  await page.goto('/')
  await page.getByRole('tab', { name: 'Editor' }).click()
  await expect(page.locator('.editor-nav-tree')).toBeVisible()

  // The panels read this tab's folder like every other surface: the move fires
  // both hub reads, and their answers are about the folder just adopted. Armed
  // before the gesture, so the responses cannot be missed. The read is also what
  // admits the folder — the moment the pool seeds it (spec §5.4, rule 23).
  const panelMcp = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/mcp' &&
      fold(new URL(res.url()).searchParams.get('workspace')) === fold(WORKSPACE),
  )
  const panelLsp = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/lsp' &&
      fold(new URL(res.url()).searchParams.get('workspace')) === fold(WORKSPACE),
  )
  await setRoot(page, WORKSPACE)
  const [mcpAnswer, lspAnswer] = await Promise.all([panelMcp, panelLsp])
  expect(mcpAnswer.ok(), `the MCP panel read failed: ${await mcpAnswer.text()}`).toBe(true)
  expect(lspAnswer.ok(), `the LSP panel read failed: ${await lspAnswer.text()}`).toBe(true)

  // The acceptance for the reserved folder's seeding, on the real move and the
  // real disk. A brand-new workspace ends up with exactly the files that are
  // genuinely workspace-declared: the policy (pol-05), the MCP declaration (from
  // the committed template), and the LSP *template* only (the declaration itself
  // is hand-written, so it must not appear here). The model connection, the
  // agents and the prompt helpers are rows of the install's store, so there is no
  // settings, modes or helpers file to seed (D2, AC-2).
  expect(fs.readdirSync(path.join(WORKSPACE, '.nojae')).sort()).toEqual([
    'lsp-settings.template.json',
    'mcp-settings.json',
    'read-write-policy.json',
  ])

  // The tree re-rooted: the root row names the new folder and lists its own
  // README.md, and nothing of the previous root's listing is on screen.
  const rootRow = page.locator('.tree-row--root')
  // The name only, so the match cannot depend on how the host spells a path.
  await expect(rootRow).toHaveAttribute('title', new RegExp(SCRATCH))
  await page.locator('.tree-row[data-path="README.md"]').first().click()
  const tabs = page.locator('.editor-tab')
  await expect(tabs).toHaveCount(1)
  await expect(tabs.locator('.editor-tab-label')).toHaveText('README.md')

  await setRoot(page, original)

  // The bug this spec exists for: the tab used to survive this, still showing
  // the file of the root that was just left.
  await expect(tabs).toHaveCount(0)
  await expect(page.locator('.editor-body .stream-empty-title')).toContainText(
    'Open a file',
  )
  // The old root is re-rooted too, and listed for real — the forget is not a
  // blank tree.
  await expect(rootRow).toHaveAttribute('title', new RegExp(path.basename(original)))

  // The scratch folder the spec created is back in the listing (it is a top-level
  // folder of this workspace, and no policy rule names it). What the root can
  // *not* list is `.nojae` — reserved, and holding this workspace's policy and its
  // trash — and `logs`, which nojae's own rules hide as the app's backups.
  await expect(
    page.locator(`.tree-row[data-path="${path.basename(WORKSPACE)}"]`),
  ).toBeVisible()
  await expect(page.locator('.tree-row[data-path="logs"]')).toHaveCount(0)
  await expect(page.locator('.tree-row[data-path=".nojae"]')).toHaveCount(0)
})

// AC-1 and AC-2, in one place: a move is a change of *folder*, never of the
// installation's settings. The servers and their models, the agents and the
// prompt helpers are read from `nojae.db`, so they are the same rows on both sides
// of the move — with no setup step — while the new workspace's `.nojae/` holds no
// store file at all.
//
// The reads are the app's own routes, not the database's bytes: a spec that opens
// the store is a second authority on it (§4.6).
test('a move leaves the store unchanged and seeds no store files', async ({
  page,
  request,
}) => {
  const original = await installationRoot(request)
  const fixture = testSettingsDocument()

  // The suite is speaking to its own fixture materialised into the temporary
  // store, not to a developer's configured connection: the one server and model
  // are the file's own, with no ids written into the spec.
  const serversBefore = await (await request.get('/api/servers')).json()
  expect(serversBefore.servers[0].url).toBe(fixture.server.url)
  expect(serversBefore.servers[0].models[0].name).toBe(fixture.server.model.name)
  const agentsBefore = await (await request.get('/api/agents')).json()
  expect(agentsBefore.agents.length).toBeGreaterThan(0)

  // One bullet added through the app's own writer while the boot root is the
  // active workspace. It belongs to the install, so it has to be there after the
  // move — and it is the read route, never a file, that says so.
  const addedRes = await request.post('/api/prompt-helpers/add', {
    data: { color: '#2ec27e', content: SENTINEL_HELPER },
  })
  expect(addedRes.ok(), await addedRes.text()).toBe(true)
  const helpersBefore = await addedRes.json()

  await page.goto('/')
  await page.getByRole('tab', { name: 'WorkBench' }).click()
  const select = page.getByLabel('Agent mode')
  await expect(select).toBeVisible()
  const optionLabels = await select.getByRole('option').allTextContents()
  await expect(page.locator(`.memory-bullet[title="${SENTINEL_HELPER}"]`)).toHaveCount(1)

  await setRoot(page, WORKSPACE)
  await admit(request)

  // AC-1: every row the store answers with is unchanged, and the composer and the
  // bullet row did not move either — a move reloads neither (D11).
  expect(await (await request.get('/api/servers')).json()).toEqual(serversBefore)
  expect(await (await request.get('/api/agents')).json()).toEqual(agentsBefore)
  expect(
    (await (await request.get('/api/prompt-helpers')).json()).slots,
  ).toEqual(helpersBefore.slots)
  await expect(select.getByRole('option')).toHaveText(optionLabels)
  await expect(page.locator('.chat-bullet-row .memory-bullet')).toHaveCount(
    helpersBefore.slots.length,
  )
  await expect(page.locator(`.memory-bullet[title="${SENTINEL_HELPER}"]`)).toHaveCount(1)

  // The Settings dialog is an editor over the same store in the new workspace: its
  // Models section names the fixture's server and model, with no file to find and
  // no setup step.
  const loadedServers = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/servers',
  )
  await page.getByRole('button', { name: 'Open settings' }).click()
  await loadedServers
  const modelsSection = page.locator('.settings-models')
  await expect(modelsSection).toContainText(fixture.server.name)
  // The model is a child row of its server, so the disclosure has to be open
  // before the tree renders it.
  await modelsSection.locator('.models-disclosure').first().click()
  await expect(modelsSection).toContainText(fixture.server.model.name)
  await page.locator('.settings-dialog').getByRole('button', { name: 'Close' }).click()

  // AC-2: a fresh workspace carries only the workspace-declared files — no model
  // connection, agent or helper store file at all — and nothing in the app looks
  // for them: the workspace payload carries the folder, the default, the policy
  // and the two hub declarations, and no per-workspace store block.
  expect(fs.readdirSync(path.join(WORKSPACE, '.nojae')).sort()).toEqual([
    'lsp-settings.template.json',
    'mcp-settings.json',
    'read-write-policy.json',
  ])
  const location = await (
    await request.get('/api/workspace', { params: WS })
  ).json()
  expect(Object.keys(location).sort()).toEqual([
    'default',
    'hubs',
    'lspSettings',
    'lspSettingsTemplate',
    'mcpSettings',
    'policy',
    'workspace',
  ])
  // These two are **roots**, and a root is answered canonically (win-01) — the
  // `/`-joined rule is for workspace-*relative* payload fields (trashedTo
  // above), never for the folder itself. `fold` stays for the comparisons where
  // one side is a spelling the browser chose; here both sides come from the
  // same server, so they are byte-identical.
  expect(location.workspace).toBe(WORKSPACE)
  expect(location.default).toBe(original)
})

// The other half of "one value moves everything": the trash moves with the root
// too. Deleting inside a moved-in workspace must file its batch under *that*
// workspace's reserved folder — not under the installation folder the app booted
// from, where a foreign project's deleted bytes have no business being.
test('a delete in a moved workspace trashes under that workspace', async ({
  page,
  request,
}) => {
  const original = await installationRoot(request)
  fs.writeFileSync(path.join(WORKSPACE, 'gone.txt'), 'to be deleted\n', 'utf8')

  await page.goto('/')
  await setRoot(page, WORKSPACE)
  await admit(request)

  const res = await request.delete('/api/fs/file', {
    params: { ...WS, path: 'gone.txt' },
  })
  expect(res.ok(), await res.text()).toBe(true)
  const body = await res.json()
  // Working-location-relative, the digest-and-stamp batch name the delete
  // invents — and this time the location it is relative to is the new root.
  // `/`-joined on every host (A §7): a payload field never carries `\`.
  expect(body.trashedTo).toMatch(/^\.nojae\/trash\/[0-9a-f]{12}_/)
  // The batch lives under the *moved-in* root, layout and all, and the
  // installation directory gained nothing.
  expect(fs.existsSync(path.join(WORKSPACE, body.trashedTo))).toBe(true)
  expect(fs.existsSync(path.join(WORKSPACE, body.trashedTo, 'gone.txt'))).toBe(true)
  expect(fs.existsSync(path.join(original, body.trashedTo))).toBe(false)
})

test('unsaved edits are reported when the move closes their tab', async ({
  page,
  request,
}) => {
  const original = await installationRoot(request)
  fs.writeFileSync(path.join(WORKSPACE, 'note.txt'), '', 'utf8')

  await page.goto('/')
  await page.getByRole('tab', { name: 'Editor' }).click()
  await setRoot(page, WORKSPACE)
  await page.locator('.tree-row[data-path="note.txt"]').first().click()
  await expect(page.locator('.editor-tab')).toHaveCount(1)

  await page.locator('.monaco-host .view-lines').first().click()
  await page.keyboard.type(' written here only')
  await expect(page.locator('.editor-tab-dirty')).toHaveCount(1)

  await setRoot(page, original)

  // Closing a dirty tab is the move's doing, not the user's gesture, so the loss
  // gets a line rather than the confirm whose Save answer no longer has a path to
  // write to.
  await expect(page.locator('.editor-tab')).toHaveCount(0)
  const notice = page.locator('.editor-notice--warn').first()
  await expect(notice).toContainText('1 tab closed with unsaved changes')
})

// A WorkBench reply at the installation folder, so the suite is proven
// *configured* and not merely readable: with the test switch on, a mispointed or
// malformed fixture refuses with the store's own sentence naming the file, which
// is a far more honest failure than a timeout. Nothing is asserted about the
// wording — the endpoint is a real server, so only the shape of the stream is.
test('the installation folder streams a reply from the test settings file', async ({
  page,
  request,
}) => {
  await installationRoot(request)

  await page.goto('/')
  await page.getByRole('tab', { name: 'WorkBench' }).click()
  await page.locator('.chat-textarea').fill('Reply with exactly one word.')
  await page.locator('.chat-send').click()

  // Both scoped to the WorkBench output column: tab views stay mounted through
  // `v-show`, so an unscoped `.chat-answer-card` counts every card the document
  // holds, not just this panel's replies.
  const output = page.locator('.chat-output')
  const error = output.locator('.error-line')
  const replies = output.locator('.chat-answer-card')
  await expect(replies).toHaveCount(1)
  // Wait for the reply to **finish**: the composer swaps Send for Stop while one
  // streams, so Send being back is the stream's own end. Leaving it in flight
  // would make the next spec's write — or any other mutation — answer 409 for a
  // reason that has nothing to do with what it asserts.
  //
  // The bound is the test's own, not the 30 s expect default: this is the only
  // spec that streams, and it is the first thing to ask the model after the server
  // booted, so a cold server's first reply carries its load/warm-up time —
  // measured here at ~31 s against a 2 s warm one. Kept under the test's own 120 s
  // budget (playwright.config.js), which is the wait that actually fails the spec.
  await expect(page.locator('.chat-send:not(.chat-stop)')).toBeVisible({
    timeout: 90_000,
  })
  // A misconfigured fixture refuses with the store's sentence on the error line
  // rather than streaming; a real reply lands in the card. Checking the refusal
  // first means a failure says which of the two happened.
  await expect(error).toHaveCount(0)
  const answer = replies.first().locator('.answer')
  await expect
    .poll(async () => (await answer.innerText()).trim().length)
    .toBeGreaterThan(0)
  // And the reply is the model's own, not a fragment of a cut stream.
  await expect(replies.locator('.chat-truncated')).toHaveCount(0)
})
