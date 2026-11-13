import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import SettingsDialog from '../src/components/SettingsDialog.vue'
import {
  fetchedModelsErrorFor,
  modelDeleteSentence,
  modelRowDraft,
  modelWritePayload,
  serverDeleteSentence,
  serverRowDraft,
  unassignedLine,
  useAppShell,
} from '../src/composables/useAppShell'

// The Models section (appdb-08): the dialog edits a **catalogue** now, so the
// two things it has to get right are which row the right-hand column is showing
// and what the one cross-store line says.
//
// The rules are asserted twice on purpose: as plain functions (the composable's
// arithmetic — the count, the payload, the draft), and through a mounted dialog
// (that a click selects the row, that the fetched listing belongs to *that*
// server, that the line opens the Agent-modes dialog). The component decides
// nothing, so the second set is thin — and it is what would catch a template
// wired to the wrong answer.

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

function resetShell() {
  state.settings = { store: true }
  state.settingsError = null
  state.settingsOpen = true
  state.servers = tree()
  state.serversCaps = CAPS
  state.serversError = null
  state.unassigned = { agentsWithoutModel: 2, agents: 4 }
  state.selectedServerId = null
  state.selectedModelId = null
  state.serverDraft = null
  state.modelDraft = null
  state.expandedServers = []
  state.fetchedModelIds = {}
  state.fetchedModelsLoading = 0
  state.fetchedModelsErrors = {}
  state.agentModesRequest = 0
  state.settingsSaving = false
}

function section(wrapper) {
  return wrapper
    .findAll('.settings-editor > section')
    .find((entry) => entry.find('h3').text() === 'Models')
}

function flush() {
  return flushPromises()
}

// The *Fetch models* button of the server the detail column is showing. Its label
// changes while a listing is in flight, so it is found by the title it carries in
// both states rather than by its words.
function fetchButton(wrapper) {
  return section(wrapper)
    .findAll('button')
    .find((button) => button.attributes('title')?.startsWith('Ask this server'))
}

// -- the plain rules -------------------------------------------------------------

describe('the Models section\'s rules', () => {
  beforeEach(() => resetShell())

  it('says how many agents have no model, and nothing when all of them have one', () => {
    expect(unassignedLine({ agentsWithoutModel: 2, agents: 4 })).toBe(
      '2 of 4 agents have no model',
    )
    expect(unassignedLine({ agentsWithoutModel: 1, agents: 1 })).toBe(
      '1 of 1 agents have no model',
    )
    expect(unassignedLine({ agentsWithoutModel: 0, agents: 4 })).toBeNull()
    // No agents at all is not a count to state, and an unread store is not a zero.
    expect(unassignedLine({ agentsWithoutModel: 0, agents: 0 })).toBeNull()
    expect(unassignedLine(null)).toBeNull()
  })

  it('drafts a new row with a null id, which is what makes it an add', () => {
    expect(serverRowDraft(null).id).toBeNull()
    expect(modelRowDraft(null).id).toBeNull()
    expect(serverRowDraft(tree()[0])).toEqual({
      id: 1, name: 'Local', url: 'http://x/v1', apiKey: 'k',
    })
  })

  it('posts a sampler it was not given as null, and a 0 as 0', () => {
    // §4.2: "not set" and 0 are different values, and the write must not merge
    // them on its way out.
    const blank = modelWritePayload(modelRowDraft(null))
    expect(blank.temperature).toBeNull()
    expect(blank.supportsVision).toBe(false)
    expect(blank.reasoning).toBeNull()

    const zero = modelWritePayload(
      modelRowDraft(model(10, 'alpha', { temperature: 0, reasoning: 'off' })),
    )
    expect(zero.temperature).toBe(0)
    expect(zero.reasoning).toBe('off')
  })

  it('carries every sampler the row has, so a save cannot drop one', () => {
    const row = model(10, 'alpha', {
      temperature: 0.2, topP: 0.9, topK: 20, minP: 0.05,
      repeatPenalty: 1.1, presencePenalty: -0.2,
    })
    const payload = modelWritePayload(modelRowDraft(row))

    expect(payload).toMatchObject({
      temperature: 0.2, topP: 0.9, topK: 20, minP: 0.05,
      repeatPenalty: 1.1, presencePenalty: -0.2,
    })
  })

  it('names what a delete takes with it, in the sentence it asks with', () => {
    expect(serverDeleteSentence(tree()[0])).toContain('2 models under it')
    expect(serverDeleteSentence(tree()[1])).toBe('Delete Cloud?')
    expect(modelDeleteSentence(model(10, 'alpha'))).toContain('alpha')
  })
})

