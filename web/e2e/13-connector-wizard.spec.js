import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Task cwizard-09 — the connector wizard ("Set me up!") in a real browser.
//
// What a browser establishes that the jsdom suite cannot, and the only reason
// this file exists:
//
//   * **geometry** (AC-1) — jsdom lays nothing out, so "the two panels keep their
//     width, height and head layout, and the new button is in the same box as the
//     restart beside it" is a fact only a real layout can answer;
//   * **the accessible name** (AC-6) — an inert button whose *name* is the refusal
//     is a browser computation over aria-label, not a string in a state object;
//   * **the clipboard** (AC-10) — copy is the one action in the feature that
//     changes anything, and it changes the system clipboard;
//   * **the composer** (AC-20) — the hand-over's "fills and only fills" is about
//     a real textarea, a real Send control and the real chat route;
//   * **nothing was written** (AC-14's browser half, AC-19's other half) — the
//     fixture workspace's reserved folder, bytes and mtimes, identical before and
//     after a whole walk, including that no declaration appeared where none was.
//
// Hermetic on purpose. The wizard's two posts are **routed** to fixture answers,
// so no spec here sends a completion request anywhere; the three reads are the
// app's own (a committed file, a store read, a scan of a folder this spec owns).
// The suite's own model connection is what the app runs on (`.env.test` +
// `.nojae/nojae-test-settings.json`, via the test switch), and the hubs stay
// switched off by the config's `NOJAE_DISABLE_MCP` / `NOJAE_DISABLE_LSP`, so no
// connector and no language server is started by anything in this file.
//
// The fixture workspace is created and removed with node's `fs`, in the folder
// name the suite's `.gitignore` already reserves for e2e workspaces — the same
// shape as `03-workspace-switch` and `08-editor-lsp`. Where a scenario needs a
// declaration file, **this spec writes it** and removes it with the folder: no
// app path may create one for a scenario, and that is what row 7 then asserts.

// The folder name the suite's `.gitignore` and `global-teardown.js` already
// reserve. `e2e-workspace` is shared the same way `02`, `06`, `07` and `08`
// share it: the suite runs one worker and each file creates and removes it, so
// no two specs hold it at once.
const SCRATCH = 'e2e-workspace'
const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
// The folder as **the server canonicalises it** (win-01): the app bar's field
// holds the host's own separators, so forcing `/` here is a second spelling of
// one folder that never matches what the tab displays on Windows.
const WORKSPACE = path.join(REPO_ROOT, SCRATCH)
const RESERVED = path.join(WORKSPACE, '.nojae')

const SETUP = '.chat-hub-setup'
const RESTART = '.chat-hub-restart'
const HEAD = '.chat-hub-head'
const MCP_PANEL = '.chat-mcp-panel'
const LSP_PANEL = '.chat-lsp-panel'
const DOCK = '.chat-tools-dock'
const DIALOG = '.wizard-dialog'
const TEXTAREA = '.chat-textarea'
const SEND = '.chat-send:not(.chat-stop)'

// The three strings this lot declares by contract, so they are matched exactly
// and not by a fragment: the button's name, the header line's lead, and the one
// canonical sentinel.
const SET_ME_UP = 'Set me up!'
const HEADER_LEAD = 'Wizard is running with'
const SENTINEL = '__put_your_api_key_here__'

// The fixture answers. Both are the shape the routes answer (task 05's page), so
// the dialog is driven by a payload a real prepare could have produced — and the
// member is one the loader accepts, which is why `accepted`/`offered` are true.
const MEMBER = {
  type: 'local',
  enable: true,
  command: ['uvx', 'mcp-server-fetch'],
}

const PREPARED = {
  family: 'mcp',
  outcome: 'ok',
  sentence: null,
  notes: [],
  declarationPath: path.join(RESERVED, 'mcp-settings.json'),
  declarationExists: false,
  id: 'fetch',
  member: MEMBER,
  snippet: '"fetch": {\n  "type": "local",\n  "enable": true,\n  "command": [\n    "uvx",\n    "mcp-server-fetch"\n  ]\n}',
  accepted: true,
  verdict: 'The declaration loader accepts this member.',
  verdictNotes: [],
  readiness: 'not installed',
  program: null,
  searched: '/usr/local/bin',
  install: { any: 'pip install mcp-server-fetch' },
  requiresInstall: true,
  decisions: ['The workspace root is the folder itself.'],
  duplicate: null,
  valueForm: 'none',
  valueWarning: null,
  valueFindings: [],
  offered: true,
}

