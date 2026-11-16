import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppShell } from '../src/composables/useAppShell'

// The LSP section writes one thing: which servers are active. Its save is the
// whole job, so this pins the payload — the ids and nothing else. A
// `maxIterations` in it would be a second writer of a value that left the dialog
// with D9 (it is a per-agent column now, edited in the Agent-modes dialog).

const { state } = useAppShell()

function settings() {
  return {
    serverUrl: '',
    apiKey: '',
    endpoint: '',
    sysprompt: '',
    temp: null, topP: null, topK: null, minP: null, repeatPenalty: null,
    presencePenalty: null, reasoning: '', supportsVision: false,
  }
}

describe('the LSP save writes the activation it owns', () => {
  const SERVERS = [
    { id: 'pyright', label: 'Pyright', active: true, status: 'running' },
    { id: 'vue', label: 'Vue', active: false, status: 'stopped' },
  ]

  beforeEach(() => {
    state.settings = settings()
    state.settingsError = null
    state.lspInstalled = true
    state.lspServers = SERVERS
    state.lspActivated = SERVERS.filter((s) => s.active).map((s) => s.id)
    state.lspSaving = false
    state.lspLoading = false
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // The payload is the ids and nothing else: a `maxIterations` in it would be a
  // second writer of a value this section no longer edits.
  it('saves only the ids', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ installed: true, servers: SERVERS, serversError: null }),
    })

    await useAppShell().saveLsp()

    // The save itself is the first call (the panel refresh that follows is a
    // plain GET); its body is the ids and nothing else.
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/lsp')
    expect(fetchMock.mock.calls[0][1].method).toBe('POST')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ enabled: ['pyright'] })
  })
})
