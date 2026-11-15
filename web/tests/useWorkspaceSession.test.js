import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_STORAGE_KEY,
  WORKSPACE_STORAGE_KEY,
  loadWorkspace,
  setWorkspaceFromField,
  useWorkspaceSession,
  withWorkspace,
} from '../src/composables/useWorkspaceSession'

const { state } = useWorkspaceSession()

// ---------------------------------------------------------------------------
// The tab's own memory of its folder (clws-02).
//
// Four promises, and each is a way the feature could silently regress:
//
// * the storage is **`sessionStorage`** — a reload keeps the folder, a new tab
//   does not inherit one, a closed tab forgets it. A `localStorage` here would
//   make the folder browser-wide, which is the exact bug being fixed;
// * **`withWorkspace` is the only speller** of the field's name, and it handles
//   both `?` and `&`;
// * a **refusal is an answer**: the previous folder stays and the server's
//   sentence is shown — never a silent substitution of another folder;
// * the **boot read** takes the stored folder, or the installation folder the
//   server reports as `default`, and a stored folder that no longer resolves is
//   reported and left in place.
//
// The server's own rules (what makes a folder a workspace, the four refusals)
// are asserted in tests/test_api.py and tests/test_workspace_seam.py; nothing
// here re-litigates them, because the client holds no validation rule of its
// own.
// ---------------------------------------------------------------------------

const INSTALL = '/srv/app'

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

function workspacePayload({ workspace = INSTALL, policy = null } = {}) {
  return {
    workspace,
    default: INSTALL,
    policy,
    mcpSettings: { state: 'absent', path: '' },
    lspSettings: { state: 'absent', path: '' },
    lspSettingsTemplate: { state: 'absent', path: '' },
    hubs: { mcp: { installed: true, connectors: [] }, lsp: { installed: true, servers: [] } },
  }
}

// Records every URL the composable asks for, and answers `/api/workspace` with
// `answer` — a payload, or a `[body, status]` pair for a refusal.
function stubWorkspaceRead(answer) {
  const urls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
    urls.push(String(url))
    if (Array.isArray(answer)) return jsonResponse(answer[0], false, answer[1])
    return jsonResponse(answer ?? workspacePayload())
  })
  return urls
}

function reset() {
  state.workspace = ''
  state.field = ''
  state.loading = false
  state.saving = false
  state.error = null
  state.policy = null
  state.policyNote = null
  window.sessionStorage.clear()
  window.localStorage.clear()
}

