import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  NO_MODEL_LABEL,
  addSlotFor,
  agentCanRun,
  agentModePayloadId,
  agentModesLoaded,
  agentWritePayload,
  applySessionAgentMode,
  closeConfirmationFor,
  closeWouldLoseFor,
  closeWouldLoseForDraft,
  createAgentDraft,
  creationActiveFor,
  creationFormFor,
  currentMode,
  deleteConfirmationFor,
  deleteSlotFor,
  deleteOfferedFor,
  entryProblems,
  fetchAgentDraft,
  fieldsDisabledFor,
  findingsLine,
  idEditableFor,
  idValidityProblem,
  loadAgentModes,
  modelUnchangedFor,
  modeBlocksHub,
  modeHint,
  modeSelectDisabled,
  modeSelectTitle,
  modelChoices,
  messageFor,
  modelLineFor,
  personaByteCount,
  personaOverByteCap,
  rebaselinedDraft,
  rememberedAgentId,
  rememberAgent,
  removeAgentFromDraft,
  saveAgent,
  saveRefusalFor,
  saveSlotFor,
  selectedAgentCanRun,
  setAgentMode,
  slugForDraft,
  slugForModeId,
  successorAfterDelete,
  tabCaptionFor,
  toolIterationProblem,
  useAgentModes,
  writeBlockedFor,
} from '../src/composables/useAgentModes'
import WorkBenchMcpPanel from '../src/components/WorkBenchMcpPanel.vue'
import {
  SESSION_FILE_VERSION,
  conversationJson,
  parseSessionFile,
  useChat,
} from '../src/composables/useChat'
import { AGENT_STORAGE_KEY } from '../src/composables/useWorkspaceSession'
import { useBatch } from '../src/composables/useBatch'
import { useAppShell } from '../src/composables/useAppShell'

// Layer 1 (jsdom): the agent list's state machine. What is asserted here is the
// composable's decisions — the selection it seeds and remembers, the payload key
// it adds, the hub gate, the "can it run" answer and the editor's field rules —
// because every one of them is a function in `useAgentModes.js` and no `.vue`
// re-derives it. The stubbed payloads mirror what `GET /api/agents` answers (the
// install's `agents` table, §4.4); the fetch harness is the one
// batchRetries.test.js uses for the chat routes.
//
// The lock and default-mode tests that used to live here are **deleted, not
// rewritten** (§5.6): they asserted behaviour D5 and §4.4 removed. What replaces
// them is the positive assertion that switching agent after a turn is allowed.

const agentModes = useAgentModes().state
const chat = useChat().state
const batch = useBatch().state
const appShell = useAppShell().state

// The app-owned agent is recognised only by `readonly` / `deletable` (§4.4), so
// this file calls it "the reserved agent" and never names it — the same rule the
// client code is held to (no such id anywhere in `web/src`).
const RESERVED_ID = 'reserved-agent-under-test'

// The caps the payload publishes. No test here hardcodes a rule *number* except
// through this object, and one case patches it to prove the verdict follows the
// payload rather than a literal.
const CAPS = {
  maxIdChars: 32,
  idPattern: '^[a-z][A-Za-z0-9_-]*$',
  maxLabelChars: 40,
  maxPersonaBytes: 16384,
  maxPersonaLines: 16,
  minToolIteration: 1,
}

//: What `GET /api/agents` answers: the install's `agents` rows. There is no
//: `default` key (D5) and no `editable` (it became `readonly`, §4.4), and each
//: row says whether it can run at all (`modelId` + `modelName`) and whether its
//: Delete is offered (`deletable`, D4).
function modesBody({ findings = [], models = {}, order } = {}) {
  const rows = [
    { id: 'code', label: 'Code', mcpEnable: true, lspEnable: true },
    { id: 'chat', label: 'Chat', mcpEnable: false, lspEnable: false },
    { id: 'architect', label: 'Architect', mcpEnable: true, lspEnable: false },
    { id: RESERVED_ID, label: 'Reserved', mcpEnable: true, lspEnable: false, readonly: true },
  ]
  const arranged = order
    ? [...order].map((id) => rows.find((row) => row.id === id))
    : rows
  const agents = arranged.map((row, index) => {
    const modelId = models[row.id] === undefined ? index + 1 : models[row.id]
    return {
      readonly: false,
      ...row,
      deletable: row.readonly !== true,
      maxToolIteration: 25,
      systemMessage: '',
      modelId,
      modelName: modelId === null ? null : `model-${modelId}`,
    }
  })
  return { agents, caps: CAPS, findings }
}

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

function chatDoneFrame() {
  return 'event: done\ndata: {"tokens":12,"took":1.5,"ttft":0.4,"decode":1.1}\n\n'
}

// A body useChat's reader loop accepts: one chunk holding the frame, then the
// stream ends (jsdom has no ReadableStream, so this is the minimal shape).
function sseBody(text) {
  const bytes = new TextEncoder().encode(text)
  let delivered = false
  return {
    getReader() {
      return {
        async read() {
          if (delivered) return { done: true, value: undefined }
          delivered = true
          return { done: false, value: bytes }
        },
      }
    },
  }
}

// The routes a conversation touches. `modes: null` makes the list fetch fail,
// and every posted /api/chat body lands in `sent`.
function stubRoutes({ modes = modesBody(), sent = [] } = {}) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const key = String(url)
    if (key.startsWith('/api/agents')) {
      return modes === null ? jsonResponse({}, false, 500) : jsonResponse(modes)
    }
    if (key.startsWith('/api/chat')) {
      sent.push(JSON.parse(init.body))
      return { ok: true, body: sseBody(chatDoneFrame()) }
    }
    throw new Error(`unexpected fetch: ${key}`)
  })
}

function resetAll() {
  chat.phase = 'idle'
  chat.messages = []
  chat.error = null
  chat.pausePending = false
  chat.session.startedAt = 0
  chat.pendingImage = null
  chat.mcp = { connectors: [], enabled: {}, loaded: false, locked: false, restarting: false }
  chat.lsp = { servers: [], enabled: {}, loaded: false, locked: false, restarting: false }
  batch.active = false
  batch.status = 'idle'
  appShell.activeTab = 'chat'
  agentModes.modes = []
  agentModes.current = null
  agentModes.loaded = false
  agentModes.findings = []
  agentModes.notice = null
  const editor = useAgentModes().editor
  editor.loading = false
  editor.saving = false
  editor.readError = null
  editor.writeError = null
  editor.serverFindings = []
  // The agent is a **tab** thing now (§5.5 rule 26), so a fresh test starts on
  // `sessionStorage` — the storage the selection actually lives in. Clearing
  // only `localStorage` would let the previous case's choice leak in.
  window.sessionStorage.clear()
}

async function typeAndSend(text) {
  const { setDraft, send } = useChat()
  setDraft(text)
  await send()
}

describe('loadAgentModes: seeding and degrading', () => {
  beforeEach(resetAll)

  it('seeds current from the first agent, the store having no default', async () => {
    stubRoutes()
    await loadAgentModes()
    expect(agentModes.loaded).toBe(true)
    expect(agentModes.current).toBe('code')
    expect(currentMode().label).toBe('Code')
    expect(agentModePayloadId()).toBe('code')
  })

  it('a failed refresh hides nothing and changes nothing', async () => {
    stubRoutes()
    await loadAgentModes()
    setAgentMode('architect')
    stubRoutes({ modes: null })
    await loadAgentModes()
    // `loaded` is false, so send() omits the key — which since D5 is a 422 from
    // the server rather than a fallback, and task 12 turns that into a disabled
    // Send. The selection is not silently downgraded, and the previous list
    // survives for the label.
    expect(agentModes.loaded).toBe(false)
    expect(agentModesLoaded()).toBe(false)
    expect(agentModes.current).toBe('architect')
    expect(agentModePayloadId()).toBeNull()
    expect(modeHint('architect')).toBe('Architect — MCP available')
  })

  it('a plain refresh keeps a choice the list still offers', async () => {
    stubRoutes()
    await loadAgentModes()
    setAgentMode('chat')
    await loadAgentModes()
    expect(agentModes.current).toBe('chat')
  })

  it('the store findings become one quiet line', async () => {
    stubRoutes({
      modes: modesBody({
        findings: [
          { kind: 'error', message: "The agent 'x' holds label as null" },
          { kind: 'error', message: "The agent 'y' names model 9, which the store does not hold" },
        ],
      }),
    })
    await loadAgentModes()
    expect(findingsLine()).toContain('2 problems')
  })
})

