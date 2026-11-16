import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import AppBar from '../src/components/AppBar.vue'
import SettingsDialog from '../src/components/SettingsDialog.vue'
import WorkBenchMcpPanel from '../src/components/WorkBenchMcpPanel.vue'
import WorkspaceNavigator from '../src/components/WorkspaceNavigator.vue'
import { loadAgentModes, useAgentModes } from '../src/composables/useAgentModes'
import { useAppShell } from '../src/composables/useAppShell'
import { useBatch } from '../src/composables/useBatch'
import { loadChatMcp, useChat } from '../src/composables/useChat'
import {
  AGENT_STORAGE_KEY,
  TOOLS_RESTARTING,
  TOOLS_RESTARTING_TEXT,
  WORKSPACE_STORAGE_KEY,
  loadWorkspace,
  locationNoteVerdict,
  noteHubPayload,
  setToolsRestarting,
  setWorkspaceFromField,
  useWorkspaceSession,
} from '../src/composables/useWorkspaceSession'
import { useWorkspaceTree } from '../src/composables/useWorkspaceTree'

// ---------------------------------------------------------------------------
// clws-11: what the user *sees*.
//
// The behaviour is already in place — the poll, the per-request field, the four
// composables. This suite is about the one visible surface that answers it: the
// app bar's working-location field and its one note line, the Editor's root
// label, and the entry point a tab takes on birth and on reload.
//
// Three structural facts make the cases below honest:
//
// * the tab's folder and agent are **`sessionStorage`** keys, so two mounted
//   cases can only meet through what this one writes down;
// * each browser tab is its own JS context, so "another tab's reply" is
//   another module instance — the one case below instantiates one to prove the
//   two states cannot meet through this one's lock;
// * a refusal is the **server's sentence**, never one this client composes.
//   The ceiling's text is asserted byte-for-byte from the route's `detail`, and
//   the pool's summary is never drawn as a list.
// ---------------------------------------------------------------------------

const shell = useAppShell().state
const { state: sessionState } = useWorkspaceSession()
const chat = useChat().state
const batch = useBatch().state
const agents = useAgentModes().state
const tree = useWorkspaceTree()

const INSTALL = '/srv/app'
const TAB_ROOT = '/w/tab-a'
const OTHER_ROOT = '/w/tab-b'
const CEILING =
  'Too many workspaces are open at once: nojae keeps at most 6 alive, and these ' +
  'are the live ones — /w/a, /w/b. Point another tab away from one of them, or ' +
  'wait for an idle one to be let go.'

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

// The workspace read's full shape, including the pool summary the bar reads but
// must not render.
function workspacePayload({
  workspace = TAB_ROOT,
  live = [workspace],
  default: fallback = INSTALL,
  policy = null,
} = {}) {
  return {
    workspace,
    default: fallback,
    policy,
    mcpSettings: { state: 'absent', path: '' },
    lspSettings: { state: 'absent', path: '' },
    lspSettingsTemplate: { state: 'absent', path: '' },
    hubs: {
      mcp: { installed: true, connectors: [], built: false },
      lsp: { installed: true, servers: [], built: false },
      pool: {
        workspaces: live.map((root) => ({ root, state: 'ready' })),
        limit: 6,
        atLimit: false,
        sentence: null,
      },
    },
  }
}

