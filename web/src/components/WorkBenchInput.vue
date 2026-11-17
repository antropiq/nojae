<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import BatchProgressBar from './BatchProgressBar.vue'
import AgentModesDialog from './AgentModesDialog.vue'
import MemoryBullets from './MemoryBullets.vue'
import RegistrationMemoryDlg from './RegistrationMemoryDlg.vue'
import {
  conversationJson,
  conversationMarkdown,
  humanFileSize,
  parseSessionFile,
  useChat,
} from '../composables/useChat'
import { copyText } from '../lib/clipboard'
import { modelInView, useAppShell } from '../composables/useAppShell'
import { useBatch } from '../composables/useBatch'
import {
  NO_MODEL_WARNING,
  findingsLine,
  modeHint,
  modeSelectTitle,
  modeSelectDisabled,
  selectedAgentCanRun,
  selectedAgentGateReason,
  setAgentMode,
  useAgentModes,
} from '../composables/useAgentModes'
import { useComposerKeys } from '../composables/useComposerKeys'

const {
  state,
  send,
  stop,
  pause,
  reset,
  setDraft,
  registerDraftInput,
  attachImage,
  loadSession,
  stage,
  chatBusy,
} = useChat()
const { state: appShellState } = useAppShell()
const {
  state: batch,
  stopBatch,
  clearBatchRun,
  openDialog: openBatchDialog,
} = useBatch()
const agentModes = useAgentModes().state
const { state: composerKeys, toggleEnterSends } = useComposerKeys()

// Let draft insertions (memory bullets) focus the textarea after appending.
const draftEl = ref(null)
onMounted(() => registerDraftInput(draftEl.value))

// Registration dialog for the clicked bullet, addressed by the store's id
// (``null`` id = closed). Not an index: with no count rule the position a bullet
// is drawn at is not a handle a write can use.
const dialogOpen = ref(false)
const dialogId = ref(null)

function openBulletDialog(id) {
  // Unreachable once the bullets are inert, but the guard keeps a keyboard or
  // synthetic click from opening an editor for a draft nobody can send.
  if (batch.active) return
  dialogId.value = id
  dialogOpen.value = true
}

// "Add bullet" from inside the dialog: the form moves to a new row, which the
// dialog renders as an empty add (it prefills from an id the list does not hold).
function addBulletDialog() {
  if (batch.active) return
  dialogId.value = null
}

const streaming = computed(() => state.phase !== 'idle')
// "There is an image to send" is "the list is non-empty": the composer holds a
// list, and every read of it answers about the list.
const hasPendingImages = computed(() => state.pendingImages.length > 0)
// A batch owns every surface but Stop and Restart: `batch.active` is true for
// the whole lot, including the momentary idle between two task turns, which is
// why the composer cannot key on `streaming` alone here.
const locked = computed(() => streaming.value || batch.active)
// §5.4: the selected agent's own "can it run" answer, and the composer's one
// gate. The warning icon, the Send button's disabled state and its title all
// read these two answers instead of re-deriving the rule.
const selectedCanRun = computed(() => selectedAgentCanRun())
const showNoModelWarning = computed(
  () => agentModes.loaded && !!agentModes.current && !selectedCanRun.value,
)
const sendGateReason = computed(() => selectedAgentGateReason())
// "Is there anything to send?" counts the strip as well as the composer: the
// sending key flushes whatever is waiting, and a strip the user has emptied the
// composer on top of is exactly what they mean to send — the draft is one more
// turn on the end of it, not a precondition.
const canSend = computed(
  () =>
    !locked.value &&
    !sendGateReason.value &&
    (state.draft.raw.trim().length > 0 ||
      state.pendingImages.length > 0 ||
      state.staged.length > 0),
)
const sendTitle = computed(() => sendGateReason.value ?? 'Send')

function submit() {
  if (!canSend.value) return
  send()
}

// "Is there something to stage?" — a non-empty draft or an attached image, the
// same two things the stage verb itself accepts as content. The busy half of the
// verdict is the composable's own `chatBusy`, read rather than re-derived here,
// so this control cannot disagree with the verb a stray keypress reaches.
const canStage = computed(
  () =>
    !chatBusy() &&
    (state.draft.raw.trim().length > 0 || state.pendingImages.length > 0),
)
// The stage verb's own two refusals, said out loud: the composer is shut, or
// there is nothing written to move. Neither may be guessed at here.
const stageTitle = computed(() => {
  if (chatBusy()) return 'Available when no reply is streaming and no batch runs'
  if (!canStage.value) return 'Write a message to stage it first'
  return 'Stage the draft (Ctrl+Enter)'
})

