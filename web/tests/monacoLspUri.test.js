import { describe, expect, it } from 'vitest'

import * as monaco from 'monaco-editor'

import { MARKER_SEVERITY, editorUriFor, pathForEditorUri } from '../src/lib/monaco-lsp'

// ---------------------------------------------------------------------------
// The URI derivation against Monaco's *real* `Uri`, not a stand-in.
//
// `lib/monaco-lsp.js` builds the URI as a string and reads it back through
// `toString()`, so the two spellings have to agree with Monaco's own parser and
// encoder — a path segment holding a space, a `#` or a `?` is where a
// hand-rolled derivation silently diverges. This file is the one place that
// check can be made without a browser: `Uri` is pure.
// ---------------------------------------------------------------------------

describe('the editor URI through Monaco\'s own Uri', () => {
  for (const path of [
    'src/app.py',
    'web/src/components/MonacoEditor.vue',
    'a file with spaces.md',
    'notes/a#b?c%d.md',
    'docs/editor-lsp-spec.md',
  ]) {
    it(`round-trips ${JSON.stringify(path)}`, () => {
      const uri = monaco.Uri.parse(editorUriFor(path))
      expect(uri.scheme).toBe('nojae-editor')
      expect(pathForEditorUri(uri)).toBe(path)
    })
  }

  // The scheme is what the providers are registered against, so it must survive
  // the parse unchanged — and it must not be `file`, which would wake Monaco's
  // built-in TypeScript worker's cross-file import resolution.
  it('keeps a synthetic scheme, never file', () => {
    const uri = monaco.Uri.parse(editorUriFor('src/app.py'))
    expect(uri.scheme).toBe('nojae-editor')
    expect(uri.scheme).not.toBe('file')
  })
})

// The component reaches for these three on the bundled Monaco; a version bump
// that dropped one would otherwise fail only in the browser.
describe('the Monaco API the surface uses', () => {
  it('offers the opener, the three provider registrations and Range', () => {
    expect(typeof monaco.editor.registerEditorOpener).toBe('function')
    expect(typeof monaco.languages.registerDefinitionProvider).toBe('function')
    expect(typeof monaco.languages.registerHoverProvider).toBe('function')
    expect(typeof monaco.languages.registerReferenceProvider).toBe('function')
    expect(typeof monaco.Range).toBe('function')
    expect(typeof monaco.editor.createModel).toBe('function')
  })

  // `lib/monaco-lsp.js` spells the four marker severities out rather than
  // importing the enum, so that it stays free of the editor. This is the pin
  // that keeps those literals honest: a version bump that renumbered one would
  // otherwise fail only in the browser, as a squiggle in the wrong colour.
  it('agrees with the bundled MarkerSeverity enum', () => {
    expect(MARKER_SEVERITY).toEqual({
      error: monaco.MarkerSeverity.Error,
      warning: monaco.MarkerSeverity.Warning,
      info: monaco.MarkerSeverity.Info,
      hint: monaco.MarkerSeverity.Hint,
    })
  })
})
