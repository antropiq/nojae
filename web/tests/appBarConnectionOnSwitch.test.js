import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import AppBar from '../src/components/AppBar.vue'
import { useAppShell } from '../src/composables/useAppShell'
import { useWorkspaceTree } from '../src/composables/useWorkspaceTree'
import { useWorkspaceSession } from '../src/composables/useWorkspaceSession'

// ---------------------------------------------------------------------------
// The connection line under the brand, now a **store-level** answer (§5.4).
//
// The model connection is install-scoped (D11): servers, models and agents live
// in the settings store, so switching workspace changes none of them and the
// bar has nothing to re-read. Since clws-02 the folder is the **tab's** own, so
// "switching workspace" is one tab moving and no other tab noticing. What the
// bar shows is the store-level question — *is
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
const { state: session, setWorkspaceFromField } = useWorkspaceSession()
const tree = useWorkspaceTree()

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

// The workspace read answers with the new root's own blocks. `/api/config`
// answers the *store's* catalogue, which a move does not change (D11).
function stubApi(config = CONFIGURED) {
  const calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
    const key = String(url)
    calls.push([key, options?.method ?? 'GET'])
    if (key.startsWith('/api/config')) return jsonResponse(config)
    if (key.startsWith('/api/workspace')) {
      return jsonResponse({
        workspace: NEW_ROOT,
        default: '/srv/app',
        policy: { state: 'existing', path: `${NEW_ROOT}/.nojae/read-write-policy.json` },
        mcpSettings: { state: 'existing', path: '' },
        lspSettings: { state: 'existing', path: '' },
        lspSettingsTemplate: { state: 'existing', path: '' },
        hubs: {
          mcp: { installed: true, connectors: [] },
          lsp: { installed: true, servers: [] },
        },
      })
    }
    if (key.startsWith('/api/fs/tree')) {
      const path = treePathOf(key)
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

// The tree's own `path` parameter, read off a URL that also carries the tab's
// workspace field (clws-02) — so the stub never spells the field itself.
function treePathOf(key) {
  const search = new URLSearchParams(key.slice(key.indexOf('?') + 1))
  return search.get('path') ?? ''
}

function resetState() {
  state.config = CONFIGURED
  state.storeState = CONFIGURED.store
  state.configError = null
  // The move's own shape: the field holds what was typed, `workspace` what the
  // server applied. Set is enabled — and the request is made — only while the
  // two differ.
  session.field = NEW_ROOT
  session.workspace = OLD_ROOT
  session.saving = false
  session.error = null
  session.policyNote = null
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
  // tab moving to another folder re-reads nothing and the bar's line does not
  // move.
  it('a workspace switch does not re-read the connection', async () => {
    const calls = stubApi()
    const wrapper = mount(AppBar)
    const before = calls.filter(([url]) => url.startsWith('/api/config')).length

    await setWorkspaceFromField()
    await wrapper.vm.$nextTick()

    expect(
      calls.filter(([url]) => url.startsWith('/api/config')).length,
    ).toBe(before)
    expect(state.config).toEqual(CONFIGURED)
    wrapper.unmount()
  })

  // A refused move changes nothing at all — not the folder, and not the bar's
  // line. The refusal is the server's sentence, shown where the gesture was
  // made (spec §5.2 rule 12: a refusal is an answer, never a substitution).
  it('a refused switch leaves the line alone', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const key = String(url)
      if (key.startsWith('/api/config')) return jsonResponse(EMPTY_STORE)
      if (key.startsWith('/api/workspace')) {
        return jsonResponse(
          { detail: 'Working location is not an existing directory: /srv/nope' },
          false,
          422,
        )
      }
      return jsonResponse({})
    })
    state.config = EMPTY_STORE
    state.storeState = EMPTY_STORE.store

    const wrapper = mount(AppBar)
    await setWorkspaceFromField()
    await wrapper.vm.$nextTick()

    expect(brandLines(wrapper)).toEqual(['no model configured'])
    // The tab stayed where it was, and said why in the field's own line.
    expect(session.workspace).toBe(OLD_ROOT)
    expect(session.error).toBe('Working location is not an existing directory: /srv/nope')
    wrapper.unmount()
  })
})
