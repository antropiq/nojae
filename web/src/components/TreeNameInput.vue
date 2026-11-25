<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useWorkspaceTree } from '../composables/useWorkspaceTree'
import { useEditorCreate } from '../composables/useEditorCreate'
import { useEditorRename } from '../composables/useEditorRename'
import { fileIcon } from '../lib/file-icons'

// The inline name row, *inside* the folder that will hold the new thing — which
// is why it is a row of the tree rather than a modal form. One widget serves both
// modes off the tree's `state.editing`: `create` names a new file or folder in
// `parent`, `rename` gives the row at `path` a new name (possibly a whole path,
// which is how a move is typed). Nothing here decides whether a name is allowed —
// that is the server's rule, shown in `error`, not argued with.
const { state, depthOf, cancelCreate, updateCreateValue } = useWorkspaceTree()
const { submitCreate } = useEditorCreate()
const { submitRename } = useEditorRename()

const input = ref(null)
const pending = computed(() => state.editing)
const isRename = computed(() => pending.value?.mode === 'rename')
const glyph = computed(() => fileIcon(pending.value?.value ?? '', { dir: !!pending.value?.isDir }))
// The same indent as the rows of the listing it sits in, so the caret lands where
// the new row will appear: a row's `--tree-depth` is one deeper than its parent.
const depth = computed(() => depthOf(pending.value?.parent ?? '') + 1)

// Focus once per mount, not once per keystroke: the row is keyed by its parent,
// kind and mode, so working elsewhere re-mounts it and gets the caret again. A
// rename preselects the stem and leaves the extension out of the selection.
watch(
  () => [pending.value?.mode, pending.value?.path, pending.value?.parent, pending.value?.isDir],
  async () => {
    if (!pending.value) return
    await nextTick()
    const field = input.value
    if (!field) return
    field.focus()
    if (!isRename.value) return
    const value = pending.value.value ?? ''
    const dot = value.lastIndexOf('.')
    field.setSelectionRange(0, dot > 0 ? dot : value.length)
  },
  { immediate: true },
)

function onInput(event) {
  updateCreateValue(event.target.value)
}

// When the input goes away the caret must not fall to `<body>`: the row the tree
// considers focused carries the roving tabindex, so it is what takes the caret
// back. Rows are matched by `dataset.path` rather than a selector because a path
// may hold any character.
async function restoreRowFocus() {
  await nextTick()
  for (const candidate of document.querySelectorAll('.tree-row')) {
    if (candidate.dataset.path === state.focused) {
      candidate.focus()
      return
    }
  }
}

async function onSubmit() {
  // A second Enter while a request is in flight joins the running one, so the row
  // is never asked twice. The input stays open on a refusal; the flow clears the
  // state itself when the change lands.
  const result = isRename.value ? await submitRename() : await submitCreate()
  if (result.ok) await restoreRowFocus()
  else input.value?.focus()
}

async function onCancel() {
  cancelCreate()
  await restoreRowFocus()
}
</script>

<template>
  <!-- Not a `role="treeitem"`: this row is not a file, and inventing one would
       put a nameless entry in the tree's count and reading order. -->
  <div
    class="tree-row tree-row--creating"
    :class="`depth-${depth - 1}`"
    :style="{ '--tree-depth': depth - 1 }"
  >
    <span class="tree-chevron" aria-hidden="true"></span>
    <span class="tree-icon" aria-hidden="true">{{ glyph }}</span>
    <input
      ref="input"
      class="tree-name-input"
      type="text"
      :value="pending.value"
      :aria-label="
        isRename
          ? 'New name — type a folder path to move it'
          : pending.isDir
            ? 'Name of the new folder'
            : 'Name of the new file'
      "
      :placeholder="
        isRename
          ? 'New name, or a path to move it'
          : pending.isDir
            ? 'New folder name'
            : 'New file name'
      "
      spellcheck="false"
      autocomplete="off"
      @input="onInput"
      @keydown.enter.prevent="onSubmit"
      @keydown.esc.prevent="onCancel"
    />
    <button
      class="tree-name-input-action"
      type="button"
      :aria-label="isRename ? 'Rename it' : 'Create it'"
      :title="isRename ? 'Rename (Enter)' : 'Create (Enter)'"
      @click="onSubmit"
    >
      ✓
    </button>
    <button
      class="tree-name-input-action"
      type="button"
      :aria-label="
        isRename
          ? `Cancel — do not rename ${pending.path}`
          : `Cancel — do not create anything in ${pending.parent || 'the workspace root'}`
      "
      title="Cancel (Escape)"
      @click="onCancel"
    >
      ×
    </button>
  </div>
  <!-- The refusal of the typed value, under the caret rather than elsewhere: the
       fix is to edit what is already there. `.tree-name-input-error` rides along
       as the create's own hook, so a selector for one mode keeps working. -->
  <p
    v-if="pending.error"
    class="tree-row-error tree-name-input-error"
    role="alert"
  >
    {{ pending.error }}
  </p>
</template>
