import { expect, test } from '@playwright/test'

// Task appdb-13 — level: UI state, over the install's agent store.
//
// The composer's dropdown, the hub panels' gray-out and the Agent-modes dialog
// all read **one** payload, `GET /api/agents`, because the agents are rows of
// the installation's `nojae.db` rather than a file in a workspace (D2, D11). So
// this spec reads that route instead of the workspace's old modes file: a spec
// that opens the store's bytes would be a second authority on the store, which
// §4.6 forbids. Nothing here names the app-owned agent either — it is found by
// its `readonly` flag, the only way the client is allowed to recognise it (D4).
//
// What the spec measures:
//
//  1. the dropdown offers exactly the store's rows, the app-owned one included,
//     and an agent with a hub switched off turns that panel inert;
//  2. the pencil opens the store editor, whose tabs are the store's rows in the
//     store's order;
//  3. Create adds a tab and writes nothing until that tab's own Save; Save
//     creates the row, a second Save edits it, and Delete removes it again;
//  4. a `readonly` agent shows its fields disabled with a live model dropdown,
//     and refuses every other write **directly against its route** (AC-4).
//
// The suite's temporary store starts from the built-ins with the fixture's model
// assigned to every agent (D14), so nothing here needs a model of its own and no
// LLM call is made. A created agent is deleted again — the store is shared by
// the whole suite, and the spec must not leave rows behind.

// The label the create/edit test uses. `E2e ` is the prefix the teardown sweeps,
// so a spec that fails between its own write and its own delete still leaves the
// install's agent list as it found it.
const NEW_LABEL = 'E2e Reviewer'
const EDITED_LABEL = 'E2e Reviewer Edited'
const NEW_PERSONA = 'You are an end-to-end reviewer.\nCheck the diff before it lands.'

async function agentsPayload(request) {
  const res = await request.get('/api/agents')
  expect(res.ok(), `GET /api/agents failed: ${await res.text()}`).toBe(true)
  return res.json()
}

async function serversPayload(request) {
  const res = await request.get('/api/servers')
  expect(res.ok(), `GET /api/servers failed: ${await res.text()}`).toBe(true)
  return res.json()
}

// The model every created agent is pointed at: the one the suite's fixture
// materialised into the temporary store. Read, never spelled.
async function firstModel(request) {
  const servers = await serversPayload(request)
  const model = servers.servers.flatMap((server) => server.models)[0]
  expect(model, 'the suite fixture has a model').toBeTruthy()
  return model
}

// The dialog's tabs, scoped to its own nav: the app's tab strip renders buttons
// of its own, and a dialog is not a tab container to the a11y tree.
function modeTabs(page) {
  return page.locator('.agent-modes-nav .agent-modes-tab')
}

// Which section of the card is showing, and what holds the focus. Read through
// `dataset` because an agent id is arbitrary text.
function focusProbe(page) {
  return page.evaluate(() => {
    const el = document.activeElement
    return {
      tag: el?.tagName ?? null,
      tab: el?.closest('section[data-tab]')?.dataset.tab ?? null,
    }
  })
}

// Opening the card is itself the read: the card fetches `GET /api/agents` on
// mount, so the response is the moment its draft is on screen.
async function openModesDialog(page) {
  const read = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/agents',
  )
  await page.locator('.chat-mode-edit').click()
  await read
  await expect(page.locator('.agent-modes-dialog')).toBeVisible()
}

async function closeModesDialog(page) {
  await page
    .locator('.agent-modes-dialog')
    .getByRole('button', { name: 'Cancel' })
    .click()
  await expect(page.locator('.agent-modes-dialog')).toHaveCount(0)
}

// The rows a spec created are swept through the route, so a failure between a
// create and its delete cannot pollute a later spec — or a later run.
test.afterEach(async ({ request }) => {
  const res = await request.get('/api/agents')
  if (!res.ok()) return
  const { agents } = await res.json()
  for (const agent of agents ?? []) {
    if (agent.deletable && String(agent.label ?? '').startsWith('E2e ')) {
      await request.post('/api/agents/delete', { data: { id: agent.id } })
    }
  }
})

