import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  MAX_FLUSH_IMAGES,
  conversationJson,
  conversationMarkdown,
  useChat,
} from '../src/composables/useChat'
import { useBatch } from '../src/composables/useBatch'
import { clearTabWorkspace } from './helpers/workspace-url'

// ---------------------------------------------------------------------------
// The strip: messages the composer has accepted but no turn has carried.
//
// It is input state of the same order as the draft — per tab, per conversation,
// never part of the thread, never a request — so the cases here assert the state
// machine and nothing about rendering: a stage moves the draft (with its images)
// to the end of the strip and opens no stream; a row is removed or pulled back by
// its id; and the image budget bounds the request a flush would make, counted
// over the strip plus the composer, refused as an image is added.
// ---------------------------------------------------------------------------

const chat = useChat().state
const batch = useBatch().state

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, body: null, json: () => Promise.resolve(body) })
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
  window.sessionStorage.clear()
}

// One real File through the real FileReader, the path `attachImage` takes: the
// reader's load event is a macrotask, so the wait is polled rather than flushed.
async function attach(name, byte = 0) {
  const bytes = new Uint8Array([byte, byte + 1, byte + 2, byte + 3])
  const file = new File([bytes], name, { type: 'image/png' })
  const accepted = useChat().attachImage(file)
  if (!accepted) return false
  await vi.waitFor(() => {
    expect(chat.pendingImages.some((image) => image.name === name)).toBe(true)
  })
  return true
}

function image(name, byte = 0) {
  return { dataUrl: `data:image/png;base64,AAAA${byte}`, name, size: 4 }
}

beforeEach(() => {
  resetAll()
})

afterEach(() => {
  vi.restoreAllMocks()
  resetAll()
})

describe('stage() moves the draft to the end of the strip', () => {
  // Every route the app could reach: a stage must touch none of them.
  function spies() {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () =>
      jsonResponse({}, false, 404),
    )
    return fetchSpy
  }

  it('appends a row after the ones already there, and opens no request', async () => {
    const fetchSpy = spies()
    chat.draft.raw = 'first thought'
    expect(useChat().stage()).toBe(true)
    expect(chat.staged.map((row) => row.raw)).toEqual(['first thought'])

    chat.draft.raw = 'second thought'
    expect(useChat().stage()).toBe(true)

    expect(chat.staged.map((row) => row.raw)).toEqual(['first thought', 'second thought'])
    // Order is the flush order, and the rows are addressed by an id each.
    expect(chat.staged[0].id).not.toBe(chat.staged[1].id)
    // Nothing about a stage is a turn: no request, no stream, no clock.
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(chat.phase).toBe('idle')
    expect(chat.session.startedAt).toBe(0)
  })

  it('carries the composer\'s images onto the row and empties the composer', async () => {
    spies()
    await attach('one.png', 0)
    await attach('two.png', 10)
    chat.draft.raw = 'two mockups'

    expect(useChat().stage()).toBe(true)

    expect(chat.staged).toHaveLength(1)
    const [row] = chat.staged
    expect(row.raw).toBe('two mockups')
    // A staged row is what a user message is: rendered text, no stream, images.
    expect(row.role).toBe('user')
    expect(row.streaming).toBe(false)
    expect(row.html).toContain('<p>')
    expect(row.html).toContain('two mockups')
    expect(row.images.map((it) => it.name)).toEqual(['one.png', 'two.png'])

    // The composer is empty again, text and images both.
    expect(chat.draft.raw).toBe('')
    expect(chat.draft.html).toBe('')
    expect(chat.pendingImages).toEqual([])
  })

  it('stages an image-only draft', async () => {
    spies()
    await attach('only.png', 0)
    expect(useChat().stage()).toBe(true)
    expect(chat.staged).toHaveLength(1)
    expect(chat.staged[0].raw).toBe('')
    expect(chat.staged[0].images.map((it) => it.name)).toEqual(['only.png'])
    expect(chat.pendingImages).toEqual([])
  })

  it('does nothing at all for an empty draft with no image', () => {
    const fetchSpy = spies()
    chat.error = null
    expect(useChat().stage()).toBe(false)
    expect(chat.staged).toEqual([])
    expect(chat.error).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('renders the draft through the one renderer, like a send does', () => {
    spies()
    chat.draft.raw = '**bold**'
    useChat().stage()
    // Same seam a sent turn's `html` comes from: the markdown renderer, never
    // raw text handed to the template.
    expect(chat.staged[0].html).toBe('<p><strong>bold</strong></p>\n')
  })
})

describe('a staged message is not the conversation', () => {
  it('leaves state.messages, the markdown copy and the JSON file alone', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({}, false, 404))
    chat.messages = [
      { role: 'user', raw: 'already sent', html: '<p>already sent</p>', streaming: false },
    ]
    const before = chat.messages.slice()

    chat.draft.raw = 'still staged'
    useChat().stage()

    expect(chat.messages).toEqual(before)
    expect(conversationMarkdown(chat.messages)).toBe('## user\n\nalready sent')
    expect(conversationMarkdown(chat.messages)).not.toContain('still staged')
    const doc = conversationJson(chat.messages)
    expect(doc.messages.map((item) => item.content)).toEqual(['already sent'])
    expect(JSON.stringify(doc)).not.toContain('still staged')
  })
})

