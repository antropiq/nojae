<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useChat } from '../composables/useChat'
import {
  bulletNumber,
  newBulletColor,
  usePromptHelpers,
} from '../composables/usePromptHelpers'

const props = defineProps({
  open: { type: Boolean, default: false },
  // The row this dialog edits, as the store's id — or ``null`` for a bullet that
  // does not exist yet, which is what "Add bullet" opens: the id is the only
  // handle that survives a delete.
  //
  // ``helperId`` rather than a bare ``id``, because this card's template already
  // uses ``id`` for the heading's own ``aria-labelledby``.
  helperId: { type: Number, default: null },
})
const emit = defineEmits(['close', 'add'])

const { state, savePromptHelper, addPromptHelper, deletePromptHelper } =
  usePromptHelpers()
const { appendDraft } = useChat()

const dialogEl = ref(null)
const content = ref('')
const color = ref(newBulletColor())
const error = ref('')

const busy = computed(() => state.saving)
const isNew = computed(() => props.helperId === null)
// The heading names the bullet by **position**, because that is the number the
// row draws; a new bullet has none yet, so it is named by what it is.
const title = computed(() => {
  if (isNew.value) return 'New memory bullet'
  const index = state.slots.findIndex((slot) => slot.id === props.helperId)
  return `Memory bullet ${bulletNumber(index < 0 ? state.slots.length : index)}`
})

// Prefill from the row and show, following the SettingsDialog pattern: watch +
// showModal, backdrop click, native-close sync.
//
// ``shownFor`` is why the row is tracked by id rather than by "is the dialog
// already open": the parent can move this form from one row to another **while
// it stays open** — that is what "Add bullet" does — and each move has to
// prefill; a slots change alone must not, or a reload would wipe the user's
// typing.
const shownFor = ref(null)

watch(
  () => [props.open, props.helperId, state.slots],
  async () => {
    await nextTick()
    const dialog = dialogEl.value
    if (!dialog) return
    if (!props.open) {
      if (dialog.open) dialog.close()
      shownFor.value = null
      return
    }
    if (dialog.open && shownFor.value === props.helperId) return
    shownFor.value = props.helperId
    const slot = state.slots.find((entry) => entry.id === props.helperId)
    content.value = slot?.content ?? ''
    color.value = slot?.color ?? newBulletColor()
    error.value = ''
    if (!dialog.open) dialog.showModal()
  },
)

function onBackdropClick(event) {
  if (event.target === dialogEl.value) emit('close')
}

// Esc (or a programmatic close): sync the parent, so Cancel never inserts
// anything.
function onNativeClose() {
  if (props.open) emit('close')
}

async function save() {
  if (state.saving) return
  error.value = ''
  const saved = content.value
  const slots = isNew.value
    ? await addPromptHelper(color.value, saved)
    : await savePromptHelper(props.helperId, color.value, saved)
  if (slots === null) {
    error.value = state.error || 'Could not save the memory bullet.'
    return
  }
  dialogEl.value?.close()
  // Saving empty content only clears the bullet — nothing goes into the draft.
  if (saved !== '') appendDraft(saved)
}

// Hands the parent the open-a-new-form request. The current edits are discarded
// on purpose: "Add" is a new bullet, not a second save, and a silent overwrite of
// the row being edited would be the worse surprise.
function addBullet() {
  if (state.saving) return
  emit('add')
}

async function removeBullet() {
  if (isNew.value || state.saving) return
  if (!window.confirm('Delete this memory bullet?')) return
  error.value = ''
  const slots = await deletePromptHelper(props.helperId)
  if (slots === null) {
    error.value = state.error || 'Could not delete the memory bullet.'
    return
  }
  dialogEl.value?.close()
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="memory-dialog"
    aria-labelledby="memory-dlg-title"
    @click="onBackdropClick"
    @close="onNativeClose"
  >
    <article>
      <header>
        <h2 id="memory-dlg-title">{{ title }}</h2>
      </header>
      <p class="caption">
        This message is appended to the chat draft when the bullet is clicked.
        Saving empty content clears the bullet.
      </p>

      <p v-if="error" class="alert-error" role="alert">{{ error }}</p>

      <form @submit.prevent="save">
        <label>
          Message
          <textarea
            v-model="content"
            rows="12"
            placeholder="Template message (markdown)…"
          ></textarea>
        </label>
        <label class="memory-color">
          Color
          <input v-model="color" type="color" />
        </label>
        <footer class="settings-actions">
          <!-- Delete sits left of Cancel and asks first: the store copies the
               whole database before the row goes, but the bullet itself is gone
               from the row, so the confirmation is the one guard. It never
               exists for a bullet that has not been created. -->
          <button
            v-if="!isNew"
            class="secondary contrast memory-bullet-delete"
            type="button"
            :disabled="busy"
            @click="removeBullet"
          >
            Delete this bullet
          </button>
          <button
            class="secondary contrast memory-bullet-add"
            type="button"
            :disabled="busy"
            @click="addBullet"
          >
            Add bullet
          </button>
          <button
            class="secondary contrast"
            type="button"
            :disabled="busy"
            @click="emit('close')"
          >
            Cancel
          </button>
          <button type="submit" :disabled="busy">
            {{ busy ? 'Saving…' : isNew ? 'Add' : 'Save' }}
          </button>
        </footer>
      </form>
    </article>
  </dialog>
</template>