test.describe('Agent mode dropdown: the composer, the gate, the hint', () => {
  test('the store is offered, the app-owned agent included, and a mode with MCP off gates the panel', async ({
    page,
  }) => {
    const payload = await agentsPayload(page.request)
    expect(payload.agents.length, 'the seeded store offers agents').toBeGreaterThan(1)
    // The app-owned agent is last and the only `readonly` one (D4) — the flag
    // the client must read instead of naming the id.
    expect(payload.agents.at(-1).readonly, 'the last agent is the app-owned one').toBe(true)
    expect(payload.agents.filter((agent) => agent.readonly)).toHaveLength(1)
    // A mode that switches MCP off, and one that leaves it on: the pair the
    // gate is about. These hold of the seeded store, which is why they are
    // assertions rather than assumptions about someone's rows.
    const gated = payload.agents.find((agent) => agent.mcpEnable === false)
    const open = payload.agents.find((agent) => agent.mcpEnable === true)
    expect(gated, 'a seeded agent switches MCP off').toBeTruthy()
    expect(open, 'a seeded agent leaves MCP on').toBeTruthy()

    // The panel only exists when Settings declares connectors; without them
    // there is nothing to gate, and the spec says so instead of passing empty.
    const mcpRes = await page.request.get('/api/mcp')
    const mcpConnectors = (await mcpRes.json()).connectors.filter((c) => c.active)

    await page.goto('/')
    await page.getByRole('tab', { name: 'WorkBench' }).click()

    const select = page.getByLabel('Agent mode')
    await expect(select, 'the composer offers the agent dropdown').toBeVisible()
    // Exactly the store's rows, in the store's order, the app-owned one last.
    await expect(select.getByRole('option')).toHaveText(
      payload.agents.map((agent) => agent.label),
    )

    // The select's title names the agent and the hubs it can reach — the part
    // of the sentence the user acts on. The wording is derived from the row's
    // own flags, so it follows whatever the seeded store holds.
    const hintFor = (agent) => {
      const hubs = []
      if (agent.mcpEnable) hubs.push('MCP')
      if (agent.lspEnable) hubs.push('language servers')
      return hubs.length ? `${hubs.join(' and ')} available` : 'no tools'
    }

    await select.selectOption(gated.id)
    await expect(select).toHaveValue(gated.id)
    const gatedHint = (await select.getAttribute('title')) ?? ''
    expect(gatedHint).toContain(gated.label)
    expect(gatedHint).toContain(hintFor(gated))

    if (mcpConnectors.length) {
      await expect(page.locator('.chat-mcp-panel')).toBeVisible()
      await expect(page.locator('.chat-mcp-panel input[role="switch"]')).toHaveCount(
        mcpConnectors.length,
      )
      // Disabled, never hidden: the toggles stay real (Settings owns them), and
      // the row's tooltip says which agent took the hub away.
      const row = page.locator('.chat-mcp-panel .chat-mcp-row').first()
      expect((await row.getAttribute('title')) ?? '').toContain(gated.label)
      await expect(
        page.locator('.chat-mcp-panel input[role="switch"]:disabled'),
      ).toHaveCount(mcpConnectors.length)
    }

    await select.selectOption(open.id)
    await expect(select).toHaveValue(open.id)
    expect((await select.getAttribute('title')) ?? '').toContain(hintFor(open))
    if (mcpConnectors.length) {
      await expect(
        page.locator('.chat-mcp-panel input[role="switch"]').first(),
      ).toBeEnabled()
    }
  })

  // The composer row is `auto minmax(0,1fr) auto`: the bullets stay centered
  // between the two button groups. The dropdown joins the *left* group, so this
  // pins that the row still lays out that way and the select keeps the
  // icon-button height it sits beside.
  test('the dropdown joins the left action group without moving the bullets', async ({
    page,
  }) => {
    await page.goto('/')
    await page.getByRole('tab', { name: 'WorkBench' }).click()

    const select = page.getByLabel('Agent mode')
    await expect(select).toBeVisible()
    const box = await select.boundingBox()
    const button = await page.locator('.chat-bullet-actions--left .icon-btn').first().boundingBox()
    const bullets = await page.locator('.chat-bullet-row .memory-bullets').boundingBox()
    const rightGroup = await page
      .locator('.chat-bullet-actions--right')
      .boundingBox()

    expect(Math.round(box.height)).toBe(Math.round(button.height))
    // Left of the bullets, which are still in the middle of the row.
    expect(box.x + box.width).toBeLessThanOrEqual(bullets.x + 1)
    expect(bullets.x + bullets.width).toBeLessThanOrEqual(rightGroup.x + 1)

    // The modes pencil joined that same row without moving anything: it sits
    // immediately right of the select, on the same line, at the same height,
    // and the select's right edge is still left of the bullets.
    const pencil = page.locator('.chat-mode-edit')
    await expect(pencil).toBeVisible()
    const pencilBox = await pencil.boundingBox()
    expect(Math.round(pencilBox.height)).toBe(Math.round(box.height))
    expect(pencilBox.x).toBeGreaterThanOrEqual(box.x + box.width)
    // Same line: the row centres both, and both are the icon-button height, so
    // their top edges coincide (rounded — the boxes are fractional).
    expect(Math.round(pencilBox.y)).toBe(Math.round(box.y))
    expect(pencilBox.x + pencilBox.width).toBeLessThanOrEqual(bullets.x + 1)
  })

  // A store that cannot be read must cost the user nothing beyond Send: no
  // control that cannot be used, and the reason is the list's own failure. D5
  // removed the server-side default a missing list used to lean on, so the
  // composer refuses rather than sending no agent it cannot name.
  test('a failing /api/agents leaves the composer unable to send, with the pencil live', async ({
    page,
  }) => {
    await page.route(
      (url) => url.pathname === '/api/agents',
      (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    )
    await page.goto('/')
    await page.getByRole('tab', { name: 'WorkBench' }).click()

    await expect(page.getByLabel('Agent mode')).toHaveCount(0)
    // Everything else about the composer is still there.
    const textarea = page.locator('.chat-textarea')
    await expect(textarea).toBeVisible()
    await textarea.fill('a question nothing can answer')

    // Send is disabled and its title is the list's own reason, not a guess.
    const send = page.locator('.chat-send')
    await expect(send).toBeDisabled()
    expect(await send.getAttribute('title')).toContain('agent list could not be read')

    // The modes editor is *not* gated on the dropdown's verdict: a store whose
    // list could not be read is exactly when it is most useful.
    const pencil = page.locator('.chat-mode-edit')
    await expect(pencil).toBeVisible()
    await expect(pencil).toBeEnabled()

    // The hub panels are not gated by an agent nobody resolved.
    const mcpRes = await page.request.get('/api/mcp')
    const mcpConnectors = (await mcpRes.json()).connectors.filter((c) => c.active)
    if (mcpConnectors.length) {
      await expect(page.locator('.chat-mcp-panel input[role="switch"]').first()).toBeEnabled()
    }
  })
})

test.describe('Agent modes editor: the pencil, the tabs, the writes', () => {
  // AC-4's app-owned half: the agent is visible in both places, its fields are
  // disabled while its model stays live, and every other write — including one
  // attempted directly against the route — answers the same refusal sentence.
  test('a readonly agent is visible, its model is live, and its other writes are refused', async ({
    page,
    request,
  }) => {
    const payload = await agentsPayload(request)
    const appOwned = payload.agents.find((agent) => agent.readonly)
    expect(appOwned, 'the store holds one app-owned agent').toBeTruthy()
    expect(appOwned.modelId, 'the suite fixture gives it a model').not.toBeNull()

    await page.goto('/')
    await page.getByRole('tab', { name: 'WorkBench' }).click()

    // It is in the composer's dropdown.
    const select = page.getByLabel('Agent mode')
    await expect(select.getByRole('option', { name: appOwned.label })).toHaveCount(1)

    // And it has a tab in the editor: visible, with its nojae-owned fields
    // disabled and the model dropdown live.
    await openModesDialog(page)
    await modeTabs(page).filter({ hasText: appOwned.label }).click()
    const section = page.locator(`section[data-tab="${appOwned.id}"]`)
    await expect(section.locator('.agent-modes-readonly')).toBeVisible()
    await expect(section.getByLabel('Label')).toBeDisabled()
    // No id field at all: a stored row's id is immutable and names nothing the
    // user acts on, so the dialog does not spend room on it.
    await expect(section.getByLabel('Id', { exact: true })).toHaveCount(0)
    await expect(section.locator('textarea')).toBeDisabled()
    await expect(section.locator('input[type="number"]')).toBeDisabled()
    await expect(section.locator('input[role="switch"]').first()).toBeDisabled()
    await expect(section.getByLabel('Model')).toBeEnabled()
    await closeModesDialog(page)

    // AC-4's route half: a write that is not the model association is refused
    // with the one sentence, so the rule does not depend on the dialog.
    const refused = await request.post('/api/agents/save', {
      data: { id: appOwned.id, mcpEnable: false },
    })
    expect(refused.status()).toBe(422)
    const detail = (await refused.json()).detail
    expect(detail).toContain('This agent is nojae')
    expect(detail).toContain('Its model is the one thing you can set')

    // The model association is the one field that agent's write accepts.
    const assigned = await request.post('/api/agents/save', {
      data: { id: appOwned.id, modelId: appOwned.modelId },
    })
    expect(assigned.ok(), await assigned.text()).toBe(true)
    const afterAssign = (await assigned.json()).agents.find(
      (agent) => agent.id === appOwned.id,
    )
    expect(afterAssign.modelId).toBe(appOwned.modelId)

    // And it cannot be deleted, from the route either.
    const refusedDelete = await request.post('/api/agents/delete', {
      data: { id: appOwned.id },
    })
    expect(refusedDelete.status()).toBe(422)
    expect((await refusedDelete.json()).detail).toContain('cannot be deleted')
  })

  test('Create adds a tab and writes nothing; Save creates, edits and deletes through the routes', async ({
    page,
    request,
  }) => {
    const before = await agentsPayload(request)
    const model = await firstModel(request)
    const captions = before.agents.map((agent) => agent.label)

    await page.goto('/')
    await page.getByRole('tab', { name: 'WorkBench' }).click()
    await openModesDialog(page)

    const dialog = page.locator('.agent-modes-dialog')
    const tabs = modeTabs(page)
    // One tab per row the store holds, in the store's order. `Common` is gone
    // with the default-agent setting it edited (D5), and the app-owned agent
    // now has a tab like every other row (D4).
    await expect(tabs).toHaveCount(captions.length)
    await expect(tabs).toHaveText(captions)

    // 1. Create: a tab appears, is focused, and nothing is written.
    await dialog.locator('.agent-modes-create').getByLabel('New agent label').fill(NEW_LABEL)
    await dialog.locator('.agent-modes-create-button').click()

    await expect(tabs).toHaveCount(captions.length + 1)
    await expect(tabs.last()).toHaveText(NEW_LABEL)
    const section = page.locator('.agent-modes-editor section:visible')
    await expect(section.getByLabel('Label')).toHaveValue(NEW_LABEL)

    // The id is the slug the composable derived from the label — read from the
    // form, judged against the caps the payload published, never spelled here.
    const idField = section.getByLabel('Id', { exact: true })
    await expect(idField, "a new agent's id is editable while it is new").toBeEditable()
    const newId = await idField.inputValue()
    expect(newId).toMatch(new RegExp(before.caps.idPattern))
    expect(before.agents.map((agent) => agent.id)).not.toContain(newId)
    await expect
      .poll(async () => {
        const focused = await focusProbe(page)
        return `${focused.tag ?? 'none'}:${focused.tab ?? 'none'}`
      })
      .toBe(`INPUT:${newId}`)

    await closeModesDialog(page)
    expect(await agentsPayload(request), 'Cancel writes nothing').toEqual(before)

    // 2. The same create, saved: the row exists after its own Save.
    await openModesDialog(page)
    await dialog.locator('.agent-modes-create').getByLabel('New agent label').fill(NEW_LABEL)
    await dialog.locator('.agent-modes-create-button').click()
    const savedSection = page.locator('.agent-modes-editor section:visible')
    await savedSection.locator('textarea').fill(NEW_PERSONA)
    await expect(savedSection.locator('.agent-modes-persona-count')).toContainText(
      `${Buffer.byteLength(NEW_PERSONA, 'utf8')} / ${before.caps.maxPersonaBytes} bytes`,
    )
    await savedSection.getByLabel('Model').selectOption(String(model.id))

    const created = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/agents/add',
    )
    await dialog.locator('.agent-modes-save').click()
    const createdResponse = await created
    expect(createdResponse.status(), 'the create was accepted').toBe(200)
    // A successful save **is** the whole action, so the card closes: the write
    // was the user's intent and a card left open would leave them hunting for a
    // second "done" (the same rule the delete does *not* follow — that one
    // adopts the returned list and stays put). The row it wrote is in the store.
    await expect(page.locator('.agent-modes-dialog')).toHaveCount(0)

    const afterCreate = await agentsPayload(request)
    const createdRow = afterCreate.agents.find((agent) => agent.id === newId)
    expect(createdRow, 'the new agent is in the store').toBeTruthy()
    expect(createdRow.label).toBe(NEW_LABEL)
    expect(createdRow.modelId).toBe(model.id)
    expect(createdRow.systemMessage).toBe(NEW_PERSONA)
    expect(createdRow.deletable, 'a user-created agent can be deleted').toBe(true)

    // 3. Edit the same row, read back from the store: it is now an **existing**
    // agent, so it has no id field any more (the id cannot be renamed), and its
    // tab follows the label live while Save rewrites the row it was read under.
    await openModesDialog(page)
    await modeTabs(page).filter({ hasText: NEW_LABEL }).click()
    const editSection = page.locator('.agent-modes-editor section:visible')
    await expect(editSection.getByLabel('Id', { exact: true })).toHaveCount(0)
    await editSection.getByLabel('Label').fill(EDITED_LABEL)
    await expect(tabs.filter({ hasText: EDITED_LABEL })).toHaveCount(1)
    const edited = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/agents/save',
    )
    await dialog.locator('.agent-modes-save').click()
    const editedResponse = await edited
    expect(editedResponse.status(), 'the edit was accepted').toBe(200)
    await expect(page.locator('.agent-modes-dialog')).toHaveCount(0)

    const afterEdit = await agentsPayload(request)
    const editedRow = afterEdit.agents.find((agent) => agent.id === newId)
    expect(editedRow.label).toBe(EDITED_LABEL)
    expect(editedRow.systemMessage).toBe(NEW_PERSONA)

    // The composer's dropdown reloaded from the write: the new agent is an
    // option, and it can be chosen like any other.
    const select = page.getByLabel('Agent mode')
    await expect(select.getByRole('option', { name: EDITED_LABEL })).toHaveCount(1)
    await select.selectOption(newId)
    await expect(select).toHaveValue(newId)

    // 4. Delete it again through the dialog, so the install's store is exactly
    // as this spec found it.
    await openModesDialog(page)
    await modeTabs(page).filter({ hasText: EDITED_LABEL }).click()
    const deleteSection = page.locator('.agent-modes-editor section:visible')
    await deleteSection.locator('.agent-modes-delete-button').click()
    const deleted = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/agents/delete',
    )
    await deleteSection.locator('.agent-modes-delete-yes').click()
    const deletedResponse = await deleted
    expect(deletedResponse.status(), 'the delete was accepted').toBe(200)
    await expect(tabs).toHaveCount(captions.length)
    expect((await agentsPayload(request)).agents.map((agent) => agent.id)).not.toContain(
      newId,
    )
    await closeModesDialog(page)
    await expect(select.getByRole('option', { name: EDITED_LABEL })).toHaveCount(0)
  })
})
