import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import WorkBenchInput from '../src/components/WorkBenchInput.vue'
import { flushGateReason, useChat } from '../src/composables/useChat'
import {
  loadAgentModes,
  setAgentMode,
  useAgentModes,
} from '../src/composables/useAgentModes'
import { useBatch } from '../src/composables/useBatch'
import { clearTabWorkspace, pointTabAt, workspaceOf } from './helpers/workspace-url'

// ---------------------------------------------------------------------------
// The flush: N user turns, one turn.
//
// Every staged message, then the draft if it has content, become consecutive
// user turns of **one** request — one agent, one workspace, one clock span.
// The cases here assert the payload and the thread together, because "the
// thread the user sees is the thread the model gets" is the property the whole
// design leans on; then the two orderings that are easy to get wrong: the gates
// run before anything moves, and one message the server would refuse stops the
// entire flush rather than letting it discard the good rows.
//
// Nothing here stages from the browser: `stage()` is the composable's verb, and
// the chord and the button that reach it are a separate change.
// ---------------------------------------------------------------------------

const chat = useChat().state
const batch = useBatch().state
const agentModes = useAgentModes().state

// A chat-template control token, built from its characters so this file never
// carries a complete run of its own.
const PIPE = '|'
const run = (name) => `<${PIPE}${name}${PIPE}>`

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

function agentsBody({ model = 1 } = {}) {
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
        modelId: model,
        modelName: model === null ? null : `model-${model}`,
      },
    ],
    caps: { minToolIteration: 1, maxIdChars: 32 },
    findings: [],
  }
}

// One accepted reply: the SSE frame that closes it, so `startTurn` sets the two
// hub locks the way only an accepted request does.
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

// Records every chat request body, in order. `/api/chat` answers an accepted
// stream, so the case can tell an accepted flush from a refused one by what the
// turn did to the hub locks as well as by what it posted.
function stubRoutes({ agents = agentsBody() } = {}) {
  const posts = []
  const calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const key = String(url)
    calls.push({ key, method: init?.method ?? 'GET' })
    if (key.startsWith('/api/chat')) {
      posts.push(JSON.parse(init?.body ?? '{}'))
      return { ok: true, body: sseBody(DONE) }
    }
    if (key === '/api/agents') return jsonResponse(agents)
    return jsonResponse({}, false, 404)
  })
  return { posts, calls }
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
  window.sessionStorage.clear()
}

// Stages one draft through the composable's own verb: type it, attach what goes
// with it, stage. The rows under test are therefore the rows the browser would
// hold, rendered by the same path a send takes.
function stage(text, images = []) {
  useChat().setDraft(text)
  chat.pendingImages = images.map((entry) => ({ ...entry }))
  expect(useChat().stage()).toBe(true)
}


function image(name, byte = 0) {
  return { dataUrl: `data:image/png;base64,AAAA${byte}`, name, size: 4 }
}

beforeEach(() => {
  resetAll()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetAll()
})

