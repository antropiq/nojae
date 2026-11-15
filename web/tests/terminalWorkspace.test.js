import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useTerminal } from '../src/composables/useTerminal'
import { pointTabAt, workspaceOf } from './helpers/workspace-url'

// ---------------------------------------------------------------------------
// The terminal socket names **this tab's** folder, when it opens (clws-07).
//
// The terminal is the one surface with no per-request body, so the workspace
// rides on the socket's URL and is read from the session composable's *current*
// value at the moment `connect()` runs (spec §8). What that buys, and its
// deliberate limit:
//
// * a socket opened by a tab on A names A — the shell is born there;
// * pointing the tab at B does **not** touch the open shell. It keeps the
//   folder it was born in; only the next `connect()` (the pane's New session,
//   or a reconnect after a drop) starts in B.
//
// The server's half — what it does with that field, and the two shells it
// spawns for two of them — is `tests/test_terminal.py`'s.
// ---------------------------------------------------------------------------

const terminal = useTerminal()

//: Every socket the composable opened, oldest first. A fake is enough: what is
//: asserted is the **URL**, and how many sockets opened, never the wire.
let opened = []

class FakeSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSED = 3

  constructor(url) {
    this.url = url
    this.readyState = FakeSocket.OPEN
    this.sent = []
    opened.push(this)
  }

  send(data) {
    this.sent.push(data)
  }

  close() {
    this.readyState = FakeSocket.CLOSED
  }

  // The server's `open` frame, which is where the pane's cwd comes from.
  announceOpen(cwd) {
    this.onmessage?.({
      data: JSON.stringify({ type: 'open', pid: 4242, cwd, shell: '/bin/sh' }),
    })
  }
}

function lastSocket() {
  return opened[opened.length - 1]
}

beforeEach(() => {
  opened = []
  vi.stubGlobal('WebSocket', FakeSocket)
  terminal.state.status = 'idle'
  terminal.state.message = ''
  terminal.state.cwd = ''
  terminal.state.pid = null
  terminal.state.shell = ''
})

describe('the socket names the tab’s folder', () => {
  it('carries it on the socket URL, built by the one helper', () => {
    const root = pointTabAt('/w/tab-workspace')

    terminal.connect()

    expect(opened).toHaveLength(1)
    expect(workspaceOf(lastSocket().url)).toBe(root)
    // And the route is the terminal's own: the field rides the socket's query
    // string — not a path, not a header, not the address bar (spec D9, §8).
    expect(lastSocket().url.split('?')[0]).toBe('ws://localhost:3000/api/terminal')
  })

  it('reads the folder as it is when the socket opens, never a captured one', () => {
    pointTabAt('/w/first')
    terminal.connect()
    expect(workspaceOf(lastSocket().url)).toBe('/w/first')

    pointTabAt('/w/second')
    terminal.connect()

    expect(workspaceOf(lastSocket().url)).toBe('/w/second')
    expect(opened.map((socket) => workspaceOf(socket.url))).toEqual(['/w/first', '/w/second'])
  })

  it('names no folder while the tab has none', () => {
    pointTabAt('')

    terminal.connect()

    // The boot read is still in flight; the server answers its interim default,
    // which is the same installation folder a new tab lands on.
    expect(workspaceOf(lastSocket().url)).toBe('')
  })
})

describe('a folder change never moves an open shell', () => {
  it('leaves the live session alone, and the next shell starts in the new folder', () => {
    pointTabAt('/w/left')
    terminal.connect()
    const live = lastSocket()
    live.announceOpen('/w/left')

    // The gesture: this tab points elsewhere. Nothing about the open socket
    // may change — no second socket, no close, not a new `open` frame.
    pointTabAt('/w/right')
    expect(opened).toHaveLength(1)
    expect(live.readyState).toBe(FakeSocket.OPEN)
    expect(terminal.state.cwd).toBe('/w/left')
    expect(terminal.state.status).toBe('open')

    // A *new* shell — the pane's New session — follows the tab.
    terminal.newSession()

    expect(opened).toHaveLength(2)
    expect(workspaceOf(lastSocket().url)).toBe('/w/right')
    // The old socket was closed by the composable, which tears its shell down
    // server-side; the new one is the session the pane now drives.
    expect(live.readyState).toBe(FakeSocket.CLOSED)
  })

  it('shows the cwd the server reported, never a value the tab made up', () => {
    pointTabAt('/w/right')
    terminal.connect()
    // The server answers about the folder the shell was *born* in, which is
    // what the header renders: a tab that has since moved cannot overwrite it.
    lastSocket().announceOpen('/w/left')

    expect(terminal.state.cwd).toBe('/w/left')
  })
})

describe('a refused folder is shown in the pane', () => {
  // The server answers a refused folder twice: the seam's sentence in an
  // `error` frame, then the policy close with the same words as its reason —
  // bounded, because a WebSocket close reason is capped at 123 bytes. The pane
  // must keep the frame's **full** sentence rather than the truncated reason,
  // and must still show the code's own line for a refusal that never accepted
  // (a foreign Origin), where no frame exists.
  const SENTENCE =
    'Working location is not an existing directory: /w/gone-and-a-very-long-name-here'

  it('keeps the full sentence the error frame carried', () => {
    pointTabAt('/w/gone-and-a-very-long-name-here')
    terminal.connect()
    const socket = lastSocket()

    socket.onmessage?.({ data: JSON.stringify({ type: 'error', message: SENTENCE }) })
    socket.onclose?.({ code: 4403, reason: SENTENCE.slice(0, 80) })

    expect(terminal.state.status).toBe('error')
    expect(terminal.state.message).toBe(SENTENCE)
  })

  it('still names a refused connection that sent no frame', () => {
    pointTabAt('/w/a')
    terminal.connect()

    // A refused Origin never accepts, so no frame lands: the close owns the line.
    lastSocket().onclose?.({ code: 4403, reason: 'Origin refused: https://evil.example' })

    expect(terminal.state.status).toBe('error')
    expect(terminal.state.message).toBe(
      'Connection refused: Origin refused: https://evil.example',
    )
  })
})
