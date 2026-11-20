<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import {
  PAGE_APPLY,
  PAGE_CHOOSE,
  PAGE_PREPARE,
  SET_ME_UP_LABEL,
  useConnectorWizard,
} from '../composables/useConnectorWizard'

// The connector wizard's dialog: **one** modal for both tool families, walking
// choose → prepare → apply. It is mounted once, in `App.vue` beside
// `BatchModeDialog`, so a tab switch never closes it and neither panel owns it.
//
// It decides **nothing**. Every sentence, every disabled state and every verdict
// is a plain function from `useConnectorWizard` (the `useSettingsServers` /
// `useAgentModes` idiom): this file turns those answers into pages and buttons,
// so no rule about the wizard can drift from the control that shows it. What it
// does own is presentation — which page is on screen, how a candidate row is laid
// out — plus the two things that are only ever a click:
//
//  * **copy** is the dialog's primary action and the only one that changes
//    anything, and it changes the clipboard alone (§7);
//  * **hand-over** fills the composer's draft and nothing else — no arming, no
//    send, no focus on a send control (§7, AC-20).
//
// There is deliberately **no** control that writes: no save, no "remember", no
// apply-to-file, no restart, no toggle (§4, §3). The restart is a *sentence*
// pointing at the panel's own button, because the app reads a declaration only at
// start-up. And there is no free-text field anywhere: neither list offers "none
// of these", so an unmatched need is one sentence and the end of the road
// (AC-18) — the wizard never degrades into the JSON editor it exists to replace.
//
// The snippet is **text**: a plain `<pre>`/`<code>` through the template's own
// escaping. Nothing here renders markup and nothing reaches for the markdown
// renderer — plain text is the honest default for JSON a user is about to paste
// into a file.
//
// It opens the way the other app-level dialogs open (watch + `showModal` +
// backdrop click + native-close sync, the `SettingsDialog` / `BatchModeDialog` /
// `AgentModesDialog` pattern) and keeps focus where a keyboard user expects it:
// on the list they are choosing from, then on the page's own action.

const {
  state,
  close,
  select,
  goOn,
  retry,
  copySnippet,
  handOverInstall,
  snippet,
  headerLine,
  waitingLine,
  messageLine,
  readinessLine,
  sentinelWarning,
  duplicateWarning,
  verdictLine,
  verdictNotes,
  decisionLines,
  missingFileSentence,
  restartSentence,
  copySlot,
  continueSlot,
  installSlot,
  installLine,
  installLines,
} = useConnectorWizard()

const dialogEl = ref(null)

//: Page 1's rows, in the list's own order. Which field holds the name and which
//: holds the one line under it is the **payload's** shape, not a rule of this
//: file: a catalogue entry carries its halves in `identity`, a proposal carries
//: its name as the id and its evidence line beside it. So nothing here compares a
//: family — the composable decided which list page 1 has by loading it.
const candidateRows = computed(() =>
  (state.candidates ?? []).map((candidate) => ({
    candidate,
    name: candidate?.identity?.name ?? candidate?.id ?? '',
    line: candidate?.identity?.description ?? candidate?.evidence ?? '',
    // The row the composable holds IS the object the list offered (`select`
    // stores the found row), so the chosen mark is object identity and this file
    // never compares an id.
    chosen: candidate === state.selected,
  })),
)

//: Page 2's complete member — every value the model resolved, shown as part of
//: the member rather than summarised away (§3). Page 3's block is the composable's
//: `snippet` (the same member, rendered for pasting); this is the member itself.
const memberJson = computed(() =>
  state.prepared?.member ? JSON.stringify(state.prepared.member, null, 2) : null,
)

