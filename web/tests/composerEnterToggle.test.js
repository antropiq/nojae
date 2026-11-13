import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import WorkBenchInput from '../src/components/WorkBenchInput.vue'
import {
  ENTER_SENDS_KEY,
  useComposerKeys,
} from '../src/composables/useComposerKeys'
import { useAgentModes, loadAgentModes } from '../src/composables/useAgentModes'
import { useBatch } from '../src/composables/useBatch'
import { useChat } from '../src/composables/useChat'

// ---------------------------------------------------------------------------
// The composer's Enter-key toggle.
//
// Default (off): Enter sends, Shift+Enter writes a newline — the behaviour the
// composer has always had. On: the pair is inverted, so a draft can be written
// and reread before it is handed to the model.
//
// Two things are asserted for every case: whether a send was *attempted* (the
// `/api/chat` fetch), and whether the keydown's default was prevented — because
// "acts as a normal Enter key" means exactly that: the textarea's own newline
// insertion is left to the browser.
// ---------------------------------------------------------------------------

const chat = useChat().state
const batch = useBatch().state
const agentModes = useAgentModes().state
const composerKeys = useComposerKeys().state

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({
    ok,
    status,
    body: null,
    json: () => Promise.resolve(body),
  })
}

// What `GET /api/agents` answers: one runnable agent is enough for a send gate
// whose "can it run" answer is true.
function agentsBody() {
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
        modelId: 1,
        modelName: 'model-1',
      },
    ],
    caps: { minToolIteration: 1, maxIdChars: 32 },
    findings: [],
  }
}

// Records every route the composer touches. `/api/chat` answers a plain
// failure: `startTurn` then drops the empty assistant turn and returns the app
// to idle, so one test's send cannot leak into the next.
function stubRoutes() {
  const calls = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const key = String(url)
    calls.push({ key, method: init?.method ?? 'GET' })
    if (key === '/api/chat') return jsonResponse({ detail: 'stubbed' }, false, 599)
    if (key === '/api/agents') return jsonResponse(agentsBody())
    return jsonResponse({}, false, 404)
  })
  return calls
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
  // The toggle is a persisted preference, so a test must not inherit the
  // previous one through either the singleton or the storage behind it.
  composerKeys.enterSends = true
  window.localStorage.clear()
}

let host = null

async function mountComposer() {
  host = document.createElement('div')
  document.body.appendChild(host)
  const wrapper = mount(WorkBenchInput, { attachTo: host })
  // The composer needs a readable agent list with a runnable agent before its
  // Send gate opens (§5.4, task 12).
  await loadAgentModes()
  await flushPromises()
  return wrapper
}

function textarea(w) {
  return w.find('textarea.chat-textarea')
}

function toggle(w) {
  return w.find('.chat-enter-mode')
}

function sendButton(w) {
  return w.find('.chat-send:not(.chat-stop)')
}

// Dispatched by hand rather than through `trigger`, because what is being
// asserted here is the event itself: `defaultPrevented` is the difference
// between "Enter was swallowed and sent" and "Enter was left to the textarea".
function pressEnter(w, { shift = false } = {}) {
  const event = new window.KeyboardEvent('keydown', {
    key: 'Enter',
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  })
  textarea(w).element.dispatchEvent(event)
  return event
}

beforeEach(() => {
  resetAll()
})

afterEach(() => {
  host?.remove()
  host = null
  vi.restoreAllMocks()
})

describe('the Enter-key toggle: default (off) keeps today\'s behaviour', () => {
  it('is off by default, and not pressed', async () => {
    stubRoutes()
    const w = await mountComposer()
    expect(composerKeys.enterSends).toBe(true)
    expect(toggle(w).attributes('aria-pressed')).toBe('false')
  })

  it('Enter sends', async () => {
    const calls = stubRoutes()
    const w = await mountComposer()
    chat.draft.raw = 'first line'

    const event = await pressEnter(w)
    await flushPromises()

    expect(calls.some((call) => call.key === '/api/chat')).toBe(true)
    expect(event.defaultPrevented).toBe(true)
  })

  it('Shift+Enter writes a newline', async () => {
    const calls = stubRoutes()
    const w = await mountComposer()
    chat.draft.raw = 'first line'

    const event = await pressEnter(w, { shift: true })
    await flushPromises()

    expect(calls.some((call) => call.key === '/api/chat')).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(chat.messages).toHaveLength(0)
  })
})

