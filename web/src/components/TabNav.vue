<script setup>
import { computed } from 'vue'
import { useAppShell } from '../composables/useAppShell'
import { useBatch } from '../composables/useBatch'

const { state, setTab } = useAppShell()
const { state: batch } = useBatch()

// A running batch pins the app to WorkBench: every other tab goes inert, and setTab
// refuses the switch too, so a keyboard path cannot escape mid-lot.
const disabled = computed(() => batch.active)
const editorDisabled = computed(() => batch.active)
const editorTitle = computed(() =>
  batch.active ? 'Unavailable while a batch runs' : 'Editor',
)
</script>

<template>
  <nav class="tab-nav" role="tablist" aria-label="Screens">
    <button
      class="tab-btn"
      role="tab"
      type="button"
      :class="{ active: state.activeTab === 'chat' }"
      :aria-selected="state.activeTab === 'chat'"
      :disabled="disabled"
      :title="batch.active ? 'Unavailable while a batch runs' : 'WorkBench'"
      @click="setTab('chat')"
    >
      WorkBench
    </button>
    <button
      class="tab-btn"
      role="tab"
      type="button"
      :class="{ active: state.activeTab === 'editor' }"
      :aria-selected="state.activeTab === 'editor'"
      :disabled="editorDisabled"
      :title="editorTitle"
      @click="setTab('editor')"
    >
      Editor
    </button>
  </nav>
</template>
