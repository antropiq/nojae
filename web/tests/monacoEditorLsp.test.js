import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

// ---------------------------------------------------------------------------
// lspe-09: the Monaco surface's language-server half.
//
// A real Monaco cannot be mounted in jsdom (it needs a canvas — see
// probe-monaco.test.js), so `monaco-editor` is replaced by a fake that records
// what the component asks of it. That is exactly the right seam here: what this
// suite asserts is the component's *decisions* — which URI a model gets, when a
// model is replaced, which providers are registered against which scheme, what
// a provider answers, and what the two gestures do — not Monaco's rendering.
//
// The rules under test are the spec's: a synthetic scheme and never `file://`
// (§6), a quiet answer producing no throw and no notice (§4.10), the buffer's
// text travelling only when the buffer is dirty (§4.5), the position converted
// in `lib/monaco-lsp.js` and never here (§4.8), hover markdown handed over with
// HTML support off (§4.9), and the built-in TypeScript worker left alone (§4.15).
// ---------------------------------------------------------------------------

const fake = vi.hoisted(() => {
  const state = {
    models: [],
    editors: [],
    providers: { definition: [], hover: [], references: [] },
    openers: [],
    commands: [],
    disposed: [],
    // Every disposable the component was handed, so the teardown can be
    // asserted rather than assumed.
    disposables: [],
  }
  function disposable() {
    const handle = { disposed: false, dispose() { this.disposed = true } }
    state.disposables.push(handle)
    return handle
  }
  function makeModel(value, language, uri) {
    const model = {
      value,
      language,
      uri: uri ?? { toString: () => `inmemory://model/${state.models.length}` },
      disposed: false,
      listeners: [],
      onDidChangeContent(fn) {
        this.listeners.push(fn)
        return { dispose() {} }
      },
      getValue() {
        return this.value
      },
      setValue(next) {
        this.value = next
      },
      getLineCount() {
        return this.value.split('\n').length
      },
      // The real model's longest column on a line, which is what `clampReveal`
      // caps a reveal's column to.
      getLineMaxColumn(line) {
        return (this.value.split('\n')[line - 1] ?? '').length + 1
      },
      dispose() {
        this.disposed = true
        state.disposed.push(this)
      },
    }
    state.models.push(model)
    return model
  }
  function makeEditor(host, options) {
    const editor = {
      host,
      options,
      model: options.model,
      position: { lineNumber: 1, column: 1 },
      revealed: [],
      disposed: false,
      addCommand(keybinding, handler) {
        state.commands.push({ keybinding, handler })
      },
      setModel(next) {
        this.model = next
      },
      getModel() {
        return this.model
      },
      getPosition() {
        return this.position
      },
      setPosition(position) {
        this.position = position
      },
      revealLineInCenter(line) {
        this.revealed.push(line)
      },
      updateOptions(next) {
        this.options = { ...this.options, ...next }
      },
      focus() {},
      dispose() {
        this.disposed = true
      },
    }
    state.editors.push(editor)
    return editor
  }
  return { state, makeModel, makeEditor, disposable }
})

vi.mock('monaco-editor', () => {
  const disposable = () => fake.disposable()
  return {
    KeyMod: { CtrlCmd: 2048, Shift: 1024, Alt: 512 },
    KeyCode: { KeyP: 41, F12: 70 },
    Range: class Range {
      constructor(startLineNumber, startColumn, endLineNumber, endColumn) {
        Object.assign(this, { startLineNumber, startColumn, endLineNumber, endColumn })
      }
    },
    Uri: {
      parse: (value) => ({ toString: () => value }),
    },
    editor: {
      createModel: (value, language, uri) => fake.makeModel(value, language, uri),
      create: (host, options) => fake.makeEditor(host, options),
      registerEditorOpener: (opener) => {
        fake.state.openers.push(opener)
        return disposable()
      },
      setModelLanguage: (model, language) => {
        model.language = language
      },
      setTheme: () => {},
    },
    languages: {
      registerDefinitionProvider: (selector, provider) => {
        fake.state.providers.definition.push({ selector, provider })
        return disposable()
      },
      registerHoverProvider: (selector, provider) => {
        fake.state.providers.hover.push({ selector, provider })
        return disposable()
      },
      registerReferenceProvider: (selector, provider) => {
        fake.state.providers.references.push({ selector, provider })
        return disposable()
      },
    },
  }
})

