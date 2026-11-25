import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import SettingsDialog from '../src/components/SettingsDialog.vue'
import { useAppShell } from '../src/composables/useAppShell'
import { AUTOSAVE_DELAY_MS } from '../src/composables/useSettingsServers'

// ---------------------------------------------------------------------------
// The Settings dialog's auto-save, mounted for real.
//
// There is no `Save` anywhere in the dialog: a form is written when it stops
// changing, a hub tick is written as it is made, and every gesture that replaces
// a form (moving the selection, `Close`) writes what it is about to drop first.
// So the questions this suite asks are the three the mechanism can get wrong:
//
//   * a keystroke lands on **its own row's** route, once, and not before the
//     debounce has run;
//   * a form the store would refuse is **not** posted — the reason is the band's;
//   * nothing typed is left behind by a click.
//
// Wording, colour and geometry are the e2e spec's, not a unit test's.
//
// jsdom has no `showModal`/`close` on `<dialog>`, so both are patched on
// `Element.prototype` as the other dialog suites do: they only have to keep
// `el.open` truthful, which is all the component's watch reads.
// ---------------------------------------------------------------------------

Element.prototype.showModal = function showModal() {
  this.open = true
}
Element.prototype.close = function close() {
  this.open = false
}

const { state } = useAppShell()

const CAPS = { samplerRanges: {}, reasoningLevels: [] }

function model(id, name, extra = {}) {
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
    ...extra,
  }
}

function tree() {
  return [
    { id: 1, name: 'Local', url: 'http://x/v1', apiKey: 'k', models: [
      model(10, 'alpha'),
    ] },
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
  state.agentModesRequest = 0
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

//: One `fetch` for the whole dialog, backed by a store that **keeps what it is
//: given**: a write mutates the rows and answers with the whole tree, and a hub
//: write marks the ids it was sent active. An answer that ignored the body would
//: let a re-baseline bug pass, so none does.
async function open() {
  const servers = tree()
  const connectors = state.mcpConnectors ?? []
  const lspServers = state.lspServers ?? []

  const writeServer = (body) => {
    const row = body.id == null
      ? null
      : servers.find((entry) => entry.id === body.id)
    if (row) {
      Object.assign(row, { name: body.name, url: body.url, apiKey: body.apiKey })
      return
    }
    servers.push({ id: 3, name: body.name, url: body.url, apiKey: body.apiKey, models: [] })
  }

  const writeModel = (body) => {
    const models = servers[0].models
    const row = body.id == null ? null : models.find((entry) => entry.id === body.id)
    if (row) {
      Object.assign(row, body)
      delete row.id
      delete row.serverId
      return
    }
    models.push({ ...model(12, body.name), temperature: body.temperature })
  }

  const treeAnswer = () => json({
    servers,
    caps: CAPS,
    unassigned: { agentsWithoutModel: 0, agents: 4 },
  })

  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const path = String(url)
    const body = init?.body ? JSON.parse(init.body) : null
    if (path.includes('/api/mcp')) {
      const enabled = new Set(body?.enabled ?? [])
      return Promise.resolve(json({
        installed: true,
        connectors: connectors.map((c) => ({ ...c, active: enabled.has(c.id) })),
      }))
    }
    if (path.includes('/api/lsp')) {
      const enabled = new Set(body?.enabled ?? [])
      return Promise.resolve(json({
        installed: true,
        servers: lspServers.map((s) => ({ ...s, active: enabled.has(s.id) })),
      }))
    }
    if (path.includes('/api/config')) {
      return Promise.resolve(json({ models: servers.flatMap((s) => s.models) }))
    }
    if (path.includes('/api/models?')) return Promise.resolve(json({ models: [] }))
    if (path.includes('/api/servers/')) writeServer(body)
    if (path.includes('/api/models/')) writeModel(body)
    return Promise.resolve(treeAnswer())
  })
  wrapper = mount(SettingsDialog, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

const json = (payload) => ({
  ok: true,
  status: 200,
  json: () => Promise.resolve(payload),
})

function close() {
  wrapper?.unmount()
  wrapper = null
  vi.useRealTimers()
  vi.restoreAllMocks()
}

const posts = () =>
  vi.mocked(globalThis.fetch).mock.calls
    .filter((call) => call[1]?.method === 'POST')
    .map((call) => [String(call[0]), JSON.parse(call[1].body)])

const postFor = (path) => posts().find(([url]) => url.includes(path))

// Let the debounce run and the write it makes land.
async function settle() {
  await vi.advanceTimersByTimeAsync(AUTOSAVE_DELAY_MS + 50)
  await flushPromises()
}

const band = () => wrapper.find('.agent-modes-message')

describe('the dialog writes a form as soon as it stops changing', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetShell()
  })
  afterEach(close)

  it('has no Save verb in any of its three sections', async () => {
    await open()
    expect(wrapper.find('.servers-save').exists()).toBe(false)
    expect(wrapper.findAll('.settings-section-save')).toHaveLength(0)
    expect(wrapper.text()).not.toMatch(/\bSave\b/)
  })

  it('posts the typed server once the form stops changing, on the save route', async () => {
    await open()
    useAppShell().selectServer(1)
    await flushPromises()
    expect(posts()).toHaveLength(0)

    state.serverDraft.name = 'Local-renamed'
    await flushPromises()
    // Nothing is posted while the hand is still typing.
    expect(posts()).toHaveLength(0)

    await settle()
    expect(postFor('/api/servers/save')[1]).toMatchObject({
      id: 1, name: 'Local-renamed', url: 'http://x/v1',
    })
    // One write per shape of the form: the same bytes are never posted twice.
    await settle()
    expect(posts().filter(([url]) => url.includes('/api/servers/save'))).toHaveLength(1)
  })

  it('writes a model to its own route and never its server', async () => {
    await open()
    useAppShell().selectModel(10)
    await flushPromises()

    state.modelDraft.temperature = 0.7
    await settle()

    expect(postFor('/api/models/save')[1]).toMatchObject({ id: 10, temperature: 0.7 })
    expect(postFor('/api/servers/save')).toBeUndefined()
    // The credential is a server column: a model body that grew one would be a
    // second, unmanaged copy of a secret.
    expect(JSON.stringify(postFor('/api/models/save')[1])).not.toMatch(/api[_K]key/i)
  })

  it('does not post a form the store would refuse, and says why in the band', async () => {
    await open()
    await wrapper.find('.servers-add').trigger('click')
    await flushPromises()

    state.serverDraft.name = 'Named'
    await settle()
    expect(posts()).toHaveLength(0)
    expect(band().text()).toContain('url must not be empty')

    // The keystroke that completes the form is what gets written, and as an add.
    state.serverDraft.url = 'http://z/v1'
    await settle()
    expect(postFor('/api/servers/add')).toBeDefined()
    expect(postFor('/api/servers/save')).toBeUndefined()
  })

  it('lands an unsaved row on its stored id, so the next keystroke is an update', async () => {
    await open()
    await wrapper.find('.servers-add').trigger('click')
    await flushPromises()
    state.serverDraft.name = 'Third'
    state.serverDraft.url = 'http://z/v1'
    await settle()

    // The fake store's new row is id 3, and the form is addressed to it without
    // a re-read: the next keystroke updates this row instead of adding again.
    expect(state.serverDraft.id).toBe(3)
    expect(postFor('/api/servers/add')).toBeDefined()

    state.serverDraft.url = 'http://moved/v1'
    await settle()
    expect(postFor('/api/servers/save')[1]).toMatchObject({ id: 3, url: 'http://moved/v1' })
    expect(posts().filter(([url]) => url.includes('/api/servers/add'))).toHaveLength(1)
  })
})