describe('the sending key flushes the strip and the draft as one turn', () => {
  it('turns two staged messages and a draft into three user turns, in one POST', async () => {
    const { posts } = stubRoutes()
    await loadAgentModes()
    stage('first thought')
    stage('second thought')
    chat.draft.raw = 'and the draft'

    await useChat().send()

    // One request for the whole flush: not one per message.
    expect(posts).toHaveLength(1)
    expect(posts[0].messages.map((message) => message.content)).toEqual([
      'first thought',
      'second thought',
      'and the draft',
    ])
    // The accumulated history sits in front of them: the body is the thread.
    expect(posts[0].messages).toHaveLength(3)
    // And the thread is what the model got, byte for byte.
    expect(chat.messages.map((message) => message.role)).toEqual(['user', 'user', 'user', 'assistant'])
    expect(chat.messages.slice(0, 3).map((message) => message.raw)).toEqual([
      'first thought',
      'second thought',
      'and the draft',
    ])
  })

  it('appends the flush after the thread it already holds', async () => {
    const { posts } = stubRoutes()
    await loadAgentModes()
    chat.messages = [
      { role: 'user', raw: 'an earlier brief', html: '<p>an earlier brief</p>', streaming: false },
      { role: 'assistant', raw: 'understood', html: '<p>understood</p>', streaming: false },
    ]
    stage('one')
    stage('two')

    await useChat().send()

    expect(posts[0].messages.map((message) => message.content)).toEqual([
      'an earlier brief',
      'understood',
      'one',
      'two',
    ])
    // The length is the previous thread plus the flush, and no message merged.
    expect(posts[0].messages).toHaveLength(4)
  })

  it('flushes the strip alone when the draft is empty', async () => {
    const { posts } = stubRoutes()
    await loadAgentModes()
    stage('one')
    stage('two')

    await useChat().send()

    expect(posts).toHaveLength(1)
    expect(posts[0].messages.map((message) => message.content)).toEqual(['one', 'two'])
    // An empty draft is not invented as a third, empty turn.
    expect(posts[0].messages).toHaveLength(2)
  })

  it('carries each message\'s own images on its own turn', async () => {
    const { posts } = stubRoutes()
    await loadAgentModes()
    stage('two mockups', [image('a.png', 1), image('b.png', 2)])
    stage('one more', [image('c.png', 3)])
    chat.draft.raw = 'no picture here'

    await useChat().send()

    const [first, second, third] = posts[0].messages
    expect(first.content.filter((part) => part.type === 'image_url')).toHaveLength(2)
    expect(second.content.filter((part) => part.type === 'image_url')).toHaveLength(1)
    expect(third).toEqual({ role: 'user', content: 'no picture here' })
  })

  it('leaves a draft-only send exactly as it was: same body, same path', async () => {
    const { posts, calls } = stubRoutes()
    await loadAgentModes()
    chat.draft.raw = 'no pictures'

    await useChat().send()

    expect(posts).toHaveLength(1)
    expect(posts[0].messages).toEqual([{ role: 'user', content: 'no pictures' }])
    // One POST, to the one route a send has always posted to.
    expect(calls.filter((call) => call.method === 'POST' && call.key.startsWith('/api/chat'))).toHaveLength(1)
    expect(chat.messages.map((message) => message.raw)).toEqual(['no pictures', ''])
  })

  it('empties the strip and the composer as part of opening the turn', async () => {
    stubRoutes()
    await loadAgentModes()
    stage('one')
    stage('two')
    chat.draft.raw = 'the draft'
    chat.pendingImages = [image('d.png', 4)]

    await useChat().send()

    expect(chat.staged).toEqual([])
    expect(chat.draft.raw).toBe('')
    expect(chat.pendingImages).toEqual([])
  })

  it('sends nothing at all when nothing is staged and nothing is typed', async () => {
    const { posts } = stubRoutes()
    await loadAgentModes()

    await useChat().send()

    expect(posts).toHaveLength(0)
    expect(chat.messages).toEqual([])
    expect(chat.error).toBeNull()
  })
})

describe('a refused flush moves nothing', () => {
  function stageTwo() {
    stage('first thought')
    stage('second thought')
    chat.draft.raw = 'and the draft'
    chat.error = null
  }

  it('refuses an unrunnable agent, leaving the draft and every row', async () => {
    const { posts } = stubRoutes({ agents: agentsBody({ model: null }) })
    await loadAgentModes()
    setAgentMode('code')
    stageTwo()
    const before = chat.staged.map((row) => row.raw)

    await useChat().send()

    expect(posts).toHaveLength(0)
    expect(chat.draft.raw).toBe('and the draft')
    expect(chat.staged.map((row) => row.raw)).toEqual(before)
    expect(chat.messages).toEqual([])
  })

  it('refuses a conversation a batch owns', async () => {
    const { posts } = stubRoutes()
    await loadAgentModes()
    stageTwo()
    batch.active = true

    await useChat().send()

    expect(posts).toHaveLength(0)
    expect(chat.draft.raw).toBe('and the draft')
    expect(chat.staged.map((row) => row.raw)).toEqual(['first thought', 'second thought'])
  })

  it('refuses while a reply streams, and keeps the rows in order', async () => {
    const { posts } = stubRoutes()
    await loadAgentModes()
    stageTwo()
    chat.phase = 'answering'

    await useChat().send()

    expect(posts).toHaveLength(0)
    expect(chat.draft.raw).toBe('and the draft')
    expect(chat.staged.map((row) => row.raw)).toEqual(['first thought', 'second thought'])
  })
})

