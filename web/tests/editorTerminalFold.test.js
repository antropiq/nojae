import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { h, nextTick } from 'vue'

// ---------------------------------------------------------------------------
// The terminal strip's fold (the Chat tools dock's twin): a control at the
// right of the header's two session buttons that hides the terminal so the code
// pane above takes the room, and brings it back when clicked again.
//
// What is protected, and why each half is asserted where it is:
//
//   * The flag belongs to the **layout owner** (`EditorView`), exactly as the
//     tools dock's does: folding changes how much of the shell's height the
//     terminal's row gets, so only the owner of that grid can answer to it. The
//     header's button therefore emits, never keeps state.
//   * It is a **flag, not a size**, and it persists — a dragged terminal height
//     survives a fold untouched, so unfolding comes back to it.
//   * The **bar goes with the body** and the terminal's grid track stops naming
//     `--bi-editor-terminal`, which is what hands the room to the code pane's
//     `1fr` row. jsdom lays nothing out, so the geometry is read out of
//     theme.css the way the other Editor geometry tests read it.
//   * The body is hidden with `v-show`, never `v-if`: the host element has to
//     keep existing so the xterm instance and the ResizeObserver that fits it
//     survive the fold.
// ---------------------------------------------------------------------------

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// The terminal composable is a singleton that lazily imports xterm on attach —
// none of which this file is about. The fold is wiring: the component reads a
// status and emits a fold. A plain state object and recording stubs answer both.
const terminalStub = vi.hoisted(() => ({
  state: { status: 'idle', pid: null, cwd: '', shell: '', message: 'no session' },
  attach: () => {},
  sendResize: () => {},
  fitVisible: () => {},
  newSession: () => {},
  kill: () => {},
}))

vi.mock('../src/composables/useTerminal', () => ({ useTerminal: () => terminalStub }))

vi.mock('../src/components/WorkspaceNavigator.vue', () => ({
  default: { name: 'NavigatorStub', render: () => h('div', { class: 'stub-nav' }) },
}))
vi.mock('../src/components/EditorArea.vue', () => ({
  default: { name: 'EditorAreaStub', render: () => h('div', { class: 'stub-area' }) },
}))
vi.mock('../src/components/EditorNoticeStack.vue', () => ({
  default: { name: 'NoticeStackStub', render: () => null },
}))

import EditorView from '../src/components/EditorView.vue'

const COLLAPSE_KEY = 'nojae:editorTerminalCollapsed'
const SIZE_KEY = 'nojae:editorTerminal'

const CSS = readFileSync(join(resolve(), 'src', 'styles', 'theme.css'), 'utf8')

