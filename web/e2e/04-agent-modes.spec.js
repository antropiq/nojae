import { expect, test } from '@playwright/test'

// Task appdb-13, rewritten for the toolbar-driven card (adrework-07) — level:
// UI state, over the install's agent store.
//
// The composer's dropdown, the hub panels' gray-out and the Agents card all read
// **one** payload, `GET /api/agents`, because the agents are rows of the
// installation's `nojae.db` rather than a file in a workspace (D2, D11). So this
// spec reads that route instead of the workspace's old modes file: a spec that
// opens the store's bytes would be a second authority on the store, which §4.6
// forbids. Nothing here names the app-owned agent either — it is found by its
// `readonly` flag, the only way the client is allowed to recognise it (D4).
//
// What the spec measures:
//
//  1. the dropdown offers exactly the store's rows, the app-owned one included,
//     and an agent with a hub switched off turns that panel inert;
//  2. the pencil opens the store editor, whose list is the store's rows in the
//     store's order and whose toolbar is the only place its verbs live;
//  3. `Add agent` enters creation mode and writes nothing; `Save agent` creates
//     the row **and leaves the card open on it**, a second save edits it, and
//     `Delete agent` + `Confirm delete` removes it again;
//  4. a `readonly` agent shows its fields disabled with a live model dropdown,
//     and refuses every other write **directly against its route** (AC-4).
//
// The card's controls are reached by their **accessible names** (`Add agent`,
// `Save agent`, `Delete agent`, `Cancel delete`, `Confirm delete`, `Keep
// editing`, `Discard and close`, `Close`) rather than by class: that vocabulary
// is what D1 guarantees, and a name query is what a reader would use. An inert
// slot is queried by a fragment of its **reason**, because D1 makes the reason
// its accessible name — so a disabled slot is never matched by its live name.
// The class hooks that remain are the ones §7 keeps unchanged (the list, the
// `readonly` explanation, the persona byte counter, the model line) plus the
// card's **one message line** (D11), which is the only place it says anything.
//
// The suite's temporary store starts from the built-ins with the fixture's model
// assigned to every agent (D14), so nothing here needs a model of its own and no
// LLM call is made. A created agent is deleted again — the store is shared by
// the whole suite, and the spec must not leave rows behind.
//
// Two assertions here exist because the rework made them easy to regress (§9):
// a `Save agent` click on an incomplete form writes nothing, leaves the card
// open, and leaves **one** message in the line; and clicking `Add agent` then a
// row discards the creation without a prompt, with **no row ever added** for it.

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

