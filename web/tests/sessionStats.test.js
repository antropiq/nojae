import { beforeEach, describe, expect, it, vi } from 'vitest'

import { mount } from '@vue/test-utils'

import SessionClock from '../src/components/SessionClock.vue'
import { useSessionStats } from '../src/composables/useSessionStats'
import { modelInView, useAppShell } from '../src/composables/useAppShell'
import { useAgentModes } from '../src/composables/useAgentModes'
import { useBatch } from '../src/composables/useBatch'
import { useChat } from '../src/composables/useChat'

// Layer 1 (jsdom): the rules behind the app bar's shared meters — which session
// they describe, and when they read blank. They are a composable rather than
// computeds inside AppBar because the app can only ever have one session at a
// time (the WorkBench reply or a batch turn), so one clock and one pair of
// counters serve the whole app. What is asserted here is the resolution, not
// the pixels — the app bar's look stays an e2e concern.
//
// The figures are **the conversation's**, not the reply's: a session continues
// for as long as the thread does, so the meters keep answering after an answer
// has landed, and only the Restart button (useChat's reset) clears them.

const stats = useSessionStats()
const appShell = useAppShell().state
const agentModes = useAgentModes().state
const batch = useBatch().state
const chat = useChat().state

// Two models on two servers, the shape a real install has: an agent's `modelId`
// is the only thing that says which of them a turn runs on, so a meter that
// ignores it reads a cap belonging to another model.
const CATALOGUE = [
  { id: 11, name: 'big-on-hpz', serverName: 'hpz', contextWindow: 524288 },
  { id: 2, name: 'small-on-aipc', serverName: 'aipc', contextWindow: 262144 },
]

const AGENTS = [
  { id: 'code', label: 'Code', modelId: 11, modelName: 'big-on-hpz' },
  { id: 'chat', label: 'Chat', modelId: 2, modelName: 'small-on-aipc' },
  { id: 'bare', label: 'Bare', modelId: null, modelName: null },
]

function reset() {
  // The cap arrives **per model** now (D5), so the fixture is a model list with
  // the window on the entry the meters read.
  appShell.config = {
    models: [{ id: 1, name: 'm', contextWindow: 8192, supportsVision: false }],
    store: { usable: true, sentence: null },
  }
  // The selection is the agent whose model the cap is read off, so the meters
  // need a list to resolve it against. `code` points at the fixture model.
  agentModes.modes = [{ id: 'code', label: 'Code', modelId: 1, modelName: 'm' }]
  agentModes.current = 'code'
  agentModes.loaded = true
  batch.active = false
  batch.status = 'idle'
  batch.pinnedMode = null
  chat.phase = 'idle'
  chat.messages = []
  chat.session.startedAt = 0
  chat.session.spentMs = 0
  chat.session.agentMode = null
}

function runningChat() {
  chat.phase = 'answering'
  chat.session.startedAt = 1000
}

// A finished reply carrying every figure the meters read.
function measuredReply(overrides = {}) {
  return {
    role: 'assistant',
    streaming: false,
    tokens: 100,
    took: 4,
    ttft: 1,
    decode: 3,
    contextTokens: 4000,
    tokensEstimated: false,
    contextEstimated: false,
    ...overrides,
  }
}