// -- the writes -------------------------------------------------------------------

describe('the write calls', () => {
  let fetchMock = null

  beforeEach(() => {
    resetShell()
    fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({
          servers: tree(),
          caps: CAPS,
          unassigned: { agentsWithoutModel: 2, agents: 4 },
        }),
      }),
    )
  })

  afterEach(() => vi.restoreAllMocks())

  const calls = () => fetchMock.mock.calls.map((call) => String(call[0]))

  it('posts a new server to the add route with its three fields', async () => {
    const shell = useAppShell()
    shell.addServerRow()
    state.serverDraft.name = 'Local'
    state.serverDraft.url = 'http://x/v1'
    state.serverDraft.apiKey = 'k'

    await shell.saveServerDraft()

    expect(calls()).toContain('/api/servers/add')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      name: 'Local', url: 'http://x/v1', apiKey: 'k',
    })
  })

  it('posts an existing server to the save route, addressed by id', async () => {
    const shell = useAppShell()
    shell.selectServer(1)
    state.serverDraft.apiKey = 'rotated'

    await shell.saveServerDraft()

    expect(calls()).toContain('/api/servers/save')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      name: 'Local', url: 'http://x/v1', apiKey: 'rotated', id: 1,
    })
  })

  it('posts a new model with its server, and an existing one with its id', async () => {
    const shell = useAppShell()
    shell.selectServer(1)
    shell.addModelRow()
    state.modelDraft.name = 'gamma'
    await shell.saveModelDraft()

    const added = fetchMock.mock.calls[0]
    expect(String(added[0])).toBe('/api/models/add')
    expect(JSON.parse(added[1].body)).toMatchObject({ serverId: 1, name: 'gamma' })

    shell.selectModel(11)
    state.modelDraft.name = 'beta-renamed'
    await shell.saveModelDraft()

    const saved = fetchMock.mock.calls[1]
    expect(String(saved[0])).toBe('/api/models/save')
    expect(JSON.parse(saved[1].body)).toMatchObject({ id: 11, name: 'beta-renamed' })
  })

  it('keeps a new row being typed across a re-read', async () => {
    // A new row addresses nothing, so no other write can have removed it — and a
    // refresh that emptied the form the user is typing into would be its own bug.
    const shell = useAppShell()
    shell.addServerRow()
    state.serverDraft.name = 'Half-typed'

    await shell.loadServers()

    expect(state.serverDraft?.name).toBe('Half-typed')
    expect(state.selectedServerId).toBeNull()
  })

  it('shows the server\'s refusal sentence rather than swallowing it', async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 422,
        json: () => Promise.resolve({ detail: 'name: a server named \'Local\' already exists' }),
      }),
    )
    const shell = useAppShell()
    shell.selectServer(1)

    await shell.saveServerDraft()

    expect(state.serversError).toContain('already exists')
  })
})

// -- selection -------------------------------------------------------------------

