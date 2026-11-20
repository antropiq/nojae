<script setup>
import { computed } from 'vue'

import { useEditorDiagnostics } from '../composables/useEditorDiagnostics.js'
import { useEditorFacts } from '../composables/useEditorFacts.js'
import { useEditorStatus } from '../composables/useEditorStatus.js'

// The Editor's status bar: one full-width strip at the very bottom of the
// screen, under the file tree as well as under the code pane and the terminal.
// It exists because diagnostics have three states — nothing analysed yet,
// analysed and clean, N problems — and without a bar the first two look the
// same: an editor showing no squiggles on a file nobody has analysed is an
// editor lying about that file.
//
// It is chrome, not a pane: no splitter, not resizable, not collapsible, not
// draggable, and nothing is ever placed below it. Its fields — which server
// answers for the buffer on screen, then the problem counts, then `analysing…`,
// then the one control — are read from composables, left to right, in one row
// that never wraps (§1.3).
//
// Everything it shows comes from a composable, never from state kept here: this
// component renders and owns nothing. The geometry lives in theme.css's
// `.editor-status-bar` rules, in the bar's own namespace.
//
// The **Server** field, first of the row: the language server answering for the
// buffer on screen, by id. It is text, never a control (§1.3), and its wording
// is one computed in `useEditorStatus` rather than a chain of template branches
// — the quiet answers included: a file no server claims gets the hub's own
// shortened sentence, a server switched off or errored gets its reason, and a
// diff tab, a preview tab and the empty pane say that no buffer applies rather
// than showing the last file's answer. Silence is a sentence, not an absence:
// this is the one place in the app that explains why Ctrl+click and diagnostics
// do nothing.
//
// The **Problems** field, second of the row: the error and warning counts for the
// buffer on screen, or the word that says the buffer was analysed and found
// clean. It exists because diagnostics have three states — nothing analysed yet,
// analysed and clean, N problems — and two of them look the same on a screen with
// no bar (§0): no squiggles on a file nobody has analysed is an editor lying
// about that file.
//
// Three rules hold it honest:
//
//   * **The counts come from one place.** `diagnostics.counts` is
//     `lib/monaco-lsp.js`'s counting function over the accepted answer's items,
//     so the number here and the underlines in the pane are one rule's two
//     renderings and cannot disagree. Nothing is counted in this component, and
//     nothing is counted from a second source. D7's line falls out of that: hints
//     and information are counted (as `other`) while only errors and warnings are
//     underlined, so a hint-only buffer shows a count and no squiggle — the
//     intended reading, said in one word rather than in a new tooltip.
//   * **A verdict is never an empty space.** An analysis with no items says *no
//     problems* in the spec's own words; silence is only allowed where the field
//     is *absent*, which is before an analysis exists (§1.3).
//   * **It describes the buffer on screen.** `diagnostics.status` is keyed by the
//     active path: an answer about any other path is not an answer about this
//     one, so the field reads absent rather than the previous buffer's numbers
//     (§1.3: no "last buffer" residue).
//
// It is text, never a control: §1.4 has no problems panel in v1 and D6 refuses
// even a per-chip count, for the same reason — chrome must not become a toolbar.
// An empty pane, a diff tab and a preview tab have no buffer and no server, so
// they show neither this field nor the state below (§1.3).
//
// The **context** fields, last of the row and aligned to its right edge: what
// the buffer on screen *is*, in the four answers an editor's own status bar
// gives — the caret's line and column, the indentation the model resolved, the
// line ending, and the file's kind by the grammar's own name. They are the
// §1.3 table's *(spare)* slot made real, and the reason it was left spare: they
// describe the buffer rather than judging it, which is why they sit apart from
// the verdict fields and why they are muted.
//
// **They come from `useEditorFacts`, never from this component.** None of the
// four can be answered without the Monaco instance, so the surface that owns it
// reports them (`MonacoEditor.vue`) and the composable holds them; the bar reads
// and formats nothing. That keeps this component's one invariant — *it renders
// and owns nothing* — and it is what lets a fact be absent: no code surface on
// screen means no facts, not the previous buffer's numbers (§1.3, again).
//
// Encoding is deliberately not among them. The bundled Monaco has no text-
// encoding concept at all, so the honest source would be the server's read
// payload — a different feature, not a field of this one.
const { serverLabel } = useEditorStatus()
const { recheck, recheckEnabled, recheckLabel, status, counts, analysing } =
  useEditorDiagnostics()
// The buffer's own facts — caret, indentation, line ending, file kind — read
// from the surface that can see them (`useEditorFacts`) and rendered at the
// strip's right edge. Every one is `null` when no code surface is on screen, so
// a diff tab, a preview tab and an empty pane show nothing there rather than the
// last buffer's numbers (§1.3).
const { state: facts } = useEditorFacts()

// The four fields in reading order, each `{ key, text }` or dropped when the
// surface has not answered it. Built as a list rather than four template
// branches so the separators are one rule, and so a fact nobody answered leaves
// no gap behind it.
const editorFacts = computed(() =>
  [
    { key: 'cursor', text: facts.cursor },
    { key: 'indentation', text: facts.indentation },
    { key: 'eol', text: facts.eol },
    { key: 'language', text: facts.language },
  ].filter((field) => field.text),
)

