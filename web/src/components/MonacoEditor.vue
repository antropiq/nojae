<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

// The code pane's editor surface. Bundled with the Editor tab's lazy chunk
// (App.vue's defineAsyncComponent), never with the entry chunk — Monaco and
// its workers are heavy and the WorkBench tab is the default screen.
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
//
// The problems this pane shows are Monaco's own validation decorations: the
// marker surface below hands a set over, Monaco draws the squiggle and its
// tooltip. Two checks are manual, because neither is visible to a jsdom suite
// (a real Monaco needs a canvas): hover a marked range and the message appears,
// and with the pane read-only — start a chat reply — the underline is still
// there. The second is the regression this feature is most likely to suffer: at
// Monaco's default, `renderValidationDecorations` hides every marker exactly
// then (spec §2), which is why the option is set explicitly below.
//
// A third surface sits beside them: Monaco's own JavaScript/TypeScript engine
// also draws marks, and for a buffer a declared server answers for the two would
// disagree about one file. That engine is silenced **per buffer**, and only while
// a server claims the path — D5, and the section below says why it is per buffer
// rather than per language.
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
  builtinValidationOverride,
  editorUriFor,
  monacoPositionToLsp,
  pathForEditorUri,
  revealFor,
  wireHoverToMonaco,
  wireLocationToMonaco,
} from '../lib/monaco-lsp'
import { cursorLabel, eolLabel, indentationLabel, languageDisplayName } from '../lib/editor-facts'
import { useEditorFacts } from '../composables/useEditorFacts'
import { useEditorFiles } from '../composables/useEditorFiles'
import { useEditorLsp } from '../composables/useEditorLsp'
import { useEditorStatus } from '../composables/useEditorStatus'

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

// The singletons the providers read: the buffer records (for the path, the text
// and the dirty flag), the language-server state (the one request per gesture)
// and the bar's server answer (which server serves a path — read, never asked
// again here). None is owned here: the pane, the Tools panel and the bar are.
const files = useEditorFiles()
const lsp = useEditorLsp()
const editorStatus = useEditorStatus()
// The bar's *editor* half: what this buffer is and where the caret sits in it.
// Reported, never read — this surface is the only thing that can answer.
const editorFacts = useEditorFacts()

let editor = null
let model = null
let themeObserver = null
// The three providers and the editor opener, registered once at mount and
// disposed with the editor. A second registration would answer every question
// twice, so the list is the guard as well as the teardown.
let providerDisposables = []
let openerDisposable = null
// The scroll position and caret of every buffer this surface has shown, keyed by
// path. Read and written only by the buffer-swap watcher below.
const viewStates = new Map()
// The built-in marker channel's listener, disposed with the rest: it names this
// pane's model, so it has no meaning once the pane is gone.
let markersSubscription = null
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

// --- The marker surface: the buffer's problems, drawn by Monaco ------------
//
// **The one caller of Monaco's model-marker API in the whole app.** A set
// arrives from outside — the composable that decides *when* lives beside this
// pane, not in it — and this surface applies it to the model that is on screen
// at apply time. Nothing else marks a model, and no set is remembered here:
// a buffer swap disposes the previous model and drops its marks with it
// (spec §2, consequence 3), so this call must be made again for a buffer that
// comes back rather than being cached against a model.
//
// **Replacement is whole** — Monaco's own semantics for `setModelMarkers`: the
// set handed over becomes the model's entire marker set for this owner, so an
// empty set clears the buffer. That is what makes a fixed defect's underline
// vanish, and merging is how a stale squiggle survives its fix (spec §6). There
// is deliberately no diffing step here "to avoid flicker".
//
// The hover is Monaco's too: a marked range shows its tooltip with the marker's
// message, positioned and keyboard-handled by Monaco. No handler, no tooltip
// component and no second text source may be added for it (spec §2) — the
// message is a plain string and Monaco escapes it like any other marker text.
const MARKER_OWNER = 'nojae-editor'

