import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { nextTick, watch } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'

import AppBar from '../src/components/AppBar.vue'
import WorkBenchInput from '../src/components/WorkBenchInput.vue'
import {
  PHASES_IN_FLIGHT,
  inferenceRunning,
  phaseInFlight,
} from '../src/lib/inference-state'
import {
  loadAgentModes,
  setAgentMode,
  useAgentModes,
} from '../src/composables/useAgentModes'
import { useAppShell } from '../src/composables/useAppShell'
import { useBatch } from '../src/composables/useBatch'
import { useChat } from '../src/composables/useChat'
import { useTabTitle } from '../src/composables/useTabTitle'
import { clearTabWorkspace } from './helpers/workspace-url'

// ---------------------------------------------------------------------------
// Task 05 — the `reconnecting` phase, and the two lists that must agree.
//
// The backend has already decided to wait on a refused endpoint (task 03 emits
// the frame); what this file pins down is the frontend half of spec §5.12, which
// the spec itself calls "the feature's most likely bug": the question "is a
// reply streaming?" is answered in two places — the shared inference-state
// predicate behind the tab glyph and the end-of-session chime, and the app bar's
// own copy behind the status pill. Update one and not the other and the app goes
// quiet mid-turn: the chime rings as though the reply had ended and the glyph
// drops to ✨, while the composer stays locked.
//
// So the agreement is asserted for **every** phase rather than for the one new
// value, and it is derived: the list has one source of truth in
// `lib/inference-state.js`, the app bar asks that predicate instead of restating
// the list, and a source scan proves no second literal came back.
// ---------------------------------------------------------------------------

const shell = useAppShell().state
const agentModes = useAgentModes().state
const chat = useChat().state
const batch = useBatch().state

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
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

// A stream that hands over its first chunk and then holds the rest behind a
// gate — the shape a real SSE channel has, and the only way a test can catch the
// phase **while** a turn is still open rather than after its last frame.
function gatedStream(firstFrame, restFrames) {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const first = new TextEncoder().encode(firstFrame)
  const rest = new TextEncoder().encode(restFrames)
  let read = 0
  return {
    release: () => release(),
    body: {
      getReader: () => ({
        async read() {
          if (read === 0) {
            read += 1
            return { done: false, value: first }
          }
          if (read === 1) {
            await gate
            read += 1
            return { done: false, value: rest }
          }
          return { done: true, value: undefined }
        },
      }),
    },
  }
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

function resetAll() {
  clearTabWorkspace()
  chat.phase = 'idle'
  chat.messages = []
  chat.error = null
  chat.pausePending = false
  chat.pendingImages = []
  chat.staged = []
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

// The chat route answering with these frames, plus the agent list every
// composer path reads. `chatBody` overrides the whole body, for the case that
// needs a stream still open when it asserts.
function stubRoutes(frames, { chatBody = null } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const key = String(url)
    if (key.startsWith('/api/chat')) {
      return { ok: true, body: chatBody ?? sseBody(frames) }
    }
    if (key === '/api/agents') return jsonResponse(agentsBody())
    return jsonResponse({})
  })
}

// The composer path a real send takes: a loaded agent list (Send is gated on it)
// and a draft to flush. Nothing is returned — the caller then calls `send()`,
// which is what opens the turn.
async function armComposer() {
  await loadAgentModes()
  setAgentMode('code')
  chat.draft.raw = 'ask'
}

// Every phase the turn moves through, in order. `flush: 'sync'` because the
// frames of one chunk are handled in a single synchronous block, so a normally
// flushed watcher would coalesce the steps and report only the last one — the
// sequence *is* the subject here.
function watchPhases() {
  const seen = []
  const stop = watch(
    () => chat.phase,
    (phase) => seen.push(phase),
    { flush: 'sync' },
  )
  return { seen, stop }
}

beforeEach(resetAll)

afterEach(() => {
  vi.restoreAllMocks()
  resetAll()
})

