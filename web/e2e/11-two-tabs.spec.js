import { expect, test } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// The two-tab run (clws-12): the acceptance items that need a browser and two
// independent tabs on one address.
//
// **What this spec proves, and what it leaves to the human checklist.**
//
// Automated here:
//   * two tabs on the same URL, each on its own folder, each listing its own
//     files, and the address bar identical in both;
//   * each tab answers as its own agent, and moving one moves nothing in the
//     other;
//   * a reload returns each tab to its own folder and its own agent;
//   * a new tab lands on the installation folder — not on A's or B's — and sees
//     the installation's files;
//   * a third tab pointed at A sees A's files, with its own agent;
//   * closing a tab mid-reply stops that tab's turn and the other tab's reply
//     completes;
//   * the catalogue was configured once: both tabs read the same agent list.
//
// **Human-only, carried into task 13's smoke checklist** — both need a real
// model whose answers can be read and compared, which is exactly what a
// real-server spec may not assert on (the suite's endpoint samples):
//   1. Two replies stream at once, each on its own tab's agent and therefore its
//      own model/endpoint, and each tool answer names the folder of the tab that
//      asked. The proof is the tool payloads, not the prose, and a real model is
//      required to produce them.
//   2. Pause in tab A stops A's reply only, leaving B's stream running. Timing a
//      pause against a live stream without asserting on the model's wording is
//      the human half.
//
// The folders are this spec's own, created and removed with node's `fs`. Each
// tab is pointed at one through the app bar's field — a browser gesture — and
// every API request names its folder; the address bar never carries one (spec
// D9). No cross-tab invalidation is assumed: a file created in one folder is
// invisible to a tab that has not refreshed (spec D7), which is why the tree
// assertions read the folder each tab was pointed at and nothing else.
const REPO_ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))))
const ROOT_A = path.join(REPO_ROOT, 'e2e-two-tabs-a').replaceAll(path.sep, '/')
const ROOT_B = path.join(REPO_ROOT, 'e2e-two-tabs-b').replaceAll(path.sep, '/')
const FILE_A = 'alpha.txt'
const FILE_B = 'beta.txt'

function resetFolders() {
  for (const root of [ROOT_A, ROOT_B]) {
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(root, { recursive: true })
  }
  fs.writeFileSync(path.join(ROOT_A, FILE_A), 'the file only A holds\n', 'utf8')
  fs.writeFileSync(path.join(ROOT_B, FILE_B), 'the file only B holds\n', 'utf8')
}

function removeFolders() {
  for (const root of [ROOT_A, ROOT_B]) {
    fs.rmSync(root, { recursive: true, force: true })
  }
}

// The installation folder a new tab lands on: `GET /api/workspace` with no field
// is the boot read, and its `default` is the installation (spec D4).
async function installationRoot(request) {
  const res = await request.get('/api/workspace')
  expect(res.ok(), `GET /api/workspace failed: ${await res.text()}`).toBe(true)
  return (await res.json()).default
}

// Point one tab at one folder, through the app bar exactly as a user does. The
// wait is for the server's answer, not for the field that `fill` already moved.
async function pointTabAt(page, root) {
  const field = page.locator('.appbar-location-input')
  if ((await field.inputValue()) === root) return
  await field.fill(root)
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
  expect(res.ok(), `could not point the tab at ${root}: ${await res.text()}`).toBe(true)
  await expect(field).toHaveValue(root)
}

async function openEditor(page) {
  await page.getByRole('tab', { name: 'Editor' }).click()
  await expect(page.locator('.editor-nav-tree')).toBeVisible()
}

async function openWorkBench(page) {
  await page.getByRole('tab', { name: 'WorkBench' }).click()
  await expect(page.getByLabel('Agent mode')).toBeVisible()
}

// The selected agent's id, read from the composer's own control. It is the
// tab's state the composables own, not rendered prose.
async function selectedAgent(page) {
  return page.getByLabel('Agent mode').inputValue()
}

