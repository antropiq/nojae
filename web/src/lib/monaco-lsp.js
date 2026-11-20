// The pure half of the Editor pane's language-server feature: the wire shapes
// `POST /api/lsp/query` answers with, mapped onto the types Monaco's providers
// take. No Vue, no `fetch`, no editor instance — the same split
// `lib/monaco-surface.js` already makes for the reveal clamp, so the mappings
// are testable in jsdom without mounting an editor.
//
// Three rules live here and are the reason the module exists at all:
//
//   * **The `+1`/`-1` lives here and nowhere else.** LSP counts lines and
//     characters from zero, Monaco counts lines and columns from one, and both
//     count characters in UTF-16 code units — so the conversion is exactly `+1`
//     in each axis, with no encoding step and no surrogate handling. A provider
//     that re-derives it is the bug this module prevents (spec §4.8).
//   * **The hover markdown is handed to Monaco as-is, with HTML support off.**
//     The app's rule is that all rendered HTML goes through `lib/markdown.js`
//     and never through raw `v-html`; Monaco's hover is not app markup, so the
//     rule is honoured by configuration at the provider (spec §4.9). This module
//     must not pre-render or sanitise the markdown into HTML — do not "fix" it
//     by adding a renderer here.
//   * **A model's URI is derived from its workspace path, and back.** The
//     derivation is a pure function of the path, so it belongs here rather than
//     in the component: a provider maps a model back to a path through it, and
//     the scheme is what the providers are registered against (spec §6).
//
// The browser never speaks LSP (spec §4.1): the shapes below are the app's own
// vocabulary, and no LSP method name or JSON-RPC frame appears in this file —
// the wire it maps is `POST /api/lsp/query`'s, and the hub is what speaks LSP.
//
// The diagnostics mapping lives here too: a wire item
// `{range: {start, end}, severity, message, code?, source?}` to a Monaco
// marker, plus the severity rule and the counts the Editor's status bar shows
// (spec §4.7, §4.11, D7). It is here because this module owns the `+1`, and a
// marker needs it at both ends of a range; the rule that markers are replaced
// whole, so a fixed defect's underline disappears, is a property of
// `markersForDiagnostics` never merging with a previous list.

// The scheme every model in the Editor's code pane is created with, and the one
// the three providers are registered against — so they answer for this pane's
// models and nothing else.
//
// It is **synthetic, never `file://`**: a `file://` URI makes Monaco's built-in
// TypeScript worker try to resolve imports across files it does not have, which
// is a behaviour change nobody asked for (spec §6). A synthetic scheme leaves
// that worker exactly as it is, which is also what makes it the fall-through
// target of a quiet answer (§4.10).
export const EDITOR_URI_SCHEME = 'nojae-editor'

// A workspace-relative path -> the URI string the pane's model is created with.
// Stable for a path (the same path always yields the same URI) and reversible
// through `pathForEditorUri`, because a provider maps a model back to a path
// through it. Each segment is percent-encoded the way Monaco's own `toString()`
// encodes a path, so the two spellings of one URI agree.
export function editorUriFor(path) {
  const encoded = String(path ?? '')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `${EDITOR_URI_SCHEME}:/${encoded}`
}

// The inverse: a model's URI — a string, or anything with a `toString` such as
// Monaco's own `Uri` — -> the workspace-relative path, or `null` when the URI is
// not this pane's. `null` is the honest answer for a model the pane did not
// create, and every caller treats it as "not mine" rather than as an error.
export function pathForEditorUri(uri) {
  const text = typeof uri === 'string' ? uri : uri?.toString?.() ?? ''
  const prefix = `${EDITOR_URI_SCHEME}:/`
  if (!text.startsWith(prefix)) return null
  try {
    return text
      .slice(prefix.length)
      .split('/')
      .map((segment) => decodeURIComponent(segment))
      .join('/')
  } catch {
    // A malformed escape is not a path: the caller's answer is "not mine".
    return null
  }
}

// LSP position -> Monaco position: `{line, character}` (0-based) becomes
// `{lineNumber, column}` (1-based). Exactly `+1` in each axis and nothing else.
export function lspPositionToMonaco(position) {
  return {
    lineNumber: position.line + 1,
    column: position.character + 1,
  }
}

// Monaco position -> LSP position: the inverse, `-1` in each axis. It exists
// because the gesture starts in Monaco's coordinates and the wire is LSP's, and
// the conversion must live in one place rather than be re-derived at each
// provider.
export function monacoPositionToLsp(position) {
  return {
    line: position.lineNumber - 1,
    character: position.column - 1,
  }
}

// A wire location `{path, line, character}` -> `{path, lineNumber, column}`.
// `path` is already workspace-relative (the hub makes it so), so it travels
// through untouched. A `null` answer — the server found no definition — is a
// no-op returning `null`, never a throw: the gesture falls through to whatever
// Monaco would have done on its own (spec §4.10).
export function wireLocationToMonaco(location) {
  if (!location) return null
  const { lineNumber, column } = lspPositionToMonaco(location)
  return { path: location.path, lineNumber, column }
}

// A wire hover `{markdown, range}` -> Monaco's hover shape. The markdown is a
// string handed over verbatim (see the second rule above); the range is
// converted through the same `+1`, and is `null` when the server named none —
// the markdown is still the answer. A `null` answer is a no-op returning
// `null`.
export function wireHoverToMonaco(hover) {
  if (!hover) return null
  return {
    contents: [{ value: hover.markdown }],
    range: hover.range
      ? {
          startLineNumber: hover.range.start.line + 1,
          startColumn: hover.range.start.character + 1,
          endLineNumber: hover.range.end.line + 1,
          endColumn: hover.range.end.character + 1,
        }
      : null,
  }
}

