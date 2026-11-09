<script setup>
import { computed, onBeforeUnmount, ref } from 'vue'
import { copyText } from '../lib/clipboard'

// One message's copy affordance: the chip on an assistant card that puts *that
// reply* on the clipboard (the composer's own button above the textarea is the
// one that copies the whole conversation).
const props = defineProps({
  // The text to copy — the reply as the model wrote it, sentinels removed (see
  // useChat's messageClipboardText).
  text: { type: String, default: '' },
})

const canCopy = computed(() => props.text.trim().length > 0)

const copyState = ref('idle') // idle | copied | failed
let copyTimer = null

function clearCopyTimer() {
  clearTimeout(copyTimer)
  copyTimer = null
}

async function copy() {
  if (!canCopy.value) return
  const ok = await copyText(props.text)
  copyState.value = ok ? 'copied' : 'failed'
  clearCopyTimer()
  copyTimer = setTimeout(() => {
    copyState.value = 'idle'
  }, 1500)
}

onBeforeUnmount(clearCopyTimer)
</script>

<template>
  <button
    class="chat-turn-chip chat-msg-copy"
    type="button"
    :disabled="!canCopy"
    :aria-label="
      copyState === 'copied' ? 'Reply copied' : 'Copy this reply to the clipboard'
    "
    :title="
      copyState === 'copied'
        ? 'Copied'
        : copyState === 'failed'
          ? 'Copy failed'
          : 'Copy this reply'
    "
    @click="copy"
  >
    <template v-if="copyState === 'copied'">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </template>
    <template v-else>
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
        stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="9" y="9" width="13" height="13" rx="2" />
        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
      </svg>
    </template>
  </button>
</template>
