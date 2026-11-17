import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

// jsdom has no ResizeObserver, and the chat splitters and the reasoning panel
// each create one on mount. A no-op is enough: nothing here measures a size.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// jsdom implements <dialog> only partially: the lightbox opens it with
// showModal(), which jsdom does not provide.
if (!globalThis.HTMLDialogElement.prototype.showModal) {
  globalThis.HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true
  }
  globalThis.HTMLDialogElement.prototype.close = function close() {
    this.open = false
  }
}

import WorkBenchView from '../src/components/WorkBenchView.vue'
import { lastUserGroupStart, useChat } from '../src/composables/useChat'
import { useAgentModes } from '../src/composables/useAgentModes'
import { useBatch } from '../src/composables/useBatch'
import { renderMarkdown } from '../src/lib/markdown'
import { clearTabWorkspace } from './helpers/workspace-url'

// ---------------------------------------------------------------------------
// The edit gesture takes the whole unanswered group.
//
// A flush opens one turn carrying several consecutive user turns, so "undo my
// last message" has to mean the run those turns form: returning one mockup of
// four would be worse than doing nothing. The group is recognised by adjacency
// alone (no marker in the thread, nothing in a saved session), it goes to the
// **strip** rather than the draft, and the pencil draws on its first message.
// ---------------------------------------------------------------------------

const chat = useChat().state
const batch = useBatch().state
const agentModes = useAgentModes().state

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

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

// One accepted reply, so a case can re-flush what the gesture returned through
// the real send path and check the round trip.
const DONE = 'event: done\ndata: {"tokens":12,"took":1.5,"ttft":0.4,"decode":1.1}\n\n'

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

function stubRoutes() {
  const posts = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const key = String(url)
    if (key.startsWith('/api/chat')) {
      posts.push(JSON.parse(init?.body ?? '{}'))
      return { ok: true, body: sseBody(DONE) }
    }
    if (key === '/api/agents') return jsonResponse(agentsBody())
    return jsonResponse({}, false, 404)
  })
  return posts
}

function resetAll() {
  clearTabWorkspace()
  chat.phase = 'idle'
  chat.messages = []
  chat.error = null
  chat.pausePending = false
  chat.session.startedAt = 0
  chat.session.spentMs = 0
  chat.session.agentMode = null
  chat.staged = []
  chat.pendingImages = []
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
  window.sessionStorage.clear()
}

function image(name, byte = 0) {
  return { dataUrl: `data:image/png;base64,AAAA${byte}`, name, size: 4 }
}

function user(raw, images = []) {
  return { role: 'user', raw, html: renderMarkdown(raw), streaming: false, images }
}

function assistant(raw, extra = {}) {
  return { role: 'assistant', raw, html: renderMarkdown(raw), streaming: false, ...extra }
}

function editButtons(w) {
  return w.findAll('.chat-turn-edit')
}

beforeEach(() => {
  resetAll()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetAll()
})

describe('the group is recognised by adjacency', () => {
  it('is the maximal run of consecutive user turns ending at the last one', () => {
    expect(
      lastUserGroupStart([user('a'), user('b'), user('c'), assistant('reply')]),
    ).toBe(0)
    expect(lastUserGroupStart([user('a'), assistant('x'), user('b'), user('c')])).toBe(2)
  })

  it('is the single last user turn when the run before it was answered', () => {
    expect(
      lastUserGroupStart([user('a'), assistant('x'), user('b'), assistant('y'), user('c')]),
    ).toBe(4)
  })

  it('answers -1 for a thread with no user turn, or no thread', () => {
    expect(lastUserGroupStart([])).toBe(-1)
    expect(lastUserGroupStart([assistant('only a reply')])).toBe(-1)
    expect(lastUserGroupStart(null)).toBe(-1)
  })
})