describe('the tab remembers its folder in sessionStorage', () => {
  beforeEach(() => {
    reset()
    vi.restoreAllMocks()
  })

  it('writes the adopted folder to sessionStorage, never to localStorage', async () => {
    stubWorkspaceRead(workspacePayload({ workspace: '/srv/proj' }))
    state.field = '/srv/proj'

    await setWorkspaceFromField()

    expect(window.sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe('/srv/proj')
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  it('names the two tab keys beside each other', () => {
    // The tab's two pieces of identity, named in one place (clws-08): the folder
    // it works on and the agent it answers as. `useAgentModes` reads and writes
    // the second through this name, so neither can end up in the settings store.
    expect(WORKSPACE_STORAGE_KEY).toBe('nojae:workspace')
    expect(AGENT_STORAGE_KEY).toBe('nojae:agent')
  })

  it('survives storage that throws', async () => {
    stubWorkspaceRead(workspacePayload({ workspace: '/srv/proj' }))
    const spy = vi.spyOn(window.sessionStorage, 'setItem').mockImplementation(() => {
      throw new Error('private mode')
    })
    state.field = '/srv/proj'

    await expect(setWorkspaceFromField()).resolves.toBeTruthy()
    expect(state.workspace).toBe('/srv/proj')
    spy.mockRestore()
  })

  // The storage's tolerance is observable in what the boot read asks for: a
  // value the tab cannot use means **no field on the request**, which is the
  // same answer as a missing key — never a guess of a folder.
  it.each([
    ['a value that is not a string', () => ({ getItem: () => ({ not: 'a string' }) })],
    ['storage that throws on read', () => ({
      getItem: () => {
        throw new Error('storage blocked')
      },
    })],
  ])('treats %s as no remembered workspace', async (_label, brokenStorage) => {
    const urls = stubWorkspaceRead(workspacePayload())
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage')
    Object.defineProperty(window, 'sessionStorage', {
      value: brokenStorage(),
      configurable: true,
    })
    try {
      await loadWorkspace()
    } finally {
      Object.defineProperty(window, 'sessionStorage', original)
    }

    expect(urls).toEqual(['/api/workspace'])
    expect(state.workspace).toBe(INSTALL)
  })
})

describe('withWorkspace: the one spelling of the field', () => {
  beforeEach(() => {
    reset()
    vi.restoreAllMocks()
  })

  it('is the only place web/src writes the field name', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { resolve } = await import('node:path')
    const offenders = []
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const file = resolve(dir, entry.name)
        if (entry.isDirectory()) {
          walk(file)
          continue
        }
        if (!/\.(js|vue)$/.test(entry.name)) continue
        const text = readFileSync(file, 'utf8')
        const hits = text.split('\n').filter((line) => {
          if (!line.includes('workspace=')) return false
          // Prose about the field is not a spelling of it: only a template
          // literal or a string that builds a query counts.
          return /[`'"]&?workspace=/.test(line)
        })
        if (hits.length && !file.endsWith('useWorkspaceSession.js')) {
          offenders.push(`${file}: ${hits[0].trim()}`)
        }
      }
    }
    walk(resolve('src'))
    expect(offenders).toEqual([])
  })

  it('adds ? when the URL has no query, & when it has one', () => {
    state.workspace = '/srv/pro j'
    expect(withWorkspace('/api/fs/tree')).toBe('/api/fs/tree?workspace=%2Fsrv%2Fpro%20j')
    expect(withWorkspace('/api/fs/tree?path=src')).toBe(
      '/api/fs/tree?path=src&workspace=%2Fsrv%2Fpro%20j',
    )
  })

  it('leaves the URL alone while the tab has no folder', () => {
    state.workspace = ''
    expect(withWorkspace('/api/fs/tree?path=src')).toBe('/api/fs/tree?path=src')
  })

  it('carries a folder whose name is not latin-1', () => {
    state.workspace = '/srv/日本語'
    expect(withWorkspace('/api/chat')).toBe(`/api/chat?workspace=${encodeURIComponent('/srv/日本語')}`)
  })

  it('never touches the address bar', async () => {
    const replace = vi.spyOn(window.history, 'replaceState')
    const push = vi.spyOn(window.history, 'pushState')
    stubWorkspaceRead(workspacePayload({ workspace: '/srv/proj' }))
    state.field = '/srv/proj'
    await setWorkspaceFromField()
    await loadWorkspace()

    expect(replace).not.toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
    expect(window.location.search).toBe('')
  })
})

describe('the boot read', () => {
  beforeEach(() => {
    reset()
    vi.restoreAllMocks()
  })

  it('lands a new tab on the folder the server boots on', async () => {
    const urls = stubWorkspaceRead(workspacePayload({ workspace: INSTALL }))

    await loadWorkspace()

    // No stored folder, so no field on the request, and the answer is the
    // installation — which is what a new tab lands on (spec D4).
    expect(urls).toEqual(['/api/workspace'])
    expect(state.workspace).toBe(INSTALL)
    expect(state.field).toBe(INSTALL)
    expect(window.sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(INSTALL)
  })

  it('adopts the folder the read answered about, never another one', async () => {
    // While the interim fallback is on, a request naming no folder is answered
    // about the server's boot folder, which is not necessarily `default`. The
    // value adopted is the one the **policy block belongs to**, so the note
    // under the field can never describe a folder the tab is not on.
    const boot = '/srv/boot-folder'
    stubWorkspaceRead({
      ...workspacePayload({ workspace: boot, policy: { state: 'existing', path: `${boot}/.nojae/read-write-policy.json` } }),
      default: INSTALL,
    })

    await loadWorkspace()

    expect(state.workspace).toBe(boot)
    expect(state.policy.path).toBe(`${boot}/.nojae/read-write-policy.json`)
  })

  it('asks about the stored folder and keeps it', async () => {
    window.sessionStorage.setItem(WORKSPACE_STORAGE_KEY, '/srv/remembered')
    const urls = stubWorkspaceRead(workspacePayload({ workspace: '/srv/remembered' }))

    await loadWorkspace()

    expect(urls).toEqual([`/api/workspace?workspace=${encodeURIComponent('/srv/remembered')}`])
    expect(state.workspace).toBe('/srv/remembered')
    expect(state.error).toBeNull()
  })

  it('reports a stored folder that no longer resolves, and leaves it in place', async () => {
    window.sessionStorage.setItem(WORKSPACE_STORAGE_KEY, '/srv/gone')
    stubWorkspaceRead([{ detail: 'Working location is not an existing directory: /srv/gone' }, 422])

    await loadWorkspace()

    // Spec §6: a remembered folder is convenience, not a guarantee. The tab
    // opens on it and says what the server said; nothing is repaired silently.
    expect(state.workspace).toBe('/srv/gone')
    expect(state.field).toBe('/srv/gone')
    expect(state.error).toBe('Working location is not an existing directory: /srv/gone')
  })

  it('shows the server sentence verbatim', async () => {
    stubWorkspaceRead([{ detail: 'Working location is on the deny-list: /etc' }, 422])

    await loadWorkspace()

    expect(state.error).toBe('Working location is on the deny-list: /etc')
  })

  it('turns a transport failure into the network sentence', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'))

    await loadWorkspace()

    expect(state.error).toContain('could not reach the server')
    expect(state.loading).toBe(false)
  })
})

describe('the one gesture: point this tab at the field', () => {
  beforeEach(() => {
    reset()
    vi.restoreAllMocks()
  })

  it('adopts the server canonicalisation, not what was typed', async () => {
    stubWorkspaceRead(workspacePayload({ workspace: '/srv/proj' }))
    state.workspace = '/srv/old'
    state.field = '/srv/proj/'

    const body = await setWorkspaceFromField()

    expect(state.workspace).toBe('/srv/proj')
    expect(state.field).toBe('/srv/proj')
    expect(body.workspace).toBe('/srv/proj')
    expect(window.sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe('/srv/proj')
  })

  it('asks about the typed folder, not the one the tab holds', async () => {
    const urls = stubWorkspaceRead(workspacePayload({ workspace: '/srv/proj' }))
    state.workspace = '/srv/old'
    state.field = '/srv/proj'

    await setWorkspaceFromField()

    expect(urls).toEqual([`/api/workspace?workspace=${encodeURIComponent('/srv/proj')}`])
  })

  it('keeps the previous folder when the typed one is refused', async () => {
    stubWorkspaceRead(
      [{ detail: 'Working location is not an existing directory: /srv/nope' }, 422],
    )
    state.workspace = '/srv/good'
    state.field = '/srv/nope'

    const body = await setWorkspaceFromField()

    // A refusal is an answer, never a silent substitution (spec §5.2 rule 12):
    // the folder every request is built from did not move, and the typed text
    // is still there to fix.
    expect(body).toBeNull()
    expect(state.workspace).toBe('/srv/good')
    expect(state.field).toBe('/srv/nope')
    expect(state.error).toBe('Working location is not an existing directory: /srv/nope')
    expect(window.sessionStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
  })

  it('makes no request when the field holds the current folder', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    state.workspace = '/srv/proj'
    state.field = '/srv/proj  '

    expect(await setWorkspaceFromField()).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('makes no second request while one is in flight', async () => {
    let release = null
    const pending = new Promise((resolve) => {
      release = resolve
    })
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => pending)
    state.workspace = '/srv/old'
    state.field = '/srv/proj'

    const first = setWorkspaceFromField()
    expect(state.saving).toBe(true)
    const second = await setWorkspaceFromField()
    expect(second).toBeNull()

    release(jsonResponse(workspacePayload({ workspace: '/srv/proj' })))
    await first
    expect(state.workspace).toBe('/srv/proj')
  })

  it('keeps the policy block as a note, never as an error', async () => {
    stubWorkspaceRead(
      workspacePayload({
        workspace: '/srv/proj',
        policy: { state: 'failed', path: '/srv/proj/.nojae/read-write-policy.json', error: 'Read-only file system' },
      }),
    )
    state.field = '/srv/proj'

    await setWorkspaceFromField()

    expect(state.error).toBeNull()
    expect(state.policyNote).toContain('could not create its policy file')
    expect(state.policyNote).toContain('Read-only file system')
  })

  it('clears a stale note on the next attempt', async () => {
    stubWorkspaceRead(
      workspacePayload({
        workspace: '/srv/proj',
        policy: { state: 'failed', path: '/x', error: 'nope' },
      }),
    )
    state.field = '/srv/proj'
    await setWorkspaceFromField()
    expect(state.policyNote).not.toBeNull()

    state.workspace = '/srv/old'
    state.field = '/srv/proj'
    stubWorkspaceRead(
      workspacePayload({ workspace: '/srv/proj', policy: { state: 'created', path: '/x', error: null } }),
    )
    await setWorkspaceFromField()
    expect(state.policyNote).toBeNull()
  })

  it('survives a payload with no policy block at all', async () => {
    stubWorkspaceRead(workspacePayload())
    state.field = '/srv/proj'

    await setWorkspaceFromField()

    expect(state.policy).toBeNull()
    expect(state.policyNote).toBeNull()
  })

  // §5.5 rule 28, from the client's side: moving **this tab** to another folder
  // invalidates nothing that belongs to the installation. The agent list, the
  // model list and the helper bullets are the store's, so the move leaves them
  // byte-identical *and* does not even ask for them again — a re-read would be
  // the app treating a folder as a reason for the catalogue to change.
  it('a folder change leaves the catalogue byte-identical, and unre-read', async () => {
    const { useAgentModes } = await import('../src/composables/useAgentModes')
    const { useAppShell } = await import('../src/composables/useAppShell')
    const { usePromptHelpers } = await import('../src/composables/usePromptHelpers')
    const agentModes = useAgentModes().state
    const appShell = useAppShell().state
    const helpers = usePromptHelpers().state

    // A configured install: one agent, one model, one bullet.
    agentModes.modes = [
      {
        id: 'code',
        label: 'Code',
        maxToolIteration: 25,
        mcpEnable: true,
        lspEnable: true,
        systemMessage: '',
        readonly: false,
        deletable: true,
        modelId: 1,
        modelName: 'model-1',
      },
    ]
    agentModes.current = 'code'
    agentModes.loaded = true
    appShell.config = { models: [{ id: 1, name: 'model-1' }], store: { usable: true, sentence: null } }
    appShell.servers = [{ id: 1, name: 'One', url: 'http://one/v1', apiKey: '', models: [] }]
    helpers.slots = [{ id: 3, color: '#808080', content: 'be brief' }]
    helpers.caps = { contentMaxChars: 200, defaultColor: '#808080' }
    helpers.loaded = true

    const catalogue = () =>
      JSON.stringify({
        agents: agentModes.modes,
        current: agentModes.current,
        models: appShell.config,
        servers: appShell.servers,
        bullets: helpers.slots,
        caps: helpers.caps,
      })
    const before = catalogue()

    const urls = stubWorkspaceRead(workspacePayload({ workspace: '/srv/other' }))
    state.field = '/srv/other'
    await setWorkspaceFromField()

    expect(state.workspace).toBe('/srv/other')
    expect(catalogue()).toBe(before)
    // And no catalogue route was asked: the read is about the folder, nothing else.
    expect(urls).toEqual([`/api/workspace?workspace=${encodeURIComponent('/srv/other')}`])
  })
})

describe('the composable is state plus plain functions', () => {
  it('hands the same state to every caller', () => {
    expect(useWorkspaceSession().state).toBe(state)
    expect(useWorkspaceSession().withWorkspace).toBe(withWorkspace)
  })
})
