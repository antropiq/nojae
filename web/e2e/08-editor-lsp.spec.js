import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Task lspe-12 — the Editor pane's language-server gesture as a human performs
// it, in a real browser. No LLM call is involved: the feature is one POST plus
// the hub behind it, so nothing here needs a reachable endpoint, and no spec in
// this file reads a model connection.
//
// **Scenario 1 is automated; scenario 2 is a manual check.** That split is the
// spec's own escape hatch (§8: "If that proves too heavy for the suite, it stays
// a manual check and the e2e keeps only the first"), and here it is not a
// judgement call but a fact about this harness: `playwright.config.js` starts the
// server under test with `NOJAE_DISABLE_LSP=1`, and that flag is read from
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
//   2. Start the app **without** `NOJAE_DISABLE_LSP` in its environment. The
//      declaration's `enable: true` is the whole activation decision (D13), so
//      there is no second switch to tick anywhere.
//   3. `POST /api/lsp/restart`, then switch that server on in the WorkBench Tools
//      panel — the **conversation**-scoped allowlist, a different axis from the
//      activation gate.
//   4. Open a `.txt` file in the Editor and Ctrl+click a name. The caret lands on
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
// The scratch is a **fixture workspace** of its own (clws-12): the page is
// pointed at it through the app bar's field and every request names it, so the
// assertions are facts about a file this spec owns rather than about whatever
// the developer's checkout happens to contain. It is created and removed with
// node's `fs`; admitting it seeds a `.nojae/` there, and that folder is reserved,
// so the Editor will not delete the subtree that contains it. Same shape as
// 03-workspace-switch.
const SCRATCH = 'e2e-workspace'
const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
// The folder as **the server canonicalises it** (win-01): `resolve()` answers
// `realpath`, so the app bar's field holds the host's own separators. Forcing
// `/` here is a second spelling of one folder that never matches what the tab
// displays on Windows.
const WORKSPACE = path.join(REPO_ROOT, SCRATCH)
const WS = { workspace: WORKSPACE }

// The fixture file as the workspace spells it: the tab's folder is the scratch,
// so its own name is not part of any path the app holds.
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

async function create(request, target, dir = false) {
  return request.post('/api/fs/create', { params: WS, data: { path: target, dir } })
}

async function diskStat(request, target) {
  const res = await request.get('/api/fs/stat', { params: { ...WS, path: target } })
  return (await res.json()).paths[0]
}

// Byte-exact seed through the write route, with the mtime token the save guard
// demands — the way 02-editor-write and 07-quick-open seed known text.
async function seed(request, target, text) {
  expect((await create(request, target)).ok(), `could not create ${target}`).toBe(true)
  const res = await request.put('/api/fs/file', {
    params: WS,
    data: { path: target, text, ifUnmodifiedSince: (await diskStat(request, target)).mtime },
  })
  expect(res.ok(), `could not seed ${target}: ${await res.text()}`).toBe(true)
}

// Point this tab at the fixture through the field, as a user does. A reload
// keeps the same tab and folder, so this is a no-op afterwards.
async function pointTabAt(page) {
  const field = page.locator('.appbar-location-input')
  if ((await field.inputValue()) === WORKSPACE) return
  await field.fill(WORKSPACE)
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
  expect(res.ok(), `could not point the tab at ${WORKSPACE}: ${await res.text()}`).toBe(true)
  await expect(field).toHaveValue(WORKSPACE)
}

// The fixture workspace: one folder and one file, both through the app's own
// writer, so the pane opens a buffer whose text this spec chose.
async function seedFixture(request) {
  fs.rmSync(WORKSPACE, { recursive: true, force: true })
  fs.mkdirSync(WORKSPACE, { recursive: true })
  await seed(request, FILE, TEXT)
}

// The Editor pane's terminal shell is born in the tab's workspace, and a folder
// a live process names as its cwd cannot be removed on Windows (`EPERM`, which
// `rmSync` does not retry — win-02, same as `02-editor-write.spec.js`). The wait
// is on the server's own witness: `GET /api/terminal` drops a session only after
// its teardown killed the process tree. (A 422 — the scratch is already gone —
// trivially means no shell lives in it.)
async function waitForShellsGone(request) {
  await expect
    .poll(
      async () => {
        const res = await request.get('/api/terminal', { params: WS })
        if (!res.ok()) return 0
        const sessions = (await res.json()).sessions ?? []
        return sessions.filter(
          (s) => (s.cwd ?? '').toLowerCase() === WORKSPACE.toLowerCase(),
        ).length
      },
      { message: 'a terminal shell still holds the scratch as its cwd', timeout: 30_000 },
    )
    .toBe(0)
}

test.beforeEach(async ({ request }) => {
  // The previous test's shell can still be dying when this hook runs.
  await waitForShellsGone(request)
  await seedFixture(request)
})

test.afterEach(async ({ page, request }) => {
  // Fixtures outlive `afterEach`, so the tab that holds the shell is still
  // open when this hook runs: close it first, wait for its teardown, delete.
  await page.close()
  await waitForShellsGone(request)
  fs.rmSync(WORKSPACE, { recursive: true, force: true })
})

async function openEditor(page) {
  await page.goto('/')
  await pointTabAt(page)
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
// The suite's server runs with `NOJAE_DISABLE_LSP=1`, so no language
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
