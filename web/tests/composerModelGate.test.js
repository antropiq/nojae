import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import WorkBenchInput from '../src/components/WorkBenchInput.vue'
import {
  AGENT_LIST_WARNING,
  NO_MODEL_WARNING,
  loadAgentModes,
  setAgentMode,
  useAgentModes,
} from '../src/composables/useAgentModes'
import { useBatch } from '../src/composables/useBatch'
import { useAppShell } from '../src/composables/useAppShell'
import { useChat } from '../src/composables/useChat'
import { AGENT_STORAGE_KEY } from '../src/composables/useWorkspaceSession'

// ---------------------------------------------------------------------------
// §5.4's model gate on the composer: the selected agent's `model_id` decides
// whether the warning icon renders and whether Send can be pressed.
//
// The answer itself is `useAgentModes`' (task 11); what this file measures is
// the composer rendering it — the icon's place beside the pencil, its one
// tooltip, the disabled Send and the reason it carries — and that switching to a
// runnable agent clears both. A list that never loaded is the other half: the
// composer cannot name an agent, so Send stays disabled with that failure.
// ---------------------------------------------------------------------------

const agentModes = useAgentModes().state
const chat = useChat().state
const batch = useBatch().state
const appShell = useAppShell().state

function agentsBody({ chatModel = 2, codeModel = 1 } = {}) {
  return {
    agents: [
      {
        id: 'code',
        label: 'Code',
        mcpEnable: true,
        lspEnable: true,
        readonly: false,
        deletable: false,
        maxToolIteration: 25,
        systemMessage: '',
        modelId: codeModel,
        modelName: codeModel === null ? null : `model-${codeModel}`,
      },
      {
        id: 'chat',
        label: 'Chat',
        mcpEnable: false,
        lspEnable: false,
        readonly: false,
        deletable: true,
        maxToolIteration: 25,
        systemMessage: '',
        modelId: chatModel,
        modelName: chatModel === null ? null : `model-${chatModel}`,
      },
    ],
    caps: { minToolIteration: 1, maxIdChars: 32 },
    findings: [],
  }
}

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

function stubRoutes({ agents = agentsBody() } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const key = String(url)
    if (key === '/api/agents') {
      return agents === null ? jsonResponse({}, false, 500) : jsonResponse(agents)
    }
    throw new Error(`unexpected fetch: ${key}`)
  })
}

function resetAll() {
  chat.phase = 'idle'
  chat.messages = []
  chat.error = null
  chat.pausePending = false
  chat.pendingImage = null
  chat.draft = { raw: '', html: '', renderedRaw: '' }
  chat.mcp = { connectors: [], enabled: {}, loaded: false, locked: false, restarting: false }
  chat.lsp = { servers: [], enabled: {}, loaded: false, locked: false, restarting: false }
  batch.active = false
  batch.status = 'idle'
  agentModes.modes = []
  agentModes.current = null
  agentModes.loaded = false
  agentModes.findings = []
  agentModes.notice = null
  appShell.config = null
  // The remembered agent is the tab's (§5.5 rule 26): `sessionStorage` is what a
  // fresh case has to clear.
  window.sessionStorage.clear()
}

let host = null

async function mountComposer() {
  host = document.createElement('div')
  document.body.appendChild(host)
  const wrapper = mount(WorkBenchInput, { attachTo: host })
  await flushPromises()
  return wrapper
}

function warning(w) {
  return w.find('.chat-mode-warning')
}

function sendButton(w) {
  return w.find('.chat-send:not(.chat-stop)')
}

// The composer's Send button is only meaningful with something to send: an
// empty draft disables it for its own reason, which would hide the gate.
function typeAway() {
  chat.draft.raw = 'hello'
}

beforeEach(() => {
  resetAll()
})

afterEach(() => {
  host?.remove()
  host = null
  vi.restoreAllMocks()
})

