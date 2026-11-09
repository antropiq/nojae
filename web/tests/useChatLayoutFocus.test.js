import { afterEach, describe, expect, it } from 'vitest'
import { ref } from 'vue'

import {
  FOCUS_CONVERSATION,
  FOCUS_NORMAL,
  FOCUS_REASONING,
  useChatLayout,
} from '../src/composables/useChatLayout'

// The screen's focalisation is one axis of three values (D1), and this file is
// where that is pinned down — no CSS and no template are involved yet, only the
// state the later tasks render. The splitters are part of the same composable,
// so their storage keys are asserted here too: a focus state that resized
// anything would silently destroy a dragged height (D3).
//
// The four arguments are the column/input/dock refs `useChatLayout` hands to
// `useSplitter`; null refs make both splitters inert (no shell to measure),
// which is what the tests want — the axis must not need a laid-out DOM.
// (The direct call does print Vue's "onMounted without a component instance"
// warning for those two splitters: harmless here, and the alternative — a
// throwaway component per test — would add a mount to every case without
// testing anything the axis owns.)
function layout() {
  return useChatLayout(ref(null), ref(null), ref(null), ref(null))
}

// The same layout with the caller's busy rule wired in — the fifth argument
// `WorkBenchView` passes (`useChat`'s `chatBusy`). A plain closure rather than
// a flag, because that is what the guard reads: the verdict at the moment of
// the write, not a reactive copy of it.
function guardedLayout(isBusy) {
  return useChatLayout(ref(null), ref(null), ref(null), ref(null), isBusy)
}

function pair(l) {
  return [l.focus.value, l.leftHidden.value]
}

const SPLIT_KEYS = ['nojae:chatToolsColumn', 'nojae:chatSplit']
const HIDDEN_KEY = 'nojae:chatLeftHidden'
const COLLAPSE_KEY = 'nojae:chatToolsCollapsed'

const STATES = [FOCUS_NORMAL, FOCUS_REASONING, FOCUS_CONVERSATION]

// What each state looks like from the outside, so the exclusivity table is one
// lookup rather than a hand-written expectation per transition.
const SHAPE = {
  [FOCUS_NORMAL]: [FOCUS_NORMAL, false],
  [FOCUS_REASONING]: [FOCUS_REASONING, false],
  [FOCUS_CONVERSATION]: [FOCUS_CONVERSATION, true],
}

let storageDescriptor = null

// `restoreMocks` does not undo a redefined `window.localStorage`, so this file
// owns the undo — otherwise the next file in the run inherits a throwing get.
function disableStorage() {
  storageDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')
  Object.defineProperty(window, 'localStorage', {
    configurable: true,
    get() {
      throw new Error('storage disabled')
    },
  })
}

afterEach(() => {
  if (storageDescriptor) {
    Object.defineProperty(window, 'localStorage', storageDescriptor)
    storageDescriptor = null
  }
  window.localStorage.clear()
})

describe('the focus axis', () => {
  it('reaches the three values and round-trips through the control', () => {
    const l = layout()
    expect(l.focus.value).toBe(FOCUS_NORMAL)

    l.toggleFocus()
    expect(l.focus.value).toBe(FOCUS_REASONING)
    l.toggleFocus()
    expect(l.focus.value).toBe(FOCUS_NORMAL)

    l.setFocus(FOCUS_CONVERSATION)
    expect(l.focus.value).toBe(FOCUS_CONVERSATION)
  })

  // All six ordered pairs: from any state to any other, the pair that comes
  // out is the target's own shape — never a leftover of the one left behind.
  it('never leaves two focalisations on at once', () => {
    for (const from of STATES) {
      for (const to of STATES) {
        if (from === to) continue
        window.localStorage.clear()
        const l = layout()
        l.setFocus(from)
        expect(pair(l)).toEqual(SHAPE[from])
        l.setFocus(to)
        expect(pair(l)).toEqual(SHAPE[to])
      }
    }
  })

  it('uncovers the column and maximises in one step from conversation', () => {
    const l = layout()
    l.setFocus(FOCUS_CONVERSATION)
    l.toggleFocus()
    expect(pair(l)).toEqual(SHAPE[FOCUS_REASONING])
  })

  it('ignores a value that is not on the axis', () => {
    const l = layout()
    l.toggleFocus()
    for (const junk of ['nonsense', undefined, null, '', 0, FOCUS_REASONING]) {
      l.setFocus(junk)
      expect(l.focus.value).toBe(FOCUS_REASONING)
      expect(l.leftHidden.value).toBe(false)
    }
  })
})

