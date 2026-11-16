import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import AgentModesDialog from '../src/components/AgentModesDialog.vue'
import {
  NO_MODEL_LABEL,
  personaByteCount,
  useAgentModes,
} from '../src/composables/useAgentModes'
import { useAppShell } from '../src/composables/useAppShell'

// ---------------------------------------------------------------------------
// The agent-list dialog, mounted for real.
//
// The component decides nothing — every rule it renders is a function from
// `useAgentModes` and is judged in `agentModes.test.js`. So this suite is about
// *what is on screen*: the toolbar's slots over the list and what they are named,
// one row per agent the **store** holds, a `readonly` agent's fields disabled with
// its model live, the model dropdown's empty option as an explicit choice, the
// card's **one message line** (D11) saying everything it has to say, and what a
// click does to the three routes.
//
// The fixtures mirror the real `GET /api/agents` payload (§4.4), so what renders
// here is the server's data and not a paraphrase. `readonly` and `deletable` are
// the only two flags the component reads — it never names an agent id, and one
// case below asserts that over the source.
//
// jsdom has no `showModal`/`close` on `<dialog>`, so both are patched on
// `Element.prototype` the way `editorMoveDialog.test.js` does: they only have to
// keep `el.open` truthful, which is all the component's watch reads.
// ---------------------------------------------------------------------------

const CAPS = {
  maxIdChars: 32,
  idPattern: '^[a-z][A-Za-z0-9_-]*$',
  maxLabelChars: 40,
  maxPersonaBytes: 16384,
  maxPersonaLines: 16,
  minToolIteration: 1,
}

// The app-owned agent is spelled with a stand-in id: this file may not name the
// real one, for the same reason `web/src` may not.
const RESERVED_ID = 'reserved-agent-under-test'

//: One `GET /api/agents` answer. The rows spell both flags per row, which is the
//: whole point of §4.4 and D4 pulling them apart: **every built-in refuses
//: deletion without being readonly**, and only `todoBuilder`-style rows carry
//: `readonly` at all. A user-created agent is `deletable: true` and editable.
function agentsBody({ models = {} } = {}) {
  const rows = [
    { id: 'chat', label: 'Chat', mcpEnable: false, lspEnable: false, systemMessage: 'You never call a tool.' },
    { id: 'code', label: 'Code', mcpEnable: true, lspEnable: true, systemMessage: 'You edit files.' },
    { id: 'architect', label: 'Architect', mcpEnable: true, lspEnable: false },
    {
      id: RESERVED_ID,
      label: 'Reserved',
      mcpEnable: true,
      lspEnable: false,
      readonly: true,
    },
  ]
  const agents = rows.map((row, index) => {
    const modelId = models[row.id] === undefined ? index + 1 : models[row.id]
    return {
      readonly: false,
      deletable: false, // nojae's own rows (D4)
      systemMessage: '',
      ...row,
      maxToolIteration: 25,
      modelId,
      modelName: modelId === null ? null : `model-${modelId}`,
    }
  })
  return { agents, caps: CAPS, findings: [] }
}

//: A user-created row appended to the built-ins: editable and deletable, which
//: is what makes `deletable` a flag rather than a synonym for `!readonly`.
function withScribe(body = agentsBody()) {
  body.agents.push(deletableRow('scribe', 'Scribe'))
  return body
}

//: A user-created row: editable and deletable, which is what makes `deletable` a
//: flag rather than a synonym for `!readonly`.
function deletableRow(id, label) {
  return {
    id,
    label,
    mcpEnable: false,
    lspEnable: false,
    systemMessage: '',
    readonly: false,
    deletable: true,
    maxToolIteration: 25,
    modelId: null,
    modelName: null,
  }
}

//: **Two** user-created rows, for the delete cases: a deleted row then has a
//: **next** one, and when it is the last, a **previous** one — which is the whole
//: successor rule D7.5 asks the toolbar to follow.
function withScribeAndProofreader(body = agentsBody()) {
  body.agents.push(deletableRow('scribe', 'Scribe'), deletableRow('proofreader', 'Proofreader'))
  return body
}

//: The same list as it is after `scribe` was deleted: the store's answer.
function withoutScribe(body = agentsBody()) {
  body.agents.push(deletableRow('proofreader', 'Proofreader'))
  return body
}

//: The connection store's rows, which the model dropdown groups by server.
const SERVERS = {
  servers: [
    { id: 1, name: 'Local', url: 'http://localhost:8080/v1', apiKey: '', models: [{ id: 1, name: 'model-1' }] },
    { id: 2, name: 'Remote', url: 'http://remote/v1', apiKey: '', models: [{ id: 2, name: 'model-2' }] },
  ],
  caps: { samplerRanges: {}, reasoningLevels: [] },
  unassigned: { agentsWithoutModel: 0, agents: 4 },
}

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

// Every agent route and the connection read. `calls` records the writes in
// order, so "Create wrote nothing yet" is asserted rather than inferred.
// `agents: null` makes the **read** fail, which is the case the one message line
// exists for.
function stubRoutes({ agents = agentsBody(), saves = {}, calls = [] } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const key = String(url)
    if (key === '/api/agents') {
      return agents === null ? jsonResponse({}, false, 500) : jsonResponse(agents)
    }
    if (key === '/api/servers') return jsonResponse(SERVERS)
    if (key === '/api/config') return jsonResponse({ models: [], store: { usable: true } })
    if (key.startsWith('/api/agents/')) {
      calls.push({ key, body: JSON.parse(init.body) })
      const answer = saves[key]
      // An **array** is a sequence: each call to that route takes the next
      // answer, which is how a test drives "refused, then accepted". A
      // **function** is called per request, for an answer that must only be
      // produced when the route is reached (a rejected promise, below).
      if (typeof answer === 'function') return answer()
      if (Array.isArray(answer)) return answer.shift()
      if (answer !== undefined) return answer
      return jsonResponse(agents)
    }
    throw new Error(`unexpected fetch: ${key}`)
  })
  return calls
}

let host = null

// Mount with the card already open (the pencil's `open` ref is true by the time
// the component exists), with the routes stubbed **first**: opening *is* the
// read, so every test calls `stubRoutes` *before* this.
async function openDialog(props = {}) {
  host = document.createElement('div')
  document.body.appendChild(host)
  const wrapper = mount(AgentModesDialog, {
    attachTo: host,
    props: { open: true, ...props },
  })
  await flushPromises()
  return wrapper
}

function resetEditor() {
  const editor = useAgentModes().editor
  editor.open = false
  editor.loading = false
  editor.saving = false
  editor.readError = null
  editor.writeError = null
  editor.serverFindings = []
  const shell = useAppShell().state
  shell.servers = []
  shell.serversCaps = null
  shell.serversError = null
}

// The list's rows only — the toolbar sits above them and is not part of the list,
// so the selector is the hook the component puts on each row.
function tabs(w) {
  return w.findAll('.agent-modes-tab').map((node) => node.text())
}

function tabButton(w, index) {
  return w.findAll('.agent-modes-tab')[index]
}

function section(w, id) {
  return w.find(`section[data-tab="${id}"]`)
}

//: The toolbar's slots, by the hook each one carries. Their **accessible name**
//: is the verdict's one string, which is also the tooltip (§6.16).
function saveButton(w) {
  return w.find('.agent-modes-save')
}

function addButton(w) {
  return w.find('.agent-modes-add')
}

function toolbar(w) {
  return w.find('.agent-modes-toolbar')
}

function toolbarSlots(w) {
  return toolbar(w).findAll('.agent-modes-slot')
}

function closeButton(w) {
  return w.find('.agent-modes-close')
}

//: The creation form's section (D4): it is a form with **no row**, so it is keyed
//: by the card's own section key rather than by any agent id.
function creationSection(w) {
  return section(w, '#new')
}

function creationLabelField(w) {
  return creationSection(w).findAll('input[type="text"]')[0]
}

function creationIdField(w) {
  return creationSection(w).findAll('input[type="text"]')[1]
}

function labelField(w, id) {
  return section(w, id).findAll('input[type="text"]')[0]
}

function idField(w, id) {
  return section(w, id).findAll('input[type="text"]')[1]
}

function personaField(w, id) {
  return section(w, id).find('textarea')
}

function modelSelect(w, id) {
  return section(w, id).find('select')
}

//: **The card's one message** (D11): the only place it says anything. Every case
//: that used to read a line under a field, at the top of the card or in the
//: footer reads this instead.
function messageLine(w) {
  return w.find('.agent-modes-message')
}

function messageText(w) {
  return messageLine(w).text()
}

//: The toolbar's delete slot, and the confirmation pair's two slots. The pair has
//: **no element at all** until a delete is being confirmed (§6.17), so these
//: wrappers are empty before the click — which is itself what a case asserts.
function deleteSlotButton(w) {
  return w.find('.agent-modes-delete')
}

function cancelDeleteButton(w) {
  return w.find('.agent-modes-cancel-delete')
}

function confirmDeleteButton(w) {
  return w.find('.agent-modes-confirm-delete')
}

//: The footer's close pair. Like the delete pair it has **no element at all** until
//: a close is being confirmed (§6.17), so these wrappers are empty before the guard
//: asks — which is itself what a case asserts.
function footerSlot(w) {
  return w.find('.agent-modes-footer-slot')
}

function keepEditingButton(w) {
  return w.find('.agent-modes-keep-editing')
}

function discardCloseButton(w) {
  return w.find('.agent-modes-discard-close')
}

//: Escape, as the browser delivers it: the `<dialog>`'s cancelable `cancel` event,
//: which the card cancels and routes through the same verb the button uses.
async function pressEscape(w) {
  const dialog = w.find('dialog').element
  const event = new window.Event('cancel', { bubbles: true, cancelable: true })
  dialog.dispatchEvent(event)
  await flushPromises()
  return event
}

//: A click on the dimmed area outside the card — the same gesture as Escape.
async function clickBackdrop(w) {
  w.find('dialog').trigger('click')
  await flushPromises()
}

//: ---------------------------------------------------------------------------
//: Measuring the mounted card.
//:
//: jsdom lays nothing out: every `getBoundingClientRect()` is zero and every
//: `offsetWidth` is nothing, so a bounding box cannot be read here. What *can* be
//: read — and what the card's own geometry suite has always read — is the
//: **resolved style of the real mounted element** with the shipped theme applied
//: to the document: the width, height, flex basis, grid area and self-alignment
//: the layout engine is handed to produce that element's x / width / top. Two
//: states whose resolved boxes agree element for element cannot lay out
//: differently, and a rule that let a confirmation pair resize a slot, or a
//: message grow the footer band, changes one of these values.
//:
//: So every geometry case measures the mounted elements and compares the
//: measurement **across states** — which is what D10 asks — and pins the shipped
//: numbers once, so an equality that held because both sides were `auto` could
//: never pass unnoticed.
//: ---------------------------------------------------------------------------

const themeStyles = []

function applyShippedTheme() {
  const style = document.createElement('style')
  style.textContent = readFileSync(resolve('src/styles/theme.css'), 'utf8')
  document.head.appendChild(style)
  themeStyles.push(style)
}

//: The resolved box a layout engine turns into a position: the element's own
//: declared size, the basis it is negotiated with, where it is placed, and the
//: gaps it lays its children out with.
function box(el) {
  const s = getComputedStyle(el)
  return {
    width: s.width,
    height: s.height,
    flex: s.flex,
    justifyContent: s.justifyContent,
    alignSelf: s.alignSelf,
    gridArea: s.gridArea,
    gridTemplateRows: s.gridTemplateRows,
    gap: s.gap,
  }
}

//: The card's geometry, read off the mounted elements: the card's own box, the
//: body's rows, the toolbar and its **five** slot boxes with the three verbs in
//: them, the list's placement, the form column's, and the footer band with its
//: three children. The confirmation pair's two buttons are deliberately *not* in
//: here: their arrival is the thing that must move nothing, so the measurement
//: compares the boxes they arrive **inside**, and the three verbs they must not
//: displace.
function cardGeometry(w) {
  const slots = toolbarSlots(w)
  const footer = w.find('footer.settings-actions').element
  return {
    card: box(w.find('article').element),
    body: box(w.find('.agent-modes-body').element),
    toolbar: box(w.find('.agent-modes-toolbar').element),
    slotBoxes: slots.map((slot) => box(slot.element)),
    verbBoxes: slots.slice(0, 3).map((slot) => box(slot.find('button').element)),
    // Not a box: the count of buttons the toolbar holds, recorded so a case can
    // prove the pair really did arrive in one of the states it compared — an
    // equality between two states that both lacked it would be vacuous.
    toolbarButtons: slots.reduce((n, slot) => n + slot.findAll('button').length, 0),
    list: box(w.find('.agent-modes-nav').element),
    form: box(w.find('.agent-modes-editor').element),
    footerButtons: footer.querySelectorAll('button').length,
    footer: box(footer),
    footerChildren: [...footer.children].map(
      (node) => `${node.className}|${JSON.stringify(box(node))}`,
    ),
    message: box(w.find('.agent-modes-message').element),
  }
}

