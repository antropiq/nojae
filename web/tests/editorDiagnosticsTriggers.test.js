import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { nextTick } from 'vue'

import {
  DIAGNOSTICS_SETTLE_MS,
  useEditorDiagnostics,
} from '../src/composables/useEditorDiagnostics'
import { useChat } from '../src/composables/useChat'
import { useEditorFiles } from '../src/composables/useEditorFiles'
import { useEditorLsp } from '../src/composables/useEditorLsp'
import { useEditorNotices } from '../src/composables/useEditorNotices'
import { useWorkspaceTree } from '../src/composables/useWorkspaceTree'
import { pointTabAt, withoutWorkspace } from './helpers/workspace-url'

// ---------------------------------------------------------------------------
// ediag-07: *when* the diagnostics are asked for.
//
// Task 06 made an answer possible; this suite pins the **four moments and no
// others** (spec D3) and the bar's one control (D1):
//
//   1. the buffer becomes the one on screen — and a buffer whose analysis is
//      already held is *re-applied*, not re-asked;
//   2. edits settle after the one quiet period of the feature;
//   3. a save completes (a refused save is not a completed save);
//   4. the explicit re-check, exactly once per press.
//
// Plus the negatives the same decision states: no interval, no poll, nothing
// per keystroke, and no refresh at all while there is no buffer on screen.
//
// The transport is a stubbed `fetch` that counts requests, and the settling
// period is driven by fake timers — no hub is reached and nothing waits on a
// real clock.
// ---------------------------------------------------------------------------

const diagnostics = useEditorDiagnostics()
const files = useEditorFiles()
const chat = useChat()
const lsp = useEditorLsp()
const notices = useEditorNotices()
const tree = useWorkspaceTree()

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

// The wire envelope, exactly as `core/lsphub/manager.py` builds it.
function envelope({ status = 'ok', server = 'pyright', reason = null, result = null } = {}) {
  return { status, server, reason, action: 'diagnostics', result }
}

function item(message = 'boom') {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    severity: 'error',
    message,
  }
}

function analysed(items = [item()], version = 1) {
  return envelope({ result: { analysed: true, version, items, suppressed: 0 } })
}

// A file record with every field the buffer rules read, without going through a
// route: this suite is about the triggers, not about the open path.
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

function viewRecord(path, kind) {
  return {
    kind,
    key: `${kind}:${path}`,
    path,
    name: `${path} (${kind})`,
    original: 'before\n',
    modified: 'after\n',
    text: 'rendered\n',
    html: '<p>rendered</p>',
    language: 'plaintext',
    status: 'modified',
    baseline: 'head',
    renamedFrom: null,
    truncated: false,
    truncatedAt: null,
  }
}

// Every `diagnostics` ask the composable made, in order. A suite that counted
// *all* requests would be counting the buffer reads and the git marks too.
function asks(fetchMock) {
  return fetchMock.mock.calls.filter(([url, init]) => {
    if (withoutWorkspace(url) !== '/api/lsp/query') return false
    try {
      return JSON.parse(init.body).action === 'diagnostics'
    } catch {
      return false
    }
  })
}

function stubRoutes(handler = () => jsonResponse(analysed())) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const key = String(url)
    if (withoutWorkspace(key) === '/api/lsp/query') return handler(url, init)
    if (key.startsWith('/api/fs/file')) {
      return jsonResponse({
        path: 'src/app.py',
        text: 'x = 1\n',
        mtime: 1000,
        language: 'python',
        size: 6,
        binary: false,
        truncated: false,
      })
    }
    if (key.startsWith('/api/fs/status') || key.startsWith('/api/fs/stat')) {
      return jsonResponse({ repo: false, entries: [], paths: [] })
    }
    return jsonResponse({ path: '', workspace: '/w/demo', entries: [], truncated: false })
  })
}

async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

function resetState() {
  diagnostics.stopRefresh()
  diagnostics.clear()
  pointTabAt('/w')
  files.state.open.length = 0
  files.state.active = null
  files.state.message = null
  chat.state.lsp.servers = []
  chat.state.lsp.enabled = {}
  chat.state.lsp.loaded = false
  lsp.clear()
  notices.clear()
  tree.state.workspace = '/w/demo'
}

beforeEach(() => {
  resetState()
  vi.restoreAllMocks()
  vi.useFakeTimers()
})

afterEach(() => {
  diagnostics.stopRefresh()
  vi.useRealTimers()
})