describe('a selected agent with no model', () => {
  it('shows the warning immediately beside the pencil, with the one tooltip', async () => {
    stubRoutes({ agents: agentsBody({ chatModel: null }) })
    await loadAgentModes()
    setAgentMode('chat')
    const w = await mountComposer()

    const icon = warning(w)
    expect(icon.exists()).toBe(true)
    // Same row, immediately after the pencil: "the two already share a row".
    expect(w.find('.chat-mode-row').element.children[1]).toBe(
      w.find('.chat-mode-edit').element,
    )
    expect(w.find('.chat-mode-row').element.children[2]).toBe(icon.element)
    expect(icon.attributes('title')).toBe(NO_MODEL_WARNING)
    expect(icon.attributes('aria-label')).toBe(NO_MODEL_WARNING)
  })

  it('leaves Send disabled, and says why', async () => {
    stubRoutes({ agents: agentsBody({ chatModel: null }) })
    await loadAgentModes()
    setAgentMode('chat')
    const w = await mountComposer()
    typeAway()
    await flushPromises()

    expect(chat.draft.raw).toBe('hello')
    expect(sendButton(w).attributes('disabled')).toBeDefined()
    expect(sendButton(w).attributes('title')).toBe(NO_MODEL_WARNING)
  })

  it('switching to an agent that has a model clears the warning and enables Send', async () => {
    stubRoutes({ agents: agentsBody({ chatModel: null }) })
    await loadAgentModes()
    setAgentMode('chat')
    const w = await mountComposer()
    typeAway()
    await flushPromises()
    expect(warning(w).exists()).toBe(true)
    expect(sendButton(w).attributes('disabled')).toBeDefined()

    // The fix the user may choose instead of assigning a model: pick another
    // agent. The row's own field is read again, so both answers flip together.
    await w.find('.chat-mode-select').setValue('code')
    await flushPromises()

    expect(warning(w).exists()).toBe(false)
    expect(sendButton(w).attributes('disabled')).toBeUndefined()
    expect(sendButton(w).attributes('title')).toBe('Send')
  })

  // Requirement 2 of clws-08, at the surface that sets it: the dropdown's change
  // lands in the **tab's** storage (§5.5 rule 26), not the browser-wide one. The
  // component's logic is unchanged — `setAgentMode` on change, which is where
  // the write happens — and this case is the reason that one call is load-bearing.
  it('writes the chosen agent to the tab storage, and to nothing browser-wide', async () => {
    stubRoutes()
    await loadAgentModes()
    const w = await mountComposer()

    await w.find('.chat-mode-select').setValue('chat')
    await flushPromises()

    expect(window.sessionStorage.getItem(AGENT_STORAGE_KEY)).toBe('chat')
    expect(window.localStorage.getItem(AGENT_STORAGE_KEY)).toBeNull()
  })
})

// The hover over the selected agent: three lines naming what the turn will run
// as and on. The rule is `modeSelectTitle`'s (judged in `agentModes.test.js`);
// what is measured here is the composer wiring the config catalogue into it —
// without that argument the server half could never appear.
describe('the selected agent tooltip', () => {
  it('says agent: server, model, and the two hubs', async () => {
    stubRoutes()
    appShell.config = {
      models: [
        { id: 1, name: 'qwen3.8-flash-next', serverName: 'hpz' },
        { id: 2, name: 'model-2', serverName: 'hpz' },
      ],
      store: { usable: true },
    }
    await loadAgentModes()
    const w = await mountComposer()

    expect(w.find('.chat-mode-select').attributes('title')).toBe(
      'Code: hpz\nmodel: qwen3.8-flash-next\nMCP: On, LSP: On',
    )
  })

  it('follows the selection, and omits the model an agent does not have', async () => {
    stubRoutes({ agents: agentsBody({ chatModel: null }) })
    appShell.config = { models: [{ id: 1, name: 'qwen3.8-flash-next', serverName: 'hpz' }] }
    await loadAgentModes()
    const w = await mountComposer()

    await w.find('.chat-mode-select').setValue('chat')
    await flushPromises()

    // Chat has neither hub open and now no model at all, so it gets two lines —
    // the missing model is the warning icon's sentence, not an invented name.
    expect(w.find('.chat-mode-select').attributes('title')).toBe('Chat\nMCP: Off, LSP: Off')
  })
})

describe('a composer whose agent list failed to load', () => {
  it('cannot send, and the load failure is the reason', async () => {
    stubRoutes({ agents: null })
    await loadAgentModes()
    const w = await mountComposer()
    typeAway()
    await flushPromises()

    // There is no selection to warn about — the dropdown is not even drawn —
    // but Send cannot name an agent it never read either.
    expect(w.find('.chat-mode-select').exists()).toBe(false)
    expect(warning(w).exists()).toBe(false)
    expect(sendButton(w).attributes('disabled')).toBeDefined()
    expect(sendButton(w).attributes('title')).toBe(AGENT_LIST_WARNING)
  })
})