//: The §5 states the card can be driven into on one mount, each as a short label
//: and the gesture that reaches it. Every geometry case walks the same list, so a
//: state added to the spec's table has to be added here too — and then measured.
async function walkStates(w) {
  const states = []
  const record = async (label, reach) => {
    if (reach) await reach()
    await flushPromises()
    states.push({ label, geometry: cardGeometry(w) })
  }
  await record('a stored agent selected, untouched', null)
  await record('a stored agent selected, edited', async () => {
    await labelField(w, 'chat').setValue('Chatting')
  })
  await record('the form holds a problem', async () => {
    await labelField(w, 'chat').setValue('')
  })
  await record('the app-owned agent selected', async () => {
    await tabButton(w, 3).trigger('click')
  })
  await record('creation mode', async () => {
    await addButton(w).trigger('click')
  })
  await record('a stored agent selected again', async () => {
    await tabButton(w, 4).trigger('click')
  })
  await record('a delete confirmation pending', async () => {
    await deleteSlotButton(w).trigger('click')
  })
  await record('the delete cancelled', async () => {
    await cancelDeleteButton(w).trigger('click')
  })
  await record('a close confirmation pending', async () => {
    await closeButton(w).trigger('click')
  })
  await record('the close refused', async () => {
    await keepEditingButton(w).trigger('click')
  })
  return states
}

beforeEach(() => {
  Element.prototype.showModal = function showModal() {
    this.open = true
  }
  Element.prototype.close = function close() {
    this.open = false
  }
  resetEditor()
  // The remembered agent is the tab's (§5.5 rule 26), so the storage a fresh
  // case must clear is `sessionStorage`.
  window.sessionStorage.clear()
  vi.restoreAllMocks()
})

afterEach(() => {
  host?.remove()
  host = null
  themeStyles.splice(0).forEach((style) => style.remove())
  document.body.querySelectorAll('dialog').forEach((el) => el.remove())
})

describe('the tabs (§5.2)', () => {
  it('opens one tab per agent the store holds, in the store order, with no Common tab', async () => {
    stubRoutes()
    const w = await openDialog()

    // §5.2: "The Common tab is deleted". The four built-ins are *all* here,
    // the app-owned one included (D4 — it is now visible).
    expect(tabs(w)).toEqual(['Chat', 'Code', 'Architect', 'Reserved'])
    expect(section(w, 'common').exists()).toBe(false)
    expect(w.text()).not.toContain('Default mode')
    w.unmount()
  })

  it('lands on the composer\'s current agent when the list holds it', async () => {
    stubRoutes()
    const w = await openDialog({ initialMode: 'architect' })

    expect(tabButton(w, 2).classes()).toContain('active')
    w.unmount()
  })

  it('falls back to the first agent for an id the list does not hold', async () => {
    stubRoutes()
    const w = await openDialog({ initialMode: 'no-such-agent' })

    expect(tabButton(w, 0).classes()).toContain('active')
    w.unmount()
  })
})

describe('a per-agent tab (§5.2)', () => {
  it('holds Label, the two switches, the prompt with its byte counter, the cap and Model', async () => {
    stubRoutes()
    const w = await openDialog()
    await tabButton(w, 1).trigger('click') // Code

    const code = section(w, 'code')
    // One text field only: a stored agent's id is not shown (see below).
    expect(code.findAll('input[type="text"]')).toHaveLength(1) // label
    expect(code.findAll('input[role="switch"]')).toHaveLength(2)
    expect(code.find('textarea').exists()).toBe(true)
    expect(code.find('input[type="number"]').exists()).toBe(true)
    expect(code.find('select').exists()).toBe(true)
    expect(code.text()).toContain('Max tool iterations')

    const switches = code.findAll('input[role="switch"]')
    expect(switches[0].element.checked).toBe(true) // MCP
    expect(switches[1].element.checked).toBe(true) // LSP
    expect(personaField(w, 'code').element.value).toBe('You edit files.')
    expect(code.find('input[type="number"]').element.value).toBe('25')
    w.unmount()
  })

  it('puts Max tool iterations beside Label at the top of the section', async () => {
    stubRoutes()
    const w = await openDialog()
    await tabButton(w, 1).trigger('click') // Code

    const code = section(w, 'code')
    // The two short fields share the section's first row, so the number field is
    // no longer a block of its own lower down the column.
    const row = code.find('.agent-modes-fields-row')
    expect(row.exists()).toBe(true)
    expect(row.find('input[type="text"]').exists()).toBe(true) // Label
    expect(row.find('input[type="number"]').exists()).toBe(true) // Max tool iterations
    // ...and it is the **first** thing in the section: nothing precedes the row.
    expect(code.element.firstElementChild).toBe(row.element)
    // The number field appears exactly once in the section, inside that row.
    expect(code.findAll('input[type="number"]')).toHaveLength(1)
    w.unmount()
  })

  it('pushes the two switches to the right of their row, clear of the prompt label', async () => {
    // Measured off the shipped theme, like the geometry cases: the switches sit
    // on the row directly above the persona field, so a row that starts at the
    // left edge makes `System prompt` read as a caption of the switches.
    applyShippedTheme()
    stubRoutes()
    const w = await openDialog()
    await tabButton(w, 1).trigger('click') // Code

    const code = section(w, 'code')
    const row = code.find('.agent-modes-switches')
    expect(row.exists()).toBe(true)
    // Both switches are in that row, and the row is the section's own child —
    // the label below it is not inside it.
    expect(row.findAll('input[role="switch"]')).toHaveLength(2)
    expect(getComputedStyle(row.element).justifyContent).toBe('flex-end')
    // The row is the line above the persona field, which is what the label needs
    // to itself.
    expect(row.element.nextElementSibling.querySelector('textarea')).not.toBeNull()
    expect(
      row.element.nextElementSibling.textContent,
    ).toContain('System prompt')
    w.unmount()
  })

  it('says what an empty persona means', async () => {
    const agents = agentsBody()
    agents.agents[0].systemMessage = ''
    stubRoutes({ agents })
    const w = await openDialog()

    expect(personaField(w, 'chat').element.value).toBe('')
    expect(personaField(w, 'chat').attributes('placeholder')).toContain(
      "the model's own system prompt",
    )
    w.unmount()
  })

  it('a stored agent shows no id field; a new one gets an editable one', async () => {
    stubRoutes()
    const w = await openDialog()

    // An existing row's id is immutable (renaming it would orphan the sessions
    // that name it) and is a value the user never acts on, so it is not
    // rendered at all — the room goes to the fields that can be edited.
    expect(section(w, 'code').findAll('input[type="text"]')).toHaveLength(1)
    expect(section(w, 'code').text()).not.toMatch(/\bId\b/)

    await addButton(w).trigger('click')
    await creationLabelField(w).setValue('Reviewer')

    expect(creationSection(w).exists()).toBe(true)
    // The new agent's id is the one the slug generated, and it is live: the
    // user may still correct it before the row exists.
    expect(creationIdField(w).exists()).toBe(true)
    expect(creationIdField(w).attributes('disabled')).toBeUndefined()
    expect(creationIdField(w).element.value).toBe('reviewer')
    expect(creationLabelField(w).element.value).toBe('Reviewer')
    w.unmount()
  })

  it('a Label edit changes the tab caption immediately', async () => {
    stubRoutes()
    const w = await openDialog()

    await labelField(w, 'chat').setValue('Chatting')
    expect(tabs(w)).toEqual(['Chatting', 'Code', 'Architect', 'Reserved'])

    // An empty label falls back to the id, which is the loader's own rule.
    await labelField(w, 'chat').setValue('')
    expect(tabs(w)).toEqual(['chat', 'Code', 'Architect', 'Reserved'])
    w.unmount()
  })
})

describe('a readonly agent (§5.2, §4.4)', () => {
  it('renders every field disabled, except the model', async () => {
    stubRoutes()
    const w = await openDialog()
    await tabButton(w, 3).trigger('click') // Reserved

    const reserved = section(w, RESERVED_ID)
    // Every field nojae owns is there — rendered, not hidden — and disabled.
    // (The id is the one field not rendered at all: it is nobody's to edit.)
    for (const input of reserved.findAll('input[type="text"]')) {
      expect(input.attributes('disabled')).toBeDefined()
    }
    for (const toggle of reserved.findAll('input[role="switch"]')) {
      expect(toggle.attributes('disabled')).toBeDefined()
    }
    expect(reserved.find('textarea').attributes('disabled')).toBeDefined()
    expect(reserved.find('input[type="number"]').attributes('disabled')).toBeDefined()

    // ...and the model is live: it is the one field of this row the user owns.
    expect(reserved.find('select').attributes('disabled')).toBeUndefined()

    w.unmount()
  })

  it('shows the same model dropdown, with the same empty option', async () => {
    stubRoutes()
    const w = await openDialog()
    await tabButton(w, 3).trigger('click')

    const options = modelSelect(w, RESERVED_ID).findAll('option').map((node) => node.text())
    expect(options[0]).toBe(NO_MODEL_LABEL)
    expect(options[1]).toBe('model-1')
    w.unmount()
  })

  it('drives all of that from the flag, not from the agent\'s id', async () => {
    // The same payload, with a *different* id on the readonly row: the rendering
    // must not move. That is the whole rule §4.4 asks for.
    const agents = agentsBody()
    agents.agents[3].id = 'another-app-owned-id'
    stubRoutes({ agents })
    const w = await openDialog()
    await tabButton(w, 3).trigger('click')

    expect(section(w, 'another-app-owned-id').find('textarea').attributes('disabled')).toBeDefined()
    expect(section(w, 'another-app-owned-id').find('select').attributes('disabled')).toBeUndefined()
    w.unmount()
  })
})

describe('the model dropdown (§5.2)', () => {
  it('offers every configured model, grouped by server, with no "use the default" entry', async () => {
    stubRoutes()
    const w = await openDialog()

    const select = modelSelect(w, 'code')
    const options = select.findAll('option').map((node) => node.text())
    expect(options).toEqual([NO_MODEL_LABEL, 'model-1', 'model-2'])
    expect(w.text().toLowerCase()).not.toContain('use the default')

    const groups = select.findAll('optgroup').map((node) => node.attributes('label'))
    expect(groups).toEqual(['Local', 'Remote'])
    w.unmount()
  })

  it('names the model the tab will run on, server and model', async () => {
    stubRoutes()
    const w = await openDialog()

    expect(section(w, 'chat').find('.agent-modes-model-line').text()).toBe('Local · model-1')
    w.unmount()
  })

  it('the empty option is an explicit, legal choice with a visible cost', async () => {
    const calls = stubRoutes()
    const w = await openDialog()
    await tabButton(w, 0).trigger('click') // Chat

    await modelSelect(w, 'chat').setValue('')
    await flushPromises()

    // Selecting it is a legal save — the composer then refuses to send (task 12).
    expect(section(w, 'chat').find('.agent-modes-model-line').text()).toBe(NO_MODEL_LABEL)
    expect(saveButton(w).element.disabled).toBe(false)

    await saveButton(w).trigger('click')
    await flushPromises()
    expect(calls[0].body.modelId).toBeNull()
    w.unmount()
  })
})

// The problems the form can hold are no longer printed under the field each one
// names (D11): the card says them once, in its one message line, and the save
// slot stays **live** so the click is how the user learns what is missing.
describe('the form-level problems (D11)', () => {
  it('a problem is said in the one message line, and Save stays live', async () => {
    stubRoutes()
    const w = await openDialog()

    await labelField(w, 'chat').setValue('')
    expect(saveButton(w).element.disabled).toBe(false)
    expect(messageText(w)).toContain('A label is required.')
    // Announced as a status, and it is the *only* thing the card says.
    expect(messageLine(w).attributes('role')).toBe('status')
    expect(w.findAll('[role="alert"]')).toHaveLength(0)

    await labelField(w, 'chat').setValue('Chat')
    expect(saveButton(w).element.disabled).toBe(false)
    // The line clears when its cause goes away.
    expect(messageText(w)).toBe('')
    w.unmount()
  })

  it('no field carries a message of its own, and no count is printed', async () => {
    stubRoutes()
    const w = await openDialog()
    await labelField(w, 'chat').setValue('')

    expect(section(w, 'chat').findAll('.agent-modes-field-finding')).toHaveLength(0)
    expect(w.find('.agent-modes-blocking-note').exists()).toBe(false)
    // Nothing at the top of the card either: the header is followed by the body.
    expect(w.find('header').element.nextElementSibling.className).toContain('settings-form')
    w.unmount()
  })

  it('a duplicate label is refused in the line, and the mark lands on that tab', async () => {
    stubRoutes()
    const w = await openDialog()

    await labelField(w, 'chat').setValue('Code')
    expect(saveButton(w).element.disabled).toBe(false)
    expect(messageText(w)).toContain('already labelled')
    expect(tabButton(w, 0).classes()).toContain('agent-modes-tab--broken')
    w.unmount()
  })

  it('the persona byte counter names the payload cap, not a literal', async () => {
    const agents = agentsBody()
    agents.agents[0].systemMessage = '日本語'
    stubRoutes({ agents })
    const w = await openDialog()

    const count = section(w, 'chat').find('.agent-modes-persona-count')
    expect(count.text()).toBe(`${personaByteCount('日本語')} / ${CAPS.maxPersonaBytes} bytes`)
    expect(count.text()).toContain('9') // bytes, not the 3 characters
    w.unmount()
  })

  it('a persona over the byte cap is refused in the line, not under its field', async () => {
    stubRoutes()
    const w = await openDialog()
    await tabButton(w, 2).trigger('click') // Architect

    await personaField(w, 'architect').setValue('x'.repeat(CAPS.maxPersonaBytes + 1))
    expect(saveButton(w).element.disabled).toBe(false)
    expect(messageText(w)).toContain('over the')
    expect(section(w, 'architect').findAll('.agent-modes-field-finding')).toHaveLength(0)
    w.unmount()
  })

  it('a cap below the floor is refused, and the number is the payload\'s', async () => {
    stubRoutes()
    const w = await openDialog()
    await tabButton(w, 1).trigger('click') // Code

    const capInput = section(w, 'code').find('input[type="number"]')
    await capInput.setValue('0')
    expect(saveButton(w).element.disabled).toBe(false)
    expect(messageText(w)).toContain('at least 1')

    await capInput.setValue('500')
    expect(saveButton(w).element.disabled).toBe(false)
    expect(messageText(w)).toBe('')
    w.unmount()
  })

  it('clearing Max tool iterations is said in the line, and the click posts nothing', async () => {
    const calls = stubRoutes()
    const w = await openDialog()
    await tabButton(w, 1).trigger('click') // Code

    // `.number` leaves a cleared field as `''`, which used to read as "no value"
    // and then serialise to 0 — a save the store refuses after the click.
    await section(w, 'code').find('input[type="number"]').setValue('')
    expect(saveButton(w).element.disabled).toBe(false)
    expect(messageText(w)).toContain('Max tool iterations')

    await saveButton(w).trigger('click')
    await flushPromises()
    expect(calls).toEqual([])
    w.unmount()
  })

  it('a label over the payload\'s cap is refused in the line, and marks its tab', async () => {
    const calls = stubRoutes()
    const w = await openDialog()

    await labelField(w, 'chat').setValue('x'.repeat(CAPS.maxLabelChars + 1))
    expect(saveButton(w).element.disabled).toBe(false)
    expect(messageText(w)).toContain(`at most ${CAPS.maxLabelChars}`)
    expect(tabButton(w, 0).classes()).toContain('agent-modes-tab--broken')

    await saveButton(w).trigger('click')
    await flushPromises()
    expect(calls).toEqual([])

    // The cap itself is the payload's number: a label at it is fine.
    await labelField(w, 'chat').setValue('x'.repeat(CAPS.maxLabelChars))
    expect(messageText(w)).toBe('')
    expect(tabButton(w, 0).classes()).not.toContain('agent-modes-tab--broken')
    w.unmount()
  })
})

