import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { h } from 'vue'

// ediag-01: the status bar's *box*, and nothing inside it.
//
// jsdom lays nothing out and loads no stylesheet, so the geometry this task
// ships is asserted on the shipped CSS itself — the same way
// workbenchToolsColumnWidth.test.js pins a width. What is being protected:
//
//   * the shell gains a fourth, `auto`-sized row at the bottom;
//   * the two full-height spans stop above that row instead of reaching
//     through it (they are placed `1 / -1`, which resolves against the
//     *explicit* grid and so would silently grow by one row);
//   * the narrow-screen block re-places every row by line, so a row list left
//     at four entries would drop the bar entirely below 1024 px;
//   * the strip is mounted by EditorView as the last child of the shell.
//
// The strip itself must make no claim about a file at this point: the fields
// arrive in later tasks, and a placeholder naming a server or calling a buffer
// clean would be a lie the app cannot yet back.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock('../src/components/WorkspaceNavigator.vue', () => ({
  default: { name: 'NavigatorStub', render: () => h('div', { class: 'stub-nav' }) },
}))
vi.mock('../src/components/EditorArea.vue', () => ({
  default: { name: 'EditorAreaStub', render: () => h('div', { class: 'stub-area' }) },
}))
vi.mock('../src/components/EditorTerminal.vue', () => ({
  default: { name: 'EditorTerminalStub', render: () => h('div', { class: 'stub-term' }) },
}))
// The notice stack teleports to `<body>`, so it contributes no element to the
// shell — a stub that rendered one would make the bar look like it is not last.
vi.mock('../src/components/EditorNoticeStack.vue', () => ({
  default: { name: 'NoticeStackStub', render: () => null },
}))

import EditorView from '../src/components/EditorView.vue'
import EditorStatusBar from '../src/components/EditorStatusBar.vue'
import { NO_BUFFER_TEXT } from '../src/composables/useEditorStatus'
import {
  clearEditorFacts,
  reportFile,
  useEditorFacts,
} from '../src/composables/useEditorFacts'
import { useEditorDiagnostics } from '../src/composables/useEditorDiagnostics'
import { useEditorFiles } from '../src/composables/useEditorFiles'
import { nextTick } from 'vue'

const files = useEditorFiles()
const diagnostics = useEditorDiagnostics()

const CSS = readFileSync(join(resolve(), 'src', 'styles', 'theme.css'), 'utf8')

