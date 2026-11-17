import { computed } from 'vue'
import { liveTokenRate, useChat } from './useChat'
import { modelInView, useAppShell } from './useAppShell'
import { useBatch } from './useBatch'
import { inferenceRunning } from '../lib/inference-state'

// ---------------------------------------------------------------------------
// The session meters: one elapsed clock and two counters (token rate, context
// occupancy). One source of truth, because the app can only ever have one
// session at a time: the WorkBench reply or a batch turn, and a batch lot owns
// the conversation across the gap between its turns. The Editor tab stays open
// read-only while one runs. So the app bar can show a single clock and a single
// pair of counters.
//
// **The figures outlive the reply they describe.** A session continues as long
// as the conversation does: the user asks again, and the meters must still
// answer "how fast, how full, how long" about the turns already spent rather
// than blanking every time an answer lands. So every computed here reads the
// conversation's carried-over values (the clock's `spentMs`, the last measured
// reply, the newest occupancy figure) and only the Restart button — `useChat`'s
// reset() — clears them. `running` stays "an inference is in flight right now"
// and is used for the clock's emphasis and the labels, never to hide a figure.
//
// "Is anything running at all" is the shared inferenceRunning()
// predicate — the one the tab glyph and the end-of-session chime read too — so
// the meters, the ⚡/✨ title and the chime cannot disagree about a session.
//
// Nothing here owns state: every computed reads the useChat / useAppShell /
// useBatch singletons, which is what keeps the meters advancing while the user
// looks at another tab (the tab views are `v-show`n, and the values never come
// from the visible one).
// ---------------------------------------------------------------------------

const { state: chatState } = useChat()
// Only for ``config``, the ``/api/config`` read the app shell holds: the
// occupancy badge needs the context-window cap and nothing else, and that cap
// arrives **per model** (D5) -- so it is read off the model in view.
const { state: shellState } = useAppShell()
const { state: batchState } = useBatch()

// 'chat' | null — which session is **live right now**; a batch lot counts as
// 'chat', since its turns stream through useChat (and the lot keeps the answer
// true across the gap between two task turns, where the chat phase is briefly
// back to 'idle'). `null` means nothing is generating. It is an emphasis and
// labelling answer only: the figures below keep describing the conversation's
// finished turns, because the conversation is still the one they measured.
const source = computed(() => {
  if (
    inferenceRunning({
      chat: chatState,
      batch: batchState,
    })
  ) {
    return 'chat'
  }
  return null
})

const running = computed(() => source.value !== null)

// -- clock -------------------------------------------------------------------

// Elapsed milliseconds of the conversation at instant `now` (the component
// driving the display owns the ticking): every reply already banked in
// `session.spentMs`, plus the open one counted from `session.startedAt` —
// covering waiting, thinking and every tool round.
//
// `startedAt` is itself the "a turn is open" marker: startTurn() sets it and
// only finish() (which banks the span) or reset() (which drops it) clears it.
// So there is no need to ask `running` as well — and asking it would make the
// digits drop for the instant between a `pause_ack` (phase back to idle) and
// the stream closing, which is exactly the kind of flicker the clock should
// never show.
function elapsedMs(now) {
  const session = chatState.session
  const spent = Math.max(session.spentMs || 0, 0)
  if (session.startedAt > 0) {
    return spent + Math.max(now - session.startedAt, 0)
  }
  return spent
}

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const parts = [Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60]
  return parts.map((n) => String(n).padStart(2, '0')).join(':')
}

// -- token rate --------------------------------------------------------------

// tokens / decode window. The server-side `decode` (cumulative generation
// seconds across all tool rounds, tool execution and re-prefill gaps excluded)
// is the preferred denominator; `took - ttft` only backs up payloads without it
// (old servers — where there were no tool rounds, so the window is exact).
function exactRate(message) {
  const secs = message.decode > 0 ? message.decode : message.took - message.ttft
  return secs > 0 ? message.tokens / secs : null
}

