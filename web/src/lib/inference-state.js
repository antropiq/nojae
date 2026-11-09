// The one bit that answers "is an inference in flight right now?", derived from
// the two states that can own one:
//   * WorkBench reply — waiting, reasoning or answering (a batch turn too);
//   * batch lot — stays busy across the gap between two task turns, which is
//     when the chat phase is back to 'idle' but a task is still owed.
//
// Both the browser-tab glyph (useTabTitle) and the end-of-session chime
// (useSessionSound) read it, so the two indicators can never disagree about
// which turn just ended.
//
// It stays a pure function of the two reactive states rather than importing
// the composables: the dependency graph remains acyclic (useBatch already
// imports useChat) and the rule is testable on its own.
export function inferenceRunning({ chat, batch }) {
  if (batch.active) return true
  return ['waiting', 'reasoning', 'answering'].includes(chat.phase)
}