describe('nothing typed is left behind by a click', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetShell()
  })
  afterEach(close)

  it('`Close` inside the debounce window writes the keystroke and leaves', async () => {
    await open()
    useAppShell().selectServer(1)
    await flushPromises()
    state.serverDraft.name = 'Local-renamed'
    await flushPromises()
    expect(posts()).toHaveLength(0)

    await wrapper.find('.settings-close').trigger('click')
    await flushPromises()

    expect(postFor('/api/servers/save')[1]).toMatchObject({ name: 'Local-renamed' })
    expect(state.settingsOpen).toBe(false)
    expect(state.serverDraft).toBeNull()
  })

  it('moving to another row writes the row being left', async () => {
    await open()
    useAppShell().selectServer(1)
    await flushPromises()
    state.serverDraft.name = 'Local-renamed'
    await flushPromises()

    useAppShell().selectServer(2)
    await flushPromises()

    expect(postFor('/api/servers/save')[1]).toMatchObject({ id: 1, name: 'Local-renamed' })
    // The write does not drag the user back to the row they clicked away from.
    expect(state.selectedServerId).toBe(2)
  })

  it('a hub tick is written on the spot, with the ids and nothing else', async () => {
    state.lspServers = [
      { id: 'pyright', label: 'Pyright', active: true, status: 'running' },
      { id: 'vue', label: 'Vue', active: false, status: 'stopped' },
    ]
    state.lspActivated = ['pyright']
    await open()
    state.activeSection = 'lsp'
    await flushPromises()

    await wrapper.findAll('.mcp-activate input')[1].setValue(true)
    await flushPromises()

    expect(String(postFor('/api/lsp')[0])).toContain('/api/lsp')
    // A `maxIterations` in the body would be a second writer of a value that left
    // the dialog: this section owns the activation flags and nothing else.
    expect(postFor('/api/lsp')[1]).toEqual({ enabled: ['pyright', 'vue'] })
    expect(state.lspSaving).toBe(false)
  })
})
