import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import SettingsDialog from '../src/components/SettingsDialog.vue'
import { draftKey, useAppShell } from '../src/composables/useAppShell'

// ---------------------------------------------------------------------------
// The Servers section, mounted for real.
//
// Every rule this dialog shows is a verdict from `useSettingsServers` and is
// judged there, so this suite asks only the questions about **the job**: does a
// click create the row the user meant, on the right route, with the right body
// and nothing else; does the listing's `+` write a child of *this* server; does
// a tab switch keep an edit and write nothing; does a delete ask before it
// posts. Nothing here asserts wording, colour or geometry — those are the
// migration plan's own acceptance list and the e2e spec's (§7), not a unit
// test's.
//
// Two properties are worth the assertions they cost, because both are the ones
// a re-shape can silently break: a **model write never carries a credential**
// (the mockup showed one and the plan calls it an error, §2.1), and a toolbar
// verb is **scoped to the page that is visible** (§4.3) — Save on a model page
// must not be able to write its server.
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

const CAPS = {
  samplerRanges: {
    temperature: { min: 0, max: null },
    topP: { min: 0, max: 1 },
    topK: { min: 0, max: null },
    minP: { min: 0, max: null },
    repeatPenalty: { min: 0, max: null },
    presencePenalty: { min: null, max: null },
  },
  reasoningLevels: ['off', 'low', 'medium', 'high', 'xhigh'],
}

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
      model(10, 'alpha', { temperature: 0.2, supportsVision: true }),
      model(11, 'beta'),
    ] },
    { id: 2, name: 'Cloud', url: 'https://y/v1', apiKey: '', models: [] },
  ]
}

//: What every write route answers with: the whole tree, which is the only shape
//: the client re-baselines on. `extraModels` grows server 1, which is how a test
//: can answer an add with the row the add created.
function treeBody({ extraModels = [], extraServers = [] } = {}) {
  const rows = tree()
  if (extraModels.length) rows[0].models.push(...extraModels)
  if (extraServers.length) rows.push(...extraServers)
  return {
    servers: rows,
    caps: CAPS,
    unassigned: { agentsWithoutModel: 0, agents: 4 },
  }
}

function resetShell() {
  state.settings = { store: true }
  state.settingsOpen = true
  state.settingsError = null
  state.config = null
  state.configError = null
  state.settingsSaving = false
  state.servers = tree()
  state.serversCaps = CAPS
  state.serversLoading = false
  state.serversLoaded = true
  state.serversError = null
  state.unassigned = { agentsWithoutModel: 0, agents: 4 }
  state.storeState = null
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
  state.pendingClose = false
  state.pendingCloseOpensAgentModes = false
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

//: One `fetch` for the whole dialog: the connection read and its six write
//: routes, the model listing, and the two hub reads. A caller overrides one of
//: them by name rather than replacing the whole implementation, so a test that
//: cares about a refusal does not have to re-answer everything else.
async function open(options = {}) {
  const answer = (url) => {
    const path = String(url)
    if (path.startsWith('/api/models?')) {
      return options.listed === undefined
        ? { models: ['alpha', 'gamma'] }
        : options.listed(path)
    }
    if (path.startsWith('/api/mcp')) return { connectors: [], enabled: [] }
    if (path.startsWith('/api/lsp')) return { servers: [], activated: [] }
    if (path.startsWith('/api/config')) {
      return options.config ? options.config() : { models: [] }
    }
    return options.body ? options.body(path) : treeBody()
  }
  const mock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const payload = answer(url)
    if (payload?.ok === false) {
      return Promise.resolve({
        ok: false,
        status: payload.status ?? 422,
        json: () => Promise.resolve({ detail: payload.detail }),
      })
    }
    return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(payload) })
  })
  wrapper = mount(SettingsDialog)
  await flushPromises()
  return mock
}

function close() {
  wrapper?.unmount()
  wrapper = null
  vi.restoreAllMocks()
}

const posts = (mock) =>
  mock.mock.calls
    .filter((call) => call[1]?.method === 'POST')
    .map((call) => [String(call[0]), JSON.parse(call[1].body)])

