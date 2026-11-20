import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { useEditorDiagnostics } from '../src/composables/useEditorDiagnostics'
import { useChat } from '../src/composables/useChat'
import { useEditorFiles } from '../src/composables/useEditorFiles'
import { useEditorLsp } from '../src/composables/useEditorLsp'
import { useEditorNotices } from '../src/composables/useEditorNotices'
import { useWorkspaceTree } from '../src/composables/useWorkspaceTree'
import { markersForDiagnostics } from '../src/lib/monaco-lsp'
import { pointTabAt, withoutWorkspace } from './helpers/workspace-url'

// ---------------------------------------------------------------------------
// The Editor pane's diagnostics (ediag-06).
//
// The rules this suite exists for are the spec's §3.1, §4's three-state table,
// D4 and §6's first four invariants:
//
//   * an ask is one request, on its own token, and every quiet outcome — no
//     server, switched off, errored, not analysed yet, an unreachable API, a
//     refused request — is a sentence or a silence, never a notice;
//   * the middle row of §4 is never presented as *clean*: `analysed: false`
//     leaves the state *unknown*, and only an `analysed: true` answer turns it
//     into a verdict;
//   * guard one (the token) and guard two (the answer's version) each hold on
//     their own — a test proves each without the other's help;
//   * the marker set is the new answer's, whole, built by `lib/monaco-lsp.js`;
//   * the memory is keyed by path, emptied by a closed buffer and by a working
//     location switch, and a re-application asks for nothing.
//
// The transport is a stubbed `fetch`, as every web suite here is: no hub is
// reached and no real analysis is assumed. The payload shapes are the ones
// `core/lsphub/editor.py` builds and `tests/test_lsp_editor.py` pins.
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
function envelope({
  status = 'ok',
  server = 'pyright',
  reason = null,
  action = 'diagnostics',
  result = null,
} = {}) {
  return { status, server, reason, action, result }
}

// One wire item: 0-based, as the hub sends it.
function item({ line = 0, character = 0, endCharacter = 3, severity = 'error', message = 'boom' } = {}) {
  return {
    range: {
      start: { line, character },
      end: { line, character: endCharacter },
    },
    severity,
    message,
  }
}

// An `analysed` result — the shape task 03 pinned.
function analysed(items, version = 1, suppressed = 0) {
  return { analysed: true, version, items, suppressed }
}

// The answer for a file nothing has analysed yet: an `ok` envelope whose result
// says so. Deliberately not an error and not a fourth status.
function notAnalysedYet() {
  return envelope({ result: { analysed: false, items: [], suppressed: 0 } })
}

// One open buffer of a given path and kind, without going through a route: this
// suite is about the composable's rules, not about `useEditorFiles`' open path.
function openRecord(path, { kind = 'file', dirty = false, text = '' } = {}) {
  const record = {
    kind,
    key: kind === 'diff' ? `diff:${path}` : kind === 'preview' ? `preview:${path}` : path,
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    text,
    baseline: dirty ? '' : text,
    dirty,
    mtime: 1,
    language: 'python',
  }
  files.state.open.push(record)
  files.state.active = record.key
  return record
}

function closeRecord(path) {
  const index = files.state.open.findIndex((record) => record.path === path && record.kind === 'file')
  if (index !== -1) files.state.open.splice(index, 1)
}

function resetState() {
  pointTabAt('/w')
  diagnostics.clear()
  files.state.open.length = 0
  files.state.active = null
  files.state.message = null
  chat.state.lsp.servers = []
  chat.state.lsp.enabled = {}
  chat.state.lsp.loaded = false
  chat.state.lsp.locked = false
  chat.state.lsp.restarting = false
  lsp.clear()
  notices.clear()
  tree.state.workspace = '/w/demo'
}

function queryBodies(fetchMock) {
  return fetchMock.mock.calls
    .filter(([url]) => withoutWorkspace(url) === '/api/lsp/query')
    .map(([, init]) => JSON.parse(init.body))
}

