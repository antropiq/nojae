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
// showModal(), which jsdom does not provide. A no-op that records `open` is
// enough — nothing here asserts what the browser paints.
if (!globalThis.HTMLDialogElement.prototype.showModal) {
  globalThis.HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true
  }
  globalThis.HTMLDialogElement.prototype.close = function close() {
    this.open = false
  }
}

import WorkBenchView from '../src/components/WorkBenchView.vue'
import WorkBenchInput from '../src/components/WorkBenchInput.vue'
import {
  conversationJson,
  parseSessionFile,
  useChat,
} from '../src/composables/useChat'
import { useAgentModes } from '../src/composables/useAgentModes'
import { useAppShell } from '../src/composables/useAppShell'
import { useBatch } from '../src/composables/useBatch'
import { clearTabWorkspace } from './helpers/workspace-url'

// ---------------------------------------------------------------------------
// Images belong to a message, and a message may carry several.
//
// The composer holds a list, a sent turn keeps every image from it, and every
// reader of "the first image" is gone: edit-and-resend returns all of them, a
// saved session round-trips all of them, and the chip above the draft draws one
// row each. One image would hide every one of those regressions.
// ---------------------------------------------------------------------------

const chat = useChat().state
const batch = useBatch().state
const agentModes = useAgentModes().state
const appShell = useAppShell().state

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, body: null, json: () => Promise.resolve(body) })
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
      {
        id: 'chat',
        label: 'Chat',
        mcpEnable: true,
        lspEnable: true,
        readonly: false,
        deletable: true,
        maxToolIteration: 25,
        systemMessage: '',
        modelId: 2,
        modelName: 'model-2',
      },
    ],
    caps: { minToolIteration: 1, maxIdChars: 32 },
    findings: [],
  }
}

