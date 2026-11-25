// The workspace tree's context menu, as data: one ordered table of items, each
// saying which rows it applies to, with the template a `v-for` over the answer.
// Adding an item is one row of data.
//
// Two rules the table keeps:
//
//   * an item is **absent rather than disabled-and-lying**: `Close` only when a
//     buffer is open for that file, `View diff…` only when git has a committed
//     side, `Rename…` / `Delete` never on the root row (the working location is
//     neither renamable nor deletable, and there is no listing above it to type
//     a new name into);
//   * a row that cannot be mutated *and* has nothing else to offer gets no menu
//     at all — an empty list is the caller's signal not to open one, because a
//     menu of one useless item is worse than no menu.
//
// Nothing here knows whether a path is *allowed* to be written: that answer is
// the server's, so there is no deny-list and no path policy in this file — only
// the flags the caller already holds.

// The one order every row kind is built from. `scope` says which rows the item
// exists for at all; `needs` names a flag the caller must confirm.
const ITEMS = [
  {
    id: 'open',
    label: 'Open',
    title: 'Open this file in the editor',
    scope: 'file',
  },
  // `scope: 'row'` covers file, folder and root, and there is no `needs` flag —
  // asking "where is this string?" is honest for every row, unlike Close (needs
  // a buffer) or View diff… (needs a committed side). So a folder or the root,
  // which have no Open, get Search as their *first* item.
  {
    id: 'search',
    label: 'Search…',
    title: 'Search inside this folder, this file, or the whole workspace',
    scope: 'row',
  },
  // Preview needs its own flag rather than being read off an open record — a
  // tree row carries no language, and the menu is built before any read happens
  // (lib/markdown-preview).
  {
    id: 'preview',
    label: 'Preview',
    title: 'Show this file rendered as Markdown, instead of as a buffer',
    scope: 'file',
    needs: 'isMarkdown',
  },
  {
    id: 'new-file',
    label: 'New file…',
    title: 'Create an empty file in this folder',
    scope: 'dir',
  },
  {
    id: 'new-folder',
    label: 'New folder…',
    title: 'Create a folder in this folder',
    scope: 'dir',
  },
  {
    id: 'view-diff',
    label: 'View diff…',
    title: 'Show this file beside its committed version',
    scope: 'file',
    needs: 'diffable',
  },
  {
    id: 'rename',
    label: 'Rename…',
    title: 'Rename this in place — type a folder path in the name field to move it (F2)',
    scope: 'row',
    needs: 'mutable',
  },
  // Directly after Rename…, the same mutation family, yet not redundant:
  // Rename… asks for the *full target path* in a field labelled as a name,
  // Move to… asks for the destination **folder** alone and lists every path it
  // is about to move.
  // There is deliberately no `needs` flag: `scope: 'file'` is exactly the set of
  // rows this item can honour, while a flag would have to answer "is this
  // writable", which is never this file's business. `moveCount` feeds the hint
  // only, never presence: a plain right-click on one unmarked file is the N=1
  // case of this same item.
  {
    id: 'move-batch',
    label: 'Move to…',
    scope: 'file',
    title: (flags) =>
      flags.moveCount > 1
        ? `Move these ${flags.moveCount} files into another folder`
        : 'Move this file into another folder',
  },
  {
    id: 'delete',
    label: 'Delete',
    scope: 'row',
    needs: 'mutable',
    danger: true,
    title: (flags) =>
      `Move this to the trash — it stays there for ${flags.trashRetentionDays} days`,
  },
  {
    id: 'close',
    label: 'Close',
    title: 'Close this file\u2019s tab (it asks first if the buffer has unsaved changes)',
    scope: 'file',
    needs: 'hasBuffer',
  },
  {
    id: 'refresh',
    label: 'Refresh',
    title: 'Re-list this folder',
    scope: 'dir',
  },
  {
    id: 'copy-path',
    label: 'Copy relative path',
    title: 'Copy this path, relative to the working location',
    scope: 'row',
  },
]

// Which rows each scope covers. `row` is any row; `dir` is a folder *or* the
// synthetic root (both are folders a new name goes into); `file` is a file row.
function inScope(scope, { dir, isRoot }) {
  if (scope === 'row') return true
  if (scope === 'dir') return dir
  return !dir && !isRoot
}

// The items for one row, in the table's order. `flags`:
//   dir                — the row is a folder (the root row counts as one)
//   isRoot             — the row is the workspace root itself
//   isMarkdown         — the row's name ends in `.md`
//   diffable           — git says this file has a committed side to compare
//   hasBuffer          — a tab already holds this file
//   mutable            — the row may be renamed/deleted (false for the root)
//   trashRetentionDays — quoted in the delete item's hint
//   moveCount          — how many rows the move item's batch covers
export function treeMenuItems(flags) {
  const out = []
  for (const item of ITEMS) {
    if (!inScope(item.scope, flags)) continue
    if (item.needs && !flags[item.needs]) continue
    out.push({
      id: item.id,
      label: item.label,
      danger: !!item.danger,
      title: typeof item.title === 'function' ? item.title(flags) : item.title,
    })
  }
  return out
}

// The ids a row offers — for a test, or for a caller that keys behaviour on them.
export function treeMenuItemIds(flags) {
  return treeMenuItems(flags).map((item) => item.id)
}