// The route a working-location switch touches: the new root's listing.
function stubWorkspaceRoutes(queryHandler) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const key = String(url)
    if (key.startsWith('/api/lsp/query')) return queryHandler(url, init)
    if (key.startsWith('/api/fs/tree')) {
      const path = decodeURIComponent(key.slice('/api/fs/tree?path='.length))
      return jsonResponse({
        path,
        workspace: '/w/other',
        entries: [{ name: 'src', path: 'src', dir: true, children: true }],
        truncated: false,
      })
    }
    return jsonResponse({})
  })
}

beforeEach(() => {
  resetState()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('the ask: one request, one body, the buffer as the source of truth', () => {
  it('posts the diagnostics action for one path and stores the analysis', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope({ result: analysed([item()]) })))

    openRecord('src/app.py')
    const answer = await diagnostics.ask('src/app.py')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0]).startsWith('/api/lsp/query')).toBe(true)
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
    const [body] = queryBodies(fetchMock)
    expect(body.action).toBe('diagnostics')
    expect(body.path).toBe('src/app.py')
    // No position travels for this action (it needs none), and a clean buffer
    // sends no text — the hub reads the file.
    expect(body).not.toHaveProperty('line')
    expect(body).not.toHaveProperty('character')
    expect(body).not.toHaveProperty('text')
    expect(answer.status).toBe('ok')
    expect(diagnostics.state.status).toBe('analysed')
    expect(diagnostics.state.items).toEqual([item()])
  })

  // §6: unsaved edits are analysed as written, so the text travels while the
  // buffer is dirty — read from the record the pane already holds, never from a
  // second copy.
  it('sends the buffer text exactly while the buffer is dirty', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope({ result: analysed([]) })))

    const record = openRecord('src/app.py', { dirty: true, text: 'x = 1\n' })
    await diagnostics.ask('src/app.py')
    expect(queryBodies(fetchMock).at(-1).text).toBe('x = 1\n')

    record.text = 'x = 1\ny = 2\n'
    record.baseline = record.text
    record.dirty = false
    await diagnostics.ask('src/app.py')
    expect('text' in queryBodies(fetchMock).at(-1)).toBe(false)
  })

  // The marker set is task 04's pure mapping, never shaped here: one `+1`, one
  // severity rule (D7), one set.
  it('holds the markers lib/monaco-lsp.js builds, not a shape of its own', async () => {
    const items = [item({ line: 4, character: 2, severity: 'error' }), item({ severity: 'hint' })]
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(envelope({ result: analysed(items) })),
    )

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')

    expect(diagnostics.state.markers).toEqual(markersForDiagnostics(items))
    // D7: the hint is counted and not underlined.
    expect(diagnostics.state.items).toHaveLength(2)
    expect(diagnostics.state.markers).toHaveLength(1)
    expect(diagnostics.state.markers[0]).toMatchObject({ startLineNumber: 5, startColumn: 3 })
  })

  // The allowlist is read from the Tools panel's own switches, from the same
  // single source the other two LSP composables read.
  it('sends the Tools panel\'s allowlist, and none when the snapshot failed', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope({ result: analysed([]) })))

    chat.state.lsp.loaded = true
    chat.state.lsp.enabled = { pyright: true, volar: false, tsserver: true }
    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')
    expect(queryBodies(fetchMock).at(-1).lspEnabled).toEqual(['pyright', 'tsserver'])

    chat.state.lsp.loaded = false
    chat.state.lsp.enabled = { pyright: false }
    await diagnostics.ask('src/app.py')
    expect('lspEnabled' in queryBodies(fetchMock).at(-1)).toBe(false)
  })

  // The two gates that must not apply, asserted the way `useEditorLsp`'s suite
  // asserts them: a mode narrows the conversation, never the pane.
  it('carries no mode id and no batch flag', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope({ result: analysed([]) })))

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')

    const [body] = queryBodies(fetchMock)
    expect(body).not.toHaveProperty('mode')
    expect(body).not.toHaveProperty('batch')
    expect(body).not.toHaveProperty('batchActive')
  })
})