// A wire location -> the arguments the pane's reveal takes (`{line, column}`,
// 1-based). The clamp is `lib/monaco-surface.js`'s `clampReveal` and the reveal
// is the pane's own exposed method: neither is duplicated here, and this helper
// only says which two numbers the reveal is asked about. `null` in, `null` out.
export function revealFor(location) {
  const mapped = wireLocationToMonaco(location)
  return mapped ? { line: mapped.lineNumber, column: mapped.column } : null
}

// The four marker severities, by the names the wire uses, with Monaco's own
// numeric values. They are written out rather than imported from
// `monaco-editor` because this module stays free of the editor — the pin
// against the bundled enum lives in `tests/monacoLspUri.test.js`, so a version
// bump that moved one fails there.
export const MARKER_SEVERITY = Object.freeze({
  error: 8,
  warning: 4,
  info: 2,
  hint: 1,
})

// A wire severity -> Monaco's marker severity. The wire spells it by name: the
// server's number was resolved to a name once, on the backend, where an omitted
// severity reads as an error (`lsphub/rendering.py`) — this repeats that answer
// rather than inventing a second one, and an unknown name lands on the same
// place. One rule, both sides of the wire.
export function markerSeverityFor(severity) {
  return MARKER_SEVERITY[severity] ?? MARKER_SEVERITY.error
}

// D7: errors and warnings are underlined, hints and information are counted
// only. Stated here once, because two consumers ask it — the markers, which are
// drawn from this predicate, and the bar's counts, which are not (spec §5 D7).
export function isUnderlined(item) {
  const severity = markerSeverityFor(item?.severity)
  return severity === MARKER_SEVERITY.error || severity === MARKER_SEVERITY.warning
}

// The counts the bar shows for a buffer's items: `errors`, `warnings`, and the
// `total`. The total counts **every** item the server reported — hints and
// information included — so an error/warning count alone is never mistaken for
// how much the server said. Counted from the answer's items, not from the
// marker set: a hint has a count and no underline, by D7.
export function diagnosticCounts(items) {
  const counts = { errors: 0, warnings: 0, total: 0 }
  for (const item of Array.isArray(items) ? items : []) {
    const severity = markerSeverityFor(item?.severity)
    if (severity === MARKER_SEVERITY.error) counts.errors += 1
    else if (severity === MARKER_SEVERITY.warning) counts.warnings += 1
    counts.total += 1
  }
  return counts
}

// D5's rule, stated once: **is Monaco's built-in JavaScript/TypeScript engine to
// be silenced for this buffer?**
//
// The answer to "does a declared server answer for this path" is not decided
// here and must not be: it is the bar's own `status` answer, which the hub gives
// from its own state (its off and errored vocabulary included). This function
// only *reads* that answer, so the browser never grows a second path→server rule
// and nothing is compressed to a boolean that loses the reasons the bar shows.
//
// Two arguments, because the bar's answer is **keyed by the path it was asked
// about**: `asked` is that stored pair (`{ path, answer }` of
// `useEditorStatus`'s state) and `path` is the buffer on screen. An answer about
// any other path is not an answer about this one, so it cannot silence this
// buffer.
//
// The result is either `null` — *hand the question back to the defaults*, i.e.
// today's behaviour, unbent — or the override itself. The override always covers
// **both** halves, because a file with a declared server should speak with one
// voice: syntactic validation and semantic validation are silenced together or
// not at all.
export function builtinValidationOverride(asked, path) {
  if (!path || !asked || asked.path !== path) return null
  const answer = asked.answer
  if (!answer || answer.status !== 'ok' || !answer.server) return null
  return { syntactic: false, semantic: false }
}

// Whether a wire coordinate is one Monaco can be handed: two non-negative
// integers. Anything else would be converted into a position near line 0, which
// Monaco clamps into real code — a squiggle on innocent lines.
function isWirePosition(position) {
  return (
    !!position &&
    typeof position === 'object' &&
    Number.isInteger(position.line) &&
    Number.isInteger(position.character) &&
    position.line >= 0 &&
    position.character >= 0
  )
}

// One wire item -> one Monaco marker, or `null` for a shape this module cannot
// map. Both ends go through `lspPositionToMonaco`, the one `+1`; the message
// travels verbatim (the last place the server's words are still words before a
// tooltip), and `code`/`source` are carried only when the server gave them — an
// absent field stays absent rather than becoming a `null` rendered as text.
export function markerForDiagnostic(item) {
  if (!item || typeof item !== 'object') return null
  const range = item.range
  if (!range || !isWirePosition(range.start) || !isWirePosition(range.end)) {
    return null
  }
  const start = lspPositionToMonaco(range.start)
  const end = lspPositionToMonaco(range.end)
  const marker = {
    startLineNumber: start.lineNumber,
    startColumn: start.column,
    endLineNumber: end.lineNumber,
    endColumn: end.column,
    severity: markerSeverityFor(item.severity),
    message: typeof item.message === 'string' ? item.message : String(item.message ?? ''),
  }
  if (item.code != null) marker.code = item.code
  if (item.source != null) marker.source = item.source
  return marker
}

// A buffer's whole marker set: the items D7 underlines, in the server's order,
// with the unmappable ones dropped. It never looks at a previous list and keeps
// no memory, so replacing the set whole — the property that makes a fixed
// defect's underline disappear (spec §6) — is structural here, not lucky.
export function markersForDiagnostics(items) {
  const markers = []
  for (const item of Array.isArray(items) ? items : []) {
    if (!isUnderlined(item)) continue
    const marker = markerForDiagnostic(item)
    if (marker) markers.push(marker)
  }
  return markers
}
