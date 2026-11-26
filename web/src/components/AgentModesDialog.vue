<script setup>
import { computed, nextTick, onScopeDispose, ref, watch } from 'vue'
import {
  AUTOSAVE_DELAY_MS,
  NO_MODEL_LABEL,
  addSlotFor,
  autoSaveTargetsFor,
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
  restoreTypedFields,
  saveAgent,
  slugForDraft,
  successorAfterDelete,
  tabCaptionFor,
  typedSnapshot,
  writeShapeFor,
  useAgentModes,
} from '../composables/useAgentModes'
import { useAppShell } from '../composables/useAppShell'

// The agent-list editor: one card that edits the installation's `agents` rows
// the way SettingsDialog edits the servers and models — a toolbar of verbs above
// the list it acts on, one form per agent, the caps enforced on the way in, and
// **no Save**: a form is written as soon as it stops changing.
//
// It decides **nothing**. Every rule this card renders is a plain function from
// `useAgentModes`: the slug, the byte counter, each toolbar slot's inertness and
// the one word that is both its accessible name and its tooltip, the save
// refusal (which is also auto-save's gate: an incomplete form is never posted),
// which forms a write is owed (`autoSaveTargetsFor`), the card's **one message**
// (`messageFor`), the creation form's shape, the model line. The component only
// turns those answers into fields and
// buttons, so a rule cannot drift from the dialog that shows it — and no cap is
// spelled here, because every number arrives in the payload's `caps`. No message
// is assembled in the template, and the line renders text only.
//
// **The list is the selection, and the selection is the edit mode**: a row click
// shows that agent's form and the toolbar acts on it; there is no Edit button and
// no mode to enter. Each agent's form is held per entry, so selecting another row
// never discards what was typed in the one left behind.
//
// **A new agent is a form, not a row**: `+` clears the selection, empties the
// form through `creationFormFor` and focuses Label, and writes nothing. The list
// keeps showing exactly what the store holds; the agent joins it as soon as the
// completed form has been written. Clicking a row ends that state by design.
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
const { state: shell, loadServers, loadConfig } = useAppShell()

const dialogEl = ref(null)
const draft = ref(null)
const activeTab = ref(null) // the shown section's key: a stored row's id, or NEW_TAB
const creation = ref(null) // the form being typed for an agent the store does not hold
const pendingDelete = ref(null) // the entry whose Delete awaits its confirm

//: The creation form's section key. It is a *section* key and never an agent id: a
//: new agent has no id the client owns until the store answers for it, and the id
//: typed into the form is the slug of whatever is typed — which may well be the id
//: of a row that already exists. So the key is spelled with a character the
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
//: no row. It is the card's only reading of that state.
const creating = computed(() => creationActiveFor(creation.value))
//: The entry every control acts on: the form being typed while there is one, the
//: selected row otherwise. "Nothing selected" stays **two** states: creation mode
//: has this form for the band to speak about, a list that came back empty has none.
const subject = computed(() => creation.value ?? selectedEntry.value)
//: The sections to render: the store's rows, plus the creation form while one is
//: held. A new agent is not an entry of the list until it has been written, so the
//: list above never gains a row for something that does not exist.
const formEntries = computed(() =>
  creation.value ? [...entries.value, creation.value] : entries.value,
)
const groups = computed(() => modelChoices(shell.servers))

//: The one context every slot verdict reads, so the two verbs cannot disagree about
//: the state they are rendered in.
const slotContext = computed(() => ({
  loaded: loaded.value,
  creating: creating.value,
  saving: editor.saving,
  confirming: pendingDelete.value !== null,
}))

//: The toolbar's slots, each one verdict: inert or not, and the single string that
//: is both its accessible name and its tooltip. The card renders answers — no
//: verb's availability is spelled here.
const addSlot = computed(() => addSlotFor(slotContext.value))

//: **delete** — the toolbar's second verb, and its subject is the card's subject: a
//: stored, deletable row or nothing. The reason a disabled slot gives (nojae owns
//: it / nothing is stored to delete / a write is in flight) is part of the same
//: verdict, so the tooltip cannot disagree with the enablement and this file never
//: reads a flag of its own.
const deleteSlot = computed(() => deleteSlotFor(subject.value, slotContext.value))

