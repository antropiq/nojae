import { beforeEach, describe, expect, it, vi } from 'vitest'

import { STARTING_RETRY_DELAY_MS, useEditorLsp } from '../src/composables/useEditorLsp'
import { useAgentModes } from '../src/composables/useAgentModes'
import { useBatch } from '../src/composables/useBatch'
import { useChat } from '../src/composables/useChat'
import { useEditorNotices } from '../src/composables/useEditorNotices'
import { useWorkspaceTree } from '../src/composables/useWorkspaceTree'

// ---------------------------------------------------------------------------
// The stateful half of the Editor pane's language-server feature.
//
// The rules this suite exists for are the spec's §4.3, §4.6, §4.10 and §4.13:
// one request per gesture; a `starting` answer retried exactly once and never
// looped; a `server: null` answer raising no notice (the feature degrades to the
// status quo, never to an error); a working-location switch dropping the state
// *and* an answer still in flight; and the allowlist read from the Tools panel's
// own switches rather than owned here.
//
// The server's own rules (which server claims a file, the policy, the cold-start
// status) belong to tests/test_lsp_editor.py; here the transport is a stubbed
// `fetch` and the payload is the wire envelope verbatim.
// ---------------------------------------------------------------------------

const lsp = useEditorLsp()
const chat = useChat()
const notices = useEditorNotices()
const tree = useWorkspaceTree()

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

// The wire envelope, exactly as `core/lsphub/editor.py` builds it.
function envelope({
  status = 'ok',
  server = 'pyright',
  reason = null,
  action = 'definition',
  result = null,
} = {}) {
  return { status, server, reason, action, result }
}

function resetLsp() {
  lsp.clear()
}

// `useChat`'s LSP slice is the Tools panel's state, so one test's switches must
// not leak into the next: the same reset the other suites do for their
// singletons.
function resetChatLsp() {
  chat.state.lsp.servers = []
  chat.state.lsp.enabled = {}
  chat.state.lsp.loaded = false
  chat.state.lsp.locked = false
  chat.state.lsp.restarting = false
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
// root. Nothing else is asked.
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
    return jsonResponse({})
  })
}

function sentBody(fetchMock, index = 0) {
  return JSON.parse(fetchMock.mock.calls[index][1].body)
}

describe('query: one request per gesture', () => {
  beforeEach(() => {
    resetLsp()
    resetChatLsp()
    resetTree()
    notices.clear()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('posts one body to the query route and stores the answer', async () => {
    const answer = envelope({
      result: { path: 'src/app.py', line: 4, character: 2 },
    })
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(answer))

    const got = await lsp.query({ action: 'definition', path: 'src/app.py', line: 3, character: 1 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/lsp/query')
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
    expect(got).toEqual(answer)
    expect(lsp.state.answer).toEqual(answer)
  })

  // The body is the wire contract: the position is already 0-based (the `-1`
  // happened in `lib/monaco-lsp.js`), and the buffer's text travels only when
  // the caller says the buffer is dirty (§4.5, §4.8).
  it('sends the position as given and the text only when the buffer is dirty', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope()))

    await lsp.query({ action: 'hover', path: 'src/app.py', line: 7, character: 3 })
    expect(sentBody(fetchMock)).toEqual({
      action: 'hover',
      path: 'src/app.py',
      line: 7,
      character: 3,
    })

    await lsp.query({ action: 'hover', path: 'src/app.py', line: 7, character: 3, text: 'x = 1\n' })
    expect(sentBody(fetchMock, 1).text).toBe('x = 1\n')
  })

  it('an unreachable API is a quiet answer, not a throw', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('down')))

    const answer = await lsp.query({ action: 'definition', path: 'a.py', line: 0, character: 0 })

    expect(answer.status).toBe('no_server')
    expect(answer.server).toBeNull()
    expect(answer.reason).toContain('could not be reached')
    expect(notices.state.notices).toHaveLength(0)
  })
})

