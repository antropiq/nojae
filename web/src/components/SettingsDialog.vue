<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import ApiKeyField from './ApiKeyField.vue'
import {
  SAMPLER_FIELDS,
  draftKey,
  fetchedModelIdsFor,
  fetchedModelsErrorFor,
  modelDeleteSentence,
  samplerBounds,
  serverDeleteSentence,
  unassignedLine,
  useAppShell,
} from '../composables/useAppShell'

const {
  state,
  closeSettings,
  selectServer,
  selectModel,
  addServerRow,
  addModelRow,
  saveServerDraft,
  saveModelDraft,
  deleteServerRow,
  deleteModelRow,
  toggleServerExpanded,
  fetchServerModels,
  requestAgentModes,
  toggleMcp,
  saveMcp,
  toggleLsp,
  saveLsp,
} = useAppShell()

const dialogEl = ref(null)
const activeSection = ref('models')

// The connection is one section now: the LLM fields and the sampling fields were
// two halves of **one** thing, and a model carries its own samplers, so the
// split stopped meaning anything the moment a model was a row (§5.1).
const SECTIONS = [
  { id: 'models', label: 'Models' },
  { id: 'mcp', label: 'MCP' },
  { id: 'lsp', label: 'LSP' },
]

const MCP_STATUS_CLASS = {
  running: 'green',
  starting: 'violet',
  error: 'red',
  stopped: 'gray',
}

// The sampler fields' labels. The **fields** are the composable's list (one
// authority for what a model row carries); only the words are the dialog's.
const SAMPLER_LABELS = {
  temperature: 'Temperature',
  topP: 'Top-p',
  topK: 'Top-k',
  minP: 'Min-p',
  repeatPenalty: 'Repeat penalty',
  presencePenalty: 'Presence penalty',
}

// The reasoning levels are the server's list, in the read's ``caps`` — the same
// set its request model refuses anything outside of. The empty option is the
// dialog's own, because "unset" is a choice the form has to offer and the
// server spells it with an absent value, not a word.
const reasoningLevels = computed(() => state.serversCaps?.reasoningLevels ?? [])

// The fetched listing for the server the form is editing, and the key it is
// filed under — both through the composable, so the dialog never re-derives
// which listing belongs to which row.
const fetchedIds = computed(() => fetchedModelIdsFor(state.serverDraft))

// The same listing, read where *Fetch models* was clicked. The button is on the
// server's fields and the `datalist` is on the model's, so the click alone asked
// the server a question whose answer appeared somewhere else — nothing on the
// row it was asked from ever changed. The server column therefore shows what its
// own listing holds: a saved row reads the listing filed under its id (which is
// also where a re-read files it), an unsaved one the listing under the new-row
// key.
const fetchedIdsForServer = computed(() => {
  const draft = state.serverDraft
  if (!draft) return []
  return draft.id === null
    ? fetchedModelIdsFor(draft)
    : state.fetchedModelIds[draft.id] ?? []
})

// The refusal this row's listing got, if it got one.
const fetchedError = computed(() => fetchedModelsErrorFor(state.serverDraft))

// What the server column says when its listing is empty: the fetch is in flight,
// or nothing was ever fetched. A failure is rendered as its own alert line, so
// it is not repeated here.
const fetchedIdsNote = computed(() =>
  state.fetchedModelsLoading === draftKey(state.serverDraft)
    ? 'Loading this server’s models…'
    : 'No listing yet — ask this server what it offers, then add a model by one of those names.',
)

// "2 of 4 agents have no model" — the sentence is the composable's arithmetic,
// and the line is the only thing in this dialog that speaks about the other
// store (§5.1). Clicking it opens the Agent-modes dialog, where a model is
// assigned.
const unassignedNote = computed(() => unassignedLine(state.unassigned))

// The destructive confirmations (D12). The sentences name what else goes with
// the row — a server takes its models with it, and every agent pointing at one
// is left unrunnable — because that is the part nobody can retype. The store
// keeps its own copy of the database before either delete lands.
function removeServer() {
  const server = state.servers.find((entry) => entry.id === state.selectedServerId)
  if (!server) return
  if (!window.confirm(serverDeleteSentence(server))) return
  deleteServerRow(server.id)
}

