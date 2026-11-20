import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  MARKER_SEVERITY,
  builtinValidationOverride,
  diagnosticCounts,
  isUnderlined,
  markerForDiagnostic,
  markerSeverityFor,
  markersForDiagnostics,
} from '../src/lib/monaco-lsp'

// ---------------------------------------------------------------------------
// The wire -> marker mapping (spec §3.1, §5 D7, §7 Part B item 7).
//
// Three rules are asserted here and worth more than the rest:
//
//   * the `+1` at **both** ends of a range comes from
//     `lspPositionToMonaco`, the module's one conversion — a range that starts
//     and ends on different lines is where a hand-rolled copy drifts;
//   * the severity rule (D7) is stated once, so the underlines and the bar's
//     counts cannot disagree — a hint is asserted on both halves at once;
//   * a set is built from scratch every time, never merged, because replacement
//     is what makes a fixed defect's underline disappear (§6).
//
// Nothing here stubs: these are pure functions, and the wire shape is task 03's
// `diagnostics_answer` result (`tests/test_lsp_editor.py` pins it).
// ---------------------------------------------------------------------------

function item(overrides = {}) {
  return {
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
    severity: 'error',
    message: 'boom',
    ...overrides,
  }
}

describe('markerSeverityFor', () => {
  it('maps the wire severity names onto Monaco\'s own numbers', () => {
    expect(markerSeverityFor('error')).toBe(MARKER_SEVERITY.error)
    expect(markerSeverityFor('warning')).toBe(MARKER_SEVERITY.warning)
    expect(markerSeverityFor('info')).toBe(MARKER_SEVERITY.info)
    expect(markerSeverityFor('hint')).toBe(MARKER_SEVERITY.hint)
  })

  // The backend resolves an omitted severity to "error" (`lsphub/rendering.py`),
  // so the client reads an absent or unknown severity the same way: one rule,
  // one answer, on both sides of the wire.
  it('resolves the omitted case to an error, as the backend does', () => {
    expect(markerSeverityFor(undefined)).toBe(MARKER_SEVERITY.error)
    expect(markerSeverityFor(null)).toBe(MARKER_SEVERITY.error)
    expect(markerSeverityFor('something else')).toBe(MARKER_SEVERITY.error)
  })
})

describe('markerForDiagnostic', () => {
  // A range that starts and ends on different lines: the `+1` has to happen at
  // both ends, and on both axes.
  it('adds one to both ends of a range on different lines', () => {
    const marker = markerForDiagnostic(
      item({
        range: { start: { line: 3, character: 4 }, end: { line: 7, character: 11 } },
        severity: 'warning',
        message: 'unused variable',
        code: 'F841',
        source: 'pyright',
      }),
    )
    expect(marker).toEqual({
      startLineNumber: 4,
      startColumn: 5,
      endLineNumber: 8,
      endColumn: 12,
      severity: MARKER_SEVERITY.warning,
      message: 'unused variable',
      code: 'F841',
      source: 'pyright',
    })
  })

  // The server's words are the answer to "what is wrong here", and this is the
  // last place they are still words before they reach a tooltip.
  it('carries the message through verbatim', () => {
    const message = 'Type "int" is not assignable to "str" — see <a href="#">x</a>'
    expect(markerForDiagnostic(item({ message })).message).toBe(message)
  })

  it('carries no code and no source when the server gave neither', () => {
    const marker = markerForDiagnostic(item())
    expect('code' in marker).toBe(false)
    expect('source' in marker).toBe(false)
  })

  // `null` in, `null` out is this module's existing rule for a shape it cannot
  // map. A marker at line 0 would be clamped somewhere real and painted on
  // innocent code.
  it('drops an item with no range rather than mapping it to line 0', () => {
    expect(markerForDiagnostic(item({ range: null }))).toBeNull()
    expect(markerForDiagnostic({ severity: 'error', message: 'boom' })).toBeNull()
  })

  it('drops an item with a non-integer coordinate rather than raising', () => {
    for (const bad of [
      { start: { line: 1.5, character: 0 }, end: { line: 2, character: 0 } },
      { start: { line: 0, character: 0 }, end: { line: -1, character: 0 } },
      { start: { line: '0', character: 0 }, end: { line: 1, character: 0 } },
      { start: { line: 0, character: NaN }, end: { line: 1, character: 0 } },
      { start: null, end: { line: 1, character: 0 } },
    ]) {
      expect(() => markerForDiagnostic(item({ range: bad }))).not.toThrow()
      expect(markerForDiagnostic(item({ range: bad }))).toBeNull()
    }
  })

  it('is a no-op for a null item rather than a throw', () => {
    expect(markerForDiagnostic(null)).toBeNull()
    expect(markerForDiagnostic(undefined)).toBeNull()
  })
})

