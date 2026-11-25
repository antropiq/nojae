<script setup>
import { useSessionStats } from '../composables/useSessionStats'

// The two session counters — generation speed and context-window occupancy — read
// whichever session is live and hold their figures once it ends, because the
// conversation they measured is still on screen; only Restart clears them.
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