function removeModel() {
  const model = state.servers
    .flatMap((server) => server.models)
    .find((entry) => entry.id === state.selectedModelId)
  if (!model) return
  if (!window.confirm(modelDeleteSentence(model))) return
  deleteModelRow(model.id)
}

// One gate decides whether a language server runs in this workspace: the
// `enable` flag of its entry in `.nojae/lsp-settings.json`, which is what a
// tick here writes (D13). The tick used to be one of two switches that had to
// agree, so the tooltip says what it means now — and says it in the file's
// terms, because the file is the record.
const LSP_TOGGLE_TOOLTIP =
  'Run this server in this workspace: the tick is the whole decision, and it is ' +
  "saved as the entry's `enable` flag in .nojae/lsp-settings.json"

// Depends on settings too: the dialog only renders once the first fetch
// filled state.settings, which may land after settingsOpen flipped.
watch(
  () => [state.settingsOpen, state.settings],
  async () => {
    await nextTick()
    const dialog = dialogEl.value
    if (!dialog) return
    const open = state.settingsOpen && state.settings
    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  },
)

function onBackdropClick(event) {
  if (event.target === dialogEl.value) closeSettings()
}

function onNativeClose() {
  if (state.settingsOpen) closeSettings()
}

function connectorDetail(connector) {
  if (connector.description) return connector.description
  if (connector.kind === 'local') {
    return Array.isArray(connector.command) ? connector.command.join(' ') : ''
  }
  return connector.endpoint || ''
}

// Language-server row: what it handles and where it looks, then its argv
// (secrets live in `env`, which the API never sends, so this is safe text).
function serverDetail(server) {
  const scope = [
    server.extensions?.length
      ? `handles ${server.extensions.join(' ')}`
      : 'no extensions declared',
    `root: ${server.workspaceRoot || '?'}`,
  ]
  const command = Array.isArray(server.command) ? server.command.join(' ') : ''
  return [server.description, scope.join(' · '), command]
    .filter(Boolean)
    .join('\n')
}

// The app-level notice (§5.1): *no model configured*, or the store itself
// unusable. The sentence is the server's — it already names what is wrong — so
// the dialog shows it verbatim: it adds nothing and translates nothing.
const storeNotice = computed(() => {
  if (!state.storeState) return null
  if (!state.storeState.usable) return state.storeState.sentence || null
  if (!(state.config?.models ?? []).length) {
    return 'No model is configured yet. Add a server and a model under it, then ' +
      'assign one to the agent you use.'
  }
  return null
})
</script>

