<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import {
  NO_MODEL_LABEL,
  addSlotFor,
  closeConfirmationFor,
  closeWouldLoseForDraft,
  creationActiveFor,
  creationFormFor,
  deleteAgent,
  deleteConfirmationFor,
  deleteSlotFor,
  entryProblems,
  fetchAgentDraft,
  fieldsDisabledFor,
  idEditableFor,
  messageFor,
  modelChoices,
  modelLineFor,
  personaByteCount,
  rebaselinedDraft,
  saveAgent,
  saveRefusalFor,
  saveSlotFor,
  slugForDraft,
  tabCaptionFor,
  successorAfterDelete,
  useAgentModes,
} from '../composables/useAgentModes'
import { useAppShell } from '../composables/useAppShell'

// The agent-list editor: one card that edits the installation's `agents` rows
// the way SettingsDialog edits the servers and models — a toolbar of verbs above
// the list it acts on, one form per agent, the caps enforced on the way in.
//
// It decides **nothing**. Every rule this card renders is a plain function from
// `useAgentModes`: the slug, the byte counter, each toolbar slot's inertness and
// the one word that is both its accessible name and its tooltip, the save
// refusal, the card's **one message** (`messageFor`, D11), the creation form's
// shape, the model line. The component only turns those answers into fields and
// buttons, so a rule cannot drift from the dialog that shows it — and no cap is
// spelled here, because every number arrives in the payload's `caps`. No message
// is assembled in the template, and the line renders text only.
//
// **The list is the selection, and the selection is the edit mode** (D2): a row
// click shows that agent's form and the toolbar acts on it; there is no Edit
// button and no mode to enter. Each agent's form is held per entry, so selecting
// another row never discards what was typed in the one left behind.
//
// **A new agent is a form, not a row** (D4): `+` clears the selection, empties
// the form through `creationFormFor` and focuses Label, and writes nothing. The
// list keeps showing exactly what the store holds; the agent joins it only when
// a save succeeds. Clicking a row ends that state by design, without asking.
//
// **`readonly` is data, never an id.** The fields of an app-owned agent render
// disabled, but this file never compares an agent id: the flag the server
// publishes is the whole answer (and a test scans `web/src` to keep it that way).
//
// It opens the way the other cards open (watch + showModal + backdrop click +
// native-close sync, the SettingsDialog / RegistrationMemoryDlg / BatchModeDialog
// pattern), and reuses their two-column shape: the list beside the editor column,
// one row per agent the **store** holds, in the order it holds them.

const props = defineProps({
  open: { type: Boolean, default: false },
  // The agent the composer's dropdown currently holds, passed in so the card
  // opens on that agent's tab. Only a preference: an id the list does not hold
  // falls through to the first agent, which is the landing rule.
  initialMode: { type: String, default: null },
})
const emit = defineEmits(['close'])

const { editor } = useAgentModes()
// The model dropdown's contents are the *connection* store's rows, which the
// Settings dialog already reads. Sharing the singleton rather than fetching a
// second time is what keeps the two dialogs naming one catalogue.
const { state: shell, loadServers } = useAppShell()

const dialogEl = ref(null)
const draft = ref(null)
const activeTab = ref(null) // the shown section's key: a stored row's id, or NEW_TAB
const creation = ref(null) // the form being typed for an agent the store does not hold (D4)
const pendingDelete = ref(null) // the entry whose Delete awaits its confirm
const pendingClose = ref(false) // `Close` was asked while the card holds unsaved work (D8)

//: The creation form's section key. It is a *section* key and never an agent id:
//: a new agent has no id the client owns until the store answers for it (D4), and
//: the id typed into the form is the slug of whatever is typed — which may well be
//: the id of a row that already exists. So the key is spelled with a character the
//: payload's id pattern cannot produce, and the two sections can never collide.
const NEW_TAB = '#new'

