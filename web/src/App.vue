<script setup>
import { defineAsyncComponent, onMounted, ref, watch } from 'vue'
import AppBar from './components/AppBar.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import BatchModeDialog from './components/BatchModeDialog.vue'
import ConnectorWizardDialog from './components/ConnectorWizardDialog.vue'
import WorkBenchView from './components/WorkBenchView.vue'
import { useAppShell } from './composables/useAppShell'
import { loadWorkspace } from './composables/useWorkspaceSession'
import { useTabTitle } from './composables/useTabTitle'
import { useSessionSound } from './composables/useSessionSound'
import { loadChatHubs } from './composables/useChat'
import { usePromptHelpers } from './composables/usePromptHelpers'

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

const { state, loadConfig } = useAppShell()

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

onMounted(async () => {
  // The two **installation-scoped** reads go first and need no folder: the
  // catalogue and the bullets are the install's, so they answer the same way in
  // every workspace (spec §4.2) and a tab whose folder has gone away still gets
  // them.
  loadConfig()
  usePromptHelpers().loadPromptHelpers()
  // The **tab's own** folder, awaited before anything that asks about a
  // workspace: the stored one if this tab has one, the installation folder
  // otherwise (spec D4). The app bar's field shows it and every workspace-scoped
  // request carries it; the address bar never does. A reload returns the tab to
  // its folder, a new tab lands on the installation, and a folder that has gone
  // away is reported rather than repaired.
  //
  // Awaited rather than fired alongside the rest, because the hub reads below
  // are workspace-scoped: issued first they would name no folder and answer
  // about the interim default — the wrong connectors and language servers for a
  // tab that remembered another folder.
  await loadWorkspace()
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

  <!-- The connector wizard, mounted once for both tool panels: it survives a tab
       switch and neither panel owns it (its state is the composable's). -->
  <ConnectorWizardDialog />

  <WorkBenchView v-show="state.activeTab === 'chat'" />

  <!-- v-show, like the other tabs: it is what keeps the Editor tab's open
       buffers, tree state and its live terminal session alive across a peek at
       the WorkBench screen. The v-if only defers the first mount until the
       lazy chunk is worth fetching. -->
  <EditorView v-if="editorMounted" v-show="state.activeTab === 'editor'" />
</template>
