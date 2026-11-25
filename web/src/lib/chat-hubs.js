// What the two tool hubs hold for this conversation.
//
// Two places read this (each panel's own body, and the tools dock's folded
// summary). Nothing here decides geometry: both panels always render, so the
// Chat left column keeps its two-panel width whatever the declaration files
// hold. A hub with no declared entry is a panel that says so, never one that
// disappears — an unconfigured workspace must not cost the reasoning timeline
// half its column.

export function mcpHasEntries(state) {
  return state.mcp.connectors.length > 0
}

export function lspHasEntries(state) {
  return state.lsp.servers.length > 0
}

// `MCP 2/3 · LSP 1/2`: how many of each hub's tools are switched on, shown
// while the dock is folded (the switches themselves are only in the panels).
export function hubsSummary(state) {
  const parts = []
  for (const [label, hub, entries] of [
    ['MCP', state.mcp, state.mcp.connectors],
    ['LSP', state.lsp, state.lsp.servers],
  ]) {
    if (!entries.length) continue
    const on = entries.filter((entry) => hub.enabled[entry.id]).length
    parts.push(`${label} ${on}/${entries.length}`)
  }
  return parts.join(' · ')
}
