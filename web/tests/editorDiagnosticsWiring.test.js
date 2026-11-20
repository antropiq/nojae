import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { h } from 'vue'

// ---------------------------------------------------------------------------
// ediag-07: the pane's half of the wiring.
//
// Two things belong to EditorArea and nowhere else, and both are asserted here:
//
//   * an answered analysis reaches the pane's **one** marker surface — the code
//     pane's exposed `setMarkers` — and no second place calls it;
//   * the four triggers are armed while the pane is on screen and disarmed with
//     it, so the composable owns the timer and the request while the component
//     only says when they are wanted (AGENTS.md's composable rule).
//
// The real Monaco cannot mount in jsdom (see probe-monaco.test.js), so the
// surface is stubbed with the same imperative shape the real one exposes.
// ---------------------------------------------------------------------------

const markerSpy = vi.hoisted(() => vi.fn())

vi.mock('../src/components/MonacoEditor.vue', () => ({
  default: {
    name: 'MonacoEditorStub',
    props: ['content', 'language', 'path', 'readonly', 'ariaLabel'],
    emits: ['content-change', 'quick-open', 'definition'],
    methods: { setMarkers: markerSpy, revealPosition() {}, focus() {} },
    render() {
      return h('div', { class: 'stub-monaco' })
    },
  },
}))
vi.mock('../src/components/MonacoDiffViewer.vue', () => ({
  default: { name: 'MonacoDiffViewerStub', render: () => h('div', { class: 'stub-diff' }) },
}))

import EditorArea from '../src/components/EditorArea.vue'
import { useAppShell } from '../src/composables/useAppShell'
import { useEditorDiagnostics } from '../src/composables/useEditorDiagnostics'
import { useEditorFiles } from '../src/composables/useEditorFiles'
import { useEditorLsp } from '../src/composables/useEditorLsp'
import { useWorkspaceTree } from '../src/composables/useWorkspaceTree'
import { markersForDiagnostics } from '../src/lib/monaco-lsp'
import { pointTabAt, withoutWorkspace } from './helpers/workspace-url'

const files = useEditorFiles()
const diagnostics = useEditorDiagnostics()
const lsp = useEditorLsp()
const tree = useWorkspaceTree()
const appShell = useAppShell()

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

function wireItem(line, message) {
  return {
    range: { start: { line, character: 0 }, end: { line, character: 4 } },
    severity: 'error',
    message,
  }
}

function fileRecord(path, text = 'x = 1\n') {
  return {
    kind: 'file',
    key: path,
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    text,
    baseline: text,
    dirty: false,
    mtime: 1000,
    language: 'python',
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
    savedAt: 0,
    editedAt: 0,
  }
}

function stubRoutes(answer) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    if (withoutWorkspace(url) === '/api/lsp/query') return jsonResponse(answer)
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
  markerSpy.mockClear()
  diagnostics.stopRefresh()
  diagnostics.clear()
  pointTabAt('/w')
  files.state.open.splice(0, files.state.open.length)
  files.state.active = null
  files.state.message = null
  tree.state.nodes = {}
  tree.state.expanded = { '': true }
  tree.state.focused = ''
  tree.state.selected = null
  tree.state.error = null
  tree.state.workspace = '/w/demo'
  lsp.clear()
  // The freshness tick is off for these tests (it would poll), and it only
  // starts on the Editor tab.
  appShell.state.activeTab = 'chat'
  vi.restoreAllMocks()
})

describe('the answer reaches the pane\'s one marker surface', () => {
  it('hands an accepted answer\'s markers over, built by the mapping module', async () => {
    const items = [wireItem(2, 'boom')]
    stubRoutes({
      status: 'ok',
      server: 'pyright',
      reason: null,
      action: 'diagnostics',
      result: { analysed: true, version: 1, items, suppressed: 0 },
    })

    await mountPane([fileRecord('src/app.py')], 'src/app.py')
    await flushPromises()

    expect(markerSpy).toHaveBeenCalled()
    expect(markerSpy).toHaveBeenLastCalledWith(markersForDiagnostics(items))
  })

  it('hands over an empty set when the buffer turned out clean', async () => {
    stubRoutes({
      status: 'ok',
      server: 'pyright',
      reason: null,
      action: 'diagnostics',
      result: { analysed: true, version: 1, items: [], suppressed: 0 },
    })

    await mountPane([fileRecord('src/app.py')], 'src/app.py')
    await flushPromises()

    expect(markerSpy).toHaveBeenLastCalledWith([])
  })

  // A diff tab and a preview tab have no live buffer to mark, and a view's
  // records must not be handed to the surface as if they were one.
  it('marks nothing for a diff tab', async () => {
    stubRoutes({
      status: 'ok',
      server: 'pyright',
      reason: null,
      action: 'diagnostics',
      result: { analysed: true, version: 1, items: [wireItem(0, 'x')], suppressed: 0 },
    })

    await mountPane(
      [
        {
          kind: 'diff',
          key: 'diff:src/app.py',
          path: 'src/app.py',
          name: 'app.py (diff)',
          original: 'a\n',
          modified: 'b\n',
          language: 'plaintext',
          status: 'modified',
          baseline: 'head',
          renamedFrom: null,
          truncated: false,
          truncatedAt: null,
        },
      ],
      'diff:src/app.py',
    )
    await flushPromises()

    expect(markerSpy).not.toHaveBeenCalled()
  })
})

describe('the pane arms the triggers and disarms them', () => {
  it('asks for the buffer already on screen once the pane mounts', async () => {
    const fetchMock = stubRoutes({
      status: 'ok',
      server: 'pyright',
      reason: null,
      action: 'diagnostics',
      result: { analysed: true, version: 1, items: [], suppressed: 0 },
    })

    const wrapper = await mountPane([fileRecord('src/app.py')], 'src/app.py')
    await flushPromises()

    const asks = fetchMock.mock.calls.filter(([url, init]) => {
      if (withoutWorkspace(url) !== '/api/lsp/query') return false
      return JSON.parse(init.body).action === 'diagnostics'
    })
    expect(asks).toHaveLength(1)
    wrapper.unmount()
  })

  it('stops asking once the pane is gone', async () => {
    const fetchMock = stubRoutes({
      status: 'ok',
      server: 'pyright',
      reason: null,
      action: 'diagnostics',
      result: { analysed: true, version: 1, items: [], suppressed: 0 },
    })

    const wrapper = await mountPane([fileRecord('src/app.py')], 'src/app.py')
    await flushPromises()
    wrapper.unmount()
    const before = fetchMock.mock.calls.length

    // Nothing is armed any more: a buffer switch reaches no ask.
    files.state.open.push(fileRecord('src/other.py'))
    files.state.active = 'src/other.py'
    await flushPromises()

    const asks = fetchMock.mock.calls
      .slice(before)
      .filter(([url, init]) => {
        if (withoutWorkspace(url) !== '/api/lsp/query') return false
        return JSON.parse(init.body).action === 'diagnostics'
      })
    expect(asks).toHaveLength(0)
  })
})
