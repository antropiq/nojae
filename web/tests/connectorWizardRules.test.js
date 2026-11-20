import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAgentModes, agentNoModelSentence } from '../src/composables/useAgentModes'
import { useBatch } from '../src/composables/useBatch'
import { useChat } from '../src/composables/useChat'
import {
  FAMILY_LSP,
  FAMILY_MCP,
  FAILURE_ENDPOINT_SENTENCE,
  FAILURE_NOTHING_SENTENCE,
  FAILURE_UNREADABLE_SENTENCE,
  NOT_INSTALLED,
  PAGE_APPLY,
  PAGE_CHOOSE,
  PAGE_PREPARE,
  PAGES,
  READY,
  SET_ME_UP_LABEL,
  SOURCE_CATALOGUE,
  SOURCE_PROPOSAL,
  candidateSource,
  close,
  copySlot,
  copySnippet,
  decisionLines,
  continueSlot,
  copyConfirmation,
  duplicateWarning,
  failureSentence,
  goOn,
  handOverInstall,
  handOverInstallLine,
  headerLine,
  installLine,
  installLines,
  installSlot,
  messageLine,
  missingFileSentence,
  open,
  panelGateContext,
  readinessLine,
  reset,
  restartSentence,
  retry,
  select,
  sentinelWarning,
  setMeUpSlot,
  setMeUpSlotFor,
  snippet,
  stopSentence,
  useConnectorWizard,
  valueForm,
  verdictLine,
  verdictNotes,
  waitingLine,
} from '../src/composables/useConnectorWizard'
import { useWorkspaceSession } from '../src/composables/useWorkspaceSession'
import { useSessionStats } from '../src/composables/useSessionStats'
import { useAppShell } from '../src/composables/useAppShell'

// ---------------------------------------------------------------------------
// The wizard's rules, in the idiom `useSettingsServers` and `useAgentModes`
// settled on: every verdict, every sentence and the dialog's one message are a
// plain function over plain state, and the `.vue` renders the answers.
//
// The assertions below are therefore about *this module*, not about a component:
// the gate's table row by row, the sentence set (pairwise distinct, and never
// the empty answer's), the stop that ends the road, the hand-over that fills the
// draft and nothing else, the header line that names three names and no number,
// and the loading rule — reads may retry, the two posts may not.
// ---------------------------------------------------------------------------

const chat = useChat().state
const batch = useBatch().state
const modes = useAgentModes().state
const session = useWorkspaceSession().state
const wizard = useConnectorWizard()
const state = wizard.state
const stats = useSessionStats()
const appShell = useAppShell().state

//: The dangling id is deliberately one the list holds and one it does not: a
//: selection that names no row must yield nothing, never a synthesised agent.
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
    {
      id: 'context7',
      identity: { name: 'context7', description: 'Docs lookup', docs: 'https://x.test' },
      member: {
        type: 'remote',
        enable: true,
        url: 'https://mcp.context7.com/mcp',
        headers: { CONTEXT7_API_KEY: '__put_your_api_key_here__' },
      },
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
  evidence: 'Python here (142 .py files, a pyproject.toml), and no Python server declared',
}

const PREPARED = {
  family: 'mcp',
  outcome: 'ok',
  sentence: null,
  notes: [],
  declarationPath: '/w/.nojae/mcp-settings.json',
  declarationExists: true,
  id: 'fetch',
  member: { type: 'local', enable: true, command: ['uvx', 'mcp-server-fetch'] },
  snippet: '"fetch": {\n  "type": "local"\n}',
  accepted: true,
  verdict: 'The declaration loader accepts this member.',
  verdictNotes: [],
  readiness: NOT_INSTALLED,
  program: null,
  searched: ['/usr/bin'],
  install: { any: 'npm install -g @playwright/mcp' },
  requiresInstall: true,
  decisions: ['The root is the workspace itself.'],
  duplicate: null,
  valueForm: 'none',
  valueWarning: null,
  valueFindings: [],
  offered: true,
}

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return Promise.resolve({
    ok,
    status,
    json: () => Promise.resolve(body),
  })
}

// A fetch stub that answers per route, so a test can name the one it cares about
// and leave the rest answering a plain, valid body.
function stubRoutes(overrides = {}) {
  const calls = []
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, options = {}) => {
    const text = String(url)
    calls.push({ url: text, method: options.method ?? 'GET', body: options.body })
    for (const [needle, answer] of Object.entries(overrides)) {
      if (text.includes(needle)) return answer(text, options)
    }
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
    if (text.includes('/api/wizard/prepare')) return jsonResponse(PREPARED)
    return jsonResponse({})
  })
  return { spy, calls }
}

function seedAgents(rows = [ROW_WITH_MODEL]) {
  modes.modes = rows
  modes.current = rows[0]?.id ?? null
  modes.loaded = true
}

function resetApp() {
  chat.phase = 'idle'
  chat.mcp = { connectors: [], enabled: {}, loaded: false, locked: false, restarting: false }
  chat.lsp = { servers: [], enabled: {}, loaded: false, locked: false, restarting: false }
  chat.draft = { raw: '', html: '', renderedRaw: '' }
  batch.active = false
  session.poolRefusal = null
  modes.modes = []
  modes.current = null
  modes.loaded = false
  state.connection = null
  state.connectionFailure = null
  close()
}

