import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { h } from 'vue'

// qop-07: the EditorArea half of the chord wiring. The real Monaco surface is
// stubbed (a real one needs a browser — see probe-monaco.test.js); the stub
// exposes the same imperative surface (`focus`) and can be told to emit
// `quick-open`, which is what the Monaco command does in the browser. What is
// asserted is the pane's wiring only: the emit reaches `openDialog`, a pick
// returns focus to the surface, and the window chord reaches the same dialog.
const focusSpy = vi.hoisted(() => vi.fn())

vi.mock('../src/components/MonacoEditor.vue', () => ({
  default: {
    name: 'MonacoEditorStub',
    props: ['content', 'language', 'readonly', 'ariaLabel'],
    emits: ['content-change', 'quick-open'],
    methods: { focus: focusSpy },
    render() {
      return h('div', { class: 'stub-monaco' })
    },
  },
}))
vi.mock('../src/components/MonacoDiffViewer.vue', () => ({
  default: {
    name: 'MonacoDiffViewerStub',
    render() {
      return h('div', { class: 'stub-diff' })
    },
  },
}))

import EditorArea from '../src/components/EditorArea.vue'
import { useAppShell } from '../src/composables/useAppShell'
import { useEditorFiles } from '../src/composables/useEditorFiles'
import { useQuickOpen } from '../src/composables/useQuickOpen'
import { useWorkspaceTree } from '../src/composables/useWorkspaceTree'

const files = useEditorFiles()
const tree = useWorkspaceTree()
const quick = useQuickOpen()
const appShell = useAppShell()

function fileRecord(path, text) {
  return {
    kind: 'file',
    key: path,
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    text,
    baseline: text,
    dirty: false,
    mtime: 1000,
    language: 'plaintext',
    size: text.length,
    binary: false,
    truncated: false,
    truncatedAt: null,
    encoding: 'utf-8',
    stale: false,
    deleted: false,
    conflict: null,
    conflictAt: 0,
    conflictDetail: null,
    saving: false,
    reloadedAt: 0,
  }
}

function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

async function mountPane() {
  files.state.open.splice(0, files.state.open.length, fileRecord('notes.md', 'one\n'))
  files.state.active = 'notes.md'
  const wrapper = mount(EditorArea, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  // jsdom has no `showModal`/`close` on `<dialog>`; the same patch
  // quickOpenDialog.test.js applies — the component's watch only needs
  // `el.open` to be truthful.
  Element.prototype.showModal = function showModal() {
    this.open = true
  }
  Element.prototype.close = function close() {
    this.open = false
  }
  Element.prototype.scrollIntoView = function scrollIntoView() {}
  focusSpy.mockClear()
  files.state.open.splice(0, files.state.open.length)
  files.state.active = null
  files.state.message = null
  tree.state.nodes = {}
  tree.state.expanded = { '': true }
  tree.state.focused = ''
  tree.state.selected = null
  tree.state.editing = null
  tree.state.error = null
  tree.state.workspace = '/w/demo'
  quick.state.open = false
  quick.state.query = ''
  quick.state.list = []
  quick.state.status = 'idle'
  quick.state.selected = 0
  quick.state.truncated = false
  quick.state.error = null
  appShell.state.activeTab = 'editor'
  vi.restoreAllMocks()
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    if (String(url).startsWith('/api/fs/files')) {
      return jsonResponse({ files: ['notes.md'], fileCount: 1, truncated: false })
    }
    return jsonResponse({ path: '', workspace: '/w/demo', entries: [], truncated: false })
  })
})

describe('the Monaco command reaches the dialog', () => {
  it('the surface\'s quick-open emit opens the dialog', async () => {
    const wrapper = await mountPane()
    const stub = wrapper.findComponent({ name: 'MonacoEditorStub' })
    stub.vm.$emit('quick-open')
    await flushPromises()

    expect(quick.state.open).toBe(true)
    expect(quick.state.status).toBe('ready')
    wrapper.unmount()
  })
})

describe('a pick returns focus to the pane', () => {
  it('the registered pane-focus handler calls the surface\'s focus', async () => {
    const wrapper = await mountPane()
    quick.pick('notes.md')
    await flushPromises()

    expect(focusSpy).toHaveBeenCalledTimes(1)
    expect(quick.state.open).toBe(false)
    wrapper.unmount()
  })
})

describe('the window chord reaches the dialog through the pane', () => {
  it('Ctrl+P on the Editor tab opens the dialog and is consumed', async () => {
    await mountPane()
    const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, cancelable: true })
    window.dispatchEvent(event)
    await flushPromises()

    expect(event.defaultPrevented).toBe(true)
    expect(quick.state.open).toBe(true)
  })

  it('Ctrl+P on another tab is neither consumed nor answered', async () => {
    await mountPane()
    appShell.state.activeTab = 'workbench'
    const event = new KeyboardEvent('keydown', { key: 'p', ctrlKey: true, cancelable: true })
    window.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(false)
    expect(quick.state.open).toBe(false)
  })
})