const postFor = (mock, path) => posts(mock).find(([url]) => url === path)

//: The section toolbar's `Save` **of the section on screen**. The three sections
//: are all in the DOM (`v-show`, so switching one cannot lose a keystroke), so
//: the class alone answers twice — `v-show` puts the `display: none` on the
//: section, which is why the ancestor is what is read.
function visibleSave() {
  const shown = wrapper.findAll('.settings-section-save').filter((button) => {
    const section = button.element.closest('section')
    return section?.style.display !== 'none'
  })
  expect(shown).toHaveLength(1)
  return shown[0]
}

// -- the toolbar's verbs, scoped to the page that is visible ----------------------

describe('the toolbar verbs create and save the row the page is showing', () => {
  beforeEach(() => resetShell())
  afterEach(close)

  it('adds a server from the server page and posts its three fields', async () => {
    const mock = await open()
    await wrapper.find('.servers-add').trigger('click')
    await flushPromises()

    // A new row is a draft with no id, which is what makes Save an add.
    expect(state.serverDraft).toEqual({ id: null, name: '', url: '', apiKey: '' })
    expect(state.modelDraft).toBeNull()

    state.serverDraft.name = 'Third'
    state.serverDraft.url = 'http://z/v1'
    state.serverDraft.apiKey = 'sk-3'
    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()

    expect(postFor(mock, '/api/servers/add')).toEqual([
      '/api/servers/add',
      { name: 'Third', url: 'http://z/v1', apiKey: 'sk-3' },
    ])
    // A server write carries no sampler of any kind.
    expect(JSON.stringify(postFor(mock, '/api/servers/add')[1])).not.toMatch(/temperature|topP/)
  })

  it('adds a model under the selected server and posts no credential', async () => {
    const mock = await open()
    // The `+` is scoped to the page that is visible (§4.3): a new model is
    // asked for from a model page, and lands under that model's server.
    useAppShell().selectModel(10)
    await flushPromises()

    await wrapper.find('.servers-add').trigger('click')
    await flushPromises()
    expect(state.modelDraft?.id).toBeNull()
    expect(state.modelDraft?.name).toBe('')
    expect(state.serverDraft?.id).toBe(1)

    state.modelDraft.name = 'gamma'
    state.modelDraft.temperature = 0.7
    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()

    const [, body] = postFor(mock, '/api/models/add')
    expect(body).toMatchObject({ name: 'gamma', serverId: 1, temperature: 0.7 })
    // §2.1: the credential is a server column. A model body that grew one would
    // be a second, unmanaged copy of a secret.
    expect(body).not.toHaveProperty('apiKey')
    expect(JSON.stringify(body)).not.toMatch(/api[_K]key/i)
  })

  it('saves the model on the model page and the server on the server page', async () => {
    const mock = await open()
    useAppShell().selectModel(10)
    await flushPromises()

    state.modelDraft.name = 'alpha-renamed'
    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()

    expect(postFor(mock, '/api/models/save')[1]).toMatchObject({
      id: 10, name: 'alpha-renamed',
    })
    // The verb is scoped to the page: the model's server was not written.
    expect(postFor(mock, '/api/servers/save')).toBeUndefined()

    useAppShell().selectServer(2)
    await flushPromises()
    state.serverDraft.url = 'https://cloud.example/v1'
    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()

    expect(postFor(mock, '/api/servers/save')[1]).toMatchObject({
      id: 2, url: 'https://cloud.example/v1',
    })
  })

  it('refuses an incomplete form without posting, and says why in the band', async () => {
    const mock = await open()
    await wrapper.find('.servers-add').trigger('click')
    await flushPromises()

    // The button stays live for a form that holds a problem (§4.3): the click is
    // refused and the reason is the band's.
    expect(wrapper.find('.servers-save').attributes('disabled')).toBeUndefined()
    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()

    expect(posts(mock)).toHaveLength(0)
    expect(wrapper.find('.agent-modes-message').text()).toContain('name must not be empty')

    state.serverDraft.name = 'Named'
    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()
    expect(posts(mock)).toHaveLength(0)
    expect(wrapper.find('.agent-modes-message').text()).toContain('url must not be empty')

    state.serverDraft.url = 'x'
    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()
    expect(posts(mock)).toHaveLength(0)
    expect(wrapper.find('.agent-modes-message').text()).toContain('url must start with')

    state.serverDraft.url = 'http://x/v1'
    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()
    expect(posts(mock)).toHaveLength(1)
  })

  it('leaves the dialog open across a save', async () => {
    await open()
    useAppShell().selectServer(1)
    await flushPromises()

    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()

    expect(state.settingsOpen).toBe(true)
  })

  it('lands a store refusal in the band rather than swallowing it', async () => {
    await open({
      body: (url) =>
        String(url).includes('/add')
          ? { ok: false, status: 422, detail: "a server named 'Local' already exists" }
          : treeBody(),
    })
    await wrapper.find('.servers-add').trigger('click')
    await flushPromises()
    state.serverDraft.name = 'Local'
    state.serverDraft.url = 'http://x/v1'
    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()

    expect(wrapper.find('.agent-modes-message').text()).toContain('already exists')
    expect(wrapper.find('.agent-modes-message').attributes('role')).toBe('alert')
  })

  it('shows the new form refusal instead of an older write failure', async () => {
    await open({
      body: (url) =>
        String(url).includes('/add')
          ? { ok: false, status: 422, detail: 'a server named Local already exists' }
          : treeBody(),
    })
    await wrapper.find('.servers-add').trigger('click')
    await flushPromises()
    state.serverDraft.name = 'Local'
    state.serverDraft.url = 'http://x/v1'
    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()
    expect(wrapper.find('.agent-modes-message').text()).toContain('already exists')

    // A write failure does not make the form "unread": the click is still
    // available, and the next refusal is the band's answer.
    expect(wrapper.find('.servers-save').attributes('disabled')).toBeUndefined()
    state.serverDraft.name = ''
    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()
    expect(wrapper.find('.agent-modes-message').text()).toContain('name must not be empty')
    expect(wrapper.find('.agent-modes-message').text()).not.toContain('already exists')
  })

  it('keeps the caps and the unassigned count when a write omits them', async () => {
    await open({ body: () => ({ servers: tree() }) })
    useAppShell().selectServer(1)
    await flushPromises()

    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()

    expect(state.serversCaps).toEqual(CAPS)
    expect(state.unassigned).toEqual({ agentsWithoutModel: 0, agents: 4 })
  })

  it('refreshes the store-level line after a successful write', async () => {
    state.storeState = { usable: true }
    state.config = { models: [], store: { usable: true } }
    await open({
      config: () => ({ models: [{ id: 10, name: 'alpha' }], store: { usable: true } }),
    })
    useAppShell().selectServer(1)
    await flushPromises()
    expect(wrapper.find('.agent-modes-message').text()).toContain('No model is configured')

    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()

    expect(state.config.models).toHaveLength(1)
    expect(wrapper.find('.agent-modes-message').text()).not.toContain('No model is configured')
  })

  it('lands a stripped name on the row the store created', async () => {
    await open({
      body: (url) =>
        String(url).includes('/add')
          ? treeBody({
              extraServers: [
                { id: 3, name: 'Third', url: 'http://z/v1', apiKey: '', models: [] },
              ],
            })
          : treeBody(),
    })
    await wrapper.find('.servers-add').trigger('click')
    await flushPromises()
    state.serverDraft.name = '  Third  '
    state.serverDraft.url = 'http://z/v1'
    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()

    // The saved row is selected, so a second Save cannot post a duplicate.
    expect(state.serverDraft?.id).toBe(3)
    expect(state.serverDraft?.name).toBe('Third')
  })
})