describe('the D7 rule', () => {
  // Errors and warnings are underlined; hints and information are counted only.
  it('underlines errors and warnings, and nothing else', () => {
    expect(isUnderlined(item({ severity: 'error' }))).toBe(true)
    expect(isUnderlined(item({ severity: 'warning' }))).toBe(true)
    expect(isUnderlined(item({ severity: 'info' }))).toBe(false)
    expect(isUnderlined(item({ severity: 'hint' }))).toBe(false)
  })

  // One rule, both halves at once: a hint has a count and no squiggle.
  it('counts a hint while drawing nothing for it', () => {
    const items = [item({ severity: 'hint' })]
    expect(diagnosticCounts(items).total).toBe(1)
    expect(markersForDiagnostics(items)).toEqual([])
  })
})

describe('diagnosticCounts', () => {
  it('separates errors, warnings and the total', () => {
    const items = [
      item({ severity: 'error' }),
      item({ severity: 'error' }),
      item({ severity: 'warning' }),
      item({ severity: 'info' }),
      item({ severity: 'hint' }),
    ]
    // The total counts every item the server reported, hints and information
    // included — the two error/warning numbers are not the whole story.
    expect(diagnosticCounts(items)).toEqual({ errors: 2, warnings: 1, total: 5 })
  })

  it('counts an empty list as zero everywhere', () => {
    expect(diagnosticCounts([])).toEqual({ errors: 0, warnings: 0, total: 0 })
    expect(diagnosticCounts(null)).toEqual({ errors: 0, warnings: 0, total: 0 })
  })

  it('counts a list of hints without underlining any of them', () => {
    const items = [item({ severity: 'hint' }), item({ severity: 'hint' })]
    expect(diagnosticCounts(items)).toEqual({ errors: 0, warnings: 0, total: 2 })
    expect(markersForDiagnostics(items)).toEqual([])
  })
})

describe('markersForDiagnostics', () => {
  // The server's order is kept and the unmappable items are dropped, so the
  // set handed to Monaco is exactly what can be drawn.
  it('keeps the server\'s order and drops what cannot be mapped', () => {
    const items = [
      item({ severity: 'warning', message: 'first' }),
      item({ severity: 'hint', message: 'not underlined' }),
      item({ severity: 'error', message: 'second', range: null }),
      item({ severity: 'error', message: 'third' }),
    ]
    const markers = markersForDiagnostics(items)
    expect(markers.map((marker) => marker.message)).toEqual(['first', 'third'])
  })

  // Replacement, never merge: a second build whose input no longer holds the
  // first's problem is a list without it, which is how a fixed defect's
  // underline disappears (spec §6).
  it('answers a fresh list on every build, never merging with the last', () => {
    const first = markersForDiagnostics([
      item({ message: 'fixed', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } }),
      item({ message: 'still there', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } } }),
    ])
    const second = markersForDiagnostics([
      item({ message: 'still there', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } } }),
    ])
    expect(first.map((marker) => marker.message)).toEqual(['fixed', 'still there'])
    expect(second.map((marker) => marker.message)).toEqual(['still there'])
    expect(second).not.toBe(first)
    // …and a build over nothing is an empty set, not the previous one.
    expect(markersForDiagnostics([])).toEqual([])
  })
})