function reset() {
  shell.config = {
    models: [{ id: 1, name: 'model-1' }],
    store: { usable: true, sentence: null },
  }
  shell.storeState = { usable: true, sentence: null }
  shell.configError = null
  shell.activeTab = 'chat'
  shell.mcpError = null
  shell.lspError = null
  shell.mcpConnectors = []
  shell.mcpEnabled = []
  shell.mcpInstalled = true
  shell.mcpLoading = false
  shell.lspServers = []
  shell.lspActivated = []
  shell.lspInstalled = true
  shell.lspLoading = false

  sessionState.workspace = TAB_ROOT
  sessionState.field = TAB_ROOT
  sessionState.loading = false
  sessionState.saving = false
  sessionState.error = null
  sessionState.policy = null
  sessionState.policyNote = null
  // Through the setter: it also drops any pending self-clearing timer a
  // previous test armed.
  setToolsRestarting(false)
  sessionState.poolRefusal = null

  chat.phase = 'idle'
  chat.error = null
  chat.session.startedAt = 0
  chat.session.agentMode = null
  chat.mcp.connectors = []
  chat.mcp.enabled = {}
  chat.mcp.loaded = false
  chat.mcp.locked = false
  chat.mcp.restarting = false
  chat.mcp.error = null
  chat.lsp.servers = []
  chat.lsp.enabled = {}
  chat.lsp.loaded = false
  chat.lsp.locked = false
  chat.lsp.restarting = false
  chat.lsp.error = null

  batch.active = false
  batch.status = 'idle'

  agents.modes = []
  agents.current = null
  agents.loaded = false
  agents.findings = []
  agents.notice = null

  tree.state.nodes = {}
  tree.state.expanded = { '': true }
  tree.state.focused = ''
  tree.state.selected = null
  tree.state.editing = null
  tree.state.workspace = ''
  tree.state.error = null

  window.sessionStorage.clear()
  window.localStorage.clear()
  Element.prototype.scrollIntoView = () => {}
  Element.prototype.showModal = function showModal() {
    this.open = true
  }
  Element.prototype.close = function close() {
    this.open = false
  }
}

beforeEach(() => {
  reset()
  vi.restoreAllMocks()
})

function setButton(wrapper) {
  return wrapper.find('.appbar-location-set')
}

function notes(wrapper) {
  return wrapper.findAll('.appbar-location-note')
}

describe('one visible workspace, and it is the one the tab uses', () => {
  it('keeps the canonical value in the field title while the text is edited', () => {
    sessionState.workspace = TAB_ROOT
    sessionState.field = '/w/typed/'
    const wrapper = mount(AppBar)

    const field = wrapper.find('.appbar-location-input')
    expect(field.element.value).toBe('/w/typed/')
    // The title is the value every request is built from — never the text being
    // typed, and never another folder.
    expect(field.attributes('title')).toBe(TAB_ROOT)
    expect(wrapper.findAll('.appbar-location-input')).toHaveLength(1)
    // No second readout in the bar: the path appears nowhere else as text.
    expect(wrapper.text()).not.toContain(TAB_ROOT)
    wrapper.unmount()
  })

  it('keeps a stale remembered folder in the field and refuses it in the note', async () => {
    window.sessionStorage.setItem(WORKSPACE_STORAGE_KEY, '/w/gone')
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(
        { detail: 'Working location is not an existing directory: /w/gone' },
        false,
        422,
      ),
    )

    await loadWorkspace()
    const wrapper = mount(AppBar)

    // Spec §6: the remembered folder is convenience, not a guarantee. The text
    // stays where the user can fix it, and the server says why.
    expect(wrapper.find('.appbar-location-input').element.value).toBe('/w/gone')
    expect(notes(wrapper)[0].text()).toContain('/w/gone')
    expect(notes(wrapper)[0].attributes('role')).toBe('alert')
    expect(notes(wrapper)[0].classes()).toContain('appbar-location-note--error')
    wrapper.unmount()
  })
})