describe('persistence of the axis', () => {
  it('keeps conversation across a re-mount, and reasoning not', () => {
    const first = layout()
    first.toggleLeftHidden()
    expect(first.leftHidden.value).toBe(true)

    const second = layout()
    expect(second.leftHidden.value).toBe(true)
    expect(second.focus.value).toBe(FOCUS_CONVERSATION)

    const maximised = layout()
    maximised.setFocus(FOCUS_REASONING)
    expect(layout().focus.value).toBe(FOCUS_NORMAL)
  })

  it('flips the flag through the control and writes it through', () => {
    const l = layout()
    l.toggleLeftHidden()
    expect(window.localStorage.getItem(HIDDEN_KEY)).toBe('1')
    l.toggleLeftHidden()
    expect(window.localStorage.getItem(HIDDEN_KEY)).toBe('0')
    expect(pair(l)).toEqual(SHAPE[FOCUS_NORMAL])
  })

  it('leaves the splitter keys alone', () => {
    window.localStorage.setItem(SPLIT_KEYS[0], '320')
    window.localStorage.setItem(SPLIT_KEYS[1], '140')

    const l = layout()
    for (const from of STATES) {
      for (const to of STATES) {
        l.setFocus(from)
        l.setFocus(to)
        l.toggleFocus()
        l.toggleLeftHidden()
      }
    }

    expect(window.localStorage.getItem(SPLIT_KEYS[0])).toBe('320')
    expect(window.localStorage.getItem(SPLIT_KEYS[1])).toBe('140')
  })

  it('stays independent of the dock fold', () => {
    const l = layout()
    l.dockCollapsed.value = true
    expect(window.localStorage.getItem(COLLAPSE_KEY)).toBe('1')

    const before = l.dockCollapsed.value
    l.toggleFocus()
    l.toggleLeftHidden()
    l.toggleFocus()
    l.setFocus(FOCUS_NORMAL)

    expect(l.dockCollapsed.value).toBe(before)
    expect(window.localStorage.getItem(COLLAPSE_KEY)).toBe('1')
    // The dock's own fold never decided the focalisation, and vice versa.
    expect(pair(l)).toEqual(SHAPE[FOCUS_NORMAL])
  })

  it('works for the session when storage throws', () => {
    disableStorage()
    const l = layout()
    expect(l.focus.value).toBe(FOCUS_NORMAL)

    l.toggleFocus()
    expect(l.focus.value).toBe(FOCUS_REASONING)
    l.toggleLeftHidden()
    expect(pair(l)).toEqual(SHAPE[FOCUS_CONVERSATION])
    l.toggleFocus()
    expect(pair(l)).toEqual(SHAPE[FOCUS_REASONING])
    l.setFocus(FOCUS_NORMAL)
    expect(pair(l)).toEqual(SHAPE[FOCUS_NORMAL])
    l.dockCollapsed.value = true
    expect(l.dockCollapsed.value).toBe(true)
  })
})

