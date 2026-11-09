import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import QuickOpenDialog from '../src/components/QuickOpenDialog.vue'
import { registerPaneFocus, useQuickOpen } from '../src/composables/useQuickOpen'
import { useWorkspaceTree } from '../src/composables/useWorkspaceTree'

// ---------------------------------------------------------------------------
// The quick-open popup, mounted for real.
//
// Everything it shows is `useQuickOpen` state, so this suite never stubs the
// composable: it *drives* it (openDialog / a payload placed on `list`) and
// reads the DOM back. That is what makes these the tests for the rendering
// rules rather than for the state machine — the state machine has its own file
// (useQuickOpen.test.js).
//
// The three rules worth jsdom are §2.8 (an empty query shows the top-level
// entries — which is the fetched list itself, in the server's order), §2.3
// (typing filters without a second fetch) and §2.4 (a path is never markup —
// the highlight is span slices, and a path that looks like a tag stays text).
// The rest is the copy the user reads: the placeholder, the footer sentence.
//
// jsdom has no `showModal`/`close` on `<dialog>`, so both are patched on
// `Element.prototype` the way searchDialog.test.js does — they only have to
// keep `el.open` truthful, which is all the component's watch reads.
// ---------------------------------------------------------------------------

const quick = useQuickOpen()
const tree = useWorkspaceTree()

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

function payload(paths, overrides = {}) {
  return { files: paths, fileCount: paths.length, truncated: false, ...overrides }
}

// The fetch stub answers the quick-open listing by URL and anything else (the
// tree's lazy listing, which `pick`'s selection may ask for) with an empty
// directory — the tree's own behaviour is asserted in its own suite.
function stubFetch(body) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    if (String(url).startsWith('/api/fs/files')) return jsonResponse(body)
    return jsonResponse({ path: '', workspace: '/w/demo', entries: [], truncated: false })
  })
}

let host = null

function mountDialog() {
  host = document.createElement('div')
  document.body.appendChild(host)
  return mount(QuickOpenDialog, { attachTo: host })
}

// Raise the popup through the composable, as the chord (qop-07) will.
async function openOn(paths, overrides = {}) {
  stubFetch(payload(paths, overrides))
  await quick.openDialog()
  await flushPromises()
}

beforeEach(() => {
  Element.prototype.showModal = function showModal() {
    this.open = true
  }
  Element.prototype.close = function close() {
    this.open = false
  }
  // jsdom has no layout, so `scrollIntoView` does not exist on an element; the
  // component calls it on every selection move, and the call must be a no-op
  // here rather than an unhandled rejection.
  Element.prototype.scrollIntoView = function scrollIntoView() {}
  // A fresh dialog per test, and the singleton state to match — the composable
  // deliberately keeps its query across closes, so a test that did not reset
  // would read the previous test's filter.
  quick.state.open = false
  quick.state.query = ''
  quick.state.list = []
  quick.state.status = 'idle'
  quick.state.selected = 0
  quick.state.truncated = false
  quick.state.error = null
  tree.state.nodes = {}
  tree.state.expanded = { '': true }
  tree.state.focused = ''
  tree.state.selected = null
  tree.state.editing = null
  tree.state.error = null
  tree.state.workspace = '/w/demo'
  vi.restoreAllMocks()
})

afterEach(() => {
  host?.remove()
  host = null
  document.body.querySelectorAll('dialog').forEach((el) => el.remove())
})

describe('the dialog follows state.open', () => {
  it('is in the DOM before anything raises it, and closed', () => {
    const w = mountDialog()

    expect(quick.state.open).toBe(false)
    expect(w.find('dialog').exists()).toBe(true)
    expect(w.find('dialog').element.open).toBe(false)
    w.unmount()
  })

  it('openDialog shows it with showModal, closeDialog hides it', async () => {
    const w = mountDialog()
    await openOn(['src/a.py'])

    expect(w.find('dialog').element.open).toBe(true)

    quick.closeDialog()
    await flushPromises()
    expect(w.find('dialog').element.open).toBe(false)
    w.unmount()
  })
})

describe('§2.8: an empty query shows the top-level entries', () => {
  it('the fetched list, in the server\'s order, with no second fetch', async () => {
    const w = mountDialog()
    await openOn(['docs', 'README.md', 'src', 'web'])

    const rows = w.findAll('.quickopen-row')
    expect(rows.map((row) => row.text())).toEqual(['docs', 'README.md', 'src', 'web'])
    // The empty query is score 0 for everything, so nothing is highlighted yet
    // except the first row — the selection has somewhere to be.
    expect(rows[0].classes()).toContain('is-selected')
    w.unmount()
  })
})