describe('selecting a row', () => {
  let wrapper = null

  beforeEach(async () => {
    resetShell()
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
    )
    wrapper = mount(SettingsDialog)
    await flush()
  })

  afterEach(() => {
    wrapper?.unmount()
    vi.restoreAllMocks()
  })

  it('puts the clicked server\'s fields in the detail column', async () => {
    const rows = section(wrapper).findAll('.models-name')
    await rows[0].trigger('click')
    await flush()

    expect(state.selectedServerId).toBe(1)
    expect(state.selectedModelId).toBeNull()
    expect(state.serverDraft).toEqual({
      id: 1, name: 'Local', url: 'http://x/v1', apiKey: 'k',
    })
    expect(section(wrapper).find('.models-detail-title').text()).toBe('Local')
  })

  it('puts the clicked model\'s fields there instead, once its server is open', async () => {
    await section(wrapper).find('.models-disclosure').trigger('click')
    await flush()
    const modelRow = section(wrapper).findAll('.models-name--model')[1]
    await modelRow.trigger('click')
    await flush()

    expect(state.selectedModelId).toBe(11)
    expect(state.modelDraft.name).toBe('beta')
    // The server stays selected as the model's parent — the tree does not collapse.
    expect(state.selectedServerId).toBe(1)
  })

  it('selecting a server clears a model selected before it', async () => {
    state.selectedServerId = 1
    state.selectedModelId = 10
    state.modelDraft = modelRowDraft(tree()[0].models[0])

    await section(wrapper).findAll('.models-name')[1].trigger('click') // Cloud
    await flush()

    expect(state.selectedServerId).toBe(2)
    expect(state.selectedModelId).toBeNull()
    expect(state.modelDraft).toBeNull()
  })

  it('offers the six samplers, the reasoning levels and the vision box on a model', async () => {
    state.selectedServerId = 1
    state.selectedModelId = 10
    state.modelDraft = modelRowDraft(tree()[0].models[0])
    await flush()

    const detail = section(wrapper).find('.models-detail')
    const labels = detail.findAll('label').map((label) => label.text())
    for (const wanted of ['Temperature', 'Top-p', 'Top-k', 'Min-p',
                          'Repeat penalty', 'Presence penalty',
                          'Reasoning level', 'vision']) {
      expect(labels.join(' ')).toContain(wanted)
    }
    // The levels are the read's, not a list the dialog carries.
    const options = detail.find('select').findAll('option').map((o) => o.text())
    expect(options).toEqual(['None', 'off', 'low', 'medium', 'high', 'xhigh'])
  })

  it('marks no model as special anywhere in the section', async () => {
    state.selectedServerId = 1
    await flush()

    // D5: there is no default model, so nothing in the tree or the fields may
    // single one out.
    expect(section(wrapper).text()).not.toMatch(/default/i)
  })
})

// -- the fetched listing belongs to one server ------------------------------------

