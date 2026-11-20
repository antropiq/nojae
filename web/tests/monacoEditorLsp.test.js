import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

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
    // Every `setModelMarkers` call, in order: `{ model, owner, markers }`. The
    // marker surface is the one caller in the app, so this list *is* the record
    // of what the pane asked to have drawn.
    markerCalls: [],
    // Every `onDidChangeMarkers` listener the component registered, and the
    // built-in engine's own options, so the D5 suppression can be driven and
    // asserted without a real TypeScript worker.
    markerListeners: [],
    builtinDiagnosticsOptions: {
      typescript: { noSyntaxValidation: false, noSemanticValidation: false },
      javascript: { noSyntaxValidation: false, noSemanticValidation: false },
    },
    builtinOptionsWrites: [],
    // The Ctrl-hover link's records: the collection the component paints
    // through, and one list per event it withdraws the underline on.
    decorationCollections: [],
    mouseMoveListeners: [],
    contentListeners: [],
    scrollListeners: [],
    modelChangeListeners: [],
    // The bar's editor facts: the caret channel on the editor, and the model's
    // own option/language channels. Recorded so the reports they drive can be
    // asserted rather than assumed.
    cursorListeners: [],
    optionListeners: [],
    languageListeners: [],
    // The buffer-position pair: what the pane asked Monaco to save and restore,
    // in order, so the "come back to where you were" rule can be asserted.
    viewStateSaves: [],
    viewStateRestores: [],
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
      getLanguageId() {
        return this.language
      },
      getOptions() {
        return this.options ?? { tabSize: 4, indentSize: 4, insertSpaces: true }
      },
      getEOL() {
        return this.value.includes('\r\n') ? '\r\n' : '\n'
      },
      onDidChangeOptions(listener) {
        state.optionListeners.push(listener)
        return { dispose() {} }
      },
      onDidChangeLanguage(listener) {
        state.languageListeners.push(listener)
        return { dispose() {} }
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
      // The word under a position, in Monaco's own shape. The component paints
      // the link over `startColumn`..`endColumn`, so the fake resolves a word
      // the same way the real model does for the identifiers the tests use:
      // `[A-Za-z0-9_$]+` around the given column.
      getWordAtPosition(position) {
        const line = this.value.split('\n')[position.lineNumber - 1] ?? ''
        const index = position.column - 1
        const isWordChar = (ch) => ch !== undefined && /[A-Za-z0-9_$]/.test(ch)
        if (!isWordChar(line[index])) return null
        let start = index
        while (start > 0 && isWordChar(line[start - 1])) start -= 1
        let end = index
        while (end < line.length && isWordChar(line[end])) end += 1
        return {
          word: line.slice(start, end),
          startColumn: start + 1,
          endColumn: end + 1,
        }
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
      // The scroll offset, which only `saveViewState`/`restoreViewState` move in
      // this fake: a test sets it to stand for "the user scrolled to line 200".
      scrollTop: 0,
      // The handles for this editor's own listeners: ended with the editor, and
      // deliberately not in the shared list above.
      listenerHandles: [],
      saveViewState() {
        state.viewStateSaves.push({ model: this.model, position: this.position, scrollTop: this.scrollTop })
        return { cursorState: { ...this.position }, viewState: { scrollTop: this.scrollTop } }
      },
      restoreViewState(saved) {
        state.viewStateRestores.push({ model: this.model, saved })
        if (!saved) return
        if (saved.viewState) this.scrollTop = saved.viewState.scrollTop
        if (saved.cursorState) this.position = { ...saved.cursorState }
      },
      track(handlers, listener) {
        handlers.push(listener)
        const handle = { disposed: false, dispose() { this.disposed = true } }
        this.listenerHandles.push(handle)
        return handle
      },
      addCommand(keybinding, handler) {
        state.commands.push({ keybinding, handler })
      },
      // Monaco fires `onDidChangeModel` on a model swap, which is the moment the
      // component withdraws the link — so the fake does too, rather than letting
      // the swap pass silently.
      setModel(next) {
        this.model = next
        for (const listener of state.modelChangeListeners) listener({})
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
      // --- the Ctrl-hover link's surface -------------------------------
      //
      // The decoration collection the component paints the underline through:
      // `set` replaces it whole and `clear` empties it, which is the pair of
      // rules the component relies on. Its length is what the events below read.
      createDecorationsCollection() {
        const collection = {
          decorations: [],
          get length() {
            return this.decorations.length
          },
          set(list) {
            this.decorations = list
          },
          clear() {
            this.decorations = []
          },
          dispose() {
            this.decorations = []
          },
        }
        state.decorationCollections.push(collection)
        return collection
      },
      // The events the link is withdrawn on. Each handler is recorded so a test
      // can fire one. These handles belong to the **editor**, not to the
      // component — the component keeps no reference and Monaco disposes them
      // with the editor it created them on — so they are tracked on `this` and
      // not in the shared disposable list, and `dispose()` below is what ends
      // them. Modelling that is what keeps the pane's own teardown assertions
      // about the pane's own registrations.
      onMouseMove(listener) {
        return this.track(state.mouseMoveListeners, listener)
      },
      onDidChangeModelContent(listener) {
        return this.track(state.contentListeners, listener)
      },
      onDidScrollChange(listener) {
        return this.track(state.scrollListeners, listener)
      },
      onDidChangeModel(listener) {
        return this.track(state.modelChangeListeners, listener)
      },
      onDidChangeCursorPosition(listener) {
        return this.track(state.cursorListeners, listener)
      },
      dispose() {
        this.disposed = true
        for (const handle of this.listenerHandles) handle.disposed = true
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
      // Monaco's own semantics, reproduced so the component's decisions can be
      // asserted: the set handed over *becomes* the model's whole marker set for
      // that owner (that is what makes an empty set clear the buffer), and it
      // belongs to the model, so a disposed model takes its marks with it.
      setModelMarkers: (model, owner, markers) => {
        fake.state.markerCalls.push({ model, owner, markers })
        model.markers = { ...(model.markers ?? {}), [owner]: markers }
      },
      // The read half, so the suppression can decide whether it has anything to
      // drop — Monaco's own rule is that an empty set for an owner is a removal.
      getModelMarkers: ({ owner, resource }) => {
        const model = fake.state.models.find(
          (candidate) => candidate.uri?.toString?.() === resource?.toString?.(),
        )
        return model?.markers?.[owner] ?? []
      },
      onDidChangeMarkers: (listener) => {
        fake.state.markerListeners.push(listener)
        return disposable()
      },
    },
    // The built-in engine's own defaults: the options the suppression restores by
    // re-setting them, and the provider channel it publishes under. Recorded so
    // the D5 rule can be asserted without a TypeScript worker.
    typescript: {
      typescriptDefaults: {
        getDiagnosticsOptions: () => fake.state.builtinDiagnosticsOptions.typescript,
        setDiagnosticsOptions: (options) => {
          fake.state.builtinOptionsWrites.push({ language: 'typescript', options })
        },
      },
      javascriptDefaults: {
        getDiagnosticsOptions: () => fake.state.builtinDiagnosticsOptions.javascript,
        setDiagnosticsOptions: (options) => {
          fake.state.builtinOptionsWrites.push({ language: 'javascript', options })
        },
      },
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
      // The registry the bar's file-kind label reads its display name from.
      // Two entries are enough to tell "found an alias" from "fell back to the
      // id": `python` has one, `plaintext` is the id an unknown extension gets.
      getLanguages: () => [
        { id: 'python', aliases: ['Python', 'py'] },
        { id: 'plaintext', aliases: ['Plain Text', 'text'] },
      ],
    },
  }
})

