import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Task qop-08 — the quick-open finder as a human performs it, in a real browser.
//
// This is the layer that can see the three things jsdom cannot: a keystroke the
// *browser* would otherwise claim (Ctrl+P is Print), a `<dialog>.showModal()`
// that really opens and really hands focus back, and a candidate list filtered
// by the workspace policy on the live route. No LLM call is involved — the
// feature is one GET plus a pure matcher in the browser — so nothing here needs
// a reachable endpoint. The suite's model connection
// (`.nojae/nojae-test-settings.json`, exported by `playwright.config.js` as
// `NOJAE_TEST_SETTINGS`) is what the *server* boots with; no spec in this
// file reads it, and none may.
//
// The scratch is a **fixture workspace** of its own (clws-12): the page is
// pointed at it through the app bar's field, and every request names it, so the
// policy file that marks one folder `hidden` and one `ro` is a fact about a file
// this spec owns. It is created and removed with node's `fs`; admitting it seeds
// a `.nojae/` there, and that folder is reserved, so the Editor will not delete
// the subtree that contains it. Same shape as 03-workspace-switch.
const SCRATCH = 'e2e-workspace'
const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
// The folder as **the server canonicalises it** (win-01): `resolve()` answers
// `realpath`, so the app bar's field holds the host's own separators. Forcing
// `/` here is a second spelling of one folder that never matches what the tab
// displays on Windows.
const WORKSPACE = path.join(REPO_ROOT, SCRATCH)
const WS = { workspace: WORKSPACE }

// The fixture's own rules — the two exclusions scenario 3 asserts, and nothing
// else. `hidden` prunes the folder, so its names are never listed and the
// finder cannot even confirm they exist; `ro` keeps a folder the *tree* still
// shows out of the finder, because the finder is a shortcut to files you will
// *edit*. Both folders exist on disk, so neither rule is a typo the loader
// would report (and a reported error would contribute no rules at all).
const POLICY = {
  version: 1,
  readme: ['e2e fixture: one hidden folder and one read-only folder'],
  policies: [
    { path: 'secret', mode: 'hidden' },
    { path: 'vendor', mode: 'ro' },
  ],
}

// The fixture files as the workspace spells them. Every path the app holds is
// relative to the tab's folder, so the scratch folder's own name is not part of
// them.
const SEED = {
  plain: 'visible.txt',
  nested: 'alpha/nested-target.md',
  hidden: 'secret/hidden-file.txt',
  ro: 'vendor/vendored-file.txt',
}

const PLAIN = SEED.plain
const NESTED = SEED.nested
const HIDDEN_DIR = 'secret'
const RO_DIR = 'vendor'

async function create(request, target, dir = false) {
  return request.post('/api/fs/create', { params: WS, data: { path: target, dir } })
}

async function diskStat(request, target) {
  const res = await request.get('/api/fs/stat', { params: { ...WS, path: target } })
  return (await res.json()).paths[0]
}

// Byte-exact seed through the write route, with the mtime token the save guard
// demands — the way 02-editor-write and 06-tree-search seed known text.
async function seed(request, target, text) {
  expect((await create(request, target)).ok(), `could not create ${target}`).toBe(true)
  const res = await request.put('/api/fs/file', {
    params: WS,
    data: { path: target, text, ifUnmodifiedSince: (await diskStat(request, target)).mtime },
  })
  expect(res.ok(), `could not seed ${target}: ${await res.text()}`).toBe(true)
}

// Point the tab at the fixture through the field: this is the user's move, and
// it is what makes the fixture's policy the live one for that tab. A reload
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

// The fixture workspace. The policy file goes in **before** admission, so the
// seed that admission performs finds it and leaves it alone (its create is
// exclusive, `O_EXCL`) — `.nojae` is reserved, and the app never writes this file
// through an Editor route, so the spec does it from outside with `fs`.
async function seedFixture(request) {
  fs.rmSync(WORKSPACE, { recursive: true, force: true })
  fs.mkdirSync(path.join(WORKSPACE, '.nojae'), { recursive: true })
  fs.writeFileSync(
    path.join(WORKSPACE, '.nojae', 'read-write-policy.json'),
    `${JSON.stringify(POLICY, null, 2)}\n`,
    'utf8',
  )

  // The folders are made from outside the app: the policy is live for this
  // workspace, so it hides `secret` and makes `vendor` read-only before any
  // Editor write could create them. The spec owns those bytes.
  for (const dir of ['alpha', HIDDEN_DIR, RO_DIR]) {
    fs.mkdirSync(path.join(WORKSPACE, dir), { recursive: true })
  }
  await seed(request, SEED.plain, 'the buffer the pane opens first\n')
  await seed(request, SEED.nested, 'a nested file the finder has to reach\n')
  fs.writeFileSync(
    path.join(WORKSPACE, SEED.hidden),
    'a hidden folder is pruned, so this name is never listed\n',
    'utf8',
  )
  fs.writeFileSync(
    path.join(WORKSPACE, SEED.ro),
    'a read-only folder is browsable in the tree, never a candidate\n',
    'utf8',
  )
}