describe('the remembered agent (D5, §5.4)', () => {
  beforeEach(resetAll)

  it('restores the agent the user last chose, over the list order', async () => {
    stubRoutes()
    await loadAgentModes()
    setAgentMode('architect')
    expect(rememberedAgentId()).toBe('architect')

    // A reload: nothing in memory, and the fetch answers the same list.
    agentModes.modes = []
    agentModes.current = null
    agentModes.loaded = false
    await loadAgentModes()
    expect(agentModes.current).toBe('architect')
  })

  it('falls back to the first entry when the remembered id names a gone agent', async () => {
    rememberAgent('deleted-long-ago')
    stubRoutes()
    await loadAgentModes()
    expect(agentModes.current).toBe('code')
  })

  it('a session file\'s agentMode wins over the remembered one on resume', async () => {
    rememberAgent('architect')
    stubRoutes()
    await loadAgentModes()
    expect(agentModes.current).toBe('architect')
    applySessionAgentMode('chat')
    expect(agentModes.current).toBe('chat')
    // ...and the choice the file made becomes the remembered one, because the
    // user is now working in it.
    expect(rememberedAgentId()).toBe('chat')
  })

  // The requirement of this task (spec D5, §5.5 rule 26): the remembered agent
  // is **the tab's**, so it lives where the tab's folder lives.
  it('writes the remembered id to sessionStorage, never to localStorage', async () => {
    stubRoutes()
    await loadAgentModes()
    setAgentMode('architect')

    expect(window.sessionStorage.getItem(AGENT_STORAGE_KEY)).toBe('architect')
    expect(window.localStorage.getItem(AGENT_STORAGE_KEY)).toBeNull()
    expect(rememberedAgentId()).toBe('architect')
  })

  // A value an older build left browser-wide is **not** inherited: the new key is
  // a new place, and reading the old one would re-share a choice this lot exists
  // to make per tab.
  it('does not read a localStorage value from an older build', async () => {
    window.localStorage.setItem(AGENT_STORAGE_KEY, 'architect')
    window.localStorage.setItem('nojae:agent-mode', 'architect')
    stubRoutes()
    await loadAgentModes()

    expect(rememberedAgentId()).toBeNull()
    expect(agentModes.current).toBe('code')
  })

  it("forgets the choice when the tab's storage is cleared", async () => {
    rememberAgent('architect')
    window.sessionStorage.clear()
    expect(rememberedAgentId()).toBeNull()
  })

  it('tolerates a storage that throws, on both ends', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'sessionStorage')
    Object.defineProperty(window, 'sessionStorage', {
      value: {
        getItem: () => {
          throw new Error('storage blocked')
        },
        setItem: () => {
          throw new Error('storage blocked')
        },
        removeItem: () => {
          throw new Error('storage blocked')
        },
      },
      configurable: true,
    })
    try {
      expect(rememberedAgentId()).toBeNull()
      expect(() => rememberAgent('architect')).not.toThrow()
      expect(() => rememberAgent(null)).not.toThrow()
    } finally {
      Object.defineProperty(window, 'sessionStorage', original)
    }
  })
})

describe('the payload of a real send', () => {
  beforeEach(resetAll)

  it('carries agentMode with the selected id', async () => {
    const sent = []
    stubRoutes({ sent })
    await loadAgentModes()
    setAgentMode('chat')
    await typeAndSend('hello')
    expect(sent).toHaveLength(1)
    expect(sent[0].agentMode).toBe('chat')
    // The hub allowlists keep their own omission rule (their snapshots never
    // loaded here), so the mode key did not drag them along.
    expect('mcpEnabled' in sent[0]).toBe(false)
  })

  it('refuses to post at all when the list failed to load', async () => {
    // The composer cannot name an agent it has not read, and D5 removed the
    // server-side default the old send leaned on — so there is no request to
    // make and none is made (task 12).
    const sent = []
    stubRoutes({ sent, modes: null })
    await loadAgentModes()
    await typeAndSend('hello')
    expect(sent).toHaveLength(0)
    expect(chat.messages).toHaveLength(0)
    // The draft survives the refused send, so the user can retry once the list
    // loads rather than losing what they typed.
    expect(chat.draft.raw).toBe('hello')
  })

  it('refuses to post when the selected agent has no model', async () => {
    const sent = []
    stubRoutes({ sent, modes: modesBody({ models: { chat: null } }) })
    await loadAgentModes()
    setAgentMode('chat')
    await typeAndSend('hello')
    expect(sent).toHaveLength(0)
    expect(chat.messages).toHaveLength(0)
    expect(chat.draft.raw).toBe('hello')
  })

  // Two tabs, each answering as its own agent (§5.5 rules 25–26, spec §1.2).
  //
  // **The second tab is simulated by resetting this module's state and handing
  // the storage the two tabs would each hold.** A jsdom test has one `window`
  // and therefore one `sessionStorage`, so it cannot have two real tabs — the
  // real two-tab run is the e2e suite's (task 12). What is asserted here is the
  // part the unit suite *can* own: the payload each tab posts carries the id
  // its own storage held, and one tab's choice never reaches the other's.
  it('two tabs post two different agentMode ids, and neither reads the other', async () => {
    const sent = []
    stubRoutes({ sent })

    // Tab A: it picks Architect from its own dropdown and sends.
    await loadAgentModes()
    setAgentMode('architect')
    await typeAndSend('from A')
    expect(rememberedAgentId()).toBe('architect')
    const tabAStorage = window.sessionStorage.getItem(AGENT_STORAGE_KEY)

    // A second tab starts with **no** memory of its own: fresh module state, and
    // a storage holding none of A's key. It lands on the list's first entry.
    agentModes.modes = []
    agentModes.current = null
    agentModes.loaded = false
    window.sessionStorage.removeItem(AGENT_STORAGE_KEY)
    await loadAgentModes()
    expect(agentModes.current).toBe('code')
    setAgentMode('chat')
    await typeAndSend('from B')
    expect(rememberedAgentId()).toBe('chat')

    expect(sent.map((body) => body.agentMode)).toEqual(['architect', 'chat'])

    // Tab A comes back (a reload of the *same* tab): its own storage answers, not
    // the value B left behind.
    window.sessionStorage.setItem(AGENT_STORAGE_KEY, tabAStorage)
    agentModes.modes = []
    agentModes.current = null
    agentModes.loaded = false
    await loadAgentModes()
    expect(agentModes.current).toBe('architect')
  })
})

describe('the lock is gone (D5/§4.4)', () => {
  // The five cases that used to live here — "the reserved agent is enterable,
  // then not leaveable once the thread turned", "entering it on a thread that
  // already turned locks at once", "a reset unlocks", "a real send locks it",
  // and "the options are disabled while locked" — are **deleted, not
  // rewritten**: they asserted a behaviour §4.4 removes, and a rewritten version
  // of a test for deleted behaviour is how a feature comes back. What replaces
  // them is the positive assertion below, so the removal is pinned too.
  beforeEach(resetAll)

  it('any agent is switchable after the thread has turned, including the app-owned one', async () => {
    stubRoutes()
    await loadAgentModes()
    // A real thread: two turns are on the conversation, and nothing freezes.
    chat.messages = [
      { role: 'user', raw: 'one turn', html: '', images: [] },
      { role: 'assistant', raw: 'one reply', html: '', images: [] },
    ]
    for (const id of ['chat', 'code', 'architect', RESERVED_ID, 'code']) {
      setAgentMode(id)
      expect(agentModes.current).toBe(id)
      expect(modeSelectDisabled(false)).toBe(false)
    }
    // ...into and out of the app-owned agent, which is the case the lock was
    // invented for and which §4.4 shows no lot ever depended on.
    setAgentMode(RESERVED_ID)
    expect(agentModePayloadId()).toBe(RESERVED_ID)
    setAgentMode('chat')
    expect(agentModePayloadId()).toBe('chat')
  })

  it('a running lot still freezes the select — the one disabling rule left', async () => {
    stubRoutes()
    await loadAgentModes()
    expect(modeSelectDisabled(true)).toBe(true)
    expect(modeSelectDisabled(false)).toBe(false)
  })

  it('unknown ids are refused, so the select can never invent an agent', async () => {
    stubRoutes()
    await loadAgentModes()
    setAgentMode('nope')
    expect(agentModes.current).toBe('code')
  })
})

describe('can the selected agent run? (§5.4, §5.5)', () => {
  beforeEach(resetAll)

  it('reads the row\'s own modelId, and answers false for no selection', async () => {
    expect(selectedAgentCanRun()).toBe(false) // nothing read yet
    stubRoutes()
    await loadAgentModes()
    expect(selectedAgentCanRun()).toBe(true)
  })

  it('an agent with no model cannot run — the warning and the Send gate agree', async () => {
    stubRoutes({ modes: modesBody({ models: { chat: null } }) })
    await loadAgentModes()
    setAgentMode('chat')
    expect(selectedAgentCanRun()).toBe(false)
    setAgentMode('code')
    expect(selectedAgentCanRun()).toBe(true)
  })

  it('the same answer for any row a caller holds', () => {
    expect(agentCanRun({ modelId: 3 })).toBe(true)
    expect(agentCanRun({ modelId: null })).toBe(false)
    expect(agentCanRun(null)).toBe(false)
  })
})

