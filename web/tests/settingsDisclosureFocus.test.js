import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// The tree's disclosure arrow and its focus ring.
//
// Pico paints a focused button's ring as a `box-shadow` in `--pico-primary-focus`
// (`button:focus` → `0 0 0 var(--pico-outline-width) var(--pico-primary-focus)`).
// On the bare glyph that opens a server's model list the ring reads as a stray
// border, so the **colour** is retargeted to the card's surface instead of the
// shadow being deleted: the focus box-shadow stays, and only becomes invisible
// against the background it sits on.
//
// jsdom resolves neither `var()` in a custom property nor Pico's shadow, so a
// computed-style assertion here would pass whatever the theme said. The rule is
// therefore read out of the shipped `theme.css` — the same way the agent-modes
// suite reads it — and the two things that must stay true are pinned: the
// disclosure carries the retargeted colour, and nothing removes the ring.
// ---------------------------------------------------------------------------

const themeCss = readFileSync(resolve('src/styles/theme.css'), 'utf8')

/** The body of the `.models-disclosure` rule, or '' when the rule is gone. */
function disclosureRule() {
  const start = themeCss.indexOf('.models-disclosure {')
  if (start === -1) return ''
  const end = themeCss.indexOf('}', start)
  return themeCss.slice(start, end)
}

describe('the servers-tree disclosure arrow', () => {
  it('retargets Pico\'s focus colour to the surface it sits on', () => {
    const rule = disclosureRule()
    expect(rule, 'the .models-disclosure rule is gone from theme.css').not.toBe('')
    expect(rule).toMatch(/--pico-primary-focus:\s*var\(--bi-surface\)/)
  })

  it('keeps the focus box-shadow — the ring is hidden, never removed', () => {
    const rule = disclosureRule()
    // Deleting the shadow would take the focus affordance with it; only its
    // colour is negotiable here.
    expect(rule).not.toMatch(/box-shadow:\s*none/)
    expect(rule).not.toMatch(/outline:\s*(none|0)/)
    expect(rule).not.toMatch(/--pico-outline-width:\s*0/)
  })

  it('narrows the change to the arrow: no app-wide focus-ring removal', () => {
    // The token may be redefined only where a control needs it. A `:root` or
    // `html`/`body` redefinition would silence every focus ring in the app,
    // which is the opposite of what the arrow asked for.
    const redefinitions = themeCss.match(/--pico-primary-focus:[^;]*/g) ?? []
    expect(redefinitions).toEqual(['--pico-primary-focus: var(--bi-surface)'])
  })
})