test.beforeEach(async ({ request }) => {
  await seedFixture(request)
})

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

// Open a top-level file of the fixture, so the code pane is mounted and the
// chord has a surface to be claimed on.
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

async function focusPane(page) {
  await page.locator('.monaco-host .view-lines').first().click()
  await expect.poll(() => paneHasFocus(page), 'the pane should hold focus').toBe(true)
}

// The dialog is *always mounted* (no `v-if`, so re-opening keeps the field's
// caret and the list's scroll position): "closed" means hidden, and that is what
// `toBeHidden` says — the same shape 06-tree-search uses.
const dialog = (page) => page.locator('.quickopen-dialog')
const field = (page) => page.locator('.quickopen-query')
const rows = (page) => page.locator('.quickopen-row')

// Raise the finder with the chord and wait for the listing it fetches. The
// response is the app's own statement that the candidate list has landed, so a
// "no rows" assertion afterwards is about the *filter* and never about a fetch
// still in flight — the one way a zero count could pass for the wrong reason.
async function openQuickOpen(page) {
  const listed = page.waitForResponse(
    (res) =>
      new URL(res.url()).pathname === '/api/fs/files' && res.request().method() === 'GET',
  )
  await page.keyboard.press('Control+p')
  await listed
  await expect(dialog(page)).toBeVisible()
  await expect(page.locator('.quickopen-busy')).toBeHidden()
}

// "Print did not fire" is not observable as a dialog in a headless browser, so
// the honest signal is the one the spec names: the keystroke was **consumed**.
//
// A capture-phase listener on `document` records the press, and the flag is read
// in a `setTimeout(0)` for two reasons: `defaultPrevented` is only final once
// every handler has run, and Monaco calls `stopPropagation()` on a chord it
// dispatches — so a bubble-phase listener would never see the event at all.
async function installPrintProbe(page) {
  await page.addInitScript(() => {
    window.__printProbe = { presses: 0, prevented: 0 }
    document.addEventListener(
      'keydown',
      (event) => {
        if (!(event.ctrlKey || event.metaKey) || event.altKey || event.shiftKey) return
        if (event.key.toLowerCase() !== 'p') return
        window.__printProbe.presses += 1
        setTimeout(() => {
          if (event.defaultPrevented) window.__printProbe.prevented += 1
        }, 0)
      },
      true,
    )
  })
}

// 1. The chord, on the surface it is claimed on. Ctrl+P is the browser's Print,
// so the assertion is not "a dialog appeared" but "the keystroke was consumed
// *and* the dialog appeared" — the two halves of §2.1, and the second is what
// makes the first a feature rather than an accident.
test('Ctrl+P in the pane raises the dialog and Print never fires', async ({ page }) => {
  await installPrintProbe(page)
  await openEditor(page)
  await openFile(page, PLAIN)
  await focusPane(page)

  await openQuickOpen(page)

  // The field is autofocused (§2.2), so typing goes straight into the filter.
  await expect(field(page)).toBeFocused()

  // Exactly one press, and it was consumed. A `prevented` of 0 is the bug this
  // scenario exists for: the browser would have opened its print preview.
  await expect
    .poll(() => page.evaluate(() => window.__printProbe))
    .toEqual({ presses: 1, prevented: 1 })
})

// 2. The whole point of the feature: a name you know, a file you land in. The
// file is nested and its folder was never expanded, so the row can only come
// from the fetched listing — not from anything the tree had already loaded.
test('a fragment of a nested name finds it, and Enter opens it in the pane', async ({ page }) => {
  await openEditor(page)
  await openFile(page, PLAIN)
  await focusPane(page)

  await openQuickOpen(page)

  // The folder is still collapsed: the finder reaches what the tree has not.
  await expect(page.locator(`.tree-row[data-path="alpha"]`)).toHaveAttribute(
    'aria-expanded',
    'false',
  )

  await field(page).fill('nested')
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toContainText(NESTED)

  await page.keyboard.press('Enter')

  // The dialog closes on open (§2.6), the buffer is a tab, and the caret is back
  // in the pane — the three things a pick promises, in that order.
  await expect(dialog(page)).toBeHidden()
  await expect(page.locator('.editor-tab-label')).toHaveText(['visible.txt', 'nested-target.md'])
  await expect.poll(() => paneHasFocus(page), 'a pick returns focus to the pane').toBe(true)
})

