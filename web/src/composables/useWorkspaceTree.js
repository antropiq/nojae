import { reactive } from 'vue'

import { withWorkspace } from './useWorkspaceSession'

// ---------------------------------------------------------------------------
// Workspace tree: the state behind WorkspaceNavigator.vue.
//
// One singleton, like every other composable: the opened branches, the focus and
// the selection live *here*, so a tab switch (`v-show`) keeps the tree exactly as
// the user left it and the code pane can consume `selected` without touching the
// navigator.
//
// The tree is lazy: one `GET /api/fs/tree` per directory, on first expand, cached
// by path — the workspace may be a huge checkout. Paths are workspace-relative
// ("" is the root) and the server applies the policy, so a denied file is simply
// absent from the payload. `refresh()` drops every cache entry and re-lists what
// is on screen. A *new working location* is the harder case: those paths now name
// other files, so `reRoot()` forgets the whole tree and hands the stale paths to
// every other holder of them. A mutation touches one folder, so
// `refreshBranch(path)` re-lists exactly that listing.
//
// The tree is also where a name is typed: `editing` is the inline input's state
// (see TreeNameInput.vue), in `create` and `rename` modes. The name's shape and
// the listing's own contents are checked by useEditorCreate / useEditorRename;
// whether a name is protected is the server's rule and arrives as a refusal —
// there is deliberately no copy of the deny-list here.
//
// **The subject of every tree command is the focused row** (`commandTarget()`):
// the keyboard chords, the context menu and the row actions all ask that one
// question, so they cannot disagree about which row "this folder" means. It is
// not `selected`, which means "the pane should open this file".
//
// A batch lives here in its own two fields (`marked` / `markAnchor`), never in
// `selected`: a batch needs none of its size/mtime and must not be dropped by
// `dropBranch`. `marked` holds *file* rows only (a folder row is refused entry by
// construction, which is what keeps a batch safe to move); `batchFor(path)` is
// the one place that answers what a command opened on a row would cover. Marking
// opens nothing and closes nothing.
// ---------------------------------------------------------------------------

export const ROOT = ''

const state = reactive({
  // Cache of one listing per path, plus the per-path fetch status.
  nodes: {},
  // Opened branches; the root starts open. Here rather than in the component so
  // every path the user opened survives a tab switch.
  expanded: { '': true },
  focused: ROOT, // roving-focus path (the tree row in the tab order)
  selected: null, // { path, name, dir, size, mtime } — the code pane's input
  workspace: '', // absolute path of the browsed workspace, from the server
  error: null,
  // The batch: ordered paths of the *file* rows the user put in it, plus the
  // path a `Shift` range grows from. Files only, so no consumer needs a cycle
  // check; never a use of `selected`.
  marked: [],
  markAnchor: null,
  // The inline name input: `{ mode, parent, path, isDir, value, error }` while
  // the user is naming something, or null. `mode` is `'create'` (the name goes
  // into `parent`) or `'rename'` (the row at `path` is renamed *within*
  // `parent`, so the input sits in the listing that shows it). Tree state, not
  // component state: a half-typed name must survive a re-render and a tab switch.
  // One object serves both modes, whose widget and focus rule are the same.
  editing: null,
})

// Join a parent and a name the way the server spells a path ("" is the root, so
// a root child is the bare name).
function childPath(parent, name) {
  return parent ? `${parent}/${name}` : name
}

function blankNode() {
  return { loaded: false, loading: false, entries: [], truncated: false, error: null }
}

function node(path) {
  if (!state.nodes[path]) state.nodes[path] = blankNode()
  return state.nodes[path]
}

function parentOf(path) {
  const index = path.lastIndexOf('/')
  return index === -1 ? ROOT : path.slice(0, index)
}

function depthOf(path) {
  return path ? path.split('/').length : 0
}

// The rows currently on screen, in visual order. Keyboard navigation and
// `aria-posinset` are both derived from this one list, so neither can disagree
// with what is rendered.
function visiblePaths() {
  const out = [ROOT]
  const walk = (path) => {
    if (!state.expanded[path]) return
    for (const entry of state.nodes[path]?.entries ?? []) {
      out.push(entry.path)
      walk(entry.path)
    }
  }
  walk(ROOT)
  return out
}