describe("the lock is this tab's only", () => {
  it.each([
    ['a reply', () => (chat.phase = 'answering')],
    ['a lot', () => (batch.active = true)],
  ])('disables Set during this tab\'s %s, and says why', (_label, arm) => {
    sessionState.field = OTHER_ROOT
    arm()
    const wrapper = mount(AppBar)

    expect(setButton(wrapper).attributes('disabled')).toBeDefined()
    expect(setButton(wrapper).attributes('title')).toContain(
      'while a session is running',
    )
    wrapper.unmount()
    chat.phase = 'idle'
    batch.active = false
  })

  // A second browser tab is a second module graph. Its reply cannot write this
  // tab's `chat.phase`, so the only way it could lock this field is a broadcast —
  // and there is none (spec D7). The fresh import below *is* that second tab.
  it("a reply streaming in another tab never disables this tab's Set", async () => {
    sessionState.field = OTHER_ROOT
    const wrapper = mount(AppBar)
    expect(setButton(wrapper).attributes('disabled')).toBeUndefined()

    vi.resetModules()
    const otherTab = (await import('../src/composables/useChat')).useChat().state
    otherTab.phase = 'answering'
    await wrapper.vm.$nextTick()

    expect(setButton(wrapper).attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})

describe("this workspace's tools are restarting", () => {
  it('is a status line, not an error, when the payload says built', async () => {
    noteHubPayload({ built: true })
    const wrapper = mount(AppBar)

    const line = notes(wrapper)
    expect(line).toHaveLength(1)
    expect(line[0].text()).toBe(TOOLS_RESTARTING_TEXT)
    expect(line[0].attributes('role')).toBe('status')
    expect(line[0].classes()).not.toContain('appbar-location-note--error')
    expect(line[0].classes()).toContain('appbar-location-note--status')

    // The next live answer is the "up again" half.
    noteHubPayload({ built: false })
    await wrapper.vm.$nextTick()
    expect(notes(wrapper)).toHaveLength(0)
    wrapper.unmount()
  })

  it('shows for a workspace with no live set at all, and clears when it is live', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const key = String(url)
      if (key.startsWith('/api/workspace?') || key === '/api/workspace') {
        return jsonResponse(workspacePayload({ workspace: TAB_ROOT, live: [] }))
      }
      return jsonResponse({})
    })

    await loadWorkspace()
    expect(sessionState.toolsRestarting).toBe(true)

    vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      String(url).startsWith('/api/workspace')
        ? jsonResponse(workspacePayload({ workspace: TAB_ROOT, live: [TAB_ROOT] }))
        : jsonResponse({}),
    )
    await loadWorkspace()
    expect(sessionState.toolsRestarting).toBe(false)
  })

  it('yields to a refusal, which is the line that wins', async () => {
    noteHubPayload({ built: true })
    sessionState.error = 'Working location is not an existing directory: /w/nope'
    const wrapper = mount(AppBar)

    const line = notes(wrapper)
    expect(line).toHaveLength(1)
    expect(line[0].text()).toContain('/w/nope')
    expect(line[0].attributes('role')).toBe('alert')
    wrapper.unmount()
  })

  // BUG-01: at boot the workspace read finds no live set (the flag is set
  // before any tools exist), then the two hub reads race — one of them is the
  // admission and answers `built: true`. That writer used to win forever, so
  // the line stuck until a reload even though the tools were demonstrably up.
  // The flag must not remain set after an admission whose set is live: once
  // the restart window has passed, the line is gone with no payload at all.
  it('does not stick after the boot admission race left built last', async () => {
    // `TOOLS_RESTARTING` is the file-top import, not a fresh dynamic one: a
    // previous test's `vi.resetModules()` makes `await import` hand back a
    // second module instance whose flag is not the one `loadWorkspace` writes.
    TOOLS_RESTARTING.ttlMs = 40
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    try {
      // 1. The boot read: the folder is not live in the pool yet, so the
      //    workspace-read path sets the flag immediately.
      vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
        const key = String(url)
        if (key.startsWith('/api/workspace')) {
          return jsonResponse(workspacePayload({ workspace: TAB_ROOT, live: [] }))
        }
        return jsonResponse({})
      })
      await loadWorkspace()
      expect(sessionState.toolsRestarting).toBe(true)

      // 2. The two hub reads land, and the admitting one's `built: true` is
      //    the **last** writer to reach the flag — the race losing nothing.
      noteHubPayload({ built: false })
      noteHubPayload({ built: true })
      const wrapper = mount(AppBar)
      expect(notes(wrapper)[0].text()).toBe(TOOLS_RESTARTING_TEXT)

      // 3. Nothing else answers — no tab switch, no dialog, no reload. The
      //    restart window is all the tab gets, and it is enough.
      await sleep(120)
      await wrapper.vm.$nextTick()
      expect(notes(wrapper)).toHaveLength(0)
      expect(sessionState.toolsRestarting).toBe(false)
      wrapper.unmount()
    } finally {
      TOOLS_RESTARTING.ttlMs = 100_000
    }
  })
})