// The stylesheet documents these classes in prose, so comments go first: a scan
// that read a comment as a selector would be asserting on documentation.
function strippedCss() {
  return CSS.replace(/\/\*[\s\S]*?\*\//g, '')
}

// The declaration body of the first rule whose selector list contains exactly
// `selector` — an exact match, so `.editor-status-bar` cannot answer with the
// body of `.editor-status-bar-field` and vice versa.
function ruleBody(css, selector) {
  const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((match) =>
    match[1]
      .split(',')
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .includes(selector),
  )
  return found ? found[2].replace(/\s+/g, ' ').trim() : null
}

// The brace-balanced body of a top-level `@media` block (one level of nesting,
// which is all this stylesheet uses for it).
function mediaBody(css, query) {
  const start = css.indexOf(`${query} {`)
  if (start < 0) return null
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return null
}

// The track list, split on top-level whitespace only: a `minmax(0, 1fr)` track
// contains a space of its own and is one entry, not two.
function rowsOf(body) {
  const value = body.match(/grid-template-rows:([^;]*);/)
  if (!value) return []
  const tracks = []
  let current = ''
  let depth = 0
  for (const char of value[1].trim()) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (/\s/.test(char) && depth === 0) {
      if (current) tracks.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current) tracks.push(current)
  return tracks
}

beforeEach(() => {
  window.localStorage.clear()
})

describe('the fourth row in the shell', () => {
  it('sizes the bar `auto`, at the bottom, so the panes absorb its height', () => {
    const rows = rowsOf(ruleBody(strippedCss(), '.editor-shell'))
    // Three tracks before it: the code pane, the horizontal resizer, the
    // terminal. The panes' `1fr` row is what absorbs the bar, which is why a
    // fixed height would be wrong.
    expect(rows).toHaveLength(4)
    expect(rows[0]).toContain('1fr')
    expect(rows[3]).toBe('auto')
  })

  it('gives the bar the whole width of the last row', () => {
    const body = ruleBody(strippedCss(), '.editor-status-bar')
    expect(body, '.editor-status-bar has a rule of its own').not.toBeNull()
    expect(body).toContain('grid-column: 1 / -1')
    expect(body).toContain('grid-row: 4')
    // One row of text, never wrapping, and the terminal's full-bleed finish:
    // no side margin, no rounded corner, a single hairline on top.
    expect(body).toContain('white-space: nowrap')
    expect(body).toContain('border-radius: 0')
    expect(body).toContain('border-top: 1px solid var(--bi-border)')
    // No side margin: the strip is flush with the screen's edges.
    expect(body).toContain('margin: 0')
    expect(body).not.toMatch(/margin-(left|right|inline)/)
  })
})

describe('the two full-height spans stop above the bar', () => {
  for (const selector of ['.editor-nav-col', '.editor-resizer-v']) {
    it(`${selector} ends at the row above the bar, not at -1`, () => {
      const body = ruleBody(strippedCss(), selector)
      expect(body, `${selector} has a rule`).not.toBeNull()
      // `1 / -1` is the trap: it resolves against the explicit grid, so it
      // reached one row too far the moment the bar's row was added.
      expect(body).not.toContain('grid-row: 1 / -1')
      expect(body).toContain('grid-row: 1 / 4')
    })
  }
})

describe('the narrow-screen block', () => {
  it('gains the bar’s row and places the bar there', () => {
    const media = mediaBody(strippedCss(), '@media (max-width: 1024px)')
    expect(media, 'the 1024 px block is still there').not.toBeNull()

    const shell = ruleBody(media, '.editor-shell')
    expect(rowsOf(shell)).toHaveLength(5)

    const bar = ruleBody(media, '.editor-status-bar')
    expect(bar, 'the bar is re-placed instead of vanishing below 1024 px').not.toBeNull()
    expect(bar).toContain('grid-row: 5')
    expect(bar).toContain('grid-column: 1')
  })
})

describe('the strip’s own row', () => {
  it('is one non-wrapping flex row with fields separated by space', () => {
    const body = ruleBody(strippedCss(), '.editor-status-bar')
    expect(body).toContain('display: flex')
    expect(body).toContain('white-space: nowrap')
    // Space, not boxes: the fields are the row's gap, not their own borders.
    expect(body).toContain('gap: var(--bi-space-2)')
    expect(body).toContain('overflow: hidden')
  })

  // ediag-08: all four fields on screen together for the first time (server,
  // problems, state, re-check). The two short ones must not be the ones that
  // give way at a narrow window, or the re-check would be pushed off the strip
  // and a count would vanish instead of a long server sentence being ellipsised.
  it('keeps the short fields’ width and lets the server field give way', () => {
    const css = strippedCss()
    // The strip itself never wraps, at either breakpoint: a second line would
    // grow the bar, which is the one thing its `auto` track must not do.
    expect(ruleBody(css, '.editor-status-bar')).toContain('white-space: nowrap')
    expect(ruleBody(mediaBody(css, '@media (max-width: 1024px)'), '.editor-status-bar'))
      .not.toMatch(/white-space: normal|flex-wrap: wrap/)

    // The counts and `analysing…` are short by construction, so they keep their
    // width; the server field's long refusal sentence is what ellipsises.
    expect(ruleBody(css, '.editor-status-bar-field--fixed')).toContain('flex: 0 0 auto')
    expect(ruleBody(css, '.editor-status-bar-field')).toContain('text-overflow: ellipsis')
    expect(ruleBody(css, '.editor-status-bar-recheck')).toContain('flex: 0 0 auto')
  })

  // Severity colours are the app's tokens, never a hexadecimal written into the
  // component (task 08's own rule, and the palette's).
  it('colours the counts from the theme’s tokens, not from raw hexadecimals', () => {
    const css = strippedCss()
    expect(ruleBody(css, '.editor-status-bar-count--errors')).toContain('color: var(--bi-danger)')
    expect(ruleBody(css, '.editor-status-bar-count--warnings')).toContain(
      'color: var(--bi-warning)',
    )
    expect(ruleBody(css, '.editor-status-bar-state')).toContain('color: var(--pico-muted-color)')
    for (const selector of [
      '.editor-status-bar-count--errors',
      '.editor-status-bar-count--warnings',
      '.editor-status-bar-count--other',
      '.editor-status-bar-state',
    ]) {
      expect(ruleBody(css, selector)).not.toMatch(/#[0-9a-f]{3,8}/i)
    }
  })
})

describe('EditorStatusBar', () => {
  // ediag-07 adds the strip's **one** control (D1). Everything else stays text:
  // §1.3's "nothing in it is a control, with the one exception in D1", and
  // adding a second would turn chrome into a toolbar.
  it('renders one non-wrapping strip of text fields and exactly one button', () => {
    const wrapper = mount(EditorStatusBar)
    const bar = wrapper.find('.editor-status-bar')

    expect(bar.exists()).toBe(true)
    // Chrome, not a pane: no splitter, no field that takes a click, and no
    // second control beside the re-check.
    expect(wrapper.find('[role="separator"]').exists()).toBe(false)
    expect(wrapper.find('input').exists()).toBe(false)
    expect(wrapper.findAll('button')).toHaveLength(1)
    wrapper.unmount()
  })

  // The empty pane is a *sentence*, not an absence (§1.3): with no buffer open
  // there is no server to name, and the field says so rather than going blank.
  it('says there is no buffer when the pane is empty', () => {
    const wrapper = mount(EditorStatusBar)
    const field = wrapper.find('[data-field="server"]')

    expect(field.exists()).toBe(true)
    expect(field.text()).toBe(NO_BUFFER_TEXT)
    wrapper.unmount()
  })

  it('makes no request with no buffer on screen', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const wrapper = mount(EditorStatusBar)
    expect(fetchSpy).not.toHaveBeenCalled()
    wrapper.unmount()
  })
})

// The strip's one control (D1, ediag-07). Disabled — never hidden — when there
// is nothing to re-check, with a title that says why; one ask per press.
describe('the re-check button', () => {
  function fileRecord(path) {
    return {
      kind: 'file',
      key: path,
      path,
      name: path.slice(path.lastIndexOf('/') + 1),
      text: '',
      baseline: '',
      dirty: false,
      mtime: 1,
      language: 'python',
      savedAt: 0,
      editedAt: 0,
    }
  }

  function jsonResponse(body, ok = true, status = 200) {
    return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
  }

  function stubAnswer(answer) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      if (String(url).startsWith('/api/lsp/query')) return jsonResponse(answer)
      return jsonResponse({ path: '', workspace: '/w', entries: [], truncated: false })
    })
  }

  // An `ok` envelope naming a server: a buffer worth re-checking.
  const OK = { status: 'ok', server: 'pyright', reason: null, action: 'status', result: null }
  // A `no_server` envelope: nothing will ever analyse this file, so there is
  // nothing to re-check.
  const NO_SERVER = {
    status: 'no_server',
    server: null,
    reason: 'no active language server handles .md',
    action: 'status',
    result: null,
  }

  async function settleBar() {
    await nextTick()
    await Promise.resolve()
    await nextTick()
  }

  beforeEach(() => {
    files.state.active = null
    files.state.open.length = 0
    diagnostics.stopRefresh()
    diagnostics.clear()
  })

  it('is present but disabled with no buffer on screen, and says why', async () => {
    stubAnswer(OK)
    const wrapper = mount(EditorStatusBar)
    await settleBar()

    const button = wrapper.find('button')
    expect(button.exists()).toBe(true)
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('title')).toContain('no buffer on screen')
    // One accessible name, the same string as the tooltip: two texts would be
    // two answers about what the button does.
    expect(button.attributes('aria-label')).toBe(button.attributes('title'))
    wrapper.unmount()
  })

  it('is enabled for a buffer a server answers, and asks once per click', async () => {
    const fetchMock = stubAnswer(OK)
    diagnostics.startRefresh()
    files.state.open.push(fileRecord('src/app.py'))
    files.state.active = 'src/app.py'
    const wrapper = mount(EditorStatusBar)
    await settleBar()

    const button = wrapper.find('button')
    expect(button.attributes('disabled')).toBeUndefined()
    expect(button.attributes('title')).toContain('Re-check src/app.py')

    const askCount = () =>
      fetchMock.mock.calls.filter(([url, init]) => {
        if (!String(url).startsWith('/api/lsp/query')) return false
        return JSON.parse(init.body).action === 'diagnostics'
      }).length
    const before = askCount()

    await button.trigger('click')
    await settleBar()
    expect(askCount()).toBe(before + 1)
    await button.trigger('click')
    await settleBar()
    expect(askCount()).toBe(before + 2)

    diagnostics.stopRefresh()
    wrapper.unmount()
  })

  it('is disabled with an explaining title for a file no server claims', async () => {
    stubAnswer(NO_SERVER)
    diagnostics.startRefresh()
    files.state.open.push(fileRecord('README.md'))
    files.state.active = 'README.md'
    const wrapper = mount(EditorStatusBar)
    await settleBar()
    await settleBar()

    const button = wrapper.find('button')
    expect(diagnostics.state.status).toBe('no_server')
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('title')).toContain('no language server answers')

    diagnostics.stopRefresh()
    wrapper.unmount()
  })
})

