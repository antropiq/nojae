import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// ---------------------------------------------------------------------------
// ediag-11: the acceptance sweep's structural half.
//
// Everything behavioural about this feature is asserted by the suites its own
// tasks shipped (`monacoDiagnostics`, `editorDiagnostics`, `editorDiagnostics-
// Triggers`, `editorDiagnosticsWiring`, `editorStatusBar`, `useEditorStatus`,
// `monacoEditorLsp`). What none of them can notice is a *second* copy of a
// mechanism arriving later — a poll beside the debounce, a stream beside the
// pull, a path→server rule beside the bar's, a notice beside the quiet answer,
// a file route beside a read. Those are exactly the drift spec §6 and the
// lot's "one owner per mechanism" rule exist to forbid, and they are invisible
// to a test that only drives the behaviour they duplicate.
//
// So this file reads the shipped sources and asks five questions about them.
// It is deliberately the smallest layer that can hold these assertions: a grep
// with an explanation, in the same style as the marker-owner scan in
// `monacoEditorLsp.test.js`.
// ---------------------------------------------------------------------------

const FEATURE_FILES = [
  join('src', 'composables', 'useEditorDiagnostics.js'),
  join('src', 'composables', 'useEditorStatus.js'),
  join('src', 'lib', 'monaco-lsp.js'),
  join('src', 'components', 'EditorStatusBar.vue'),
  join('src', 'components', 'MonacoEditor.vue'),
]

function read(relative) {
  return readFileSync(resolve(relative), 'utf8')
}

// Comments are documentation, and several of these files *describe* the things
// they must not do ("no `setInterval`", "a second mechanism … would be the
// drift"). A scan that read a comment as code would assert on prose.
function codeOf(relative) {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/(^|\s)\/\/[^\n]*/g, '$1')
}

describe('spec §6, invariant one: pull, not push', () => {
  // One request per trigger and no long-lived stream: the bar's reads and the
  // marker feed are requests, and a stream here would be a second owner of the
  // same answer with its own reconnect story.
  it('opens no stream anywhere in the feature', () => {
    for (const file of FEATURE_FILES) {
      const code = codeOf(file)
      expect(code, file).not.toContain('EventSource')
      expect(code, file).not.toContain('WebSocket')
      expect(code, file).not.toContain('getReader(')
    }
  })

  // D3's other half: the settling period is the feature's only clock.
  it('polls nothing: no interval, no animation frame, no second timeout', () => {
    for (const file of [FEATURE_FILES[0], FEATURE_FILES[1]]) {
      const code = codeOf(file)
      expect(code, file).not.toContain('setInterval')
      expect(code, file).not.toContain('requestAnimationFrame')
    }
  })
})

describe('spec §3: one question, one source', () => {
  // The bar's server field asks `status`; the counts ask `diagnostics`. A second
  // speller of either would be a second owner of one answer — the drift the
  // lot's "one server-answer source" rule names.
  it('spells the status question in one file only', () => {
    const spelling = FEATURE_FILES.filter((file) =>
      codeOf(file).includes("action: 'status'") || codeOf(file).includes('action: "status"'),
    )
    expect(spelling).toEqual([join('src', 'composables', 'useEditorStatus.js')])
  })

  it('spells the diagnostics question in one file only', () => {
    const spelling = FEATURE_FILES.filter((file) => {
      const code = codeOf(file)
      return code.includes("action: 'diagnostics'") || code.includes('action: "diagnostics"')
    })
    expect(spelling).toEqual([join('src', 'composables', 'useEditorDiagnostics.js')])
  })

  // The bar's counts come from `lib/monaco-lsp.js`'s one function over one
  // answer. Nothing in the component layer may count a severity of its own again
  // — that is how a number and the squiggles beside it start to disagree (D7).
  it('counts severities in one function, called from one place', () => {
    const lib = codeOf(join('src', 'lib', 'monaco-lsp.js'))
    expect(lib.match(/export function diagnosticCounts/g) ?? []).toHaveLength(1)

    const callers = FEATURE_FILES.filter((file) => codeOf(file).includes('diagnosticCounts('))
    // The lib defines it, the composable calls it, and no component does.
    expect(callers.sort()).toEqual(
      [
        join('src', 'lib', 'monaco-lsp.js'),
        join('src', 'composables', 'useEditorDiagnostics.js'),
      ].sort(),
    )
  })

  // Each of the bar's two reads has its own single request token, and neither
  // borrows `useEditorLsp`'s — a second token in one composable would be two
  // answers racing for one question, which is the defect the token exists to
  // prevent.
  it('holds exactly one request token in each of the two composables', () => {
    for (const file of [FEATURE_FILES[0], FEATURE_FILES[1]]) {
      const declarations = codeOf(file).match(/^let\s+(token|answerToken)\s*=\s*0/gm) ?? []
      expect(declarations, file).toHaveLength(1)
    }
    // …and it is not `useEditorLsp`'s: the gesture's answer is left alone.
    expect(codeOf(FEATURE_FILES[0])).not.toContain('useEditorLsp')
    expect(codeOf(FEATURE_FILES[1])).not.toContain('useEditorLsp')
  })
})

describe('spec §6, invariant four: no marker is ever a write', () => {
  // This feature adds no path of its own to a file route. The marker surface is
  // a *read* of an answer the hub already holds: it names no `/api/fs` route,
  // and the one it does name is the LSP query route.
  it('names no file route, read or write, from any of its files', () => {
    for (const file of FEATURE_FILES) {
      expect(codeOf(file), file).not.toContain('/api/fs')
    }
  })
})

describe('spec §4: every quiet answer stays quiet', () => {
  // No notice on any path: `EditorNoticeStack` stays reserved for write
  // refusals, so the feature's files must not reach it at all.
  it('raises no notice: the stack is imported nowhere in the feature', () => {
    for (const file of FEATURE_FILES) {
      expect(codeOf(file), file).not.toContain('useEditorNotices')
    }
  })
})