describe('the hub gate (D4)', () => {
  beforeEach(resetAll)

  it('each hub is off exactly for the agents whose flag is false', async () => {
    stubRoutes()
    await loadAgentModes()
    setAgentMode('chat')
    expect(modeBlocksHub('mcp')).toBe(true)
    expect(modeBlocksHub('lsp')).toBe(true)
    setAgentMode('architect')
    expect(modeBlocksHub('mcp')).toBe(false)
    expect(modeBlocksHub('lsp')).toBe(true)
    setAgentMode('code')
    expect(modeBlocksHub('mcp')).toBe(false)
    expect(modeBlocksHub('lsp')).toBe(false)
  })

  it('no gate at all when the list never loaded', async () => {
    stubRoutes({ modes: null })
    await loadAgentModes()
    expect(currentMode()).toBeNull()
    expect(modeBlocksHub('mcp')).toBe(false)
    expect(modeBlocksHub('lsp')).toBe(false)
  })

  it('a stale list gates nothing either — the payload carries no agent', async () => {
    stubRoutes()
    await loadAgentModes()
    setAgentMode('chat')
    expect(modeBlocksHub('mcp')).toBe(true)
    // The refresh failed, so this client no longer knows what the next turn
    // would gate.
    stubRoutes({ modes: null })
    await loadAgentModes()
    expect(agentModes.current).toBe('chat') // still shown, never downgraded
    expect(modeBlocksHub('mcp')).toBe(false)
    expect(modeBlocksHub('lsp')).toBe(false)
  })

  // The reason is a tooltip only: the panel keeps no inline sentence about the
  // gate, so the row's `title` is where the agent that took the hub is named.
  it('the MCP panel renders its switches inert with a tooltip reason, not hidden', async () => {
    stubRoutes()
    await loadAgentModes()
    setAgentMode('chat')
    seedMcpSnapshot()
    const wrapper = mount(WorkBenchMcpPanel)
    expect(wrapper.find('.chat-mcp-panel').exists()).toBe(true)
    expect(wrapper.get('input[role="switch"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('.chat-hub-gate').exists()).toBe(false)
    expect(wrapper.get('.chat-mcp-row').attributes('title')).toContain('Chat')
    wrapper.unmount()
  })

  it('the same panel is live for an agent that opens the hub', async () => {
    stubRoutes()
    await loadAgentModes()
    setAgentMode('code')
    seedMcpSnapshot()
    const wrapper = mount(WorkBenchMcpPanel)
    expect(wrapper.get('input[role="switch"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })
})

function seedMcpSnapshot() {
  chat.mcp.loaded = true
  chat.mcp.connectors = [{ id: 'fedit', label: 'File editor', status: 'running' }]
  chat.mcp.enabled = { fedit: true }
}

describe('the mode hint', () => {
  beforeEach(resetAll)

  it('names the hubs the agent can reach — the UI sentence about gating', async () => {
    stubRoutes()
    await loadAgentModes()
    expect(modeHint('code')).toBe('Code — MCP and language servers available')
    expect(modeHint('chat')).toBe('Chat — no tools')
    expect(modeHint('architect')).toBe('Architect — MCP available')
  })

  it('the select explains a running lot, and says nothing about a fixed mode', async () => {
    stubRoutes()
    await loadAgentModes()
    expect(modeSelectTitle()).toBe('Code — MCP and language servers available')
    batch.active = true
    expect(modeSelectTitle({ batchActive: true })).toContain(
      'a running lot keeps the agent it launched with',
    )
    batch.active = false
    // No agent locks any more (§4.4), so the tooltip has no fixed-mode sentence
    // to add: "a message describing behaviour that no longer happens is worse
    // than no message".
    setAgentMode(RESERVED_ID)
    chat.messages = [{ role: 'user', raw: 'one turn', html: '', images: [] }]
    expect(modeSelectTitle({ batchActive: false })).toBe('Reserved — MCP available')
  })
})

describe('the session envelope', () => {
  beforeEach(resetAll)

  it('saves the agent and reads it back', async () => {
    stubRoutes()
    await loadAgentModes()
    setAgentMode('architect')
    chat.messages = [
      { role: 'user', raw: 'plan it', html: '', images: [] },
      { role: 'assistant', raw: 'here is the spec', html: '', images: [] },
    ]
    const doc = conversationJson(chat.messages)
    expect(doc.version).toBe(SESSION_FILE_VERSION)
    expect(doc.agentMode).toBe('architect')
    const parsed = parseSessionFile(JSON.stringify(doc))
    expect(parsed.agentMode).toBe('architect')
    applySessionAgentMode(parsed.agentMode)
    expect(agentModes.current).toBe('architect')
    expect(agentModes.notice).toBeNull()
  })

  it('a v3 file parses with no agentMode and keeps the agent it had', async () => {
    stubRoutes()
    await loadAgentModes()
    const v3 = {
      format: 'nojae-chat-session',
      version: 3,
      messages: [{ role: 'user', content: 'older conversation' }],
    }
    const parsed = parseSessionFile(JSON.stringify(v3))
    expect(parsed.agentMode).toBeNull()
    applySessionAgentMode(parsed.agentMode)
    expect(agentModes.current).toBe('code')
    expect(agentModes.notice).toBeNull()
  })

  it('an agent unknown to this installation falls back to the first, out loud', async () => {
    stubRoutes()
    await loadAgentModes()
    applySessionAgentMode('reviewer')
    expect(agentModes.current).toBe('code')
    expect(agentModes.notice).toContain('"reviewer"')
  })

  it('a saved agent with no list to judge it against is still said out loud', async () => {
    stubRoutes({ modes: null })
    await loadAgentModes()
    applySessionAgentMode('code')
    expect(agentModes.current).toBeNull() // nothing was ever seeded
    expect(agentModes.notice).toContain('could not be read')
    // And the payload keeps omitting the key, so the server would 422 — which is
    // why task 12 refuses the send instead.
    expect(agentModePayloadId()).toBeNull()
  })

  it('a restored thread in the reserved agent restores the selection, not a lock', async () => {
    stubRoutes()
    await loadAgentModes()
    chat.messages = [{ role: 'user', raw: 'x', html: '', images: [] }]
    applySessionAgentMode(RESERVED_ID)
    expect(agentModes.current).toBe(RESERVED_ID)
    expect(modeSelectDisabled(false)).toBe(false)
  })

  it('a save with no loaded list carries no agentMode key', () => {
    chat.messages = [{ role: 'user', raw: 'x', html: '', images: [] }]
    const doc = conversationJson(chat.messages)
    expect('agentMode' in doc).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// The editor's rules, over **the agent list itself** (§5.2, §5.5).
//
// The file-shaped cases are gone with the file: there is no document to read, no
// `mtime` token, no conflict, no "saving will create this file" and no
// server-side default agent (D5, §4.7). What survives is the vocabulary no file
// ever owned — the slug, the id field's read-only-while-new rule, the persona
// counter — adapted to rows, plus the rules a row needs instead.
// ---------------------------------------------------------------------------

function draftOf(body = modesBody()) {
  return createAgentDraft(body)
}

describe('slugForModeId', () => {
  it('from a plain label', () => {
    expect(slugForModeId('Reviewer', [], CAPS)).toBe('reviewer')
  })

  it('from a label with punctuation', () => {
    expect(slugForModeId('Docs Review (v2)!', [], CAPS)).toBe('docs-review-v2')
    expect(slugForModeId('  Spaced   Out  ', [], CAPS)).toBe('spaced-out')
  })

  it('colliding with an existing id gains a suffix', () => {
    expect(slugForModeId('Reviewer', ['reviewer'], CAPS)).toBe('reviewer-2')
    expect(slugForModeId('Reviewer', ['reviewer', 'reviewer-2'], CAPS)).toBe('reviewer-3')
  })

  it('stays within the payload cap, suffix included', () => {
    const long = 'x'.repeat(80)
    const slug = slugForModeId(long, [], CAPS)
    expect(slug.length).toBeLessThanOrEqual(CAPS.maxIdChars)
    // A collision at the cap cannot push the id past it: the base gives up its
    // tail for the suffix.
    const taken = [slug]
    const next = slugForModeId(long, taken, CAPS)
    expect(next.length).toBeLessThanOrEqual(CAPS.maxIdChars)
    expect(taken).not.toContain(next)
  })

  it('follows a patched cap, not a literal', () => {
    const caps = { ...CAPS, maxIdChars: 8 }
    expect(slugForModeId('Reviewer Of Docs', [], caps)).toHaveLength(8)
  })

  it('produces an id the payload pattern accepts, even from a label that cannot start one', () => {
    for (const label of ['2 Fast', 'Ünicode Näme', '', '---']) {
      const slug = slugForModeId(label, [], CAPS)
      expect(slug, `label ${JSON.stringify(label)}`).toMatch(new RegExp(CAPS.idPattern))
    }
  })

  it('slugForDraft judges against the ids the draft already holds', () => {
    expect(slugForDraft(draftOf(), 'Code')).toBe('code-2')
  })
})

describe('the draft is the agent list', () => {
  beforeEach(resetAll)

  it('one entry per row, with the fields the tab renders', () => {
    const draft = draftOf()
    expect(draft.entries.map((entry) => entry.id)).toEqual([
      'code', 'chat', 'architect', RESERVED_ID,
    ])
    expect(draft.entries[0]).toMatchObject({
      isNew: false,
      label: 'Code',
      mcpEnable: true,
      lspEnable: true,
      modelId: 1,
      readonly: false,
      deletable: true,
    })
    // The app-owned row is readonly and not deletable — two flags, both data.
    expect(draft.entries[3].readonly).toBe(true)
    expect(draft.entries[3].deletable).toBe(false)
  })

  it('an entry carries no file vocabulary', () => {
    const draft = draftOf()
    expect(draft).not.toHaveProperty('mtime')
    expect(draft).not.toHaveProperty('default')
    expect(draft).not.toHaveProperty('source')
    expect(draft).not.toHaveProperty('baseline')
  })
})

describe('the id field', () => {
  beforeEach(resetAll)

  it('an existing agent id is read-only while a new one is editable', () => {
    const draft = draftOf()
    expect(idEditableFor(draft.entries[0])).toBe(false)
    // The new agent is the creation form, not an entry of the list (D4).
    expect(idEditableFor(creationFormFor(draft))).toBe(true)
  })

  it('a new id is judged against the pattern, the cap and the other ids', () => {
    const draft = draftOf()
    const created = creationFormFor(draft)
    created.label = 'Reviewer'
    created.id = slugForDraft(draft, 'Reviewer')
    expect(idValidityProblem(draft, created)).toBeNull()
    created.id = 'Reviewer' // uppercase: the pattern wants a lowercase start
    expect(idValidityProblem(draft, created)).toContain('must match')
    created.id = 'x'.repeat(33)
    expect(idValidityProblem(draft, created)).toContain('at most 32')
    created.id = 'code'
    expect(idValidityProblem(draft, created)).toContain('already used')
    created.id = 'reviewer'
    expect(idValidityProblem(draft, created)).toBeNull()
  })

  it('an existing entry is never judged by the id rule — its id is immutable', () => {
    const draft = draftOf()
    expect(idValidityProblem(draft, draft.entries[1])).toBeNull()
  })

  it('a readonly agent has no editable id either', () => {
    const draft = draftOf()
    expect(idEditableFor(draft.entries[3])).toBe(false)
  })
})

describe('the persona counter', () => {
  beforeEach(resetAll)

  it('counts UTF-8 bytes, not characters', () => {
    expect(personaByteCount('ascii')).toBe(5)
    expect(personaByteCount('héllo wörld')).toBe(13) // two 2-byte letters
    expect(personaByteCount('日本語')).toBe(9) // three 3-byte letters
    expect(personaByteCount('')).toBe(0)
  })

  it('over the cap makes the save click refuse, and the verdict follows the payload', () => {
    const draft = draftOf()
    const text = 'a'.repeat(CAPS.maxPersonaBytes + 1)
    expect(personaOverByteCap(draft, text)).toBe(true)
    draft.entries[0].personaText = text
    expect(saveRefusalFor(draft, draft.entries[0])).toContain('system prompt')
    expect(entryProblems(draft, draft.entries[0])[0].field).toBe('systemMessage')

    // Patch the cap in the payload: the same text is fine under a bigger one, so
    // the rule is the payload's number and not a literal in this file.
    const roomy = draftOf(modesBody())
    roomy.caps = { ...CAPS, maxPersonaBytes: 32768 }
    roomy.entries[0].personaText = text
    expect(personaOverByteCap(roomy, text)).toBe(false)
    expect(saveRefusalFor(roomy, roomy.entries[0])).toBeNull()
  })
})

describe('the tool-iteration cap (D9)', () => {
  beforeEach(resetAll)

  it('accepts the floor and every larger number — no ceiling', () => {
    const draft = draftOf()
    expect(toolIterationProblem(draft, 1)).toBeNull()
    expect(toolIterationProblem(draft, 500)).toBeNull()
    expect(toolIterationProblem(draft, 0)).toContain('at least 1')
    expect(toolIterationProblem(draft, 1.5)).toContain('whole number')
  })

  it('follows a patched floor, not a literal', () => {
    const draft = draftOf()
    draft.caps = { ...CAPS, minToolIteration: 4 }
    expect(toolIterationProblem(draft, 3)).toContain('at least 4')
    expect(toolIterationProblem(draft, 4)).toBeNull()
  })

  it('a below-floor value in a row makes the save click refuse', () => {
    const draft = draftOf()
    draft.entries[0].maxToolIteration = 0
    expect(saveRefusalFor(draft, draft.entries[0])).toContain('Max tool iterations')
    expect(entryProblems(draft, draft.entries[0])[0].field).toBe('maxToolIteration')
    draft.entries[0].maxToolIteration = 1
    expect(saveRefusalFor(draft, draft.entries[0])).toBeNull()
  })

  it('an empty field is a problem, and the payload never posts a 0 for it', () => {
    const draft = draftOf()
    // Vue's `.number` keeps a cleared number input as `''`; a payload that never
    // carried the field arrives as null. Both mean "no value", not zero.
    for (const empty of ['', null, undefined]) {
      expect(toolIterationProblem(draft, empty)).toBe(
        'Max tool iterations must be a whole number.',
      )
      const entry = { ...draft.entries[0], maxToolIteration: empty }
      expect(agentWritePayload(entry)).not.toHaveProperty('maxToolIteration')
    }
    expect(toolIterationProblem(draft, 0)).toContain('at least 1')
    const entry = { ...draft.entries[0], maxToolIteration: 5 }
    expect(agentWritePayload(entry).maxToolIteration).toBe(5)
  })
})

describe('the form-level problems (§5.2)', () => {
  beforeEach(resetAll)

  it('each problem names the field it is about, and the refusal says it', () => {
    const draft = draftOf()
    draft.entries[0].label = ''
    expect(entryProblems(draft, draft.entries[0])).toEqual([
      { field: 'label', message: 'A label is required.' },
    ])
    expect(saveRefusalFor(draft, draft.entries[0])).toContain('A label is required.')
    draft.entries[0].label = 'Code'
    expect(saveRefusalFor(draft, draft.entries[0])).toBeNull()
  })

  it('a duplicate label is refused before the server sees it', () => {
    const draft = draftOf()
    draft.entries[1].label = 'Code'
    const problems = entryProblems(draft, draft.entries[1])
    expect(problems[0].field).toBe('label')
    expect(problems[0].message).toContain('already labelled')
  })

  it('a label over the payload cap is refused, and a stored over-cap row is marked', () => {
    const draft = draftOf()
    draft.entries[0].label = 'x'.repeat(CAPS.maxLabelChars)
    expect(saveRefusalFor(draft, draft.entries[0])).toBeNull()

    draft.entries[0].label = 'x'.repeat(CAPS.maxLabelChars + 1)
    expect(entryProblems(draft, draft.entries[0])).toContainEqual({
      field: 'label',
      message: `The label must be at most ${CAPS.maxLabelChars} characters.`,
    })
    expect(saveRefusalFor(draft, draft.entries[0])).toContain(
      `at most ${CAPS.maxLabelChars}`,
    )

    // The number is the payload's, not a literal: a roomier cap accepts the same
    // label, and a tighter one refuses a label that was fine.
    const roomy = draftOf()
    roomy.caps = { ...CAPS, maxLabelChars: 80 }
    roomy.entries[0].label = 'x'.repeat(80)
    expect(saveRefusalFor(roomy, roomy.entries[0])).toBeNull()
  })

  it('a readonly agent is never judged — only its model is the user\'s', () => {
    const draft = draftOf()
    // A readonly row whose label is empty and whose cap is nonsense: nojae
    // re-asserts those on the next boot (D4), so the form does not refuse them.
    draft.entries[3].label = ''
    draft.entries[3].maxToolIteration = -5
    expect(entryProblems(draft, draft.entries[3])).toEqual([])
    expect(saveRefusalFor(draft, draft.entries[3])).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The save slot's two answers, and the card's one message (D1, D11).
//
// The rework splits what used to be one verdict: *may the slot be clicked at
// all* is `writeBlockedFor`, and *why did this click write nothing* is
// `saveRefusalFor`. Keeping them apart is the decision (Q2), so they are judged
// apart — a case that let the form's completeness back into the enablement would
// be the rework undone.
// ---------------------------------------------------------------------------

describe('writeBlockedFor: the save slot\'s enablement and nothing else (D1)', () => {
  beforeEach(resetAll)

  it('is inert only with nothing to act on, or a write in flight', () => {
    const draft = draftOf()
    expect(writeBlockedFor(draft.entries[0])).toBe(false)
    expect(writeBlockedFor(null)).toBe(true)
    expect(writeBlockedFor(draft.entries[0], { saving: true })).toBe(true)
  })

  it('an incomplete form does **not** disable it — that is the refusal\'s answer', () => {
    const draft = draftOf()
    draft.entries[0].label = ''
    draft.entries[0].maxToolIteration = 0
    expect(entryProblems(draft, draft.entries[0]).length).toBeGreaterThan(0)
    expect(writeBlockedFor(draft.entries[0])).toBe(false)
    expect(saveRefusalFor(draft, draft.entries[0])).toContain('must be completed')
  })

  it('names what is missing, in one sentence', () => {
    const draft = draftOf()
    draft.entries[0].label = ''
    draft.entries[0].maxToolIteration = 0
    const refusal = saveRefusalFor(draft, draft.entries[0])
    expect(refusal).toContain('A label is required.')
    expect(refusal).toContain('at least 1')
    // One sentence, not a list the line would have to lay out.
    expect(refusal.split('\n')).toHaveLength(1)
  })
})

describe('deleteSlotFor: the delete verb always explains itself (D1)', () => {
  beforeEach(resetAll)

  it('is live for a user-created row, and its tooltip is its name', () => {
    const draft = draftOf()
    const scribe = { id: 'scribe', isNew: false, deletable: true }
    expect(deleteSlotFor(scribe)).toEqual({ disabled: false, label: 'Delete agent' })
    expect(deleteSlotFor(draft.entries[0]).disabled).toBe(false)
  })

  it('is inert with a reason for each of the three cases', () => {
    const draft = draftOf()
    expect(deleteSlotFor(null).disabled).toBe(true)
    // §6.10's "nothing selected": the reason names the missing selection, which
    // is a different truth from a row that cannot be deleted — and it is the
    // slot's tooltip, never the message line's business (D11).
    expect(deleteSlotFor(null).label).toContain('Select an agent')
    expect(deleteSlotFor(creationFormFor(draft))).toMatchObject({
      disabled: true,
    })
    // The reason is the one that says nothing is stored to delete yet.
    expect(deleteSlotFor(creationFormFor(draft)).label).toContain('before it can be deleted')
    expect(deleteSlotFor(draft.entries[0], { saving: true })).toMatchObject({
      disabled: true,
    })
    // Every reason is a sentence, never an empty tooltip: a disabled control
    // always says why.
    for (const entry of [null, draft.entries[3], draft.entries[0]]) {
      expect(deleteSlotFor(entry, { saving: true }).label.length).toBeGreaterThan(0)
    }
    // The app-owned row is refused by its flag, and no id is named.
    expect(deleteSlotFor(draft.entries[3]).label).toContain('nojae owns')
  })
})

// ---------------------------------------------------------------------------
// The toolbar's five slots (§5), the two confirmation pairs, the per-entry
// baseline and the close verdict (D1, D5, D7, D8, D11).
//
// Every row of §5's table is one case below, so a row that later loses its
// answer fails here rather than in a template that had to invent one. These are
// the verdicts task 03 wires into the toolbar; nothing the user sees changes
// yet, which is exactly what "the component decides nothing" buys.
// ---------------------------------------------------------------------------

describe('the toolbar slots: every row of §5 answered (D1, D5)', () => {
  beforeEach(resetAll)

  it('every slot is inert when nothing has been read', () => {
    const draft = draftOf()
    const gone = { loaded: false }
    expect(addSlotFor(gone).disabled).toBe(true)
    expect(saveSlotFor(draft.entries[0], gone).disabled).toBe(true)
    expect(deleteSlotFor(draft.entries[0], gone).disabled).toBe(true)
    // And each says why, in the one value that is also its accessible name.
    for (const slot of [
      addSlotFor(gone),
      saveSlotFor(draft.entries[0], gone),
      deleteSlotFor(draft.entries[0], gone),
    ]) {
      expect(slot.label.length).toBeGreaterThan(0)
    }
  })

  it('a stored agent selected, untouched: add live, save live, delete by its flag', () => {
    const draft = draftOf()
    expect(addSlotFor()).toEqual({ disabled: false, label: 'Add agent' })
    expect(saveSlotFor(draft.entries[0])).toEqual({ disabled: false, label: 'Save agent' })
    // Delete is the row's flag's answer, and nothing else about this state.
    expect(deleteSlotFor(draft.entries[0])).toEqual({ disabled: false, label: 'Delete agent' })
    const scribe = { id: 'scribe', isNew: false, deletable: true }
    expect(deleteSlotFor(scribe)).toEqual({ disabled: false, label: 'Delete agent' })
  })

  it('a stored agent selected, edited, no problems: all three still live', () => {
    const draft = draftOf()
    draft.entries[0].label = 'Coder'
    draft.entries[0].personaText = 'You edit files.'
    expect(addSlotFor().disabled).toBe(false)
    expect(saveSlotFor(draft.entries[0])).toEqual({ disabled: false, label: 'Save agent' })
    const scribe = { id: 'scribe', isNew: false, deletable: true }
    expect(deleteSlotFor(scribe).disabled).toBe(false)
  })

  it('a form holding a problem keeps Save **live** — the click refuses instead (D11)', () => {
    const draft = draftOf()
    draft.entries[0].label = ''
    draft.entries[0].maxToolIteration = 0
    expect(entryProblems(draft, draft.entries[0]).length).toBeGreaterThan(0)
    expect(saveSlotFor(draft.entries[0])).toEqual({ disabled: false, label: 'Save agent' })
    // The refusal is a separate answer, for the message line.
    expect(saveRefusalFor(draft, draft.entries[0])).toContain('must be completed')
  })

  it('the app-owned row: Save is inert until its model changes, live after', () => {
    const draft = draftOf()
    const reserved = draft.entries[3]
    expect(reserved.readonly).toBe(true)
    expect(writeBlockedFor(reserved)).toBe(true)
    expect(saveSlotFor(reserved).disabled).toBe(true)
    expect(saveSlotFor(reserved).label).toContain('model')
    // The one field the user owns there: change it and the slot has something to
    // offer. Judged off the row's flag and its baseline, never off an id.
    expect(modelUnchangedFor(reserved)).toBe(true)
    reserved.modelId = 99
    expect(modelUnchangedFor(reserved)).toBe(false)
    expect(writeBlockedFor(reserved)).toBe(false)
    expect(saveSlotFor(reserved)).toEqual({ disabled: false, label: 'Save agent' })
    // Add stays live there: the row being app-owned says nothing about creating.
    expect(addSlotFor().disabled).toBe(false)
    // And the delete slot still refuses it by its flag.
    expect(deleteSlotFor(reserved).label).toContain('nojae owns')
  })

  it('the app-owned exception is **only** its model — no other field unlocks it', () => {
    const draft = draftOf()
    const reserved = draft.entries[3]
    reserved.label = 'Something else'
    reserved.personaText = 'typed into a locked field'
    reserved.maxToolIteration = 99
    expect(writeBlockedFor(reserved)).toBe(true)
  })

  it('"nothing selected" is two states: creation mode has a live Save, an empty list has none', () => {
    const draft = draftOf()
    const creation = creationFormFor(draft)
    // creation mode: a form with no row
    expect(saveSlotFor(creation, { creating: true })).toEqual({
      disabled: false,
      label: 'Save agent',
    })
    expect(deleteSlotFor(creation, { creating: true }).disabled).toBe(true)
    expect(addSlotFor({ creating: true }).disabled).toBe(true)
    expect(addSlotFor({ creating: true }).label).toContain('Already adding')
  })

  it('the list came back empty: add is live, save is inert — there is no form to type into', () => {
    // The other half of "nothing selected", which must never be collapsed with
    // creation mode: this is a read that answered **nothing**, so there is no
    // form for Save to write and no row for Delete to act on.
    expect(addSlotFor({ loaded: true })).toEqual({ disabled: false, label: 'Add agent' })
    expect(saveSlotFor(null, { loaded: true }).disabled).toBe(true)
    expect(saveSlotFor(null, { loaded: true }).label).toContain('no agent selected')
    expect(deleteSlotFor(null, { loaded: true }).disabled).toBe(true)
  })

  it('a write in flight makes every verb inert', () => {
    const draft = draftOf()
    const scribe = { id: 'scribe', isNew: false, deletable: true }
    const flying = { saving: true }
    expect(addSlotFor(flying).disabled).toBe(true)
    expect(saveSlotFor(draft.entries[0], flying).disabled).toBe(true)
    expect(deleteSlotFor(scribe, flying).disabled).toBe(true)
    expect(deleteConfirmationFor(scribe, { ...flying, confirming: true }).cancel.disabled).toBe(true)
    expect(deleteConfirmationFor(scribe, { ...flying, confirming: true }).confirm.disabled).toBe(true)
  })

  it('while a save is in flight the slot\'s name and its tooltip are both `Saving…`', () => {
    const draft = draftOf()
    // One value is read as both, so the pair cannot move apart: a case that let
    // the name say `Save agent` while the tooltip said `Saving…` (or the other
    // way) would fail here, which is the difference between an honest label and
    // a screen reader disagreeing with a hover (§6.16).
    const flying = saveSlotFor(draft.entries[0], { saving: true })
    expect(flying).toEqual({ disabled: true, label: 'Saving…' })
    expect(flying.label).toBe('Saving…')
    // When the write lands, both go back together.
    expect(saveSlotFor(draft.entries[0], { saving: false })).toEqual({
      disabled: false,
      label: 'Save agent',
    })
  })

  it('a pending delete confirmation makes the three verbs inert and the pair live', () => {
    const draft = draftOf()
    const scribe = { id: 'scribe', isNew: false, deletable: true }
    const pending = { confirming: true }
    expect(addSlotFor(pending).disabled).toBe(true)
    expect(saveSlotFor(scribe, pending).disabled).toBe(true)
    expect(deleteSlotFor(scribe, pending).disabled).toBe(true)
    const pair = deleteConfirmationFor(scribe, pending)
    expect(pair.rendered).toBe(true)
    expect(pair.cancel).toEqual({ disabled: false, label: 'Cancel delete' })
    expect(pair.confirm).toEqual({ disabled: false, label: 'Confirm delete' })
  })

  it('a pending close confirmation makes the three verbs inert, and the pair is never inert', () => {
    const draft = draftOf()
    const pending = { closing: true }
    expect(addSlotFor(pending).disabled).toBe(true)
    expect(saveSlotFor(draft.entries[0], pending).disabled).toBe(true)
    expect(deleteSlotFor(draft.entries[0], pending).disabled).toBe(true)
    const pair = closeConfirmationFor(pending)
    expect(pair.rendered).toBe(true)
    expect(pair.cancel).toEqual({ disabled: false, label: 'Keep editing' })
    expect(pair.confirm).toEqual({ disabled: false, label: 'Discard and close' })
    // The close pair has no `Saving…` state: both answers can always be given.
    expect(closeConfirmationFor({ closing: true, saving: true })).toEqual(pair)
    // ...and §5's row says the *delete* pair is not rendered here: a close is
    // what the card is asking about, so the toolbar's right slots stay empty.
    expect(deleteConfirmationFor(draft.entries[0], pending).rendered).toBe(false)
  })
})

describe('the confirmation pairs are absent, not hidden (§6.17)', () => {
  beforeEach(resetAll)

  it('the delete pair answers `rendered: false` until a delete is being confirmed', () => {
    const scribe = { id: 'scribe', isNew: false, deletable: true }
    expect(deleteConfirmationFor(scribe, {})).toEqual({
      rendered: false,
      cancel: null,
      confirm: null,
    })
    expect(deleteConfirmationFor(scribe, { confirming: false }).rendered).toBe(false)
    // Nothing to confirm for a row that cannot be deleted, even if asked.
    expect(deleteConfirmationFor({ id: 'code', isNew: false, deletable: false }, { confirming: true }).rendered).toBe(false)
  })

  it('the close pair answers `rendered: false` until a close is being confirmed', () => {
    expect(closeConfirmationFor({})).toEqual({ rendered: false, cancel: null, confirm: null })
    expect(closeConfirmationFor({ closing: false }).rendered).toBe(false)
  })
})

describe('the creation form (D4)', () => {
  beforeEach(resetAll)

  it('holds an empty form at the payload\'s floor, with no model and both switches off', () => {
    const draft = draftOf()
    const creation = creationFormFor(draft)
    expect(creation.label).toBe('')
    expect(creation.personaText).toBe('')
    expect(creation.mcpEnable).toBe(false)
    expect(creation.lspEnable).toBe(false)
    expect(creation.modelId).toBeNull()
    expect(creation.modelName).toBeNull()
    // The tool loop starts at the floor the **payload** publishes, never a
    // literal here: patch the cap and the form follows it.
    expect(creation.maxToolIteration).toBe(CAPS.minToolIteration)
    const raised = draftOf()
    raised.caps = { ...CAPS, minToolIteration: 7 }
    expect(creationFormFor(raised).maxToolIteration).toBe(7)
  })

  it('an empty label yields the neutral placeholder id, still correctable', () => {
    const draft = draftOf()
    const creation = creationFormFor(draft)
    expect(creation.id).toBe('agent')
    expect(creation.id).toMatch(new RegExp(CAPS.idPattern))
    // Shown and editable exactly as a new agent's id is today.
    expect(idEditableFor(creation)).toBe(true)
  })

  it('carries the flags that make delete inert for it, so no second branch is needed', () => {
    const draft = draftOf()
    const creation = creationFormFor(draft)
    expect(creation.isNew).toBe(true)
    expect(creation.deletable).toBe(false)
    expect(creation.readonly).toBe(false)
    expect(deleteOfferedFor(creation)).toBe(false)
    expect(deleteSlotFor(creation, { creating: true }).disabled).toBe(true)
    expect(saveSlotFor(creation, { creating: true }).disabled).toBe(false)
  })

  it('the creation state is a verdict: a form held with no row', () => {
    expect(creationActiveFor(null)).toBe(false)
    expect(creationActiveFor(creationFormFor(draftOf()))).toBe(true)
  })
})

describe('successorAfterDelete: next, else previous, else nothing (D7.5)', () => {
  beforeEach(resetAll)

  it('picks the next row in the order it is given', () => {
    const draft = draftOf()
    expect(successorAfterDelete(draft.entries, draft.entries[0])).toBe(draft.entries[1])
    expect(successorAfterDelete(draft.entries, draft.entries[1])).toBe(draft.entries[2])
  })

  it('falls back to the previous one when the deleted row was last', () => {
    const draft = draftOf()
    const last = draft.entries[draft.entries.length - 1]
    expect(successorAfterDelete(draft.entries, last)).toBe(draft.entries[draft.entries.length - 2])
  })

  it('answers nothing when the list comes back empty, or holds only the deleted row', () => {
    const draft = draftOf()
    expect(successorAfterDelete([], draft.entries[0])).toBeNull()
    const only = [draft.entries[0]]
    expect(successorAfterDelete(only, only[0])).toBeNull()
    expect(successorAfterDelete(null, null)).toBeNull()
  })

  it('adds no ordering of its own — the order it is given is the order it uses', () => {
    const draft = draftOf()
    const reversed = [...draft.entries].reverse()
    // The same row, a different list order, a different successor: the store's
    // order is the server's, and this function never re-sorts.
    expect(successorAfterDelete(reversed, reversed[0])).toBe(reversed[1])
  })
})

describe('the per-entry baseline, and closeWouldLoseFor (D8)', () => {
  beforeEach(resetAll)

  it('every entry carries the baseline the store answered with', () => {
    const draft = draftOf()
    expect(draft.entries[0].baseline).toEqual({
      label: 'Code',
      maxToolIteration: 25,
      mcpEnable: true,
      lspEnable: true,
      personaText: '',
      modelId: 1,
    })
    // The read and both writes build their draft the same way, so a write
    // re-baselines on the store's answer rather than on what was sent.
    const written = createAgentDraft(modesBody())
    expect(written.entries[0].baseline).toEqual(draft.entries[0].baseline)
  })

  it('is false for a freshly read entry, true after a keystroke, true in creation mode', () => {
    const draft = draftOf()
    expect(closeWouldLoseFor(draft.entries[0])).toBe(false)
    draft.entries[0].label = 'Coder'
    expect(closeWouldLoseFor(draft.entries[0])).toBe(true)
    // ...and back to false when the keystroke is undone: the question is whether
    // closing loses something, not whether a key was ever pressed.
    draft.entries[0].label = 'Code'
    expect(closeWouldLoseFor(draft.entries[0])).toBe(false)
    // Every field the form holds, and nothing the store owns.
    for (const field of ['maxToolIteration', 'mcpEnable', 'lspEnable', 'personaText', 'modelId']) {
      const entry = draftOf().entries[0]
      entry[field] = entry[field] === 'x' ? 'y' : 'x'
      expect(closeWouldLoseFor(entry), field).toBe(true)
    }
    expect(closeWouldLoseFor(null, { creating: true })).toBe(true)
    expect(closeWouldLoseFor(creationFormFor(draft), { creating: true })).toBe(true)
    expect(closeWouldLoseFor(null)).toBe(false)
  })

  it('the card-level reading asks every form the card holds, not just the selected one', () => {
    const draft = draftOf()
    // Nothing typed anywhere: closing loses nothing, so `Close` costs no click.
    expect(closeWouldLoseForDraft(draft)).toBe(false)
    // A keystroke in a row the user has since left behind is still work that
    // leaving would throw away — the card holds one form per agent, so the guard
    // asks about all of them and not just the selected one.
    draft.entries[2].personaText = 'typed and not saved'
    expect(closeWouldLoseForDraft(draft)).toBe(true)
    // ...and back to false when the keystroke is undone.
    draft.entries[2].personaText = ''
    expect(closeWouldLoseForDraft(draft)).toBe(false)
    // Creation mode is always unsaved work, with no entries to compare at all.
    expect(closeWouldLoseForDraft(draft, { creating: true })).toBe(true)
    expect(closeWouldLoseForDraft(null, { creating: true })).toBe(true)
    // A card that read nothing has nothing to lose.
    expect(closeWouldLoseForDraft(null)).toBe(false)
    expect(closeWouldLoseForDraft({ entries: [] })).toBe(false)
  })

  it('the baseline is **never** consulted by a save verdict (Q2)', () => {
    const draft = draftOf()
    // An untouched, fully-stored agent: closing loses nothing, and re-saving it
    // is still allowed — there is no `Nothing to save` state and no dirty gate.
    expect(closeWouldLoseFor(draft.entries[0])).toBe(false)
    expect(writeBlockedFor(draft.entries[0])).toBe(false)
    expect(saveSlotFor(draft.entries[0])).toEqual({ disabled: false, label: 'Save agent' })
    // And the reverse: an entry whose baseline says it differs is judged by
    // nothing of the sort on the save path.
    draft.entries[0].label = 'Coder'
    expect(closeWouldLoseFor(draft.entries[0])).toBe(true)
    expect(writeBlockedFor(draft.entries[0])).toBe(false)
    // The one row where the baseline does reach the save slot is the app-owned
    // one, and only through its **model** — see `modelUnchangedFor`, which reads
    // that field alone.
    const reserved = draft.entries[3]
    reserved.personaText = 'not the model'
    expect(modelUnchangedFor(reserved)).toBe(true)
    expect(writeBlockedFor(reserved)).toBe(true)
  })
})

// A write answers the whole list and the card adopts it (D6) — but it holds one
// form per agent, so adopting the answer verbatim would throw away what the user
// typed in an agent the write did not touch. `rebaselinedDraft` is the seam.
describe('rebaselinedDraft: a write re-baselines without discarding another agent\'s typing (D6, §6.18)', () => {
  beforeEach(resetAll)

  it('puts back every field the user had changed in an untouched row', () => {
    const held = draftOf()
    held.entries[1].label = 'Chatting'
    held.entries[1].personaText = 'typed and not saved'
    held.entries[1].mcpEnable = true
    held.entries[1].maxToolIteration = 99

    const next = createAgentDraft(modesBody())
    const merged = rebaselinedDraft(next, held, 'code')

    expect(merged.entries[1]).toMatchObject({
      label: 'Chatting',
      personaText: 'typed and not saved',
      mcpEnable: true,
      maxToolIteration: 99,
    })
  })

  it('leaves an untouched row exactly as the store answered it', () => {
    const held = draftOf()
    const next = createAgentDraft(modesBody())
    const merged = rebaselinedDraft(next, held, 'code')
    expect(merged.entries[2]).toEqual(next.entries[2])
  })

  it('the agent that was written shows the store\'s answer, not what was sent', () => {
    const held = draftOf()
    held.entries[0].label = 'Coder'
    held.entries[0].personaText = 'what was posted'
    // The store's answer kept the old label (a refusal, a re-asserted built-in).
    const answer = modesBody()
    const merged = rebaselinedDraft(createAgentDraft(answer), held, 'code')
    expect(merged.entries[0].label).toBe('Code')
    expect(merged.entries[0].personaText).toBe('')
  })

  it('every re-baselined row still carries the store\'s fresh baseline', () => {
    const held = draftOf()
    held.entries[1].label = 'Chatting'
    const merged = rebaselinedDraft(createAgentDraft(modesBody()), held, 'code')
    // The typing survived, and the baseline is still the store's — which is what
    // keeps the close guard's question honest after a save.
    expect(merged.entries[1].label).toBe('Chatting')
    expect(merged.entries[1].baseline.label).toBe('Chat')
    expect(closeWouldLoseFor(merged.entries[1])).toBe(true)
  })

  it('a row whose model was put back keeps the name of that model', () => {
    const held = draftOf()
    held.entries[1].modelId = 9
    held.entries[1].modelName = 'model-9'
    const merged = rebaselinedDraft(createAgentDraft(modesBody()), held, 'code')
    expect(merged.entries[1].modelId).toBe(9)
    expect(merged.entries[1].modelName).toBe('model-9')
  })

  it('answers the same draft for nothing to merge', () => {
    const next = createAgentDraft(modesBody())
    expect(rebaselinedDraft(next, [], 'code')).toBe(next)
    expect(rebaselinedDraft(null, [], 'code')).toBeNull()
  })
})

describe('messageFor: the card\'s one message, by fixed priority (D11)', () => {
  const editor = useAgentModes().editor
  beforeEach(resetAll)

  it('says nothing when there is nothing to say, and still answers a role', () => {
    const draft = draftOf()
    expect(messageFor(draft, draft.entries[0])).toEqual({ text: '', role: 'status' })
    // A card with no draft at all (a read that failed) is the same shape.
    expect(messageFor(null, null).text).toBe('')
  })

  it('a write in flight outranks every other truth', () => {
    const draft = draftOf()
    draft.entries[0].label = ''
    editor.serverFindings = [{ kind: 'error', message: 'the store refused' }]
    editor.saving = true
    expect(messageFor(draft, draft.entries[0])).toEqual({ text: 'Saving…', role: 'status' })
  })

  it('a read in flight is progress too, and a write in flight outranks it', () => {
    // D11's two progress messages: the read's is here because it is the card's
    // only way to say "this empty form is a read still happening" (D4.4).
    editor.loading = true
    expect(messageFor(null, null)).toEqual({ text: 'Reading the agents…', role: 'status' })
    editor.saving = true
    expect(messageFor(null, null)).toEqual({ text: 'Saving…', role: 'status' })
  })

  it('a refusal from the store outranks the incomplete-form sentence', () => {
    const draft = draftOf()
    draft.entries[0].label = ''
    editor.serverFindings = [{ kind: 'error', message: 'Cannot change agent. nojae owns it.' }]
    expect(messageFor(draft, draft.entries[0])).toEqual({
      text: 'Cannot change agent. nojae owns it.',
      role: 'alert',
    })
    // The same branch for a validation body, which lands in writeError.
    editor.serverFindings = []
    editor.writeError = 'label: already exists.'
    expect(messageFor(draft, draft.entries[0])).toEqual({
      text: 'label: already exists.',
      role: 'alert',
    })
  })

  it('the incomplete-form sentence outranks a read failure', () => {
    const draft = draftOf()
    draft.entries[0].label = ''
    editor.readError = 'Could not read the agents (500).'
    expect(messageFor(draft, draft.entries[0])).toMatchObject({ role: 'status' })
    expect(messageFor(draft, draft.entries[0]).text).toContain('A label is required.')
  })

  it('a read failure outranks the read\'s findings', () => {
    const draft = draftOf({ ...modesBody(), findings: [{ kind: 'error', message: 'row x is odd' }] })
    editor.readError = 'Could not reach the API: TypeError'
    expect(messageFor(draft, draft.entries[0])).toEqual({
      text: 'Could not reach the API: TypeError',
      role: 'alert',
    })
  })

  it('the loader\'s and the server\'s findings are said as one message', () => {
    const draft = draftOf({ ...modesBody(), findings: [{ kind: 'error', message: 'row x is odd' }] })
    const message = messageFor(draft, draft.entries[0])
    expect(message.role).toBe('alert')
    expect(message.text).toContain('row x is odd')
    editor.serverFindings = [{ kind: 'error', message: 'the store refused' }]
    // (Through the refusal branch above, which is where a refused write's
    // sentence belongs — still one line, never two.)
    expect(messageFor(draft, draft.entries[0]).text).toBe('the store refused')
  })

  it('the line clears when its cause goes away', () => {
    const draft = draftOf()
    draft.entries[0].label = ''
    expect(messageFor(draft, draft.entries[0]).text).toContain('must be completed')
    draft.entries[0].label = 'Code'
    expect(messageFor(draft, draft.entries[0]).text).toBe('')
  })
})

describe('the two flags the client renders from (§4.4, D4)', () => {
  beforeEach(resetAll)

  it('fieldsDisabledFor answers from `readonly` alone', () => {
    const draft = draftOf()
    expect(fieldsDisabledFor(draft.entries[0])).toBe(false)
    expect(fieldsDisabledFor(draft.entries[3])).toBe(true)
    // A hand-built row with neither flag is editable: the default is "the user's".
    expect(fieldsDisabledFor({})).toBe(false)
  })

  it('deleteOfferedFor answers from `deletable`, and never for an unsaved row', () => {
    const draft = draftOf()
    expect(deleteOfferedFor(draft.entries[0])).toBe(true)
    expect(deleteOfferedFor(draft.entries[3])).toBe(false)
    // The creation form is the unsaved row (D4): it is not in the list at all.
    expect(deleteOfferedFor(creationFormFor(draft))).toBe(false)
  })

  it('removing an entry drops it from the draft, and nothing else', () => {
    const draft = draftOf()
    const code = draft.entries[0]
    expect(removeAgentFromDraft(draft, code)).toBe(true)
    expect(draft.entries.map((entry) => entry.id)).toEqual([
      'chat', 'architect', RESERVED_ID,
    ])
    expect(removeAgentFromDraft(draft, code)).toBe(false)
  })
})

describe('a tab\'s caption', () => {
  it('follows the Label field, falling back to the id', () => {
    expect(tabCaptionFor({ id: 'code', label: 'Code' })).toBe('Code')
    expect(tabCaptionFor({ id: 'code', label: '  ' })).toBe('code')
    expect(tabCaptionFor(null)).toBe('')
  })
})

describe('the model dropdown (§5.2)', () => {
  const servers = [
    { id: 1, name: 'Local', models: [{ id: 10, name: 'llama' }, { id: 11, name: 'qwen' }] },
    { id: 2, name: 'Remote', models: [{ id: 20, name: 'gpt' }] },
    { id: 3, name: 'Empty', models: [] },
  ]

  it('groups every configured model by the server that names it', () => {
    expect(modelChoices(servers)).toEqual([
      { server: 'Local', models: [{ id: 10, name: 'llama' }, { id: 11, name: 'qwen' }] },
      { server: 'Remote', models: [{ id: 20, name: 'gpt' }] },
    ])
    expect(modelChoices(null)).toEqual([])
  })

  it('the quiet line names the server and the model, or the cannot-run wording', () => {
    expect(modelLineFor({ modelId: 20 }, servers)).toBe('Remote · gpt')
    // The same wording the dropdown's empty option carries: one fact, one
    // sentence.
    expect(modelLineFor({ modelId: null }, servers)).toBe(NO_MODEL_LABEL)
    // A model the catalogue no longer holds is the same refusal (D7).
    expect(modelLineFor({ modelId: 999, modelName: 'gone' }, servers)).toBe(NO_MODEL_LABEL)
    expect(modelLineFor(null, servers)).toBeNull()
  })
})

describe('the editor\'s three calls', () => {
  beforeEach(resetAll)

  function stubEditor(overrides = {}) {
    const calls = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const key = String(url)
      calls.push({ key, method: init?.method ?? 'GET', body: init?.body })
      const answer = overrides[key]
      if (answer === undefined) {
        if (key === '/api/agents') return jsonResponse(modesBody())
        throw new Error(`unexpected fetch: ${key}`)
      }
      return answer
    })
    return calls
  }

  it('the read adopts the same payload the dropdown reads', async () => {
    const calls = stubEditor()
    const draft = await fetchAgentDraft()
    expect(calls.map((call) => call.key)).toEqual(['/api/agents'])
    expect(draft.entries).toHaveLength(4)
    // ...and it feeds the singleton too, so the composer sees what the card does.
    expect(agentModes.loaded).toBe(true)
    expect(agentModes.modes.map((mode) => mode.id)).toContain('code')
  })

  it('a read clears a stale write failure, so a reopened card starts clean', async () => {
    const editor = useAgentModes().editor
    editor.writeError = 'Could not reach the API: Error: network down'
    stubEditor()

    const draft = await fetchAgentDraft()

    expect(draft).not.toBeNull()
    expect(editor.writeError).toBeNull()
    // The line reads the old failure *before* a read failure, so leaving it set
    // would also mask a genuine read error in the card that just opened.
    expect(messageFor(draft, draft.entries[0])).toEqual({ text: '', role: 'status' })
  })

  it('a stale write failure cannot mask a failed read', async () => {
    const editor = useAgentModes().editor
    editor.writeError = 'Could not reach the API: Error: network down'
    stubEditor({ '/api/agents': jsonResponse({}, false, 500) })

    const draft = await fetchAgentDraft()

    expect(draft).toBeNull()
    expect(editor.writeError).toBeNull()
    expect(messageFor(null, null).text).toContain('Could not read the agents')
  })

  it('a save addresses one agent and re-baselines on the whole answer', async () => {
    const saved = modesBody()
    saved.agents[0].label = 'Coder'
    const calls = stubEditor({ '/api/agents/save': jsonResponse(saved) })
    const draft = draftOf()
    draft.entries[0].label = 'Coder'
    const next = await saveAgent(draft.entries[0])
    expect(calls.map((call) => call.key)).toEqual(['/api/agents/save'])
    const body = JSON.parse(calls[0].body)
    expect(body.id).toBe('code')
    expect(body.label).toBe('Coder')
    expect(next.entries[0].label).toBe('Coder')
  })

  it('a readonly agent\'s save carries its model and nothing else', async () => {
    const calls = stubEditor({ '/api/agents/save': jsonResponse(modesBody()) })
    const draft = draftOf()
    draft.entries[3].modelId = 7
    await saveAgent(draft.entries[3])
    expect(JSON.parse(calls[0].body)).toEqual({ id: RESERVED_ID, modelId: 7 })
  })

  it('a new agent posts to add, naming its own id', async () => {
    const calls = stubEditor({ '/api/agents/add': jsonResponse(modesBody()) })
    const draft = draftOf()
    // The creation form goes straight to the write (D4): it was never appended to
    // the list, so the draft still holds only the store's rows.
    const creation = creationFormFor(draft)
    creation.label = 'Reviewer'
    creation.id = slugForDraft(draft, 'Reviewer')
    await saveAgent(creation)
    expect(calls[0].key).toBe('/api/agents/add')
    expect(JSON.parse(calls[0].body).id).toBe('reviewer')
    expect(draft.entries).toHaveLength(4)
  })

  it('a refused write keeps its sentence, and leaves the store alone', async () => {
    const detail = 'Cannot change agent \'x\'. nojae owns it.'
    const calls = stubEditor({ '/api/agents/save': jsonResponse({ detail }, false, 422) })
    const draft = draftOf()
    const next = await saveAgent(draft.entries[3])
    expect(next).toBeNull()
    expect(useAgentModes().editor.serverFindings[0].message).toBe(detail)
    expect(calls).toHaveLength(1)
  })
})

// The app-owned agent's id must never reach the client: the dialog recognises
// that agent by `readonly` alone (§4.4), so an id hardcoded in a component would
// be a second source of truth — and one that outlives a rename. The honest check
// is a scan, and it reads the id out of the Python module that owns it rather
// than restating it here (restating it would make this file a hit).
const SCANNED_EXTENSIONS = ['.js', '.vue', '.css', '.json']

function walk(dir) {
  const found = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) found.push(...walk(path))
    else if (SCANNED_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) found.push(path)
  }
  return found
}

describe('no reserved-agent id in the client', () => {
  it('web/src never contains an id agent_modes marks as reserved', () => {
    // Vitest runs from `web/`, and the jsdom environment leaves
    // `import.meta.url` non-file, so the roots are taken from the working
    // directory the way the other tests take their route paths.
    const source = readFileSync(resolve('..', 'src/core/agent_modes.py'), 'utf8')
    const declaration = /RESERVED_MODE_IDS[^=]*=\s*\(([^)]*)\)/.exec(source)
    expect(declaration, 'agent_modes.RESERVED_MODE_IDS is not readable').toBeTruthy()
    const ids = [...declaration[1].matchAll(/"([^"]+)"/g)].map((match) => match[1])
    expect(ids.length, 'no reserved id declared').toBeGreaterThan(0)

    const files = walk(join(resolve(), 'src'))
    expect(files.length, 'the scan found nothing to scan').toBeGreaterThan(0)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      for (const id of ids) {
        expect(text, `${file} mentions the reserved agent id ${id}`).not.toContain(id)
      }
    }
  })
})
