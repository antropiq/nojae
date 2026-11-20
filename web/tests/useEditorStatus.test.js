import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import { NO_BUFFER_TEXT, useEditorStatus } from '../src/composables/useEditorStatus'
import { useChat } from '../src/composables/useChat'
import { useEditorFiles } from '../src/composables/useEditorFiles'
import { useEditorLsp } from '../src/composables/useEditorLsp'
import { useEditorNotices } from '../src/composables/useEditorNotices'
import { pointTabAt, withoutWorkspace } from './helpers/workspace-url'

// ---------------------------------------------------------------------------
// The status bar's server field (ediag-02).
//
// One question — *which language server answers for the buffer on screen?* — and
// the rules that make its answer trustworthy, from the spec's §1.3 and D8:
//
//   * the field never invents a state: a file no server claims says so in the
//     hub's own shortened sentence, and a server switched off, errored or
//     starting says why;
//   * there is no "last buffer" residue: the answer is keyed by the path it was
//     asked about and dropped the moment the buffer changes, and a late answer
//     for a buffer that is no longer on screen is dropped rather than painted;
//   * it is asked when the buffer on screen changes and never otherwise — no
//     polling, nothing per keystroke;
//   * every quiet answer stays quiet: no notice, on any path (§4);
//   * a diff tab, a preview tab and the empty pane say that no buffer applies;
//   * its own token keeps it clear of a `definition` read in flight, which is
//     why it does not travel `useEditorLsp.query()`.
//
// The transport is a stubbed `fetch`, as every web suite here is: no hub is
// reached and no real answer is assumed.
// ---------------------------------------------------------------------------

const status = useEditorStatus()
const files = useEditorFiles()
const chat = useChat()
const lsp = useEditorLsp()
const notices = useEditorNotices()

function jsonResponse(body, ok = true, status_ = 200) {
  return Promise.resolve({ ok, status: status_, json: () => Promise.resolve(body) })
}

// The wire envelope, exactly as `core/lsphub/manager.py` builds it.
function envelope({
  status: statusValue = 'ok',
  server = 'pyright',
  reason = null,
  action = 'status',
  result = null,
} = {}) {
  return { status: statusValue, server, reason, action, result }
}

// One open buffer of a given path and kind, without going through a route: this
// suite is about the field's rules, not about `useEditorFiles`' open path.
function openRecord(path, kind = 'file') {
  const record = {
    kind,
    key: kind === 'diff' ? `diff:${path}` : kind === 'preview' ? `preview:${path}` : path,
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    text: '',
    baseline: '',
    dirty: false,
    mtime: 1,
    language: 'python',
  }
  files.state.open.push(record)
  files.state.active = record.key
  return record
}

function resetState() {
  pointTabAt('/w')
  files.state.open.length = 0
  files.state.active = null
  files.state.message = null
  chat.state.lsp.servers = []
  chat.state.lsp.enabled = {}
  chat.state.lsp.loaded = false
  chat.state.lsp.locked = false
  chat.state.lsp.restarting = false
  lsp.clear()
  status.clear()
  notices.clear()
}

function statusBodies(fetchMock) {
  return fetchMock.mock.calls
    .filter(([url]) => withoutWorkspace(url) === '/api/lsp/query')
    .map(([, init]) => JSON.parse(init.body))
}

// Let the watcher's own read land: the switch is synchronous, the answer is a
// promise, and the field re-renders after it. Two ticks and a macrotask cover
// the chain the app really runs, so no test calls `ask` by hand to *simulate* a
// trigger the watcher already fires.
async function settle() {
  await nextTick()
  await Promise.resolve()
  await nextTick()
}

