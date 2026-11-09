<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

// The code pane's editor surface. Bundled with the Editor tab's lazy chunk
// (App.vue's defineAsyncComponent), never with the entry chunk — Monaco and
// its workers are heavy and the Benchmark tab is the default screen.
//
// Two things about this component are load-bearing and easy to break:
//
//   * Monaco owns the DOM inside `host`. It is created once and never
//     re-created on a prop change: content swaps go through the *model*
//     (`setValue`), the language through `setModelLanguage`. Re-creating the
//     editor per file would throw away scroll position, view state and the
//     worker session every click. A *buffer swap* is the one exception, and it
//     is a model swap rather than an editor one — see the note above the
//     `props.path` watcher.
//   * Pico's bare-element rules must not reach Monaco's internals, which is
//     what `monaco-pico.css` scopes out. Its import rides this file so it
//     lands in the same chunk as the editor it protects.
import * as monaco from 'monaco-editor'
import '../styles/monaco-pico.css'
import {
  clampReveal,
  ensureMonacoWorkers,
  monacoLanguageId,
  monoFontFamily,
  picoMonacoTheme,
} from '../lib/monaco-surface'
import {
  EDITOR_URI_SCHEME,
  editorUriFor,
  monacoPositionToLsp,
  pathForEditorUri,
  revealFor,
  wireHoverToMonaco,
  wireLocationToMonaco,
} from '../lib/monaco-lsp'
import { useEditorFiles } from '../composables/useEditorFiles'
import { useEditorLsp } from '../composables/useEditorLsp'

// The worker bootstrap, the theme mapping, the mono font and the server's
// language ids all live in `lib/monaco-surface`, because the diff viewer is a
// second Monaco surface with exactly the same needs — one source for both.
ensureMonacoWorkers()

const props = defineProps({
  content: { type: String, default: '' },
  language: { type: String, default: 'plaintext' },
  // The buffer's workspace-relative path. It is what the model's URI is derived
  // from, and therefore what a provider maps a model back to: without it there
  // is no way to say *which* file a Ctrl+click is about. Empty means "no buffer
  // named yet", which is a model with no URI and no provider answering for it.
  path: { type: String, default: '' },
  // Read-only by default: the safe shape is the one this component starts in,
  // and the *pane* decides when it changes (useEditorMode's rule — editable
  // while the WorkBench is idle). `readOnly`+`domReadOnly` gate the editing, and
  // the watcher below flips both hot when the mode changes. Saving is wired
  // either way (Ctrl+S and the header's buttons are window/pane level), so a
  // read-only pane can still be a pane with unsaved work in it.
  readonly: { type: Boolean, default: true },
  ariaLabel: { type: String, default: 'File contents' },
})

// Emits the new text whenever the user edits the buffer. Only fires for real
// edits (the model listener is guarded against the programmatic `setValue`
// below), and only matters while not `readonly` — a read-only surface cannot
// type. The pane routes this into the buffer record and the dirty flag.
//
// `quick-open` is the Ctrl+P chord (qop-07), claimed *inside* Monaco through
// its command API: a window-level `keydown` cannot reliably beat Monaco's own
// keybinding service, and the pane is exactly where the user is when the need
// arises. The command is registered once at mount, beside the editor itself.
//
// `definition` is a language server's answer to Ctrl+click / F12, as
// `{path, line, column}` in the pane's own coordinates. This surface never
// opens a buffer — the pane owns that — so a target in another file is handed
// over rather than reached for here (spec §6).
const emit = defineEmits(['content-change', 'quick-open', 'definition'])

const host = ref(null)

// The two singletons the providers read: the buffer records (for the path, the
// text and the dirty flag) and the language-server state (the one request per
// gesture). Neither is owned here — the pane and the Tools panel are.
const files = useEditorFiles()
const lsp = useEditorLsp()

let editor = null
let model = null
let themeObserver = null
// The three providers and the editor opener, registered once at mount and
// disposed with the editor. A second registration would answer every question
// twice, so the list is the guard as well as the teardown.
let providerDisposables = []
let openerDisposable = null
// Set while this component drives the model itself (`setValue` on a buffer
// swap or a reload) so the content listener stays silent for those, and only
// real user edits reach `content-change`.
let applyingExternal = false

