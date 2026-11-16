import { reactive } from 'vue'

import { describePolicy } from '../lib/path-location-policy'
import { describeTransportError, fetchWithRetry } from '../lib/api-fetch'

// ---------------------------------------------------------------------------
// The tab's own memory: which folder this tab works on (clws-02).
//
// The browser already owns the whole *view* per tab — buffers, tree expansion,
// scroll, transcript. This composable gives the tab the one thing it did not
// own: the **answer** to "which folder". Before it the folder was process state
// — one route set an environment variable the whole server then read — so two
// tabs on two folders were impossible no matter what a tab asked for. That
// route is gone: nothing sets the process's folder any more.
//
// **Storage is `sessionStorage`, not `localStorage`, and that is the whole
// requirement.** `localStorage` is browser-wide: a folder remembered there is
// inherited by every tab, which is exactly the bug being fixed (spec D4, D11).
// `sessionStorage` is per tab — a reload is the same tab and keeps its folder,
// a new tab starts without one and lands on the installation folder the server
// reports, and a closed tab forgets its folder. Nothing here belongs in the
// settings store either: the store is the **installation's** (servers, models,
// agents, bullets), and a tab's folder is neither configuration nor shared.
//
// Two rules the rest of the app depends on:
//
// * **`state.workspace` is the one value every request is built from** (spec
//   §5.1 rule 9). It holds the canonical text the server answered, never what
//   was typed, so the field and the requests cannot drift apart.
// * **`withWorkspace(url)` is the single place the field's name is spelled.**
//   No call site writes `workspace=`; a new request cannot forget the field and
//   the name cannot drift from the server's reader.
//
// The address bar is **never** touched: no query string, no hash, no
// `history.replaceState` (spec D9). Two tabs showing the same address may be on
// two different folders — the address says *which app*, never *which folder*.
//
// And no cross-tab machinery: no `storage` listener, no broadcast channel, no
// polling (spec D7). Two tabs on one folder are last-write-wins and a stale
// tree until the user refreshes, which is the accepted behaviour.
// ---------------------------------------------------------------------------

// The two keys of **tab** state, named in one place. Neither is configuration:
// nothing here belongs in the settings store, and neither is read by the
// server between requests (spec §8: no server-side memory, no browser-wide
// memory). `AGENT_STORAGE_KEY` is the agent this tab answers as (spec D5,
// §5.5 rule 26) — `useAgentModes` reads and writes it through this name rather
// than a second base name, so the tab's two pieces of identity sit side by side.
export const WORKSPACE_STORAGE_KEY = 'nojae:workspace'
export const AGENT_STORAGE_KEY = 'nojae:agent'

const state = reactive({
  // The folder this tab works on: the **canonical** text the server answered
  // (its realpath), and the only value `withWorkspace` puts on a URL.
  workspace: '',
  // What the app bar's field holds while it is being edited. Deliberately a
  // second slot: Set is about the difference between the two, and a canonicalised
  // path must not leave the button spuriously enabled.
  field: '',
  loading: false, // the boot read is in flight
  saving: false, // a Set is in flight
  // The server's own sentence, shown verbatim. A refusal is an answer, never a
  // silent substitution: the previous folder stays in place beside it.
  error: null,
  // The workspace's read-write policy file, as the read reported it, and the
  // one line the app bar shows under the field when that report is a warning.
  // A `failed` seed is a note and never an error: the folder **did** move.
  policy: null,
  policyNote: null,
  // The pool's visible-restart fact (rule 23): this workspace's tools were just
  // admitted — its connectors and language servers are coming back — or were let
  // go, so the tab would otherwise show an empty catalogue with no explanation.
  // It is a **status**, never an error. It clears when a later read says the
  // set is live (`built: false` on a hub payload, or this root in the pool's
  // summary) — and, because an admission is bounded by the managers' own
  // connect-retry windows, it also **clears itself** once
  // `TOOLS_RESTARTING.ttlMs` has passed, so a `built: true` that landed last
  // in the boot race can never stick. The flag and its timer are written only
  // through `setToolsRestarting`, so the two cannot drift apart.
  toolsRestarting: false,
  // The pool's own sentence when it refused to admit this workspace (the
  // ceiling). It is the server's text, verbatim, and the app bar shows it as an
  // alert — an error outranks the policy note and the restarting status below.
  poolRefusal: null,
})

// The one wording the interface gives the restarting fact. The pool's sentence
// is the ceiling's; this line is the interface's own, because the payload's
// `built` flag is a fact rather than a sentence.
export const TOOLS_RESTARTING_TEXT = "this workspace's tools are restarting"

// How long the line may stay without a live answer. "Restarting" is a
// transient by definition: an admission ends when the managers' own
// connect-retry windows have burned out, and `ttlMs` is that worst case plus
// slack — the MCP hub's local-external window (60 retries × 0.5 s, plus the
// close grace it spends between them) and the LSP hub's stuck-starting
// budget (a 60 s handshake + 2×5 s grace + 15 s). A healthy set answers
// within a few seconds, so the timer only fires when nothing else will
// clear the flag for the tab. A property rather than a bare constant, so a
// test patches `TOOLS_RESTARTING.ttlMs` and the arm below reads it at call
// time.
export const TOOLS_RESTARTING = {
  ttlMs: (60 * 0.5 + 5 + 60 + 2 * 5 + 15) * 1000 + 10_000,
}

