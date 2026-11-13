<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import {
  NO_MODEL_LABEL,
  READONLY_CAPTION,
  addAgentToDraft,
  deleteAgent,
  deleteOfferedFor,
  entryProblems,
  fetchAgentDraft,
  fieldsDisabledFor,
  idEditableFor,
  modelChoices,
  modelLineFor,
  personaByteCount,
  saveAgent,
  saveDisabledFor,
  slugForDraft,
  tabCaptionFor,
  useAgentModes,
} from '../composables/useAgentModes'
import { useAppShell } from '../composables/useAppShell'

// The agent-list editor: one card that edits the installation's `agents` rows
// the way SettingsDialog edits the servers and models — one tab per agent,
// fields instead of a file, the caps enforced on the way in.
//
// It decides **nothing**. Every rule this card renders is a plain function from
// `useAgentModes`: the slug, the byte counter, the field-named problems, the
// Save verdict, the Delete offer, the model line. The component only turns those
// answers into fields, so a rule cannot drift from the dialog that shows it —
// and no cap is spelled here, because every number arrives in the payload's
// `caps`.
//
// **`readonly` is data, never an id.** The fields of an app-owned agent render
// disabled and one caption says why, but this file never compares an agent id:
// the flag the server publishes is the whole answer (and a test scans `web/src`
// to keep it that way).
//
// It opens the way the other cards open (watch + showModal + backdrop click +
// native-close sync, the SettingsDialog / RegistrationMemoryDlg / BatchModeDialog
// pattern), and reuses their two-column shape: a vertical nav beside the editor
// column, one tab per agent the **store** holds, in the order it holds them.
// The Common tab is gone — its only control edited the default agent D5 removed —
// and the app-owned agent now *has* a tab, exactly like every other row (D4).

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
const activeTab = ref(null)
const createLabel = ref('')
const pendingDelete = ref(null) // the entry whose Delete awaits its confirm
const savingEntry = ref(null) // the entry whose Save is in flight

// The draft is this dialog's state, not the singleton's: a card that reads a
// damaged store must leave the composer's dropdown exactly as it was.
const loaded = computed(() => draft.value !== null)
const entries = computed(() => draft.value?.entries ?? [])
const activeEntry = computed(
  () => entries.value.find((entry) => `entry:${entry.id}` === activeTab.value) ?? null,
)
const groups = computed(() => modelChoices(shell.servers))
const serverFindings = computed(() => editor.serverFindings)

// The one answer the Save button renders, from the composable — for the tab the
// user is looking at. A card with no active tab (nothing loaded) has no Save.
const saveBlocked = computed(() => {
  if (!loaded.value || editor.saving) return true
  return saveDisabledFor(draft.value, activeEntry.value, { saving: savingEntry.value !== null })
})

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
  createLabel.value = ''
  pendingDelete.value = null
  savingEntry.value = null
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
  activeTab.value = tabIdFor(chosen ?? opened.entries[0] ?? null)
}

function tabIdFor(entry) {
  return entry ? `entry:${entry.id}` : null
}

function onBackdropClick(event) {
  if (event.target === dialogEl.value) cancel()
}

// Esc (or a programmatic close) is Cancel: it writes nothing, so the store is
// exactly as it was and any unsaved tab is dropped.
function onNativeClose() {
  if (props.open) emit('close')
}

function cancel() {
  pendingDelete.value = null
  draft.value = null
  emit('close')
}

// Create agent: append the tab immediately and focus it. **Nothing is written**
// until that tab's own Save, because the row does not exist yet — which is the
// one thing that differs between a create and an update here.
async function createAgent() {
  if (!loaded.value || editor.saving) return
  const entry = addAgentToDraft(draft.value, createLabel.value)
  focusTab(tabIdFor(entry), true)
}