// -- the frame drives the phase ----------------------------------------------

describe('a `reconnecting` frame drives the phase', () => {
  // The phase exists to show for a wait **after a tool round**, which is the
  // state the phase was in when that round was refused. A guard refusing to
  // leave `answering` — the shape the `reasoning` case keeps, for the opposite
  // reason — would hide the phase for the common case entirely.
  it('leaves `answering` for the wait, and the next round answers again', async () => {
    stubRoutes(
      [
        'event: token',
        'data: {"text":"first round "}',
        '',
        'event: reconnecting',
        'data: {"attempt":1,"budget":3,"waitSeconds":10,"message":"the model endpoint answered HTTP 502"}',
        '',
        'event: token',
        'data: {"text":"replayed"}',
        '',
        'event: done',
        'data: {"tokens":8,"took":1.5,"ttft":0.4,"decode":1.1}',
        '',
        '',
      ].join('\n'),
    )
    await armComposer()
    const { seen, stop } = watchPhases()

    await useChat().send()
    stop()

    // waiting -> answering -> reconnecting -> answering -> idle: the wait is a
    // step *inside* the turn, not a new turn and not the end of one.
    expect(seen).toEqual([
      'waiting',
      'answering',
      'reconnecting',
      'answering',
      'idle',
    ])
    expect(chat.messages[chat.messages.length - 1].raw).toBe('first round replayed')
  })

  // A wait on the very first round lands on `waiting`, and the frame must reach
  // the new phase from there too.
  it('replaces `waiting` for a wait before any content arrived', async () => {
    stubRoutes(
      [
        'event: reconnecting',
        'data: {"attempt":2,"budget":3,"waitSeconds":10,"message":"read timed out"}',
        '',
        'event: token',
        'data: {"text":"at last"}',
        '',
        'event: done',
        'data: {"tokens":4,"took":1.5,"ttft":0.4,"decode":1.1}',
        '',
        '',
      ].join('\n'),
    )
    await armComposer()
    const { seen, stop } = watchPhases()

    await useChat().send()
    stop()

    expect(seen).toEqual(['waiting', 'reconnecting', 'answering', 'idle'])
  })

  // A thinking model flags its thinking with a `reasoning` frame, and that frame
  // means the endpoint answered again — so the wait is over and the phase moves
  // with it. A pill still reading `Reconnecting` while thinking streams would
  // say the opposite of what is happening, which is the confusion spec §5.11
  // rules out. This is the one place where the `reasoning` case's
  // never-downgrade guard had to learn the new phase.
  it('gives way to `reasoning` when the replayed round starts thinking', async () => {
    stubRoutes(
      [
        'event: reconnecting',
        'data: {"attempt":1,"budget":3,"waitSeconds":10,"message":"HTTP 502"}',
        '',
        'event: reasoning',
        'data: {}',
        '',
        'event: reasoning_delta',
        'data: {"text":"thinking hard"}',
        '',
        'event: done',
        'data: {"tokens":4,"took":1.5,"ttft":0.4,"decode":1.1}',
        '',
        '',
      ].join('\n'),
    )
    await armComposer()
    const { seen, stop } = watchPhases()

    await useChat().send()
    stop()

    expect(seen).toEqual(['waiting', 'reconnecting', 'reasoning', 'idle'])
  })

  // The frame is a **progress** event: it never ends the turn, and only the
  // terminal frame puts the phase back to 'idle' (the rule the whole app holds).
  it('keeps the turn in flight through the wait, and ends on its `done` frame', async () => {
    // The wait's frame lands in the first chunk; the turn's `done` is held
    // behind the gate, so the assertion runs while the reply is genuinely still
    // in flight.
    const stream = gatedStream(
      'event: reconnecting\ndata: {"attempt":1,"budget":3,"waitSeconds":10,"message":"HTTP 503"}\n\n',
      'event: done\ndata: {"tokens":4,"took":1.5,"ttft":0.4,"decode":1.1}\n\n',
    )
    stubRoutes('', { chatBody: stream.body })
    await armComposer()
    const turn = useChat().send()

    await vi.waitFor(() => expect(chat.phase).toBe('reconnecting'))
    // The two indicators that must not go quiet mid-turn: the shared predicate
    // behind the tab glyph and the chime, and the bar's pill.
    expect(inferenceRunning({ chat, batch })).toBe(true)
    expect(useChat().chatBusy()).toBe(true)
    // and the turn is still open, so no terminal frame has been read.
    expect(chat.messages[1].streaming).toBe(true)

    stream.release()
    await turn
    expect(chat.phase).toBe('idle')
    expect(chat.messages[1].streaming).toBe(false)
  })

  // Nothing is written into the transcript for a wait (spec §5.13 — asserted
  // here for the phase's own path, so a later change to this case cannot smuggle
  // a marker in beside the phase).
  it('adds no message and no marker to the thread', async () => {
    stubRoutes(
      [
        'event: reconnecting',
        'data: {"attempt":1,"budget":3,"waitSeconds":10,"message":"HTTP 502"}',
        '',
        'event: done',
        'data: {"tokens":4,"took":1.5,"ttft":0.4,"decode":1.1}',
        '',
        '',
      ].join('\n'),
    )
    await armComposer()

    await useChat().send()

    // the one user turn plus the (empty) reply the turn always opens — no third
    // row, no marker in the reply, no error line.
    expect(chat.messages).toHaveLength(2)
    expect(chat.messages[1].role).toBe('assistant')
    expect(chat.messages[1].raw).toBe('')
    expect(chat.error).toBeNull()
  })
})