beforeEach(resetApp)
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

// -- the gate table, row by row (§10) -----------------------------------------

describe('the gate: only the model gates Set me up!', () => {
  // §10's five rows: each of them answers **live**, with a resolvable model.
  const liveRows = [
    ['a reply streaming on this workspace', { streaming: true }],
    ['a batch running', { batchActive: true }],
    ['toggles locked by a started conversation', { togglesLocked: true }],
    ['the active agent mode switching this hub off', { modeSwitchesHubOff: true }],
    ['a hub route that refused the workspace', { poolRefused: 'too many workspaces' }],
  ]

  it.each(liveRows)('is live while %s', (_row, extra) => {
    const slot = setMeUpSlotFor({ mode: ROW_WITH_MODEL, connection: CONNECTION, ...extra })

    expect(slot.disabled).toBe(false)
    expect(slot.label).toBe(SET_ME_UP_LABEL)
  })

  it('is live with no connection read at all, when the row can run', () => {
    // The read is an optimisation, not the rule: the row's own `modelId` answers.
    expect(setMeUpSlotFor({ mode: ROW_WITH_MODEL }).disabled).toBe(false)
  })

  // The one real gate: no resolvable model. The reason is `useAgentModes`'s own
  // sentence for that row, compared against its builder so it cannot drift — a
  // reason that reads differently in two tooltips is two reasons.
  it('is inert with the existing refusal string, built by useAgentModes itself', () => {
    const slot = setMeUpSlotFor({ mode: ROW_WITHOUT_MODEL, connection: null })

    expect(slot.disabled).toBe(true)
    expect(slot.label).toBe(agentNoModelSentence(ROW_WITHOUT_MODEL))
    // And it is not the live label: the pair moves as one.
    expect(slot.label).not.toBe(SET_ME_UP_LABEL)
  })

  it('prefers the server\'s refusal when the row names a model the app cannot reach', () => {
    const refusal =
      "Agent Chat has no model to run with: the model it names is not in nojae's settings store."
    const slot = setMeUpSlotFor({
      mode: ROW_WITH_MODEL,
      connection: { ...CONNECTION, canRun: false, refusal },
    })

    expect(slot.disabled).toBe(true)
    expect(slot.label).toBe(refusal)
  })

  // The panel's own entry point reads the app's live state and decides nothing.
  it('reads the app\'s live state for a panel, and still only the model gates it', async () => {
    seedAgents()
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => jsonResponse(CONNECTION))
    // The connection read is what makes the server's verdict available; without
    // it the row's own field answers.
    const context = panelGateContext(FAMILY_MCP)

    expect(context.mode.id).toBe('chat')
    expect(context.streaming).toBe(false)
    expect(setMeUpSlot(FAMILY_MCP).disabled).toBe(false)

    // Every §10 row, planted on the live app state, still answers live.
    chat.phase = 'streaming'
    batch.active = true
    chat.mcp.locked = true
    modes.modes = [{ ...ROW_WITH_MODEL, mcpEnable: false }]
    session.poolRefusal = 'too many workspaces'

    expect(setMeUpSlot(FAMILY_MCP).disabled).toBe(false)
    expect(setMeUpSlot(FAMILY_MCP).label).toBe(SET_ME_UP_LABEL)
  })
})

// -- the family, the pages, and what page 1 costs ------------------------------

describe('the family comes from the button, and only page 1\'s source differs', () => {
  it('opens from each panel on that family', async () => {
    seedAgents()
    stubRoutes()

    await open(FAMILY_MCP)
    expect(state.family).toBe(FAMILY_MCP)
    expect(candidateSource(state.family)).toBe(SOURCE_CATALOGUE)

    stubRoutes()
    await open(FAMILY_LSP)
    expect(state.family).toBe(FAMILY_LSP)
    expect(candidateSource(state.family)).toBe(SOURCE_PROPOSAL)
  })

  it('keeps the page order identical for both families', async () => {
    seedAgents()
    stubRoutes()
    await open(FAMILY_MCP)
    expect(state.page).toBe(PAGE_CHOOSE)

    stubRoutes()
    await open(FAMILY_LSP)
    expect(state.page).toBe(PAGE_CHOOSE)
    // The order is **data**, so the two families cannot walk different pages.
    expect(PAGES).toEqual([PAGE_CHOOSE, PAGE_PREPARE, PAGE_APPLY])
  })

  it('re-opens on the new family, discarding the unfinished walk', async () => {
    seedAgents()
    stubRoutes()
    await open(FAMILY_MCP)
    select({ id: 'fetch' })
    expect(state.selected.id).toBe('fetch')

    stubRoutes()
    await open(FAMILY_LSP)

    expect(state.family).toBe(FAMILY_LSP)
    expect(state.selected).toBeNull()
    expect(state.prepared).toBeNull()
  })

  // AC-3's client half: opening the dialog and rendering page 1's MCP list runs
  // **no model**. The catalogue is a committed file; the two posts are not sent.
  it('runs no model for the MCP list: the catalogue is fetched, the posts are not', async () => {
    seedAgents()
    const { calls } = stubRoutes()

    await open(FAMILY_MCP)

    expect(calls.some((call) => call.url.includes('/api/wizard/catalogue'))).toBe(true)
    expect(calls.some((call) => call.url.includes('/api/wizard/propose'))).toBe(false)
    expect(calls.some((call) => call.url.includes('/api/wizard/prepare'))).toBe(false)
    expect(state.candidates.map((entry) => entry.id)).toEqual(['fetch', 'context7'])
  })

  it('asks the model for the LSP list, and shows the evidence line it answered', async () => {
    seedAgents()
    const { calls } = stubRoutes()

    await open(FAMILY_LSP)

    expect(calls.some((call) => call.url.includes('/api/wizard/propose'))).toBe(true)
    expect(state.candidates).toHaveLength(1)
    expect(state.candidates[0].evidence).toContain('142 .py files')
  })

  it('names the family a third way nowhere: an unknown one opens nothing', async () => {
    expect(await open('both')).toBe(false)
    expect(state.open).toBe(false)
  })
})