describe('the strip is read-only while the conversation is busy', () => {
  function withOneRow() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({}, false, 404))
    chat.draft.raw = 'staged thought'
    useChat().stage()
    chat.error = null
    return chat.staged[0].id
  }

  function assertUntouched(id) {
    expect(chat.staged).toHaveLength(1)
    expect(chat.staged[0].id).toBe(id)
    expect(chat.staged[0].raw).toBe('staged thought')
  }

  it('refuses a stage while a reply streams', () => {
    const id = withOneRow()
    chat.phase = 'answering'
    chat.draft.raw = 'typed mid-reply'

    expect(useChat().stage()).toBe(false)
    assertUntouched(id)
    // The draft is untouched too: a refused stage moves nothing.
    expect(chat.draft.raw).toBe('typed mid-reply')
  })

  it('refuses a stage while a batch owns the conversation', () => {
    const id = withOneRow()
    batch.active = true
    chat.draft.raw = 'typed mid-lot'

    expect(useChat().stage()).toBe(false)
    assertUntouched(id)
    expect(chat.draft.raw).toBe('typed mid-lot')
  })

  it('refuses a remove and a pull-back in both busy windows', () => {
    const id = withOneRow()
    const phases = [
      () => {
        chat.phase = 'answering'
      },
      () => {
        chat.phase = 'idle'
        batch.active = true
      },
    ]
    for (const enter of phases) {
      enter()
      expect(useChat().removeStaged(id)).toBe(false)
      assertUntouched(id)
      expect(useChat().pullBackStaged(id)).toBe(false)
      assertUntouched(id)
      expect(chat.draft.raw).toBe('')
      expect(chat.pendingImages).toEqual([])
      chat.phase = 'idle'
      batch.active = false
    }
  })
})

describe('removeStaged() and pullBackStaged() address one row by its id', () => {
  function stageThree() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({}, false, 404))
    for (const text of ['one', 'two', 'three']) {
      chat.draft.raw = text
      useChat().stage()
    }
    return chat.staged.map((row) => row.id)
  }

  it('drops exactly the row named, keeping the rest in order', () => {
    const [first, second, third] = stageThree()
    expect(useChat().removeStaged(second)).toBe(true)
    expect(chat.staged.map((row) => row.id)).toEqual([first, third])
    expect(chat.staged.map((row) => row.raw)).toEqual(['one', 'three'])

    // An id the strip no longer holds (a second click) touches nothing.
    expect(useChat().removeStaged(second)).toBe(false)
    expect(chat.staged).toHaveLength(2)
  })

  it('pulls a row back into the composer: its text and all its images', async () => {
    stageThree()
    const [first, second, third] = chat.staged.map((row) => row.id)
    // Give the middle row two images, the way a staged mockup set carries them.
    chat.staged[1].images = [image('a.png', 1), image('b.png', 2)]

    expect(useChat().pullBackStaged(second)).toBe(true)

    expect(chat.staged.map((row) => row.id)).toEqual([first, third])
    expect(chat.draft.raw).toBe('two')
    expect(chat.pendingImages.map((it) => it.name)).toEqual(['a.png', 'b.png'])
  })

  it('appends a pulled-back row\'s images after the composer\'s own', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({}, false, 404))
    chat.draft.raw = 'staged'
    useChat().stage()
    const id = chat.staged[0].id
    chat.staged[0].images = [image('staged.png', 1)]
    chat.pendingImages = [image('composer.png', 2)]

    useChat().pullBackStaged(id)

    expect(chat.pendingImages.map((it) => it.name)).toEqual(['composer.png', 'staged.png'])
    // A transfer, not an addition: the budget it was already inside still holds.
    expect(chat.error).toBeNull()
  })
})