describe('a flush is all-or-nothing on validation', () => {
  it('blocks the whole flush on one message that would arrive empty', async () => {
    const { posts } = stubRoutes()
    await loadAgentModes()
    stage('a good brief')
    // Looks non-empty in the strip; the server strips the run and receives
    // nothing, which is the blank user turn it rejects as a whole request.
    stage(run('im_start'))
    stage('another good brief')
    chat.error = null

    await useChat().send()

    expect(posts).toHaveLength(0)
    // Every row is still staged, in order, and nothing was sent from the draft.
    expect(chat.staged).toHaveLength(3)
    expect(chat.staged.map((row) => row.raw)).toEqual([
      'a good brief',
      run('im_start'),
      'another good brief',
    ])
    expect(chat.messages).toEqual([])
    // The verdict's own sentence names the row: the second one, in flush order.
    expect(chat.error).toContain('message 2')
    expect(chat.error).toContain(flushGateReason({ raw: run('im_start'), images: [] }))
  })

  it('refuses a draft that would arrive empty, keeping the good rows staged', async () => {
    const { posts } = stubRoutes()
    await loadAgentModes()
    stage('a good brief')
    chat.draft = { raw: run('im_end'), html: '<p>preview</p>', renderedRaw: 'preview' }

    await useChat().send()

    expect(posts).toHaveLength(0)
    expect(chat.staged.map((row) => row.raw)).toEqual(['a good brief'])
    // The draft is untouched down to its rendered preview: a refusal is not a
    // send that happened to fail, it is nothing happening at all.
    expect(chat.draft).toEqual({ raw: run('im_end'), html: '<p>preview</p>', renderedRaw: 'preview' })
    expect(chat.error).toContain('the draft')
  })

  it('accepts an image-only message, whose text legitimately arrives empty', async () => {
    const { posts } = stubRoutes()
    await loadAgentModes()
    stage('', [image('mockup.png', 1)])

    await useChat().send()

    expect(posts).toHaveLength(1)
    expect(posts[0].messages).toHaveLength(1)
    expect(posts[0].messages[0].content.filter((part) => part.type === 'image_url')).toHaveLength(1)
  })
})

describe('flushGateReason() is the one verdict a flush and a strip row share', () => {
  it('accepts text the server will still see', () => {
    expect(flushGateReason({ raw: 'a brief', images: [] })).toBeNull()
    expect(flushGateReason({ raw: '  padded  ', images: [] })).toBeNull()
    expect(flushGateReason({ raw: '', images: [image('a.png')] })).toBeNull()
  })

  it('refuses text that only looks non-empty, naming why in a sentence', () => {
    const reason = flushGateReason({ raw: run('im_start'), images: [] })
    expect(reason).toBeTruthy()
    expect(reason).toContain('blank user turn')
  })

  it('refuses text whose run only disappears after an inner one is gone', () => {
    const spliced = `<${PIPE}im_${run('x')}start${PIPE}>`
    expect(flushGateReason({ raw: spliced, images: [] })).toBeTruthy()
  })

  it('refuses whitespace alone', () => {
    expect(flushGateReason({ raw: '   \n\t ', images: [] })).toBeTruthy()
  })

  it('tolerates a well-formed message object and a missing one alike', () => {
    expect(flushGateReason(undefined)).toBeTruthy()
    expect(flushGateReason({ raw: 'ok' })).toBeNull()
  })
})

describe('the hub toggles lock on the accepted flush, never on a stage', () => {
  it('leaves both panels unlocked while messages are only staged', async () => {
    stubRoutes()
    await loadAgentModes()
    chat.mcp = { connectors: [], enabled: { c1: true }, loaded: true, locked: false, restarting: false }
    chat.lsp = { servers: [], enabled: { s1: true }, loaded: true, locked: false, restarting: false }

    stage('staged only')

    expect(chat.mcp.locked).toBe(false)
    expect(chat.lsp.locked).toBe(false)
  })

  it('sets both once, on the flush that is accepted', async () => {
    const { posts } = stubRoutes()
    await loadAgentModes()
    chat.mcp = { connectors: [], enabled: { c1: true }, loaded: true, locked: false, restarting: false }
    chat.lsp = { servers: [], enabled: { s1: true }, loaded: true, locked: false, restarting: false }
    stage('one')
    stage('two')

    await useChat().send()

    expect(posts).toHaveLength(1)
    expect(chat.mcp.locked).toBe(true)
    expect(chat.lsp.locked).toBe(true)
    // The one accepted flush carried one conversation-scoped allowlist, not one
    // per staged message.
    expect(posts[0].mcpEnabled).toEqual(['c1'])
    expect(posts[0].lspEnabled).toEqual(['s1'])
    expect(posts[0].agentMode).toBe('code')
  })
})

