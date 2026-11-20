import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import ConnectorWizardDialog from '../src/components/ConnectorWizardDialog.vue'
import {
  FAMILY_LSP,
  FAMILY_MCP,
  NOT_INSTALLED,
  READY,
  close,
  open,
  select,
  useConnectorWizard,
} from '../src/composables/useConnectorWizard'
import { useAgentModes } from '../src/composables/useAgentModes'
import { useBatch } from '../src/composables/useBatch'
import { useChat } from '../src/composables/useChat'
import { useWorkspaceSession } from '../src/composables/useWorkspaceSession'

// ---------------------------------------------------------------------------
// The connector wizard's dialog, mounted for real.
//
// The component decides nothing — every sentence, every verdict and every
// disabled state is a function from `useConnectorWizard`, judged in
// `connectorWizardRules.test.js`. So this suite is about *what is on screen*:
// that the header line is on every page and no page carries a figure, that page
// 1 renders whichever list the composable loaded and starts the work only on a
// click, that the stop leaves no way on and no field anywhere, that a failure is
// its own sentence with a way to press again, that page 3 prints the member
// verbatim from a read-only block with copy as the primary action, and that no
// control in the card writes, restarts or toggles anything.
//
// The fixtures mirror the real route payloads (`GET /api/wizard/catalogue`,
// `POST /api/wizard/propose`, `POST /api/wizard/prepare`), so what renders here
// is the server's data and not a paraphrase. `fetch` is stubbed throughout: this
// file never reaches an endpoint.
//
// jsdom has no `showModal`/`close` on `<dialog>`, so both are patched on
// `Element.prototype` the way `quickOpenDialog.test.js` does — they only have to
// keep `el.open` truthful, which is all the component's watch reads.
// ---------------------------------------------------------------------------

const wizard = useConnectorWizard()
const state = wizard.state
const chat = useChat().state
const batch = useBatch().state
const modes = useAgentModes().state
const session = useWorkspaceSession().state

const ROW_WITH_MODEL = {
  id: 'chat',
  label: 'Chat',
  mcpEnable: true,
  lspEnable: true,
  modelId: 7,
  modelName: 'a model',
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
      identity: {
        name: 'Fetch',
        description: 'Fetches a page',
        docs: 'https://x.test/fetch',
      },
      member: { type: 'local', enable: true, command: ['uvx', 'mcp-server-fetch'] },
      requirements: { requires: {}, inputs: [] },
      relevance: { signals: [] },
    },
    {
      id: 'context7',
      identity: {
        name: 'context7',
        description: 'Docs lookup',
        docs: 'https://x.test/context7',
      },
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
  extensions: ['.css'],
  workspaceRoot: '${NOJAE_PATH_LOCATION}',
  evidence: 'CSS here (12 .css files) and no CSS server declared',
}

const SNIPPET = '"fetch": {\n  "type": "local",\n  "enable": true\n}'

