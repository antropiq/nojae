import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import WorkBenchInput from '../src/components/WorkBenchInput.vue'
import { loadAgentModes, setAgentMode, useAgentModes } from '../src/composables/useAgentModes'
import { useBatch } from '../src/composables/useBatch'
import { useAppShell } from '../src/composables/useAppShell'
import { useChat } from '../src/composables/useChat'

// ---------------------------------------------------------------------------
// The pencil beside the mode dropdown (eds-07), over a mounted composer.
//
// The card it opens is judged in `agentModesDialog.test.js` and every rule
// behind it in `agentModes.test.js`. What lives here is the *affordance*: that
// the button sits in the mode column next to the select, which states of the
// app make it inert (D10), that it is reachable when the dropdown's list failed
// to load, and that opening the card reads the file and writes nothing.
//
// The composer is mounted for real because enablement is its own composition of
// `useChat`'s phase and `useBatch`'s flag — a rule no composable function owns.
// ---------------------------------------------------------------------------

const agentModes = useAgentModes().state
const chat = useChat().state
const batch = useBatch().state
const appShell = useAppShell().state

//: What `GET /api/agents` answers — the store's rows. The app-owned agent is
//: spelled with a stand-in id (this file may not name the real one), and it is
//: the one row the store publishes `readonly` for.
function modesBody() {
  const rows = [
    { id: 'code', label: 'Code', mcpEnable: true, lspEnable: true },
    { id: 'chat', label: 'Chat', mcpEnable: false, lspEnable: false },
    { id: 'reserved-agent-under-test', label: 'Reserved', mcpEnable: true, lspEnable: false, readonly: true },
  ]
  return {
    agents: rows.map((row, index) => ({
      readonly: false,
      ...row,
      deletable: false,
      maxToolIteration: 25,
      systemMessage: '',
      modelId: index + 1,
      modelName: `model-${index + 1}`,
    })),
    caps: {
      minToolIteration: 1,
      maxIdChars: 32,
      idPattern: '^[a-z][A-Za-z0-9_-]*$',
      maxPersonaBytes: 16384,
    },
    findings: [],
  }
}

//: The connection catalogue the model dropdown is built from.
const SERVERS_BODY = {
  servers: [{ id: 1, name: 'Local', url: 'http://localhost:8080/v1', apiKey: '', models: [{ id: 1, name: 'model-1' }] }],
  caps: { samplerRanges: {}, reasoningLevels: [] },
  unassigned: { agentsWithoutModel: 0, agents: 3 },
}

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

// `calls` records every route the composer touches, in order. `list: null` makes
// the dropdown's own fetch fail — the case the pencil must survive.
function stubRoutes({ list = modesBody(), calls = [] } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const key = String(url)
    calls.push({ key, method: init?.method ?? 'GET' })
    if (key === '/api/agents') {
      return list === null ? jsonResponse({}, false, 500) : jsonResponse(list)
    }
    if (key === '/api/servers') return jsonResponse(SERVERS_BODY)
    if (key.startsWith('/api/agents/')) {
      throw new Error('the pencil must not write on its own')
    }
    throw new Error(`unexpected fetch: ${key}`)
  })
  return calls
}

function resetAll() {
  chat.phase = 'idle'
  chat.messages = []
  chat.error = null
  chat.pausePending = false
  chat.pendingImage = null
  chat.mcp = { connectors: [], enabled: {}, loaded: false, locked: false, restarting: false }
  chat.lsp = { servers: [], enabled: {}, loaded: false, locked: false, restarting: false }
  batch.active = false
  batch.status = 'idle'
  appShell.activeTab = 'chat'
  agentModes.modes = []
  agentModes.current = null
  agentModes.loaded = false
  agentModes.findings = []
  agentModes.notice = null
  const editor = useAgentModes().editor
  editor.loading = false
  editor.saving = false
  editor.error = null
  editor.serverFindings = []
  appShell.servers = []
  appShell.serversCaps = null
  window.localStorage.clear()
}

let host = null

async function mountComposer() {
  host = document.createElement('div')
  document.body.appendChild(host)
  const wrapper = mount(WorkBenchInput, { attachTo: host })
  await flushPromises()
  return wrapper
}

function pencil(w) {
  return w.find('.chat-mode-edit')
}

beforeEach(() => {
  // jsdom has no <dialog> methods; the card's watch only reads `el.open`.
  Element.prototype.showModal = function showModal() {
    this.open = true
  }
  Element.prototype.close = function close() {
    this.open = false
  }
  resetAll()
})

afterEach(() => {
  host?.remove()
  host = null
  document.body.querySelectorAll('dialog').forEach((el) => el.remove())
  vi.restoreAllMocks()
})