// ediag-08: the Problems and State fields.
//
// The bar presents what tasks 04, 06 and 07 produced and counts nothing of its
// own, so every case below is a state put in place through the diagnostics
// composable and read back off the rendered strip. What is being protected is
// §4's three-state table: a verdict is never an empty space, an unknown is never
// a verdict, and no field may describe a buffer that is not on screen.
describe('the Problems and State fields', () => {
  function fileRecord(path, kind = 'file') {
    return {
      kind,
      key: kind === 'file' ? path : `${kind}:${path}`,
      path,
      name: path.slice(path.lastIndexOf('/') + 1),
      text: '',
      baseline: '',
      dirty: false,
      mtime: 1,
      language: 'python',
      savedAt: 0,
      editedAt: 0,
    }
  }

  function jsonResponse(body, ok = true, status = 200) {
    return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
  }

  // One wire item, 0-based, exactly as `core/lsphub/editor.py` sends it.
  function item(severity = 'error', line = 0) {
    return {
      range: { start: { line, character: 0 }, end: { line, character: 3 } },
      severity,
      message: `${severity} here`,
    }
  }

  function analysed(items, version = 1) {
    return {
      status: 'ok',
      server: 'pyright',
      reason: null,
      action: 'diagnostics',
      result: { analysed: true, version, items, suppressed: 0 },
    }
  }

  // Every answer the one route gives, per action: `diagnostics` is what the
  // fields are about, and `status` fills the Server field beside them.
  function stubAnswer(diagnosticsAnswer, statusAnswer = { status: 'ok', server: 'pyright' }) {
    return vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (!String(url).startsWith('/api/lsp/query')) {
        return jsonResponse({ path: '', workspace: '/w', entries: [], truncated: false })
      }
      const action = JSON.parse(init.body).action
      if (action === 'diagnostics') return jsonResponse(diagnosticsAnswer)
      return jsonResponse({ ...statusAnswer, reason: statusAnswer.reason ?? null, action: 'status', result: null })
    })
  }

  // An ask made while the fetch is held open: `analysing…` is a state of an
  // in-flight request, so it can only be observed by opening one.
  function gateAnswer() {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (!String(url).startsWith('/api/lsp/query')) {
        return jsonResponse({ path: '', workspace: '/w', entries: [], truncated: false })
      }
      const action = JSON.parse(init.body).action
      if (action === 'diagnostics') return gate
      return jsonResponse({ status: 'ok', server: 'pyright', reason: null, action: 'status', result: null })
    })
    return { fetchMock, release }
  }

  async function settleBar() {
    await nextTick()
    await Promise.resolve()
    await nextTick()
    await Promise.resolve()
    await nextTick()
  }

  function openActive(path) {
    files.state.open.push(fileRecord(path))
    files.state.active = path
  }

  beforeEach(() => {
    files.state.active = null
    files.state.open.length = 0
    diagnostics.stopRefresh()
    diagnostics.clear()
  })

  // §4, row three: an analysis with items shows the counts, and both the number
  // and the underlines come from the one rule in `lib/monaco-lsp.js` (D7).
  it('shows the counts for two errors and a warning, and only those are underlined', async () => {
    stubAnswer(analysed([item('error'), item('error', 1), item('warning', 2)]))
    diagnostics.startRefresh()
    openActive('src/app.py')
    const wrapper = mount(EditorStatusBar)
    await settleBar()

    const field = wrapper.find('[data-field="problems"]')
    expect(field.exists()).toBe(true)
    expect(field.text()).toContain('2 errors')
    expect(field.text()).toContain('1 warning')
    // D7: the same answer's marker set is the errors and the warning, nothing
    // else — the number and the squiggles cannot disagree.
    expect(diagnostics.state.markers).toHaveLength(3)

    diagnostics.stopRefresh()
    wrapper.unmount()
  })

  // §4, row three, the zero case: a clean file is a verdict in words, never a
  // blank (§1.3: "A clean file is a verdict, and a verdict is never rendered as
  // an empty space").
  it('says "no problems" in words for a buffer analysed and clean', async () => {
    stubAnswer(analysed([]))
    diagnostics.startRefresh()
    openActive('src/app.py')
    const wrapper = mount(EditorStatusBar)
    await settleBar()

    const field = wrapper.find('[data-field="problems"]')
    expect(field.exists()).toBe(true)
    expect(field.text()).toBe('no problems')

    diagnostics.stopRefresh()
    wrapper.unmount()
  })

  // §4, row two: unknown is not clean. With a request in flight the State field
  // reads `analysing…` and the Problems field says nothing at all.
  it('reads `analysing…` and no counts while an answer is awaited', async () => {
    const { release } = gateAnswer()
    diagnostics.startRefresh()
    openActive('src/app.py')
    const wrapper = mount(EditorStatusBar)
    await settleBar()

    expect(wrapper.find('[data-field="state"]').text()).toBe('analysing…')
    expect(wrapper.find('[data-field="problems"]').exists()).toBe(false)

    release(jsonResponse(analysed([])))
    // The answer's own `res.json()` is one more microtask than the helpers
    // below flush, so the verdict is awaited here rather than raced.
    await vi.waitFor(() => expect(diagnostics.state.analysing).toBe(false))
    await settleBar()
    // And it disappears the moment there is a verdict.
    expect(wrapper.find('[data-field="state"]').exists()).toBe(false)
    expect(wrapper.find('[data-field="problems"]').text()).toBe('no problems')

    diagnostics.stopRefresh()
    wrapper.unmount()
  })

  // D4: "While an answer is awaited or dropped the bar reads `analysing…`." A
  // dropped answer leaves the held verdict on screen — the only answer that can
  // be stale is older than it — so the count stays and the state word appears
  // beside it, which is the honest reading of an analysis describing text that
  // is no longer there.
  it('reads `analysing…` beside the held counts when an answer was dropped as stale', async () => {
    let version = 7
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (!String(url).startsWith('/api/lsp/query')) {
        return jsonResponse({ path: '', workspace: '/w', entries: [], truncated: false })
      }
      const action = JSON.parse(init.body).action
      if (action === 'status') {
        return jsonResponse({ status: 'ok', server: 'pyright', reason: null, action: 'status', result: null })
      }
      return jsonResponse(analysed([item('error')], version))
    })
    diagnostics.startRefresh()
    openActive('src/app.py')
    const wrapper = mount(EditorStatusBar)
    await settleBar()
    expect(wrapper.find('[data-field="problems"]').text()).toContain('1 error')
    expect(wrapper.find('[data-field="state"]').exists()).toBe(false)

    // A strictly older version lands: dropped, not painted, and the bar keeps
    // saying it does not know yet.
    version = 5
    await diagnostics.recheck()
    await settleBar()
    expect(diagnostics.state.items).toHaveLength(1)
    expect(wrapper.find('[data-field="state"]').text()).toBe('analysing…')

    diagnostics.stopRefresh()
    wrapper.unmount()
  })

  // §4, row one: no server, so the Server field carries the reason, no counts
  // appear, and the bar never reads as clean.
  it('shows no counts for a file no server claims, and never reads as clean', async () => {
    stubAnswer(
      { status: 'no_server', server: null, reason: 'no active language server handles .md', action: 'diagnostics', result: null },
      { status: 'no_server', server: null, reason: 'no active language server handles .md' },
    )
    diagnostics.startRefresh()
    openActive('README.md')
    const wrapper = mount(EditorStatusBar)
    await settleBar()

    expect(wrapper.find('[data-field="problems"]').exists()).toBe(false)
    expect(wrapper.find('[data-field="state"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('no problems')
    expect(wrapper.find('[data-field="server"]').text()).toContain('no active language server')

    diagnostics.stopRefresh()
    wrapper.unmount()
  })

  // D7's own line: a hint has a count and no squiggle, and both halves come from
  // the same rule.
  it('counts a hint-only buffer and underlines none of it', async () => {
    stubAnswer(analysed([item('hint'), item('info', 1)]))
    diagnostics.startRefresh()
    openActive('src/app.py')
    const wrapper = mount(EditorStatusBar)
    await settleBar()

    const field = wrapper.find('[data-field="problems"]')
    expect(field.exists()).toBe(true)
    expect(field.text()).toContain('2 hints/info')
    expect(diagnostics.state.markers).toEqual([])

    diagnostics.stopRefresh()
    wrapper.unmount()
  })

  // "It describes the buffer on screen" (§1.3): switching buffers changes every
  // field in the same frame, and no field ever shows the previous buffer's
  // numbers.
  it('changes every field on a buffer switch and never leaves the old numbers', async () => {
    let answerFor = 'src/app.py'
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (!String(url).startsWith('/api/lsp/query')) {
        return jsonResponse({ path: '', workspace: '/w', entries: [], truncated: false })
      }
      const action = JSON.parse(init.body).action
      if (action === 'status') {
        return jsonResponse({ status: 'ok', server: 'pyright', reason: null, action: 'status', result: null })
      }
      return jsonResponse(
        answerFor === 'src/app.py'
          ? analysed([item('error'), item('warning', 1)])
          : analysed([], 2),
      )
    })
    diagnostics.startRefresh()
    files.state.open.push(fileRecord('src/app.py'), fileRecord('src/clean.py'))
    files.state.active = 'src/app.py'
    const wrapper = mount(EditorStatusBar)
    await settleBar()
    expect(wrapper.find('[data-field="problems"]').text()).toContain('1 error')

    answerFor = 'src/clean.py'
    files.state.active = 'src/clean.py'
    await settleBar()

    const field = wrapper.find('[data-field="problems"]')
    expect(field.exists()).toBe(true)
    expect(field.text()).toBe('no problems')
    expect(field.text()).not.toContain('error')

    diagnostics.stopRefresh()
    wrapper.unmount()
  })

  // A diff tab, a preview tab and the empty pane have no buffer and no server:
  // neither field appears (§1.3).
  it('shows neither field for a diff tab, a preview tab or an empty pane', async () => {
    stubAnswer(analysed([item('error')]))
    diagnostics.startRefresh()
    const wrapper = mount(EditorStatusBar)
    await settleBar()
    expect(wrapper.find('[data-field="problems"]').exists()).toBe(false)
    expect(wrapper.find('[data-field="state"]').exists()).toBe(false)

    files.state.open.push(fileRecord('src/app.py', 'diff'))
    files.state.active = 'diff:src/app.py'
    await settleBar()
    expect(wrapper.find('[data-field="problems"]').exists()).toBe(false)

    files.state.open.push(fileRecord('docs/a.md', 'preview'))
    files.state.active = 'preview:docs/a.md'
    await settleBar()
    expect(wrapper.find('[data-field="problems"]').exists()).toBe(false)
    expect(wrapper.find('[data-field="state"]').exists()).toBe(false)

    diagnostics.stopRefresh()
    wrapper.unmount()
  })

  // §1.4 and D6: neither field is a control, and the count is text.
  it('renders both fields as text, never as a control', async () => {
    stubAnswer(analysed([item('error')]))
    diagnostics.startRefresh()
    openActive('src/app.py')
    const wrapper = mount(EditorStatusBar)
    await settleBar()

    expect(wrapper.find('[data-field="problems"]').element.tagName).toBe('SPAN')
    // Still exactly the one button — the re-check (D1).
    expect(wrapper.findAll('button')).toHaveLength(1)

    diagnostics.stopRefresh()
    wrapper.unmount()
  })
})