describe('trigger one: the buffer becomes the one on screen', () => {
  it('asks once for a buffer with no held analysis', async () => {
    const fetchMock = stubRoutes()
    diagnostics.startRefresh()
    await settle()

    files.state.open.push(fileRecord('src/app.py'))
    files.state.active = 'src/app.py'
    await settle()

    // Immediate arming already looked at an empty pane, which asks nothing.
    expect(asks(fetchMock)).toHaveLength(1)
  })

  // Re-applying is not a fifth moment (D3): coming back to a buffer whose
  // analysis is held costs no request — it is the same moment, answered from
  // what is held.
  it('asks nothing for a buffer whose analysis is held, and re-applies it', async () => {
    const fetchMock = stubRoutes()
    diagnostics.startRefresh()
    await settle()

    files.state.open.push(fileRecord('src/app.py'), fileRecord('src/other.py'))
    files.state.active = 'src/app.py'
    await settle()
    files.state.active = 'src/other.py'
    await settle()
    expect(asks(fetchMock)).toHaveLength(2)

    files.state.active = 'src/app.py'
    await settle()

    expect(asks(fetchMock)).toHaveLength(2)
    expect(diagnostics.state.path).toBe('src/app.py')
    expect(diagnostics.state.status).toBe('analysed')
    expect(diagnostics.state.markers).toHaveLength(1)
  })

  // The pane's own notion of the active tab, so a chip click, a tree click, an
  // arrow key on the strip, a close that reveals its neighbour and a reload all
  // reach the same value — this asserts the value, not a DOM event.
  it('a close that reveals its neighbour is the same moment', async () => {
    const fetchMock = stubRoutes()
    diagnostics.startRefresh()
    await settle()

    files.state.open.push(fileRecord('src/app.py'), fileRecord('src/other.py'))
    files.state.active = 'src/other.py'
    await settle()
    expect(asks(fetchMock)).toHaveLength(1)

    // Closing the active tab reveals its neighbour, exactly as `closeTab` does.
    files.state.open.splice(1, 1)
    files.state.active = 'src/app.py'
    await settle()

    expect(asks(fetchMock)).toHaveLength(2)
  })
})

describe('trigger two: edits settle after the one quiet period', () => {
  it('four edits in a row produce one request, after the quiet period', async () => {
    const fetchMock = stubRoutes()
    diagnostics.startRefresh()
    await settle()

    files.state.open.push(fileRecord('src/app.py'))
    files.state.active = 'src/app.py'
    await settle()
    await vi.advanceTimersByTimeAsync(0)
    const before = asks(fetchMock).length

    for (const text of ['a\n', 'ab\n', 'abc\n', 'abcd\n']) {
      files.updateText('src/app.py', text)
      await nextTick()
      await vi.advanceTimersByTimeAsync(DIAGNOSTICS_SETTLE_MS - 50)
    }
    // No request at all while the user keeps typing inside the period.
    expect(asks(fetchMock)).toHaveLength(before)

    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_SETTLE_MS)
    expect(asks(fetchMock)).toHaveLength(before + 1)

    // And nothing more afterwards: the settling period is not a poll.
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_SETTLE_MS * 20)
    expect(asks(fetchMock)).toHaveLength(before + 1)
  })

  // The same moment with a burst of *one*: a single edit must still ask, or the
  // debounce would only ever work for people who type fast.
  it('one edit asks once, after the quiet period', async () => {
    const fetchMock = stubRoutes()
    diagnostics.startRefresh()
    await settle()

    files.state.open.push(fileRecord('src/app.py'))
    files.state.active = 'src/app.py'
    await settle()
    await vi.advanceTimersByTimeAsync(0)
    const before = asks(fetchMock).length

    files.updateText('src/app.py', 'edited\n')
    await nextTick()
    expect(asks(fetchMock)).toHaveLength(before)

    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_SETTLE_MS)
    expect(asks(fetchMock)).toHaveLength(before + 1)
  })

  it('a buffer switch drops a settling period armed for the buffer just left', async () => {
    const fetchMock = stubRoutes()
    diagnostics.startRefresh()
    await settle()

    files.state.open.push(fileRecord('src/app.py'), fileRecord('src/other.py'))
    files.state.active = 'src/app.py'
    await settle()
    await vi.advanceTimersByTimeAsync(0)
    const before = asks(fetchMock).length

    files.updateText('src/app.py', 'edited\n')
    await nextTick()
    files.state.active = 'src/other.py'
    await settle()

    // The switch itself is trigger one for `src/other.py` — one ask. The period
    // armed for `src/app.py` is gone, so it adds nothing.
    expect(asks(fetchMock)).toHaveLength(before + 1)
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_SETTLE_MS * 4)
    expect(asks(fetchMock)).toHaveLength(before + 1)
  })
})