// The draft is this dialog's state, not the singleton's: a card that reads a
// damaged store must leave the composer's dropdown exactly as it was.
const loaded = computed(() => draft.value !== null)
const entries = computed(() => draft.value?.entries ?? [])
const selectedEntry = computed(
  () => entries.value.find((entry) => entry.id === activeTab.value) ?? null,
)
//: Creation mode, read through the composable's verdict: a form is held that has
//: no row (D4). It is the card's only reading of that state.
const creating = computed(() => creationActiveFor(creation.value))
//: The entry every control acts on: the form being typed while there is one, the
//: selected row otherwise. "Nothing selected" stays **two** states (§5): creation
//: mode has this form for Save to write, a list that came back empty has nothing.
const subject = computed(() => creation.value ?? selectedEntry.value)
//: The sections to render: the store's rows, plus the creation form while one is
//: held. A new agent is not an entry of the list until a save succeeds (D4), so
//: the list above never gains a row for something that does not exist.
const formEntries = computed(() =>
  creation.value ? [...entries.value, creation.value] : entries.value,
)
const groups = computed(() => modelChoices(shell.servers))

//: The one context every slot verdict reads, so the three verbs cannot disagree
//: about the state they are rendered in.
const slotContext = computed(() => ({
  loaded: loaded.value,
  creating: creating.value,
  saving: editor.saving,
  confirming: pendingDelete.value !== null,
  closing: pendingClose.value,
}))

//: The toolbar's slots, each one verdict: inert or not, and the single string that
//: is both its accessible name and its tooltip (§6.16). The card renders answers —
//: no verb's availability is spelled here (D1, §5's closing rule).
const addSlot = computed(() => addSlotFor(slotContext.value))
const saveSlot = computed(() => saveSlotFor(subject.value, slotContext.value))

//: **delete** — the toolbar's third slot, and the verb's subject is the card's
//: subject: a stored, deletable row or nothing. The reason a disabled slot gives
//: (nojae owns it / nothing is stored to delete / a write is in flight) is part of
//: the same verdict, so the tooltip cannot disagree with the enablement (D1, §6.10)
//: and this file never reads a flag of its own.
const deleteSlot = computed(() => deleteSlotFor(subject.value, slotContext.value))

//: The row a pending confirmation is about, and the pair's verdict. The pair is
//: **absent from the DOM** until that verdict says `rendered` (§6.17) — not hidden,
//: so it is neither focusable nor announced while it means nothing. Its two
//: tooltips are the whole question and its two answers (Q7): no sentence is added
//: anywhere, and a write in flight makes the pair inert rather than queueing it (§8).
const pendingEntry = computed(
  () => entries.value.find((entry) => entry.id === pendingDelete.value) ?? null,
)
const deleteConfirmation = computed(() =>
  deleteConfirmationFor(pendingEntry.value, slotContext.value),
)

//: **Would closing lose something?** (D8) — the guard's only question, answered by
//: the composable over every form the card holds plus creation mode. It is read
//: once, when `Close` is asked, and it is *never* consulted by the save slot: the
//: baseline exists for this question alone (Q2), which is why re-saving an untouched
//: agent stays allowed.
const unsavedWork = computed(() =>
  closeWouldLoseForDraft(draft.value, { creating: creating.value }),
)

//: The footer's close pair (D8): the same idiom as the delete pair, in the footer's
//: **reserved** slot, and **absent from the DOM** until a close is being confirmed
//: (§6.17). Its two tooltips are the two answers, and each glyph's tooltip is its
//: accessible name — one value read as both, so they cannot drift (§6.16).
const closeConfirmation = computed(() => closeConfirmationFor(slotContext.value))

//: The card's **one message** (D11): everything it has to say comes out of here,
//: with the role that announces it. The line is always rendered, so an empty
//: `text` is a slot holding nothing rather than a slot that is gone.
const message = computed(() => messageFor(draft.value, subject.value))

// Open/fetch/close, following the SettingsDialog pattern. Opening *is* the read:
// agents are uncached on purpose (the store is the cache, D11), so a card that
// has been open for ten minutes knows it.
//
// `immediate` because the pencil mounts this card with `open` already true (the
// composer holds the flag): a watch that only fires on a *change* would leave a
// card mounted while open never reading the list.
watch(
  () => [props.open, editor.loading],
  async () => {
    await nextTick()
    const dialog = dialogEl.value
    if (!dialog) return
    if (props.open && !dialog.open) {
      dialog.showModal()
      if (!loaded.value) await openList()
    } else if (!props.open && dialog.open) {
      dialog.close()
    }
  },
  { immediate: true },
)