function setMarkers(markers) {
  // No buffer named yet (an empty path) has nothing to mark: a no-op, never a
  // throw. The model is read *here* rather than captured, and its own URI is
  // what says which buffer it is, so a set applied after a swap reaches the new
  // model and a path-less one reaches nothing.
  if (!pathOf(model)) return
  monaco.editor.setModelMarkers(model, MARKER_OWNER, Array.isArray(markers) ? markers : [])
}

// --- The built-in engine, silenced per buffer (D5) -------------------------
//
// Monaco's own JavaScript/TypeScript engine draws marks too, and on a buffer a
// declared server answers for the two engines would disagree about one file. The
// built-in switch is **per language** — the TypeScript mode's diagnostics options
// and the validation providers it registers — so flipping it would delete the
// only marks a `.ts` buffer has when no declared server claims it, which is
// precisely the case D5 protects. The rule here is therefore **per buffer**: the
// built-in engine is silenced for the model on screen, and only that model, while
// a declared server answers for that buffer's path.
//
// *Which server answers* is not decided here. It is the pane's server field's own
// answer (`useEditorStatus` — `POST /api/lsp/query`'s `status` action, answered
// by the hub from its own state, off and errored vocabulary included), read
// **live** at the moment of the sweep and never captured at mount: a server that
// finishes starting, a hub restart or a switch moved in the Tools panel changes
// that answer while the model stays the same model. So no second path→server rule
// is written here, and nothing is compressed to a boolean: the answer's reason is
// still the bar's to show.
//
// The silencing is per **marker owner**, and that is the nearest thing to a
// per-model override this build of Monaco offers: it publishes no model-side
// diagnostics-provider registration, so what a model's own validation *is* cannot
// be overridden. What it does have is an owner-scoped marker channel, and the
// built-in engine publishes its whole output for a model under that model's
// language id as the owner (`typescript`, `javascript`). Dropping that entry for
// **this model and no other** removes both halves at once — the syntax check and
// the semantic one — so one file speaks with one voice, and a neighbouring `.ts`
// buffer nothing claims keeps its marks. A buffer nothing claims is never
// touched: with no claim the sweep is a no-op and the built-in engine repaints
// exactly as it does today.
//
// Restoring is the same rule's other half. The engine's own revalidation is
// requested — its diagnostics options re-set to the value they already carry,
// which is the documented "recompute diagnostics" trigger of the language
// service — so the marks return without a re-created model, a re-opened document
// or a reload.
//
// **A marker set is never removed, replaced or overridden here.** The declared
// server's marks are ours (`MARKER_OWNER`) and this sweep only ever names the
// built-in owners: the two are different channels.
//
// The listener that drives the fifth moment is this pane's own, kept beside the
// providers and disposed with them, so a remount leaves exactly one live set —
// two would clear each other's model twice per publish.
const BUILTIN_MARKER_OWNERS = Object.freeze(['typescript', 'javascript'])

// The built-in language service per language id, by the same two ids its marks
// are published under — one map says both, so the owners above and the defaults
// below cannot drift apart.
function builtinDefaultsFor(languageId) {
  const services = monaco.typescript
  if (!services) return null
  if (languageId === BUILTIN_MARKER_OWNERS[0]) return services.typescriptDefaults ?? null
  if (languageId === BUILTIN_MARKER_OWNERS[1]) return services.javascriptDefaults ?? null
  return null
}

// The override for the *live* answer, read at the moment Monaco asks rather than
// captured at mount. The decision is `lib/monaco-lsp.js`'s
// `builtinValidationOverride` — one statement of D5's rule, reading the bar's own
// keyed answer so the browser grows no second path→server rule — and this surface
// only applies the verdict. Non-`null` is "suppress", and the override's two
// halves come together: a file with a declared server speaks with one voice.
function builtinValidationFor(path) {
  return builtinValidationOverride(editorStatus.state, path)
}

// Drop the built-in engine's publication for one model, and only that model — a
// neighbouring `.ts` buffer no server claims keeps its marks. Reads first, so the
// common case (nothing published) writes nothing and cannot loop.
function clearBuiltinMarkers(target) {
  for (const owner of BUILTIN_MARKER_OWNERS) {
    const published = monaco.editor.getModelMarkers({ owner, resource: target.uri })
    if (!published || published.length === 0) continue
    monaco.editor.setModelMarkers(target, owner, [])
  }
}

