import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { flushPromises, mount } from '@vue/test-utils'

import WorkBenchInput from '../src/components/WorkBenchInput.vue'
import WorkBenchView from '../src/components/WorkBenchView.vue'
import {
  conversationJson,
  conversationMarkdown,
  endpointWaitLine,
  useChat,
} from '../src/composables/useChat'
import {
  loadAgentModes,
  setAgentMode,
  useAgentModes,
} from '../src/composables/useAgentModes'
import { useAppShell } from '../src/composables/useAppShell'
import { useBatch } from '../src/composables/useBatch'
import { clearTabWorkspace } from './helpers/workspace-url'

// ---------------------------------------------------------------------------
// Task 06 — what a wait shows, and what it must never write.
//
// The backend decided to wait on a refused endpoint (task 03) and the phase
// exists to carry it (task 05). This file is the two halves spec §4 and §5.13
// assign to the frontend:
//
//   * **the strip**: one status line, drawn from the frame alone, reading
//     exactly spec §5.6's shape, with the endpoint's own sentence quoted
//     verbatim (spec §9 — the app quotes it, it never diagnoses it);
//   * **the transcript**: nothing. No message, no marker, no change to the
//     reply's `raw`, nothing in the saved session.
//
// Every case here drives the frames through a real `send()` over a stubbed SSE
// body — the line is SSE-derived (no timer and no client-side guess), so the
// only honest way to prove that is to watch what the frames do to the DOM, and
// to watch a clock that runs advance nothing.
// ---------------------------------------------------------------------------

// jsdom has no ResizeObserver, and the chat splitters each create one on mount.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const chat = useChat().state
const batch = useBatch().state
const agentModes = useAgentModes().state
const shell = useAppShell().state

// spec §5.6's own example, attempt 2 of a budget of 3. The sentence is the
// endpoint's, and the test asserts it survives whole.
const WAIT_FRAME =
  'event: reconnecting\n' +
  'data: {"attempt":2,"budget":3,"waitSeconds":10,' +
  '"message":"the model endpoint answered HTTP 502"}\n\n'

const WAIT_LINE =
  'Reconnecting 2/3 — the model endpoint answered HTTP 502 · retrying in 10s'

const TOKEN = (text) => `event: token\ndata: {"text":"${text}"}\n\n`
const DONE = 'event: done\ndata: {"tokens":4,"took":1.5,"ttft":0.4,"decode":1.1}\n\n'
const PAUSE_ACK = 'event: pause_ack\ndata: {"paused":true}\n\n'

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

// A stream that hands over `first` and holds `rest` behind a gate: the only way
// to assert on the line **while** the turn is still open, and the way to leave a
// stream ending between two waits.
function gatedStream(first, rest) {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const head = new TextEncoder().encode(first)
  const tail = new TextEncoder().encode(rest)
  let read = 0
  return {
    release: () => release(),
    body: {
      getReader: () => ({
        async read() {
          if (read === 0) {
            read += 1
            return { done: false, value: head }
          }
          if (read === 1) {
            await gate
            read += 1
            return { done: false, value: tail }
          }
          return { done: true, value: undefined }
        },
      }),
    },
  }
}

// A reply that never ends on its own, and honours the abort signal the way a
// real fetch does — the turn a Stop reaches.
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

function resetAll() {
  clearTabWorkspace()
  chat.phase = 'idle'
  chat.messages = []
  chat.error = null
  chat.pausePending = false
  chat.pendingImages = []
  chat.staged = []
  chat.endpointWait = null
  chat.draft = { raw: '', html: '', renderedRaw: '' }
  chat.session.startedAt = 0
  chat.session.spentMs = 0
  chat.session.agentMode = null
  chat.mcp = {
    connectors: [],
    enabled: {},
    loaded: false,
    locked: false,
    restarting: false,
    error: null,
  }
  chat.lsp = {
    servers: [],
    enabled: {},
    loaded: false,
    locked: false,
    restarting: false,
    error: null,
  }
  batch.active = false
  batch.status = 'idle'
  agentModes.modes = []
  agentModes.current = null
  agentModes.loaded = false
  agentModes.findings = []
  agentModes.notice = null
  shell.config = {
    models: [{ id: 1, name: 'model-1', serverId: 1, serverName: 'srv' }],
    store: { usable: true, sentence: null },
  }
  shell.storeState = { usable: true, sentence: null }
  shell.configError = null
  shell.activeTab = 'chat'
  window.sessionStorage.clear()
  window.localStorage.clear()
}