// -- the three failures, the stop, and the untrusted shape ---------------------

describe('the sentences the wizard owns', () => {
  it('keeps the three failures pairwise distinct, and none of them the stop', () => {
    const sentences = [
      failureSentence('endpoint'),
      failureSentence('unreadable'),
      failureSentence('nothing'),
      stopSentence('/w/.nojae/mcp-settings.json'),
    ]

    for (let i = 0; i < sentences.length; i += 1) {
      for (let j = i + 1; j < sentences.length; j += 1) {
        expect(sentences[i]).not.toBe(sentences[j])
      }
    }
    // The named constants are what the functions answer, so a re-wording lands
    // in both places and a test cannot pass against a stale copy.
    expect(failureSentence('endpoint')).toBe(FAILURE_ENDPOINT_SENTENCE)
    expect(failureSentence('unreadable')).toBe(FAILURE_UNREADABLE_SENTENCE)
    expect(failureSentence('nothing')).toBe(FAILURE_NOTHING_SENTENCE)
  })

  // AC-7: an unreachable model is a named sentence, distinct from an empty list.
  it('renders an unreachable model as its own sentence, never as an empty list', async () => {
    seedAgents()
    stubRoutes({
      '/api/wizard/propose': () =>
        jsonResponse({
          outcome: 'failed',
          sentence: 'The model call failed: [Errno 111] Connection refused',
          proposals: [],
          notes: [],
          declarationPath: '/w/.nojae/lsp-settings.json',
        }),
    })

    await open(FAMILY_LSP)

    const message = messageLine()
    expect(message.role).toBe('alert')
    expect(message.text).toContain('Connection refused')
    // The empty-list rendering is a different state, and it is not this one.
    expect(message.text).not.toBe(stopSentence())
    expect(state.empty).toBe(false)
  })

  // AC-18: an empty answer is the stop — one sentence naming the declaration
  // file — and the dialog ends there.
  it('stops on an empty answer with the sentence naming the declaration file', async () => {
    seedAgents()
    stubRoutes({
      '/api/wizard/propose': () =>
        jsonResponse({
          outcome: 'empty',
          sentence: 'No language server found for this folder.',
          proposals: [],
          notes: [],
          declarationPath: '/w/.nojae/lsp-settings.json',
        }),
    })

    await open(FAMILY_LSP)

    expect(state.empty).toBe(true)
    expect(state.failure).toBeNull()
    expect(messageLine().text).toBe(stopSentence('/w/.nojae/lsp-settings.json'))
    expect(messageLine().text).toContain('/w/.nojae/lsp-settings.json')
  })

  it('carries the server\'s own sentence when the step answered with one', () => {
    const carried = "The model call failed: 401 Unauthorized at https://x.test/v1"

    expect(failureSentence('endpoint', carried)).toBe(carried)
    expect(failureSentence('nothing', carried)).toBe(carried)
  })

  it('leaves one message on the page, and a failure outranks a stop', () => {
    expect(messageLine().text).toBe('')
    state.empty = true
    expect(messageLine().role).toBe('status')
    state.failure = FAILURE_ENDPOINT_SENTENCE
    expect(messageLine()).toEqual({ text: FAILURE_ENDPOINT_SENTENCE, role: 'alert' })
  })

  // AC-18's other half: no state exists that could hold a hand-written
  // candidate. `select` refuses anything the list did not offer.
  it('refuses a candidate the list never offered', async () => {
    seedAgents()
    stubRoutes()
    await open(FAMILY_MCP)

    expect(select({ id: 'made-up' })).toBeNull()
    expect(state.selected).toBeNull()
    // And there is no free-text field anywhere in this module's state.
    expect(Object.keys(state)).not.toContain('candidateText')
    expect(Object.keys(state)).not.toContain('freeText')
  })
})

// -- the header line, and no numbers ------------------------------------------