//: The row a pending confirmation is about, and the pair's verdict. The pair is
//: **absent from the DOM** until that verdict says `rendered` — not hidden, so it
//: is neither focusable nor announced while it means nothing. Its two tooltips are
//: the whole question and its two answers: no sentence is added anywhere, and a
//: write in flight makes the pair inert rather than queueing it.
const pendingEntry = computed(
  () => entries.value.find((entry) => entry.id === pendingDelete.value) ?? null,
)
const deleteConfirmation = computed(() =>
  deleteConfirmationFor(pendingEntry.value, slotContext.value),
)

//: The card's **one message**: everything it has to say comes out of here, with
//: the role that announces it. The line is always rendered, so an empty `text` is a
//: slot holding nothing rather than a slot that is gone.
const message = computed(() => messageFor(draft.value, subject.value))

// Open/fetch/close, following the SettingsDialog pattern. Opening *is* the read:
// agents are uncached on purpose (the store is the cache), so a card that has been
// open for ten minutes knows it.
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
//: key for the creation form — because the id typed into that form is nobody's key
//: until the store answers for it, and it may well be the slug of a row that
//: already exists.
function tabKeyFor(entry) {
  if (!entry) return null
  return entry === creation.value ? NEW_TAB : entry.id
}

// **Escape and a backdrop click count as `Close` in every respect.** Nothing here
// has to ask on the way out: a form is written as it stops changing, so the last
// thing typed has already been posted — and `closeCard` flushes what is still
// inside the debounce window, which covers a click made right after a keystroke.
function onBackdropClick(event) {
  if (event.target === dialogEl.value) closeCard()
}

// The `<dialog>`'s own Escape path is the cancelable `cancel` event, so it is
// cancelled here and routed through the same verb the button uses, which is the
// verb that flushes.
function onEscape(event) {
  event?.preventDefault?.()
  closeCard()
}

// The card going away by any native route (an in-page form, a script): the pencil
// owns the flag, and the flush rides along with it.
function onNativeClose() {
  if (props.open) closeCard()
}

//: Leaving: `Close` is the card's only exit and it asks nothing, because there is
//: no longer any work leaving would lose — the flush below makes the write that is
//: still inside the debounce window before the forms go away. The card's own state
//: goes with it, so a re-open reads the store afresh.
function closeCard() {
  pendingDelete.value = null
  flushAutoSave()
  creation.value = null
  draft.value = null
  emit('close')
}

//: Add: the selection clears, the form empties through the composable's own shape,
//: focus lands on Label, and **nothing is written**. The list gains no row — a new
//: agent is not an entry until a save succeeds.
async function addAgent() {
  if (addSlot.value.disabled) return
  creation.value = creationFormFor(draft.value)
  // The shown section is the creation form's, which is **not** any row's key — so
  // no row carries the selected mark, and that is the whole signal.
  activeTab.value = NEW_TAB
  await focusSection()
}