// --- The reveal: "put the caret on this search hit" -----------------------
//
// The pane owns *which* hit and when to ask; this surface owns how, and the
// queue lives here because only this component knows when its model swap has
// finished (search-08). A reveal cannot be applied at the moment of the row
// click, for two independent reasons:
//
//   * the file may not be open yet, so there is no `editor` to move — the
//     reveal waits for `onMounted` (drain at its end);
//   * when the file *is* already open, the pane keeps this one instance across
//     tab switches and the `props.content` watcher below calls `model.setValue`
//     — which clears the cursor. So the reveal drains at the end of that
//     watcher too, after the swap, which is what lets a reveal queued for a
//     buffer that is still being fetched land once its text arrives.
//
// `revealPosition` also drains on the next tick, covering the case where
// neither of those is scheduled: the right text is already on screen, so the
// watcher never runs and the mount long happened.
const pendingReveal = ref(null) // { line, column }

function flushPendingReveal() {
  if (!pendingReveal.value || !editor || !model) return
  const position = clampReveal(
    pendingReveal.value,
    model.getLineCount(),
    (line) => model.getLineMaxColumn(line),
  )
  pendingReveal.value = null
  if (!position) return
  // This order: `setPosition` on an off-screen line does not scroll.
  editor.revealLineInCenter(position.line)
  editor.setPosition({ lineNumber: position.line, column: position.column })
}

function revealPosition({ line, column } = {}) {
  if (!Number.isInteger(line) || !Number.isInteger(column) || line < 1 || column < 1) {
    return // a reveal that cannot be applied is a no-op, never an error
  }
  pendingReveal.value = { line, column }
  void nextTick(flushPendingReveal)
}

// The only imperative surfaces this component has: the search-hit reveal and
// the focus return after a quick-open pick (qop-07) — `editor.focus()` puts the
// caret back in the textarea, which a focus on the host div would not.
function focus() {
  editor?.focus()
}

defineExpose({ revealPosition, focus })

// --- The language-server half: one model per path, three providers ----------
//
// **A model per path, not one model renamed.** Monaco has no "rename a model's
// URI" call, and the model's URI has to name the buffer on screen or every
// provider answers about the previous file. So a buffer swap creates a model
// with the new path's URI and disposes the old one — the one place this
// component departs from its "one model, swapped through `setValue`" note. The
// *editor* is still created once and never re-created, which is the invariant
// that matters: scroll position, view state and the worker session survive a
// swap, and only the model (and its undo stack) is replaced.
//
// The URI's scheme is synthetic (`lib/monaco-lsp.js`'s `EDITOR_URI_SCHEME`),
// never `file://`: a `file://` URI makes Monaco's built-in TypeScript worker try
// to resolve imports across files it does not have, which is a behaviour change
// nobody asked for. The providers are registered against that scheme, so they
// answer for this pane's models and nothing else.

// The buffer's text, but only when the buffer is dirty (spec §4.5). A clean
// buffer omits it and the hub reads the file — the common case stays cheap, and
// a user who typed three lines and then Ctrl+clicked is answered about what is
// on screen.
function bufferTextFor(path) {
  const record = files.recordFor(path)
  return record?.dirty ? record.text : undefined
}

// One question, one structured answer — or `null` for every quiet outcome: no
// server, a cold server still starting, a policy refusal, an unreachable API.
// A provider must never see a throw and the pane must never see a notice, so
// the three non-`ok` statuses collapse to the same nothing here (spec §4.10).
async function ask(action, path, position) {
  const answer = await lsp.query({
    action,
    path,
    line: position.line,
    character: position.character,
    text: bufferTextFor(path),
  })
  if (!answer || answer.status !== 'ok') return null
  return answer.result
}

// A wire location -> Monaco's `Location`. The `+1` happened in
// `lib/monaco-lsp.js`; this only wraps the two numbers in a zero-width range at
// the target, which is what a "go to definition" lands on.
function monacoLocationFor(location) {
  const mapped = wireLocationToMonaco(location)
  if (!mapped) return null
  return {
    uri: monaco.Uri.parse(editorUriFor(mapped.path)),
    range: new monaco.Range(
      mapped.lineNumber,
      mapped.column,
      mapped.lineNumber,
      mapped.column,
    ),
  }
}