const message = computed(() => messageLine())
//: The road's end (§3): the model answered and nothing it offered fits this need.
//: The page then says the one stop sentence and offers **no** way on — no
//: "none of these" entry, no field, no link to the JSON. It is the composable's
//: flag, so this file judges nothing.
const stopped = computed(() => state.empty === true)
const waiting = computed(() => waitingLine())
const continueButton = computed(() => continueSlot())
const copyButton = computed(() => copySlot())
const installButton = computed(() => installSlot())
const installText = computed(() => installLine(state.prepared?.install))
const platformLines = computed(() => installLines(state.prepared?.install))
const readiness = computed(() => readinessLine())
const valueWarning = computed(() => sentinelWarning())
const duplicate = computed(() => duplicateWarning())
const verdict = computed(() => verdictLine())
const verdictNoteLines = computed(() => verdictNotes())
const decisions = computed(() => decisionLines())
const missingFile = computed(() => missingFileSentence())
const restart = computed(() => restartSentence())
const header = computed(() => headerLine())
const member = computed(() => snippet())

// Open/close, following the SettingsDialog pattern: the composable owns the flag
// and the element follows it. `immediate` is not needed here — the dialog is
// mounted closed and only ever opened through a panel's button.
watch(
  () => state.open,
  async () => {
    await nextTick()
    const dialog = dialogEl.value
    if (!dialog) return
    if (state.open && !dialog.open) {
      dialog.showModal()
      await settleFocus()
    } else if (!state.open && dialog.open) {
      dialog.close()
    }
  },
)

// What changes which control the page is **for**: the page, the list it offers,
// the one candidate chosen, the answer that landed, and whether a step is still
// in flight. Each of those re-offers the page's own action; a press has moved the
// focus by then already, so this never pulls a user back — `settleFocus` leaves a
// control that is already focused exactly where it is.
watch(
  () => [
    state.page,
    state.candidates,
    state.selected,
    state.prepared,
    state.loading,
  ],
  async () => {
    if (state.open) await settleFocus()
  },
)

//: Focus lands on the first live `data-wizard-focus` control of the page — the
//: first candidate on page 1, the page's own action on pages 2 and 3 — so a
//: keyboard user is one keystroke from what the page is for. Focus already
//: sitting on such a control is left alone, and a page whose step is still in
//: flight (nothing is live yet) keeps it on the card itself, so the answer
//: arriving moves nothing.
async function settleFocus() {
  await nextTick()
  const dialog = dialogEl.value
  if (!dialog) return
  const live = [...dialog.querySelectorAll('[data-wizard-focus]')].filter(
    (node) => !node.disabled,
  )
  if (live.includes(document.activeElement)) return
  ;(live[0] ?? dialog).focus()
}

// **Escape and a backdrop click are `Close` in every respect**, so both go
// through the composable's `close()`: it is the one act that leaves nothing
// behind (no draft, no cached snippet), and a walk that closed must not leave a
// candidate or an answer for the next open to inherit.
function onBackdropClick(event) {
  if (event.target === dialogEl.value) closeDialog()
}

function closeDialog() {
  close()
}

// The element closing by its own route (Escape) is the same verb: sync the
// composable so the flag and the element cannot disagree.
function onNativeClose() {
  if (state.open) close()
}

//: Choosing a candidate. Only a row the list offered can become the choice — the
//: composable's `select` refuses anything else, so nothing here validates one.
function choose(row) {
  select(row.candidate)
}

// One press, one step: page 1 → the prepare post, page 2 → page 3. Page 3 issues
// no request at all, because everything it prints came with the prepared answer.
function nextPage() {
  goOn()
}

//: Pressing again after a named failure: one more attempt at **the step that
//: failed**, and nothing else. The wizard makes exactly one attempt per press —
//: no waiting and no backoff, which is the spec's deliberate exception to the
//: chat turn's refused-round rule (§5).
function pressAgain() {
  retry()
}

function copyMember() {
  copySnippet()
}

