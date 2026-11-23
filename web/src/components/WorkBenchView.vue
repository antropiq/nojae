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

// Keep config.supportsVision (which gates the attach button) and the
// conversation-scoped MCP snapshot fresh when the chat tab is opened:
// settings may have been saved, or a hub declaration edited and refreshed,
// meanwhile (App.vue's initial loadConfig covers the first render). A locked
// (started) conversation keeps its frozen list — loadChatMcp ignores locked
// state. The prompt helper bullets refresh the same way (they may have been
// edited meanwhile).
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

// Where the edit affordance draws itself: on the **first** message of the last
// unanswered group of user turns, so the gesture is discoverable where the group
// begins rather than at its end. The rule (adjacency, no marker in the thread) is
// `useChat`'s; the view renders its answer and derives no index of its own.
const lastGroupStart = computed(() => lastUserGroupStart(state.messages))

// The card's "Thinking…" caption has to stop while the endpoint is refusing.
// Its condition — a streaming reply that has produced no text yet — is true
// during a wait on the **first** round too, which is exactly the confusion
// spec §5.11 forbids: `waiting` means "sent, no first token yet", a wait means
// "the endpoint refused". Of the two honest treatments the task offers
// (suppress the caption, or make it say what the strip says), this one
// **suppresses** it: the composer strip already carries the one line that
// names the wait, and repeating it in the card would be two captions for one
// wait — the drift this lot keeps refusing. The caption comes back on its own
// for the replayed round, because the wait's state clears at that round's
// first arrival (see `useChat`'s `endpointWait`).
//
// The read is the composable's state, not a phase list here: `endpointWait` is
// set by the wait's own frame and cleared by every arrival and every ending, so
// the caption and the strip's line cannot disagree about whether a wait is
// running.
const waitInProgress = computed(() => !!state.endpointWait)

const input = ref(null)
const panel = ref(null)

// Image opened in the full-size lightbox popup (null = closed). Pure view
// state, deliberately outside the useChat singleton.
const preview = ref(null)
// Everything that changes the pane's height, so the auto-scroll re-anchors when
// it moves. The whole pending-image list counts: the composer draws one chip row
// per attached image, so adding or removing one changes the height. The strip
// counts the same way, so a stage — or a row dropped or pulled back — scrolls
// the conversation the way typing does.
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

// Two splitters, one per column: the right one sizes the composer row (it used
// to span the whole shell and so sized the left column too), the left one
// sizes the tools dock under the reasoning timeline. See useChatLayout.
//
// `focus` / `leftHidden` / the two toggles drive the gutter between the
// columns: the state is the composable's, the template only renders it.
// `chatBusy` reaches the fold through the same seam, so the rule that refuses a
// fold mid-reply is useChat's own and not a second copy of it (see useChatLayout).
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
       never on the columns: this is where the chat geometry is already decided
       (it carries the breakpoint-overridden --bi-chat-panel-width), and the two
       rules those names drive in theme.css are the whole geometry of the
       feature. The reads below render useChatLayout's state (D1); the template
       computes no transition. -->
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
      <!-- The bar belongs to the dock's body: folding takes both out of the
           flow (the dock then sizes itself by its head strip), which is the
           only thing the dock's contents decide about the layout. The column's
           width is not one of them — it is the two panels' width whatever the
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
              <!-- The gesture returns the whole unanswered group — every user
                   turn the model has not answered — to the strip, so it draws on
                   the group's first message and says what it does rather than
                   claiming to touch one message. Gated exactly as it always was:
                   idle, and no batch runs. -->
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
            <!-- The reply's own copy affordance, on the card's top-right corner
                 (the composer's button above the textarea is the one that copies
                 the whole conversation). -->
            <MessageCopyChip :text="messageClipboardText(message)" />
            <MarkdownStream :html="message.html" mermaid />
            <!-- Sticky marker: the transient error line above the composer is
                 cleared by the next send, but the fragment stays in the
                 conversation (and is re-posted to the model on the next turn),
                 so the reply itself has to say it was cut short. -->
            <p v-if="message.truncated" class="caption chat-truncated" role="status">
              &#9888; Cut short by the server — this reply is incomplete.
            </p>
            <!-- The user's own interruption: unlike the line above this is not
                 a fault, and the fragment is deliberately part of the
                 conversation, so it says what happens next. -->
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
        <!-- One chip per attached image, in attachment order (the order they
             will be posted in): each carries its own thumbnail, its own
             lightbox target and its own remove button, so a set of mockups is
             reviewable and individually editable before it is sent. -->
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
        <!-- The strip: the messages the composer has accepted but no turn has
             carried yet, in flush order. Drawn in the pane, directly above the
             draft preview and beside the lightbox their thumbnails open, because
             a staged message is the next thing that will be sent — not a part of
             the conversation, and not something the composer row decides about.
             It renders nothing at all until the first stage. -->
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