// -- selection -------------------------------------------------------------------

describe('selecting a row', () => {
  beforeEach(() => resetShell())
  afterEach(close)

  it('puts the clicked server in the detail column as a draft copy', async () => {
    await open()
    await wrapper.findAll('.models-name')[0].trigger('click')
    await flushPromises()

    expect(state.selectedServerId).toBe(1)
    expect(state.selectedModelId).toBeNull()
    expect(state.serverDraft).toEqual({
      id: 1, name: 'Local', url: 'http://x/v1', apiKey: 'k',
    })
    expect(wrapper.find('.models-page--server').exists()).toBe(true)
    expect(wrapper.find('.models-page--settings').exists()).toBe(false)
  })

  it('puts the clicked model there instead, keeping its server selected', async () => {
    await open()
    await wrapper.find('.models-disclosure').trigger('click')
    await flushPromises()
    await wrapper.findAll('.models-name--model')[1].trigger('click')
    await flushPromises()

    expect(state.selectedModelId).toBe(11)
    expect(state.modelDraft.name).toBe('beta')
    expect(state.selectedServerId).toBe(1)
    expect(wrapper.find('.models-page--settings').exists()).toBe(true)
    expect(wrapper.find('.models-page--server').exists()).toBe(false)
  })

  it('clears a model selected before the server clicked after it', async () => {
    await open()
    useAppShell().selectModel(10)
    await flushPromises()

    await wrapper.findAll('.models-name')[1].trigger('click')
    await flushPromises()

    expect(state.selectedServerId).toBe(2)
    expect(state.modelDraft).toBeNull()
  })

  it('offers the read\'s reasoning levels, not a list the dialog carries', async () => {
    await open()
    useAppShell().selectModel(10)
    await flushPromises()

    const options = wrapper.find('.models-field--reasoning').findAll('option')
    expect(options.map((option) => option.attributes('value'))).toEqual(
      ['', 'off', 'low', 'medium', 'high', 'xhigh'],
    )
  })

  it('holds every sampler the row has, so a save cannot drop one', async () => {
    await open()
    useAppShell().selectModel(10)
    await flushPromises()

    expect(state.modelDraft).toMatchObject({ temperature: 0.2, topP: null })
    expect(wrapper.find('.models-field--name').find('input').element.value).toBe('alpha')
  })
})

