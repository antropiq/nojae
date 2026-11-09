import { reactive } from 'vue'

import { useChat } from './useChat'
import { registerReRootHandler } from './useWorkspaceTree'

// ---------------------------------------------------------------------------
// The Editor pane's language-server state: the stateful half of the feature
// whose pure half is `lib/monaco-lsp.js`.
//
// One singleton, like every other Editor composable: the last answer, the
// status line's text and the in-flight tokens live *here*, not in the pane, so
// the providers asking a question and the caption saying which server serves
// the file read the same state.
//
// Four rules hold it together, and they are the spec's:
//
//   * **One request per gesture.** `query()` posts one body to
//     `POST /api/lsp/query` and stores the envelope it answers with. No
//     polling, no debounce, no queue: a gesture is a question and the answer is
//     the answer.
//   * **A cold server answers `starting`, and the browser retries once**
//     (§4.6). One short delay, one second attempt, then stop — never a loop,
//     never a retry of a `no_server` answer, and never a retry of a `status`
//     query, whose "starting" is the honest answer the status line shows.
//   * **No server is a quiet answer** (§4.10). A `server: null` envelope, a
//     policy refusal and an unreachable API all store a reason and raise no
//     notice: the feature degrades to the status quo, never to an error. The
//     one place the absence is *said* is the pane's status line, which is what
//     `statusFor()` fills — and what a quiet gesture answer refreshes, so a
//     user who Ctrl+clicked and saw nothing finds the reason where they look.
//   * **The allowlist is read, never owned** (§4.3). The Tools panel's switches
//     are `useChat`'s `state.lsp.enabled`; this module sends the ids that are
//     on and owns no copy, because two switches for one server would drift. A
//     failed snapshot (`loaded: false`) sends no filter at all — the panel is
//     hidden and every Settings-activated server stays eligible, exactly as
//     chat behaves. A locked conversation's frozen set is what travels: the
//     switches are already frozen by `useChat`, so nothing here unfreezes them.
//
// The browser never speaks LSP (§4.1): the actions named here are the app's own
// vocabulary, and no LSP method name appears in this file.
//
// A *new working location* clears all of it through the keyed
// `registerReRootHandler` registry the buffers and the search results use: the
// last answer, the status line and any in-flight request are dropped, because a
// location that no longer exists makes every one of them a lie (§4.13).
// ---------------------------------------------------------------------------

// How long the one `starting` retry waits (§4.6). Short enough that a Ctrl+click
// on a cold project still feels like a gesture, long enough that a lazy server's
// spawn has begun — the second attempt is what lands the definition.
export const STARTING_RETRY_DELAY_MS = 500

const state = reactive({
  // The last gesture's envelope, or null:
  // `{ status, server, reason, action, result }`, the wire's own shape.
  answer: null,
  // The pane's status line: which server serves the active buffer, or that none
  // does. A caption, never a control (§6).
  statusLine: '',
})

// The two slots above are filled by two different questions — a gesture and the
// status line — so each has its own token: a status query must not drop a
// gesture's answer, and a gesture must not blank the caption. Same trick
// `useQuickOpen` uses: stamped on send, checked on arrival, bumped by `clear()`.
let answerToken = 0
let statusToken = 0

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The quiet envelope for a request that never produced one: an unreachable API,
// a refusal, a body that was not JSON. The wire's own shape, so every caller
// treats "no answer" and "no server" the same way (§4.10).
function quietAnswer(action, reason) {
  return { status: 'no_server', server: null, reason, action, result: null }
}

// The status line's wording, from one envelope. Three states, and a policy
// refusal is the same quiet shape as "no server" with the policy's own sentence
// beside it — the shared refusal wording, never a new one.
function statusLineFor(answer) {
  if (!answer) return ''
  if (answer.status === 'ok') return `Served by ${answer.server}`
  if (answer.status === 'starting') return `${answer.server} is starting`
  const reason = answer.reason ? ` — ${answer.reason}` : ''
  return `No language server serves this file${reason}`
}