import MonacoEditor from '../src/components/MonacoEditor.vue'
import { EDITOR_URI_SCHEME, editorUriFor } from '../src/lib/monaco-lsp'
import { useChat } from '../src/composables/useChat'
import { useEditorFiles } from '../src/composables/useEditorFiles'
import { clearEditorFacts, useEditorFacts } from '../src/composables/useEditorFacts'
import { useEditorLsp } from '../src/composables/useEditorLsp'
import { useEditorStatus } from '../src/composables/useEditorStatus'

const files = useEditorFiles()
const lsp = useEditorLsp()
const chat = useChat()
const status = useEditorStatus()

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
  fake.state.markerCalls.length = 0
  fake.state.markerListeners.length = 0
  fake.state.builtinOptionsWrites.length = 0
  fake.state.decorationCollections.length = 0
  fake.state.mouseMoveListeners.length = 0
  fake.state.contentListeners.length = 0
  fake.state.scrollListeners.length = 0
  fake.state.modelChangeListeners.length = 0
  fake.state.cursorListeners.length = 0
  fake.state.optionListeners.length = 0
  fake.state.languageListeners.length = 0
  fake.state.viewStateSaves.length = 0
  fake.state.viewStateRestores.length = 0
  files.state.open.splice(0, files.state.open.length)
  files.state.active = null
  lsp.clear()
  status.clear()
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