async function readAgents(request) {
  const res = await request.get('/api/agents')
  expect(res.ok(), `GET /api/agents failed: ${await res.text()}`).toBe(true)
  return res.json()
}

test.beforeEach(() => {
  resetFolders()
})

test.afterEach(() => {
  removeFolders()
})

test('two tabs on one address work on two folders, each with its own agent', async ({
  context,
  request,
}) => {
  const install = await installationRoot(request)
  const agents = await readAgents(context.request)
  expect(agents.agents.length, 'the suite offers at least two agents').toBeGreaterThanOrEqual(
    2,
  )
  const agentA = agents.agents[1]
  const agentB = agents.agents[0]
  // A's agent runs on the suite's configured model: the catalogue every tab
  // reads holds one model, and the agent's row points at it.
  const config = await (await context.request.get('/api/config')).json()
  expect(config.models.map((model) => model.id)).toContain(agentA.modelId)

  const pageA = await context.newPage()
  const pageB = await context.newPage()
  await pageA.goto('/')
  await pageB.goto('/')

  // The entry point: a fresh tab is on the installation folder, not on another
  // tab's. Both are on the same address, and neither URL carries a folder.
  const fieldA = pageA.locator('.appbar-location-input')
  const fieldB = pageB.locator('.appbar-location-input')
  await expect(fieldA).toHaveValue(install)
  await expect(fieldB).toHaveValue(install)
  expect(pageA.url()).toBe(pageB.url())

  await pointTabAt(pageA, ROOT_A)
  await pointTabAt(pageB, ROOT_B)

  // A's tree is A's and B's is B's: each folder lists the file this spec put in
  // it, and neither lists the other's.
  await openEditor(pageA)
  await openEditor(pageB)
  await expect(pageA.locator(`.tree-row[data-path="${FILE_A}"]`)).toBeVisible()
  await expect(pageA.locator(`.tree-row[data-path="${FILE_B}"]`)).toHaveCount(0)
  await expect(pageB.locator(`.tree-row[data-path="${FILE_B}"]`)).toBeVisible()
  await expect(pageB.locator(`.tree-row[data-path="${FILE_A}"]`)).toHaveCount(0)

  // The address bar is the same in both, whatever the folders are.
  expect(pageA.url()).toBe(pageB.url())

  // Each tab answers as its own agent; moving one moves nothing in the other.
  await openWorkBench(pageA)
  await openWorkBench(pageB)
  await pageA.getByLabel('Agent mode').selectOption(agentA.id)
  await pageB.getByLabel('Agent mode').selectOption(agentB.id)
  expect(await selectedAgent(pageA)).toBe(agentA.id)
  expect(await selectedAgent(pageB)).toBe(agentB.id)
  // Re-read A after B moved: B's choice reached nothing in A.
  expect(await selectedAgent(pageA)).toBe(agentA.id)

  // A reload is the same tab: it returns to its own folder and its own agent,
  // both from the tab's own storage.
  await pageA.reload()
  await pageB.reload()
  await expect(pageA.locator('.appbar-location-input')).toHaveValue(ROOT_A)
  await expect(pageB.locator('.appbar-location-input')).toHaveValue(ROOT_B)
  await expect(pageA.getByLabel('Agent mode')).toBeVisible()
  await expect(pageB.getByLabel('Agent mode')).toBeVisible()
  expect(await selectedAgent(pageA)).toBe(agentA.id)
  expect(await selectedAgent(pageB)).toBe(agentB.id)

  // The catalogue is the installation's: both tabs read the same list, and move
  // none of it by selecting a different agent.
  expect(await readAgents(pageA.request)).toEqual(await readAgents(pageB.request))
})