import MonacoEditor from '../src/components/MonacoEditor.vue'
import { EDITOR_URI_SCHEME, editorUriFor } from '../src/lib/monaco-lsp'
import { useChat } from '../src/composables/useChat'
import { useEditorFiles } from '../src/composables/useEditorFiles'
import { useEditorLsp } from '../src/composables/useEditorLsp'

const files = useEditorFiles()
const lsp = useEditorLsp()
const chat = useChat()

function fileRecord(path, text, dirty = false) {
  return {
    kind: 'file',
    key: path,
    path,
    name: path.slice(path.lastIndexOf('/') + 1),
    text,
    baseline: dirty ? '' : text,
    dirty,
    mtime: 1000,
    language: 'python',
    size: text.length,
    binary: false,
    truncated: false,
    truncatedAt: null,
    encoding: 'utf-8',
    stale: false,
    deleted: false,
    conflict: null,
    conflictAt: 0,
    conflictDetail: null,
    saving: false,
    reloadedAt: 0,
  }
}

function jsonResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) })
}

function envelope({ status = 'ok', server = 'pyright', reason = null, action, result = null }) {
  return { status, server, reason, action, result }
}

function sentBody(fetchMock, index = 0) {
  return JSON.parse(fetchMock.mock.calls[index][1].body)
}

// Ten lines, so a reveal into the middle of the buffer is not clamped away by
// `clampReveal` — the clamp itself is `monacoRevealClamp.test.js`'s subject.
const TEN_LINES = Array.from({ length: 10 }, (_, index) => `x${index} = ${index}`).join('\n')

async function mountSurface(props = {}) {
  const wrapper = mount(MonacoEditor, {
    props: { content: TEN_LINES, path: 'src/app.py', language: 'python', ...props },
    attachTo: document.body,
  })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  fake.state.models.length = 0
  fake.state.editors.length = 0
  fake.state.providers.definition.length = 0
  fake.state.providers.hover.length = 0
  fake.state.providers.references.length = 0
  fake.state.openers.length = 0
  fake.state.commands.length = 0
  fake.state.disposed.length = 0
  fake.state.disposables.length = 0
  files.state.open.splice(0, files.state.open.length)
  files.state.active = null
  lsp.clear()
  chat.state.lsp.servers = []
  chat.state.lsp.enabled = {}
  chat.state.lsp.loaded = false
  chat.state.lsp.locked = false
  vi.restoreAllMocks()
})

describe('the model URI names the buffer on screen', () => {
  it('creates the model with a URI derived from the path, on a synthetic scheme', async () => {
    const wrapper = await mountSurface()
    const model = fake.state.models[0]

    expect(model.uri.toString()).toBe(editorUriFor('src/app.py'))
    expect(model.uri.toString().startsWith(`${EDITOR_URI_SCHEME}:/`)).toBe(true)
    expect(model.uri.toString().startsWith('file:')).toBe(false)
    wrapper.unmount()
  })

  // Monaco has no "rename a model's URI", so a buffer swap is a model swap: the
  // new model carries the new path's URI and the old one is disposed. The
  // *editor* is never re-created — that is the invariant that matters.
  it('moves the URI with a buffer swap, without re-creating the editor', async () => {
    const wrapper = await mountSurface()
    const editor = fake.state.editors[0]
    const first = fake.state.models[0]

    await wrapper.setProps({ path: 'src/other.py', content: 'y = 2\n' })
    await flushPromises()

    expect(fake.state.editors).toHaveLength(1)
    expect(fake.state.editors[0]).toBe(editor)
    expect(fake.state.models).toHaveLength(2)
    const second = fake.state.models[1]
    expect(second.uri.toString()).toBe(editorUriFor('src/other.py'))
    expect(editor.getModel()).toBe(second)
    expect(first.disposed).toBe(true)
    wrapper.unmount()
  })

  it('keeps the text on screen across the swap', async () => {
    const wrapper = await mountSurface()
    await wrapper.setProps({ path: 'src/other.py', content: 'y = 2\n' })
    await flushPromises()

    expect(fake.state.models[1].getValue()).toBe('y = 2\n')
    wrapper.unmount()
  })
})

