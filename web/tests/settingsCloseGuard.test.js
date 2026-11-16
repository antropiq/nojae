import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import SettingsDialog from '../src/components/SettingsDialog.vue'
import { closeWouldLoseForSettings, useAppShell } from '../src/composables/useAppShell'

// ---------------------------------------------------------------------------
// The Settings dialog's close guard — the Agents card's D8, ported.
//
// `Close` is the dialog's only exit and it writes nothing, so while it holds work
// that was typed and never written it must ask **in place** rather than take the
// form away. The bug this suite exists for: renaming a server and clicking `Close`
// dropped the dialog and the rename with it, silently.
//
// The guard's only input is *the store's answer as the baseline, against what the
// form holds*. That baseline is `state.servers` (adopted wholesale by every read
// and every write) and the hub rows' `active` flags — never a snapshot of what was
// typed, which is the whole invariant. A **save** re-baselines, so closing
// straight after one costs no extra click.
//
// `Close`, Escape and a backdrop click are **one verb**, so all three take the
// guard: a route that skipped it would be the silent bypass the guard is written
// against.
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
      model(10, 'alpha', { temperature: 0.2 }),
    ] },
    { id: 2, name: 'Cloud', url: 'https://y/v1', apiKey: '', models: [] },
  ]
}

function resetShell() {
  state.settings = { store: true }
  // **Closed**, and opened by the harness below: the dialog's open/close watch is
  // not `immediate`, so a mount with the flag already true would never call
  // `showModal()` and every `dialog.open` assertion here would read a lie.
  state.settingsOpen = false
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

async function open() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const path = String(url)
    if (path.startsWith('/api/mcp')) return Promise.resolve(json({ connectors: [] }))
    if (path.startsWith('/api/lsp')) return Promise.resolve(json({ servers: [] }))
    if (path.startsWith('/api/config')) return Promise.resolve(json({ models: [] }))
    return Promise.resolve(json({
      servers: tree(),
      caps: CAPS,
      unassigned: { agentsWithoutModel: 0, agents: 4 },
    }))
  })
  wrapper = mount(SettingsDialog, { attachTo: document.body })
  await flushPromises()
  // The gesture the app bar performs: the flag flips, the watch calls `showModal`.
  state.settingsOpen = true
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
  vi.restoreAllMocks()
}

const posts = () =>
  vi.mocked(globalThis.fetch).mock.calls
    .filter((call) => call[1]?.method === 'POST')
    .map((call) => String(call[0]))

const closeButton = () => wrapper.find('.settings-close')
const keepEditingButton = () => wrapper.find('.settings-keep-editing')
const discardCloseButton = () => wrapper.find('.settings-discard-close')
const footerSlot = () => wrapper.find('.agent-modes-footer-slot')
const band = () => wrapper.find('.agent-modes-message')
const dialogEl = () => wrapper.find('dialog').element

async function pressEscape() {
  const event = new window.Event('cancel', { bubbles: true, cancelable: true })
  dialogEl().dispatchEvent(event)
  await flushPromises()
  return event
}

async function clickBackdrop() {
  wrapper.find('dialog').trigger('click')
  await flushPromises()
}

// -- the verdict, asked of the shell's state -----------------------------------

