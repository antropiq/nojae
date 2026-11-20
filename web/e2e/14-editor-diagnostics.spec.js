import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// ediag-10 — the Editor's status bar and its diagnostics, as far as a hermetic
// browser can honestly take them.
//
// **What this file proves, and what it cannot.** `playwright.config.js` starts
// the server under test with `NOJAE_DISABLE_LSP=1`, read from the *server
// process's* environment by both the app lifespan and `POST /api/lsp/restart`.
// A spec cannot change another process's environment and may not touch that
// config, so no declaration written into a scratch workspace can make the
// shared server spawn a language server. What remains provable is everything
// the flag does not blind:
//
//   * the bar's **geometry** — at the wide viewport and below the narrow
//     breakpoint, this feature's most likely shipping failure (§8's first and
//     last items), provable with no language server at all;
//   * the **no-server degradation** — every buffer in this suite is unclaimed
//     by definition, so the bar's reason, the absence of a notice and the
//     absence of a verdict are the spec's own subject here (§8's fourth item).
//
// Everything else in §8 needs a live server: the underlines, the hover, the
// overview ruler, `analysing…` giving way to a verdict, and the underlines
// surviving a read-only pane during a reply. Those live in **the manual
// checklist below**, which is this file's header on purpose — beside the spec
// that automates the other half, exactly as `08-editor-lsp.spec.js` keeps its
// own manual check. A stub server is deliberately not used in their place: a
// spec that asserts a stub proves nothing about the feature.
//
// **The manual check, step by step** (a person, one machine, a real server):
//
//   1. In the working location's `.nojae/lsp-settings.json`, declare a server
//      with `"enable": true`, `"extensions": [".py", ".pyi"]`,
//      `"workspaceRoot"` set to that working location, and `"command"` naming
//      that server's stdio launcher — `["pyright-langserver", "--stdio"]` for
//      pyright, whose complete entry the README's LSP section spells out.
//   2. Start the app **without** `NOJAE_DISABLE_LSP` in its environment. The
//      declaration's `enable: true` is the whole activation decision, so there
//      is no second switch to tick anywhere. Then restart the hub (the LSP
//      panel's **restart**, or `POST /api/lsp/restart`) and switch that server
//      on in the WorkBench Tools panel — the **conversation**-scoped allowlist,
//      a different axis from the activation gate.
//   3. Open a **clean** `.py` file — `answer: int = 1` and nothing else — and
//      watch the bar: `analysing…` first, then **no problems** once pyright has
//      indexed the project. An empty squiggle set before that verdict is the
//      lie this feature exists to prevent, so the intermediate word must have
//      been seen.
//   4. Put a real defect in it — `answer: int = "no"` on its own line — and wait
//      a moment. The line is underlined in red, the bar shows a count, and
//      hovering the underline shows the server's own message.
//   5. Start a chat reply and leave it streaming. The pane goes read-only and
//      **the underline is still there** — §8's headline regression, and the one
//      Monaco's own default would cause (its validation filter hides markers in
//      a read-only editor unless the pane asks otherwise).
//   6. Put the same defect near the top of a long file and scroll the code pane
//      far past it: the overview ruler on the right edge still carries the mark.
//   7. Fix the defect. The underline goes away, the bar says the file is clean,
//      and it does not come back when an older answer lands afterwards.
//   8. With the browser's network panel open, type a dozen characters: at most
//      one `POST` to the LSP query route follows, after the typing settles —
//      never one per keystroke.
//
// The scratch is a **fixture workspace** of its own, in the shape the other
// Editor specs use: the page is pointed at it through the app bar's field and
// every request names it, so these assertions are facts about a folder this
// spec owns rather than about whatever the developer's checkout happens to
// hold. It is created and removed with node's `fs`; admitting it seeds a
// `.nojae/` there, and that folder is reserved, so the Editor will not delete
// the subtree that contains it.
const SCRATCH = 'e2e-workspace'
const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
// The folder as **the server canonicalises it**: `resolve()` answers
// `realpath`, so the app bar's field holds the host's own separators.
const WORKSPACE = path.join(REPO_ROOT, SCRATCH)
const WS = { workspace: WORKSPACE }

