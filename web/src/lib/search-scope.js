// One row of the tree -> the scope the search dialog names and asks the server
// for. `target` is `commandTarget()`'s shape ({ path, name, dir, parent }) from
// useWorkspaceTree; `rootLabel` is that composable's own `rootLabel()`.
//
// It lives in `lib/` so the menu row, the dialog's label and the request share
// one rule, testable without mounting either side.
//
// Returns { kind, label, path, isFile }, or null when there is no row to search:
// a scope invented for an absent row would be a guess.
//
// The root check comes *before* the `dir` one, and that order is the logic: the
// root row answers `dir: true`, so asking about `dir` first reads "the whole
// workspace" as "a folder" and the search covers less than the label promises.
import { ROOT } from '../composables/useWorkspaceTree'

export function scopeFor(target, rootLabel) {
  if (!target || typeof target.path !== 'string') return null

  let kind = 'file'
  let label = target.path
  // The root row has no relative path — it *is* ROOT — so it cannot render as an
  // empty label; it names the workspace itself, as the tree's root row does.
  if (target.path === ROOT) {
    kind = 'workspace'
    label = rootLabel()
  } else if (target.dir) {
    kind = 'folder'
  }
  // `isFile` is read off `kind` rather than set per branch: one answer to "is the
  // scope one file's content?".
  return { kind, label, path: target.path, isFile: kind === 'file' }
}
