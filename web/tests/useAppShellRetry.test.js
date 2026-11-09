import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppShell } from '../src/composables/useAppShell'

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