const PREPARED = {
  family: 'mcp',
  outcome: 'ok',
  sentence: null,
  notes: [],
  declarationPath: '/w/.nojae/mcp-settings.json',
  declarationExists: true,
  id: 'fetch',
  member: {
    type: 'local',
    enable: true,
    command: ['uvx', 'mcp-server-fetch'],
  },
  snippet: SNIPPET,
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
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

// A fetch stub that answers per route, so a test names the one it cares about
// and the rest answer a plain, valid body. `calls` is what the "writes nothing"
// assertions read: no request to a hub, an fs route or a settings-store write.
function stubRoutes(overrides = {}) {
  const calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, options = {}) => {
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
  return calls
}

let host = null

function mountDialog() {
  host = document.createElement('div')
  document.body.appendChild(host)
  return mount(ConnectorWizardDialog, { attachTo: host })
}

// Walk to a page through the panel's own entry point, then read the DOM back.
async function openOn(family, prepared = PREPARED) {
  stubRoutes({ '/api/wizard/prepare': () => jsonResponse(prepared) })
  await open(family)
  await flushPromises()
}

async function walkToPrepare(family = FAMILY_MCP, prepared = PREPARED) {
  await openOn(family, prepared)
  select(state.candidates[0])
  await wizard.goOn()
  await flushPromises()
}

async function walkToApply(family = FAMILY_MCP, prepared = PREPARED) {
  await walkToPrepare(family, prepared)
  await wizard.goOn()
  await flushPromises()
}

// Every rendered string of the card, in one read: the assertion "no token and no
// cost number on any page" is over the *whole* text, not over the header alone.
function renderedText(w) {
  return w.find('dialog').text()
}

beforeEach(() => {
  Element.prototype.showModal = function showModal() {
    this.open = true
  }
  Element.prototype.close = function closeEl() {
    this.open = false
  }
  chat.phase = 'idle'
  chat.draft = { raw: '', html: '', renderedRaw: '' }
  chat.staged = []
  batch.active = false
  session.poolRefusal = null
  modes.modes = [ROW_WITH_MODEL]
  modes.current = ROW_WITH_MODEL.id
  modes.loaded = true
  state.connection = null
  state.connectionFailure = null
  close()
})

afterEach(() => {
  host?.remove()
  host = null
  document.body.querySelectorAll('dialog').forEach((el) => el.remove())
  vi.restoreAllMocks()
})

// -- the card's dialog conventions -------------------------------------------

describe('the card follows the app\'s dialog conventions', () => {
  it('is an aria-labelled dialog in the DOM before anything raises it, and closed', () => {
    const w = mountDialog()

    const dialog = w.find('dialog')
    expect(dialog.exists()).toBe(true)
    expect(dialog.element.open).toBe(false)
    // The accessible name is the title's, the way every card in this family
    // names itself.
    expect(dialog.attributes('aria-labelledby')).toBe('wizard-title')
    expect(w.find('#wizard-title').exists()).toBe(true)
    w.unmount()
  })

  it('raises and hides the element as the composable opens and closes it', async () => {
    const w = mountDialog()
    expect(w.find('dialog').element.open).toBe(false)

    await openOn(FAMILY_MCP)
    expect(w.find('dialog').element.open).toBe(true)

    close()
    await flushPromises()
    expect(w.find('dialog').element.open).toBe(false)
    w.unmount()
  })

  // Focus is kept where a keyboard user expects it: the first candidate once the
  // list arrives, then the page's own action as the walk moves — never `<body>`,
  // and never a verb that belongs to another page.
  it('keeps focus inside the card, and on the page\'s own action as it moves', async () => {
    const w = mountDialog()
    await openOn(FAMILY_MCP)
    // The list arrives after the card is up, so the first row takes the focus
    // once there is one to take.
    expect(document.activeElement).toBe(w.findAll('.wizard-candidate')[0].element)

    await w.findAll('.wizard-candidate')[0].trigger('click')
    await w.find('.wizard-continue').trigger('click')
    await flushPromises()
    // Page 2 has no list: the page's own action takes the focus.
    expect(document.activeElement).toBe(w.find('.wizard-continue').element)

    await w.find('.wizard-continue').trigger('click')
    await flushPromises()
    // Page 3's one action is copy — the primary button, not the footer's Close.
    expect(document.activeElement).toBe(w.find('.wizard-copy').element)
    w.unmount()
  })

  // A backdrop click is `Close` in every respect, so it goes through the same
  // verb: the walk is discarded and nothing is left for a re-open.
  it('treats a backdrop click as `Close`', async () => {
    const w = mountDialog()
    await walkToApply()

    await w.find('dialog').trigger('click')
    await flushPromises()

    expect(state.open).toBe(false)
    expect(wizard.snippet()).toBeNull()
    w.unmount()
  })
})

// -- every page's header line, and no numbers anywhere -----------------------

describe('the header line, and no number on any page', () => {
  const PAGES_UNDER_TEST = ['page 1', 'page 2', 'page 3']

  it.each(PAGES_UNDER_TEST)('names agent, server and model on %s', async (page) => {
    const w = mountDialog()
    if (page === 'page 1') await openOn(FAMILY_MCP)
    else if (page === 'page 2') await walkToPrepare()
    else await walkToApply()

    expect(w.find('.wizard-header').text()).toBe(
      'Wizard is running with Chat on Local server — a-model',
    )
    w.unmount()
  })

  it.each(PAGES_UNDER_TEST)('carries no token or cost figure on %s', async (page) => {
    const w = mountDialog()
    if (page === 'page 1') await openOn(FAMILY_MCP)
    else if (page === 'page 2') await walkToPrepare()
    else await walkToApply()

    const text = renderedText(w)
    // No token count, no cost figure, no rate and no timing: the wizard's model
    // calls belong to no conversation, so they enter neither the session clock
    // nor the cost badges — and the dialog shows no number at all.
    expect(text).not.toMatch(/\btokens?\b/i)
    expect(text).not.toMatch(/\bcost\b/i)
    expect(text).not.toMatch(/[$€£]\s?\d/)
    expect(text).not.toMatch(/\bt\/s\b/)
    expect(text).not.toMatch(/\b\d+(?:\.\d+)?\s?(?:s|ms|seconds?|seconds)\b/i)
    w.unmount()
  })
})

// -- page 1: the two lists, and what only a click starts ---------------------

describe('page 1 renders the list the composable loaded', () => {
  // AC-3's client half: the MCP list is the committed catalogue, and opening the
  // dialog posts nothing — no model has run for this page.
  it('shows the catalogue with each entry\'s one line, and posts nothing', async () => {
    const w = mountDialog()
    const calls = stubRoutes()
    await open(FAMILY_MCP)
    await flushPromises()

    const rows = w.findAll('.wizard-candidate')
    expect(rows.map((row) => row.find('.wizard-candidate-name').text())).toEqual([
      'Fetch',
      'context7',
    ])
    expect(rows[0].find('.wizard-candidate-line').text()).toBe('Fetches a page')

    // The catalogue was read; the two model steps were not run.
    expect(calls.some((call) => call.url.includes('/api/wizard/catalogue'))).toBe(true)
    expect(calls.some((call) => call.url.includes('/api/wizard/propose'))).toBe(false)
    expect(calls.some((call) => call.url.includes('/api/wizard/prepare'))).toBe(false)
    w.unmount()
  })

  it('shows the proposed servers with their evidence line beneath', async () => {
    const w = mountDialog()
    await openOn(FAMILY_LSP)

    const rows = w.findAll('.wizard-candidate')
    expect(rows).toHaveLength(1)
    expect(rows[0].find('.wizard-candidate-name').text()).toBe('fake-langserver')
    expect(rows[0].find('.wizard-candidate-line').text()).toContain('12 .css files')
    w.unmount()
  })

  it('starts the work on a selection, not before it', async () => {
    const w = mountDialog()
    const calls = stubRoutes()
    await open(FAMILY_MCP)
    await flushPromises()

    const button = w.find('.wizard-continue')
    expect(button.attributes('disabled')).toBeDefined()
    expect(calls.some((call) => call.url.includes('/api/wizard/prepare'))).toBe(false)

    await w.findAll('.wizard-candidate')[0].trigger('click')
    await flushPromises()

    // The row carries the chosen mark, and the one button is live.
    expect(w.findAll('.wizard-candidate')[0].attributes('aria-pressed')).toBe('true')
    expect(w.find('.wizard-continue').attributes('disabled')).toBeUndefined()

    await w.find('.wizard-continue').trigger('click')
    await flushPromises()
    expect(calls.some((call) => call.url.includes('/api/wizard/prepare'))).toBe(true)
    w.unmount()
  })
})

// -- the stop: one sentence, and nothing to type into ------------------------

describe('an empty candidate answer is a stop', () => {
  it('renders the stop sentence and the way on is gone', async () => {
    const w = mountDialog()
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
    await flushPromises()

    expect(w.findAll('.wizard-candidate')).toHaveLength(0)
    const message = w.find('.wizard-message').text()
    expect(message).toContain('Nothing offered fits this need')
    expect(message).toContain('/w/.nojae/lsp-settings.json')
    // The road ends here: no "continue", no entry, no field, no link to the JSON.
    expect(w.find('.wizard-continue').exists()).toBe(false)
    expect(w.find('input').exists()).toBe(false)
    expect(w.find('textarea').exists()).toBe(false)
    expect(renderedText(w)).not.toContain('none of these')
    w.unmount()
  })

  // AC-18: there is nowhere to type a candidate of your own, on any page.
  it('has no free-text control anywhere in the dialog', async () => {
    const w = mountDialog()
    await walkToApply()

    expect(w.find('input').exists()).toBe(false)
    expect(w.find('textarea').exists()).toBe(false)
    expect(w.find('select').exists()).toBe(false)
    // Nor a "none of these" entry, in either list.
    expect(renderedText(w)).not.toContain('none of these')
    w.unmount()
  })
})

// -- a failure is its own sentence, with a way to press again ----------------

describe('a failure is a named sentence, not an empty page', () => {
  it('renders the sentence and a way to press again, distinct from the stop', async () => {
    const w = mountDialog()
    let attempts = 0
    stubRoutes({
      '/api/wizard/propose': () => {
        attempts += 1
        return jsonResponse({
          outcome: 'failed',
          sentence: 'The model call failed: [Errno 111] Connection refused',
          proposals: [],
          notes: [],
          declarationPath: '/w/.nojae/lsp-settings.json',
        })
      },
    })
    await open(FAMILY_LSP)
    await flushPromises()

    const message = w.find('.wizard-message')
    expect(message.text()).toContain('Connection refused')
    expect(message.attributes('role')).toBe('alert')
    // Not the empty list's sentence: the two renderings differ.
    expect(message.text()).not.toContain('Nothing offered fits')

    const again = w.find('.wizard-retry')
    expect(again.exists()).toBe(true)
    await again.trigger('click')
    await flushPromises()
    expect(attempts).toBe(2)
    w.unmount()
  })
})

// -- page 2: the complete member, the readiness pair, the install line -------

describe('page 2 prepares the entry', () => {
  it('shows the complete member with every resolved value inside it', async () => {
    const w = mountDialog()
    await walkToPrepare()

    const block = w.find('.wizard-member').text()
    expect(block).toContain('"uvx"')
    expect(block).toContain('"mcp-server-fetch"')
    // The member's own halves, not a summary of them.
    expect(JSON.parse(block)).toEqual(PREPARED.member)
    w.unmount()
  })

  it('shows a not-installed candidate, flagged, with its install line', async () => {
    const w = mountDialog()
    await walkToPrepare()

    expect(w.find('.wizard-readiness').text()).toBe(NOT_INSTALLED)
    expect(w.find('.wizard-install-line').text()).toBe('npm install -g @playwright/mcp')
    expect(w.find('.wizard-hand-over').exists()).toBe(true)
    // The reasoning that shaped the member is visible, one line each.
    expect(w.find('.wizard-decisions').text()).toContain('The root is the workspace itself.')
    w.unmount()
  })

  it('says `looks installed` when nothing has to be installed', async () => {
    const w = mountDialog()
    await walkToPrepare(FAMILY_MCP, {
      ...PREPARED,
      readiness: READY,
      install: {},
      requiresInstall: false,
      program: '/usr/bin/uvx',
      searched: null,
    })

    expect(w.find('.wizard-readiness').text()).toBe(READY)
    expect(w.find('.wizard-install-line').exists()).toBe(false)
    expect(w.find('.wizard-hand-over').exists()).toBe(false)
    w.unmount()
  })

  it('shows the per-platform lines where they differ', async () => {
    const w = mountDialog()
    await walkToPrepare(FAMILY_MCP, {
      ...PREPARED,
      install: { any: 'a line', windows: 'the windows one' },
    })

    const platform = w.find('.wizard-platform-lines').text()
    expect(platform).toContain('any: a line')
    expect(platform).toContain('windows: the windows one')
    w.unmount()
  })

  // The waiting state is a status line, never a token stream (§5): the step that
  // is in flight says so, in one sentence, and the line is gone once it answers.
  it('shows one waiting line while the prepare step is in flight', async () => {
    const w = mountDialog()
    let release = null
    stubRoutes({
      '/api/wizard/prepare': () =>
        new Promise((resolve) => {
          release = () => resolve(jsonResponse(PREPARED))
        }),
    })
    await open(FAMILY_MCP)
    await flushPromises()
    await w.findAll('.wizard-candidate')[0].trigger('click')

    const pressing = w.find('.wizard-continue').trigger('click')
    await flushPromises()
    // Page 2 with its step running: one line, and a status role rather than an
    // alert, because nothing has failed.
    expect(w.find('.wizard-page--prepare').exists()).toBe(true)
    const line = w.find('.wizard-waiting')
    expect(line.text()).toContain('Preparing the entry')
    expect(line.attributes('role')).toBe('status')

    release()
    await pressing
    await flushPromises()
    expect(w.find('.wizard-waiting').exists()).toBe(false)
    w.unmount()
  })

  // AC-9: the loader's own words, on the page, before any restart.
  it('shows the loader\'s refusal here rather than after a restart', async () => {
    const verdict =
      'mcp-settings.json: entry "fetch": "command" must be a list of strings'
    const w = mountDialog()
    await walkToPrepare(FAMILY_MCP, {
      ...PREPARED,
      accepted: false,
      verdict,
      verdictNotes: ['the reach refusal applies: a local candidate cannot start here'],
      offered: false,
    })

    expect(w.find('.wizard-verdict').text()).toBe(verdict)
    expect(w.find('.wizard-notes').text()).toContain('a local candidate cannot start here')
    w.unmount()
  })

  it('hands the install line into the composer and nothing else', async () => {
    const w = mountDialog()
    await walkToPrepare()

    chat.draft.raw = ''
    await w.find('.wizard-hand-over').trigger('click')
    await flushPromises()

    // The draft, verbatim — and no message, no staged row, no turn begun.
    expect(chat.draft.raw).toBe('npm install -g @playwright/mcp')
    expect(chat.staged).toEqual([])
    expect(chat.messages).toEqual([])
    expect(chat.phase).toBe('idle')
    // No send control is reached: the composer's own textarea is not in this
    // dialog at all, so nothing here could have focused one.
    expect(w.find('textarea').exists()).toBe(false)
    w.unmount()
  })
})

// -- page 3: the member verbatim, copy as the primary action ----------------

describe('page 3 applies the member', () => {
  const DESCRIPTOR = Object.getOwnPropertyDescriptor(globalThis.navigator, 'clipboard')

  function stubClipboard(impl) {
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: vi.fn(impl) },
      configurable: true,
    })
    return globalThis.navigator.clipboard.writeText
  }

  afterEach(() => {
    if (DESCRIPTOR) Object.defineProperty(globalThis.navigator, 'clipboard', DESCRIPTOR)
    else delete globalThis.navigator.clipboard
  })

  // AC-10: the block's text **is** the payload's string, and it is read-only.
  it('prints the member verbatim from a read-only block', async () => {
    const w = mountDialog()
    await walkToApply()

    const block = w.find('.wizard-snippet')
    expect(block.find('code').text()).toBe(SNIPPET)
    // A `<pre>` holds text: there is no editable control and nothing inside it
    // but the one text node the member is.
    expect(block.element.querySelectorAll('input, textarea, button').length).toBe(0)
    expect(block.element.children).toHaveLength(1)
    expect(block.element.children[0].tagName.toLowerCase()).toBe('code')
    w.unmount()
  })

  it('makes copy the primary action and confirms only after the helper answered', async () => {
    // A clipboard the test releases itself, so "before" and "after" are two
    // states of the same press rather than two ticks of the event loop.
    let release = null
    const writeText = stubClipboard(
      () =>
        new Promise((resolve) => {
          release = resolve
        }),
    )
    const w = mountDialog()
    await walkToApply()

    const copy = w.find('.wizard-copy')
    // The primary button: the only filled one on the page, inside the primary
    // band, while every footer verb is secondary.
    expect(copy.classes()).toContain('wizard-copy')
    expect(w.find('.wizard-primary .wizard-copy').exists()).toBe(true)
    expect(w.find('.wizard-close').classes()).toContain('secondary')
    // Nothing is confirmed before the click.
    expect(copy.text()).toBe('Copy the member')

    await copy.trigger('click')
    await flushPromises()
    // The helper has not answered yet, so nothing is confirmed.
    expect(writeText).toHaveBeenCalledWith(SNIPPET)
    expect(w.find('.wizard-copy').text()).toBe('Copy the member')

    release()
    await flushPromises()
    expect(w.find('.wizard-copy').text()).toBe('Copied')
    w.unmount()
  })

  it('names the declaration file\'s absolute path and the restart sentence', async () => {
    const w = mountDialog()
    await walkToApply()

    expect(w.find('.wizard-path').text()).toContain('/w/.nojae/mcp-settings.json')
    const restart = w.find('.wizard-restart').text()
    expect(restart).toContain("panel's restart button")
    // The wizard has no restart control of its own.
    expect(restart).not.toContain('press this button')
    w.unmount()
  })

  // AC-19: a missing declaration file prints the path to create, and the block is
  // still a **member**, never a whole file.
  it('prints the path to create when the file does not exist, and still a member', async () => {
    const w = mountDialog()
    await walkToApply(FAMILY_LSP, {
      ...PREPARED,
      family: 'lsp',
      declarationPath: '/w/.nojae/lsp-settings.json',
      declarationExists: false,
    })

    const missing = w.find('.wizard-missing').text()
    expect(missing).toContain('/w/.nojae/lsp-settings.json')
    expect(missing).toContain('top level')
    // The block still opens with the entry's id, not with a file's outer braces.
    expect(w.find('.wizard-snippet code').text()).toBe(SNIPPET)
    w.unmount()
  })

  // AC-8a: the sentinel warning appears exactly when a slot carries it.
  it('shows the sentinel warning exactly when the payload says so', async () => {
    const w = mountDialog()
    await walkToApply(FAMILY_MCP, PREPARED)
    expect(w.find('.wizard-warning').exists()).toBe(false)
    w.unmount()

    const sentinel = mountDialog()
    await walkToApply(FAMILY_MCP, {
      ...PREPARED,
      valueForm: 'sentinel',
      valueWarning:
        'This entry carries __put_your_api_key_here__ in the value slot: it will ' +
        'not authenticate until that slot is replaced with your key.',
    })

    const warning = sentinel.find('.wizard-warning').text()
    expect(warning).toContain('__put_your_api_key_here__')
    expect(warning).toContain('will not authenticate until')
    // And there is no field to type a key into, anywhere.
    expect(sentinel.find('input').exists()).toBe(false)
    sentinel.unmount()
  })

  // AC-11: a duplicate id is a warning, and the snippet is still offered.
  it('shows the duplicate id as a warning and still offers the member', async () => {
    const w = mountDialog()
    await walkToApply(FAMILY_MCP, {
      ...PREPARED,
      duplicate: "'fetch' mcp-settings.json already declares an entry of that id",
    })

    expect(w.find('.wizard-warning').text()).toContain('already declares an entry of that id')
    expect(w.find('.wizard-copy').attributes('disabled')).toBeUndefined()
    expect(w.find('.wizard-snippet code').text()).toBe(SNIPPET)
    w.unmount()
  })
})