// ---------------------------------------------------------------------------
// The one message line (D11).
//
// Everything the card says comes out of `messageFor` and lands here, so these
// cases are about the *site*: one element, on the footer's band, always present,
// and the only thing in the card that carries a message.
// ---------------------------------------------------------------------------

describe('the one message line (D11)', () => {
  it('a failed read is said in the line, as an alert, and nowhere at the top', async () => {
    stubRoutes({ agents: null })
    const w = await openDialog()

    expect(messageLine(w).exists()).toBe(true)
    expect(messageText(w)).toContain('Could not read the agents')
    expect(messageLine(w).attributes('role')).toBe('alert')
    // There is nothing to edit — and nothing was printed above where the body
    // would have been: the header is followed straight by the form.
    expect(w.findAll('.agent-modes-tab')).toHaveLength(0)
    expect(w.findAll('section[data-tab]')).toHaveLength(0)
    expect(w.find('header').element.nextElementSibling.className).toContain('settings-form')
    w.unmount()
  })

  it('a failed write does not survive Close/Reopen as a fresh error', async () => {
    stubRoutes({
      saves: { '/api/agents/save': () => Promise.reject(new Error('network down')) },
    })
    const first = await openDialog()

    await labelField(first, 'chat').setValue('Chatting')
    await saveButton(first).trigger('click')
    await flushPromises()
    expect(messageText(first)).toContain('Could not reach the API')
    first.unmount()

    // The editor state is a module singleton, so reopening must read the store
    // afresh and say nothing about an action this card never attempted.
    const w = await openDialog()
    expect(messageText(w)).toBe('')
    expect(w.findAll('[role="alert"]')).toHaveLength(0)
    w.unmount()
  })

  it('the read\'s findings are said in the line, as one message', async () => {
    const agents = agentsBody()
    agents.findings = [
      { kind: 'error', message: 'The agent x holds label as null' },
      { kind: 'error', message: 'The agent y names model 9' },
    ]
    stubRoutes({ agents })
    const w = await openDialog()

    const text = messageText(w)
    expect(text).toContain('label as null')
    expect(text).toContain('names model 9')
    // One element, not a block per finding.
    expect(w.findAll('.agent-modes-message')).toHaveLength(1)
    expect(messageLine(w).attributes('role')).toBe('alert')
    w.unmount()
  })

  it('a read in flight is progress, said in the same line and nowhere above', async () => {
    // D11's last category — progress — has no other site either: the card's
    // body is rendered while the read is still happening, so the only place it
    // can say so is the reserved line (which is also how an empty form is told
    // apart from a failed read, D4.4).
    let release = null
    const pending = new Promise((resolve) => {
      release = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      String(url) === '/api/agents' ? pending : jsonResponse(SERVERS),
    )
    const w = await openDialog()

    expect(messageText(w)).toBe('Reading the agents…')
    expect(messageLine(w).attributes('role')).toBe('status')
    // Nothing appeared above the body to say it: the header is still followed
    // straight by the form, and the line is the only announced thing.
    expect(w.find('header').element.nextElementSibling.className).toContain('settings-form')
    expect(w.findAll('[role="alert"], [role="status"]')).toHaveLength(1)

    release(jsonResponse(agentsBody()))
    await flushPromises()
    // And it clears when the read lands.
    expect(messageText(w)).toBe('')
    w.unmount()
  })

  it('the line occupies its band while empty: filling it changes no other element', async () => {
    stubRoutes()
    const w = await openDialog()

    const footer = () => w.find('footer.settings-actions')
    const shape = () =>
      [...footer().element.children]
        .map((node) => `${node.tagName}.${node.className}`)
        .join('|')

    // Empty, and already in the band the buttons sit on.
    expect(messageText(w)).toBe('')
    const before = shape()
    expect(footer().element.children[0]).toBe(messageLine(w).element)

    await labelField(w, 'chat').setValue('')
    expect(messageText(w)).toContain('must be completed')
    // Same elements, same order: the message filled a slot that was already there.
    expect(shape()).toBe(before)
    expect(footer().element.children[0]).toBe(messageLine(w).element)
    w.unmount()
  })
})

// The nav's "New agent label" field and `+ Create agent` button are **gone**, and
// what replaces them is a form-only state: the toolbar's `+` empties the form, the
// list gains nothing, and the agent exists only once a save succeeds (D4).
describe('creation mode (D4, D5)', () => {
  it('add clears the selection, empties the form, focuses Label, and writes nothing', async () => {
    const calls = stubRoutes()
    const w = await openDialog()

    await addButton(w).trigger('click')
    await flushPromises()

    // The list is exactly what the store holds: no row was added for something
    // that does not exist yet, and no row carries the selected mark.
    expect(tabs(w)).toEqual(['Chat', 'Code', 'Architect', 'Reserved'])
    expect(tabButton(w, 0).classes()).not.toContain('active')
    expect(w.findAll('.agent-modes-tab[aria-current="true"]')).toHaveLength(0)
    // The form is the shape a new entry already has (the composable's own).
    expect(creationLabelField(w).element.value).toBe('')
    expect(creationSection(w).find('textarea').element.value).toBe('')
    const switches = creationSection(w).findAll('input[role="switch"]')
    expect(switches[0].element.checked).toBe(false)
    expect(switches[1].element.checked).toBe(false)
    expect(creationSection(w).find('input[type="number"]').element.value).toBe('1')
    expect(creationSection(w).find('.agent-modes-model-line').text()).toBe(NO_MODEL_LABEL)
    // Focus landed on Label.
    expect(document.activeElement).toBe(creationLabelField(w).element)
    // Nothing was written: only the two reads happened.
    expect(calls).toEqual([])
    w.unmount()
  })

  it('announces itself in no words at all: the title and the heading are unchanged', async () => {
    stubRoutes()
    const w = await openDialog()
    await addButton(w).trigger('click')
    await flushPromises()

    // D9: the dialog's title reads `Agents` in every state, and the list's own
    // heading too — no `New agent` caption, no banner, no badge anywhere.
    expect(w.find('#agent-modes-title').text()).toBe('Agents')
    expect(w.text()).not.toMatch(/New agent/i)
    // The only thing the card says is the incomplete-form sentence D11 puts in
    // its one reserved line — the same words any empty label earns, in a slot
    // that is always there, so nothing appeared to announce the state.
    expect(messageText(w)).toContain('must be completed')
    expect(w.findAll('.agent-modes-message')).toHaveLength(1)
    w.unmount()
  })

  it('add is inert in creation mode, and its tooltip says so', async () => {
    stubRoutes()
    const w = await openDialog()

    await addButton(w).trigger('click')
    await flushPromises()

    expect(addButton(w).element.disabled).toBe(true)
    expect(addButton(w).attributes('title')).toContain('Already adding')
    // The name and the tooltip are the same words, even when inert (§6.16).
    expect(addButton(w).attributes('aria-label')).toBe(addButton(w).attributes('title'))
    // A second click cannot empty the form the user may be typing into.
    await creationLabelField(w).setValue('Reviewer')
    await addButton(w).trigger('click')
    expect(creationLabelField(w).element.value).toBe('Reviewer')
    w.unmount()
  })

  it('a new agent may be saved without a model, and the quiet line says it cannot run', async () => {
    stubRoutes()
    const w = await openDialog()

    await addButton(w).trigger('click')
    await creationLabelField(w).setValue('Reviewer')
    await flushPromises()

    expect(creationSection(w).find('.agent-modes-model-line').text()).toBe(NO_MODEL_LABEL)
    expect(saveButton(w).element.disabled).toBe(false)
    w.unmount()
  })

  it('clicking a row abandons the creation without asking and shows that agent', async () => {
    const calls = stubRoutes()
    const w = await openDialog()

    await addButton(w).trigger('click')
    await creationLabelField(w).setValue('Reviewer')
    await tabButton(w, 1).trigger('click') // Code
    await flushPromises()

    // Nothing was written, so nothing needs confirming: the clicked agent is
    // shown, the half-typed form is gone, and the list never gained a row.
    expect(tabButton(w, 1).classes()).toContain('active')
    expect(section(w, 'code').find('textarea').element.value).toBe('You edit files.')
    expect(creationSection(w).exists()).toBe(false)
    expect(tabs(w)).toEqual(['Chat', 'Code', 'Architect', 'Reserved'])
    expect(calls).toEqual([])
    w.unmount()
  })

  it('names the collision instead of reusing an id', async () => {
    stubRoutes()
    const w = await openDialog()

    await addButton(w).trigger('click')
    await creationLabelField(w).setValue('Code')
    await flushPromises()

    // The creation form's own section is not the stored `code` one, so both are
    // in the DOM at once and the typed id is the one the slug rule made unique.
    expect(tabs(w)).toContain('Code')
    expect(creationIdField(w).element.value).toBe('code-2')
    expect(section(w, 'code').exists()).toBe(true)
    w.unmount()
  })

  it('a hand-edited Id is not overwritten by the next Label edit', async () => {
    stubRoutes()
    const w = await openDialog()

    await addButton(w).trigger('click')
    await flushPromises()
    await creationLabelField(w).setValue('Reviewer')
    expect(creationIdField(w).element.value).toBe('reviewer')

    // The id is a choice a chat payload and a saved session name the agent by, so
    // correcting it by hand stops the Label from driving it.
    await creationIdField(w).setValue('my-custom-id')
    await creationLabelField(w).setValue('Reviewer Bot')
    expect(creationIdField(w).element.value).toBe('my-custom-id')

    // The untouched path still follows the Label: a fresh form slugs as before.
    await tabButton(w, 0).trigger('click') // ends creation mode
    await addButton(w).trigger('click')
    await flushPromises()
    await creationLabelField(w).setValue('Scribe')
    expect(creationIdField(w).element.value).toBe('scribe')
    w.unmount()
  })
})

// Delete is a **toolbar verb** (D7): the third slot, offered only for a selected
// row that can be deleted and otherwise **disabled with its reason** in its
// tooltip — never hidden and never silently inert. Its confirmation is the pair at
// that toolbar's right end, carried by the two glyphs and their tooltips alone: no
// sentence, no agent label, no caption anywhere (Q7). The form holds no delete
// affordance at all any more, and the refusal wording that used to sit under it
// survives in the slot's tooltip.
describe('delete, as a toolbar verb (D1, D7, §6.10–§6.14, §6.17)', () => {
  it('is live for a user-created agent, and its click asks the pair without writing', async () => {
    const calls = stubRoutes({ agents: withScribe() })
    const w = await openDialog()
    await tabButton(w, 4).trigger('click') // Scribe

    expect(deleteSlotButton(w).element.disabled).toBe(false)
    // §6.16: the accessible name and the tooltip are the same words.
    expect(deleteSlotButton(w).attributes('title')).toBe('Delete agent')
    expect(deleteSlotButton(w).attributes('aria-label')).toBe('Delete agent')

    await deleteSlotButton(w).trigger('click')
    await flushPromises()

    // The confirm is asked for; nothing has been sent yet, and the selection and
    // the form did not change (D7.2).
    expect(calls).toEqual([])
    expect(cancelDeleteButton(w).exists()).toBe(true)
    expect(confirmDeleteButton(w).exists()).toBe(true)
    expect(tabButton(w, 4).classes()).toContain('active')
    expect(labelField(w, 'scribe').element.value).toBe('Scribe')
    // While the confirmation is pending the three verbs are inert (D7.3): one
    // destructive action is decided at a time. The card renders the verdicts.
    expect(addButton(w).element.disabled).toBe(true)
    expect(saveButton(w).element.disabled).toBe(true)
    expect(deleteSlotButton(w).element.disabled).toBe(true)
    expect(addButton(w).attributes('title')).toContain('confirmation is pending')
    // Focus landed on **Cancel** — the safe answer (D7).
    expect(document.activeElement).toBe(cancelDeleteButton(w).element)
    w.unmount()
  })

  it('is inert with a reason for a built-in agent, for nothing selected, and for a write in flight (§6.10)', async () => {
    // A built-in row: refused by its flag, and the reason is in the tooltip.
    stubRoutes()
    const w = await openDialog()
    await tabButton(w, 1).trigger('click') // Code

    expect(deleteSlotButton(w).exists()).toBe(true)
    expect(deleteSlotButton(w).element.disabled).toBe(true)
    expect(deleteSlotButton(w).attributes('title')).toContain('cannot be deleted')
    expect(deleteSlotButton(w).attributes('aria-label')).toBe(deleteSlotButton(w).attributes('title'))
    // The refusal is a tooltip, not a message: the line stays empty.
    expect(messageText(w)).toBe('')
    // A click on the inert slot asks nothing.
    await deleteSlotButton(w).trigger('click')
    expect(cancelDeleteButton(w).exists()).toBe(false)
    w.unmount()

    // Nothing selected, in creation mode: nothing is stored to delete.
    const w2 = await openDialog()
    await addButton(w2).trigger('click')
    await flushPromises()
    expect(deleteSlotButton(w2).element.disabled).toBe(true)
    expect(deleteSlotButton(w2).attributes('title')).toContain('before it can be deleted')
    w2.unmount()

    // A write in flight: the reason is the write, not the row.
    let release = null
    const pending = new Promise((resolve) => {
      release = resolve
    })
    stubRoutes({ agents: withScribe(), saves: { '/api/agents/save': pending } })
    const w3 = await openDialog()
    await tabButton(w3, 4).trigger('click') // Scribe, a deletable row
    await saveButton(w3).trigger('click')
    await flushPromises()

    expect(deleteSlotButton(w3).element.disabled).toBe(true)
    expect(deleteSlotButton(w3).attributes('title')).toContain('write is in flight')
    // ...and the pair, if it had been asked, is inert rather than queued (§8).
    release(jsonResponse(agentsBody()))
    await flushPromises()
    w3.unmount()
  })

  it('the pair is **absent from the DOM** until a delete is asked, and adds no sentence (§6.17, §6.11)', async () => {
    stubRoutes({ agents: withScribe() })
    const w = await openDialog()
    await tabButton(w, 4).trigger('click')

    // Not merely invisible: the toolbar holds five slots and two of them hold
    // nothing, so the pair is neither focusable nor announced.
    expect(toolbarSlots(w)).toHaveLength(5)
    expect(cancelDeleteButton(w).exists()).toBe(false)
    expect(confirmDeleteButton(w).exists()).toBe(false)
    // The toolbar says nothing in words: its slots hold glyphs only, and the
    // glyphs are decorative.
    expect(toolbar(w).text()).toBe('')

    await deleteSlotButton(w).trigger('click')
    await flushPromises()

    // Exactly two slots gained a button, and the toolbar still holds five slots —
    // so the three verbs kept the slots they were in and the height is the
    // toolbar's own, unchanged by content.
    expect(toolbarSlots(w)).toHaveLength(5)
    expect(toolbarSlots(w)[2].find('button').classes()).toContain('agent-modes-delete')
    expect(toolbarSlots(w)[3].find('button').classes()).toContain('agent-modes-cancel-delete')
    expect(toolbarSlots(w)[4].find('button').classes()).toContain('agent-modes-confirm-delete')
    // The pair's tooltips are the whole question and its two answers (Q7).
    expect(cancelDeleteButton(w).attributes('title')).toBe('Cancel delete')
    expect(confirmDeleteButton(w).attributes('title')).toBe('Confirm delete')
    // No sentence or label appeared anywhere: the toolbar still holds no text, and
    // the card's one message line is still empty.
    expect(toolbar(w).text()).toBe('')
    expect(messageText(w)).toBe('')
    w.unmount()
  })

  it('revealing the pair moves nothing: the same five slot boxes, the same three verbs (§6.11)', async () => {
    applyShippedTheme()
    stubRoutes({ agents: withScribe() })
    const w = await openDialog()
    await tabButton(w, 4).trigger('click')

    // The DOM handed to the layout engine: the same five slot boxes, the same
    // three verb buttons in them, in the same order, and the same **measured**
    // box for each — a slot's size never depends on whether it holds a button.
    const before = cardGeometry(w)
    const slotsBefore = toolbarSlots(w).map((slot) => slot.element)
    const verbsBefore = slotsBefore.slice(0, 3).map((slot) => slot.firstElementChild)

    await deleteSlotButton(w).trigger('click')
    await flushPromises()

    const after = cardGeometry(w)
    const slotsAfter = toolbarSlots(w).map((slot) => slot.element)
    expect(slotsAfter).toEqual(slotsBefore)
    expect(slotsAfter.slice(0, 3).map((slot) => slot.firstElementChild)).toEqual(verbsBefore)
    expect(after.slotBoxes).toEqual(before.slotBoxes)
    expect(after.verbBoxes).toEqual(before.verbBoxes)
    expect(after.toolbar).toEqual(before.toolbar)
    // Measured, not read out of the stylesheet: the pair arrived in slots whose
    // box the shipped theme declares, and the three verbs kept theirs.
    expect(after.slotBoxes.every((slot) => slot.width === '36px' && slot.flex === '0 0 36px')).toBe(true)
    w.unmount()
  })

  it('`Cancel delete` hides the pair and restores **nothing** — including what was typed (§6.12)', async () => {
    const calls = stubRoutes({ agents: withScribe() })
    const w = await openDialog()
    await tabButton(w, 4).trigger('click')

    await personaField(w, 'scribe').setValue('typed and not saved')
    await deleteSlotButton(w).trigger('click')
    await flushPromises()
    await cancelDeleteButton(w).trigger('click')
    await flushPromises()

    // The pair is gone, and nothing else changed: same selection, same form, same
    // typing — nothing was written, so there was nothing to restore (Q4).
    expect(cancelDeleteButton(w).exists()).toBe(false)
    expect(confirmDeleteButton(w).exists()).toBe(false)
    expect(tabButton(w, 4).classes()).toContain('active')
    expect(personaField(w, 'scribe').element.value).toBe('typed and not saved')
    expect(calls).toEqual([])
    // And the verb is live again: the card is back where it was.
    expect(deleteSlotButton(w).element.disabled).toBe(false)
    w.unmount()
  })

  it('`Confirm delete` posts the delete and selects the **next** row (§6.13)', async () => {
    const calls = stubRoutes({
      agents: withScribeAndProofreader(),
      saves: { '/api/agents/delete': jsonResponse(withoutScribe()) },
    })
    const w = await openDialog()
    await tabButton(w, 4).trigger('click') // Scribe

    await deleteSlotButton(w).trigger('click')
    await flushPromises()
    await confirmDeleteButton(w).trigger('click')
    await flushPromises()

    expect(calls[0].key).toBe('/api/agents/delete')
    expect(calls[0].body).toEqual({ id: 'scribe' })
    // The list is the store's answer, and the row after the deleted one is the
    // selected one.
    expect(tabs(w)).toEqual(['Chat', 'Code', 'Architect', 'Reserved', 'Proofreader'])
    expect(tabButton(w, 4).classes()).toContain('active')
    expect(labelField(w, 'proofreader').element.value).toBe('Proofreader')
    // The pair went away with the delete it was asked for.
    expect(cancelDeleteButton(w).exists()).toBe(false)
    w.unmount()
  })

  it('deleting one agent leaves another agent\'s typed edits alone (§6.18)', async () => {
    stubRoutes({
      agents: withScribeAndProofreader(),
      saves: { '/api/agents/delete': jsonResponse(withoutScribe()) },
    })
    const w = await openDialog()

    // Type into Chat, then delete a different, deletable row.
    await labelField(w, 'chat').setValue('Chatting')
    await personaField(w, 'chat').setValue('typed and not saved')
    await tabButton(w, 4).trigger('click') // Scribe
    await deleteSlotButton(w).trigger('click')
    await flushPromises()
    await confirmDeleteButton(w).trigger('click')
    await flushPromises()

    // Chat still holds what was typed in it — the delete was Scribe's alone.
    await tabButton(w, 0).trigger('click')
    expect(labelField(w, 'chat').element.value).toBe('Chatting')
    expect(personaField(w, 'chat').element.value).toBe('typed and not saved')
    // ...and because its baseline is still the store's, the close guard can see
    // the unsaved work instead of being made blind by the new rows.
    await closeButton(w).trigger('click')
    await flushPromises()
    expect(keepEditingButton(w).exists()).toBe(true)
    w.unmount()
  })

  it('deleting the **last** row selects the previous one (§6.13)', async () => {
    const answer = withScribe() // the store's answer: Scribe is the last row left
    stubRoutes({
      agents: withScribeAndProofreader(),
      saves: { '/api/agents/delete': jsonResponse(answer) },
    })
    const w = await openDialog()
    await tabButton(w, 5).trigger('click') // Proofreader, the last row

    await deleteSlotButton(w).trigger('click')
    await flushPromises()
    await confirmDeleteButton(w).trigger('click')
    await flushPromises()

    expect(tabs(w)).toEqual(['Chat', 'Code', 'Architect', 'Reserved', 'Scribe'])
    expect(tabButton(w, 4).classes()).toContain('active')
    w.unmount()
  })

  it('a delete that leaves the list empty leaves **no selection** (§6.13)', async () => {
    stubRoutes({
      agents: withScribe(),
      saves: { '/api/agents/delete': jsonResponse({ agents: [], caps: CAPS, findings: [] }) },
    })
    const w = await openDialog()
    await tabButton(w, 4).trigger('click')

    await deleteSlotButton(w).trigger('click')
    await flushPromises()
    await confirmDeleteButton(w).trigger('click')
    await flushPromises()

    expect(tabs(w)).toEqual([])
    expect(w.findAll('.agent-modes-tab[aria-current="true"]')).toHaveLength(0)
    // §5's last row: with an empty list the verbs are inert, each with its reason.
    expect(saveButton(w).element.disabled).toBe(true)
    expect(saveButton(w).attributes('title')).toContain('no agent selected')
    expect(deleteSlotButton(w).element.disabled).toBe(true)
    // §6.10's "nothing selected" is its own reason — the delete verb has no row
    // to act on, which is not the same sentence as a row that cannot be deleted.
    expect(deleteSlotButton(w).attributes('title')).toContain('Select an agent')
    w.unmount()
  })

  it('selecting another agent while the confirmation is pending cancels it and deletes nothing (§6.14)', async () => {
    const calls = stubRoutes({ agents: withScribe() })
    const w = await openDialog()
    await tabButton(w, 4).trigger('click') // Scribe

    await deleteSlotButton(w).trigger('click')
    await flushPromises()
    expect(cancelDeleteButton(w).exists()).toBe(true)

    await tabButton(w, 1).trigger('click') // Code
    await flushPromises()

    // The destructive action did not survive the selection moving.
    expect(cancelDeleteButton(w).exists()).toBe(false)
    expect(confirmDeleteButton(w).exists()).toBe(false)
    expect(calls).toEqual([])
    expect(tabButton(w, 1).classes()).toContain('active')
    // And the verb now answers for the row that is selected: Code is a built-in.
    expect(deleteSlotButton(w).element.disabled).toBe(true)
    w.unmount()
  })

  it('the per-agent section holds no delete affordance at all', async () => {
    stubRoutes({ agents: withScribe() })
    const w = await openDialog()
    await tabButton(w, 4).trigger('click')

    for (const node of w.findAll('section[data-tab]')) {
      expect(node.find('.agent-modes-delete-button').exists()).toBe(false)
      expect(node.find('.agent-modes-delete-confirm').exists()).toBe(false)
      expect(node.find('.agent-modes-actions').exists()).toBe(false)
      expect(node.text()).not.toMatch(/\bDelete\b/)
      expect(node.text()).not.toMatch(/Keep it/)
    }
    w.unmount()
  })
})

// A save is a **write, not an exit** (D6): the card stays open, the saved agent
// stays selected, and the list re-baselines on the store's answer — which is also
// how another agent's unsaved typing survives it (§6.18).
describe('save (one agent, and the card stays open)', () => {
  it('posts the selected agent to /api/agents/save, adopts the answer, and stays open', async () => {
    const saved = agentsBody()
    saved.agents[1].label = 'Coder'
    const calls = stubRoutes({ saves: { '/api/agents/save': jsonResponse(saved) } })
    const w = await openDialog()
    await tabButton(w, 1).trigger('click') // Code

    await labelField(w, 'code').setValue('Coder')
    await personaField(w, 'code').setValue('You edit files.\nNever guess.')
    const switches = section(w, 'code').findAll('input[role="switch"]')
    await switches[0].setValue(false)
    await saveButton(w).trigger('click')
    await flushPromises()

    expect(calls.map((call) => call.key)).toEqual(['/api/agents/save'])
    expect(calls[0].body).toMatchObject({
      id: 'code',
      label: 'Coder',
      mcpEnable: false,
      lspEnable: true,
      systemMessage: 'You edit files.\nNever guess.',
      modelId: 2,
      maxToolIteration: 25,
    })
    // The answer re-baselines the card, so the caption follows the server's row.
    expect(tabs(w)).toContain('Coder')
    // ...the saved agent is still the selected one, and the card is still open.
    expect(tabButton(w, 1).classes()).toContain('active')
    expect(w.find('dialog').element.open).toBe(true)
    expect(w.emitted('close')).toBeFalsy()
    w.unmount()
  })

  it('a save of one agent leaves another agent\'s typed edits alone (§6.18)', async () => {
    const saved = agentsBody()
    const calls = stubRoutes({ saves: { '/api/agents/save': jsonResponse(saved) } })
    const w = await openDialog()

    // Type into Chat, switch to Code and save *that*.
    await labelField(w, 'chat').setValue('Chatting')
    await personaField(w, 'chat').setValue('typed and not saved')
    await tabButton(w, 1).trigger('click') // Code
    await saveButton(w).trigger('click')
    await flushPromises()

    expect(calls.map((call) => call.key)).toEqual(['/api/agents/save'])
    expect(calls[0].body.id).toBe('code')
    // Chat still holds what was typed in it — the write was Code's alone.
    await tabButton(w, 0).trigger('click')
    expect(labelField(w, 'chat').element.value).toBe('Chatting')
    expect(personaField(w, 'chat').element.value).toBe('typed and not saved')
    w.unmount()
  })

  it('switching rows and back preserves what was typed in each form (§6.18)', async () => {
    stubRoutes()
    const w = await openDialog()

    await labelField(w, 'chat').setValue('Chatting')
    await personaField(w, 'chat').setValue('one')
    await tabButton(w, 1).trigger('click') // Code
    await labelField(w, 'code').setValue('Coding')
    await personaField(w, 'code').setValue('two')
    await tabButton(w, 2).trigger('click') // Architect
    await tabButton(w, 0).trigger('click') // back to Chat

    expect(labelField(w, 'chat').element.value).toBe('Chatting')
    expect(personaField(w, 'chat').element.value).toBe('one')
    await tabButton(w, 1).trigger('click')
    expect(labelField(w, 'code').element.value).toBe('Coding')
    expect(personaField(w, 'code').element.value).toBe('two')
    w.unmount()
  })

  it('a readonly agent\'s Save sends its model and nothing else, and stays open', async () => {
    const calls = stubRoutes()
    const w = await openDialog()
    await tabButton(w, 3).trigger('click')

    await modelSelect(w, RESERVED_ID).setValue('2')
    await saveButton(w).trigger('click')
    await flushPromises()

    expect(calls[0].key).toBe('/api/agents/save')
    expect(calls[0].body).toEqual({ id: RESERVED_ID, modelId: 2 })
    expect(w.find('dialog').element.open).toBe(true)
    expect(w.emitted('close')).toBeFalsy()
    w.unmount()
  })

  it('a new agent is created from the empty form, its row appears selected, and the card stays open', async () => {
    const created = withScribe() // the store's answer holds the new row
    const calls = stubRoutes({ saves: { '/api/agents/add': jsonResponse(created) } })
    const w = await openDialog()

    await addButton(w).trigger('click')
    await creationLabelField(w).setValue('Scribe')
    await flushPromises()

    // Nothing was written by adding, and the list gained no row for it.
    expect(calls).toEqual([])
    expect(tabs(w)).toEqual(['Chat', 'Code', 'Architect', 'Reserved'])

    await saveButton(w).trigger('click')
    await flushPromises()

    expect(calls[0].key).toBe('/api/agents/add')
    expect(calls[0].body.id).toBe('scribe')
    expect(calls[0].body.label).toBe('Scribe')
    // The new agent's row is there now, selected, and the form stayed open on it.
    expect(tabs(w)).toEqual(['Chat', 'Code', 'Architect', 'Reserved', 'Scribe'])
    expect(tabButton(w, 4).classes()).toContain('active')
    expect(creationSection(w).exists()).toBe(false)
    expect(labelField(w, 'scribe').element.value).toBe('Scribe')
    expect(w.find('dialog').element.open).toBe(true)
    expect(w.emitted('close')).toBeFalsy()
    w.unmount()
  })

  it('an incomplete form leaves the slot live, and a click writes nothing', async () => {
    const calls = stubRoutes()
    const w = await openDialog()

    await labelField(w, 'chat').setValue('')
    expect(saveButton(w).element.disabled).toBe(false)

    await saveButton(w).trigger('click')
    await flushPromises()

    // Nothing was posted, the card is still open, and the line holds exactly one
    // message — the incomplete-form sentence, announced as a status (§6.6).
    expect(calls).toEqual([])
    expect(w.find('dialog').element.open).toBe(true)
    expect(w.emitted('close')).toBeFalsy()
    expect(messageLine(w).attributes('role')).toBe('status')
    expect(messageText(w)).toContain('must be completed')
    expect(messageText(w)).toContain('A label is required.')
    w.unmount()
  })

  it('a refused save keeps the card open with the server\'s sentence in the line', async () => {
    const detail = 'label: an agent labelled \'Code\' already exists.'
    stubRoutes({ saves: { '/api/agents/save': jsonResponse({ detail }, false, 422) } })
    const w = await openDialog()

    await labelField(w, 'chat').setValue('Chat')
    await saveButton(w).trigger('click')
    await flushPromises()

    // The store's own words, verbatim, announced as an alert, and nowhere else
    // (§6.7: nothing at the top of the card, no field with its own message).
    expect(messageText(w)).toBe(detail)
    expect(messageLine(w).attributes('role')).toBe('alert')
    expect(w.findAll('[role="alert"]')).toHaveLength(1)
    expect(w.find('dialog').element.open).toBe(true)
    // A refusal is not a save: the card stays open and closes nothing.
    expect(w.emitted('close')).toBeFalsy()
    w.unmount()
  })

  it('a successful save empties a refusal', async () => {
    const saved = agentsBody()
    stubRoutes({
      agents: saved,
      saves: {
        '/api/agents/save': [
          jsonResponse({ detail: 'the store refused' }, false, 422),
          jsonResponse(saved),
        ],
      },
    })
    const w = await openDialog()

    await saveButton(w).trigger('click')
    await flushPromises()
    expect(messageText(w)).toBe('the store refused')

    await saveButton(w).trigger('click')
    await flushPromises()
    expect(messageText(w)).toBe('')
    w.unmount()
  })

  it('`Close` is the footer\'s only button, it writes nothing, and there is no Save there', async () => {
    const calls = stubRoutes()
    const w = await openDialog()

    const footer = w.find('footer.settings-actions')
    expect(footer.findAll('button').map((node) => node.text())).toEqual(['Close'])
    expect(footer.find('.agent-modes-save').exists()).toBe(false)

    // Nothing was typed, so the guard has nothing to ask and `Close` leaves at once.
    await closeButton(w).trigger('click')

    expect(calls).toEqual([])
    expect(w.emitted('close')).toBeTruthy()
    w.unmount()
  })

  it('re-saving an untouched agent is still allowed — no dirty gate on the save slot (§6.9)', async () => {
    const saved = agentsBody()
    const calls = stubRoutes({ saves: { '/api/agents/save': jsonResponse(saved) } })
    const w = await openDialog()

    // The baseline says this row differs from nothing, so the guard would not ask —
    // and that same baseline must **not** reach the save slot: there is no `Nothing
    // to save` state, so an untouched agent may be written again.
    expect(saveButton(w).element.disabled).toBe(false)
    expect(saveButton(w).attributes('title')).toBe('Save agent')

    await saveButton(w).trigger('click')
    await flushPromises()

    expect(calls.map((call) => call.key)).toEqual(['/api/agents/save'])
    expect(w.find('dialog').element.open).toBe(true)
    w.unmount()
  })
})

// ---------------------------------------------------------------------------
// The close guard (D8).
//
// `Close` is the card's only exit, so it must not silently discard typing: while
// the card holds unsaved work it asks **in place**, in the footer's reserved slot,
// with the delete pair's own idiom. Escape and a backdrop click are the same verb
// and take the same guard — otherwise they are a silent bypass. The guard's only
// input is the per-entry baseline (plus creation mode), and that baseline never
// reaches the save slot (Q2).
// ---------------------------------------------------------------------------

describe('the close guard (D8, §6.15, §6.17)', () => {
  it('with unsaved work, `Close` asks in the footer\'s reserved slot and writes nothing', async () => {
    const calls = stubRoutes()
    const w = await openDialog()
    await labelField(w, 'chat').setValue('Chatting')

    // Both buttons are **absent from the DOM** before the question is asked, and
    // the slot they arrive in is already there (§6.17).
    expect(keepEditingButton(w).exists()).toBe(false)
    expect(discardCloseButton(w).exists()).toBe(false)
    expect(footerSlot(w).exists()).toBe(true)

    await closeButton(w).trigger('click')
    await flushPromises()

    // The pair is in the footer's slot, and the card is still open with nothing
    // written: the guard asked instead of leaving.
    expect(keepEditingButton(w).exists()).toBe(true)
    expect(discardCloseButton(w).exists()).toBe(true)
    expect(footerSlot(w).element.contains(keepEditingButton(w).element)).toBe(true)
    expect(footerSlot(w).element.contains(discardCloseButton(w).element)).toBe(true)
    expect(w.find('dialog').element.open).toBe(true)
    expect(w.emitted('close')).toBeFalsy()
    expect(calls).toEqual([])
    // The pair reuses the delete idiom's two answers, and each glyph's tooltip is
    // its accessible name (§6.16).
    expect(keepEditingButton(w).attributes('title')).toBe('Keep editing')
    expect(keepEditingButton(w).attributes('aria-label')).toBe('Keep editing')
    expect(discardCloseButton(w).attributes('title')).toBe('Discard and close')
    expect(discardCloseButton(w).attributes('aria-label')).toBe('Discard and close')
    // The pair's two glyphs name its two answers; the card's **one message line**
    // (D11) names the question they answer, so nobody has to read a glyph twice to
    // learn that closing now would discard typing. It is the footer's question, so
    // the line — the slot immediately before the two buttons — is its home, and
    // `messageFor` owns the wording, not the template.
    expect(messageText(w)).toBe('There are unsaved changes. Close anyway?')
    expect(messageLine(w).attributes('role')).toBe('status')
    // It says nothing else: no nested dialog appeared, and no second copy of the
    // question sits anywhere outside that line.
    expect(w.findAll('.agent-modes-message')).toHaveLength(1)
    // Focus landed on **`Keep editing`** — the safe answer.
    expect(document.activeElement).toBe(keepEditingButton(w).element)
    // And while it is pending the toolbar's three verbs are inert: one destructive
    // decision at a time (§5's last row).
    expect(addButton(w).element.disabled).toBe(true)
    expect(saveButton(w).element.disabled).toBe(true)
    expect(deleteSlotButton(w).element.disabled).toBe(true)
    expect(addButton(w).attributes('title')).toContain('confirmation is pending')
    w.unmount()
  })

  it('with nothing unsaved, `Close` closes at once and the pair is never rendered', async () => {
    const calls = stubRoutes()
    const w = await openDialog()

    await closeButton(w).trigger('click')
    await flushPromises()

    expect(w.emitted('close')).toBeTruthy()
    expect(calls).toEqual([])
    expect(keepEditingButton(w).exists()).toBe(false)
    expect(discardCloseButton(w).exists()).toBe(false)
    w.unmount()
  })

  it('a keystroke in a row the user left behind is still unsaved work', async () => {
    stubRoutes()
    const w = await openDialog()
    await labelField(w, 'chat').setValue('Chatting')
    await tabButton(w, 1).trigger('click') // away to Code, which is untouched

    await closeButton(w).trigger('click')
    await flushPromises()

    // The card holds one form per agent, so the guard asks about all of them —
    // the common case (open, change nothing, close) is the only one that costs
    // no extra click.
    expect(keepEditingButton(w).exists()).toBe(true)
    expect(w.emitted('close')).toBeFalsy()
    w.unmount()
  })

  it('creation mode counts as unsaved work: nothing was ever written', async () => {
    const calls = stubRoutes()
    const w = await openDialog()
    await addButton(w).trigger('click')
    await flushPromises()

    await closeButton(w).trigger('click')
    await flushPromises()

    expect(keepEditingButton(w).exists()).toBe(true)
    expect(w.emitted('close')).toBeFalsy()
    expect(calls).toEqual([])
    w.unmount()
  })

  it('Escape and a backdrop click are `Close`, so they take the same guard', async () => {
    // Escape: the `<dialog>`'s own close path is cancelled and routed through the
    // same verb, so it cannot be a silent bypass of the guard.
    const calls = stubRoutes()
    const w = await openDialog()
    await labelField(w, 'chat').setValue('Chatting')

    const event = await pressEscape(w)
    expect(event.defaultPrevented).toBe(true)
    expect(keepEditingButton(w).exists()).toBe(true)
    expect(w.find('dialog').element.open).toBe(true)
    expect(w.emitted('close')).toBeFalsy()
    expect(calls).toEqual([])

    // A backdrop click is the same gesture and the same answer.
    await clickBackdrop(w)
    expect(keepEditingButton(w).exists()).toBe(true)
    expect(w.emitted('close')).toBeFalsy()
    expect(calls).toEqual([])
    w.unmount()
  })

  it('with nothing unsaved, Escape and a backdrop click still leave at once', async () => {
    const calls = stubRoutes()
    const w = await openDialog()

    await pressEscape(w)
    expect(keepEditingButton(w).exists()).toBe(false)
    expect(w.emitted('close')).toBeTruthy()
    expect(calls).toEqual([])

    const w2 = await openDialog()
    await clickBackdrop(w2)
    expect(w2.emitted('close')).toBeTruthy()
    expect(keepEditingButton(w2).exists()).toBe(false)
    w.unmount()
    w2.unmount()
  })

  it('a save re-baselines, so closing straight after it costs no extra click', async () => {
    const saved = agentsBody()
    saved.agents[1].label = 'Coder'
    stubRoutes({ saves: { '/api/agents/save': jsonResponse(saved) } })
    const w = await openDialog()
    await tabButton(w, 1).trigger('click') // Code

    await labelField(w, 'code').setValue('Coder')
    await saveButton(w).trigger('click')
    await flushPromises()

    // The write made the stored state the truth, so nothing would be lost — the
    // guard's baseline is the store's answer, never what was sent.
    await closeButton(w).trigger('click')
    await flushPromises()

    expect(keepEditingButton(w).exists()).toBe(false)
    expect(w.emitted('close')).toBeTruthy()
    w.unmount()
  })

  it('`Keep editing` hides the pair and changes **nothing** else', async () => {
    const calls = stubRoutes()
    const w = await openDialog()
    await tabButton(w, 1).trigger('click') // Code
    await personaField(w, 'code').setValue('typed and not saved')
    await closeButton(w).trigger('click')
    await flushPromises()

    await keepEditingButton(w).trigger('click')
    await flushPromises()

    // The pair is gone and the card is back exactly where it was: same selection,
    // same form, same typing, nothing written.
    expect(keepEditingButton(w).exists()).toBe(false)
    expect(discardCloseButton(w).exists()).toBe(false)
    expect(w.find('dialog').element.open).toBe(true)
    expect(w.emitted('close')).toBeFalsy()
    expect(tabButton(w, 1).classes()).toContain('active')
    expect(personaField(w, 'code').element.value).toBe('typed and not saved')
    expect(calls).toEqual([])
    // The question is the guard's, so it leaves with the guard: the line is empty
    // again rather than still asking about a close that was refused.
    expect(messageText(w)).toBe('')
    // The verbs are live again, and the pencil's `@close` was never reached.
    expect(saveButton(w).element.disabled).toBe(false)
    // Focus went back to the verb that asked, not to `<body>`.
    expect(document.activeElement).toBe(closeButton(w).element)
    w.unmount()
  })

  it('focus returns to the toolbar when a delete pair is cancelled or answered', async () => {
    stubRoutes({
      agents: withScribeAndProofreader(),
      saves: { '/api/agents/delete': jsonResponse(withoutScribe()) },
    })
    const w = await openDialog()
    await tabButton(w, 4).trigger('click') // Scribe

    // Cancel: the Delete verb that asked takes focus back.
    await deleteSlotButton(w).trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(cancelDeleteButton(w).element)
    await cancelDeleteButton(w).trigger('click')
    await flushPromises()
    expect(document.activeElement).toBe(deleteSlotButton(w).element)

    // Confirm: the pair leaves the DOM, so focus lands on the successor tab the
    // delete selects — not at the start of the page.
    await deleteSlotButton(w).trigger('click')
    await flushPromises()
    await confirmDeleteButton(w).trigger('click')
    await flushPromises()
    const successor = w.find('.agent-modes-tab.active')
    expect(successor.exists()).toBe(true)
    expect(successor.text()).toBe('Proofreader')
    expect(document.activeElement).toBe(successor.element)
    w.unmount()
  })

  it('`Discard and close` closes the card and posts nothing', async () => {
    const calls = stubRoutes()
    const w = await openDialog()
    await labelField(w, 'chat').setValue('Chatting')
    await closeButton(w).trigger('click')
    await flushPromises()

    await discardCloseButton(w).trigger('click')
    await flushPromises()

    // It drops the in-memory form only: no write, and no store row touched.
    expect(w.emitted('close')).toBeTruthy()
    expect(calls).toEqual([])
    w.unmount()
  })

  it('a pending delete is abandoned when `Close` is clicked, and nothing was written', async () => {
    const calls = stubRoutes({ agents: withScribe() })
    const w = await openDialog()
    await tabButton(w, 4).trigger('click') // Scribe, the deletable row
    await deleteSlotButton(w).trigger('click')
    await flushPromises()
    expect(confirmDeleteButton(w).exists()).toBe(true)

    await closeButton(w).trigger('click')
    await flushPromises()

    // The delete is gone — nothing was written for it — and the guard answered on
    // its own terms: Scribe holds unsaved work? No, it was untouched, so the card
    // leaves at once, with the delete abandoned.
    expect(confirmDeleteButton(w).exists()).toBe(false)
    expect(cancelDeleteButton(w).exists()).toBe(false)
    expect(keepEditingButton(w).exists()).toBe(false)
    expect(w.emitted('close')).toBeTruthy()
    expect(calls).toEqual([])
    w.unmount()
  })

  it('a pending delete abandoned by `Close` still asks when there is unsaved work', async () => {
    const calls = stubRoutes({ agents: withScribe() })
    const w = await openDialog()
    await tabButton(w, 4).trigger('click')
    await personaField(w, 'scribe').setValue('typed and not saved')
    await deleteSlotButton(w).trigger('click')
    await flushPromises()

    await closeButton(w).trigger('click')
    await flushPromises()

    // One destructive decision at a time: the delete pair is gone, the close pair
    // is here, and neither has written anything.
    expect(confirmDeleteButton(w).exists()).toBe(false)
    expect(keepEditingButton(w).exists()).toBe(true)
    expect(calls).toEqual([])
    w.unmount()
  })

  it('the footer reserves the pair\'s slot: measured, `Close` does not move (§6.15, D10)', async () => {
    // Measured, not read out of the stylesheet: the shipped theme is applied to the
    // document and the *resolved* style of the real mounted elements is asked, so a
    // rule that let the pair's arrival change the band would show up here.
    const style = document.createElement('style')
    style.textContent = readFileSync(resolve('src/styles/theme.css'), 'utf8')
    document.head.appendChild(style)
    try {
      stubRoutes()
      const w = await openDialog()
      await labelField(w, 'chat').setValue('Chatting')

      const band = () => [...w.find('footer.settings-actions').element.children]
      const measure = () => ({
        // The band's elements, in order: the same three, whatever the slot holds.
        order: band().map((node) => node.className),
        // The reserved slot: a box that does not depend on its content — its
        // width *and* its height are declared, and its flex basis can neither
        // grow nor shrink, so the pair's arrival cannot resize the band.
        slotWidth: getComputedStyle(band()[1]).width,
        slotHeight: getComputedStyle(band()[1]).height,
        slotFlex: getComputedStyle(band()[1]).flex,
        // `Close` is the band's last element, and its own box is untouched.
        closeClass: band()[2].className,
        closeFlex: getComputedStyle(band()[2]).flex,
      })

      const before = measure()
      await closeButton(w).trigger('click')
      await flushPromises()
      const after = measure()

      expect(after).toEqual(before)
      // Not a vacuous comparison: the resolved values are the shipped rule's, so
      // a change that let the slot's box depend on its content moves one of them.
      expect(after.slotWidth).toBe('calc(36px + 36px + var(--bi-space-1))')
      expect(after.slotHeight).toBe('36px')
      expect(after.slotFlex).toBe('0 0 auto')
      expect(after.closeFlex).toBe('0 0 auto')
      // The pair arrived **inside** the slot that was already there, in the
      // toolbar's own fixed 36px boxes: the band gained no element.
      expect(keepEditingButton(w).exists()).toBe(true)
      expect(band()).toHaveLength(3)
      for (const slot of footerSlot(w).findAll('.agent-modes-slot')) {
        expect(getComputedStyle(slot.element).width).toBe('36px')
        expect(getComputedStyle(slot.element).height).toBe('36px')
        // And the glyph inside it keeps the icon button's box: the band's shared
        // rule gives a *text* button `width: auto`, which would otherwise squeeze
        // the pair's glyphs into something that is not the toolbar's idiom.
        expect(getComputedStyle(slot.find('button').element).width).toBe('36px')
      }
      // And the pair reads as the delete pair's idiom: the safe answer in red, the
      // confirming one in green, from the theme tokens (D8, D1).
      expect(
        getComputedStyle(keepEditingButton(w).find('svg').element).stroke,
      ).toBe('var(--bi-danger)')
      expect(
        getComputedStyle(discardCloseButton(w).find('svg').element).stroke,
      ).toBe('var(--bi-success)')
      w.unmount()
    } finally {
      style.remove()
    }
  })
})

// ---------------------------------------------------------------------------
// The toolbar (D1, D2, D9).
//
// Five fixed-width slots over the list — three verbs at the left, the two
// confirmation slots at its right end. Each present slot is an icon button whose
// **accessible name is its tooltip**, both read from the same verdict, and an
// inert one always says why. The glyphs are the app's own inline SVGs: no icon
// dependency was added and the tree's generated icon artifacts are untouched.
// ---------------------------------------------------------------------------

describe('the toolbar over the list (D1, D9)', () => {
  it('the card is titled `Agents` and its accessible name follows', async () => {
    stubRoutes()
    const w = await openDialog()

    expect(w.find('#agent-modes-title').text()).toBe('Agents')
    expect(w.find('dialog').attributes('aria-labelledby')).toBe('agent-modes-title')
    w.unmount()
  })

  it('sits above the list in the left column, with the form beside it', async () => {
    stubRoutes()
    const w = await openDialog()

    const body = w.find('.agent-modes-body')
    // The body's four parts are the grid's: heading, toolbar and list in the left
    // column, the form in the right one — no wrapper column to scroll with.
    expect(
      [...body.element.children].map((node) => node.className),
    ).toEqual([
      'agent-modes-heading',
      'agent-modes-toolbar',
      'settings-nav agent-modes-nav',
      'settings-editor agent-modes-editor',
    ])
    // The heading above the toolbar reads `Agents` too (D4.4), in every state.
    expect(w.find('.agent-modes-heading').text()).toBe('Agents')
    w.unmount()
  })

  it('the heading reads `Agents` in every state, creation mode included', async () => {
    stubRoutes()
    const w = await openDialog()

    expect(w.find('.agent-modes-heading').text()).toBe('Agents')
    await addButton(w).trigger('click')
    await flushPromises()
    expect(w.find('.agent-modes-heading').text()).toBe('Agents')
    expect(w.find('#agent-modes-title').text()).toBe('Agents')
    w.unmount()
  })

  it('holds five fixed-width slots, three of them verbs', async () => {
    stubRoutes()
    const w = await openDialog()

    const slots = toolbarSlots(w)
    expect(slots).toHaveLength(5)
    // The three verbs are always in the first three slots — delete disabled with
    // its reason, never hidden (D1). The confirmation pair's two slots are empty
    // until a confirmation is pending (§6.17) — absent, not hidden.
    expect(slots[0].find('button').classes()).toContain('agent-modes-add')
    expect(slots[1].find('button').classes()).toContain('agent-modes-save')
    expect(slots[2].find('button').classes()).toContain('agent-modes-delete')
    expect(slots[3].find('button').exists()).toBe(false)
    expect(slots[4].find('button').exists()).toBe(false)
    // Every slot keeps its width whether or not it holds a button (D10).
    for (const slot of slots) {
      expect(slot.classes()).toContain('agent-modes-slot')
    }
    w.unmount()
  })

  it('the three verbs are house icon buttons: an inline glyph, named, no icon package', async () => {
    stubRoutes()
    const w = await openDialog()

    for (const button of [addButton(w), saveButton(w), deleteSlotButton(w)]) {
      expect(button.classes()).toContain('icon-btn')
      const glyph = button.find('svg')
      expect(glyph.exists()).toBe(true)
      // The glyph is decorative: the button's own name says what it does.
      expect(glyph.attributes('aria-hidden')).toBe('true')
      // §6.16: the accessible name and the tooltip are the same words.
      expect(button.attributes('aria-label')).toBe(button.attributes('title'))
    }
    // No dependency was added for these five glyphs.
    const manifest = JSON.parse(readFileSync(resolve('package.json'), 'utf8'))
    expect(Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }))
      .not.toContain('@iconify/vue')
    w.unmount()
  })

  it('the three slots say their own names when they are live', async () => {
    stubRoutes({ agents: withScribe() })
    const w = await openDialog()
    await tabButton(w, 4).trigger('click') // Scribe: the deletable row

    expect(addButton(w).attributes('aria-label')).toBe('Add agent')
    expect(addButton(w).element.disabled).toBe(false)
    expect(saveButton(w).attributes('aria-label')).toBe('Save agent')
    expect(saveButton(w).element.disabled).toBe(false)
    expect(deleteSlotButton(w).attributes('aria-label')).toBe('Delete agent')
    expect(deleteSlotButton(w).element.disabled).toBe(false)
    w.unmount()
  })

  it('an inert slot always says why, in the words a reader and a hover both get', async () => {
    stubRoutes({ agents: null })
    const w = await openDialog()

    // Nothing was read: all three verbs are inert, and each explains itself.
    for (const button of [addButton(w), saveButton(w), deleteSlotButton(w)]) {
      expect(button.element.disabled).toBe(true)
      expect(button.attributes('title')).toContain('not been read')
      expect(button.attributes('aria-label')).toBe(button.attributes('title'))
    }
    w.unmount()
  })

  it('the save slot reads `Saving…` as its name **and** its tooltip together', async () => {
    let release = null
    const pending = new Promise((resolve) => {
      release = resolve
    })
    stubRoutes({ saves: { '/api/agents/save': pending } })
    const w = await openDialog()

    const clicked = saveButton(w).trigger('click')
    await flushPromises()

    expect(saveButton(w).attributes('title')).toBe('Saving…')
    expect(saveButton(w).attributes('aria-label')).toBe('Saving…')
    expect(saveButton(w).element.disabled).toBe(true)

    release(jsonResponse(agentsBody()))
    await clicked
    await flushPromises()

    // Both go back together when the write lands.
    expect(saveButton(w).attributes('title')).toBe('Save agent')
    expect(saveButton(w).attributes('aria-label')).toBe('Save agent')
    w.unmount()
  })

  it('in creation mode save is live and the other two verbs are inert', async () => {
    stubRoutes()
    const w = await openDialog()
    await addButton(w).trigger('click')
    await flushPromises()

    // §5's signature of creation mode: save is live, delete is not, and nothing
    // is selected — and add is inert because a creation is already being typed.
    expect(saveButton(w).element.disabled).toBe(false)
    expect(addButton(w).element.disabled).toBe(true)
    expect(deleteSlotButton(w).element.disabled).toBe(true)
    expect(deleteSlotButton(w).attributes('title')).toContain('before it can be deleted')
    w.unmount()
  })

  it('renders no Edit button anywhere — the selection is the edit mode (D2)', async () => {
    stubRoutes()
    const w = await openDialog()

    expect(w.text()).not.toMatch(/\bEdit\b/)
    // Clicking a row shows that agent's form; that is the only way in.
    await tabButton(w, 2).trigger('click')
    expect(tabButton(w, 2).classes()).toContain('active')
    expect(creationSection(w).exists()).toBe(false)
    expect(w.find('.agent-modes-editor').element.querySelectorAll('section[style*="display: none"]').length)
      .toBeGreaterThan(0)
    w.unmount()
  })
})