// The flag's one writer, with its timer. Setting the flag arms the
// self-clearing; any write — `true` or `false` — replaces rather than stacks
// the pending timer, so an old expiry cannot clear a newer restart.
let restartingTimer = null

export function setToolsRestarting(value) {
  if (restartingTimer) {
    clearTimeout(restartingTimer)
    restartingTimer = null
  }
  state.toolsRestarting = !!value
  if (state.toolsRestarting) {
    restartingTimer = setTimeout(() => {
      restartingTimer = null
      state.toolsRestarting = false
    }, TOOLS_RESTARTING.ttlMs)
    if (restartingTimer.unref) restartingTimer.unref()
  }
}

// -- the tab's storage, tolerant on both ends ----------------------------------
//
// A missing key, a cleared storage, a private-mode throw and a value that is not
// a string all mean the same thing: no remembered workspace. Same shape as the
// theme and layout keys read their storage.

function readStoredWorkspace() {
  try {
    const value = window.sessionStorage.getItem(WORKSPACE_STORAGE_KEY)
    return typeof value === 'string' && value ? value : ''
  } catch {
    return ''
  }
}

function writeStoredWorkspace(value) {
  try {
    if (value) window.sessionStorage.setItem(WORKSPACE_STORAGE_KEY, value)
    else window.sessionStorage.removeItem(WORKSPACE_STORAGE_KEY)
  } catch {
    // Storage disabled: the tab still works, it just forgets on reload.
  }
}

// -- the one spelling of the field ---------------------------------------------

/**
 * Add this tab's workspace to a request URL. The only function in `web/src`
 * that writes `workspace=`, and the only one that needs to know the name.
 *
 * A tab that has not resolved its folder yet (the boot read is still in flight)
 * sends no field, and the server answers from its interim default — which is
 * the same installation folder a new tab lands on. Task 10 is where a request
 * without the field stops being an answer at all.
 */
export function withWorkspace(url) {
  return withWorkspaceRoot(url, state.workspace)
}

/**
 * The same spelling for an **explicit** folder — the cases where a request must
 * name a folder the tab is not necessarily on right now:
 *
 * * the read that decides whether a typed folder may become the tab's workspace
 *   (it is asked *before* the tab adopts the answer);
 * * a **batch lot**, whose workspace is part of its pin: every task turn and
 *   every re-listing of the lot names the folder the run started on, so a tab
 *   that moves afterwards re-roots nothing (spec §5.7 rule 33).
 *
 * An empty or absent ``root`` adds no field, which is the shape a tab that has
 * not resolved its folder yet sends.
 */
export function withWorkspaceRoot(url, root) {
  if (!root) return url
  const separator = url.includes('?') ? '&' : '?'
  return `${url}${separator}workspace=${encodeURIComponent(root)}`
}

// The server's refusal, verbatim when it is a sentence. The client re-spells no
// validation rule of its own (spec §5.2): the field's refusals are the server's.
function describeError(body, fallback) {
  const detail = body?.detail
  if (typeof detail === 'string' && detail) return detail
  return fallback
}

// What a read had to say about the reserved folder's policy file: the block, and
// the app bar's one line when the block's tone is a warning. Cleared on every
// attempt, so a note from a read that has since worked cannot linger.
function adoptPolicy(block) {
  state.policy = block ?? null
  const described = describePolicy(block)
  state.policyNote = described && described.tone === 'warn' ? described.text : null
}

// Adopt the server's answer: the canonical folder, the field, the tab's memory,
// and the pool's answer about this folder's tools. A successful read means the
// ceiling did not refuse it, so a stale pool refusal goes with the move.
function adopt(resolvedRoot, block, hubs) {
  state.workspace = resolvedRoot
  state.field = resolvedRoot
  state.poolRefusal = null
  writeStoredWorkspace(resolvedRoot)
  adoptPolicy(block)
  noteWorkspaceHubs(hubs, resolvedRoot)
}

// -- what a payload says about this workspace's tools -------------------------

/**
 * Adopt a hub route's `built` flag (`GET /api/mcp`, `GET /api/lsp`).
 *
 * `built: true` is the **visible restart** the pool reports when this request is
 * the one that admitted the workspace (spec §5.4 rule 23): its tools are coming
 * back. `built: false` is the other half — this request found the set already
 * live, so the line clears. Either way the write goes through
 * `setToolsRestarting`, so a `built: true` that lands last in the boot race
 * cannot stick: it expires like every other restart. A hub route that answered
 * at all means the ceiling did not refuse this workspace, so a stale ceiling
 * sentence clears too.
 */
export function noteHubPayload(payload) {
  if (!payload || typeof payload.built !== 'boolean') return
  setToolsRestarting(payload.built)
  state.poolRefusal = null
}

