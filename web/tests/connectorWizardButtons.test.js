import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import WorkBenchLspPanel from '../src/components/WorkBenchLspPanel.vue'
import WorkBenchMcpPanel from '../src/components/WorkBenchMcpPanel.vue'
import { agentNoModelSentence, useAgentModes } from '../src/composables/useAgentModes'
import { useBatch } from '../src/composables/useBatch'
import { useChat } from '../src/composables/useChat'
import {
  FAMILY_LSP,
  FAMILY_MCP,
  SET_ME_UP_LABEL,
  close,
  useConnectorWizard,
} from '../src/composables/useConnectorWizard'
import { useWorkspaceSession } from '../src/composables/useWorkspaceSession'

// ---------------------------------------------------------------------------
// The two entry points, and the two empty states (cwizard-08, spec §2).
//
// What this file pins is the *panels'* surface, not the wizard's: each head row
// carries exactly one `Set me up!` button, at the left of that panel's restart,
// in the head row and nothing else; a click opens the wizard on **that panel's
// family** and issues no write, no restart and no toggle; and the empty-state
// line now invites the click while still naming its declaration file.
//
// The gate is the composable's one verdict, so the rows below assert the panel
// *shows* it rather than re-deriving it: live during a streaming reply, a running
// batch, locked toggles and a mode that switches the hub off (§10), and inert —
// with the app's **existing** no-model sentence as its accessible name — when
// there is no resolvable model. The comparison goes against
// `useAgentModes`'s own builder, so the two cannot drift.
//
// `fetch` is stubbed throughout: no spec here reaches an endpoint.
// ---------------------------------------------------------------------------

const chat = useChat().state
const batch = useBatch().state
const modes = useAgentModes().state
const session = useWorkspaceSession().state
const wizard = useConnectorWizard()
const state = wizard.state

const ROW_WITH_MODEL = {
  id: 'chat',
  label: 'Chat',
  mcpEnable: true,
  lspEnable: true,
  modelId: 7,
  modelName: 'a model',
}

const ROW_WITHOUT_MODEL = {
  id: 'plain',
  label: 'Plain',
  mcpEnable: true,
  lspEnable: true,
  modelId: null,
  modelName: null,
}

const CONNECTION = {
  agentMode: 'chat',
  agent: 'Chat',
  server: 'Local server',
  model: 'a-model',
  canRun: true,
  refusal: null,
}

const CATALOGUE = {
  entries: [
    {
      id: 'fetch',
      identity: { name: 'Fetch', description: 'Fetches a page', docs: 'https://x.test' },
      member: { type: 'local', enable: true, command: ['uvx', 'mcp-server-fetch'] },
      requirements: { requires: {}, inputs: [] },
      relevance: { signals: [] },
    },
  ],
  notes: [],
}

const PROPOSAL = {
  id: 'fake-langserver',
  command: ['fake-langserver', '--stdio'],
  extensions: ['.py'],
  workspaceRoot: '${NOJAE_PATH_LOCATION}',
  evidence: 'Python here (12 .py files)',
}

// The two panels, with the family each one opens and the declaration file its
// empty line has to keep naming.
const PANELS = [
  {
    label: 'MCP',
    component: WorkBenchMcpPanel,
    family: FAMILY_MCP,
    files: ['.nojae/mcp-settings.json'],
  },
  {
    label: 'LSP',
    component: WorkBenchLspPanel,
    family: FAMILY_LSP,
    files: ['.nojae/lsp-settings.template.json', '.nojae/lsp-settings.json'],
  },
]

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

// A stub that answers the wizard's own routes and records every request, so a
// click can be checked for what it did **not** reach.
function stubWizardRoutes() {
  const calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, options = {}) => {
    const text = String(url)
    calls.push({ url: text, method: options.method ?? 'GET', body: options.body })
    if (text.includes('/api/wizard/catalogue')) return jsonResponse(CATALOGUE)
    if (text.includes('/api/wizard/connection')) return jsonResponse(CONNECTION)
    if (text.includes('/api/wizard/scan')) return jsonResponse({ facts: { extensions: {} } })
    if (text.includes('/api/wizard/propose')) {
      return jsonResponse({
        outcome: 'ok',
        sentence: null,
        proposals: [PROPOSAL],
        notes: [],
        declarationPath: '/w/.nojae/lsp-settings.json',
      })
    }
    return jsonResponse({})
  })
  return calls
}

