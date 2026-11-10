import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { h } from 'vue'

// ---------------------------------------------------------------------------
// lspe-10: the EditorArea half of the language-server feature.
//
// The real Monaco surface is stubbed (a real one needs a browser — see
// probe-monaco.test.js); the stub carries the same props and emits the same
// `definition` event the real one does, which is exactly the seam this file is
// about. What is asserted is the pane's wiring only:
//
//   * the active buffer's path reaches the surface (without it no provider can
//     say which file a Ctrl+click is about);
//   * a definition target in another file opens that buffer and then reveals the
//     position through the surface's existing queue; a target in the same file
//     reveals directly; a refused open reveals nothing.
//
// The composable's own rules (one request per gesture, the `starting` retry, the
// quiet answer) are useEditorLsp.test.js's; the server's are
// tests/test_lsp_editor.py's.
// ---------------------------------------------------------------------------

const revealSpy = vi.hoisted(() => vi.fn())

vi.mock('../src/components/MonacoEditor.vue', () => ({
  default: {
    name: 'MonacoEditorStub',
    props: ['content', 'language', 'path', 'readonly', 'ariaLabel'],
    emits: ['content-change', 'quick-open', 'definition'],
    methods: { revealPosition: revealSpy },
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
import { useEditorLsp } from '../src/composables/useEditorLsp'
import { useWorkspaceTree } from '../src/composables/useWorkspaceTree'

const files = useEditorFiles()
const lsp = useEditorLsp()
const tree = useWorkspaceTree()
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

function diffRecord(path) {
  return {
    kind: 'diff',
    key: `diff:${path}`,
    path,
    name: `${path} (diff)`,
    original: 'before\n',
    modified: 'after\n',
    language: 'plaintext',
    status: 'modified',
    baseline: 'head',
    renamedFrom: null,
    truncated: false,
    truncatedAt: null,
  }
}

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

// The wire envelope, exactly as `core/lsphub/editor.py` builds it.
function envelope({
  status = 'ok',
  server = 'pyright',
  reason = null,
  action = 'status',
  result = null,
} = {}) {
  return { status, server, reason, action, result }
}

// The routes this pane touches: the language-server query, a buffer read, and
// the tree's listing (the active-tab watcher reveals the row). Anything else
// answers empty.
function stubRoutes({ queryAnswer = envelope(), fileAnswer = null } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const key = String(url)
    if (key.startsWith('/api/lsp/query')) return jsonResponse(queryAnswer)
    if (key.startsWith('/api/fs/file?')) {
      const path = decodeURIComponent(key.slice('/api/fs/file?path='.length))
      if (fileAnswer) return fileAnswer(path)
      return jsonResponse({
        path,
        text: 'x = 1\n',
        mtime: 1000,
        language: 'python',
        size: 6,
        binary: false,
        truncated: false,
      })
    }
    return jsonResponse({ path: '', workspace: '/w/demo', entries: [], truncated: false })
  })
}

async function mountPane(records, activeKey) {
  files.state.open.splice(0, files.state.open.length, ...records)
  files.state.active = activeKey
  const wrapper = mount(EditorArea, { attachTo: document.body })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  revealSpy.mockClear()
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
  lsp.clear()
  // The freshness tick is off for these tests (it would poll), and it only
  // starts on the Editor tab.
  appShell.state.activeTab = 'chat'
  vi.restoreAllMocks()
})

describe('the surface is told which buffer it shows', () => {
  it('passes the active buffer\'s path to the mount', async () => {
    stubRoutes()
    const wrapper = await mountPane([fileRecord('src/app.py', 'x = 1\n')], 'src/app.py')

    expect(wrapper.findComponent({ name: 'MonacoEditorStub' }).props('path')).toBe('src/app.py')
    wrapper.unmount()
  })

  it('moves the path with the active buffer', async () => {
    stubRoutes()
    const wrapper = await mountPane(
      [fileRecord('src/app.py', 'x = 1\n'), fileRecord('src/other.py', 'y = 2\n')],
      'src/app.py',
    )

    files.state.active = 'src/other.py'
    await flushPromises()

    expect(wrapper.findComponent({ name: 'MonacoEditorStub' }).props('path')).toBe('src/other.py')
    wrapper.unmount()
  })
})

describe('a definition target in another file', () => {
  it('opens that buffer and then reveals the position', async () => {
    stubRoutes()
    const wrapper = await mountPane([fileRecord('src/app.py', 'x = 1\n')], 'src/app.py')
    const stub = wrapper.findComponent({ name: 'MonacoEditorStub' })

    stub.vm.$emit('definition', { path: 'src/other.py', line: 7, column: 3 })
    await flushPromises()

    expect(files.state.open.map((item) => item.path)).toEqual(['src/app.py', 'src/other.py'])
    expect(files.state.active).toBe('src/other.py')
    expect(revealSpy).toHaveBeenCalledTimes(1)
    expect(revealSpy).toHaveBeenCalledWith({ line: 7, column: 3 })
    wrapper.unmount()
  })

  it('reveals directly when the target is in the same file', async () => {
    const fetchMock = stubRoutes()
    const wrapper = await mountPane([fileRecord('src/app.py', 'x = 1\n')], 'src/app.py')
    const stub = wrapper.findComponent({ name: 'MonacoEditorStub' })
    const fileReads = () =>
      fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/fs/file?')).length
    const before = fileReads()

    stub.vm.$emit('definition', { path: 'src/app.py', line: 4, column: 2 })
    await flushPromises()

    expect(fileReads()).toBe(before)
    expect(revealSpy).toHaveBeenCalledWith({ line: 4, column: 2 })
    wrapper.unmount()
  })

  // A refused open (binary, over the cap, gone since) is the pane's own existing
  // answer — a message — and nothing is revealed into a buffer that is not there.
  it('reveals nothing when the open is refused', async () => {
    stubRoutes({
      fileAnswer: (path) => jsonResponse({ detail: `${path} is binary` }, false, 422),
    })
    const wrapper = await mountPane([fileRecord('src/app.py', 'x = 1\n')], 'src/app.py')
    const stub = wrapper.findComponent({ name: 'MonacoEditorStub' })

    stub.vm.$emit('definition', { path: 'assets/logo.png', line: 1, column: 1 })
    await flushPromises()

    expect(revealSpy).not.toHaveBeenCalled()
    expect(files.state.message?.path).toBe('assets/logo.png')
    wrapper.unmount()
  })
})