// The path a model belongs to, or `null` for a model this pane did not create.
// Every provider starts here, so a model from another surface is never asked
// about.
function pathOf(model) {
  return model ? pathForEditorUri(model.uri) : null
}

const definitionProvider = {
  async provideDefinition(model, position) {
    const path = pathOf(model)
    if (!path) return null
    return monacoLocationFor(await ask('definition', path, monacoPositionToLsp(position)))
  },
}

const hoverProvider = {
  async provideHover(model, position) {
    const path = pathOf(model)
    if (!path) return null
    const hover = wireHoverToMonaco(await ask('hover', path, monacoPositionToLsp(position)))
    if (!hover) return null
    // HTML support **off** (spec §4.9): the server's markdown is escaped rather
    // than interpreted. The app's rule is that all rendered HTML goes through
    // `lib/markdown.js`; Monaco's hover is not app markup, so the rule is
    // honoured by configuration here — and this component renders nothing.
    return {
      contents: hover.contents.map((item) => ({ ...item, supportHtml: false })),
      ...(hover.range ? { range: hover.range } : {}),
    }
  },
}

const referencesProvider = {
  async provideReferences(model, position) {
    const path = pathOf(model)
    if (!path) return null
    const result = await ask('references', path, monacoPositionToLsp(position))
    if (!Array.isArray(result)) return null
    return result.map(monacoLocationFor).filter(Boolean)
  },
}

// The definition gesture, shared by F12 and by the Ctrl+click opener below, so
// the two cannot disagree: ask, map, then land the caret. A target in this file
// goes through the pane's own reveal (its queue and its clamp — a buffer may
// still be being fetched); a target in another file is handed to the pane,
// which owns opening buffers.
//
// An empty answer is a no-op: no throw, no notice, no visible change. F12 is
// *our* command, so it simply does nothing — handing the keystroke back to
// Monaco's own action would raise its "No definition found" message, which is
// exactly the notice §4.10 forbids. Ctrl+click needs no such care: it is
// Monaco's own gesture, so a `null` from our provider already lets it fall
// through to whatever it would have done on its own — for TypeScript and
// JavaScript, the built-in worker's definition, i.e. exactly today's behaviour.
async function goToDefinition() {
  if (!editor || !model) return
  const path = pathOf(model)
  const position = editor.getPosition()
  if (!path || !position) return
  const answer = await ask('definition', path, monacoPositionToLsp(position))
  if (!answer) return
  if (answer.path === path) {
    // Same file: the pane's own reveal, with its queue and its clamp.
    const reveal = revealFor(answer)
    if (reveal) revealPosition(reveal)
    return
  }
  // Another file: the pane owns opening buffers, so it is handed the target.
  const target = wireLocationToMonaco(answer)
  if (!target) return
  emit('definition', {
    path: target.path,
    line: target.lineNumber,
    column: target.column,
  })
}

// The model for a path, with the URI a provider maps back to it. A path-less
// model (no buffer named yet) keeps Monaco's own generated URI, which no
// provider answers for.
function createModelFor(path, content, language) {
  const uri = path ? monaco.Uri.parse(editorUriFor(path)) : undefined
  const created = monaco.editor.createModel(content, monacoLanguageId(language), uri)
  // One listener per model: the guard keeps the programmatic `setValue` (a
  // reload, a buffer swap) from echoing back as an edit. Real edits are exactly
  // the `content`-prop changes we did *not* cause — so each one is surfaced to
  // the pane once, with the model's text. (The loop still closes: the pane
  // stores what we emit, the watcher below sees it already equals
  // `model.getValue()` and skips.)
  created.onDidChangeContent(() => {
    if (applyingExternal) return
    emit('content-change', created.getValue())
  })
  return created
}

