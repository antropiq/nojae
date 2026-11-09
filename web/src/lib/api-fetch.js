// One read-only GET, retried, and a sentence for when it still fails.
//
// Why this exists: a settings dialog opens by fetching four or five things at
// once, and the browser's network stack raises `TypeError: Error in input stream`
// whenever a request's connection dies mid-flight — a Wi-Fi drop, a laptop
// waking, a proxy restarting. Without a second attempt the dialog shows the raw
// TypeError and the user has to reopen it; with one, a short blip is invisible.
//
// Scoped deliberately to GET loaders. POSTs (save settings, save LSP/MCP, set
// the working location, chat) are NOT wrapped here: a retry on those would
// either duplicate a write or resume a half-streamed reply, and each of those
// already carries its own user-visible error the user acts on.
//
// Only the *transport* failure retries. A response that comes back with a 4xx
// or 5xx reached the server fine and the server had something to say about it,
// so the loader's own `!res.ok` path renders the answer — retrying a 422 would
// hide a real error behind a longer wait.

const DEFAULT_RETRIES = 2
const DEFAULT_BASE_DELAY_MS = 300

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function fetchWithRetry(
  url,
  options = {},
  { retries = DEFAULT_RETRIES, baseDelayMs = DEFAULT_BASE_DELAY_MS, sleepFn = sleep } = {},
) {
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fetch(url, options)
    } catch (exc) {
      lastError = exc
      // Exponential backoff between attempts; never after the last one.
      if (attempt < retries) await sleepFn(baseDelayMs * 2 ** attempt)
    }
  }
  throw lastError
}

// Turn a transport failure into a sentence a person can act on. The raw error
// (`TypeError: Error in input stream`, `TypeError: Failed to fetch`, a
// DOMException for an aborted request, ...) is browser-stack noise: it names a
// socket, not the problem. After `fetchWithRetry` has retried and still failed,
// the one true cause left is that the server was not reachable, so that is what
// we say — the raw error is kept in a trailing bracket for the console, not read
// as the message.
export function describeTransportError(exc) {
  const raw = exc instanceof Error ? `${exc.name}: ${exc.message}` : String(exc)
  return `Network unavailable — could not reach the server. Check the connection and try again. [${raw}]`
}