describe('the field names the server the hub names', () => {
  beforeEach(() => {
    resetState()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // Done when: opening a `.py` file the workspace's declared server claims makes
  // the field name that server. The name is the hub's id — one source.
  it('reads the status action and shows the answering server by id', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope({ server: 'pyright' })))

    openRecord('src/app.py')
    await settle()

    const [body] = statusBodies(fetchMock)
    expect(body.action).toBe('status')
    expect(body.path).toBe('src/app.py')
    // A status read carries no position and no text: nothing is being edited.
    expect(body).not.toHaveProperty('line')
    expect(body).not.toHaveProperty('text')
    expect(status.serverLabel.value).toBe('pyright')
  })

  // D8: one source of phrasing — the bar says what the Ctrl+click path would
  // say, shortened, and composes no second sentence of its own.
  it('shows the hub\'s own refusal sentence for a file no server claims', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(
        envelope({
          status: 'no_server',
          server: null,
          reason: 'no active language server handles .md',
        }),
      ),
    )

    openRecord('README.md')
    await settle()

    expect(status.serverLabel.value).toBe('no active language server handles .md')
  })

  // A switched-off or errored server is a *reason*, never a blank field (§1.3:
  // it never invents a state).
  it('shows the hub\'s reason for a server that is switched off or errored', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(
        envelope({
          status: 'no_server',
          server: null,
          reason: 'pyright is error: the language server exited with code 1',
        }),
      ),
    )

    openRecord('src/app.py')
    await settle()

    expect(status.serverLabel.value).toContain('pyright is error')
  })

  // The envelope is the route's, unchanged: the same allowlist the Tools panel
  // holds travels with it, so a server switched off there is not named here.
  it('sends the Tools panel\'s allowlist, and none when the snapshot failed', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope()))

    chat.state.lsp.loaded = true
    chat.state.lsp.enabled = { pyright: true, volar: false }
    openRecord('src/app.py')
    await settle()
    expect(statusBodies(fetchMock).at(-1).lspEnabled).toEqual(['pyright'])

    // A failed snapshot means "all activated servers", not "none": no filter
    // travels and the pane is not blinded.
    chat.state.lsp.loaded = false
    chat.state.lsp.enabled = { pyright: false }
    await status.ask('src/app.py')
    expect('lspEnabled' in statusBodies(fetchMock).at(-1)).toBe(false)
  })

  // The two gates that must not apply, asserted the way `useEditorLsp`'s suite
  // asserts them: a mode narrows the conversation, never the pane.
  it('carries no mode id and no batch flag', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope()))

    openRecord('src/app.py')
    await settle()

    const [body] = statusBodies(fetchMock)
    expect(body).not.toHaveProperty('batch')
    expect(body).not.toHaveProperty('batchActive')
    expect(body).not.toHaveProperty('mode')
  })
})

describe('there is no last-buffer residue', () => {
  beforeEach(() => {
    resetState()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('says so when there is no tab, a diff tab or a preview tab', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope()))
    await nextTick()
    expect(status.serverLabel.value).toBe(NO_BUFFER_TEXT)

    const diff = openRecord('src/app.py', 'diff')
    await nextTick()
    expect(status.serverLabel.value).toBe(NO_BUFFER_TEXT)
    // No buffer means no question: nothing was asked about a view.
    expect(statusBodies(fetchMock)).toHaveLength(0)

    files.state.open.splice(files.state.open.indexOf(diff), 1)
    openRecord('docs/notes.md', 'preview')
    await nextTick()
    expect(status.serverLabel.value).toBe(NO_BUFFER_TEXT)
    expect(statusBodies(fetchMock)).toHaveLength(0)
  })

  // Switching from a claimed buffer to an unclaimed one changes the field, and
  // the answer for the buffer just left is never shown against the new one.
  it('drops the previous buffer\'s answer the moment the buffer changes', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      const body = JSON.parse(init.body)
      if (body.path === 'src/app.py') return jsonResponse(envelope({ server: 'pyright' }))
      return jsonResponse(
        envelope({
          status: 'no_server',
          server: null,
          reason: 'no active language server handles .md',
        }),
      )
    })

    openRecord('src/app.py')
    await settle()
    expect(status.serverLabel.value).toBe('pyright')

    openRecord('README.md')
    // The switch is synchronous, so the old answer stops describing the field in
    // the same tick — before the new buffer's own answer can possibly land.
    expect(status.serverLabel.value).toBe('')
    expect(status.state.path).toBeNull()

    await settle()
    expect(status.serverLabel.value).toBe('no active language server handles .md')
  })

  // The token: a late answer for a buffer that is no longer on screen is dropped
  // rather than painted, so a stale name can never appear under a newer buffer.
  it('drops a late answer for a buffer that has since been replaced', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const never = new Promise(() => {})
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      const body = JSON.parse(init.body)
      // The buffer just left answers late; the one now on screen never answers,
      // so what the field ends up holding is decided by the guard alone.
      return body.path === 'src/app.py' ? gate : never
    })

    openRecord('src/app.py')
    const inFlight = status.ask('src/app.py')
    openRecord('README.md')
    await nextTick()
    release(jsonResponse(envelope({ server: 'pyright' })))
    const answer = await inFlight
    await nextTick()

    expect(answer).toBeNull()
    expect(status.state.path).toBeNull()
    expect(status.serverLabel.value).toBe('')
  })

  // The point of a second token: a status read must not disturb a `definition`
  // read in flight, and vice versa — `useEditorLsp`'s answer is untouched.
  it('does not disturb a definition read in flight', async () => {
    const answers = {
      definition: envelope({ action: 'definition', result: { path: 'a.py', line: 9, character: 0 } }),
      status: envelope({ server: 'pyright' }),
    }
    let releaseDefinition
    const definitionGate = new Promise((resolve) => {
      releaseDefinition = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      const body = JSON.parse(init.body)
      if (body.action === 'definition') return definitionGate
      return jsonResponse(answers.status)
    })

    const definition = lsp.query({ action: 'definition', path: 'a.py', line: 0, character: 0 })
    openRecord('src/app.py')
    await settle()
    releaseDefinition(jsonResponse(answers.definition))
    const answer = await definition
    await nextTick()

    expect(answer.action).toBe('definition')
    expect(lsp.state.answer).toEqual(answers.definition)
    expect(status.serverLabel.value).toBe('pyright')
  })
})