// The fixture file as the workspace spells it: the tab's folder is the scratch,
// so its own name is not part of any path the app holds. `.txt` is a suffix no
// declared server in this suite claims — which is *every* file here, the hub
// being off, and the point of the degradation case below.
const FILE = 'notes.txt'
const TEXT = 'alpha\nbeta\ngamma\ndelta\n'

// The breakpoint the narrow block is written at (`styles/theme.css`): a
// 1024 px window is the widest narrow screen, so 900 px sits inside it.
const NARROW = { width: 900, height: 900 }

async function create(request, target, dir = false) {
  return request.post('/api/fs/create', { params: WS, data: { path: target, dir } })
}

async function diskStat(request, target) {
  const res = await request.get('/api/fs/stat', { params: { ...WS, path: target } })
  return (await res.json()).paths[0]
}

// Byte-exact seed through the write route, with the mtime token the save guard
// demands — the way `02-editor-write` and `08-editor-lsp` seed known text.
async function seed(request, target, text) {
  expect((await create(request, target)).ok(), `could not create ${target}`).toBe(true)
  const res = await request.put('/api/fs/file', {
    params: WS,
    data: { path: target, text, ifUnmodifiedSince: (await diskStat(request, target)).mtime },
  })
  expect(res.ok(), `could not seed ${target}: ${await res.text()}`).toBe(true)
}

// Point this tab at the fixture through the field, as a user does. The field is
// disabled until the boot read has adopted this tab's remembered folder, so an
// enabled field is the witness that the value read here is real.
async function pointTabAt(page) {
  const field = page.locator('.appbar-location-input')
  await expect(field).toBeEnabled()
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
// `rmSync` does not retry). The wait is on the server's own witness:
// `GET /api/terminal` drops a session only after its teardown killed the
// process tree. (A 422 — the scratch is already gone — trivially means no shell
// lives in it.)
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
  // Fixtures outlive `afterEach`, so the tab that holds the shell is still open
  // when this hook runs: close it first, wait for its teardown, delete.
  await page.close()
  await waitForShellsGone(request)
  fs.rmSync(WORKSPACE, { recursive: true, force: true })
})

async function openEditor(page) {
  await page.goto('/')
  await pointTabAt(page)
  await page.getByRole('tab', { name: 'Editor' }).click()
  await expect(page.locator('.editor-nav-tree')).toBeVisible()
  await expect(page.locator('.editor-status-bar')).toBeVisible()
}

// Open the fixture file, so the code pane is mounted and the bar describes a
// buffer rather than an empty pane.
async function openFile(page, target) {
  await page.locator(`.tree-row[data-path="${target}"]`).first().click()
  await expect(page.locator('.monaco-host .view-lines').first()).toBeVisible()
}

// The geometry of the strip, read from the browser's own layout. Every value is
// a client rect, because the question §8 asks ("at the very bottom, edge to
// edge, nothing below it") is a question about the laid-out page and nothing
// else can answer it.
//
// The shell's children are the *panes*: the file tree's column, the two
// resizers, the code pane, the terminal and the bar. The notice stack teleports
// to `<body>`, so it contributes no child here — and the deepest of the rest is
// what "nothing is below the bar" is measured against.
function geometry(page) {
  return page.evaluate(() => {
    const box = (selector) => {
      const el = document.querySelector(selector)
      if (!el) return null
      const rect = el.getBoundingClientRect()
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom }
    }
    const shell = document.querySelector('.editor-shell')
    const children = [...shell.children]
      .map((el) => el.getBoundingClientRect())
      .filter((rect) => rect.height > 0)
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      bar: box('.editor-status-bar'),
      nav: box('.editor-nav-col'),
      terminal: box('.editor-terminal-slot'),
      area: box('.editor-area-slot'),
      deepest: Math.max(...children.map((rect) => rect.bottom)),
    }
  })
}

