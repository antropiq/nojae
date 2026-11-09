import { reactive } from 'vue'

import { registerReRootHandler, useWorkspaceTree } from './useWorkspaceTree'

// ---------------------------------------------------------------------------
// Quick Open: the state behind the Editor tab's fuzzy file finder.
//
// One singleton, like every other screen's (the same reason `useWorkspaceSearch`
// is one): the dialog visibility, the query, the fetched candidate list, the
// fetch state and the selected index live *here*, not in the component, so
// closing the `<dialog>` and re-opening it cannot lose the query — re-opening
// shows the previous filter, which the user clears with one keystroke (§2.7).
//
// The list is fetched **once per dialog open** and never mid-session (§2.3):
// `openDialog()` asks `GET /api/fs/files` fresh every time — cheap, and it
// keeps the list honest after renames, deletes and new files made since the
// last open — then the per-keystroke filtering happens in the browser against
// `list`. No request per keystroke, no debounce, no cancellation machinery:
// one bounded walk per open is the whole server cost.
//
// `pick(path)` is §2.6 in order: publish the path as the tree's selection (the
// existing `openFile` flow opens or focuses the buffer, and its existing
// refused-open answers — binary, over the size cap, renamed/deleted since the
// listing — are the pane's own words; no staleness machinery here), close the
// dialog, then return focus to the Monaco pane through the one-way registry
// below, because the composable must not import the pane and the pane must not
// import this state twice.
//
// A *new working location* empties all of it through the same keyed
// `registerReRootHandler` registry the buffers and the search results use:
// paths relative to a root that no longer exists are a lie (§2.7).
// ---------------------------------------------------------------------------

const state = reactive({
  open: false,
  // Kept across closes, cleared on a working-location switch.
  query: '',
  // The fetched candidate paths, workspace-relative, in the server's order.
  list: [],
  // 'idle' | 'loading' | 'ready' | 'error'
  status: 'idle',
  // Index into the *filtered* rows the dialog renders, not into `list` — the
  // dialog owns the filtering, this only holds where the selection is.
  selected: 0,
  // The payload's own `truncated` flag (§2.5): the footer line is the dialog's
  // only reader, and it renders the flag rather than counting rows client-side.
  truncated: false,
  // { status, detail } for the dialog's inline error line. `status: 0` means
  // the request never reached the server.
  error: null,
})

// The fetch in flight, stamped on send and checked on arrival — two
// `openDialog()` calls in a row (Escape, Ctrl+P again) must not let an older
// answer land over a newer one. Same token trick the tree and search use.
let generation = 0

// Where focus goes after a pick. Registered by the pane (EditorArea), one-way
// like the tree's chord registries: this module says *when*, the pane says how.
let paneFocus = null

/** Register the handler that returns focus to the Monaco pane after a pick. */
export function registerPaneFocus(handler) {
  paneFocus = typeof handler === 'function' ? handler : null
}

export function useQuickOpen() {
  const tree = useWorkspaceTree()

  // Open the dialog: fetch the candidate list fresh **every time** (§2.3),
  // then show it. The previous list stays on screen while the fetch runs —
  // clearing it would flash an empty dialog at the person re-opening — and a
  // response that answers an older open is dropped by the generation token.
  async function openDialog() {
    state.open = true
    state.selected = 0
    state.error = null
    const askedAt = ++generation
    state.status = 'loading'
    let res
    let body = null
    try {
      res = await fetch('/api/fs/files')
      body = await res.json().catch(() => null)
    } catch (exc) {
      if (askedAt !== generation) return
      state.status = 'error'
      state.error = { status: 0, detail: `The API could not be reached: ${exc}` }
      return
    }
    if (askedAt !== generation) return

    if (!res.ok) {
      state.status = 'error'
      state.error = { status: res.status, detail: body?.detail ?? '' }
      return
    }
    state.list = body?.files ?? []
    state.truncated = body?.truncated === true
    state.error = null
    state.status = 'ready'
  }

  // Escape and the backdrop both end up here. The query and the list are kept:
  // closing a popup is not a forget (§2.7).
  function closeDialog() {
    state.open = false
  }

  // §2.6, in order: publish the path as the tree's selection — the tree is
  // lazy, so the entry is synthesised from the path exactly as the search's
  // `openHit` does (`dir: false` routes it to "select a file", and `name` is
  // real because `select()` copies it into `state.selected`) — then close and
  // hand focus back to the pane.
  function pick(path) {
    if (!path) return
    const entry = tree.entryFor(path) ?? {
      path,
      name: path.slice(path.lastIndexOf('/') + 1),
      dir: false,
    }
    tree.select(entry)
    closeDialog()
    paneFocus?.()
  }

  // A working-location switch: every path in the list is relative to a root
  // that no longer exists, so the list and the query that filters it both go —
  // including the open dialog, a popup over a root that does not contain its
  // own rows being the same lie in a louder form. Registered from the factory
  // body, like the other holders: the keyed registry makes a re-registration a
  // replacement of this entry rather than a second copy.
  registerReRootHandler('quickOpen', () => {
    generation += 1 // an answer in flight belongs to the root that was just left
    state.open = false
    state.query = ''
    state.list = []
    state.status = 'idle'
    state.selected = 0
    state.truncated = false
    state.error = null
  })

  return { state, openDialog, closeDialog, pick }
}
