import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import JsonWorker from 'monaco-editor/language/json/json.worker.js?worker'
import CssWorker from 'monaco-editor/language/css/css.worker.js?worker'
import HtmlWorker from 'monaco-editor/language/html/html.worker.js?worker'
import TsWorker from 'monaco-editor/language/typescript/ts.worker.js?worker'

// Workers are configured once per page, before any editor exists: Monaco asks
// `MonacoEnvironment.getWorker(label)` at first use of each language service,
// and Vite's `?worker` suffix is what turns each worker source into a
// same-origin module worker instead of a fetch of an unbundled file.
//
// The label is chosen by Monaco, not by us: `editorWorkerService` for the core
// worker, otherwise the language id (`json`, `css`/`scss`/`less`,
// `html`/`handlebars`/`razor`, `typescript`/`javascript`). Anything unmapped
// falls back to the editor worker — a wrong worker fails the language service, a
// missing one fails the editor.
//
// It lives here rather than inside MonacoEditor.vue because *both* Monaco
// surfaces (the code pane and the diff viewer) need it, and a module-scoped side
// effect in one component only happens to run before the other one imports it.
export function ensureMonacoWorkers() {
  if (self.MonacoEnvironment) return
  self.MonacoEnvironment = {
    getWorker(_workerId, label) {
      switch (label) {
        case 'json':
          return new JsonWorker()
        case 'css':
        case 'scss':
        case 'less':
          return new CssWorker()
        case 'html':
        case 'handlebars':
        case 'razor':
          return new HtmlWorker()
        case 'typescript':
        case 'javascript':
          return new TsWorker()
        default:
          return new EditorWorker()
      }
    },
  }
}

// The app's mono stack comes from the theme token rather than a literal, so a
// Monaco surface cannot drift from the rest of the UI's monospace text.
export function monoFontFamily() {
  const fromToken = getComputedStyle(document.documentElement)
    .getPropertyValue('--pico-font-family-monospace')
    .trim()
  return fromToken || 'ui-monospace, SFMono-Regular, monospace'
}

// Pico's theme is the single source of truth for light/dark: the `data-theme`
// attribute on `<html>`, set before first paint and flipped by useTheme.
// Monaco's built-in themes are `vs` (light) and `vs-dark`, so the mapping is one
// line — but it must be *read* at mount (an editor can be created long after
// boot) and re-read on every change.
export function picoMonacoTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light'
    ? 'vs'
    : 'vs-dark'
}

// The reveal of a search hit: the coordinates come from a *scan*, which may be
// stale by the time the buffer holds the file. Monaco's behaviour for an
// out-of-range position is not part of this contract, so the clamp happens here
// — the line capped to the model's line count, the column to that line's max
// column.
//
// It is a pure helper taking the model facts as arguments (`lineCount` and a
// `maxColumnFor(line)` callback) because the only instance that knows them lives
// inside a component jsdom cannot drive: this is the half that can be tested
// without a browser. A position that is not two positive integers (absent,
// fractional, negative, NaN, not an object) answers `null`, so a reveal that
// cannot be applied is a no-op rather than an error the pane has to handle.
export function clampReveal(position, lineCount, maxColumnFor) {
  if (!position || typeof position !== 'object') return null
  const { line, column } = position
  if (!Number.isInteger(line) || !Number.isInteger(column)) return null
  if (line < 1 || column < 1) return null
  const clampedLine = Math.min(line, Math.max(lineCount, 1))
  return { line: clampedLine, column: Math.min(column, maxColumnFor(clampedLine)) }
}

// The server sends the language id it chose for a file
// (`core/editorfs/files.py`), and an unknown extension is honestly `plaintext`.
// Monaco has no grammar for two of the ids it can receive: a `.vue` file
// tokenizes as its template (`html`), and `toml` has no grammar in the bundle, so
// it stays plain rather than pretending to be `ini`.
const LANGUAGE_BY_SERVER_ID = {
  python: 'python',
  javascript: 'javascript',
  typescript: 'typescript',
  vue: 'html',
  json: 'json',
  markdown: 'markdown',
  html: 'html',
  css: 'css',
  scss: 'scss',
  yaml: 'yaml',
  shell: 'shell',
  rust: 'rust',
}

export function monacoLanguageId(id) {
  return LANGUAGE_BY_SERVER_ID[id] ?? 'plaintext'
}