// -- the model page's two tabs ----------------------------------------------------

describe('the model page\'s two tabs', () => {
  beforeEach(() => resetShell())
  afterEach(close)

  it('keeps an edit made on either page, in both directions, writing nothing', async () => {
    const mock = await open()
    useAppShell().selectModel(10)
    await flushPromises()

    const name = wrapper.find('.models-field--name input')
    await name.setValue('typed-on-settings')

    await wrapper.findAll('.models-detail-tab')[1].trigger('click')
    await flushPromises()
    expect(wrapper.find('.models-prompt').element.value).toBe('')

    await wrapper.find('.models-prompt').setValue('a persona')
    await wrapper.findAll('.models-detail-tab')[0].trigger('click')
    await flushPromises()

    expect(wrapper.find('.models-field--name input').element.value).toBe('typed-on-settings')
    expect(state.modelDraft.sysPrompt).toBe('a persona')
    // A tab switch is presentation: it writes nothing and posts nothing.
    expect(posts(mock)).toHaveLength(0)
    expect(state.settingsSaving).toBe(false)
  })

  it('hides the detail tabs on the server page without losing the reserved strip', async () => {
    await open()
    useAppShell().selectServer(1)
    state.detailTab = 'prompt'
    await flushPromises()

    // A tab left on `prompt` while a server is shown must not draw an empty
    // textarea over the server's fields (§4.5).
    expect(wrapper.find('.models-page--server').exists()).toBe(true)
    expect(wrapper.find('.models-prompt').exists()).toBe(false)
    // Both tabs stay in the DOM so the strip keeps its height and selecting a
    // model cannot move the fields; on the server page they are hidden, because
    // the section strip above already reads `Servers`.
    const tabs = wrapper.findAll('.models-detail-tabs li')
    expect(tabs).toHaveLength(2)
    expect(tabs.every((li) => li.classes('models-detail-tab--hidden'))).toBe(true)
  })

  it('shows the detail tabs again for a model', async () => {
    await open()
    useAppShell().selectModel(10)
    await flushPromises()

    const tabs = wrapper.findAll('.models-detail-tabs li')
    expect(tabs).toHaveLength(2)
    expect(tabs.some((li) => li.classes('models-detail-tab--hidden'))).toBe(false)
  })
})

