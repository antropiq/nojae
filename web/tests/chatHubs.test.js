import { describe, expect, it } from 'vitest'

import {
  lspHasEntries,
  mcpHasEntries,
  hubsSummary,
} from '../src/lib/chat-hubs'

// `lib/chat-hubs` answers one question now: does a hub hold anything to switch.
// It no longer answers anything about geometry — both tool panels are always
// rendered and the Chat left column keeps its two-panel width whatever the
// answer is (that is pinned by `workbenchToolsColumnWidth.test.js`). A hub with
// no declared entry is a panel that says so, never a panel that leaves the
// dock, so what is worth pinning here is that the *contents* verdict stays
// separate from the *layout* verdict.
function hubState({ mcpLoaded = true, mcp = [], lspLoaded = true, lsp = [] }) {
  return {
    mcp: {
      loaded: mcpLoaded,
      connectors: mcp,
      enabled: Object.fromEntries(mcp.map((c) => [c.id, c.on])),
    },
    lsp: {
      loaded: lspLoaded,
      servers: lsp,
      enabled: Object.fromEntries(lsp.map((s) => [s.id, s.on])),
    },
  }
}

const MCP = [{ id: 'console', label: 'Console', on: true }]
const LSP = [{ id: 'pyright', label: 'Pyright', on: false }]

describe('what each hub holds', () => {
  it('reports a hub with no declared entry as empty', () => {
    const state = hubState({})
    expect(mcpHasEntries(state)).toBe(false)
    expect(lspHasEntries(state)).toBe(false)
  })

  it('reports a hub with entries as holding them', () => {
    expect(mcpHasEntries(hubState({ mcp: MCP }))).toBe(true)
    expect(lspHasEntries(hubState({ lsp: LSP }))).toBe(true)
  })

  // The verdict is about the entries the snapshot carries, not about whether
  // the snapshot arrived: a hub whose GET failed holds nothing, and the panel
  // beside it is unaffected either way.
  it('is a per-hub answer, never a shared one', () => {
    const state = hubState({ mcp: MCP, lspLoaded: false })
    expect(mcpHasEntries(state)).toBe(true)
    expect(lspHasEntries(state)).toBe(false)
  })
})

describe('hubsSummary', () => {
  it('counts switched-on entries per hub', () => {
    const state = hubState({
      mcp: [...MCP, { id: 'playwright', label: 'Playwright', on: false }],
      lsp: LSP,
    })
    expect(hubsSummary(state)).toBe('MCP 1/2 · LSP 0/1')
  })

  it('omits a hub with nothing to show', () => {
    expect(hubsSummary(hubState({ mcp: MCP }))).toBe('MCP 1/1')
    expect(hubsSummary(hubState({ lsp: LSP }))).toBe('LSP 0/1')
  })

  it('is empty when neither hub is present', () => {
    expect(hubsSummary(hubState({}))).toBe('')
  })

  it('survives an entry missing from the enable map', () => {
    const state = hubState({ mcp: MCP })
    state.mcp.enabled = {}
    expect(hubsSummary(state)).toBe('MCP 0/1')
  })
})
