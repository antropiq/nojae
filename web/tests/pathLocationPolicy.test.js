import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AppBar from '../src/components/AppBar.vue'
import { POLICY_STATES, describePolicy } from '../src/lib/path-location-policy'
import { useAppShell } from '../src/composables/useAppShell'
import { useChat } from '../src/composables/useChat'
import { useBatch } from '../src/composables/useBatch'
import { useWorkspaceTree } from '../src/composables/useWorkspaceTree'

// pol-05, client half: what the working-location payload's `policy` block
// becomes on screen. The two blocks these tests used to carry are gone with
// their files — `promptHelpers` (appdb-07) and `agentModes` (appdb-11) — because
// the bullets and the agents are rows of the install's settings store, so a
// workspace has nothing to report about either.
//
// The surface that renders this is the app bar's working-location field, which
// is what the switch is made from; the settings dialog has no part in it.
//
// The rule this pins is the *tone*, not the text: a switch that could not leave
// a file behind **succeeded**, so it must not be reported as
// `pathLocationError` (the dialog renders that as a refusal and the location
// really did move). It goes to a separate note. And GET never seeds — the
// server's read half reports `absent` without writing into a browsed project —
// so the client has to carry that state rather than invent one.

const { state, loadPathLocation, setPathLocation } = useAppShell()

function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

const treePayload = { path: '', workspace: '/srv/proj', entries: [], truncated: false }

function stub({ postPolicy, getPolicy }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
    const key = String(url)
    if (key === '/api/path-location' && options?.method === 'POST') {
      return jsonResponse({
        key: 'NOJAE_PATH_LOCATION',
        path: '/srv/proj',
        default: '/srv/app',
        mcp: { installed: true, connectors: [], externalsError: null },
        lsp: { installed: true, servers: [], serversError: null },
        policy: postPolicy,
      })
    }
    if (key.startsWith('/api/path-location')) {
      return jsonResponse({
        key: 'NOJAE_PATH_LOCATION',
        path: '/srv/proj',
        default: '/srv/app',
        policy: getPolicy,
      })
    }
    if (key.startsWith('/api/fs/')) return jsonResponse(treePayload)
    return jsonResponse({})
  })
}

function reset() {
  state.pathLocation = '/srv/proj'
  state.pathLocationCurrent = '/srv/old'
  state.pathLocationError = null
  state.pathLocationPolicy = null
  state.pathLocationPolicyNote = null
  state.pathLocationSaving = false
  const tree = useWorkspaceTree()
  tree.state.nodes = {}
  tree.state.expanded = { '': true }
}

describe('a switch carries the seed result', () => {
  beforeEach(() => {
    reset()
    vi.restoreAllMocks()
  })

  it('says nothing alarming when the policy file was created', async () => {
    stub({ postPolicy: { state: 'created', path: '/srv/proj/.nojae/read-write-policy.json', error: null } })
    await setPathLocation()

    expect(state.pathLocationPolicy.state).toBe('created')
    expect(state.pathLocationPolicyNote).toBeNull()
    expect(state.pathLocationError).toBeNull()
  })

  it('reports a failed seed as a note, never as a failed switch', async () => {
    stub({
      postPolicy: {
        state: 'failed',
        path: '/srv/proj/.nojae/read-write-policy.json',
        error: 'Read-only file system',
      },
    })
    await setPathLocation()

    // The location moved and the tree re-rooted; only the note says the file
    // could not be written.
    expect(state.pathLocationCurrent).toBe('/srv/proj')
    expect(state.pathLocationError).toBeNull()
    expect(state.pathLocationPolicyNote).toContain('could not create its policy file')
    expect(state.pathLocationPolicyNote).toContain('Read-only file system')
    expect(state.pathLocationPolicyNote).toContain('/srv/proj/.nojae/read-write-policy.json')
  })

  it('clears a stale note on the next attempt', async () => {
    stub({ postPolicy: { state: 'failed', path: '/x', error: 'nope' } })
    await setPathLocation()
    expect(state.pathLocationPolicyNote).not.toBeNull()

    state.pathLocationCurrent = '/srv/old'
    stub({ postPolicy: { state: 'created', path: '/x', error: null } })
    await setPathLocation()
    expect(state.pathLocationPolicyNote).toBeNull()
  })

  it('keeps whatever the server reported on a read', async () => {
    stub({ getPolicy: { state: 'absent', path: '/srv/proj/.nojae/read-write-policy.json', error: null } })
    await loadPathLocation()

    expect(state.pathLocationPolicy.state).toBe('absent')
    // `absent` is not an error and not a note — the dialog words it plainly.
    expect(state.pathLocationPolicyNote).toBeNull()
    expect(state.pathLocationError).toBeNull()
  })

  it('survives a payload with no policy block at all', async () => {
    stub({ getPolicy: undefined })
    await loadPathLocation()
    expect(state.pathLocationPolicy).toBeNull()
    expect(state.pathLocationPolicyNote).toBeNull()
  })
})

// appdb-11 deleted the agent-modes block these cases described: the agents are
// rows of the install's settings store now, so a working location has no modes
// file to seed and nothing to report about one (§4.7). What survives is the
// policy block's own rule, and the bar's "one line" promise — carried by the
// `policy` cases above and the surface cases below.

