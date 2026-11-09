import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import SettingsDialog from '../src/components/SettingsDialog.vue'
import { useAppShell } from '../src/composables/useAppShell'

// The "Max tool iterations" knob caps the single shared MCP+LSP tool loop, but
// the user reads it as an MCP-tool setting. It therefore belongs to the MCP tab
// only: the LSP tab offers query-style tools through a different mechanism and
// must not present a second input editing the same value. All sections render
// (v-show, not v-if), so the test picks a section by its title.

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

describe('the Max tool iterations knob lives only in the MCP tab', () => {
  beforeEach(() => {
    state.settings = settings()
    state.settingsError = null
    state.mcpInstalled = true
    state.mcpConnectors = []
    state.lspInstalled = true
    state.lspServers = []
  })

  it('shows the input in the MCP section', () => {
    const wrapper = mount(SettingsDialog)
    const mcp = sectionByTitle(wrapper, 'MCP connectors')
    expect(mcp.find('label.mcp-iterations').exists()).toBe(true)
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
