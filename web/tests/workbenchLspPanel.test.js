import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import WorkBenchLspPanel from '../src/components/WorkBenchLspPanel.vue'
import { useAgentModes } from '../src/composables/useAgentModes'
import { useBatch } from '../src/composables/useBatch'
import { useChat } from '../src/composables/useChat'

// Layer 1 (jsdom): the LSP panel's shape (lspe-11).
//
// The panel's rows are conversation-scoped switches, and the Editor's code pane
// obeys the same ones (§4.3). What this file pins down is the panel's surface:
// one switch per server and the restart button, nothing else — no second
// control, no renamed title, no changed row title, no touched gate.

const chat = useChat().state
const batch = useBatch().state
const agentModes = useAgentModes().state

function seedServers() {
  chat.lsp.loaded = true
  chat.lsp.servers = [{ id: 'pyright', label: 'Pyright', status: 'running' }]
  chat.lsp.enabled = { pyright: true }
}

function resetState() {
  chat.phase = 'idle'
  chat.lsp = { servers: [], enabled: {}, loaded: false, locked: false, restarting: false }
  batch.active = false
  agentModes.modes = []
  agentModes.current = null
  agentModes.loaded = false
}

describe('the LSP panel', () => {
  beforeEach(resetState)

  // The switches are the whole control surface: one per server, plus the hub
  // restart, and nothing else.
  it('adds no control beyond the switches and the restart', () => {
    seedServers()
    const wrapper = mount(WorkBenchLspPanel)

    expect(wrapper.findAll('input[role="switch"]')).toHaveLength(1)
    expect(wrapper.findAll('button')).toHaveLength(1) // the hub restart, unchanged
    wrapper.unmount()
  })

  it('leaves the title, the row title and the restart button as they were', () => {
    seedServers()
    const wrapper = mount(WorkBenchLspPanel)

    expect(wrapper.find('.chat-mcp-title').text()).toBe('LSP tools')
    expect(wrapper.find('.chat-mcp-row').attributes('title')).toBe(
      'Use Pyright tools in this conversation',
    )
    expect(wrapper.find('.chat-hub-restart').attributes('title')).toBe(
      'Restart the LSP hub: respawn every server from .nojae/lsp-settings.json',
    )
    wrapper.unmount()
  })

  // A mode gate makes the rows inert and its tooltip says why, but never
  // removes them: the switches keep their values and stay on screen (§4.3).
  it('stays in place while a mode gates the switches', () => {
    seedServers()
    agentModes.modes = [
      { id: 'chat', label: 'Chat', mcptools: false, lsptools: false, editable: true },
    ]
    agentModes.current = 'chat'
    agentModes.loaded = true
    const wrapper = mount(WorkBenchLspPanel)

    expect(wrapper.find('.chat-hub-gate').exists()).toBe(false)
    expect(wrapper.get('.chat-mcp-row').attributes('title')).toContain('Chat')
    expect(wrapper.findAll('input[role="switch"]')).toHaveLength(1)
    expect(wrapper.get('input[role="switch"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})