// ---------------------------------------------------------------------------
// A tab switch is a model swap, and Monaco's scroll position and caret live on
// the *editor's* view model — which `setModel` replaces together with the old
// model. So without a save/restore the user came back to a file at line 1, with
// the caret at (1, 1), however far down they had been reading.
//
// The mechanism is Monaco's own, not an in-house scroll arithmetic:
// `saveViewState()` answers a plain serialisable object and `restoreViewState()`
// puts it back, which is exactly the pair VS Code's own multi-model editor uses.
// These tests pin the *decisions* around it — when the save is taken, which key
// it is filed under, and that a deliberate reveal still wins over it.
// ---------------------------------------------------------------------------
describe('the view state survives a tab switch', () => {
  // "The user read line 200 of A, then B, then came back."
  const DEEP = { lineNumber: 200, column: 7 }

  it('saves before the swap, under the buffer that is being left', async () => {
    const wrapper = await mountSurface()
    const editor = fake.state.editors[0]
    editor.position = { ...DEEP }
    editor.scrollTop = 4210

    await wrapper.setProps({ path: 'src/other.py', content: 'y = 2\n' })
    await flushPromises()

    expect(fake.state.viewStateSaves).toHaveLength(1)
    // Filed under the *old* path, and captured from the *old* model: after the
    // swap `saveViewState` would answer about the new buffer.
    expect(fake.state.viewStateSaves[0].model.uri.toString()).toBe(editorUriFor('src/app.py'))
    expect(fake.state.viewStateSaves[0].position).toEqual(DEEP)
    wrapper.unmount()
  })

  it('restores the remembered position when the buffer comes back', async () => {
    const wrapper = await mountSurface()
    const editor = fake.state.editors[0]
    editor.position = { ...DEEP }
    editor.scrollTop = 4210

    // A → B: the swap home captures nothing (B was never shown), so the editor
    // is left where a fresh model puts it.
    await wrapper.setProps({ path: 'src/other.py', content: 'y = 2\n' })
    await flushPromises()
    expect(editor.getPosition()).toEqual(DEEP) // the fake leaves it alone…
    // …so move it, which is what a real `setModel` would have done.
    editor.position = { lineNumber: 1, column: 1 }
    editor.scrollTop = 0

    // B → A: back to where the user was reading.
    await wrapper.setProps({ path: 'src/app.py', content: TEN_LINES })
    await flushPromises()

    expect(fake.state.viewStateRestores).toHaveLength(1)
    expect(editor.getPosition()).toEqual(DEEP)
    expect(editor.scrollTop).toBe(4210)
    wrapper.unmount()
  })

  it('asks for nothing when the buffer has never been shown', async () => {
    const wrapper = await mountSurface()
    await wrapper.setProps({ path: 'src/other.py', content: 'y = 2\n' })
    await flushPromises()

    // A save for the buffer being left, and no restore: there is no remembered
    // position for a file opened for the first time.
    expect(fake.state.viewStateSaves).toHaveLength(1)
    expect(fake.state.viewStateRestores).toHaveLength(0)
    wrapper.unmount()
  })

  // A reveal — a search hit, a definition — is a request about where to *be*,
  // and it must not be overruled by the position the user merely *was* at. The
  // restore is synchronous inside the swap watcher, and a reveal is applied
  // either at the end of that same watcher or on a later tick, so "the reveal
  // wins" is a consequence of the order inside the watcher — which is what this
  // pins.
  it('lets a queued reveal win over the remembered position', async () => {
    const wrapper = await mountSurface()
    const editor = fake.state.editors[0]
    editor.position = { ...DEEP }
    await wrapper.setProps({ path: 'src/other.py', content: 'y = 2\n' })
    await flushPromises()
    editor.position = { lineNumber: 1, column: 1 }
    await wrapper.setProps({ path: 'src/app.py', content: TEN_LINES })
    await flushPromises()

    // The hit is queued *for the buffer on screen*, which is the state the pane
    // is in when a search row is clicked for the file it is already showing.
    wrapper.vm.revealPosition({ line: 3, column: 2 })
    await flushPromises()

    expect(editor.revealed).toEqual([3])
    expect(editor.getPosition()).toEqual({ lineNumber: 3, column: 2 })
    wrapper.unmount()
  })

  it('files nothing for a buffer with no path named', async () => {
    const wrapper = await mountSurface({ path: '', content: 'a\n' })
    await wrapper.setProps({ path: 'src/other.py', content: 'y = 2\n' })
    await flushPromises()

    // No key to file it under, so the save is skipped rather than guessed at.
    expect(fake.state.viewStateSaves).toHaveLength(0)
    wrapper.unmount()
  })

  // The hazard that made the save/restore a no-op at first. A tab switch moves
  // `path` and `content` in the *same* render, and a watcher can observe the
  // content change while the model on screen is still the outgoing buffer's.
  // Writing B's text into A's model with `setValue` would wipe A's caret and
  // scroll offset out from under the save that is about to run — which is
  // exactly what happened, and why the remembered state was the top of the file.
  //
  // The content watcher therefore refuses a text that belongs to another buffer:
  // that text is the swap's to apply, in the model the swap creates. Asserted
  // here as the two facts that make it true — the outgoing model keeps its text
  // and its caret, and the save records the real position.
  it('never writes another buffer\'s text into the model on screen', async () => {
    const wrapper = await mountSurface()
    const editor = fake.state.editors[0]
    const outgoing = fake.state.models[0]
    editor.position = { ...DEEP }

    // Both props in one move, as a tab click really delivers them.
    await wrapper.setProps({ path: 'src/other.py', content: 'y = 2\n' })
    await flushPromises()

    // The outgoing model was not overwritten: the swap replaced it instead.
    expect(outgoing.getValue()).toBe(TEN_LINES)
    expect(outgoing.disposed).toBe(true)
    // The state saved for it is the position the user was reading, not (1, 1).
    expect(fake.state.viewStateSaves).toHaveLength(1)
    expect(fake.state.viewStateSaves[0].position).toEqual(DEEP)
    // …and the new model holds the new buffer's text.
    expect(fake.state.models[1].getValue()).toBe('y = 2\n')
    wrapper.unmount()
  })

  // The identity guard must not swallow an ordinary reload of a buffer that has
  // no path yet (an unnamed model): there `pathOf(model)` is `null` while the
  // prop is the empty string, so the two are compared with `|| null` rather than
  // `!==` — otherwise a reload would silently never reach the model.
  it('still applies a reload to a buffer with no path named', async () => {
    const wrapper = await mountSurface({ path: '', content: 'a\n' })
    const model = fake.state.models[0]

    await wrapper.setProps({ content: 'a\nb\n' })
    await flushPromises()

    expect(model.getValue()).toBe('a\nb\n')
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
    // The first mount's registrations (three providers, the opener and the
    // built-in marker channel's listener) are disposed; the second mount's are
    // live.
    expect(fake.state.disposables.slice(0, 5).every((handle) => handle.disposed)).toBe(true)
    expect(fake.state.disposables.slice(5).some((handle) => handle.disposed)).toBe(false)
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

// The Ctrl-hover indicator: the underline that tells the user a Ctrl+click
// would land somewhere. Monaco paints one itself, but only after its own
// contribution has asked the text-model service for the *target* document — and
// a standalone editor's service answers only for models that already exist, so
// an answer pointing at another file (the ordinary case) throws `Model not
// found` and the decoration is never applied. Verified in the real app before
// this was written; the underline is therefore this pane's own decoration, and
// these tests pin the rules it obeys.
describe('the Ctrl-hover link', () => {
  // A definition answer that lands in *another* file: the shape that defeats
  // Monaco's own contribution, and so the one that has to work here.
  function answerInAnotherFile() {
    return vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(
        envelope({ action: 'definition', result: { path: 'src/other.py', line: 2, character: 0 } }),
      ),
    )
  }

  function otherFileProvider() {
    return fake.state.providers.definition[0].provider
  }

  // A hover that resolves nothing must underline nothing — a mark under a word
  // with no target would be the indicator lying about what a click does.
  it('paints nothing when the answer is empty', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(envelope({ action: 'definition', result: null })),
    )
    const wrapper = await mountSurface()
    const model = fake.state.models[0]

    await otherFileProvider().provideDefinition(model, { lineNumber: 1, column: 5 })
    await flushPromises()

    expect(fake.state.decorationCollections[0].length).toBe(0)
    wrapper.unmount()
  })

  // The indicator arrives on the hover alone: no click, no second request. The
  // provider answered, so the pane paints over the word it was asked about.
  it('underlines the word under a hover that found a target', async () => {
    answerInAnotherFile()
    const wrapper = await mountSurface({ content: 'value = other_name\n' })
    const model = fake.state.models[0]

    await otherFileProvider().provideDefinition(model, { lineNumber: 1, column: 10 })
    await flushPromises()

    const painted = fake.state.decorationCollections[0].decorations
    expect(painted).toHaveLength(1)
    // `other_name` spans columns 9..19 in `value = other_name`.
    expect(painted[0].range).toMatchObject({
      startLineNumber: 1,
      startColumn: 9,
      endLineNumber: 1,
      endColumn: 19,
    })
    expect(painted[0].options.inlineClassName).toBe('nojae-definition-link')
    wrapper.unmount()
  })

  // Releasing the modifier withdraws it: the underline describes a gesture that
  // is no longer being made. The release is heard on the window, because the
  // modifier is let go wherever the focus is — the pointer hovered the pane and
  // never had to focus it.
  it('withdraws the underline when the modifier is released', async () => {
    answerInAnotherFile()
    const wrapper = await mountSurface({ content: 'value = other_name\n' })
    const model = fake.state.models[0]
    await otherFileProvider().provideDefinition(model, { lineNumber: 1, column: 10 })
    await flushPromises()
    expect(fake.state.decorationCollections[0].length).toBe(1)

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Control' }))

    expect(fake.state.decorationCollections[0].length).toBe(0)
    wrapper.unmount()
  })

  // Any other key released mid-hover must leave the underline alone, or the
  // indicator would vanish under a gesture that is still being made.
  it('keeps the underline when another key is released', async () => {
    answerInAnotherFile()
    const wrapper = await mountSurface({ content: 'value = other_name\n' })
    const model = fake.state.models[0]
    await otherFileProvider().provideDefinition(model, { lineNumber: 1, column: 10 })
    await flushPromises()

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a' }))

    expect(fake.state.decorationCollections[0].length).toBe(1)
    wrapper.unmount()
  })

  // Moving the pointer with no modifier down clears it too, which is what makes
  // the indicator follow the gesture rather than stick to the last word.
  it('withdraws the underline on a pointer move with no modifier', async () => {
    answerInAnotherFile()
    const wrapper = await mountSurface({ content: 'value = other_name\n' })
    const model = fake.state.models[0]
    await otherFileProvider().provideDefinition(model, { lineNumber: 1, column: 10 })
    await flushPromises()

    for (const listener of fake.state.mouseMoveListeners) {
      listener({ event: { ctrlKey: false, metaKey: false } })
    }

    expect(fake.state.decorationCollections[0].length).toBe(0)
    wrapper.unmount()
  })

  // An edit makes the painted range meaningless, so it goes with the text.
  it('withdraws the underline on an edit', async () => {
    answerInAnotherFile()
    const wrapper = await mountSurface({ content: 'value = other_name\n' })
    const model = fake.state.models[0]
    await otherFileProvider().provideDefinition(model, { lineNumber: 1, column: 10 })
    await flushPromises()

    for (const listener of fake.state.contentListeners) listener()

    expect(fake.state.decorationCollections[0].length).toBe(0)
    wrapper.unmount()
  })

  // A buffer swap is the case a model-scoped decoration would get wrong: the
  // underline belongs to the word in the file that was on screen, never to the
  // one that replaced it.
  it('withdraws the underline when the buffer is swapped', async () => {
    answerInAnotherFile()
    const wrapper = await mountSurface({ content: 'value = other_name\n' })
    const model = fake.state.models[0]
    await otherFileProvider().provideDefinition(model, { lineNumber: 1, column: 10 })
    await flushPromises()

    await wrapper.setProps({ path: 'src/other.py', content: 'y = 2\n' })
    await flushPromises()

    expect(fake.state.decorationCollections[0].length).toBe(0)
    wrapper.unmount()
  })

  // An answer that lands after the user has already moved to another file must
  // not paint over the buffer that replaced it.
  it('ignores an answer for a model that is no longer on screen', async () => {
    answerInAnotherFile()
    const wrapper = await mountSurface({ content: 'value = other_name\n' })
    const stale = fake.state.models[0]

    const pending = otherFileProvider().provideDefinition(stale, { lineNumber: 1, column: 10 })
    await wrapper.setProps({ path: 'src/other.py', content: 'y = 2\n' })
    await flushPromises()
    await pending
    await flushPromises()

    expect(fake.state.decorationCollections[0].length).toBe(0)
    wrapper.unmount()
  })
})

describe('the marker surface', () => {
  const errorMarker = {
    startLineNumber: 2,
    startColumn: 1,
    endLineNumber: 2,
    endColumn: 6,
    severity: 8,
    message: 'boom',
  }

  // Monaco's own API, called by the one owner in the app: what the pane hands
  // over becomes the marker set of the model on screen, under one owner name.
  it('applies a set to the model on screen, under one owner', async () => {
    const wrapper = await mountSurface()
    const model = fake.state.models[0]

    wrapper.vm.setMarkers([errorMarker])

    expect(fake.state.markerCalls).toHaveLength(1)
    expect(fake.state.markerCalls[0].model).toBe(model)
    expect(fake.state.markerCalls[0].owner).toBe('nojae-editor')
    expect(model.markers['nojae-editor']).toEqual([errorMarker])
    wrapper.unmount()
  })

  // Replacement, never merge: a second set is the buffer's whole set, so an
  // item present only in the first is gone — that is how a fixed defect's
  // underline disappears (§6).
  it('replaces the previous set whole', async () => {
    const wrapper = await mountSurface()
    const model = fake.state.models[0]
    const other = { ...errorMarker, message: 'still there', startLineNumber: 4, endLineNumber: 4 }

    wrapper.vm.setMarkers([errorMarker, other])
    wrapper.vm.setMarkers([other])

    expect(model.markers['nojae-editor']).toEqual([other])
    wrapper.unmount()
  })

  // An empty set is a verdict and it clears the buffer, rather than leaving the
  // last analysis's squiggles behind.
  it('clears the buffer on an empty set', async () => {
    const wrapper = await mountSurface()
    const model = fake.state.models[0]

    wrapper.vm.setMarkers([errorMarker])
    wrapper.vm.setMarkers([])

    expect(model.markers['nojae-editor']).toEqual([])
    wrapper.unmount()
  })

  // A model swap disposes the previous model — and the marks are the model's,
  // so they went with it. A set applied afterwards therefore has to reach the
  // *new* model, which is why the surface reads the current one at apply time
  // instead of caching a set (§2, consequence 3).
  it('sends a set applied after a buffer swap to the new model', async () => {
    const wrapper = await mountSurface()
    const first = fake.state.models[0]

    wrapper.vm.setMarkers([errorMarker])
    await wrapper.setProps({ path: 'src/other.py', content: 'y = 2\n' })
    await flushPromises()
    const second = fake.state.models[1]
    wrapper.vm.setMarkers([errorMarker])

    expect(first.disposed).toBe(true)
    expect(first.markers['nojae-editor']).toEqual([errorMarker])
    expect(second.markers['nojae-editor']).toEqual([errorMarker])
    expect(fake.state.markerCalls.at(-1).model).toBe(second)
    wrapper.unmount()
  })

  // No buffer named yet: nothing to mark. A no-op, never a throw.
  it('is a no-op with no path named', async () => {
    const wrapper = await mountSurface({ path: '' })

    expect(() => wrapper.vm.setMarkers([errorMarker])).not.toThrow()
    expect(fake.state.markerCalls).toHaveLength(0)
    wrapper.unmount()
  })
})

// The component is the one owner, asserted rather than assumed: a second caller
// of Monaco's marker API elsewhere in `src/` would mean two surfaces fighting
// over one buffer's marks, and a mouseover handler anywhere would mean a hover
// that drifts from Monaco's own (spec §2).
describe('the marker surface has one owner and builds no hover', () => {
  function sourceFiles(dir) {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) return sourceFiles(full)
      return /\.(vue|js)$/.test(name) ? [full] : []
    })
  }

  const sources = sourceFiles(resolve('src'))
  const owners = sources.filter((file) => readFileSync(file, 'utf8').includes('setModelMarkers'))

  it('has exactly one caller of setModelMarkers in src, and it is the pane', () => {
    expect(owners.map((file) => file.replace(resolve('src'), 'src'))).toEqual([
      join('src', 'components', 'MonacoEditor.vue'),
    ])
  })

  // Monaco positions and keyboard-handles the hover itself, so a handler here
  // would be a second, drifting implementation (spec §2).
  it('adds no mouseover handler and no tooltip component', () => {
    const pane = readFileSync(resolve('src/components/MonacoEditor.vue'), 'utf8')
    for (const forbidden of ['mouseover', 'mouseenter', 'mouseleave']) {
      expect(pane.toLowerCase()).not.toContain(forbidden)
    }
    // A tooltip component would be a second text source beside Monaco's own.
    expect(sources.filter((file) => /tooltip/i.test(file))).toEqual([])
  })
})