describe('editLast returns the whole group to the strip', () => {
  it('brings back three turns in order and removes all three from the thread', () => {
    stubRoutes()
    chat.messages = [
      user('first brief'),
      user('second brief'),
      user('third brief'),
      assistant('on it'),
    ]

    useChat().editLast()

    expect(chat.staged.map((row) => row.raw)).toEqual([
      'first brief',
      'second brief',
      'third brief',
    ])
    // The group's first message is the strip's first row: order is flush order.
    expect(chat.staged.map((row) => row.role)).toEqual(['user', 'user', 'user'])
    expect(new Set(chat.staged.map((row) => row.id)).size).toBe(3)
    // The thread lost the group *and* the reply it earned: nothing unanswered
    // is left behind, and no request was made by the gesture.
    expect(chat.messages).toEqual([])
  })

  it('leaves the draft alone and joins the strip in front of what is staged', () => {
    stubRoutes()
    chat.draft.raw = 'typing something new'
    chat.pendingImages = [image('draft.png', 9)]
    // Something already staged, written after the group was.
    chat.staged = [
      { id: 'staged-kept', role: 'user', raw: 'staged later', html: '<p>staged later</p>', streaming: false, images: [] },
    ]
    chat.messages = [user('one'), user('two'), assistant('reply')]

    useChat().editLast()

    // The group was written before what the user is staging now, so it comes
    // first: the strip is the flush order.
    expect(chat.staged.map((row) => row.raw)).toEqual(['one', 'two', 'staged later'])
    // The draft is the user's in-progress typing; nothing here asked for it.
    expect(chat.draft.raw).toBe('typing something new')
    expect(chat.pendingImages.map((it) => it.name)).toEqual(['draft.png'])
  })

  it('carries every image of every turn back, each with its own message', () => {
    stubRoutes()
    chat.messages = [
      user('mockup one', [image('a.png', 1), image('b.png', 2)]),
      user('mockup two', [image('c.png', 3)]),
      user('mockup three', []),
      assistant('three mockups, understood'),
    ]

    useChat().editLast()

    expect(chat.staged.map((row) => row.images.map((it) => it.name))).toEqual([
      ['a.png', 'b.png'],
      ['c.png'],
      [],
    ])
  })

  it('keeps the rendered html the thread already held, and never streams', () => {
    stubRoutes()
    chat.messages = [user('**bold** brief'), assistant('ok')]
    useChat().editLast()
    expect(chat.staged[0].html).toContain('<strong>bold</strong>')
    expect(chat.staged[0].streaming).toBe(false)
  })

  it('renders through the one renderer when a turn carries no html', () => {
    stubRoutes()
    // A loaded session or a turn rebuilt by hand may arrive without it; the row
    // is rendered the same way a send renders a draft, never blank and never raw.
    chat.messages = [
      { role: 'user', raw: '**bold** brief', streaming: false, images: [] },
      assistant('ok'),
    ]
    useChat().editLast()
    expect(chat.staged[0].html).toBe('<p><strong>bold</strong> brief</p>\n')
  })

  it('does nothing for a thread with no user turn', () => {
    stubRoutes()
    chat.messages = [assistant('a reply with nothing asked')]
    useChat().editLast()
    expect(chat.staged).toEqual([])
    expect(chat.messages).toHaveLength(1)
  })

  it('refuses while the conversation is busy', () => {
    stubRoutes()
    chat.messages = [user('one'), user('two'), assistant('reply')]
    for (const enter of [
      () => {
        chat.phase = 'answering'
      },
      () => {
        chat.phase = 'idle'
        batch.active = true
      },
    ]) {
      enter()
      useChat().editLast()
      expect(chat.messages).toHaveLength(3)
      expect(chat.staged).toEqual([])
      chat.phase = 'idle'
      batch.active = false
    }
  })
})

describe('a single unanswered message is the same verb on the same kind of run', () => {
  it('goes to the strip, not to the draft — the one visible change', () => {
    stubRoutes()
    chat.messages = [user('the only message')]

    useChat().editLast()

    expect(chat.staged).toHaveLength(1)
    expect(chat.staged[0].raw).toBe('the only message')
    // Today's behaviour loaded the text straight into the draft; that is what
    // changes. Pulling a row back into the composer is the strip's own verb.
    expect(chat.draft.raw).toBe('')
    expect(chat.messages).toEqual([])
  })

  it('returns exactly one after an assistant turn, never the answered run', () => {
    stubRoutes()
    chat.messages = [
      user('answered question'),
      assistant('answer'),
      user('the unanswered one'),
    ]

    useChat().editLast()

    expect(chat.staged.map((row) => row.raw)).toEqual(['the unanswered one'])
    expect(chat.messages.map((message) => message.raw)).toEqual([
      'answered question',
      'answer',
    ])
  })
})

describe('after an interrupted turn the gesture returns everything unanswered', () => {
  // The two ways a reply ends unfinished and stays in the thread: the user
  // paused it, or the server cut it short. Either way the user turns before it
  // are still unanswered.
  const INTERRUPTED = [
    ['paused', { paused: true }],
    ['truncated', { truncated: true }],
  ]

  for (const [label, extra] of INTERRUPTED) {
    it(`takes the partial reply with it when it was ${label}`, () => {
      stubRoutes()
      chat.messages = [
        user('brief one'),
        user('brief two'),
        assistant('half an ans', extra),
      ]
      // The composer is shut mid-reply, so the gesture is refused then; it acts
      // once the turn is over, which is when the fragment is all that is left.
      chat.phase = 'idle'

      useChat().editLast()

      expect(chat.staged.map((row) => row.raw)).toEqual(['brief one', 'brief two'])
      expect(chat.messages).toEqual([])
    })
  }
})