describe('the header line names three names and no number', () => {
  it('names the agent, the server and the model', () => {
    expect(headerLine(CONNECTION)).toBe('Wizard is running with Chat on Local server — a-model')
  })

  it('drops a half it cannot name rather than guessing it', () => {
    expect(headerLine({ agent: 'Chat', server: null, model: null })).toBe(
      'Wizard is running with Chat',
    )
    expect(headerLine(null)).toBeNull()
    expect(headerLine({ agent: '' })).toBeNull()
  })

  // The header is on screen from the moment the dialog opens, so the connection
  // is read at open — and a read that failed is its own sentence rather than a
  // short header with no explanation.
  it('reads the connection at open, and names a read that failed', async () => {
    seedAgents()
    stubRoutes({
      '/api/wizard/connection': () =>
        jsonResponse(
          { detail: 'agentMode: unknown agent mode' },
          { ok: false, status: 422 },
        ),
    })

    await open(FAMILY_MCP)

    expect(state.connection).toBeNull()
    expect(state.connectionFailure).toBe('agentMode: unknown agent mode')
    // And the walk still proceeds: the connection is not the catalogue's gate.
    expect(state.candidates).toHaveLength(2)
    expect(messageLine()).toEqual({
      text: 'agentMode: unknown agent mode',
      role: 'alert',
    })
  })

  // AC-17: every page's rendered answer set carries no figure. The set is every
  // string this module can produce for the dialog, gathered across all three
  // pages of a real walk.
  it('carries no digit on any page', async () => {
    seedAgents()
    stubRoutes()
    await open(FAMILY_MCP)
    select({ id: 'fetch' })

    // Every string this module can put on the page, gathered from the same
    // functions the dialog renders — so a figure added anywhere in the walk fails
    // here rather than only in the header's own assertion.
    const answers = () => [
      headerLine(),
      waitingLine(),
      messageLine().text,
      stopSentence(),
      restartSentence(),
      readinessLine(),
      sentinelWarning(),
      valueForm(),
      duplicateWarning(),
      verdictLine(),
      ...verdictNotes(),
      ...decisionLines(),
      ...installLines(state.prepared?.install).map((row) => row.line),
      copyConfirmation(),
      copySlot().label,
      continueSlot().label,
      installSlot().label,
      missingFileSentence(),
    ]

    // Page 1.
    expect(state.page).toBe(PAGE_CHOOSE)
    for (const text of answers()) {
      if (text) expect(String(text)).not.toMatch(/\d/)
    }

    // Page 2.
    await goOn()
    expect(state.page).toBe(PAGE_PREPARE)
    for (const text of answers()) {
      if (text) expect(String(text)).not.toMatch(/\d/)
    }

    // Page 3.
    await goOn()
    expect(state.page).toBe(PAGE_APPLY)
    for (const text of answers()) {
      if (text) expect(String(text)).not.toMatch(/\d/)
    }
  })
})

// -- page 2 and page 3's answers ----------------------------------------------

describe('the prepared answer, as page 2 and page 3 render it', () => {
  async function walkToApply(prepared = PREPARED) {
    seedAgents()
    stubRoutes({ '/api/wizard/prepare': () => jsonResponse(prepared) })
    await open(FAMILY_MCP)
    select({ id: 'fetch' })
    await goOn()
    await goOn()
  }

  it('shows the complete member and the two readiness answers', async () => {
    await walkToApply()

    expect(snippet()).toBe(PREPARED.snippet)
    expect(readinessLine()).toBe(NOT_INSTALLED)

    reset()
    seedAgents()
    stubRoutes({
      '/api/wizard/prepare': () => jsonResponse({ ...PREPARED, readiness: READY }),
    })
    await open(FAMILY_MCP)
    select({ id: 'fetch' })
    await goOn()
    expect(readinessLine()).toBe(READY)
  })

  it('answers null for a readiness the payload did not give', () => {
    expect(readinessLine({ readiness: null })).toBeNull()
    expect(readinessLine(null)).toBeNull()
  })

  it('carries the install line, and hands the platform\'s own one over', async () => {
    await walkToApply()

    expect(installLine({ any: 'a line' }, 'posix')).toBe('a line')
    expect(installLine({ any: 'a line', posix: 'the posix one' }, 'posix')).toBe(
      'the posix one',
    )
    expect(installLines({ any: 'a line', windows: 'the windows one' })).toEqual([
      { platform: 'any', line: 'a line' },
      { platform: 'windows', line: 'the windows one' },
    ])
  })

  it('shows the sentinel warning when the payload says a slot carries it', async () => {
    await walkToApply({
      ...PREPARED,
      valueForm: 'sentinel',
      valueWarning:
        'This entry carries __put_your_api_key_here__ in the value slot: it will ' +
        'not authenticate until that slot is replaced with your key.',
    })

    expect(valueForm()).toBe('sentinel')
    expect(sentinelWarning()).toContain('will not authenticate until')
  })

  it('shows the duplicate id as a warning, and still offers the snippet', async () => {
    await walkToApply({
      ...PREPARED,
      duplicate: "'fetch' already declares an entry of that id",
    })

    expect(duplicateWarning()).toContain('already declares an entry of that id')
    expect(snippet()).toBe(PREPARED.snippet)
  })

  it('renders the loader\'s verdict in the loader\'s own words', async () => {
    const verdict =
      'lsp-settings.json: entry "broken": "workspaceRoot" must be an absolute path'
    await walkToApply({ ...PREPARED, accepted: false, verdict, offered: false })

    expect(verdictLine()).toBe(verdict)
  })

  // AC-19: a missing declaration file is a sentence plus a path, and the block
  // is still a member.
  it('prints the path to create when the declaration file does not exist', async () => {
    await walkToApply({
      ...PREPARED,
      declarationExists: false,
      declarationPath: '/w/.nojae/lsp-settings.json',
    })

    const sentence = missingFileSentence()
    expect(sentence).toContain('/w/.nojae/lsp-settings.json')
    expect(sentence).toContain('top level')
    expect(snippet()).toBe(PREPARED.snippet)

    // And nothing is said about creating a file that is already there.
    expect(missingFileSentence({ ...PREPARED, declarationExists: true })).toBeNull()
  })

  it('points at the panel\'s own restart, and never offers one of its own', async () => {
    await walkToApply()

    expect(restartSentence()).toContain('restart button')
    // No restart surface exists in this module: the sentence is the whole of it.
    const exported = Object.keys(useConnectorWizard())
    expect(exported).not.toContain('restartMcp')
    expect(exported).not.toContain('restartLsp')
    expect(exported).not.toContain('restart')
    expect(exported).not.toContain('setChatMcp')
    expect(exported).not.toContain('setChatLsp')
  })
})