// `/api/chat` answers a plain failure, which `startTurn` turns into "the user
// turn stays, the empty assistant turn is dropped, the app is idle again" — so
// the request body is recorded and one case cannot leak into the next.
function stubRoutes() {
  const posts = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const key = String(url)
    if (key === '/api/chat' || key.startsWith('/api/chat?')) {
      posts.push(JSON.parse(init?.body ?? '{}'))
      return jsonResponse({ detail: 'stubbed' }, false, 599)
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
  chat.session.agentMode = null
  chat.staged = []
  chat.pendingImages = []
  chat.draft = { raw: '', html: '', renderedRaw: '' }
  chat.mcp = { connectors: [], enabled: {}, loaded: false, locked: false, restarting: false }
  chat.lsp = { servers: [], enabled: {}, loaded: false, locked: false, restarting: false }
  batch.active = false
  batch.status = 'idle'
  appShell.config = null
  agentModes.modes = []
  agentModes.current = null
  agentModes.loaded = false
  agentModes.findings = []
  agentModes.notice = null
  window.sessionStorage.clear()
}

// One real File through the real FileReader, the path `attachImage` takes: the
// reader's load event is a macrotask, so the wait is polled rather than flushed.
async function attach(name, byte = 0) {
  const bytes = new Uint8Array([byte, byte + 1, byte + 2, byte + 3])
  const file = new File([bytes], name, { type: 'image/png' })
  expect(useChat().attachImage(file)).toBe(true)
  await vi.waitFor(() => {
    expect(chat.pendingImages.some((image) => image.name === name)).toBe(true)
  })
  return chat.pendingImages.find((image) => image.name === name)
}

function imageParts(message) {
  return Array.isArray(message.content)
    ? message.content.filter((part) => part.type === 'image_url')
    : []
}

beforeEach(() => {
  resetAll()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetAll()
})

describe('the composer holds a list of images', () => {
  it('starts empty and appends rather than replacing', async () => {
    const { attachImage } = useChat()
    expect(chat.pendingImages).toEqual([])

    await attach('one.png', 0)
    await attach('two.png', 10)
    await attach('three.png', 20)
    await attach('four.png', 30)

    expect(chat.pendingImages.map((image) => image.name)).toEqual([
      'one.png',
      'two.png',
      'three.png',
      'four.png',
    ])
    // The list is made of the same objects the chip renders: data URL, name, size.
    for (const image of chat.pendingImages) {
      expect(image.dataUrl.startsWith('data:image/png;base64,')).toBe(true)
      expect(image.size).toBe(4)
    }
    expect(attachImage(null)).toBe(false)
  })

  it('drops one by position and keeps the rest in order', async () => {
    const { removeImage } = useChat()
    await attach('one.png', 0)
    await attach('two.png', 10)
    await attach('three.png', 20)
    await attach('four.png', 30)

    removeImage(1)
    expect(chat.pendingImages.map((image) => image.name)).toEqual([
      'one.png',
      'three.png',
      'four.png',
    ])
    // A position the list no longer holds touches nothing.
    removeImage(9)
    removeImage(-1)
    expect(chat.pendingImages).toHaveLength(3)
  })

  it('clears them all', async () => {
    await attach('one.png', 0)
    await attach('two.png', 10)
    useChat().clearImage()
    expect(chat.pendingImages).toEqual([])
  })

  it('is non-empty, not "an image", that opens the send gate', async () => {
    stubRoutes()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const w = mount(WorkBenchInput, { attachTo: host })
    await useAgentModes().loadAgentModes()
    await flushPromises()

    const send = () => w.find('.chat-send:not(.chat-stop)')
    expect(send().attributes('disabled')).toBeDefined()

    chat.pendingImages = [{ dataUrl: 'data:image/png;base64,AAAA', name: 'a.png', size: 3 }]
    await flushPromises()
    expect(send().attributes('disabled')).toBeUndefined()

    chat.pendingImages = []
    await flushPromises()
    expect(send().attributes('disabled')).toBeDefined()

    w.unmount()
    host.remove()
  })
})

describe('a sent turn keeps every image the composer held', () => {
  it('posts one image part per attached image', async () => {
    const posts = stubRoutes()
    await useAgentModes().loadAgentModes()
    await attach('one.png', 0)
    await attach('two.png', 10)
    await attach('three.png', 20)
    chat.draft.raw = 'three mockups'

    await useChat().send()
    await flushPromises()

    expect(posts).toHaveLength(1)
    expect(imageParts(posts[0].messages.at(-1))).toHaveLength(3)
    const sent = chat.messages[chat.messages.length - 1]
    expect(sent.role).toBe('user')
    expect(sent.images.map((image) => image.name)).toEqual(['one.png', 'two.png', 'three.png'])
    // The composer is empty again: the images went with the message.
    expect(chat.pendingImages).toEqual([])
  })

  it('is exactly today\'s send when no image is attached', async () => {
    const posts = stubRoutes()
    await useAgentModes().loadAgentModes()
    chat.draft.raw = 'no pictures'

    await useChat().send()
    await flushPromises()

    expect(posts).toHaveLength(1)
    expect(posts[0].messages.at(-1)).toEqual({ role: 'user', content: 'no pictures' })
  })
})

describe('the edit gesture returns every image with its message', () => {
  it('keeps all three on the one message, in the strip', async () => {
    await useAgentModes().loadAgentModes()
    chat.messages = [
      {
        role: 'user',
        raw: 'three mockups',
        html: '<p>three mockups</p>',
        streaming: false,
        images: [
          { dataUrl: 'data:image/png;base64,AAAA', name: 'one.png', size: 3 },
          { dataUrl: 'data:image/png;base64,BBBB', name: 'two.png', size: 3 },
          { dataUrl: 'data:image/png;base64,CCCC', name: 'three.png', size: 3 },
        ],
      },
      { role: 'assistant', raw: 'got it', html: '<p>got it</p>', streaming: false },
    ]

    useChat().editLast()

    // The message waits in the strip with every image it carried, in order; the
    // draft is untouched, because it is the user's own typing.
    expect(chat.staged).toHaveLength(1)
    expect(chat.staged[0].raw).toBe('three mockups')
    expect(chat.staged[0].images.map((image) => image.name)).toEqual([
      'one.png',
      'two.png',
      'three.png',
    ])
    expect(chat.draft.raw).toBe('')
    expect(chat.pendingImages).toEqual([])
    // The thread lost the returned turn (and its reply).
    expect(chat.messages).toEqual([])
  })

  it('carries an image-less message back with an empty image list', () => {
    chat.messages = [
      { role: 'user', raw: 'plain', html: '<p>plain</p>', streaming: false, images: [] },
    ]
    useChat().editLast()
    expect(chat.staged).toHaveLength(1)
    expect(chat.staged[0].images).toEqual([])
  })
})

describe('a saved session keeps all three images on one turn', () => {
  it('round-trips them through the file and re-posts them', async () => {
    const posts = stubRoutes()
    await useAgentModes().loadAgentModes()
    chat.messages = [
      {
        role: 'user',
        raw: 'three mockups',
        html: '<p>three mockups</p>',
        streaming: false,
        images: [
          { dataUrl: 'data:image/png;base64,AAAA', name: 'one.png', size: 3 },
          { dataUrl: 'data:image/png;base64,BBBB', name: 'two.png', size: 3 },
          { dataUrl: 'data:image/png;base64,CCCC', name: 'three.png', size: 3 },
        ],
      },
    ]

    const doc = conversationJson(chat.messages)
    expect(imageParts(doc.messages[0])).toHaveLength(3)
    expect(doc.messages[0].content.filter((part) => part.type === 'image_url').map((part) => part.name))
      .toEqual(['one.png', 'two.png', 'three.png'])

    // A save and reload replaces the conversation, so start from an empty one.
    chat.messages = []
    const result = useChat().loadSession(parseSessionFile(JSON.stringify(doc)))
    expect(result).toEqual({ restored: 1 })
    expect(chat.messages[0].images.map((image) => image.name)).toEqual([
      'one.png',
      'two.png',
      'three.png',
    ])

    chat.draft.raw = 'go again'
    await useChat().send()
    await flushPromises()

    const sent = posts[0].messages
    // The restored turn keeps its three parts, and the new turn carries the rest.
    expect(imageParts(sent[0])).toHaveLength(3)
    expect(sent.at(-1).content).toBe('go again')
  })
})

describe('the pending-attachment chip draws one row per image', () => {
  it('renders four rows, and removing the second leaves three', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const w = mount(WorkBenchView, { attachTo: host })

    chat.pendingImages = [
      { dataUrl: 'data:image/png;base64,AAAA', name: 'one.png', size: 3 },
      { dataUrl: 'data:image/png;base64,BBBB', name: 'two.png', size: 3 },
      { dataUrl: 'data:image/png;base64,CCCC', name: 'three.png', size: 3 },
      { dataUrl: 'data:image/png;base64,DDDD', name: 'four.png', size: 3 },
    ]
    await flushPromises()

    const rows = () => w.findAll('.chat-attachment--pending')
    expect(rows()).toHaveLength(4)
    expect(rows().map((row) => row.find('.chat-attachment-name').text())).toEqual([
      'one.png',
      'two.png',
      'three.png',
      'four.png',
    ])
    // Each row carries its own lightbox target and its own remove button.
    for (const row of rows()) {
      expect(row.findAll('.chat-thumb-zoom')).toHaveLength(1)
      expect(row.findAll('.chat-attachment-remove')).toHaveLength(1)
    }

    await rows()[1].find('.chat-attachment-remove').trigger('click')
    await flushPromises()
    expect(rows()).toHaveLength(3)
    expect(rows().map((row) => row.find('.chat-attachment-name').text())).toEqual([
      'one.png',
      'three.png',
      'four.png',
    ])

    // The lightbox opens the row that was clicked, not the first of the set.
    await rows()[1].find('.chat-thumb-zoom').trigger('click')
    await flushPromises()
    expect(w.find('.image-lightbox img').attributes('alt')).toBe('three.png')

    w.unmount()
    host.remove()
  })

  it('leaves the empty state alone while images are pending', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const w = mount(WorkBenchView, { attachTo: host })

    expect(w.find('.stream-empty').exists()).toBe(true)
    chat.pendingImages = [{ dataUrl: 'data:image/png;base64,AAAA', name: 'a.png', size: 3 }]
    await flushPromises()
    expect(w.find('.stream-empty').exists()).toBe(false)

    w.unmount()
    host.remove()
  })
})

