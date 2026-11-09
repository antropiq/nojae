<script setup>
import { defineAsyncComponent, onMounted, ref, watch } from 'vue'
import AppBar from './components/AppBar.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import BatchModeDialog from './components/BatchModeDialog.vue'
import WorkBenchView from './components/WorkBenchView.vue'
import { useAppShell } from './composables/useAppShell'
import { useTabTitle } from './composables/useTabTitle'
import { useSessionSound } from './composables/useSessionSound'
import { loadChatHubs } from './composables/useChat'

// Lazy on purpose: Monaco and xterm are heavy, and the WorkBench tab is the
// app's default screen — it must never download them. The Editor tab's first
// open pays the chunk instead.
const EditorView = defineAsyncComponent(() =>
  import('./components/EditorView.vue'),
)

// Mirrors the inference state into the browser tab title (⚡ / ✨), so a
// backgrounded tab still answers "is it generating?". Started here because App
// is where every composable's state gets mounted.
useTabTitle()
// ...and rings `session_ended.mp3` on the same edge (busy -> idle), which is
// how the end of a conversation reaches a user looking at another window.
useSessionSound()

const { state, loadConfig, loadPathLocation } = useAppShell()

// The lazy chunk is only fetched once the tab has been opened: an async
// component behind a plain v-show resolves its import at boot, which would make
// the default screen pay for it. Once mounted the view stays mounted (v-show),
// so its open buffers and its terminal session survive a tab switch.
const editorMounted = ref(false)
watch(
  () => state.activeTab,
  (tab) => {
    if (tab === 'editor') editorMounted.value = true
  },
  { immediate: true },
)

onMounted(() => {
  loadConfig()
  // The app bar shows the active working location, so fetch it at boot too —
  // not only when the settings dialog opens.
  loadPathLocation()
  // The WorkBench tab is mounted from the start (v-show), so its composer's
  // mode dropdown and the tools dock must not wait for a tab click that may
  // never come. The tab's own watch keeps them fresh on re-entry; this is the
  // first fill.
  loadChatHubs()
})
</script>

<template>
  <AppBar />

  <SettingsDialog />

  <!-- Mounted here (not inside WorkBenchView) so the lot form survives a tab
       switch, exactly like the settings dialog. -->
  <BatchModeDialog />

  <WorkBenchView v-show="state.activeTab === 'chat'" />

  <!-- v-show, like the other tabs: it is what keeps the Editor tab's open
       buffers, tree state and its live terminal session alive across a peek at
       the WorkBench screen. The v-if only defers the first mount until the
       lazy chunk is worth fetching. -->
  <EditorView v-if="editorMounted" v-show="state.activeTab === 'editor'" />
</template>