describe('the starting retry: exactly once, then stop', () => {
  beforeEach(() => {
    resetLsp()
    resetChatLsp()
    resetTree()
    notices.clear()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('retries a starting answer once, and the second attempt is what lands', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementationOnce(() =>
        jsonResponse(envelope({ status: 'starting', reason: 'pyright is starting' })),
      )
      .mockImplementationOnce(() =>
        jsonResponse(envelope({ result: { path: 'a.py', line: 1, character: 0 } })),
      )

    const pending = lsp.query({ action: 'definition', path: 'a.py', line: 0, character: 0 })
    await vi.advanceTimersByTimeAsync(STARTING_RETRY_DELAY_MS)
    const answer = await pending

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(answer.status).toBe('ok')
    expect(lsp.state.answer.status).toBe('ok')
    vi.useRealTimers()
  })

  it('a second starting answer stops — no third request', async () => {
    vi.useFakeTimers()
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        jsonResponse(envelope({ status: 'starting', reason: 'pyright is starting' })),
      )

    const pending = lsp.query({ action: 'definition', path: 'a.py', line: 0, character: 0 })
    await vi.advanceTimersByTimeAsync(STARTING_RETRY_DELAY_MS * 10)
    const answer = await pending

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(answer.status).toBe('starting')
    vi.useRealTimers()
  })

  it('a no_server answer is never retried', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        jsonResponse(envelope({ status: 'no_server', server: null, reason: 'no server' })),
      )

    await lsp.query({ action: 'definition', path: 'README.md', line: 0, character: 0 })

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // The status line may honestly say "starting", so asking for it is not a
  // gesture to retry — the caption shows the answer as it is.
  it('a status query is never retried', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        jsonResponse(
          envelope({ status: 'starting', action: 'status', reason: 'pyright is starting' }),
        ),
      )

    await lsp.statusFor('a.py')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(lsp.state.statusLine).toContain('starting')
  })
})

describe('no server is a quiet answer', () => {
  beforeEach(() => {
    resetLsp()
    resetChatLsp()
    resetTree()
    notices.clear()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // §4.10: a toast on every Ctrl+click in a Markdown file would be worse than
  // the feature is good. The reason goes to the status line, and nowhere else.
  it('a server: null answer raises no notice and stores the reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(
        envelope({
          status: 'no_server',
          server: null,
          reason: 'no active language server handles .md',
        }),
      ),
    )

    const answer = await lsp.query({
      action: 'definition',
      path: 'README.md',
      line: 0,
      character: 0,
    })

    expect(answer.status).toBe('no_server')
    expect(answer.server).toBeNull()
    expect(notices.state.notices).toHaveLength(0)
    expect(lsp.state.statusLine).toContain('no active language server handles .md')
  })

  it('a policy refusal is the same quiet shape, with the policy sentence', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(envelope({ status: 'no_server', server: null, reason: 'a.py is read-only' })),
    )

    await lsp.query({ action: 'definition', path: 'a.py', line: 0, character: 0 })

    expect(notices.state.notices).toHaveLength(0)
    expect(lsp.state.statusLine).toContain('a.py is read-only')
  })
})

describe('statusFor: the pane\'s caption', () => {
  beforeEach(() => {
    resetLsp()
    resetChatLsp()
    resetTree()
    notices.clear()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('names the serving server', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope({ action: 'status', server: 'pyright' })))

    await lsp.statusFor('src/app.py')

    expect(sentBody(fetchMock)).toEqual({ action: 'status', path: 'src/app.py' })
    expect(lsp.state.statusLine).toBe('Served by pyright')
  })

  it('says so quietly when no server claims the file', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(
        envelope({
          action: 'status',
          status: 'no_server',
          server: null,
          reason: 'no server handles .md',
        }),
      ),
    )

    await lsp.statusFor('README.md')

    expect(lsp.state.statusLine).toContain('No language server serves this file')
    expect(lsp.state.statusLine).toContain('no server handles .md')
    expect(notices.state.notices).toHaveLength(0)
  })

  it('an empty path clears the caption rather than asking', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    lsp.state.statusLine = 'Served by pyright'

    await lsp.statusFor('')

    expect(fetchMock).not.toHaveBeenCalled()
    expect(lsp.state.statusLine).toBe('')
  })

  // A buffer switch is the ordinary case: the previous file's status answer is
  // still in flight when the next one is asked, and it must not paint over the
  // newer caption.
  it('an answer for the buffer that was just left is dropped', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    let calls = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      calls += 1
      return calls === 1
        ? gate
        : jsonResponse(envelope({ action: 'status', server: 'volar' }))
    })

    const stale = lsp.statusFor('old.vue')
    await lsp.statusFor('new.vue')
    release(jsonResponse(envelope({ action: 'status', server: 'pyright' })))
    const dropped = await stale

    expect(dropped).toBeNull()
    expect(lsp.state.statusLine).toBe('Served by volar')
  })
})