describe('the three providers', () => {
  it('are registered once at mount, against this pane\'s scheme', async () => {
    const wrapper = await mountSurface()

    for (const kind of ['definition', 'hover', 'references']) {
      expect(fake.state.providers[kind]).toHaveLength(1)
      expect(fake.state.providers[kind][0].selector).toEqual({ scheme: EDITOR_URI_SCHEME })
    }
    wrapper.unmount()
  })

  // A remount registers a fresh set — but the previous set was disposed with
  // its editor, so exactly one set is ever live. Two live sets would answer
  // every question twice.
  it('leave exactly one live set after a remount', async () => {
    const first = await mountSurface()
    first.unmount()
    const second = await mountSurface()

    for (const kind of ['definition', 'hover', 'references']) {
      expect(fake.state.providers[kind]).toHaveLength(2)
    }
    // The first mount's four registrations (three providers and the opener) are
    // disposed; the second mount's four are live.
    expect(fake.state.disposables.slice(0, 4).every((handle) => handle.disposed)).toBe(true)
    expect(fake.state.disposables.slice(4).some((handle) => handle.disposed)).toBe(false)
    second.unmount()
  })

  it('answer nothing for a model this pane did not create', async () => {
    const wrapper = await mountSurface()
    const foreign = { uri: { toString: () => 'file:///tmp/app.py' } }
    const position = { lineNumber: 1, column: 1 }

    expect(
      await fake.state.providers.definition[0].provider.provideDefinition(foreign, position),
    ).toBeNull()
    expect(
      await fake.state.providers.hover[0].provider.provideHover(foreign, position),
    ).toBeNull()
    expect(
      await fake.state.providers.references[0].provider.provideReferences(foreign, position),
    ).toBeNull()
    wrapper.unmount()
  })
})

describe('a quiet answer is a no-op', () => {
  // §4.10: the feature degrades to the status quo, never to an error. Every
  // non-`ok` status collapses to "nothing", so Monaco falls through to whatever
  // it would have done on its own.
  for (const status of ['no_server', 'starting']) {
    it(`answers nothing for a ${status} envelope, without throwing`, async () => {
      vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
        jsonResponse(envelope({ status, server: null, reason: 'nothing here', action: 'definition' })),
      )
      const wrapper = await mountSurface()
      const model = fake.state.models[0]

      const answer = await fake.state.providers.definition[0].provider.provideDefinition(
        model,
        { lineNumber: 2, column: 3 },
      )

      expect(answer).toBeNull()
      wrapper.unmount()
    })
  }

  it('answers nothing when the server found no definition', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(envelope({ action: 'definition', result: null })),
    )
    const wrapper = await mountSurface()

    const answer = await fake.state.providers.definition[0].provider.provideDefinition(
      fake.state.models[0],
      { lineNumber: 2, column: 3 },
    )

    expect(answer).toBeNull()
    wrapper.unmount()
  })

  it('answers nothing when the API cannot be reached', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('down')))
    const wrapper = await mountSurface()

    const answer = await fake.state.providers.definition[0].provider.provideDefinition(
      fake.state.models[0],
      { lineNumber: 2, column: 3 },
    )

    expect(answer).toBeNull()
    wrapper.unmount()
  })
})