// D5 (spec §5, §7 Part B item 11): Monaco's own JavaScript/TypeScript checking is
// silenced **per buffer**, and only while a declared server answers for that
// buffer's path.
//
// What the cases have to prove, in the task's own words: a claimed buffer has both
// its validations suppressed; an unclaimed one hands the question back to the
// defaults; and a claim arriving after mount changes the answer without a
// re-created model.
//
// The answer itself is never invented here — these cases feed the bar's own
// `status` state (`useEditorStatus`), which is the single source of "does a
// declared server serve this path", and assert what the pane does with it.
describe('the built-in engine is silenced per buffer (D5)', () => {
  const BUILTIN_OWNERS = ['typescript', 'javascript']

  // The built-in engine publishing for a model: what Monaco's TypeScript worker
  // does under the model's language id as the owner. `'ts'` gives a `.ts` buffer
  // so the built-in language id and the owner agree.
  function publishBuiltin(model, owner = 'typescript', message = 'builtin complaint') {
    model.markers = { ...(model.markers ?? {}) }
    const marker = {
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 1,
      endColumn: 4,
      severity: 8,
      message,
    }
    model.markers[owner] = [marker]
    for (const listener of fake.state.markerListeners) listener([model.uri])
    return marker
  }

  // The bar's state for a path, as the field would hold it: the envelope the hub
  // answers the `status` action with, keyed by the path it was asked about.
  function claim(path, server = 'tsserver') {
    return status.ask(path).then(() => {
      expect(status.state.path).toBe(path)
      expect(status.state.answer?.server).toBe(server)
    })
  }

  it('registers the built-in channel listener once, and disposes it with the rest', async () => {
    const wrapper = await mountSurface({ language: 'typescript' })
    expect(fake.state.markerListeners).toHaveLength(1)
    wrapper.unmount()
    expect(fake.state.disposables.every((handle) => handle.disposed)).toBe(true)
  })

  // A buffer a declared server claims: the built-in set is dropped. Both owners
  // are dropped, so syntactic and semantic validation go silent together — one
  // voice per file.
  it('drops the built-in set for a claimed buffer, both owners at once', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(envelope({ action: 'status', server: 'tsserver' })),
    )
    const wrapper = await mountSurface({ path: 'src/app.ts', language: 'typescript' })
    const model = fake.state.models[0]

    // Both halves recorded under their owners, as Monaco publishes them.
    publishBuiltin(model, 'typescript', 'syntactic')
    publishBuiltin(model, 'javascript', 'semantic')
    await claim('src/app.ts')

    expect(fake.state.markerCalls.map((call) => call.owner)).toEqual(BUILTIN_OWNERS)
    for (const owner of BUILTIN_OWNERS) {
      expect(model.markers[owner]).toEqual([])
    }
    wrapper.unmount()
  })

  // The rule's other half, and the case D5 exists to protect: a buffer nothing
  // claims keeps its built-in marks — and its options are handed back to the
  // defaults rather than overridden by the app.
  it('leaves an unclaimed buffer exactly as it is today, marks included', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(
        envelope({
          action: 'status',
          status: 'no_server',
          server: null,
          reason: 'no active language server handles .ts',
        }),
      ),
    )
    const wrapper = await mountSurface({ path: 'src/app.ts', language: 'typescript' })
    const model = fake.state.models[0]

    const marker = publishBuiltin(model, 'typescript')
    // The bar's own read lands: the hub says no declared server serves this path.
    await status.ask('src/app.ts')
    await flushPromises()
    expect(status.state.answer?.status).toBe('no_server')

    // The set the engine published is still there: the app took no decision it
    // had nothing to say about.
    expect(model.markers.typescript).toEqual([marker])
    // And no option write happened: a quiet answer never flips the engine.
    expect(fake.state.builtinOptionsWrites).toEqual([])
    wrapper.unmount()
  })

  // The answer moves while the buffer does not. The suppression is read live, so
  // a claim arriving after mount silences the model — and the *model* is the same
  // one, never re-created.
  it('changes with a claim that arrives after mount, without re-creating the model', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(envelope({ action: 'status', server: 'tsserver' })),
    )
    const wrapper = await mountSurface({ path: 'src/app.ts', language: 'typescript' })
    const editor = fake.state.editors[0]
    const model = fake.state.models[0]
    const marker = publishBuiltin(model, 'typescript')
    expect(model.markers.typescript).toEqual([marker])

    await claim('src/app.ts')
    await flushPromises()

    expect(model.markers.typescript).toEqual([])
    // The same editor and the same model: no re-created model, no re-opened
    // document, no reload.
    expect(fake.state.editors).toHaveLength(1)
    expect(fake.state.editors[0]).toBe(editor)
    expect(fake.state.models).toHaveLength(1)
    expect(editor.getModel()).toBe(model)
    wrapper.unmount()
  })

  // …and a claim that goes away restores the engine for that buffer, through the
  // engine's own revalidation trigger rather than by re-creating anything.
  it('restores the built-in engine when the claim goes away', async () => {
    const answer = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(envelope({ action: 'status', server: 'tsserver' })))
    const wrapper = await mountSurface({ path: 'src/app.ts', language: 'typescript' })
    const model = fake.state.models[0]
    publishBuiltin(model, 'typescript')
    await claim('src/app.ts')
    await flushPromises()
    expect(model.markers.typescript).toEqual([])

    // The server is switched off for the conversation: the hub now says so.
    answer.mockImplementation(() =>
      jsonResponse(
        envelope({
          action: 'status',
          status: 'no_server',
          server: null,
          reason: 'tsserver is disabled',
        }),
      ),
    )
    await status.ask('src/app.ts')
    await flushPromises()

    // The engine's own recompute was requested — once, with the value it already
    // carried — and no model was re-created to make the marks come back.
    expect(fake.state.builtinOptionsWrites).toHaveLength(1)
    expect(fake.state.builtinOptionsWrites[0].language).toBe('typescript')
    expect(fake.state.builtinOptionsWrites[0].options).toEqual(
      fake.state.builtinDiagnosticsOptions.typescript,
    )
    expect(fake.state.models).toHaveLength(1)
    wrapper.unmount()
  })

  // A buffer swap moves the answer with the buffer: the previous model's claim is
  // never applied to the new one.
  it('moves the answer with a buffer swap', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      const body = JSON.parse(init.body)
      if (body.path === 'src/claimed.ts') {
        return jsonResponse(envelope({ action: 'status', server: 'tsserver' }))
      }
      return jsonResponse(
        envelope({
          action: 'status',
          status: 'no_server',
          server: null,
          reason: 'no active language server handles .ts',
        }),
      )
    })
    const wrapper = await mountSurface({ path: 'src/claimed.ts', language: 'typescript' })
    await claim('src/claimed.ts')
    await flushPromises()

    // A buffer no server claims replaces it.
    await wrapper.setProps({ path: 'src/other.ts', content: 'y = 2\n' })
    await flushPromises()
    const second = fake.state.models[1]
    const marker = publishBuiltin(second, 'typescript')

    // The new buffer is unclaimed, so its built-in marks stay — the previous
    // buffer's answer was not carried across.
    expect(second.markers.typescript).toEqual([marker])
    wrapper.unmount()
  })

  // The declared server's marks are a different channel: silencing the built-in
  // engine never touches ours.
  it('never removes the declared server\'s own marker set', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse(envelope({ action: 'status', server: 'tsserver' })),
    )
    const wrapper = await mountSurface({ path: 'src/app.ts', language: 'typescript' })
    const model = fake.state.models[0]
    const ours = {
      startLineNumber: 3,
      startColumn: 1,
      endLineNumber: 3,
      endColumn: 5,
      severity: 8,
      message: 'from the declared server',
    }
    wrapper.vm.setMarkers([ours])
    publishBuiltin(model, 'typescript')
    await claim('src/app.ts')
    await flushPromises()

    expect(model.markers['nojae-editor']).toEqual([ours])
    expect(fake.state.markerCalls.every((call) => call.owner !== 'nojae-editor' || call.markers.length > 0)).toBe(true)
    wrapper.unmount()
  })

  // A path-less model belongs to no server: nothing is silenced.
  it('silences nothing for a buffer with no path named', async () => {
    const wrapper = await mountSurface({ path: '', language: 'typescript' })
    const model = fake.state.models[0]
    const marker = publishBuiltin(model, 'typescript')

    expect(model.markers.typescript).toEqual([marker])
    expect(fake.state.markerCalls).toHaveLength(0)
    wrapper.unmount()
  })

})