// Focus what the user is about to type into: the first live field of the
// section now shown. `v-show` keeps every section in the DOM, so the query is
// scoped to the active tab's own section — otherwise a Create would focus the
// *first* agent's Label instead of the new one's.
async function focusTab(id, focusFields = true) {
  activeTab.value = id
  await nextTick()
  if (!focusFields) return
  const key = id.slice('entry:'.length)
  const section = [...(dialogEl.value?.querySelectorAll('section[data-tab]') ?? [])].find(
    (node) => node.dataset.tab === key,
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

// The problems that name one field, placed next to it — the same "next to" the
// loader's findings had, now with a field name instead of a JSON pointer.
function fieldProblems(entry, field) {
  return problemsOn(entry).filter((problem) => problem.field === field)
}

function fieldsLocked(entry) {
  return fieldsDisabledFor(entry) || savingEntry.value !== null
}

function modelLine(entry) {
  return modelLineFor(entry, shell.servers)
}

// Delete, with a confirm. Offered for user-created agents only (D4) — the flag
// is the store's, so this card never names an agent to decide.
function askDelete(entry) {
  if (!deleteOfferedFor(entry)) return
  pendingDelete.value = entry.id
}

function dismissDelete() {
  pendingDelete.value = null
}

async function confirmDelete() {
  const entry = activeEntry.value
  if (!entry || entry.id !== pendingDelete.value) return
  pendingDelete.value = null
  const next = await deleteAgent(entry)
  if (!next) return // the reason is on the card's error line
  // The whole list came back: adopt it, drop the deleted tab, and land on the
  // first agent that is left (there is always a built-in, D4).
  draft.value = next
  activeTab.value = tabIdFor(entries.value[0] ?? null)
}

// Save one agent — this tab's, and only this one. A new row is created; an
// existing one is rewritten, and a `readonly` row sends its model alone. The
// answer is the whole new list, and it has already refreshed the composer's
// dropdown (`acceptPayload` in the composable), so a successful save closes the
// card — the write is the whole action, and a card left open would leave the
// user hunting for a second "done".
async function save() {
  const entry = activeEntry.value
  if (!entry || saveBlocked.value) return
  savingEntry.value = entry.id
  try {
    const next = await saveAgent(entry)
    if (!next) return // a refusal keeps the card open, with its sentence shown
    draft.value = next
    emit('close')
  } finally {
    savingEntry.value = null
  }
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="agent-modes-dialog"
    aria-labelledby="agent-modes-title"
    @click="onBackdropClick"
    @close="onNativeClose"
  >
    <article>
      <header>
        <h2 id="agent-modes-title" class="settings-title">Agent modes</h2>
      </header>

      <p v-if="editor.loading" class="caption" role="status">Reading the agents…</p>
      <p v-if="editor.error" class="alert-error" role="alert">{{ editor.error }}</p>

      <p v-if="draft?.findings?.length" class="alert-error agent-modes-file-findings" role="alert">
        <span v-for="finding in draft.findings" :key="finding.message" class="agent-modes-finding">
          {{ finding.message }}
        </span>
      </p>
      <p v-if="serverFindings.length" class="alert-error agent-modes-server-findings" role="alert">
        <span v-for="finding in serverFindings" :key="finding.message" class="agent-modes-finding">
          {{ finding.message }}
        </span>
      </p>

      <!-- The form is the *draft*'s rendering: with no draft (a read that
           failed, or one still in flight) there is nothing to edit, and the
           lines above are what the card says instead. -->
      <form v-if="loaded" class="settings-form agent-modes-form" @submit.prevent>
        <div class="settings-body agent-modes-body">
          <nav class="settings-nav agent-modes-nav" aria-label="Agent modes">
            <ul>
              <li v-for="entry in entries" :key="entry.id">
                <button
                  type="button"
                  :class="{
                    'agent-modes-tab': true,
                    active: activeTab === `entry:${entry.id}`,
                    'agent-modes-tab--broken': problemsOn(entry).length > 0,
                  }"
                  :aria-current="activeTab === `entry:${entry.id}` ? 'true' : undefined"
                  @click="activeTab = `entry:${entry.id}`"
                >
                  {{ tabCaptionFor(entry) }}
                </button>
              </li>
            </ul>
            <label class="agent-modes-create">
              New agent label
              <input
                v-model="createLabel"
                type="text"
                spellcheck="false"
                placeholder="Reviewer"
                autocomplete="off"
                :disabled="editor.saving"
              />
            </label>
            <button
              class="agent-modes-create-button"
              type="button"
              :disabled="editor.saving"
              @click="createAgent"
            >
              + Create agent
            </button>
          </nav>

          <div class="settings-editor agent-modes-editor">
            <section
              v-for="entry in entries"
              :key="entry.id"
              :data-tab="entry.id"
              v-show="activeTab === `entry:${entry.id}`"
            >
              <!-- A `readonly` agent: everything nojae owns is rendered but
                   disabled, the model stays live, and one caption says why. The
                   **flag** decides this, never an id (§4.4). -->
              <p v-if="entry.readonly" class="caption agent-modes-readonly">
                {{ READONLY_CAPTION }}
              </p>

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
              <p
                v-for="problem in fieldProblems(entry, 'label')"
                :key="problem.message"
                class="alert-error agent-modes-field-finding"
                role="alert"
              >
                {{ problem.message }}
              </p>

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
              <p
                v-for="problem in fieldProblems(entry, 'id')"
                :key="problem.message"
                class="alert-error agent-modes-field-finding"
                role="alert"
              >
                {{ problem.message }}
              </p>

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
              <p
                v-for="problem in fieldProblems(entry, 'systemMessage')"
                :key="problem.message"
                class="alert-error agent-modes-field-finding agent-modes-persona-finding"
                role="alert"
              >
                {{ problem.message }}
              </p>
              <p class="caption agent-modes-persona-count">
                {{ personaByteCount(entry.personaText) }} / {{ draft.caps.maxPersonaBytes ?? '—' }} bytes
              </p>

              <label>
                Max tool iterations
                <input
                  v-model.number="entry.maxToolIteration"
                  type="number"
                  :min="draft.caps.minToolIteration ?? null"
                  :disabled="fieldsLocked(entry)"
                />
              </label>
              <p
                v-for="problem in fieldProblems(entry, 'maxToolIteration')"
                :key="problem.message"
                class="alert-error agent-modes-field-finding"
                role="alert"
              >
                {{ problem.message }}
              </p>

              <!-- The model: live for **every** agent, a `readonly` one
                   included, because it is the one field of those rows the user
                   owns. No "use the default" entry — there is no default (D5) —
                   so the empty option is an explicit, legal choice with a
                   visible cost. -->
              <label>
                Model
                <select v-model.number="entry.modelId" :disabled="savingEntry !== null">
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

              <div class="agent-modes-actions">
                <!-- Delete is offered for user-created agents only; a built-in's
                     tab says so instead of offering a button that can only be
                     refused (D4, AC-11). -->
                <button
                  v-if="deleteOfferedFor(entry)"
                  class="secondary contrast agent-modes-delete-button"
                  type="button"
                  :disabled="editor.saving || entry.isNew"
                  @click="askDelete(entry)"
                >
                  Delete
                </button>
              </div>
              <div class="agent-modes-delete">
                <p v-if="!deleteOfferedFor(entry)" class="caption agent-modes-delete-refusal">
                  {{ entry.isNew ? 'Save this agent before it can be deleted.' : 'nojae owns this agent, so it cannot be deleted.' }}
                </p>
                <div v-if="pendingDelete === entry.id" class="agent-modes-delete-confirm">
                  <!-- The confirm is asked *in place*, not by a nested dialog:
                       this card is already a modal. -->
                  <button class="agent-modes-delete-yes" type="button" @click="confirmDelete">
                    Delete
                  </button>
                  <button class="secondary contrast" type="button" @click="dismissDelete">
                    Keep it
                  </button>
                </div>
              </div>
            </section>
          </div>
        </div>

        <footer class="settings-actions">
          <p
            v-if="activeEntry && problemsOn(activeEntry).length"
            class="caption agent-modes-blocking-note"
            role="status"
          >
            {{ problemsOn(activeEntry).length }} problem{{ problemsOn(activeEntry).length === 1 ? '' : 's' }}
            in this agent must be fixed before it can be saved.
          </p>
          <button class="secondary contrast" type="button" :disabled="editor.saving" @click="cancel">
            Cancel
          </button>
          <button
            class="agent-modes-save"
            type="button"
            :disabled="saveBlocked"
            @click="save"
          >
            {{ savingEntry ? 'Saving…' : 'Save' }}
          </button>
        </footer>
      </form>
    </article>
  </dialog>
</template>
