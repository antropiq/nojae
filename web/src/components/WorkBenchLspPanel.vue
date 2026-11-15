<script setup>
import { computed } from 'vue'
import { useChat } from '../composables/useChat'
import { useBatch } from '../composables/useBatch'
import { currentMode, modeBlocksHub } from '../composables/useAgentModes'
import { lspHasEntries } from '../lib/chat-hubs'

const { state, setChatLsp, restartLsp } = useChat()
const { state: batch } = useBatch()

// Status dot next to each switch: green when the language server serves its
// tools, red on a startup/configuration error, gray otherwise (stopped,
// disabled or still starting — a lazy server shows gray until its first
// tool call spawns it). Reuses the chat-mcp classes: same visual row.
const DOT_CLASS = {
  running: 'chat-mcp-dot--green',
  error: 'chat-mcp-dot--red',
}

// Always on screen, like the MCP panel beside it: the two are the Chat left
// column's fixed width, and a workspace that has not written its
// `.nojae/lsp-settings.json` yet must not cost the reasoning timeline half of
// it. An empty panel says where the declaration goes, and its restart button
// is what picks up a file written after the boot scan.
const hasEntries = computed(() => lspHasEntries(state))
// Same pair as the MCP panel: the batch flag covers the between-tasks window.
const locked = computed(
  () => state.lsp.locked || state.phase !== 'idle' || batch.active,
)

// The same gate as the MCP panel, judged by the same function: an agent whose
// `lsp_enable` is false gets no language-server schemas at all, so the switches
// are shown inert with the reason rather than hidden.
const gatedByMode = computed(() => modeBlocksHub('lsp'))
const switchesDisabled = computed(() => locked.value || gatedByMode.value)

function rowTitle(server) {
  if (gatedByMode.value) {
    return `Language-server tools are not available in ${currentMode()?.label} mode — switch mode, or change them in Settings`
  }
  if (batch.active) {
    return 'Unavailable while a batch runs — stop it to change the tools'
  }
  if (locked.value) {
    return 'Toggles apply to the next conversation — restart to change them'
  }
  if (server.status !== 'running') {
    return `Language server is ${server.status} — its tools start on the first call`
  }
  return `Use ${server.label} tools in this conversation`
}

// Restarting respawns every language server from a fresh
// .nojae/lsp-settings.json scan, so a hub thread blocked in a chat tool
// call would be killed mid-call: the button is only usable on an idle
// conversation, and stays busy until the awaited server-side restart comes
// back.
const canRestart = computed(
  () => state.phase === 'idle' && !state.lsp.restarting && !batch.active,
)
const restartTitle = computed(() => {
  if (batch.active) return 'Unavailable while a batch runs'
  if (state.lsp.restarting) return 'Restarting language servers…'
  return 'Restart the LSP hub: respawn every server from .nojae/lsp-settings.json'
})
</script>

<template>
  <aside class="chat-lsp-panel" aria-label="LSP language servers for this conversation">
    <div class="chat-hub-head">
      <p class="caption chat-mcp-title">LSP tools</p>
      <button
        class="icon-btn chat-hub-restart"
        :class="{ 'chat-hub-restart--busy': state.lsp.restarting }"
        type="button"
        :disabled="!canRestart"
        :aria-label="state.lsp.restarting ? 'Restarting LSP hub' : 'Restart LSP hub'"
        :title="restartTitle"
        @click="restartLsp"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
        </svg>
      </button>
    </div>
    <!-- Same rule as the MCP panel: the route's sentence, verbatim. -->
    <p v-if="state.lsp.error" class="caption alert-error chat-hub-error" role="alert">
      {{ state.lsp.error }}
    </p>
    <p v-if="!hasEntries" class="caption chat-hub-empty">
      No language server is switched on for this conversation — copy the seeded
      <code>.nojae/lsp-settings.template.json</code> to
      <code>.nojae/lsp-settings.json</code>, then switch the servers on in
      Settings.
    </p>
    <label
      v-for="server in state.lsp.servers"
      :key="server.id"
      class="chat-mcp-row"
      :class="{ 'chat-mcp-row--dim': gatedByMode || server.status !== 'running' }"
      :title="rowTitle(server)"
    >
      <input
        type="checkbox"
        role="switch"
        :checked="state.lsp.enabled[server.id]"
        :disabled="switchesDisabled"
        :aria-label="`LSP ${server.label} for this conversation`"
        @change="setChatLsp(server.id, $event.target.checked)"
      />
      <span
        class="chat-mcp-dot"
        :class="DOT_CLASS[server.status] ?? 'chat-mcp-dot--gray'"
        :title="`Status: ${server.status}`"
      ></span>
      <span class="chat-mcp-label">{{ server.label }}</span>
    </label>
  </aside>
</template>
