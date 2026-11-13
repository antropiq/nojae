import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import SettingsDialog from '../src/components/SettingsDialog.vue'
import { useAppShell } from '../src/composables/useAppShell'

// The "Max tool iterations" knob left the Settings dialog entirely (D9): it is
// a **per-agent** column now, edited on that agent's tab in the Agent-modes
// dialog. So neither the MCP tab nor the LSP tab may present an input for it —
// a field here would be a second writer of a value that belongs to an agent.
// All sections render (v-show, not v-if), so the test picks a section by title.
//
// The LSP section lost its *second gate* with D13, so this file also pins what a
// tick means now: the row's tooltip says the tick is the whole decision, and the
// save posts nothing but the ids — no cap it can no longer set.

const { state } = useAppShell()

function settings() {
  return {
    serverUrl: '',
    apiKey: '',
    endpoint: '',
    sysprompt: '',
    temp: null, topP: null, topK: null, minP: null, repeatPenalty: null,
    presencePenalty: null, reasoning: '', supportsVision: false,
  }
}

function sectionByTitle(wrapper, title) {
  return wrapper
    .findAll('.settings-editor > section')
    .find((section) => section.find('h3').text() === title)
}

describe('the Max tool iterations knob left the dialog with D9', () => {
  beforeEach(() => {
    state.settings = settings()
    state.settingsError = null
    state.mcpInstalled = true
    state.mcpConnectors = []
    state.lspInstalled = true
    state.lspServers = []
  })

  it('shows no iteration input in the MCP section', () => {
    const wrapper = mount(SettingsDialog)
    const mcp = sectionByTitle(wrapper, 'MCP connectors')
    expect(mcp.find('label.mcp-iterations').exists()).toBe(false)
    expect(mcp.text()).not.toContain('Max tool iterations')
    wrapper.unmount()
  })

  it('shows no iteration input in the LSP section', () => {
    const wrapper = mount(SettingsDialog)
    const lsp = sectionByTitle(wrapper, 'LSP language servers')
    expect(lsp.exists()).toBe(true)
    expect(lsp.find('label.mcp-iterations').exists()).toBe(false)
    expect(lsp.text()).not.toContain('Max tool iterations')
    wrapper.unmount()
  })
})

describe('the LSP row is the whole activation decision (D13)', () => {
  const SERVERS = [
    { id: 'pyright', label: 'Pyright', active: true, status: 'running' },
    { id: 'vue', label: 'Vue', active: false, status: 'stopped' },
  ]

  beforeEach(() => {
    state.settings = settings()
    state.settingsError = null
    state.lspInstalled = true
    state.lspServers = SERVERS
    state.lspActivated = SERVERS.filter((s) => s.active).map((s) => s.id)
    state.lspSaving = false
    state.lspLoading = false
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The meaning of a tick changed, so the row has to say so: one gate, and the
  // flag in the declaration file is what it writes.
  it('says on the row that the tick is the whole decision', () => {
    const wrapper = mount(SettingsDialog)
    const row = sectionByTitle(wrapper, 'LSP language servers').find('label.mcp-activate')
    const tooltip = row.attributes('title')

    expect(tooltip).toBeTruthy()
    expect(tooltip).toContain('enable')
    expect(tooltip).toContain('.nojae/lsp-settings.json')
    wrapper.unmount()
  })

  // The payload is the ids and nothing else: a `maxIterations` in it would be a
  // second writer of a value this section no longer edits.
  it('saves only the ids', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ installed: true, servers: SERVERS, serversError: null }),
    })

    await useAppShell().saveLsp()

    // The save itself is the first call (the panel refresh that follows is a
    // plain GET); its body is the ids and nothing else.
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/lsp')
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ enabled: ['pyright'] })
  })
})