// wf-04's sweep. The cases above walk *transitions* (one hop per pair); this
// walks a whole session the way a user actually moves — one control, then the
// other, sometimes from a state the previous click left behind — and asserts
// the pair at every step, not only at the destination. A bug that only shows
// on the third hop (a leftover `view` behind a persisted flag, say) is
// invisible to the single-hop table.
describe('a walk through the states', () => {
  it('keeps the pair honest over a full cycle of both controls', () => {
    const l = layout()
    // normal -> reasoning -> normal -> conversation -> reasoning ->
    // conversation -> normal, each step by the gesture a user would use.
    const steps = [
      ['toggleFocus', FOCUS_REASONING],
      ['toggleFocus', FOCUS_NORMAL],
      ['toggleLeftHidden', FOCUS_CONVERSATION],
      // From `conversation` the focus control uncovers the column and
      // maximises in one gesture (spec §2), so the pair must be reasoning's.
      ['toggleFocus', FOCUS_REASONING],
      ['toggleLeftHidden', FOCUS_CONVERSATION],
      ['toggleLeftHidden', FOCUS_NORMAL],
    ]

    expect(pair(l)).toEqual(SHAPE[FOCUS_NORMAL])
    for (const [gesture, expected] of steps) {
      l[gesture]()
      expect([gesture, ...pair(l)]).toEqual([gesture, ...SHAPE[expected]])
    }

    // Storage agrees with the live pair at the end of the walk, which is what
    // a reload reads back (D4).
    expect(window.localStorage.getItem(HIDDEN_KEY)).toBe('0')
  })

  // The screen's two independent flags — the dock's fold and the axis — were
  // never silently merged: the fold survives every state in both orders, and
  // the axis survives the fold being flipped mid-walk.
  it('leaves the dock fold alone when the axis walks, and the reverse', () => {
    // Fold first, walk all three states, unfold last.
    const folded = layout()
    folded.dockCollapsed.value = true
    folded.toggleFocus()
    folded.toggleLeftHidden()
    folded.toggleFocus()
    folded.setFocus(FOCUS_NORMAL)
    expect(folded.dockCollapsed.value).toBe(true)
    expect(window.localStorage.getItem(COLLAPSE_KEY)).toBe('1')
    expect(pair(folded)).toEqual(SHAPE[FOCUS_NORMAL])

    // Walk first, fold while a state is active, walk on.
    const walked = layout()
    walked.toggleFocus()
    walked.dockCollapsed.value = true
    walked.toggleLeftHidden()
    walked.toggleFocus()
    expect(walked.dockCollapsed.value).toBe(true)
    expect(pair(walked)).toEqual(SHAPE[FOCUS_REASONING])
  })
})

// The fold's lock. Folding resizes the box the reasoning timeline paints
// into, and that box is measured once per inference and then frozen, so a fold
// mid-reply leaves the stream flowing in the window computed before it — the
// bug the lock exists to prevent. The rule is the caller's (`chatBusy`), read
// here at the moment of the write, so no writer can slip past it: the dock's
// button is `:disabled` for the reader, this is the guard.
describe('the fold while an inference runs', () => {
  it('refuses the fold, in both directions, and persists nothing', () => {
    let busy = true
    const l = guardedLayout(() => busy)

    l.dockCollapsed.value = true
    expect(l.dockCollapsed.value).toBe(false)
    expect(window.localStorage.getItem(COLLAPSE_KEY)).toBe(null)

    // And the same layout takes the fold as soon as the rule says idle.
    busy = false
    l.dockCollapsed.value = true
    expect(l.dockCollapsed.value).toBe(true)
    expect(window.localStorage.getItem(COLLAPSE_KEY)).toBe('1')
  })

  // Unfolding is refused too: the box changes either way. The fold is read back
  // from storage (the flag's own persistence), so the layout starts folded
  // without the guard having to allow a write to get there.
  it('refuses to unfold as well', () => {
    window.localStorage.setItem(COLLAPSE_KEY, '1')
    const l = guardedLayout(() => true)
    expect(l.dockCollapsed.value).toBe(true)

    l.dockCollapsed.value = false
    expect(l.dockCollapsed.value).toBe(true)
    expect(window.localStorage.getItem(COLLAPSE_KEY)).toBe('1')
  })

  // A layout nobody gave a rule to still folds: the guard is the caller's
  // decision, and `useChatLayout` has no streaming state of its own.
  it('is free when the caller has no busy rule', () => {
    const l = layout()
    l.dockCollapsed.value = true
    expect(l.dockCollapsed.value).toBe(true)
    expect(window.localStorage.getItem(COLLAPSE_KEY)).toBe('1')
  })

  // The lock is the fold's only new behaviour: the axis it shares the composable
  // with is untouched by it, so a reply cannot strand a focalisation.
  it('leaves the focus axis free while it holds the fold', () => {
    const l = guardedLayout(() => true)
    l.toggleFocus()
    l.toggleLeftHidden()
    expect(pair(l)).toEqual(SHAPE[FOCUS_CONVERSATION])
  })
})