describe('the fetched model list is a server\'s own', () => {
  let wrapper = null
  let fetchMock = null

  beforeEach(async () => {
    resetShell()
    fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            String(url).startsWith('/api/models?')
              ? { models: ['alpha', 'gamma'] }
              : {},
          ),
      }),
    )
    wrapper = mount(SettingsDialog)
    await flush()
  })

  afterEach(() => {
    wrapper?.unmount()
    vi.restoreAllMocks()
  })

  it('fills the model name field of the server it was fetched for', async () => {
    state.selectedServerId = 1
    state.serverDraft = serverRowDraft(tree()[0])
    await flush()

    await section(wrapper).findAll('button').find((b) => b.text() === 'Fetch models')
      .trigger('click')
    await flush()

    expect(String(fetchMock.mock.calls.at(-1)[0])).toContain('serverUrl=http%3A%2F%2Fx%2Fv1')
    expect(state.fetchedModelIds[1]).toEqual(['alpha', 'gamma'])
    // The other server has no listing of its own, and borrows none.
    expect(state.fetchedModelIds[2]).toBeUndefined()
  })

  it('offers the fetched ids as suggestions for a new model\'s name', async () => {
    state.selectedServerId = 1
    state.serverDraft = serverRowDraft(tree()[0])
    state.fetchedModelIds = { 1: ['alpha', 'gamma'] }
    state.modelDraft = modelRowDraft(null)
    await flush()

    const options = wrapper.find('#models-fetched').findAll('option')
    expect(options.map((option) => option.attributes('value'))).toEqual([
      'alpha', 'gamma',
    ])
  })

  it('shows the listing in the server column the button was clicked from', async () => {
    state.selectedServerId = 1
    state.serverDraft = serverRowDraft(tree()[0])
    await flush()

    const detail = section(wrapper).find('.models-detail')
    // Before the fetch there is nothing to list, and the column says so.
    expect(detail.find('ul.models-fetched-list').exists()).toBe(false)
    expect(detail.text()).toContain('No listing yet')

    await fetchButton(wrapper).trigger('click')
    await flush()

    expect(detail.findAll('ul.models-fetched-list li').map((li) => li.text())).toEqual([
      'alpha', 'gamma',
    ])
    // And the "nothing yet" line is gone, replaced by the names.
    expect(detail.text()).not.toContain('No listing yet')
  })

  it('says it is fetching, and cannot be clicked twice while it is', async () => {
    state.selectedServerId = 1
    state.serverDraft = serverRowDraft(tree()[0])
    let resolveFetch = null
    fetchMock.mockImplementation(() => new Promise((resolve) => {
      resolveFetch = resolve
    }))
    await flush()

    const button = fetchButton(wrapper)
    expect(button.attributes('disabled')).toBeUndefined()

    await button.trigger('click')
    await flush()

    const pending = fetchButton(wrapper)
    expect(pending.text()).toBe('Fetching…')
    expect(pending.attributes('disabled')).toBeDefined()
    // The in-flight listing is this row's, and it is empty until the answer lands.
    expect(section(wrapper).find('.models-detail').text())
      .toContain('Loading this server’s models…')

    resolveFetch({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ models: ['alpha', 'gamma'] }),
    })
    await flush()

    expect(fetchButton(wrapper).text()).toBe('Fetch models')
    expect(fetchButton(wrapper).attributes('disabled')).toBeUndefined()
  })

  it('fetches from a server that is not saved yet, from the URL being typed', async () => {
    // The composable dials the draft's URL on purpose: a server whose address
    // was just corrected must be listable before it is saved.
    state.serverDraft = serverRowDraft(null)
    state.serverDraft.url = 'http://typed/v1'
    await flush()

    const button = fetchButton(wrapper)
    expect(button.attributes('disabled')).toBeUndefined()

    await button.trigger('click')
    await flush()

    expect(String(fetchMock.mock.calls.at(-1)[0])).toContain('serverUrl=http%3A%2F%2Ftyped%2Fv1')
    expect(section(wrapper).find('.models-detail')
      .findAll('ul.models-fetched-list li').map((li) => li.text())).toEqual([
      'alpha', 'gamma',
    ])
  })

  it('shows the server\'s refusal under the button that asked', async () => {
    state.selectedServerId = 1
    state.serverDraft = serverRowDraft(tree()[0])
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 502,
        json: () => Promise.resolve({
          detail: "Could not fetch models from http://x/v1/models: All connection attempts failed",
        }),
      }),
    )
    await flush()

    await fetchButton(wrapper).trigger('click')
    await flush()

    const alert = section(wrapper).find('.models-detail .alert-error')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('All connection attempts failed')
    // A refusal is not a "no listing yet" line beside it.
    expect(section(wrapper).find('.models-detail').text()).not.toContain('No listing yet')
  })

  it('keeps a refusal on the row that got it', async () => {
    state.selectedServerId = 1
    state.serverDraft = serverRowDraft(tree()[0])
    fetchMock.mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 502,
        json: () => Promise.resolve({ detail: 'dialling http://x/v1 failed' }),
      }),
    )
    await flush()
    await fetchButton(wrapper).trigger('click')
    await flush()

    expect(fetchedModelsErrorFor(state.serverDraft)).toContain('failed')

    // Selecting the other server must not carry that failure onto its fields: it
    // was never dialled.
    useAppShell().selectServer(2)
    await flush()

    const detail = section(wrapper).find('.models-detail')
    expect(detail.find('.alert-error').exists()).toBe(false)
    expect(detail.text()).toContain('No listing yet')
    expect(fetchedModelsErrorFor(state.serverDraft)).toBeNull()
  })

  it('clears a row\'s refusal when its next fetch works', async () => {
    state.selectedServerId = 1
    state.serverDraft = serverRowDraft(tree()[0])
    let failure = true
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        failure
          ? { ok: false, status: 502, json: () => Promise.resolve({ detail: 'offline' }) }
          : { ok: true, status: 200, json: () => Promise.resolve({ models: ['alpha'] }) },
      ),
    )
    await flush()
    await fetchButton(wrapper).trigger('click')
    await flush()
    expect(section(wrapper).find('.models-detail .alert-error').text()).toContain('offline')

    failure = false
    await fetchButton(wrapper).trigger('click')
    await flush()

    expect(section(wrapper).find('.models-detail .alert-error').exists()).toBe(false)
    expect(section(wrapper).find('.models-detail')
      .findAll('ul.models-fetched-list li').map((li) => li.text())).toEqual(['alpha'])
  })
})

