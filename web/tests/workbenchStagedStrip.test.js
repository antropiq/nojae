import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// jsdom has no ResizeObserver, and the chat splitters each create one on mount.
// A no-op is enough: nothing here measures a size.
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

import StagedMessageStrip from '../src/components/StagedMessageStrip.vue'
import WorkBenchView from '../src/components/WorkBenchView.vue'
import { flushGateReason, useChat } from '../src/composables/useChat'
import { useBatch } from '../src/composables/useBatch'
import { renderMarkdown } from '../src/lib/markdown'

// ---------------------------------------------------------------------------
// The strip in the composer area.
//
// The staged messages are drawn where the draft preview is drawn — in the
// conversation pane, above it and beside the lightbox their thumbnails open —
// because a staged message is the next thing that will be sent. Everything the
// rows *do* is useChat's verbs; what is asserted here is that the component
// renders that state and decides nothing of its own: the numbers are positions
// in flush order, the verdict is the flush's own, the strip is inert when empty
// and read-only (never hidden) while the composer is shut.
//
// Nothing here stages from the browser: the chord and the Stage button are a
// later change, so every row is put in through the composable's own verb.
// ---------------------------------------------------------------------------

const chat = useChat().state
const batch = useBatch().state

// A chat-template control token, built from its characters so this file never
// carries a complete run of its own.
const PIPE = '|'
const run = (name) => `<${PIPE}${name}${PIPE}>`

function image(name, byte = 0) {
  return { dataUrl: `data:image/png;base64,AAAA${byte}`, name, size: 4 }
}

function resetAll() {
  chat.phase = 'idle'
  chat.messages = []
  chat.error = null
  chat.pausePending = false
  chat.staged = []
  chat.pendingImages = []
  chat.draft = { raw: '', html: '', renderedRaw: '' }
  batch.active = false
  batch.status = 'idle'
}

// One staged row, put in through the composable's own verb: type it, attach what
// travels with it, stage. The row under test is therefore the row the browser
// would hold, rendered by the same path a send takes.
function stage(text, images = []) {
  // Typed straight into the state rather than through `setDraft`: that one arms
  // the preview's debounce, and a timer outliving its case would write a draft
  // into the next one.
  chat.draft = { raw: text, html: '', renderedRaw: '' }
  chat.pendingImages = images.map((entry) => ({ ...entry }))
  expect(useChat().stage()).toBe(true)
}

function rowsIn(w) {
  return w.findAll('.chat-staged-row')
}

function rowTexts(w) {
  return rowsIn(w).map((row) => row.find('.answer').text())
}

function numberOf(row) {
  return row.find('.chat-staged-number').text()
}

function removeButton(row) {
  return row.find('.chat-staged-remove')
}

function pullButton(row) {
  return row.find('.chat-staged-pull')
}

function themeCss() {
  return readFileSync(join(resolve(), 'src', 'styles', 'theme.css'), 'utf8')
}

// One selector list per rule block, comments removed first: this stylesheet
// documents these classes in prose, and a scan that read a comment as a selector
// would be asserting on documentation instead of on a rule.
function ruleSelectors(css) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map((match) =>
    match[1].replace(/\s+/g, ' ').trim(),
  )
}

beforeEach(() => {
  resetAll()
})

afterEach(() => {
  resetAll()
})