describe('closeWouldLoseForSettings', () => {
  beforeEach(() => resetShell())

  it('is no when the store was read and nothing was touched', () => {
    useAppShell().selectServer(1)
    expect(closeWouldLoseForSettings(state)).toBe(false)
  })

  it('is yes the moment a stored server\u2019s name differs from the store\u2019s row', () => {
    useAppShell().selectServer(1)
    state.serverDraft.name = 'Local-renamed'
    expect(closeWouldLoseForSettings(state)).toBe(true)
  })

  it('is yes for a model field, including a sampler typed as text', () => {
    useAppShell().selectModel(10)
    state.modelDraft.temperature = '0.9'
    expect(closeWouldLoseForSettings(state)).toBe(true)
  })

  it('is no for a number the form holds as text but did not change', () => {
    useAppShell().selectModel(10)
    state.modelDraft.temperature = '0.2'
    expect(closeWouldLoseForSettings(state)).toBe(false)
  })

  it('is no for an Add the user opened and never typed into', () => {
    useAppShell().addServerRow()
    expect(closeWouldLoseForSettings(state)).toBe(false)
    state.serverDraft.name = 'Third'
    expect(closeWouldLoseForSettings(state)).toBe(true)
  })

  it('is yes when a hub tick disagrees with the declaration the read answered', () => {
    state.mcpConnectors = [
      { id: 'console', active: true },
      { id: 'fedit', active: false },
    ]
    state.mcpEnabled = ['console']
    state.lspServers = [{ id: 'pyright', active: true }]
    state.lspActivated = ['pyright']
    expect(closeWouldLoseForSettings(state)).toBe(false)
    state.mcpEnabled = ['console', 'fedit']
    expect(closeWouldLoseForSettings(state)).toBe(true)
  })

  it('is yes for a language-server tick, the same way', () => {
    state.lspServers = [
      { id: 'pyright', active: true },
      { id: 'vue', active: false },
    ]
    state.lspActivated = ['pyright', 'vue']
    expect(closeWouldLoseForSettings(state)).toBe(true)
    // Re-ticking back to what the declaration says is no longer unsaved work.
    state.lspActivated = ['pyright']
    expect(closeWouldLoseForSettings(state)).toBe(false)
  })

  it('is yes when the row a draft addresses is no longer in the tree', () => {
    useAppShell().selectServer(1)
    state.servers = tree().slice(1)
    expect(closeWouldLoseForSettings(state)).toBe(true)
  })
})

// -- the verb, on the mounted dialog -------------------------------------------

