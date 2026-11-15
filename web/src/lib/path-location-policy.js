// One place to say what the file in the workspace's reserved folder is doing
// (pol-05's read-write policy).
//
// `GET /api/workspace` reports `{state, path, error}` for it, and the app bar's
// working-location field is the one surface that speaks about it. It renders
// only the `warn` sentences, as the one line under its field, and stays silent
// on the `plain` ones — the bar has room for a warning, not for a caption. It
// gets its sentences from here rather than inventing them, because the *tone*
// carries meaning: `failed` is a warning that the folder moved and the seed did
// not, `absent` is a plain fact, `created` is reassurance that the project's own
// config is readable and editable outside the app.
//
// The wording is unchanged by clws-02: the folder is the tab's own now, but
// what the file is doing is the same question either way.
//
// The prompt helpers and the agent modes used to be the other blocks here. Both
// are rows in ``nojae.db`` now, so a working location has no file to report on
// and there is nothing for the bar to say about them (D11, §4.7).

export const POLICY_STATES = ['created', 'existing', 'absent', 'failed']

// `tone` is what a caller renders it as: 'warn' is a line the user should read
// but not act on, 'plain' is context.
//
// A state the user has nothing to learn from answers `null`: `existing` is the
// ordinary case of a project that has had its file since the last switch, and
// naming the path of a file nobody asked about is noise, so the three describers
// say nothing about it. `absent`, `failed` and the rest still get their sentence.
export function describePolicy(policy) {
  if (!policy || !policy.state) return null
  switch (policy.state) {
    case 'created':
      return {
        tone: 'plain',
        text: `Created this project's read-write policy: ${policy.path}. It is edited outside the app, and it decides what the Editor hides or locks.`,
      }
    case 'existing':
      return null
    case 'absent':
      return {
        tone: 'plain',
        text: 'This project has no read-write policy file, so its tree is not filtered by any workspace rules.',
      }
    case 'failed':
      // Deliberately NOT an error line: the location moved and both hubs
      // restarted, so the switch succeeded. Only the file could not be written.
      return {
        tone: 'warn',
        text: `Working location is set, but nojae could not create its policy file (${policy.path ?? '?'}): ${
          policy.error || 'unknown error'
        }. That project's tree is not filtered by any workspace rules yet.`,
      }
    default:
      return null
  }
}