// -- close, and nothing left behind ----------------------------------------

describe('closing leaves nothing for a re-open', () => {
  it('closes on the button, and the next open starts on page 1 with no member', async () => {
    const w = mountDialog()
    await walkToApply()
    expect(w.find('.wizard-snippet').exists()).toBe(true)

    await w.find('.wizard-close').trigger('click')
    await flushPromises()
    expect(w.find('dialog').element.open).toBe(false)

    // No draft, no cached snippet: the feature has no memory by design.
    expect(wizard.snippet()).toBeNull()
    expect(state.prepared).toBeNull()
    expect(state.selected).toBeNull()

    await openOn(FAMILY_MCP)
    expect(w.find('dialog').element.open).toBe(true)
    expect(w.find('.wizard-candidates').exists()).toBe(true)
    expect(w.find('.wizard-snippet').exists()).toBe(false)
    w.unmount()
  })

  // Escape is `Close` in every respect, so it takes the same path.
  it('treats the element\'s own close as `Close`', async () => {
    const w = mountDialog()
    await walkToApply()

    await w.find('dialog').trigger('close')
    await flushPromises()

    expect(state.open).toBe(false)
    expect(wizard.snippet()).toBeNull()
    w.unmount()
  })
})

// -- nothing writes --------------------------------------------------------