describe('the three states, and the middle one is never "clean"', () => {
  it('"not analysed yet" leaves the state unknown, and a later empty answer is a verdict', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => jsonResponse(notAnalysedYet()))
      .mockImplementationOnce(() => jsonResponse(envelope({ result: analysed([], 2) })))

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')

    // The middle row of §4: unknown, not clean — no items and no verdict.
    expect(diagnostics.state.status).toBe('unknown')
    expect(diagnostics.state.items).toEqual([])
    expect(diagnostics.state.markers).toEqual([])
    expect(diagnostics.analysisFor('src/app.py')).toBeNull()

    await diagnostics.ask('src/app.py')
    expect(diagnostics.state.status).toBe('analysed')
    expect(diagnostics.state.items).toEqual([])
    expect(diagnostics.state.suppressed).toBe(0)
  })

  // A file nothing will ever analyse says so, and leaves no marks behind from
  // whatever was on screen before.
  it('a no_server answer is its own state, with the hub\'s reason', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => jsonResponse(envelope({ result: analysed([item()]) })))
      .mockImplementationOnce(() =>
        jsonResponse(
          envelope({
            status: 'no_server',
            server: null,
            reason: 'no active language server handles .md',
          }),
        ),
      )

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')
    expect(diagnostics.state.markers).toHaveLength(1)

    openRecord('README.md')
    await diagnostics.ask('README.md')
    expect(diagnostics.state.status).toBe('no_server')
    expect(diagnostics.state.reason).toBe('no active language server handles .md')
    // The previous buffer's marks are gone: a memory keyed by path never answers
    // for another path.
    expect(diagnostics.state.markers).toEqual([])
    expect(diagnostics.analysisFor('src/app.py')).toEqual(
      expect.objectContaining({ items: [item()] }),
    )
  })

  // A `starting` answer is *not* retried here (there is one timing constant in
  // this feature, and it belongs to task 07) and it is not a verdict either.
  it('a starting answer leaves the state unknown and sends one request', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        jsonResponse(envelope({ status: 'starting', reason: 'pyright is starting' })),
      )

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(diagnostics.state.status).toBe('unknown')
    expect(diagnostics.state.reason).toBe('pyright is starting')
  })

  it('reports an answer awaited, and stops reporting it once one lands', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => gate)

    openRecord('src/app.py')
    const pending = diagnostics.ask('src/app.py')
    expect(diagnostics.state.analysing).toBe(true)

    release(jsonResponse(envelope({ result: analysed([]) })))
    await pending
    expect(diagnostics.state.analysing).toBe(false)
  })
})

describe('guard one: a late answer never overwrites a newer one', () => {
  // Two asks in flight, the first answering last. Its version is *newer* than
  // the second's, so guard two could not have dropped it: only the token can.
  it('drops the first answer when it lands after the second', async () => {
    const first = 'from the first ask'
    const second = 'from the second ask'
    let releaseFirst
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve
    })
    let call = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      call += 1
      if (call === 1) return firstGate
      return jsonResponse(
        envelope({ result: analysed([item({ message: second })], 2) }),
      )
    })

    openRecord('src/app.py')
    const pendingFirst = diagnostics.ask('src/app.py')
    const pendingSecond = diagnostics.ask('src/app.py')
    const secondAnswer = await pendingSecond
    releaseFirst(
      jsonResponse(envelope({ result: analysed([item({ message: first })], 9) })),
    )

    expect(await pendingFirst).toBeNull()
    expect(secondAnswer.status).toBe('ok')
    expect(diagnostics.state.items.map((entry) => entry.message)).toEqual([second])
    expect(diagnostics.analysisFor('src/app.py').version).toBe(2)
    expect(diagnostics.state.version).toBe(2)
  })
})