// The three facts §8 states about the strip, asserted the same way at both
// widths: it is the bottom edge of the Editor screen, it spans the whole
// width, and nothing — the file tree's column included — reaches under it.
function expectStripIsTheBottomEdge(shell) {
  const { bar } = shell
  expect(bar, 'the strip is on screen').not.toBeNull()
  // Edge to edge: flush with both sides of the window, no side margin.
  expect(bar.left).toBeLessThanOrEqual(1)
  expect(bar.right).toBeGreaterThanOrEqual(shell.viewport.width - 1)
  // The very bottom of the window — and at the narrow breakpoint the caller
  // scrolls to the end of the document first, so a stacked layout taller than
  // the window cannot make this pass by accident.
  expect(bar.bottom).toBeGreaterThanOrEqual(shell.viewport.height - 1)
  // Nothing is below it, in the shell's own flow.
  expect(shell.deepest).toBeLessThanOrEqual(bar.bottom + 1)
  // The file tree's column ends at or above the strip, so its content never
  // runs beneath it; the terminal does too, and meets it on one edge.
  expect(shell.nav.bottom).toBeLessThanOrEqual(bar.top + 1)
  expect(shell.terminal.bottom).toBeLessThanOrEqual(bar.top + 1)
  expect(shell.terminal.bottom).toBeGreaterThanOrEqual(bar.top - 1)
}

// 1. The bar's geometry at the wide viewport (the config's 1440×900): at the
// very bottom, edge to edge, under the terminal and under the file tree's
// column, with the tree's content not running beneath it and nothing below it.
test('the status bar is the bottom edge of the Editor screen', async ({ page }) => {
  await openEditor(page)
  await openFile(page, FILE)

  const shell = await geometry(page)
  expect(shell.bar).not.toBeNull()
  // The strip is under the code pane as well as the tree: its top edge is below
  // the pane's bottom, and it is wider than the tree's column.
  expect(shell.bar.top).toBeGreaterThanOrEqual(shell.area.bottom - 1)
  expect(shell.bar.left).toBeLessThanOrEqual(shell.nav.left)
  expect(shell.bar.right).toBeGreaterThanOrEqual(shell.nav.right)
  expectStripIsTheBottomEdge(shell)
})

// 2. …and the same three facts below the narrow breakpoint. This is the failure
// this feature is most likely to ship with: the narrow block re-places every
// row by grid line, so a row list that did not name the bar would drop it
// entirely (the CSS suite pins the rule; this pins the rendering).
test('the status bar keeps the bottom edge below the narrow breakpoint', async ({ page }) => {
  await openEditor(page)
  await openFile(page, FILE)

  await page.setViewportSize(NARROW)
  // The single-column layout stacks the panes, so the page can be taller than
  // the window: the bottom edge is measured from the end of the document,
  // which is where a reader looking for the bar ends up.
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  const shell = await geometry(page)

  expect(shell.viewport.width).toBe(NARROW.width)
  // The tree becomes a drawer on its own row at this width, so this is the
  // arrangement the old bug would have hidden the bar in.
  expect(shell.bar.top).toBeGreaterThan(shell.nav.top)
  expectStripIsTheBottomEdge(shell)
})

// 3. The no-server state (§8's fourth item), which under the flag above is
// *every* buffer: the bar states the reason, no notice appears, and nothing
// else changes — the buffer is still open with its own text, and the bar makes
// no claim about problems it never heard about.
test('a file no server claims is named by the bar, and nothing else changes', async ({
  page,
}) => {
  // The bar's own two questions, captured as the app asks them: one `status`
  // read for the server field, one `diagnostics` read for the counts. Waiting
  // for them is waiting for the state below to be *settled* rather than a race.
  const statusAnswered = page.waitForResponse((res) => {
    if (new URL(res.url()).pathname !== '/api/lsp/query') return false
    try {
      return JSON.parse(res.request().postData() ?? '{}').action === 'status'
    } catch {
      return false
    }
  })
  const diagnosticsAnswered = page.waitForResponse((res) => {
    if (new URL(res.url()).pathname !== '/api/lsp/query') return false
    try {
      return JSON.parse(res.request().postData() ?? '{}').action === 'diagnostics'
    } catch {
      return false
    }
  })

  await openEditor(page)
  await openFile(page, FILE)
  await expect(page.locator('.monaco-host .view-lines').first()).toContainText('beta')

  // Both reads are quiet envelopes: no server, and no error dressed as one.
  for (const response of [await statusAnswered, await diagnosticsAnswered]) {
    const envelope = await response.json()
    expect(response.ok(), `the query was refused: ${JSON.stringify(envelope)}`).toBe(true)
    expect(envelope.status).toBe('no_server')
    expect(envelope.server).toBeNull()
  }

  // The server field states the fact rather than going blank (§1.3: silence is
  // a sentence, not an absence). Under this flag the hub itself is the reason.
  const server = page.locator('.editor-status-bar [data-field="server"]')
  await expect(server).toBeVisible()
  await expect(server).not.toBeEmpty()
  await expect(server).toContainText(/language-server hub|no active language server/)

  // No verdict and no work in flight: nothing was analysed, so the bar says
  // nothing about problems and `analysing…` has gone. A file with no server is
  // never presented as clean (§4).
  await expect(page.locator('.editor-status-bar [data-field="state"]')).toHaveCount(0)
  await expect(page.locator('.editor-status-bar [data-field="problems"]')).toHaveCount(0)

  // …and nothing else changed: the same buffer, its own text, no marks, no
  // notice (this feature raises none on any path, §4), and the one control
  // inert because there is nothing it could re-check.
  await expect(page.locator('.editor-tab')).toHaveCount(1)
  await expect(page.locator('.editor-tab-label')).toHaveText(FILE)
  await expect(page.locator('.monaco-host .squiggly-error')).toHaveCount(0)
  await expect(page.locator('.editor-notice')).toHaveCount(0)
  await expect(page.locator('.editor-status-bar button')).toBeDisabled()
})