describe('the strip renders the staged list in flush order', () => {
  it('draws three numbered rows, in order, with their text', () => {
    stage('first thought')
    stage('**second** thought')
    stage('third thought')
    const w = mount(StagedMessageStrip)

    expect(rowsIn(w)).toHaveLength(3)
    expect(rowsIn(w).map(numberOf)).toEqual(['1', '2', '3'])
    expect(rowTexts(w)).toEqual(['first thought', 'second thought', 'third thought'])
    // The text comes through the one markdown renderer, exactly as the draft
    // preview renders it — never raw text handed to the template.
    expect(rowsIn(w)[1].html()).toContain('<strong>second</strong>')
    expect(rowsIn(w)[1].classes()).toContain('chat-staged-row')
    w.unmount()
  })

  it('renumbers after a removal, because a number is a position', async () => {
    stage('one')
    stage('two')
    stage('three')
    const w = mount(StagedMessageStrip)

    await removeButton(rowsIn(w)[0]).trigger('click')
    await flushPromises()

    expect(rowsIn(w)).toHaveLength(2)
    expect(rowsIn(w).map(numberOf)).toEqual(['1', '2'])
    expect(rowTexts(w)).toEqual(['two', 'three'])
    w.unmount()
  })

  it('marks a removal and a pull-back as acting on one named message', () => {
    stage('one')
    stage('two')
    const w = mount(StagedMessageStrip)

    // A list of identical "Remove" buttons would be unusable to a screen reader,
    // so each one names the message it acts on — and the two verbs never share a
    // name with each other or with a control elsewhere in the composer.
    const labels = rowsIn(w).flatMap((row) => [
      removeButton(row).attributes('aria-label'),
      pullButton(row).attributes('aria-label'),
    ])
    expect(new Set(labels).size).toBe(4)
    expect(labels).toEqual([
      'Remove staged message 1',
      'Pull staged message 1 back into the composer',
      'Remove staged message 2',
      'Pull staged message 2 back into the composer',
    ])
    for (const row of rowsIn(w)) {
      for (const button of [removeButton(row), pullButton(row)]) {
        // Icon-only, named like the rest of this composer: a glyph plus a title.
        expect(button.attributes('title')).toBeTruthy()
        expect(button.findAll('svg')).toHaveLength(1)
        expect(button.text()).toBe('')
        // The phrase the pinned e2e spec finds the Send button by stays that
        // button's alone, whatever state the strip is in.
        expect(button.attributes('aria-label')).not.toContain('Send message')
        expect(button.attributes('title')).not.toContain('Send message')
      }
    }
    w.unmount()
  })

  it('names the thumbnails the way the sent turns\' own do', () => {
    stage('one mockup', [image('a.png', 1)])
    const w = mount(WorkBenchView)

    // One wording for one gesture across the pane, and distinct from the two
    // verbs: the thumbnail opens, the row's buttons act.
    const label = w.find('.chat-staged-thumbs .chat-thumb-zoom').attributes('aria-label')
    expect(label).toBe('View a.png at full size')
    expect(label).not.toContain('Send message')
    w.unmount()
  })

  it('renders its text through the one renderer, with no v-html of its own', () => {
    const source = readFileSync(
      join(resolve(), 'src', 'components', 'StagedMessageStrip.vue'),
      'utf8',
    )
    // The single markdown renderer is `lib/`'s, reached through MarkdownStream —
    // the same seam the draft preview uses. No second renderer, no raw HTML.
    expect(source).not.toMatch(/v-html/)
    expect(source).toContain("from './MarkdownStream.vue'")
  })

  it('draws one thumbnail per image, each naming its image', () => {
    stage('two mockups', [image('a.png', 1), image('b.png', 2)])
    const w = mount(StagedMessageStrip)

    const thumbs = rowsIn(w)[0].findAll('.chat-thumb-zoom')
    expect(thumbs).toHaveLength(2)
    expect(thumbs.map((thumb) => thumb.find('img').attributes('alt'))).toEqual([
      'a.png',
      'b.png',
    ])
    expect(thumbs[0].attributes('aria-label')).toBe('View a.png at full size')
    w.unmount()
  })

  it('pulls one row back into the composer: its text and every image', async () => {
    stage('one', [image('a.png', 1)])
    stage('two', [image('b.png', 2)])
    const w = mount(StagedMessageStrip)

    await pullButton(rowsIn(w)[0]).trigger('click')
    await flushPromises()

    expect(rowsIn(w)).toHaveLength(1)
    expect(rowTexts(w)).toEqual(['two'])
    expect(chat.draft.raw).toBe('one')
    expect(chat.pendingImages.map((it) => it.name)).toEqual(['a.png'])
    w.unmount()
  })
})

describe('an empty strip occupies no space at all', () => {
  it('puts no strip element in the DOM', () => {
    const w = mount(WorkBenchView)

    expect(w.find('.chat-staged-strip').exists()).toBe(false)
    expect(w.findAll('.chat-staged-row')).toHaveLength(0)
    expect(w.find('.chat-staged-list').exists()).toBe(false)
    // The pane and the composer are exactly what they were: the empty state is
    // still the empty state, and the composer is still there.
    expect(w.find('.stream-empty').exists()).toBe(true)
    expect(w.find('.chat-input').exists()).toBe(true)
    w.unmount()
  })

  it('displaces the empty state once it holds a message', async () => {
    const w = mount(WorkBenchView)
    expect(w.find('.stream-empty').exists()).toBe(true)

    stage('a brief')
    await flushPromises()

    expect(w.find('.chat-staged-strip').exists()).toBe(true)
    expect(w.find('.stream-empty').exists()).toBe(false)
    w.unmount()
  })

  it('has no rule that reserves space for it, so the empty box cannot appear', () => {
    const css = themeCss()
    // The box exists only while the template renders it; the rule bounds a
    // populated strip, it does not give an empty one a height.
    expect(ruleSelectors(css)).toContain('.chat-staged-strip')
    const body = css.match(/\.chat-staged-strip\s*\{([^}]*)\}/)[1]
    expect(body).toContain('max-height')
    expect(body).not.toMatch(/min-height\s*:/)
  })
})