function stageDraft() {
  if (!canStage.value) return
  stage()
}

// Which Enter sends, which writes a newline, and which stages. The composer's
// toggle inverts the send/newline pair (see useComposerKeys); staging is read
// *before* that toggle is consulted, because a gesture whose meaning flipped
// with a keyboard habit would be unusable. `Ctrl` or `Cmd`, matching how every
// other modifier chord in the app is read. An Enter from an IME candidate window
// belongs to the IME and does neither.
function onKeydown(event) {
  if (event.key !== 'Enter' || event.isComposing) return
  // Ctrl/Cmd+Enter stages. Shift is not consulted: Ctrl+Shift+Enter is still
  // this chord, so a combination the user never pressed cannot reach staging.
  if (event.ctrlKey || event.metaKey) {
    // The textarea would otherwise insert a newline into the draft a stage just
    // emptied.
    event.preventDefault()
    stageDraft()
    return
  }
  const sends = composerKeys.enterSends ? !event.shiftKey : event.shiftKey
  if (!sends) return
  // The newline is what the textarea would have done on its own, so only the
  // sending branch has to prevent anything.
  event.preventDefault()
  submit()
}

// Restart stays live during a batch and means Stop + wipe (B15): the only way
// back to a launchable state after a stopped batch. clearBatchRun first, so the
// loop can never be left running on a conversation that no longer exists.
function restart() {
  clearBatchRun()
  stop()
  reset()
}

const canRestart = computed(
  () => state.messages.length > 0 || state.phase !== 'idle' || batch.active,
)

// --- Agent mode (the composer's dropdown; every rule lives in useAgentModes) ---

// The select's title, and the quiet findings line, come from the composable —
// this component only renders them. Switching mid-`streaming` is allowed and
// has no effect on the turn already in flight (that request carried the agent
// chosen when it was sent). **There is no mode lock** any more (§4.4): a thread
// that has turned can move to any agent, including the app-owned one. What is
// left of the disabling rules is the running lot, which took this selection at
// launch and keeps it for every task — a rendering rule the composable owns.
// The catalogue the server name is read from: `/api/config`'s per-model rows,
// which already carry the `serverName` of the server each model sits on. The
// WorkBench loads it for its own reasons, so the tooltip adds no fetch.
const modeTitle = computed(() =>
  modeSelectTitle({ batchActive: batch.active, models: appShellState.config?.models }),
)
const modeFindingsLine = computed(() => findingsLine())

function onModeChange(event) {
  setAgentMode(event.target.value)
}

// --- The modes editor (the pencil beside the dropdown) -----------------------

// One button, one card: the pencil opens `AgentModesDialog`, which reads and
// saves the store's agents through the composable's own calls rather than
// through the dropdown's verdict — so it stays reachable when the dropdown's
// list failed to load, which is precisely when a broken store needs fixing.
const modesDialogOpen = ref(false)

// The pencil's enablement, the dropdown's own window and nothing wider:
//  * inert while a reply streams — a dialog opened into a turn would show a
//    selection that turn no longer runs under;
//  * inert while a lot runs — the lot pinned its agent at launch, and a save
//    cannot move it;
//  * live with a failed list — deliberately not gated on `agentModes.loaded`,
//    because a store that could not be read is precisely the one worth opening.
// The click guard is the same verdict, not a second rule: a synthetic or
// keyboard activation cannot open the card in the window it must not open in.
const pencilDisabled = computed(() => batch.active || streaming.value)
// Naming: neither string may contain the select's own accessible name, or the
// two controls in this column would answer the same `getByLabel` query (the
// pinned e2e spec asks for "Agent mode" and expects exactly the select). The
// wording is the composer's own — "modes", the short affordance the other
// buttons use ("Save session (JSON)"), and the disabled reason the batch
// button already states in the same row.
const pencilTitle = computed(() =>
  pencilDisabled.value
    ? 'Available when no reply is streaming and no batch runs'
    : 'Edit modes',
)

function openModesDialog() {
  if (pencilDisabled.value) return
  modesDialogOpen.value = true
}

function closeModesDialog() {
  modesDialogOpen.value = false
}

// The Models section's unassigned line asks for this card from the other dialog
// (§5.1). The request is a counter, not a flag, so this watch is the only place
// the card opens from outside the composer, and the pencil's own enablement is
// the gate — a line that opened a card whose Save would be refused would be the
// same mistake D10 refuses for the button.
watch(
  () => appShellState.agentModesRequest,
  (request, previous) => {
    if (request === previous) return
    openModesDialog()
  },
)