// ---------------------------------------------------------------------------
// Task 06: nothing moves (D10, §6.19), every slot says one thing (§6.16), the
// pairs are absent until they mean something (§6.17), and no rule of the old
// card is left behind styling nothing.
//
// This is the sweep that *proves* the rework's governing rule instead of
// restating it: the shipped theme is applied to the document, the card is
// mounted for real, driven through every state §5 lists, and the resolved box
// of each element the rule protects is compared **between** those states.
// ---------------------------------------------------------------------------

//: The one string each slot says when it is live. An inert slot's tooltip must be
//: something else — the reason — and this is how the sweep tells the two apart
//: without re-spelling every reason the composable owns.
const LIVE_SLOT_LABELS = {
  'agent-modes-add': 'Add agent',
  'agent-modes-save': 'Save agent',
  'agent-modes-delete': 'Delete agent',
  'agent-modes-cancel-delete': 'Cancel delete',
  'agent-modes-confirm-delete': 'Confirm delete',
  'agent-modes-keep-editing': 'Keep editing',
  'agent-modes-discard-close': 'Discard and close',
}

function slotButtons(w) {
  return [
    ...toolbar(w).findAll('button'),
    ...footerSlot(w).findAll('button'),
  ]
}

describe('the geometry sweep: nothing moves (§6.19, D10)', () => {
  it('the shipped numbers are the ones measured — so the comparisons below are not vacuous', async () => {
    applyShippedTheme()
    stubRoutes({ agents: withScribe() })
    const w = await openDialog()
    const geometry = cardGeometry(w)

    // The card's own box: fixed, so no state can resize the dialog.
    expect(geometry.card.width).toBe('900px')
    expect(geometry.card.height).toBe('600px')
    // The body's rows: only the list's is flexible, so the toolbar's row is the
    // heading's and the toolbar's own height — never the list's content.
    expect(geometry.body.gridTemplateRows).toBe('auto auto minmax(0, 1fr)')
    expect(geometry.toolbar.gridArea).toBe('2 / 1')
    expect(geometry.list.gridArea).toBe('3 / 1')
    expect(geometry.form.gridArea).toBe('2 / 2 / 4 / 3')
    // Every slot is a fixed box, negotiated with nothing.
    for (const slot of geometry.slotBoxes) {
      expect(slot.width).toBe('36px')
      expect(slot.height).toBe('36px')
      expect(slot.flex).toBe('0 0 36px')
    }
    // The footer's three children: a message that stretches instead of growing,
    // a reserved slot whose width *and* height are declared, and a `Close` that
    // takes its own width and neither grows nor shrinks.
    expect(geometry.message.flex).toBe('1 1 auto')
    expect(geometry.message.alignSelf).toBe('stretch')
    // §6.1's "one `Close` button on the right": the band is right-aligned and the
    // message line is its first child (the case above the geometry sweep), so the
    // one button the band holds sits at its right end. This is the value that makes
    // that order a *position* rather than a DOM sequence.
    expect(geometry.footer.justifyContent).toBe('flex-end')
    expect(geometry.footerChildren[1]).toContain('"width":"calc(36px + 36px + var(--bi-space-1))"')
    expect(geometry.footerChildren[1]).toContain('"height":"36px"')
    expect(geometry.footerChildren[1]).toContain('"flex":"0 0 auto"')
    expect(geometry.footerChildren[2]).toContain('"flex":"0 0 auto"')
    w.unmount()
  })

  it('the first three slots, the toolbar, the list and the card hold still across every state in §5', async () => {
    applyShippedTheme()
    stubRoutes({ agents: withScribe() })
    const w = await openDialog()
    const states = await walkStates(w)

    // Not a short list: the states §5's rows describe, each reached by a gesture.
    expect(states.map((state) => state.label)).toEqual([
      'a stored agent selected, untouched',
      'a stored agent selected, edited',
      'the form holds a problem',
      'the app-owned agent selected',
      'creation mode',
      'a stored agent selected again',
      'a delete confirmation pending',
      'the delete cancelled',
      'a close confirmation pending',
      'the close refused',
    ])

    const first = states[0].geometry
    for (const { label, geometry } of states) {
      // The three verbs' slot boxes and the buttons inside them: their x is the
      // toolbar's start plus the slots before them, all of which are fixed, so an
      // identical box in every state is an identical position.
      expect(geometry.slotBoxes, `slots moved in: ${label}`).toEqual(first.slotBoxes)
      expect(geometry.verbBoxes, `verbs moved in: ${label}`).toEqual(first.verbBoxes)
      // The toolbar's height is its tallest child's, and its children are the
      // five fixed slots and the flexible spacer — so it is 36px in every state,
      // with and without the delete pair rendered.
      expect(geometry.toolbar, `the toolbar changed in: ${label}`).toEqual(first.toolbar)
      // The list's top edge is the heading's row plus the toolbar's row, so both
      // of those and the body's rows are measured.
      expect(geometry.body, `the body changed in: ${label}`).toEqual(first.body)
      expect(geometry.list, `the list moved in: ${label}`).toEqual(first.list)
      // The card keeps the size it has today, so switching selection never
      // resizes the dialog.
      expect(geometry.card, `the card resized in: ${label}`).toEqual(first.card)
      // The footer band: its own box, its three children with their boxes, and
      // the message line inside it. These states include an empty line, a filled
      // one, and each pair pending, so the band is measured against all of them.
      expect(geometry.footer, `the footer band changed in: ${label}`).toEqual(first.footer)
      expect(geometry.footerChildren, `the band reflowed in: ${label}`).toEqual(
        first.footerChildren,
      )
      expect(geometry.message, `the message line changed in: ${label}`).toEqual(first.message)
    }

    // The measurements are not between states that all lacked the pairs: the
    // toolbar held three buttons, then five, then three again, and the footer's
    // band held one button, then three. The boxes compared above were identical
    // through all of it.
    expect(states.map((state) => state.geometry.toolbarButtons)).toEqual([
      3, 3, 3, 3, 3, 3, 5, 3, 3, 3,
    ])
    expect(states.map((state) => state.geometry.footerButtons)).toEqual([
      1, 1, 1, 1, 1, 1, 1, 1, 3, 1,
    ])
    w.unmount()
  })

  it('the toolbar holds nothing but fixed slots and the spacer, in every state', async () => {
    applyShippedTheme()
    stubRoutes({ agents: withScribe() })
    const w = await openDialog()

    const shape = () =>
      [...toolbar(w).element.children].map((node) => {
        const s = getComputedStyle(node)
        return `${node.className}|${s.width}|${s.height}|${s.flex}|${s.minWidth}`
      })

    const idle = shape()
    expect(idle).toEqual([
      'agent-modes-slot|36px|36px|0 0 36px|auto',
      'agent-modes-slot|36px|36px|0 0 36px|auto',
      'agent-modes-slot|36px|36px|0 0 36px|auto',
      // The only flexible item: it gives way, so a slot's width is never
      // negotiated with anything and the pair's slots keep their place.
      'agent-modes-toolbar-space|auto|auto|1 1 auto|0px',
      'agent-modes-slot|36px|36px|0 0 36px|auto',
      'agent-modes-slot|36px|36px|0 0 36px|auto',
    ])

    await tabButton(w, 4).trigger('click')
    await deleteSlotButton(w).trigger('click')
    await flushPromises()
    // The same six children, the same six boxes: the pair arrived *inside* two of
    // the slots that were already there.
    expect(shape()).toEqual(idle)
    w.unmount()
  })

  it('`Close`, the footer band and the list hold still with an empty and a filled message, and with each pair pending', async () => {
    applyShippedTheme()
    stubRoutes({ agents: withScribe() })
    const w = await openDialog()

    const band = () => cardGeometry(w).footerChildren
    const list = () => cardGeometry(w).list

    // Empty message line.
    expect(messageText(w)).toBe('')
    const empty = band()

    // Filled message line: the same three children with the same boxes, because
    // the line stretches to the band instead of setting its height.
    await labelField(w, 'chat').setValue('')
    expect(messageText(w)).toContain('must be completed')
    expect(band()).toEqual(empty)
    expect(list()).toEqual(cardGeometry(w).list)

    // A pending delete confirmation: the toolbar's pair, and the band untouched.
    await tabButton(w, 4).trigger('click')
    await deleteSlotButton(w).trigger('click')
    await flushPromises()
    expect(cancelDeleteButton(w).exists()).toBe(true)
    expect(band()).toEqual(empty)
    await cancelDeleteButton(w).trigger('click')
    await flushPromises()

    // A pending close confirmation: the pair arrives **inside** the slot that was
    // already there, so `Close` keeps its box and the band gains no child.
    await closeButton(w).trigger('click')
    await flushPromises()
    expect(keepEditingButton(w).exists()).toBe(true)
    expect(band()).toEqual(empty)
    expect(w.find('footer.settings-actions').element.children).toHaveLength(3)

    // And the list's top edge answers the same in every one of those states.
    expect(list()).toEqual(cardGeometry(w).list)
    w.unmount()
  })

  it('the two states that need their own mount measure the same card', async () => {
    // §5's first and last rows: a read that answered nothing, and a read that
    // answered an empty list. Neither can be reached from a mounted card, so
    // each is mounted on its own — and each still shows the same toolbar, the
    // same five slots and the same footer band, because the card renders its
    // body whatever the read answered (the message line is what changes).
    applyShippedTheme()
    stubRoutes({ agents: withScribe() })
    const idleWrapper = await openDialog()
    const idle = cardGeometry(idleWrapper)
    idleWrapper.unmount()

    const emptyBody = { agents: [], caps: CAPS, findings: [] }
    for (const [label, agents] of [
      ['nothing loaded', null],
      ['the list came back empty', emptyBody],
    ]) {
      stubRoutes({ agents })
      const w = await openDialog()
      const geometry = cardGeometry(w)
      expect(geometry.slotBoxes, `${label}: the slots moved`).toEqual(idle.slotBoxes)
      expect(geometry.toolbar, `${label}: the toolbar moved`).toEqual(idle.toolbar)
      expect(geometry.list, `${label}: the list moved`).toEqual(idle.list)
      expect(geometry.footerChildren, `${label}: the band reflowed`).toEqual(
        idle.footerChildren,
      )
      expect(geometry.card, `${label}: the card resized`).toEqual(idle.card)
      // Anything either state has to say is said in the one line — the card
      // renders its body whatever the read answered, so the geometry above is
      // the same card with different words in its slot.
      expect(w.findAll('.agent-modes-message')).toHaveLength(1)
      w.unmount()
    }
  })
})