describe('the strip offers no verb and no field this lot did not ask for', () => {
  it('exports no re-ordering verb: order is the flush order, and only that', () => {
    const api = useChat()
    // Whole names, not substrings: `removeStaged` legitimately carries "move".
    const reordering = Object.keys(api).filter((name) =>
      /^(reorder|sortStaged|moveStaged|moveRow|moveUp|moveDown|swapStaged)/.test(name),
    )
    expect(reordering).toEqual([])
    // The three verbs that exist are the three the lot asked for, and nothing
    // beside them acts on a row's position.
    expect(typeof api.stage).toBe('function')
    expect(typeof api.removeStaged).toBe('function')
    expect(typeof api.pullBackStaged).toBe('function')
  })

  it('names a staged message as waiting, never as reaching the reply in flight', () => {
    // Staging is refused while a reply streams, so no string may suggest that a
    // staged message joins the turn in flight. The two halves that carry the
    // feature's words are the component and the composer's own labels.
    const strip = readFileSync(
      join(resolve(), 'src', 'components', 'StagedMessageStrip.vue'),
      'utf8',
    )
    const composer = readFileSync(
      join(resolve(), 'src', 'components', 'WorkBenchInput.vue'),
      'utf8',
    )
    // The wording that says what a row is: waiting, not yet sent.
    expect(strip).toContain('Staged messages (not sent yet)')
    expect(composer).toContain('Stage the draft as a message not yet sent')
    for (const source of [strip, composer]) {
      const words = source.toLowerCase()
      for (const word of ['steer', 'inject', 'while it answers', 'into the running']) {
        expect(words).not.toContain(word)
      }
    }
  })

  it('stages no per-message agent, model or workspace choice', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({}, false, 404))
    chat.draft.raw = 'one brief'
    useChat().stage()

    // A row is what a user message is plus the id that addresses it. Anything
    // that named an agent, a model or a folder here would be a per-message
    // choice this feature deliberately does not have — one flush runs as one
    // agent, in one folder, on one connection.
    expect(Object.keys(chat.staged[0]).sort()).toEqual([
      'html',
      'id',
      'images',
      'raw',
      'role',
      'streaming',
    ])
  })
})

describe('the image budget bounds the request a flush would make', () => {
  function stub() {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => jsonResponse({}, false, 404))
  }

  it('is a named constant, not a literal at the call site', () => {
    expect(MAX_FLUSH_IMAGES).toBe(6)
  })

  it('refuses the seventh image with a sentence naming the budget and the count', async () => {
    stub()
    for (let i = 0; i < MAX_FLUSH_IMAGES; i += 1) {
      await attach(`image-${i}.png`, i * 10)
    }
    expect(chat.pendingImages).toHaveLength(MAX_FLUSH_IMAGES)

    const seventh = new File([new Uint8Array([1, 2, 3, 4])], 'seventh.png', {
      type: 'image/png',
    })
    expect(useChat().attachImage(seventh)).toBe(false)

    expect(chat.error).toContain(String(MAX_FLUSH_IMAGES))
    expect(chat.error).toContain('7 images')
    // Nothing changed: the six already attached are still there.
    expect(chat.pendingImages.map((it) => it.name)).toEqual([
      'image-0.png',
      'image-1.png',
      'image-2.png',
      'image-3.png',
      'image-4.png',
      'image-5.png',
    ])
  })

  it('counts the strip\'s images too, because a flush would carry them', async () => {
    stub()
    await attach('one.png', 0)
    await attach('two.png', 10)
    chat.draft.raw = 'a brief with two mockups'
    useChat().stage()

    // Four more fit; the fifth would be the seventh image of the set.
    for (let i = 0; i < 4; i += 1) {
      await attach(`filler-${i}.png`, 20 + i)
    }
    expect(chat.pendingImages).toHaveLength(4)

    const extra = new File([new Uint8Array([9, 9, 9, 9])], 'extra.png', { type: 'image/png' })
    expect(useChat().attachImage(extra)).toBe(false)
    expect(chat.error).toContain('7 images')
    expect(chat.error).toContain(String(MAX_FLUSH_IMAGES))
    expect(chat.pendingImages).toHaveLength(4)
  })

  it('leaves the per-image size limit exactly where it was', async () => {
    stub()
    const huge = new File([new Uint8Array([1])], 'huge.png', { type: 'image/png' })
    // Pretend the file is oversized without allocating ten megabytes.
    Object.defineProperty(huge, 'size', { value: 10 * 1024 * 1024 + 1 })
    expect(useChat().attachImage(huge)).toBe(false)
    expect(chat.error).toContain('Image too large')
    expect(chat.error).not.toContain('at most')
  })
})
