import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import WorkspaceNavigator from '../src/components/WorkspaceNavigator.vue'
import { useAppShell } from '../src/composables/useAppShell'
import { useGitStatus } from '../src/composables/useGitStatus'
import { useWorkspaceTree } from '../src/composables/useWorkspaceTree'

// ---------------------------------------------------------------------------
// Entering the Editor tab re-lists the tree.
//
// The use case: the WorkBench agent writes a file while the user is on the
// WorkBench tab; clicking Editor must show it. The view is `v-show` (App.vue),
// so the navigator is mounted once and its `onMounted` listing is never re-run
// — the tab switch is the only entry signal there is, and it now performs the
// refresh button's whole promise (every open folder + the git marks).
//
// The second case is the one that could silently destroy work: the inline name
// input. Re-listing the folder a half-typed name sits in would rebuild the rows
// around the caret, so the tree is left alone while `state.editing` is open —
// and the marks, which change no row, still re-read.
// ---------------------------------------------------------------------------

const tree = useWorkspaceTree()
const git = useGitStatus()
const appShell = useAppShell()

// The disk, mutable: `agent.py` appears between the two listings, which is the
// whole story the first test tells.
function stubDisk() {
  const disk = { extra: false }
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const key = String(url)
    if (key.startsWith('/api/fs/status')) {
      return jsonResponse({ repo: true, entries: [] })
    }
    const path = decodeURIComponent(key.slice('/api/fs/tree?path='.length))
    const entries =
      path === ''
        ? [
            { name: 'src', path: 'src', dir: true, children: true },
            { name: 'notes.md', path: 'notes.md', dir: false, size: 4, mtime: 1000 },
          ]
        : path === 'src'
          ? [{ name: 'a.py', path: 'src/a.py', dir: false, size: 4, mtime: 1000 }]
          : []
    if (disk.extra && path === '') {
      entries.push({ name: 'agent.py', path: 'agent.py', dir: false, size: 4, mtime: 2000 })
    }
    return jsonResponse({ path, workspace: '/work/demo', entries, truncated: false })
  })
  return disk
}

function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

function fetchCalls(prefix) {
  return [...globalThis.fetch.mock.calls].filter(([url]) =>
    String(url).startsWith(prefix),
  ).length
}

async function mountedNavigator() {
  const wrapper = mount(WorkspaceNavigator, { attachTo: document.body })
  await flushPromises()
  tree.expand('src')
  await flushPromises()
  return wrapper
}

// jsdom has no layout, and no `showModal`/`close` on `<dialog>` (the navigator
// mounts `<SearchDialog />`); the same patches workspaceTreeMenu.test.js makes.
Element.prototype.scrollIntoView = () => {}
Element.prototype.showModal = function showModal() {
  this.open = true
}
Element.prototype.close = function close() {
  this.open = false
}

beforeEach(() => {
  tree.state.nodes = {}
  tree.state.expanded = { '': true }
  tree.state.focused = ''
  tree.state.selected = null
  tree.state.editing = null
  tree.state.workspace = ''
  tree.state.marked = []
  tree.state.markAnchor = null
  tree.state.error = null
  git.state.entries = []
  git.state.loadedAt = 0
  // The tab the user is *on* when the navigator mounts: the watch must answer
  // the switch back to the Editor, not the state it started in.
  appShell.state.activeTab = 'editor'
  vi.restoreAllMocks()
  document.body.querySelectorAll('.tree-context-menu, dialog').forEach((el) => el.remove())
})

describe('entering the Editor tab', () => {
  it('re-lists every open folder, so a file the agent wrote is on screen', async () => {
    const disk = stubDisk()
    const wrapper = await mountedNavigator()
    expect(wrapper.find('.tree-row[data-path="agent.py"]').exists()).toBe(false)

    // The user leaves for the WorkBench — flushed, because a watcher that
    // never saw the away edge has nothing to answer on the way back — and the
    // agent writes a file there.
    appShell.state.activeTab = 'chat'
    await flushPromises()
    disk.extra = true

    // …and comes back. No click on the refresh button anywhere in this test.
    appShell.state.activeTab = 'editor'
    await flushPromises()

    expect(wrapper.find('.tree-row[data-path="agent.py"]').exists()).toBe(true)
    // Every folder whose listing is on screen, not just the root: a file the
    // agent wrote inside an opened branch is the same complaint.
    expect(fetchCalls('/api/fs/tree?path=src')).toBe(2)
    // …and the git marks, which are the other half of what a refresh promises.
    expect(fetchCalls('/api/fs/status')).toBe(2)
    wrapper.unmount()
  })

  it('keeps the opened branches open across that re-list', async () => {
    stubDisk()
    const wrapper = await mountedNavigator()
    appShell.state.activeTab = 'chat'
    await flushPromises()
    appShell.state.activeTab = 'editor'
    await flushPromises()

    // A refresh is not a collapse: the rows the user had opened are still open.
    expect(tree.state.expanded.src).toBe(true)
    expect(wrapper.find('.tree-row[data-path="src/a.py"]').exists()).toBe(true)
    wrapper.unmount()
  })

  // The one thing the re-list must never do: rebuild the listing a half-typed
  // name is sitting in.
  it('leaves the tree alone while a name is being typed, and still re-reads the marks', async () => {
    stubDisk()
    const wrapper = await mountedNavigator()
    tree.startCreate('src', false)
    tree.updateCreateValue('half-typ')
    await flushPromises()

    const before = fetchCalls('/api/fs/tree')
    appShell.state.activeTab = 'chat'
    await flushPromises()
    appShell.state.activeTab = 'editor'
    await flushPromises()

    expect(fetchCalls('/api/fs/tree')).toBe(before)
    expect(tree.state.editing).toMatchObject({ mode: 'create', parent: 'src', value: 'half-typ' })
    expect(wrapper.find('.tree-name-input').exists()).toBe(true)
    expect(fetchCalls('/api/fs/status')).toBe(2)
    wrapper.unmount()
  })

  it('does nothing while the user is leaving the tab', async () => {
    stubDisk()
    const wrapper = await mountedNavigator()
    const before = globalThis.fetch.mock.calls.length

    appShell.state.activeTab = 'chat'
    await flushPromises()

    expect(globalThis.fetch.mock.calls.length).toBe(before)
    wrapper.unmount()
  })
})
