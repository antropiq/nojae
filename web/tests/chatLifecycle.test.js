import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import WorkBenchInput from '../src/components/WorkBenchInput.vue'
import {
  conversationJson,
  conversationMarkdown,
  useChat,
} from '../src/composables/useChat'
import { loadAgentModes, useAgentModes } from '../src/composables/useAgentModes'
import { useBatch } from '../src/composables/useBatch'
import { registerReRootHandler, useWorkspaceTree } from '../src/composables/useWorkspaceTree'
import { clearTabWorkspace } from './helpers/workspace-url'

// ---------------------------------------------------------------------------
// The strip's lifecycle: the five gestures that already reached the
// conversation now reach the staged messages too — and they do not all do the
// same thing.
//
// The rule behind all five: the strip is the user's *uncommitted* input. So the
// one gesture that wipes everything (Restart, and batch mode's between-task
// wipe) wipes it, the ones that end a turn in flight (Stop, Pause and Pause's
// local fallback) leave it byte-identical, a loaded session replaces the
// conversation and takes the strip with it, and a moved folder drops it
// **reported** rather than silently. The copy-as-markdown output never sees a
// staged row and shows a flushed group as consecutive sections, which is the
// honest rendering of what was sent.
// ---------------------------------------------------------------------------

const chat = useChat().state
const batch = useBatch().state
const agentModes = useAgentModes().state
const tree = useWorkspaceTree()

const OLD_ROOT = '/w/oldproj'
const NEW_ROOT = '/w/newproj'

const PROBE_KEY = 'lifecycleProbe'

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

function agentsBody() {
  return {
    agents: [
      {
        id: 'code',
        label: 'Code',
        mcpEnable: true,
        lspEnable: true,
        readonly: false,
        deletable: false,
        maxToolIteration: 25,
        systemMessage: '',
        modelId: 1,
        modelName: 'model-1',
      },
    ],
    caps: { minToolIteration: 1, maxIdChars: 32 },
    findings: [],
  }
}

function sseBody(text) {
  const bytes = new TextEncoder().encode(text)
  let delivered = false
  return {
    getReader() {
      return {
        async read() {
          if (delivered) return { done: true, value: undefined }
          delivered = true
          return { done: false, value: bytes }
        },
      }
    },
  }
}

const DONE = 'event: done\ndata: {"tokens":12,"took":1.5,"ttft":0.4,"decode":1.1}\n\n'
const PAUSE_ACK = 'event: pause_ack\ndata: {"paused":true}\n\n'