describe('guard two: an answer about older text is dropped', () => {
  // The newest ask answers with a *lower* version than the analysis already
  // accepted for this buffer: the token is current, so only the version can
  // drop it.
  it('discards a strictly older version and keeps describing the newer text', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() =>
        jsonResponse(envelope({ result: analysed([item({ message: 'newer' })], 7) })),
      )
      .mockImplementationOnce(() =>
        jsonResponse(envelope({ result: analysed([item({ message: 'older' })], 5) })),
      )

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')
    expect(diagnostics.state.items.map((entry) => entry.message)).toEqual(['newer'])

    const dropped = await diagnostics.ask('src/app.py')

    expect(dropped).toBeNull()
    expect(diagnostics.state.version).toBe(7)
    expect(diagnostics.state.items.map((entry) => entry.message)).toEqual(['newer'])
    expect(diagnostics.analysisFor('src/app.py').version).toBe(7)
    // The analysis on screen describes text that is no longer there, so the
    // honest reading is still "we do not know yet" (D4).
    expect(diagnostics.state.analysing).toBe(true)
  })

  // The lagging inbox, as the symptom the user reported: after a fix the hub
  // answers "not analysed yet" (the payload still described the buggy text), and
  // that must CLEAR the held verdict rather than leave the old problems on the
  // bar. `analysed: false` is the middle row of §4 — unknown, never stale-held.
  it('clears a held verdict when the hub says the edited text is not analysed yet', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() =>
        jsonResponse(envelope({ result: analysed([item({ message: 'boom' })], 4) })),
      )
      .mockImplementationOnce(() => jsonResponse(notAnalysedYet()))

    openRecord('src/app.py', { dirty: true, text: 'BUG here\n' })
    await diagnostics.ask('src/app.py')
    expect(diagnostics.state.items).toHaveLength(1)
    expect(diagnostics.state.markers).toHaveLength(1)

    // The user typed the fix; the settle period asks again.
    files.state.open[0].text = 'clean now\n'
    files.state.open[0].dirty = true
    await diagnostics.ask('src/app.py')

    // No squiggles under the fixed code, and no stale verdict remembered.
    expect(diagnostics.state.status).toBe('unknown')
    expect(diagnostics.state.items).toEqual([])
    expect(diagnostics.state.markers).toEqual([])
    expect(diagnostics.analysisFor('src/app.py')).toBeNull()
    // The bar reads `analysing…` rather than a count: it does not know yet.
    expect(diagnostics.counts.value).toEqual({ errors: 0, warnings: 0, total: 0 })
  })

  // An equal version is the same analysis: accepted, never called stale.
  it('accepts an equal version', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() =>
        jsonResponse(envelope({ result: analysed([item({ message: 'first' })], 3) })),
      )
      .mockImplementationOnce(() =>
        jsonResponse(envelope({ result: analysed([item({ message: 'again' })], 3) })),
      )

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')
    await diagnostics.ask('src/app.py')

    expect(diagnostics.state.items.map((entry) => entry.message)).toEqual(['again'])
    expect(diagnostics.state.analysing).toBe(false)
  })
})

describe('whole replacement, never a merge', () => {
  it('a second answer with fewer items yields exactly those items', async () => {
    const kept = item({ line: 1, message: 'kept' })
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() =>
        jsonResponse(envelope({ result: analysed([item({ message: 'fixed' }), kept], 1) })),
      )
      .mockImplementationOnce(() => jsonResponse(envelope({ result: analysed([kept], 2) })))

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')
    expect(diagnostics.state.markers).toHaveLength(2)

    await diagnostics.ask('src/app.py')
    expect(diagnostics.state.items).toEqual([kept])
    expect(diagnostics.state.markers).toEqual(markersForDiagnostics([kept]))
  })

  it('an analysed-and-clean answer clears the marks it replaced', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => jsonResponse(envelope({ result: analysed([item()], 1) })))
      .mockImplementationOnce(() => jsonResponse(envelope({ result: analysed([], 2) })))

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')
    expect(diagnostics.state.markers).toHaveLength(1)

    await diagnostics.ask('src/app.py')
    expect(diagnostics.state.status).toBe('analysed')
    expect(diagnostics.state.markers).toEqual([])
  })
})