function seedHubs({ mcp = true, lsp = true } = {}) {
  chat.mcp = {
    connectors: mcp ? [{ id: 'console', label: 'Console', status: 'running' }] : [],
    enabled: mcp ? { console: true } : {},
    loaded: mcp,
    locked: false,
    restarting: false,
    error: null,
  }
  chat.lsp = {
    servers: lsp ? [{ id: 'pyright', label: 'Pyright', status: 'running' }] : [],
    enabled: lsp ? { pyright: true } : {},
    loaded: lsp,
    locked: false,
    restarting: false,
    error: null,
  }
}

function seedModel(row = ROW_WITH_MODEL) {
  modes.modes = [row]
  modes.current = row.id
  modes.loaded = true
}

function reset() {
  chat.phase = 'idle'
  chat.error = null
  batch.active = false
  session.poolRefusal = null
  modes.modes = []
  modes.current = null
  modes.loaded = false
  state.connection = null
  state.connectionFailure = null
  close()
  seedHubs()
}

// The two head buttons, in document order, from the head row itself.
function headButtons(wrapper) {
  return wrapper.find('.chat-hub-head').findAll('button')
}

beforeEach(reset)

afterEach(() => {
  vi.restoreAllMocks()
})

describe('each panel\'s head carries one Set me up! button, left of its restart', () => {
  for (const panel of PANELS) {
    it(`puts exactly one in the ${panel.label} head, before the restart`, () => {
      seedModel()
      const wrapper = mount(panel.component)

      const buttons = headButtons(wrapper)
      expect(buttons).toHaveLength(2)
      // Left to right: the wizard's entry point, then the restart.
      expect(buttons[0].classes()).toContain('chat-hub-setup')
      expect(buttons[1].classes()).toContain('chat-hub-restart')
      // And the entry point really is the first of the two in the DOM, not
      // merely present: a later rule cannot reorder them out of this contract.
      expect(
        buttons[0].element.compareDocumentPosition(buttons[1].element) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
      wrapper.unmount()
    })

    // The tooltip and the accessible name are the same string, as every icon
    // button in the app does — and the glyph is decoration, never named.
    it(`names the ${panel.label} entry point ${SET_ME_UP_LABEL}, glyph hidden`, () => {
      seedModel()
      const wrapper = mount(panel.component)

      const button = wrapper.find('.chat-hub-setup')
      expect(button.attributes('title')).toBe(SET_ME_UP_LABEL)
      expect(button.attributes('aria-label')).toBe(SET_ME_UP_LABEL)
      const glyph = button.find('svg')
      expect(glyph.exists()).toBe(true)
      expect(glyph.attributes('aria-hidden')).toBe('true')
      wrapper.unmount()
    })

    // Opening the wizard on this panel's family and nothing else: no toggle, no
    // restart, no write. The family is never a question inside the dialog.
    it(`opens the wizard on the ${panel.label} family and touches nothing else`, async () => {
      seedModel()
      const calls = stubWizardRoutes()
      const wrapper = mount(panel.component)
      const before = {
        mcpEnabled: { ...chat.mcp.enabled },
        lspEnabled: { ...chat.lsp.enabled },
      }

      await wrapper.find('.chat-hub-setup').trigger('click')
      await flushPromises()

      expect(state.open).toBe(true)
      expect(state.family).toBe(panel.family)

      // Every request the press issued is the wizard's own read surface: no hub,
      // no file route, no settings store, no chat turn.
      const forbidden = ['/api/mcp', '/api/lsp', '/api/fs', '/api/chat', '/api/settings']
      for (const call of calls) {
        expect(call.url.startsWith('/api/wizard/')).toBe(true)
        for (const prefix of forbidden) expect(call.url.startsWith(prefix)).toBe(false)
      }
      // And the panel's own state is what it was: nothing restarted, no toggle
      // moved.
      expect(chat.mcp.restarting).toBe(false)
      expect(chat.lsp.restarting).toBe(false)
      expect(chat.mcp.enabled).toEqual(before.mcpEnabled)
      expect(chat.lsp.enabled).toEqual(before.lspEnabled)

      wrapper.unmount()
    })
  }
})

describe('the only gate is the model', () => {
  // §10's table, row by row: none of these states gates preparation.
  const liveRows = [
    ['a reply streaming', () => { chat.phase = 'streaming' }],
    ['a batch running', () => { batch.active = true }],
    [
      'the toggles locked by a started conversation',
      () => {
        chat.mcp.locked = true
        chat.lsp.locked = true
      },
    ],
    [
      'the active agent mode switching that hub off',
      () => {
        modes.modes = [{ ...ROW_WITH_MODEL, mcpEnable: false, lspEnable: false }]
        modes.current = ROW_WITH_MODEL.id
      },
    ],
    ['a hub route that refused the workspace', () => { session.poolRefusal = 'too many' }],
  ]

  for (const panel of PANELS) {
    it.each(liveRows)(`keeps the ${panel.label} button live while %s`, (_row, plant) => {
      seedModel()
      plant()
      const wrapper = mount(panel.component)

      const button = wrapper.find('.chat-hub-setup')
      expect(button.attributes('disabled')).toBeUndefined()
      expect(button.attributes('aria-label')).toBe(SET_ME_UP_LABEL)
      wrapper.unmount()
    })

    // The one real gate: with no resolvable model the button is inert, and its
    // accessible name is the app's **existing** refusal sentence for that row —
    // never a second wording, and never the live label.
    it(`inerts the ${panel.label} button with the existing refusal sentence`, () => {
      seedModel(ROW_WITHOUT_MODEL)
      const wrapper = mount(panel.component)

      const button = wrapper.find('.chat-hub-setup')
      expect(button.attributes('disabled')).toBeDefined()
      expect(button.attributes('aria-label')).toBe(agentNoModelSentence(ROW_WITHOUT_MODEL))
      expect(button.attributes('title')).toBe(agentNoModelSentence(ROW_WITHOUT_MODEL))
      expect(button.attributes('aria-label')).not.toBe(SET_ME_UP_LABEL)
      wrapper.unmount()
    })
  }

  // The restart's own rules are untouched by the new button: it stays inert
  // while a reply streams, while the wizard's stays live.
  it('leaves the restart\'s own enablement exactly as it was', () => {
    seedModel()
    chat.phase = 'streaming'
    const wrapper = mount(WorkBenchMcpPanel)

    expect(wrapper.find('.chat-hub-restart').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.chat-hub-setup').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('the second head button is the restart\'s own box', () => {
  // jsdom lays nothing out, so what is pinned here is the shipped rule that says
  // the two head buttons share one box: adding a control to the head must never
  // change the row's height or the panel's width (AC-1). The rendered sizes are
  // the Playwright half's.
  it('sizes the wizard\'s entry point exactly like the restart', () => {
    const css = readFileSync(join(resolve(), 'src', 'styles', 'theme.css'), 'utf8')
    const rule = css.match(/\n\.chat-hub-setup\s*\{[^}]*\}/)
    expect(rule, 'the entry point has a box of its own').not.toBeNull()
    expect(rule[0]).toContain('width: 1.5rem')
    expect(rule[0]).toContain('height: 1.5rem')
    expect(rule[0]).toContain('flex: 0 0 auto')
  })
})

describe('the empty state invites the click and still names its file', () => {
  for (const panel of PANELS) {
    it(`does both in the ${panel.label} panel`, () => {
      seedModel()
      seedHubs({ mcp: false, lsp: false })
      const wrapper = mount(panel.component)

      const line = wrapper.find('.chat-hub-empty')
      expect(line.exists()).toBe(true)
      // The reworded half: it points at that button, by the name the button has.
      expect(line.text()).toContain(SET_ME_UP_LABEL)
      // The information it already carried, kept.
      for (const file of panel.files) expect(line.text()).toContain(file)
      expect(line.text()).toContain('Settings')
      wrapper.unmount()
    })
  }
})
