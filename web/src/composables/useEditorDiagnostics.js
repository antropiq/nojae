import { computed, effectScope, reactive, watch } from 'vue'

import { diagnosticCounts, markersForDiagnostics } from '../lib/monaco-lsp'
import { useChat } from './useChat'
import { useEditorFiles } from './useEditorFiles'
import { registerReRootHandler } from './useWorkspaceTree'
import { withWorkspace } from './useWorkspaceSession'

// ---------------------------------------------------------------------------
// The Editor pane's diagnostics: the one question — *what does the workspace's
// language server report for this buffer?* — and the two guards that keep a
// wrong answer off the screen.
//
// The answer is `POST /api/lsp/query`'s `diagnostics` action: it syncs the
// document and then reads the hub's per-session inbox without waiting, so a cold
// file answers "not analysed yet" and a later ask answers the problems. The route
// and the envelope are untouched here; this module reads one action and shapes
// the three states the bar exists for.
//
// It has **its own state and its own token**, not `useEditorLsp`'s: that one
// keeps a single answer for one *gesture* and drops an older in-flight answer on
// purpose, which is right for Ctrl+click and wrong for a refresh loop, which
// would cancel a definition request the user is waiting on.
//
// The three states, never to be confused:
//
//   * **`no_server`** — nothing will ever analyse this file, and `reason` holds
//     the hub's own sentence saying so. No items, no marks.
//   * **`unknown`** — *not analysed yet*. `analysing` says a request is in
//     flight; with no request in flight it is still unknown, never clean: an
//     empty squiggle set is a claim about the code and may only be made when an
//     analysis was actually reached.
//   * **`analysed`** — an item list, possibly empty, and that emptiness is a
//     verdict.
//
// **The two guards**, both required and independent:
//
//   * *The client token.* Stamped on send, checked on arrival, bumped whenever
//     the buffer being asked about changes — so a late answer can never
//     overwrite a newer one, and an answer that lost its token is not stored,
//     not painted and not counted.
//   * *The answer's version.* An answer describing text older than what has
//     already been accepted for this buffer is discarded, by the rule
//     `core/lsphub/editor.py` states: a strictly older version loses, an equal
//     version is the same analysis, and a version either side did not give
//     cannot be compared — so it is accepted rather than guessed at. It is
//     deliberately **not** "does the answer's version equal the document's
//     current version": the shared sync bumps that version on every ask, so that
//     comparison would call every good answer stale.
//
// A dropped answer changes nothing it cannot improve: the held verdict stays
// held, because the only answer that can be stale is older than it. `analysing`
// stays true across the drop all the same — the analysis on screen then
// describes text that is no longer there, and the honest reading is still *we do
// not know yet*. The next trigger, or the bar's own re-check, clears it.
//
// **Whole replacement.** An accepted answer's marker set is built by
// `lib/monaco-lsp.js`'s `markersForDiagnostics` and never shaped here: it
// replaces the previous set whole, which is what makes a fixed defect's
// underline go away. No merging, no diffing.
//
// **A memory keyed by path.** A model swap drops its marks with it, so an answer
// must be *re-applied* when a buffer comes back on screen rather than remembered
// once. Only a real verdict is remembered — a "not analysed yet" answer is not,
// or a buffer would never be asked about again. A buffer that leaves the strip
// takes its entry with it (a per-open-buffer cache, not a document store), and a
// new working location empties the whole memory and drops an answer still in
// flight, through the same keyed `registerReRootHandler` registry the buffers
// and the search results use.
//
// **Every answer is quiet.** No server, switched off, errored, not-yet-analysed,
// an unreachable API and a refused request are a sentence or a silence, never a
// notice, never a dialog, never an error state.
//
// **The four triggers, and no others.** A refresh happens when (1) the buffer
// becomes the one on screen, (2) edits settle after the one quiet period below,
// (3) a save completes, and (4) the user presses the bar's re-check. In
// particular there is **no interval, no poll and no timer** other than the
// settling one, nothing is refreshed while no buffer is on screen (a diff tab, a
// preview, an empty pane have no text to analyse), and a streaming chat reply is
// not a trigger — this is a read that stays legal while a reply streams.
//
// Trigger one films the pane's own notion of the active buffer, not a DOM event:
// a chip click, a tree click, an arrow key on the strip, a close that reveals
// its neighbour and a reload all change that one value. When the new buffer's
// analysis is already held the answer is *re-applied* from the memory, which
// asks for nothing.
//
// Triggers two and three read signals the buffer record already carries, so no
// second copy of the text, of the dirty flag or of a save's outcome exists here:
// `editedAt` rises in `useEditorFiles.updateText` for a real edit only — a
// counter, not a second dirty flag, which is what a debounce needs — and
// `savedAt` rises in the one place a save is *confirmed*, so save-all, a
// conflict resolution and save-and-close all fire it while a refused save fires
// nothing.
//
// **The bar reads, this module answers.** The problem count and the
// `analysing…` word are the bar's *fields*, so their wording lives in the
// component; what lives here is what they are read from — the state's own
// `status`/`items` (counted by `lib/monaco-lsp.js`'s one counting function, so
// the number and the underlines cannot disagree) and `analysing`, which is not
// a fourth state. `shownOnScreen` is the guard that keeps any field from
// describing a buffer that is no longer on screen.
// ---------------------------------------------------------------------------