describe('the editor is created with the options the marks need', () => {
  // The default for `renderValidationDecorations` is `'editable'`, which hides
  // every marker while the pane is read-only — i.e. during a live reply. Pinned
  // on the recorded creation options, so an edit that drops the explicit value
  // fails here rather than in use (spec §2, consequence 2).
  it('sets validation decorations explicitly on, at creation', async () => {
    const wrapper = await mountSurface()

    expect(fake.state.editors[0].options.renderValidationDecorations).toBe('on')
    wrapper.unmount()
  })

  // D2: the overview-ruler lanes are on, the gutter icon column stays off.
  it('turns the overview ruler on and leaves the glyph margin off', async () => {
    const wrapper = await mountSurface()
    const options = fake.state.editors[0].options

    expect(options.overviewRulerLanes).toBeGreaterThan(0)
    expect(options.glyphMargin).toBe(false)
    wrapper.unmount()
  })

  // §8's headline regression, at the one layer that can hold it without a
  // browser: the read-only pane is entered and left, and neither transition may
  // put the option back to Monaco's default nor clear a mark. That is what the
  // underline surviving a live reply amounts to — the pane asks for `'on'` at
  // creation and never overrides it afterwards.
  it('keeps the option on and the marks in place across a read-only toggle', async () => {
    const wrapper = await mountSurface({ readonly: false })
    const editor = fake.state.editors[0]
    const model = fake.state.models[0]
    const marker = {
      startLineNumber: 2,
      startColumn: 1,
      endLineNumber: 2,
      endColumn: 6,
      severity: 8,
      message: 'boom',
    }
    wrapper.vm.setMarkers([marker])
    const callsBefore = fake.state.markerCalls.length

    await wrapper.setProps({ readonly: true })
    await flushPromises()

    expect(editor.options.readOnly).toBe(true)
    expect(editor.options.renderValidationDecorations).toBe('on')
    expect(model.markers['nojae-editor']).toEqual([marker])
    // Nothing repainted the buffer on the way in: the marks were never ours to
    // re-issue, so a second write here would be the pane guessing.
    expect(fake.state.markerCalls).toHaveLength(callsBefore)
    wrapper.unmount()
  })
})

