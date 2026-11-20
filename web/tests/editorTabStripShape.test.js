import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// The tab strip's vertical shape, asserted on the stylesheet's *source* — the
// same technique `monacoRevealClamp.test.js` uses for the find widget, and for
// the same reason: what the browser finally draws is the e2e layer's to measure,
// but the properties that decide it are easy to undo by accident, and a chip
// that is two pixels taller than its siblings is a bug no unit test would
// otherwise see.
//
// Two rules are pinned here, and they are the two halves of one visual fix:
//
//   1. the chip is a little shorter than it was (the header's `min-height`);
//   2. the name and the × sit *centred* in it. That second half is the one that
//      was actually broken: the chip's buttons are Pico `[type=button]`s and
//      Pico gives every one of them `margin-bottom: var(--pico-spacing)`, which
//      inside a ~2rem cell pushed both of them up by two thirds of a rem.
//
// The margin reset is asserted by *which selectors carry it*, because that is
// what keeps the fix narrow: zeroing every `button` would undo a deliberate gap
// somewhere else in the app.
const css = readFileSync(join(resolve(), 'src', 'styles', 'theme.css'), 'utf8')

// The declarations of one rule, by exact selector text. The file is formatted
// one selector per line for simple rules and a selector list for grouped ones,
// so the selector is matched literally between the opening brace and the body.
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`(?:^|\\n)${escaped}\\s*\\{([^}]*)\\}`))
  return match ? match[1] : null
}

describe('the tab strip is a little shorter than it was', () => {
  it('caps the header strip at a height the chips inherit', () => {
    const body = ruleBody('.editor-area-head')
    expect(body, 'the header strip carries its own rule').not.toBeNull()
    // A `min-height` and not a fixed height: a chip with the stale marker still
    // has to be able to grow it, and the chips stretch to whatever it settles at.
    const height = /min-height:\s*([\d.]+)rem/.exec(body)
    expect(height, 'the strip states a rem min-height').not.toBeNull()
    // Shorter than the 2.1rem it was. Asserted as a bound rather than an exact
    // number so a later nudge is allowed — the *direction* is the change.
    expect(Number(height[1])).toBeLessThan(2.1)
  })
})

describe('the name and the × are centred in the chip', () => {
  it('zeroes Pico\'s button margin on the chip\'s own buttons, and only those', () => {
    const body = ruleBody('.editor-tab-name,\n.editor-tab-close,\n.editor-tab-stale')
    expect(body, 'the three chip buttons share one margin reset').not.toBeNull()
    expect(body).toMatch(/margin:\s*0\s*;/)
    // The reset names the chip's buttons; a bare `button` rule would reach every
    // control in the app.
    expect(css).not.toMatch(/(?:^|\n)\s*button\s*\{\s*margin:\s*0\s*;/)
  })

  it('builds the cell out of flexbox rather than a measured height', () => {
    // `height: 100%` against a `stretch` parent is 100% of the *content* box,
    // plus the button's own padding: it made the button taller than its cell.
    // `align-self: stretch` is the same intent without the arithmetic.
    const name = ruleBody('.editor-tab-name')
    expect(name).not.toBeNull()
    expect(name).toMatch(/align-self:\s*stretch\s*;/)
    expect(name).not.toMatch(/(?:^|\n)\s*height:\s*100%\s*;/)
  })

  it('keeps the × glyph\'s line box out of the centring', () => {
    // `display: grid; place-items: center` centres the glyph — as long as its
    // own line box is not padded out by an inherited line-height, which is what
    // the unitless value prevents.
    const close = ruleBody('.editor-tab-close')
    expect(close).not.toBeNull()
    expect(close).toMatch(/place-items:\s*center\s*;/)
    expect(close).toMatch(/line-height:\s*1\s*;/)
  })
})
