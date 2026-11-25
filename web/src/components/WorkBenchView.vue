<script setup>
import { computed, ref, watch } from 'vue'
import WorkBenchInput from './WorkBenchInput.vue'
import WorkBenchToolPanel from './WorkBenchToolPanel.vue'
import ImageLightbox from './ImageLightbox.vue'
import MarkdownStream from './MarkdownStream.vue'
import MessageCopyChip from './MessageCopyChip.vue'
import StagedMessageStrip from './StagedMessageStrip.vue'
import {
  humanFileSize,
  lastUserGroupStart,
  messageClipboardText,
  useChat,
} from '../composables/useChat.js'
import { usePromptHelpers } from '../composables/usePromptHelpers.js'
import { useAutoScroll } from '../composables/useAutoScroll.js'
import { useAppShell } from '../composables/useAppShell.js'
import { FOCUS_REASONING, useChatLayout } from '../composables/useChatLayout.js'
import { useBatch } from '../composables/useBatch.js'
import WorkBenchToolsDock from './WorkBenchToolsDock.vue'
import WorkBenchFocusGutter from './WorkBenchFocusGutter.vue'

const { state, editLast, removeImage, loadChatHubs, chatBusy } = useChat()
const { state: batch } = useBatch()
const { state: appShellState, loadConfig } = useAppShell()
const { loadPromptHelpers } = usePromptHelpers()

// Refresh what the chat tab reads when it is opened: the settings (they gate the
// attach button), the hub snapshot and the prompt helper bullets may all have
// been edited meanwhile. A locked conversation keeps its frozen hub list.
watch(
  () => appShellState.activeTab,
  (tab) => {
    if (tab === 'chat') {
      loadConfig()
      // The hub allowlists *and* the agent-mode list: the dropdown, the panels'
      // gray-out and the payload's agentMode all come from that one fetch.
      loadChatHubs()
      loadPromptHelpers()
    }
  },
)

// Where the edit affordance draws itself: the first message of the last
// unanswered group, so the gesture is discoverable where the group begins. The
// rule is `useChat`'s; the view derives no index of its own.
const lastGroupStart = computed(() => lastUserGroupStart(state.messages))

// The card's "Thinking…" caption has to stop while the endpoint is refusing: its
// condition — a streaming reply with no text yet — also holds during a wait on
// the first round, where `waiting` means "sent, no first token yet" but a wait
// means "the endpoint refused". The caption is suppressed rather than reworded,
// because the composer strip already carries the one line naming the wait. It
// comes back for the replayed round, whose first arrival clears the wait.
const waitInProgress = computed(() => !!state.endpointWait)

const input = ref(null)
const panel = ref(null)

// Image opened in the full-size lightbox popup (null = closed). Pure view state,
// deliberately outside the useChat singleton.
const preview = ref(null)
// Everything that changes the pane's height, so the auto-scroll re-anchors when
// it moves: the messages, the draft, one chip row per pending image, and the
// strip — a stage, or a row dropped or pulled back, scrolls like typing does.
const contentVersion = computed(() =>
  state.messages
    .map((m) => `${m.role}:${m.raw.length}:${m.images?.length ?? 0}`)
    .concat(
      `draft:${state.draft.raw.length}`,
      // Count first, so attaching the same file name twice still moves it.
      `images:${state.pendingImages.length}:${state.pendingImages
        .map((image) => image.name)
        .join('|')}`,
      `staged:${state.staged.length}:${state.staged
        .map((row) => `${row.id}:${row.raw.length}:${(row.images ?? []).length}`)
        .join('|')}`,
    )
    .join(','),
)
const { onScroll } = useAutoScroll(panel, contentVersion)
const leftCol = ref(null)
const rightCol = ref(null)
const dock = ref(null)