// -- the two lists answer one question ---------------------------------------

describe('the app bar and the shared predicate cannot drift', () => {
  function pill(wrapper) {
    return wrapper.find('.status-pill')
  }

  // Derived from the exported list rather than transcribed: a phase that joins
  // the list later is covered by this case the moment it joins it, which is what
  // makes this worth more than a test of the one new value (spec §5.12).
  it.each(PHASES_IN_FLIGHT)('keeps the pill lit through the `%s` phase', (phase) => {
    chat.phase = phase
    const wrapper = mount(AppBar)
    const node = pill(wrapper)

    expect(phaseInFlight(phase)).toBe(true)
    expect(node.classes()).not.toContain('status-idle')
    expect(node.text()).not.toBe('idle')
    wrapper.unmount()
  })

  it('reads idle for the phase the list does not name', () => {
    expect(PHASES_IN_FLIGHT).not.toContain('idle')
    chat.phase = 'idle'
    const wrapper = mount(AppBar)
    expect(pill(wrapper).text()).toBe('idle')
    expect(pill(wrapper).classes()).toContain('status-idle')
    wrapper.unmount()
  })

  // The other half of what must not go quiet mid-turn: the browser-tab glyph.
  // It reads the same predicate, so a wait holds ⚡ rather than dropping to ✨
  // while the composer is still locked.
  it('holds the tab glyph through the wait', async () => {
    chat.phase = 'answering'
    useTabTitle()
    await nextTick()
    expect(document.title).toMatch(/^⚡/)

    chat.phase = 'reconnecting'
    await nextTick()
    expect(document.title).toMatch(/^⚡/)

    chat.phase = 'idle'
    await nextTick()
    expect(document.title).toMatch(/^✨/)
  })

  // The label the wait shows, and the wording it must not borrow: `Reconnecting`
  // (spec D6), never the thinking wording — one phase means the endpoint refused
  // and the other means it is thinking, and the two must never be confusable on
  // screen (spec §5.11).
  it('labels the wait `Reconnecting`, not thinking', () => {
    chat.phase = 'reconnecting'
    const wrapper = mount(AppBar)
    const node = pill(wrapper)

    expect(node.text()).toBe('Reconnecting')
    expect(node.text()).not.toContain('thinking')
    expect(node.text()).not.toContain('reasoning')
    // Still lit, on the bar's existing "a reply is running" tone rather than an
    // invented colour: the distinction lives in the label, not the palette.
    expect(node.classes()).toContain('status-reconnecting')
    wrapper.unmount()
  })

  // A running lot keeps its own branch of the pill even during a wait — the
  // lot owns the conversation across the gap between its task turns, and the new
  // phase must not steal that reading.
  it('still reads `Batch` for a lot whose turn is waiting', () => {
    batch.active = true
    batch.status = 'running'
    chat.phase = 'reconnecting'
    const wrapper = mount(AppBar)
    expect(pill(wrapper).text()).toBe('Batch')
    expect(pill(wrapper).classes()).toContain('status-batch')
    wrapper.unmount()
  })

  // The composer stays locked through a wait (spec §5.12) — verified rather than
  // assumed, since the task warns that a phase list hiding in a computed would
  // make it a third copy to keep in step. Send is gone, Stop is live, and the
  // composable's own busy verdict refuses the strip's verbs.
  it('keeps the composer locked through the wait', async () => {
    stubRoutes('')
    await loadAgentModes()
    setAgentMode('code')
    const host = document.createElement('div')
    document.body.appendChild(host)
    const wrapper = mount(WorkBenchInput, { attachTo: host })
    await flushPromises()

    chat.draft.raw = 'a thought not sent yet'
    chat.phase = 'reconnecting'
    await flushPromises()

    expect(wrapper.find('.chat-send:not(.chat-stop)').exists()).toBe(false)
    expect(wrapper.find('.chat-send.chat-stop').exists()).toBe(true)
    expect(useChat().chatBusy()).toBe(true)
    // Staging is refused too, so the wait cannot move the user's uncommitted
    // input anywhere.
    expect(useChat().stage()).toBe(false)
    expect(chat.staged).toEqual([])
    // A hand-made send opens nothing: the flush gate stops it.
    expect(await useChat().send()).toBeUndefined()
    expect(chat.messages).toEqual([])

    wrapper.unmount()
    host.remove()
  })

  // The drift this task exists to prevent, asserted as a source rule: there is
  // **one** list, in `lib/inference-state.js`, and the bar asks that predicate
  // instead of restating the list. Two literals kept in step by hand would make
  // every case above agree by luck rather than by construction — and a phase
  // added later would break one copy silently.
  it('keeps one copy of the phase list in the sources', () => {
    const shared = readFileSync(resolve('src/lib/inference-state.js'), 'utf8')
    const bar = readFileSync(resolve('src/components/AppBar.vue'), 'utf8')
    const composer = readFileSync(resolve('src/components/WorkBenchInput.vue'), 'utf8')

    // The bar imports the verdict and spells no phase list of its own.
    expect(bar).toContain("import { phaseInFlight } from '../lib/inference-state'")
    expect(bar).not.toMatch(/\[[^\]]*'waiting'/)
    expect(bar).not.toMatch(/chat\.phase\s*!==?\s*'idle'/)
    // The list exists once, exported, and it covers the new phase.
    expect(shared.match(/export const PHASES_IN_FLIGHT = \[/g)).toHaveLength(1)
    for (const phase of PHASES_IN_FLIGHT) {
      expect(shared).toContain(`'${phase}'`)
    }
    expect(PHASES_IN_FLIGHT).toContain('reconnecting')

    // The composer's lock is the near-third copy: it asks "is the phase idle?"
    // rather than listing the busy ones, so it cannot go stale when a phase is
    // added — which is why it follows the wait for free and why this scan, not a
    // literal, is what keeps it that way.
    expect(composer).toContain("state.phase !== 'idle'")
    expect(composer).not.toMatch(/\[[^\]]*'waiting'/)
  })
})