const PROPOSAL = {
  id: 'css-language-server',
  command: ['vscode-css-language-server', '--stdio'],
  extensions: ['.css'],
  workspaceRoot: '${NOJAE_PATH_LOCATION}',
  evidence: 'CSS here (2 .css files: site.css, theme.css), and no CSS language server declared',
}

// ---------------------------------------------------------------------------
// The fixture workspace
// ---------------------------------------------------------------------------

// Two CSS files, so the LSP page's evidence line can be compared against names
// the folder really holds (AC-4's rendered half), and a manifest, so the scan has
// something to report. Written by this spec with `fs` — never by an app route.
function createFixtureWorkspace() {
  fs.rmSync(WORKSPACE, { recursive: true, force: true })
  fs.mkdirSync(WORKSPACE, { recursive: true })
  fs.writeFileSync(path.join(WORKSPACE, 'site.css'), 'body { color: red }\n')
  fs.writeFileSync(path.join(WORKSPACE, 'theme.css'), ':root { --x: 1px }\n')
  fs.writeFileSync(
    path.join(WORKSPACE, 'package.json'),
    JSON.stringify({ name: 'wizard-fixture', dependencies: { vue: '^3.5.0' } }, null, 2),
  )
}

// Every file under the reserved folder: name, bytes and mtime. The witness for
// AC-14's browser half and AC-19's other half — a route that wrote, seeded,
// backed up or created anything in here changes it.
function reservedSnapshot() {
  if (!fs.existsSync(RESERVED)) return { missing: true, files: [] }
  const files = []
  for (const entry of fs.readdirSync(RESERVED, { recursive: true })) {
    const name = String(entry)
    const target = path.join(RESERVED, name)
    const stat = fs.statSync(target)
    if (!stat.isFile()) continue
    files.push({ name, mtime: stat.mtimeNs.toString(), bytes: fs.readFileSync(target).toString('base64') })
  }
  return { missing: false, files: files.sort((a, b) => a.name.localeCompare(b.name)) }
}

// ---------------------------------------------------------------------------
// Routing the wizard's two posts
// ---------------------------------------------------------------------------

// The wizard's propose/prepare posts are answered here and never forwarded: no
// spec in this file sends a completion request anywhere. Everything else — the
// catalogue read, the connection read, the scan, the agents list, the config —
// is the app's own answer, so the header line's three names are real.
async function routeWizardSteps(page, { propose, prepare } = {}) {
  const posts = []
  await page.route(
    (url) => url.pathname === '/api/wizard/propose' || url.pathname === '/api/wizard/prepare',
    (route) => {
      const pathname = new URL(route.request().url()).pathname
      posts.push({ pathname, body: route.request().postDataJSON() })
      const body = pathname.endsWith('/propose') ? propose : prepare
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(body ?? {}),
      })
    },
  )
  return posts
}

const proposeOk = {
  outcome: 'ok',
  sentence: null,
  proposals: [PROPOSAL],
  notes: [],
  declarationPath: path.join(RESERVED, 'lsp-settings.json'),
}

// ---------------------------------------------------------------------------
// Getting to the surface
// ---------------------------------------------------------------------------

async function openWorkBench(page) {
  await page.goto('/')
  await page.getByRole('tab', { name: 'WorkBench' }).click()
  await expect(page.locator(TEXTAREA)).toBeVisible()
  await expect(page.locator(MCP_PANEL)).toBeVisible()
  await expect(page.locator(LSP_PANEL)).toBeVisible()
}

// Point this tab at the fixture, as a user does through the app bar's field, so
// the workspace-scoped scan and posts answer about the folder this spec owns.
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

// The agent the composer is showing, read from the app's own list — never a
// hard-coded id, because the store's rows are the suite's shared fixture.
async function currentAgent(page) {
  const payload = await (await page.request.get('/api/agents')).json()
  return payload.agents.find((agent) => agent.modelId != null) ?? payload.agents[0]
}

