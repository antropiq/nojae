import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  NO_MODEL_LABEL,
  addAgentToDraft,
  agentCanRun,
  agentModePayloadId,
  agentModesLoaded,
  applySessionAgentMode,
  createAgentDraft,
  currentMode,
  deleteOfferedFor,
  entryProblems,
  fetchAgentDraft,
  fieldsDisabledFor,
  findingsLine,
  idEditableFor,
  idValidityProblem,
  loadAgentModes,
  modeBlocksHub,
  modeHint,
  modeSelectDisabled,
  modeSelectTitle,
  modelChoices,
  modelLineFor,
  personaByteCount,
  personaOverByteCap,
  rememberedAgentId,
  rememberAgent,
  removeAgentFromDraft,
  saveAgent,
  saveDisabledFor,
  selectedAgentCanRun,
  setAgentMode,
  slugForDraft,
  slugForModeId,
  tabCaptionFor,
  toolIterationProblem,
  useAgentModes,
} from '../src/composables/useAgentModes'
import WorkBenchMcpPanel from '../src/components/WorkBenchMcpPanel.vue'
import {
  SESSION_FILE_VERSION,
  conversationJson,
  parseSessionFile,
  useChat,
} from '../src/composables/useChat'
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
  editor.error = null
  editor.serverFindings = []
  window.localStorage.clear()
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

  it('the select explains the batch pin, and says nothing about a fixed mode', async () => {
    stubRoutes()
    await loadAgentModes()
    expect(modeSelectTitle()).toBe('Code — MCP and language servers available')
    batch.active = true
    expect(modeSelectTitle({ batchActive: true })).toContain(
      'a running batch picks its own mode',
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
    const created = addAgentToDraft(draft, 'Reviewer')
    expect(idEditableFor(created)).toBe(true)
  })

  it('a new id is judged against the pattern, the cap and the other ids', () => {
    const draft = draftOf()
    const created = addAgentToDraft(draft, 'Reviewer')
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

  it('over the cap blocks Save, and the verdict follows the payload', () => {
    const draft = draftOf()
    const text = 'a'.repeat(CAPS.maxPersonaBytes + 1)
    expect(personaOverByteCap(draft, text)).toBe(true)
    draft.entries[0].personaText = text
    expect(saveDisabledFor(draft, draft.entries[0])).toBe(true)
    expect(entryProblems(draft, draft.entries[0])[0].field).toBe('systemMessage')

    // Patch the cap in the payload: the same text is fine under a bigger one, so
    // the rule is the payload's number and not a literal in this file.
    const roomy = draftOf(modesBody())
    roomy.caps = { ...CAPS, maxPersonaBytes: 32768 }
    roomy.entries[0].personaText = text
    expect(personaOverByteCap(roomy, text)).toBe(false)
    expect(saveDisabledFor(roomy, roomy.entries[0])).toBe(false)
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

  it('a below-floor value in a row blocks Save', () => {
    const draft = draftOf()
    draft.entries[0].maxToolIteration = 0
    expect(saveDisabledFor(draft, draft.entries[0])).toBe(true)
    expect(entryProblems(draft, draft.entries[0])[0].field).toBe('maxToolIteration')
    draft.entries[0].maxToolIteration = 1
    expect(saveDisabledFor(draft, draft.entries[0])).toBe(false)
  })
})

describe('the form-level problems (§5.2)', () => {
  beforeEach(resetAll)

  it('each problem names the field it is about', () => {
    const draft = draftOf()
    draft.entries[0].label = ''
    expect(entryProblems(draft, draft.entries[0])).toEqual([
      { field: 'label', message: 'A label is required.' },
    ])
    expect(saveDisabledFor(draft, draft.entries[0])).toBe(true)
    draft.entries[0].label = 'Code'
    expect(saveDisabledFor(draft, draft.entries[0])).toBe(false)
  })

  it('a duplicate label is refused before the server sees it', () => {
    const draft = draftOf()
    draft.entries[1].label = 'Code'
    const problems = entryProblems(draft, draft.entries[1])
    expect(problems[0].field).toBe('label')
    expect(problems[0].message).toContain('already labelled')
  })

  it('a readonly agent is never judged — only its model is the user\'s', () => {
    const draft = draftOf()
    // A readonly row whose label is empty and whose cap is nonsense: nojae
    // re-asserts those on the next boot (D4), so the form does not refuse them.
    draft.entries[3].label = ''
    draft.entries[3].maxToolIteration = -5
    expect(entryProblems(draft, draft.entries[3])).toEqual([])
    expect(saveDisabledFor(draft, draft.entries[3])).toBe(false)
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
    expect(deleteOfferedFor(addAgentToDraft(draft, 'Reviewer'))).toBe(false)
  })

  it('removing an entry drops it from the draft, and nothing else', () => {
    const draft = draftOf()
    const reviewer = addAgentToDraft(draft, 'Reviewer')
    expect(draft.entries).toHaveLength(5)
    expect(removeAgentFromDraft(draft, reviewer)).toBe(true)
    expect(draft.entries.map((entry) => entry.id)).toEqual([
      'code', 'chat', 'architect', RESERVED_ID,
    ])
    expect(removeAgentFromDraft(draft, reviewer)).toBe(false)
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
    const reviewer = addAgentToDraft(draft, 'Reviewer')
    await saveAgent(reviewer)
    expect(calls[0].key).toBe('/api/agents/add')
    expect(JSON.parse(calls[0].body).id).toBe('reviewer')
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