describe('useSessionStats: one clock and two counters, whichever session is live', () => {
  beforeEach(reset)

  it('reads blank with no lot and no reply', () => {
    expect(stats.source.value).toBe(null)
    expect(stats.running.value).toBe(false)
    expect(stats.elapsedMs(5000)).toBe(0)
    expect(stats.rateText.value).toBe('— t/s')
    expect(stats.contextText.value).toBe('— ctx')
  })

  it('keeps the figures once the answer has landed, until the conversation is reset', () => {
    runningChat()
    chat.messages = [measuredReply()]
    expect(stats.rateText.value).toBe('33.3 t/s')
    expect(stats.contextText.value).toBe('ctx 4k / 8.2k')

    // The reply ended: it is no longer live, but the conversation it measured is
    // still the one on screen — so the meters hold their answer.
    chat.phase = 'idle'
    chat.session.startedAt = 0
    expect(stats.running.value).toBe(false)
    expect(stats.rateText.value).toBe('33.3 t/s')
    expect(stats.contextText.value).toBe('ctx 4k / 8.2k')

    // Only the conversation being reset (Restart) blanks them again.
    chat.messages = []
    chat.session.spentMs = 0
    expect(stats.rateText.value).toBe('— t/s')
    expect(stats.contextText.value).toBe('— ctx')
  })

  it('counts a chat session from its startedAt, tool rounds included', () => {
    runningChat()
    expect(stats.source.value).toBe('chat')
    expect(stats.elapsedMs(4500)).toBe(3500)
    expect(stats.formatElapsed(stats.elapsedMs(4500))).toBe('00:00:03')
  })

  it('adds a finished turn to the clock instead of dropping it', () => {
    // 2s already banked by an earlier reply, then a turn that ran 1000 → 3500.
    chat.session.spentMs = 2000
    runningChat()
    expect(stats.elapsedMs(3500)).toBe(4500)

    // The turn ended: finish() banked its span and cleared startedAt, so the
    // clock holds the total no matter how long the conversation sits idle.
    chat.phase = 'idle'
    chat.session.startedAt = 0
    chat.session.spentMs = 4500
    expect(stats.running.value).toBe(false)
    expect(stats.elapsedMs(999_999)).toBe(4500)
    expect(stats.formatElapsed(stats.elapsedMs(999_999))).toBe('00:00:04')
  })

  it('keeps a batch lot between two task turns, when the phase is back to idle', () => {
    runningChat()
    chat.phase = 'idle'
    batch.active = true
    expect(stats.source.value).toBe('chat')
    expect(stats.elapsedMs(3000)).toBe(2000)
  })

  it('flags the fill colour as the window fills up', () => {
    runningChat()
    chat.messages = [measuredReply({ tokens: 10, took: 2, decode: 1, contextTokens: 6144 })]
    expect(stats.contextClass.value).toBe('violet')
    expect(stats.contextTitle.value).toContain('75%')
    chat.messages[0].contextTokens = 7400 // 90%: the window is nearly full
    expect(stats.contextClass.value).toBe('red')
  })
})

// ---------------------------------------------------------------------------
// The cap is the **agent's**, not the catalogue's first entry.
//
// `GET /api/config` answers the window per model and names no default, so the
// only thing that says which model a turn runs on is the agent row's `modelId`.
// Reading `models[0]` instead pins the badge to one server whatever the agent is:
// a 256k model shows `ctx 12.4k / 524.3k`, and the ≥70 % / ≥90 % warnings never
// fire because the fill is divided by a window twice as wide as the real one.
// ---------------------------------------------------------------------------

describe('the context cap follows the agent, not the first model of the catalogue', () => {
  beforeEach(() => {
    reset()
    appShell.config = { models: CATALOGUE, store: { usable: true, sentence: null } }
    agentModes.modes = AGENTS
    agentModes.current = 'chat'
  })

  it('reads the selected agent model, and changes with the selection', () => {
    chat.messages = [measuredReply({ contextTokens: 204800 })]
    expect(stats.contextWindow.value).toBe(262144)
    expect(stats.contextText.value).toBe('ctx 204.8k / 262.1k')

    // The reported bug, in one keystroke: the dropdown moved to the other agent.
    agentModes.current = 'code'
    expect(stats.contextText.value).toBe('ctx 204.8k / 524.3k')
  })

  it('fills against the real window, so the warning colour fires', () => {
    // 204800 of 262144 is 78 % of the window the turn runs on — but 39 % of the
    // other model's, which is why the badge used to stay green at the edge.
    chat.messages = [measuredReply({ contextTokens: 204800 })]
    expect(stats.contextFill.value).toBeCloseTo(0.78125, 5)
    expect(stats.contextClass.value).toBe('violet')
    expect(stats.contextTitle.value).toContain('78%')
  })

  // A turn in flight is answered by the agent it was **sent** as, exactly like
  // the brand's `Running <model> on <server>` line beside it: the two halves of
  // the bar cannot name different models for the same stream.
  it('follows the running turn, not a mid-reply agent switch', () => {
    chat.messages = [measuredReply({ contextTokens: 204800 })]
    chat.phase = 'answering'
    chat.session.startedAt = 1000
    chat.session.agentMode = 'chat'

    // The dropdown is moved to the other agent while the reply streams: that
    // change reaches no turn in flight, so the cap stays the running one's.
    agentModes.current = 'code'
    expect(stats.contextText.value).toBe('ctx 204.8k / 262.1k')
  })

  it('reads the agent a running lot was launched with', () => {
    chat.messages = [measuredReply({ contextTokens: 204800 })]
    batch.active = true
    batch.pinnedMode = 'chat'
    // A lot runs every task under its own pin; the selection is not its answer.
    agentModes.current = 'code'
    expect(stats.contextText.value).toBe('ctx 204.8k / 262.1k')
  })

  // The agent row names a model the catalogue no longer holds (deleted in the
  // Settings dialog): there is no window to state, so the badge says `ctx 204.8k`
  // alone. Falling back to another entry is the mistake being fixed here.
  it('states no cap for an agent whose model is gone', () => {
    agentModes.modes = [
      { id: 'ghost', label: 'Ghost', modelId: 99, modelName: 'deleted-model' },
    ]
    agentModes.current = 'ghost'
    chat.messages = [measuredReply({ contextTokens: 204800 })]

    expect(stats.contextWindow.value).toBe(null)
    expect(stats.contextText.value).toBe('ctx 204.8k')
    expect(stats.contextFill.value).toBe(null)
  })
})

