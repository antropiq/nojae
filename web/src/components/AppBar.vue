<script setup>
import { computed, onUnmounted, ref, watch } from 'vue'
import TabNav from './TabNav.vue'
import ThemeToggle from './ThemeToggle.vue'
import SoundToggle from './SoundToggle.vue'
import SessionClock from './SessionClock.vue'
import SessionStatBadges from './SessionStatBadges.vue'
import { useAppShell } from '../composables/useAppShell'
import {
  locationNoteVerdict,
  useWorkspaceSession,
} from '../composables/useWorkspaceSession'
import { useChat } from '../composables/useChat'
import { useBatch } from '../composables/useBatch'
import { useWorkspaceTree } from '../composables/useWorkspaceTree'
import { modeById, runningOnLine } from '../composables/useAgentModes'
import { phaseInFlight } from '../lib/inference-state'

const { state, openSettings, applyWorkspaceHubs } = useAppShell()
const { state: session, setWorkspaceFromField } = useWorkspaceSession()
const { state: chat } = useChat()
const { state: batch } = useBatch()

// The connection indicator, narrowed to the **store-level** question: is the
// store usable, and does it hold at least one model? Whether *this* turn can run
// is the composer's business — that is where the agent is chosen and where the fix
// is one click away — so the bar says nothing about the selected agent. One
// warning in two places would mean two sentences to keep in step.
//
// The sentence is the server's: an unusable store answers 422 with one naming its
// path, shown verbatim. "No model configured" is the bar's own, because there is
// no server sentence for a store that is perfectly usable and simply empty.
const storeLine = computed(() => {
  const store = state.storeState
  if (store && !store.usable) return store.sentence || null
  if (state.config && !(state.config.models ?? []).length) {
    return 'no model configured'
  }
  return null
})

// One pill for the app: a chat reply in flight reports its own phase. The "in
// flight" half is the shared predicate's answer, not a list spelled out here: the
// bar and the tab glyph / end-of-session chime must never disagree about whether a
// reply is still running, or the app goes quiet mid-turn while the composer stays
// locked. Every phase that is not idle reaches it through `phaseInFlight`, so a
// later phase needs no edit here.
const chatBusy = computed(() => phaseInFlight(chat.phase))

// A running batch reads `Batch`, ahead of the chat branch: the lot owns the
// conversation across the gap between two task turns, where the chat phase is back
// to 'idle'. Once the lot is over, its own outcome keeps the pill for a couple of
// seconds — long enough to see which of Stop / finish / fail happened — then the
// chat state takes over again.
const BATCH_PILL_HOLD_MS = 2000
const BATCH_OUTCOME_CLASS = {
  stopped: 'status-cancelled',
  failed: 'status-failed',
  finished: 'status-finished',
}

// Transient, so it lives here rather than in useBatch: `batch.status` stays on
// screen (the progress bar reads it), but the pill must not stay coloured.
const batchOutcome = ref(null)
let batchPillTimer = null

function clearBatchPillTimer() {
  if (batchPillTimer) clearTimeout(batchPillTimer)
  batchPillTimer = null
}

watch(
  () => [batch.active, batch.status],
  ([active, status]) => {
    clearBatchPillTimer()
    batchOutcome.value = active || status === 'idle' ? null : status
    if (batchOutcome.value) {
      batchPillTimer = setTimeout(() => {
        batchOutcome.value = null
        batchPillTimer = null
      }, BATCH_PILL_HOLD_MS)
    }
  },
)
onUnmounted(clearBatchPillTimer)

// -- the working location, edited in place ---------------------------------
//
// The field belongs to **this tab alone**: `session.field` is what the user has
// typed, `session.workspace` what the server applied (its realpath) and what every
// request of this tab is built from, so Set reads the same difference the field is
// about — a canonicalised path never leaves it spuriously enabled. A second tab on
// the same address keeps its own folder.
const workspaceChanged = computed(
  () => (session.field || '').trim() !== session.workspace,
)