onMounted(() => {
  model = createModelFor(props.path, props.content, props.language)
  editor = monaco.editor.create(host.value, {
    model,
    automaticLayout: true,
    theme: picoMonacoTheme(),
    readOnly: props.readonly,
    domReadOnly: props.readonly,
    ariaLabel: props.ariaLabel,
    // The viewer shape: no sticky scroll, a ruler-less overview — none of it is
    // decoration, each of them costs width this pane does not have next to the
    // tree and the terminal strip. The minimap is the exception worth paying
    // that width for: it is how you scrub a long file, so it never autohides
    // (an autohidden minimap is a slider you cannot grab) and its slider is
    // shown always rather than only on hover. It draws colour blocks instead
    // of glyphs — unreadable at this scale, and they cost render time.
    // `maxColumn` is the width budget for this narrow pane.
    minimap: {
      enabled: true,
      autohide: 'none',
      showSlider: 'always',
      renderCharacters: false,
      maxColumn: 80,
    },
    stickyScroll: { enabled: false },
    overviewRulerLanes: 0,
    hideCursorInOverviewRuler: true,
    overviewRulerBorder: false,
    scrollBeyondLastLine: false,
    renderLineHighlight: 'line',
    glyphMargin: false,
    folding: true,
    wordWrap: 'off',
    smoothScrolling: true,
    padding: { top: 8, bottom: 8 },
    fontFamily: monoFontFamily(),
    fontSize: 13,
    lineHeight: 20,
    renderWhitespace: 'none',
    scrollbar: {
      verticalScrollbarSize: 10,
      horizontalScrollbarSize: 10,
      useShadows: false,
    },
  })

  // The quick-open chord (qop-07): Ctrl+P inside the pane raises the dialog.
  // Registered through the command API — the one path that beats Monaco's
  // internal keybinding service — and `preventDefault` is implied: a command
  // that runs has consumed the keystroke, so Print never fires while the pane
  // holds focus. The pane routes the emit into the composable's `openDialog`.
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, () => emit('quick-open'))

  // F12, the keyboard half of "go to definition", registered the same way and
  // for the same reason. Ctrl+click needs no keybinding of its own — it is
  // Monaco's own gesture for this — so it is claimed through the editor opener
  // below instead, and both run `goToDefinition` so the two cannot disagree.
  editor.addCommand(monaco.KeyCode.F12, () => void goToDefinition())

  // The three providers, registered once against this pane's scheme so they
  // answer for its models and nothing else. Each returns nothing for a quiet
  // answer, which is what lets Monaco fall through to whatever it would have
  // done on its own — for TypeScript and JavaScript, the built-in worker's
  // definition, i.e. exactly today's behaviour (spec §4.10).
  providerDisposables = [
    monaco.languages.registerDefinitionProvider(
      { scheme: EDITOR_URI_SCHEME },
      definitionProvider,
    ),
    monaco.languages.registerHoverProvider({ scheme: EDITOR_URI_SCHEME }, hoverProvider),
    monaco.languages.registerReferenceProvider(
      { scheme: EDITOR_URI_SCHEME },
      referencesProvider,
    ),
  ]

  // Ctrl+click. Monaco's own "go to definition" gesture asks the definition
  // providers and then opens the target through the editor service, which in a
  // standalone editor can only reach the model already attached — so a target
  // in another file would go nowhere. The opener is the seam for that: it is
  // asked first, and answering `true` means this pane handled the jump. A
  // quiet answer returns `false`, so the gesture falls through untouched.
  openerDisposable = monaco.editor.registerEditorOpener({
    async openCodeEditor(_source, resource, selectionOrPosition) {
      const target = pathForEditorUri(resource)
      if (!target) return false
      const position = selectionOrPosition
      if (!position) return false
      const line = position.startLineNumber ?? position.lineNumber
      const column = position.startColumn ?? position.column
      if (!Number.isInteger(line) || !Number.isInteger(column)) return false
      if (target === pathOf(model)) {
        revealPosition({ line, column })
      } else {
        emit('definition', { path: target, line, column })
      }
      return true
    },
  })

  // Theme changes are an attribute mutation on `<html>`, not a store we can
  // import (useTheme writes the attribute directly and index.html sets it
  // before any module runs), so a MutationObserver is the honest listener.
  themeObserver = new MutationObserver(() => monaco.editor.setTheme(picoMonacoTheme()))
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })
  flushPendingReveal()
})