describe('the ceiling is one sentence, verbatim, in the bar and the panel', () => {
  it('renders the server sentence as an alert and no list of live workspaces', async () => {
    sessionState.workspace = TAB_ROOT
    sessionState.field = OTHER_ROOT
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      String(url).startsWith('/api/workspace')
        ? jsonResponse({ detail: CEILING }, false, 429)
        : jsonResponse({}),
    )

    await setWorkspaceFromField()
    const wrapper = mount(AppBar)

    const line = notes(wrapper)
    expect(line).toHaveLength(1)
    expect(line[0].text()).toBe(CEILING)
    expect(line[0].attributes('role')).toBe('alert')
    expect(line[0].classes()).toContain('appbar-location-note--error')
    // The pool's summary is not a list on screen: the only place the live roots
    // appear is inside the one sentence the server sent.
    expect(wrapper.find('.appbar-location').findAll('ul, ol')).toHaveLength(0)
    expect(wrapper.find('.appbar-location').text()).toContain(CEILING)
    wrapper.unmount()
  })

  it('gives the panel that asked the same sentence, and clears it when tools answer', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) =>
      String(url).startsWith('/api/mcp')
        ? jsonResponse({ detail: CEILING }, false, 429)
        : jsonResponse({}),
    )

    await loadChatMcp()
    expect(chat.mcp.error).toBe(CEILING)
    expect(sessionState.poolRefusal).toBe(CEILING)

    const panel = mount(WorkBenchMcpPanel)
    expect(panel.find('[role="alert"]').text()).toBe(CEILING)
    panel.unmount()

    const bar = mount(AppBar)
    expect(notes(bar)[0].text()).toBe(CEILING)
    bar.unmount()

    // The next successful hub answer says the tools are up: the panel's line and
    // the bar's ceiling sentence both go.
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse({ installed: true, connectors: [], built: false }),
    )
    await loadChatMcp()
    expect(chat.mcp.error).toBeNull()
    expect(sessionState.poolRefusal).toBeNull()
  })
})

describe('the entry point: a new tab, and a reload', () => {
  it('lands a new tab on the installation folder, ignoring browser-wide storage', async () => {
    // A stale browser-wide value from another build must not be inherited.
    window.localStorage.setItem(WORKSPACE_STORAGE_KEY, OTHER_ROOT)
    const urls = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      urls.push(String(url))
      return jsonResponse(workspacePayload({ workspace: INSTALL, live: [INSTALL] }))
    })

    await loadWorkspace()

    // No stored folder means no field on the request, and the answer is the
    // server's installation folder (spec D4).
    expect(urls).toEqual(['/api/workspace'])
    expect(sessionState.workspace).toBe(INSTALL)
    expect(sessionState.field).toBe(INSTALL)
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBe(OTHER_ROOT)
  })

  it('returns a reload to its own folder and agent, from sessionStorage', async () => {
    window.sessionStorage.setItem(WORKSPACE_STORAGE_KEY, TAB_ROOT)
    window.sessionStorage.setItem(AGENT_STORAGE_KEY, 'chat')
    const urls = []
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const key = String(url)
      urls.push(key)
      if (key.startsWith('/api/workspace')) {
        return jsonResponse(workspacePayload({ workspace: TAB_ROOT }))
      }
      if (key === '/api/agents') {
        return jsonResponse({
          agents: [
            { id: 'code', label: 'Code', modelId: 1, modelName: 'model-1' },
            { id: 'chat', label: 'Chat', modelId: 1, modelName: 'model-1' },
          ],
          findings: [],
        })
      }
      return jsonResponse({})
    })

    await loadWorkspace()
    await loadAgentModes()

    // The first request in the reload already names the tab's own folder.
    expect(urls[0]).toBe(
      `/api/workspace?workspace=${encodeURIComponent(TAB_ROOT)}`,
    )
    expect(sessionState.workspace).toBe(TAB_ROOT)
    // The agent comes out of the same per-tab storage.
    expect(agents.current).toBe('chat')
    // And no browser-wide copy was written by either half.
    expect(window.localStorage.getItem(WORKSPACE_STORAGE_KEY)).toBeNull()
    expect(window.localStorage.getItem(AGENT_STORAGE_KEY)).toBeNull()
  })

  it('names both keys in sessionStorage, and writes no browser-wide copy', () => {
    const session = readFileSync(
      resolve('src/composables/useWorkspaceSession.js'),
      'utf8',
    )
    const modes = readFileSync(resolve('src/composables/useAgentModes.js'), 'utf8')
    for (const source of [session, modes]) {
      expect(source).not.toMatch(
        /localStorage\.(set|get|remove)Item\(\s*(WORKSPACE|AGENT)_STORAGE_KEY/,
      )
    }
    expect(session).toContain('window.sessionStorage.getItem(WORKSPACE_STORAGE_KEY)')
    expect(modes).toContain('window.sessionStorage.getItem(AGENT_STORAGE_KEY)')
  })
})

