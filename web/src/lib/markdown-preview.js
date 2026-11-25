// ---------------------------------------------------------------------------
// "Is this a markdown file?" — the one place that answers it.
//
// The question is asked from a *tree row*, before any read has happened, and a
// tree entry carries no language. So the answer cannot come from an open record
// (`record.language === 'markdown'` only describes a file already in the strip)
// and it cannot come from `lib/file-icons.js`, which maps names to Nerd Font code
// points by *stem* — a different question, on a generated table.
//
// The rule mirrors `LANGUAGE_BY_EXTENSION['.md'] === 'markdown'` in
// `src/core/editorfs/files.py`, the table the server uses to name the buffer's
// Monaco language:
//
//   * `.md` only, case-insensitive — a second extension means editing that
//     server table too, and agreeing with the server is the point: the menu must
//     never promise a preview for a file the pane calls `plaintext`;
//   * a dotfile has no extension, mirroring `language_for()`'s own guard, so a
//     file literally named `.md` is not previewable;
//   * uppercase is fine: the server lowercases too.
//
// Known and out of scope: a preview renders no relative *images* and navigates
// away on a relative *link*. `renderMarkdown` rewrites no `src`/`href` and the
// app has no byte-serving route (`GET /api/fs/file` is text-only and capped), so
// `<img src="diagram.png">` resolves against the app origin and a relative
// `<a href="other.md">` leaves the SPA. Fixing either needs a new asset route
// gated by the same workspace policy or an anchor interceptor inside the preview
// container — never a global DOMPurify hook in `lib/markdown.js`, which the chat
// shares.
// ---------------------------------------------------------------------------

export function isMarkdownPath(path) {
  if (typeof path !== 'string' || !path) return false
  // The extension is a property of the *name*: the server hands `language_for()`
  // a file name, so `dir/.md` must read as a dotfile here too.
  const separator = path.lastIndexOf('/')
  const name = separator === -1 ? path : path.slice(separator + 1)
  const index = name.lastIndexOf('.')
  // -1 is a name with no dot, 0 is a dotfile: neither has an extension to key on,
  // exactly as the server's `language_for()` reads them.
  if (index <= 0) return false
  return name.slice(index).toLowerCase() === '.md'
}