// -- Fetch models and the listing's `+` ------------------------------------------

describe('Fetch models and the listing', () => {
  beforeEach(() => resetShell())
  afterEach(close)

  it('is inert with its reason until the server has a backend row', async () => {
    const mock = await open()
    useAppShell().addServerRow()
    state.serverDraft.url = 'http://typed/v1'
    await flushPromises()

    const button = wrapper.find('.models-fetch')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('title')).toContain('Save the server before fetching')

    // A keyboard activation cannot reach a fetch the button said it would not.
    await button.trigger('click')
    await flushPromises()
    expect(
      mock.mock.calls.some((call) => String(call[0]).startsWith('/api/models?')),
    ).toBe(false)
  })

  it('is inert while the URL is empty, and live once it is filled', async () => {
    await open()
    useAppShell().selectServer(2)
    await flushPromises()

    state.serverDraft.url = ''
    await flushPromises()
    expect(wrapper.find('.models-fetch').attributes('disabled')).toBeDefined()

    state.serverDraft.url = 'https://y/v1'
    await flushPromises()
    expect(wrapper.find('.models-fetch').attributes('disabled')).toBeUndefined()
  })

  it('fills the two-column table with the names that server answered', async () => {
    await open({ listed: () => ({ models: ['alpha', 'gamma', 'delta'] }) })
    useAppShell().selectServer(1)
    await flushPromises()

    expect(wrapper.findAll('.models-listing-row')).toHaveLength(0)

    await wrapper.find('.models-fetch').trigger('click')
    await flushPromises()

    const names = wrapper.findAll('.models-listing-name').map((cell) => cell.text())
    expect(names).toEqual(['alpha', 'gamma', 'delta'])
    // One `+` per name, and the listing belongs to *this* server only.
    expect(wrapper.findAll('.models-add-row')).toHaveLength(3)
    expect(state.fetchedModelIds[draftKey(state.serverDraft)]).toEqual([
      'alpha', 'gamma', 'delta',
    ])
    expect(state.fetchedModelIds[draftKey({ id: 2, url: 'https://y/v1', apiKey: '' })]).toBeUndefined()
  })

  it('keeps the previous rows on screen while the next fetch is in flight', async () => {
    let resolveFetch = null
    const mock = await open()
    useAppShell().selectServer(1)
    state.fetchedModelIds = { [draftKey(state.serverDraft)]: ['alpha'] }
    await flushPromises()

    mock.mockImplementation(() => new Promise((resolve) => { resolveFetch = resolve }))
    await wrapper.find('.models-fetch').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('.models-listing-name').map((cell) => cell.text())).toEqual(['alpha'])
    expect(wrapper.find('.models-fetch').text()).toBe('Fetching…')
    expect(wrapper.find('.models-fetch').attributes('disabled')).toBeDefined()

    resolveFetch({ ok: true, status: 200, json: () => Promise.resolve({ models: [] }) })
    await flushPromises()

    // An empty answer **is** an answer: the rows go and the band says so.
    expect(wrapper.findAll('.models-listing-name')).toHaveLength(0)
    expect(wrapper.find('.agent-modes-message').text()).toContain('lists no models')
  })

  it('writes a child model on `+` with the name and its parent only', async () => {
    const mock = await open({
      listed: () => ({ models: ['alpha', 'gamma'] }),
      body: (url) =>
        url.endsWith('/models/add') ? treeBody({ extraModels: [model(12, 'gamma')] }) : treeBody(),
    })
    useAppShell().selectServer(1)
    await flushPromises()
    state.expandedServers = [1]
    await flushPromises()
    await wrapper.find('.models-fetch').trigger('click')
    await flushPromises()

    // A name the server already holds is inert, so no click can land on the
    // store's UNIQUE refusal.
    const rows = wrapper.findAll('.models-listing-row')
    expect(rows[0].find('.models-add-row').attributes('disabled')).toBeDefined()
    expect(rows[0].find('.models-add-row').attributes('title')).toBe('Already added')
    expect(rows[1].find('.models-add-row').attributes('disabled')).toBeUndefined()

    await rows[1].find('.models-add-row').trigger('click')
    await flushPromises()

    expect(postFor(mock, '/api/models/add')).toEqual([
      '/api/models/add',
      { name: 'gamma', serverId: 1 },
    ])
    // Then it lands on the new row: selected, its page open on Settings.
    expect(state.selectedModelId).toBe(12)
    expect(state.modelDraft.name).toBe('gamma')
    expect(state.detailTab).toBe('settings')
    expect(wrapper.find('.models-page--settings').exists()).toBe(true)
  })

  it('makes every `+` inert while a write is in flight', async () => {
    const mock = await open({ listed: () => ({ models: ['gamma', 'delta'] }) })
    useAppShell().selectServer(1)
    await flushPromises()
    await wrapper.find('.models-fetch').trigger('click')
    await flushPromises()

    let resolveAdd = null
    mock.mockImplementation(() => new Promise((resolve) => {
      resolveAdd = resolve
    }))
    const rows = wrapper.findAll('.models-listing-row')
    await rows[0].find('.models-add-row').trigger('click')
    await flushPromises()

    for (const row of wrapper.findAll('.models-listing-row')) {
      expect(row.find('.models-add-row').attributes('disabled')).toBeDefined()
    }
    resolveAdd({ ok: true, status: 200, json: () => Promise.resolve(treeBody()) })
    await flushPromises()
  })

  it('carries a fetch refusal to the band, and keeps it off the row that never asked', async () => {
    await open({
      listed: () => ({ ok: false, status: 502, detail: 'All connection attempts failed' }),
    })
    useAppShell().selectServer(1)
    await flushPromises()
    await wrapper.find('.models-fetch').trigger('click')
    await flushPromises()

    const band = wrapper.find('.agent-modes-message')
    expect(band.text()).toContain('All connection attempts failed')
    expect(band.attributes('role')).toBe('alert')

    // The other server was never dialled, so its page says nothing about this:
    // a refusal is a fact about the row that asked.
    useAppShell().selectServer(2)
    await flushPromises()
    expect(wrapper.find('.agent-modes-message').text()).toBe('')
  })

  it('forgets a fetch failure when that server is saved', async () => {
    await open({
      listed: () => ({ ok: false, status: 502, detail: 'All connection attempts failed' }),
    })
    useAppShell().selectServer(1)
    await flushPromises()
    await wrapper.find('.models-fetch').trigger('click')
    await flushPromises()
    expect(wrapper.find('.agent-modes-message').text()).toContain(
      'All connection attempts failed',
    )

    state.serverDraft.url = 'http://fixed/v1'
    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()

    expect(state.fetchedModelsErrors).toEqual({})
    expect(wrapper.find('.agent-modes-message').text()).not.toContain(
      'All connection attempts failed',
    )
  })

  it('drops a deleted server\'s listing so a reused id cannot show it', async () => {
    await open({ body: () => ({ ...treeBody(), servers: [tree()[1]] }) })
    useAppShell().selectServer(1)
    await flushPromises()
    await wrapper.find('.models-fetch').trigger('click')
    await flushPromises()
    expect(Object.keys(state.fetchedModelIds)).toHaveLength(1)

    await wrapper.find('.servers-delete').trigger('click')
    await flushPromises()
    await wrapper.find('.servers-confirm-delete').trigger('click')
    await flushPromises()

    expect(state.fetchedModelIds).toEqual({})
    expect(state.fetchedModelsErrors).toEqual({})
  })

  it('does not replace a new model draft from the toolbar `+`', async () => {
    await open()
    useAppShell().selectModel(10)
    await flushPromises()
    await wrapper.find('.servers-add').trigger('click')
    await flushPromises()
    state.modelDraft.name = 'typed but unsaved'
    await flushPromises()

    const button = wrapper.find('.servers-add')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('title')).toContain('Already adding a model')
    await button.trigger('click')
    await flushPromises()
    expect(state.modelDraft.name).toBe('typed but unsaved')
  })

  it('refuses a sampler outside its bound before it reaches the store', async () => {
    const mock = await open()
    useAppShell().selectModel(10)
    await flushPromises()

    state.modelDraft.topP = 2
    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()

    expect(posts(mock)).toHaveLength(0)
    expect(wrapper.find('.agent-modes-message').text()).toContain(
      'topP must be at most 1',
    )
  })
})