async function configPayload(request) {
  const res = await request.get('/api/config')
  expect(res.ok(), `GET /api/config failed: ${await res.text()}`).toBe(true)
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

//: The card itself, by the accessible name D9 says it carries in **every** state.
function card(page) {
  return page.getByRole('dialog', { name: 'Agents', exact: true })
}

//: A toolbar or footer slot, by the name that is also its tooltip (§6.16). Each
//: of these names is unique inside the card, which is what D1 guarantees — so
//: this is how every **live** slot is reached.
function slot(page, name) {
  return card(page).getByRole('button', { name, exact: true })
}

//: An **inert** slot: D1 replaces its name with its reason, so the live name
//: matches nothing there and the reason's fragment is the query.
function inertSlot(page, reason) {
  return card(page).getByRole('button', { name: reason })
}

//: The agent list — the nav, not the toolbar above it. The app's own tab strip
//: renders buttons too, so every query is scoped to the card and to that nav.
function modeTabs(page) {
  return card(page).getByRole('navigation', { name: 'Agent modes' }).getByRole('button')
}

//: One row, by the label it is captioned with (a row's caption **is** its
//: Label field, so this is also how "the tab follows the label live" is read).
function modeTab(page, label) {
  return card(page)
    .getByRole('navigation', { name: 'Agent modes' })
    .getByRole('button', { name: label, exact: true })
}

//: The row the card acts on. The selected mark is the row's own `aria-current`,
//: which is also what a reader hears (D2 — the selection *is* the edit mode), so
//: this is a **state** query rather than a class hook.
function selectedTab(page) {
  return card(page)
    .getByRole('navigation', { name: 'Agent modes' })
    .locator('[aria-current="true"]')
}

// Which section of the card is showing, what holds the focus, and which field of
// that section it is. Read through `dataset` because an agent id is arbitrary
// text.
function focusProbe(page) {
  return page.evaluate(() => {
    const el = document.activeElement
    return {
      tag: el?.tagName ?? null,
      tab: el?.closest('section[data-tab]')?.dataset.tab ?? null,
      field: el?.closest('label')?.firstChild?.textContent?.trim() ?? null,
    }
  })
}

//: The shown section of the form column. `v-show` keeps every agent's form in
//: the DOM, so "the form the user is looking at" is the visible one — and while
//: a new agent is being typed it is the **creation** form, which has no row.
function visibleSection(page) {
  return card(page).locator('.agent-modes-editor section:visible')
}

//: **The card's one message line** (D11): the only place it says anything.
function messageLine(page) {
  return card(page).locator('.agent-modes-message')
}

//: Every POST the card makes, recorded so "writes nothing" is asserted rather
//: than inferred from the store happening to look unchanged. The record is a
//: **window**: `expectNone` checks it and opens the next one, and a step that
//: *does* expect a write calls `checkpoint()` after awaiting it — so a create
//: that was supposed to happen cannot make a later "wrote nothing" lie.
function trackWrites(page) {
  let paths = []
  page.on('request', (req) => {
    const path = new URL(req.url()).pathname
    if (req.method() === 'POST' && path.startsWith('/api/agents/')) paths.push(path)
  })
  return {
    checkpoint: () => {
      paths = []
    },
    // Polled, so a request that *was* issued has time to show up in the window.
    async expectNone(why) {
      await expect
        .poll(() => paths.length, { message: `${why} (${paths.join(', ')})`, timeout: 2000 })
        .toBe(0)
      paths = []
    },
  }
}

//: The response a click on a toolbar verb must produce, awaited around the click.
function agentRoute(page, name) {
  return page.waitForResponse(
    (response) => new URL(response.url()).pathname === `/api/agents/${name}`,
  )
}

// Opening the card is itself the read: the card fetches `GET /api/agents` on
// mount, so the response is the moment its draft is on screen.
async function openModesDialog(page) {
  const read = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/agents',
  )
  await page.locator('.chat-mode-edit').click()
  await read
  await expect(card(page)).toBeVisible()
}

