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
// vocabulary, and no LSP method name or JSON-RPC frame appears in this file.
//
// The diagnostics mapping — a wire diagnostic
// `{line, character, endLine, endCharacter, severity, message, source, code}`
// to a Monaco marker — belongs to the diagnostics increment (spec §4.7, §4.11)
// and is deliberately absent here.

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