// appdb-07 deleted the third block these tests described: the prompt helpers are
// rows of the settings store now, so a working location has no helper file to
// seed and nothing to report about one (D11). What survives here is the part that
// was never about the helpers — the app bar renders one line, and only one, from
// whatever the switch had to say.
describe('the app bar says one thing about a switch', () => {
  beforeEach(() => {
    reset()
    vi.restoreAllMocks()
  })

  it('shows a seed warning under the app bar field, not a refusal', async () => {
    // Read through the mounted bar: the point is that the one surface holding
    // the field is also the one that answers the switch, and that a seed that
    // did not land is the warn line — the red one belongs to a refusal alone.
    state.pathLocationPolicy = {
      state: 'failed',
      path: '/srv/proj/.nojae/read-write-policy.json',
      error: 'Read-only file system',
    }
    state.pathLocationPolicyNote = describePolicy(state.pathLocationPolicy).text
    state.pathLocationError = null

    const wrapper = mount(AppBar)
    const notes = wrapper.findAll('.appbar-location-note')
    expect(notes).toHaveLength(1)
    expect(notes[0].classes()).not.toContain('appbar-location-note--error')
    expect(notes[0].text()).toContain('Read-only file system')
    wrapper.unmount()
  })

  it('shows a refusal as the error line, ahead of any seed note', async () => {
    state.pathLocationError = 'Working location does not exist: /nope'
    state.pathLocationPolicyNote = 'Working location is set, but ...'

    const wrapper = mount(AppBar)
    const notes = wrapper.findAll('.appbar-location-note')
    expect(notes).toHaveLength(1)
    expect(notes[0].classes()).toContain('appbar-location-note--error')
    expect(notes[0].text()).toContain('/nope')
    wrapper.unmount()
  })

  it('leaves the line out when the switch had nothing to say', async () => {
    const wrapper = mount(AppBar)
    expect(wrapper.findAll('.appbar-location-note')).toHaveLength(0)
    wrapper.unmount()
  })
})

// The Set button is the one gesture that moves the root, so it is inert
// whenever a session is live: the route answers 409 to a switch during a reply,
// and a batch would find its lot folder re-rooted mid-task.
describe('Set is inert while a session runs', () => {
  beforeEach(() => {
    reset()
    vi.restoreAllMocks()
  })

  function setButton(wrapper) {
    return wrapper.find('.appbar-location-set')
  }

  it('is enabled when nothing runs and the field differs', async () => {
    const wrapper = mount(AppBar)
    const button = setButton(wrapper)
    expect(button.attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it.each([
    ['a chat reply', () => (useChat().state.phase = 'answering')],
    ['a batch', () => (useBatch().state.active = true)],
  ])('is inert during %s, and says why', async (_label, arm) => {
    arm()
    const wrapper = mount(AppBar)
    const button = setButton(wrapper)
    expect(button.attributes('disabled')).toBeDefined()
    expect(button.attributes('title')).toContain('while a session is running')
    wrapper.unmount()
    useChat().state.phase = 'idle'
    useBatch().state.active = false
  })

  it('refuses Enter in the field while a session runs', async () => {
    const fetchSpy = stub({ postPolicy: { state: 'created', path: '/x', error: null } })
    useChat().state.phase = 'answering'
    const wrapper = mount(AppBar)
    await wrapper.find('.appbar-location-input').trigger('keydown.enter')
    const calls = fetchSpy.mock.calls.map(([url]) => String(url))
    expect(calls.some((url) => url === '/api/path-location')).toBe(false)
    useChat().state.phase = 'idle'
    wrapper.unmount()
  })

  it('applies the field on Enter when nothing runs', async () => {
    const fetchSpy = stub({ postPolicy: { state: 'created', path: '/x', error: null } })
    const wrapper = mount(AppBar)
    await wrapper.find('.appbar-location-input').trigger('keydown.enter')
    const posts = fetchSpy.mock.calls.filter(
      ([url, options]) => String(url) === '/api/path-location' && options?.method === 'POST',
    )
    expect(posts).toHaveLength(1)
    wrapper.unmount()
  })
})

// The app bar's two remaining session indicators, pinned here because this is
// the file that mounts AppBar: the settings button is the other control locked
// against a live session (it reloads the model connection a reply is using), so
// it reads the same two states Set does — never a third busy flag.
// And the pill has nothing left to defer to: batch, then the reply's phase,
// then idle.
describe('the app bar reads only the WorkBench reply and the batch lot', () => {
  beforeEach(() => {
    reset()
    vi.restoreAllMocks()
  })

  it('keeps the settings button inert during a reply or a lot, and only those', async () => {
    const settings = (wrapper) => wrapper.find('.appbar-settings')

    const idle = mount(AppBar)
    expect(settings(idle).attributes('disabled')).toBeUndefined()
    idle.unmount()

    useChat().state.phase = 'answering'
    const busy = mount(AppBar)
    expect(settings(busy).attributes('disabled')).toBeDefined()
    busy.unmount()
    useChat().state.phase = 'idle'

    useBatch().state.active = true
    const lot = mount(AppBar)
    expect(settings(lot).attributes('disabled')).toBeDefined()
    lot.unmount()
    useBatch().state.active = false
  })

  it('the status pill reads batch, then the reply, then idle', async () => {
    const pill = (wrapper) => wrapper.find('.status-pill')
    const idle = mount(AppBar)
    expect(pill(idle).text()).toBe('idle')
    idle.unmount()

    useChat().state.phase = 'reasoning'
    const thinking = mount(AppBar)
    expect(pill(thinking).text()).toBe('reasoning...')
    expect(pill(thinking).attributes('class')).toContain('status-reasoning')
    thinking.unmount()
    useChat().state.phase = 'idle'

    useBatch().state.active = true
    const lot = mount(AppBar)
    expect(pill(lot).text()).toBe('Batch')
    lot.unmount()
    useBatch().state.active = false
  })
})
