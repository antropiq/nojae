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
// one switch per server and the head's **two** icon buttons — the wizard's entry
// point and the restart — and nothing else. The count used to be one button; the
// `Set me up!` entry point is a deliberate widening of this contract (cwizard-08),
// not a loosening: both buttons are named here, and the restart's own title is
// still pinned word for word.

const chat = useChat().state
const batch = useBatch().state
const agentModes = useAgentModes().state

// The agent the panel is showing, with a model: the wizard's entry point is live
// then, and its own name is what the button below is pinned by. Without a model it
// is inert and its accessible name is the refusal — which is the right answer, and
// not what this file is about.
const ROW_WITH_MODEL = {
  id: 'chat',
  label: 'Chat',
  mcpEnable: true,
  lspEnable: true,
  modelId: 7,
  modelName: 'a model',
}

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

  // The switches and the head's two buttons are the whole control surface: one
  // switch per server, the wizard's entry point, and the hub restart — and
  // nothing else. The buttons are pinned **by name** rather than by a bare count,
  // so a third one cannot slip in unnoticed while the feature's own two stay put.
  it('adds no control beyond the switches and the head\'s two buttons', () => {
    seedServers()
    agentModes.modes = [ROW_WITH_MODEL]
    agentModes.current = ROW_WITH_MODEL.id
    agentModes.loaded = true
    const wrapper = mount(WorkBenchLspPanel)

    expect(wrapper.findAll('input[role="switch"]')).toHaveLength(1)
    const buttons = wrapper.findAll('button')
    expect(buttons).toHaveLength(2)
    // The wizard's entry point comes first, then the restart — the order the head
    // reads left to right.
    expect(buttons.map((button) => button.attributes('aria-label'))).toEqual([
      'Set me up!',
      'Restart LSP hub',
    ])
    expect(wrapper.find('.chat-hub-setup').attributes('title')).toBe('Set me up!')
    expect(wrapper.find('.chat-hub-restart').exists()).toBe(true)
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
      { id: 'chat', label: 'Chat', mcpEnable: false, lspEnable: false },
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
