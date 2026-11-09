import { beforeEach, describe, expect, it } from 'vitest'

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

const stats = useSessionStats()
const appShell = useAppShell().state
const batch = useBatch().state
const chat = useChat().state

function reset() {
  appShell.config = { contextWindow: 8192 }
  batch.active = false
  batch.status = 'idle'
  chat.phase = 'idle'
  chat.messages = []
  chat.session.startedAt = 0
}

function runningChat() {
  chat.phase = 'answering'
  chat.session.startedAt = 1000
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

  it('goes blank again when the session ends, instead of keeping the figures', () => {
    runningChat()
    chat.messages = [
      {
        role: 'assistant',
        streaming: false,
        tokens: 100,
        took: 4,
        ttft: 1,
        decode: 3,
        contextTokens: 4000,
        tokensEstimated: false,
        contextEstimated: false,
      },
    ]
    expect(stats.rateText.value).toBe('33.3 t/s')
    expect(stats.contextText.value).toBe('ctx 4k / 8.2k')

    chat.phase = 'idle'
    chat.session.startedAt = 0
    expect(stats.rateText.value).toBe('— t/s')
    expect(stats.contextText.value).toBe('— ctx')
  })

  it('counts a chat session from its startedAt, tool rounds included', () => {
    runningChat()
    expect(stats.source.value).toBe('chat')
    expect(stats.elapsedMs(4500)).toBe(3500)
    expect(stats.formatElapsed(stats.elapsedMs(4500))).toBe('00:00:03')
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
    chat.messages = [
      {
        role: 'assistant',
        streaming: false,
        tokens: 10,
        took: 2,
        ttft: 1,
        decode: 1,
        contextTokens: 6144, // 75% of the window: the warning band
        tokensEstimated: false,
        contextEstimated: false,
      },
    ]
    expect(stats.contextClass.value).toBe('violet')
    expect(stats.contextTitle.value).toContain('75%')
    chat.messages[0].contextTokens = 7400 // 90%: the window is nearly full
    expect(stats.contextClass.value).toBe('red')
  })
})