// -- the hand-over fills the draft and nothing else ---------------------------

describe('the install hand-over', () => {
  it('writes the draft, verbatim, and calls no send, stage or focus function', () => {
    const composer = {
      setDraft: vi.fn(),
      send: vi.fn(),
      sendBatchTurn: vi.fn(),
      stage: vi.fn(),
      appendDraft: vi.fn(),
      registerDraftInput: vi.fn(),
    }
    const line = 'npm install -g @playwright/mcp'

    const written = handOverInstallLine(line, composer)

    expect(written).toBe(line)
    expect(composer.setDraft).toHaveBeenCalledTimes(1)
    expect(composer.setDraft).toHaveBeenCalledWith(line)
    // Everything that would turn a hand-over into an execution, spied and unused.
    expect(composer.send).not.toHaveBeenCalled()
    expect(composer.sendBatchTurn).not.toHaveBeenCalled()
    expect(composer.stage).not.toHaveBeenCalled()
    expect(composer.appendDraft).not.toHaveBeenCalled()
  })

  it('reaches the real composer\'s draft setter, and leaves its staging alone', () => {
    const composer = useChat()
    chat.draft.raw = 'something the user typed'
    chat.staged = []

    handOverInstallLine('npm install -g x', composer)

    expect(chat.draft.raw).toBe('npm install -g x')
    // Nothing staged, and no message added: the turn is the user's to send.
    expect(chat.staged).toEqual([])
    expect(chat.messages).toEqual([])
    expect(chat.phase).toBe('idle')
  })

  it('writes nothing for a page that installs nothing', async () => {
    seedAgents()
    stubRoutes({ '/api/wizard/prepare': () => jsonResponse({ ...PREPARED, install: {} }) })
    await open(FAMILY_MCP)
    select({ id: 'fetch' })
    await goOn()

    const composer = { setDraft: vi.fn() }
    expect(handOverInstall(composer)).toBeNull()
    expect(composer.setDraft).not.toHaveBeenCalled()
    expect(installSlot().disabled).toBe(true)
  })

  it('hands over the platform\'s line for the answered page', async () => {
    seedAgents()
    stubRoutes({ '/api/wizard/prepare': () => jsonResponse(PREPARED) })
    await open(FAMILY_MCP)
    select({ id: 'fetch' })
    await goOn()

    const composer = { setDraft: vi.fn() }
    expect(handOverInstall(composer)).toBe('npm install -g @playwright/mcp')
    expect(composer.setDraft).toHaveBeenCalledWith('npm install -g @playwright/mcp')
  })
})

// -- copying ------------------------------------------------------------------

describe('the copy action', () => {
  const DESCRIPTOR = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard')

  afterEach(() => {
    if (DESCRIPTOR) Object.defineProperty(globalThis.navigator, 'clipboard', DESCRIPTOR)
    else delete globalThis.navigator.clipboard
  })

  function stubClipboard(impl) {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: vi.fn(impl) },
      configurable: true,
    })
    return globalThis.navigator.clipboard.writeText
  }

  async function walkToApply() {
    seedAgents()
    stubRoutes()
    await open(FAMILY_MCP)
    select({ id: 'fetch' })
    await goOn()
    await goOn()
  }

  it('copies the member verbatim in one click, and says so', async () => {
    const writeText = stubClipboard(async () => {})
    await walkToApply()

    expect(copySlot().disabled).toBe(false)
    expect(await copySnippet()).toBe(true)

    expect(writeText).toHaveBeenCalledWith(PREPARED.snippet)
    expect(copySlot().label).toBe('Copied')
  })

  it('reports a refused copy instead of pretending', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')))
    await walkToApply()

    expect(await copySnippet()).toBe(false)
    expect(copySlot().label).toBe('Copy failed')
  })

  it('is inert when there is no member to copy', () => {
    state.prepared = null
    expect(copySlot().disabled).toBe(true)
  })
})

