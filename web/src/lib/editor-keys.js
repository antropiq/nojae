// The Editor pane's window-level chords, decided apart from the listener that
// dispatches them. All the chords belong to *one* owner: splitting `Ctrl+S` into
// a Monaco keybinding and `Ctrl+W` into this listener is how one of them quietly
// stops working, because the pane is read-only while a reply streams and a
// command registered on the editor is not reachable then. The window listener
// always is.

// Returns the action for this event, or null when the pane must not consume it
// at all — which is also the signal *not* to call `preventDefault()`, so the
// browser keeps its own behaviour for every chord this app does not own.
export function editorChord(event, context) {
  // The chord belongs to the Editor screen only: a Ctrl+W elsewhere must not
  // close a buffer the user is not looking at.
  if (context.activeTab !== 'editor') return null
  if (!(event.ctrlKey || event.metaKey)) return null
  // Alt is never part of these chords: accepting Ctrl+Alt+S would take a key
  // some window managers and input methods already own.
  if (event.altKey) return null

  const key = event.key.toLowerCase()
  if (key === 's') {
    // Ctrl+S saves the active buffer, Ctrl+Shift+S the whole dirty strip.
    return context.active ? { action: event.shiftKey ? 'save-all' : 'save' } : null
  }
 if (key === 'p' && !event.shiftKey) {
   // Ctrl+P is the quick-open finder. It needs no active buffer, but it is
   // still the Editor tab's chord only: elsewhere the browser keeps Print.
   return { action: 'quick-open' }
 }
 if (key === 'w' && !event.shiftKey) {
    // Whether the close needs a confirmation is `requestCloseTab`'s business.
    // Ctrl+Shift+W is left alone: it means "close all" in these browsers, and
    // taking a chord the app has no answer for loses the user a whole window.
    return context.active ? { action: 'close' } : null
  }
  return null
}

// Consumes the event only for a chord this app owns, keeping the browser's
// Save-page and close-tab dialogs from appearing on top of the app's answer.
export function applyEditorChord(event, context, handlers) {
  const chord = editorChord(event, context)
  if (!chord) return false
  event.preventDefault()
  handlers[chord.action]?.(event)
  return true
}
