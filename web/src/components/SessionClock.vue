<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSessionStats } from '../composables/useSessionStats'

// The app bar's elapsed clock: the whole app has one session at a time (a
// WorkBench reply or a batch turn), so this single readout follows whichever
// one is live — and keeps ticking while the user watches the Editor tab, which
// is what makes a background session readable at all. Idle, it rests on
// 00:00:00. See useSessionStats for the source resolution.
const stats = useSessionStats()

// Ticked on its own interval rather than on SSE events, so the digits keep
// advancing during a long tool call or a stalled first token as well.
const now = ref(Date.now())
let timer = null

onMounted(() => {
  timer = setInterval(() => {
    now.value = Date.now()
  }, 250)
})

onBeforeUnmount(() => clearInterval(timer))

const display = computed(() => stats.formatElapsed(stats.elapsedMs(now.value)))

const label = computed(() => {
  if (stats.source.value === 'chat') return 'Elapsed time of the WorkBench session'
  return 'No session running'
})
</script>

<template>
  <p
    class="session-clock"
    :class="{ 'session-clock--running': stats.running.value }"
    role="timer"
    :aria-label="label"
    :title="
      stats.running.value
        ? `${label} — the app has one session at a time.`
        : 'Idle — the clock counts the running WorkBench session.'
    "
  >
    {{ display }}
  </p>
</template>
