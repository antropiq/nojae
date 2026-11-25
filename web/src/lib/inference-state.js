// The phases that mean "a reply is in flight" — every value of
// `useChat.state.phase` except 'idle'.
//
// This is the app's **only** copy of that list: a phase added to one copy and
// not another makes the app go quiet mid-turn — the chime rings as though the
// reply had ended, the glyph stops, the composer stays locked. So the app bar
// imports this list instead of restating it, and one test asserts every surface
// answers the same question for every phase.
//
// `reconnecting` belongs here as much as the other three: the endpoint refused
// a round and the app is waiting to ask again, so the turn is every bit as much
// in flight as one that is thinking.
export const PHASES_IN_FLIGHT = ['waiting', 'reasoning', 'answering', 'reconnecting']

// The phase-only half of the verdict, so a surface with no batch state to read
// (the app bar's pill) asks the *same* question instead of writing the list out.
export function phaseInFlight(phase) {
  return PHASES_IN_FLIGHT.includes(phase)
}

// "Is an inference in flight right now?", derived from the two states that can
// own one:
//   * WorkBench reply — waiting, reasoning, answering or waiting on a refused
//     endpoint (a batch turn too);
//   * batch lot — stays busy across the gap between two task turns, which is
//     when the chat phase is back to 'idle' but a task is still owed.
//
// Both the browser-tab glyph (useTabTitle) and the end-of-session chime
// (useSessionSound) read it, so the two can never disagree about which turn just
// ended. It stays a pure function of the two reactive states rather than
// importing the composables: the dependency graph stays acyclic (useBatch already
// imports useChat) and the rule is testable on its own.
export function inferenceRunning({ chat, batch }) {
  if (batch.active) return true
  return phaseInFlight(chat.phase)
}
