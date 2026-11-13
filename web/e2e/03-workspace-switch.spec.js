import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The working location is what every workspace-relative path in the app is
// measured from, so moving it invalidates all of them at once — including the
// file an Editor tab is showing. The bug this spec pins: after a switch the tab
// strip kept the README.md of the *previous* root while the tree had moved on,
// so the two halves of the Editor disagreed about which project was open. A
// switch now closes the tabs of the root it leaves.
//
// The other half of the same rule, and the point of the app-level store: a
// switch changes **nothing** about the model connection, the agents or the
// prompt helpers. Those are rows of the installation's `nojae.db`, so the
// servers, models, agents and bullets a user built once are there in every
// workspace with no setup step (D11, AC-1) — and a fresh workspace's `.nojae/`
// holds only what is genuinely workspace-declared (D2, AC-2).
//
// No LLM call is needed except in the one streaming check at the end. The new
// root is a top-level scratch folder (gitignored and out of the way of the
// repo's own files), and the location is restored afterwards so the other specs
// still see the boot-time root. It is *not* under `logs/` any more: nojae's own
// rules hide that tree from the Editor, so a folder in it could not be created
// through the API at all.
//
// The scratch root is removed with node's `fs`, not through `/api/fs/file`:
// switching into it seeds a `.nojae/read-write-policy.json` there (pol-05), and
// that folder is reserved — the Editor will not delete a subtree that contains
// it, by design. So the spec cleans up the way a user would, from outside the
// app.
const SCRATCH = 'e2e-ws-root'

// The app-level bullet this spec adds and removes again. It is the witness that
// the prompt helpers are the installation's, not the workspace's.
const SENTINEL_HELPER = 'the install store survives a switch'

async function create(request, path, dir = false) {
  return request.post('/api/fs/create', { data: { path, dir } })
}

async function currentRoot(request) {
  return (await (await request.get('/api/path-location')).json()).path
}

// Windows: the unlink of a folder that existed for seconds can fail EPERM
// while a handle to it is still closing — anything the app (or the OS) ran
// inside the switched-in root holds its current-directory handle until it is
// reaped: the `git` of a status query (`editorfs/gitstatus.py`), the indexer,
// the scan of the freshly seeded files. `maxRetries`/`retryDelay` is Node's
// bound for exactly this on a directory (EPERM/EBUSY/ENOTEMPTY) — but it is
// not the end of it: `rmSync` can also *return* with the folder still on disk,
// because the last handle closes after the call and the name stays in the
// listing until it does. So removal is over only when the path is gone, and it
// is retried until then; the answer says which of the two happened. Waiting
// matters: a `beforeEach` that gave up early handed the next spec's `create` a
// 409 for a folder this suite had just deleted — a failure naming nothing, and
// the flake this is here to stop.
//
// A folder that still will not go after every attempt is reported by the
// `beforeEach` that needs it out of the way; the teardown, which owes the next
// spec nothing, ignores the answer — the folder is gitignored, and one genuinely
// in the way then fails loudly at that spec's own `create` (409).
async function removeScratch(root) {
  const target = path.join(root, SCRATCH)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(target, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 300,
      })
    } catch {
      // Still held; the attempt below retries while the handle closes.
    }
    if (!fs.existsSync(target)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  // Still held after every attempt: the caller decides whether that is a note
  // (the teardown's) or a failure (the next spec's, which cannot start).
  return false
}

// The scratch root as a switch target: the boot root (`GET /api/path-location`,
// the app's own witness, so already canonical) plus the folder's name. Folded
// to `/` because the app normalises a `\`-shaped input anyway (win-03) — the
// value only has to *reach* the root, its spelling is the host's.
function expectedPath(root, rel) {
  return path.join(root, rel).replaceAll(path.sep, '/')
}

// The install root, from this file's own `../../..` — the way
// `playwright.config.js` locates the repo, and the same join that file uses to
// find the suite's settings fixture.
const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))

