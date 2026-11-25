<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useSessionStats } from '../composables/useSessionStats'

// The app bar's elapsed clock: the whole app has one session at a time (a
// WorkBench reply or a batch turn), so this single readout follows whichever
// one is live — and keeps ticking while the user watches the Editor tab, which
// is what makes a background session readable at all. Between two replies it
// holds the total the conversation has spent, because asking again continues
// the same session; only the composer's Restart puts it back to 00:00:00.
//
// **The clock's total excludes the seconds a turn spent waiting on a refused
// endpoint** — a 40-minute provider outage is not a 40-minute session. The
// turn's own span is still the composable's answer, but this component does not
// render it: the caption under the clock made the actions row taller than the
// bar.
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
  if (stats.running.value) return 'Elapsed time of the WorkBench session'
  return 'Total time this conversation has spent (no reply running)'
})
</script>

<template>
  <!-- One row: the digits alone, on the single line the actions row is sized
       for. -->
  <p
    class="session-clock"
    :class="{ 'session-clock--running': stats.running.value }"
    role="timer"
    :aria-label="label"
    :title="
      stats.running.value
        ? `${label} — the app has one session at a time. It excludes the time a turn spent waiting on the model endpoint.`
        : `${label} — restart the conversation to start it over. It excludes the time a turn spent waiting on the model endpoint.`
    "
  >
    {{ display }}
  </p>
</template>
