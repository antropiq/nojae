import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

import {
  inferenceRunning,
  PHASES_IN_FLIGHT,
} from '../src/lib/inference-state'
import { useBatch } from '../src/composables/useBatch'
import { useChat } from '../src/composables/useChat'
import { playSessionEnded, useSessionSound } from '../src/composables/useSessionSound'

// Layer 1 (jsdom): when the end-of-session chime rings. The rule itself is the
// busy -> idle edge of `inferenceRunning()` — the same predicate the ⚡/✨ tab
// glyph uses — so both are asserted here instead of in a browser: the only
// browser-specific part (the autoplay gate) cannot be reproduced in jsdom.

// jsdom implements no media playback, so Audio is replaced with a recorder:
// the assertion is about *whether and how often* play() is reached, not about
// sound coming out of a speaker.
const played = []

class FakeAudio {
  constructor(src) {
    this.src = src
    this.volume = 1
    this.preload = 'none'
    this.muted = false
    this.currentTime = 0
  }
  play() {
    played.push({ src: this.src, muted: this.muted, volume: this.volume })
    return Promise.resolve()
  }
  pause() {}
}

vi.stubGlobal('Audio', FakeAudio)

const chat = useChat().state
const batch = useBatch().state
const sound = useSessionSound()

function reset() {
  chat.phase = 'idle'
  batch.active = false
  sound.state.enabled = true
  played.length = 0
}

async function settle() {
  await nextTick()
  await nextTick()
}

describe('inferenceRunning: one predicate, two indicators', () => {
  it('is idle only when no lot and no reply is in flight', () => {
    expect(
      inferenceRunning({ chat: { phase: 'idle' }, batch: { active: false } }),
    ).toBe(false)
  })

  it('stays busy across a batch turn gap', () => {
    expect(
      inferenceRunning({ chat: { phase: 'idle' }, batch: { active: true } }),
    ).toBe(true)
  })

  // The wait on a refused endpoint is a busy phase too (spec §5.12): the turn is
  // still in flight, so the glyph keeps ⚡ and the chime stays silent. Derived
  // from the exported list, so the case cannot go stale when a phase is added.
  it('stays busy for every phase the composable calls in flight', () => {
    for (const phase of PHASES_IN_FLIGHT) {
      expect(
        inferenceRunning({ chat: { phase }, batch: { active: false } }),
      ).toBe(true)
    }
  })

  // The list is not "any phase at all": 'idle' stays outside it, so the chime
  // still has an edge to ring on.
  it('is idle for a phase the list does not name', () => {
    expect(PHASES_IN_FLIGHT).not.toContain('idle')
    expect(
      inferenceRunning({ chat: { phase: 'idle' }, batch: { active: false } }),
    ).toBe(false)
  })
})

describe('useSessionSound: rings on the busy -> idle edge only', () => {
  beforeEach(reset)

  it('chimes when a streamed reply ends', async () => {
    chat.phase = 'answering'
    await settle()
    expect(played).toHaveLength(0)

    chat.phase = 'idle'
    await settle()
    expect(played).toHaveLength(1)
    expect(played[0].muted).toBe(false)
    expect(played[0].src).toContain('session_ended')
  })

  it('does not chime between two batch task turns', async () => {
    batch.active = true
    chat.phase = 'answering'
    await settle()
    chat.phase = 'idle' // task N done, another owed
    await settle()
    expect(played).toHaveLength(0)

    batch.active = false // lot over
    await settle()
    expect(played).toHaveLength(1)
  })

  // A wait on a refused endpoint must not read as the end of a reply: the phase
  // moves from `answering` to `reconnecting` mid-turn, and that step crosses no
  // busy -> idle edge. Getting this wrong is what spec §5.12 calls the feature's
  // most likely bug — the chime ringing, and the tab glyph going to ✨, while the
  // composer is still locked.
  it('does not chime while a reply waits on a refused endpoint', async () => {
    chat.phase = 'answering'
    await settle()
    chat.phase = 'reconnecting'
    await settle()
    expect(played).toHaveLength(0)

    chat.phase = 'answering' // the replayed round answered
    await settle()
    expect(played).toHaveLength(0)
  })

  it('stays silent while muted', async () => {
    sound.toggle()
    expect(sound.state.enabled).toBe(false)
    played.length = 0

    chat.phase = 'answering'
    await settle()
    chat.phase = 'idle'
    await settle()
    expect(played).toHaveLength(0)
  })

  it('is silent on boot: no chime without a preceding inference', async () => {
    await settle()
    expect(played).toHaveLength(0)
    playSessionEnded()
    expect(played).toHaveLength(1)
  })
})
