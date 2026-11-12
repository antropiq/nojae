import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import AppBar from '../src/components/AppBar.vue'
import { useAppShell } from '../src/composables/useAppShell'
import { useWorkspaceTree } from '../src/composables/useWorkspaceTree'

// ---------------------------------------------------------------------------
// The connection line under the brand, across a working-location switch.
//
// The bug this suite exists for: switching workspace moved the tree, both hub
// panels, the agent modes and the memory bullets to the new root, but the bar
// kept naming the models and the server URL of the workspace that was just
// left. Those two lines come from `state.config` -- the `GET /api/config`
// payload -- and nothing reloaded it on a switch: `loadConfig()` ran at boot,
// after a settings save and on chat-tab re-entry, so the bar only caught up on
// the next tab click.
//
// The model connection is *workspace* state (`.nojae/nojae-settings.json` in
// the active root), so the read has to follow the root like everything else
// the switch reloads. Asserted here over a mounted AppBar rather than only on
// the composable, because the reported symptom is the rendered line.
// ---------------------------------------------------------------------------

const OLD_ROOT = '/w/oldproj'
const NEW_ROOT = '/w/newproj'

const OLD_CONFIG = {
  models: ['llama-3.1-8b'],
  serverUrl: 'http://old-host:8000/v1',
  supportsVision: false,
  contextWindow: 8192,
}
const NEW_CONFIG = {
  models: ['qwen2.5-coder', 'gpt-4o-mini'],
  serverUrl: 'http://new-host:9000/v1',
  supportsVision: true,
  contextWindow: 32768,
}

const { state } = useAppShell()
const tree = useWorkspaceTree()

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

// The switch answers with the new root's own blocks; `/api/config` answers with
// the new root's connection, which is the whole point of the assertion.
function stubApi() {
  const calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
    const key = String(url)
    calls.push([key, options?.method ?? 'GET'])
    if (key.startsWith('/api/config')) {
      return jsonResponse(NEW_CONFIG)
    }
    if (key.startsWith('/api/path-location')) {
      return jsonResponse({
        path: NEW_ROOT,
        policy: { state: 'existing', path: `${NEW_ROOT}/.nojae/read-write-policy.json` },
        agentModes: { state: 'existing', path: '' },
        promptHelpers: { state: 'existing', path: '' },
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
  state.config = OLD_CONFIG
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
  state.pathLocationAgentModesNote = null
  state.pathLocationPromptHelpersNote = null
  state.activeTab = 'chat'
  tree.state.nodes = {}
  tree.state.workspace = OLD_ROOT
}

function brandLines(wrapper) {
  return wrapper.findAll('.brand-sub').map((node) => node.text())
}

describe('the brand connection line follows the working location', () => {
  beforeEach(() => {
    resetState()
    vi.restoreAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('names the new workspace models and server once the switch landed', async () => {
    stubApi()
    const wrapper = mount(AppBar)
    expect(brandLines(wrapper)).toEqual([
      'llama-3.1-8b',
      'on http://old-host:8000/v1',
    ])

    await useAppShell().setPathLocation()
    await wrapper.vm.$nextTick()

    // `waitFor`, not one `nextTick`: the connection is a *second* request the
    // switch fires, so its answer lands on a later microtask than the switch's
    // own completion. What is asserted is that the bar ends up naming the new
    // workspace, which is the reported symptom.
    await vi.waitFor(() =>
      expect(brandLines(wrapper)).toEqual([
        'qwen2.5-coder · gpt-4o-mini',
        'on http://new-host:9000/v1',
      ]),
    )
    wrapper.unmount()
  })

  // The reload is a *re-read*, not the switch payload: `/api/config` is the one
  // route that builds the config the way a chat call will, so the bar must show
  // what that read answered rather than a guess made from the switch's blocks.
  it('re-reads /api/config as part of the switch', async () => {
    const calls = stubApi()
    const wrapper = mount(AppBar)

    await useAppShell().setPathLocation()
    await wrapper.vm.$nextTick()

    expect(calls).toContainEqual(['/api/config', 'GET'])
    await vi.waitFor(() => expect(state.config).toEqual(NEW_CONFIG))
    wrapper.unmount()
  })

  // The other half of the bug: a workspace whose model-connection file is still
  // the seeded template answers 422, and the previous root's models must not
  // stay on screen as if they were the new root's. The bar then draws nothing
  // rather than a lie.
  it('an unconfigured new workspace shows the old connection no more', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      const key = String(url)
      if (key.startsWith('/api/config')) {
        return jsonResponse(
          { detail: `${NEW_ROOT}/.nojae/nojae-settings.json is not configured` },
          false,
          422,
        )
      }
      if (key.startsWith('/api/path-location')) {
        return jsonResponse({
          path: NEW_ROOT,
          policy: { state: 'existing', path: '' },
          agentModes: { state: 'existing', path: '' },
          promptHelpers: { state: 'existing', path: '' },
          mcp: { installed: true, connectors: [] },
          lsp: { installed: true, servers: [] },
        })
      }
      if (key.startsWith('/api/fs/tree')) {
        return jsonResponse({ path: '', workspace: NEW_ROOT, entries: [], truncated: false })
      }
      return jsonResponse({}, options?.method !== 'POST')
    })

    const wrapper = mount(AppBar)
    expect(brandLines(wrapper)).toHaveLength(2)

    await useAppShell().setPathLocation()
    await wrapper.vm.$nextTick()

    await vi.waitFor(() => {
      expect(state.config).toBeNull()
      expect(brandLines(wrapper)).toEqual([])
    })
    wrapper.unmount()
  })

  // A refused switch moves nothing, so the bar must keep what it had: the
  // reload belongs to the applied location, not to the attempt.
  it('a refused switch leaves the connection line alone', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const key = String(url)
      if (key.startsWith('/api/config')) return jsonResponse(OLD_CONFIG)
      if (key.startsWith('/api/path-location')) {
        return jsonResponse(
          { detail: 'Cannot change the working location while a chat reply is streaming' },
          false,
          409,
        )
      }
      return jsonResponse({})
    })

    const wrapper = mount(AppBar)
    await useAppShell().setPathLocation()
    await wrapper.vm.$nextTick()

    expect(state.config).toEqual(OLD_CONFIG)
    expect(brandLines(wrapper)).toEqual([
      'llama-3.1-8b',
      'on http://old-host:8000/v1',
    ])
    wrapper.unmount()
  })
})