// The header line's three names, as the **server** resolved them for this agent.
// The dialog prints exactly these, so the assertion compares two answers rather
// than restating a name this spec invented.
async function connectionNames(page, agent) {
  const res = await page.request.get('/api/wizard/connection', { params: { agentMode: agent.id } })
  expect(res.ok(), await res.text()).toBe(true)
  return res.json()
}

async function openWizard(page, panel) {
  const button = page.locator(`${panel} ${SETUP}`)
  await expect(button).toBeEnabled()
  await button.click()
  await expect(page.locator(DIALOG)).toBeVisible()
}

async function closeWizard(page) {
  await page.locator(`${DIALOG} .wizard-close`).click()
  await expect(page.locator(DIALOG)).toBeHidden()
}

// ---------------------------------------------------------------------------
// 1. Geometry (AC-1)
// ---------------------------------------------------------------------------

test.describe('the two entry points, in the layout they were promised', () => {
  test.beforeEach(async () => {
    createFixtureWorkspace()
  })

  test.afterEach(async ({ page }) => {
    await page.close()
    fs.rmSync(WORKSPACE, { recursive: true, force: true })
  })

  // The panels' boxes are driven by `--bi-chat-panel-width` and the dock's own
  // rule, and the head row's height by the two 1.5rem icon buttons. Adding a
  // second head control was only allowed on the promise that none of that moves,
  // so the numbers are read off the rendered page and compared against the
  // restart's own box — the button that was already there.
  for (const panel of [
    { label: 'MCP', selector: MCP_PANEL },
    { label: 'LSP', selector: LSP_PANEL },
  ]) {
    test(`${panel.label}: one Set me up! at the left of the restart, in the same box`, async ({
      page,
    }) => {
      await openWorkBench(page)

      const head = page.locator(`${panel.selector} ${HEAD}`)
      const buttons = head.locator('button')
      await expect(buttons).toHaveCount(2)

      const setup = buttons.nth(0)
      const restart = buttons.nth(1)
      await expect(setup).toHaveClass(/chat-hub-setup/)
      await expect(restart).toHaveClass(/chat-hub-restart/)

      // Left of the restart, on the same line: x strictly smaller, and the same
      // vertical centre (rounded, since the boxes are fractional).
      const setupBox = await setup.boundingBox()
      const restartBox = await restart.boundingBox()
      const headBox = await head.boundingBox()
      expect(setupBox && restartBox && headBox).toBeTruthy()
      expect(setupBox.x).toBeLessThan(restartBox.x)
      expect(Math.round(setupBox.y + setupBox.height / 2)).toBe(
        Math.round(restartBox.y + restartBox.height / 2),
      )
      // The same box as the restart beside it — the promise §2 makes ("the same
      // 1.5rem box as the restart glyph"), asserted against the restart's own
      // rendered box rather than a pixel this spec guessed, so it follows the
      // stylesheet whatever box-sizing resolves it to.
      expect(Math.round(setupBox.width)).toBe(Math.round(restartBox.width))
      expect(Math.round(setupBox.height)).toBe(Math.round(restartBox.height))
      const boxes = await page.evaluate(() => {
        const one = (el) => {
          const s = getComputedStyle(el)
          return `${s.width}x${s.height}`
        }
        const panel = document.querySelector('.chat-mcp-panel')
        return {
          setup: one(panel.querySelector('.chat-hub-setup')),
          restart: one(panel.querySelector('.chat-hub-restart')),
        }
      })
      expect(boxes.setup).toBe(boxes.restart)
      // And the row grew by nothing. The honest form of "the head layout is
      // unchanged" is not "the row is as tall as a button" — the row's height
      // comes from its caption, and always did — it is that the head is still
      // **one line**: one caption and two buttons, all vertically centred on the
      // same band, inside a row no taller than its tallest child plus its own
      // padding. A second row, or a taller control, breaks one of these.
      await expect(head.locator('.chat-mcp-title')).toHaveCount(1)
      await expect(head.locator('p')).toHaveCount(1)
      const titleBox = await head.locator('.chat-mcp-title').boundingBox()
      // The row is one line, not two: it is no taller than its tallest child
      // plus the caption's own block margin, and it is far shorter than the two
      // of them stacked. (The caption's centre sits a few pixels off the
      // buttons' because Pico gives a `<p>` a margin — that is the caption's,
      // and predates this feature, so it is not what this row guards.)
      expect(headBox.height).toBeGreaterThanOrEqual(
        Math.max(titleBox.height, restartBox.height),
      )
      expect(headBox.height).toBeLessThan(titleBox.height + restartBox.height)
      // Both buttons sit inside the row's own band.
      expect(setupBox.y).toBeGreaterThanOrEqual(headBox.y - 1)
      expect(setupBox.y + setupBox.height).toBeLessThanOrEqual(
        headBox.y + headBox.height + 1,
      )

      // The tooltip and the accessible name are the one string (§2).
      await expect(setup).toHaveAttribute('title', SET_ME_UP)
      await expect(
        page.getByRole('button', { name: SET_ME_UP, exact: true }),
      ).toHaveCount(2)
      // The glyph is decoration: it carries no name of its own.
      expect(await setup.locator('svg').getAttribute('aria-hidden')).toBe('true')
    })
  }

  // The panels and the dock keep the dimensions they had before the feature:
  // both panels are the same width as each other (the dock's rule), and the dock
  // is the sum of the two plus its gap — a third head control cannot have
  // stretched any of them.
  test('both panels and the dock keep their rendered dimensions', async ({ page }) => {
    await openWorkBench(page)

    const mcp = await page.locator(MCP_PANEL).boundingBox()
    const lsp = await page.locator(LSP_PANEL).boundingBox()
    const dock = await page.locator(DOCK).boundingBox()
    expect(mcp && lsp && dock).toBeTruthy()

    // Two equal panels side by side inside the dock: the dock's body is the two
    // of them and its gap, which is the rule the stylesheet states with
    // `--bi-chat-tools-col-width`. A second head control cannot have stretched
    // any of the three, because none of the three is sized by its contents.
    expect(Math.abs(mcp.width - lsp.width)).toBeLessThanOrEqual(1)
    expect(Math.abs(mcp.height - lsp.height)).toBeLessThanOrEqual(1)
    expect(mcp.x).toBeGreaterThanOrEqual(dock.x)
    expect(lsp.x + lsp.width).toBeLessThanOrEqual(dock.x + dock.width + 1)

    // The head rows are one line tall in both panels, and the two panels' rows
    // are the same height as each other.
    const mcpHead = await page.locator(`${MCP_PANEL} ${HEAD}`).boundingBox()
    const lspHead = await page.locator(`${LSP_PANEL} ${HEAD}`).boundingBox()
    expect(Math.round(mcpHead.height)).toBe(Math.round(lspHead.height))
  })

  // AC-2: each empty state invites the click instead of only naming the file.
  // The panels are empty when the hub route answers no entries — a workspace
  // with nothing declared — so that is the state routed here. (The buttons stay
  // live in it: §10's table has no row that gates preparation on an empty hub.)
  test('each empty state names its file and invites the click', async ({ page }) => {
    await page.route(
      (url) => url.pathname === '/api/mcp' || url.pathname === '/api/lsp',
      (route) =>
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            connectors: [],
            servers: [],
            enabled: {},
            loaded: true,
            locked: false,
            error: null,
          }),
        }),
    )
    await openWorkBench(page)

    for (const panel of [
      { selector: MCP_PANEL, file: 'mcp-settings.json' },
      { selector: LSP_PANEL, file: 'lsp-settings.json' },
    ]) {
      const line = page.locator(`${panel.selector} .chat-hub-empty`)
      await expect(line).toBeVisible()
      const text = (await line.textContent()).replace(/\s+/g, ' ')
      expect(text, panel.file).toContain(panel.file)
      expect(text, panel.file).toContain(SET_ME_UP)
    }
  })
})