describe("the Editor names the tab's folder", () => {
  it('labels the tree root and its empty state with the tree payload folder', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const key = String(url)
      if (key.startsWith('/api/fs/tree')) {
        return jsonResponse({
          path: '',
          workspace: TAB_ROOT,
          entries: [],
          truncated: false,
        })
      }
      if (key.startsWith('/api/fs/status')) {
        return jsonResponse({ repo: false, entries: [] })
      }
      return jsonResponse({})
    })

    const wrapper = mount(WorkspaceNavigator, { attachTo: document.body })
    await flushPromises()

    expect(tree.state.workspace).toBe(TAB_ROOT)
    expect(tree.rootLabel()).toBe('tab-a')
    expect(wrapper.find('.tree-name').text()).toBe('tab-a')
    expect(wrapper.find('.editor-nav-empty').text()).toBe('tab-a is empty.')
    expect(wrapper.text()).not.toContain('srv/app')
    wrapper.unmount()
  })
})

describe('the Settings dialog holds no workspace control', () => {
  it('never reads or writes the tab folder', () => {
    const source = readFileSync(
      resolve('src/components/SettingsDialog.vue'),
      'utf8',
    )
    // The comment may *name* the composable; what matters is that the module
    // never imports it and no binding reads or spells a folder.
    expect(source).not.toContain("from '../composables/useWorkspaceSession'")
    expect(source).not.toContain('withWorkspace(')
    expect(source).not.toContain('session.workspace')
    expect(source).not.toContain('state.workspace')
    expect(source).not.toContain('workspace=')
    // The dialog is the installation's catalogue: one instance, no folder field.
    expect(SettingsDialog).toBeTruthy()
  })
})

describe('the note verdict is a plain precedence', () => {
  it('puts the refusal above the ceiling, the policy note and the status', () => {
    sessionState.toolsRestarting = true
    sessionState.policyNote = 'policy note'
    sessionState.poolRefusal = CEILING
    sessionState.error = 'the refusal'

    expect(locationNoteVerdict()).toEqual({
      tone: 'error',
      role: 'alert',
      text: 'the refusal',
    })
    sessionState.error = null
    expect(locationNoteVerdict()).toEqual({
      tone: 'error',
      role: 'alert',
      text: CEILING,
    })
    sessionState.poolRefusal = null
    expect(locationNoteVerdict()).toEqual({
      tone: 'warn',
      role: 'status',
      text: 'policy note',
    })
    sessionState.policyNote = null
    expect(locationNoteVerdict()).toEqual({
      tone: 'status',
      role: 'status',
      text: TOOLS_RESTARTING_TEXT,
    })
    sessionState.toolsRestarting = false
    expect(locationNoteVerdict()).toBeNull()
  })
})
