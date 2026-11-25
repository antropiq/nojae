import { computed, ref } from 'vue'
import { useSplitter } from './useSplitter.js'

// The Chat screen's geometry, in one place: the shell is one row of two columns
// with a gutter between them, so a bar sizes only its own column. Both
// splitters take the *column* as their shell, so each measures the column it
// lives in and sizes the pane after its bar.
//
// `focus` picks which surface owns the screen and reaches the DOM as one state
// class on the shell, whose rules move a whole column; no state reads or writes
// a splitter's stored size, so a dragged dock and a dragged composer come back
// exactly as they were left (see `dockCollapsed` below: a flag, not a size).
//
// The dock keeps its bar plus two switches and their hub titles. 200 px is what
// leaves the timeline above it its own 160 px floor plus the bar and the column
// gaps: any less and the clamp and the CSS floor cannot both be honoured, and
// the column overflows.
const DOCK_MIN = 104
const DOCK_MIN_OTHER = 200

const COLLAPSE_KEY = 'nojae:chatToolsCollapsed'

function loadCollapsed() {
  try {
    return window.localStorage.getItem(COLLAPSE_KEY) === '1'
  } catch {
    return false
  }
}

// Which of the two surfaces owns the screen. Three values on one axis, so
// "both at once, screen empty" is not a state this composable can be in: the
// exclusivity lives in the type, not in a CSS rule.
export const FOCUS_NORMAL = 'normal'
export const FOCUS_REASONING = 'reasoning'
export const FOCUS_CONVERSATION = 'conversation'
const FOCUS_VALUES = [FOCUS_NORMAL, FOCUS_REASONING, FOCUS_CONVERSATION]

// `conversation` is a furnishing preference, of the same order as the dock
// fold, so it persists. `reasoning` deliberately does not: reloading into it
// would boot the app with no composer — a screen with no way to speak to the
// model.
const LEFT_HIDDEN_KEY = 'nojae:chatLeftHidden'

function loadLeftHidden() {
  try {
    return window.localStorage.getItem(LEFT_HIDDEN_KEY) === '1'
  } catch {
    return false
  }
}

export function useChatLayout(leftColRef, rightColRef, inputRef, dockRef, isBusy = null) {
  const column = useSplitter(leftColRef, dockRef, {
    storageKey: 'nojae:chatToolsColumn',
    minResized: DOCK_MIN,
    minOther: DOCK_MIN_OTHER,
  })

  const composer = useSplitter(rightColRef, inputRef, {
    storageKey: 'nojae:chatSplit',
  })

  // Folding is a flag, not a size: the dock's dragged height survives it
  // untouched, so expanding comes back at exactly the height it had. The
  // write-through keeps it durable however it is flipped (the dock's button
  // through v-model, a caller through the setter).
  //
  // The fold is refused while an inference owns the conversation: folding
  // resizes the box the reasoning timeline paints into, and that box is
  // measured once per inference and then frozen, so a fold mid-reply would
  // leave the stream flowing in the window computed before it. `isBusy` is the
  // caller's own rule (useChat's `chatBusy`, so a batch between two turns locks
  // it too) read at the moment of the write — the reason the dock's button is
  // `:disabled` beside it rather than instead of it. Absent, the fold is free.
  const collapsed = ref(loadCollapsed())
  const dockCollapsed = computed({
    get: () => collapsed.value,
    set: (value) => {
      if (isBusy?.()) return
      collapsed.value = value
      try {
        window.localStorage.setItem(COLLAPSE_KEY, value ? '1' : '0')
      } catch {
        // Storage disabled: the fold still works for the session.
      }
    },
  })

  // One owner arbitrates the axis. `view` holds only the non-persisted half
  // ('normal' | 'reasoning'), and `conversation` is *derived* from the persisted
  // flag — so no caller can observe `reasoning` and a hidden left column at the
  // same time, and the view sizes from `focus`.
  const hidden = ref(loadLeftHidden())
  const view = ref(FOCUS_NORMAL)
  const focus = computed(() => (hidden.value ? FOCUS_CONVERSATION : view.value))

  // Every change of the axis goes through this one setter: it moves the flag,
  // moves `view`, and writes the flag through — so `toggleLeftHidden` is
  // allowed to be a shortcut for it rather than a second decision.
  function setFocus(next) {
    if (!FOCUS_VALUES.includes(next)) return
    hidden.value = next === FOCUS_CONVERSATION
    view.value = next === FOCUS_REASONING ? FOCUS_REASONING : FOCUS_NORMAL
    try {
      window.localStorage.setItem(LEFT_HIDDEN_KEY, hidden.value ? '1' : '0')
    } catch {
      // Storage disabled: the layout still works for the session.
    }
  }

  // A second click on the control restores, and from `conversation` it uncovers
  // the column and maximises in the same step — the reasoning panel is not on
  // screen while the column is out of the flow.
  function toggleFocus() {
    setFocus(focus.value === FOCUS_REASONING ? FOCUS_NORMAL : FOCUS_REASONING)
  }

  function toggleLeftHidden() {
    setFocus(hidden.value ? FOCUS_NORMAL : FOCUS_CONVERSATION)
  }

  // Read-only on purpose: writing the flag directly would bypass the
  // arbitration above and could persist a state the axis cannot represent.
  const leftHidden = computed(() => hidden.value)

  return {
    column,
    composer,
    dockCollapsed,
    focus,
    setFocus,
    toggleFocus,
    leftHidden,
    toggleLeftHidden,
  }
}