// --- Image attach (the hidden file input below, driven by the icon button) ---

// Only usable when the model the turn will run on is declared vision-capable.
// `/api/config` carries the flag **per model** (D5), so it is read off the model
// in view rather than off "the" connection.
const supportsVision = computed(
  () => modelInView(appShellState.config)?.supportsVision === true,
)

const fileInput = ref(null)

function pickImage() {
  if (locked.value) return
  fileInput.value?.click()
}

function onFilePicked(event) {
  const input = event.target
  attachImage(input.files?.[0])
  // Reset so picking the same file again still fires the change event.
  input.value = ''
}

// --- Batch mode (the dialog itself lives in App.vue, like every modal) ---

// Active only while this tab's state is IDLE: `locked` covers a reply streaming
// and the whole of a running lot (including the gap between two task turns).
const canOpenBatch = computed(() => !locked.value)

const batchDisabledReason = computed(() => {
  if (batch.active) return 'A batch is already running'
  if (streaming.value) return 'Available when no reply is streaming'
  return ''
})

// --- Copy the conversation as markdown ---

const canCopy = computed(
  () => state.messages.length > 0 && !batch.active,
)

const copyState = ref('idle') // idle | copied | failed
let copyTimer = null

function clearCopyTimer() {
  clearTimeout(copyTimer)
  copyTimer = null
}

async function copyConversation() {
  if (!canCopy.value) return
  const ok = await copyText(conversationMarkdown(state.messages))
  copyState.value = ok ? 'copied' : 'failed'
  clearCopyTimer()
  copyTimer = setTimeout(() => {
    copyState.value = 'idle'
  }, 1500)
}

// --- Save / load the session as a JSON file (see useChat's conversationJson) ---

// Refuse an oversized file before even reading it, so a stray blob cannot freeze
// the tab inside JSON.parse. Kept well above what a *valid* session can hold:
// an image is capped at MAX_IMAGE_BYTES (10 MB) decoded, i.e. ~13.4 MB of
// base64, and every per-turn image the conversation carries lives in this one
// file — so the guard stays a guard against junk, not against real saved
// images. An image that is itself too large is reported per turn by
// parseSessionFile instead.
const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024

const canSave = computed(() => canCopy.value && !streaming.value)