describe('the definition provider', () => {
  it('asks in the app\'s vocabulary, at the 0-based position, and maps the answer', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(
        envelope({ action: 'definition', result: { path: 'src/app.py', line: 4, character: 2 } }),
      ),
    )
    const wrapper = await mountSurface()

    const answer = await fake.state.providers.definition[0].provider.provideDefinition(
      fake.state.models[0],
      { lineNumber: 3, column: 4 },
    )

    // The `-1` happened in `lib/monaco-lsp.js`, never here (§4.8).
    expect(sentBody(fetchMock)).toEqual({
      action: 'definition',
      path: 'src/app.py',
      line: 2,
      character: 3,
    })
    // …and the `+1` back, in the same module.
    expect(answer.uri.toString()).toBe(editorUriFor('src/app.py'))
    expect(answer.range).toMatchObject({ startLineNumber: 5, startColumn: 3 })
    wrapper.unmount()
  })

  // §4.5: the buffer is the source of truth, so a dirty buffer sends its text
  // and a clean one omits it — the hub reads the file in that case.
  it('sends the text only when the buffer is dirty', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope({ action: 'definition', result: null })))
    const wrapper = await mountSurface()

    files.state.open.push(fileRecord('src/app.py', 'x = 1\n', false))
    await fake.state.providers.definition[0].provider.provideDefinition(fake.state.models[0], {
      lineNumber: 1,
      column: 1,
    })
    expect('text' in sentBody(fetchMock, 0)).toBe(false)

    files.state.open[0].dirty = true
    files.state.open[0].text = 'x = 2\n'
    await fake.state.providers.definition[0].provider.provideDefinition(fake.state.models[0], {
      lineNumber: 1,
      column: 1,
    })
    expect(sentBody(fetchMock, 1).text).toBe('x = 2\n')
    wrapper.unmount()
  })
})

describe('the hover provider', () => {
  // §4.9: the markdown is handed to Monaco with HTML support off, so the
  // server's text is escaped rather than interpreted. This component renders
  // nothing itself — the app's `lib/markdown.js` rule is honoured by
  // configuration here.
  it('returns the markdown with HTML support off', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(
        envelope({
          action: 'hover',
          result: { markdown: '**bold** and <b>not markup</b>', range: null },
        }),
      ),
    )
    const wrapper = await mountSurface()

    const answer = await fake.state.providers.hover[0].provider.provideHover(
      fake.state.models[0],
      { lineNumber: 1, column: 1 },
    )

    expect(answer.contents).toEqual([
      { value: '**bold** and <b>not markup</b>', supportHtml: false },
    ])
    wrapper.unmount()
  })

  it('answers nothing when the server has no hover', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(envelope({ action: 'hover', result: null })),
    )
    const wrapper = await mountSurface()

    expect(
      await fake.state.providers.hover[0].provider.provideHover(fake.state.models[0], {
        lineNumber: 1,
        column: 1,
      }),
    ).toBeNull()
    wrapper.unmount()
  })
})

describe('the references provider', () => {
  it('returns the locations in the server\'s order', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(
        envelope({
          action: 'references',
          result: [
            { path: 'src/app.py', line: 0, character: 0 },
            { path: 'src/other.py', line: 9, character: 4 },
          ],
        }),
      ),
    )
    const wrapper = await mountSurface()

    const answer = await fake.state.providers.references[0].provider.provideReferences(
      fake.state.models[0],
      { lineNumber: 1, column: 1 },
    )

    expect(answer.map((item) => item.uri.toString())).toEqual([
      editorUriFor('src/app.py'),
      editorUriFor('src/other.py'),
    ])
    expect(answer[1].range).toMatchObject({ startLineNumber: 10, startColumn: 5 })
    wrapper.unmount()
  })

  it('answers an empty list when the server found none', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(envelope({ action: 'references', result: [] })),
    )
    const wrapper = await mountSurface()

    expect(
      await fake.state.providers.references[0].provider.provideReferences(fake.state.models[0], {
        lineNumber: 1,
        column: 1,
      }),
    ).toEqual([])
    wrapper.unmount()
  })
})