describe('the strip lives with the conversation, above the draft preview', () => {
  it('is drawn in the pane, above the draft, outside the composer', async () => {
    stage('a staged thought')
    chat.draft = {
      raw: 'a draft',
      html: renderMarkdown('a draft'),
      renderedRaw: 'a draft',
    }
    const w = mount(WorkBenchView)
    await flushPromises()

    const strip = w.find('.chat-output .chat-staged-strip')
    expect(strip.exists()).toBe(true)
    // It is not part of the composer's own row: the textarea and the action row
    // keep the geometry they have.
    expect(w.find('.chat-input .chat-staged-strip').exists()).toBe(false)

    // Above the draft preview in document order: the order they will be sent in.
    const pane = w.find('.chat-output').element
    const stripEl = strip.element
    const draftEl = w.find('.chat-bubble--draft').element
    expect(
      stripEl.compareDocumentPosition(draftEl) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy()
    expect(pane.contains(stripEl)).toBe(true)
    w.unmount()
  })

  it('opens the pane\'s own lightbox from a row thumbnail', async () => {
    stage('two mockups', [image('one.png', 1), image('two.png', 2)])
    const w = mount(WorkBenchView)
    await flushPromises()

    await rowsIn(w)[0].findAll('.chat-thumb-zoom')[1].trigger('click')
    await flushPromises()

    // The same full-size lightbox a sent turn's thumbnails open.
    expect(w.find('.image-lightbox img').attributes('alt')).toBe('two.png')
    w.unmount()
  })
})

describe('the strip is read-only, never hidden, while the composer is shut', () => {
  const BUSY = [
    ['a reply streams', () => { chat.phase = 'answering' }],
    ['a batch owns the conversation', () => { batch.active = true }],
  ]

  for (const [label, enter] of BUSY) {
    it(`keeps every row at full text and shuts both verbs while ${label}`, async () => {
      stage('first thought')
      stage('second thought', [image('a.png', 1)])
      const w = mount(StagedMessageStrip)
      enter()
      await flushPromises()

      // Still there, at full text and with the image it carries.
      expect(rowsIn(w)).toHaveLength(2)
      expect(rowTexts(w)).toEqual(['first thought', 'second thought'])
      expect(rowsIn(w)[1].findAll('.chat-thumb-zoom')).toHaveLength(1)

      for (const row of rowsIn(w)) {
        for (const button of [removeButton(row), pullButton(row)]) {
          expect(button.attributes('disabled')).toBeDefined()
          // Disabled *and* saying why, rather than a mute refusal.
          expect(button.attributes('title')).toContain('no reply is streaming')
          expect(button.attributes('title')).toContain('no batch runs')
        }
      }
      w.unmount()
    })
  }

  it('looks like nothing in flight: no spinner, no badge, no stream marker', async () => {
    stage('a staged thought')
    const w = mount(StagedMessageStrip)
    chat.phase = 'answering'
    await flushPromises()

    const html = w.html()
    expect(html).not.toContain('chat-typing')
    expect(html).not.toContain('aria-busy')
    expect(html).not.toContain('is-streaming')
    expect(html).not.toContain('chat-attach-badge')
    w.unmount()
  })

  it('comes back live when the conversation is idle again', async () => {
    stage('a staged thought')
    const w = mount(StagedMessageStrip)
    chat.phase = 'answering'
    await flushPromises()
    expect(removeButton(rowsIn(w)[0]).attributes('disabled')).toBeDefined()

    chat.phase = 'idle'
    await flushPromises()
    expect(removeButton(rowsIn(w)[0]).attributes('disabled')).toBeUndefined()
    expect(pullButton(rowsIn(w)[0]).attributes('disabled')).toBeUndefined()
    w.unmount()
  })
})

describe('a row the flush would be refused over is named', () => {
  // Looks non-empty in the strip; the server strips the run and receives
  // nothing, which is the blank user turn it rejects as a whole request.
  const BLANK = run('im_start')

  function refusalOf(raw) {
    return flushGateReason({ raw, images: [] })
  }

  it('renders the verdict\'s own sentence, announced, on that row alone', async () => {
    stage('a good brief')
    stage(BLANK)
    stage('another good brief')
    const w = mount(StagedMessageStrip)
    await flushPromises()

    const marked = w.findAll('.chat-staged-row--refused')
    expect(marked).toHaveLength(1)
    expect(marked[0].element).toBe(rowsIn(w)[1].element)

    const line = marked[0].find('.chat-staged-refusal')
    expect(line.exists()).toBe(true)
    // The verdict's own words, not a second copy of the rule.
    expect(line.text()).toContain(refusalOf(BLANK))
    expect(line.attributes('role')).toBe('alert')
    w.unmount()
  })

  it('marks the row by more than colour alone', () => {
    // A border weight and a glyph travel with the class, so the marking survives
    // a reader who cannot tell the colours apart.
    const css = themeCss()
    const rule = css.match(/\.chat-staged-row--refused\s*\{[^}]*\}/)
    expect(rule, 'the refused row has a rule of its own').not.toBeNull()
    expect(rule[0]).toContain('border-left-width')
    expect(rule[0]).toContain('border-style')
  })

  it('clears the marking when the row is removed', async () => {
    stage('a good brief')
    stage(BLANK)
    const w = mount(StagedMessageStrip)
    expect(w.findAll('.chat-staged-row--refused')).toHaveLength(1)

    await removeButton(rowsIn(w)[1]).trigger('click')
    await flushPromises()

    expect(rowsIn(w)).toHaveLength(1)
    expect(w.findAll('.chat-staged-row--refused')).toHaveLength(0)
    expect(w.find('.chat-staged-refusal').exists()).toBe(false)
    w.unmount()
  })

  it('clears the marking when the row is fixed in the composer and restaged', async () => {
    stage(BLANK)
    const w = mount(StagedMessageStrip)
    expect(w.findAll('.chat-staged-row--refused')).toHaveLength(1)

    await pullButton(rowsIn(w)[0]).trigger('click')
    await flushPromises()
    expect(w.find('.chat-staged-refusal').exists()).toBe(false)

    stage('now it says something')
    await flushPromises()
    expect(rowsIn(w)).toHaveLength(1)
    expect(w.findAll('.chat-staged-row--refused')).toHaveLength(0)
    w.unmount()
  })

  it('never marks an image-only message, whose text legitimately arrives empty', () => {
    stage('', [image('mockup.png', 1)])
    const w = mount(StagedMessageStrip)
    expect(w.findAll('.chat-staged-row--refused')).toHaveLength(0)
    w.unmount()
  })
})

