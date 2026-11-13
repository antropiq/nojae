import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

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
// The scratch is a **fixture workspace** of its own, and switching into it is
// what makes scenario 3 deterministic: the policy file that marks one folder
// `hidden` and one `ro` is written by this spec, so the two exclusions are
// facts about a file the spec owns rather than about whatever the developer's
// checkout happens to contain. It is a top-level folder (gitignored, and
// visible to the pane) and it is removed with node's `fs`, not through
// `/api/fs/file`: switching into it seeds a `.nojae/` there, and that folder is
// reserved — the Editor will not delete a subtree that contains it. Same shape
// as 03-workspace-switch and 04-agent-modes.
const SCRATCH = 'e2e-quickopen'

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

// The fixture as the **boot** root spells it — what the seeding routes address
// before the switch, since the working location is still the install directory.
const SEED = {
  plain: `${SCRATCH}/visible.txt`,
  nested: `${SCRATCH}/alpha/nested-target.md`,
  hidden: `${SCRATCH}/secret/hidden-file.txt`,
  ro: `${SCRATCH}/vendor/vendored-file.txt`,
}

// The same files as the **fixture** root spells them — what the finder lists
// once the working location has moved. Every path the app holds is relative to
// the working location, so the scratch folder's own name is not part of them.
const PLAIN = 'visible.txt'
const NESTED = 'alpha/nested-target.md'
const HIDDEN_DIR = 'secret'
const RO_DIR = 'vendor'

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
// this is here to stop. Same rule as 03-workspace-switch and 04-agent-modes.
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
// demands — the way 02-editor-write and 06-tree-search seed known text.
async function seed(request, target, text) {
  expect((await create(request, target)).ok(), `could not create ${target}`).toBe(true)
  const res = await request.put('/api/fs/file', {
    data: { path: target, text, ifUnmodifiedSince: (await diskStat(request, target)).mtime },
  })
  expect(res.ok(), `could not seed ${target}: ${await res.text()}`).toBe(true)
}

// The fixture workspace, seeded the way the other specs seed theirs: the visible
// tree through the app's own writer, and the one file no Editor route can write
// through node's `fs`.
//
// The policy file goes in **before** the switch, so the seed that a switch
// performs finds it and leaves it alone (its create is exclusive, `O_EXCL`) —
// `.nojae` is reserved, and the app never writes this file through an Editor
// route, so the spec does it from outside with `fs`.
async function seedFixture(request) {
  const created = await create(request, SCRATCH, true)
  expect(created.ok(), `could not create the scratch workspace: ${await created.text()}`).toBe(
    true,
  )

  const reserved = path.join(bootRoot, SCRATCH, '.nojae')
  fs.mkdirSync(reserved, { recursive: true })
  fs.writeFileSync(
    path.join(reserved, 'read-write-policy.json'),
    `${JSON.stringify(POLICY, null, 2)}\n`,
    'utf8',
  )

  for (const dir of [`${SCRATCH}/alpha`, `${SCRATCH}/${HIDDEN_DIR}`, `${SCRATCH}/${RO_DIR}`]) {
    expect((await create(request, dir, true)).ok(), `could not create ${dir}`).toBe(true)
  }
  await seed(request, SEED.plain, 'the buffer the pane opens first\n')
  await seed(request, SEED.nested, 'a nested file the finder has to reach\n')
  await seed(request, SEED.hidden, 'a hidden folder is pruned, so this name is never listed\n')
  await seed(request, SEED.ro, 'a read-only folder is browsable in the tree, never a candidate\n')
}

test.beforeEach(async ({ request }) => {
  bootRoot = await currentRoot(request)
  // The removal has to be *finished* before `seedFixture`'s own `create` runs,
  // or that create answers 409 for a folder the previous spec deleted.
  const cleared = await removeScratch(bootRoot)
  expect(cleared, `the scratch folder is still in the way: ${SCRATCH}`).toBe(true)
  await seedFixture(request)
  // The switch is the app's own route — the one the app bar's Set button calls —
  // and it is what makes the fixture's policy the live one.
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
  const payload = await (await request.get('/api/fs/files')).json()

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
