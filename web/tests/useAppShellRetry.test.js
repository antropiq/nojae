import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppShell } from '../src/composables/useAppShell'
import { useWorkspaceSession } from '../src/composables/useWorkspaceSession'

// A read-only loader, seen end to end: the composable must actually go through
// the retry, not just call fetch once and bail on the first dropped packet.
//
// loadConfig is the simplest such loader (it only writes state.config /
// state.configError), so it stands in for all of them. These use the lib's real
// backoff (the loader does not inject a sleep), so they pay ~0.3s / ~0.9s —
// well inside the test timeout, and proof the production path is wired, not just
// the helper in isolation.

const { state } = useAppShell()

function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

describe('loadConfig survives a dropped connection', () => {
  beforeEach(() => {
    state.config = null
    state.configError = null
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('retries the transient failure and stores the config', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Error in input stream'))
      .mockImplementationOnce(() => jsonResponse({ model: 'gpt' }))

    await useAppShell().loadConfig()

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(state.config).toEqual({ model: 'gpt' })
    expect(state.configError).toBeNull()
  })

  it('shows the friendly network sentence, not the raw TypeError', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('Error in input stream'),
    )

    await useAppShell().loadConfig()

    expect(state.configError).toContain('Network unavailable')
    expect(state.configError).not.toMatch(/^Could not reach the API/)
    expect(state.configError).toContain('Error in input stream')
  })
})

describe('opening the settings dialog', () => {
  const { state } = useAppShell()
  const session = useWorkspaceSession()

  beforeEach(() => {
    state.settingsOpen = false
    state.settingsLoading = false
    session.state.loading = false
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('waits for the boot workspace read before asking a workspace-scoped section', async () => {
    session.state.loading = true
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    await useAppShell().openSettings()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(state.settingsOpen).toBe(false)
    session.state.loading = false
  })

  it('awaits its reads, and a reopen does not start a second set', async () => {
    const releases = {}
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(
      (url) =>
        new Promise((resolve) => {
          releases[String(url)] = () =>
            resolve({
              ok: true,
              status: 200,
              json: () => Promise.resolve(
                String(url).startsWith('/api/servers')
                  ? {
                      servers: [],
                      caps: { samplerRanges: {}, reasoningLevels: [] },
                      unassigned: { agentsWithoutModel: 0, agents: 4 },
                    }
                  : String(url).startsWith('/api/config')
                    ? { models: [], store: { usable: true } }
                    : String(url).startsWith('/api/mcp')
                      ? { installed: true, connectors: [] }
                      : { installed: true, servers: [] },
              ),
            })
        }),
    )

    const first = useAppShell().openSettings()
    expect(state.settingsLoading).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(4)

    useAppShell().closeSettings()
    await useAppShell().openSettings()
    expect(state.settingsOpen).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(4)

    for (const release of Object.values(releases)) release()
    await first

    expect(state.settingsLoading).toBe(false)
    expect(state.settingsOpen).toBe(true)
  })
})
