<script setup>
import { computed } from 'vue'
import { useAppShell } from '../composables/useAppShell'
import { useEditorNotices } from '../composables/useEditorNotices'

// The Editor's write-feedback stack: up to three dismissible lines at the
// bottom-centre, answering "what happened to that write?".
//
// Teleported to `<body>` because the panes it reports on are scroll containers
// with their own stacking, so a notice inside one is clipped or buried.
//
// Every rule — dedupe, the cap, which tones expire — lives in useEditorNotices;
// this component only renders them. `aria-live="polite"` here makes a refusal
// heard when focus is in the tree; it is deliberately a *second* element from
// the pane's `role="alert"` line, since one element cannot serve both a refused
// open and a refused write.
const { state, dismiss } = useEditorNotices()

// Teleported content sits outside App.vue's `v-show` on the Editor view, so the
// stack gates itself: Editor feedback has no business floating over the
// WorkBench. The notices survive the switch because the composable owns them.
const onEditorTab = computed(() => useAppShell().state.activeTab === 'editor')
const visible = computed(() => onEditorTab.value && state.notices.length > 0)
</script>

<template>
  <Teleport to="body">
    <div
      v-if="visible"
      class="editor-notice-stack"
      aria-live="polite"
      aria-label="Editor write feedback"
    >
      <p
        v-for="item in state.notices"
        :key="item.id"
        class="editor-notice"
        :class="`editor-notice--${item.tone}`"
      >
        <span class="editor-notice-text">{{ item.text }}</span>
        <button
          class="editor-notice-dismiss"
          type="button"
          aria-label="Dismiss this message"
          title="Dismiss"
          @click="dismiss(item.id)"
        >
          ×
        </button>
      </p>
    </div>
  </Teleport>
</template>