describe('re-flushing the returned group loses nothing', () => {
  it('produces the same three user turns in one request, in the same order', async () => {
    const posts = stubRoutes()
    await useAgentModes().loadAgentModes()
    chat.messages = [
      user('mockup one', [image('a.png', 1)]),
      user('mockup two'),
      user('mockup three', [image('b.png', 2)]),
      assistant('got them'),
    ]

    useChat().editLast()
    await useChat().send()
    await flushPromises()

    expect(posts).toHaveLength(1)
    expect(posts[0].messages.map((message) => message.role)).toEqual([
      'user',
      'user',
      'user',
    ])
    expect(chat.messages.slice(0, 3).map((message) => message.raw)).toEqual([
      'mockup one',
      'mockup two',
      'mockup three',
    ])
    // The images landed back on the message that owned them.
    expect(
      posts[0].messages
        .slice(0, 3)
        .map((message) =>
          Array.isArray(message.content)
            ? message.content.filter((part) => part.type === 'image_url').length
            : 0,
        ),
    ).toEqual([1, 0, 1])
  })
})

describe('the affordance sits on the group\'s first message', () => {
  it('draws once, on the first of three user turns', async () => {
    stubRoutes()
    chat.messages = [user('one'), user('two'), user('three'), assistant('reply')]
    const w = mount(WorkBenchView)
    await flushPromises()

    const buttons = editButtons(w)
    expect(buttons).toHaveLength(1)
    // The bubble it hangs off is the first user turn's, not the last one's.
    const bubbles = w.findAll('.chat-turn')
    expect(bubbles).toHaveLength(3)
    expect(buttons[0].element.closest('.chat-turn')).toBe(bubbles[0].element)
    expect(bubbles[1].find('.chat-turn-edit').exists()).toBe(false)
    expect(bubbles[2].find('.chat-turn-edit').exists()).toBe(false)
    w.unmount()
  })

  it('draws on a lone unanswered message after an answered one', async () => {
    stubRoutes()
    chat.messages = [
      user('answered'),
      assistant('answer'),
      user('unanswered'),
    ]
    const w = mount(WorkBenchView)
    await flushPromises()

    const bubbles = w.findAll('.chat-turn')
    expect(editButtons(w)).toHaveLength(1)
    expect(editButtons(w)[0].element.closest('.chat-turn')).toBe(bubbles[1].element)
    w.unmount()
  })

  it('says what it does, and no longer claims a single message', async () => {
    stubRoutes()
    chat.messages = [user('one'), user('two'), user('three'), assistant('reply')]
    const w = mount(WorkBenchView)
    await flushPromises()

    const button = editButtons(w)[0]
    const label = button.attributes('aria-label')
    const title = button.attributes('title')
    // "Edit and resend" reads as one message once the gesture returns a run.
    expect(label).not.toBe('Edit and resend')
    expect(title).not.toBe('Edit and resend')
    for (const text of [label, title]) {
      expect(text.toLowerCase()).toContain('unanswered')
    }
    // The pencil glyph stays: the app already borrows it for this verb.
    expect(button.findAll('svg')).toHaveLength(1)
    // And the phrase the pinned e2e spec finds the Send button by stays that
    // button's alone.
    expect(label).not.toContain('Send message')
    expect(title).not.toContain('Send message')
    w.unmount()
  })

  it('is gated exactly as it was: idle, and no batch', async () => {
    stubRoutes()
    chat.messages = [user('one'), user('two'), assistant('reply')]
    const w = mount(WorkBenchView)
    await flushPromises()
    expect(editButtons(w)).toHaveLength(1)

    chat.phase = 'answering'
    await flushPromises()
    expect(editButtons(w)).toHaveLength(0)

    chat.phase = 'idle'
    batch.active = true
    await flushPromises()
    expect(editButtons(w)).toHaveLength(0)
    w.unmount()
  })
})

describe('what the gesture returns renders as a sent turn does', () => {
  it('draws a thumbnail per returned image, opening the pane\'s lightbox', async () => {
    stubRoutes()
    chat.messages = [
      user('mockup one', [image('a.png', 1), image('b.png', 2)]),
      user('mockup two', [image('c.png', 3)]),
      assistant('reply'),
    ]
    const w = mount(WorkBenchView)
    await flushPromises()

    await editButtons(w)[0].trigger('click')
    await flushPromises()

    expect(w.findAll('.chat-staged-row')).toHaveLength(2)
    const thumbs = w.findAll('.chat-staged-thumbs .chat-thumb-zoom')
    expect(thumbs).toHaveLength(3)
    expect(thumbs.map((thumb) => thumb.find('img').attributes('alt'))).toEqual([
      'a.png',
      'b.png',
      'c.png',
    ])
    // The same full-size lightbox a sent turn's thumbnails open.
    await thumbs[1].trigger('click')
    await flushPromises()
    expect(w.find('.image-lightbox img').attributes('alt')).toBe('b.png')
    w.unmount()
  })
})