describe('the Enter-key toggle: on', () => {
  it('Enter writes a newline and sends nothing', async () => {
    const calls = stubRoutes()
    const w = await mountComposer()
    chat.draft.raw = 'first line'
    await toggle(w).trigger('click')
    expect(composerKeys.enterSends).toBe(false)

    const event = await pressEnter(w)
    await flushPromises()

    expect(calls.some((call) => call.key === '/api/chat')).toBe(false)
    expect(event.defaultPrevented).toBe(false)
    expect(chat.messages).toHaveLength(0)
    // The draft is untouched: the point of the toggle is to keep composing.
    expect(chat.draft.raw).toBe('first line')
  })

  it('Shift+Enter sends', async () => {
    const calls = stubRoutes()
    const w = await mountComposer()
    chat.draft.raw = 'first line'
    await toggle(w).trigger('click')

    const event = await pressEnter(w, { shift: true })
    await flushPromises()

    expect(calls.some((call) => call.key === '/api/chat')).toBe(true)
    expect(event.defaultPrevented).toBe(true)
  })

  it('a second click restores the default', async () => {
    stubRoutes()
    const w = await mountComposer()
    await toggle(w).trigger('click')
    expect(toggle(w).attributes('aria-pressed')).toBe('true')
    await toggle(w).trigger('click')
    expect(composerKeys.enterSends).toBe(true)
    expect(toggle(w).attributes('aria-pressed')).toBe('false')
  })

  it('an empty draft is not sent by either key', async () => {
    const calls = stubRoutes()
    const w = await mountComposer()
    await toggle(w).trigger('click')

    await pressEnter(w, { shift: true })
    await flushPromises()
    expect(calls.some((call) => call.key === '/api/chat')).toBe(false)
  })
})

describe('the toggle button itself', () => {
  it('sits immediately left of Send', async () => {
    stubRoutes()
    const w = await mountComposer()
    const button = toggle(w)
    expect(button.exists()).toBe(true)
    expect(button.element.nextElementSibling).toBe(sendButton(w).element)
    // Same action group as Send, so it joins the right-hand cluster and not the
    // left one (which the layout spec measures).
    expect(button.element.parentElement).toBe(sendButton(w).element.parentElement)
    expect(button.element.parentElement.classList.contains('chat-bullet-actions--right')).toBe(
      true,
    )
  })

  it('stays immediately left of Stop while a reply streams', async () => {
    stubRoutes()
    const w = await mountComposer()
    chat.phase = 'answering'
    await flushPromises()
    const stop = w.find('.chat-stop')
    expect(stop.exists()).toBe(true)
    expect(toggle(w).element.nextElementSibling).toBe(stop.element)
  })

  it('is named after what Enter does, never after Send', async () => {
    // `getByLabel('Send message')` is pinned by the e2e spec and must keep
    // answering the Send button alone.
    stubRoutes()
    const w = await mountComposer()
    const off = [toggle(w).attributes('aria-label'), toggle(w).attributes('title')]
    for (const name of off) {
      expect(name).not.toContain('Send message')
    }
    expect(off[0]).toContain('Enter sends')

    await toggle(w).trigger('click')
    const on = [toggle(w).attributes('aria-label'), toggle(w).attributes('title')]
    for (const name of on) {
      expect(name).not.toContain('Send message')
    }
    expect(on[0]).toContain('new line')
  })

  it('changes its glyph with its state', async () => {
    stubRoutes()
    const w = await mountComposer()
    expect(toggle(w).findAll('svg')).toHaveLength(1)
    await toggle(w).trigger('click')
    expect(toggle(w).findAll('svg')).toHaveLength(1)
  })

  it('is live whatever the app is doing', async () => {
    // Flipping it cannot touch a reply already in flight, and the textarea
    // being disabled for a lot is no reason to hide a preference.
    stubRoutes()
    const w = await mountComposer()

    chat.phase = 'answering'
    await flushPromises()
    expect(toggle(w).attributes('disabled')).toBeUndefined()
    chat.phase = 'idle'
    await flushPromises()

    batch.active = true
    await flushPromises()
    expect(toggle(w).attributes('disabled')).toBeUndefined()
    expect(textarea(w).attributes('disabled')).toBeDefined()
    await toggle(w).trigger('click')
    expect(composerKeys.enterSends).toBe(false)
  })

  it('says the same thing in the placeholder it does in the key handler', async () => {
    stubRoutes()
    const w = await mountComposer()
    expect(textarea(w).attributes('placeholder')).toContain('Enter to send')
    expect(textarea(w).attributes('placeholder')).toContain('Shift+Enter for a new line')

    await toggle(w).trigger('click')
    expect(textarea(w).attributes('placeholder')).toContain('Shift+Enter to send')
    expect(textarea(w).attributes('placeholder')).toContain('Enter for a new line')
  })
})

describe('useComposerKeys', () => {
  it('writes the flag through to storage on every flip', () => {
    // `resetAll` left the flag at its default (Enter sends), so the first flip
    // is the one that stores "0" and the second stores "1" back.
    const { toggleEnterSends } = useComposerKeys()
    toggleEnterSends()
    expect(window.localStorage.getItem(ENTER_SENDS_KEY)).toBe('0')
    toggleEnterSends()
    expect(window.localStorage.getItem(ENTER_SENDS_KEY)).toBe('1')
  })

  it('is the same singleton the composer reads', async () => {
    stubRoutes()
    const w = await mountComposer()
    useComposerKeys().toggleEnterSends()
    await flushPromises()
    expect(composerKeys.enterSends).toBe(false)
    expect(toggle(w).attributes('aria-pressed')).toBe('true')
  })
})