//: Select a row: that agent's form is shown, and the toolbar acts on it. Clicking
//: any row ends creation mode **by design** — nothing was written, so nothing needs
//: confirming, and the agent clicked is shown instead.
function selectEntry(entry) {
  creation.value = null
  activeTab.value = tabKeyFor(entry)
  // A pending delete is **abandoned** by the selection moving: the destructive
  // action never survives the row it was asked for changing its mark.
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
// `idEdited` is the creation form's provenance, so a manual correction is never
// overwritten by a later Label change (the id names sessions; it is a choice).
function onLabelChange(entry) {
  if (!idEditableFor(entry) || entry.idEdited === true) return
  entry.id = slugForDraft(draft.value, entry.label)
}

function onIdInput(entry) {
  if (idEditableFor(entry)) entry.idEdited = true
}

function problemsOn(entry) {
  return loaded.value ? entryProblems(draft.value, entry) : []
}

//: Which fields render disabled: the `readonly` half is the store's flag, and a
//: write in flight is **not** one of them — auto-save posts without being asked, so
//: locking the form on every keystroke pause would take the field away from a hand
//: that is still typing. What is typed during a write is put back over its answer.
function fieldsLocked(entry) {
  return fieldsDisabledFor(entry)
}

function modelLine(entry) {
  return modelLineFor(entry, shell.servers)
}

//: Delete: the toolbar's verb, asked by the click and answered by the pair at that
//: toolbar's right end. The offer and its refusal reason are the composable's answer
//: for the card's subject, so nothing here reads a flag or names an agent:
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

//: Cancel: hide the pair and change **nothing** else. Nothing was written, so there
//: is nothing to restore — the selection stays, the form stays, and everything typed
//: in it stays. Focus returns to the Delete verb, the one control that asked, rather
//: than dropping to the page.
async function dismissDelete() {
  pendingDelete.value = null
  await nextTick()
  dialogEl.value?.querySelector('.agent-modes-delete')?.focus()
}

//: Confirm: delete the selected agent, re-baseline on the whole answer the store
//: sent back, and select the **successor** — the next row in the order the list had
//: while the deleted row was still in it, else the previous one, else nothing. That
//: ordering is `successorAfterDelete`'s rule and is read *before* the answer
//: replaces the list, so the card derives no order of its own.
async function confirmDelete() {
  const entry = pendingEntry.value
  if (!entry) return
  const successor = successorAfterDelete(entries.value, entry)
  const held = draft.value
  pendingDelete.value = null
  const next = await deleteAgent(entry)
  if (!next) {
    // The reason is in the card's message line; focus goes back to the Delete
    // verb, which is still live for the row that was not deleted.
    await focusAfterDelete(false)
    return
  }
  // Like a save, the answer re-baselines the whole list without discarding what the
  // user typed in the agents this delete did not touch: `writtenId` is null because
  // no row here was written as a form — the deleted one is simply gone from
  // `next.entries`.
  draft.value = rebaselinedDraft(next, held, null)
  // The successor by id in the re-baselined list — and when the list came back
  // empty there is no row to select, so the card holds no selection.
  activeTab.value = tabKeyFor(
    successor ? (entries.value.find((row) => row.id === successor.id) ?? null) : null,
  )
  await focusAfterDelete(true)
}

// The pair's buttons are gone from the DOM by the time a delete lands, so focus
// is put back deliberately: the successor's tab when the delete succeeded, else
// the Delete verb, else (an empty list leaves that verb inert) the footer's
// Close — never `<body>`.
async function focusAfterDelete(preferTab) {
  await nextTick()
  const dialog = dialogEl.value
  const tab = preferTab ? dialog?.querySelector('.agent-modes-tab.active') : null
  if (tab) {
    tab.focus()
    return
  }
  const remove = dialog?.querySelector('.agent-modes-delete')
  if (remove && !remove.disabled) {
    remove.focus()
    return
  }
  dialog?.querySelector('.agent-modes-close')?.focus()
}

//: Which set of forms a write belongs to. `Close` and a teardown drop them while the
//: flush's bytes are still in flight, so an answer is applied only while the
//: generation it was posted for is the current one: the write itself always goes
//: out — that is the point of the flush — but a dead card's forms are not
//: resurrected by it.
let generation = 0

//: **The auto-save.** A form is written when it stops changing, so the card has no
//: `Save`: the entry is the record of what is typed, the baseline the record of
//: what is stored, and a write is owed wherever the two disagree
//: (`autoSaveTargetsFor`). Every owed form is written, not just the one on screen —
//: the card holds one form per agent, and typing in a row the user has left behind
//: is no less theirs.
//:
//: A form the store would refuse is **not** posted: its sentence goes to the band as
//: it always did, and the next keystroke that completes it is what gets written.
async function writeEntry(entry) {
  const wasCreation = entry === creation.value
  const savedId = entry.id
  const shape = writeShapeFor(entry)
  // What the form holds at the moment its bytes are posted: the answer re-baselines
  // that row to the store, and only what has moved on **since** this snapshot is
  // typing no write carried yet.
  const sentValues = typedSnapshot(entry)
  const held = draft.value
  posted.set(entry, shape)
  const writtenFor = generation
  const next = await saveAgent(entry)
  // The answer still fed the composer's list (the singleton took it), but a card
  // that has dropped its forms has nothing to re-baseline.
  if (!next || writtenFor !== generation) return
  if (wasCreation) creation.value = null // the creation is over: it is a row now
  // The answer re-baselines the list, and only the agent this write touched loses
  // its typed state — every other agent keeps what was typed in it.
  draft.value = rebaselinedDraft(next, held, savedId)
  // The written row itself: a keystroke made while the write was in flight is put
  // back over the answer, so no character is eaten — and because that moved value
  // differs from its fresh baseline, it is owed the next write.
  restoreTypedFields(entries.value.find((row) => row.id === savedId), entry, sentValues)
  // A write never moves the selection: auto-save can land for a row the user has
  // since left behind, and dragging them back to it would be the one thing a write
  // of their own typing must not do. The exception is a new agent, whose form had
  // no row to stay on — so its arrival is where the selection goes.
  if (wasCreation) {
    activeTab.value = tabKeyFor(entries.value.find((row) => row.id === savedId) ?? null)
  }
  // The write may have assigned or cleared this agent's model, which changes the
  // Settings band's cross-store count and, for a model added elsewhere, the
  // store-level "no model configured" line. Both are shell state read outside
  // this card, so refresh them now instead of leaving a stale sentence behind.
  await Promise.all([loadServers(), loadConfig()])
}

//: One write per shape of a form. A write the store answered without taking the
//: bytes it was sent (a row it would not create) must not be posted again on the
//: next tick — that would be a loop. A shape is remembered per posted form, so any
//: further keystroke that changes it is owed a write again.
const posted = new WeakMap()

function nextOwedEntry() {
  for (const entry of autoSaveTargetsFor(draft.value, creation.value)) {
    if (posted.get(entry) === writeShapeFor(entry)) continue
    return entry
  }
  return null
}

let autoSaveRunning = false

async function runAutoSave() {
  // A delete awaiting its answer, or a write from anywhere else: the store is not
  // free to be told about these rows **right now**, and a delete that vanished
  // because of a keystroke nobody confirmed is a question answered by the wrong
  // hand. None of it is lost — the watch below re-runs once the blocker clears.
  if (autoSaveRunning || editor.saving || pendingDelete.value) return
  autoSaveRunning = true
  try {
    // One at a time: every write answers the whole list and re-baselines it, so two
    // in flight would have the later answer overwrite the earlier one's merge.
    for (let entry = nextOwedEntry(); entry; entry = nextOwedEntry()) {
      if (pendingDelete.value) break
      await writeEntry(entry)
    }
  } finally {
    autoSaveRunning = false
  }
}

let timer = null

function scheduleAutoSave() {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => {
    timer = null
    runAutoSave()
  }, AUTOSAVE_DELAY_MS)
}

