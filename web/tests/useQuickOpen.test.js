import { beforeEach, describe, expect, it, vi } from 'vitest'

import { registerPaneFocus, useQuickOpen } from '../src/composables/useQuickOpen'
import { useWorkspaceTree } from '../src/composables/useWorkspaceTree'

// ---------------------------------------------------------------------------
// The quick-open composable's state, driven through its own functions.
//
// The two rules this suite exists for are the spec's §2.3 and §2.7: the list is
// refetched **on every open** (the opposite retention of the content search —
// the list must stay honest after renames and deletes), and a working-location
// switch empties query and list, because paths relative to a root that no
// longer exists are a lie.
//
// The server's own rules (the caps, the policy pruning) belong to
// tests/test_editorfs_quickopen.py; here the transport is a stubbed `fetch`
// and the payload is the Contract read verbatim.
//
// `useWorkspaceTree` is imported for the re-root registry and the selection
// `pick` publishes into; the tree's own behaviour is asserted in its own suite.
// ---------------------------------------------------------------------------

const tree = useWorkspaceTree()
const quick = useQuickOpen()

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

function payload(paths) {
  return { files: paths, fileCount: paths.length, truncated: false }
}

function resetQuick() {
  quick.state.open = false
  quick.state.query = ''
  quick.state.list = []
  quick.state.status = 'idle'
  quick.state.selected = 0
  quick.state.error = null
}

function resetTree() {
  tree.state.nodes = {}
  tree.state.expanded = { '': true }
  tree.state.focused = ''
  tree.state.selected = null
  tree.state.editing = null
  tree.state.error = null
  tree.state.workspace = '/w/demo'
}

// The routes a working-location switch touches: the tree's listing of the new
// root and the git marks the buffer holder re-reads.
function stubWorkspaceRoutes() {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const key = String(url)
    if (key.startsWith('/api/fs/tree')) {
      const path = decodeURIComponent(key.slice('/api/fs/tree?path='.length))
      return jsonResponse({
        path,
        workspace: '/w/other',
        entries: [{ name: 'src', path: 'src', dir: true, children: true }],
        truncated: false,
      })
    }
    if (key.startsWith('/api/fs/status')) {
      return jsonResponse({ repo: false, entries: [] })
    }
    return jsonResponse({})
  })
}

describe('openDialog: the list is refetched on every open', () => {
  beforeEach(() => {
    resetQuick()
    resetTree()
    vi.restoreAllMocks()
  })

  it('one fetch per open, and the payload is the Contract verbatim', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(payload(['src/a.py', 'README.md'])))

    await quick.openDialog()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/fs/files')
    expect(quick.state.open).toBe(true)
    expect(quick.state.list).toEqual(['src/a.py', 'README.md'])
    expect(quick.state.status).toBe('ready')
    expect(quick.state.error).toBeNull()
  })

  it('a close and a re-open cost a second fetch — the list stays honest', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(payload(['src/a.py'])))

    await quick.openDialog()
    quick.closeDialog()
    await quick.openDialog()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(quick.state.open).toBe(true)
    expect(quick.state.list).toEqual(['src/a.py'])
  })

  it('the query is kept across closes — re-opening shows the previous filter', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => jsonResponse(payload([])))
    quick.state.query = 'redact'
    await quick.openDialog()
    quick.closeDialog()
    await quick.openDialog()

    expect(quick.state.query).toBe('redact')
  })

  it('a failed fetch is an error, not a silent empty list', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => jsonResponse({ detail: 'no' }, false, 500))
    await quick.openDialog()

    expect(quick.state.status).toBe('error')
    expect(quick.state.error.status).toBe(500)
    expect(quick.state.open).toBe(true)
  })

  it('an unreachable API is named as never having arrived', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('down')))
    await quick.openDialog()

    expect(quick.state.status).toBe('error')
    expect(quick.state.error.status).toBe(0)
  })

  it('an answer that lands after a newer open is dropped', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    // The first open's answer is slow; the second open's is instant. When the
    // slow one finally lands it belongs to an older generation and must be
    // dropped, not painted over the newer open's list.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      fetchMock.mock.calls.length === 1 ? gate : jsonResponse(payload(['fresh.py'])),
    )
    const fetchMock = globalThis.fetch

    const first = quick.openDialog()
    const second = quick.openDialog()
    await second
    expect(quick.state.list).toEqual(['fresh.py'])

    release(jsonResponse(payload(['stale.py'])))
    await first

    expect(quick.state.list).toEqual(['fresh.py'])
    expect(quick.state.status).toBe('ready')
  })
})

describe('pick: the selection, the close and the focus, in that order', () => {
  beforeEach(() => {
    resetQuick()
    resetTree()
    vi.restoreAllMocks()
  })

  it('publishes the path as the tree\'s selection and closes the dialog', () => {
    const focus = vi.fn()
    registerPaneFocus(focus)
    quick.state.open = true

    quick.pick('src/core/redact.py')

    expect(tree.state.selected?.path).toBe('src/core/redact.py')
    expect(tree.state.selected?.dir).toBe(false)
    expect(quick.state.open).toBe(false)
    expect(focus).toHaveBeenCalledTimes(1)
  })

  it('a path the lazy tree has no listing of is still selected', () => {
    registerPaneFocus(vi.fn())
    quick.pick('docs/old/notes.md')

    expect(tree.state.selected?.path).toBe('docs/old/notes.md')
    expect(tree.state.selected?.name).toBe('notes.md')
  })

  it('an empty path is a no-op, never a selection', () => {
    const focus = vi.fn()
    registerPaneFocus(focus)
    quick.pick('')
    quick.pick(null)

    expect(tree.state.selected).toBeNull()
    expect(focus).not.toHaveBeenCalled()
  })
})

describe('a working-location switch empties the quick open', () => {
  beforeEach(() => {
    resetQuick()
    resetTree()
    vi.restoreAllMocks()
  })

  it('forgets query, list, status, error and the open dialog', async () => {
    stubWorkspaceRoutes()
    quick.state.open = true
    quick.state.query = 'redact'
    quick.state.list = ['src/core/redact.py']
    quick.state.status = 'ready'
    quick.state.error = { status: 500, detail: 'no' }

    await tree.reRoot('/w/other')

    expect(quick.state.query).toBe('')
    expect(quick.state.list).toEqual([])
    expect(quick.state.status).toBe('idle')
    expect(quick.state.error).toBeNull()
    expect(quick.state.open).toBe(false)
    expect(quick.state.selected).toBe(0)

    // A switch re-roots and re-reads; it never asks for a new list.
    const asked = globalThis.fetch.mock.calls.some(([url]) => String(url).startsWith('/api/fs/files'))
    expect(asked).toBe(false)
  })

  it('an answer that lands after the switch is dropped', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const key = String(url)
      if (key.startsWith('/api/fs/files')) return gate
      if (key.startsWith('/api/fs/tree')) {
        return jsonResponse({
          path: '',
          workspace: '/w/other',
          entries: [{ name: 'src', path: 'src', dir: true, children: true }],
          truncated: false,
        })
      }
      if (key.startsWith('/api/fs/status')) {
        return jsonResponse({ repo: false, entries: [] })
      }
      return jsonResponse({})
    })

    const inFlight = quick.openDialog()
    await tree.reRoot('/w/other')
    release(jsonResponse(payload(['stale.py'])))
    await inFlight

    expect(quick.state.list).toEqual([])
    expect(quick.state.status).toBe('idle')
  })
})