describe('it is asked when the buffer changes, and never otherwise', () => {
  beforeEach(() => {
    resetState()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('asks once per buffer switch, and never per keystroke', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope()))
    await nextTick()

    openRecord('src/app.py')
    await nextTick()
    await nextTick()
    expect(statusBodies(fetchMock)).toHaveLength(1)

    // Typing does not change which server answers a path: nothing to re-ask.
    files.updateText('src/app.py', 'x = 1\n')
    files.updateText('src/app.py', 'x = 1\ny = 2\n')
    await nextTick()
    expect(statusBodies(fetchMock)).toHaveLength(1)

    openRecord('src/other.py')
    await nextTick()
    await nextTick()
    expect(statusBodies(fetchMock)).toHaveLength(2)
  })

  it('asks nothing while no buffer is on screen', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope()))
    await nextTick()

    files.state.active = null
    await nextTick()

    expect(statusBodies(fetchMock)).toHaveLength(0)
  })

  // The trigger belongs to the singleton, not to a component's effect scope: a
  // bar that has been unmounted (the Editor tab is a lazy chunk that mounts and
  // unmounts) must not stop the field answering, and a second reader must not
  // arm a second watcher.
  it('keeps answering, once, after a reader mounts and unmounts', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope()))
    await settle()

    const first = useEditorStatus()
    const second = useEditorStatus()
    expect(first.serverLabel).toBe(second.serverLabel)
    await settle()

    openRecord('src/app.py')
    await settle()
    expect(statusBodies(fetchMock)).toHaveLength(1)
    expect(first.serverLabel.value).toBe('pyright')
  })
})

describe('every quiet answer stays quiet', () => {
  beforeEach(() => {
    resetState()
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  it('an unreachable API is a sentence in the field and no notice', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('down')))

    openRecord('src/app.py')
    await settle()

    expect(status.serverLabel.value).toContain('could not be reached')
    expect(notices.state.notices).toHaveLength(0)
  })

  it('a refused request is a sentence in the field and no notice', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse({ detail: 'the language-server hub is not available' }, false, 503),
    )

    openRecord('src/app.py')
    await settle()

    expect(status.serverLabel.value).toBe('the language-server hub is not available')
    expect(notices.state.notices).toHaveLength(0)
  })

  // The hub disabled — the hermetic-test shape — is the route's own quiet
  // envelope, and it reads as one short clause, never as an error.
  it('a hub that is not there is a sentence and no notice', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(
        envelope({
          status: 'no_server',
          server: null,
          reason: 'the language-server hub is not available',
        }),
      ),
    )

    openRecord('src/app.py')
    await settle()

    expect(status.serverLabel.value).toBe('the language-server hub is not available')
    expect(notices.state.notices).toHaveLength(0)
  })
})