describe('§2.3: typing filters without a second fetch', () => {
  it('the list is re-filtered client-side, and fetch is called once', async () => {
    const w = mountDialog()
    const fetchMock = stubFetch(payload(['src/core/redact.py', 'README.md']))
    await quick.openDialog()
    await flushPromises()

    quick.state.query = 'redact'
    await flushPromises()

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const rows = w.findAll('.quickopen-row')
    expect(rows.map((row) => row.text())).toEqual(['src/core/redact.py'])
    w.unmount()
  })

  it('a query nothing matches says so', async () => {
    const w = mountDialog()
    await openOn(['src/a.py'])

    quick.state.query = 'zzz'
    await flushPromises()

    expect(w.findAll('.quickopen-row')).toHaveLength(0)
    expect(w.find('.quickopen-empty').text()).toBe('no matching files')
    w.unmount()
  })
})

describe('the keyboard', () => {
  it('Enter picks the highlighted row: selection, close, focus', async () => {
    const focus = vi.fn()
    registerPaneFocus(focus)
    const w = mountDialog()
    await openOn(['src/a.py', 'README.md'])

    // ↓ once, then Enter: the second row is the one that opens. The tree's own
    // ordering puts `README.md` first (`r` < `s`), so the second row is the
    // nested one.
    await w.find('dialog').trigger('keydown', { key: 'ArrowDown' })
    expect(w.findAll('.quickopen-row')[1].classes()).toContain('is-selected')

    await w.find('dialog').trigger('keydown', { key: 'Enter' })
    await flushPromises()

    expect(tree.state.selected?.path).toBe('src/a.py')
    expect(quick.state.open).toBe(false)
    expect(w.find('dialog').element.open).toBe(false)
    expect(focus).toHaveBeenCalledTimes(1)
    w.unmount()
  })

  it('↑ stops at the top and ↓ stops at the bottom', async () => {
    const w = mountDialog()
    await openOn(['a.py', 'b.py'])

    await w.find('dialog').trigger('keydown', { key: 'ArrowUp' })
    expect(w.findAll('.quickopen-row')[0].classes()).toContain('is-selected')

    await w.find('dialog').trigger('keydown', { key: 'ArrowDown' })
    await w.find('dialog').trigger('keydown', { key: 'ArrowDown' })
    expect(w.findAll('.quickopen-row')[1].classes()).toContain('is-selected')
    w.unmount()
  })

  it('Escape closes the dialog and keeps the query', async () => {
    const w = mountDialog()
    await openOn(['src/a.py'])
    quick.state.query = 'redact'

    await w.find('dialog').trigger('close')
    await flushPromises()

    expect(quick.state.open).toBe(false)
    expect(quick.state.query).toBe('redact')
    w.unmount()
  })
})

describe('a row click does the same as Enter', () => {
  it('picks the clicked path and closes', async () => {
    const focus = vi.fn()
    registerPaneFocus(focus)
    const w = mountDialog()
    await openOn(['src/a.py', 'README.md'])

    await w.findAll('.quickopen-row')[1].trigger('click')
    await flushPromises()

    expect(tree.state.selected?.path).toBe('src/a.py')
    expect(quick.state.open).toBe(false)
    expect(focus).toHaveBeenCalledTimes(1)
    w.unmount()
  })
})

// The component's own source, for the rules that are about *who renders what*
// and cannot be seen on a DOM node (same approach as searchDialog.test.js's
// template scan). `resolve()` is the `web/` root under Vitest.
const componentSource = readFileSync(
  join(resolve(), 'src', 'components', 'QuickOpenDialog.vue'),
  'utf8',
)

describe('a path is never injected as HTML', () => {
  it('renders a tag-looking path as text, with no element of its own', async () => {
    const w = mountDialog()
    await openOn(['src/a <img src=x onerror=alert(1)>.py'])

    const row = w.find('.quickopen-row')
    expect(row.text()).toBe('src/a <img src=x onerror=alert(1)>.py')
    expect(row.element.innerHTML).not.toContain('<img')
    w.unmount()
  })

  it('the highlight is span slices, and the source has no v-html', async () => {
    const w = mountDialog()
    await openOn(['src/core/redact.py'])
    quick.state.query = 'redact'
    await flushPromises()

    const code = w.find('.quickopen-row code')
    const nodes = Array.from(code.element.childNodes).map((node) =>
      node.nodeType === 3
        ? { text: node.textContent }
        : { tag: node.tagName.toLowerCase(), text: node.textContent },
    )
    // The matched characters, and only they, are inside spans.
    expect(nodes.some((n) => n.tag === 'span' && n.text.toLowerCase() === 'redact')).toBe(true)
    expect(code.text()).toBe('src/core/redact.py')

    expect(componentSource).not.toMatch(/v-html/)
    expect(componentSource).not.toMatch(/markdown/)
    w.unmount()
  })
})

describe('§2.5: the truncation footer', () => {
  it('renders the one sentence only when the payload said truncated', async () => {
    const w = mountDialog()
    await openOn(['a.py'], { truncated: true, fileCount: 9000 })

    expect(w.find('.quickopen-footer').text()).toBe(
      'showing the first 5000 files — narrow with the policy or type to filter',
    )
    w.unmount()
  })

  it('is absent when the payload was complete', async () => {
    const w = mountDialog()
    await openOn(['a.py'])

    expect(w.find('.quickopen-footer').exists()).toBe(false)
    w.unmount()
  })
})