describe('the accessible names and the absent pairs (§6.16, §6.17)', () => {
  it('every rendered slot button, in every state, has a name equal to its tooltip', async () => {
    stubRoutes({ agents: withScribe() })
    const w = await openDialog()

    const checked = []
    const sweep = (where) => {
      for (const button of slotButtons(w)) {
        const name = button.attributes('aria-label')
        const tooltip = button.attributes('title')
        // The equality, not the two strings: an edit to one side fails here.
        expect(name, `${where}: a slot has no accessible name`).toBeTruthy()
        expect(name, `${where}: name and tooltip disagree`).toBe(tooltip)
        checked.push(button.classes().find((c) => LIVE_SLOT_LABELS[c]))
      }
    }

    sweep('idle')
    await tabButton(w, 4).trigger('click')
    await deleteSlotButton(w).trigger('click')
    await flushPromises()
    sweep('a delete confirmation pending')
    expect(cancelDeleteButton(w).exists()).toBe(true)
    expect(confirmDeleteButton(w).exists()).toBe(true)
    await cancelDeleteButton(w).trigger('click')
    await flushPromises()
    // The guard only asks when something would be lost, so the close pair's state
    // has to be reached the way a user reaches it: with typing in the card.
    await personaField(w, 'scribe').setValue('typed')
    await flushPromises()
    await closeButton(w).trigger('click')
    await flushPromises()
    sweep('a close confirmation pending')
    expect(keepEditingButton(w).exists()).toBe(true)
    expect(discardCloseButton(w).exists()).toBe(true)

    // All seven spellings were reached, so no slot escaped the equality check.
    expect([...new Set(checked)].sort()).toEqual(Object.keys(LIVE_SLOT_LABELS).sort())
    w.unmount()
  })

  it('the save slot keeps name and tooltip together while the word is `Saving…`', async () => {
    // The state an equality written only against the idle label would miss: the
    // string is different there, and both places must carry it.
    let release = null
    const pending = new Promise((resolve) => {
      release = resolve
    })
    stubRoutes({ agents: withScribe(), saves: { '/api/agents/save': pending } })
    const w = await openDialog()
    // A deletable row, so the delete slot's reason here is the write itself and
    // not the row's own flag.
    await tabButton(w, 4).trigger('click')

    const clicked = saveButton(w).trigger('click')
    await flushPromises()

    expect(saveButton(w).attributes('aria-label')).toBe(saveButton(w).attributes('title'))
    expect(saveButton(w).attributes('title')).toBe('Saving…')
    expect(saveButton(w).element.disabled).toBe(true)
    // The other two verbs are inert for the same write, and each says so.
    for (const button of [addButton(w), deleteSlotButton(w)]) {
      expect(button.element.disabled).toBe(true)
      expect(button.attributes('aria-label')).toBe(button.attributes('title'))
      expect(button.attributes('title')).toContain('write is in flight')
    }

    release(jsonResponse(agentsBody()))
    await clicked
    await flushPromises()
    expect(saveButton(w).attributes('aria-label')).toBe(saveButton(w).attributes('title'))
    w.unmount()
  })

  it('every disabled slot explains itself, in words that are not its live name', async () => {
    stubRoutes({ agents: withScribe() })
    const w = await openDialog()

    const sweep = (where) => {
      for (const button of slotButtons(w)) {
        if (!button.element.disabled) continue
        const key = button.classes().find((c) => LIVE_SLOT_LABELS[c])
        expect(key, `${where}: a slot carries no known verb class`).toBeTruthy()
        const reason = button.attributes('title')
        expect(reason, `${where}: an inert slot says nothing`).toBeTruthy()
        expect(reason, `${where}: an inert slot repeats its live name`).not.toBe(
          LIVE_SLOT_LABELS[key],
        )
        expect(button.attributes('aria-label')).toBe(reason)
      }
    }

    sweep('a built-in selected')
    await addButton(w).trigger('click')
    await flushPromises()
    sweep('creation mode')
    await tabButton(w, 4).trigger('click')
    await deleteSlotButton(w).trigger('click')
    await flushPromises()
    sweep('a delete confirmation pending')
    await cancelDeleteButton(w).trigger('click')
    await flushPromises()
    await personaField(w, 'scribe').setValue('typed')
    await closeButton(w).trigger('click')
    await flushPromises()
    sweep('a close confirmation pending')
    expect(keepEditingButton(w).exists()).toBe(true)
    w.unmount()
  })

  it('every glyph is decorative, so it is never announced on top of the name', async () => {
    stubRoutes({ agents: withScribe() })
    const w = await openDialog()

    const sweep = () => {
      const glyphs = [...toolbar(w).element.querySelectorAll('svg'), ...footerSlot(w).element.querySelectorAll('svg')]
      expect(glyphs.length).toBeGreaterThan(0)
      for (const glyph of glyphs) {
        expect(glyph.getAttribute('aria-hidden')).toBe('true')
        expect(glyph.getAttribute('role')).toBeNull()
        expect(glyph.getAttribute('title')).toBeNull()
      }
    }

    sweep()
    await tabButton(w, 4).trigger('click')
    await deleteSlotButton(w).trigger('click')
    await flushPromises()
    sweep()
    expect(toolbar(w).element.querySelectorAll('svg')).toHaveLength(5)
    await cancelDeleteButton(w).trigger('click')
    await flushPromises()
    await personaField(w, 'scribe').setValue('typed')
    await flushPromises()
    await closeButton(w).trigger('click')
    await flushPromises()
    sweep()
    expect(footerSlot(w).element.querySelectorAll('svg')).toHaveLength(2)
    w.unmount()
  })

  it('both confirmation pairs are absent from the DOM until their confirmation is pending (§6.17)', async () => {
    stubRoutes({ agents: withScribe() })
    const w = await openDialog()

    // Absent, not hidden: no element, so nothing focusable and nothing announced.
    expect(w.findAll('.agent-modes-cancel')).toHaveLength(0)
    expect(w.findAll('.agent-modes-confirm')).toHaveLength(0)
    expect(w.find('footer').element.querySelectorAll('button')).toHaveLength(1)

    await tabButton(w, 4).trigger('click')
    await deleteSlotButton(w).trigger('click')
    await flushPromises()
    expect(w.findAll('.agent-modes-cancel')).toHaveLength(1)
    expect(w.findAll('.agent-modes-confirm')).toHaveLength(1)
    await cancelDeleteButton(w).trigger('click')
    await flushPromises()
    expect(w.findAll('.agent-modes-cancel')).toHaveLength(0)
    expect(w.findAll('.agent-modes-confirm')).toHaveLength(0)

    // The close pair's question needs something to lose, so the card holds typing
    // before it is asked — and the pair is still absent until then.
    await personaField(w, 'scribe').setValue('typed')
    await closeButton(w).trigger('click')
    await flushPromises()
    expect(w.findAll('.agent-modes-cancel')).toHaveLength(1)
    expect(w.findAll('.agent-modes-confirm')).toHaveLength(1)
    w.unmount()
  })

  it('the card\'s CSS and the card\'s classes agree — no rule styles nothing', async () => {
    // Checked mechanically rather than by eye: every `agent-modes` class the
    // theme's block selects must be a class the mounted card actually renders
    // (in some state), and every class the card renders that the block does
    // *not* select must be one of the listed hooks — a class with no rule of
    // its own is fine, a rule with no element is the leftover the next reader
    // trusts as documentation.
    const css = readFileSync(resolve('src/styles/theme.css'), 'utf8')
    const block = css.slice(
      css.indexOf('/* -- agent-modes dialog'),
      css.indexOf('/* -- tab navigation'),
    )
    expect(block, 'the agent-modes block is not readable').not.toBe(css)
    // Selector text only: a comment that names a class is not a rule for it.
    const selectors = block.replace(/\/\*[\s\S]*?\*\//g, '').replace(/{[^{}]*}/g, '')
    const styled = [...new Set([...selectors.matchAll(/agent-modes[a-z0-9_-]*/g)].map((m) => m[0]))].sort()

    // Every state that renders something the others do not: a broken row, and
    // each confirmation pair.
    stubRoutes({ agents: withScribe() })
    const w = await openDialog()
    await labelField(w, 'chat').setValue('')
    const rendered = new Set()
    const harvest = () => {
      for (const el of w.find('dialog').element.querySelectorAll('*')) {
        for (const cls of el.classList) if (cls.startsWith('agent-modes')) rendered.add(cls)
      }
      for (const cls of w.find('dialog').element.classList) rendered.add(cls)
    }
    harvest()
    await tabButton(w, 4).trigger('click')
    await deleteSlotButton(w).trigger('click')
    await flushPromises()
    harvest()
    await cancelDeleteButton(w).trigger('click')
    await flushPromises()
    await closeButton(w).trigger('click')
    await flushPromises()
    harvest()
    w.unmount()

    for (const cls of styled) {
      expect(rendered.has(cls), `theme.css styles ${cls}, which the card never renders`).toBe(true)
    }
    // The other direction, spelled out: these are the card's hooks — the slots
    // and rows the suites reach by class, and the fields styled by a shared rule
    // (`.icon-btn`, `.caption`, `.settings-nav button`, `.settings-actions
    // button`). A new one is a decision, not an accident.
    const hooks = [...rendered].filter((cls) => !styled.includes(cls)).sort()
    expect(hooks).toEqual([
      'agent-modes-add',
      'agent-modes-cancel-delete',
      'agent-modes-close',
      'agent-modes-confirm-delete',
      'agent-modes-delete',
      'agent-modes-discard-close',
      'agent-modes-form',
      'agent-modes-keep-editing',
      'agent-modes-persona-count',
      'agent-modes-save',
      'agent-modes-tab',
    ])
  })
})

describe('what this component is not allowed to be', () => {
  const source = () => readFileSync(resolve('src/components/AgentModesDialog.vue'), 'utf8')

  it('names no reserved agent id, no cap and no route of its own', () => {
    const text = source()
    // The reserved id is read out of the Python module rather than hardcoded
    // here, so this check cannot be satisfied by a different string.
    const python = readFileSync(resolve('../src/core/agent_modes.py'), 'utf8')
    const declaration = /RESERVED_MODE_IDS[^=]*=\s*\(([^)]*)\)/.exec(python)
    expect(declaration, 'agent_modes.RESERVED_MODE_IDS is not readable').toBeTruthy()
    for (const match of declaration[1].matchAll(/"([^"]+)"/g)) {
      expect(text, `the component names the reserved agent id ${match[1]}`).not.toContain(match[1])
    }
    // No cap is spelled in the client: every number arrives in the payload.
    expect(text).not.toContain('16384')
    // The dialog reaches the store through the composable's own calls only, so
    // it spells **no route at all** — the write-marker scan
    // (`tests/test_write_surface_isolation.py`) allows those spellings in the
    // composable alone.
    expect(text).not.toContain('/api/')
    expect(text).not.toContain('/api/fs')
  })

  it('decides "readonly" from the flag — never by comparing an id', () => {
    const text = source()
    // No equality test against an id anywhere: `readonly` and `deletable` are
    // the whole vocabulary.
    expect(text).not.toMatch(/id\s*===\s*'/)
    expect(text).not.toMatch(/id\s*===\s*"/)
    // The delete verb's answer is the composable's, and it is the verdict that
    // carries the reason too (D1) — the card never re-derives either.
    expect(text).toContain('deleteSlotFor')
    expect(text).toContain('fieldsDisabledFor')
    // And the message line's content is `messageFor`'s, never a template chain.
    expect(text).toContain('messageFor')
  })

  it('the close guard is the composable\'s answer, never a condition of its own (D3, D8)', () => {
    const text = source()
    // Both halves of the guard are verdicts: *would closing lose something*, and
    // the pair's two labels. The card renders them and decides nothing — and the
    // baseline is read nowhere else, which is what keeps it off the save path.
    expect(text).toContain('closeWouldLoseForDraft')
    expect(text).toContain('closeConfirmationFor')
    // The per-entry baseline is never read here: the card asks the verdict and
    // never compares fields itself, which is what keeps it off the save path.
    expect(text).not.toMatch(/\.baseline/)
    // The two pairs' labels come from one value each (name and tooltip cannot
    // drift), so neither pair's wording is spelled in the **template**: a card
    // that wrote its own sentence would own a second copy of the composable's.
    const template = /<template>[\s\S]*<\/template>/.exec(text)[0]
    expect(template).not.toMatch(/Keep editing|Discard and close/)
    expect(template).not.toMatch(/Cancel delete|Confirm delete/)
    // The pending-close state is the card's own, and the template reads only the
    // verdict built from it: no verb's availability is spelled there.
    expect(template).toMatch(/v-if="closeConfirmation\.rendered"/)
    expect(template).not.toMatch(/v-if="pendingClose/)
  })

  it('renders field text only — no raw v-html anywhere', () => {
    expect(source()).not.toContain('v-html')
  })

  it('the per-agent form holds no delete affordance — the verb is the toolbar\'s', () => {
    // D7 moves the verb and its confirm out of the form rather than keeping both
    // homes: an old class left beside the new one would be a second delete the
    // sweep of task 06 could never tell apart from a live one.
    const text = source()
    expect(text).not.toContain('agent-modes-delete-button')
    expect(text).not.toContain('agent-modes-delete-yes')
    expect(text).not.toContain('agent-modes-delete-confirm')
    expect(text).not.toContain('agent-modes-actions')
    expect(text).not.toContain('Keep it')
    // The toolbar's own hooks are the only delete spellings, and the pair's
    // verdict comes from the composable (D3): the card renders its answer.
    expect(text).toContain('deleteConfirmationFor')
    expect(text).toContain('successorAfterDelete')
  })

  it('the nav\'s create field, its button and the draft-appending call are gone', () => {
    // D4 removes them rather than hiding them: a new agent is a form with no row,
    // so nothing may still append one to the list or type its label somewhere the
    // card does not read it back.
    const text = source()
    expect(text).not.toContain('agent-modes-create')
    expect(text).not.toContain('Create agent')
    expect(text).not.toContain('addAgentToDraft')
    // And not in the composable either — that is how the new-agent-in-the-list
    // rule would grow back.
    const composable = readFileSync(resolve('src/composables/useAgentModes.js'), 'utf8')
    expect(composable).not.toContain('addAgentToDraft')
  })

  it('the save verdict the rework renamed is gone from both files', () => {
    // D3 splits `saveDisabledFor` into `writeBlockedFor` (the slot's enablement)
    // and `saveRefusalFor` (the click's refusal), and the lot **renames** rather
    // than reusing the name: a verdict called "disabled" that an incomplete form
    // deliberately does *not* disable would keep the lie the rework removes. The
    // two new names are judged where their behaviour lives (the composable's
    // suite), so only the old one needs a scan.
    const composable = readFileSync(resolve('src/composables/useAgentModes.js'), 'utf8')
    for (const [name, contents] of [
      ['the component', source()],
      ['the composable', composable],
    ]) {
      expect(contents, `${name} still spells the renamed save verdict`).not.toContain(
        'saveDisabledFor',
      )
    }
  })

  it('sizes the article, never the dialog element', () => {
    const dialogTag = /<dialog[\s\S]*?>/.exec(source())
    expect(dialogTag[0]).not.toMatch(/style=/)
  })

  it('the scan over web/src covers it (the tree walk reaches components)', () => {
    // The reserved-id scan (`agentModes.test.js`) walks `web/src` in full, so a
    // new component is inside it without being added to anything. What could
    // silently leave this file out is that scan's extension filter, so *that* is
    // what is asserted here — the scan's own list, read from the file that owns
    // it rather than copied (a second copy of a guard is how a guard drifts).
    const scan = readFileSync(resolve('tests/agentModes.test.js'), 'utf8')
    const extensions = /SCANNED_EXTENSIONS = \[([^\]]*)\]/.exec(scan)
    expect(extensions, 'the reserved-id scan is not readable').toBeTruthy()
    expect(extensions[1]).toContain("'.vue'")
    expect(scan).toContain("walk(join(resolve(), 'src'))")
  })
})