// -- the destructive verbs --------------------------------------------------------

describe('the destructive verbs', () => {
  beforeEach(() => resetShell())
  afterEach(close)

  it('asks inline for a server delete and posts nothing until confirmed', async () => {
    const confirmMock = vi.spyOn(globalThis, 'confirm').mockReturnValue(true)
    const mock = await open({ body: () => ({ ...treeBody(), servers: [tree()[1]] }) })
    useAppShell().selectServer(1)
    await flushPromises()

    await wrapper.find('.servers-delete').trigger('click')
    await flushPromises()

    // No native blocking dialog: the question is the toolbar's pair and the
    // band's sentence (§4.8).
    expect(confirmMock).not.toHaveBeenCalled()
    expect(wrapper.find('.servers-cancel-delete').exists()).toBe(true)
    expect(wrapper.find('.servers-confirm-delete').exists()).toBe(true)
    expect(wrapper.find('.agent-modes-message').text()).toContain('2 models under it')
    expect(posts(mock).filter(([url]) => url.endsWith('/delete'))).toHaveLength(0)

    await wrapper.find('.servers-cancel-delete').trigger('click')
    await flushPromises()
    expect(wrapper.find('.servers-confirm-delete').exists()).toBe(false)
    expect(posts(mock).filter(([url]) => url.endsWith('/delete'))).toHaveLength(0)
  })

  it('posts the model delete for the model page, and not its server', async () => {
    const mock = await open({ body: () => ({ ...treeBody(), servers: [{ ...tree()[0], models: [model(11, 'beta')] }] }) })
    useAppShell().selectModel(10)
    await flushPromises()

    await wrapper.find('.servers-delete').trigger('click')
    await flushPromises()
    await wrapper.find('.servers-confirm-delete').trigger('click')
    await flushPromises()

    expect(postFor(mock, '/api/models/delete')).toEqual(['/api/models/delete', { id: 10 }])
    expect(postFor(mock, '/api/servers/delete')).toBeUndefined()
  })

  it('abandons the question when the selection moves', async () => {
    await open()
    useAppShell().selectServer(1)
    await flushPromises()

    await wrapper.find('.servers-delete').trigger('click')
    await flushPromises()
    expect(wrapper.find('.servers-confirm-delete').exists()).toBe(true)
    expect(wrapper.find('.agent-modes-message').text()).toContain('Delete Local')

    await wrapper.findAll('.models-name')[1].trigger('click')
    await flushPromises()

    // The sentence named Local; the pair is gone rather than aimed at Cloud.
    expect(wrapper.find('.servers-confirm-delete').exists()).toBe(false)
    expect(state.pendingDelete).toBeNull()
    expect(wrapper.find('.agent-modes-message').text()).not.toContain('Delete Local')
  })

  it('answers the row the question named even if the selection changes', async () => {
    const mock = await open({
      body: () => ({ ...treeBody(), servers: [tree()[1]] }),
    })
    useAppShell().selectServer(1)
    await flushPromises()
    await wrapper.find('.servers-delete').trigger('click')
    await flushPromises()

    // Move the selection without the UI's dismissal (the guard that path uses).
    state.selectedServerId = 2
    state.serverDraft = { id: 2, name: 'Cloud', url: 'https://y/v1', apiKey: '' }
    await wrapper.find('.servers-confirm-delete').trigger('click')
    await flushPromises()

    expect(postFor(mock, '/api/servers/delete')).toEqual([
      '/api/servers/delete', { id: 1 },
    ])
  })

  it('is inert for a row that has no backend row', async () => {
    await open()
    useAppShell().addServerRow()
    await flushPromises()

    const button = wrapper.find('.servers-delete')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('title')).toContain('Save the server before')
    expect(wrapper.find('.servers-confirm-delete').exists()).toBe(false)
  })
})

