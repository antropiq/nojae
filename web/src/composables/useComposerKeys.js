import { reactive } from 'vue'

// The composer's Enter key, in one place.
//
// By default Enter sends the message and Shift+Enter writes a newline. The
// composer's toggle inverts that: Enter becomes a plain newline and only
// Shift+Enter sends, so a multi-line draft can be finished — and reread —
// before it is handed to the model.
//
// It lives here rather than in the component because the composer is mounted
// once and kept alive (its tab is `v-show`n), so a component-local `ref` would
// already survive a tab change — but this is a *preference*, of the same order
// as the layout flags in `useChatLayout`: it is worth carrying across a reload,
// and it is worth reading from a test without mounting the composer.
//
// Deliberately not sent anywhere: which key sends is a keyboard habit of this
// browser, not a property of the conversation or of the model.

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
  // The one switch, and the only writer of the flag: it flips and writes
  // through, the way `useSessionSound.toggle` does. Nothing else moves
  // `enterSends`, so the stored value can never disagree with the live one.
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
