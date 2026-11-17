import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useSessionStats } from '../src/composables/useSessionStats'
import { useAppShell } from '../src/composables/useAppShell'
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
const batch = useBatch().state
const chat = useChat().state

function reset() {
  // The cap arrives **per model** now (D5), so the fixture is a model list with
  // the window on the entry the meters read.
  appShell.config = {
    models: [{ id: 1, name: 'm', contextWindow: 8192, supportsVision: false }],
    store: { usable: true, sentence: null },
  }
  batch.active = false
  batch.status = 'idle'
  chat.phase = 'idle'
  chat.messages = []
  chat.session.startedAt = 0
  chat.session.spentMs = 0
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
