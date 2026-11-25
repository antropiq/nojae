<script setup>
import { useChat } from '../composables/useChat'
import { useBatch } from '../composables/useBatch'
import {
  bulletColor,
  bulletNumber,
  isFilled,
  usePromptHelpers,
} from '../composables/usePromptHelpers'

const emit = defineEmits(['configure'])

const { state } = usePromptHelpers()
const { appendDraft } = useChat()
const { state: batch } = useBatch()

// Tooltip preview cap (the full text stays in the store).
const TOOLTIP_MAX_CHARS = 150

// Black or white number by background luminance (ITU-R BT.601 luma).
function textColor(color) {
  const r = parseInt(color.slice(1, 3), 16)
  const g = parseInt(color.slice(3, 5), 16)
  const b = parseInt(color.slice(5, 7), 16)
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    return '#ffffff'
  }
  return 0.299 * r + 0.587 * g + 0.114 * b > 140 ? '#000000' : '#ffffff'
}

function bulletStyle(data) {
  const background = bulletColor(data)
  return { background, color: textColor(background) }
}

function tooltip(data) {
  if (!isFilled(data)) return undefined
  return data.content.length > TOOLTIP_MAX_CHARS
    ? `${data.content.slice(0, TOOLTIP_MAX_CHARS)}…`
    : data.content
}

// A filled bullet appends its text to the draft; Ctrl/Cmd+click or an empty
// bullet opens the dialog.
function onClick(event, data) {
  if (batch.active) return
  if (isFilled(data) && !event.ctrlKey && !event.metaKey) {
    appendDraft(data.content)
    return
  }
  emit('configure', data.id)
}
</script>

<template>
  <!-- As many bullets as the store holds, numbered by position; the row wraps
       rather than overflowing, and renders nothing when every bullet is deleted. -->
  <div class="memory-bullets" role="group" aria-label="Memory bullets">
    <button
      v-for="(data, index) in state.slots"
      :key="data.id"
      type="button"
      class="memory-bullet"
      :style="bulletStyle(data)"
      :disabled="batch.active"
      :title="batch.active ? 'Unavailable while a batch runs' : tooltip(data)"
      :aria-label="
        isFilled(data)
          ? `Memory bullet ${bulletNumber(index)} (edit with Ctrl+click)`
          : `Memory bullet ${bulletNumber(index)} (empty — configure)`
      "
      @click="onClick($event, data)"
    >
      {{ bulletNumber(index) }}
    </button>
    <!-- Needed only with no bullets at all: otherwise the dialog, where Add lives,
         would be unreachable because a bullet click is the only way in. -->
    <button
      v-if="!state.slots.length"
      type="button"
      class="memory-bullet-add"
      :disabled="batch.active"
      aria-label="Add a memory bullet"
      :title="
        batch.active ? 'Unavailable while a batch runs' : 'Add a memory bullet'
      "
      @click="emit('configure', null)"
    >
      +
    </button>
  </div>
</template>