// The suite's own model connection: the flat fixture the server under test
// materialises into its temporary database at boot, because
// `playwright.config.js` exports `NOJAE_TEST_SETTINGS` and refuses to start the
// suite without it. Read from disk with `node:fs` — the folder is reserved, so
// no Editor route can see it — and resolved the way the app resolves it:
// `NOJAE_PATH_LOCATION` when set, else the repo root.
//
// This is the assertion that pins "the suite talks to the fixture, never to
// wherever the app happens to be pointed": the store's one server and model are
// compared to *this file's* values, so a spec that started reaching the
// developer's configured connection fails instead of passing.
const TEST_SETTINGS_FILE = path.join(
  (process.env.NOJAE_PATH_LOCATION || '').trim() || REPO_ROOT,
  '.nojae',
  'nojae-test-settings.json',
)
function testSettingsDocument() {
  return JSON.parse(fs.readFileSync(TEST_SETTINGS_FILE, 'utf8'))
}

// The app's own spelling of a path — `os.path.realpath`'s answer, which spells
// the host separator (win-01: the shape is the OS's, never a name check). A
// comparison with a `/`-shaped value folds both sides, which is what lets one
// assertion work whatever the host.
const fold = (p) => p.replaceAll('\\', '/')

// The switch as a user performs it: the app bar's working-location field, then
// its Set button. There is nothing to close afterwards — the field *is* the
// location, and Set is an apply, so the bar shows the new root as soon as the
// server has answered.
//
// The wait is for the **response**, not for the field. Polling the field alone
// waits for nothing: `fill()` has already put `target` there, so the poll is
// satisfied on its first attempt whether or not the server has answered, and
// the switch is still in flight when the helper returns. That is what made the
// seeding assertion below race: the route seeds the MCP declaration and the
// policy *before* the two hub restarts and the LSP template *after* them, so a
// caller that did not wait for the answer read the folder mid-switch and found
// exactly those two. The response is the last thing the route produces, so it
// is the one moment all three seeds are on disk.
//
// `target` is always absolute: the route refuses anything else with 422, so a
// relative one would leave the location exactly where it was while the page
// looked like it had moved. The assertion folds the separators on both sides —
// the sentence these lines are here for is "the app bar moved to the root this
// switch asked for", the app's behaviour, and the host's spelling of a path may
// not decide it.
async function setRoot(page, target) {
  const field = page.locator('.appbar-location-input')
  await field.fill(target)
  const button = page.locator('.appbar-location-set')
  await expect(button).toBeEnabled()
  // Armed before the click, so the response it resolves on cannot be missed.
  const applied = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/path-location' &&
      response.request().method() === 'POST',
  )
  await button.click()
  // A refused switch leaves the field holding what was typed, so the poll below
  // would pass anyway and the spec would fail later, somewhere else, for a
  // reason that names nothing. Say which refusal this was.
  const res = await applied
  expect(res.ok(), `the working-location switch failed: ${await res.text()}`).toBe(true)
  await expect
    .poll(async () => fold(await field.inputValue()))
    .toContain(fold(target))
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

test.beforeEach(async ({ request }) => {
  // The removal has to be *finished* before the spec's own `create` runs, or
  // that create answers 409 for a folder this suite deleted a moment ago.
  const cleared = await removeScratch(await currentRoot(request))
  expect(cleared, `the scratch folder is still in the way: ${SCRATCH}`).toBe(true)
})

// The root this server booted on, remembered so a spec that fails between its
// two switches cannot leave the whole suite pointing at a scratch folder.
let bootRoot = null

test.afterEach(async ({ request }) => {
  await removeSentinelHelper(request)
  if (bootRoot === null) return
  // The *live* location decides, not a remembered flag: a spec that ended its
  // own switch back owes nothing, and one that died mid-way owes exactly one
  // restore. A switch restarts both hubs and costs seconds, so the check keeps
  // that one free — and it cannot drift out of sync the way a flag can.
  if ((await currentRoot(request)) !== bootRoot) {
    const res = await request.post('/api/path-location', { data: { path: bootRoot } })
    expect(res.ok(), `could not restore the working location: ${await res.text()}`).toBe(true)
  }
  await removeScratch(bootRoot)
})