function flushAutoSave() {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  return runAutoSave()
}

// Every form the card holds: `v-show` keeps them all in the DOM, so a keystroke in
// a row the user has left behind is still a keystroke — and auto-save writes that
// row too. The creation form is watched as well: it is not part of the draft until
// the store answers for it.
watch(
  () => [draft.value?.entries, creation.value],
  scheduleAutoSave,
  { deep: true },
)

// A write that was owed but **blocked** — one still in flight, or a delete that had
// to be answered first — is owed no less once the blocker clears, so clearing it
// re-runs the schedule. Without this, a keystroke whose debounce fell inside an
// earlier write's window would never be written at all.
watch(
  () => [editor.saving, pendingDelete.value !== null],
  ([saving, confirming], [wasSaving, wasConfirming]) => {
    if ((wasSaving && !saving) || (wasConfirming && !confirming)) scheduleAutoSave()
  },
)

// A card torn down rather than closed (the pencil's `v-if`, a hot reload) is the
// same gesture that must not lose a keystroke: the owed write is made before the
// watches that make it go away.
onScopeDispose(() => {
  generation += 1
  flushAutoSave()
  if (timer) clearTimeout(timer)
})
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
        <!-- The title is `Agents` in **every** state — nothing selected, creation
             mode, a confirmation pending — and the dialog's accessible name
             follows it. It is never restyled into a word that describes what the
             card is doing, because wording that comes and goes is a layout
             change. -->
        <h2 id="agent-modes-title" class="settings-title">Agents</h2>
      </header>

      <!-- The card renders its body even with no draft (a read that failed, or
           one still in flight): there is then nothing to edit, and the one
           message line below is what the card says instead. It is not `v-if`'d
           away, because the line has to be there to say so. -->
      <form class="settings-form agent-modes-form" @submit.prevent>
        <div class="settings-body agent-modes-body">
          <!-- The body's four parts, placed in the grid by `theme.css`: the
               heading, the toolbar and the list down the left column, the form
               spanning the toolbar's row and the list's. -->
          <!-- The heading above the toolbar reads `Agents` in **every** state —
               including creation mode — and never becomes a word that describes
               what the card is doing. It is not the dialog's accessible name (that
               follows the title above), so the two can say the same thing without
               one naming the card twice. -->
          <h3 class="agent-modes-heading">Agents</h3>

          <!-- **Four fixed-width slots**, not a flex row that grows: add and delete
               at the left, the confirmation pair's two at the right end — just left
               of the form. There is no `Save`: a form is written as it stops
               changing, so the only verbs left are the ones that cannot be guessed
               at. Every slot keeps its width whether or not it holds a button, so
               revealing a pair moves nothing and the toolbar never changes height:
               the delete verb is always in its slot (disabled with its reason, never
               hidden), and the pair arrives in slots whose width was already
               reserved, so the two verbs do not move by a pixel when it does. -->
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
            <!-- The confirmation pair: **not rendered at all** until a delete is
                 being confirmed, so it is neither focusable nor announced before it
                 means something. The two glyphs and their tooltips are the whole
                 question and its two answers — no sentence, no agent label, no
                 caption is added anywhere, because the toolbar's height is fixed and
                 the pair's slots were already reserved. -->
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
               rows never discards what was typed. It carries no caption line and no
               per-field message: everything the card has to say is in the message
               line below. The creation form is the last of these sections and the
               only one shown while a new agent is being typed — the list above
               gains no row for it. -->
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
                    :maxlength="draft.caps.maxLabelChars ?? undefined"
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

              <!-- The id: a field only while the agent is **new**, where the slug
                   the Label generated can still be corrected. An existing row's id
                   is immutable (a rename would orphan the sessions that name it) and
                   names nothing the user acts on, so it is not shown — the tab is
                   captioned by the Label, and the room is better spent on the fields
                   that can be edited. -->
              <label v-if="idEditableFor(entry)">
                Id
                <input
                  v-model="entry.id"
                  type="text"
                  spellcheck="false"
                  autocomplete="off"
                  :disabled="fieldsLocked(entry)"
                  @input="onIdInput(entry)"
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

              <!-- The model: live for **every** agent, a `readonly` one included,
                   because it is the one field of those rows the user owns. No "use
                   the default" entry — there is no default — so the empty option is
                   an explicit, legal choice with a visible cost. -->
              <label>
                Model
                <!-- Never disabled: it is the one field of a `readonly` row the user
                     owns, and auto-save's writes must not interrupt a choice. -->
                <select v-model.number="entry.modelId">
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

              <!-- The form holds **no verb**: Delete is the toolbar's, and the
                   refusal's wording survives in the slot's tooltip, while a delete
                   the store refuses is said in the message line. The model line above
                   is the last field of a section. -->
            </section>
          </div>
        </div>

        <footer class="settings-actions">
          <!-- **The card's one message**: always present, on the same band as the
               buttons, its text and its role both `messageFor`'s answer. Nothing
               else in the card says anything. -->
          <p class="agent-modes-message" :role="message.role">{{ message.text }}</p>
          <!-- `Close` is the card's only verb on this band and it writes nothing of
               its own, because auto-save has written everything by the time it is
               clicked — it only flushes what is still inside the debounce window.
               Escape and a backdrop click are the same verb, so they flush too. -->
          <button class="secondary contrast agent-modes-close" type="button" @click="closeCard">
            Close
          </button>
        </footer>
      </form>
    </article>
  </dialog>
</template>