function sessionFileName() {
  const now = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`
  return `chat-session-${stamp}.json`
}

function saveSession() {
  if (!canSave.value) return
  const blob = new Blob([JSON.stringify(conversationJson(state.messages), null, 2)], {
    type: 'application/json',
  })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  // The browser's native Save-As lets the user rename it from here.
  link.download = sessionFileName()
  document.body.appendChild(link)
  link.click()
  document.body.removeChild(link)
  URL.revokeObjectURL(url)
  state.error = null
}

const sessionInput = ref(null)

function pickSessionFile() {
  if (locked.value) return
  sessionInput.value?.click()
}

async function onSessionFilePicked(event) {
  const input = event.target
  const file = input.files?.[0]
  // Reset so picking the same file again still fires the change event.
  input.value = ''
  if (!file || streaming.value) return
  if (file.size > MAX_SESSION_FILE_BYTES) {
    state.error = `Session file too large (${humanFileSize(file.size)}, max ${humanFileSize(MAX_SESSION_FILE_BYTES)}).`
    return
  }
  let text
  try {
    text = await file.text()
  } catch {
    state.error = 'Could not read the selected session file.'
    return
  }
  let parsed
  try {
    parsed = parseSessionFile(text)
  } catch (exc) {
    state.error = `Cannot load session: ${exc?.message ?? exc}`
    return
  }
  if (
    state.messages.length &&
    !window.confirm('Replace the current conversation with the loaded session?')
  ) {
    return
  }
  const result = loadSession(parsed)
  if (!result) {
    state.error = 'Cannot load a session while a reply is streaming.'
  }
}

onBeforeUnmount(() => {
  registerDraftInput(null)
  clearCopyTimer()
})
</script>

<template>
  <div class="chat-input">
    <input
      ref="fileInput"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      class="chat-file-input"
      tabindex="-1"
      aria-hidden="true"
      @change="onFilePicked"
    />
    <input
      ref="sessionInput"
      type="file"
      accept="application/json,.json"
      class="chat-file-input"
      tabindex="-1"
      aria-hidden="true"
      @change="onSessionFilePicked"
    />
    <div class="chat-textarea-col">
      <!-- The batch meter, above the composer row: it owns the column's full
           width now that no side panel stands next to the textarea, and it
           only renders while a lot runs (or just after it ended). -->
      <BatchProgressBar />
      <!-- One row above the textarea: the session icon buttons flanking the
           memory bullets, which stay centered between the two button groups. -->
      <div class="chat-bullet-row">
        <div class="chat-bullet-actions chat-bullet-actions--left">
          <!-- Attaching appends: a message may carry several images, so with
               one already pending the button offers another rather than a
               replacement. Its accessible name stays distinct from every other
               control's in this column (the thumbnails' "View … at full size"
               and the chips' "Remove attached image …"). -->
          <button
            class="icon-btn chat-attach"
            type="button"
            :disabled="!supportsVision || locked"
            :class="{ 'chat-attach--pending': hasPendingImages }"
            :aria-label="
              supportsVision
                ? hasPendingImages
                  ? 'Add another image'
                  : 'Attach image'
                : 'Image input not supported'
            "
            :title="
              !supportsVision
                ? 'The configured model does not support image input (enable it in Settings → LLM)'
                : hasPendingImages
                  ? 'Add another image'
                  : 'Attach image'
            "
            @click="pickImage"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="m21 15-5-5L5 21" />
            </svg>
            <span v-if="hasPendingImages" class="chat-attach-badge" aria-hidden="true"></span>
          </button>
          <button
            class="icon-btn"
            type="button"
            :disabled="!canCopy"
            :aria-label="copyState === 'copied' ? 'Conversation copied' : 'Copy conversation as markdown'"
            :title="
              copyState === 'copied'
                ? 'Copied'
                : copyState === 'failed'
                  ? 'Copy failed'
                  : 'Copy conversation (markdown)'
            "
            @click="copyConversation"
          >
            <template v-if="copyState === 'copied'">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M20 6 9 17l-5-5" />
              </svg>
            </template>
            <template v-else>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="9" y="9" width="13" height="13" rx="2" />
                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
              </svg>
            </template>
          </button>
          <button
            class="icon-btn"
            type="button"
            :disabled="!canSave"
            aria-label="Save session as JSON"
            title="Save session (JSON)"
            @click="saveSession"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 14v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1" />
              <path d="M12 3v12" />
              <path d="m7 10 5 5 5-5" />
            </svg>
          </button>
          <button
            class="icon-btn"
            type="button"
            :disabled="locked"
            aria-label="Load session from a JSON file"
            title="Load session (JSON)"
            @click="pickSessionFile"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 14v1a3 3 0 0 0 3 3h10a3 3 0 0 0 3-3v-1" />
              <path d="M12 15V3" />
              <path d="m7 8 5-5 5 5" />
            </svg>
          </button>
          <!-- Batch mode, right of the JSON session buttons: it belongs to this
               tab only, so it sits in the composer row instead of the app bar.
               Live only while the composer is fully idle (see canOpenBatch) —
               a lot always starts on an empty thread. -->
          <button
            class="icon-btn"
            type="button"
            :disabled="!canOpenBatch"
            aria-label="Batch mode"
            :title="canOpenBatch ? 'Batch mode' : batchDisabledReason"
            @click="openBatchDialog"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M4 6h10" />
              <path d="M4 12h16" />
              <path d="M4 18h7" />
              <path d="m17 15 3 3-3 3" />
            </svg>
          </button>
          <!-- The agent this conversation answers as, and the pencil that edits
               the agent list. The **column** always renders: the pencil is
               useful whatever the dropdown's verdict, and a store whose list
               could not be read is precisely the one worth opening. The
               `<select>` inside it is still rendered only once the list loaded —
               a control that cannot be used is worse than no control. The column
               sits in the left action group, after the buttons, so the memory
               bullets stay centered as the layout promises. The select is inert
               while a batch runs: the lot is one job executed under one agent the
               runner pins for the whole run (D13), so the dropdown can neither
               change it mid-lot nor pretend it owns it. Nothing else disables
               it — there is no mode lock (§4.4, AC-10). -->
          <div class="chat-mode-col">
            <div class="chat-mode-row">
              <select
                v-if="agentModes.loaded"
                class="chat-mode-select"
                :value="agentModes.current"
                :disabled="modeSelectDisabled(batch.active)"
                :title="modeTitle"
                aria-label="Agent mode"
                @change="onModeChange"
              >
                <option
                  v-for="mode in agentModes.modes"
                  :key="mode.id"
                  :value="mode.id"
                  :title="modeHint(mode.id)"
                >
                  {{ mode.label }}
                </option>
              </select>
              <!-- The pencil: the agent-list editor, immediately after the
                   select and on its line, drawn with the glyph the conversation
                   already uses for pulling the last unanswered messages back
                   into the strip. It opens the card that edits the
                   store's agents, so it is *not* gated on the dropdown having
                   loaded — a store whose list could not be read is exactly the
                   one worth opening. Its accessible name deliberately does not
                   contain the select's ("Agent mode"), so the two controls stay
                   distinguishable to a query and to a reader. -->
              <button
                class="icon-btn chat-mode-edit"
                type="button"
                :disabled="pencilDisabled"
                aria-label="Edit modes"
                :title="pencilTitle"
                @click="openModesDialog"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <!-- §5.4: the selected agent has no model, so no turn can run. It
                   sits immediately beside the pencil — the row already exists, so
                   the warning adds a glyph and no layout — and the fix is either
                   assigning a model in the card the pencil opens, or picking an
                   agent that has one. Only the row's own `modelId` is read. -->
              <span
                v-if="showNoModelWarning"
                class="chat-mode-warning"
                role="img"
                :aria-label="NO_MODEL_WARNING"
                :title="NO_MODEL_WARNING"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                  stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" />
                  <path d="M12 9v4" />
                  <path d="M12 17h.01" />
                </svg>
              </span>
            </div>
            <!-- The two quiet lines this control can carry, never a modal and
                 never a banner: a session asked for an agent this installation
                 does not have (its substitution is said out loud, not chosen
                 silently), or the store's read has findings the server could not
                 use (the rest of the list still renders, and the fix lives in the
                 dialog). It renders with or without the select: the column is
                 there for the pencil whatever the list's verdict. -->
            <p v-if="agentModes.notice" class="chat-mode-findings" role="status">
              {{ agentModes.notice }}
            </p>
            <p v-else-if="modeFindingsLine" class="chat-mode-findings" role="status">
              {{ modeFindingsLine }}
            </p>
          </div>
        </div>
        <MemoryBullets @configure="openBulletDialog" />
        <div class="chat-bullet-actions chat-bullet-actions--right">
          <button
            class="icon-btn"
            type="button"
            :disabled="!canRestart"
            aria-label="Restart conversation"
            title="Restart conversation"
            @click="restart"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
              <path d="M3 3v5h5" />
            </svg>
          </button>
          <!-- Pause: the non-destructive twin of Stop, and it only exists
               while a reply streams — the `pause_ack` returns the app to idle,
               so this button leaves the row exactly when Send comes back.
               Blinking means the request is armed and the button is not
               clickable; typing a comment and sending it is the only way back
               into inference. Hidden during a batch: pausing one turn and
               letting the loop carry on onto the next task would contradict
               "Stop is the only control", and a comment is meaningless between
               automated tasks. -->
          <button
            v-if="streaming && !batch.active"
            class="icon-btn chat-pause"
            type="button"
            :disabled="state.pausePending"
            :class="{ 'is-paused-blink': state.pausePending }"
            :aria-label="state.pausePending ? 'Pausing…' : 'Pause — keep the partial reply, add a comment'"
            :title="state.pausePending ? 'Pausing…' : 'Pause'"
            @click="pause"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="7" y="5" width="4" height="14" rx="1" />
              <rect x="14" y="5" width="4" height="14" rx="1" />
            </svg>
          </button>
          <!-- Which Enter does what (see useComposerKeys): immediately left of
               Stage, because the three buttons are the row's verbs in the order
               the keys reach them — Enter/Shift+Enter first, then the staging
               chord, then the sending key. Off (the default) Enter sends; on,
               Enter writes a newline and Shift+Enter sends, so a draft can be
               finished — and reread — before it is handed to the model.

               Always live: flipping it cannot touch a reply already in flight,
               and a textarea disabled for a lot is no reason to hide a
               preference. Its accessible names deliberately do not contain
               "Send message", the label the pinned e2e spec queries here. -->
          <button
            class="icon-btn chat-enter-mode"
            type="button"
            :aria-pressed="!composerKeys.enterSends"
            :aria-label="
              composerKeys.enterSends
                ? 'Enter sends the message'
                : 'Enter starts a new line'
            "
            :title="
              composerKeys.enterSends
                ? 'Enter sends, Shift+Enter for a new line — click to make Enter write a new line'
                : 'Enter writes a new line, Shift+Enter sends — click to make Enter send'
            "
            @click="toggleEnterSends"
          >
            <!-- One glyph per state: the Enter arrow alone while that key sends,
                 the same arrow over the line it starts once it does not. -->
            <svg v-if="composerKeys.enterSends" width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              aria-hidden="true">
              <path d="M20 5v7a4 4 0 0 1-4 4H4" />
              <path d="m9 12-5 4 5 4" />
            </svg>
            <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none"
              stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
              aria-hidden="true">
              <path d="M20 4v6a3 3 0 0 1-3 3H4" />
              <path d="m8 10-4 3 4 3" />
              <path d="M4 20h16" />
            </svg>
          </button>
          <!-- Stage: the visible half of Ctrl/Cmd+Enter, because a keyboard-only
               affordance for a state the user has never seen is undiscoverable.
               It renders in every state — the row's three verbs keep their
               order whatever the conversation is doing — and it is inert, with
               the reason in its title, exactly when the verb would refuse: the
               composer is shut, or there is nothing written to move. Clicking a
               disabled button stages nothing.

               Its names avoid "Send message", the phrase the Send button is found
               by: staging does not send, and neither a reader nor a query may be
               told that it does. -->
          <button
            class="icon-btn chat-stage"
            type="button"
            :disabled="!canStage"
            aria-label="Stage the draft as a message not yet sent"
            :title="stageTitle"
            @click="stageDraft"
          >
            <!-- A stack: what staging does is add the draft under what is
                 already waiting. -->
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M12 2 2 7l10 5 10-5-10-5z" />
              <path d="m2 12 10 5 10-5" />
              <path d="m2 17 10 5 10-5" />
            </svg>
          </button>
          <!-- Send and Stop swap on `streaming`, except during a batch: the lot
               keeps Stop live across the microsecond its own loop spends between
               two task turns, and Send is inert for the whole lot anyway. -->
          <button
            v-if="!streaming && !batch.active"
            class="icon-btn chat-send"
            type="button"
            :disabled="!canSend"
            aria-label="Send message"
            :title="sendTitle"
            @click="submit"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M22 2 11 13" />
              <path d="M22 2 15 22l-4-9-9-4 20-7z" />
            </svg>
          </button>
          <button
            v-else
            class="icon-btn chat-send chat-stop"
            type="button"
            aria-label="Stop generating"
            :title="batch.active ? 'Stop the batch' : 'Stop'"
            @click="batch.active ? stopBatch() : stop()"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
              stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <rect x="5" y="5" width="14" height="14" rx="2" />
            </svg>
          </button>
        </div>
      </div>
      <textarea
        ref="draftEl"
        :value="state.draft.raw"
        class="chat-textarea"
        rows="3"
        :disabled="batch.active"
        :placeholder="
          batch.active
            ? 'A batch is running — only Stop and Restart are live.'
            : composerKeys.enterSends
              ? 'Ask the model something… (Enter to send, Shift+Enter for a new line, Ctrl+Enter to stage)'
              : 'Ask the model something… (Shift+Enter to send, Enter for a new line, Ctrl+Enter to stage)'
        "
        :aria-label="
          batch.active
            ? 'WorkBench input (unavailable while a batch runs)'
            : streaming
              ? 'WorkBench input (reply streaming)'
              : 'WorkBench input'
        "
        @input="setDraft($event.target.value)"
        @keydown="onKeydown"
      ></textarea>
    </div>
    <RegistrationMemoryDlg
      :open="dialogOpen"
      :helper-id="dialogId"
      @close="dialogOpen = false"
      @add="addBulletDialog"
    />
    <!-- The modes editor, mounted where it is used (the way the bullet dialog
         above is). The card's writes are the browser's own and are not gated on
         a reply: a turn resolves its agent once, at its start (§4.5).

         `v-if` rather than an always-mounted card: a closed `<dialog>` is still
         in the DOM and keeps its own accessible name, so the canvas does not
         carry closed cards around in every query. (The name collision this used
         to guard — the card titled "Agent modes", a substring of the select's
         "Agent mode" — is gone: the card is titled `Agents` now, but the habit
         stands.) The card's own watch runs with `immediate`, so mounting it *is*
         opening it. -->
    <AgentModesDialog
      v-if="modesDialogOpen"
      :open="modesDialogOpen"
      :initial-mode="agentModes.current"
      @close="closeModesDialog"
    />
  </div>
</template>