//: The hand-over — the install line into the composer's draft, and nothing else
//: (§7). It reaches the composable's own function, so no send, no stage and no
//: focus of a send control exists on this path.
function handOver() {
  handOverInstall()
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="wizard-dialog"
    aria-labelledby="wizard-title"
    tabindex="-1"
    @click="onBackdropClick"
    @close="onNativeClose"
  >
    <article>
      <header>
        <!-- The card's title is the button's own name, not a second sentence: the
             dialog is the walk that button starts, and a title this file spelled
             would be one more string to drift. -->
        <h2 id="wizard-title" class="settings-title">{{ SET_ME_UP_LABEL }}</h2>
        <!-- The header line: whose reasoning the wizard spends and on what — the
             agent, its server and its model, present on every page from the
             moment the dialog opens (§5). Three names and no number: nothing in
             this dialog shows a token count, a cost or a timing. -->
        <p v-if="header" class="caption wizard-header">{{ header }}</p>
      </header>

      <div class="wizard-body">
        <!-- The step in flight, as one status line — never a token stream: the
             wizard's two calls are non-streaming by construction (§5). It sits at
             the top of the page area, so a page that is still waiting says so in
             the place its answer will arrive. -->
        <p v-if="waiting" class="caption wizard-waiting" role="status">{{ waiting }}</p>

        <!-- Page 1 — choose. The same page for both families; only the list's
             source differs, and the rows above render whichever payload arrived.
             The list scrolls; nothing else on the page does. -->
        <ul
          v-if="state.page === PAGE_CHOOSE"
          class="wizard-candidates"
          aria-label="Candidates"
        >
          <li v-for="row in candidateRows" :key="row.candidate.id">
            <!-- A toggle button, because choosing is the action: the row is the
                 target, and `aria-pressed` is the one selection state it carries.
                 Tab walks the list and Enter or Space chooses, which is the
                 keyboard contract a plain button already has. -->
            <button
              type="button"
              class="wizard-candidate"
              data-wizard-focus
              :aria-pressed="row.chosen ? 'true' : 'false'"
              @click="choose(row)"
            >
              <span class="wizard-candidate-name">{{ row.name }}</span>
              <!-- The one line under the name: what the connector is good for
                   (catalogue) or the evidence the proposal rests on (LSP). -->
              <span v-if="row.line" class="caption wizard-candidate-line">
                {{ row.line }}
              </span>
            </button>
          </li>
        </ul>

        <!-- Page 2 — prepare. The complete member this machine and this folder
             get, then the readiness pair, the install line when something has to
             be installed, the per-platform lines where they differ, and one
             decision line each — so the reasoning that shaped the member is
             visible rather than summarised away. -->
        <section
          v-else-if="state.page === PAGE_PREPARE"
          class="wizard-page wizard-page--prepare"
        >
          <!-- The complete member, every resolved value inside it. -->
          <pre v-if="memberJson" class="wizard-member"><code>{{ memberJson }}</code></pre>

          <!-- The readiness pair, with the line that has to be run beside it.
               A `not installed` candidate is present and flagged here, never
               dropped (§7) — and the hand-over only ever fills the draft. -->
          <p v-if="readiness || installText" class="wizard-install">
            <span v-if="readiness" class="wizard-readiness">{{ readiness }}</span>
            <code v-if="installText" class="wizard-install-line">{{ installText }}</code>
            <button
              v-if="!installButton.disabled"
              class="secondary contrast wizard-hand-over"
              type="button"
              :aria-label="installButton.label"
              :title="installButton.label"
              @click="handOver"
            >
              {{ installButton.label }}
            </button>
          </p>

          <!-- The lines that differ per platform, so a Windows user is not handed
               a POSIX command with no way of knowing. -->
          <ul v-if="platformLines.length > 1" class="wizard-lines wizard-platform-lines">
            <li v-for="row in platformLines" :key="row.platform" class="caption">
              {{ row.platform }}: {{ row.line }}
            </li>
          </ul>

          <!-- What the loader says about this member — the same words the panel
               would show after a restart, so a refusal is read *here* rather than
               after one. -->
          <p v-if="verdict" class="caption wizard-verdict">{{ verdict }}</p>
          <ul v-if="verdictNoteLines.length" class="wizard-lines wizard-notes">
            <li v-for="line in verdictNoteLines" :key="line" class="caption">
              {{ line }}
            </li>
          </ul>

          <!-- Anything platform- or project-specific the member had to decide,
               one line each. -->
          <ul v-if="decisions.length" class="wizard-lines wizard-decisions">
            <li v-for="line in decisions" :key="line" class="caption">{{ line }}</li>
          </ul>
        </section>

        <!-- Page 3 — apply. The member **verbatim** in a read-only block, the copy
             action as the primary button, and beside it the loader's verdict, the
             duplicate-id warning, the value warning, the declaration file's
             absolute path, and the restart sentence. -->
        <section
          v-else-if="state.page === PAGE_APPLY"
          class="wizard-page wizard-page--apply"
        >
          <!-- Text, not markup: the block is exactly the member the payload
               returned, which is what the user pastes. -->
          <pre class="wizard-snippet"><code>{{ member }}</code></pre>

          <div class="wizard-primary">
            <button
              type="button"
              class="wizard-copy"
              data-wizard-focus
              :disabled="copyButton.disabled"
              :aria-label="copyButton.label"
              :title="copyButton.label"
              @click="copyMember"
            >
              {{ copyButton.label }}
            </button>
          </div>

          <p v-if="verdict" class="caption wizard-verdict">{{ verdict }}</p>
          <ul v-if="verdictNoteLines.length" class="wizard-lines wizard-notes">
            <li v-for="line in verdictNoteLines" :key="line" class="caption">
              {{ line }}
            </li>
          </ul>
          <p v-if="duplicate" class="caption wizard-warning">{{ duplicate }}</p>
          <p v-if="valueWarning" class="caption wizard-warning">{{ valueWarning }}</p>

          <!-- The absolute path of the declaration file this member belongs in —
               from the payload, never spelled here. -->
          <p v-if="state.declarationPath" class="wizard-path">
            <span class="caption">Declaration file</span>
            <code>{{ state.declarationPath }}</code>
          </p>

          <!-- A file that does not exist yet: the sentence names the path to
               create, and the block above is still a **member**, never a whole
               file (AC-19). -->
          <p v-if="missingFile" class="caption wizard-missing">{{ missingFile }}</p>

          <!-- The app reads a declaration only at start-up, so a restart is what
               applies the member — the panel's own button, not one of ours. -->
          <p class="caption wizard-restart">{{ restart }}</p>
        </section>
      </div>

      <footer class="settings-actions wizard-actions">
        <!-- The dialog's **one** message: the failure, the stop, a read's own
             sentence, or a note — its text and its role are the composable's
             answer, so nothing competing with it is assembled here. -->
        <p class="wizard-message" :role="message.role">{{ message.text }}</p>
        <!-- A failed step is answered by pressing again: one more attempt at that
             step, and nothing else. -->
        <button
          v-if="state.failure && !state.loading"
          class="secondary contrast wizard-retry"
          type="button"
          @click="pressAgain"
        >
          Try again
        </button>
        <button
          class="secondary contrast wizard-close"
          type="button"
          @click="closeDialog"
        >
          Close
        </button>
        <!-- Page 3 holds no "continue": everything it prints came with the
             prepared answer, so there is nothing further to ask for. Neither
             does the stop, which is the end of the road rather than a page with
             nothing chosen yet. -->
        <button
          v-if="state.page !== PAGE_APPLY && !stopped"
          type="button"
          class="wizard-continue"
          data-wizard-focus
          :disabled="continueButton.disabled"
          :aria-label="continueButton.label"
          :title="continueButton.label"
          @click="nextPage"
        >
          Continue
        </button>
      </footer>
    </article>
  </dialog>
</template>
