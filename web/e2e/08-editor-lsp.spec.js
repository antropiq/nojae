import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

// Task lspe-12 — the Editor pane's language-server gesture as a human performs
// it, in a real browser. No LLM call is involved: the feature is one POST plus
// the hub behind it, so nothing here needs a reachable endpoint, and no spec in
// this file reads a model connection.
//
// **Scenario 1 is automated; scenario 2 is a manual check.** That split is the
// spec's own escape hatch (§8: "If that proves too heavy for the suite, it stays
// a manual check and the e2e keeps only the first"), and here it is not a
// judgement call but a fact about this harness: `playwright.config.js` starts the
// server under test with `nojae_DISABLE_LSP=1`, and that flag is read from
// the *server process's* environment by both the app lifespan and
// `POST /api/lsp/restart`. A spec cannot change another process's environment,
// and it may not touch the config — so no declaration written into a scratch
// workspace can make the shared server spawn a language server. Scenario 2 would
// need a second app instance of its own (its own port, its own environment, its
// own seeding and teardown), which is exactly the "too heavy" the spec names.
//
// **What a human does to perform scenario 2 by hand:**
//   1. In the working location's `.nojae/lsp-settings.json`, declare a server
//      with `"enable": true`, `"extensions": [".txt"]`, `"workspaceRoot"` set to
//      that working location, and `"command": ["<the Python that runs the app>",
//      "tests/fake_langserver.py"]`.
//   2. Put its id in `lspEnabled` in `.nojae/nojae-settings.json`.
//   3. Start the app **without** `nojae_DISABLE_LSP` in its environment.
//   4. `POST /api/lsp/restart`, then switch that server on in the WorkBench Tools
//      panel — the browser's half of the gate.
//   5. Open a `.txt` file in the Editor and Ctrl+click a name. The caret lands on
//      line 3 (the fake server answers a definition at 0-based line 2).
// A stub is deliberately not used in place of this: a spec that asserts a stub
// proves nothing about the feature.
//
// Scenario 1 is the one that must never regress (§4.10). Under the flag above
// there is no language server at all, so *every* buffer is unclaimed — which is
// the degradation path in its purest form: the caret stays where the click put
// it and no notice is raised. The feature degrades to the status quo, never to
// an error.
//
// The scratch is a **fixture workspace** of its own, and switching into it is
// what makes the assertions facts about a file this spec owns rather than about
// whatever the developer's checkout happens to contain. It is a top-level folder
// (visible to the pane) and it is removed with node's `fs`, not through
// `/api/fs/file`: switching into it seeds a `.nojae/` there, and that folder is
// reserved — the Editor will not delete a subtree that contains it. Same shape as
// 03-workspace-switch, 04-agent-modes and 07-quick-open.
const SCRATCH = 'e2e-editor-lsp'

// The fixture as the **boot** root spells it — what the seeding routes address
// before the switch, since the working location is still the install directory.
const SEED = `${SCRATCH}/notes.txt`

// The same file as the **fixture** root spells it — what the tree and the pane
// address once the working location has moved. Every path the app holds is
// relative to the working location, so the scratch folder's own name is not part
// of it.
const FILE = 'notes.txt'

// Four short lines, so a jump is visible as a *different* line: the gesture is
// made on line 2 and a definition answer would land the caret somewhere else.
// The suffix is `.txt` — a file no language server in this suite claims, and the
// suffix the manual check above declares.
const TEXT = 'alpha\nbeta\ngamma\ndelta\n'

// The line the gesture is made on, 0-based as the rendered `.view-line` list is.
const TARGET_LINE_INDEX = 1
// …and the same line as the gutter numbers it, which is what the caret assertion
// reads.
const TARGET_LINE = '2'

// The root this server booted on, remembered so a spec that fails between its
// two switches cannot leave the whole suite pointing at a scratch folder.
let bootRoot = null

async function currentRoot(request) {
  return (await (await request.get('/api/path-location')).json()).path
}