describe('the close guard asks instead of taking the form away', () => {
  beforeEach(() => resetShell())
  afterEach(close)

  it('a renamed server plus `Close` asks in the footer\u2019s reserved slot and writes nothing', async () => {
    await open()
    useAppShell().selectServer(1)
    await flushPromises()
    state.serverDraft.name = 'Local-renamed'
    await flushPromises()

    // Both answers are **absent from the DOM** before the question is asked, and
    // the slot they arrive in is already there.
    expect(keepEditingButton().exists()).toBe(false)
    expect(discardCloseButton().exists()).toBe(false)
    expect(footerSlot().exists()).toBe(true)

    await closeButton().trigger('click')
    await flushPromises()

    expect(keepEditingButton().exists()).toBe(true)
    expect(discardCloseButton().exists()).toBe(true)
    expect(footerSlot().element.contains(keepEditingButton().element)).toBe(true)
    expect(footerSlot().element.contains(discardCloseButton().element)).toBe(true)
    // The dialog is still open, the rename is still typed, and nothing was posted.
    expect(dialogEl().open).toBe(true)
    expect(state.settingsOpen).toBe(true)
    expect(state.serverDraft.name).toBe('Local-renamed')
    expect(posts()).toEqual([])
    // One question, in the band, and it is the Agents card's own wording.
    expect(band().text()).toBe('There are unsaved changes. Close anyway?')
    expect(band().attributes('role')).toBe('status')
    expect(wrapper.findAll('.agent-modes-message')).toHaveLength(1)
    // Each glyph's tooltip is its accessible name, so they cannot drift.
    expect(keepEditingButton().attributes('title')).toBe('Keep editing')
    expect(keepEditingButton().attributes('aria-label')).toBe('Keep editing')
    expect(discardCloseButton().attributes('title')).toBe('Discard and close')
    expect(discardCloseButton().attributes('aria-label')).toBe('Discard and close')
    // Focus landed on the safe answer.
    expect(document.activeElement).toBe(keepEditingButton().element)
    // And one decision at a time: while the dialog asks, no verb can write.
    expect(wrapper.find('.servers-add').element.disabled).toBe(true)
    expect(wrapper.find('.servers-save').element.disabled).toBe(true)
    expect(wrapper.find('.servers-delete').element.disabled).toBe(true)
    expect(wrapper.find('.servers-add').attributes('title')).toContain(
      'confirmation is pending',
    )
  })

  it('an untouched model form — eleven fields, all the store\u2019s — is not work to lose', async () => {
    await open()
    useAppShell().selectModel(10)
    await flushPromises()
    expect(state.modelDraft.id).toBe(10)

    await closeButton().trigger('click')
    await flushPromises()

    // The comparison is per field against the store's row, so an unset sampler
    // (`null` in the row, `''` in the field) cannot make the guard ask either.
    expect(state.settingsOpen).toBe(false)
    expect(keepEditingButton().exists()).toBe(false)
    expect(band().text()).toBe('')
  })

  it('with nothing unsaved, `Close` leaves at once and the pair is never rendered', async () => {
    await open()
    useAppShell().selectServer(1)
    await flushPromises()

    await closeButton().trigger('click')
    await flushPromises()

    expect(state.settingsOpen).toBe(false)
    expect(dialogEl().open).toBe(false)
    expect(keepEditingButton().exists()).toBe(false)
    expect(discardCloseButton().exists()).toBe(false)
    expect(posts()).toEqual([])
  })

  it('`Keep editing` hides the pair and changes nothing else', async () => {
    await open()
    useAppShell().selectModel(10)
    await flushPromises()
    state.modelDraft.sysPrompt = 'typed and not saved'
    // The typing is on the page that is **not** drawn: both pages are one form, so
    // a keystroke the user cannot even see is still work leaving would drop.
    await wrapper.findAll('.models-detail-tab')[1].trigger('click')
    await flushPromises()
    await closeButton().trigger('click')
    await flushPromises()
    expect(keepEditingButton().exists()).toBe(true)

    await keepEditingButton().trigger('click')
    await flushPromises()

    expect(keepEditingButton().exists()).toBe(false)
    expect(dialogEl().open).toBe(true)
    expect(state.settingsOpen).toBe(true)
    expect(state.modelDraft.sysPrompt).toBe('typed and not saved')
    expect(state.selectedModelId).toBe(10)
    expect(state.pendingClose).toBe(false)
    expect(posts()).toEqual([])
    // Focus went back to the verb that asked, not to <body>.
    expect(document.activeElement).toBe(closeButton().element)
  })

  it('`Discard and close` is an unguarded `Close`: it leaves, writes nothing, and drops the forms', async () => {
    await open()
    useAppShell().selectServer(1)
    await flushPromises()
    state.serverDraft.url = 'https://moved.example/v1'
    await closeButton().trigger('click')
    await flushPromises()

    await discardCloseButton().trigger('click')
    await flushPromises()

    expect(state.settingsOpen).toBe(false)
    expect(dialogEl().open).toBe(false)
    expect(posts()).toEqual([])
    // The typing went with the close, so a re-open asks nothing: the answer the
    // user gave is the answer the next open gives too.
    expect(state.serverDraft).toBeNull()
    useAppShell().selectServer(1)
    expect(closeWouldLoseForSettings(state)).toBe(false)
  })

  it('Escape and a backdrop click are `Close`, so they take the same guard', async () => {
    await open()
    useAppShell().selectServer(1)
    await flushPromises()
    state.serverDraft.name = 'Local-renamed'
    await flushPromises()

    const event = await pressEscape()
    expect(event.defaultPrevented).toBe(true)
    expect(keepEditingButton().exists()).toBe(true)
    expect(dialogEl().open).toBe(true)
    expect(state.settingsOpen).toBe(true)

    // A backdrop click is the same gesture and the same answer.
    await clickBackdrop()
    expect(keepEditingButton().exists()).toBe(true)
    expect(state.settingsOpen).toBe(true)
    expect(posts()).toEqual([])
  })

  it('with nothing unsaved, Escape and a backdrop click still leave at once', async () => {
    await open()
    useAppShell().selectServer(1)
    await flushPromises()

    await pressEscape()
    expect(state.settingsOpen).toBe(false)
    expect(dialogEl().open).toBe(false)
    expect(keepEditingButton().exists()).toBe(false)

    close()
    await open()
    useAppShell().selectServer(1)
    await flushPromises()
    await clickBackdrop()
    expect(state.settingsOpen).toBe(false)
    expect(keepEditingButton().exists()).toBe(false)
  })

  it('a save re-baselines, so closing straight after it costs no extra click', async () => {
    await open()
    useAppShell().selectServer(1)
    await flushPromises()
    state.serverDraft.name = 'Local-renamed'
    await flushPromises()

    await wrapper.find('.servers-save').trigger('click')
    await flushPromises()

    expect(posts()).toContain('/api/servers/save')
    await closeButton().trigger('click')
    await flushPromises()

    expect(keepEditingButton().exists()).toBe(false)
    expect(state.settingsOpen).toBe(false)
  })

  it('a tick in another section is unsaved work too, whatever section is on screen', async () => {
    state.mcpConnectors = [{ id: 'console', active: false }]
    state.mcpEnabled = []
    await open()
    state.activeSection = 'servers'
    await flushPromises()
    useAppShell().selectServer(1)
    await flushPromises()

    useAppShell().toggleMcp('console', true)
    await flushPromises()

    await closeButton().trigger('click')
    await flushPromises()
    expect(keepEditingButton().exists()).toBe(true)
    expect(state.settingsOpen).toBe(true)
  })

  it('while the guard asks, a hub section\u2019s own `Save` is inert too', async () => {
    state.mcpConnectors = [{ id: 'console', active: false }]
    state.mcpEnabled = []
    await open()
    state.activeSection = 'mcp'
    await flushPromises()
    useAppShell().toggleMcp('console', true)
    await closeButton().trigger('click')
    await flushPromises()

    const save = wrapper.find('.settings-section-save')
    expect(save.element.disabled).toBe(true)
    expect(save.attributes('title')).toContain('confirmation is pending')
  })

  it('a pending delete is abandoned by `Close`, which then answers on its own terms', async () => {
    await open()
    useAppShell().selectServer(1)
    await flushPromises()
    await wrapper.find('.servers-delete').trigger('click')
    await flushPromises()
    expect(wrapper.find('.servers-confirm-delete').exists()).toBe(true)
    expect(band().text()).toContain('Delete Local')

    state.serverDraft.name = 'Local-renamed'
    await closeButton().trigger('click')
    await flushPromises()

    // Nothing was written for the delete, so it goes; the close question answers.
    expect(wrapper.find('.servers-confirm-delete').exists()).toBe(false)
    expect(state.pendingDelete).toBeNull()
    expect(keepEditingButton().exists()).toBe(true)
    expect(band().text()).toBe('There are unsaved changes. Close anyway?')
  })

  it('the band\u2019s `Assign one` is a close too, and the guard does not let it discard typing', async () => {
    state.unassigned = { agentsWithoutModel: 2, agents: 4 }
    await open()
    useAppShell().selectServer(1)
    await flushPromises()
    state.serverDraft.name = 'Local-renamed'
    // The band's action button only renders for the cross-store line, which the
    // guard's question outranks — so it is clicked while the line still shows it.
    expect(wrapper.find('.settings-message-action').exists()).toBe(true)
    const before = state.agentModesRequest

    await wrapper.find('.settings-message-action').trigger('click')
    await flushPromises()

    // Stopped by the guard: still open, nothing asked for yet.
    expect(state.settingsOpen).toBe(true)
    expect(state.agentModesRequest).toBe(before)
    expect(keepEditingButton().exists()).toBe(true)

    // The answer that leaves also performs the intent that was stopped.
    await discardCloseButton().trigger('click')
    await flushPromises()
    expect(state.settingsOpen).toBe(false)
    expect(state.agentModesRequest).toBe(before + 1)
  })
})