// The chat route answering with these frames (or with `chatBody`, for the cases
// that need a stream still open when they assert), plus the agent list every
// composer path reads.
function stubRoutes(frames, { chatBody = null, onChat = null } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const key = String(url)
    if (key.startsWith('/api/chat/pause')) return jsonResponse({ paused: 'requested' })
    if (key.startsWith('/api/chat')) {
      if (onChat) return onChat(init)
      return { ok: true, body: chatBody ?? sseBody(frames) }
    }
    if (key === '/api/agents') return jsonResponse(agentsBody())
    return jsonResponse({})
  })
}

// The composer path a real send takes: a loaded agent list (Send is gated on it)
// and a draft to flush. The caller then calls `send()`, which opens the turn.
async function armComposer() {
  await loadAgentModes()
  setAgentMode('code')
  chat.draft.raw = 'ask'
}

function waitLineNode(wrapper) {
  return wrapper.find('.chat-endpoint-wait')
}

beforeEach(resetAll)

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  resetAll()
})

// -- the line itself ---------------------------------------------------------

describe('the composer strip carries one line for a wait', () => {
  // The whole chain the feature is about: a frame over a stubbed SSE body, the
  // composable's state, and the text the composer draws. The shape is spec
  // §5.6's to the letter — the label, the attempt over the budget's own value,
  // the endpoint's sentence, and the length of this wait.
  it('renders the frame as its one line, with the endpoint sentence verbatim', async () => {
    const stream = gatedStream(WAIT_FRAME, DONE)
    stubRoutes('', { chatBody: stream.body })
    await armComposer()
    const wrapper = mount(WorkBenchInput)
    await flushPromises()

    const turn = useChat().send()
    await vi.waitFor(() => expect(waitLineNode(wrapper).exists()).toBe(true))

    // The four fields, kept as the frame gave them (task 06 half 1).
    expect(chat.endpointWait).toEqual({
      attempt: 2,
      budget: 3,
      waitSeconds: 10,
      message: 'the model endpoint answered HTTP 502',
    })

    const node = waitLineNode(wrapper)
    expect(node.text()).toBe(WAIT_LINE)
    // The sentence survives whole: the app quotes the endpoint, never re-words
    // it (spec §9).
    expect(node.text()).toContain('the model endpoint answered HTTP 502')
    expect(node.text()).not.toContain('network')
    // `Reconnecting` is the label and not a verb about what the app did.
    expect(node.text().startsWith('Reconnecting 2/3')).toBe(true)

    stream.release()
    await turn
    wrapper.unmount()
  })

  // The affordances the strip's other statuses hold: a screen reader hears it,
  // and the `title` repeats the detail a long sentence may have been cut short
  // of. A quiet caption, not an alert.
  it('is a status line: role, title, and the theme caption voice', async () => {
    chat.endpointWait = {
      attempt: 1,
      budget: 3,
      waitSeconds: 10,
      message: 'read timed out after 60s',
    }
    stubRoutes('')
    const wrapper = mount(WorkBenchInput)
    await flushPromises()

    const node = waitLineNode(wrapper)
    expect(node.attributes('role')).toBe('status')
    expect(node.attributes('title')).toBe(
      'Reconnecting 1/3 — read timed out after 60s · retrying in 10s',
    )
    expect(node.classes()).toContain('caption')
    // The machine-quoted voice the batch counter already uses, and not the
    // error line: a wait is not a failure.
    expect(node.classes()).toContain('mono')
    expect(node.classes()).not.toContain('error-line')
    wrapper.unmount()
  })

  // The plain-text rule: the endpoint's sentence is never markdown and never
  // HTML, so a sentence carrying markup arrives as words.
  it('quotes the sentence as plain text, never as markup', async () => {
    chat.endpointWait = {
      attempt: 1,
      budget: 2,
      waitSeconds: 5,
      message: 'upstream <b>502</b> [Bad *Gateway*]',
    }
    stubRoutes('')
    const wrapper = mount(WorkBenchInput)
    await flushPromises()

    const node = waitLineNode(wrapper)
    expect(node.text()).toContain('<b>502</b> [Bad *Gateway*]')
    // The sentence arrives as escaped text and the element holds no child at
    // all: the markup was never parsed, and nothing was rendered as HTML.
    expect(node.html()).toContain('&lt;b&gt;502&lt;/b&gt;')
    expect(node.element.children).toHaveLength(0)

    // And the composer still renders its text through interpolation, never raw
    // HTML — the rule `lib/` holds for everything else.
    const composerSource = readFileSync(
      resolve('src/components/WorkBenchInput.vue'),
      'utf8',
    )
    expect(composerSource).not.toMatch(/v-html/)
    wrapper.unmount()
  })

  // Nothing to say → nothing rendered: no box, no reserved space, in the same
  // discipline the staged strip follows.
  it('renders nothing at all when no wait is in progress', async () => {
    stubRoutes('')
    const wrapper = mount(WorkBenchInput)
    await flushPromises()

    expect(chat.endpointWait).toBeNull()
    expect(waitLineNode(wrapper).exists()).toBe(false)
    // The composer is exactly what it was: the textarea and the run row are
    // still there, and the line added no control of its own.
    expect(wrapper.find('.chat-textarea').exists()).toBe(true)
    expect(wrapper.findAll('.chat-send')).toHaveLength(1)
    wrapper.unmount()
  })

  // spec §5.6's own words for where it lives: "the strip whose layout the short
  // label exists for" — the composer, above the textarea beside the batch
  // meter — so it stays on screen while the conversation scrolls away.
  it('sits in the composer strip, above the textarea beside the batch meter', async () => {
    chat.endpointWait = { attempt: 1, budget: 3, waitSeconds: 10, message: 'HTTP 502' }
    stubRoutes('')
    const composer = mount(WorkBenchInput)
    await flushPromises()

    // In the composer, not in the conversation pane.
    const line = composer.find('.chat-input .chat-endpoint-wait')
    expect(line.exists()).toBe(true)
    // Above the textarea in document order, in the meter's column.
    const textarea = composer.find('.chat-textarea').element
    expect(
      line.element.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(line.element.parentElement).toBe(textarea.parentElement)

    // One line about one wait, and it is not in the conversation: the pane that
    // scrolls holds none of it.
    const view = mount(WorkBenchView)
    await flushPromises()
    expect(view.find('.chat-output .chat-endpoint-wait').exists()).toBe(false)
    composer.unmount()
    view.unmount()
  })

  it('has no rule that reserves space for it, so an empty box cannot appear', () => {
    const css = readFileSync(resolve('src/styles/theme.css'), 'utf8')
    const body = css.match(/\.chat-endpoint-wait\s*\{([^}]*)\}/)[1]
    // No height, no background, no border: the element exists only while a
    // frame has something to say, so the strip is a strip the rest of the time.
    expect(body).not.toMatch(/min-height\s*:/)
    expect(body).not.toMatch(/height\s*:/)
    expect(body).not.toMatch(/background\s*:/)
    expect(body).not.toMatch(/border\s*:/)
  })

  // SSE is the UI's only source of truth: no clock fills the line in and no
  // clock takes it down. With fake timers advanced well past the wait's own
  // length, the line still appears only for a frame and still leaves only for
  // a frame.
  it('answers no clock of its own — waiting out the seconds changes nothing', async () => {
    vi.useFakeTimers()
    stubRoutes('')
    const wrapper = mount(WorkBenchInput)

    vi.advanceTimersByTime(600000)
    expect(waitLineNode(wrapper).exists()).toBe(false)

    chat.endpointWait = { attempt: 1, budget: 3, waitSeconds: 10, message: 'HTTP 503' }
    await flushPromises()
    vi.advanceTimersByTime(600000)
    expect(waitLineNode(wrapper).text()).toBe(
      'Reconnecting 1/3 — HTTP 503 · retrying in 10s',
    )

    wrapper.unmount()
    vi.useRealTimers()
  })

  // The one-field-one-clearing-site rule, asserted as a source rule: the state
  // field is written in exactly two places — the frame that fills it and
  // `clearEndpointWait` that empties it — so a stale line has no third door and
  // there is no second list of clearing sites for a later change to forget.
  it('keeps one field and one clearing site in the sources', () => {
    const source = readFileSync(resolve('src/composables/useChat.js'), 'utf8')
    // Two assignments to the field, and only those: the clearing function and
    // the frame that fills it. (Its initialiser is the `null` in the reactive
    // literal, which is a declaration and not a write.)
    expect(source.match(/state\.endpointWait\s*=/g)).toHaveLength(2)
    // Exactly one of the two ever empties it — that one is the clearing site.
    expect(source.match(/state\.endpointWait\s*=\s*null/g)).toHaveLength(1)
    // and that function is reached everywhere the line must go: the four
    // arrivals, the three terminal frames, finish()'s fallback and reset().
    const clears = source.match(/(?<!function )clearEndpointWait\(\)/g) ?? []
    expect(clears).toHaveLength(9)
    // The strip draws the composable's line and builds no wording of its own.
    const composer = readFileSync(
      resolve('src/components/WorkBenchInput.vue'),
      'utf8',
    )
    expect(composer).toContain('endpointWaitLine(state.endpointWait)')
    expect(composer).not.toContain('Reconnecting')
  })

  // The wording rule (spec §3, D6) asserted where it is decided: the sentence
  // is the frame's, the shape is the composable's, and it names no network and
  // calls nothing a reconnect.
  it('builds the line in the composable, naming no network and no reconnect', () => {
    expect(endpointWaitLine(null)).toBe('')
    expect(
      endpointWaitLine({ attempt: 2, budget: 3, waitSeconds: 10, message: 'HTTP 502' }),
    ).toBe('Reconnecting 2/3 — HTTP 502 · retrying in 10s')
    const line = endpointWaitLine({
      attempt: 1,
      budget: 3,
      waitSeconds: 10,
      message: 'the model endpoint answered HTTP 502',
    })
    expect(line).not.toMatch(/network/i)
    // The label is the only place the word survives, and it never reads as a
    // verb.
    expect(line.replace('Reconnecting', '')).not.toMatch(/reconnect/i)
  })
})