// This tab must not have its root moved out from under a running session: a reply
// streaming **here** owns the tools and the lot of this folder, so the field is
// locked while `useChat`'s phase (this module instance's) is busy or `useBatch`'s
// lot is active.
//
// **There is deliberately no cross-tab channel here.** Each browser tab is its own
// JS context, so these two composables — and the `sessionStorage` holding the
// folder and the agent — are per tab; a reply streaming in another tab lives in
// *that* tab's module instances and cannot reach this state. No `storage` event,
// no `BroadcastChannel`, no polling.
const locationLocked = computed(
  () => batch.active || chatBusy.value,
)
const locationTitle = computed(() =>
  locationLocked.value
    ? 'Unavailable while a session is running'
    : 'Point the MCP and LSP tools, the Editor and the terminal at this folder',
)

// What the read answered that is worth a line under the field, chosen by the
// composable's precedence: a refusal (red, alert), the pool's ceiling sentence (red,
// alert, the server's own words), the policy file that could not be read (warning),
// or the restarting status. The policy line is a warning and never a refusal — the
// folder *did* move — and the error outranks it.
const locationNote = computed(() => locationNoteVerdict())

// Presentation only: the composable decides *which* note wins and whether it is
// an alert or a status; this table decides the colour.
const NOTE_CLASS = {
  error: 'appbar-location-note--error',
  warn: '',
  status: 'appbar-location-note--status',
}
const locationNoteClass = computed(() =>
  locationNote.value ? NOTE_CLASS[locationNote.value.tone] : '',
)

// One gesture, two entries: the button and Enter in the field. The lock is
// re-checked here rather than left to the disabled button, because a key
// reaches the request without ever meeting the button.
async function applyLocation() {
  if (locationLocked.value) return
  const body = await setWorkspaceFromField()
  if (!body) return
  // The hub panels read the same payload the read answered with, so the tool
  // lists and the status dots are the new folder's without a second request.
  applyWorkspaceHubs(body.hubs)
  // **Three things are deliberately not reloaded**: the model connection, the
  // agent list and the prompt helpers. All three live in the install's settings
  // store, so moving a tab invalidates nothing in them — the servers, models,
  // agents and bullets a user built once are the same in every folder.
  //
  // The Editor's tree browses this folder, so the whole workspace-relative view of
  // the tab moves here: the listings cached under the old root are forgotten and
  // the tabs that held files of it close with it. Driven from the gesture rather
  // than from the tab, because the tab may never have been opened — in which case
  // there is nothing to forget.
  try {
    await useWorkspaceTree().reRoot(session.workspace)
  } catch (exc) {
    // The folder moved but the tree could not be listed: the next tree request
    // re-reads it. Say so rather than let it read as a failed move.
    session.error = `Workspace is set, but the file tree could not re-root: ${exc}`
  }
}

// What each phase the pill can be reading says about itself, and which tone it
// wears:
//
//   * `reconnecting` must not borrow the `thinking` / `reasoning...` wording — one
//     phase means "the endpoint refused", the other "it is thinking", and the two
//     must never be confusable on screen. So it gets its own short label; the
//     endpoint's own sentence belongs to the composer's detail line, not here.
//   * it stays **lit**: the turn is still in flight, so the tone is the violet
//     pulse the bar already uses for "a reply is running" — an `idle` pill during a
//     wait would tell the user the app had given up.
//
// The tables cover every in-flight phase, and the fallbacks below keep a phase that
// arrives later reading as busy rather than blank.
const PILL_LABEL = {
  waiting: 'thinking',
  reasoning: 'reasoning...',
  answering: 'thinking',
  reconnecting: 'Reconnecting',
}
const PILL_CLASS = {
  waiting: 'status-thinking',
  reasoning: 'status-reasoning',
  answering: 'status-thinking',
  reconnecting: 'status-reconnecting',
}

const pillLabel = computed(() => {
  if (batch.active) return 'Batch'
  if (batchOutcome.value) return `batch ${batchOutcome.value}`
  if (chatBusy.value) return PILL_LABEL[chat.phase] ?? 'thinking'
  return 'idle'
})
const pillClass = computed(() => {
  if (batch.active) return 'status-batch'
  if (batchOutcome.value) {
    return BATCH_OUTCOME_CLASS[batchOutcome.value] ?? 'status-idle'
  }
  if (chatBusy.value) return PILL_CLASS[chat.phase] ?? 'status-thinking'
  return 'status-idle'
})

