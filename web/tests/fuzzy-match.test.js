import { describe, it, expect } from 'vitest'
import { fuzzyMatch, rankMatches } from '../src/lib/fuzzy-match.js'

describe('fuzzyMatch — subsequence in/out', () => {
  it('matches a plain subsequence', () => {
    expect(fuzzyMatch('red', 'src/core/editorfs/redact.py')).not.toBeNull()
  })

  it('rejects characters out of order', () => {
    expect(fuzzyMatch('pyred', 'src/core/editorfs/redact.py')).toBeNull()
  })

  it('rejects a missing character', () => {
    expect(fuzzyMatch('zzz', 'src/core/editorfs/redact.py')).toBeNull()
  })

  it('is case-insensitive', () => {
    expect(fuzzyMatch('README', 'readme.md')).not.toBeNull()
    expect(fuzzyMatch('readme', 'README.md')).not.toBeNull()
  })

  it('an empty query matches everything with no spans', () => {
    const m = fuzzyMatch('', 'src/a.py')
    expect(m).toEqual({ score: 0, spans: [] })
  })

  it('rejects non-string input', () => {
    expect(fuzzyMatch('a', null)).toBeNull()
    expect(fuzzyMatch(null, 'a.py')).toBeNull()
  })
})

describe('fuzzyMatch — scoring rules', () => {
  it('contiguous beats scattered', () => {
    const contiguous = fuzzyMatch('red', 'redact.py')
    const scattered = fuzzyMatch('red', 'routed/end/dot.py')
    expect(contiguous.score).toBeGreaterThan(scattered.score)
  })

  it('word boundary beats mid-word', () => {
    const boundary = fuzzyMatch('red', 'redact.py')
    const midword = fuzzyMatch('red', 'shared.py')
    expect(boundary.score).toBeGreaterThan(midword.score)
  })

  it('segment start beats a later position in the segment', () => {
    const start = fuzzyMatch('cor', 'src/core/x.py')
    const later = fuzzyMatch('ore', 'src/core/x.py')
    expect(start.score).toBeGreaterThan(later.score)
  })

  it('a camelCase change counts as a word boundary', () => {
    const camel = fuzzyMatch('r', 'myRed.py')
    const mid = fuzzyMatch('r', 'myxrd.py')
    expect(camel.score).toBeGreaterThan(mid.score)
  })

  it('a bare-name match outranks a mid-path match at equal structure', () => {
    const bare = fuzzyMatch('readme', 'docs/README.md')
    const midpath = fuzzyMatch('readme', 'docs/old/reader-me.txt')
    expect(bare.score).toBeGreaterThan(midpath.score)
  })

  it('spec example: usred finds src/core/editorfs/redact.py', () => {
    expect(fuzzyMatch('usred', 'src/core/editorfs/redact.py')).not.toBeNull()
  })

  it('spec example: readme ranks README.md before docs/old/reader-me.txt', () => {
    const rows = rankMatches('readme', ['docs/old/reader-me.txt', 'README.md'])
    expect(rows[0].path).toBe('README.md')
    expect(rows[1].path).toBe('docs/old/reader-me.txt')
  })
})

describe('fuzzyMatch — spans', () => {
  it('spans are non-overlapping, in order, and cover the matched characters', () => {
    const path = 'src/core/editorfs/redact.py'
    const m = fuzzyMatch('usred', path)
    expect(m).not.toBeNull()
    let lastEnd = -1
    for (const [start, end] of m.spans) {
      expect(start).toBeGreaterThan(lastEnd)
      expect(end).toBeGreaterThan(start)
      expect(end).toBeLessThanOrEqual(path.length)
      lastEnd = end
    }
  })

  it('contiguous matches collapse into one span', () => {
    const m = fuzzyMatch('red', 'redact.py')
    expect(m.spans).toEqual([[0, 3]])
  })

  it('scattered matches produce several spans', () => {
    const m = fuzzyMatch('sc', 'src/a.py')
    expect(m.spans.length).toBeGreaterThan(1)
  })

  it('span slices reconstruct the query characters in order', () => {
    const path = 'src/core/editorfs/redact.py'
    const m = fuzzyMatch('usred', path)
    const picked = m.spans.map(([s, e]) => path.slice(s, e)).join('')
    // The skipped character is not in the spans; the rest spells the query.
    expect(picked.toLowerCase()).toBe('sred')
  })
})

describe('rankMatches', () => {
  it('sorts by score, best first', () => {
    const rows = rankMatches('red', ['shared.py', 'redact.py'])
    expect(rows[0].path).toBe('redact.py')
  })

  it('breaks ties by the tree ordering, deterministically', () => {
    const paths = ['b/Beta.py', 'a/alpha.py', 'a/Beta.py']
    const rows = rankMatches('a', paths)
    const order = rows.map((r) => r.path)
    // Same input, same output — twice.
    expect(order).toEqual(rankMatches('a', paths).map((r) => r.path))
    // Ties fall back to (name.lower(), name) per segment.
    expect(order).toEqual(['a/alpha.py', 'a/Beta.py', 'b/Beta.py'])
  })

  it('a skipped character never outranks an equal match without one', () => {
    const rows = rankMatches('red', ['redact.py', 'routed/end/dot.py'])
    expect(rows[0].path).toBe('redact.py')
  })

  it('omits paths that do not match', () => {
    const rows = rankMatches('zzz', ['a.py', 'b.py'])
    expect(rows).toEqual([])
  })

  it('an empty query matches everything in tree order with score 0', () => {
    // The tree's order: directories first, then files, each alphabetical.
    const rows = rankMatches('', ['b.py', 'a/a.py', 'a.py'])
    expect(rows.map((r) => r.path)).toEqual(['a/a.py', 'a.py', 'b.py'])
    expect(rows.every((r) => r.score === 0 && r.spans.length === 0)).toBe(true)
  })

  it('rows carry path, score and spans', () => {
    const rows = rankMatches('red', ['redact.py'])
    expect(rows).toEqual([{ path: 'redact.py', score: rows[0].score, spans: [[0, 3]] }])
  })
})