describe('the memory keyed by path', () => {
  it('re-applies a held analysis without asking for it again', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope({ result: analysed([item()], 4) })))

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // A model swap dropped the marks; the buffer comes back on screen.
    diagnostics.reapply('src/app.py')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(diagnostics.state.items).toEqual([item()])
    expect(diagnostics.state.markers).toEqual(markersForDiagnostics([item()]))
    expect(diagnostics.state.analysing).toBe(false)
  })

  it('a path with nothing held re-applies nothing, so the bar can say analysing…', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(notAnalysedYet()))

    openRecord('src/app.py')
    const held = diagnostics.reapply('src/app.py')

    expect(held).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(diagnostics.state.status).toBe('unknown')
    // Never a verdict: an empty item list here would read as "clean".
    expect(diagnostics.state.items).toEqual([])
  })

  it('a buffer that leaves the strip takes its entry with it', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(envelope({ result: analysed([item()], 1) })),
    )

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')
    expect(diagnostics.analysisFor('src/app.py')).not.toBeNull()

    closeRecord('src/app.py')
    await nextTick()

    expect(diagnostics.analysisFor('src/app.py')).toBeNull()
    expect(diagnostics.reapply('src/app.py')).toBeNull()
  })

  // A diff tab is a record but not a buffer: it holds no analysis and cannot
  // keep one alive for a file that is no longer open.
  it('a diff tab does not keep an analysis alive', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(envelope({ result: analysed([item()], 1) })),
    )

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')
    closeRecord('src/app.py')
    openRecord('src/app.py', { kind: 'diff' })
    await nextTick()

    expect(diagnostics.analysisFor('src/app.py')).toBeNull()
  })

  it('a working-location switch empties the memory and drops an answer in flight', async () => {
    const answers = []
    const gate = new Promise((resolve) => {
      answers.push(resolve)
    })
    stubWorkspaceRoutes(() => gate)

    openRecord('src/app.py')
    const inFlight = diagnostics.ask('src/app.py')
    await tree.reRoot('/w/other')

    answers[0](jsonResponse(envelope({ result: analysed([item()], 1) })))
    const answer = await inFlight

    expect(answer).toBeNull()
    expect(diagnostics.analysisFor('src/app.py')).toBeNull()
    expect(diagnostics.state.items).toEqual([])
    expect(diagnostics.state.status).toBe('unknown')
  })

  it('a working-location switch forgets analyses it already held', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const key = String(url)
      if (key.startsWith('/api/lsp/query')) {
        return jsonResponse(envelope({ result: analysed([item()], 1) }))
      }
      return jsonResponse({ path: '', workspace: '/w/other', entries: [], truncated: false })
    })

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')
    expect(diagnostics.analysisFor('src/app.py')).not.toBeNull()

    await tree.reRoot('/w/other')

    expect(diagnostics.analysisFor('src/app.py')).toBeNull()
    expect(diagnostics.state.status).toBe('unknown')
    expect(diagnostics.state.markers).toEqual([])
  })
})

describe('every quiet answer stays quiet', () => {
  it('an unreachable API is unknown with a reason, and no notice', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('down')))

    openRecord('src/app.py')
    const answer = await diagnostics.ask('src/app.py')

    expect(answer.status).toBe('no_server')
    expect(diagnostics.state.reason).toContain('could not be reached')
    expect(diagnostics.state.status).toBe('no_server')
    expect(notices.state.notices).toHaveLength(0)
  })

  it('a refused request is a sentence, not an error and not a notice', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse({ detail: 'path is not usable' }, false, 422),
    )

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')

    expect(diagnostics.state.reason).toBe('path is not usable')
    expect(diagnostics.state.status).toBe('no_server')
    expect(notices.state.notices).toHaveLength(0)
  })

  it('no server, switched off and errored are all quiet', async () => {
    const reasons = [
      'no active language server handles .md',
      'pyright is disabled in Settings',
      'pyright is error: the language server exited with code 1',
    ]
    for (const reason of reasons) {
      resetState()
      vi.restoreAllMocks()
      vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        jsonResponse(envelope({ status: 'no_server', server: null, reason })),
      )
      openRecord('src/app.py')
      await diagnostics.ask('src/app.py')
      expect(diagnostics.state.reason).toBe(reason)
      expect(notices.state.notices).toHaveLength(0)
    }
  })

  it('not analysed yet raises no notice either', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => jsonResponse(notAnalysedYet()))

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')

    expect(diagnostics.state.status).toBe('unknown')
    expect(notices.state.notices).toHaveLength(0)
  })

  // A refusal must not reach the pane as an error state a component could show:
  // the only fields are the three states, the items, the reason and `analysing`.
  it('exposes no error field at all', () => {
    expect(Object.keys(diagnostics.state).sort()).toEqual(
      ['analysing', 'items', 'markers', 'path', 'reason', 'status', 'suppressed', 'version'].sort(),
    )
  })
})