// A reply that never ends on its own: the turn in flight a Stop or a Pause is
// called against. It honours the abort signal the way a real fetch does.
function hangUntilAborted(init) {
  return new Promise((resolve, reject) => {
    const signal = init?.signal
    if (!signal) return
    signal.addEventListener('abort', () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })
}

// A reply whose single frame (a `pause_ack`) is delivered when the case says so
// — that is what a server-side Pause looks like from here.
function gatedStream(frame = PAUSE_ACK) {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  let delivered = false
  return {
    release: () => release(),
    body: {
      getReader: () => ({
        async read() {
          if (delivered) return { done: true, value: undefined }
          await gate
          delivered = true
          return { done: false, value: new TextEncoder().encode(frame) }
        },
      }),
    },
  }
}

function image(name, byte = 0) {
  return { dataUrl: `data:image/png;base64,AAAA${byte}`, name, size: 4 }
}

function resetAll() {
  clearTabWorkspace()
  chat.phase = 'idle'
  chat.messages = []
  chat.error = null
  chat.pausePending = false
  chat.session.startedAt = 0
  chat.session.spentMs = 0
  chat.session.agentMode = null
  chat.staged = []
  chat.pendingImages = []
  chat.draft = { raw: '', html: '', renderedRaw: '' }
  chat.mcp = { connectors: [], enabled: {}, loaded: false, locked: false, restarting: false }
  chat.lsp = { servers: [], enabled: {}, loaded: false, locked: false, restarting: false }
  batch.active = false
  batch.status = 'idle'
  agentModes.modes = []
  agentModes.current = null
  agentModes.loaded = false
  agentModes.findings = []
  agentModes.notice = null
  tree.state.nodes = {}
  tree.state.expanded = { '': true }
  tree.state.selected = null
  tree.state.error = null
  tree.state.workspace = ''
  window.sessionStorage.clear()
  window.localStorage.clear()
}

// One staged row through the composable's own verb: the row under test is the
// row the browser would hold, rendered by the path a send takes.
function stage(text, images = []) {
  chat.draft = { raw: text, html: '', renderedRaw: '' }
  chat.pendingImages = images.map((entry) => ({ ...entry }))
  expect(useChat().stage()).toBe(true)
}

// What the strip holds, down to its rows' identity and their images: the
// assertion Stop and Pause owe is that this is *byte-identical* afterwards.
function stripSnapshot() {
  return JSON.stringify(
    chat.staged.map((row) => ({
      id: row.id,
      raw: row.raw,
      html: row.html,
      images: row.images,
    })),
  )
}

// The chat route plus the agents route every composer path reads. `onChat` says
// what the one posted reply does.
function stubRoutes({ onChat = () => ({ ok: true, body: sseBody(DONE) }) } = {}) {
  const calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const key = String(url)
    calls.push({ key, method: init?.method ?? 'GET' })
    if (key.startsWith('/api/chat/pause')) return jsonResponse({ paused: 'requested' })
    if (key.startsWith('/api/chat')) return onChat(init)
    if (key === '/api/agents') return jsonResponse(agentsBody())
    if (key.startsWith('/api/fs/tree')) {
      return jsonResponse({ path: '', workspace: NEW_ROOT, entries: [], truncated: false })
    }
    if (key.startsWith('/api/fs/status')) return jsonResponse({ repo: false, entries: [] })
    return jsonResponse({}, false, 404)
  })
  return calls
}

beforeEach(() => {
  resetAll()
})

afterEach(() => {
  vi.restoreAllMocks()
  // A probe left registered would run in every suite that follows.
  registerReRootHandler(PROBE_KEY, null)
  resetAll()
})

describe('Restart clears the strip with the conversation', () => {
  it('wipes both, from the composer\'s own gesture', async () => {
    stubRoutes()
    await loadAgentModes()
    chat.messages = [
      { role: 'user', raw: 'already asked', html: '<p>already asked</p>', streaming: false },
    ]
    stage('a thought not sent yet', [image('a.png', 1)])
    const host = document.createElement('div')
    document.body.appendChild(host)
    const w = mount(WorkBenchInput, { attachTo: host })
    await flushPromises()

    await w.find('[aria-label="Restart conversation"]').trigger('click')
    await flushPromises()

    expect(chat.messages).toEqual([])
    // A queue that outlived the thread would be the only survivor of a
    // conversation nobody can see any more.
    expect(chat.staged).toEqual([])
    expect(chat.draft.raw).toBe('')
    expect(chat.pendingImages).toEqual([])
    // Deliberate and silent: Restart already means wipe, so a discarded row
    // needs no sentence the user has to read.
    expect(chat.error).toBeNull()

    w.unmount()
    host.remove()
  })

  it('wipes both on batch mode\'s between-task route too', () => {
    stage('one')
    stage('two')
    chat.messages = [
      { role: 'user', raw: 'task one', html: '<p>task one</p>', streaming: false },
    ]
    const calls = stubRoutes()

    // `refetchHubs: false` is the same function as Restart's, and both mean
    // "this conversation is gone".
    useChat().reset({ refetchHubs: false })

    expect(chat.messages).toEqual([])
    expect(chat.staged).toEqual([])
    // The wipe refetches nothing, exactly as before.
    expect(calls).toEqual([])
  })
})