// The last assistant reply that finished with usable figures — what the badge
// rests on between two turns of a conversation.
function lastMeasuredReply() {
  return (
    [...chatState.messages]
      .reverse()
      .find(
        (m) =>
          m.role === 'assistant' &&
          !m.streaming &&
          m.tokens > 0 &&
          exactRate(m) !== null,
      ) ?? null
  )
}

// The reply in flight always wins (its live figure beats a banked one), and the
// last measured reply answers between turns — so the badge keeps reporting the
// conversation's speed until the conversation itself is reset.
const rate = computed(() => {
  const active = chatState.messages.find((m) => m.streaming) ?? null
  if (active) {
    // `done` already arrived but the stream is still closing: exact figures.
    if (active.tokens) {
      const value = exactRate(active)
      if (value !== null) return { value, estimated: active.tokensEstimated }
    }
    // Still generating: the live rate covers the reasoning phase as well as
    // the answer (see liveTokenRate), so the badge ticks while the model
    // thinks instead of freezing on the previous reply's figure.
    const live = liveTokenRate(active)
    if (live) return live
  }
  const finished = lastMeasuredReply()
  if (finished) {
    return { value: exactRate(finished), estimated: finished.tokensEstimated }
  }
  return null
})

const rateText = computed(() =>
  rate.value
    ? `${rate.value.estimated ? '≈ ' : ''}${rate.value.value.toFixed(1)} t/s`
    : '— t/s',
)

const rateTitle = computed(() =>
  'Generation speed of the last measured WorkBench reply (decode time only — tool execution excluded). Kept until the conversation is restarted.',
)

// -- context occupancy -------------------------------------------------------

const contextWindow = computed(
  () => modelInView(shellState.config)?.contextWindow ?? null,
)

// Context-window occupancy: the LAST round's prompt + completion (exactly what
// the server slots into its window — template, tool schemas and thinking-round
// history included), never summed across rounds/turns. Fed by `done`,
// refreshed between tool rounds by `usage`; the cap comes from /api/config
// (meta.n_ctx). It is read from the newest reply that reported one, so it
// survives the end of the turn — the window keeps holding that conversation
// until the conversation is reset.
const contextUsage = computed(() => {
  for (let i = chatState.messages.length - 1; i >= 0; i -= 1) {
    const message = chatState.messages[i]
    if (message.role === 'assistant' && message.contextTokens > 0) {
      return { tokens: message.contextTokens, estimated: message.contextEstimated }
    }
  }
  return null
})

function formatTokens(n) {
  return n >= 1000 ? `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k` : `${n}`
}

const contextFill = computed(() => {
  const usage = contextUsage.value
  if (!usage) return null
  return contextWindow.value ? usage.tokens / contextWindow.value : null
})

const contextText = computed(() => {
  const usage = contextUsage.value
  if (!usage) return '— ctx'
  const cap = contextWindow.value
  return (
    `${usage.estimated ? '≈ ' : ''}ctx ${formatTokens(usage.tokens)}` +
    (cap ? ` / ${formatTokens(cap)}` : '')
  )
})

const contextTitle = computed(() => {
  const head =
    'Tokens in the model context window (last round: prompt + generation, tool schemas included). Kept until the conversation is restarted.'
  const fill = contextFill.value
  if (fill === null) return head
  return `${head} ${
    fill > 0 && fill < 0.01
      ? '<1% of the window used.'
      : `${Math.round(fill * 100)}% of the window used.`
  }`
})

const contextClass = computed(() => {
  const fill = contextFill.value
  if (fill === null) return contextUsage.value ? 'green' : 'gray'
  if (fill >= 0.9) return 'red'
  if (fill >= 0.7) return 'violet'
  return 'green'
})

export function useSessionStats() {
  return {
    source,
    running,
    elapsedMs,
    formatElapsed,
    rate,
    rateText,
    rateTitle,
    contextWindow,
    contextUsage,
    contextFill,
    contextText,
    contextTitle,
    contextClass,
  }
}
