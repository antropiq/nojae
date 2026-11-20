import { beforeEach, describe, expect, it } from 'vitest'

import {
  cursorLabel,
  eolLabel,
  indentationLabel,
  languageDisplayName,
} from '../src/lib/editor-facts'
import {
  clearEditorFacts,
  reportCursor,
  reportFile,
  useEditorFacts,
} from '../src/composables/useEditorFacts'

// ---------------------------------------------------------------------------
// The status bar's *editor* half: the four facts about the buffer on screen —
// caret, indentation, line ending, file kind.
//
// The whole point of putting the formatting in `lib/editor-facts.js` is that
// the surface owning the Monaco instance cannot be driven in jsdom, so the
// choices are asserted here, on plain values: what each label says, and — more
// importantly — that a fact nobody answered is `null` rather than a plausible
// lie. The composable's own rules (a report is keyed by its path, and clearing
// is the same thing as holding nothing) are the second half.
// ---------------------------------------------------------------------------

describe('the caret label', () => {
  it('spells a position the way an editor does, one-based, with no conversion', () => {
    expect(cursorLabel({ lineNumber: 32, column: 23 })).toBe('Ln 32, Col 23')
    // Monaco counts from one already: `1,1` is the first character.
    expect(cursorLabel({ lineNumber: 1, column: 1 })).toBe('Ln 1, Col 1')
  })

  // §"a fact that cannot be determined is null, never a guess": an unanswered
  // position must not print as `Ln 0, Col 0`.
  it('answers null for anything that is not a real position', () => {
    expect(cursorLabel(null)).toBeNull()
    expect(cursorLabel(undefined)).toBeNull()
    expect(cursorLabel({})).toBeNull()
    expect(cursorLabel({ lineNumber: 0, column: 1 })).toBeNull()
    expect(cursorLabel({ lineNumber: 1, column: 0 })).toBeNull()
    expect(cursorLabel({ lineNumber: 1.5, column: 2 })).toBeNull()
    expect(cursorLabel({ lineNumber: '3', column: 4 })).toBeNull()
  })
})

describe('the indentation label', () => {
  // `createModel` runs Monaco's guesser, so these numbers are read from the
  // file rather than assumed — the label only says what the model resolved.
  it('names spaces with their width, and a tab with the width it is drawn at', () => {
    expect(indentationLabel({ insertSpaces: true, indentSize: 2, tabSize: 2 }))
      .toBe('Spaces: 2')
    expect(indentationLabel({ insertSpaces: true, indentSize: 4, tabSize: 4 }))
      .toBe('Spaces: 4')
    expect(indentationLabel({ insertSpaces: false, indentSize: 4, tabSize: 4 }))
      .toBe('Tab: 4')
  })

  it('falls back to the tab width when the indent width is not a number', () => {
    // `indentSize: 'tabSize'` is Monaco's internal "same as the tab" marker; the
    // resolved options carry a number, but a shape without one is still answerable.
    expect(indentationLabel({ insertSpaces: true, tabSize: 8 })).toBe('Spaces: 8')
  })

  it('answers null when there is nothing to say', () => {
    expect(indentationLabel(null)).toBeNull()
    expect(indentationLabel({})).toBeNull()
    expect(indentationLabel({ insertSpaces: false })).toBeNull()
  })
})

describe('the line-ending label', () => {
  it('says LF or CRLF, from the sequence itself rather than an enum number', () => {
    expect(eolLabel('\n')).toBe('LF')
    expect(eolLabel('\r\n')).toBe('CRLF')
  })

  it('answers null for a sequence that is neither', () => {
    expect(eolLabel('')).toBeNull()
    expect(eolLabel('\r')).toBeNull()
    expect(eolLabel(undefined)).toBeNull()
    expect(eolLabel(0)).toBeNull()
  })
})

describe('the file-kind label', () => {
  // The name comes from Monaco's own registry, so the strip cannot drift from
  // the grammar the pane is tokenizing with.
  const LANGUAGES = [
    { id: 'json', aliases: ['JSON', 'json'] },
    { id: 'python', aliases: ['Python', 'py'] },
    { id: 'plaintext', aliases: ['Plain Text', 'text'] },
  ]

  it('uses the grammar\'s own first alias', () => {
    expect(languageDisplayName('json', LANGUAGES)).toBe('JSON')
    expect(languageDisplayName('python', LANGUAGES)).toBe('Python')
    expect(languageDisplayName('plaintext', LANGUAGES)).toBe('Plain Text')
  })

  // An id with no registration is still a true answer — the id itself — rather
  // than a blank where a file's kind should be.
  it('falls back to the id when the registry has no entry for it', () => {
    expect(languageDisplayName('toml', LANGUAGES)).toBe('toml')
    expect(languageDisplayName('json', [])).toBe('json')
    expect(languageDisplayName('json', undefined)).toBe('json')
  })

  it('answers null only when there is no id at all', () => {
    expect(languageDisplayName('', LANGUAGES)).toBeNull()
    expect(languageDisplayName(null, LANGUAGES)).toBeNull()
    expect(languageDisplayName(undefined, LANGUAGES)).toBeNull()
  })
})

describe('useEditorFacts', () => {
  const facts = useEditorFacts()

  beforeEach(() => {
    clearEditorFacts()
  })

  it('holds every fact a report names, keyed by the path it describes', () => {
    reportFile({
      path: 'src/app.py',
      cursor: 'Ln 2, Col 3',
      indentation: 'Spaces: 4',
      eol: 'LF',
      language: 'Python',
    })

    expect(facts.state).toMatchObject({
      path: 'src/app.py',
      cursor: 'Ln 2, Col 3',
      indentation: 'Spaces: 4',
      eol: 'LF',
      language: 'Python',
    })
  })

  // The one fact that moves per keystroke: reported alone, and dropped when it
  // describes a buffer that is no longer the one on screen.
  it('takes a cursor report only for the path it is currently holding', () => {
    reportFile({ path: 'src/app.py', cursor: 'Ln 1, Col 1', eol: 'LF' })

    reportCursor('src/app.py', 'Ln 9, Col 4')
    expect(facts.state.cursor).toBe('Ln 9, Col 4')

    reportCursor('src/other.py', 'Ln 1, Col 1')
    expect(facts.state.cursor).toBe('Ln 9, Col 4')
    expect(facts.state.path).toBe('src/app.py')
  })

  it('answers every fact as null once no buffer is on screen', () => {
    reportFile({ path: 'src/app.py', cursor: 'Ln 1, Col 1', eol: 'CRLF' })
    clearEditorFacts()

    expect(facts.state.path).toBeNull()
    expect(facts.state.cursor).toBeNull()
    expect(facts.state.indentation).toBeNull()
    expect(facts.state.eol).toBeNull()
    expect(facts.state.language).toBeNull()
  })

  // A partial report does not leave the previous buffer's numbers behind: the
  // report *is* the whole state of the facts.
  it('replaces the whole set, so a partial report cannot leave residue', () => {
    reportFile({ path: 'src/app.py', cursor: 'Ln 3, Col 1', eol: 'CRLF', language: 'Python' })
    reportFile({ path: 'src/other.py', eol: 'LF' })

    expect(facts.state.path).toBe('src/other.py')
    expect(facts.state.cursor).toBeNull()
    expect(facts.state.language).toBeNull()
    expect(facts.state.eol).toBe('LF')
  })
})
