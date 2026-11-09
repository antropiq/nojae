import { afterEach, describe, expect, it, vi } from 'vitest'

import { describeTransportError, fetchWithRetry } from '../src/lib/api-fetch'

// The transport retry every read-only settings loader now goes through. A Wi-Fi
// blip surfaces as `TypeError: Error in input stream` from the browser network
// stack; one extra attempt makes it invisible, and a request that never recovers
// must still produce the friendly sentence rather than the raw TypeError.
//
// A no-op sleep is injected so the backoff never waits real time in tests, and a
// counter records the delays so the exponential shape is asserted too.

const neverSleep = () => Promise.resolve()

describe('fetchWithRetry', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the response on the first success without sleeping', async () => {
    const ok = { ok: true, status: 200 }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok)
    const sleepMock = vi.fn(neverSleep)

    const res = await fetchWithRetry('/api/config', {}, { sleepFn: sleepMock })

    expect(res).toBe(ok)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sleepMock).not.toHaveBeenCalled()
  })

  it('retries a dropped connection and returns the later success', async () => {
    const ok = { ok: true, status: 200 }
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('Error in input stream'))
      .mockResolvedValueOnce(ok)
    const sleepMock = vi.fn(neverSleep)

    const res = await fetchWithRetry('/api/lsp', {}, { sleepFn: sleepMock })

    expect(res).toBe(ok)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // One backoff between the two attempts, doubling per extra round.
    expect(sleepMock).toHaveBeenCalledTimes(1)
    expect(sleepMock).toHaveBeenCalledWith(300)
  })

  it('keeps the raw error but throws after exhausting the retries', async () => {
    const boom = new TypeError('Error in input stream')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(boom)
    const sleepMock = vi.fn(neverSleep)

    await expect(
      fetchWithRetry('/api/mcp', {}, { retries: 2, baseDelayMs: 100, sleepFn: sleepMock }),
    ).rejects.toBe(boom)

    // initial attempt + 2 retries, with a delay after each of the first two.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(sleepMock.mock.calls.map((call) => call[0])).toEqual([100, 200])
  })

  it('does NOT retry an HTTP error — it reached the server, which answered', async () => {
    // A 422 is a real answer, not a dropped connection: retrying it would only
    // delay the validation message the loader renders from `!res.ok`.
    const notOk = { ok: false, status: 422 }
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(notOk)
    const sleepMock = vi.fn(neverSleep)

    const res = await fetchWithRetry('/api/models?serverUrl=x', {}, { sleepFn: sleepMock })

    expect(res).toBe(notOk)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sleepMock).not.toHaveBeenCalled()
  })

  it('honours retries: 0 (no second attempt)', async () => {
    const boom = new TypeError('Failed to fetch')
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(boom)
    const sleepMock = vi.fn(neverSleep)

    await expect(
      fetchWithRetry('/api/config', {}, { retries: 0, sleepFn: sleepMock }),
    ).rejects.toBe(boom)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(sleepMock).not.toHaveBeenCalled()
  })
})

describe('describeTransportError', () => {
  it('names the actionable cause and keeps the raw error for the console', () => {
    const msg = describeTransportError(new TypeError('Error in input stream'))
    expect(msg).toContain('Network unavailable')
    expect(msg).toContain('could not reach the server')
    // The raw TypeError is preserved, but bracketed — never the leading text.
    expect(msg).toContain('[TypeError: Error in input stream]')
    expect(msg.startsWith('TypeError')).toBe(false)
  })

  it('formats a non-Error throw as a string', () => {
    const msg = describeTransportError('boom')
    expect(msg).toContain('Network unavailable')
    expect(msg).toContain('[boom]')
  })
})