describe('Stop and Pause leave the strip untouched', () => {
  // The one window in which a reply streams while rows are staged: a lot's turn.
  // A flush empties the strip, and staging is refused while a reply streams, so
  // a launch with rows already staged is how that window is reached — and it is
  // the one an over-eager `phase` reset would silently eat. The three end-of-turn
  // paths below are the composable's own (Stop's abort, Pause's ack and Pause's
  // local abort), which is what the assertion is about: whatever reaches them,
  // none may touch the composer's staged rows.
  function stageRows() {
    stage('kept one', [image('a.png', 1)])
    stage('kept two')
    stage('kept three', [image('b.png', 2), image('c.png', 3)])
  }

  async function startLotTurn() {
    await loadAgentModes()
    expect(
      useChat().sendBatchTurn('one task', { agentMode: 'code', workspace: '/w/task-folder' }),
    ).toBe(true)
    await vi.waitFor(() => expect(chat.phase).toBe('waiting'))
  }

  it('Stop ends the turn and leaves every row, in order, with its images', async () => {
    stubRoutes({ onChat: (init) => hangUntilAborted(init) })
    stageRows()
    const before = stripSnapshot()
    await startLotTurn()

    useChat().stop()
    await vi.waitFor(() => expect(chat.phase).toBe('idle'))
    await flushPromises()

    expect(chat.staged).toHaveLength(3)
    expect(stripSnapshot()).toBe(before)
    expect(chat.staged.map((row) => row.raw)).toEqual(['kept one', 'kept two', 'kept three'])
  })

  it('Pause, ending on its own ack, leaves every row', async () => {
    const stream = gatedStream()
    stubRoutes({ onChat: () => ({ ok: true, body: stream.body }) })
    stageRows()
    const before = stripSnapshot()
    await startLotTurn()

    await useChat().pause()
    expect(chat.pausePending).toBe(true)
    stream.release()
    await vi.waitFor(() => expect(chat.phase).toBe('idle'))
    await flushPromises()

    expect(chat.pausePending).toBe(false)
    expect(stripSnapshot()).toBe(before)
  })

  it('Pause\'s local fallback leaves every row', async () => {
    stubRoutes({ onChat: (init) => hangUntilAborted(init) })
    // The pause route unreachable: the composable aborts locally instead, and
    // that abort is the second end-of-turn path that must not touch the strip.
    const fallback = globalThis.fetch.getMockImplementation()
    globalThis.fetch.mockImplementation((url, init) => {
      if (String(url).startsWith('/api/chat/pause')) {
        return Promise.reject(new TypeError('Failed to fetch'))
      }
      return fallback(url, init)
    })
    stageRows()
    const before = stripSnapshot()
    await startLotTurn()

    await useChat().pause()
    await vi.waitFor(() => expect(chat.phase).toBe('idle'))
    await flushPromises()

    expect(chat.pausePending).toBe(false)
    expect(stripSnapshot()).toBe(before)
  })
})

describe('a loaded session replaces the conversation and empties the strip', () => {
  it('drops every staged row when a file is loaded', () => {
    stage('staged before the load')
    stage('also staged', [image('a.png', 1)])

    const loaded = useChat().loadSession({
      messages: [{ role: 'user', content: 'restored turn' }],
      agentMode: null,
    })

    expect(loaded.restored).toBe(1)
    expect(chat.messages.map((message) => message.raw)).toEqual(['restored turn'])
    // The strip belonged to the conversation the file replaced.
    expect(chat.staged).toEqual([])
  })

  it('never writes a staged message into a saved session', () => {
    chat.messages = [
      { role: 'user', raw: 'a turn the model saw', html: '<p>a turn the model saw</p>', streaming: false },
    ]
    stage('typed but never sent')

    const doc = conversationJson(chat.messages)

    expect(doc.messages).toHaveLength(1)
    expect(JSON.stringify(doc)).not.toContain('typed but never sent')
  })
})

