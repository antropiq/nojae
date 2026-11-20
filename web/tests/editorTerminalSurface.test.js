import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

// ---------------------------------------------------------------------------
// The terminal's placeholder surface — why no band sits between the pane and
// the status bar.
//
// xterm's own stylesheet paints `.xterm-viewport` `#000` and switches a native
// scrollbar on (`overflow-y: scroll`). The emulator fits **whole rows**, so the
// slice of the pane left under the last row is whatever the splitter drag left
// there — and it was showing that black through, full width, with a scrollbar
// handle in it. The reported symptom ("a black line at the bottom, bigger or
// smaller when the splitter moves") is exactly that slice.
//
// jsdom lays nothing out and loads no stylesheet, so the fix is pinned where it
// is written: read out of `theme.css`, the way the other geometry tests in this
// suite do it. Two halves must both hold — the viewport takes the app surface
// (so the leftover slice is invisible), and its native scrollbar is gone (so
// the handle goes with it). xterm's own slider in `.xterm-scrollable-element`
// is untouched, so nothing is lost by hiding the native one.
// ---------------------------------------------------------------------------

const CSS = readFileSync(join(resolve(), 'src', 'styles', 'theme.css'), 'utf8')

// Comments go first: the stylesheet documents these selectors in prose, and a
// scan that read a comment as a rule would assert on documentation.
const STRIPPED = CSS.replace(/\/\*[\s\S]*?\*\//g, '')

/** The declaration body of the rule whose selector is exactly `selector`. */
function ruleBody(selector) {
  const found = [...STRIPPED.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((match) =>
    match[1]
      .split(',')
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .includes(selector),
  )
  return found ? found[2].replace(/\s+/g, ' ').trim() : null
}

const VIEWPORT = '.editor-term-host .xterm .xterm-viewport'

describe('the terminal’s xterm viewport', () => {
  it('takes the app surface instead of xterm’s black', () => {
    const body = ruleBody(VIEWPORT)
    expect(body, `${VIEWPORT} has a rule of its own`).not.toBeNull()
    // The token, not a hard-coded colour: the viewport must follow the theme
    // the same way the panel around it does, in light and dark alike.
    expect(body).toContain('background-color: var(--bi-surface)')
  })

  it('hides its native scrollbar, in Firefox and in Chromium/Safari', () => {
    // A leftover slice can never be scrolled anyway (the pane's own scroller is
    // xterm's themed slider), so the native track is only a stray handle.
    expect(ruleBody(VIEWPORT)).toContain('scrollbar-width: none')

    const pseudo = ruleBody(`${VIEWPORT}::-webkit-scrollbar`)
    expect(pseudo, 'the WebKit half is what Chromium honours').not.toBeNull()
    expect(pseudo).toContain('width: 0')
    expect(pseudo).toContain('height: 0')
  })

  it('is scoped to the terminal host, not applied app-wide', () => {
    // `.xterm-viewport` exists only inside this pane, but an unscoped rule here
    // would also be the template for the next one: the fix names its host.
    const rules = [...STRIPPED.matchAll(/([^{}]+)\{[^{}]*scrollbar-width:\s*none[^{}]*\}/g)]
    expect(rules.length).toBeGreaterThan(0)
    for (const [, selector] of rules) {
      expect(selector).toContain('.editor-term-host')
    }
  })
})
