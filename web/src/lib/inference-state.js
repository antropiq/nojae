// The phases that mean "a reply is in flight" — every value of
// `useChat.state.phase` except 'idle'.
//
// This is the app's **only** copy of that list. Spec §5.12 is explicit about
// why: the same question is asked in two places — the tab glyph and the
// end-of-session chime read `inferenceRunning` below, the app bar's status pill
// used to keep its own literal — and a phase added to one copy and not the
// other makes the app go quiet mid-turn (the chime rings as though the reply
// had ended, the glyph stops, the composer stays locked). So the bar imports
// this list instead of restating it, and one test asserts the two still answer
// the same question for every phase.
//
// `reconnecting` belongs here as much as the other three: the endpoint refused
// a round and the app is waiting to ask again, so the turn is every bit as much
// in flight as one that is thinking.
export const PHASES_IN_FLIGHT = ['waiting', 'reasoning', 'answering', 'reconnecting']

// The phase-only half of the verdict, exported so a surface with no batch state
// to read (the app bar's pill) asks the *same* question instead of writing the
// list out again.
export function phaseInFlight(phase) {
  return PHASES_IN_FLIGHT.includes(phase)
}

// The one bit that answers "is an inference in flight right now?", derived from
// the two states that can own one:
//   * WorkBench reply — waiting, reasoning, answering or waiting on a refused
//     endpoint (a batch turn too);
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
  return phaseInFlight(chat.phase)
}