describe('moving the tab\'s folder invalidates the strip, reported', () => {
  it('empties it and names what was lost on the chat error line', async () => {
    stubRoutes()
    tree.state.workspace = OLD_ROOT
    stage('mockup brief one', [image('a.png', 1)])
    stage('mockup brief two')
    chat.error = null

    await tree.reRoot(NEW_ROOT)

    expect(chat.staged).toEqual([])
    // One sentence, on the line that already carries a refusal above the
    // composer — where the strip was, and where the WorkBench tab can see it.
    expect(chat.error).toContain('2 staged messages')
    expect(chat.error).toContain(NEW_ROOT)
  })

  it('names one lost row in the singular', async () => {
    stubRoutes()
    stage('the only one')
    chat.error = null

    await tree.reRoot(NEW_ROOT)

    expect(chat.staged).toEqual([])
    expect(chat.error).toContain('1 staged message')
    expect(chat.error).not.toContain('1 staged messages')
  })

  it('says nothing at all when there was nothing to lose', async () => {
    stubRoutes()
    chat.error = null

    await tree.reRoot(NEW_ROOT)

    expect(chat.staged).toEqual([])
    expect(chat.error).toBeNull()
  })

  it('reports for itself even when an earlier holder throws', async () => {
    stubRoutes()
    stage('still reported')
    chat.error = null
    // Registered ahead of the strip's own holder, so the ordering the registry's
    // isolation property is about is the one under test here: the failing holder
    // runs first, and the strip's must still run.
    registerReRootHandler(PROBE_KEY, () => {
      throw new Error('probe exploded')
    })
    registerReRootHandler('chatStrip', null)
    useChat()

    await tree.reRoot(NEW_ROOT)

    // A sibling failing is its own bug, never a silent drop of the strip's own
    // report.
    expect(chat.staged).toEqual([])
    expect(chat.error).toContain('1 staged message')
  })

  it('reaches no Editor file composable and invents no second channel', () => {
    const source = readFileSync(resolve('src/composables/useChat.js'), 'utf8')
    // The strip is forgotten through the registry, which is the one-way seam:
    // this module never imports the Editor's buffers, and it reports on the chat
    // error line rather than adding a notification mechanism of its own.
    expect(source).not.toContain("from './useEditorFiles'")
    expect(source).not.toContain("from './useEditorNotices'")
    expect(source).toContain("registerReRootHandler('chatStrip'")
    expect(source).toContain('state.error =')
  })

  it('is registered once per module load, not once per call', async () => {
    stubRoutes()
    // The factory body re-runs on every call and registers the same key again;
    // the registry replaces that entry rather than appending a second copy, so
    // one switch reaches the strip once and reports it once.
    useChat()
    useChat()
    stage('one')
    chat.error = null

    await tree.reRoot(NEW_ROOT)

    expect(chat.staged).toEqual([])
    expect(chat.error.match(/Working location switched/g)).toHaveLength(1)
  })
})

describe('copy-as-markdown renders the thread alone', () => {
  it('carries no section for a staged message', () => {
    chat.messages = [
      { role: 'user', raw: 'what the model saw', html: '', streaming: false },
      { role: 'assistant', raw: 'the answer', html: '', streaming: false },
    ]
    stage('staged and unsent')

    const copy = conversationMarkdown(chat.messages)

    expect(copy).toBe('## user\n\nwhat the model saw\n\n## assistant\n\nthe answer')
    expect(copy).not.toContain('staged and unsent')
  })

  it('shows a flushed group as consecutive user sections, in flush order', async () => {
    // A reply with text, so the group is visible as a run of sections rather
    // than as three headings with an empty bubble after them.
    stubRoutes({
      onChat: () => ({
        ok: true,
        body: sseBody('event: token\ndata: {"text":"on it"}\n\n' + DONE),
      }),
    })
    await loadAgentModes()
    stage('first brief')
    stage('second brief')
    chat.draft.raw = 'and the draft'

    await useChat().send()
    await flushPromises()

    const copy = conversationMarkdown(chat.messages)
    const sections = copy.split('\n\n').filter((part) => part.startsWith('## '))
    expect(sections).toEqual(['## user', '## user', '## user', '## assistant'])
    // Consecutive, in flush order: the honest rendering of what was sent.
    expect(copy.startsWith('## user\n\nfirst brief\n\n## user\n\nsecond brief')).toBe(true)
    expect(copy).toContain('## user\n\nand the draft')
  })
})