// The paths whose *listing* is on screen — what refresh() has to re-fetch: the
// root plus every folder the user has opened. Unlike `visiblePaths()` it skips
// file rows (the tree endpoint refuses one with 400) and collapsed folders (on
// screen, but their next expand re-lists them anyway).
function openDirPaths() {
  const out = [ROOT]
  const walk = (path) => {
    if (!state.expanded[path]) return
    for (const entry of state.nodes[path]?.entries ?? []) {
      if (entry.dir && state.expanded[entry.path]) {
        out.push(entry.path)
        walk(entry.path)
      }
    }
  }
  walk(ROOT)
  return out
}

// The fetch in flight per path, outside the reactive state so nobody observes a
// Promise. A second `load()` *joins* the running fetch rather than returning
// early, which is what reveal() below depends on.
const inflight = new Map()

// Bumped whenever the tree stops belonging to the folder it was listing. `load`
// stamps the token it asked with and drops the answer when the token moved: a
// late reply would otherwise re-write old rows into the new tree.
let generation = 0

// What the *other* holders of the previous workspace do when it is replaced: the
// open buffers with their git marks, the search results. The same one-way
// registry the chords use, so this module stays a read model and imports no
// write half.
//
// A list rather than one slot, because more than one holder exists. Each
// registers under its own key, so re-registering replaces that holder's entry
// instead of appending a second copy.
const reRootHandlers = new Map()

export function registerReRootHandler(key, handler) {
  if (typeof key !== 'string' || !key) return
  if (typeof handler !== 'function') {
    reRootHandlers.delete(key)
    return
  }
  reRootHandlers.set(key, handler)
}

// The tree owns the keyboard model (which key, in which folder) and
// `useEditorCreate` owns the request. One-way, so this module never imports the
// create half and the lazy Editor chunk stays lazy.
let createChord = null

export function registerCreateChord(handler) {
  createChord = typeof handler === 'function' ? handler : null
}

// Same one-way registry for the delete chord (`Delete`/`Shift+Delete`): the tree
// says which key and on which row, the buffer half owns the confirmation and the
// request — so a cycle between the two files stays impossible.
let deleteChord = null

export function registerDeleteChord(handler) {
  deleteChord = typeof handler === 'function' ? handler : null
}

// …and the same for the rename chord (`F2`), whose input and request belong to
// `useEditorRename`.
let renameChord = null

export function registerRenameChord(handler) {
  renameChord = typeof handler === 'function' ? handler : null
}

// …and for the refresh chord (`r`), which needs no write half but does need the
// git marks the navigator owns: the answer re-lists the focused folder and
// re-reads which files are unstaged, as the header's refresh button does for the
// whole tree.
let refreshChord = null

export function registerRefreshChord(handler) {
  refreshChord = typeof handler === 'function' ? handler : null
}

// True when `candidate` is `path` itself or something below it. The trailing slash
// is what keeps `src/x.pyw` out of `src/x.py`'s subtree.
function sameOrUnder(candidate, path) {
  if (!path || typeof candidate !== 'string') return false
  return candidate === path || candidate.startsWith(`${path}/`)
}