describe('nothing in the dialog writes, starts or restarts anything', () => {
  it('issues no hub, fs or settings-store request through a whole walk', async () => {
    const w = mountDialog()
    const calls = stubRoutes()
    await open(FAMILY_MCP)
    await flushPromises()
    await w.findAll('.wizard-candidate')[0].trigger('click')
    await w.find('.wizard-continue').trigger('click')
    await flushPromises()
    await w.find('.wizard-continue').trigger('click')
    await flushPromises()

    for (const call of calls) {
      expect(call.url).not.toContain('/api/mcp')
      expect(call.url).not.toContain('/api/lsp')
      expect(call.url).not.toContain('/api/fs')
      expect(call.url).not.toContain('/api/settings')
      expect(call.url).not.toContain('/api/agents')
      // Page 3 issues no request at all, and this walk ended on it.
      if (call.url.includes('/api/wizard/')) {
        expect(call.url).toMatch(/\/api\/wizard\/(catalogue|connection|propose|prepare|scan)/)
      }
    }
    w.unmount()
  })

  it('holds no control that writes: no save, remember, apply, restart or toggle', async () => {
    const w = mountDialog()
    await walkToApply()

    const labels = w
      .findAll('button')
      .map((button) => `${button.text()} ${button.attributes('aria-label') ?? ''}`.toLowerCase())
    for (const label of labels) {
      expect(label).not.toContain('save')
      expect(label).not.toContain('remember')
      expect(label).not.toContain('restart')
      expect(label).not.toContain('toggle')
    }
    // The dialog's only enabled non-footer verb on page 3 is copy.
    expect(w.findAll('.wizard-page--apply button')).toHaveLength(1)
    w.unmount()
  })

  it('renders no v-html and no markdown renderer', () => {
    const source = readFileSync(
      join(resolve(), 'src', 'components', 'ConnectorWizardDialog.vue'),
      'utf8',
    )
    expect(source).not.toMatch(/v-html/)
    expect(source).not.toMatch(/lib\/markdown/)
  })
})