// -- what the mechanism must not turn into --------------------------------------

describe('the guard is the composable\u2019s answer, never a condition of the template', () => {
  it('the dialog reads verdicts, and spells no question, no label and no comparison itself', () => {
    const source = wrapperSource()
    // Both halves of the guard are verdicts, imported from the rule modules.
    expect(source).toContain('closeConfirmation')
    expect(source).toContain('askClose')
    expect(source).toContain('discardAndClose')
    // Neither the question nor the pair's two answers is spelled here, and the
    // baseline comparison happens nowhere near the template.
    const template = /<template>[\s\S]*<\/template>/.exec(source)[0]
    expect(template).not.toMatch(/unsaved changes|Keep editing|Discard and close/)
    expect(template).toMatch(/v-if="closeConfirmation\.rendered"/)
    expect(template).not.toMatch(/v-if="state\.pendingClose/)
    // No route reaches the act of closing except through the guard's answers.
    expect(template).not.toMatch(/@click="closeSettings"/)
    expect(template).toMatch(/@cancel="onEscape"/)
  })

  it('every exit is routed through the guard, in the shell as well as the card', () => {
    const dialog = wrapperSource()
    const handlers = /<script setup>[\s\S]*<\/script>/.exec(dialog)[0]
    // The three routes out call the same verb; `closeSettings` is left only to the
    // native-close sync, which fires when the flag has already dropped.
    expect(handlers.match(/askClose\(\)/g)).toHaveLength(3)
    expect(handlers).toContain('if (state.settingsOpen) closeSettings()')
  })
})

function wrapperSource() {
  return readFileSync(resolve('src/components/SettingsDialog.vue'), 'utf8')
}