describe('a long strip scrolls inside its own box', () => {
  it('is bounded by a scroll box, not by a count', async () => {
    for (let i = 0; i < 40; i += 1) stage(`message ${i + 1}`)
    // No cap on how many messages the strip may hold, so all forty are there.
    const w = mount(StagedMessageStrip)
    expect(rowsIn(w)).toHaveLength(40)
    w.unmount()

    // The bound is the style's: the box scrolls rather than pushing the
    // conversation out of the pane.
    const css = themeCss()
    const body = css.match(/\.chat-staged-strip\s*\{([^}]*)\}/)[1]
    expect(body).toContain('max-height')
    expect(body).toContain('overflow-y: auto')
  })

  it('leaves the textarea and the action row their own sizes', async () => {
    const w = mount(WorkBenchView)
    const before = {
      textarea: w.find('.chat-textarea').exists(),
      actions: w.find('.chat-bullet-actions--right').exists(),
      composer: w.find('.chat-input').exists(),
    }
    for (let i = 0; i < 20; i += 1) stage(`message ${i + 1}`)
    await flushPromises()

    // The strip is a sibling of nothing in the composer: the textarea and the
    // button row are still exactly one each, unchanged by what the strip holds.
    expect(w.findAll('.chat-textarea')).toHaveLength(1)
    expect(w.findAll('.chat-bullet-actions--right')).toHaveLength(1)
    expect(w.findAll('.chat-input')).toHaveLength(1)
    expect(before).toEqual({ textarea: true, actions: true, composer: true })
    w.unmount()
  })
})