// Ask the built-in engine to recompute this model's marks. Re-setting the options
// it already holds is the language service's own "diagnostics are stale" trigger:
// the value does not change, so nothing about the engine's answer does — it only
// repaints what an unclaimed buffer should be showing anyway.
function requestBuiltinRevalidation(target) {
  const defaults = builtinDefaultsFor(target.getLanguageId())
  if (!defaults?.getDiagnosticsOptions || !defaults?.setDiagnosticsOptions) return
  defaults.setDiagnosticsOptions(defaults.getDiagnosticsOptions())
}

// Whether the built-in engine is currently silenced for the model on screen. Per
// model, not per pane: a buffer swap moves it with the buffer.
let builtinSuppressed = false

// Re-evaluate the one rule for the model on screen: silence it while a declared
// server answers for its path, hand the question back to the defaults when one
// stops. Called at every moment the answer can move — mount, a buffer swap, the
// status answer landing, and the built-in engine publishing afresh.
function sweepBuiltinSuppression() {
  if (!model) return
  if (builtinValidationFor(pathOf(model))) {
    builtinSuppressed = true
    clearBuiltinMarkers(model)
    return
  }
  if (!builtinSuppressed) return
  builtinSuppressed = false
  requestBuiltinRevalidation(model)
}

// The built-in engine republishes after every edit's own debounce, so the sweep
// is driven by its answers rather than by a timer: a suppressed model's set is
// dropped the moment it appears. A resource this pane does not own is ignored.
function builtinPublished(resources) {
  if (!model) return
  const mine = model.uri?.toString?.()
  if (!Array.isArray(resources) || !resources.some((uri) => uri?.toString?.() === mine)) return
  if (!builtinValidationFor(pathOf(model))) return
  builtinSuppressed = true
  clearBuiltinMarkers(model)
}

// The imperative surfaces this component has: the search-hit reveal, the focus
// return after a quick-open pick (qop-07 — `editor.focus()` puts the caret back
// in the textarea, which a focus on the host div would not), and the marker set
// above.
function focus() {
  editor?.focus()
}

defineExpose({ revealPosition, focus, setMarkers })

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

// --- The Ctrl-hover link: is there a target under the pointer? -------------
//
// Monaco draws this indicator itself, and this pane cannot use that path: after
// a provider answers, Monaco's own contribution asks the text-model service for
// the **target** document, to show a preview of it in the link's tooltip. In a
// standalone editor that service only answers for models that already exist, so
// an ordinary answer here — a name defined in another file, or outside the
// workspace entirely, which is what a server returns for an imported symbol —
// throws `Model not found`, the decoration is never applied, and the user gets
// no indicator at all. The underline therefore stays this pane's to paint.
//
// It is painted from the answer the pane already holds, and the gesture is what
// asks: Monaco calls a definition provider on Ctrl+hover and on Ctrl+click
// alike, so painting here costs **no second request** — the underline is a
// reading of an answer the gesture produced anyway. A hover that resolves
// nothing paints nothing, which is the point: the underline means a target
// exists.
const LINK_CLASS = 'nojae-definition-link'

// Owned by the editor, so `editor.dispose()` takes it with the rest.
let linkDecorations = null

// Withdraw the underline. Called at each moment it stops being a true
// statement about the pointer, and a no-op when nothing is painted, so the
// common path writes nothing.
function clearLink() {
  if (!linkDecorations || linkDecorations.length === 0) return
  linkDecorations.clear()
}

// The modifier's own release, from anywhere on the page. Only the two keys that
// make a Ctrl+click a Ctrl+click are watched: releasing any other key must not
// withdraw an underline the pointer is still making true.
function onWindowKeyUp(event) {
  if (event.key === 'Control' || event.key === 'Meta') clearLink()
}

