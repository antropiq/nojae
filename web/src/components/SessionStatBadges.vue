<script setup>
import { useSessionStats } from '../composables/useSessionStats'

// The two session counters — generation speed and context-window occupancy —
// now living in the app bar, left of the tab strip. They read whichever session
// is live (the WorkBench reply or a batch turn) and go blank when nothing is
// generating, so an idle app bar never shows a stale figure as if it were
// current. useSessionStats holds the rules.
const stats = useSessionStats()
</script>

<template>
  <span class="session-stat-badges">
    <span
      class="badge badge--rate"
      :class="stats.rate.value ? 'violet' : 'gray'"
      role="status"
      :title="stats.rateTitle.value"
    >
      {{ stats.rateText.value }}
    </span>
    <span
      class="badge badge--context"
      :class="stats.contextClass.value"
      role="status"
      :title="stats.contextTitle.value"
    >
      {{ stats.contextText.value }}
    </span>
  </span>
</template>