// -- reset, close, and re-open ------------------------------------------------

describe('no memory: reset leaves nothing behind', () => {
  it('clears the candidate, the prepared answer and the failure', () => {
    state.candidates = [{ id: 'fetch' }]
    state.selected = { id: 'fetch' }
    state.prepared = PREPARED
    state.failure = FAILURE_ENDPOINT_SENTENCE
    state.copied = true

    reset()

    expect(state.candidates).toEqual([])
    expect(state.selected).toBeNull()
    expect(state.prepared).toBeNull()
    expect(state.failure).toBeNull()
    expect(state.copied).toBeNull()
    expect(snippet()).toBeNull()
  })

  it('survives an open → close → open with no draft and no cached snippet', async () => {
    seedAgents()
    stubRoutes()
    await open(FAMILY_MCP)
    select({ id: 'fetch' })
    await goOn()
    await goOn()
    expect(snippet()).toBe(PREPARED.snippet)
    chat.draft.raw = 'typed while the dialog was open'

    close()
    expect(state.open).toBe(false)
    expect(snippet()).toBeNull()
    expect(state.prepared).toBeNull()
    expect(state.selected).toBeNull()

    stubRoutes()
    await open(FAMILY_MCP)

    expect(state.page).toBe(PAGE_CHOOSE)
    expect(state.selected).toBeNull()
    expect(state.prepared).toBeNull()
    expect(snippet()).toBeNull()
  })

  it('keeps the connection across a close, because the gate reads it', async () => {
    seedAgents()
    stubRoutes()
    await open(FAMILY_MCP)
    expect(state.connection).toEqual(CONNECTION)

    close()

    expect(state.connection).toEqual(CONNECTION)
    expect(setMeUpSlot(FAMILY_MCP).disabled).toBe(false)
  })
})

// -- one attempt for the posts, retries for the reads -------------------------

describe('the two posts get one attempt; the reads may retry', () => {
  it('issues the propose post exactly once per press, with no retry and no sleep', async () => {
    vi.useFakeTimers()
    seedAgents()
    let attempts = 0
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const text = String(url)
      if (text.includes('/api/wizard/connection')) return jsonResponse(CONNECTION)
      if (text.includes('/api/wizard/propose')) {
        attempts += 1
        return Promise.reject(new TypeError('Error in input stream'))
      }
      return jsonResponse({})
    })

    const walking = open(FAMILY_LSP)
    // Let the connection read settle, then the propose post to fail.
    await vi.advanceTimersByTimeAsync(0)
    await walking

    // One attempt: no backoff timer was ever scheduled, so advancing time finds
    // no second request.
    await vi.advanceTimersByTimeAsync(10_000)
    expect(attempts).toBe(1)
    expect(
      spy.mock.calls.filter((call) => String(call[0]).includes('/api/wizard/propose')),
    ).toHaveLength(1)
    expect(state.failure).toContain('Network unavailable')
  })

  it('issues the prepare post exactly once per press', async () => {
    seedAgents()
    let attempts = 0
    stubRoutes({
      '/api/wizard/prepare': () => {
        attempts += 1
        return Promise.resolve({
          ok: false,
          status: 422,
          json: () => Promise.resolve({ detail: 'family: unknown wizard family' }),
        })
      },
    })
    await open(FAMILY_MCP)
    select({ id: 'fetch' })

    await goOn()

    expect(attempts).toBe(1)
    expect(state.failure).toBe('family: unknown wizard family')
  })

  // A second press while the first is still in flight posts nothing: the step
  // already running owns the answer.
  it('posts nothing on a second press while the first is in flight', async () => {
    seedAgents()
    let attempts = 0
    let release = null
    stubRoutes({
      '/api/wizard/prepare': () => {
        attempts += 1
        return new Promise((resolve) => {
          release = () => resolve(jsonResponse(PREPARED))
        })
      },
    })
    await open(FAMILY_MCP)
    select({ id: 'fetch' })

    const first = goOn()
    expect(state.loading).toBe(true)
    expect(await goOn()).toBeNull()

    release()
    await first
    expect(attempts).toBe(1)
  })

  it('retries a read that dropped, because a GET costs nothing to absorb', async () => {
    seedAgents()
    vi.useFakeTimers()
    let catalogueAttempts = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation((url) => {
      const text = String(url)
      if (text.includes('/api/wizard/connection')) return jsonResponse(CONNECTION)
      if (text.includes('/api/wizard/catalogue')) {
        catalogueAttempts += 1
        if (catalogueAttempts === 1) return Promise.reject(new TypeError('Error in input stream'))
        return jsonResponse(CATALOGUE)
      }
      return jsonResponse({})
    })

    const walking = open(FAMILY_MCP)
    await vi.advanceTimersByTimeAsync(2000)
    await walking

    expect(catalogueAttempts).toBe(2)
    expect(state.candidates.map((entry) => entry.id)).toEqual(['fetch', 'context7'])
  })

  it('a failure can be pressed again, and the press is one more attempt', async () => {
    seedAgents()
    let attempts = 0
    stubRoutes({
      '/api/wizard/propose': () => {
        attempts += 1
        return jsonResponse({
          outcome: 'ok',
          sentence: null,
          proposals: [PROPOSAL],
          notes: [],
          declarationPath: '/w/.nojae/lsp-settings.json',
        })
      },
    })
    await open(FAMILY_LSP)
    expect(attempts).toBe(1)

    state.failure = FAILURE_ENDPOINT_SENTENCE
    await retry()

    expect(attempts).toBe(2)
    expect(state.failure).toBeNull()
    expect(state.candidates).toHaveLength(1)
  })

  it('runs no model at all when a catalogue read fails: the reads are not posts', async () => {
    seedAgents()
    const { calls } = stubRoutes({
      '/api/wizard/catalogue': () =>
        jsonResponse({ entries: [], notes: ['catalog-mcp.json is not readable JSON'] }),
    })

    await open(FAMILY_MCP)

    expect(state.candidates).toEqual([])
    expect(messageLine().text).toContain('not readable JSON')
    expect(calls.some((call) => call.url.includes('/api/wizard/propose'))).toBe(false)
    expect(calls.some((call) => call.url.includes('/api/wizard/prepare'))).toBe(false)
  })
})

