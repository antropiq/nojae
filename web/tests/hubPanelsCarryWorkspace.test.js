import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppShell } from '../src/composables/useAppShell'
import { useChat } from '../src/composables/useChat'
import {
  clearTabWorkspace,
  pointTabAt,
  workspaceOf,
} from './helpers/workspace-url'

// ---------------------------------------------------------------------------
// The hub panels show **this tab's workspace's** tools (clws-06).
//
// Task 02 wrapped every hub call site in `withWorkspace`; task 06 is where that
// starts to matter, because the server now answers each one about the folder it
// names. Two facts are worth pinning on the client side:
//
// * the fetch **carries the tab's folder** — a panel that asked about no folder
//   would get whatever the server defaults to, which is another tab's answer;
// * moving the tab's folder **re-reads** rather than keeping the previous list —
//   the panels are workspace state, so the payload of the folder the tab left
//   must not linger on screen beside the new folder's name.
//
// The restart handlers are in the same family: a Restart pressed in a tab on A
// rebuilds A's tools, so the request must name A.
// ---------------------------------------------------------------------------

const shell = useAppShell().state
const chat = useChat().state

function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

const MCP_A = {
  installed: true,
  connectors: [{ id: 'console', label: 'Console', active: true, status: 'running' }],
  externalsError: null,
  built: false,
}
const MCP_B = {
  installed: true,
  connectors: [{ id: 'fedit', label: 'Fedit', active: true, status: 'running' }],
  externalsError: null,
  built: false,
}
const LSP_A = {
  installed: true,
  servers: [{ id: 'pyright', label: 'Pyright', active: true, status: 'running' }],
  serversError: null,
  built: false,
}
const LSP_B = {
  installed: true,
  servers: [{ id: 'vue', label: 'Vue', active: true, status: 'running' }],
  serversError: null,
  built: false,
}

// One stub for the four hub routes, answering per folder so a stale answer is
// observable rather than merely possible.
function stubHubs() {
  const urls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    urls.push(String(url))
    const folder = workspaceOf(url)
    if (String(url).startsWith('/api/mcp')) {
      return jsonResponse(folder === '/w/b' ? MCP_B : MCP_A)
    }
    return jsonResponse(folder === '/w/b' ? LSP_B : LSP_A)
  })
  return urls
}

function reset() {
  clearTabWorkspace()
  shell.mcpConnectors = []
  shell.mcpEnabled = []
  shell.lspServers = []
  shell.lspActivated = []
  chat.mcp = { connectors: [], enabled: {}, loaded: false, locked: false, restarting: false }
  chat.lsp = { servers: [], enabled: {}, loaded: false, locked: false, restarting: false }
}

describe('a hub panel fetch names the tab’s folder', () => {
  beforeEach(reset)

  it('carries it on both Settings reads', async () => {
    const root = pointTabAt('/w/a')
    const urls = stubHubs()

    await useAppShell().loadMcp()
    await useAppShell().loadLsp()

    expect(workspaceOf(urls[0])).toBe(root)
    expect(workspaceOf(urls[1])).toBe(root)
    expect(shell.mcpConnectors.map((c) => c.id)).toEqual(['console'])
    expect(shell.lspServers.map((s) => s.id)).toEqual(['pyright'])
  })

  it('carries it on the conversation-scoped reads too', async () => {
    const root = pointTabAt('/w/a')
    const urls = stubHubs()

    await useChat().loadChatMcp()
    await useChat().loadChatLsp()

    expect(workspaceOf(urls[0])).toBe(root)
    expect(workspaceOf(urls[1])).toBe(root)
    expect(chat.mcp.connectors.map((c) => c.id)).toEqual(['console'])
  })

  it('carries it on a hub restart', async () => {
    const root = pointTabAt('/w/a')
    const urls = stubHubs()

    await useChat().restartMcp()
    await useChat().restartLsp()

    // A restart is followed by a re-read of the panel (the handler's `finally`),
    // so the restart POSTs are picked out by route — and **every** call, the
    // restart and the re-read alike, names this tab's folder.
    const restarts = urls.filter((url) => url.includes('/restart'))
    expect(restarts.map((url) => url.split('?')[0])).toEqual([
      '/api/mcp/restart',
      '/api/lsp/restart',
    ])
    for (const url of urls) {
      expect(workspaceOf(url)).toBe(root)
    }
  })
})

describe('moving the tab’s folder re-reads the panels', () => {
  beforeEach(reset)

  it('shows the new folder’s connectors, not the ones it left', async () => {
    pointTabAt('/w/a')
    stubHubs()
    await useAppShell().loadMcp()
    await useAppShell().loadLsp()
    expect(shell.mcpConnectors.map((c) => c.id)).toEqual(['console'])

    // The gesture, as `AppBar.applyLocation` performs it: the tab's folder moves
    // first, then the panels are repainted from the read's payload, then the
    // conversation-scoped panels re-snapshot **from the new folder**. The
    // previous folder's rows are gone, not appended to.
    pointTabAt('/w/b')
    useAppShell().applyWorkspaceHubs({ mcp: MCP_B, lsp: LSP_B })
    // The loaders are async (fetch → json → state); a macrotask drains them.
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(shell.mcpConnectors.map((c) => c.id)).toEqual(['fedit'])
    expect(shell.mcpEnabled).toEqual(['fedit'])
    expect(shell.lspServers.map((s) => s.id)).toEqual(['vue'])
    expect(shell.lspActivated).toEqual(['vue'])
    expect(chat.mcp.connectors.map((c) => c.id)).toEqual(['fedit'])
    expect(chat.lsp.servers.map((s) => s.id)).toEqual(['vue'])
  })

  it('re-reads from the new folder when the panel is opened again', async () => {
    pointTabAt('/w/a')
    const urls = stubHubs()
    await useAppShell().loadMcp()
    expect(shell.mcpConnectors.map((c) => c.id)).toEqual(['console'])

    pointTabAt('/w/b')
    await useAppShell().loadMcp()

    expect(workspaceOf(urls[1])).toBe('/w/b')
    expect(shell.mcpConnectors.map((c) => c.id)).toEqual(['fedit'])
  })
})
