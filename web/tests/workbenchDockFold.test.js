import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'

// jsdom has no ResizeObserver, and both the chat splitters and the reasoning
// panel create one on mount. A no-op is enough here: what this file asserts is
// that the fold is reachable and locked — never a size.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

import WorkBenchView from '../src/components/WorkBenchView.vue'
import { useChat } from '../src/composables/useChat'

// The fold is asserted through the real `WorkBenchView`: the flag lives in the
// `useChatLayout` instance the view owns (the composable is a factory, not a
// singleton), so a second call would report its own initial state and never see
// what a click did. `w.vm.dockCollapsed` is that instance's flag.
//
// Why the lock exists: folding resizes the box the reasoning timeline paints
// into, and WorkBenchToolPanel measures that box once per inference and freezes
// it — so a fold mid-reply leaves the stream flowing in the window computed
// before it. Disabling the button is the reader's half; the setter refusing the
// write is the half that holds for every writer.
const { state: chat, chatBusy } = useChat()

// The streaming half of `chatBusy` is `state.phase`, which is reactive and so
// is what the button's `:disabled` re-evaluates on. The batch half is covered by
// the composable test (a guard closure would not re-render anything here).
function streamReply(on) {
  chat.phase = on ? 'reasoning' : 'idle'
}

function hubs(mcp, lsp) {
  chat.mcp.loaded = mcp
  chat.mcp.connectors = mcp ? [{ id: 'console', label: 'Console', on: true }] : []
  chat.lsp.loaded = lsp
  chat.lsp.servers = lsp ? [{ id: 'pyright', label: 'Pyright', on: true }] : []
}

function foldButton(wrapper) {
  return wrapper.find('.chat-tools-dock-toggle')
}

// Both hubs on: the fold control only exists when the dock has a body.
beforeEach(() => {
  window.localStorage.clear()
  hubs(true, true)
  streamReply(false)
})

afterEach(() => {
  window.localStorage.clear()
  hubs(false, false)
  streamReply(false)
})

describe('the tools dock fold', () => {
  it('folds and unfolds at rest, and writes the flag through', async () => {
    const w = mount(WorkBenchView)
    const btn = foldButton(w)
    expect(btn.exists(), 'the dock renders its fold control').toBe(true)
    expect(btn.attributes()['aria-expanded']).toBe('true')

    await btn.trigger('click')
    expect(w.vm.dockCollapsed).toBe(true)
    expect(window.localStorage.getItem('nojae:chatToolsCollapsed')).toBe('1')
    expect(foldButton(w).attributes()['aria-expanded']).toBe('false')

    await foldButton(w).trigger('click')
    expect(w.vm.dockCollapsed).toBe(false)
    expect(window.localStorage.getItem('nojae:chatToolsCollapsed')).toBe('0')
  })

  // The lock itself: disabled while the model replies, and the click answered
  // without the flag moving (a disabled control still fires in jsdom, and the
  // guard is what makes the rule hold for a writer that is not the button).
  it('refuses the fold while a reply streams, and releases it', async () => {
    streamReply(true)
    const w = mount(WorkBenchView)
    await nextTick()
    expect('disabled' in foldButton(w).attributes()).toBe(true)
    expect(chatBusy(), 'the lock reads the composable rule').toBe(true)

    await foldButton(w).trigger('click')
    expect(w.vm.dockCollapsed).toBe(false)
    expect(window.localStorage.getItem('nojae:chatToolsCollapsed')).toBe(null)

    streamReply(false)
    await nextTick()
    expect('disabled' in foldButton(w).attributes()).toBe(false)

    await foldButton(w).trigger('click')
    expect(w.vm.dockCollapsed).toBe(true)
  })

  // Unfolding is refused too — the box changes either way — and the reason is
  // on the control, so a locked button is not read as a broken one.
  it('refuses to unfold while a reply streams, and says why', async () => {
    window.localStorage.setItem('nojae:chatToolsCollapsed', '1')
    streamReply(true)
    const w = mount(WorkBenchView)
    await nextTick()

    expect(w.vm.dockCollapsed).toBe(true)
    expect(foldButton(w).attributes().title).toContain('Locked while the model is replying')

    await foldButton(w).trigger('click')
    expect(w.vm.dockCollapsed).toBe(true)
    expect(window.localStorage.getItem('nojae:chatToolsCollapsed')).toBe('1')
  })

  // The control is disabled, never removed: the dock's own body and its summary
  // still read off the fold, and a button that vanished mid-reply and came back
  // afterwards would read as a bug rather than as a lock.
  it('keeps the control on screen while it is locked', async () => {
    const w = mount(WorkBenchView)
    streamReply(true)
    await nextTick()
    expect(foldButton(w).exists()).toBe(true)
    // The dock is still a dock: its head strip is what the fold would take away.
    expect(w.find('.chat-tools-dock-head').exists()).toBe(true)
  })
})