// A buffer swap moves the model's URI with it. Monaco has no "rename a model's
// URI" call, so the honest shape is a model per path: the new one is created
// with the new path's URI and the old one is disposed. The *editor* is not
// re-created — it takes the new model through `setModel`, so scroll position,
// view state and the worker session survive, and only the model (and its undo
// stack) is replaced. Without this, every provider would keep answering about
// the file that was on screen before the swap.
//
// Registered before the content watcher below so it runs first in the same
// flush: the new model already holds the new text, and the content watcher then
// sees `next === model.getValue()` and skips its `setValue`.
watch(
  () => props.path,
  (next) => {
    if (!editor) return
    const previous = model
    model = createModelFor(next, props.content, props.language)
    editor.setModel(model)
    previous?.dispose()
    // The swap cleared the cursor, exactly as `setValue` does, so a reveal
    // queued for this buffer is applied here — the first moment the new model
    // is the one on screen.
    flushPendingReveal()
  },
)

// Content: go through the model, never `create` again. The guard matters:
// `setValue` clears the undo stack and the cursor/selection, so it must not
// run when the text already matches (an unrelated re-render, a reload that
// changed nothing).
//
// Line endings need no handling here beyond letting the model do it: `setValue`
// builds the model's EOL from the text it is given (the majority of `\r\n` over
// `\n`), so a CRLF file keeps CRLF, the caret's Enter inserts CRLF, and every
// `getValue()` the pane saves back is written with that EOL. The server never
// normalises (D5) — what the model says is what lands. The one thing that does
// not survive is a file with *mixed* endings, which the model resolves to its
// dominant form on load: the same normalising any editor with a single EOL per
// buffer does, and a reason the save goes through the mtime guard rather than
// trusting the buffer to be byte-identical.
watch(
  () => props.content,
  (next) => {
    if (!model || next === model.getValue()) return
    applyingExternal = true
    try {
      model.setValue(next)
    } finally {
      applyingExternal = false
    }
    // `setValue` cleared the cursor, so a reveal queued for this buffer (a hit
    // clicked while its file was still being fetched) is applied here — the
    // first moment the new text is in the model. Draining anywhere earlier is
    // the synchronous-reveal bug the queue exists to avoid.
    flushPendingReveal()
  },
)

watch(
  () => props.language,
  (next) => {
    if (model) monaco.editor.setModelLanguage(model, monacoLanguageId(next))
  },
)

watch(
  () => props.readonly,
  (next) => {
    if (!editor) return
    editor.updateOptions({ readOnly: next, domReadOnly: next })
  },
)

// `ariaLabel` is a construction-time option, so switching the active buffer
// (same editor, new file) would otherwise leave the screen-reader label stuck
// on the first file opened. It rides the same `updateOptions` path.
watch(
  () => props.ariaLabel,
  (next) => {
    if (editor) editor.updateOptions({ ariaLabel: next })
  },
)

// Both halves get disposed: the editor (its DOM, listeners, and the
// ResizeObserver behind `automaticLayout`) and the model (its worker-side
// mirror and tokenization caches). Disposing only the editor leaks the model.
// The providers and the opener go with them: they are registered against a
// scheme this pane's models no longer use, and a second mount would otherwise
// register a second set that answers every question twice.
onBeforeUnmount(() => {
  themeObserver?.disconnect()
  themeObserver = null
  for (const disposable of providerDisposables) disposable?.dispose()
  providerDisposables = []
  openerDisposable?.dispose()
  openerDisposable = null
  editor?.dispose()
  editor = null
  model?.dispose()
  model = null
})
</script>

<template>
  <!-- `monaco-host` is the scope of the Pico overrides in monaco-pico.css and
       the element Monaco builds inside: it must stay empty of app markup. -->
  <div ref="host" class="monaco-host"></div>
</template>

<style scoped>
/* Monaco fills its host and never sizes it, so the host takes the pane and
   Monaco's own `automaticLayout` observes this box. */
.monaco-host {
  width: 100%;
  height: 100%;
  min-height: 0;
}
</style>
