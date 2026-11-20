// The Editor status bar's *editor* half: the four facts about the buffer on
// screen that VS Code's own strip shows at its right edge — where the caret is,
// how the buffer indents, which line ending it uses and what kind of file it is.
//
// It is here, and not in a component, for the same reason `lib/monaco-surface.js`
// holds the reveal clamp: the surface that owns the Monaco instance cannot be
// driven in jsdom, so every choice these labels embody is written as a pure
// function over the values a model and an editor already answer. The component
// reads them, formats nothing, and decides nothing.
//
// Two rules the labels keep:
//
//   * **A label is a short phrase, never a sentence** — the strip is one row of
//     chrome and the four sit side by side at its end.
//   * **A fact that cannot be determined is `null`, never a guess.** A model that
//     answers no position, or no line ending, has nothing to say; the field is
//     then absent rather than reading `Ln 0, Col 0`.
//
// Nothing here invents a fact Monaco cannot answer. Encoding is the one the app
// deliberately leaves out: the bundled editor has no text-encoding concept at
// all (it assumes text arrived already decoded), so the only honest source would
// be the server's read payload — a different feature, not this one.

// The caret's place in the buffer, in the strip's own phrasing: `Ln 32, Col 23`.
// Monaco counts both from one, and so does the label — no conversion happens
// here. A position that is not two positive integers is `null`: an absent
// position is a fact the editor has not answered yet, never `Ln 0, Col 0`.
export function cursorLabel(position) {
  if (!position || typeof position !== 'object') return null
  const { lineNumber, column } = position
  if (!Number.isInteger(lineNumber) || !Number.isInteger(column)) return null
  if (lineNumber < 1 || column < 1) return null
  return `Ln ${lineNumber}, Col ${column}`
}

// How the buffer indents, as *the model resolved it* rather than as an
// assumption: `createModel` runs Monaco's indentation guesser over the text, so
// the numbers here are read from the file. `insertSpaces` picks the wording —
// `Spaces: 2` for spaces, `Tab: 4` for tabs (the width a tab is drawn at, which
// is what a reader comparing two files actually cares about).
export function indentationLabel(options) {
  if (!options || typeof options !== 'object') return null
  const tabSize = Number.isInteger(options.tabSize) ? options.tabSize : null
  if (options.insertSpaces) {
    const width = Number.isInteger(options.indentSize) ? options.indentSize : tabSize
    return width ? `Spaces: ${width}` : null
  }
  return tabSize ? `Tab: ${tabSize}` : null
}

// The buffer's line ending, in VS Code's two spellings. The input is a model's
// `getEOL()` — the sequence itself, `'\n'` or `'\r\n'` — rather than the
// `EndOfLineSequence` enum, so this module needs no editor import and no magic
// number: a mixed-ending file resolves to its dominant form, which is the one
// the model reports and the one the pane saves back.
export function eolLabel(eol) {
  if (eol === '\r\n') return 'CRLF'
  if (eol === '\n') return 'LF'
  return null
}

// The file's kind, as a reader would name it: `JSON`, `Python`, `Plain Text`.
// The name comes from Monaco's own language registry — the `aliases` a
// registration carries — so the strip cannot drift from the grammar the pane is
// tokenizing with, and a new grammar needs no entry here. `languages` is
// `monaco.languages.getLanguages()`; an id with no registration falls back to
// the id itself, which is still a true answer.
export function languageDisplayName(languageId, languages) {
  if (typeof languageId !== 'string' || !languageId) return null
  const entry = Array.isArray(languages)
    ? languages.find((language) => language?.id === languageId)
    : null
  const alias = entry?.aliases?.find((name) => typeof name === 'string' && name.trim())
  return alias?.trim() || languageId
}