// ---------------------------------------------------------------------------
// 2. Entry, family, and the three pages end to end
// ---------------------------------------------------------------------------

test.describe('one dialog, two families, three pages', () => {
  test.beforeEach(async () => {
    createFixtureWorkspace()
  })

  test.afterEach(async ({ page }) => {
    await page.close()
    fs.rmSync(WORKSPACE, { recursive: true, force: true })
  })

  // AC-3: MCP opens on the committed catalogue with **no model run**; LSP opens
  // on the servers proposed for this folder. The family is never asked.
  test('MCP opens on the catalogue and runs no model; LSP opens on a proposal', async ({
    page,
  }) => {
    const posts = await routeWizardSteps(page, { propose: proposeOk, prepare: PREPARED })
    await openWorkBench(page)
    await pointTabAt(page)

    await openWizard(page, MCP_PANEL)
    await expect(page.locator(`${DIALOG} .wizard-candidate`)).toHaveCount(9)
    // The committed catalogue's names, and no post was issued for them.
    await expect(page.locator(`${DIALOG} .wizard-candidate-name`).first()).toHaveText('Playwright')
    expect(posts.filter((post) => post.pathname.endsWith('/propose'))).toEqual([])
    expect(posts.filter((post) => post.pathname.endsWith('/prepare'))).toEqual([])
    // The family is never a question: no control in the card names one.
    const card = page.locator(DIALOG)
    expect(await card.locator('select').count()).toBe(0)
    expect((await card.textContent()).toLowerCase()).not.toContain('choose a family')
    await closeWizard(page)

    await openWizard(page, LSP_PANEL)
    await expect(page.locator(`${DIALOG} .wizard-candidate`)).toHaveCount(1)
    expect(posts.filter((post) => post.pathname.endsWith('/propose'))).toHaveLength(1)
    await closeWizard(page)
  })

  // AC-4/5's rendered half: the evidence line names the files the fixture folder
  // really holds. (The ranking itself is the model step's, and belongs to
  // tests/test_wizard_model_step.py — a browser cannot rank a model's answer.)
  test('the LSP list shows the proposal with the evidence line naming this folder', async ({
    page,
  }) => {
    await routeWizardSteps(page, { propose: proposeOk, prepare: PREPARED })
    await openWorkBench(page)
    await pointTabAt(page)

    await openWizard(page, LSP_PANEL)
    const row = page.locator(`${DIALOG} .wizard-candidate`).first()
    await expect(row.locator('.wizard-candidate-name')).toHaveText('css-language-server')
    const evidence = (await row.locator('.wizard-candidate-line').textContent()).replace(/\s+/g, ' ')
    expect(evidence).toContain('.css')
    // The names it quotes are files the folder holds — read from disk, not from
    // the fixture this spec wrote.
    for (const name of ['site.css', 'theme.css']) {
      expect(fs.existsSync(path.join(WORKSPACE, name)), name).toBe(true)
      expect(evidence).toContain(name)
    }
    await closeWizard(page)
  })

  // AC-8, AC-10, AC-12, AC-19: choose → prepare → apply, with the posts routed.
  test('the whole walk, page by page', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const posts = await routeWizardSteps(page, { propose: proposeOk, prepare: PREPARED })
    await openWorkBench(page)
    await pointTabAt(page)

    await openWizard(page, MCP_PANEL)
    await page.locator(`${DIALOG} .wizard-candidate`).first().click()
    await expect(page.locator(`${DIALOG} .wizard-continue`)).toBeEnabled()
    await page.locator(`${DIALOG} .wizard-continue`).click()

    // Page 2 — the complete member, the readiness pair and the install line.
    await expect(page.locator(`${DIALOG} .wizard-member`)).toBeVisible()
    const memberText = await page.locator(`${DIALOG} .wizard-member`).textContent()
    expect(memberText).toContain('mcp-server-fetch')
    await expect(page.locator(`${DIALOG} .wizard-readiness`)).toHaveText('not installed')
    await expect(page.locator(`${DIALOG} .wizard-install-line`)).toHaveText(
      'pip install mcp-server-fetch',
    )
    // The not-installed candidate is present and flagged, never dropped (§7).
    await expect(page.locator(`${DIALOG} .wizard-continue`)).toBeEnabled()
    await page.locator(`${DIALOG} .wizard-continue`).click()

    // Page 3 — the member verbatim, the copy action, the path, the restart line.
    const snippetText = await page.locator(`${DIALOG} .wizard-snippet`).textContent()
    expect(snippetText).toBe(PREPARED.snippet)
    // A member, never a whole file: it is one key, and it parses inside an object.
    expect(snippetText.trim().startsWith('"fetch": {')).toBe(true)
    expect(() => JSON.parse(`{${snippetText}}`)).not.toThrow()

    // AC-12: the absolute path of the file it belongs in, and the restart.
    await expect(page.locator(`${DIALOG} .wizard-path code`)).toHaveText(
      path.join(RESERVED, 'mcp-settings.json'),
    )
    const restart = await page.locator(`${DIALOG} .wizard-restart`).textContent()
    expect(restart).toContain('restart')
    // AC-19's other half: the file does not exist, so the page says to create it.
    expect(fs.existsSync(path.join(RESERVED, 'mcp-settings.json'))).toBe(false)
    await expect(page.locator(`${DIALOG} .wizard-missing`)).toBeVisible()
    // The wizard has no restart button of its own.
    await expect(page.locator(`${DIALOG} .wizard-restart-btn`)).toHaveCount(0)

    // AC-10: one click copies, and the copy says so.
    await page.locator(`${DIALOG} .wizard-copy`).click()
    await expect(page.locator(`${DIALOG} .wizard-copy`)).toHaveText('Copied')
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe(PREPARED.snippet)

    // Page 3 issued no request: everything it printed came with the prepare.
    expect(posts.filter((post) => post.pathname.endsWith('/prepare'))).toHaveLength(1)
    await closeWizard(page)
  })

  // AC-17: the header line is on screen the moment the dialog opens, on every
  // page, and no token or cost figure ever appears in the card.
  test('every page names agent, server and model, and shows no figure', async ({ page }) => {
    const agent = await (async () => {
      await openWorkBench(page)
      return currentAgent(page)
    })()
    const names = await connectionNames(page, agent)
    expect(names.canRun, 'the suite agent can run').toBe(true)
    expect(names.model, 'the suite model is named').toBeTruthy()

    await routeWizardSteps(page, { propose: proposeOk, prepare: PREPARED })
    await openWizard(page, MCP_PANEL)

    const header = page.locator(`${DIALOG} .wizard-header`)
    await expect(header).toBeVisible()
    const line = (await header.textContent()).replace(/\s+/g, ' ')
    expect(line).toContain(HEADER_LEAD)
    expect(line).toContain(names.agent)
    expect(line).toContain(names.server)
    expect(line).toContain(names.model)

    // Page 1, then 2, then 3: the same line, and no figure anywhere in the card.
    for (const step of ['page1', 'page2', 'page3']) {
      const text = (await page.locator(DIALOG).textContent()).replace(/\s+/g, ' ')
      expect(text, step).toContain(HEADER_LEAD)
      expect(text, step).toContain(names.model)
      // No token/cost figure: the words the app would use, and no number beside
      // them. (The catalogue's own names may hold a digit — `context7` — so the
      // claim is about the meters' vocabulary, not about digits in prose.)
      for (const marker of [' t/s', ' tokens', 'token/s', ' ctx', '$', 'cost']) {
        expect(text, `${step}: ${marker}`).not.toContain(marker)
      }
      if (step === 'page1') {
        await page.locator(`${DIALOG} .wizard-candidate`).first().click()
        await page.locator(`${DIALOG} .wizard-continue`).click()
      } else if (step === 'page2') {
        await page.locator(`${DIALOG} .wizard-continue`).click()
      }
    }
    await closeWizard(page)
  })

  // AC-7: an unreachable model is a named sentence on the page, and an empty
  // candidate answer is a different one — two renderings, never one.
  test('a refused model and an empty answer are two different sentences', async ({ page }) => {
    await openWorkBench(page)
    await pointTabAt(page)

    await routeWizardSteps(page, {
      propose: { outcome: 'failed', sentence: 'Could not reach the model endpoint: refused', proposals: [] },
    })
    await openWizard(page, LSP_PANEL)
    const failure = page.locator(`${DIALOG} .wizard-message`)
    await expect(failure).toContainText('Could not reach the model endpoint')
    // A way to press again, and the stop's sentence is nowhere on the page.
    await expect(page.locator(`${DIALOG} .wizard-retry`)).toBeVisible()
    expect(await page.locator(DIALOG).textContent()).not.toContain('Nothing offered fits')
    await closeWizard(page)

    await routeWizardSteps(page, {
      propose: {
        outcome: 'empty',
        sentence: 'No language server found for this folder.',
        proposals: [],
        // The route always answers the path (task 05), so the fixture does too:
        // the stop sentence is required to name the file it would have belonged in.
        declarationPath: path.join(RESERVED, 'lsp-settings.json'),
      },
    })
    await openWizard(page, LSP_PANEL)
    // AC-18: the stop names the declaration file and ends the road — no way on.
    const stop = page.locator(`${DIALOG} .wizard-message`)
    await expect(stop).toContainText('Nothing offered fits')
    await expect(stop).toContainText('lsp-settings.json')
    await expect(page.locator(`${DIALOG} .wizard-continue`)).toHaveCount(0)
    await expect(page.locator(`${DIALOG} .wizard-retry`)).toHaveCount(0)
    // And no free-text field: the wizard never becomes the editor it replaces.
    await expect(page.locator(`${DIALOG} input[type="text"]`)).toHaveCount(0)
    await expect(page.locator(`${DIALOG} textarea`)).toHaveCount(0)
    await closeWizard(page)
  })

  // AC-8a's rendered half: a key-bearing entry's snippet carries the one
  // canonical sentinel in the value slot, and page 3 says it will not
  // authenticate until it is replaced. The payload is the route's own shape for
  // the catalogue's context7 entry, which task 04 builds from the member group.
  test('a key-bearing entry shows the sentinel and the warning beside it', async ({ page }) => {
    const keyPrepared = {
      ...PREPARED,
      id: 'context7',
      member: {
        type: 'remote',
        enable: true,
        url: 'https://mcp.context7.com/mcp',
        headers: { CONTEXT7_API_KEY: SENTINEL },
      },
      snippet:
        '"context7": {\n  "type": "remote",\n  "enable": true,\n  ' +
        '"url": "https://mcp.context7.com/mcp",\n  "headers": {\n    ' +
        `"CONTEXT7_API_KEY": "${SENTINEL}"\n  }\n}`,
      valueForm: 'sentinel',
      valueWarning:
        `This entry carries ${SENTINEL} in the value slot: it will not ` +
        'authenticate until that slot is replaced with your key.',
    }
    await routeWizardSteps(page, { propose: proposeOk, prepare: keyPrepared })
    await openWorkBench(page)
    await pointTabAt(page)

    await openWizard(page, MCP_PANEL)
    // The catalogue's own key-bearing entry, chosen by its listed name.
    await page
      .locator(`${DIALOG} .wizard-candidate`)
      .filter({ hasText: 'Context7' })
      .click()
    await page.locator(`${DIALOG} .wizard-continue`).click()
    await page.locator(`${DIALOG} .wizard-continue`).click()

    // The sentinel is in the text the user copies, in its one canonical spelling.
    const snippetText = await page.locator(`${DIALOG} .wizard-snippet`).textContent()
    expect(snippetText).toContain(SENTINEL)
    // And the page says what the slot means, in the snippet module's words.
    await expect(page.locator(`${DIALOG} .wizard-warning`)).toContainText(
      'will not authenticate until',
    )
    await closeWizard(page)
  })

  // AC-14's browser half and AC-19's other half, over a whole walk: the reserved
  // folder is byte- and mtime-identical afterwards, and nothing appeared in it.
  test('a whole walk leaves the reserved folder exactly as it found it', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await routeWizardSteps(page, { propose: proposeOk, prepare: PREPARED })
    await openWorkBench(page)
    await pointTabAt(page)

    // The wizard's routes never admit a hub set (§10: discovery acquires none),
    // so this folder may have no reserved folder at all — which is the strongest
    // form of the row: a walk that ends with a declaration file appearing where
    // there was no folder is exactly the write the feature promises never to do.
    const before = reservedSnapshot()

    for (const panel of [MCP_PANEL, LSP_PANEL]) {
      await openWizard(page, panel)
      await page.locator(`${DIALOG} .wizard-candidate`).first().click()
      await page.locator(`${DIALOG} .wizard-continue`).click()
      await page.locator(`${DIALOG} .wizard-continue`).click()
      await page.locator(`${DIALOG} .wizard-copy`).click()
      await closeWizard(page)
    }

    // Bytes and mtimes identical — or, as here, still absent.
    expect(reservedSnapshot()).toEqual(before)
    expect(fs.existsSync(RESERVED), 'no request created the reserved folder').toBe(
      before.missing === false,
    )
    // And neither family's declaration file exists.
    for (const name of ['mcp-settings.json', 'lsp-settings.json']) {
      expect(
        fs.existsSync(path.join(RESERVED, name)),
        `${name} was created by a wizard request`,
      ).toBe(false)
    }
  })

  // AC-20: the hand-over fills the composer and nothing else.
  test('the install hand-over fills the composer, sends nothing and arms nothing', async ({
    page,
  }) => {
    const chatRequests = []
    page.on('request', (request) => {
      const pathname = new URL(request.url()).pathname
      if (pathname === '/api/chat' || pathname === '/api/chat/pause') {
        chatRequests.push(pathname)
      }
    })
    await routeWizardSteps(page, { propose: proposeOk, prepare: PREPARED })
    await openWorkBench(page)
    await pointTabAt(page)

    await openWizard(page, MCP_PANEL)
    await page.locator(`${DIALOG} .wizard-candidate`).first().click()
    await page.locator(`${DIALOG} .wizard-continue`).click()

    const handOver = page.locator(`${DIALOG} .wizard-hand-over`)
    await expect(handOver).toBeVisible()
    await handOver.click()

    // The draft holds the install line, verbatim.
    await expect(page.locator(TEXTAREA)).toHaveValue('pip install mcp-server-fetch')
    // Nothing was sent, nothing was staged, and focus is not on a send control.
    expect(chatRequests).toEqual([])
    await expect(page.locator('.chat-staged-row')).toHaveCount(0)
    const focused = await page.evaluate(() => document.activeElement?.className ?? '')
    expect(String(focused)).not.toContain('chat-send')
    await expect(page.locator(SEND)).toBeEnabled()
    await closeWizard(page)
  })
})