// -- the unassigned line -----------------------------------------------------------

describe('the unassigned count line', () => {
  let wrapper = null

  beforeEach(async () => {
    resetShell()
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }),
    )
    wrapper = mount(SettingsDialog)
    await flush()
  })

  afterEach(() => {
    wrapper?.unmount()
    vi.restoreAllMocks()
  })

  it('reads the count and opens the Agent-modes dialog on click', async () => {
    const line = section(wrapper).find('.models-unassigned-link')
    expect(line.text()).toContain('2 of 4 agents have no model')

    const before = state.agentModesRequest
    await line.trigger('click')

    expect(state.agentModesRequest).toBe(before + 1)
    // And this dialog steps aside: a card opened behind a modal dialog is a
    // click that did nothing.
    expect(state.settingsOpen).toBe(false)
  })

  it('is absent when every agent has a model', async () => {
    state.unassigned = { agentsWithoutModel: 0, agents: 4 }
    await flush()

    expect(section(wrapper).find('.models-unassigned').exists()).toBe(false)
  })
})

// -- the destructive confirmations ---------------------------------------------------

describe('the destructive confirmations', () => {
  let wrapper = null
  let confirmMock = null

  beforeEach(async () => {
    resetShell()
    confirmMock = vi.spyOn(globalThis, 'confirm').mockReturnValue(false)
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ servers: [] }) }),
    )
    wrapper = mount(SettingsDialog)
    await flush()
  })

  afterEach(() => {
    wrapper?.unmount()
    vi.restoreAllMocks()
  })

  it('names the models a server delete takes with it, and asks first', async () => {
    state.selectedServerId = 1
    state.serverDraft = serverRowDraft(tree()[0])
    await flush()

    const remove = section(wrapper)
      .findAll('button')
      .find((button) => button.text() === 'Remove server')
    await remove.trigger('click')
    await flush()

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(confirmMock.mock.calls[0][0]).toContain('2 models under it')
    expect(confirmMock.mock.calls[0][0]).toContain('no model')
    // Refused: nothing was posted.
    expect(
      vi.spyOn(globalThis, 'fetch').mock.calls.some((call) =>
        String(call[0]).endsWith('/delete'),
      ),
    ).toBe(false)
  })

  it('asks before a model delete too, and says what it costs the agents', async () => {
    state.selectedServerId = 1
    state.selectedModelId = 10
    state.modelDraft = modelRowDraft(tree()[0].models[0])
    await flush()

    const remove = section(wrapper)
      .findAll('button')
      .find((button) => button.text() === 'Remove model')
    await remove.trigger('click')
    await flush()

    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(confirmMock.mock.calls[0][0]).toContain('alpha')
    expect(confirmMock.mock.calls[0][0]).toContain('no model')
  })
})