/** How long edits must be quiet before they are analysed.
 *
 * Named and exported because it is *the* timing constant of this feature: the
 * settling period is the only debounce, and nothing else here measures time. A
 * test may shorten it (fake timers or a smaller value).
 */
export const DIAGNOSTICS_SETTLE_MS = 400

const state = reactive({
  // The buffer these fields describe, from `ask()` or `reapply()`.
  path: null,
  // 'unknown' | 'no_server' | 'analysed' — the three states, and no fourth.
  status: 'unknown',
  // The accepted answer's items, whole, and the marker set built from them.
  items: [],
  markers: [],
  // The document version the accepted answer belongs to, and how many items the
  // server's cap hid. Both `null`/`0` while there is no verdict.
  version: null,
  suppressed: 0,
  // One short sentence when there is nothing to show and there is something to
  // say: the no-server reason, or why an ask answered nothing.
  reason: null,
  // An answer is awaited for `path`.
  analysing: false,
})

// The accepted analysis per open buffer: `{ items, markers, version, suppressed }`.
// Keyed by workspace-relative path, bounded by the tab strip (see the pruner
// below), emptied by a working-location switch.
const memory = reactive({})

// The answer above belongs to one question, so it has its own token — not
// `useEditorLsp`'s, and not `useEditorStatus`'s. Stamped on send, checked on
// arrival, bumped by `clear()`, by `reapply()` on a different buffer and by
// `ask()` itself.
let token = 0

// The path of the request currently in flight, or `null`. Kept beside the token
// so `reapply()` can tell a switch to another buffer (drop the answer) from a
// re-application of the same one (leave it alone).
let askedPath = null

// Bump the token, and forget which request it belonged to.
function supersede() {
  token += 1
  askedPath = null
}

// The quiet envelope for a read that never produced one: an unreachable API, a
// refusal, a body that was not JSON. The wire's own shape, so every caller
// treats "no answer" and "no server" alike — and one short reason, because a
// field has room for one clause.
function quietAnswer(reason) {
  return { status: 'no_server', server: null, reason, action: 'diagnostics', result: null }
}

// The conversation-scoped allowlist, read from the Tools panel's own state —
// the same rule `useEditorLsp` and `useEditorStatus` read, from the same single
// source: `null` means "send no filter" (a failed snapshot must not blind the
// pane), otherwise the ids whose switch is on.
function allowedServerIds() {
  const lsp = useChat().state.lsp
  if (!lsp.loaded) return null
  return Object.keys(lsp.enabled).filter((id) => lsp.enabled[id])
}

