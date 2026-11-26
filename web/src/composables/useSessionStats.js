import { computed } from 'vue'
import { liveTokenRate, useChat } from './useChat'
import { modelInView, useAppShell } from './useAppShell'
import { useBatch } from './useBatch'
import { currentMode, modeById } from './useAgentModes'
import { inferenceRunning, phaseInFlight } from '../lib/inference-state'

// ---------------------------------------------------------------------------
// The session meters: one elapsed clock, two counters (token rate, context
// occupancy) and one caption stating the last turn's own span. The app can only
// ever have one session at a time — the WorkBench reply or a batch turn, and a
// batch lot owns the conversation across the gap between its turns — so the app
// bar shows a single clock and a single pair of counters.
//
// **The figures outlive the reply they describe.** A session continues as long
// as the conversation does, so every computed here reads the conversation's
// carried-over values (the clock's `spentMs`, the last measured reply, the newest
// occupancy figure) rather than blanking when an answer lands; only the Restart
// button — `useChat`'s reset() — clears them. `running` stays "an inference is in
// flight right now" and is used for the clock's emphasis and the labels, never to
// hide a figure.
//
// "Is anything running at all" is the shared inferenceRunning() predicate — the
// one the tab glyph and the end-of-session chime read too — so the meters, the
// ⚡/✨ title and the chime cannot disagree about a session.
//
// Nothing here owns state: every computed reads the useChat / useAppShell /
// useBatch singletons, which is what keeps the meters advancing while the user
// looks at another tab (the tab views are `v-show`n, and the values never come
// from the visible one).
// ---------------------------------------------------------------------------

const { state: chatState } = useChat()
// Only for `config`, the `/api/config` read the app shell holds: the occupancy
// badge needs the context-window cap, and that cap arrives **per model**, so it
// is read off the model in view.
const { state: shellState } = useAppShell()
const { state: batchState } = useBatch()

// 'chat' | null — which session is **live right now**; a batch lot counts as
// 'chat', since its turns stream through useChat (the lot keeps the answer true
// across the gap between two task turns, where the chat phase is briefly back to
// 'idle'). `null` means nothing is generating. Emphasis and labelling only: the
// figures below keep describing the conversation's finished turns, because the
// conversation is still the one they measured.
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
// thinking and every tool round included, but **not the seconds a turn spent
// waiting on a refused endpoint**: useChat's finish() banks `span − waited`
// rather than the raw span, because a wait is neither inference nor thinking and
// a 40-minute provider outage must not read as a 40-minute session. The open turn
// counts wall time until it banks, since the wait it will spend is not known yet.
//
// `startedAt` is itself the "a turn is open" marker: startTurn() sets it and only
// finish() (which banks the span) or reset() (which drops it) clears it. Asking
// `running` as well would make the digits drop for the instant between a
// `pause_ack` (phase back to idle) and the stream closing.
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

// -- the turn span -----------------------------------------------------------

// The app bar's turn-span pair, next to the clock: the conversation is where the
// clock already answers "how long", the reply card carries its own status
// captions (cut-short, interrupted), a wait appears nowhere in the transcript,
// and the meters' neighbourhood is the only place the app tells the user how long
// one turn took. `waited` arrives with `took` on the same frame.
//
// The newest reply that reported a span (`took`, off its `done` frame), the same
// carried-over reading the rate badge uses: it holds between turns and is cleared
// by reset() with the rest. A turn still streaming but past its `done` frame
// counts too, so the figure does not flicker back to the previous turn while the
// stream closes. A turn that never got a `done` frame (Stop, an abort, a dropped
// connection) reported no span, so it is skipped rather than invented.
function lastMeasuredSpan() {
  return (
    [...chatState.messages]
      .reverse()
      .find((m) => m.role === 'assistant' && (m.took || 0) > 0) ?? null
  )
}

// `{ span, waited }` in seconds, `waited` always a number (a payload from an
// older server, or a paused turn whose `pause_ack` carries no `waited`, reads as
// no wait). `span` is the **whole request, waiting included** — the figure that
// answers "this turn took 41 minutes" — and `waited` is what separates it from
// "took 1 minute and waited 40".
const turnSpan = computed(() => {
  const message = lastMeasuredSpan()
  if (!message) return null
  return { span: message.took, waited: message.waited || 0 }
})

// Terse wall-clock shape for a turn's figures: `8s`, `2m 02s`, `40m`, `1h 04m`.
// The clock's own `formatElapsed` is `hh:mm:ss`, right for a running total and too
// wide for a figure beside it. Each unit is stated once and a zero unit left out,
// so a 40-minute wait reads `40m` rather than `40m 00s`; the stated parts are
// padded, the way the clock's digits are.
function formatSpan(seconds) {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total}s`
  const mins = Math.floor(total / 60)
  const secs = String(total % 60).padStart(2, '0')
  if (mins < 60) return total % 60 ? `${mins}m ${secs}s` : `${mins}m`
  // Past an hour the minutes are always stated: dropping a zero minute unit
  // there would lose a real figure (`1h 04m` must not read as `1h`).
  const hours = String(Math.floor(mins / 60)).padStart(2, '0')
  return `${hours}h ${String(mins % 60).padStart(2, '0')}m`
}

// The pair as one short line: `turn 41m · 40m waited`. The wait segment appears
// only when the turn actually waited, and the whole element is absent when no
// turn has reported a span.
const turnSpanText = computed(() => {
  const turn = turnSpan.value
  if (!turn) return ''
  const head = `turn ${formatSpan(turn.span)}`
  return turn.waited > 0 ? `${head} · ${formatSpan(turn.waited)} waited` : head
})

const turnSpanTitle = computed(() =>
  turnSpan.value
    ? 'The last WorkBench turn: its whole span — endpoint waits, thinking and every tool round included — and the part of it spent waiting on a refused endpoint. The clock above excludes that waiting; this figure keeps it.'
    : 'No turn has reported its span yet.',
)

// -- token rate --------------------------------------------------------------

// tokens / decode window. The server-side `decode` (cumulative generation
// seconds across all tool rounds, tool execution and re-prefill gaps excluded) is
// the preferred denominator; `took - ttft` only backs up payloads without it (old
// servers — no tool rounds there, so the window is exact). `waited` is in none of
// it: a wait has no chunk arrival and enters neither the decode window nor the
// estimate, so the rate is the same figure waited or not.
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

// Which agent's model the cap is read off — the same question the brand's
// `Running <model> on <server>` line answers, and answered the same way: the
// agent the turn in flight was **sent** as, not the composer's current selection.
// A lot is asked of its own pin, which is the agent every task of it carries.
// With nothing running, the answer is the selection, because that is the model
// the next turn will land on.
function modeInPlay() {
  if (batchState.active) return modeById(batchState.pinnedMode)
  if (phaseInFlight(chatState.phase)) {
    return modeById(chatState.session.agentMode)
  }
  return currentMode()
}

const contextWindow = computed(
  () => modelInView(shellState.config, modeInPlay())?.contextWindow ?? null,
)

// Context-window occupancy: the LAST round's prompt + completion (exactly what
// the server slots into its window — template, tool schemas and thinking-round
// history included), never summed across rounds or turns. Fed by `done`, refreshed
// between tool rounds by `usage`; the cap comes from /api/config (meta.n_ctx). It
// is read from the newest reply that reported one, so it survives the end of the
// turn — the window keeps holding that conversation until the conversation is
// reset.
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
    turnSpan,
    turnSpanText,
    turnSpanTitle,
    formatSpan,
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