describe('a working-location switch clears the editor\'s LSP state', () => {
  beforeEach(() => {
    resetLsp()
    resetChatLsp()
    resetTree()
    notices.clear()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('drops the last answer and the status line', async () => {
    stubWorkspaceRoutes()
    lsp.state.answer = envelope()
    lsp.state.statusLine = 'Served by pyright'

    await tree.reRoot('/w/other')

    expect(lsp.state.answer).toBeNull()
    expect(lsp.state.statusLine).toBe('')
  })

  it('an answer that lands after the switch is dropped', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const key = String(url)
      if (key.startsWith('/api/lsp/query')) return gate
      if (key.startsWith('/api/fs/tree')) {
        return jsonResponse({
          path: '',
          workspace: '/w/other',
          entries: [{ name: 'src', path: 'src', dir: true, children: true }],
          truncated: false,
        })
      }
      return jsonResponse({})
    })

    const inFlight = lsp.query({ action: 'definition', path: 'a.py', line: 0, character: 0 })
    await tree.reRoot('/w/other')
    release(jsonResponse(envelope({ result: { path: 'a.py', line: 9, character: 0 } })))
    const answer = await inFlight

    expect(answer).toBeNull()
    expect(lsp.state.answer).toBeNull()
    expect(lsp.state.statusLine).toBe('')
  })
})

describe('the allowlist: read from the Tools panel, never owned', () => {
  beforeEach(() => {
    resetLsp()
    resetChatLsp()
    resetTree()
    notices.clear()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('sends the ids whose switch is on', async () => {
    chat.state.lsp.loaded = true
    chat.state.lsp.enabled = { pyright: true, volar: false, tsserver: true }
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope()))

    await lsp.query({ action: 'definition', path: 'a.py', line: 0, character: 0 })

    expect(sentBody(fetchMock).lspEnabled).toEqual(['pyright', 'tsserver'])
  })

  // §4.3: a failed snapshot means "all activated servers", not "none". The
  // panel is hidden, so no filter travels and the pane is not blinded.
  it('sends no filter at all when the snapshot failed', async () => {
    chat.state.lsp.loaded = false
    chat.state.lsp.enabled = { pyright: false }
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope()))

    await lsp.query({ action: 'definition', path: 'a.py', line: 0, character: 0 })

    expect('lspEnabled' in sentBody(fetchMock)).toBe(false)
  })

  // §10.2: the Editor freezes with the conversation. `useChat` has already
  // frozen `enabled`, so the frozen set is what travels — nothing here reads
  // `locked` or tries to unfreeze anything.
  it('a locked conversation\'s frozen set is what travels', async () => {
    chat.state.lsp.loaded = true
    chat.state.lsp.locked = true
    chat.state.lsp.enabled = { pyright: true, volar: false }
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope()))

    await lsp.query({ action: 'definition', path: 'a.py', line: 0, character: 0 })

    expect(sentBody(fetchMock).lspEnabled).toEqual(['pyright'])
    // Reading the switches is not a write to them.
    expect(chat.state.lsp.enabled).toEqual({ pyright: true, volar: false })
    expect(chat.state.lsp.locked).toBe(true)
  })

  it('the status query carries the same allowlist', async () => {
    chat.state.lsp.loaded = true
    chat.state.lsp.enabled = { pyright: true, volar: false }
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope({ action: 'status' })))

    await lsp.statusFor('a.py')

    expect(sentBody(fetchMock).lspEnabled).toEqual(['pyright'])
  })
})

// §4.3: two gates deliberately do not apply, and both are browser state — so
// this is where they are proved. A mode narrows the conversation, never the
// pane; a running lot disables the switches, not reading code. Neither may
// reach the query, and the body carries no field for either.
describe('the two gates that must not apply', () => {
  beforeEach(() => {
    resetLsp()
    resetChatLsp()
    resetTree()
    notices.clear()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('a running lot does not stop a query, and no batch flag travels', async () => {
    const batch = useBatch()
    batch.state.active = true
    chat.state.lsp.loaded = true
    chat.state.lsp.enabled = { pyright: true }
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope()))

    const answer = await lsp.query({ action: 'definition', path: 'a.py', line: 0, character: 0 })

    expect(answer.status).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const body = sentBody(fetchMock)
    expect(body).not.toHaveProperty('batch')
    expect(body).not.toHaveProperty('batchActive')
    batch.state.active = false
  })

  it('a mode with lsptools false does not stop a query, and no mode id travels', async () => {
    const modes = useAgentModes()
    modes.state.modes = [{ id: 'chat', label: 'Chat', mcptools: false, lsptools: false }]
    modes.state.selected = 'chat'
    chat.state.lsp.loaded = true
    chat.state.lsp.enabled = { pyright: true }
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope()))

    const answer = await lsp.query({ action: 'definition', path: 'a.py', line: 0, character: 0 })

    expect(answer.status).toBe('ok')
    const body = sentBody(fetchMock)
    expect(body).not.toHaveProperty('agentMode')
    expect(body).not.toHaveProperty('mode')
    // The switches' *values* are what the pane reads, and the mode did not
    // change them — the panel shows them inert, it does not clear them.
    expect(body.lspEnabled).toEqual(['pyright'])
  })
})