// One request, one answer, no retry and no throw. A `starting` answer is *not*
// retried here: the pane's four triggers are what asks again, and a retry delay
// would be a second timing constant in a feature that has exactly one.
async function post(path, text) {
  const body = { action: 'diagnostics', path }
  // The buffer is the source of truth: unsaved edits are analysed as written, so
  // the text travels only when the caller's record says the buffer is dirty. A
  // clean buffer omits it and the hub reads the file.
  if (typeof text === 'string') body.text = text
  const allowed = allowedServerIds()
  if (allowed !== null) body.lspEnabled = allowed
  let res
  let answer = null
  try {
    res = await fetch(withWorkspace('/api/lsp/query'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    answer = await res.json().catch(() => null)
  } catch {
    return quietAnswer('the API could not be reached')
  }
  if (!res.ok) {
    return quietAnswer(
      typeof answer?.detail === 'string' && answer.detail
        ? answer.detail
        : `the query was refused (${res.status})`,
    )
  }
  return answer ?? quietAnswer('the query answered nothing')
}

// Guard two, on its own: an answer describing a strictly older document version
// than the one already accepted for this path is stale. An equal version is the
// same analysis, and a `null` on either side is no comparison at all — accepted
// rather than guessed stale (`core/lsphub/editor.py` states the rule).
function isStaleAnswer(path, version) {
  const held = memory[path]
  if (!held || version == null || held.version == null) return false
  return version < held.version
}

// The shown fields for a path, from a held analysis.
function showHeld(path, held) {
  state.path = path
  state.status = 'analysed'
  state.items = held.items
  state.markers = held.markers
  state.version = held.version
  state.suppressed = held.suppressed
  state.reason = null
}

// The shown fields for a path that has nothing to show: *unknown*, never clean.
// `reason` carries a sentence when one exists, and no marks are ever left over
// from the buffer that was on screen before.
function showUnknown(path, reason = null) {
  state.path = path
  state.status = 'unknown'
  state.items = []
  state.markers = []
  state.version = null
  state.suppressed = 0
  state.reason = reason
}

// The shown fields for a path nothing will ever analyse.
function showNoServer(path, reason) {
  state.path = path
  state.status = 'no_server'
  state.items = []
  state.markers = []
  state.version = null
  state.suppressed = 0
  state.reason = reason
}

// Forget what is shown, without touching the memory (a buffer that simply is
// not on screen any more is not a lost analysis).
function resetShown() {
  showUnknown(null)
  state.analysing = false
}

// Drop the memory entries of buffers that are no longer open. The tab strip is
// the bound on the cache: a closed, renamed, deleted or re-rooted buffer's entry
// goes with the buffer, because a path that names nothing must not answer.
function prune(openPaths) {
  for (const path of Object.keys(memory)) {
    if (!openPaths.has(path)) delete memory[path]
  }
}

// The open *file* buffers' paths. A diff tab and a preview tab are records but
// not buffers: they have no live text a server could analyse, so they hold no
// analysis and are pruned like a closed tab.
function openBufferPaths() {
  const files = useEditorFiles()
  return files.state.open
    .filter((record) => record.kind === 'file')
    .map((record) => record.path)
}

// The one place the shown state is adopted from a settled answer. A verdict is
// remembered for its path so a returning buffer re-applies it; anything else
// clears that path's entry, because an analysis the hub no longer holds must not
// be painted from a cache.
function adoptAnswer(path, answer) {
  const result = answer?.result
  if (!result || result.analysed !== true) {
    // `analysed: false` — *unknown*, never "clean", and deliberately not an
    // error and not a fourth envelope status.
    delete memory[path]
    showUnknown(path)
    return
  }
  const items = Array.isArray(result.items) ? result.items : []
  const held = {
    items,
    // The markers are `lib/monaco-lsp.js`'s pure mapping, never shaped here: one
    // `+1`, one severity rule, one replacement set.
    markers: markersForDiagnostics(items),
    version: result.version ?? null,
    suppressed: Number.isInteger(result.suppressed) ? result.suppressed : 0,
  }
  memory[path] = held
  showHeld(path, held)
}

// Ask about one buffer: one request, its own token, both guards, and no notice
// on any path. The text comes from the buffer record the pane already holds —
// never from a second copy kept here — and only while it is dirty.
//
// Returns the envelope it accepted, or `null` for every dropped or quiet
// outcome: a caller has nothing to branch on, and there is nothing to show.
async function ask(path) {
  if (!path) {
    resetShown()
    return null
  }
  const record = useEditorFiles().recordFor(path)
  // A first ask for a buffer that is not the one on screen must not leave the
  // previous buffer's items under this path while the request runs: the fields
  // become *unknown* for the path and the verdict arrives with the answer.
  if (state.path !== path) showUnknown(path)
  const askedAt = ++token
  askedPath = path
  state.analysing = true
  const answer = await post(path, record?.dirty ? record.text : undefined)
  // Guard one: an answer overtaken by a newer question (or by a buffer switch,
  // or by a working-location switch) belongs to nobody and changes nothing.
  if (askedAt !== token) return null
  askedPath = null

  // Guard two, asked *before* the state is touched: a stale answer is dropped,
  // not painted — the answer held on screen describes newer text than this one,
  // so it stays. `analysing` stays true with it: the last thing an answer had to
  // say was that it described text nobody is looking at, which is a "we do not
  // know yet" the bar must keep reading as `analysing…` until the refresh the
  // settling period fires lands.
  if (answer.status === 'ok' && isStaleAnswer(path, answer.result?.version)) {
    return null
  }
  state.analysing = false

  if (answer.status !== 'ok') {
    // Every quiet envelope is a sentence or a silence, never a notice. A
    // no-server answer means nothing will analyse this path; a `starting` one
    // means not yet — and neither may leave the previous verdict on screen.
    delete memory[path]
    if (answer.status === 'no_server') showNoServer(path, answer.reason ?? null)
    else showUnknown(path, answer.reason ?? null)
    return answer
  }

  adoptAnswer(path, answer)
  return answer
}

// The read the pane uses to re-apply an answer when a buffer comes back on
// screen: for a path, whatever analysis is already held — or `null`, in which
// case the bar says `analysing…` until the ask the same trigger fires lands.
//
// Re-applying asks for nothing, so a buffer whose analysis is held costs no
// request. A switch to a *different* buffer bumps the token, so an answer still
// in flight for the buffer just left is dropped rather than painted under the
// new one.
function reapply(path) {
  if (!path) {
    supersede()
    resetShown()
    return null
  }
  if (askedPath !== path) supersede()
  const held = memory[path]
  if (held) showHeld(path, held)
  else showUnknown(path)
  // The news that nothing is known yet survives a re-application only while a
  // request for this very buffer is still in flight: a buffer coming back on
  // screen to an analysis it already holds is not "we do not know yet".
  state.analysing = askedPath === path
  return held ?? null
}

// The held analysis for a path, or `null`. The memory's read for a caller that
// only wants to know whether an ask is needed.
function analysisFor(path) {
  return (path && memory[path]) || null
}

// Forget everything, including a request in flight: the token moves, so an
// answer that arrives afterwards is dropped rather than shown. A working
// location switch is the reason this exists: paths relative to a root that no
// longer exists are a lie.
function clear() {
  // A settling period armed for a buffer of the folder just left must not fire
  // an ask about a path that names nothing any more.
  clearSettleTimer()
  supersede()
  for (const path of Object.keys(memory)) delete memory[path]
  resetShown()
}

// -- the four triggers --------------------------------------------------------
//
// Armed by the pane and disarmed with it, the shape `useEditorFiles` keeps for
// its freshness tick: the timer, the watchers and the request stay this module's,
// and a component only says when the pane is on screen.

// The active *file* buffer's record, or null. A diff tab and a preview tab are
// records but not buffers: they hold no live text a server could analyse. Read
// from the active tab rather than from a DOM event, because a chip click, a tree
// click, an arrow key on the strip and a close that reveals its neighbour all
// move that one value.
function activeRecord() {
  const files = useEditorFiles()
  const key = files.state.active
  if (!key) return null
  const record = files.recordForKey(key)
  return record && record.kind === 'file' ? record : null
}

function activeBufferPath() {
  return activeRecord()?.path ?? null
}

// The one timer: the settling period after edits (trigger two). One per buffer
// on screen — a switch clears it, so a period armed for the buffer just left can
// never ask about it under the new one.
let settleTimer = null

function clearSettleTimer() {
  if (settleTimer === null) return
  clearTimeout(settleTimer)
  settleTimer = null
}

// Trigger one: the buffer becomes the one on screen. A held analysis is
// **re-applied, not re-asked** — it costs no request — and only an unheld
// buffer asks.
function enterActiveBuffer(path) {
  clearSettleTimer()
  if (!path) {
    // A diff tab, a preview tab or an empty pane: nothing to analyse and no
    // path to ask about, so no request and no marks left over.
    reapply(null)
    return
  }
  if (reapply(path)) return
  void ask(path)
}

// Trigger two: edits settle. One timer, reset by each edit and cleared by a
// buffer switch, so four keystrokes in a row are one ask after the quiet period
// — never four. An edit that lands while a request is in flight opens no second
// request in parallel: this period produces one ask, and the two guards above
// decide which answer wins.
function settleEdits(path) {
  clearSettleTimer()
  settleTimer = setTimeout(() => {
    settleTimer = null
    void ask(path)
  }, DIAGNOSTICS_SETTLE_MS)
}

// Trigger three: a save completed. A save that landed is a new baseline on disk
// and a document the hub has just been told about, so the analysis should
// describe the saved text. `record.savedAt` rises only in the one branch that
// confirms a save, which is why save-all, a conflict resolution and
// save-and-close all fire this without a handler on each button — and why a
// refused save fires nothing.
function afterSave(path) {
  clearSettleTimer()
  void ask(path)
}

// Trigger four, and the bar's only control: exactly one ask for the buffer on
// screen, per press.
function recheck() {
  const path = activeBufferPath()
  if (!path) return null
  clearSettleTimer()
  return ask(path)
}

// The scope the watchers live in while the pane is on screen, or null.
let triggerScope = null

/**
 * Arm the four triggers. Idempotent: the pane mounts once per Editor view, and a
 * second call must not arm a second set of watchers (which would double every
 * request).
 *
 * Arming runs trigger one immediately, so a pane that appears with a buffer
 * already on screen answers about it without waiting for the next click.
 */
function startRefresh() {
  if (triggerScope) return
  triggerScope = effectScope(true)
  triggerScope.run(() => {
    watch(() => activeBufferPath(), enterActiveBuffer, { immediate: true })
    // Triggers two and three watch a `(path, counter)` pair: a buffer switch
    // changes both counters at once (they belong to another record), and that is
    // trigger one's business — only a *rising* counter on the same buffer is an
    // edit or a save.
    watch(
      () => [activeBufferPath(), activeRecord()?.editedAt ?? 0],
      ([path, edits], previous) => {
        if (!path || !previous || previous[0] !== path) return
        if (edits > (previous[1] ?? 0)) settleEdits(path)
      },
    )
    watch(
      () => [activeBufferPath(), activeRecord()?.savedAt ?? 0],
      ([path, savedAt], previous) => {
        if (!path || !previous || previous[0] !== path) return
        if (savedAt > (previous[1] ?? 0)) afterSave(path)
      },
    )
  })
}

/**
 * Disarm them, and drop a settling period that has not fired: the pane is gone,
 * so there is no reader for the answer and no surface for the marks.
 */
function stopRefresh() {
  clearSettleTimer()
  if (!triggerScope) return
  triggerScope.stop()
  triggerScope = null
}

// -- the bar's one control -----------------------------------------------------
//
// Whether the re-check has anything to do is answered from this composable's own
// state, which is the answer for the buffer on screen: a buffer whose last answer
// said `no_server` is one nothing will ever analyse, so there is nothing to
// re-check. `unknown` and `analysed` are both worth a press — the first because
// nobody knows yet, the second because an answer can be stale.

/**
 * Whether the re-check has anything to do: a buffer on screen *and* a server for
 * it.
 *
 * A buffer on screen is re-checkable as soon as it is on screen — its first
 * answer may still be in flight, and pressing then is a legitimate "ask now".
 * What makes it inert is an answer that says nothing will ever analyse this
 * path: `no_server` is the one state a refresh cannot improve.
 *
 * False is the button's disabled state — **disabled, never hidden**: a re-check
 * is the only thing a user can do about a stale or absent answer, so the control
 * has to stay visible and say why it is inert, rather than appear and disappear
 * with the tab.
 */
const recheckEnabled = computed(() => {
  const path = activeBufferPath()
  if (!path) return false
  return !(state.path === path && state.status === 'no_server')
})

/**
 * What the one control does, and — when it is disabled — why. One string for the
 * button's accessible name and its tooltip: two texts would be two answers.
 */
const recheckLabel = computed(() => {
  const path = activeBufferPath()
  if (!path) return 'Nothing to re-check — no buffer on screen'
  if (state.path === path && state.status === 'no_server') {
    return 'Nothing to re-check — no language server answers for this file'
  }
  return `Re-check ${path}`
})

// -- the bar's two readouts ---------------------------------------------------
//
// The Problems and State fields read these three exports and count nothing of
// their own. The *wording* is the component's (components are the widgets, `lib/`
// is the rule that produced the numbers); what is answered here is *which*
// buffer the answer describes and *what* its counts are.

/**
 * Whether the shown answer describes the buffer on screen — the one rule that
 * keeps a field from carrying the previous buffer's numbers.
 *
 * It is a comparison rather than a copy, and it is needed because trigger one
 * runs in a watcher: for the tick between a tab switch and the re-application
 * there is an answer in hand that belongs to the buffer just left. In that tick
 * both fields read absent, which is the honest reading — the bar knows nothing
 * about the buffer it is now describing.
 */
const shownOnScreen = computed(() => {
  const path = activeBufferPath()
  return path !== null && state.path === path
})

/**
 * The state for the buffer on screen: `'no_server'`, `'unknown'` or
 * `'analysed'` — or `null` when nothing is known about *this* buffer, which is
 * the tick between a tab switch and the re-application that follows it. `null`
 * is what makes a field absent rather than wrong.
 */
const status = computed(() => (shownOnScreen.value ? state.status : null))

/**
 * The counts for the accepted answer's items: `lib/monaco-lsp.js`'s one counting
 * function, over one answer. The bar renders these numbers and never counts again
 * with a rule of its own, so the number and the underlines cannot disagree.
 *
 * Keyed like `status`: an answer about another path is counted as nothing, so a
 * field can never show the previous buffer's numbers. `status` is what
 * distinguishes the zeroes — a caller checks it before treating a zero as a
 * *verdict*, because "clean" may only be said about an analysis that was
 * reached.
 */
const counts = computed(() =>
  diagnosticCounts(shownOnScreen.value ? state.items : []),
)

/**
 * Whether an answer for the buffer on screen is awaited or was dropped as stale
 * — the only thing that makes the bar read `analysing…`. `state.analysing`
 * already covers both (it stays true across a drop); the path check keeps it
 * from describing another buffer.
 */
const analysing = computed(() => shownOnScreen.value && state.analysing)

// The bound on the cache, kept by the tab strip itself rather than by a caller
// remembering to prune: one watcher over the open buffers, armed in a detached
// scope so N readers do not make N watchers and a component that unmounts does
// not stop the pruning. `flush: 'sync'` because the entry must be gone in the
// same tick the buffer leaves the strip.
effectScope(true).run(() => {
  watch(
    // A string, not the array: a fresh array every tick would make every
    // dependency change look like a change of the open set.
    () => JSON.stringify(openBufferPaths()),
    (serialised) => prune(new Set(JSON.parse(serialised))),
    { immediate: true, flush: 'sync' },
  )
})

export function useEditorDiagnostics() {
  // A working-location switch empties the memory and drops an answer still in
  // flight. Registered from the factory body, like the other holders: the keyed
  // registry makes a re-registration a replacement of this entry rather than a
  // second copy — a second mechanism for "the folder moved" would be the drift
  // this app avoids.
  registerReRootHandler('editorDiagnostics', clear)

  return {
    state,
    ask,
    reapply,
    analysisFor,
    clear,
    // The trigger lifecycle the pane arms on mount and disarms on unmount, and
    // the bar's one control.
    startRefresh,
    stopRefresh,
    recheck,
    recheckEnabled,
    recheckLabel,
    // The bar's two readouts: which buffer the answer describes, which of the
    // three states it is in, its counts, and whether an answer is awaited or was
    // dropped.
    shownOnScreen,
    status,
    counts,
    analysing,
  }
}