test('a switch closes the tabs of the root it leaves', async ({ page, request }) => {
  const original = await currentRoot(request)
  bootRoot = original
  expect((await create(request, SCRATCH, true)).ok()).toBe(true)
  // The same relative name on both sides of the switch, so a surviving tab
  // cannot be mistaken for a correctly re-opened one.
  expect((await create(request, `${SCRATCH}/README.md`)).ok()).toBe(true)
  const scratchAbs = expectedPath(original, SCRATCH)

  await page.goto('/')
  await page.getByRole('tab', { name: 'Editor' }).click()
  await expect(page.locator('.editor-nav-tree')).toBeVisible()

  await setRoot(page, scratchAbs)

  // The acceptance for the reserved folder's seeding, on the real switch and the
  // real disk. A brand-new workspace ends up with exactly the files that are
  // genuinely workspace-declared: the policy (pol-05), the MCP declaration
  // (from the committed template), and the LSP *template* only (the declaration
  // itself is hand-written, so it must not appear here). The model connection,
  // the agents and the prompt helpers are rows of the install's store now, so
  // there is no settings, modes or helpers file to seed (D2, AC-2).
  expect(fs.readdirSync(path.join(scratchAbs, '.nojae')).sort()).toEqual([
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
  await expect(page.locator('.editor-body .stream-empty-title')).toHaveText('Open a file')
  // The old root is re-rooted too, and listed for real — the forget is not a
  // blank tree.
  await expect(rootRow).toHaveAttribute('title', new RegExp(path.basename(original)))

  // The scratch folder the spec created is back in the listing (it is a
  // top-level folder of this workspace, and no policy rule names it). What the
  // root can *not* list is `.nojae` — reserved, and holding this workspace's
  // policy and its trash — and `logs`, which nojae's own rules hide as the
  // app's backups.
  await expect(page.locator('.tree-row[data-path="e2e-ws-root"]')).toBeVisible()
  await expect(page.locator('.tree-row[data-path="logs"]')).toHaveCount(0)
  await expect(page.locator('.tree-row[data-path=".nojae"]')).toHaveCount(0)
})

// AC-1 and AC-2, in one place: a switch is a change of *folder*, never of the
// installation's settings. The servers and their models, the agents and the
// prompt helpers are read from `nojae.db`, so they are the same rows on both
// sides of the switch — with no setup step — while the new workspace's
// `.nojae/` holds no store file at all.
//
// The reads are the app's own routes, not the database's bytes: a spec that
// opens the store is a second authority on it (§4.6).
test('a switch leaves the store unchanged and seeds no store files', async ({
  page,
  request,
}) => {
  const original = await currentRoot(request)
  bootRoot = original
  expect((await create(request, SCRATCH, true)).ok()).toBe(true)
  const scratchAbs = expectedPath(original, SCRATCH)
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
  // active workspace. It belongs to the install, so it has to be there after
  // the switch — and it is the read route, never a file, that says so.
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

  await setRoot(page, scratchAbs)

  // AC-1: every row the store answers with is unchanged, and the composer and
  // the bullet row did not move either — a switch reloads neither (D11).
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

  // The Settings dialog is an editor over the same store in the new workspace:
  // its Models section names the fixture's server and model, with no file to
  // find and no setup step.
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

  // AC-2: a fresh workspace carries only the workspace-declared files — no
  // model connection, agent or helper store file at all — and nothing in the
  // app looks for them: the path-location payload carries the location, the
  // policy and the two hub declarations, and no per-workspace store block.
  expect(fs.readdirSync(path.join(scratchAbs, '.nojae')).sort()).toEqual([
    'lsp-settings.template.json',
    'mcp-settings.json',
    'read-write-policy.json',
  ])
  const location = await (await request.get('/api/path-location')).json()
  expect(Object.keys(location).sort()).toEqual([
    'default',
    'key',
    'lspSettings',
    'lspSettingsTemplate',
    'mcpSettings',
    'path',
    'policy',
  ])
})

// The other half of "one value moves everything": the trash moves with the
// root too. Deleting inside a switched-in workspace must file its batch under
// *that* workspace's reserved folder — not under the install directory the app
// booted from, where a foreign project's deleted bytes have no business being.
test('a delete in a switched-in workspace trashes under that workspace', async ({
  page,
  request,
}) => {
  const original = await currentRoot(request)
  bootRoot = original
  expect((await create(request, SCRATCH, true)).ok()).toBe(true)
  expect((await create(request, `${SCRATCH}/gone.txt`)).ok()).toBe(true)
  const scratchAbs = expectedPath(original, SCRATCH)

  await page.goto('/')
  await setRoot(page, scratchAbs)

  const res = await request.delete('/api/fs/file?path=gone.txt')
  expect(res.ok(), await res.text()).toBe(true)
  const body = await res.json()
  // Working-location-relative, the digest-and-stamp batch name the delete
  // invents — and this time the location it is relative to is the new root.
  // `/`-joined on every host (A §7): a payload field never carries `\`.
  expect(body.trashedTo).toMatch(/^\.nojae\/trash\/[0-9a-f]{12}_/)
  // The batch lives under the *switched-in* root, layout and all, and the
  // install directory gained nothing.
  expect(fs.existsSync(path.join(scratchAbs, body.trashedTo))).toBe(true)
  expect(fs.existsSync(path.join(scratchAbs, body.trashedTo, 'gone.txt'))).toBe(true)
})

test('unsaved edits are reported when the switch closes their tab', async ({ page, request }) => {
  const original = await currentRoot(request)
  bootRoot = original
  expect((await create(request, SCRATCH, true)).ok()).toBe(true)
  expect((await create(request, `${SCRATCH}/note.txt`)).ok()).toBe(true)
  const scratchAbs = expectedPath(original, SCRATCH)

  await page.goto('/')
  await page.getByRole('tab', { name: 'Editor' }).click()
  await setRoot(page, scratchAbs)
  await page.locator('.tree-row[data-path="note.txt"]').first().click()
  await expect(page.locator('.editor-tab')).toHaveCount(1)

  await page.locator('.monaco-host .view-lines').first().click()
  await page.keyboard.type(' written here only')
  await expect(page.locator('.editor-tab-dirty')).toHaveCount(1)

  await setRoot(page, original)

  // Closing a dirty tab is the switch's doing, not the user's gesture, so the
  // loss gets a line rather than the confirm whose Save answer no longer has a
  // path to write to.
  await expect(page.locator('.editor-tab')).toHaveCount(0)
  const notice = page.locator('.editor-notice--warn').first()
  await expect(notice).toContainText('1 tab closed with unsaved changes')
})

// A WorkBench reply at the boot root, so the suite is proven *configured* and
// not merely readable: with the test switch on, a mispointed or malformed
// fixture refuses with the store's own sentence naming the file, which is a far
// more honest failure than a timeout. Nothing is asserted about the wording —
// the endpoint is a real server, so only the shape of the stream is.
test('the boot root streams a reply from the test settings file', async ({
  page,
  request,
}) => {
  bootRoot = await currentRoot(request)

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
  // would make the next spec's working-location switch — or any other mutation —
  // answer 409 for a reason that has nothing to do with what it asserts.
  //
  // The bound is the test's own, not the 30 s expect default: this is the only
  // spec that streams, and it is the first thing to ask the model after the
  // server booted, so a cold server's first reply carries its load/warm-up time
  // — measured here at ~31 s against a 2 s warm one. Bounding that wait at 30 s
  // is a flake that costs the *next* spec too: the reply is still in flight, so
  // the shared afterEach's restore of the working location answers 409 and an
  // unrelated spec fails. Nothing is weakened — the stream must still end, and
  // the refusal below still fires well inside the bound. Kept under the test's
  // own 120 s budget (playwright.config.js), which is the wait that actually
  // fails the spec.
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