//: Leaving the card, which is now its **only** way out (D8): `Close`, and the
//: guard's `Discard and close` when the card holds unsaved work. Both paths are
//: read here, so a card that left **through** the guard — or that never asked —
//: cannot pass unnoticed, and the old `Cancel` helper's guarantee (leaving writes
//: nothing) is the same guarantee through the new exit.
async function closeModesDialog(page) {
  await slot(page, 'Close').click()
  if (await slot(page, 'Discard and close').count()) {
    await expect(slot(page, 'Keep editing')).toBeVisible()
    await slot(page, 'Discard and close').click()
  }
  await expect(card(page)).toHaveCount(0)
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
    // The hub is a read of **one** folder: the installation, which is where a
    // fresh tab lands and therefore the folder every request names here.
    const installation = (await (await page.request.get('/api/workspace')).json()).workspace
    const mcpRes = await page.request.get('/api/mcp', {
      params: { workspace: installation },
    })
    const mcpConnectors = (await mcpRes.json()).connectors.filter((c) => c.active)

    await page.goto('/')
    await page.getByRole('tab', { name: 'WorkBench' }).click()

    const select = page.getByLabel('Agent mode')
    await expect(select, 'the composer offers the agent dropdown').toBeVisible()
    // Exactly the store's rows, in the store's order, the app-owned one last.
    await expect(select.getByRole('option')).toHaveText(
      payload.agents.map((agent) => agent.label),
    )

    // The select's title says what the selected agent runs as and on: the agent
    // with the server its model sits on, the model itself, and the two hubs.
    // Every part is derived from the store's rows and `/api/config`, so it
    // follows whatever the seeded install holds.
    const config = await configPayload(page.request)
    const titleFor = (agent) => {
      const entry = config.models.find((model) => model.id === agent.modelId)
      const modelName = String(entry?.name ?? agent.modelName ?? '').trim()
      const serverName = String(entry?.serverName ?? '').trim()
      const lines = [serverName ? `${agent.label}: ${serverName}` : agent.label]
      if (modelName) lines.push(`model: ${modelName}`)
      // The hub flags are `!== false` on the client (an absent flag is On), so
      // the derivation mirrors that rather than reading the flag as a boolean.
      lines.push(
        `MCP: ${agent.mcpEnable !== false ? 'On' : 'Off'}, ` +
          `LSP: ${agent.lspEnable !== false ? 'On' : 'Off'}`,
      )
      return lines.join('\n')
    }

    await select.selectOption(gated.id)
    await expect(select).toHaveValue(gated.id)
    // A **retrying** assertion, not a one-shot read: the title's server name is
    // the composer's computed over the `/api/config` catalogue, so the line is
    // only complete once that read has landed — a fixed-time `getAttribute`
    // would race it (and did, in a full-suite run where the response arrived a
    // beat later than on a cold boot).
    await expect(select).toHaveAttribute('title', titleFor(gated))

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
    await expect(select).toHaveAttribute('title', titleFor(open))
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

    // The **select**, by role and its exact name — not `getByLabel('Agent mode')`.
    // With no resolvable agent the two panels' wizard buttons are inert, and
    // AC-6 requires each inert button's accessible name to be the app's existing
    // no-model sentence, which names the "Agent modes dialog": a bare label query
    // now matches those two buttons as well. The claim this row guards is
    // unchanged — the composer's own dropdown is absent.
    await expect(page.getByRole('combobox', { name: 'Agent mode' })).toHaveCount(0)
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
    // The hub is a read of **one** folder: the installation, which is where a
    // fresh tab lands and therefore the folder every request names here.
    const installation = (await (await page.request.get('/api/workspace')).json()).workspace
    const mcpRes = await page.request.get('/api/mcp', {
      params: { workspace: installation },
    })
    const mcpConnectors = (await mcpRes.json()).connectors.filter((c) => c.active)
    if (mcpConnectors.length) {
      await expect(page.locator('.chat-mcp-panel input[role="switch"]').first()).toBeEnabled()
    }
  })
})

