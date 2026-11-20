<script setup>
import { computed } from 'vue'
import { useChat } from '../composables/useChat'
import { useBatch } from '../composables/useBatch'
import { currentMode, modeBlocksHub } from '../composables/useAgentModes'
import {
  FAMILY_MCP,
  SET_ME_UP_LABEL,
  useConnectorWizard,
} from '../composables/useConnectorWizard'
import { mcpHasEntries } from '../lib/chat-hubs'

const { state, setChatMcp, restartMcp } = useChat()
const { state: batch } = useBatch()
const wizard = useConnectorWizard()

// Status dot next to each switch: green when the connector serves its
// tools, red on a startup/configuration error, gray otherwise (stopped,
// disabled or still starting).
const DOT_CLASS = {
  running: 'chat-mcp-dot--green',
  error: 'chat-mcp-dot--red',
}

// The panel is always on screen: it is half of the Chat left column's fixed
// width, and the reasoning timeline above it is measured against that width.
// What comes and goes is its switch list — with nothing activated in Settings
// the panel shows its own empty line instead of leaving a gap in the dock.
const hasEntries = computed(() => mcpHasEntries(state))
// Only Settings-launched connectors may ever appear here, so this is also the
// sentence that says where to declare them.
// The toggles freeze with the first accepted send anyway; the batch flag covers
// the between-tasks window, so a lot really does run under one identical tool
// set (useChat's own guard refuses the change too, so the rule lives in both
// places it can be reached from).
const locked = computed(
  () => state.mcp.locked || state.phase !== 'idle' || batch.active,
)

// D4's coarsest switch: the active agent mode can switch the whole hub off. The
// panel then renders **disabled with a reason** rather than disappearing — the
// toggles stay real (Settings owns them) and a hidden control that reappears on
// a mode change reads as a bug. `modeBlocksHub` is false when the mode list
// never loaded, which is exactly the pre-feature rendering.
const gatedByMode = computed(() => modeBlocksHub('mcp'))
const switchesDisabled = computed(() => locked.value || gatedByMode.value)

function rowTitle(connector) {
  if (gatedByMode.value) {
    return `MCP tools are not available in ${currentMode()?.label} mode — switch mode, or change them in Settings`
  }
  if (batch.active) {
    return 'Unavailable while a batch runs — stop it to change the tools'
  }
  if (locked.value) {
    return 'Toggles apply to the next conversation — restart to change them'
  }
  if (connector.status !== 'running') {
    return `Connector is ${connector.status} — its tools are unavailable`
  }
  return `Use ${connector.label} tools in this conversation`
}

// Restarting reconnects every connector from a fresh .nojae/mcp-settings.json
// scan, so
// a hub thread blocked in a chat tool call would be killed mid-call: the
// button is only usable on an idle conversation, and stays busy until the
// awaited server-side restart comes back.
const canRestart = computed(
  () => state.phase === 'idle' && !state.mcp.restarting && !batch.active,
)
const restartTitle = computed(() => {
  if (batch.active) return 'Unavailable while a batch runs'
  if (state.mcp.restarting) return 'Restarting MCP connectors…'
  return 'Restart the MCP hub: reconnect every connector from .nojae/mcp-settings.json'
})

// The wizard's entry point. Its enablement is the composable's one gate verdict —
// `{disabled, label}`, where the label is `Set me up!` when live and the app's
// existing no-model sentence when not — so this panel adds no rule of its own.
//
// Deliberately **not** `locked` / `gatedByMode` / `canRestart`: those are the
// restart's rules. Preparing an entry touches no hub and no conversation, so it
// stays live while a reply streams, while a batch runs, while the toggles are
// locked and while the active mode switches this hub off (§10).
const setMeUp = computed(() => wizard.setMeUpSlot(FAMILY_MCP))

// Opening the wizard on **this** panel's family and nothing else: no toggle, no
// restart, no send. The dialog is one component for both families; which of them
// it shows is the button that opened it, never a question inside it.
function openWizard() {
  wizard.open(FAMILY_MCP)
}

// The empty panel's one sentence: the line it already carried — which declaration
// file, and that the entry is switched on in Settings — plus the click this
// feature adds. Composed here rather than in the template, so the template renders
// a value and decides nothing, and built around the composable's own
// `SET_ME_UP_LABEL`, so the sentence and the button beside it cannot drift.
const emptyLine = computed(
  () =>
    'No MCP connector is available for this conversation — declare one in ' +
    '.nojae/mcp-settings.json and switch it on in Settings, or press ' +
    `${SET_ME_UP_LABEL} and it prepares that entry for you to paste in.`,
)
</script>

<template>
  <aside class="chat-mcp-panel" aria-label="MCP connectors for this conversation">
    <div class="chat-hub-head">
      <p class="caption chat-mcp-title">MCP tools</p>
      <!-- The wizard's entry point, left of the restart and in the same 1.5rem
           box: one line in the head, so the panel's width, height and head
           layout are untouched. It opens this panel's family and nothing else. -->
      <button
        class="icon-btn chat-hub-setup"
        type="button"
        :disabled="setMeUp.disabled"
        :aria-label="setMeUp.label"
        :title="setMeUp.label"
        @click="openWizard"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M10 3.5 11.4 7.6 15.5 9 11.4 10.4 10 14.5 8.6 10.4 4.5 9 8.6 7.6z" />
          <path d="M17.5 13 18.3 15.2 20.5 16 18.3 16.8 17.5 19 16.7 16.8 14.5 16 16.7 15.2z" />
        </svg>
      </button>
      <button
        class="icon-btn chat-hub-restart"
        :class="{ 'chat-hub-restart--busy': state.mcp.restarting }"
        type="button"
        :disabled="!canRestart"
        :aria-label="state.mcp.restarting ? 'Restarting MCP hub' : 'Restart MCP hub'"
        :title="restartTitle"
        @click="restartMcp"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
        </svg>
      </button>
    </div>
    <!-- The route's refusal, verbatim: the ceiling's sentence is the same one
         the app bar shows, and a panel that asked must not look merely empty. -->
    <p v-if="state.mcp.error" class="caption alert-error chat-hub-error" role="alert">
      {{ state.mcp.error }}
    </p>
    <!-- The empty line inviting the click: the composable's sentence, which still
         names the declaration file and now says what the button above does. -->
    <p v-if="!hasEntries" class="caption chat-hub-empty">{{ emptyLine }}</p>
    <label
      v-for="connector in state.mcp.connectors"
      :key="connector.id"
      class="chat-mcp-row"
      :class="{ 'chat-mcp-row--dim': gatedByMode || connector.status !== 'running' }"
      :title="rowTitle(connector)"
    >
      <input
        type="checkbox"
        role="switch"
        :checked="state.mcp.enabled[connector.id]"
        :disabled="switchesDisabled"
        :aria-label="`MCP ${connector.label} for this conversation`"
        @change="setChatMcp(connector.id, $event.target.checked)"
      />
      <span
        class="chat-mcp-dot"
        :class="DOT_CLASS[connector.status] ?? 'chat-mcp-dot--gray'"
        :title="`Status: ${connector.status}`"
      ></span>
      <span class="chat-mcp-label">{{ connector.label }}</span>
    </label>
  </aside>
</template>