// Removal is over when the path is gone, not when `rmSync` returned. Windows:
// the unlink of a folder that existed for seconds can fail EPERM while a handle
// to it is still closing — anything the app ran inside the switched-in root
// holds its current-directory handle until it is reaped (the terminal's shell
// cwd, the `git` of a status query) — and `maxRetries`/`retryDelay` is Node's
// bound for exactly this on a directory. It is not the end of it either: the
// call can *return* with the folder still on disk, because the last handle
// closes after it and the name stays in the listing until it does. So the
// removal is retried until the path is gone, and the answer says which of the
// two happened — a `beforeEach` that gave up early handed the next spec's
// `create` a 409 for a folder this suite had just deleted, which is the flake
// this is here to stop. Same rule as 03-workspace-switch and 07-quick-open.
//
// A folder that still will not go after every attempt is reported by the
// `beforeEach` that needs it out of the way; the teardown, which owes the next
// spec nothing, ignores the answer.
async function removeScratch(root) {
  const target = path.join(root, SCRATCH)
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    } catch {
      // Still held; the attempt below retries while the handle closes.
    }
    if (!fs.existsSync(target)) return true
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

async function create(request, target, dir = false) {
  return request.post('/api/fs/create', { data: { path: target, dir } })
}

async function diskStat(request, target) {
  const res = await request.get(`/api/fs/stat?path=${encodeURIComponent(target)}`)
  return (await res.json()).paths[0]
}

// Byte-exact seed through the write route, with the mtime token the save guard
// demands — the way 02-editor-write and 07-quick-open seed known text.
async function seed(request, target, text) {
  expect((await create(request, target)).ok(), `could not create ${target}`).toBe(true)
  const res = await request.put('/api/fs/file', {
    data: { path: target, text, ifUnmodifiedSince: (await diskStat(request, target)).mtime },
  })
  expect(res.ok(), `could not seed ${target}: ${await res.text()}`).toBe(true)
}

// The fixture workspace: one folder and one file, both through the app's own
// writer, so the pane opens a buffer whose text this spec chose.
async function seedFixture(request) {
  const created = await create(request, SCRATCH, true)
  expect(created.ok(), `could not create the scratch workspace: ${await created.text()}`).toBe(
    true,
  )
  await seed(request, SEED, TEXT)
}

test.beforeEach(async ({ request }) => {
  bootRoot = await currentRoot(request)
  // The removal has to be *finished* before `seedFixture`'s own `create` runs,
  // or that create answers 409 for a folder the previous spec deleted.
  const cleared = await removeScratch(bootRoot)
  expect(cleared, `the scratch folder is still in the way: ${SCRATCH}`).toBe(true)
  await seedFixture(request)
  // The switch is the app's own route — the one the app bar's Set button calls —
  // and it is what makes the fixture the live working location.
  const moved = await request.post('/api/path-location', {
    data: { path: path.join(bootRoot, SCRATCH) },
  })
  expect(moved.ok(), `could not move the working location: ${await moved.text()}`).toBe(true)
})

test.afterEach(async ({ request }) => {
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
  bootRoot = null
})

async function openEditor(page) {
  await page.goto('/')
  await page.getByRole('tab', { name: 'Editor' }).click()
  await expect(page.locator('.editor-nav-tree')).toBeVisible()
}

// Open the fixture file, so the code pane is mounted and the gesture has a
// surface to be made on.
async function openFile(page, target) {
  await page.locator(`.tree-row[data-path="${target}"]`).first().click()
  await expect(page.locator('.monaco-host .view-lines').first()).toBeVisible()
}

// Whether the caret is in the code pane. Monaco moves focus to an input of its
// own on a click — a `<textarea>` or, where the EditContext API exists, a
// contenteditable node — so the honest question is "the active element is
// inside the pane", not "it is this one element".
function paneHasFocus(page) {
  return page.evaluate(() => document.activeElement?.closest('.monaco-host') !== null)
}

