import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

// jsdom has no ResizeObserver and the panel creates one on mount. A no-op is
// enough: what this file asserts is the badge's text and classes, never a size.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

import WorkBenchToolPanel from '../src/components/WorkBenchToolPanel.vue'
import { useChat } from '../src/composables/useChat'

// Layer 1 (jsdom): the badge a bad tool call paints in the reasoning panel.
//
// A model that writes a tool call out as text instead of submitting it has its
// round repaired by the server (see tests/test_chat.py), and the panel is told
// so with `bad: true` on the `tool_call` frame. What this file pins down is
// that the badge says which failure it is — not that a connector's call went
// wrong, which is what `state: 'error'` already means.

const chat = useChat().state

function seedTool(tool) {
  chat.phase = 'idle'
  chat.messages = [
    {
      role: 'assistant',
      raw: 'answer',
      blocks: [{ kind: 'tool', tool }],
    },
  ]
}

function badges() {
  return mount(WorkBenchToolPanel).findAll('.chat-tool')
}

describe('the reasoning panel badge', () => {
  beforeEach(() => {
    chat.messages = []
  })

  it('names a bad tool call instead of a connector method', () => {
    seedTool({ id: 'b', tool: 'read_files', server: '', bad: true, state: 'error' })
    const [badge] = badges()
    expect(badge.text()).toContain('bad tool call')
    expect(badge.text()).toContain('read_files')
    expect(badge.classes()).toContain('chat-tool--bad')
  })

  it('leaves a connector call looking like one', () => {
    seedTool({ id: 'c', tool: 'read_file', server: 'fedit', state: 'ok' })
    const [badge] = badges()
    expect(badge.text()).toContain('fedit::read_file')
    expect(badge.text()).not.toContain('bad tool call')
    expect(badge.classes()).not.toContain('chat-tool--bad')
  })

  it('keeps the red mark on a connector call that merely failed', () => {
    // `state: 'error'` already had a red glyph; that is a different failure and
    // must not be relabelled as a bad tool call.
    seedTool({ id: 'd', tool: 'read_file', server: 'fedit', state: 'error' })
    const [badge] = badges()
    expect(badge.classes()).toContain('error')
    expect(badge.classes()).not.toContain('chat-tool--bad')
    expect(badge.text()).not.toContain('bad tool call')
  })
})
