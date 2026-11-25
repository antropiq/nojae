import { reactive } from 'vue'

// The composer's Enter key, in one place: by default Enter sends and
// Shift+Enter writes a newline, and the composer's toggle inverts that so a
// multi-line draft can be reread before it goes to the model.
//
// Module state, not a component ref, because it is a preference worth carrying
// across a reload and reading from a test without mounting the composer.
// Deliberately never sent anywhere: which key sends is a keyboard habit of this
// browser, not a property of the conversation.

// Exported so a test can assert the write-through without repeating the name.
export const ENTER_SENDS_KEY = 'nojae:composerEnterSends'

// Only an explicit "0" flips the behaviour: a first run (and a storage-less
// private mode) keeps the Enter-sends default.
function storedEnterSends() {
  try {
    return window.localStorage.getItem(ENTER_SENDS_KEY) !== '0'
  } catch {
    return true
  }
}

const state = reactive({ enterSends: storedEnterSends() })

export function useComposerKeys() {
  // The only writer of the flag, so the stored value can never disagree with
  // the live one.
  function toggleEnterSends() {
    state.enterSends = !state.enterSends
    try {
      window.localStorage.setItem(ENTER_SENDS_KEY, state.enterSends ? '1' : '0')
    } catch {
      // Storage disabled: the toggle still works for this session.
    }
  }

  return { state, toggleEnterSends }
}