// 4. The context fields at the strip's right edge, from a real Monaco: the
// caret, the indentation the model resolved, the line ending and the file's
// kind. Everything here needs the bundled editor — the facts come from a model
// no jsdom test can create — so this is the one place the whole chain is
// exercised: model -> surface report -> composable -> strip.
test('the bar shows the buffer\'s own facts, and moves them with the caret', async ({
  page,
}) => {
  await openEditor(page)
  await openFile(page, FILE)

  const facts = page.locator('.editor-status-bar-facts')
  await expect(facts).toBeVisible()

  // The caret starts at the first character; clicking the third line moves it,
  // and the label follows without a reload.
  await expect(facts.locator('[data-field="cursor"]')).toHaveText('Ln 1, Col 1')
  await page.locator('.monaco-host .view-line').nth(2).click()
  await expect(facts.locator('[data-field="cursor"]')).toHaveText(/^Ln 3, Col \d+$/)

  // The four fields, in reading order, as the strip renders them.
  await expect(facts.locator('[data-field]')).toHaveCount(4)
  // `notes.txt` is `plaintext`: the registry's alias for it, not the raw id.
  await expect(facts.locator('[data-field="language"]')).toHaveText('Plain Text')
  // `TEXT` is an LF file with no indentation to guess from, so the model
  // resolved Monaco's default: four spaces.
  await expect(facts.locator('[data-field="eol"]')).toHaveText('LF')
  await expect(facts.locator('[data-field="indentation"]')).toHaveText('Spaces: 4')

  // Right-aligned: the group's right edge meets the strip's, while its left
  // edge sits in the right half of the window — which is what "aligned to the
  // right" means in a laid-out page, and nothing else can answer it.
  const boxes = await page.evaluate(() => {
    const rect = (selector) => document.querySelector(selector).getBoundingClientRect()
    return {
      bar: rect('.editor-status-bar'),
      facts: rect('.editor-status-bar-facts'),
      server: rect('.editor-status-bar [data-field="server"]'),
      viewport: window.innerWidth,
    }
  })
  // The strip's own right padding (0.875rem) sits between the group and the
  // screen edge, so "hugging the right" is measured inside it.
  expect(boxes.facts.right).toBeGreaterThanOrEqual(boxes.bar.right - 16)
  expect(boxes.facts.right).toBeLessThanOrEqual(boxes.bar.right)
  expect(boxes.facts.left).toBeGreaterThan(boxes.viewport / 2)
  // The server field keeps the left of the row: the two groups are apart.
  expect(boxes.server.left).toBeLessThan(boxes.facts.left)

  // Closing the only tab takes the surface away, and the facts with it — never
  // the previous buffer's numbers under an empty pane.
  await page.locator('.editor-tab-close').first().click()
  await expect(page.locator('.editor-status-bar-facts')).toHaveCount(0)
})