describe('modelInView: the agent row is the pointer', () => {
  const config = { models: CATALOGUE }

  it('resolves the agent model by id, whatever its place in the list', () => {
    expect(modelInView(config, AGENTS[0]).id).toBe(11)
    expect(modelInView(config, AGENTS[1]).id).toBe(2)
  })

  it('answers null rather than a stranger for a model the catalogue lost', () => {
    expect(modelInView(config, { id: 'x', modelId: 99 })).toBe(null)
  })

  it('falls back to the first entry only when no agent is named at all', () => {
    // Nothing read yet, or a store with no row: there is no better answer, and
    // the composer refuses the send either way.
    expect(modelInView(config, null).id).toBe(11)
    expect(modelInView(config, AGENTS[2]).id).toBe(11)
  })

  it('answers null for an install with no model', () => {
    expect(modelInView({ models: [] }, AGENTS[0])).toBe(null)
    expect(modelInView(null, AGENTS[0])).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Task 07 — the clock and the wait.
//
// Spec §5.16 and §5.17 in figures: the session total **excludes** the seconds a
// turn spent waiting on a refused endpoint (a 40-minute provider outage must
// not read as a 40-minute session), while the turn's **own span keeps them**
// and states the waited part separately ("took 41 minutes" vs "took 1 minute
// and waited 40"). The token rate is in neither rule and must not move: a wait
// has no chunk arrival, so it enters no decode window.
//
// Asserted on the figures, not the pixels — the caption's look stays an e2e
// concern, exactly like the rest of the meters.
// ---------------------------------------------------------------------------

describe('the wait: excluded from the session total, kept in the turn span', () => {
  beforeEach(reset)

  it('answers no span at all until a turn reports one', () => {
    expect(stats.turnSpan.value).toBe(null)
    expect(stats.turnSpanText.value).toBe('')
  })

  it('keeps the whole span and exposes the waited part separately', () => {
    chat.messages = [measuredReply({ took: 2460, ttft: 30, decode: 25, waited: 2400 })]
    expect(stats.turnSpan.value).toEqual({ span: 2460, waited: 2400 })
    expect(stats.turnSpanText.value).toBe('turn 41m · 40m waited')
    // The tooltip spells out which of the two figures excludes the wait, so the
    // pair cannot be read as the same number twice.
    expect(stats.turnSpanTitle.value).toContain('spent waiting')
    expect(stats.turnSpanTitle.value).toContain('excludes')
  })

  it('says nothing about waiting for a turn that waited nothing', () => {
    chat.messages = [measuredReply({ took: 8.2, waited: 0 })]
    expect(stats.turnSpan.value).toEqual({ span: 8.2, waited: 0 })
    expect(stats.turnSpanText.value).toBe('turn 8s')
  })

  it('reads a payload with no waited key as no wait (an older server)', () => {
    const reply = measuredReply({ took: 90 })
    expect('waited' in reply).toBe(false)
    chat.messages = [reply]
    expect(stats.turnSpan.value).toEqual({ span: 90, waited: 0 })
    expect(stats.turnSpanText.value).toBe('turn 1m 30s')
  })

  it('leaves the token rate untouched: the same tokens over the same decode', () => {
    // One turn waited 40 minutes of a 41-minute span, the other never waited;
    // both generated the same tokens in the same decode window, so both must
    // read the same t/s. The wait is a third category: it enters the turn's
    // span and the session clock's exclusion, and nothing else.
    const unwaited = measuredReply({ tokens: 100, took: 5, ttft: 1, decode: 4 })
    const waited = measuredReply({
      tokens: 100,
      took: 2465,
      ttft: 1,
      decode: 4,
      waited: 2460,
    })

    chat.messages = [unwaited]
    expect(stats.rateText.value).toBe('25.0 t/s')
    const rateOfTheUnwaitedTurn = stats.rate.value.value

    chat.messages = [waited]
    expect(stats.rateText.value).toBe('25.0 t/s')
    expect(stats.rate.value.value).toBe(rateOfTheUnwaitedTurn)
  })

  it('formats a span tersely, since the clock beside it is already hh:mm:ss', () => {
    expect(stats.formatSpan(0)).toBe('0s')
    expect(stats.formatSpan(8.2)).toBe('8s')
    expect(stats.formatSpan(59.6)).toBe('1m')
    expect(stats.formatSpan(122)).toBe('2m 02s')
    expect(stats.formatSpan(2400)).toBe('40m')
    expect(stats.formatSpan(3840)).toBe('01h 04m')
    expect(stats.formatSpan(86_400)).toBe('24h 00m')
  })
})

// The other half of the rule: the composable's own carrying-over must be driven
// by useChat — a turn banks its span when it ends, and reset() is the only thing
// that zeroes the total. Asserted against a stubbed stream so the real start/finish
// path is the thing under test.
describe('useChat keeps the session total across turns', () => {
  function jsonResponse(body, ok = true, status = 200) {
    return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
  }

  function sseBody(text) {
    const bytes = new TextEncoder().encode(text)
    let delivered = false
    return {
      getReader: () => ({
        async read() {
          if (delivered) return { done: true, value: undefined }
          delivered = true
          return { done: false, value: bytes }
        },
      }),
    }
  }

  function stubRoutes() {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const key = String(url)
      if (key.startsWith('/api/agents')) {
        return jsonResponse({
          agents: [
            {
              id: 'code', label: 'Code', mcpEnable: true, lspEnable: true,
              readonly: false, deletable: true, maxToolIteration: 25,
              systemMessage: '', modelId: 1, modelName: 'm',
            },
          ],
          caps: {
            maxIdChars: 32, idPattern: '^[a-z][A-Za-z0-9_-]*$', maxLabelChars: 40,
            maxPersonaBytes: 16384, maxPersonaLines: 16, minToolIteration: 1,
          },
          findings: [],
        })
      }
      if (key.startsWith('/api/chat')) {
        return {
          ok: true,
          body: sseBody(
            'event: done\ndata: {"tokens":12,"took":1.5,"ttft":0.4,"decode":1.1,"contextTokens":900}\n\n',
          ),
        }
      }
      return jsonResponse({})
    })
  }

  beforeEach(async () => {
    reset()
    vi.restoreAllMocks()
    chat.mcp = { connectors: [], enabled: {}, loaded: false, locked: false, restarting: false, error: null }
    chat.lsp = { servers: [], enabled: {}, loaded: false, locked: false, restarting: false, error: null }
    stubRoutes()
    const { useAgentModes } = await import('../src/composables/useAgentModes')
    await useAgentModes().loadAgentModes()
  })

  async function turn(text) {
    const { setDraft, send } = useChat()
    setDraft(text)
    await send()
  }

  // Re-points only the chat route at a scripted stream, leaving the agent list
  // (and every other route) as `stubRoutes` answered them: the turn's `done`
  // payload is the thing under test here.
  function chatStream(frames) {
    const routes = globalThis.fetch.getMockImplementation()
    globalThis.fetch.mockImplementation((url, init) => {
      const key = String(url)
      if (key.startsWith('/api/agents')) return routes(url, init)
      if (key.startsWith('/api/chat')) {
        return { ok: true, body: sseBody(frames) }
      }
      return jsonResponse({})
    })
  }

  const DONE = (payload) => `event: done\ndata: ${payload}\n\n`
  const TOKEN = (text) => `event: token\ndata: {"text":"${text}"}\n\n`

  it('banks a turn with no wait at all as exactly its span', async () => {
    // The shape before this feature, restated so the exclusion is proven to
    // change only the waited case: no key, `waited: 0`, both bank the span.
    chatStream(DONE('{"tokens":12,"took":1.5,"ttft":0.4,"decode":1.1,"waited":0}'))
    const now = vi.spyOn(Date, 'now').mockReturnValue(99_000)
    now.mockReturnValueOnce(10_000).mockReturnValueOnce(11_500)
    await turn('no wait')
    expect(chat.session.spentMs).toBe(1500)
  })

  it('banks the span less the seconds the turn waited on the endpoint', async () => {
    // spec §5.16: a 41-minute turn that spent 40 of them waiting on a refused
    // endpoint credits the conversation with 1 minute, not 41 — a provider
    // outage is not a session.
    chatStream(
      TOKEN('late but fine') +
        DONE('{"tokens":12,"took":2460.0,"ttft":0.4,"decode":1.1,"waited":2400.0}'),
    )
    // Three reads of the scripted clock: opening the turn (startedAt), the
    // streamed chunk's generation window, and finish()'s span.
    const now = vi.spyOn(Date, 'now').mockReturnValue(99_000)
    now
      .mockReturnValueOnce(10_000)
      .mockReturnValueOnce(610_000)
      .mockReturnValueOnce(2_470_000)
    await turn('outage')

    expect(chat.session.spentMs).toBe(60_000) // 2460s of span − 2400s of wait
    // The same turn's own figures keep the wait and say it separately (§5.17),
    // and the clock's total is what excludes it.
    expect(stats.turnSpan.value).toEqual({ span: 2460, waited: 2400 })
    expect(stats.turnSpanText.value).toBe('turn 41m · 40m waited')
    expect(stats.elapsedMs(99_000)).toBe(60_000)
    // The clock reads the excluded total, and the turn line beside it keeps the
    // whole span: the two readings the spec refuses to let be conflated.
    expect(stats.formatElapsed(stats.elapsedMs(99_000))).toBe('00:01:00')
  })

  it('banks the whole span when the payload carries no waited key (older server)', async () => {
    // `waited` must read as 0 and not as `undefined`, or the bank would be NaN.
    chatStream(DONE('{"tokens":12,"took":1.5,"ttft":0.4,"decode":1.1}'))
    const now = vi.spyOn(Date, 'now').mockReturnValue(99_000)
    now.mockReturnValueOnce(20_000).mockReturnValueOnce(21_500)
    await turn('old server')
    expect(chat.session.spentMs).toBe(1500)
  })

  it('banks a paused turn its whole span too — no frame reported a wait for it', async () => {
    // spec §5.15 puts `waited` on `done` only, and a paused turn ends on
    // `pause_ack` instead. So the bank is the span with `waited` read as 0:
    // a decision, not an oversight — the app cannot know what that turn
    // waited, and inventing a figure would be worse.
    chatStream(
      TOKEN('interrupted mid-way') + 'event: pause_ack\ndata: {"paused":true}\n\n',
    )
    const now = vi.spyOn(Date, 'now').mockReturnValue(99_000)
    now.mockReturnValueOnce(30_000).mockReturnValueOnce(31_000).mockReturnValueOnce(33_000)
    await turn('paused')
    expect(chat.session.spentMs).toBe(3000)
    // The partial turn is kept in the conversation, and it reported no span.
    expect(chat.messages.some((m) => m.role === 'assistant' && m.paused)).toBe(true)
    expect(stats.turnSpanText.value).toBe('')
  })

  it('banks a stopped turn its whole span, since no frame told it what it waited', async () => {
    // A turn cut short before its `done` frame: the app cannot know what it
    // waited, so it banks the raw span — an honest 0 rather than an invented
    // figure. Nothing is subtracted from a number nobody reported.
    chatStream(TOKEN('half an answer'))
    const now = vi.spyOn(Date, 'now').mockReturnValue(99_000)
    now.mockReturnValueOnce(10_000).mockReturnValueOnce(12_000).mockReturnValueOnce(14_000)
    await turn('no terminal frame')
    expect(chat.session.spentMs).toBe(4000)
    // No `done` frame means no reported span either, so the turn line stays out.
    expect(stats.turnSpanText.value).toBe('')
  })

  it('leaves the token rate exactly where a wait does not reach it', async () => {
    // The same generation figures, waited and unwaited: the badge reads the
    // same t/s, because `decode` never contains a wait (task 04) and this task
    // changes no rate arithmetic.
    chatStream(DONE('{"tokens":100,"took":5,"ttft":1,"decode":4,"waited":0}'))
    await turn('plain')
    expect(stats.rateText.value).toBe('25.0 t/s')

    chatStream(
      TOKEN('x') + DONE('{"tokens":100,"took":2465,"ttft":1,"decode":4,"waited":2460}'),
    )
    await turn('waited')
    expect(stats.rateText.value).toBe('25.0 t/s')
  })

  it('banks a failed turn once, even though finish() runs twice on that path', async () => {
    // A refused send finishes in the error branch *and* again in `finally`; the
    // clock must not charge the same span twice.
    const agentsRoute = globalThis.fetch.getMockImplementation()
    globalThis.fetch.mockImplementation((url, init) => {
      const key = String(url)
      if (key.startsWith('/api/agents')) return agentsRoute(url, init)
      return jsonResponse({ detail: 'server said no' }, false, 500)
    })

    const now = vi.spyOn(Date, 'now').mockReturnValue(99_000)
    now.mockReturnValueOnce(10_000).mockReturnValueOnce(11_000)
    await turn('doomed')
    expect(chat.session.spentMs).toBe(1000)

    now.mockReturnValueOnce(12_000).mockReturnValueOnce(13_000)
    await turn('also doomed')
    expect(chat.session.spentMs).toBe(2000)
  })

  it('banks each finished turn, and only reset() clears the total', async () => {
    // A scripted clock so each turn's span is exact: one read when the turn
    // opens (startedAt), one when it ends (the span banked). The extra
    // `mockReturnValue` is what a third read would see.
    const now = vi.spyOn(Date, 'now').mockReturnValue(99_000)

    now.mockReturnValueOnce(10_000).mockReturnValueOnce(11_500)
    await turn('first')
    expect(chat.session.startedAt).toBe(0) // the turn ended
    expect(chat.session.spentMs).toBe(1500)
    expect(stats.rateText.value).toBe('10.9 t/s')

    now.mockReturnValueOnce(20_000).mockReturnValueOnce(23_000)
    await turn('second')
    // The second turn did not start over: its 3s were added to the first's.
    expect(chat.session.spentMs).toBe(4500)
    expect(stats.elapsedMs(99_000)).toBe(4500)
    expect(stats.contextText.value).toBe('ctx 900 / 8.2k')

    // Only the conversation being restarted zeroes the meters.
    useChat().reset()
    expect(chat.session.spentMs).toBe(0)
    expect(chat.session.startedAt).toBe(0)
    expect(stats.elapsedMs(99_000)).toBe(0)
    expect(stats.rateText.value).toBe('— t/s')
    expect(stats.contextText.value).toBe('— ctx')
  })

  it('a loaded session starts the meters over, since its timings are not in the file', async () => {
    // A conversation that already spent time, about to be replaced by a file.
    chat.session.spentMs = 5000
    chat.messages = [measuredReply()]

    const loaded = useChat().loadSession({
      messages: [{ role: 'user', content: 'restored' }],
      agentMode: null,
    })
    expect(loaded.restored).toBe(1)

    // The restored turns carry no figures, so the meters read blank rather than
    // crediting them with the previous conversation's total.
    expect(chat.session.spentMs).toBe(0)
    expect(chat.session.startedAt).toBe(0)
    expect(stats.elapsedMs(99_000)).toBe(0)
    expect(stats.rateText.value).toBe('— t/s')
    expect(stats.contextText.value).toBe('— ctx')
  })
})

// The clock renders **its digits alone**: the turn-span caption that used to sit
// under them made the actions row taller than the app bar, so it is gone from
// the bar. The figures behind it (spec §5.17) are still the composable's answer
// and still asserted above — this test only guards that the bar no longer draws
// them.
describe('the app bar clock renders the digits alone', () => {
  function mountClock() {
    const wrapper = mount(SessionClock)
    return {
      wrapper,
      clock: () => wrapper.get('.session-clock').text().trim(),
    }
  }

  it('renders no caption while no turn has reported a span', () => {
    reset()
    const view = mountClock()
    expect(view.clock()).toBe('00:00:00')
    expect(view.wrapper.find('.session-clock-turn').exists()).toBe(false)
    view.wrapper.unmount()
  })

  it('still renders no caption once a turn has reported a span', async () => {
    reset()
    chat.messages = [measuredReply({ took: 2460, ttft: 30, decode: 25, waited: 2400 })]
    chat.session.spentMs = 60_000 // that 2460s turn banked 60s of it
    const view = mountClock()
    await view.wrapper.vm.$nextTick()
    expect(view.clock()).toBe('00:01:00')
    expect(view.wrapper.find('.session-clock-turn').exists()).toBe(false)
    view.wrapper.unmount()
  })
})