export function useEditorLsp() {
  const chat = useChat()

  // The conversation-scoped allowlist (§4.3), read from the Tools panel's own
  // state. `null` means "send no filter": the snapshot failed, so the panel is
  // hidden and every Settings-activated server stays eligible — a failed load
  // must not silently blind the pane.
  function allowedServerIds() {
    const lsp = chat.state.lsp
    if (!lsp.loaded) return null
    return Object.keys(lsp.enabled).filter((id) => lsp.enabled[id])
  }

  function bodyFor({ action, path, line, character, text }) {
    const body = { action }
    if (path) body.path = path
    // The position travels only for the actions that have one, and it is
    // already 0-based: the `-1` from Monaco's coordinates happened in
    // `lib/monaco-lsp.js` (§4.8).
    if (Number.isInteger(line) && Number.isInteger(character)) {
      body.line = line
      body.character = character
    }
    // The buffer is the source of truth (§4.5): the text travels only when the
    // caller says the buffer is dirty, and the hub reads the file otherwise.
    if (typeof text === 'string') body.text = text
    const allowed = allowedServerIds()
    if (allowed !== null) body.lspEnabled = allowed
    return body
  }

  // One request, one answer. A failure is the quiet envelope rather than a
  // throw: a provider must never see an exception, and the pane must never see
  // a notice for a gesture that simply had nothing to say (§4.10).
  async function post(body) {
    let res
    let answer = null
    try {
      res = await fetch('/api/lsp/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      answer = await res.json().catch(() => null)
    } catch (exc) {
      return quietAnswer(body.action, `the API could not be reached: ${exc}`)
    }
    if (!res.ok) {
      return quietAnswer(
        body.action,
        answer?.detail ?? `the query was refused (${res.status})`,
      )
    }
    return answer ?? quietAnswer(body.action, 'the query answered nothing')
  }

  // One gesture: build the body, ask, store the answer, hand it back so the
  // provider can act on it. A `starting` answer is retried exactly once (§4.6);
  // an answer that a newer request (or a working-location switch) has overtaken
  // is dropped rather than stored, and `null` is returned for it — it belongs to
  // a question nobody is asking any more.
  async function query({ action, path, line, character, text } = {}) {
    const askedAt = ++answerToken
    const body = bodyFor({ action, path, line, character, text })
    let answer = await post(body)
    if (askedAt !== answerToken) return null
    if (answer.status === 'starting' && action !== 'status') {
      await delay(STARTING_RETRY_DELAY_MS)
      if (askedAt !== answerToken) return null
      answer = await post(body)
      if (askedAt !== answerToken) return null
    }
    state.answer = answer
    // A quiet answer is the one case the pane *says* something about (§4.10),
    // so it refreshes the caption too — and takes the status token with it, so
    // an older status answer cannot land over the fresher reason.
    if (answer.status === 'no_server') {
      statusToken += 1
      state.statusLine = statusLineFor(answer)
    }
    return answer
  }

  // What the pane asks when a buffer becomes the active tab: which server serves
  // this file, or that none does. Never retried — a status query's "starting" is
  // the honest answer, and the caption says so.
  async function statusFor(path) {
    if (!path) {
      // No buffer, no caption — and the token moves so a status answer still in
      // flight for the buffer that was just left cannot land on the empty pane.
      statusToken += 1
      state.statusLine = ''
      return null
    }
    const askedAt = ++statusToken
    const answer = await post(bodyFor({ action: 'status', path }))
    if (askedAt !== statusToken) return null
    state.statusLine = statusLineFor(answer)
    return answer
  }

  // Forget everything, including any request in flight: both tokens move, so an
  // answer that arrives afterwards is dropped rather than shown.
  function clear() {
    answerToken += 1
    statusToken += 1
    state.answer = null
    state.statusLine = ''
  }

  // A working-location switch clears the editor's LSP state with the buffers
  // (§4.13). Registered from the factory body, like the other holders: the keyed
  // registry makes a re-registration a replacement of this entry rather than a
  // second copy.
  registerReRootHandler('editorLsp', clear)

  return { state, query, statusFor, clear }
}