test('a new tab lands on the installation folder, and a third tab can join A', async ({
  context,
}) => {
  const pageA = await context.newPage()
  await pageA.goto('/')
  await pointTabAt(pageA, ROOT_A)

  const pageC = await context.newPage()
  await pageC.goto('/')
  // Not A's folder and not B's: the installation, because a new tab inherits
  // nothing and remembers nothing (spec D4, D11).
  const install = pageC.locator('.appbar-location-input')
  await expect(install).not.toHaveValue(ROOT_A)
  const installValue = await install.inputValue()
  expect(installValue).toBeTruthy()
  expect(pageC.url()).toBe(pageA.url())

  // Its tree lists the installation's own files.
  await openEditor(pageC)
  await expect(pageC.locator('.tree-row[data-path="README.md"]')).toBeVisible()

  // Pointed at A, the third tab sees A's answers, with its own agent: it starts
  // on the list's first entry, independent of A's choice.
  await pageC.getByRole('tab', { name: 'WorkBench' }).click()
  const agents = await readAgents(pageC.request)
  const pageAAgent = await (async () => {
    await openWorkBench(pageA)
    await pageA.getByLabel('Agent mode').selectOption(agents.agents[1].id)
    return selectedAgent(pageA)
  })()
  expect(pageAAgent).toBe(agents.agents[1].id)

  await pointTabAt(pageC, ROOT_A)
  await openEditor(pageC)
  await expect(pageC.locator(`.tree-row[data-path="${FILE_A}"]`)).toBeVisible()
  await openWorkBench(pageC)
  expect(await selectedAgent(pageC)).not.toBe(pageAAgent)
  expect(await selectedAgent(pageA)).toBe(pageAAgent)
})

test('closing a tab mid-reply stops its own turn and the other tab completes', async ({
  context,
  request,
}) => {
  const agents = await readAgents(context.request)
  const agent = agents.agents[0]

  const pageA = await context.newPage()
  const pageB = await context.newPage()
  await pageA.goto('/')
  await pageB.goto('/')
  await pointTabAt(pageA, ROOT_A)
  await pointTabAt(pageB, ROOT_B)
  await openWorkBench(pageA)
  await openWorkBench(pageB)
  await pageA.getByLabel('Agent mode').selectOption(agent.id)
  await pageB.getByLabel('Agent mode').selectOption(agent.id)

  // Long enough that a real model is still talking when A closes. The assertion
  // is on the stream's shape (Stop means a turn is in flight, Send means it is
  // over), never on the wording of an answer.
  const prompt = 'Write roughly three hundred words about river deltas.'
  await pageA.locator('.chat-textarea').fill(prompt)
  await pageA.locator('.chat-send:not(.chat-stop)').click()
  await expect(pageA.locator('.chat-stop')).toBeVisible()

  await pageB.locator('.chat-textarea').fill(prompt)
  await pageB.locator('.chat-send:not(.chat-stop)').click()
  await expect(pageB.locator('.chat-stop')).toBeVisible()

  // Closing A ends the tab and its SSE stream; the server's `finally` cancels
  // A's worker (spec D10). B owns a different workspace and is untouched.
  await pageA.close()

  // A has no reply streaming any more. Pause asks the workspace's own slot, so
  // a 409 here is the server saying so while B may still be streaming.
  await expect
    .poll(
      async () => {
        const res = await request.post('/api/chat/pause', {
          params: { workspace: ROOT_A },
        })
        return res.status()
      },
      { message: "A's turn should be over once its tab is closed" },
    )
    .toBe(409)

  // B's reply finishes normally, and it is a whole answer rather than a cut
  // stream.
  await expect(pageB.locator('.chat-send:not(.chat-stop)')).toBeVisible({
    timeout: 90_000,
  })
  const output = pageB.locator('.chat-output')
  await expect(output.locator('.error-line')).toHaveCount(0)
  const cards = output.locator('.chat-answer-card')
  await expect(cards).toHaveCount(1)
  await expect
    .poll(async () => (await cards.first().locator('.answer').innerText()).trim().length)
    .toBeGreaterThan(0)
  await expect(cards.locator('.chat-truncated')).toHaveCount(0)
})
