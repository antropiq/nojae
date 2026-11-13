<script setup>
import { computed } from 'vue'
import WorkBenchMcpPanel from './WorkBenchMcpPanel.vue'
import WorkBenchLspPanel from './WorkBenchLspPanel.vue'
import { useChat } from '../composables/useChat'
import { hubsSummary } from '../lib/chat-hubs'

// Bottom of the Chat left column: the conversation-scoped MCP panel beside
// the LSP panel (the pair the input row used to carry), plus the control that
// folds them away so the reasoning timeline above gets the whole column.
//
// The fold belongs to the view, not to this component: folding changes how
// much height the column's splitter gives the timeline, so only the layout
// owner can answer to it. Hence the `collapsed` prop / `update:collapsed`
// pair rather than a local flag.
const props = defineProps({ collapsed: Boolean })
const emit = defineEmits(['update:collapsed'])

const { state, chatBusy } = useChat()

// The dock always has its body: the two panels are the Chat left column's
// fixed width, so an unconfigured workspace still gets the same column and the
// same dock height, and each panel says what is missing instead of leaving a
// half-empty strip. The fold is therefore always a real control.
//
// The fold is inert while a reply streams. Folding changes the height of the
// box the reasoning timeline paints into, and that box is measured once per
// inference and then frozen (WorkBenchToolPanel's pinned window) — so a fold
// mid-reply would leave the stream flowing in the window computed before it.
// It is the same rule the Live View's own switch answers to (`chatBusy`, not
// `phase`, so a batch between two turns locks it too), and the control stays
// visible rather than disappearing: a button that vanishes and returns reads
// as a bug, and the reason is worth a tooltip.
const expanded = computed(() => !props.collapsed)

// Folded, the strip still answers the one question the panels answered: which
// hubs are switched on for this conversation. Counts rather than names — the
// folded strip is a single line.
const summary = computed(() => hubsSummary(state))
</script>

<template>
  <section
    class="chat-tools-dock"
    :class="{ 'chat-tools-dock--collapsed': !expanded }"
    aria-label="Conversation tools"
  >
    <div class="chat-tools-dock-head">
      <p class="caption chat-tools-dock-title">Tools</p>
      <span
        v-if="!expanded && summary"
        class="chat-tools-dock-summary"
        role="status"
        title="Tool hubs enabled for this conversation — expand to change them"
      >
        {{ summary }}
      </span>
      <button
        class="icon-btn chat-tools-dock-toggle"
        type="button"
        :disabled="chatBusy()"
        :aria-expanded="expanded"
        :aria-controls="expanded ? 'chat-tools-dock-body' : undefined"
        :aria-label="expanded ? 'Hide the tool panels' : 'Show the tool panels'"
        :title="
          chatBusy()
            ? 'Locked while the model is replying — the reasoning panel sizes itself once per reply'
            : expanded
              ? 'Hide the tool panels — the reasoning timeline takes the column'
              : 'Show the MCP and LSP panels'
        "
        @click="emit('update:collapsed', expanded)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-if="expanded" d="m6 9 6 6 6-6" />
          <path v-else d="m18 15-6-6-6 6" />
        </svg>
      </button>
    </div>
    <div v-if="expanded" id="chat-tools-dock-body" class="chat-tools-dock-body">
      <WorkBenchMcpPanel />
      <WorkBenchLspPanel />
    </div>
  </section>
</template>
