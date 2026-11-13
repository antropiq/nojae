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
// *what is on screen*: one tab per agent the **store** holds, a `readonly`
// agent's fields disabled with its model live, the model dropdown's empty option
// as an explicit choice, the problems sitting next to the field they name, and
// what a click does to the three routes.
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
  body.agents.push({
    id: 'scribe',
    label: 'Scribe',
    mcpEnable: false,
    lspEnable: false,
    systemMessage: '',
    readonly: false,
    deletable: true,
    maxToolIteration: 25,
    modelId: null,
    modelName: null,
  })
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
function stubRoutes({ agents = agentsBody(), saves = {}, calls = [] } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const key = String(url)
    if (key === '/api/agents') return jsonResponse(agents)
    if (key === '/api/servers') return jsonResponse(SERVERS)
    if (key.startsWith('/api/agents/')) {
      calls.push({ key, body: JSON.parse(init.body) })
      const answer = saves[key]
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
  editor.error = null
  editor.serverFindings = []
  const shell = useAppShell().state
  shell.servers = []
  shell.serversCaps = null
  shell.serversError = null
}

// The nav's *tabs* only — the Create button lives in the same nav but is not a
// tab, so the selector is the hook the component puts on each one.
function tabs(w) {
  return w.findAll('.agent-modes-tab').map((node) => node.text())
}

function tabButton(w, index) {
  return w.findAll('.agent-modes-tab')[index]
}

function section(w, id) {
  return w.find(`section[data-tab="${id}"]`)
}

function saveButton(w) {
  return w.find('.agent-modes-save')
}

function createButton(w) {
  return w.find('.agent-modes-create-button')
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

function fieldFindings(w, id) {
  return section(w, id).findAll('.agent-modes-field-finding').map((node) => node.text())
}

function buttonByText(w, text) {
  return w.findAll('button').filter((node) => node.text() === text)[0]
}

beforeEach(() => {
  Element.prototype.showModal = function showModal() {
    this.open = true
  }
  Element.prototype.close = function close() {
    this.open = false
  }
  resetEditor()
  window.localStorage.clear()
  vi.restoreAllMocks()
})

afterEach(() => {
  host?.remove()
  host = null
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

    await w.find('.agent-modes-create input').setValue('Reviewer')
    await createButton(w).trigger('click')

    const created = section(w, 'reviewer')
    expect(created.exists()).toBe(true)
    // The new agent's id is the one the slug generated, and it is live: the
    // user may still correct it before the row exists.
    expect(idField(w, 'reviewer').exists()).toBe(true)
    expect(idField(w, 'reviewer').attributes('disabled')).toBeUndefined()
    expect(idField(w, 'reviewer').element.value).toBe('reviewer')
    expect(labelField(w, 'reviewer').element.value).toBe('Reviewer')
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
  it('renders every field disabled, except the model, and says why once', async () => {
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

    // One caption, naming no agent.
    expect(reserved.findAll('.agent-modes-readonly')).toHaveLength(1)
    expect(reserved.find('.agent-modes-readonly').text()).toContain('belong to nojae')
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

describe('the form-level problems (§5.2)', () => {
  it('a problem sits next to the field it names and disables Save', async () => {
    stubRoutes()
    const w = await openDialog()

    await labelField(w, 'chat').setValue('')
    expect(saveButton(w).element.disabled).toBe(true)
    expect(fieldFindings(w, 'chat')).toEqual(['A label is required.'])
    expect(w.find('.agent-modes-blocking-note').text()).toContain('1 problem')

    await labelField(w, 'chat').setValue('Chat')
    expect(saveButton(w).element.disabled).toBe(false)
    expect(fieldFindings(w, 'chat')).toEqual([])
    w.unmount()
  })

  it('a duplicate label is refused, and the mark lands on that tab', async () => {
    stubRoutes()
    const w = await openDialog()

    await labelField(w, 'chat').setValue('Code')
    expect(saveButton(w).element.disabled).toBe(true)
    expect(fieldFindings(w, 'chat')[0]).toContain('already labelled')
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

  it('a persona over the byte cap blocks Save next to its field', async () => {
    stubRoutes()
    const w = await openDialog()
    await tabButton(w, 2).trigger('click') // Architect

    await personaField(w, 'architect').setValue('x'.repeat(CAPS.maxPersonaBytes + 1))
    expect(saveButton(w).element.disabled).toBe(true)
    expect(fieldFindings(w, 'architect')[0]).toContain('over the')
    w.unmount()
  })

  it('a cap below the floor blocks Save, and the number is the payload\'s', async () => {
    stubRoutes()
    const w = await openDialog()
    await tabButton(w, 1).trigger('click') // Code

    const capInput = section(w, 'code').find('input[type="number"]')
    await capInput.setValue('0')
    expect(saveButton(w).element.disabled).toBe(true)
    expect(fieldFindings(w, 'code')[0]).toContain('at least 1')

    await capInput.setValue('500')
    expect(saveButton(w).element.disabled).toBe(false)
    w.unmount()
  })
})

describe('create agent', () => {
  it('appends a tab, focuses it, and writes nothing', async () => {
    const calls = stubRoutes()
    const w = await openDialog()

    await w.find('.agent-modes-create input').setValue('Docs Review (v2)!')
    await createButton(w).trigger('click')

    expect(tabs(w)).toEqual(['Chat', 'Code', 'Architect', 'Reserved', 'Docs Review (v2)!'])
    expect(section(w, 'docs-review-v2').exists()).toBe(true)
    expect(document.activeElement?.closest('section[data-tab="docs-review-v2"]')).not.toBeNull()
    // Nothing was written: only the two reads happened.
    expect(calls).toEqual([])
    w.unmount()
  })

  it('names the collision instead of reusing an id', async () => {
    stubRoutes()
    const w = await openDialog()

    await w.find('.agent-modes-create input').setValue('Code')
    await createButton(w).trigger('click')

    expect(tabs(w)).toContain('Code')
    expect(section(w, 'code-2').exists()).toBe(true)
    expect(idField(w, 'code-2').element.value).toBe('code-2')
    w.unmount()
  })
})

describe('delete (D4, AC-11)', () => {
  it('is offered for a user-created agent and asks for a confirm', async () => {
    const calls = stubRoutes({ agents: withScribe() })
    const w = await openDialog()
    await tabButton(w, 4).trigger('click') // Scribe

    await section(w, 'scribe').find('.agent-modes-delete-button').trigger('click')
    // The confirm is asked for; nothing has been sent yet.
    expect(calls).toEqual([])
    expect(section(w, 'scribe').find('.agent-modes-delete-confirm').exists()).toBe(true)

    await section(w, 'scribe').find('.agent-modes-delete-yes').trigger('click')
    await flushPromises()
    expect(calls[0].key).toBe('/api/agents/delete')
    expect(calls[0].body).toEqual({ id: 'scribe' })
    w.unmount()
  })

  it('is not offered for a built-in agent, and the tab says why', async () => {
    stubRoutes()
    const w = await openDialog()
    await tabButton(w, 1).trigger('click') // Code

    expect(section(w, 'code').find('.agent-modes-delete-button').exists()).toBe(false)
    expect(section(w, 'code').find('.agent-modes-delete-refusal').text()).toContain(
      'cannot be deleted',
    )
    w.unmount()
  })

  it('"Keep it" leaves the agent alone', async () => {
    const calls = stubRoutes({ agents: withScribe() })
    const w = await openDialog()
    await tabButton(w, 4).trigger('click')

    await section(w, 'scribe').find('.agent-modes-delete-button').trigger('click')
    await buttonByText(section(w, 'scribe'), 'Keep it').trigger('click')

    expect(section(w, 'scribe').find('.agent-modes-delete-confirm').exists()).toBe(false)
    expect(calls).toEqual([])
    w.unmount()
  })
})

describe('save (per agent)', () => {
  it('posts this tab\'s agent to /api/agents/save and adopts the whole answer', async () => {
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
    // A successful save is the whole action: the card asks its parent to close.
    expect(w.emitted('close')).toBeTruthy()
    w.unmount()
  })

  it('a readonly agent\'s Save sends its model and nothing else', async () => {
    const calls = stubRoutes()
    const w = await openDialog()
    await tabButton(w, 3).trigger('click')

    await modelSelect(w, RESERVED_ID).setValue('2')
    await saveButton(w).trigger('click')
    await flushPromises()

    expect(calls[0].key).toBe('/api/agents/save')
    expect(calls[0].body).toEqual({ id: RESERVED_ID, modelId: 2 })
    expect(w.emitted('close')).toBeTruthy()
    w.unmount()
  })

  it('a new agent posts to add', async () => {
    const calls = stubRoutes()
    const w = await openDialog()

    await w.find('.agent-modes-create input').setValue('Reviewer')
    await createButton(w).trigger('click')
    await saveButton(w).trigger('click')
    await flushPromises()

    expect(calls[0].key).toBe('/api/agents/add')
    expect(calls[0].body.id).toBe('reviewer')
    expect(calls[0].body.label).toBe('Reviewer')
    w.unmount()
  })

  it('a refused save keeps the card open with the server\'s sentence', async () => {
    const detail = 'label: an agent labelled \'Code\' already exists.'
    stubRoutes({ saves: { '/api/agents/save': jsonResponse({ detail }, false, 422) } })
    const w = await openDialog()

    await labelField(w, 'chat').setValue('Chat')
    await saveButton(w).trigger('click')
    await flushPromises()

    expect(w.find('.agent-modes-server-findings').text()).toContain('already exists')
    expect(w.find('dialog').element.open).toBe(true)
    // A refusal is not a save: the card stays open and closes nothing.
    expect(w.emitted('close')).toBeFalsy()
    w.unmount()
  })

  it('Cancel writes nothing', async () => {
    const calls = stubRoutes()
    const w = await openDialog()

    await labelField(w, 'chat').setValue('Chatting')
    await buttonByText(w, 'Cancel').trigger('click')

    expect(calls).toEqual([])
    expect(w.emitted('close')).toBeTruthy()
    w.unmount()
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
    expect(text).toContain('deleteOfferedFor')
    expect(text).toContain('fieldsDisabledFor')
  })

  it('renders field text only — no raw v-html anywhere', () => {
    expect(source()).not.toContain('v-html')
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