// -- the line goes when the wait is over -------------------------------------

describe('the line never outlives the wait it described', () => {
  // The replayed round answering is what ends a wait, and its **first**
  // arrival — of any kind — is the moment the line goes.
  it('goes at the first token of the replayed round', async () => {
    const stream = gatedStream(WAIT_FRAME, TOKEN('at last') + DONE)
    stubRoutes('', { chatBody: stream.body })
    await armComposer()
    const wrapper = mount(WorkBenchInput)
    await flushPromises()

    const turn = useChat().send()
    await vi.waitFor(() => expect(waitLineNode(wrapper).exists()).toBe(true))

    stream.release()
    await turn
    await flushPromises()

    expect(chat.endpointWait).toBeNull()
    expect(waitLineNode(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })

  // Every arrival that means the endpoint answered again, from the frame's own
  // chunk: `reasoning_delta` is streamed thinking, and a `tool_call` is a call
  // the replayed round submitted.
  for (const [name, frame] of [
    ['a `reasoning` frame', 'event: reasoning\ndata: {}\n\n'],
    ['a `reasoning_delta`', 'event: reasoning_delta\ndata: {"text":"thinking"}\n\n'],
    ['a `tool_call`', 'event: tool_call\ndata: {"tool":"read_file","id":"c1"}\n\n'],
  ]) {
    it(`goes at ${name} instead`, async () => {
      stubRoutes(`${WAIT_FRAME}${frame}${DONE}`)
      await armComposer()
      const wrapper = mount(WorkBenchInput)

      await useChat().send()
      await flushPromises()

      expect(chat.endpointWait).toBeNull()
      expect(waitLineNode(wrapper).exists()).toBe(false)
      wrapper.unmount()
    })
  }

  // Each terminal path, in turn: the wait is inside the turn, so the frame
  // that closes the turn closes the line with it.
  it('goes on the `done` frame', async () => {
    stubRoutes(`${WAIT_FRAME}${DONE}`)
    await armComposer()

    await useChat().send()

    expect(chat.phase).toBe('idle')
    expect(chat.endpointWait).toBeNull()
  })

  // A budget that ran out: the endpoint's sentence is now the **error** line,
  // and the status line that announced the last wait goes with it — two lines
  // about one failure is the drift this lot keeps refusing.
  it('goes on the `error` frame, leaving only the error line', async () => {
    stubRoutes(
      `${WAIT_FRAME}event: error\ndata: {"message":"the model endpoint answered HTTP 502 (retried 3 times)"}\n\n`,
    )
    await armComposer()
    const wrapper = mount(WorkBenchInput)

    await useChat().send()
    await flushPromises()

    expect(chat.endpointWait).toBeNull()
    expect(waitLineNode(wrapper).exists()).toBe(false)
    expect(chat.error).toContain('retried 3 times')
    wrapper.unmount()
  })

  // A Pause armed during a wait does not cut the wait short (spec §5.8) — but
  // its ack is a terminal frame, so when it lands the line goes with it.
  it('goes on the `pause_ack` frame', async () => {
    const stream = gatedStream(WAIT_FRAME, PAUSE_ACK)
    stubRoutes('', { chatBody: stream.body })
    await armComposer()
    const wrapper = mount(WorkBenchInput)
    await flushPromises()

    const turn = useChat().send()
    await vi.waitFor(() => expect(chat.endpointWait).not.toBeNull())

    await useChat().pause()
    expect(chat.pausePending).toBe(true)
    // Armed, not ended: the wait's line holds until the ack arrives.
    expect(waitLineNode(wrapper).exists()).toBe(true)

    stream.release()
    await vi.waitFor(() => expect(chat.phase).toBe('idle'))
    await turn
    await flushPromises()

    expect(chat.endpointWait).toBeNull()
    expect(waitLineNode(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })

  // Stop's abort reaches no terminal frame, so it clears through finish()'s
  // fallback: the local half of "one place, cleared in one place".
  it('goes when Stop ends a turn mid-wait', async () => {
    stubRoutes('', { onChat: (init) => hangUntilAborted(init) })
    await armComposer()
    const wrapper = mount(WorkBenchInput)
    await flushPromises()

    const turn = useChat().send()
    chat.endpointWait = {
      attempt: 1,
      budget: 3,
      waitSeconds: 10,
      message: 'the model endpoint answered HTTP 502',
    }
    await flushPromises()
    expect(waitLineNode(wrapper).exists()).toBe(true)

    useChat().stop()
    await vi.waitFor(() => expect(chat.phase).toBe('idle'))
    await turn
    await flushPromises()

    expect(chat.endpointWait).toBeNull()
    expect(waitLineNode(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })

  // A stream that ends between two waits: the last thing it sent was a
  // `reconnecting` frame, and there was no terminal frame after it. The line
  // must not survive into the idle composer.
  it('leaves nothing when a stream ends between two waits', async () => {
    stubRoutes(`${WAIT_FRAME}`)
    await armComposer()
    const wrapper = mount(WorkBenchInput)

    await useChat().send()
    await flushPromises()

    // The turn closed without a terminal frame; the wait's line went anyway.
    expect(chat.phase).toBe('idle')
    expect(chat.endpointWait).toBeNull()
    expect(waitLineNode(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })

  // Restart during a wait aborts a turn that reached no terminal frame, and the
  // composer it reopens holds no turn: no stale line under it.
  it('goes when Restart wipes a conversation mid-wait', async () => {
    stubRoutes('', { onChat: (init) => hangUntilAborted(init) })
    await armComposer()
    const wrapper = mount(WorkBenchInput)
    await flushPromises()

    const turn = useChat().send()
    chat.endpointWait = { attempt: 3, budget: 3, waitSeconds: 10, message: 'HTTP 504' }
    await flushPromises()
    expect(waitLineNode(wrapper).exists()).toBe(true)

    useChat().reset({ refetchHubs: false })
    await turn
    await flushPromises()

    expect(chat.endpointWait).toBeNull()
    expect(waitLineNode(wrapper).exists()).toBe(false)
    wrapper.unmount()
  })
})

// -- and the transcript keeps no trace of it ---------------------------------

describe('a wait writes nothing into the transcript', () => {
  // The reply's own text, before, during and after a wait: a replayed round
  // produces no duplicate because the failed round produced none, and the wait
  // itself is not content.
  it('adds no message, no marker, and no character to the reply', async () => {
    stubRoutes(`${WAIT_FRAME}${TOKEN('part one ')}${WAIT_FRAME}${TOKEN('part two ')}${DONE}`)
    await armComposer()

    await useChat().send()
    await flushPromises()

    // one user turn plus the reply — no third row for the two waits.
    expect(chat.messages).toHaveLength(2)
    const [user, reply] = chat.messages
    expect(user.raw).toBe('ask')
    expect(reply.role).toBe('assistant')
    // the two rounds' text and nothing between them.
    expect(reply.raw).toBe('part one part two ')
    // No marker of any kind: no flag, no block, no tool badge, no error line.
    expect(reply.truncated).toBe(false)
    expect(reply.paused).toBe(false)
    expect(reply.blocks).toEqual([])
    expect(reply.tools).toEqual([])
    expect(chat.error).toBeNull()
    expect(chat.endpointWait).toBeNull()
  })

  // The same claim read across the wait's own boundary rather than after it:
  // the reply's `raw` at the moment the line appears is the text that arrived
  // **before** the refused round, and it is still that after the replay. The
  // wait itself contributed nothing to it — which is also why a replayed round
  // cannot duplicate text (spec §5.13).
  it('changes no character of the reply across the wait', async () => {
    const stream = gatedStream(TOKEN('part one ') + WAIT_FRAME, TOKEN('part two ') + DONE)
    stubRoutes('', { chatBody: stream.body })
    await armComposer()
    const wrapper = mount(WorkBenchInput)
    await flushPromises()

    const turn = useChat().send()
    await vi.waitFor(() => expect(waitLineNode(wrapper).exists()).toBe(true))

    const reply = chat.messages[1]
    const duringTheWait = reply.raw
    expect(duringTheWait).toBe('part one ')

    stream.release()
    await turn
    await flushPromises()

    expect(reply.raw).toBe(`${duringTheWait}part two `)
    wrapper.unmount()
  })

  // The wait survives neither the session file nor the copy: what leaves the
  // browser is the thread, exactly.
  it('leaves no trace in the session file or the copy', async () => {
    stubRoutes(`${WAIT_FRAME}${TOKEN('the answer')}${DONE}`)
    await armComposer()

    await useChat().send()
    await flushPromises()

    const json = JSON.stringify(conversationJson(chat.messages))
    const markdown = conversationMarkdown(chat.messages)
    for (const text of [json, markdown]) {
      expect(text).toContain('the answer')
      expect(text).not.toMatch(/Reconnecting/i)
      expect(text).not.toContain('502')
      expect(text).not.toContain('retrying')
    }
  })

  // The reply card must not claim to be thinking while the endpoint is
  // refusing: `waiting` means "sent, no first token yet", a wait means "the
  // endpoint refused", and spec §5.11 rules out confusing the two. The chosen
  // treatment is suppression — the strip carries the one line.
  it('leaves the reply card claiming no thinking during a wait', async () => {
    const stream = gatedStream(WAIT_FRAME, TOKEN('finally') + DONE)
    stubRoutes('', { chatBody: stream.body })
    await armComposer()
    const wrapper = mount(WorkBenchView)
    await flushPromises()

    const turn = useChat().send()
    await vi.waitFor(() => expect(chat.phase).toBe('reconnecting'))

    // The condition the caption used to read alone: a streaming reply with no
    // text yet. It is true during this wait, and the caption still abstains.
    const reply = chat.messages[1]
    expect(reply.streaming).toBe(true)
    expect(reply.raw).toBe('')
    expect(wrapper.find('.chat-typing').exists()).toBe(false)
    // One line about the wait, and it is the composer's.
    expect(wrapper.find('.chat-endpoint-wait').exists()).toBe(true)
    expect(wrapper.text()).not.toContain('Thinking')

    // The replayed round's first arrival puts the caption back on its own.
    stream.release()
    await turn
    await flushPromises()
    expect(wrapper.find('.chat-endpoint-wait').exists()).toBe(false)

    wrapper.unmount()
  })

  // The other side of the same rule: with no wait running, the caption is
  // untouched — the guard did not swallow the ordinary thinking line. The
  // stream's first chunk is a `usage` frame, which neither streams text nor
  // moves the phase, so the pane is genuinely in `waiting` (sent, no first
  // token yet) when this asserts.
  it('keeps the thinking caption for a reply that is only waiting', async () => {
    const usage = 'event: usage\ndata: {"tokens":1,"decode":0.1}\n\n'
    const stream = gatedStream(usage, TOKEN('later') + DONE)
    stubRoutes('', { chatBody: stream.body })
    await armComposer()
    const wrapper = mount(WorkBenchView)
    await flushPromises()

    const turn = useChat().send()
    await vi.waitFor(() => expect(chat.phase).toBe('waiting'))
    await flushPromises()

    expect(chat.messages[1].raw).toBe('')
    expect(chat.endpointWait).toBeNull()
    expect(wrapper.find('.chat-typing').exists()).toBe(true)
    expect(wrapper.find('.chat-typing').text()).toBe('Thinking…')

    stream.release()
    await turn
    wrapper.unmount()
  })
})