// ---------------------------------------------------------------------------
// The bar's editor facts: the four things about the buffer on screen that the
// strip shows at its right edge. The surface is the only thing that can see
// them, so it reports and `useEditorFacts` holds — nothing here renders.
//
// The fake model answers `getOptions`, `getEOL` and `getLanguageId` the way the
// real one does, so what is asserted is the component's decisions: which facts
// it reads, what it reports for a buffer swap, and that a caret report names the
// buffer it belongs to.
// ---------------------------------------------------------------------------
describe('the editor facts it reports for the bar', () => {
  const facts = useEditorFacts()

  // Fire the newest model's own option channel, which is what Monaco does when
  // an indentation is re-resolved under the buffer on screen.
  function modelOptionsChanged() {
    fake.state.optionListeners.at(-1)({})
  }

  beforeEach(() => {
    clearEditorFacts()
  })

  it('reports every fact for the buffer it mounts on', async () => {
    const wrapper = await mountSurface()

    expect(facts.state.path).toBe('src/app.py')
    expect(facts.state.cursor).toBe('Ln 1, Col 1')
    // The fake's default resolved options: four spaces, an LF file, the id the
    // pane was created with.
    expect(facts.state.indentation).toBe('Spaces: 4')
    expect(facts.state.eol).toBe('LF')
    expect(facts.state.language).toBe('Python')
    wrapper.unmount()
  })

  // A line ending is a fact the model reports on the content channel, and it is
  // the only place it arrives: a CRLF buffer must say so.
  it('reports CRLF for a buffer whose model resolved that ending', async () => {
    const wrapper = await mountSurface({ content: 'x = 1\r\ny = 2\r\n' })

    expect(facts.state.eol).toBe('CRLF')
    wrapper.unmount()
  })

  // The indentation can move without the buffer changing, so the model's own
  // option channel is a report path rather than a read taken once at mount.
  it('reports an indentation the model re-resolved', async () => {
    const wrapper = await mountSurface()
    expect(facts.state.indentation).toBe('Spaces: 4')

    fake.state.models.at(-1).options = { insertSpaces: false, indentSize: 4, tabSize: 2 }
    modelOptionsChanged()

    expect(facts.state.indentation).toBe('Tab: 2')
    wrapper.unmount()
  })

  // A swap moves every fact with the buffer: the new model's own numbers, never
  // the previous one's.
  it('moves the facts with a buffer swap', async () => {
    const wrapper = await mountSurface()
    await wrapper.setProps({ content: 'a\r\nb\r\n', path: 'notes/a.md', language: 'markdown' })
    await flushPromises()

    expect(facts.state.path).toBe('notes/a.md')
    expect(facts.state.eol).toBe('CRLF')
    // `markdown` is not in this suite's registry: the id itself is the honest
    // answer, which is what the fallback is for.
    expect(facts.state.language).toBe('markdown')
    wrapper.unmount()
  })

  it('reports the caret alone, keyed by the buffer it is in', async () => {
    const wrapper = await mountSurface()
    expect(fake.state.cursorListeners).toHaveLength(1)

    fake.state.cursorListeners[0]({ position: { lineNumber: 7, column: 3 } })

    expect(facts.state.cursor).toBe('Ln 7, Col 3')
    expect(facts.state.path).toBe('src/app.py')
    wrapper.unmount()
  })

  it('forgets everything when the surface goes away', async () => {
    const wrapper = await mountSurface()
    expect(facts.state.path).toBe('src/app.py')

    wrapper.unmount()

    expect(facts.state.path).toBeNull()
    expect(facts.state.cursor).toBeNull()
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
    // Five registrations: three providers, the opener and the built-in marker
    // channel's listener.
    expect(fake.state.disposables).toHaveLength(5)

    wrapper.unmount()

    expect(fake.state.disposables.every((handle) => handle.disposed)).toBe(true)
    expect(editor.disposed).toBe(true)
    expect(model.disposed).toBe(true)
  })
})