// The context fields at the strip's right edge: what the buffer on screen *is* —
// caret, indentation, line ending, file kind. They come from `useEditorFacts`
// (the surface that owns the Monaco instance is the only thing that can answer)
// so every case here is a state put in place by a report and read back off the
// rendered strip. Encoding is deliberately absent: the bundled editor has no
// text-encoding concept, so there is nothing honest to show.
describe('the context fields', () => {
  const facts = useEditorFacts()

  beforeEach(() => {
    files.state.active = null
    files.state.open.length = 0
    diagnostics.stopRefresh()
    diagnostics.clear()
    clearEditorFacts()
  })

  function reported(overrides = {}) {
    reportFile({
      path: 'src/app.py',
      cursor: 'Ln 32, Col 23',
      indentation: 'Spaces: 2',
      eol: 'LF',
      language: 'JSON',
      ...overrides,
    })
  }

  it('shows the four facts in reading order, at the right edge', async () => {
    reported()
    const wrapper = mount(EditorStatusBar)
    await nextTick()

    const group = wrapper.find('.editor-status-bar-facts')
    expect(group.exists()).toBe(true)
    const fields = group.findAll('[data-field]')
    expect(fields.map((field) => field.attributes('data-field'))).toEqual([
      'cursor',
      'indentation',
      'eol',
      'language',
    ])
    expect(fields.map((field) => field.text())).toEqual([
      'Ln 32, Col 23',
      'Spaces: 2',
      'LF',
      'JSON',
    ])
    // Text, never a control: the group adds no button and no input.
    expect(group.findAll('button')).toHaveLength(0)
    expect(group.findAll('input')).toHaveLength(0)
    wrapper.unmount()
  })

  // The strip's one control stays the re-check: the facts are the §1.3 table's
  // spare slot made real, not a second affordance.
  it('adds no control to the strip', async () => {
    reported()
    const wrapper = mount(EditorStatusBar)
    await nextTick()

    expect(wrapper.findAll('button')).toHaveLength(1)
    wrapper.unmount()
  })

  // §1.3: no code surface on screen means no facts — never the previous
  // buffer's numbers under no buffer at all.
  it('is absent entirely while no code surface is on screen', async () => {
    const wrapper = mount(EditorStatusBar)
    await nextTick()

    expect(wrapper.find('.editor-status-bar-facts').exists()).toBe(false)
    wrapper.unmount()
  })

  it('is absent once the surface goes away', async () => {
    reported()
    const wrapper = mount(EditorStatusBar)
    await nextTick()
    expect(wrapper.find('.editor-status-bar-facts').exists()).toBe(true)

    clearEditorFacts()
    await nextTick()
    expect(wrapper.find('.editor-status-bar-facts').exists()).toBe(false)
    wrapper.unmount()
  })

  // A fact the surface could not answer is dropped from the group rather than
  // rendered as a gap or as a plausible lie.
  it('drops a fact that was not answered, and keeps the rest', async () => {
    reported({ cursor: null, indentation: null })
    const wrapper = mount(EditorStatusBar)
    await nextTick()

    const keys = wrapper
      .findAll('.editor-status-bar-facts [data-field]')
      .map((field) => field.attributes('data-field'))
    expect(keys).toEqual(['eol', 'language'])
    wrapper.unmount()
  })

  // The caret moves per keystroke, so the group must not be announced: the strip
  // is a polite live region and "Ln 12, Col 3" after each character would bury
  // the verdicts it exists to speak.
  it('is not announced as a live region', async () => {
    reported()
    const wrapper = mount(EditorStatusBar)
    await nextTick()

    expect(wrapper.find('.editor-status-bar-facts').attributes('aria-live')).toBe('off')
    wrapper.unmount()
  })

  // The geometry is asserted on the shipped CSS, the way this suite already pins
  // the strip's own rules: jsdom lays nothing out.
  it('is pushed to the right edge by its own rule, in its own namespace', () => {
    const css = strippedCss()
    const body = ruleBody(css, '.editor-status-bar-facts')
    expect(body, '.editor-status-bar-facts has a rule of its own').not.toBeNull()
    expect(body).toContain('margin-left: auto')
    expect(body).toContain('display: flex')
    expect(body).toContain('flex: 0 0 auto')
    // Muted, from the theme's token: context, quieter than the verdicts beside
    // it — and never a raw hexadecimal written into the stylesheet here.
    const field = ruleBody(css, '.editor-status-bar-facts .editor-status-bar-field')
    expect(field).toContain('color: var(--pico-muted-color)')
    expect(field).not.toMatch(/#[0-9a-f]{3,8}/i)
  })
})

describe('EditorView mounts it', () => {
  it('as the last child of the shell, so it is below tree, pane and terminal', () => {
    const wrapper = mount(EditorView, { attachTo: document.body })
    const shell = wrapper.find('.editor-shell')

    expect(shell.exists()).toBe(true)
    const children = [...shell.element.children]
    const last = children[children.length - 1]
    expect(last.classList.contains('editor-status-bar')).toBe(true)

    // And the bar is not one of the three panes: the tree and its splitter
    // come before the code pane, the terminal, then the bar.
    expect(shell.find('.editor-nav-col').exists()).toBe(true)
    expect(shell.find('.editor-terminal-slot').exists()).toBe(true)
    expect(
      children.indexOf(shell.find('.editor-nav-col').element),
    ).toBeLessThan(children.indexOf(last))
    wrapper.unmount()
  })
})
