import { describe, expect, it } from 'vitest'

import {
  EDITOR_URI_SCHEME,
  editorUriFor,
  lspPositionToMonaco,
  monacoPositionToLsp,
  pathForEditorUri,
  revealFor,
  wireHoverToMonaco,
  wireLocationToMonaco,
} from '../src/lib/monaco-lsp'

// ---------------------------------------------------------------------------
// The pure half of the Editor pane's language-server feature.
//
// One rule is worth more than the rest: the `+1`/`-1` between LSP's 0-based
// coordinates and Monaco's 1-based ones lives in this module and nowhere else.
// A provider that re-derives it is the bug the module exists to prevent, so the
// conversion is asserted in both directions and as a round trip.
//
// The other rule is that a `null` answer is a no-op: a file no server claims, a
// server that found no definition and a hover with nothing to say all have to
// leave the pane exactly as it was, never throw inside a provider (spec §4.10).
// ---------------------------------------------------------------------------

describe('the model URI', () => {
  // A synthetic scheme, never `file://`: a `file://` URI makes Monaco's built-in
  // TypeScript worker try to resolve imports across files it does not have,
  // which is a behaviour change nobody asked for (spec §6).
  it('uses a synthetic scheme, never file://', () => {
    const uri = editorUriFor('src/app.py')
    expect(uri.startsWith(`${EDITOR_URI_SCHEME}:/`)).toBe(true)
    expect(uri.startsWith('file:')).toBe(false)
    expect(EDITOR_URI_SCHEME).not.toBe('file')
  })

  // The same path always yields the same URI: a provider maps a model back to a
  // path through it, so an unstable derivation would answer about the wrong file.
  it('is stable for a path', () => {
    expect(editorUriFor('web/src/app.ts')).toBe(editorUriFor('web/src/app.ts'))
    expect(editorUriFor('web/src/app.ts')).not.toBe(editorUriFor('web/src/other.ts'))
  })

  it('round-trips back to the workspace-relative path', () => {
    for (const path of [
      'src/app.py',
      'web/src/components/MonacoEditor.vue',
      'a file with spaces.md',
      'docs/editor-lsp-spec.md',
    ]) {
      expect(pathForEditorUri(editorUriFor(path))).toBe(path)
    }
  })

  // A path segment may hold a character a URI would otherwise read as syntax, so
  // each segment is encoded — and the round trip still gives the path back.
  it('survives characters a URI would read as syntax', () => {
    const path = 'notes/a#b?c%d.md'
    expect(pathForEditorUri(editorUriFor(path))).toBe(path)
    expect(editorUriFor(path)).not.toContain('#')
    expect(editorUriFor(path)).not.toContain('?')
  })

  // Anything that is not this pane's model is "not mine", which every caller
  // treats as a no-op rather than as an error.
  it('answers null for a URI that is not this pane\'s', () => {
    expect(pathForEditorUri('file:///tmp/app.py')).toBeNull()
    expect(pathForEditorUri('inmemory://model/1')).toBeNull()
    expect(pathForEditorUri('')).toBeNull()
    expect(pathForEditorUri(null)).toBeNull()
    expect(pathForEditorUri(undefined)).toBeNull()
  })

  // Monaco hands a provider its own `Uri` object, not a string, so the inverse
  // has to read one through `toString()`.
  it('reads a Monaco Uri through its string form', () => {
    const uri = { toString: () => editorUriFor('src/app.py') }
    expect(pathForEditorUri(uri)).toBe('src/app.py')
  })
})

describe('position mapping', () => {
  it('turns an LSP position into a Monaco position with +1 in each axis', () => {
    expect(lspPositionToMonaco({ line: 0, character: 0 })).toEqual({
      lineNumber: 1,
      column: 1,
    })
    expect(lspPositionToMonaco({ line: 11, character: 4 })).toEqual({
      lineNumber: 12,
      column: 5,
    })
  })

  it('turns a Monaco position into an LSP position with -1 in each axis', () => {
    expect(monacoPositionToLsp({ lineNumber: 1, column: 1 })).toEqual({
      line: 0,
      character: 0,
    })
    expect(monacoPositionToLsp({ lineNumber: 12, column: 5 })).toEqual({
      line: 11,
      character: 4,
    })
  })

  it('round-trips in both directions', () => {
    const lsp = { line: 7, character: 3 }
    expect(monacoPositionToLsp(lspPositionToMonaco(lsp))).toEqual(lsp)
    const monaco = { lineNumber: 8, column: 4 }
    expect(lspPositionToMonaco(monacoPositionToLsp(monaco))).toEqual(monaco)
  })

  // Both sides count characters in UTF-16 code units, so an astral character is
  // two units on either side and the conversion stays a plain `+1` — no
  // encoding step, no surrogate handling (spec §4.8).
  it('adds nothing but one, even past an astral character', () => {
    expect(lspPositionToMonaco({ line: 2, character: 5 })).toEqual({
      lineNumber: 3,
      column: 6,
    })
  })
})

describe('wireLocationToMonaco', () => {
  it('maps a wire location to a Monaco location, keeping the path', () => {
    expect(
      wireLocationToMonaco({ path: 'web/src/app.ts', line: 4, character: 2 }),
    ).toEqual({ path: 'web/src/app.ts', lineNumber: 5, column: 3 })
  })

  it('is a no-op for a null answer rather than a throw', () => {
    expect(wireLocationToMonaco(null)).toBeNull()
    expect(wireLocationToMonaco(undefined)).toBeNull()
  })
})

describe('wireHoverToMonaco', () => {
  it('maps a hover answer, converting the range through the same +1', () => {
    expect(
      wireHoverToMonaco({
        markdown: '```python\ndef greet(name: str) -> str\n```',
        range: { start: { line: 3, character: 0 }, end: { line: 3, character: 5 } },
      }),
    ).toEqual({
      contents: [{ value: '```python\ndef greet(name: str) -> str\n```' }],
      range: {
        startLineNumber: 4,
        startColumn: 1,
        endLineNumber: 4,
        endColumn: 6,
      },
    })
  })

  // The markdown travels as a string: this module renders no HTML, and Monaco
  // escapes it with HTML support off (spec §4.9).
  it('hands the markdown over verbatim, never as rendered HTML', () => {
    const markdown = '**bold** and <b>not markup</b>'
    expect(wireHoverToMonaco({ markdown, range: null }).contents).toEqual([
      { value: markdown },
    ])
  })

  it('keeps the markdown when the server named no range', () => {
    expect(wireHoverToMonaco({ markdown: 'a docstring', range: null })).toEqual({
      contents: [{ value: 'a docstring' }],
      range: null,
    })
  })

  it('is a no-op for a null answer rather than a throw', () => {
    expect(wireHoverToMonaco(null)).toBeNull()
    expect(wireHoverToMonaco(undefined)).toBeNull()
  })
})

describe('revealFor', () => {
  // The pane's reveal takes `{line, column}` and clamps them itself
  // (`lib/monaco-surface.js`'s `clampReveal`), so this helper only says which
  // two numbers to ask about — it neither clamps nor reveals.
  it('turns a wire location into the reveal arguments', () => {
    expect(revealFor({ path: 'src/app.py', line: 0, character: 0 })).toEqual({
      line: 1,
      column: 1,
    })
    expect(revealFor({ path: 'src/app.py', line: 9, character: 6 })).toEqual({
      line: 10,
      column: 7,
    })
  })

  it('is a no-op for a null answer', () => {
    expect(revealFor(null)).toBeNull()
  })
})