export function useWorkspaceTree() {
  // A path is fetched at most once concurrently, so a double click never
  // double-lists.
  async function load(path = ROOT, { force = false } = {}) {
    const entry = node(path)
    if (entry.loaded && !force) return
    const running = inflight.get(path)
    // A joining caller waits for the running fetch, which is what reveal()
    // depends on. A forced call still re-lists afterwards: after refresh() dropped
    // the cache, the fetch it joins writes into an orphaned entry.
    if (running) await running
    if (entry.loaded && !force) return
    entry.loading = true
    state.error = null
    const run = (async () => {
      const askedAt = generation
      try {
        const res = await fetch(
          withWorkspace(`/api/fs/tree?path=${encodeURIComponent(path)}`),
        )
        const body = await res.json().catch(() => null)
        if (askedAt !== generation) return
        if (!res.ok) {
          const detail = typeof body?.detail === 'string' ? body.detail : ''
          entry.error = detail || `Could not list the folder (${res.status})`
          state.error = entry.error
          return
        }
        state.workspace = body.workspace || state.workspace
        entry.entries = body.entries || []
        entry.truncated = !!body.truncated
        entry.loaded = true
        entry.error = null
      } catch (exc) {
        entry.error = `Could not reach the API: ${exc}`
        state.error = entry.error
      } finally {
        entry.loading = false
        if (inflight.get(path) === run) inflight.delete(path)
      }
    })()
    inflight.set(path, run)
    await run
  }

  // One listing, re-fetched: what a mutation just made true about *one* folder.
  // `refresh()` costs every opened branch, which is not what a
  // create/rename/delete should pay.
  //
  // An unloaded folder is skipped: its next expand fetches it anyway. The focus
  // is revalidated because a re-list can drop the row that had it.
  async function refreshBranch(path) {
    if (!state.nodes[path]?.loaded) return
    await load(path, { force: true })
    revalidateFocus()
  }

  // One level up from a mutation: the listing that holds the row of the folder
  // the change happened in. A directory row's `children` flag comes from its
  // parent's listing and means "expanding will show something", so creating the
  // first file inside a folder leaves that row still claiming it has nothing to
  // expand — a lie about a branch the user may be staring at, since the arrow is
  // drawn from that flag.
  //
  // So: only when the flag says `false`, and only for a folder that is not in the
  // root, whose own listing the mutation already re-listed.
  async function refreshListingOfParent(path) {
    const parent = parentOf(path)
    if (parent === ROOT) return
    const row = entryFor(parent)
    if (!row || row.children) return
    await refreshBranch(parentOf(parent))
  }

  // Drop the cache and re-list what is on screen. The opened branches stay open —
  // a refresh is not a collapse — because the folders it re-lists still exist.
  async function refresh() {
    // Snapshot the on-screen folders *before* the cache is dropped: after that,
    // the walk that answers "what is on screen" has nothing left to walk.
    const openDirs = openDirPaths()
    state.nodes = {}
    await Promise.all(openDirs.map((path) => load(path, { force: true })))
    // A re-list can drop the focused file (deleted, or now hidden by policy),
    // which would leave the roving tabindex on a row that is no longer rendered.
    revalidateFocus()
  }

  // A *new* working location: not a refresh, because the paths this tree holds
  // are relative to the previous root and stop meaning anything when it moves.
  // `src/a.py` of one project and of another are two different files, so every
  // cached listing has to go rather than be re-fetched — and so does every piece
  // of state pointing at the old paths.
  //
  // The token bump is what makes the forget stick: a listing already in flight
  // answers after the switch with rows belonging to the folder just left.
  // `reRootHandlers` carries the same news to every other holder of those paths.
  //
  // `rootPath` is the location the server confirmed, adopted as the root label
  // straight away rather than waiting for the new tree's first listing.
  async function reRoot(rootPath = '') {
    generation += 1
    inflight.clear()
    state.nodes = {}
    state.expanded = { [ROOT]: true }
    state.focused = ROOT
    state.selected = null
    state.editing = null
    // The batch too: those paths mean nothing in the new root, which is the
    // same argument the lines above make for the focus, the selection and a
    // half-typed name.
    state.marked = []
    state.markAnchor = null
    state.error = null
    // The previous root is not kept even when no new one is named: the label
    // and title would then point at a folder nothing is browsing. The listing
    // below writes the confirmed value as soon as the server answers.
    state.workspace = rootPath
    // One holder failing must not cancel the others' cleanup, so each call is
    // caught and named rather than thrown past the next subscriber.
    const failures = []
    for (const handler of reRootHandlers.values()) {
      try {
        handler({ workspace: rootPath })
      } catch (exc) {
        failures.push(String(exc))
      }
    }
    await load(ROOT)
    // Reported *after* the listing: `load` clears this field on the way in, so a
    // failure recorded before it would be erased by a successful listing and never
    // reach the user. A failed listing says the more urgent thing and keeps it.
    if (failures.length && !state.error) {
      state.error = `Could not clear the previous workspace: ${failures.join('; ')}`
    }
  }

  function expand(path) {
    state.expanded[path] = true
    if (!node(path).loaded) load(path)
  }

  function collapse(path) {
    delete state.expanded[path]
    revalidateFocus()
  }

  // Is this row on screen: its listing loaded, its entry there, and every folder
  // above it expanded?
  function isDisplayed(path) {
    if (path === ROOT) return true
    let current = path
    while (current !== ROOT) {
      if (!state.expanded[parentOf(current)] || !entryFor(current)) return false
      current = parentOf(current)
    }
    return true
  }

  // The roving tabindex has to be carried by a rendered row, or the tree cannot be
  // tabbed into. A focused path can stop being displayed under the user — a
  // re-list drops the file, a reveal fails, a collapse hides the branch — so focus
  // walks up to the nearest row still on screen.
  function revalidateFocus() {
    if (isDisplayed(state.focused)) return
    let current = state.focused
    while (current !== ROOT && !isDisplayed(current)) current = parentOf(current)
    state.focused = current
  }

  // Close every branch the user opened. The root stays open — a collapsed root
  // would leave no row to re-open it — and listings keep their cache. Focus lands
  // on the root, the only row guaranteed to still be on screen.
  function collapseAll() {
    state.expanded = { [ROOT]: true }
    state.focused = ROOT
  }

  function toggle(path) {
    if (state.expanded[path]) collapse(path)
    else expand(path)
  }

  // -- the inline name input -------------------------------------------------
  //
  // Ask for a name inside `parent` ("" is the workspace root). The branch is
  // opened and its listing fetched first, because the input renders *inside* that
  // listing and the "already in this folder" check reads it.
  //
  // Not awaited: a request would put a pause between the gesture and the caret,
  // and `load()` joins the running fetch anyway. A parent that is not a folder is
  // refused rather than asked about — there is no listing to type into.
  function startCreate(parent, isDir) {
    if (parent !== ROOT && !entryFor(parent)?.dir) return false
    expand(parent)
    state.focused = parent
    state.editing = { mode: 'create', parent, isDir: !!isDir, value: '', error: null }
    return true
  }

  // Ask for a new name for the row at `path`, in the listing that shows it: the
  // same `editing` state as a create, whose submitted value is here the full new
  // path of an existing row.
  //
  // The value is prefilled with the current name and the row's folder is opened
  // first, because the input renders inside that listing. The root row is not a
  // candidate: the working location has no folder above it to type into.
  function startRename(path) {
    if (!path) return false
    const entry = entryFor(path)
    if (!entry) return false
    const parent = parentOf(path)
    expand(parent)
    state.focused = path
    state.editing = {
      mode: 'rename',
      path,
      parent,
      isDir: !!entry.dir,
      value: entry.name,
      error: null,
    }
    return true
  }

  function cancelCreate() {
    state.editing = null
  }

  function updateCreateValue(value) {
    if (!state.editing) return
    state.editing.value = value
    // A new attempt is a new answer: the old refusal stops being about this text.
    state.editing.error = null
  }

  // The subject of every tree command: the focused row, as its path, its name and
  // the folder it lives in ("" for a root child). Built from `entryFor`, so it is
  // always the listing's own answer rather than a reverse-engineered path string.
  //
  // A focused row a re-list dropped has no subject, and every command that needs
  // one declines. `dir` says whether `path` is a folder or a neighbour of one.
  function commandTarget() {
    const path = state.focused
    const entry = entryFor(path)
    if (!entry) return null
    return { path, name: entry.name, dir: !!entry.dir, parent: parentOf(path) }
  }

  // -- the batch: marked rows ------------------------------------------------
  //
  // Marking is a *gesture-level* fact: it never issues a request, never opens a
  // buffer and never touches `selected`. The row style, the navigator's count
  // line and the write flow's `batchFor` answer all read these two fields.

  // Put one *file* path in or take it out — by path, or by the row's entry when
  // the caller has it (the click does, and its `dir` is the listing's own answer
  // rather than a lookup). A folder row is refused entry, explicitly, so a future
  // gesture that marks folders fails here rather than shipping a batch that would
  // move a tree. The toggled path becomes the anchor, so the next `Shift` gesture
  // grows from where the pointer was.
  function toggleMark(target) {
    const path = typeof target === 'string' ? target : target?.path
    if (!path) return
    const entry = typeof target === 'string' ? entryFor(path) : target
    if (entry?.dir) return
    const index = state.marked.indexOf(path)
    if (index === -1) state.marked.push(path)
    else state.marked.splice(index, 1)
    state.markAnchor = path
  }

  // The marks become exactly the *file* rows in the visual span between the anchor
  // and `toPath` — a range is an answer to "which rows", not an append, so a
  // second `Shift`+ArrowDown grows the set instead of accumulating one per
  // keystroke. Folder rows in the span are skipped, and a span may cross parents:
  // narrowing it to one folder is `batchFor`'s job. With no anchor the gesture is
  // its own range, so a first `Shift`+click cannot invent a span from nowhere.
  function rangeMark(toPath) {
    const paths = visiblePaths()
    const anchor = state.markAnchor ?? toPath
    const from = paths.indexOf(anchor)
    const to = paths.indexOf(toPath)
    if (from === -1 || to === -1) return
    const [lo, hi] = from <= to ? [from, to] : [to, from]
    state.marked = paths
      .slice(lo, hi + 1)
      .filter((path) => !entryFor(path)?.dir)
    state.markAnchor = anchor
  }

  function clearMarks() {
    state.marked = []
    state.markAnchor = null
  }

  // What a command opened on `path` covers — decided **once**, when the menu
  // opens, because by the time an item is clicked the marks may have moved. The
  // whole mark set only when the row is itself marked, there is more than one
  // mark, and every mark shares that row's folder; otherwise this one row. A
  // cross-parent selection therefore narrows visibly while the marks stay
  // highlighted — the dialog's list, not the highlight, is what the user reads.
  function batchFor(path) {
    const parent = parentOf(path)
    const marks = state.marked
    if (
      marks.length >= 2 &&
      marks.includes(path) &&
      marks.every((item) => parentOf(item) === parent)
    ) {
      return { paths: [...marks], parent }
    }
    return { paths: [path], parent }
  }

  // Selection is a row click: a folder only toggles (an open folder is not
  // something a code pane could load), a file is recorded with its entry, so the
  // consumer has its size and mtime without a second request.
  //
  // EditorArea watches it and opens the file. Selection and the editor's active
  // buffer stay separate on purpose: a refused click (binary, over the cap)
  // selects a row without putting anything in a tab.
  //
  // The click's `event` decides what happens to the *batch*:
  //
  //   * plain click — the marks go; it is a fresh look at one row, not a way to
  //     extend anything.
  //   * `Ctrl`/`Cmd`+click — this path toggles in `marked` and the normal
  //     selection still runs, so the row under the cursor is both the row you
  //     look at and the row you add.
  //   * `Shift`+click — every *file* row in the visual span between `markAnchor`
  //     and this row joins the batch. The span comes from `visiblePaths()`, so a
  //     range can never disagree with what is rendered.
  //
  // Callers that are not a click at all — the `Enter`/`Space` chord, the menu's
  // Open, a search hit — pass no event and answer what a plain click does: this
  // row, on its own.
  function select(entry, event) {
    if (!entry) return
    if (event?.ctrlKey || event?.metaKey) toggleMark(entry)
    else if (event?.shiftKey) rangeMark(entry.path)
    else {
      clearMarks()
      state.markAnchor = entry.path
    }
    state.focused = entry.path
    if (entry.dir) {
      toggle(entry.path)
      return
    }
    state.selected = {
      path: entry.path,
      name: entry.name,
      dir: false,
      size: entry.size ?? null,
      mtime: entry.mtime ?? null,
    }
  }

  // The reverse direction of the tree <-> tab-strip link: focusing a tab in
  // EditorArea selects the row of its file here.
  //
  // The tree is lazy, so that row usually does not exist yet: every listing on
  // the way down is fetched and every branch opened. A cached listing that does
  // not carry the path may simply predate the file (the WorkBench writes files),
  // so that folder is re-listed once before giving up.
  //
  // Failure — a denied path, a folder that refuses its listing, a file that
  // disappeared — leaves the selection exactly as it was: a tab the tree cannot
  // show must not highlight some other row. A reveal finishing after a newer one
  // started is dropped for the same reason.
  //
  // `source: 'tab'` marks where the selection came from, so EditorArea's watcher
  // can skip it: replaying it as a click would be a redundant round-trip back
  // into the buffer that caused it.
  let revealSeq = 0

  async function reveal(path) {
    if (!path) return false
    const seq = ++revealSeq
    let current = ROOT
    for (const name of path.split('/')) {
      if (!state.nodes[current]?.loaded) await load(current)
      const child = childPath(current, name)
      let entry = entryFor(child)
      if (!entry) {
        await load(current, { force: true })
        entry = entryFor(child)
        if (!entry) return false
      }
      if (child === path) break // the last segment is the file's own row
      // A segment that is not a folder means the listings and the open buffers
      // disagree; there is no branch to open below it.
      if (!entry.dir) return false
      expand(child)
      current = child
    }
    if (seq !== revealSeq) return false
    const entry = entryFor(path)
    if (!entry) return false
    // The row exists now, so it also takes the tree's focus: the roving tabindex
    // lands where the eye is sent, and the navigator scrolls it into view.
    state.focused = path
    state.selected = {
      path,
      name: entry.name,
      dir: false,
      size: entry.size ?? null,
      mtime: entry.mtime ?? null,
      source: 'tab',
    }
    return true
  }

  function moveFocus(delta) {
    const paths = visiblePaths()
    const index = paths.indexOf(state.focused)
    if (index === -1) return
    const next = Math.min(Math.max(index + delta, 0), paths.length - 1)
    state.focused = paths[next]
  }

  function focusEdge(last) {
    const paths = visiblePaths()
    state.focused = paths[last ? paths.length - 1 : 0]
  }

  // The batch half of the four navigation chords, after the focus has moved:
  // `Shift` extends the marks over the span the arrows just walked, and a plain
  // arrow only moves the anchor, which is where the next range grows from. Marks
  // are not cleared here.
  function extendMarks(event) {
    if (event.shiftKey) rangeMark(state.focused)
    else state.markAnchor = state.focused
  }

  // Forget everything the tree knew about a path and its subtree, without
  // re-listing anything: what a rename does to the cache *before* the affected
  // folders are re-fetched.
  //
  // The cache is keyed by folder path, so a renamed folder leaves stale keys
  // behind: its own listing, its descendants' listings, and the `expanded` flags
  // carried by all of them. Dropping them makes the re-list afterwards the only
  // source of the new names — an entry still carrying the old path would keep
  // rendering a row that no longer exists. Re-expansion is the caller's job,
  // which is why the flags go with the entries rather than surviving them.
  function dropBranch(path) {
    if (!path) return
    for (const key of Object.keys(state.nodes)) {
      if (sameOrUnder(key, path)) delete state.nodes[key]
    }
    for (const key of Object.keys(state.expanded)) {
      if (sameOrUnder(key, path)) delete state.expanded[key]
    }
    if (sameOrUnder(state.focused, path)) state.focused = parentOf(path)
    if (sameOrUnder(state.selected?.path, path)) state.selected = null
    // A batch that outlives its own rows is worse than no batch: the marks go
    // with the paths they name, as the focus and the selection do.
    if (state.marked.some((item) => sameOrUnder(item, path))) {
      state.marked = state.marked.filter((item) => !sameOrUnder(item, path))
    }
    if (sameOrUnder(state.markAnchor, path)) state.markAnchor = null
  }

  // The entry a path refers to, looked up in its parent's listing — the tree has
  // no global path index, the listings *are* the index. The root answers with a
  // synthetic directory row, since it always exists and is always open.
  function entryFor(path) {
    if (path === ROOT) {
      return { name: rootLabel(), path: ROOT, dir: true, children: true }
    }
    return state.nodes[parentOf(path)]?.entries.find((item) => item.path === path) ?? null
  }

  // The one keyboard model of the tree:
  //
  //   ↑ ↓ ← → Home End   move the roving focus, open/close a branch
  //     (with Shift on ↑ ↓ Home End: the same move, and the batch grows to
  //      cover the span from the anchor — there is no chord *key* for a move)
  //   Enter / Space      select (open a file, toggle a folder)
  //   n / N              New file / New folder in the focused folder
  //   F2                 rename the focused row
  //   Delete             delete the focused row (asks first)
  //   r                  re-list the focused folder (the file's parent for a file)
  //
  // It lives in the composable, not the component, so `visiblePaths()` stays the
  // single source of truth for what is on screen, and every chord's subject is
  // the focused row — which is also what the context menu sets before it acts, so
  // mouse and keyboard agree about "this row".
  //
  // A single letter is only safe because the container is a `role="tree"` widget
  // that takes focus as a whole, so these letters mean something only while a row
  // has the focus, and nowhere else: Monaco, the terminal, a chat box and the name
  // input all own their own keystrokes. The guards: `editing` is checked first,
  // because while the name input is on screen it owns the keyboard and a chord
  // that typed into itself is the bug this stops; a modifier chord is never one of
  // ours; and a modal `<dialog>` keeps the caret inside itself, so no tree chord
  // can reach into one.
  //
  // The destructive and creating keys answer *through* the registries above, and
  // the workspace root is never a candidate for rename or delete: it has no name
  // to change and no folder above it to type one into.
  //
  // The return value answers "did the tree *own* this keystroke?", which the
  // navigator needs: the container sees the keydowns of everything inside it,
  // including the name input, and must move the caret to the focused row only for
  // the keys it acted on. Otherwise a character typed into that input would throw
  // the caret out of it.
  function handleKey(event) {
    if (state.editing) return false
    if (event.ctrlKey || event.metaKey || event.altKey) return false
    const path = state.focused
    const directory = path === ROOT || !!entryFor(path)?.dir
    if (event.key === 'ArrowDown') {
      moveFocus(1)
      extendMarks(event)
    } else if (event.key === 'ArrowUp') {
      moveFocus(-1)
      extendMarks(event)
    } else if (event.key === 'Home') {
      focusEdge(false)
      extendMarks(event)
    } else if (event.key === 'End') {
      focusEdge(true)
      extendMarks(event)
    } else if (event.key === 'ArrowRight') {
      if (directory && !state.expanded[path]) expand(path)
      else moveFocus(1)
    } else if (event.key === 'ArrowLeft') {
      if (directory && state.expanded[path]) collapse(path)
      else if (path !== ROOT) state.focused = parentOf(path)
    } else if (event.key === 'Enter' || event.key === ' ') {
      select(entryFor(path) ?? { path, dir: directory })
    } else if (event.key === 'n' || event.key === 'N') {
      // New file / new folder, in the focused folder — or next to the focused
      // file, since the user's intent is "here". This model only says which key
      // means which kind, and in which folder.
      createChord?.(event.shiftKey ? 'new-folder' : 'new-file', directory ? path : parentOf(path))
    } else if (event.key === 'F2') {
      // Rename the focused row — the tree's own chord, next to `Delete`: same
      // one-way registry, same reason. The root is not a candidate: there is no
      // listing above it to type a new name into.
      if (path === ROOT) return false
      renameChord?.(path)
    } else if (event.key === 'Delete') {
      // Delete the focused row. The root is not a candidate: the working location
      // is never deletable, and offering it would only collect a refusal.
      // `deleteChord` asks the user and then deletes. The *row* travels, not just
      // the path, so the confirmation names what the user was looking at.
      if (path === ROOT) return false
      deleteChord?.(entryFor(path) ?? { path, dir: directory, name: path })
    } else if (event.key === 'r' || event.key === 'R') {
      // Re-list the focused folder — or, for a file row, the folder that lists it,
      // the only listing that row can be wrong about. `refreshChord` is the
      // navigator's answer (folder listing + git marks).
      refreshChord?.(directory ? path : parentOf(path))
    } else {
      return false
    }
    event.preventDefault()
    return true
  }

  // The workspace basename, so the root row says *which* checkout is being
  // browsed; the absolute path rides in its `title`.
  function rootLabel() {
    const workspace = state.workspace
    if (!workspace) return 'workspace'
    const trimmed = workspace.replace(/[/\\]+$/, '')
    const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))
    return index === -1 ? trimmed : trimmed.slice(index + 1)
  }

  return {
    state,
    ROOT,
    load,
    refresh,
    reRoot,
    refreshBranch,
    refreshListingOfParent,
    expand,
    collapse,
    collapseAll,
    toggle,
    startCreate,
    startRename,
    cancelCreate,
    updateCreateValue,
    commandTarget,
    dropBranch,
    select,
    toggleMark,
    rangeMark,
    clearMarks,
    batchFor,
    reveal,
    entryFor,
    handleKey,
    rootLabel,
    parentOf,
    depthOf,
    visiblePaths,
  }
}