// -- the shape of the walk ----------------------------------------------------

describe('the walk', () => {
  it('will not go on from page 1 with nothing chosen', async () => {
    seedAgents()
    stubRoutes()
    await open(FAMILY_MCP)

    expect(await goOn()).toBeNull()
    expect(state.page).toBe(PAGE_CHOOSE)
    expect(state.prepared).toBeNull()
  })

  // A waiting line is a *status line*, never a token stream (§5) — one per step,
  // and none of them on screen when nothing is running.
  it('shows one waiting line per step, and none when nothing runs', async () => {
    seedAgents()
    stubRoutes()
    expect(waitingLine()).toBeNull()

    await open(FAMILY_MCP)
    state.loading = true
    const mcpWaiting = waitingLine()
    expect(mcpWaiting).toBeTruthy()

    await open(FAMILY_LSP)
    state.loading = true
    const lspWaiting = waitingLine()
    expect(lspWaiting).toBeTruthy()
    // The two steps' lines are different sentences, because the steps differ.
    expect(lspWaiting).not.toBe(mcpWaiting)

    state.page = PAGE_PREPARE
    state.loading = true
    expect(waitingLine()).toBeTruthy()
    expect(waitingLine()).not.toBe(lspWaiting)

    state.loading = false
    expect(waitingLine()).toBeNull()
  })

  it('says why Continue is inert instead of hiding the reason', async () => {
    seedAgents()
    stubRoutes()
    await open(FAMILY_MCP)

    const noChoice = continueSlot()
    expect(noChoice.disabled).toBe(true)
    expect(noChoice.label).toContain('candidate')

    select({ id: 'fetch' })
    expect(continueSlot()).toEqual({ disabled: false, label: 'Continue' })
  })

  it('sends the catalogue entry\'s id, and never a member of its own', async () => {
    seedAgents()
    const { calls } = stubRoutes()
    await open(FAMILY_MCP)
    select({ id: 'fetch' })

    await goOn()

    const posted = calls.find((call) => call.url.includes('/api/wizard/prepare'))
    expect(posted.method).toBe('POST')
    const body = JSON.parse(posted.body)
    expect(body.family).toBe('mcp')
    expect(body.candidate).toEqual({ id: 'fetch' })
    // No member travelled: the route looks the entry up again, so a command line
    // can only ever have come from the catalogue.
    expect(JSON.stringify(body)).not.toContain('uvx')
  })

  it('walks choose → prepare → apply, and page 3 issues no request', async () => {
    seedAgents()
    const { calls } = stubRoutes()
    await open(FAMILY_MCP)
    select({ id: 'fetch' })

    await goOn()
    expect(state.page).toBe(PAGE_PREPARE)
    const afterPrepare = calls.length

    await goOn()
    expect(state.page).toBe(PAGE_APPLY)
    expect(calls.length).toBe(afterPrepare)
  })

  it('posts the workspace-scoped steps with this tab\'s folder', async () => {
    seedAgents()
    const { calls } = stubRoutes()
    session.workspace = '/w/a'
    await open(FAMILY_LSP)

    for (const call of calls) {
      if (call.url.includes('/api/wizard/propose')) {
        expect(call.url).toContain('workspace=%2Fw%2Fa')
      }
      // The installation-scoped reads name no folder: the catalogue and the
      // connection are about the install, not about a tab.
      if (call.url.includes('/api/wizard/catalogue')) {
        expect(call.url).not.toContain('workspace=')
      }
      if (call.url.includes('/api/wizard/connection')) {
        expect(call.url).not.toContain('workspace=')
      }
    }
  })

  it('turns a failed proposal into the failure sentence, never the stop', async () => {
    seedAgents()
    stubRoutes({
      '/api/wizard/propose': () =>
        jsonResponse({ outcome: 'failed', sentence: 'The model call failed: boom' }),
    })

    await open(FAMILY_LSP)

    expect(state.failure).toBe('The model call failed: boom')
    expect(state.empty).toBe(false)
    expect(messageLine().text).toBe('The model call failed: boom')
    expect(messageLine().text).not.toContain('Nothing offered fits')
  })

  it('reports a prepare that answered no member as a failure of its own', async () => {
    seedAgents()
    stubRoutes({
      '/api/wizard/prepare': () => jsonResponse({ ...PREPARED, outcome: 'failed', member: null }),
    })
    await open(FAMILY_MCP)
    select({ id: 'fetch' })

    await goOn()

    expect(state.prepared).toBeNull()
    expect(state.failure).toBe(FAILURE_NOTHING_SENTENCE)
    expect(state.empty).toBe(false)
  })
})