// Underline the word at `position`, or withdraw the underline when there is no
// word to name (a pointer resting on whitespace).
function paintLink(model, position) {
  const word = model?.getWordAtPosition?.(position)
  if (!word || !linkDecorations) {
    clearLink()
    return
  }
  linkDecorations.set([
    {
      range: new monaco.Range(
        position.lineNumber,
        word.startColumn,
        position.lineNumber,
        word.endColumn,
      ),
      options: { description: 'nojae-ctrl-hover-link', inlineClassName: LINK_CLASS },
    },
  ])
}

const definitionProvider = {
  async provideDefinition(model, position) {
    const path = pathOf(model)
    if (!path) return null
    const location = monacoLocationFor(await ask('definition', path, monacoPositionToLsp(position)))
    // The answer lands after the gesture, so the link is painted only while
    // this model is still the one on screen: a buffer swap mid-request must not
    // underline a word in the file that replaced it.
    if (editor?.getModel() === model) {
      if (location) paintLink(model, position)
      else clearLink()
    }
    return location
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

// --- The bar's editor facts: report, never render -------------------------
//
// The four facts the strip's right edge shows — caret, indentation, line ending,
// file kind — are read from the model and the editor, formatted by
// `lib/editor-facts.js`, and handed to `useEditorFacts` for the bar to render.
// Nothing in that chain is decided here: this surface is the only thing that can
// *see* the answers, so it is the only thing that reports them.
//
// The path travels with every report, so a fact can never describe the buffer
// that used to be on screen: the composable drops a cursor report for a path it
// is not holding, and `reportFacts` always names the model it read.
function reportFacts(target) {
  if (!target) return
  const path = pathOf(target)
  if (!path) return
  editorFacts.reportFile({
    path,
    // The caret is the editor's fact, not the model's; a report made while no
    // editor exists yet (the model is created before `editor`) simply has none,
    // and the mount reports again once there is one.
    cursor: editor ? cursorLabel(editor.getPosition()) : null,
    indentation: indentationLabel(target.getOptions()),
    eol: eolLabel(target.getEOL()),
    language: languageDisplayName(target.getLanguageId(), monaco.languages.getLanguages()),
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
  created.onDidChangeContent((event) => {
    // A line ending is a fact the bar shows and nothing else watches: Monaco
    // reports it on the content channel (`isEolChange`), which is the only place
    // it arrives. Reported before the edit guard below, because a line-ending
    // change is not a user edit of the text.
    if (event?.isEolChange) reportFacts(created)
    if (applyingExternal) return
    emit('content-change', created.getValue())
  })
  // The two facts that move without the buffer changing: an indentation Monaco
  // has re-resolved, and a language the pane set. Each is one string in the bar,
  // so a report that changes nothing writes nothing.
  created.onDidChangeOptions(() => reportFacts(created))
  created.onDidChangeLanguage(() => reportFacts(created))
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
    // The viewer shape: no sticky scroll — none of it is decoration, each of them
    // costs width this pane does not have next to the tree and the terminal
    // strip. The minimap is the exception worth paying that width for: it is how
    // you scrub a long file, so it never autohides (an autohidden minimap is a
    // slider you cannot grab) and its slider is shown always rather than only on
    // hover. It draws colour blocks instead of glyphs — unreadable at this
    // scale, and they cost render time. `maxColumn` is the width budget for this
    // narrow pane.
    minimap: {
      enabled: true,
      autohide: 'none',
      showSlider: 'always',
      renderCharacters: false,
      maxColumn: 80,
    },
    stickyScroll: { enabled: false },
    // The lanes are where Monaco puts a problem that is off screen, so they are
    // on: "how bad is this file, and roughly where" is exactly the question a
    // long file raises (D2). The gutter icon column stays off — a per-line icon
    // duplicates a mark already visible on the line itself and costs horizontal
    // space this pane cannot spare. Only the cursor mark is suppressed.
    overviewRulerLanes: 2,
    hideCursorInOverviewRuler: true,
    overviewRulerBorder: false,
    scrollBeyondLastLine: false,
    renderLineHighlight: 'line',
    glyphMargin: false,
    // **Not the default, on purpose.** Monaco's default is `'editable'`, whose
    // filter is literally "hide validation decorations when the editor is
    // read-only" — and this pane *is* read-only while a chat reply streams, i.e.
    // exactly when someone is reading code rather than editing it. Leave this at
    // the default and every squiggle vanishes during a live reply (spec §2,
    // consequence 2): the feature works in testing and fails in use.
    renderValidationDecorations: 'on',
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

  // The link's decoration collection, created with the editor so it is disposed
  // with it. It hangs off the *editor* rather than the model, so a buffer swap
  // does not carry a stale underline to the new file.
  linkDecorations = editor.createDecorationsCollection()

  // The underline stops being true when the pointer moves without the modifier,
  // on any edit, whenever the pane scrolls, and when the buffer changes. Each of
  // these withdraws it; a later Ctrl+hover paints it again from a fresh answer.
  // Registered on the editor, so they cost nothing after dispose.
  editor.onMouseMove((e) => {
    if (!linkDecorations?.length) return
    if (!e.event.ctrlKey && !e.event.metaKey) clearLink()
  })
  editor.onDidChangeModelContent(() => clearLink())
  editor.onDidScrollChange(() => clearLink())
  editor.onDidChangeModel(() => clearLink())
  // The release is heard on the **window**, not on the editor: the modifier is
  // let go wherever the focus happens to be (the pointer hovered the pane, it
  // never had to focus it), and Monaco's own `onKeyUp` only fires while the
  // editor holds focus. Listening on the editor alone leaves the underline
  // painted after the key is up, which is the indicator stuck on.
  window.addEventListener('keyup', onWindowKeyUp)

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

  // The built-in engine's own publication is the fifth moment its answer can
  // move: it repaints after every edit's debounce, so a suppressed model's set is
  // dropped as it appears rather than polled for. Registered beside the others
  // and disposed with them.
  markersSubscription = monaco.editor.onDidChangeMarkers(builtinPublished)
  // A pane that mounts on a buffer whose server answer is already held silences
  // the built-in engine without waiting for the next status read.
  sweepBuiltinSuppression()

  // Theme changes are an attribute mutation on `<html>`, not a store we can
  // import (useTheme writes the attribute directly and index.html sets it
  // before any module runs), so a MutationObserver is the honest listener.
  themeObserver = new MutationObserver(() => monaco.editor.setTheme(picoMonacoTheme()))
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  })

  // The caret's own channel: the one fact that moves per keystroke. Registered
  // on the editor like the events above, so it is disposed with it; the report
  // is one comparison in the composable when the position has not moved.
  editor.onDidChangeCursorPosition((event) => {
    const path = pathOf(editor?.getModel())
    if (!path) return
    editorFacts.reportCursor(path, cursorLabel(event.position))
  })

  // The four facts for the buffer the pane was born on, once the editor exists
  // (a report made earlier could not have named a caret).
  reportFacts(model)
  flushPendingReveal()
})

// The answer can move while the buffer does not: a hub restart, a server that
// finishes starting, a switch moved in the Tools panel. Read **live** — the
// watcher re-runs the one rule, so the override's answer changes with the state
// and the model is never re-created, re-opened or reloaded to make it take
// effect. Two dependencies: the path it is keyed by, and the envelope itself.
watch(
  () => [editorStatus.state.path, editorStatus.state.answer],
  () => sweepBuiltinSuppression(),
)

// A buffer swap moves the model's URI with it. Monaco has no "rename a model's
// URI" call, so the honest shape is a model per path: the new one is created
// with the new path's URI and the old one is disposed. The *editor* is not
// re-created — it takes the new model through `setModel`, so the worker session
// survives, and only the model (and its undo stack) is replaced. Without this,
// every provider would keep answering about the file that was on screen before
// the swap.
//
// **The view state does not survive a swap, and has to be carried.** Scroll
// position and caret belong to the *editor's* view model, which `setModel`
// throws away with the old model — that is why a tab switch landed back at the
// top of the file. Monaco publishes exactly the two calls for this,
// `saveViewState()` and `restoreViewState()` (the pair VS Code's own multi-model
// editor is built on), and the state is a plain serialisable object, so it is
// remembered per path and re-applied when the buffer comes back. Nothing
// in-house re-derives a scroll offset: the only facts kept are Monaco's own.
//
// The save happens **before** `setModel`, because `saveViewState` reads the
// model that is attached at call time — after the swap it would answer about the
// new one. A path-less buffer has no key to file it under and is skipped.
//
// Registered before the content watcher below so it runs first in the same
// flush: the new model already holds the new text, and the content watcher then
// sees `next === model.getValue()` and skips its `setValue`.
watch(
  () => props.path,
  (next) => {
    if (!editor) return
    // The outgoing buffer's position, filed under the path it belongs to.
    const previousPath = pathOf(model)
    if (previousPath) {
      const state = editor.saveViewState()
      if (state) viewStates.set(previousPath, state)
      else viewStates.delete(previousPath)
    }
    const previous = model
    model = createModelFor(next, props.content, props.language)
    editor.setModel(model)
    previous?.dispose()
    // Back to where this buffer was last read or edited. Applied before the
    // reveal below, so a deliberate "go to this hit" still wins over the
    // remembered position — a reveal is a request about where to *be*, and the
    // restored state is only where the user *was*.
    const remembered = next ? viewStates.get(next) : null
    if (remembered) editor.restoreViewState(remembered)
    // The answer moves with the buffer: the previous model's answer is never
    // applied to the new one, and the new buffer may be one no server claims, in
    // which case its built-in marks stay exactly as they are.
    builtinSuppressed = false
    sweepBuiltinSuppression()
    // The four facts move with the buffer: the indentation, the line ending and
    // the kind are the *new* model's, never the previous one's residue (§1.3).
    // `restoreViewState` moved the caret, so this report is the one that puts the
    // remembered line in the status bar.
    reportFacts(model)
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
// **A tab switch moves this prop and `path` in the same flush, and this watcher
// can be reached first.** Writing the incoming buffer's text into the model that
// is on screen would then be doubly wrong: it is not a buffer swap at all, and
// `setValue` wipes the caret and the scroll offset of the file the user is
// leaving — before the path watcher above gets to save them, which is why a
// switch used to lose the position even once the save/restore existed. So the
// guard is the *buffer's identity*, not only the text: a change that belongs to
// another path is the path watcher's to apply, through the model it creates.
// (`pathOf(model)` and not the old prop, because the props have already moved,
// and `|| null` so "no buffer named yet" agrees with itself: the model's own
// path is `null` for an unnamed buffer while the prop is the empty string.)
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
    if (!model || (props.path || null) !== pathOf(model)) return
    if (next === model.getValue()) return
    applyingExternal = true
    try {
      model.setValue(next)
    } finally {
      applyingExternal = false
    }
    // A new text re-resolves the model's own facts — the line ending above all,
    // since `setValue` rebuilds it from the text it is handed.
    reportFacts(model)
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
  markersSubscription?.dispose()
  markersSubscription = null
  builtinSuppressed = false
  for (const disposable of providerDisposables) disposable?.dispose()
  providerDisposables = []
  openerDisposable?.dispose()
  openerDisposable = null
  // The collection belongs to the editor, which disposes it — dropping the
  // reference is all that is left, so a remount never paints through a handle
  // from the previous editor. The window listener is ours, so it is removed
  // here for the same reason a second one must never exist.
  window.removeEventListener('keyup', onWindowKeyUp)
  linkDecorations = null
  editor?.dispose()
  editor = null
  model?.dispose()
  model = null
  // No code surface is on screen any more (a diff tab, a preview tab, the last
  // tab closing): the facts go with it rather than being left describing a
  // buffer nobody can see.
  editorFacts.clearEditorFacts()
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

/* The Ctrl-hover indicator: the word a Ctrl+click would jump from, drawn while
   the modifier is down and a target exists for it. The class is applied by this
   component's own decoration (see `paintLink`), and its elements are Monaco's,
   so `:deep` is what reaches them — a scoped rule alone would not. Only the
   underline is drawn: the token keeps its own colour, so the indicator says
   "there is a target here" without repainting the code around it. */
.monaco-host :deep(.nojae-definition-link) {
  text-decoration: underline;
  cursor: pointer;
}
</style>