// `1 error` / `2 errors` — the count is a phrase, because a bare number in a
// field named Problems would not say what it counts.
function counted(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

// The field's parts, or `null` when the field is absent. `null` is the only
// "show nothing": an analysis that was reached answers an object, and a zero-item
// one answers `{ clean: true }` rather than an empty list — so the template can
// never render a verdict as a blank.
const problems = computed(() => {
  // Before an analysis exists the field says nothing; the State field and the
  // Server field are what carry the news (§1.3). `status` is null while the bar
  // holds nothing about the buffer on screen, and `'unknown'`/`'no_server'` are
  // both "no verdict" — only `'analysed'` may show a number or the word clean.
  if (status.value !== 'analysed') return null
  const { errors, warnings, total } = counts.value
  if (total === 0) return { clean: true, parts: [] }
  const parts = []
  if (errors > 0) parts.push({ key: 'errors', text: counted(errors, 'error') })
  if (warnings > 0) parts.push({ key: 'warnings', text: counted(warnings, 'warning') })
  // What D7 does not underline — hints and information. Named in the field
  // rather than left to a tooltip, because the split between "counted" and
  // "underlined" is the one thing a reader could wonder about while looking at a
  // file with a number and no squiggle. The number itself is the counting
  // function's, not a second count: this part is the total *minus* the two
  // severities it reports, so a hint cannot be counted twice or missed.
  const other = total - errors - warnings
  if (other > 0) {
    parts.push({ key: 'other', text: `${other} hint${other === 1 ? '' : 's'}/info` })
  }
  return { clean: false, parts }
})

// The **State** field, third of the row: `analysing…` while an answer is awaited,
// and nothing at all otherwise. It is the middle row of §4's table, and the
// reason the bar exists — a buffer with no analysis and no request in flight must
// not read as clean, so while it is unknown the Problems field stays silent and
// the Server field carries the reason the app can give.
//
// Present while `diagnostics.analysing` holds, which covers both a request in
// flight and an answer dropped as stale (D4): the analysis on screen then
// describes text that is no longer there, and the honest reading is still "we do
// not know yet". Absent otherwise — never a spinner and never an animation that
// outlives its cause, because the word is the whole affordance and it must vanish
// the moment there is a verdict.
const stateLabel = computed(() => (analysing.value ? 'analysing…' : null))

// The **one** interactive element of the strip (D1): a manual re-check. It fires
// trigger four — one ask for the buffer on screen — and nothing else. The counts
// remain text: §1.4 has no problems panel in v1, and D1's rationale is that a
// second control turns chrome into a toolbar.
//
// It is **disabled, never hidden**, when there is nothing to re-check: no buffer
// on screen, or no server for this path. That is deliberate — a re-check is the
// only thing a user can meaningfully do about a stale or absent answer, so the
// control has to stay visible and explain itself rather than appear and
// disappear with the tab. Its accessible name and its tooltip are one computed
// string, so the two cannot disagree about what the button does or why it is
// inert.
</script>

<template>
  <footer
    class="editor-status-bar"
    aria-label="Editor status"
    aria-live="polite"
  >
    <span class="editor-status-bar-field" data-field="server">{{ serverLabel }}</span>
    <!-- The problems for the buffer on screen, or the verdict that it is clean.
         Absent entirely before an analysis exists (§1.3): silence there is the
         honest answer, and the State field below carries the news that nothing is
         known yet. Each count is its own span so the severity colour is a token
         from theme.css rather than a hexadecimal written here; the separators are
         plain text, so the field reads as one sentence to a screen reader. -->
    <span
      v-if="problems"
      class="editor-status-bar-field editor-status-bar-field--fixed"
      data-field="problems"
    >
      <!-- A clean file is a verdict, and a verdict is never an empty space. -->
      <template v-if="problems.clean">no problems</template>
      <template v-else>
        <template v-for="(part, index) in problems.parts" :key="part.key">
          <span :class="`editor-status-bar-count--${part.key}`">{{ part.text }}</span>
          <template v-if="index + 1 < problems.parts.length">, </template>
        </template>
      </template>
    </span>
    <!-- `analysing…` while an answer is awaited, or while one was dropped as
         stale (D4). One word in the strip's own type, and it disappears the
         moment there is a verdict — not a spinner, and no animation that could
         outlive its cause. -->
    <span
      v-if="stateLabel"
      class="editor-status-bar-field editor-status-bar-field--fixed editor-status-bar-state"
      data-field="state"
    >{{ stateLabel }}</span>
    <!-- The one control, last in the row so a long server sentence is what gets
         ellipsised when the window is narrow — never the button. An icon button
         in the app's existing idiom: inline SVG, aria-label and title. -->
    <button
      class="editor-status-bar-recheck"
      type="button"
      :disabled="!recheckEnabled"
      :aria-label="recheckLabel"
      :title="recheckLabel"
      @click="recheck"
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <path d="M21 3v6h-6" />
      </svg>
    </button>
    <!-- The buffer's own facts, at the right edge of the strip: where the caret
         is, how the buffer indents, its line ending and what kind of file it is.
         Text, never a control, and absent entirely while no code surface is on
         screen — the group is dropped rather than left holding the previous
         buffer's numbers. `margin-left: auto` is what pushes it right; the
         fields above keep the space in between. -->
    <!-- `aria-live="off"` because the strip is a polite live region: the caret
         field changes on every keystroke, and announcing "Ln 12, Col 3" after
         each character would bury the verdicts this bar exists to speak. The
         facts are read on demand, not announced. -->
    <div v-if="editorFacts.length" class="editor-status-bar-facts" aria-live="off">
      <span
        v-for="field in editorFacts"
        :key="field.key"
        class="editor-status-bar-field editor-status-bar-field--fixed"
        :data-field="field.key"
      >{{ field.text }}</span>
    </div>
  </footer>
</template>