// -- the other two sections' one verb --------------------------------------------

describe('the MCP and LSP sections', () => {
  beforeEach(() => resetShell())
  afterEach(close)

  it('saves the connectors from the section toolbar, not the footer', async () => {
    const mock = await open()
    state.activeSection = 'mcp'
    await flushPromises()

    // The footer is **one shape for all three sections**: the band and `Close`.
    expect(wrapper.findAll('.settings-actions button')).toHaveLength(1)

    await visibleSave().trigger('click')
    await flushPromises()
    expect(posts(mock).some(([url]) => url.includes('/mcp'))).toBe(true)
    expect(state.settingsOpen).toBe(true)
  })

  it('saves the language servers from their own toolbar', async () => {
    const mock = await open()
    state.activeSection = 'lsp'
    await flushPromises()

    expect(wrapper.findAll('.settings-actions button')).toHaveLength(1)

    await visibleSave().trigger('click')
    await flushPromises()
    expect(posts(mock).some(([url]) => url.includes('/lsp'))).toBe(true)
    expect(state.settingsOpen).toBe(true)
  })
})

// -- the dialog's one message area ------------------------------------------------

describe('the dialog\'s one message area', () => {
  beforeEach(() => resetShell())
  afterEach(close)

  it('is the only place a failure is said, in every section', async () => {
    await open()
    state.serversError = 'the store could not be read'
    state.mcpError = 'connector read failed'
    state.lspError = 'language server read failed'
    await flushPromises()

    expect(wrapper.findAll('.agent-modes-message')).toHaveLength(1)
    expect(wrapper.find('.agent-modes-message').text()).toContain('could not be read')

    state.activeSection = 'mcp'
    await flushPromises()
    expect(wrapper.find('.agent-modes-message').text()).toContain('connector read failed')

    // Per-row problems stay beside their row, which is the plan's named
    // exception (§4.7) — but they are not a second band.
    expect(wrapper.findAll('.agent-modes-message')).toHaveLength(1)
  })

  it('offers the way into the Agent-modes dialog for the cross-store line', async () => {
    await open()
    state.unassigned = { agentsWithoutModel: 2, agents: 4 }
    await flushPromises()

    const before = state.agentModesRequest
    await wrapper.find('.settings-message-action').trigger('click')
    expect(state.agentModesRequest).toBe(before + 1)
    // A card opened behind a modal dialog is a click that did nothing.
    expect(state.settingsOpen).toBe(false)
  })

  it('does not print a Servers failure while another section is on screen', async () => {
    await open()
    state.serversError = 'the store could not be read'
    state.activeSection = 'mcp'
    await flushPromises()

    expect(wrapper.find('.agent-modes-message').text()).not.toContain(
      'the store could not be read',
    )
    // It speaks about the MCP section instead: nothing is declared there.
    expect(wrapper.find('.agent-modes-message').text()).toContain(
      'Nothing declared in',
    )
  })

  it('says a hub read is loading, and a failed read before "not installed"', async () => {
    await open()
    state.activeSection = 'mcp'
    state.mcpLoading = true
    state.mcpInstalled = null
    await flushPromises()
    expect(wrapper.find('.agent-modes-message').text()).toContain('Loading connectors…')

    state.mcpLoading = false
    state.mcpError = 'could not read the connectors'
    state.mcpInstalled = null
    await flushPromises()
    expect(wrapper.find('.agent-modes-message').text()).toContain(
      'could not read the connectors',
    )
    expect(wrapper.find('.agent-modes-message').text()).not.toContain('not installed')
  })
})
