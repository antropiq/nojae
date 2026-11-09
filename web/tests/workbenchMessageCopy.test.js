import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

// jsdom has no ResizeObserver, and the chat splitters and the reasoning panel
// each create one on mount. A no-op is enough: nothing here measures a size.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

import WorkBenchView from '../src/components/WorkBenchView.vue'
import MessageCopyChip from '../src/components/MessageCopyChip.vue'
import { messageClipboardText, useChat } from '../src/composables/useChat'
import { TOOL_LINE_MARKER } from '../src/lib/markdown'

// ---------------------------------------------------------------------------
// The copy chip on an assistant card.
//
// Two halves, one per layer: what the chip *puts on the clipboard* (the reply
// as the model wrote it, sentinel-free — the rule `messageClipboardText` owns)
// and that the card actually carries one chip per reply, in the pane's copy
// affordance rather than the composer's whole-conversation button.
//
// The chip is asserted through the real `WorkBenchView` because the promise is
// the *placement*: one chip inside the assistant's own card, and none on a user
// turn. Whether the chip is half-visible at rest is CSS, so it stays an e2e
// concern — this file asserts the class the rule hangs on instead.
// ---------------------------------------------------------------------------

const chat = useChat().state

const CLIPBOARD_DESCRIPTOR = Object.getOwnPropertyDescriptor(
  globalThis.navigator,
  'clipboard',
)

// jsdom ships no `navigator.clipboard`, so each case installs the one it needs
// and the teardown puts the property back exactly as it found it.
function stubClipboard(impl) {
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    value: { writeText: vi.fn(impl) },
    configurable: true,
  })
  return globalThis.navigator.clipboard.writeText
}

function assistant(raw, extra = {}) {
  return { role: 'assistant', raw, html: `<p>${raw}</p>`, streaming: false, ...extra }
}

function userTurn(raw) {
  return { role: 'user', raw, html: `<p>${raw}</p>`, images: [] }
}

function cards(w) {
  return w.findAll('.chat-answer-card')
}

function chip(card) {
  return card.find('.chat-msg-copy')
}

beforeEach(() => {
  chat.phase = 'idle'
  chat.error = null
  chat.messages = []
  chat.pendingImage = null
  chat.draft.html = ''
})

afterEach(() => {
  chat.messages = []
  if (CLIPBOARD_DESCRIPTOR) {
    Object.defineProperty(globalThis.navigator, 'clipboard', CLIPBOARD_DESCRIPTOR)
  } else {
    delete globalThis.navigator.clipboard
  }
})

describe('messageClipboardText: the text a reply copies as', () => {
  it('is the reply verbatim', () => {
    expect(messageClipboardText(assistant('hello **there**'))).toBe('hello **there**')
  })

  it('drops the tool-line sentinel the raw text carries for rendering', () => {
    const raw = `first round${TOOL_LINE_MARKER}second round`
    expect(messageClipboardText(assistant(raw))).toBe('first roundsecond round')
  })

  it('is empty for a message with nothing in it', () => {
    expect(messageClipboardText(assistant(''))).toBe('')
    expect(messageClipboardText(null)).toBe('')
  })
})