async function openList() {
  creation.value = null
  pendingDelete.value = null
  pendingClose.value = false
  // The models the dropdown offers, from the connection store's own read. A
  // failure is not this card's to report: an empty catalogue simply means every
  // model option is the empty one. Re-read every time the card opens, because a
  // model may have been added since.
  loadServers()
  draft.value = await fetchAgentDraft()
  const opened = draft.value
  if (!opened) return
  // The landing rule: the composer's current agent when the list holds it, and
  // otherwise the first agent — which is the fallback the card always had.
  const chosen = opened.entries.find((entry) => entry.id === props.initialMode)
  activeTab.value = tabKeyFor(chosen ?? opened.entries[0] ?? null)
}

//: Which section a form is rendered under: a stored row's own id, or the card's
//: key for the creation form — because the id typed into that form is nobody's
//: key until the store answers for it (D4), and it may well be the slug of a row
//: that already exists.
function tabKeyFor(entry) {
  if (!entry) return null
  return entry === creation.value ? NEW_TAB : entry.id
}

// **Escape and a backdrop click count as `Close` in every respect** (D8), so they
// take the same guard — otherwise they would be a silent bypass of it. The backdrop
// therefore never calls `dialog.close()` itself: it asks, and only a guard that has
// nothing to ask lets the card go.
function onBackdropClick(event) {
  if (event.target === dialogEl.value) askClose()
}

// **Escape is `Close` in every respect** (D8), so it takes the same guard. The
// `<dialog>`'s own Escape path is the cancelable `cancel` event, so it is always
// cancelled here and routed through the same verb the button uses: with nothing
// unsaved that closes the card, with unsaved work it asks. Leaving the native path
// alone would be the silent bypass D8 names, and it is why the pencil's `@close`
// can never be reached while a close confirmation is pending — nothing closes in
// that state by any route.
function onEscape(event) {
  event?.preventDefault?.()
  askClose()
}

// The card going away, whichever way it went: the pencil owns the flag, so this
// only tells it. A close the guard is asking about never gets here.
function onNativeClose() {
  if (props.open) emit('close')
}

//: `Close` is the card's only way out and it writes nothing. **While the card holds
//: unsaved work it asks first, in place** (D8): the delete confirmation's idiom
//: arrives in the footer's reserved slot, no sentence is added, no dialog is nested,
//: and `Close` does not move. A pending delete is **abandoned** here — nothing was
//: written for it — and the guard answers on its own terms.
function askClose() {
  pendingDelete.value = null
  if (!unsavedWork.value) {
    closeCard()
    return
  }
  pendingClose.value = true
  // Focus lands on **`Keep editing`** — the safe answer — the same way the delete
  // pair lands on its cancel, so a keyboard user is told what a pointer user reads.
  nextTick(() => dialogEl.value?.querySelector('.agent-modes-keep-editing')?.focus())
}

//: `Keep editing`: hide the pair and change **nothing** else — not the selection,
//: not the form, not a keystroke (§6.12's rule for the other pair).
function dismissClose() {
  pendingClose.value = false
}

//: Leaving: `Discard and close` and an unguarded `Close` are the same act, and it
//: writes **nothing** — it drops the in-memory forms only, resets no store row and
//: posts no route. The card's own state goes with it, so a re-open reads the store
//: afresh.
function closeCard() {
  pendingDelete.value = null
  pendingClose.value = false
  creation.value = null
  draft.value = null
  emit('close')
}

//: Add (D4): the selection clears, the form empties through the composable's own
//: shape, focus lands on Label, and **nothing is written**. The list gains no row
//: — a new agent is not an entry until a save succeeds.
async function addAgent() {
  if (addSlot.value.disabled) return
  creation.value = creationFormFor(draft.value)
  // The shown section is the creation form's, which is **not** any row's key — so
  // no row carries the selected mark, and that is the whole signal D4 asks for.
  activeTab.value = NEW_TAB
  await focusSection()
}