describe('the pencil beside the mode dropdown', () => {
  it('renders in the mode column, immediately after the select', async () => {
    stubRoutes()
    await loadAgentModes()
    const w = await mountComposer()

    const select = w.find('.chat-mode-select')
    const button = pencil(w)
    expect(select.exists()).toBe(true)
    expect(button.exists()).toBe(true)
    // The pencil glyph the app already draws (the "Edit and resend" chip).
    expect(button.find('svg').exists()).toBe(true)
    // Same row, and the pencil is the select's next sibling: the layout promise
    // the e2e spec measures is "the pencil joined the column, nothing moved".
    const row = w.find('.chat-mode-row')
    expect(row.exists()).toBe(true)
    expect(row.element.children[0]).toBe(select.element)
    expect(row.element.children[1]).toBe(button.element)
    // Named, so the affordance says what it opens.
    expect(button.attributes('aria-label')).toContain('modes')
    expect(button.attributes('title')).toContain('modes')
    // …but not with the *select's* name: a query for "Agent mode" must keep
    // answering one element, or the pinned layout spec would start matching the
    // pencil too.
    expect(select.attributes('aria-label')).toBe('Agent mode')
    for (const name of [button.attributes('aria-label'), button.attributes('title')]) {
      expect(name.toLowerCase()).not.toContain('agent mode')
    }
  })

  it('opens the dialog, which reads the file and writes nothing', async () => {
    const calls = stubRoutes()
    await loadAgentModes()
    const w = await mountComposer()

    expect(document.querySelector('dialog.agent-modes-dialog')?.open ?? false).toBe(false)
    await pencil(w).trigger('click')
    await flushPromises()

    expect(document.querySelector('dialog.agent-modes-dialog')?.open).toBe(true)
    // Opening *is* the read — the agent list, and the connection catalogue the
    // model dropdowns are built from. No save happens without pressing Save.
    expect(calls.map((call) => call.key)).toEqual([
      '/api/agents',
      '/api/servers',
      '/api/agents',
    ])
    expect(calls.some((call) => call.method === 'POST')).toBe(false)
  })

  it('is inert while a reply streams, and live otherwise', async () => {
    stubRoutes()
    await loadAgentModes()
    const w = await mountComposer()
    expect(pencil(w).attributes('disabled')).toBeUndefined()

    chat.phase = 'answering'
    await flushPromises()
    expect(pencil(w).attributes('disabled')).toBeDefined()
    // A click in that window opens nothing: the card's Save would be refused.
    await pencil(w).trigger('click')
    await flushPromises()
    expect(document.querySelector('dialog.agent-modes-dialog')?.open ?? false).toBe(false)

    chat.phase = 'idle'
    await flushPromises()
    expect(pencil(w).attributes('disabled')).toBeUndefined()
  })

  it('is inert while a lot runs, and live after it', async () => {
    stubRoutes()
    await loadAgentModes()
    const w = await mountComposer()

    batch.active = true
    await flushPromises()
    expect(pencil(w).attributes('disabled')).toBeDefined()
    // The select obeys the same rule: one live and the other not is the drift
    // this task is told to avoid.
    expect(w.find('.chat-mode-select').attributes('disabled')).toBeDefined()

    batch.active = false
    await flushPromises()
    expect(pencil(w).attributes('disabled')).toBeUndefined()
    expect(w.find('.chat-mode-select').attributes('disabled')).toBeUndefined()
  })

  it('stays reachable when the dropdown list failed to load', async () => {
    const calls = stubRoutes({ list: null })
    await loadAgentModes()
    expect(agentModes.loaded).toBe(false)
    const w = await mountComposer()

    // No select (a control that cannot be used is worse than none), but the
    // editor is there: a store whose list could not be read is exactly the one
    // worth opening.
    expect(w.find('.chat-mode-select').exists()).toBe(false)
    expect(pencil(w).exists()).toBe(true)
    expect(pencil(w).attributes('disabled')).toBeUndefined()

    await pencil(w).trigger('click')
    await flushPromises()
    expect(document.querySelector('dialog.agent-modes-dialog')?.open).toBe(true)
    // The card retries the read itself, so the failure it was opened for is
    // reported on its own error line rather than inherited from the dropdown.
    expect(calls.filter((call) => call.key === '/api/agents')).toHaveLength(2)
  })

  it('a turned conversation never stops the agent being switched', async () => {
    // The old case here asserted that a *locked* conversation could still edit
    // the modes file — a lock that no longer exists (§4.4, D5). What survives
    // its removal is the invariant behind it, stated positively: after a turn,
    // the select is live and the pencil is live, so nothing about this
    // conversation freezes.
    stubRoutes()
    await loadAgentModes()
    const w = await mountComposer()

    chat.messages = [{ role: 'user', raw: 'one turn', html: '', images: [] }]
    setAgentMode('chat')
    await flushPromises()
    expect(agentModes.current).toBe('chat')

    // Both the select and the pencil stay live: no agent locks, and the agent
    // list was never part of this conversation's state anyway.
    expect(w.find('.chat-mode-select').attributes('disabled')).toBeUndefined()
    expect(pencil(w).attributes('disabled')).toBeUndefined()

    await pencil(w).trigger('click')
    await flushPromises()
    expect(document.querySelector('dialog.agent-modes-dialog')?.open).toBe(true)
  })

  it('the notice line still renders under the column, pencil included', async () => {
    // The quiet line arrives through the notice slot, so the column must render
    // for a notice with no list behind it.
    stubRoutes({ list: null })
    agentModes.notice =
      'The saved session asked for agent mode "gone", which this installation does not have — using Code.'
    const w = await mountComposer()

    const line = w.find('.chat-mode-findings')
    expect(line.exists()).toBe(true)
    expect(line.text()).toContain('does not have')
    expect(pencil(w).exists()).toBe(true)
  })
})
