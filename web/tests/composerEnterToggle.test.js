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
// The composer's Enter-key toggle, and the three Enter shapes it must not blur.
//
// Default (off): Enter sends, Shift+Enter writes a newline — the behaviour the
// composer has always had. On: the send/newline pair is inverted, so a draft can
// be written and reread before it is handed to the model.
//
// The third shape is Ctrl/Cmd+Enter, which stages the draft: it reads *before*
// the toggle, so it means the same thing in both settings. The staging cases
// below therefore run twice, once under each setting, and assert the two runs
// left the same state behind.
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
  chat.pendingImages = []
  chat.staged = []
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

function stageButton(w) {
  return w.find('.chat-stage')
}

// Dispatched by hand rather than through `trigger`, because what is being
// asserted here is the event itself: `defaultPrevented` is the difference
// between "Enter was swallowed and sent" and "Enter was left to the textarea".
// `composing` is the IME candidate-window Enter, which the browser flags on the
// event itself.
function pressEnter(
  w,
  { shift = false, ctrl = false, meta = false, alt = false, composing = false } = {},
) {
  const event = new window.KeyboardEvent('keydown', {
    key: 'Enter',
    shiftKey: shift,
    ctrlKey: ctrl,
    metaKey: meta,
    altKey: alt,
    bubbles: true,
    cancelable: true,
  })
  if (composing) Object.defineProperty(event, 'isComposing', { value: true })
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

describe('the row\'s three verbs, in the order the keys reach them', () => {
  it('is toggle, then Stage, then Send, and the toggle is immediately left of Stage', async () => {
    stubRoutes()
    const w = await mountComposer()
    const button = toggle(w)
    expect(button.exists()).toBe(true)
    expect(stageButton(w).exists()).toBe(true)
    // The order is the point, and it is asserted on the elements themselves: the
    // toggle is immediately left of Stage, and Stage immediately left of Send.
    expect(button.element.nextElementSibling).toBe(stageButton(w).element)
    expect(stageButton(w).element.nextElementSibling).toBe(sendButton(w).element)
    // Same action group as Send, so the three join the right-hand cluster and
    // not the left one (which the layout spec measures).
    const group = sendButton(w).element.parentElement
    expect(button.element.parentElement).toBe(group)
    expect(stageButton(w).element.parentElement).toBe(group)
    expect(group.classList.contains('chat-bullet-actions--right')).toBe(true)
  })

  it('stays in that order while a reply streams, ending at Stop', async () => {
    stubRoutes()
    const w = await mountComposer()
    chat.phase = 'answering'
    await flushPromises()
    const stop = w.find('.chat-stop')
    expect(stop.exists()).toBe(true)
    expect(toggle(w).element.nextElementSibling).toBe(stageButton(w).element)
    // Stop takes Send's place, and nothing else about the row moves.
    expect(stageButton(w).element.nextElementSibling).toBe(stop.element)
    expect(stageButton(w).element.parentElement).toBe(stop.element.parentElement)
  })

  it('is named after what Enter does, never after Send', async () => {
    // One phrase names one control: "Send message" is the Send button's, so
    // neither of the two controls beside it may carry it, in any of their states.
    // A query or a screen reader asking for "Send message" therefore answers Send
    // and nothing else — which is what the e2e suite's own locators assume.
    stubRoutes()
    const w = await mountComposer()
    // The phrase has exactly one owner to begin with: without that, "the other
    // two do not carry it" would be true of a composer with nobody carrying it.
    expect(sendButton(w).attributes('aria-label')).toBe('Send message')
    const off = [toggle(w).attributes('aria-label'), toggle(w).attributes('title')]
    for (const name of off) {
      expect(name).not.toContain('Send message')
    }
    expect(off[0]).toContain('Enter sends')

    const stageNames = [stageButton(w).attributes('aria-label'), stageButton(w).attributes('title')]
    for (const name of stageNames) {
      expect(name).not.toContain('Send message')
    }

    await toggle(w).trigger('click')
    const on = [toggle(w).attributes('aria-label'), toggle(w).attributes('title')]
    for (const name of on) {
      expect(name).not.toContain('Send message')
    }
    expect(on[0]).toContain('new line')

    // …and still not once the draft gives the Stage button a live title, nor in
    // the window where its title is the refusal.
    chat.draft.raw = 'something to stage'
    await flushPromises()
    const live = [stageButton(w).attributes('aria-label'), stageButton(w).attributes('title')]
    for (const name of live) {
      expect(name).not.toContain('Send message')
    }
    expect(live[1]).toContain('Stage')

    chat.phase = 'answering'
    await flushPromises()
    const busy = [stageButton(w).attributes('aria-label'), stageButton(w).attributes('title')]
    for (const name of busy) {
      expect(name).not.toContain('Send message')
    }
    expect(busy[1]).toContain('no reply is streaming')
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
    // The staging chord is named too, and it is the same name in both settings:
    // it is the one shape the toggle never moves.
    expect(textarea(w).attributes('placeholder')).toContain('Ctrl+Enter to stage')

    await toggle(w).trigger('click')
    expect(textarea(w).attributes('placeholder')).toContain('Shift+Enter to send')
    expect(textarea(w).attributes('placeholder')).toContain('Enter for a new line')
    expect(textarea(w).attributes('placeholder')).toContain('Ctrl+Enter to stage')
  })
})

describe('Ctrl/Cmd+Enter stages, under both settings of the toggle', () => {
  // The staging chord is read *before* the toggle, so its meaning cannot depend
  // on a keyboard habit. Each case runs twice — toggle off and toggle on — and
  // compares what the two runs left behind.
  const SETTINGS = [
    ['default (Enter sends)', false],
    ['inverted (Shift+Enter sends)', true],
  ]

  async function stageWith(setting, press) {
    const calls = stubRoutes()
    const w = await mountComposer()
    if (setting) await toggle(w).trigger('click')
    chat.draft.raw = 'a first thought'
    const event = press(w)
    await flushPromises()
    const result = {
      staged: chat.staged.map((row) => row.raw),
      draft: chat.draft.raw,
      prevented: event.defaultPrevented,
      requests: calls.filter((call) => call.key === '/api/chat').length,
      phase: chat.phase,
      messages: chat.messages.length,
    }
    w.unmount()
    return result
  }

  for (const [label, inverted] of SETTINGS) {
    it(`stages the draft and sends nothing under ${label}`, async () => {
      stubRoutes()
      const w = await mountComposer()
      if (inverted) await toggle(w).trigger('click')
      chat.draft.raw = 'a first thought'

      const event = await pressEnter(w, { ctrl: true })
      await flushPromises()

      // The draft moved to the strip and the composer emptied — and the
      // textarea's own newline was prevented, so nothing landed in its place.
      expect(chat.staged.map((row) => row.raw)).toEqual(['a first thought'])
      expect(chat.draft.raw).toBe('')
      expect(event.defaultPrevented).toBe(true)
      // A stage is not a turn: no request, no phase change, no bubble.
      expect(chat.phase).toBe('idle')
      expect(chat.messages).toHaveLength(0)
      w.unmount()
    })

    it(`stages on Cmd+Enter under ${label}`, async () => {
      const calls = stubRoutes()
      const w = await mountComposer()
      if (inverted) await toggle(w).trigger('click')
      chat.draft.raw = 'a first thought'

      const event = await pressEnter(w, { meta: true })
      await flushPromises()

      expect(chat.staged.map((row) => row.raw)).toEqual(['a first thought'])
      expect(event.defaultPrevented).toBe(true)
      expect(calls.some((call) => call.key === '/api/chat')).toBe(false)
      w.unmount()
    })
  }

  it('does the same thing in both settings, byte for byte', async () => {
    const off = await stageWith(false, (w) => pressEnter(w, { ctrl: true }))
    resetAll()
    const on = await stageWith(true, (w) => pressEnter(w, { ctrl: true }))

    expect(on).toEqual(off)
    // Spelled out as well, so a change to `equal` cannot soften the pin.
    expect(off).toEqual({
      staged: ['a first thought'],
      draft: '',
      prevented: true,
      requests: 0,
      phase: 'idle',
      messages: 0,
    })
  })

  it('keeps Ctrl+Shift+Enter on the staging chord', async () => {
    const calls = stubRoutes()
    const w = await mountComposer()
    chat.draft.raw = 'a first thought'

    // Shift does not join the chord, so the combination still stages.
    const chord = await pressEnter(w, { ctrl: true, shift: true })
    await flushPromises()
    expect(chat.staged.map((row) => row.raw)).toEqual(['a first thought'])
    expect(chord.defaultPrevented).toBe(true)
    expect(calls.some((call) => call.key === '/api/chat')).toBe(false)
    w.unmount()
  })

  it('leaves Alt+Enter out of the chord, so it still sends', async () => {
    const calls = stubRoutes()
    const w = await mountComposer()
    chat.draft.raw = 'a first thought'

    // Alt is not part of the chord: the key keeps the meaning the toggle gives
    // it — a send, under the default setting — and it stages nothing.
    const alt = await pressEnter(w, { alt: true })
    await flushPromises()

    expect(chat.staged).toHaveLength(0)
    expect(alt.defaultPrevented).toBe(true)
    expect(calls.some((call) => call.key === '/api/chat')).toBe(true)
    w.unmount()
  })

  it('stages nothing for an empty draft, with no error line', async () => {
    const calls = stubRoutes()
    const w = await mountComposer()

    const event = await pressEnter(w, { ctrl: true })
    await flushPromises()

    expect(chat.staged).toHaveLength(0)
    expect(chat.error).toBeNull()
    // Swallowed rather than sent: the key is the chord's either way.
    expect(event.defaultPrevented).toBe(true)
    expect(calls.some((call) => call.key === '/api/chat')).toBe(false)
    w.unmount()
  })

  it('neither sends nor stages an Enter that came from an IME', async () => {
    const calls = stubRoutes()
    const w = await mountComposer()
    chat.draft.raw = 'a first thought'

    // The candidate window's Enter belongs to the IME, whatever modifier is held.
    const plain = await pressEnter(w, { composing: true })
    const chord = await pressEnter(w, { composing: true, ctrl: true })
    await flushPromises()

    expect(plain.defaultPrevented).toBe(false)
    expect(chord.defaultPrevented).toBe(false)
    expect(chat.staged).toHaveLength(0)
    expect(chat.draft.raw).toBe('a first thought')
    expect(calls.some((call) => call.key === '/api/chat')).toBe(false)
    w.unmount()
  })

  it('stages nothing while a reply streams or a batch owns the conversation', async () => {
    stubRoutes()
    const w = await mountComposer()
    chat.draft.raw = 'typed mid-reply'

    chat.phase = 'answering'
    await flushPromises()
    await pressEnter(w, { ctrl: true })
    expect(chat.staged).toHaveLength(0)

    chat.phase = 'idle'
    batch.active = true
    await flushPromises()
    await pressEnter(w, { ctrl: true })
    expect(chat.staged).toHaveLength(0)
    // The draft survives both refusals intact.
    expect(chat.draft.raw).toBe('typed mid-reply')
    w.unmount()
  })
})

describe('the Stage button', () => {
  it('stages the draft and opens nothing', async () => {
    const calls = stubRoutes()
    const w = await mountComposer()
    chat.draft.raw = 'a first thought'
    await flushPromises()

    expect(stageButton(w).attributes('disabled')).toBeUndefined()
    await stageButton(w).trigger('click')
    await flushPromises()

    expect(chat.staged.map((row) => row.raw)).toEqual(['a first thought'])
    expect(chat.draft.raw).toBe('')
    expect(chat.phase).toBe('idle')
    expect(calls.some((call) => call.key === '/api/chat')).toBe(false)
    w.unmount()
  })

  it('is inert with a stated reason when there is nothing to stage', async () => {
    stubRoutes()
    const w = await mountComposer()

    expect(stageButton(w).attributes('disabled')).toBeDefined()
    expect(stageButton(w).attributes('title')).toContain('Write a message')

    // A draft of whitespace is still nothing to stage.
    chat.draft.raw = '   \n  '
    await flushPromises()
    expect(stageButton(w).attributes('disabled')).toBeDefined()

    // Clicking it stages nothing, and says nothing either.
    await stageButton(w).trigger('click')
    await flushPromises()
    expect(chat.staged).toHaveLength(0)
    expect(chat.error).toBeNull()
    w.unmount()
  })

  it('puts the caret back in the composer, so the next message is written on top', async () => {
    stubRoutes()
    const w = await mountComposer()
    chat.draft.raw = 'a first thought'
    await flushPromises()

    // What a click on the button really does: focus lands on the affordance, not
    // on the textarea the user was writing in.
    stageButton(w).element.focus()
    expect(document.activeElement).toBe(stageButton(w).element)

    await stageButton(w).trigger('click')
    await flushPromises()

    expect(chat.staged.map((row) => row.raw)).toEqual(['a first thought'])
    expect(document.activeElement).toBe(textarea(w).element)
    w.unmount()
  })

  it('is live for an attached image with no text', async () => {
    stubRoutes()
    const w = await mountComposer()
    chat.pendingImages = [{ dataUrl: 'data:image/png;base64,AAAA', name: 'a.png', size: 4 }]
    await flushPromises()

    expect(stageButton(w).attributes('disabled')).toBeUndefined()
    await stageButton(w).trigger('click')
    await flushPromises()

    expect(chat.staged).toHaveLength(1)
    expect(chat.staged[0].images.map((it) => it.name)).toEqual(['a.png'])
    w.unmount()
  })

  it('is inert with the reason while a reply streams, and stages nothing', async () => {
    stubRoutes()
    const w = await mountComposer()
    chat.draft.raw = 'typed mid-reply'
    chat.phase = 'answering'
    await flushPromises()

    expect(stageButton(w).attributes('disabled')).toBeDefined()
    expect(stageButton(w).attributes('title')).toContain('no reply is streaming')
    await stageButton(w).trigger('click')
    await flushPromises()
    expect(chat.staged).toHaveLength(0)
    expect(chat.draft.raw).toBe('typed mid-reply')
    w.unmount()
  })

  it('is inert with the reason while a batch owns the conversation', async () => {
    stubRoutes()
    const w = await mountComposer()
    chat.draft.raw = 'typed mid-lot'
    batch.active = true
    await flushPromises()

    expect(stageButton(w).attributes('disabled')).toBeDefined()
    expect(stageButton(w).attributes('title')).toContain('no batch runs')
    await stageButton(w).trigger('click')
    await flushPromises()
    expect(chat.staged).toHaveLength(0)
    w.unmount()
  })

  it('keeps its place in the row in every state, with one glyph', async () => {
    stubRoutes()
    const w = await mountComposer()
    chat.draft.raw = 'something'
    await flushPromises()
    expect(stageButton(w).findAll('svg')).toHaveLength(1)
    expect(stageButton(w).text()).toBe('')

    // Nothing to stage, and mid-reply: it stays where it is rather than
    // appearing and disappearing beside the keys it belongs to.
    chat.draft.raw = ''
    chat.phase = 'answering'
    await flushPromises()
    expect(stageButton(w).exists()).toBe(true)
    w.unmount()
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
