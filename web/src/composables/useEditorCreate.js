import { useEditorFiles } from './useEditorFiles'
import { useEditorNotices } from './useEditorNotices'
import { useGitStatus } from './useGitStatus'
import { registerCreateChord, useWorkspaceTree } from './useWorkspaceTree'
import { withWorkspace } from './useWorkspaceSession'

// ---------------------------------------------------------------------------
// The create flow behind the tree's inline name input: New file / New folder.
//
// It is a composable of its own rather than a method of `useWorkspaceTree`, which
// owns the *read* model and stays importable without the buffer half of the pane,
// and rather than a function inside `WorkspaceNavigator.vue`, because its answer
// reaches three places — the tree, the open buffers and the git marks — and a
// component is the wrong owner of state the next component reads.
//
// What a *name* may look like is checked here, so the input answers at once.
// Whether a name is *allowed* is the server's rule and is never duplicated here:
// the refusal comes back in the connector's own wording and that wording is what
// is shown. A second list of protected names in the frontend is exactly what this
// file must never grow.
// ---------------------------------------------------------------------------

// The fast, shape-only half of the answer: null when the name may be sent, a
// sentence when it may not. `taken` is checked here because the alternative is a
// row appearing and then a 409 the user could have been told about for free.
export function validateCreateName(name, { taken = [] } = {}) {
  const value = (name ?? '').trim()
  if (!value) return 'A name is needed'
  if (value.includes('/')) return 'A name cannot contain a slash — make a folder first'
  if (value.includes('\\')) return 'A name cannot contain a backslash'
  if (value.includes('\0')) return 'A name cannot contain that character'
  if (value === '.' || value === '..') return `"${value}" is not a name`
  if (taken.includes(value)) return `${value} is already in this folder`
  return null
}

// "" is the workspace root, so a root child is the bare name.
function childPath(parent, name) {
  return parent ? `${parent}/${name}` : name
}

// One create at a time: the input's Enter has no other guard, and two requests
// for one name would make the second answer a 409 about the first.
let inFlight = null

export function useEditorCreate() {
  const tree = useWorkspaceTree()
  const files = useEditorFiles()
  const git = useGitStatus()
  // The one write-feedback channel: a create that lands says so, and a refused
  // one gets the same copy the row shows, so the news reaches a user whose eyes
  // are on the pane.
  const notices = useEditorNotices()

  // Every entry point to the create flow goes through here — the menu items and
  // the `n`/`N` chords — so one place decides where a name is typed.
  function startCreate(folder, isDir) {
    return tree.startCreate(folder, isDir)
  }

  // The keyboard and the menu items run one flow and leave one set of answers;
  // the tree decides *which* folder the name goes into.
  registerCreateChord((action, folder) => startCreate(folder, action === 'new-folder'))

  // Send the name in the tree's `editing` state. The folder and the kind come
  // from that state, so the row the user typed into is the one answered into.
  //
  // On success: the input clears, *that* listing is re-fetched (not the whole
  // tree), the git marks are re-read (a new file is a new untracked row), and the
  // new row is made visible — a folder expanded and focused, a file revealed and
  // opened, so the empty buffer is a tab ready for Ctrl+S.
  async function submitCreate() {
    const pending = tree.state.editing
    if (!pending) return { ok: false, reason: 'no-input' }
    // The one name input has two modes: a value typed for a rename is a *move*,
    // and creating a new thing from it would be the wrong request entirely.
    if (pending.mode === 'rename') return { ok: false, reason: 'not-a-create' }
    if (inFlight) return inFlight

    const name = (pending.value ?? '').trim()
    const problem = validateCreateName(name, {
      taken: (tree.state.nodes[pending.parent]?.entries ?? []).map((entry) => entry.name),
    })
    if (problem) {
      pending.error = problem
      return { ok: false, reason: 'invalid-name', text: problem }
    }

    const path = childPath(pending.parent, name)
    const run = (async () => {
      let res
      let body = null
      try {
        res = await fetch(withWorkspace('/api/fs/create'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path, dir: pending.isDir }),
        })
        body = await res.json().catch(() => null)
      } catch (exc) {
        const text = `Could not create ${path}: the API could not be reached`
        pending.error = text
        notices.notice('error', text, path)
        return { ok: false, reason: 'network', path, text }
      }

      if (!res.ok) {
        // The server's sentence, verbatim: the deny-list, the taken name, the
        // missing folder and the streaming reply are its rules and its words. A
        // taken name answers with the {reason, path, dir} object, so it is phrased
        // from the reason the server gave rather than a local guess.
        const detail = body?.detail
        const reason =
          typeof detail === 'string'
            ? detail
            : detail?.reason === 'exists'
              ? `${detail.path} is already ${detail.dir ? 'a folder' : 'a file'} on disk`
              : `the request was refused (${res.status})`
        const text = `Could not create ${path}: ${reason}`
        // The input's line stays the bare reason — it sits inside the row the name
        // is typed into. The notice is the copy that travels, so it names the path.
        pending.error = reason
        notices.notice('error', text, path)
        return { ok: false, reason: 'refused', path, text }
      }

      // Clear the input before anything re-renders the listing it was typed into.
      tree.state.editing = null
      await tree.refreshBranch(pending.parent)
      // One level higher too: if this was the first thing in that folder, the
      // folder's own row above still says "nothing to expand".
      await tree.refreshListingOfParent(path)
      void git.load({ force: true })

      if (pending.isDir) {
        // Expand it (empty now, ready for the next New file inside) and put the
        // roving focus on its row.
        tree.expand(path)
        if (tree.entryFor(path)) tree.state.focused = path
      } else {
        await tree.reveal(path)
        await files.openFile(path)
      }
      // The confirmation names what was made: the row may not show it yet (a
      // listing that has not re-rendered, a branch elsewhere).
      notices.notice('ok', `Created ${path}`, path)
      return { ok: true, path, dir: pending.isDir, mtime: body?.mtime ?? null }
    })()
    inFlight = run
    try {
      return await run
    } finally {
      inFlight = null
    }
  }

  return { startCreate, submitCreate }
}
