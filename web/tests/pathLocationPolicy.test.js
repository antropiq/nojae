import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AppBar from '../src/components/AppBar.vue'
import { POLICY_STATES, describePolicy } from '../src/lib/path-location-policy'
import { useChat } from '../src/composables/useChat'
import { useBatch } from '../src/composables/useBatch'
import { useWorkspaceSession } from '../src/composables/useWorkspaceSession'
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
// The rule this pins is the *tone*, not the text: a move that could not leave a
// file behind **succeeded**, so it must not be reported as the session's
// `error` (the bar renders that as a refusal and the folder really did move).
// It goes to a separate note. And `GET /api/workspace` never seeds — the read
// reports `absent` without writing into a browsed project — so the client has to
// carry that state rather than invent one.

const { state: sessionState, loadWorkspace, setWorkspaceFromField } =
  useWorkspaceSession()

function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

const treePayload = { path: '', workspace: '/srv/proj', entries: [], truncated: false }

// One route now answers both halves of the old pair: `GET /api/workspace`,
// asked **about the folder that was typed** (the field rides on the URL, spelled
// only by `withWorkspace`). `policy` is the block the read reports.
function stub({ policy, status = 200, detail = null }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    const key = String(url)
    if (key.startsWith('/api/workspace')) {
      if (status !== 200) {
        return Promise.resolve({
          ok: false,
          status,
          json: () => Promise.resolve({ detail }),
        })
      }
      return jsonResponse({
        workspace: '/srv/proj',
        default: '/srv/app',
        policy,
        mcpSettings: { state: 'existing', path: '' },
        lspSettings: { state: 'existing', path: '' },
        lspSettingsTemplate: { state: 'existing', path: '' },
        hubs: {
          mcp: { installed: true, connectors: [], externalsError: null },
          lsp: { installed: true, servers: [], serversError: null },
        },
      })
    }
    if (key.startsWith('/api/fs/')) return jsonResponse(treePayload)
    return jsonResponse({})
  })
}

function reset() {
  sessionState.workspace = '/srv/old'
  sessionState.field = '/srv/proj'
  sessionState.error = null
  sessionState.policy = null
  sessionState.policyNote = null
  sessionState.saving = false
  const tree = useWorkspaceTree()
  tree.state.nodes = {}
  tree.state.expanded = { '': true }
}

describe('a move carries the policy report', () => {
  beforeEach(() => {
    reset()
    vi.restoreAllMocks()
  })

  it('says nothing alarming when the policy file was created', async () => {
    stub({ policy: { state: 'created', path: '/srv/proj/.nojae/read-write-policy.json', error: null } })
    await setWorkspaceFromField()

    expect(sessionState.policy.state).toBe('created')
    expect(sessionState.policyNote).toBeNull()
    expect(sessionState.error).toBeNull()
  })

  it('reports a failed seed as a note, never as a failed move', async () => {
    stub({
      policy: {
        state: 'failed',
        path: '/srv/proj/.nojae/read-write-policy.json',
        error: 'Read-only file system',
      },
    })
    await setWorkspaceFromField()

    // The tab moved and the tree re-rooted; only the note says the file
    // could not be written.
    expect(sessionState.workspace).toBe('/srv/proj')
    expect(sessionState.error).toBeNull()
    expect(sessionState.policyNote).toContain('could not create its policy file')
    expect(sessionState.policyNote).toContain('Read-only file system')
    expect(sessionState.policyNote).toContain('/srv/proj/.nojae/read-write-policy.json')
  })

  it('clears a stale note on the next attempt', async () => {
    stub({ policy: { state: 'failed', path: '/x', error: 'nope' } })
    await setWorkspaceFromField()
    expect(sessionState.policyNote).not.toBeNull()

    sessionState.workspace = '/srv/old'
    sessionState.field = '/srv/proj'
    stub({ policy: { state: 'created', path: '/x', error: null } })
    await setWorkspaceFromField()
    expect(sessionState.policyNote).toBeNull()
  })

  it('keeps whatever the server reported on a read', async () => {
    stub({ policy: { state: 'absent', path: '/srv/proj/.nojae/read-write-policy.json', error: null } })
    sessionState.workspace = ''
    sessionState.field = ''
    await loadWorkspace()

    expect(sessionState.policy.state).toBe('absent')
    // `absent` is not an error and not a note — the bar words it plainly.
    expect(sessionState.policyNote).toBeNull()
    expect(sessionState.error).toBeNull()
  })

  it('survives a payload with no policy block at all', async () => {
    stub({ policy: undefined })
    sessionState.workspace = ''
    sessionState.field = ''
    await loadWorkspace()
    expect(sessionState.policy).toBeNull()
    expect(sessionState.policyNote).toBeNull()
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
    // the field is also the one that answers the move, and that a seed that
    // did not land is the warn line — the red one belongs to a refusal alone.
    sessionState.policy = {
      state: 'failed',
      path: '/srv/proj/.nojae/read-write-policy.json',
      error: 'Read-only file system',
    }
    sessionState.policyNote = describePolicy(sessionState.policy).text
    sessionState.error = null

    const wrapper = mount(AppBar)
    const notes = wrapper.findAll('.appbar-location-note')
    expect(notes).toHaveLength(1)
    expect(notes[0].classes()).not.toContain('appbar-location-note--error')
    expect(notes[0].text()).toContain('Read-only file system')
    wrapper.unmount()
  })

  it('shows a refusal as the error line, ahead of any seed note', async () => {
    sessionState.error = 'Working location does not exist: /nope'
    sessionState.policyNote = 'Working location is set, but ...'

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
    const fetchSpy = stub({ policy: { state: 'created', path: '/x', error: null } })
    useChat().state.phase = 'answering'
    const wrapper = mount(AppBar)
    await wrapper.find('.appbar-location-input').trigger('keydown.enter')
    const calls = fetchSpy.mock.calls.map(([url]) => String(url))
    expect(calls.some((url) => url.startsWith('/api/workspace'))).toBe(false)
    useChat().state.phase = 'idle'
    wrapper.unmount()
  })

  // The move is a **read** of the folder that was typed, carrying it as the
  // workspace field — the old POST that set process state is gone (clws-02).
  it('applies the field on Enter when nothing runs', async () => {
    const fetchSpy = stub({ policy: { state: 'created', path: '/x', error: null } })
    const wrapper = mount(AppBar)
    await wrapper.find('.appbar-location-input').trigger('keydown.enter')
    const reads = fetchSpy.mock.calls.filter(
      ([url, options]) =>
        String(url).startsWith('/api/workspace?') &&
        String(url).includes('workspace=') &&
        options?.method === undefined,
    )
    expect(reads).toHaveLength(1)
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
