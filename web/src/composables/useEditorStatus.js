import { computed, effectScope, reactive, watch } from 'vue'

import { useChat } from './useChat'
import { useEditorFiles } from './useEditorFiles'
import { withWorkspace } from './useWorkspaceSession'

// ---------------------------------------------------------------------------
// The Editor status bar's server field: the stateful half of one question —
// *which language server answers for the buffer on screen?*
//
// It is **wiring, not invention**: `POST /api/lsp/query`'s `status` action is
// answered by the hub from its own state, sends no request to a server and
// spawns none, and applies the same server choice the Ctrl+click path uses. The
// route and its envelope are untouched by this module; only the reading of that
// one action is new.
//
// Why its own state and its own token instead of `useEditorLsp`'s:
//
//   * `useEditorLsp.query()` keeps **one** `state.answer` for one *gesture*, and
//     a newer gesture drops an older one's in-flight answer on purpose. That is
//     right for Ctrl+click and wrong here: a status read fired on every buffer
//     switch travelling that path would discard a definition request the user
//     is waiting on. So the bar's reads have their own slot and their own
//     token, and `useEditorLsp`'s contract is left exactly as it documents it.
//   * The answer is **keyed by the path it was asked about** (§1.3: there is no
//     "last buffer" residue). A reader asks for the buffer on screen; a stored
//     answer describing any other path is not an answer to that question, so an
//     answer for the buffer just left can never be shown against the one that
//     replaced it. The stored pair is also cleared the moment the active buffer
//     changes, in the same tick the switch happens.
//   * **Its reads are quiet.** A refusal, an unreachable API, a hub that is not
//     there: each stores one short reason in the field and raises nothing. This
//     feature adds no notice on any path (§4) — `EditorNoticeStack` stays
//     reserved for write refusals.
//
// It is asked only when the buffer on screen changes (a tab switch, an open, a
// close that reveals its neighbour) and once on the first mount. Never per
// keystroke, never on a timer: typing does not change which server answers a
// path, so there is nothing to re-ask.
// ---------------------------------------------------------------------------

/** What the field says when there is no buffer on screen at all.
 *
 * One short form for the three shapes that have no buffer and no server: no tab
 * open, a diff tab, a preview tab. §1.3 asks the bar to say so rather than to
 * show the last file's answer; "silence is a sentence, not an absence". */
export const NO_BUFFER_TEXT = 'no buffer on screen'

/** The fallback for an envelope that named no reason.
 *
 * Only reachable for a malformed answer — every real quiet answer carries the
 * hub's own sentence — but the field must never go blank when it cannot
 * determine the server (§1.3: *it never invents a state*). */
const UNKNOWN_SERVER_TEXT = 'no language server'

const state = reactive({
  // The path the answer below is about, and the answer itself in the wire's own
  // shape `{ status, server, reason, action, result }`. A pair, not two
  // independent values: they are only meaningful together.
  path: null,
  answer: null,
})

// The answer above is keyed by one question, so it has its own token: a newer
// read (or a buffer switch) must not be painted over by an older answer. Same
// trick `useEditorLsp` uses for a gesture, held here so the two never share one.
let answerToken = 0

// The quiet envelope for a read that never produced one: an unreachable API, a
// refusal, a body that was not JSON. The wire's own shape, so every caller
// treats "no answer" and "no server" alike — and one short reason, because the
// field has room for one clause.
function quietAnswer(reason) {
  return { status: 'no_server', server: null, reason, action: 'status', result: null }
}

// The hub's sentence as the field shows it: the hub's own words, trimmed, with
// no sentence of ours composed beside them (D8 — one source of phrasing: the bar
// says what the `Ctrl`+click path would say).
function shortReason(reason) {
  if (typeof reason !== 'string') return ''
  return reason.trim().replace(/\.$/, '')
}

// The buffer on screen, or null. A diff tab and a preview tab are records but
// not *buffers*: they have no live text a server could analyse, so they answer
// null here and the field says `NO_BUFFER_TEXT`. The tab's kind is the record's
// own — read here, never re-derived from the key's prefix.
function activeBuffer() {
  const files = useEditorFiles()
  const key = files.state.active
  if (!key) return null
  const record = files.recordForKey(key)
  if (!record || record.kind !== 'file') return null
  return record
}

// The conversation-scoped allowlist, read from the Tools panel's own state —
// the same rule `useEditorLsp` reads, from the same single source, so the two
// cannot drift: `null` means "send no filter" (a failed snapshot must not blind
// the pane), otherwise the ids whose switch is on. A server switched off in the
// panel must not be named here as answering.
function allowedServerIds() {
  const lsp = useChat().state.lsp
  if (!lsp.loaded) return null
  return Object.keys(lsp.enabled).filter((id) => lsp.enabled[id])
}

// One request, one answer, no retry and no throw. `status` is answered from the
// hub's own state, so it never comes back `starting` and never spawns a server:
// there is nothing to wait for.
async function post(path) {
  const body = { action: 'status', path }
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

// Forget the stored pair, including any read in flight: the token moves, so an
// answer that arrives afterwards is dropped rather than shown.
function clear() {
  answerToken += 1
  state.path = null
  state.answer = null
}

// Ask about one path and store the answer keyed by it. An answer a newer read
// (or a buffer switch) has overtaken is dropped rather than stored: it belongs
// to a question nobody is asking any more.
async function ask(path) {
  if (!path) {
    clear()
    return null
  }
  const askedAt = ++answerToken
  const answer = await post(path)
  if (askedAt !== answerToken) return null
  state.path = path
  state.answer = answer
  return answer
}

// The field's text — the one place the wording lives, because a chain of
// template branches would be three copies of one rule. `''` only in the window
// between a buffer appearing and its answer landing; every settled answer fills
// the field, a failure included.
const serverLabel = computed(() => {
  const record = activeBuffer()
  if (!record) return NO_BUFFER_TEXT
  // Keyed: an answer about another path is not an answer about this one.
  if (state.path !== record.path || !state.answer) return ''
  if (state.answer.status === 'ok' && state.answer.server) return state.answer.server
  return shortReason(state.answer.reason) || UNKNOWN_SERVER_TEXT
})

// The one trigger: the buffer on screen changing (a tab switch, an open, a close
// that reveals its neighbour), plus the first mount — and `immediate` is that
// mount. Armed once, in a **detached** effect scope: N readers must not make N
// watchers, and the answer belongs to the singleton rather than to whichever
// component happened to ask for it first — a scope tied to that component would
// stop the field answering the moment the component unmounted.
effectScope(true).run(() => {
  watch(
    () => activeBuffer()?.path ?? null,
    (path) => {
      clear()
      if (path) void ask(path)
    },
    // Synchronous, so the field stops describing the buffer just left in the
    // same tick the switch happens — no frame in which the answer for one buffer
    // sits under another's name.
    { immediate: true, flush: 'sync' },
  )
})

export function useEditorStatus() {
  return { state, serverLabel, ask, clear }
}