/**
 * Adopt the `hubs` block of a workspace read.
 *
 * Two facts, one line. A set the read found live and not freshly built is up; a
 * freshly built one is restarting; and a folder with **no live set at all** is
 * the let-go case — a panel's next request admits it — so the user never sees an
 * empty catalogue without the line (spec §5.4 rule 23). The pool's summary is
 * read only to answer "is *this* root live"; it is never rendered as a list.
 */
export function noteWorkspaceHubs(hubs, root = state.workspace) {
  if (!hubs) {
    setToolsRestarting(false)
    return
  }
  const built = !!(hubs.mcp?.built || hubs.lsp?.built)
  const pool = hubs.pool
  if (pool && Array.isArray(pool.workspaces)) {
    const live = pool.workspaces.some((row) => row?.root === root)
    setToolsRestarting(built || !live)
    return
  }
  setToolsRestarting(built)
}

/**
 * Record the pool's own sentence when a hub route refused this workspace
 * (HTTP 429). The client composes no sentence of its own: the bar and the panel
 * that asked both render this text verbatim.
 */
export function reportPoolRefusal(sentence) {
  state.poolRefusal = typeof sentence === 'string' && sentence ? sentence : null
}

/**
 * The field's one note, as a plain verdict — error, then the pool's ceiling,
 * then the policy note, then the restarting status.
 *
 * The precedence is the point: a refusal (a 422 the server raised, or the pool's
 * 429) outranks every status, exactly as the old refusal/seed-note pair did. One
 * line only, because the bar has room for one.
 */
export function locationNoteVerdict() {
  if (state.error) {
    return { tone: 'error', role: 'alert', text: state.error }
  }
  if (state.poolRefusal) {
    return { tone: 'error', role: 'alert', text: state.poolRefusal }
  }
  if (state.policyNote) {
    return { tone: 'warn', role: 'status', text: state.policyNote }
  }
  if (state.toolsRestarting) {
    return { tone: 'status', role: 'status', text: TOOLS_RESTARTING_TEXT }
  }
  return null
}

// -- the two reads -------------------------------------------------------------

/**
 * The boot read: the stored folder if there is one, otherwise the folder the
 * server boots on — the installation, which is where a new tab lands and from
 * which the user points it (spec D4).
 *
 * A stored folder that no longer resolves is **reported and left in place**: the
 * tab opens on it, the sentence says why, and the first request that needs the
 * folder is refused the same way. Nothing is repaired silently (spec §6: a
 * remembered folder is convenience, not a guarantee).
 */
export async function loadWorkspace() {
  state.loading = true
  state.error = null
  const stored = readStoredWorkspace()
  try {
    const res = await fetchWithRetry(withWorkspaceRoot('/api/workspace', stored))
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      if (stored) {
        // Left in place, not substituted: the tab stays on the folder it
        // remembers and says what the server said about it.
        state.workspace = stored
        state.field = stored
        state.error = describeError(
          body,
          `Could not open the remembered workspace (${res.status})`,
        )
      } else {
        state.error = describeError(body, `Could not read the workspace (${res.status})`)
      }
      return
    }
    // What is adopted is the folder the read **answered about**, so the policy
    // block on screen is the one belonging to the folder the tab is now on —
    // never a report about a folder that was not asked about. With no stored
    // folder that is the server's boot folder, which is the installation
    // (spec D4: a new tab lands there); `default` is the same answer once task
    // 10 deletes the interim environment value, and is kept in the payload for
    // the interface's "back to the installation" affordance.
    adopt(body.workspace, body.policy, body.hubs)
  } catch (exc) {
    state.error = describeTransportError(exc)
  } finally {
    state.loading = false
  }
}

/**
 * The one gesture: point **this tab** at the folder its field holds.
 *
 * Asks `GET /api/workspace` about what was typed and adopts the server's
 * canonical answer on success, so field, requests and tab memory hold one
 * value. On a refusal the previous folder stays exactly where it was and the
 * server's sentence is shown — a refusal is an answer, never a silent
 * substitution (spec §5.2 rule 12).
 *
 * Returns the adopted payload (or null), because the caller owns what a move
 * invalidates: the tree re-roots and the hub panels re-read. The settings
 * store — servers, models, agents, bullets — is the installation's and is
 * deliberately not touched (spec §4.2's closing rule).
 */
export async function setWorkspaceFromField() {
  if (state.saving) return null
  const next = (state.field || '').trim()
  if (!next || next === state.workspace) return null
  state.saving = true
  state.error = null
  state.policyNote = null
  try {
    const res = await fetch(withWorkspaceRoot('/api/workspace', next))
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      // The typed text stays in the field (it is what the user wants to fix),
      // and `state.workspace` — what every request is built from — does not move.
      state.error = describeError(body, `Could not set the workspace (${res.status})`)
      return null
    }
    adopt(body.workspace, body.policy, body.hubs)
    return body
  } catch (exc) {
    state.error = describeTransportError(exc)
    return null
  } finally {
    state.saving = false
  }
}

export function useWorkspaceSession() {
  return { state, loadWorkspace, setWorkspaceFromField, withWorkspace }
}