test.describe('Agent modes editor: the pencil, the tabs, the writes', () => {
  // AC-4's app-owned half: the agent is visible in both places, its fields are
  // disabled while its model stays live, the toolbar's two other verbs refuse it
  // by name, and every other write — including one attempted directly against
  // the route — answers the same refusal sentence.
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

    // And it has a row in the card: visible, with its nojae-owned fields
    // disabled and the model dropdown live.
    await openModesDialog(page)
    await modeTab(page, appOwned.label).click()
    const section = page.locator(`section[data-tab="${appOwned.id}"]`)
    await expect(section.getByLabel('Label')).toBeDisabled()
    // No id field at all: a stored row's id is immutable and names nothing the
    // user acts on, so the dialog does not spend room on it.
    await expect(section.getByLabel('Id', { exact: true })).toHaveCount(0)
    await expect(section.locator('textarea')).toBeDisabled()
    await expect(section.locator('input[type="number"]')).toBeDisabled()
    await expect(section.locator('input[role="switch"]').first()).toBeDisabled()
    await expect(section.getByLabel('Model')).toBeEnabled()

    // The toolbar's two other verbs refuse this row **by name**: an inert slot
    // always says why (D1), and the reason is its accessible name — so the live
    // names match nothing here. The delete refusal that used to be a caption
    // under the form is this tooltip now (D11).
    await expect(slot(page, 'Delete agent')).toHaveCount(0)
    await expect(inertSlot(page, 'nojae owns this agent')).toBeVisible()
    await expect(inertSlot(page, 'nojae owns this agent')).toBeDisabled()
    // And save has nothing to offer until the one field the user owns changes
    // (§5's exception, which is about that row's model and nothing else).
    await expect(slot(page, 'Save agent')).toHaveCount(0)
    await expect(inertSlot(page, 'has not changed')).toBeVisible()
    await expect(inertSlot(page, 'has not changed')).toBeDisabled()

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

  // The toolbar's slots are fixed 36px boxes, and the glyph button inside each
  // one is the icon button's **circle**. The toolbar carries `role="group"` for
  // ARIA, and Pico's input-group rules match *any* `[role="group"]` — including
  // `[role="group"] button { width: auto }`, which outranks the bare `.icon-btn`
  // width. Left alone, the slot keeps its 36px so nothing moves, but the button
  // inside it collapses to its glyph's width while keeping its 36px height: an
  // ellipse.
  //
  // Measured in a real browser on purpose: the unit layer injects only
  // `theme.css`, so Pico's competing rule is not in that document and the
  // collision cannot be observed there — which is how the ellipse passed 949
  // unit assertions.
  test('the toolbar glyphs are circles: each slot button is as wide as it is tall', async ({
    page,
  }) => {
    await page.goto('/')
    await page.getByRole('tab', { name: 'WorkBench' }).click()
    await openModesDialog(page)

    // Square and fully rounded: the two together are what a circle is, since a
    // 50% radius on a non-square box is exactly the ellipse that was reported.
    const expectCircles = (locator, count) => {
      expect(locator).toHaveCount(count)
      return locator.evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.getBoundingClientRect()
          return {
            w: Math.round(rect.width),
            h: Math.round(rect.height),
            radius: getComputedStyle(node).borderRadius,
          }
        }),
      ).then((boxes) => {
        for (const box of boxes) {
          expect(box.w, `glyph button is ${box.w}x${box.h}`).toBe(box.h)
          expect(box.h).toBe(36)
          expect(box.radius).toBe('50%')
        }
      })
    }

    const toolbar = card(page).getByRole('group', { name: 'Agent actions' })
    await expectCircles(toolbar.locator('.agent-modes-slot button'), 3)

    // The footer's pair is the same idiom in the same fixed slots, so it is
    // measured too — reached by typing and asking `Close`, which writes nothing.
    await visibleSection(page).getByLabel('Label').fill('Circle Check')
    await slot(page, 'Close').click()
    await expect(slot(page, 'Keep editing')).toBeVisible()
    await expectCircles(card(page).locator('.agent-modes-footer-slot .agent-modes-slot button'), 2)
    await slot(page, 'Keep editing').click()
    await closeModesDialog(page)
  })

  // The toolbar's three verbs, in order, over the list they act on: `Add agent`
  // enters creation mode and writes nothing, `Save agent` writes the one subject
  // and **leaves the card open on it** (D6), and `Delete agent` asks its pair
  // before the route is touched. The card's only exit is `Close`, which writes
  // nothing and asks first when the card holds typing (D8).
  test('the toolbar creates, edits and deletes one agent, and the card stays open', async ({
    page,
    request,
  }) => {
    const before = await agentsPayload(request)
    const model = await firstModel(request)
    const captions = before.agents.map((agent) => agent.label)
    // The row the card lands on is the store's first one (a fresh browser has
    // remembered no agent), and that is a built-in: which is what makes the
    // delete slot's refusal below the row's own flag rather than an assumption.
    expect(before.agents[0].deletable, 'the store opens on a built-in row').toBe(false)

    await page.goto('/')
    await page.getByRole('tab', { name: 'WorkBench' }).click()
    await openModesDialog(page)

    const writes = trackWrites(page)
    const tabs = modeTabs(page)
    // One row per agent the store holds, in the store's order, and the landing
    // rule has one of them selected (D9: how the card opens is unchanged).
    await expect(tabs).toHaveCount(captions.length)
    await expect(tabs).toHaveText(captions)
    await expect(selectedTab(page)).toHaveText(captions[0])

    // The toolbar over the list: three slots, and the selected built-in makes the
    // third one inert with its reason (§6.10) — never hidden, and never silent.
    const toolbar = card(page).getByRole('group', { name: 'Agent actions' })
    await expect(slot(page, 'Add agent')).toBeEnabled()
    await expect(slot(page, 'Save agent')).toBeEnabled()
    await expect(slot(page, 'Delete agent')).toHaveCount(0)
    await expect(inertSlot(page, 'cannot be deleted')).toBeDisabled()
    // The confirmation pairs are absent from the DOM until they mean something
    // (§6.17), so the toolbar holds exactly its three verbs.
    await expect(toolbar.getByRole('button')).toHaveCount(3)

    // 1. `Add agent`: the selection clears, the form empties, Label is focused,
    // and **nothing is written** (D4). The list gains no row.
    await slot(page, 'Add agent').click()
    await expect(tabs).toHaveCount(captions.length)
    await expect(selectedTab(page)).toHaveCount(0)
    await expect
      .poll(async () => {
        const focused = await focusProbe(page)
        return `${focused.tag ?? 'none'}:${focused.field ?? 'none'}`
      })
      .toBe('INPUT:Label')
    const creation = visibleSection(page)
    await expect(creation.getByLabel('Label')).toHaveValue('')
    await expect(creation.locator('textarea')).toHaveValue('')
    await expect(creation.locator('.agent-modes-model-line')).toHaveText(
      /no model/,
    )
    await writes.expectNone('entering creation mode writes nothing')

    // Creation mode is announced by **no words at all**: the heading and the
    // card's name still read `Agents`, and the only thing said is the one
    // message line's incomplete-form sentence (D4.4, D9, D11).
    await expect(card(page).getByRole('heading', { name: 'Agents', exact: true })).toHaveCount(2)
    await expect(card(page)).not.toContainText(/New agent/i)
    await expect(messageLine(page)).toHaveAttribute('role', 'status')
    await expect(messageLine(page)).toContainText('must be completed')
    // §5's signature of the state: save is live, delete is inert because
    // nothing is stored to delete, and add is inert because a creation is
    // already being typed.
    await expect(slot(page, 'Save agent')).toBeEnabled()
    await expect(inertSlot(page, 'before it can be deleted')).toBeDisabled()
    await expect(inertSlot(page, 'Already adding')).toBeDisabled()

    // 2. §9's first new assertion: `Save agent` on an **incomplete** form is
    // live, refuses, and says so in the card's one line — no write, no close,
    // and exactly one message anywhere in the card.
    await expect(slot(page, 'Save agent')).toBeEnabled()
    await slot(page, 'Save agent').click()
    await writes.expectNone('a refused save posts nothing')
    await expect(card(page)).toBeVisible()
    await expect(messageLine(page)).toContainText('must be completed')
    await expect(messageLine(page)).toContainText('A label is required')
    // Exactly one message: the reserved line, and no per-field or top-of-card
    // site left to compete with it (D11).
    await expect(card(page).locator('[role="alert"], [role="status"]')).toHaveCount(1)
    await expect(card(page).locator('.agent-modes-message')).toHaveCount(1)

    // 3. §9's second new assertion: clicking a row **discards the creation
    // without a prompt** — nothing was written, so nothing needs confirming —
    // and no row was ever added for the half-typed agent.
    await creation.getByLabel('Label').fill('Half-typed')
    await modeTab(page, captions[1]).click()
    await expect(card(page)).toBeVisible()
    await expect(slot(page, 'Keep editing')).toHaveCount(0)
    await expect(selectedTab(page)).toHaveText(captions[1])
    await expect(tabs).toHaveCount(captions.length)
    await expect(tabs).toHaveText(captions)
    await writes.expectNone('abandoning a creation writes nothing')

    // 4. The same creation, completed and saved: the row exists after its own
    // save, and the card is **still open on it** (D6).
    await slot(page, 'Add agent').click()
    const form = visibleSection(page)
    await form.getByLabel('Label').fill(NEW_LABEL)
    // The id follows the label on the field's own `change`, so focus has to
    // leave it before the slug the form settled on can be read.
    await form.getByLabel('Label').press('Tab')

    // The id is the slug the composable derived from the label — read from the
    // form, judged against the caps the payload published, never spelled here.
    const idField = form.getByLabel('Id', { exact: true })
    await expect(idField, "a new agent's id is editable while it is new").toBeEditable()
    const newId = await idField.inputValue()
    expect(newId).toMatch(new RegExp(before.caps.idPattern))
    expect(before.agents.map((agent) => agent.id)).not.toContain(newId)

    await form.locator('textarea').fill(NEW_PERSONA)
    await expect(form.locator('.agent-modes-persona-count')).toContainText(
      `${Buffer.byteLength(NEW_PERSONA, 'utf8')} / ${before.caps.maxPersonaBytes} bytes`,
    )
    await form.getByLabel('Model').selectOption(String(model.id))
    // The form is complete now, so the line that named what was missing is empty
    // (D11: a message clears when its cause goes away).
    await expect(messageLine(page)).toHaveText('')

    const created = agentRoute(page, 'add')
    await slot(page, 'Save agent').click()
    const createdResponse = await created
    expect(createdResponse.status(), 'the create was accepted').toBe(200)
    // The write the step was waiting for: the window opens again here, so the
    // "writes nothing" checks below are about what follows, not about this.
    writes.checkpoint()
    // A save is a write, not an exit: the card stays open, the new agent's row
    // is in the list for the first time, and it is the selected one (D4.6, D6).
    await expect(card(page)).toBeVisible()
    await expect(tabs).toHaveCount(captions.length + 1)
    await expect(modeTab(page, NEW_LABEL)).toHaveCount(1)
    await expect(selectedTab(page)).toHaveText(NEW_LABEL)
    await expect(visibleSection(page).getByLabel('Label')).toHaveValue(NEW_LABEL)
    await expect(messageLine(page)).toHaveText('')

    const afterCreate = await agentsPayload(request)
    const createdRow = afterCreate.agents.find((agent) => agent.id === newId)
    expect(createdRow, 'the new agent is in the store').toBeTruthy()
    expect(createdRow.label).toBe(NEW_LABEL)
    expect(createdRow.modelId).toBe(model.id)
    expect(createdRow.systemMessage).toBe(NEW_PERSONA)
    expect(createdRow.deletable, 'a user-created agent can be deleted').toBe(true)

    // 5. Leaving after a write costs **no** extra click: nothing is unsaved, so
    // `Close` closes at once and the guard's pair is never rendered (D8).
    await slot(page, 'Close').click()
    await expect(slot(page, 'Keep editing')).toHaveCount(0)
    await expect(card(page)).toHaveCount(0)

    // 6. `Close` with unsaved work asks **in place**, and `Keep editing` answers
    // it by changing nothing — the guarantee the footer's old `Cancel` gave, now
    // through the card's only exit.
    await openModesDialog(page)
    await modeTab(page, NEW_LABEL).click()
    const editSection = visibleSection(page)
    await editSection.getByLabel('Label').fill(`${NEW_LABEL} Unsaved`)
    await slot(page, 'Close').click()
    await expect(slot(page, 'Keep editing')).toBeVisible()
    await expect(slot(page, 'Discard and close')).toBeVisible()
    await expect(card(page)).toBeVisible()
    // The guard asks in **words** too, in the one message line: two glyphs are not
    // a sentence, and the consequence here is that leaving throws typing away.
    await expect(messageLine(page)).toHaveText('There are unsaved changes. Close anyway?')
    await slot(page, 'Keep editing').click()
    await expect(card(page)).toBeVisible()
    await expect(visibleSection(page).getByLabel('Label')).toHaveValue(`${NEW_LABEL} Unsaved`)
    // The question was the guard's, so it left with the guard (D11: a message
    // clears when its cause goes away).
    await expect(messageLine(page)).toHaveText('')
    await writes.expectNone('the close guard writes nothing')
    // And the row it was typed over is still the store's own.
    expect(
      (await agentsPayload(request)).agents.find((agent) => agent.id === newId).label,
    ).toBe(NEW_LABEL)

    // 7. Edit the same row for real: it is now an **existing** agent, so it has
    // no id field any more (the id cannot be renamed), its row follows the label
    // live, and the save leaves the card open on it again.
    await editSection.getByLabel('Label').fill(EDITED_LABEL)
    await expect(modeTab(page, EDITED_LABEL)).toHaveCount(1)
    const edited = agentRoute(page, 'save')
    await slot(page, 'Save agent').click()
    const editedResponse = await edited
    expect(editedResponse.status(), 'the edit was accepted').toBe(200)
    writes.checkpoint()
    await expect(card(page)).toBeVisible()
    await expect(selectedTab(page)).toHaveText(EDITED_LABEL)
    await expect(tabs).toHaveCount(captions.length + 1)

    const afterEdit = await agentsPayload(request)
    const editedRow = afterEdit.agents.find((agent) => agent.id === newId)
    expect(editedRow.label).toBe(EDITED_LABEL)
    expect(editedRow.systemMessage).toBe(NEW_PERSONA)

    // The unsaved `Unsaved` edit is gone with the form it was typed into: the
    // write re-baselined the row it touched, and the label it stored is the one
    // the form holds.
    await expect(visibleSection(page).getByLabel('Label')).toHaveValue(EDITED_LABEL)

    await closeModesDialog(page)

    // The composer's dropdown reloaded from the write: the new agent is an
    // option, and it can be chosen like any other.
    const select = page.getByLabel('Agent mode')
    await expect(select.getByRole('option', { name: EDITED_LABEL })).toHaveCount(1)
    await select.selectOption(newId)
    await expect(select).toHaveValue(newId)

    // 8. Delete it again through the toolbar, so the install's store is exactly
    // as this spec found it. The click asks the pair at the toolbar's right end
    // and writes nothing (D7); `Cancel delete` then leaves everything as it was
    // (D7.4, Q4), and only `Confirm delete` posts.
    await openModesDialog(page)
    const tabsAfter = modeTabs(page)
    await modeTab(page, EDITED_LABEL).click()
    await slot(page, 'Delete agent').click()
    await expect(toolbar.getByRole('button')).toHaveCount(5)
    await expect(slot(page, 'Cancel delete')).toBeFocused()
    await expect(slot(page, 'Confirm delete')).toBeVisible()
    // While the answer is pending the three verbs are inert: one destructive
    // action is decided at a time (D7.3).
    await expect(inertSlot(page, 'confirmation is pending')).toHaveCount(3)
    await writes.expectNone('asking for a delete writes nothing')

    await slot(page, 'Cancel delete').click()
    await expect(toolbar.getByRole('button')).toHaveCount(3)
    await expect(selectedTab(page)).toHaveText(EDITED_LABEL)
    await expect(visibleSection(page).getByLabel('Label')).toHaveValue(EDITED_LABEL)

    const deleted = agentRoute(page, 'delete')
    await slot(page, 'Delete agent').click()
    await slot(page, 'Confirm delete').click()
    const deletedResponse = await deleted
    expect(deletedResponse.status(), 'the delete was accepted').toBe(200)
    writes.checkpoint()
    await expect(tabsAfter).toHaveCount(captions.length)
    await expect(tabsAfter).toHaveText(captions)
    // The successor is selected: the **next** row in the order the list had
    // while the deleted row was still in it (D7.5) — the app-owned agent, which
    // the store always answers last.
    await expect(selectedTab(page)).toHaveText(before.agents.at(-1).label)
    expect((await agentsPayload(request)).agents.map((agent) => agent.id)).not.toContain(
      newId,
    )
    await closeModesDialog(page)
    await expect(select.getByRole('option', { name: EDITED_LABEL })).toHaveCount(0)
  })
})