describe('the attach button answers about the list', () => {
  it('offers another image once one is pending, and badges itself', async () => {
    stubRoutes()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const w = mount(WorkBenchInput, { attachTo: host })
    appShell.config = { models: [{ id: 1, supportsVision: true }], currentModelId: 1 }
    await useAgentModes().loadAgentModes()
    await flushPromises()

    const button = () => w.find('.chat-attach')
    expect(button().attributes('aria-label')).toBe('Attach image')
    expect(button().find('.chat-attach-badge').exists()).toBe(false)

    // Two images pending: still one button, and it does not pretend to replace.
    chat.pendingImages = [
      { dataUrl: 'data:image/png;base64,AAAA', name: 'a.png', size: 3 },
      { dataUrl: 'data:image/png;base64,BBBB', name: 'b.png', size: 3 },
    ]
    await flushPromises()
    expect(button().attributes('aria-label')).toBe('Add another image')
    expect(button().attributes('title')).toBe('Add another image')
    expect(button().classes()).toContain('chat-attach--pending')
    expect(button().find('.chat-attach-badge').exists()).toBe(true)
    // The name stays distinct from the Send button's, which the e2e spec queries.
    expect(button().attributes('aria-label')).not.toContain('Send message')

    w.unmount()
    host.remove()
  })

  // The flag is `/api/config`'s **per model**, so the button answers about the
  // model the next send will run on — the selected agent's. Reading the
  // catalogue's first entry instead enabled it off another server's model.
  it('answers about the selected agent model, and follows the switch', async () => {
    stubRoutes()
    const host = document.createElement('div')
    document.body.appendChild(host)
    const w = mount(WorkBenchInput, { attachTo: host })
    appShell.config = {
      models: [
        { id: 1, name: 'model-1', supportsVision: true },
        { id: 2, name: 'model-2', supportsVision: false },
      ],
    }
    await useAgentModes().loadAgentModes()
    await flushPromises()

    const button = () => w.find('.chat-attach')
    expect(button().attributes('disabled')).toBeUndefined()

    await w.find('.chat-mode-select').setValue('chat')
    await flushPromises()

    expect(button().attributes('disabled')).toBeDefined()
    expect(button().attributes('aria-label')).toBe('Image input not supported')

    w.unmount()
    host.remove()
  })
})
