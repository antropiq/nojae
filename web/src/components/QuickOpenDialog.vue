<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useQuickOpen } from '../composables/useQuickOpen'
import { rankMatches } from '../lib/fuzzy-match'

// The quick-open popup: a `<dialog>` + `showModal()` over `useQuickOpen` state,
// the shape the Editor's other dialogs follow. Nothing here is a second store:
// the query, the fetched candidate list, the fetch state and the selected index
// are the composable's, so closing and re-opening shows the previous filter
// without another request.
//
// There is deliberately no `v-if` on the `<dialog>`: unmounting it throws away
// the caret position in the field and the list's scroll position, which is what
// makes re-opening pleasant. The watch below reconciles the element with
// `state.open`.
//
// What this component *does* own is the presentation, and three rules live only
// here:
//
//   * **the filtering is client-side**: `rankMatches` runs over the fetched list
//     on every keystroke and never asks the server again;
//   * **a path is never markup**: the matched spans are `<span>` slices around
//     the path string — no raw-HTML directive, no renderer, nothing that parses
//     the path;
//   * **the footer sentence is the payload's**: it is composed from the
//     `truncated` flag, because the count it names is the cap the server
//     already applied.
//
// The Ctrl+P chord raises this dialog through the composable's `openDialog` —
// from the Monaco command and from `lib/editor-keys.js` — so this component owns
// no chord of its own. A row click calls `pick`, the composable's own close, so
// this component never closes the dialog itself and the close keeps one owner.
const { state, closeDialog, pick } = useQuickOpen()

const dialogEl = ref(null)
const fieldEl = ref(null)
const listEl = ref(null)

// The state decides, the element follows. The focus call is done here rather
// than trusted to the `autofocus` attribute, because the element is not
// re-mounted per open and the browser's own autofocus only runs on insertion.
watch(
  () => state.open,
  async (open) => {
    await nextTick()
    const dialog = dialogEl.value
    if (dialog) {
      if (open && !dialog.open) dialog.showModal()
      else if (!open && dialog.open) dialog.close()
    }
    if (open) fieldEl.value?.focus()
  },
)

// Esc and a click outside both end in `closeDialog()`, which keeps the query and
// the list. The native `@close` writes the state instead of leaving it
// disagreeing with the element — otherwise the next `openDialog()` would find
// `state.open` already true and never show the dialog again.
function onBackdropClick(event) {
  if (event.target === dialogEl.value) closeDialog()
}

function onNativeClose() {
  if (state.open) closeDialog()
}

// An empty query matches everything with score 0, in the server's tree order —
// which for the root listing *is* the top-level entries, so the empty-dialog
// case needs no branch of its own.
const rows = computed(() => rankMatches(state.query, state.list))

// The selection is an index into `rows`, clamped whenever the filtered list
// shrinks — typing past the selected row must not leave the highlight on a row
// that is no longer there, and ↑/↓ must never move past either end.
const selected = computed({
  get: () => Math.min(state.selected, Math.max(rows.value.length - 1, 0)),
  set: (value) => {
    state.selected = Math.min(Math.max(value, 0), Math.max(rows.value.length - 1, 0))
  },
})

// ↑/↓ move the selection, Enter opens it, Escape closes — all on the dialog, so
// the field never needs its own handler. Enter on an empty list does nothing;
// there is no row to open.
function onKeydown(event) {
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    selected.value = selected.value + 1
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    selected.value = selected.value - 1
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const row = rows.value[selected.value]
    if (row) pick(row.path)
  }
  // Escape needs no entry: a `<dialog>` closes itself on it, and the native
  // `@close` above routes that into `closeDialog()`.
}

// The selected row is scrolled into view whenever it moves — including when
// typing shrinks the list and the clamp above moves the selection.
watch(selected, async () => {
  await nextTick()
  listEl.value
    ?.querySelector('.quickopen-row.is-selected')
    ?.scrollIntoView({ block: 'nearest' })
})

// One row's highlight: the spans are `[start, end)` slices of the path, so the
// row is the slices and the gaps between them — plain text nodes and `<span>`
// elements, never markup built from the path.
function slices(row) {
  const parts = []
  let at = 0
  for (const [start, end] of row.spans) {
    if (start > at) parts.push({ text: row.path.slice(at, start), mark: false })
    parts.push({ text: row.path.slice(start, end), mark: true })
    at = end
  }
  if (at < row.path.length) parts.push({ text: row.path.slice(at), mark: false })
  return parts
}

// Only when the payload said the walk was capped: the count it names is the
// cap the server applied, not a client-side count.
const footerLine = computed(() =>
  state.truncated
    ? 'showing the first 5000 files — narrow with the policy or type to filter'
    : '',
)

const loading = computed(() => state.status === 'loading')
const error = computed(() => (state.status === 'error' ? state.error : null))
</script>

<template>
  <dialog
    ref="dialogEl"
    class="quickopen-dialog"
    aria-labelledby="quickopen-title"
    @click="onBackdropClick"
    @close="onNativeClose"
    @keydown="onKeydown"
  >
    <article>
      <header>
        <h2 id="quickopen-title">Quick open</h2>
      </header>

      <!-- 1. The one field, autofocused. No `<form>` anywhere in this dialog,
           so Enter cannot navigate — it is handled on the dialog above. -->
      <input
        ref="fieldEl"
        v-model="state.query"
        class="quickopen-query"
        type="text"
        autofocus
        spellcheck="false"
        autocomplete="off"
        placeholder="file name — type to filter"
        aria-label="File name — type to filter"
      />

      <!-- A failed fetch is said here, next to the field that asked: the notice
           stack is for writes, and this dialog read nothing. -->
      <p v-if="error" class="error-line quickopen-error" role="alert">
        {{ error.detail }}
      </p>
      <p v-if="loading" class="caption quickopen-busy" role="status" aria-live="polite">
        listing files…
      </p>

      <!-- 2. The list, re-filtered on every keystroke. Rows are buttons, the
           selected one highlighted and scrolled into view; the path is rendered
           as text nodes and span slices, never markup. -->
      <div ref="listEl" class="quickopen-results">
        <button
          v-for="(row, index) in rows"
          :key="row.path"
          type="button"
          class="quickopen-row"
          :class="{ 'is-selected': index === selected }"
          :title="`Open ${row.path}`"
          @click="pick(row.path)"
          @mousemove="selected = index"
        ><code
          ><template v-for="(part, pi) in slices(row)" :key="pi"
            ><span v-if="part.mark" class="quickopen-mark">{{ part.text }}</span
            ><template v-else>{{ part.text }}</template></template
          ></code></button>
        <p v-if="!rows.length && !loading && !error" class="caption quickopen-empty">
          no matching files
        </p>
      </div>

      <!-- 3. The truncation footer, only when the payload said so. -->
      <footer v-if="footerLine" class="caption quickopen-footer">{{ footerLine }}</footer>
    </article>
  </dialog>
</template>
