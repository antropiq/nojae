import { useEditorFiles } from './useEditorFiles'
import { useEditorNotices } from './useEditorNotices'
import { useGitStatus } from './useGitStatus'
import { registerRenameChord, useWorkspaceTree } from './useWorkspaceTree'
import { withWorkspace } from './useWorkspaceSession'

// ---------------------------------------------------------------------------
// The rename/move flow behind the tree's inline name input: Rename… and F2.
//
// A sibling of `useEditorCreate`, deliberately not merged with it: a create
// answers into one listing, while a rename answers into every holder of the old
// path — the open records, the active tab key, the tree cache and the git marks.
// That second half belongs to the buffer layer, so one owner for both would be
// the tree importing the pane, the cycle the chord registries exist to prevent.
//
// The shape of what was typed is checked here, per mode: a create names one
// thing, so a slash is a mistake, while a rename expresses a *move* by typing a
// slash. Whether the target is *allowed* is the server's rule — it answers in the
// connector's own wording, and nothing here grows a second list of protected
// paths.
// ---------------------------------------------------------------------------

// "" is the workspace root, so a root child is the bare name.
function joinPath(parent, name) {
  return parent ? `${parent}/${name}` : name
}

function parentOf(path) {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

// The shape half of a rename answer: null when the value may be sent, a sentence
// when it may not. `value` is a bare name or a whole workspace-relative path — a
// `/` is how a move is expressed, exactly the character `validateCreateName`
// forbids. Both forms resolve to the target path the route is sent.
export function validateRenameTarget(value, { from = '', parent = '' } = {}) {
  const text = (value ?? '').trim()
  if (!text) return 'A name is needed'
  if (text.includes('\\')) return 'A name cannot contain a backslash'
  if (text.includes('\0')) return 'A name cannot contain that character'
  if (text.startsWith('/') || text.startsWith('~')) {
    return 'The target must be relative to the working location'
  }
  if (text.split('/').some((segment) => segment === '.' || segment === '..')) {
    return 'The target cannot contain . or ..'
  }
  const target = text.includes('/') ? text : joinPath(parent, text)
  if (!target) return 'The target cannot be the working location itself'
  if (target === from) return 'That is already its name'
  // The server refuses this too, in its own words; answering it here only saves
  // a round trip on the most common way to type this mistake.
  if (target.startsWith(`${from}/`)) return 'A folder cannot be moved inside itself'
  return null
}

// One rename at a time, for the create's reason: a second Enter for one row
// would make the second answer a 409 about the first.
let inFlight = null

export function useEditorRename() {
  const tree = useWorkspaceTree()
  const files = useEditorFiles()
  const git = useGitStatus()
  // The one write-feedback channel: a rename answers in the row, so the notice is
  // the copy for a user whose eyes are on the pane, and the only confirmation a
  // move landed at all.
  const notices = useEditorNotices()

  // Every entry point — the menu item and the `F2` chord — goes through the
  // tree's own `startRename`, so the input opens in the listing that shows the
  // row, prefilled with its name.
  function startRename(path) {
    return tree.startRename(path)
  }

  // `F2` on a focused row reaches this through the tree's chord registry: the
  // keyboard model says which key on which row, this owns the request.
  registerRenameChord((path) => startRename(path))

  // Send the value in the tree's `editing` state, when that state is a rename.
  //
  // On success the records that name the old path are re-pointed **first**, so no
  // tick of the freshness probe sees a tab whose path just vanished and offers to
  // reload a file that was only *moved*; then the tree forgets the old subtree and
  // re-lists the folders the move changed; then the new row is revealed. On
  // refusal nothing moves and the server's sentence appears in the row, the input
  // still holding what was typed.
  async function submitRename() {
    const pending = tree.state.editing
    if (!pending || pending.mode !== 'rename') return { ok: false, reason: 'no-input' }
    if (inFlight) return inFlight

    const from = pending.path
    const problem = validateRenameTarget(pending.value, { from, parent: pending.parent })
    if (problem) {
      pending.error = problem
      return { ok: false, reason: 'invalid-name', text: problem }
    }
    const typed = String(pending.value).trim()
    const to = typed.includes('/') ? typed : joinPath(pending.parent, typed)

    const run = (async () => {
      let res
      let body = null
      try {
        res = await fetch(withWorkspace('/api/fs/rename'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ from, to }),
        })
        body = await res.json().catch(() => null)
      } catch (exc) {
        const text = `Could not rename ${from}: the API could not be reached`
        pending.error = text
        notices.notice('error', text, from)
        return { ok: false, reason: 'network', from, to, text }
      }

      if (!res.ok) {
        // The server's rules in its own sentences; a taken target answers with the
        // {reason, path, dir} object rather than a sentence, so it is phrased from
        // the reason the server gave — the shape a create's refusal takes too.
        const detail = body?.detail
        const reason =
          typeof detail === 'string'
            ? detail
            : detail?.reason === 'exists'
              ? `${detail.path} is already ${detail.dir ? 'a folder' : 'a file'} on disk`
              : `the request was refused (${res.status})`
        // Both ends, because the row the user watched shows only one of them.
        const text = `Could not rename ${from} → ${to}: ${reason}`
        // The row's line stays bare: it sits under the input that names both ends.
        pending.error = reason
        notices.notice('error', text, to)
        return { ok: false, reason: 'refused', from, to, text }
      }

      const target = body?.to ?? to
      tree.state.editing = null

      // The buffers first, for the reason above.
      files.repointPath(from, target)

      // Whether the user had this folder *open* is read before the drop, because
      // the drop is what erases that answer. Re-expansion is this flow's job, not
      // `dropBranch`'.
      const wasOpen = !!tree.state.expanded[from]
      tree.dropBranch(from)
      const parents = new Set([parentOf(from), parentOf(target)])
      await Promise.all([...parents].map((folder) => tree.refreshBranch(folder)))
      // One level higher at *both* ends: the folder moved into may have been an
      // empty branch (its row needs the arrow back), the one left may now be empty
      // (its row needs the arrow gone).
      await tree.refreshListingOfParent(from)
      await tree.refreshListingOfParent(target)

      // The new row is made visible. A file goes through `reveal`, which publishes
      // the selection — the pane's watcher skips that echo. A folder is only
      // expanded and focused: publishing a folder as a *file* selection would ask
      // the pane to open a folder.
      if (body?.dir) {
        if (wasOpen) tree.expand(target)
        if (tree.entryFor(target)) tree.state.focused = target
      } else {
        await tree.reveal(target)
      }

      void git.load({ force: true })
      // Both ends: a move is about two paths and the row shows only one of them.
      notices.notice('ok', `Renamed ${from} → ${target}`, target)
      return { ok: true, from, to: target, dir: !!body?.dir, mtime: body?.mtime ?? null }
    })()
    inFlight = run
    try {
      return await run
    } finally {
      inFlight = null
    }
  }

  return { startRename, submitRename }
}
