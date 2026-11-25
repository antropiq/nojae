import { reactive } from 'vue'

import { useChat } from './useChat'
import { registerReRootHandler } from './useWorkspaceTree'
import { withWorkspace } from './useWorkspaceSession'

// ---------------------------------------------------------------------------
// The Editor pane's language-server state: the stateful half of the feature
// whose pure half is `lib/monaco-lsp.js`.
//
// One singleton, like every other Editor composable: the last answer and the
// in-flight token live *here*, not in the pane, so every provider asking a
// question reads the same state.
//
// Four rules hold it together:
//
//   * **One request per gesture.** `query()` posts one body to
//     `POST /api/lsp/query` and stores the envelope it answers with. No polling,
//     no debounce, no queue.
//   * **A cold server answers `starting`, and the browser retries once.** One
//     short delay, one second attempt, then stop — never a loop and never a
//     retry of a `no_server` answer.
//   * **No server is a quiet answer.** A `server: null` envelope, a policy
//     refusal and an unreachable API all store a reason and raise no notice: the
//     feature degrades to the status quo, never to an error.
//   * **The allowlist is read, never owned.** The Tools panel's switches are
//     `useChat`'s `state.lsp.enabled`; this module sends the ids that are on and
//     owns no copy, because two switches for one server would drift. A failed
//     snapshot (`loaded: false`) sends no filter at all. A locked conversation's
//     frozen set is what travels: the switches are already frozen by `useChat`.
//
// The browser never speaks LSP: the actions named here are the app's own
// vocabulary, and no LSP method name appears in this file.
//
// A *new working location* clears all of it through the keyed
// `registerReRootHandler` registry the buffers and the search results use: the
// last answer and any in-flight request are dropped, because a location that no
// longer exists makes every one of them a lie.
// ---------------------------------------------------------------------------

// How long the one `starting` retry waits: short enough that a Ctrl+click on a
// cold project still feels like a gesture, long enough that a lazy server's spawn
// has begun.
export const STARTING_RETRY_DELAY_MS = 500

const state = reactive({
  // The last gesture's envelope, or null:
  // `{ status, server, reason, action, result }`, the wire's own shape.
  answer: null,
})

// The answer above is filled by one gesture, so it has its own token: a newer
// gesture must not be painted over by an older answer. Stamped on send, checked
// on arrival, bumped by `clear()`.
let answerToken = 0

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// The quiet envelope for a request that never produced one: an unreachable API,
// a refusal, a body that was not JSON. The wire's own shape, so every caller
// treats "no answer" and "no server" the same way.
function quietAnswer(action, reason) {
  return { status: 'no_server', server: null, reason, action, result: null }
}

export function useEditorLsp() {
  const chat = useChat()

  // The conversation-scoped allowlist, read from the Tools panel's own state.
  // `null` means "send no filter": a failed load must not silently blind the pane.
  function allowedServerIds() {
    const lsp = chat.state.lsp
    if (!lsp.loaded) return null
    return Object.keys(lsp.enabled).filter((id) => lsp.enabled[id])
  }

  function bodyFor({ action, path, line, character, text }) {
    const body = { action }
    if (path) body.path = path
    // The position travels only for the actions that have one, already 0-based:
    // Monaco's own `-1` happened in `lib/monaco-lsp.js`.
    if (Number.isInteger(line) && Number.isInteger(character)) {
      body.line = line
      body.character = character
    }
    // The buffer is the source of truth: the text travels only when the caller
    // says the buffer is dirty, and the hub reads the file otherwise.
    if (typeof text === 'string') body.text = text
    const allowed = allowedServerIds()
    if (allowed !== null) body.lspEnabled = allowed
    return body
  }

  // One request, one answer. A failure is the quiet envelope rather than a throw:
  // a provider must never see an exception, and the pane must never see a notice
  // for a gesture that simply had nothing to say.
  async function post(body) {
    let res
    let answer = null
    try {
      res = await fetch(withWorkspace('/api/lsp/query'), {
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

  // One gesture: build the body, ask, store the answer, hand it back. A `starting`
  // answer is retried exactly once; an answer a newer request (or a
  // working-location switch) has overtaken is dropped and `null` is returned for
  // it — it belongs to a question nobody is asking any more.
  /** @param {{ action?: string, path?: string, line?: number, character?: number, text?: string }} [request] */
  async function query({ action, path, line, character, text } = {}) {
    const askedAt = ++answerToken
    const body = bodyFor({ action, path, line, character, text })
    let answer = await post(body)
    if (askedAt !== answerToken) return null
    if (answer.status === 'starting') {
      await delay(STARTING_RETRY_DELAY_MS)
      if (askedAt !== answerToken) return null
      answer = await post(body)
      if (askedAt !== answerToken) return null
    }
    state.answer = answer
    return answer
  }

  // Forget everything, including any request in flight: the token moves, so an
  // answer that arrives afterwards is dropped rather than shown.
  function clear() {
    answerToken += 1
    state.answer = null
  }

  // A working-location switch clears the editor's LSP state with the buffers.
  // Registered from the factory body like the other holders: the keyed registry
  // makes a re-registration a replacement rather than a second copy.
  registerReRootHandler('editorLsp', clear)

  return { state, query, clear }
}