// ---------------------------------------------------------------------------
// 3. The gate (AC-6)
// ---------------------------------------------------------------------------

test.describe('the only gate is the model', () => {
  test.beforeEach(async () => {
    createFixtureWorkspace()
  })

  test.afterEach(async ({ page }) => {
    await page.close()
    fs.rmSync(WORKSPACE, { recursive: true, force: true })
  })

  // An agent with no model: both buttons inert, and each inert button's
  // accessible name is the refusal — matched by a fragment of its **reason**, so
  // it is never matched by its live name (the way 04-agent-modes queries a slot).
  test('with no resolvable model both buttons are inert and say why', async ({ page }) => {
    // Every agent loses its model, so no button can resolve one.
    await page.route(
      (url) => url.pathname === '/api/agents',
      async (route) => {
        const body = await (await route.fetch()).json()
        body.agents = (body.agents ?? []).map((agent) => ({
          ...agent,
          modelId: null,
          modelName: null,
        }))
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(body),
        })
      },
    )
    await openWorkBench(page)

    // The composer's **existing** no-model warning is on screen in this state, so
    // it is the witness for "the app's existing words": the wizard's inert reason
    // is compared against the refusal the app already had, never against a copy of
    // a sentence this spec wrote.
    const warning = page.locator('.chat-mode-warning')
    await expect(warning).toBeVisible()
    const existing = await warning.getAttribute('aria-label')
    expect(existing).toContain('no model')

    for (const panel of [MCP_PANEL, LSP_PANEL]) {
      const button = page.locator(`${panel} ${SETUP}`)
      await expect(button).toBeDisabled()
      // The reason, not the live name — and the same string is the tooltip.
      const name = await button.getAttribute('aria-label')
      expect(name).not.toBe(SET_ME_UP)
      expect(name).toContain('no model')
      expect(name).toContain('assign a model')
      await expect(button).toHaveAttribute('title', name)
      // The two surfaces speak the app's one refusal, not two wordings of it:
      // the composer's icon and this button share the phrase, and the wizard's
      // only addition is the agent's own name, which the row is about.
      expect(existing).toContain('has no model to run with')
      expect(name).toContain('has no model to run with')
    }
    // And the live name matches nothing inert: the two states are distinguishable.
    await expect(page.getByRole('button', { name: SET_ME_UP, exact: true })).toHaveCount(0)
  })
})