// The stylesheet documents these selectors in prose, so comments go first.
function strippedCss() {
  return CSS.replace(/\/\*[\s\S]*?\*\//g, '')
}

/** The declaration body of the first rule whose selector list contains `selector`. */
function ruleBody(css, selector) {
  const found = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((match) =>
    match[1]
      .split(',')
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .includes(selector),
  )
  return found ? found[2].replace(/\s+/g, ' ').trim() : null
}

/** The brace-balanced body of a top-level `@media` block. */
function mediaBody(css, query) {
  const start = css.indexOf(`${query} {`)
  if (start < 0) return null
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    else if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return null
}

/**
 * The track list of a body, split on top-level whitespace only: a
 * `minmax(0, 1fr)` track contains a space of its own and is one entry.
 */
function rowsOf(body) {
  const value = body.match(/grid-template-rows:([^;]*);/)
  if (!value) return []
  const tracks = []
  let current = ''
  let depth = 0
  for (const char of value[1].trim()) {
    if (char === '(') depth += 1
    if (char === ')') depth -= 1
    if (/\s/.test(char) && depth === 0) {
      if (current) tracks.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (current) tracks.push(current)
  return tracks
}

function toggle(wrapper) {
  return wrapper.find('.editor-terminal-toggle')
}

function body(wrapper) {
  return wrapper.find('.editor-terminal-body')
}

/** `true` when the element is on screen, per the `v-show` display switch. */
function shown(wrapper) {
  const el = body(wrapper).element
  return el.style.display !== 'none'
}

function mountView() {
  return mount(EditorView, { attachTo: document.body })
}

beforeEach(() => {
  window.localStorage.clear()
  terminalStub.state.status = 'idle'
  terminalStub.state.message = 'no session'
})

describe('the terminal header’s fold control', () => {
  it('is the last of the header’s right-aligned buttons, after kill', () => {
    const w = mountView()
    const header = w.find('.editor-terminal-head')
    const buttons = header.findAll('button')

    expect(buttons).toHaveLength(3)
    // Renew, kill, fold — the order the brief names.
    expect(buttons[0].classes()).toContain('editor-terminal-new')
    expect(buttons[1].classes()).toContain('editor-terminal-kill')
    expect(buttons[2].classes()).toContain('editor-terminal-toggle')

    // An icon button in the app's idiom, and never disabled: folding is always
    // available, with or without a live session.
    expect(buttons[2].classes()).toContain('icon-btn')
    expect(buttons[2].attributes('disabled')).toBeUndefined()
    expect(buttons[2].attributes('type')).toBe('button')
    w.unmount()
  })

  it('says what it does, and answers its state to assistive tech', async () => {
    const w = mountView()
    const btn = toggle(w)

    expect(btn.attributes('aria-expanded')).toBe('true')
    expect(btn.attributes('aria-label')).toBe('Hide the terminal')
    expect(btn.attributes('title')).toContain('Hide the terminal')
    expect(btn.attributes('aria-controls')).toBe('editor-terminal-body')

    await btn.trigger('click')
    await nextTick()

    expect(toggle(w).attributes('aria-expanded')).toBe('false')
    expect(toggle(w).attributes('aria-label')).toBe('Show the terminal')
    // The body is out of the flow, so there is nothing for it to control.
    expect(toggle(w).attributes('aria-controls')).toBeUndefined()
    w.unmount()
  })
})

describe('folding and unfolding the terminal', () => {
  it('hides the body and hands the row to the code pane, then restores it', async () => {
    // A dragged height on file, so "the stored size survives the fold" is a
    // statement about a real value rather than about the CSS default.
    window.localStorage.setItem(SIZE_KEY, '260')
    const w = mountView()
    await nextTick()

    const shell = w.find('.editor-shell')
    expect(shown(w)).toBe(true)
    expect(shell.classes()).not.toContain('editor-shell--terminal-collapsed')
    // The resizer is the fold's other half: a bar for a pane that is not there
    // would drag nothing.
    expect(w.find('.editor-resizer-h').exists()).toBe(true)

    await toggle(w).trigger('click')
    await nextTick()

    expect(shown(w)).toBe(false)
    // The head strip is what stays: it carries the control that brings the pane
    // back, so a fold can never hide its own undo.
    expect(w.find('.editor-terminal-head').exists()).toBe(true)
    expect(shell.classes()).toContain('editor-shell--terminal-collapsed')
    expect(w.find('.editor-resizer-h').exists()).toBe(false)
    // The dragged height is not written to the layout while folded, so it comes
    // back exactly as it was left.
    expect(shell.attributes('style') ?? '').not.toContain('--bi-editor-terminal')
    expect(window.localStorage.getItem(COLLAPSE_KEY)).toBe('1')
    expect(window.localStorage.getItem(SIZE_KEY)).toBe('260')

    await toggle(w).trigger('click')
    await nextTick()

    expect(shown(w)).toBe(true)
    expect(shell.classes()).not.toContain('editor-shell--terminal-collapsed')
    expect(w.find('.editor-resizer-h').exists()).toBe(true)
    expect(shell.attributes('style') ?? '').toContain('--bi-editor-terminal: 260px')
    expect(window.localStorage.getItem(COLLAPSE_KEY)).toBe('0')
    w.unmount()
  })

  it('opens folded when the preference was saved that way', async () => {
    window.localStorage.setItem(COLLAPSE_KEY, '1')
    const w = mountView()
    await nextTick()

    expect(shown(w)).toBe(false)
    expect(w.find('.editor-shell').classes()).toContain('editor-shell--terminal-collapsed')
    expect(toggle(w).attributes('aria-expanded')).toBe('false')
    // Unfolding is one click away, from the strip that is still on screen.
    await toggle(w).trigger('click')
    await nextTick()
    expect(shown(w)).toBe(true)
    w.unmount()
  })

  it('keeps the shell mounted across both states, so a live shell is never lost', async () => {
    const w = mountView()
    const section = w.find('.editor-terminal')

    await toggle(w).trigger('click')
    await nextTick()
    expect(w.find('.editor-terminal').element).toBe(section.element)
    expect(w.find('.editor-terminal-body').exists()).toBe(true)
    w.unmount()
  })
})

describe('the fold’s geometry, as shipped', () => {
  it('sizes the terminal’s track by the head strip instead of its dragged height', () => {
    const body = ruleBody(strippedCss(), '.editor-shell--terminal-collapsed')
    expect(body, '.editor-shell--terminal-collapsed has a rule of its own').not.toBeNull()

    const tracks = rowsOf(body)
    // Four tracks in the wide layout: the code pane absorbs the height, the
    // resizer's row is empty, the terminal is sized by its content, and the
    // status bar keeps its own `auto`.
    expect(tracks).toEqual(['minmax(0, 1fr)', 'auto', 'auto', 'auto'])
    // The positive half: the dragged size is not named at all here.
    expect(body).not.toContain('--bi-editor-terminal')
  })

  it('restates the track list at the narrow breakpoint too', () => {
    const media = mediaBody(strippedCss(), '@media (max-width: 1024px)')
    expect(media, 'the 1024 px block is still there').not.toBeNull()

    const body = ruleBody(media, '.editor-shell--terminal-collapsed')
    expect(body, 'the fold is re-placed below 1024 px').not.toBeNull()
    // Five rows there (the tree is on its own), and none of them is the fixed
    // terminal height — the terminal's row is its head strip's.
    const tracks = rowsOf(body)
    expect(tracks).toHaveLength(5)
    expect(tracks).toEqual(['auto', 'minmax(0, 1fr)', 'auto', 'auto', 'auto'])
    expect(body).not.toContain('--bi-editor-terminal')
  })

  it('sizes its control like the two beside it, and drops the body’s hairline', () => {
    const css = strippedCss()
    const btn = ruleBody(css, '.editor-terminal-toggle')
    expect(btn, '.editor-terminal-toggle has a rule').not.toBeNull()
    expect(btn).toContain('width: 28px')
    expect(btn).toContain('height: 28px')
    expect(btn).toContain('flex: none')

    // Folded, the head strip is the whole pane: the body's border-bottom would
    // otherwise be a second edge against the status bar.
    const head = ruleBody(css, '.editor-terminal--collapsed .editor-terminal-head')
    expect(head, 'the folded head has a rule of its own').not.toBeNull()
    expect(head).toContain('border-bottom: 0')
  })
})

// The head strip's height is its own content plus its padding — nothing else.
// Pico puts a 1rem bottom margin on every `[type=button]`, which in a one-row
// strip is not spacing but height: it made the head 14 px taller than its
// contents and left the three buttons riding high instead of centred on the
// text beside them.
describe('the head strip’s height', () => {
  it('cancels the margin Pico gives a button, so no button decides the height', () => {
    const btn = ruleBody(strippedCss(), '.editor-terminal-head .icon-btn')
    expect(btn, 'the head’s buttons have a rule of their own').not.toBeNull()
    expect(btn).toContain('margin: 0')
  })

  it('stays one centred row: `align-items: center` and a single small padding', () => {
    const head = ruleBody(strippedCss(), '.editor-terminal-head')
    expect(head, '.editor-terminal-head has a rule').not.toBeNull()
    expect(head).toContain('display: flex')
    // Centred, not baseline-aligned: the buttons are 28 px tall boxes, so a
    // baseline row would sit them high against 14 px of text.
    expect(head).toContain('align-items: center')
    // `--bi-space-1` vertically: a strip, not a panel.
    expect(head).toContain('padding: var(--bi-space-1) var(--bi-space-2)')
  })
})