describe('trigger three: a save that completed', () => {
  it('asks once when a save lands, and a refused save asks nothing', async () => {
    let put = () => jsonResponse({ path: 'src/app.py', size: 9, mtime: 2000 })
    const fetchMock = stubRoutes()
    const base = fetchMock.getMockImplementation()
    fetchMock.mockImplementation((url, init) => {
      if (init?.method === 'PUT') return put()
      return base(url, init)
    })

    diagnostics.startRefresh()
    const record = await files.openFile('src/app.py')
    await settle()
    await vi.advanceTimersByTimeAsync(0)
    expect(asks(fetchMock)).toHaveLength(1)

    files.updateText('src/app.py', 'mine\n')
    await nextTick()
    expect(record.editedAt).toBe(1)

    expect((await files.saveFile('src/app.py')).ok).toBe(true)
    await settle()
    // The save's own ask; the settling period the edit armed was dropped.
    expect(asks(fetchMock)).toHaveLength(2)
    expect(record.savedAt).toBe(1)
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_SETTLE_MS * 4)
    expect(asks(fetchMock)).toHaveLength(2)

    // A save that did not land is not a completed save: no ask at all. The
    // edit's own settling period is flushed first, so the count below can only
    // move if the *save* asked something.
    files.updateText('src/app.py', 'mine again\n')
    await nextTick()
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_SETTLE_MS)
    await settle()
    const afterEdit = asks(fetchMock).length

    for (const [status, detail] of [
      [409, 'Cannot save while a chat reply is streaming'],
      [422, 'Path is read-only by workspace policy: src/app.py'],
    ]) {
      put = () => jsonResponse({ detail }, false, status)
      expect((await files.saveFile('src/app.py')).ok).toBe(false)
      await settle()
      await vi.advanceTimersByTimeAsync(DIAGNOSTICS_SETTLE_MS * 4)
      expect(asks(fetchMock)).toHaveLength(afterEdit)
      expect(record.savedAt).toBe(1)
    }
  })
})

describe('trigger four: the bar\'s one control', () => {
  it('asks exactly once per press', async () => {
    const fetchMock = stubRoutes()
    diagnostics.startRefresh()
    await settle()

    files.state.open.push(fileRecord('src/app.py'))
    files.state.active = 'src/app.py'
    await settle()
    await vi.advanceTimersByTimeAsync(0)
    const before = asks(fetchMock).length

    await diagnostics.recheck()
    expect(asks(fetchMock)).toHaveLength(before + 1)
    await diagnostics.recheck()
    expect(asks(fetchMock)).toHaveLength(before + 2)
  })

  // D1: disabled, never hidden, with a title that explains itself.
  it('is disabled with an explaining title when there is no buffer or no server', async () => {
    stubRoutes()
    diagnostics.startRefresh()
    await settle()

    expect(diagnostics.recheckEnabled.value).toBe(false)
    expect(diagnostics.recheckLabel.value).toContain('no buffer on screen')

    // A buffer a server answers for: enabled, and the title names the press.
    files.state.open.push(fileRecord('src/app.py'))
    files.state.active = 'src/app.py'
    await settle()
    expect(diagnostics.recheckEnabled.value).toBe(true)
    expect(diagnostics.recheckLabel.value).toContain('Re-check src/app.py')

    // A buffer nothing will ever analyse: disabled again, and it says why.
    const local = stubRoutes(() =>
      jsonResponse(envelope({ status: 'no_server', server: null, reason: 'no server handles .md' })),
    )
    files.state.open.push(fileRecord('README.md'))
    files.state.active = 'README.md'
    await settle()
    expect(local).toBeDefined()
    expect(diagnostics.recheckEnabled.value).toBe(false)
    expect(diagnostics.recheckLabel.value).toContain('no language server answers')
  })
})

