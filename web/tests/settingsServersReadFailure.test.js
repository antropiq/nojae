import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import SettingsDialog from '../src/components/SettingsDialog.vue'
import { useAppShell } from '../src/composables/useAppShell'

// ---------------------------------------------------------------------------
// The Servers section's verbs across a **failed** read of the connection.
//
// `serversLoaded` answers one question — are the rows on screen the store's? —
// and it is what makes the toolbar's verbs inert with *The servers have not been
// read.* A read that fails answers nothing and changes nothing: the rows already
// on screen are still the store's, the form still edits one of them, and a delete
// of a row the store has since lost is answered by the store's own 404 sentence.
// So a failed read leaves the flag alone, exactly as a failed write already does.
// Clearing it was what left `Delete` inert for good, over a tree of rows that
// were there to be deleted.
//
// The other half is the flag's reason to exist: a connection that has **never**
// been read leaves no row on screen, and then the verbs have nothing to act on.
//
// jsdom has no `showModal`/`close` on `<dialog>`, so both are patched on
// `Element.prototype` as the other dialog suites do.
// ---------------------------------------------------------------------------

Element.prototype.showModal = function showModal() {
  this.open = true
}
Element.prototype.close = function close() {
  this.open = false
}

const { state } = useAppShell()

const CAPS = { samplerRanges: {}, reasoningLevels: [] }

function model(id, name) {
  return {
    id,
    serverId: 1,
    name,
    sysPrompt: '',
    temperature: null,
    topP: null,
    topK: null,
    minP: null,
    repeatPenalty: null,
    presencePenalty: null,
    reasoning: null,
    supportsVision: false,
  }
}

function tree() {
  return [
    { id: 1, name: 'Local', url: 'http://x/v1', apiKey: 'k', models: [model(10, 'alpha')] },
    { id: 2, name: 'Cloud', url: 'https://y/v1', apiKey: '', models: [] },
  ]
}

function resetShell() {
  state.settings = { store: true }
  state.settingsOpen = true
  state.settingsError = null
  state.settingsSaving = false
  state.config = { models: [{ id: 10, name: 'alpha' }] }
  state.configError = null
  state.storeState = { usable: true, sentence: null }
  state.servers = tree()
  state.serversCaps = CAPS
  state.serversLoading = false
  state.serversLoaded = true
  state.serversError = null
  state.unassigned = { agentsWithoutModel: 0, agents: 4 }
  state.activeSection = 'servers'
  state.detailTab = 'settings'
  state.selectedServerId = null
  state.selectedModelId = null
  state.serverDraft = null
  state.modelDraft = null
  state.expandedServers = []
  state.fetchedModelIds = {}
  state.fetchedModelsLoading = null
  state.fetchedModelsErrors = {}
  state.pendingDelete = null
  state.pendingDeleteSentence = null
  state.focusTreeRowId = null
  state.mcpInstalled = true
  state.mcpConnectors = []
  state.mcpEnabled = []
  state.mcpLoading = false
  state.mcpSaving = false
  state.mcpError = null
  state.mcpExternalsError = null
  state.lspInstalled = true
  state.lspServers = []
  state.lspActivated = []
  state.lspLoading = false
  state.lspSaving = false
  state.lspError = null
  state.lspServersError = null
}

let wrapper = null

const json = (payload) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(payload),
})

const treeAnswer = () => json({
  servers: tree(),
  caps: CAPS,
  unassigned: { agentsWithoutModel: 0, agents: 4 },
})

//: One `fetch` for the whole dialog, with the connection read's answer switchable:
//: a read that lands re-adopts the same rows, a read that refuses answers 500.
function mockFetch({ servers = treeAnswer } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const path = String(url)
    if (path === '/api/servers') return servers()
    if (path.includes('/api/config')) return Promise.resolve(json({ models: [] }))
    if (path.includes('/api/mcp')) return Promise.resolve(json({ installed: true, connectors: [] }))
    if (path.includes('/api/lsp')) return Promise.resolve(json({ installed: true, servers: [] }))
    return Promise.resolve(treeAnswer())
  })
}

const refused = () => Promise.resolve({
  ok: false,
  status: 500,
  json: () => Promise.resolve({ detail: 'the store could not be opened' }),
})

const unreachable = () => Promise.reject(new TypeError('Failed to fetch'))