// The caret's position, read from the two DOM facts Monaco renders it with —
// the same kind of witness 06-tree-search uses for a revealed line, and for the
// same reason: the spec has no handle on the editor instance, and a screenshot
// comparison would prove less.
//
//   * the gutter's `active-line-number` row is the caret's *model* line, and
//     exactly one row carries that class at a time;
//   * the primary cursor node's `top`/`left` are the rendered position, so two
//     equal readings mean the caret did not move at all — not merely that it
//     stayed on the same line.
//
// The gutter pads its numbers to right-align them, hence the trim.
async function caretPosition(page) {
  return page.evaluate(() => {
    const active = document.querySelector(
      '.monaco-host .margin-view-overlays .line-numbers.active-line-number',
    )
    const cursor = document.querySelector('.monaco-host .cursors-layer .cursor')
    return {
      line: active ? active.textContent.trim() : null,
      top: cursor ? cursor.style.top : null,
      left: cursor ? cursor.style.left : null,
    }
  })
}

// One rendered line of the code pane. Monaco renders one `.view-line` per
// visible line, in line order, so the nth element is the nth line.
function viewLine(page, index) {
  return page.locator('.monaco-host .view-lines .view-line').nth(index)
}

// The gesture, made where a person makes it: hold Ctrl, click a name. The click
// point is inside the line's first characters, which is where a symbol sits.
async function ctrlClick(page, index) {
  await viewLine(page, index).click({ position: { x: 10, y: 6 }, modifiers: ['Control'] })
}

// The app's own answer to the gesture: the `definition` query the pane's
// provider posts. Waiting for it is waiting for the gesture to be *over*, so the
// assertions after it are about a finished request rather than a race — and it
// is also the proof that the gesture reached the hub at all, instead of the
// provider never being asked. The status query posts to the same route, so the
// action in the body is what tells the two apart.
function definitionAnswered(page) {
  return page.waitForResponse((res) => {
    if (new URL(res.url()).pathname !== '/api/lsp/query') return false
    try {
      return JSON.parse(res.request().postData() ?? '{}').action === 'definition'
    } catch {
      return false
    }
  })
}

// 1. The degradation path, which is the one that must never regress (§4.10).
//
// The suite's server runs with `nojae_DISABLE_LSP=1`, so no language
// server exists and this `.txt` buffer is claimed by nobody. Ctrl+click must
// then change nothing: the caret stays where the click put it and no notice is
// raised.
test('Ctrl+click in a file no server claims changes nothing', async ({
  page,
}) => {
  await openEditor(page)
  await openFile(page, FILE)

  // The buffer on screen is the fixture's, so the gesture below is about a file
  // this spec seeded and not about whatever the pane happened to open.
  await expect(page.locator('.monaco-host .view-lines').first()).toContainText('beta')

  // Put the caret where the gesture will be made, and read it. A plain click
  // first is what makes the "before" reading a position the user chose rather
  // than Monaco's initial caret on line 1.
  await viewLine(page, TARGET_LINE_INDEX).click({ position: { x: 10, y: 6 } })
  await expect.poll(() => paneHasFocus(page), 'the pane should hold focus').toBe(true)
  await expect.poll(() => caretPosition(page)).toMatchObject({ line: TARGET_LINE })
  const before = await caretPosition(page)
  // The reading has to be a *real* one: a null cursor node would make the
  // "did not move" comparison below true for the wrong reason.
  expect(before.top).not.toBeNull()
  expect(before.left).not.toBeNull()

  // The gesture itself, and the app's own answer to it.
  const answered = definitionAnswered(page)
  await ctrlClick(page, TARGET_LINE_INDEX)
  const response = await answered
  const envelope = await response.json()

  // The hub answered quietly: no server claims the file, and the envelope says
  // so in the wire's own shape rather than as an error.
  expect(envelope.status).toBe('no_server')
  expect(envelope.server).toBeNull()
  expect(envelope.action).toBe('definition')
  expect(envelope.result).toBeNull()

  // The caret did not move — same line, same rendered position. A definition
  // answer would have landed it on another line; a fall-through to Monaco's own
  // behaviour would have left it exactly here, which is the point.
  expect(await caretPosition(page)).toEqual(before)

  // No notice: not the app's stack (which is where a refusal would be reported)
  // and not Monaco's own overlay message either — the gesture is muted, so a
  // "No definition found" bubble never appears.
  await expect(page.locator('.editor-notice')).toHaveCount(0)
  await expect(page.locator('.monaco-editor-overlaymessage')).toHaveCount(0)
})
