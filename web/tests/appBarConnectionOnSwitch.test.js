import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import AppBar from '../src/components/AppBar.vue'
import { useAppShell } from '../src/composables/useAppShell'
import { useWorkspaceTree } from '../src/composables/useWorkspaceTree'

// ---------------------------------------------------------------------------
// The connection line under the brand, now a **store-level** answer (§5.4).
//
// The model connection is install-scoped (D11): servers, models and agents live
// in the settings store, so switching workspace changes none of them and the
// bar has nothing to re-read. What it shows is the store-level question — *is
// the store usable, and does it hold at least one model?* — and the sentence is
// the server's, shown verbatim.
//
// Whether *this* turn can run is deliberately left to the composer: that is
// where the agent is chosen and where the fix is one click away. One warning in
// two places would mean two sentences to keep in step.
//
// Asserted over a mounted AppBar rather than only on the composable, because the
// subject is the rendered line.
// ---------------------------------------------------------------------------

const OLD_ROOT = '/w/oldproj'
const NEW_ROOT = '/w/newproj'

// A configured install: one model, so the bar says **nothing** — the model a
// turn runs on is the composer's answer and is named there.
const CONFIGURED = {
  models: [{ id: 1, name: 'llama-3.1-8b', contextWindow: 8192 }],
  store: { usable: true, sentence: null },
}

// An install with no model at all: the bar's one line.
const EMPTY_STORE = {
  models: [],
  store: { usable: true, sentence: null },
}

// An unusable store: the server's own sentence, naming the path.
const UNUSABLE_STORE = {
  models: [],
  store: {
    usable: false,
    sentence: "nojae's settings store at /srv/nojae.db cannot be read.",
  },
}

const { state } = useAppShell()
const tree = useWorkspaceTree()

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

// The switch answers with the new root's own blocks. `/api/config` answers the
// *store's* catalogue, which a switch does not change (D11).
function stubApi(config = CONFIGURED) {
  const calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
    const key = String(url)
    calls.push([key, options?.method ?? 'GET'])
    if (key.startsWith('/api/config')) return jsonResponse(config)
    if (key.startsWith('/api/path-location')) {
      return jsonResponse({
        path: NEW_ROOT,
        policy: { state: 'existing', path: `${NEW_ROOT}/.nojae/read-write-policy.json` },
        agentModes: { state: 'existing', path: '' },
        mcp: { installed: true, connectors: [] },
        lsp: { installed: true, servers: [] },
      })
    }
    if (key.startsWith('/api/fs/tree')) {
      const path = decodeURIComponent(key.slice('/api/fs/tree?path='.length))
      return jsonResponse({
        path,
        workspace: NEW_ROOT,
        entries: [],
        truncated: false,
      })
    }
    return jsonResponse({})
  })
  return calls
}

function resetState() {
  state.config = CONFIGURED
  state.storeState = CONFIGURED.store
  state.configError = null
  // The switch's own shape: the field holds what was typed, `pathLocationCurrent`
  // what the server applied. Set is enabled -- and the request is made -- only
  // while the two differ, so a test that gives them the same value asserts a
  // call that `setPathLocation` refuses to make.
  state.pathLocation = NEW_ROOT
  state.pathLocationCurrent = OLD_ROOT
  state.pathLocationSaving = false
  state.pathLocationError = null
  state.pathLocationPolicyNote = null
  state.activeTab = 'chat'
  tree.state.nodes = {}
  tree.state.workspace = OLD_ROOT
}

function brandLines(wrapper) {
  return wrapper.findAll('.brand-sub').map((node) => node.text())
}

describe('the brand connection line is the store-level answer', () => {
  beforeEach(() => {
    resetState()
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  // A configured install renders **no** connection line: the model a turn runs
  // on is the composer's answer, so the bar has nothing to add (§5.4).
  it('a configured store says nothing under the brand', () => {
    stubApi()
    const wrapper = mount(AppBar)

    expect(brandLines(wrapper)).toEqual([])
    wrapper.unmount()
  })

  // The one app-level notice that replaces the three per-workspace file blocks.
  it('an install with no model says so', async () => {
    stubApi(EMPTY_STORE)
    const wrapper = mount(AppBar)

    await useAppShell().loadConfig()
    await wrapper.vm.$nextTick()

    expect(brandLines(wrapper)).toEqual(['no model configured'])
    wrapper.unmount()
  })

  // The sentence is the server's: it names the path, and the bar translates
  // nothing. `loadConfig` answers 422 when the store cannot be read.
  it('an unusable store shows the server sentence verbatim', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const key = String(url)
      if (key.startsWith('/api/config')) {
        return jsonResponse({ detail: UNUSABLE_STORE.store.sentence }, false, 422)
      }
      return jsonResponse({})
    })
    const wrapper = mount(AppBar)

    await useAppShell().loadConfig()
    await wrapper.vm.$nextTick()

    expect(brandLines(wrapper)).toEqual([UNUSABLE_STORE.store.sentence])
    wrapper.unmount()
  })

  // D11's point, as the rendered answer: the store is install-scoped, so a
  // workspace switch re-reads nothing and the bar's line does not move.
  it('a workspace switch does not re-read the connection', async () => {
    const calls = stubApi()
    const wrapper = mount(AppBar)
    const before = calls.filter(([url]) => url.startsWith('/api/config')).length

    await useAppShell().setPathLocation()
    await wrapper.vm.$nextTick()

    expect(
      calls.filter(([url]) => url.startsWith('/api/config')).length,
    ).toBe(before)
    expect(state.config).toEqual(CONFIGURED)
    wrapper.unmount()
  })

  // A refused switch moves nothing at all, and the bar's line is not the
  // switch's business any more.
  it('a refused switch leaves the line alone', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const key = String(url)
      if (key.startsWith('/api/config')) return jsonResponse(EMPTY_STORE)
      if (key.startsWith('/api/path-location')) {
        return jsonResponse(
          { detail: 'Cannot change the working location while a chat reply is streaming' },
          false,
          409,
        )
      }
      return jsonResponse({})
    })
    state.config = EMPTY_STORE
    state.storeState = EMPTY_STORE.store

    const wrapper = mount(AppBar)
    await useAppShell().setPathLocation()
    await wrapper.vm.$nextTick()

    expect(brandLines(wrapper)).toEqual(['no model configured'])
    wrapper.unmount()
  })
})