// `fetchWithRetry` makes three attempts of a transport failure, so a failed read
// is over only once its backoff has run out.
async function settle() {
  await vi.advanceTimersByTimeAsync(5000)
  await flushPromises()
}

const deleteButton = () => wrapper.find('.servers-delete')
const addButton = () => wrapper.find('.servers-add')
const band = () => wrapper.find('.agent-modes-message')

async function open() {
  wrapper = mount(SettingsDialog, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

function close() {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  vi.restoreAllMocks()
}

describe('a failed read leaves the rows it did not change alone', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetShell()
    mockFetch()
  })
  afterEach(close)

  it('keeps `Delete` live over the rows a refused read left standing', async () => {
    await open()
    useAppShell().selectServer(1)
    await flushPromises()
    expect(deleteButton().element.disabled).toBe(false)

    mockFetch({ servers: refused })
    useAppShell().loadServers()
    await settle()

    // The failure is said, and the verb still answers for the row on screen.
    expect(band().text()).toContain('the store could not be opened')
    expect(wrapper.findAll('.models-server')).toHaveLength(2)
    expect(deleteButton().element.disabled).toBe(false)
    expect(deleteButton().attributes('title')).toBe('Delete')
    expect(addButton().element.disabled).toBe(false)
  })

  it('keeps it live when the read never reached the server either', async () => {
    await open()
    useAppShell().selectModel(10)
    await flushPromises()

    mockFetch({ servers: unreachable })
    useAppShell().loadServers()
    await settle()

    expect(band().text()).toContain('Network unavailable')
    expect(state.modelDraft?.id).toBe(10)
    expect(deleteButton().element.disabled).toBe(false)
  })

  it('still deletes the selected row after a read that failed', async () => {
    await open()
    useAppShell().selectServer(2)
    await flushPromises()

    mockFetch({ servers: refused })
    useAppShell().loadServers()
    await settle()

    await deleteButton().trigger('click')
    await flushPromises()
    await wrapper.find('.servers-confirm-delete').trigger('click')
    await settle()

    const deleted = vi.mocked(globalThis.fetch).mock.calls
      .filter((call) => String(call[0]).endsWith('/api/servers/delete'))
      .map((call) => JSON.parse(call[1].body))
    expect(deleted).toEqual([{ id: 2 }])
  })
})

//: The same flag's other half: a read in flight **over** rows that were read. The
//: verbs stay inert while the tree is being replaced, but the sentence they give
//: has to be the read that is in flight — the rows on screen are the store's, so
//: *the servers have not been read* is a sentence that is not true there.
describe('a read in flight says what is in flight', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetShell()
    mockFetch()
  })
  afterEach(close)

  it('keeps the rows drawn and names the read while its answer is held', async () => {
    await open()
    useAppShell().selectServer(1)
    await flushPromises()
    expect(deleteButton().attributes('title')).toBe('Delete')

    let answer = null
    mockFetch({
      servers: () => new Promise((resolve) => { answer = resolve }),
    })
    const inFlight = useAppShell().loadServers()
    await flushPromises()

    expect(state.serversLoading).toBe(true)
    expect(state.serversLoaded).toBe(true)
    // The caption and the rows are separate siblings: the tree keeps its rows.
    expect(wrapper.find('.models-tree .caption').text()).toContain('Loading servers…')
    expect(wrapper.findAll('.models-server')).toHaveLength(2)

    expect(deleteButton().element.disabled).toBe(true)
    expect(deleteButton().attributes('title')).toContain('read is in flight')
    expect(deleteButton().attributes('title')).not.toContain('have not been read')
    expect(addButton().element.disabled).toBe(true)
    expect(addButton().attributes('title')).toContain('read is in flight')

    answer(treeAnswer())
    await inFlight
    await flushPromises()

    expect(state.serversLoading).toBe(false)
    expect(deleteButton().element.disabled).toBe(false)
    expect(deleteButton().attributes('title')).toBe('Delete')
    expect(addButton().element.disabled).toBe(false)
  })
})

describe('a connection that has never been read has no row to act on', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetShell()
    state.servers = []
    state.serversLoaded = false
    mockFetch({ servers: refused })
  })
  afterEach(close)

  it('says so, and keeps the verbs inert', async () => {
    await open()

    expect(wrapper.findAll('.models-server')).toHaveLength(0)
    expect(deleteButton().element.disabled).toBe(true)
    expect(deleteButton().attributes('title')).toContain('not been read')
    expect(addButton().element.disabled).toBe(true)
  })
})