// D5 (spec §5, §7 Part B item 11): Monaco's own JavaScript/TypeScript checking is
// suppressed **per buffer**, and only when a declared server answers for that
// buffer's path. The rule is stated here, once, so the pane and any other surface
// cannot drift apart on it — and it *reads* the bar's server answer rather than
// deciding it, so the browser grows no second path→server rule.
describe('builtinValidationOverride (D5)', () => {
  function asked(path, answer) {
    return { path, answer }
  }

  function status(overrides = {}) {
    return { status: 'ok', server: 'pyright', reason: null, action: 'status', result: null, ...overrides }
  }

  // A claimed buffer: both halves silenced together, because a file with a
  // declared server should speak with one voice.
  it('suppresses both validations for a buffer a declared server claims', () => {
    expect(builtinValidationOverride(asked('src/app.py', status()), 'src/app.py')).toEqual({
      syntactic: false,
      semantic: false,
    })
  })

  // D5's whole point: the built-in engine is left alone for a file the app's
  // servers do not serve, so its marks are not deleted.
  for (const quiet of ['no_server', 'starting']) {
    it(`returns null — the defaults — for a ${quiet} answer`, () => {
      expect(
        builtinValidationOverride(
          asked('src/app.py', status({ status: quiet, server: null })),
          'src/app.py',
        ),
      ).toBeNull()
    })
  }

  // The bar's answer is keyed by the path it was asked about: an answer about
  // another buffer is not an answer about this one.
  it('returns null when the answer describes a different path', () => {
    expect(
      builtinValidationOverride(asked('src/other.py', status()), 'src/app.py'),
    ).toBeNull()
  })

  it('returns null for a buffer with no path, and for no answer at all', () => {
    expect(builtinValidationOverride(asked('src/app.py', status()), '')).toBeNull()
    expect(builtinValidationOverride(asked('', status()), '')).toBeNull()
    expect(builtinValidationOverride(null, 'src/app.py')).toBeNull()
    expect(builtinValidationOverride(asked('src/app.py', null), 'src/app.py')).toBeNull()
  })

  // An `ok` envelope with no server named is not a claim either.
  it('returns null for an ok envelope that named no server', () => {
    expect(
      builtinValidationOverride(asked('src/app.py', status({ server: null })), 'src/app.py'),
    ).toBeNull()
  })
})

// The rule that produced the module's old "deliberately absent" note still
// holds even though the mapping is now here: the browser never speaks LSP. So
// the module names no LSP method, no JSON-RPC frame and no path — it maps the
// app's own wire shape and nothing else.
describe('the module still does not speak LSP', () => {
  const source = readFileSync(resolve('src/lib/monaco-lsp.js'), 'utf8')

  it('names no LSP method and no JSON-RPC frame', () => {
    for (const forbidden of ['textDocument/', 'workspace/', 'jsonrpc', '$/']) {
      expect(source).not.toContain(forbidden)
    }
  })

  // The route is *named* in the header as the wire this module maps — that is a
  // description, not a call. What must not appear is a request being made: this
  // module reaches no route at all ("this task adds no request", §6).
  it('makes no request and holds no path policy', () => {
    expect(source).not.toContain('fetch(')
    expect(source).not.toContain('apiFetch')
    expect(source).not.toContain('EventSource')
    expect(source).not.toContain('pathLocationPolicy')
  })

  // The header used to say this mapping was "deliberately absent here". It is
  // here now, and the note has to say so rather than leave a reader looking for
  // a mapping that no longer lives somewhere else.
  it('states the mapping is present, and keeps naming the no-LSP rule', () => {
    expect(source).not.toContain('deliberately absent here')
    expect(source).toContain('The diagnostics mapping lives here too')
    expect(source).toContain('The browser never speaks LSP')
  })
})