describe('the strip is input state: no route, no stream, no store', () => {
  function readSource(...parts) {
    return readFileSync(join(resolve(), 'src', ...parts), 'utf8')
  }

  it('spells no API route and no write verb anywhere on the staging path', () => {
    // Staging touches nothing on the network, so a URL in either half of the
    // feature — the composable's verbs or the component that draws them — would
    // be the first sign it had become something else.
    const chat = readSource('composables', 'useChat.js')
    const stagePath = chat.slice(
      chat.indexOf('function stage()'),
      chat.indexOf('// Everything a conversation needs freshly snapshotted'),
    )
    expect(stagePath).not.toBe('')
    for (const source of [stagePath, readSource('components', 'StagedMessageStrip.vue')]) {
      expect(source).not.toContain('/api/')
      expect(source).not.toMatch(/\bfetch\(/)
      expect(source).not.toMatch(/method:\s*'(POST|PUT|PATCH|DELETE)'/)
    }
  })

  it('is never persisted and never synced, by the composable or the component', () => {
    const strip = readSource('components', 'StagedMessageStrip.vue')
    for (const source of [strip]) {
      expect(source).not.toContain('localStorage')
      expect(source).not.toContain('sessionStorage')
      expect(source).not.toContain('BroadcastChannel')
    }
    // The draft's own storage is the Enter-toggle preference alone; nothing in
    // the composable writes the strip to either storage.
    const chat = readSource('composables', 'useChat.js')
    expect(chat).not.toMatch(/(localStorage|sessionStorage)[.\[]/s)
  })

  it('opens no stream: the component subscribes to nothing', () => {
    const strip = readSource('components', 'StagedMessageStrip.vue')
    expect(strip).not.toContain('EventSource')
    expect(strip).not.toContain('addEventListener')
    // Its whole script surface is the composable's read of the staged list and
    // the two verbs plus the lightbox emit.
    expect(strip).toContain('useChat()')
  })

  it('reuses the one control-token stripper instead of a second copy of the rule', () => {
    // Both doors strip control-token runs, so the flush's verdict has to ask the
    // question with the renderer's own rule. A second regex in `web/src` is how
    // the two would drift.
    const chat = readSource('composables', 'useChat.js')
    expect(chat).toContain('neutralizeControlTokenRuns')
    // One spelling of the rule in the whole source tree: the renderer's.
    const markdown = readSource('lib', 'markdown.js')
    expect(markdown).toContain('export function neutralizeControlTokenRuns')
    expect(chat).not.toMatch(/<\\?\|[^/]*\\?\|>/)
    expect(readSource('components', 'StagedMessageStrip.vue')).not.toMatch(/<\\?\|/)
  })

  it('adds no second writer of wire content: the payload builder is the only one', () => {
    const chat = readSource('composables', 'useChat.js')
    // Two spellings of `content:` in the builder — text-only and the parts form —
    // and batch mode's own one-instruction payload, which never reads the
    // conversation. A fourth would be a second writer.
    const builder = chat.slice(
      chat.indexOf('function messagePayload('),
      chat.indexOf('// Save / load a session as a JSON file'),
    )
    expect(builder).not.toBe('')
    expect([...builder.matchAll(/content:/g)]).toHaveLength(2)
    // Neither the strip's verbs nor the flush builds wire content of its own:
    // they hand their messages to the builder.
    const stripVerbs = chat.slice(
      chat.indexOf('function stage()'),
      chat.indexOf('// The tab\'s folder moved'),
    )
    const flush = chat.slice(
      chat.indexOf('async function send() {'),
      chat.indexOf('function sendBatchTurn('),
    )
    for (const path of [stripVerbs, flush]) {
      expect(path).not.toBe('')
      expect(path).not.toMatch(/content:/)
    }
    expect(flush).toContain('...state.messages.map(messagePayload)')
    expect(flush).toContain('...userMessages.map(messagePayload)')
  })
})

describe('the pane\'s auto-scroll tracks the strip', () => {
  it('counts the strip in the version string that re-anchors the pane', () => {
    // The version string is the watch source the pane's auto-scroll re-anchors
    // on: a stage has to move it the way typing does, or the new row lands below
    // the fold with the pane pinned where it was.
    const source = readFileSync(
      join(resolve(), 'src', 'components', 'WorkBenchView.vue'),
      'utf8',
    )
    const version = source.match(/const contentVersion = computed\(\(\) =>([\s\S]*?)\n\)/)
    expect(version, 'the version string is where it was').not.toBeNull()
    expect(version[1]).toContain('state.staged')
  })
})