// ediag-08: the two readouts the bar renders. They add no counting rule —
// `counts` is `lib/monaco-lsp.js`'s one function over the accepted answer's
// items (D7), and `status`/`analysing` are §4's own rows, keyed by the buffer on
// screen so no field can describe the one just left.
describe('the readouts the bar shows', () => {
  it('counts the accepted answer\'s items with lib/monaco-lsp.js\'s one function', async () => {
    const items = [
      item({ severity: 'error' }),
      item({ severity: 'error', line: 1 }),
      item({ severity: 'warning', line: 2 }),
      item({ severity: 'hint', line: 3 }),
      item({ severity: 'info', line: 4 }),
    ]
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(envelope({ result: analysed(items) })),
    )

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')

    expect(diagnostics.counts.value).toEqual({ errors: 2, warnings: 1, total: 5 })
    // D7, both halves at once: the hints and the info are counted and not
    // underlined.
    expect(diagnostics.state.markers).toEqual(markersForDiagnostics(items))
    expect(diagnostics.state.markers).toHaveLength(3)
  })

  it('reports `analysed` with no items as a verdict, and `unknown` as no verdict', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() => jsonResponse(notAnalysedYet()))
      .mockImplementationOnce(() => jsonResponse(envelope({ result: analysed([], 2) })))

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')
    // The middle row of §4: no verdict, so the bar must show no counts.
    expect(diagnostics.status.value).toBe('unknown')
    expect(diagnostics.counts.value).toEqual({ errors: 0, warnings: 0, total: 0 })

    await diagnostics.ask('src/app.py')
    expect(diagnostics.status.value).toBe('analysed')
    expect(diagnostics.counts.value).toEqual({ errors: 0, warnings: 0, total: 0 })
  })

  it('reports `no_server` for a path nothing will analyse', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(
        envelope({ status: 'no_server', server: null, reason: 'no active language server handles .md' }),
      ),
    )

    openRecord('README.md')
    await diagnostics.ask('README.md')

    expect(diagnostics.status.value).toBe('no_server')
  })

  // §1.3: "It describes the buffer on screen … there is no 'last buffer'
  // residue." An answer about another path is not an answer about this one.
  it('reads nothing for a buffer the SHOWN answer does not describe', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(envelope({ result: analysed([item()]) })),
    )

    openRecord('src/app.py')
    await diagnostics.ask('src/app.py')
    expect(diagnostics.status.value).toBe('analysed')

    // Another buffer becomes the one on screen; nothing has asked about it yet.
    files.state.open.push({ ...files.state.open[0], key: 'src/other.py', path: 'src/other.py' })
    files.state.active = 'src/other.py'
    await nextTick()

    expect(diagnostics.shownOnScreen.value).toBe(false)
    expect(diagnostics.status.value).toBeNull()
    expect(diagnostics.counts.value).toEqual({ errors: 0, warnings: 0, total: 0 })
    expect(diagnostics.analysing.value).toBe(false)
  })

  it('reads `analysing` while an answer is awaited, and for a dropped answer', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => gate)

    openRecord('src/app.py')
    const pending = diagnostics.ask('src/app.py')
    expect(diagnostics.analysing.value).toBe(true)

    release(jsonResponse(envelope({ result: analysed([]) })))
    await pending
    expect(diagnostics.analysing.value).toBe(false)
  })
})