// Two splitters, one per column: the right one sizes the composer row, the left
// one the tools dock under the reasoning timeline.
//
// `focus` / `leftHidden` / the two toggles drive the gutter: the state is the
// composable's, the template only renders it. `chatBusy` reaches the fold
// through the same seam, so the rule that refuses a fold mid-reply stays
// useChat's own rather than a second copy of it.
const {
  column: dockSplit,
  composer: composerSplit,
  dockCollapsed,
  focus,
  leftHidden,
  toggleFocus,
  toggleLeftHidden,
} = useChatLayout(leftCol, rightCol, input, dock, chatBusy)
</script>

<template>
  <!-- The two focalisations reach the screen as state classes on the shell,
       never on the columns: the shell is where the chat geometry is decided
       (it carries the breakpoint-overridden --bi-chat-panel-width), and the two
       rules those names drive in theme.css are the whole geometry. The template
       renders useChatLayout's state and computes no transition. -->
  <div
    class="chat-shell"
    :class="{
      'chat-shell--reasoning': focus === FOCUS_REASONING,
      'chat-shell--conversation': leftHidden,
    }"
  >
    <div
      ref="leftCol"
      class="chat-col chat-col--left"
    >
      <WorkBenchToolPanel />
      <!-- The bar belongs to the dock's body: folding takes both out of the flow
           (the dock then sizes itself by its head strip). The column's width is
           not the dock's to decide — it is the two panels' width whatever the
           hub declaration files hold. -->
      <div
        v-if="!dockCollapsed"
        class="pane-resizer chat-resizer chat-col-resizer"
        :class="{ dragging: dockSplit.dragging.value }"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the tool panels (drag, arrow keys, double-click to reset)"
        tabindex="0"
        @pointerdown="dockSplit.onPointerDown"
        @pointermove="dockSplit.onPointerMove"
        @pointerup="dockSplit.onPointerUp"
        @pointercancel="dockSplit.onPointerUp"
        @keydown="dockSplit.onKeyDown"
        @dblclick="dockSplit.onDoubleClick"
      ></div>
      <WorkBenchToolsDock
        ref="dock"
        v-model:collapsed="dockCollapsed"
        :style="dockCollapsed ? null : dockSplit.bottomStyle.value"
      />
    </div>

    <WorkBenchFocusGutter
      :focus="focus"
      :left-hidden="leftHidden"
      @toggle-focus="toggleFocus"
      @toggle-left-hidden="toggleLeftHidden"
    />
    <div ref="rightCol" class="chat-col chat-col--right">
      <div
        ref="panel"
        class="chat-output stream-panel"
        aria-label="WorkBench conversation"
        @scroll.passive="onScroll"
      >
        <template v-for="(message, i) in state.messages" :key="i">
          <div v-if="message.role === 'user'" class="chat-turn">
            <div class="chat-bubble">
              <span class="chat-turn-chip chat-turn-avatar" aria-hidden="true">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <circle cx="12" cy="8" r="4" />
                  <path d="M4 21a8 8 0 0 1 16 0" />
                </svg>
              </span>
              <!-- The gesture returns the whole unanswered group to the strip,
                   so it draws on the group's first message and says what it
                   does rather than claiming to touch one message. Gated: idle,
                   and no batch running. -->
              <button
                v-if="i === lastGroupStart && state.phase === 'idle' && !batch.active"
                class="chat-turn-chip chat-turn-edit"
                type="button"
                aria-label="Edit the last unanswered messages"
                title="Pull the last unanswered messages back into the strip"
                @click="editLast"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button
                v-for="(image, j) in message.images ?? []"
                :key="j"
                type="button"
                class="chat-thumb-zoom"
                :aria-label="`View ${image.name} at full size`"
                :title="`View ${image.name} at full size`"
                @click="preview = image"
              >
                <img
                  :src="image.dataUrl"
                  :alt="image.name"
                  class="chat-thumb"
                  loading="lazy"
                />
              </button>
              <MarkdownStream v-if="message.html" :html="message.html" />
            </div>
          </div>
          <article v-else class="chat-answer-card">
            <!-- The reply's own copy affordance. The composer's button is the
                 one that copies the whole conversation. -->
            <MessageCopyChip :text="messageClipboardText(message)" />
            <MarkdownStream :html="message.html" mermaid />
            <!-- Sticky marker: the transient error line above the composer is
                 cleared by the next send, but the fragment stays in the
                 conversation and is re-posted, so the reply itself says it was
                 cut short. -->
            <p v-if="message.truncated" class="caption chat-truncated" role="status">
              &#9888; Cut short by the server — this reply is incomplete.
            </p>
            <!-- The user's own interruption: not a fault, and the fragment is
                 deliberately kept, so it says what happens next. -->
            <p v-if="message.paused" class="caption chat-paused" role="status">
              &#9208; Interrupted by you — the partial reply above is kept in
              the conversation.
            </p>
            <p
              v-if="message.streaming && !message.raw && !waitInProgress"
              class="caption chat-typing"
              role="status"
            >
              {{ 'Thinking…' }}
            </p>
          </article>
        </template>
        <!-- One chip per attached image, in attachment order: each carries its
             own thumbnail, lightbox target and remove button, so a set of
             mockups is individually editable before it is sent. -->
        <div
          v-for="(image, index) in state.pendingImages"
          :key="index"
          class="chat-attachment chat-attachment--pending"
          :aria-label="`Attached image: ${image.name} (not sent yet)`"
        >
          <button
            type="button"
            class="chat-thumb-zoom"
            :aria-label="`View ${image.name} at full size`"
            :title="`View ${image.name} at full size`"
            @click="preview = image"
          >
            <img
              :src="image.dataUrl"
              :alt="image.name"
              class="chat-thumb"
            />
          </button>
          <span class="chat-attachment-meta">
            <span class="chat-attachment-name">{{ image.name }}</span>
            <span class="caption">{{ humanFileSize(image.size) }}</span>
          </span>
          <button
            class="icon-btn chat-attachment-remove"
            type="button"
            :aria-label="`Remove attached image ${image.name}`"
            :title="`Remove ${image.name}`"
            @click="removeImage(index)"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" />
              <path d="m6 6 12 12" />
            </svg>
          </button>
        </div>
        <!-- The strip: messages the composer accepted that no turn has carried
             yet, in flush order. Drawn in the pane because a staged message is
             the next thing to be sent, not a part of the conversation. It
             renders nothing until the first stage. -->
        <StagedMessageStrip @preview="preview = $event" />
        <div
          v-if="state.draft.html"
          class="chat-bubble chat-bubble--draft"
          aria-label="Message preview (not sent yet)"
        >
          <MarkdownStream :html="state.draft.html" />
        </div>
        <p v-if="state.error" class="error-line" role="alert">{{ state.error }}</p>
        <div
          v-if="
            !state.messages.length &&
            !state.draft.html &&
            !state.pendingImages.length &&
            !state.staged.length
          "
          class="stream-empty"
        >
          <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
            stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
          <p class="stream-empty-title">Chat with the model</p>
          <p class="caption">
            Ask anything — answers stream from the endpoint configured for this workspace.
          </p>
        </div>
      </div>

      <div
        class="pane-resizer chat-resizer"
        :class="{ dragging: composerSplit.dragging.value }"
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize the message input (drag, arrow keys, double-click to reset)"
        tabindex="0"
        @pointerdown="composerSplit.onPointerDown"
        @pointermove="composerSplit.onPointerMove"
        @pointerup="composerSplit.onPointerUp"
        @pointercancel="composerSplit.onPointerUp"
        @keydown="composerSplit.onKeyDown"
        @dblclick="composerSplit.onDoubleClick"
      ></div>

      <WorkBenchInput ref="input" :style="composerSplit.bottomStyle.value" />
    </div>

    <ImageLightbox :image="preview" @close="preview = null" />
  </div>
</template>
