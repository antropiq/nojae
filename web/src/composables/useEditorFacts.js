import { reactive } from 'vue'

// ---------------------------------------------------------------------------
// The Editor status bar's *editor* half: the caret, indentation, line ending and
// file kind of the buffer on screen.
//
// It is a **sink, not a reader**: none of the four can be answered without the
// Monaco instance in `MonacoEditor.vue`, which owns the model and is the only
// thing that sees a caret move. The surface reports and this module holds.
//
// The labels are formatted at report time (`lib/editor-facts.js`) and the state
// holds strings: a fresh object per keystroke would repaint the strip even when
// nothing it shows changed, while a string compares by value.
//
// **A fact is keyed by the path it describes**, and a report for another path is
// dropped. The surface clears this when it goes away (a diff tab, a preview tab,
// the last tab closing), so an empty state and "no buffer on screen" are the same
// thing: the bar shows nothing rather than the file it used to show.
// ---------------------------------------------------------------------------

const state = reactive({
  // The path these facts are about, or `null` when no code surface is on screen.
  path: null,
  // `'Ln 32, Col 23'` — the caret, one-based, Monaco's own numbers.
  cursor: null,
  // `'Spaces: 2'` / `'Tab: 4'` — as the model resolved it for this buffer.
  indentation: null,
  // `'LF'` / `'CRLF'` — the buffer's dominant sequence.
  eol: null,
  // `'JSON'` / `'Python'` — the grammar's own name, from Monaco's registry.
  language: null,
})

// Report every fact for a buffer, plus the path they belong to: one call covers
// the surface mounting, a buffer swap, and a model's own options/language/line
// ending moving under it.
/** @param {{ path?: string, cursor?: string, indentation?: string, eol?: string, language?: string }} facts */
export function reportFile({ path, cursor, indentation, eol, language }) {
  state.path = path ?? null
  state.cursor = cursor ?? null
  state.indentation = indentation ?? null
  state.eol = eol ?? null
  state.language = language ?? null
}

// Report the caret alone. Guarded by the path, so a cursor event arriving after
// its buffer was replaced cannot paint over the new one.
export function reportCursor(path, cursor) {
  if (!path || path !== state.path) return
  state.cursor = cursor ?? null
}

// No code surface on screen: forget every fact rather than leaving the previous
// buffer's numbers under no buffer at all.
export function clearEditorFacts() {
  reportFile({})
}

export function useEditorFacts() {
  return { state, reportFile, reportCursor, clearEditorFacts }
}