describe('the composer can send a strip it emptied the draft on top of', () => {
  it('leaves Send live with an empty draft and a non-empty strip', async () => {
    stubRoutes()
    await loadAgentModes()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const w = mount(WorkBenchInput, { attachTo: host })
    await flushPromises()

    const sendButton = () => w.find('.chat-send:not(.chat-stop)')
    expect(sendButton().attributes('disabled')).toBeDefined()

    stage('a staged brief')
    await flushPromises()
    // The composer is empty, but there is something waiting to be flushed:
    // Send is what opens the turn on it, so it must not be inert.
    expect(chat.draft.raw).toBe('')
    expect(sendButton().attributes('disabled')).toBeUndefined()

    w.unmount()
    host.remove()
  })
})

describe('a flush is one turn, and the strip never reaches the request another way', () => {
  it('opens one clock span and one reply bracket for the whole group', async () => {
    const { posts } = stubRoutes()
    await loadAgentModes()
    stage('one')
    stage('two')
    chat.draft.raw = 'three'

    await useChat().send()

    expect(posts).toHaveLength(1)
    // One assistant bubble closes the one turn, whatever the group held.
    expect(chat.messages.filter((message) => message.role === 'assistant')).toHaveLength(1)
    expect(chat.phase).toBe('idle')
  })

  it('is not read by a batch turn, which builds its own request', async () => {
    const { posts } = stubRoutes()
    await loadAgentModes()
    stage('staged but never sent')

    expect(
      useChat().sendBatchTurn('one task', { agentMode: 'code', workspace: '/w/task-folder' }),
    ).toBe(true)
    await vi.waitFor(() => expect(chat.phase).toBe('idle'))

    expect(posts).toHaveLength(1)
    // The task's turn is its own instruction alone: no strip, no conversation.
    expect(posts[0].messages).toEqual([{ role: 'user', content: 'one task' }])
    // And a non-empty strip neither joins nor blocks the lot.
    expect(chat.staged.map((row) => row.raw)).toEqual(['staged but never sent'])
  })

  it('builds a byte-identical batch payload with a non-empty strip, and with none', async () => {
    // The strongest form of "the strip never leaks into a task turn": the very
    // same launch, run twice, differing only in what the composer is holding.
    // Anything the strip contributed — a message, a field, a count — would show
    // up as a difference here.
    const run = async (staged) => {
      const { posts } = stubRoutes()
      await loadAgentModes()
      for (const text of staged) stage(text)
      expect(
        useChat().sendBatchTurn('one task', { agentMode: 'code', workspace: '/w/task-folder' }),
      ).toBe(true)
      await vi.waitFor(() => expect(chat.phase).toBe('idle'))
      expect(posts).toHaveLength(1)
      useChat().reset({ refetchHubs: false })
      vi.restoreAllMocks()
      return JSON.stringify(posts[0])
    }

    const withStrip = await run(['a brief written before the lot', 'and another'])
    const withoutStrip = await run([])

    expect(withStrip).toBe(withoutStrip)
  })
})

describe('one flush names one agent and one folder, whatever the group held', () => {
  it('posts every staged message in one request naming the tab\'s folder', async () => {
    const { calls, posts } = stubRoutes()
    const root = pointTabAt('/w/workspace-a')
    await loadAgentModes()
    stage('one mockup')
    stage('two mockups')
    chat.draft.raw = 'and the note'

    await useChat().send()

    // One POST: a flush resolves the connection, the agent and the folder once
    // for the whole group rather than once per staged message.
    const chatPosts = calls.filter(
      (call) => call.method === 'POST' && call.key.startsWith('/api/chat'),
    )
    expect(chatPosts).toHaveLength(1)
    expect(workspaceOf(chatPosts[0].key)).toBe(root)
    expect(posts[0].agentMode).toBe('code')
    expect(posts[0].messages).toHaveLength(3)
  })

  it('sends the thread shape alone: no row id, no strip field, nothing to persist', async () => {
    const { posts } = stubRoutes()
    await loadAgentModes()
    stage('one', [image('a.png', 1)])
    stage('two')

    await useChat().send()

    // The strip's own address (the id that lets a row be removed) is browser
    // state and stops at the wire: a flush is a longer thread, nothing more.
    const body = JSON.stringify(posts[0])
    expect(body).not.toContain('staged-')
    expect(body).not.toContain('"staged"')
    expect(body).not.toContain('"id"')
    // The body holds the thread and the request's own fields — the agent this
    // turn runs as, the two hub allowlists — and nothing that names the strip.
    expect(Object.keys(posts[0]).sort()).toEqual(['agentMode', 'messages'])
    for (const message of posts[0].messages) {
      expect(Object.keys(message).sort()).toEqual(['content', 'role'])
      expect(message.role).toBe('user')
    }
  })
})