// The brand's second line while a reply streams: which model the answer is coming
// from, on which server. It reads the agent the **turn was sent as**
// (`chat.session.agentMode`, recorded when the request opened) and not the
// composer's selection, so a dropdown moved mid-reply — or a lot running under its
// own pin — cannot make the line name a stranger to the stream.
//
// Gone the moment the reply ends: a model that is not answering anything is not
// worth a line, and keeping the last one on screen would pass it off as current.
// The recorded agent is required as much as the busy flag, because `modeById`
// answers the composer's *current* selection for a missing id, so a turn carrying
// no agent would be credited with whatever the dropdown happens to hold.
const runningLine = computed(() => {
  if (!chatBusy.value || !chat.session.agentMode) return null
  return runningOnLine(modeById(chat.session.agentMode), state.config?.models)
})
</script>

<template>
  <header class="appbar">
    <div class="appbar-brand">
      <span class="brand-mark" aria-hidden="true">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 12h4l3 8 4-16 3 8h4" />
        </svg>
      </span>
      <span class="brand-text">
        <span class="brand-name">Nojaé</span>
        <!-- One line, whichever half of the answer it is: the store is unusable
             (its own sentence, naming the path) or holds no model at all. A
             configured install shows nothing here while it is idle -- the model a
             turn runs on is the composer's answer. Once a reply streams the line
             becomes the running model instead: the store's problem and a live turn
             cannot coexist. -->
        <span v-if="storeLine" class="brand-sub">{{ storeLine }}</span>
        <span v-else-if="runningLine" class="brand-sub">{{ runningLine }}</span>
      </span>
    </div>

    <div class="appbar-center">
      <!-- The two session counters, left of the tab strip: they read whichever
           session is live (the WorkBench reply or a batch turn) and keep their
           figures once it ends, until the conversation is restarted. -->
      <SessionStatBadges />
      <TabNav />
      <div class="appbar-location">
        <div class="appbar-location-row">
          <input
            v-model="session.field"
            class="appbar-location-input"
            type="text"
            spellcheck="false"
            aria-label="Working location"
            :disabled="session.loading"
            :title="session.workspace"
            @keydown.enter.prevent="applyLocation"
          />
          <button
            class="appbar-location-set"
            type="button"
            :disabled="
              !workspaceChanged || session.saving || locationLocked
            "
            :title="locationTitle"
            @click="applyLocation"
          >
            {{ session.saving ? 'Reloading…' : 'Set' }}
          </button>
        </div>
        <!-- One line, whichever answer wins: a refusal (the server's 422 or the
             pool's ceiling 429), the policy seed that could not land, or the
             restarting status. The bar has no room for a wrapped sentence, so it
             truncates and `title` carries all of it. -->
        <p
          v-if="locationNote"
          class="appbar-location-note"
          :class="locationNoteClass"
          :role="locationNote.role"
          :title="locationNote.text"
        >
          {{ locationNote.text }}
        </p>
      </div>
    </div>

    <div class="appbar-actions">
      <!-- One clock for the whole app: there is one session at a time, so the same
           readout serves every tab and keeps ticking while the Editor tab is
           open. -->
      <SessionClock />
      <span class="status-pill" :class="pillClass" role="status">
        <span class="status-dot" aria-hidden="true"></span>{{ pillLabel }}
      </span>
      <button
        class="icon-btn appbar-settings"
        type="button"
        :disabled="batch.active || chatBusy || session.loading"
        :aria-label="batch.active || chatBusy || session.loading ? 'Settings (available when idle)' : 'Open settings'"
        :title="batch.active || chatBusy || session.loading ? 'Available when idle' : 'Settings'"
        @click="openSettings"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      <SoundToggle />
      <ThemeToggle />
    </div>
  </header>
</template>