// -- AC-16: the wizard's model calls belong to no conversation -----------------

// A plausible `usage` on the wizard's own answers. The route never sends one (the
// model step discards the response's usage and asks the server for none), so this
// is the *worst* input: a payload shaped exactly like a chat turn's, handed to the
// client that also owns the session meters. If the wizard's step were folded into
// the session anywhere, it would be here.
const USAGE = { prompt_tokens: 1234, completion_tokens: 567, total_tokens: 1901 }

const ROUTES_CARRYING_USAGE = {
  '/api/wizard/propose': () =>
    jsonResponse({
      outcome: 'ok',
      sentence: null,
      proposals: [PROPOSAL],
      notes: [],
      declarationPath: '/w/.nojae/lsp-settings.json',
      usage: USAGE,
    }),
  '/api/wizard/prepare': () => jsonResponse({ ...PREPARED, usage: USAGE }),
}

// A conversation the meters are busy describing: an open turn, a banked span, and
// a finished reply carrying every figure the badges read. Without this the
// "untouched" assertion would be vacuously true of a blank session.
function seedLiveSession() {
  appShell.config = {
    models: [{ id: 1, name: 'm', contextWindow: 8192, supportsVision: false }],
    store: { usable: true, sentence: null },
  }
  chat.phase = 'answering'
  chat.session.startedAt = 1000
  chat.session.spentMs = 2000
  chat.messages = [
    {
      role: 'assistant',
      streaming: false,
      tokens: 100,
      took: 4,
      ttft: 1,
      decode: 3,
      contextTokens: 4000,
      tokensEstimated: false,
      contextEstimated: false,
    },
  ]
}

// Everything the app bar's clock and two badges answer right now, plus the
// conversation's own carried-over numbers. Read at a fixed instant, so the clock
// cannot move between the two readings for a reason that has nothing to do with
// the wizard.
function sessionReading(now = 9000) {
  return {
    phase: chat.phase,
    startedAt: chat.session.startedAt,
    spentMs: chat.session.spentMs,
    messages: chat.messages.length,
    replyTokens: chat.messages.map((message) => message.tokens ?? null).join(','),
    source: stats.source.value,
    running: stats.running.value,
    elapsed: stats.elapsedMs(now),
    rate: stats.rateText.value,
    context: stats.contextText.value,
  }
}

describe('the wizard spends no session: AC-16', () => {
  // Both families, because they cost different numbers of model calls (one for
  // MCP, two for LSP) and share the same rule about all of them.
  const walks = [
    ['MCP', FAMILY_MCP, 'fetch'],
    ['LSP', FAMILY_LSP, 'fake-langserver'],
  ]

  it.each(walks)(
    'leaves the session clock and both badges exactly where they were, over a whole %s walk',
    async (_label, family, candidateId) => {
      seedAgents()
      seedLiveSession()
      stubRoutes(ROUTES_CARRYING_USAGE)

      const before = sessionReading()
      expect(before.rate).not.toBe('— t/s')
      expect(before.context).not.toBe('— ctx')
      expect(before.elapsed).toBeGreaterThan(0)

      await open(family)
      select({ id: candidateId })
      await goOn()
      await goOn()

      // The walk really completed, so the reading below is about a wizard that
      // ran and not about a test that did nothing.
      expect(state.page).toBe(PAGE_APPLY)
      expect(state.prepared).toBeTruthy()
      expect(snippet()).toBeTruthy()

      expect(sessionReading()).toEqual(before)
      // The stronger form of the same claim: the wizard's figures are nowhere in
      // the state the meters read. `state.prepared` *does* hold the payload
      // verbatim — the composable stores the answer it was given and renders
      // named fields from it — so the assertion is about the session, not about
      // the wizard's own cache.
      const sessionState = JSON.stringify({
        session: chat.session,
        messages: chat.messages,
        config: appShell.config,
      })
      expect(sessionState).not.toContain('1901')
      expect(sessionState).not.toContain('1234')
      expect(sessionState).not.toContain('567')
      // And the dialog's header line stays three names and no number.
      expect(headerLine()).not.toMatch(/\d/)
    },
  )
})