// 3. The candidate set is the tree's set **minus `ro`**, and a hidden path is
// indistinguishable from an absent one. Asserted twice on purpose: on the
// payload (the rule is the server's, and the browser can only show what it was
// sent) and in the browser (what the person actually sees, whatever they type).
test('a hidden or read-only path is never in the list, whatever is typed', async ({
  page,
  request,
}) => {
  const payload = await (await request.get('/api/fs/files', { params: WS })).json()

  // The Contract's key set, on the live route where the real policy applies.
  expect(Object.keys(payload).sort()).toEqual(['fileCount', 'files', 'truncated'])
  expect(payload.truncated).toBe(false)

  // The two visible files are candidates...
  expect(payload.files).toContain(PLAIN)
  expect(payload.files).toContain(NESTED)
  // ...and neither excluded folder contributes a single path. Not a row, and
  // not a count either: `fileCount` is the honest total of what was *listed*,
  // so a hidden name is not even counted.
  for (const candidate of payload.files) {
    expect(
      candidate.startsWith(`${HIDDEN_DIR}/`),
      `a hidden path reached the payload: ${candidate}`,
    ).toBe(false)
    expect(
      candidate.startsWith(`${RO_DIR}/`),
      `a read-only path reached the payload: ${candidate}`,
    ).toBe(false)
  }
  expect(payload.fileCount).toBe(payload.files.length)

  await openEditor(page)

  // The tree shows the read-only folder and prunes the hidden one — the finder's
  // bar is *stricter* than the tree's, and that difference is the rule here.
  await expect(page.locator(`.tree-row[data-path="${RO_DIR}"]`)).toBeVisible()
  await expect(page.locator(`.tree-row[data-path="${HIDDEN_DIR}"]`)).toHaveCount(0)

  await openFile(page, PLAIN)
  await focusPane(page)
  await openQuickOpen(page)

  // A query that *does* match, so the checks below are the filter's answer and
  // not an empty list nobody looked at.
  await field(page).fill('nested')
  await expect(rows(page)).toHaveCount(1)

  // Whatever is typed, no row may name an excluded path. Asserted on the rows
  // rather than as a row *count* on purpose: the matcher is a tolerant
  // subsequence (§2.4), so a query like "secret" can legitimately match a
  // visible path — what must never happen is a row whose text is a hidden or
  // read-only path, which is the claim this scenario makes.
  const excluded = [`${HIDDEN_DIR}/`, `${RO_DIR}/`]
  const assertNoExcludedRow = async (query) => {
    await field(page).fill(query)
    const texts = await rows(page).allInnerTexts()
    for (const text of texts) {
      for (const prefix of excluded) {
        expect(
          text.startsWith(prefix),
          `"${query}" listed an excluded path: ${text}`,
        ).toBe(false)
      }
    }
  }
  // The hidden file's own name, the read-only file's name, and the two folder
  // names — the four queries a person would try.
  for (const query of ['hidden-file', 'vendored', HIDDEN_DIR, RO_DIR]) {
    await assertNoExcludedRow(query)
  }
  // And the empty query, which lists every candidate: the same claim, on the
  // whole payload rather than on one filter's answer (§2.8).
  await assertNoExcludedRow('')
  await expect(rows(page)).toHaveCount(payload.files.length)
})

// Escape, and the app's own acknowledgement of it.
//
// The `<dialog>` closes itself on Escape, but its `close` event is dispatched as
// a **task**, so the composable learns about it one turn later than the element
// does. Waiting for that event is waiting for the app's state to settle — the
// same rule as waiting for a response instead of for a field — and it is what
// makes the re-open below a test of the *retention* rule rather than a race
// against the event queue.
async function escapeDialog(page) {
  const closed = page.evaluate(
    () =>
      new Promise((resolve) => {
        document
          .querySelector('.quickopen-dialog')
          .addEventListener('close', () => resolve(true), { once: true })
      }),
  )
  await page.keyboard.press('Escape')
  await closed
  await expect(dialog(page)).toBeHidden()
}

// 4. Escape is the way out, and it costs nothing: the dialog closes, focus goes
// back to the pane it was raised from, and the filter is still there when the
// chord is pressed again — the query is the composable's, not the component's
// (§2.7), so a close is not a forget.
test('Escape closes and returns focus, and re-opening keeps the query', async ({ page }) => {
  await openEditor(page)
  await openFile(page, PLAIN)
  await focusPane(page)

  await openQuickOpen(page)
  await field(page).fill('nested')
  await expect(rows(page)).toHaveCount(1)

  await escapeDialog(page)
  // The browser hands focus back to the element that had it before `showModal()`
  // — the pane — which is what makes the next chord land on the Monaco command
  // rather than on the document.
  await expect.poll(() => paneHasFocus(page), 'Escape returns focus to the pane').toBe(true)

  await openQuickOpen(page)
  await expect(field(page)).toHaveValue('nested')
  await expect(rows(page)).toHaveCount(1)
  await expect(rows(page).first()).toContainText(NESTED)
})