describe('no other moment refreshes anything', () => {
  it('a diff tab, a preview tab and an empty pane ask nothing', async () => {
    const fetchMock = stubRoutes()
    diagnostics.startRefresh()
    await settle()

    files.state.open.push(viewRecord('src/app.py', 'diff'))
    files.state.active = 'diff:src/app.py'
    await settle()

    files.state.open.push(viewRecord('docs/a.md', 'preview'))
    files.state.active = 'preview:docs/a.md'
    await settle()

    files.state.active = null
    await settle()
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_SETTLE_MS * 10)

    expect(asks(fetchMock)).toHaveLength(0)
  })

  // A streaming reply is not a trigger: this is a read, and §8's headline
  // regression is that the underlines stay visible *during* a reply.
  it('neither a streaming reply nor a passing timer asks', async () => {
    const fetchMock = stubRoutes()
    diagnostics.startRefresh()
    await settle()

    files.state.open.push(fileRecord('src/app.py'))
    files.state.active = 'src/app.py'
    await settle()
    await vi.advanceTimersByTimeAsync(0)
    const before = asks(fetchMock).length

    chat.state.phase = 'streaming'
    await settle()
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_SETTLE_MS * 30)
    chat.state.phase = 'idle'
    await settle()
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_SETTLE_MS * 30)

    expect(asks(fetchMock)).toHaveLength(before)
  })

  // Task 06's guards are what decide which of two overlapping asks wins, so an
  // edit landing during a request opens no second one in parallel — the settled
  // period produces one ask.
  it('an edit during a request opens no second request in parallel', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    let count = 0
    const fetchMock = stubRoutes(() => {
      count += 1
      if (count === 1) return gate
      return jsonResponse(analysed())
    })
    diagnostics.startRefresh()
    await settle()

    files.state.open.push(fileRecord('src/app.py'))
    files.state.active = 'src/app.py'
    await settle()
    expect(asks(fetchMock)).toHaveLength(1)

    files.updateText('src/app.py', 'edited\n')
    await nextTick()
    // Still inside the settling period: no parallel request has been opened.
    expect(asks(fetchMock)).toHaveLength(1)

    release(jsonResponse(analysed()))
    await settle()
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_SETTLE_MS)
    expect(asks(fetchMock)).toHaveLength(2)
  })
})

// D3 says it twice: the settling period is *the only timing constant in the
// feature*, and a per-tick analysis is the request storm it forbids. Asserted on
// the shipped source, because the failure mode is an added `setInterval` that
// every behavioural test above would still pass.
describe('the one timing constant, and no poll anywhere', () => {
  const SOURCE = readFileSync(
    join(resolve(), 'src', 'composables', 'useEditorDiagnostics.js'),
    'utf8',
  )

  function stripped() {
    return SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  }

  it('exports the settling period by name', () => {
    expect(typeof DIAGNOSTICS_SETTLE_MS).toBe('number')
    expect(DIAGNOSTICS_SETTLE_MS).toBeGreaterThan(0)
    expect(SOURCE).toContain('export const DIAGNOSTICS_SETTLE_MS')
  })

  it('sets exactly one timeout and no interval', () => {
    const code = stripped()
    expect(code.match(/setTimeout\(/g) ?? []).toHaveLength(1)
    expect(code).not.toContain('setInterval')
    expect(code).not.toContain('requestAnimationFrame')
    // Every other scheduled wait in this app is a named millisecond number; a
    // second one here would be a second timing constant.
    expect(code.match(/\b\d{2,}\s*(?=[,)])/g) ?? []).toHaveLength(0)
  })
})

describe('disarming', () => {
  it('drops the settling period and the watchers when the pane goes away', async () => {
    const fetchMock = stubRoutes()
    diagnostics.startRefresh()
    await settle()

    files.state.open.push(fileRecord('src/app.py'))
    files.state.active = 'src/app.py'
    await settle()
    await vi.advanceTimersByTimeAsync(0)
    const before = asks(fetchMock).length

    files.updateText('src/app.py', 'edited\n')
    await nextTick()
    diagnostics.stopRefresh()
    await vi.advanceTimersByTimeAsync(DIAGNOSTICS_SETTLE_MS * 4)

    expect(asks(fetchMock)).toHaveLength(before)
  })

  it('arming twice does not arm a second set of watchers', async () => {
    const fetchMock = stubRoutes()
    diagnostics.startRefresh()
    diagnostics.startRefresh()
    await settle()

    files.state.open.push(fileRecord('src/app.py'))
    files.state.active = 'src/app.py'
    await settle()

    expect(asks(fetchMock)).toHaveLength(1)
  })
})