//: Select a row (D2): that agent's form is shown, and the toolbar acts on it.
//: Clicking any row ends creation mode **by design** (D4.7) — nothing was
//: written, so nothing needs confirming, and the agent clicked is shown instead.
function selectEntry(entry) {
  creation.value = null
  activeTab.value = tabKeyFor(entry)
  // A pending delete is **abandoned** by the selection moving (D7.6, §6.14): the
  // destructive action never survives the row it was asked for changing its mark.
  pendingDelete.value = null
}

//: Focus what the user is about to type into: the first live field of the section
//: now shown. `v-show` keeps every section in the DOM, so the query is scoped to
//: the shown one — otherwise a new agent would focus the *first* row's Label.
async function focusSection() {
  await nextTick()
  const section = [...(dialogEl.value?.querySelectorAll('section[data-tab]') ?? [])].find(
    (node) => node.dataset.tab === activeTab.value,
  )
  section
    ?.querySelector('input:not([disabled]), textarea:not([disabled]), select:not([disabled])')
    ?.focus()
}

// A new agent's id follows its Label field until the user edits it by hand: the
// slug is the composable's rule, and an id typed here is judged by the same one.
function onLabelChange(entry) {
  if (!idEditableFor(entry)) return
  entry.id = slugForDraft(draft.value, entry.label)
}

function problemsOn(entry) {
  return loaded.value ? entryProblems(draft.value, entry) : []
}

function fieldsLocked(entry) {
  return fieldsDisabledFor(entry) || editor.saving
}

function modelLine(entry) {
  return modelLineFor(entry, shell.servers)
}

//: Delete (D7): the toolbar's verb, asked by the click and answered by the pair at
//: that toolbar's right end. The offer and its refusal reason are the composable's
//: answer for the card's subject, so nothing here reads a flag or names an agent:
//: `readonly` and `deletable` are the whole vocabulary.
async function askDelete() {
  if (deleteSlot.value.disabled) return
  pendingDelete.value = subject.value.id
  // Focus lands on **Cancel** — the safe answer — so a keyboard user is told what
  // a pointer user reads in the tooltip. The pair is in the DOM by now, because
  // `deleteConfirmationFor` reads this same state.
  await nextTick()
  dialogEl.value?.querySelector('.agent-modes-cancel-delete')?.focus()
}

//: Cancel (D7.4, Q4): hide the pair and change **nothing** else. Nothing was
//: written, so there is nothing to restore — the selection stays, the form stays,
//: and everything typed in it stays (§6.12).
function dismissDelete() {
  pendingDelete.value = null
}

//: Confirm (D7.5): delete the selected agent, re-baseline on the whole answer the
//: store sent back, and select the **successor** — the next row in the order the
//: list had while the deleted row was still in it, else the previous one, else
//: nothing. That ordering is `successorAfterDelete`'s rule and is read *before* the
//: answer replaces the list, so the card derives no order of its own.
async function confirmDelete() {
  const entry = pendingEntry.value
  if (!entry) return
  const successor = successorAfterDelete(entries.value, entry)
  pendingDelete.value = null
  const next = await deleteAgent(entry)
  if (!next) return // the reason is in the card's message line
  draft.value = next
  // The successor by id in the re-baselined list — and when the list came back
  // empty there is no row to select, so the card holds no selection.
  activeTab.value = tabKeyFor(
    successor ? (entries.value.find((row) => row.id === successor.id) ?? null) : null,
  )
}