describe('the copy chip on an assistant card', () => {
  it('renders one chip per reply, inside that reply card', async () => {
    stubClipboard(async () => {})
    chat.messages = [
      userTurn('one'),
      assistant('two'),
      userTurn('three'),
      assistant('four'),
    ]
    const w = mount(WorkBenchView)

    // One card per assistant turn, one chip per card, and the chip is the
    // card's own child (that is what the corner it hangs off is relative to).
    expect(cards(w)).toHaveLength(2)
    for (const card of cards(w)) {
      expect(chip(card).exists()).toBe(true)
      expect(card.findAll('.chat-msg-copy')).toHaveLength(1)
    }
    // A user turn carries its own chips (avatar, pencil) but never a copy one.
    for (const bubble of w.findAll('.chat-turn .chat-bubble')) {
      expect(bubble.find('.chat-msg-copy').exists()).toBe(false)
    }
  })

  it('copies that reply alone, not the conversation', async () => {
    const writeText = stubClipboard(async () => {})
    chat.messages = [
      userTurn('the question'),
      assistant('the answer'),
      userTurn('another question'),
      assistant('another answer'),
    ]
    const w = mount(WorkBenchView)

    await chip(cards(w)[1]).trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('another answer')
  })

  it('copies the sentinel-free text of a tool-loop reply', async () => {
    const writeText = stubClipboard(async () => {})
    chat.messages = [
      assistant(`before${TOOL_LINE_MARKER}after`),
    ]
    const w = mount(WorkBenchView)

    await chip(cards(w)[0]).trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith('beforeafter')
  })

  it('says so while the copy landed, then goes quiet', async () => {
    vi.useFakeTimers()
    try {
      stubClipboard(async () => {})
      chat.messages = [assistant('a reply')]
      const w = mount(WorkBenchView)

      await chip(cards(w)[0]).trigger('click')
      await vi.waitFor(async () => {
        expect(chip(cards(w)[0]).attributes('aria-label')).toBe('Reply copied')
      })
      expect(chip(cards(w)[0]).attributes('title')).toBe('Copied')

      vi.advanceTimersByTime(1500)
      await flushPromises()
      expect(chip(cards(w)[0]).attributes('aria-label')).toContain('Copy this reply')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reports a refused copy instead of pretending', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')))
    // The fallback path needs `document.execCommand`, which jsdom does not
    // implement — so it throws and the helper answers false.
    chat.messages = [assistant('a reply')]
    const w = mount(WorkBenchView)

    await chip(cards(w)[0]).trigger('click')
    await flushPromises()

    expect(chip(cards(w)[0]).attributes('title')).toBe('Copy failed')
  })

  it('is inert while a reply has streamed nothing', async () => {
    const writeText = stubClipboard(async () => {})
    chat.messages = [assistant('', { streaming: true })]
    const w = mount(WorkBenchView)

    const button = chip(cards(w)[0])
    expect(button.exists()).toBe(true)
    expect(button.attributes('disabled')).toBeDefined()

    await button.trigger('click')
    await flushPromises()
    expect(writeText).not.toHaveBeenCalled()
  })

  it('tracks the reply: inert the moment its text is gone', async () => {
    stubClipboard(async () => {})
    const message = assistant('partial', { streaming: true })
    chat.messages = [message]
    const w = mount(WorkBenchView)
    expect(chip(cards(w)[0]).attributes('disabled')).toBeUndefined()

    // Through the array: `state.messages` is deeply reactive, so the proxy it
    // holds is what a re-render reads — the object handed in is the raw target.
    chat.messages[0].raw = ''
    await flushPromises()
    expect(chip(cards(w)[0]).attributes('disabled')).toBeDefined()
  })

  it('is the chip class the theme hangs the resting look on', async () => {
    stubClipboard(async () => {})
    chat.messages = [assistant('a reply')]
    const w = mount(WorkBenchView)

    // The card is the positioned containing block and the chip the absolutely
    // placed corner: both classes must be present for the theme's rule to bite.
    expect(cards(w)[0].classes()).toContain('chat-answer-card')
    expect(chip(cards(w)[0]).classes()).toContain('chat-turn-chip')
    expect(chip(cards(w)[0]).classes()).toContain('chat-msg-copy')
  })
})

describe('the chip on its own', () => {
  it('answers nothing for blank text', async () => {
    const writeText = stubClipboard(async () => {})
    const w = mount(MessageCopyChip, { props: { text: '   ' } })

    expect(w.find('button').attributes('disabled')).toBeDefined()
    await w.find('button').trigger('click')
    await flushPromises()
    expect(writeText).not.toHaveBeenCalled()
  })
})
