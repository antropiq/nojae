import { describe, expect, it } from 'vitest'

import { monacoLanguageId } from '../src/lib/monaco-surface'

// Layer 1: the server-id -> Monaco-grammar mapping.
//
// The pane can only colourise a file the server has *named*: `read_file()`
// computes the id from `LANGUAGE_BY_EXTENSION` and an unmapped extension is
// honestly `plaintext`, so a missing entry here is indistinguishable (from the
// browser) from a grammar Monaco does not ship. The two halves are therefore
// asserted together: the mapping, and — for the ids it claims to map — that the
// bundled `monaco-editor` really has a grammar that tokenizes them. `toml` is
// the counter-example that motivated the check: it is a server id with no
// grammar in the bundle, so it stays out of the map rather than pretending.

window.matchMedia =
  window.matchMedia ||
  ((query) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
  }))

// Imported after the shim: the standalone build reads `matchMedia` at module
// scope (see `probe-monaco.test.js`, which does the same).
const monaco = await import('monaco-editor')

describe('monacoLanguageId', () => {
  it('passes the ids Monaco has a grammar for through unchanged', () => {
    // The ids are the ones `LANGUAGE_BY_EXTENSION` (src/core/editorfs/files.py)
    // can answer with, so a new extension there needs an entry here too — the
    // pane can only colourise a file whose id reaches a grammar.
    for (const id of ['python', 'javascript', 'typescript', 'json', 'markdown',
                      'html', 'css', 'scss', 'yaml', 'shell', 'rust']) {
      expect(monacoLanguageId(id)).toBe(id)
    }
  })

  it('maps the two ids the bundle has no grammar for', () => {
    // A .vue file tokenizes as its template; toml has no grammar at all.
    expect(monacoLanguageId('vue')).toBe('html')
    expect(monacoLanguageId('toml')).toBe('plaintext')
  })

  it('falls back to plaintext for anything unknown', () => {
    expect(monacoLanguageId('plaintext')).toBe('plaintext')
    expect(monacoLanguageId('cobol')).toBe('plaintext')
    expect(monacoLanguageId(undefined)).toBe('plaintext')
  })
})

describe('the Rust grammar', () => {
  it('is registered by the bundled monaco-editor', () => {
    const ids = monaco.languages.getLanguages().map((language) => language.id)
    expect(ids).toContain('rust')
  })

  it('colorizes Rust source, not just the name', async () => {
    // The grammar is lazy: registering the language only installs a factory, so
    // the tokenizer has to be awaited. `colorize` is the API that does that
    // (`editor.tokenize` reads the registry synchronously and silently falls
    // back to null tokens, which would pass for a language with no grammar).
    const source = 'fn main() {\n    let x: u32 = 1;\n}\n'
    const [rust, plaintext] = await Promise.all([
      monaco.editor.colorize(source, 'rust', {}),
      monaco.editor.colorize(source, 'plaintext', {}),
    ])
    // Asserted as a difference rather than as named classes: which `mtkN` a
    // keyword lands on is the bundled theme's business, and hardcoding it would
    // break on a Monaco upgrade that changes nothing about Rust support. What
    // must hold is that the Rust grammar *splits* the source into differently
    // classed tokens (keyword / identifier / number) where plaintext gives every
    // character one class — which is exactly the state the pane is in when the
    // server's id never reaches a grammar.
    const classesOf = (html) => new Set(html.match(/\bmtk\d+\b/g) ?? [])
    expect(classesOf(plaintext).size).toBe(1)
    expect(classesOf(rust).size).toBeGreaterThan(1)
  })
})