// Save **one** agent — the subject, and only it: the form being typed when a new
// agent is being created, the selected row otherwise. There is no "save all".
//
// A successful save does **not** close the card (D6): the answer is the whole new
// list, so the card re-baselines on it, keeps the saved agent selected, and
// leaves every other agent's typed edits exactly as they were. A new agent's row
// appears in the list for the first time here, selected.
//
// An incomplete form is **refused here, not prevented**: the slot is live, the
// click consults `saveRefusalFor`, and on a refusal nothing is posted. The
// message line already says the sentence — it is derived from the form, so it
// reads the same before the click and after it (D11).
async function save() {
  const entry = subject.value
  if (saveSlot.value.disabled) return
  if (saveRefusalFor(draft.value, entry)) return
  const wasCreation = creating.value
  const savedId = entry.id
  const held = draft.value
  const next = await saveAgent(entry)
  if (!next) return // a refusal keeps the card open, its sentence in the line
  if (wasCreation) creation.value = null // the creation is over: it is a row now
  // The answer re-baselines the list, and only the agent this write touched
  // loses its typed state — every other agent keeps what the user typed in it.
  draft.value = rebaselinedDraft(next, held, savedId)
  // Keep the saved agent selected — for a new one, that is the first time it has
  // a row at all (D4.6).
  activeTab.value = tabKeyFor(
    entries.value.find((row) => row.id === savedId) ?? entries.value[0] ?? null,
  )
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="agent-modes-dialog"
    aria-labelledby="agent-modes-title"
    @click="onBackdropClick"
    @cancel="onEscape"
    @close="onNativeClose"
  >
    <article>
      <header>
        <!-- D9: the title is `Agents` in **every** state — nothing selected,
             creation mode, a confirmation pending — and the dialog's accessible
             name follows it. It is never restyled into a word that describes what
             the card is currently doing (D4.4), because wording that comes and
             goes is a layout change. -->
        <h2 id="agent-modes-title" class="settings-title">Agents</h2>
      </header>

      <!-- The card renders its body even with no draft (a read that failed, or
           one still in flight): there is then nothing to edit, and the one
           message line below is what the card says instead (D11). It is not
           `v-if`'d away, because the line has to be there to say so. -->
      <form class="settings-form agent-modes-form" @submit.prevent>
        <div class="settings-body agent-modes-body">
          <!-- The body's four parts, placed in the grid by `theme.css`: the
               heading, the toolbar and the list down the left column, the form
               spanning the toolbar's row and the list's (§3). -->
          <!-- D4.4 / D9: the heading above the toolbar reads `Agents` in **every**
               state — including creation mode — and never becomes a word that
               describes what the card is doing. It is not the dialog's accessible
               name (that follows the title above), so the two can say the same
               thing without one naming the card twice. -->
          <h3 class="agent-modes-heading">Agents</h3>

          <!-- **Five fixed-width slots**, not a flex row that grows (D1): add,
               save, delete at the left, the confirmation pair's two at the right
               end — just left of the form. Every slot keeps its width whether or
               not it holds a button, so revealing a pair moves nothing and the
               toolbar never changes height (D10): the delete verb is always in its
               slot (disabled with its reason, never hidden), and the pair arrives in
               slots whose width was already reserved, so the three verbs do not move
               by a pixel when it does (§6.11). -->
          <div class="agent-modes-toolbar" role="group" aria-label="Agent actions">
            <span class="agent-modes-slot">
              <button
                class="icon-btn agent-modes-add"
                type="button"
                :disabled="addSlot.disabled"
                :aria-label="addSlot.label"
                :title="addSlot.label"
                @click="addAgent"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round"
                  stroke-linejoin="round" aria-hidden="true">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </button>
            </span>
            <span class="agent-modes-slot">
              <button
                class="icon-btn agent-modes-save"
                type="button"
                :disabled="saveSlot.disabled"
                :aria-label="saveSlot.label"
                :title="saveSlot.label"
                @click="save"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round"
                  stroke-linejoin="round" aria-hidden="true">
                  <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
                  <path d="M17 21v-8H7v8" />
                  <path d="M7 3v5h8" />
                </svg>
              </button>
            </span>
            <span class="agent-modes-slot">
              <button
                class="icon-btn agent-modes-delete"
                type="button"
                :disabled="deleteSlot.disabled"
                :aria-label="deleteSlot.label"
                :title="deleteSlot.label"
                @click="askDelete"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round"
                  stroke-linejoin="round" aria-hidden="true">
                  <path d="M3 6h18" />
                  <path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                </svg>
              </button>
            </span>
            <span class="agent-modes-toolbar-space"></span>
            <!-- The confirmation pair (D7): **not rendered at all** until a delete
                 is being confirmed (§6.17), so it is neither focusable nor announced
                 before it means something. The two glyphs and their tooltips are the
                 whole question and its two answers (Q7) — no sentence, no agent
                 label, no caption is added anywhere, because the toolbar's height is
                 fixed and the pair's slots were already reserved (D10, §6.11). -->
            <span class="agent-modes-slot">
              <button
                v-if="deleteConfirmation.rendered"
                class="icon-btn agent-modes-cancel agent-modes-cancel-delete"
                type="button"
                :disabled="deleteConfirmation.cancel.disabled"
                :aria-label="deleteConfirmation.cancel.label"
                :title="deleteConfirmation.cancel.label"
                @click="dismissDelete"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round"
                  stroke-linejoin="round" aria-hidden="true">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </span>
            <span class="agent-modes-slot">
              <button
                v-if="deleteConfirmation.rendered"
                class="icon-btn agent-modes-confirm agent-modes-confirm-delete"
                type="button"
                :disabled="deleteConfirmation.confirm.disabled"
                :aria-label="deleteConfirmation.confirm.label"
                :title="deleteConfirmation.confirm.label"
                @click="confirmDelete"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round"
                  stroke-linejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </button>
            </span>
          </div>

          <nav class="settings-nav agent-modes-nav" aria-label="Agent modes">
            <ul>
              <li v-for="entry in entries" :key="entry.id">
                <button
                  type="button"
                  :class="{
                    'agent-modes-tab': true,
                    active: activeTab === entry.id,
                    'agent-modes-tab--broken': problemsOn(entry).length > 0,
                  }"
                  :aria-current="activeTab === entry.id ? 'true' : undefined"
                  @click="selectEntry(entry)"
                >
                  {{ tabCaptionFor(entry) }}
                </button>
              </li>
            </ul>
          </nav>

          <!-- The right column: one form per agent, held per entry so switching
               rows never discards what was typed (§6.18). It carries no caption
               line and no per-field message (§3): everything the card has to say
               is in the message line below (D11). The creation form is the last
               of these sections and the only one shown while a new agent is being
               typed — the list above gains no row for it (D4). -->
          <div class="settings-editor agent-modes-editor">
            <section
              v-for="entry in formEntries"
              :key="tabKeyFor(entry)"
              :data-tab="tabKeyFor(entry)"
              v-show="activeTab === tabKeyFor(entry)"
            >
              <!-- The two short fields share the section's first row: Label on the
                   left, Max tool iterations on the right, so the persona textarea
                   starts higher up the column. -->
              <div class="agent-modes-fields-row">
                <label>
                  Label
                  <input
                    v-model="entry.label"
                    type="text"
                    spellcheck="false"
                    autocomplete="off"
                    :disabled="fieldsLocked(entry)"
                    @change="onLabelChange(entry)"
                  />
                </label>

                <label>
                  Max tool iterations
                  <input
                    v-model.number="entry.maxToolIteration"
                    type="number"
                    :min="draft.caps.minToolIteration ?? null"
                    :disabled="fieldsLocked(entry)"
                  />
                </label>
              </div>

              <!-- The id: a field only while the agent is **new**, where the
                   slug the Label generated can still be corrected. An existing
                   row's id is immutable (a rename would orphan the sessions that
                   name it) and names nothing the user acts on, so it is not
                   shown — the tab is captioned by the Label, and the room is
                   better spent on the fields that can be edited. -->
              <label v-if="idEditableFor(entry)">
                Id
                <input
                  v-model="entry.id"
                  type="text"
                  spellcheck="false"
                  autocomplete="off"
                  :disabled="fieldsLocked(entry)"
                />
              </label>

              <div class="agent-modes-switches">
                <label class="agent-modes-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    v-model="entry.mcpEnable"
                    :disabled="fieldsLocked(entry)"
                  />
                  MCP tools
                </label>
                <label class="agent-modes-switch">
                  <input
                    type="checkbox"
                    role="switch"
                    v-model="entry.lspEnable"
                    :disabled="fieldsLocked(entry)"
                  />
                  LSP tools
                </label>
              </div>

              <label>
                System prompt
                <textarea
                  v-model="entry.personaText"
                  rows="8"
                  spellcheck="false"
                  :disabled="fieldsLocked(entry)"
                  placeholder="Leave empty to use the model's own system prompt."
                ></textarea>
              </label>
              <p class="caption agent-modes-persona-count">
                {{ personaByteCount(entry.personaText) }} / {{ draft.caps.maxPersonaBytes ?? '—' }} bytes
              </p>

              <!-- The model: live for **every** agent, a `readonly` one
                   included, because it is the one field of those rows the user
                   owns. No "use the default" entry — there is no default (D5) —
                   so the empty option is an explicit, legal choice with a
                   visible cost. -->
              <label>
                Model
                <select v-model.number="entry.modelId" :disabled="editor.saving">
                  <option :value="null">{{ NO_MODEL_LABEL }}</option>
                  <optgroup
                    v-for="group in groups"
                    :key="group.server"
                    :label="group.server"
                  >
                    <option
                      v-for="model in group.models"
                      :key="model.id"
                      :value="model.id"
                    >
                      {{ model.name }}
                    </option>
                  </optgroup>
                </select>
              </label>
              <p class="caption agent-modes-model-line">{{ modelLine(entry) }}</p>

              <!-- The form holds **no verb**: Delete is the toolbar's (D7), and the
                   in-place confirm and the refusal caption that used to sit here are
                   gone with it — the refusal's wording survives in the slot's tooltip
                   (D1), and a delete the store refuses is said in the message line
                   (D11). The model line above is the last field of a section. -->
            </section>
          </div>
        </div>

        <footer class="settings-actions">
          <!-- **The card's one message** (D11): always present, on the same band
               as the buttons, its text and its role both `messageFor`'s answer.
               Nothing else in the card says anything. -->
          <p class="agent-modes-message" :role="message.role">{{ message.text }}</p>
          <!-- The footer's **reserved** confirmation slot (D8): always there and
               always the pair's width, so `Close` never moves when the card asks a
               question (D10). It holds the close pair and nothing else — the delete
               pair belongs to the toolbar. Both buttons are **absent from the DOM**
               until a close is pending (§6.17), so neither is focusable nor announced
               while it means nothing, and the width they arrive in was already
               reserved. The two glyphs reuse the delete pair's idiom and its colours,
               so the card teaches the pair once (D8). -->
          <span class="agent-modes-footer-slot">
            <span class="agent-modes-slot">
              <button
                v-if="closeConfirmation.rendered"
                class="icon-btn agent-modes-cancel agent-modes-keep-editing"
                type="button"
                :disabled="closeConfirmation.cancel.disabled"
                :aria-label="closeConfirmation.cancel.label"
                :title="closeConfirmation.cancel.label"
                @click="dismissClose"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round"
                  stroke-linejoin="round" aria-hidden="true">
                  <path d="M18 6 6 18" />
                  <path d="m6 6 12 12" />
                </svg>
              </button>
            </span>
            <span class="agent-modes-slot">
              <button
                v-if="closeConfirmation.rendered"
                class="icon-btn agent-modes-confirm agent-modes-discard-close"
                type="button"
                :disabled="closeConfirmation.confirm.disabled"
                :aria-label="closeConfirmation.confirm.label"
                :title="closeConfirmation.confirm.label"
                @click="closeCard"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
                  stroke="currentColor" stroke-width="2" stroke-linecap="round"
                  stroke-linejoin="round" aria-hidden="true">
                  <path d="M20 6 9 17l-5-5" />
                </svg>
              </button>
            </span>
          </span>
          <!-- `Close` is the card's only exit and it writes nothing, exactly as the
               footer's `Cancel` did — and `Save` is no longer its twin, because a
               save is a write and not an exit (D6). It asks before discarding typed
               work (D8), and Escape and a backdrop click are the same verb, so they
               take the same guard rather than bypassing it. -->
          <button class="secondary contrast agent-modes-close" type="button" @click="askClose">
            Close
          </button>
        </footer>
      </form>
    </article>
  </dialog>
</template>