<template>
  <dialog
    v-if="state.settings"
    ref="dialogEl"
    class="settings-dialog"
    aria-labelledby="settings-title"
    @click="onBackdropClick"
    @close="onNativeClose"
  >
    <article>
    <header>
      <h2 id="settings-title" class="settings-title">Settings</h2>
    </header>
    <p v-if="state.settingsError" class="alert-error" role="alert">
      {{ state.settingsError }}
    </p>

    <form class="settings-form" @submit.prevent>
      <nav class="settings-nav" aria-label="Settings sections">
        <ul>
          <li v-for="section in SECTIONS" :key="section.id">
            <button
              type="button"
              :class="{ active: activeSection === section.id }"
              :aria-current="activeSection === section.id ? 'true' : undefined"
              @click="activeSection = section.id"
            >
              {{ section.label }}
            </button>
          </li>
        </ul>
      </nav>

      <div class="settings-body">
        <div class="settings-editor">
          <!-- The Models section (§5.1): the store's servers on the left, each
               expandable to its own models, and the selected row's fields on the
               right. It is the old LLM and Sampling sections merged, because a
               model carries its own samplers — the split only made sense while
               there was one connection and one model.

               No model is marked as special anywhere in here: which agent runs on
               which model is the agent's own field, and the question is asked in
               the Agent-modes dialog (D5). What this section says about that is
               the one quiet line below. -->
          <section v-show="activeSection === 'models'" class="settings-models">
            <h3 class="settings-section-title">Models</h3>
            <p v-if="storeNotice" class="caption alert-error mcp-externals-error" role="alert">
              {{ storeNotice }}
            </p>
            <p v-if="state.serversError" class="caption alert-error mcp-externals-error" role="alert">
              {{ state.serversError }}
            </p>
            <p v-if="unassignedNote" class="caption models-unassigned">
              <button type="button" class="models-unassigned-link" @click="requestAgentModes">
                {{ unassignedNote }} — assign one
              </button>
            </p>

            <div class="models-body">
              <ul class="models-tree" aria-label="Servers and their models">
                <li v-if="state.serversLoading" class="caption">Loading servers…</li>
                <li v-else-if="!state.servers.length" class="caption">
                  No server configured yet.
                </li>
                <li v-for="server in state.servers" :key="server.id" class="models-server">
                  <div class="models-row">
                    <button
                      type="button"
                      class="models-disclosure"
                      :aria-expanded="state.expandedServers.includes(server.id) ? 'true' : 'false'"
                      :title="server.models.length ? 'Show or hide its models' : 'This server has no models yet'"
                      @click="toggleServerExpanded(server.id)"
                    >
                      {{ state.expandedServers.includes(server.id) ? '▾' : '▸' }}
                    </button>
                    <button
                      type="button"
                      class="models-name"
                      :class="{ active: state.selectedServerId === server.id && state.selectedModelId === null }"
                      :aria-current="state.selectedServerId === server.id && state.selectedModelId === null ? 'true' : undefined"
                      @click="selectServer(server.id)"
                    >
                      {{ server.name }}
                      <span class="models-count">[{{ server.models.length }}]</span>
                    </button>
                  </div>
                  <ul v-if="state.expandedServers.includes(server.id)" class="models-children">
                    <li v-for="model in server.models" :key="model.id" class="models-row">
                      <button
                        type="button"
                        class="models-name models-name--model"
                        :class="{ active: state.selectedModelId === model.id }"
                        :aria-current="state.selectedModelId === model.id ? 'true' : undefined"
                        @click="selectModel(model.id)"
                      >
                        {{ model.name }}
                      </button>
                    </li>
                  </ul>
                </li>
              </ul>

              <div class="models-detail">
                <!-- A model's fields win the column when one is selected: the
                     server is its parent, and the row the user clicked is the
                     one they mean to edit. -->
                <template v-if="state.modelDraft">
                  <h4 class="models-detail-title">
                    {{ state.modelDraft.id === null ? 'New model' : state.modelDraft.name }}
                  </h4>
                  <label>
                    Model name
                    <input
                      v-model="state.modelDraft.name"
                      type="text"
                      list="models-fetched"
                      placeholder="exactly as the server names it"
                    />
                  </label>
                  <datalist id="models-fetched">
                    <option v-for="id in fetchedIds" :key="id" :value="id"></option>
                  </datalist>
                  <p v-if="!fetchedIds.length" class="caption">
                    {{ state.fetchedModelsLoading === draftKey(state.serverDraft)
                      ? 'Loading this server’s models…'
                      : 'No listing yet — use Fetch models on the server, or type the name.' }}
                  </p>
                  <p v-if="fetchedError" class="caption alert-error" role="alert">
                    {{ fetchedError }}
                  </p>
                  <label>
                    System prompt
                    <textarea
                      v-model="state.modelDraft.sysPrompt"
                      rows="3"
                      placeholder="You are a helpful assistant."
                    ></textarea>
                  </label>
                  <div class="settings-grid">
                    <label v-for="field in SAMPLER_FIELDS" :key="field">
                      {{ SAMPLER_LABELS[field] }}
                      <input
                        v-model="state.modelDraft[field]"
                        type="number"
                        :step="field === 'topK' ? '1' : '0.1'"
                        :min="samplerBounds(state.serversCaps, field).min ?? undefined"
                        :max="samplerBounds(state.serversCaps, field).max ?? undefined"
                      />
                    </label>
                  </div>
                  <label>
                    Reasoning level
                    <select v-model="state.modelDraft.reasoning">
                      <option value="">None</option>
                      <option
                        v-for="level in reasoningLevels"
                        :key="level"
                        :value="level"
                      >
                        {{ level }}
                      </option>
                    </select>
                  </label>
                  <label class="settings-vision">
                    <input type="checkbox" v-model="state.modelDraft.supportsVision" />
                    Model accepts image input (vision)
                  </label>
                  <div class="models-detail-actions">
                    <button
                      type="button"
                      :disabled="state.settingsSaving"
                      @click="saveModelDraft"
                    >
                      {{ state.settingsSaving ? 'Saving…' : 'Save model' }}
                    </button>
                    <button
                      v-if="state.modelDraft.id !== null"
                      type="button"
                      class="secondary contrast"
                      :disabled="state.settingsSaving"
                      @click="removeModel"
                    >
                      Remove model
                    </button>
                  </div>
                </template>

                <template v-else-if="state.serverDraft">
                  <h4 class="models-detail-title">
                    {{ state.serverDraft.id === null ? 'New server' : state.serverDraft.name }}
                  </h4>
                  <label>
                    Name
                    <input v-model="state.serverDraft.name" type="text" placeholder="Local" />
                  </label>
                  <label>
                    Server URL
                    <input
                      v-model="state.serverDraft.url"
                      type="url"
                      placeholder="http://127.0.0.1:8080/v1"
                    />
                  </label>
                  <label>
                    API key
                    <ApiKeyField v-model="state.serverDraft.apiKey" />
                  </label>
                  <div class="models-detail-actions">
                    <button
                      type="button"
                      :disabled="state.settingsSaving"
                      @click="saveServerDraft"
                    >
                      {{ state.settingsSaving ? 'Saving…' : 'Save server' }}
                    </button>
                    <button
                      type="button"
                      :disabled="
                        state.settingsSaving ||
                        state.fetchedModelsLoading === draftKey(state.serverDraft)
                      "
                      title="Ask this server which models it offers, for the model name field"
                      @click="fetchServerModels"
                    >
                      {{ state.fetchedModelsLoading === draftKey(state.serverDraft)
                        ? 'Fetching…'
                        : 'Fetch models' }}
                    </button>
                    <button
                      v-if="state.serverDraft.id !== null"
                      type="button"
                      class="secondary contrast"
                      :disabled="state.settingsSaving"
                      @click="removeServer"
                    >
                      Remove server
                    </button>
                  </div>
                  <p v-if="state.serverDraft.id === null" class="caption">
                    Save the server before adding a model to it.
                  </p>

                  <!-- What *Fetch models* answered for this row, beside the button
                       that asked it. The refusal sentence belongs here too: the
                       model column's copy of it is not on screen while the server
                       row is the one being edited. -->
                  <p
                    v-if="fetchedError"
                    class="caption alert-error mcp-externals-error"
                    role="alert"
                  >
                    {{ fetchedError }}
                  </p>
                  <p v-else-if="!fetchedIdsForServer.length" class="caption">
                    {{ fetchedIdsNote }}
                  </p>
                  <ul v-else class="models-fetched-list" aria-label="Models this server offers">
                    <li v-for="id in fetchedIdsForServer" :key="id">{{ id }}</li>
                  </ul>
                </template>

                <p v-else class="caption">
                  Select a server or a model to edit it.
                </p>

                <div class="models-add">
                  <button type="button" :disabled="state.settingsSaving" @click="addServerRow">
                    Add server
                  </button>
                  <button
                    type="button"
                    :disabled="state.settingsSaving || state.selectedServerId === null"
                    @click="addModelRow"
                  >
                    Add model
                  </button>
                </div>
              </div>
            </div>
          </section>

          <section v-show="activeSection === 'mcp'">
            <h3 class="settings-section-title">MCP connectors</h3>
            <p v-if="!state.mcpInstalled" class="caption alert-error" role="alert">
              The mcp package is not installed. Run
              <code>pip install -e ".[mcp]"</code> and restart the app.
            </p>
            <p v-if="state.mcpExternalsError" class="caption alert-error mcp-externals-error" role="alert">
              {{ state.mcpExternalsError }}
            </p>
            <p v-if="state.mcpLoading" class="caption">Loading connectors…</p>
            <p v-else-if="!state.mcpConnectors.length" class="caption">
              Nothing declared in <code>.nojae/mcp-settings.json</code>:
              add a <code>remote</code> or <code>local</code> entry to get
              connectors here.
            </p>
            <div v-for="connector in state.mcpConnectors" :key="connector.id" class="mcp-panel">
              <div class="mcp-panel-header">
                <label class="mcp-activate">
                  <input
                    type="checkbox"
                    role="switch"
                    :checked="state.mcpEnabled.includes(connector.id)"
                    :disabled="state.mcpLoading"
                    @change="toggleMcp(connector.id, $event.target.checked)"
                  />
                  {{ connector.label }}
                  <span v-if="connector.kind" class="mcp-external-tag">[{{ connector.kind }}]</span>
                </label>
                <span class="mcp-panel-badges">
                  <span class="badge" :class="MCP_STATUS_CLASS[connector.status]">
                    {{ connector.status }}
                  </span>
                </span>
              </div>
              <p class="caption mcp-description">{{ connectorDetail(connector) }}</p>
              <p v-if="connector.error" class="caption alert-error">{{ connector.error }}</p>
            </div>
            <!-- The tool-loop cap is not this section's knob any more (D9): it
                 is a per-agent column, edited on that agent's tab. -->
          </section>

          <section v-show="activeSection === 'lsp'">
            <h3 class="settings-section-title">LSP language servers</h3>
            <p v-if="!state.lspInstalled" class="caption alert-error" role="alert">
              The pygls package is not installed. Run
              <code>pip install -e ".[lsp]"</code> and restart the app.
            </p>
            <p v-if="state.lspError" class="caption alert-error" role="alert">
              {{ state.lspError }}
            </p>
            <p v-if="state.lspServersError" class="caption alert-error mcp-externals-error" role="alert">
              {{ state.lspServersError }}
            </p>
            <p v-if="state.lspLoading" class="caption">Loading language servers…</p>
            <p v-else-if="!state.lspServers.length" class="caption">
              No language servers declared in
              <code>.nojae/lsp-settings.json</code> (copy the seeded
              <code>.nojae/lsp-settings.template.json</code> to get started).
            </p>
            <div v-for="server in state.lspServers" :key="server.id" class="mcp-panel">
              <div class="mcp-panel-header">
                <label class="mcp-activate" :title="LSP_TOGGLE_TOOLTIP">
                  <input
                    type="checkbox"
                    role="switch"
                    :checked="state.lspActivated.includes(server.id)"
                    :disabled="state.lspLoading"
                    @change="toggleLsp(server.id, $event.target.checked)"
                  />
                  {{ server.label }}
                  <span v-if="server.lazy" class="mcp-external-tag">[lazy]</span>
                </label>
                <span class="mcp-panel-badges">
                  <span v-if="server.toolCount" class="badge mcp-port-badge"
                    :title="`tools offered by ${server.id}`">
                    {{ server.toolCount }} tools
                  </span>
                  <span class="badge" :class="MCP_STATUS_CLASS[server.status]">
                    {{ server.status }}
                  </span>
                </span>
              </div>
              <p class="caption mcp-description">{{ serverDetail(server) }}</p>
              <p v-if="server.error" class="caption alert-error">{{ server.error }}</p>
            </div>
          </section>
        </div>
      </div>

      <footer class="settings-actions">
        <button class="secondary contrast" type="button" :disabled="state.settingsSaving" @click="closeSettings">
          Close
        </button>
        <button
          v-if="activeSection === 'mcp'"
          type="button"
          :disabled="state.mcpSaving || state.mcpLoading"
          @click="saveMcp"
        >
          {{ state.mcpSaving ? 'Saving…' : 'Save' }}
        </button>
        <button
          v-else-if="activeSection === 'lsp'"
          type="button"
          :disabled="state.lspSaving || state.lspLoading"
          @click="saveLsp"
        >
          {{ state.lspSaving ? 'Saving…' : 'Save' }}
        </button>
        <!-- The Models section has no footer Save at all: a server and a model
             are each saved from their own field column, because each is a row
             and the dialog edits one row at a time. The Close button above is
             therefore its whole footer — a second "close" beside it would be a
             second word for one action. -->
      </footer>
    </form>
    </article>
  </dialog>
</template>