describe('the two gestures reach the definition path', () => {
  it('Ctrl+P is still registered, beside F12', async () => {
    const wrapper = await mountSurface()
    const keys = fake.state.commands.map((entry) => entry.keybinding)

    expect(keys).toContain(2048 | 41) // CtrlCmd | KeyP
    expect(keys).toContain(70) // F12
    wrapper.unmount()
  })

  it('F12 reveals a target in the same file through the pane\'s own reveal', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(
        envelope({ action: 'definition', result: { path: 'src/app.py', line: 6, character: 2 } }),
      ),
    )
    const wrapper = await mountSurface()
    const editor = fake.state.editors[0]
    const f12 = fake.state.commands.find((entry) => entry.keybinding === 70)

    f12.handler()
    await flushPromises()

    expect(editor.revealed).toEqual([7])
    expect(editor.getPosition()).toEqual({ lineNumber: 7, column: 3 })
    expect(wrapper.emitted('definition')).toBeUndefined()
    wrapper.unmount()
  })

  it('F12 hands a target in another file to the pane', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(
        envelope({ action: 'definition', result: { path: 'src/other.py', line: 2, character: 0 } }),
      ),
    )
    const wrapper = await mountSurface()
    const f12 = fake.state.commands.find((entry) => entry.keybinding === 70)

    f12.handler()
    await flushPromises()

    expect(wrapper.emitted('definition')).toEqual([
      [{ path: 'src/other.py', line: 3, column: 1 }],
    ])
    wrapper.unmount()
  })

  it('F12 does nothing when the answer is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(envelope({ status: 'no_server', server: null, action: 'definition' })),
    )
    const wrapper = await mountSurface()
    const editor = fake.state.editors[0]
    const f12 = fake.state.commands.find((entry) => entry.keybinding === 70)

    f12.handler()
    await flushPromises()

    expect(editor.revealed).toEqual([])
    expect(wrapper.emitted('definition')).toBeUndefined()
    wrapper.unmount()
  })

  // Ctrl+click is Monaco's own gesture for "go to definition", so it needs no
  // keybinding: it arrives through the editor opener, which is the seam a
  // standalone editor has for opening a resource other than the attached model.
  it('Ctrl+click reveals a target in the same file', async () => {
    const wrapper = await mountSurface()
    const editor = fake.state.editors[0]
    const opener = fake.state.openers[0]

    const handled = await opener.openCodeEditor(
      editor,
      { toString: () => editorUriFor('src/app.py') },
      { lineNumber: 4, column: 2 },
    )

    expect(handled).toBe(true)
    expect(editor.revealed).toEqual([4])
    expect(wrapper.emitted('definition')).toBeUndefined()
    wrapper.unmount()
  })

  it('Ctrl+click hands a target in another file to the pane', async () => {
    const wrapper = await mountSurface()
    const opener = fake.state.openers[0]

    const handled = await opener.openCodeEditor(
      fake.state.editors[0],
      { toString: () => editorUriFor('src/other.py') },
      { lineNumber: 4, column: 2 },
    )

    expect(handled).toBe(true)
    expect(wrapper.emitted('definition')).toEqual([
      [{ path: 'src/other.py', line: 4, column: 2 }],
    ])
    wrapper.unmount()
  })

  // A resource this pane does not own is not handled, so the gesture falls
  // through to whatever Monaco would have done on its own (§4.10).
  it('Ctrl+click falls through for a resource this pane does not own', async () => {
    const wrapper = await mountSurface()
    const opener = fake.state.openers[0]

    const handled = await opener.openCodeEditor(
      fake.state.editors[0],
      { toString: () => 'file:///tmp/app.py' },
      { lineNumber: 1, column: 1 },
    )

    expect(handled).toBe(false)
    expect(wrapper.emitted('definition')).toBeUndefined()
    wrapper.unmount()
  })
})

describe('disposal', () => {
  // The providers and the opener are registered against a scheme this pane's
  // models no longer use once it is gone, and a second mount would otherwise
  // register a second set that answers every question twice.
  it('disposes the providers, the opener, the editor and the model', async () => {
    const wrapper = await mountSurface()
    const editor = fake.state.editors[0]
    const model = fake.state.models[0]
    // Four registrations: three providers and the opener.
    expect(fake.state.disposables).toHaveLength(4)

    wrapper.unmount()

    expect(fake.state.disposables.every((handle) => handle.disposed)).toBe(true)
    expect(editor.disposed).toBe(true)
    expect(model.disposed).toBe(true)
  })
})
