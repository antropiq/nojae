<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import ApiKeyField from './ApiKeyField.vue'
import { SAMPLER_FIELDS, samplerBounds, useAppShell } from '../composables/useAppShell'
import { useSettingsServers } from '../composables/useSettingsServers'

const {
  state,
  closeSettings,
  selectServer,
  selectModel,
  toggleServerExpanded,
  setDetailTab,
  requestAgentModes,
  toggleMcp,
  saveMcp,
  toggleLsp,
  saveLsp,
} = useAppShell()

// **The dialog decides nothing.** Every enablement verdict, every tooltip, the
// detail page that is drawn and the one message the band says are answered by
// `useSettingsServers`; this file turns those answers into fields and buttons
// (plan §6.1). A condition in this template would be a rule that can drift from
// the control that shows it.
const {
  addSlot,
  saveSlot,
  deleteSlot,
  deleteConfirmation,
  fetchSlot,
  mcpSaveSlot,
  lspSaveSlot,
  rows,
  rowSlotFor,
  tabs,
  visibleTabs,
  activeTab,
  body,
  message,
  addRow,
  saveRow,
  addFromListing,
  fetchModels,
  askDelete,
  dismissDelete,
  confirmDelete,
} = useSettingsServers()

// This dialog edits the **installation's** catalogue — servers, models, the MCP
// and LSP declarations — and deliberately has **no workspace control**: the
// folder belongs to the tab and lives in the app bar's field (spec D2, §5.1
// rule 9). Nothing here imports `useWorkspaceSession`, reads a workspace value
// or spells one on a request, because a folder field here would say the folder
// and the catalogue are one setting. The requests this dialog's composables make
// carry the tab's folder through `withWorkspace`; that is the tab's own field
// riding along, not a setting this dialog owns.
const dialogEl = ref(null)

// The three sections, and the strip that chooses between them. The first is
// named for the tree's root object — a **server**, with its models under it —
// which is what the toolbar's heading reads too (plan §4.1 / §4.2).
const SECTIONS = [
  { id: 'servers', label: 'Servers' },
  { id: 'mcp', label: 'MCP' },
  { id: 'lsp', label: 'LSP' },
]

// The section strip's selection is the shell's, not this component's, for one
// reason: the strip and the **one** message band have to agree about which
// section the sentence on screen belongs to (§4.7). Choosing a section is a
// plain assignment — no verdict is decided here.
function setSection(id) {
  state.activeSection = id
}

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

// The strip's buttons, by position, so an arrow key can move focus as well as
// selection. The list is re-taken whenever the strip changes, so a stale button
// can never be focused.
let detailTabRefs = []
watch(() => tabs.value, () => { detailTabRefs = [] })

function setDetailTabRef(el, index) {
  detailTabRefs[index] = el ?? undefined
}

// The detail strip behaves as tabs: the buttons are a `tablist`, the arrow keys
// walk between them, and only the selected one is in the tab order. A model is
// the only row with two pages, so the list the keys walk is the composable's
// `visibleTabs` — empty on the server page, where the strip is reserved but the
// tabs are hidden (§4.5). The refs are kept by position in the **full** list,
// which is what the `v-for` indexes, so the walked tab is looked up there.
function onDetailTabKeydown(event, index) {
  const step = { ArrowRight: 1, ArrowLeft: -1 }
  const walkable = visibleTabs.value
  if (walkable.length < 2) return
  const at = walkable.findIndex((tab) => tab.id === tabs.value[index]?.id)
  if (at === -1) return
  let next
  if (event.key in step) next = (at + step[event.key] + walkable.length) % walkable.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = walkable.length - 1
  else return
  event.preventDefault()
  const target = walkable[next]
  setDetailTab(target.id)
  detailTabRefs[tabs.value.findIndex((tab) => tab.id === target.id)]?.focus()
}

// A model added from the listing must land on its own tree row (§9.1-3): the
// name is already in the field, so focusing the row is what makes the tree's
// keyboard position coherent and lets Tab walk into the form from there.
watch(
  () => state.focusTreeRowId,
  async (id) => {
    if (id === null || id === undefined) return
    await nextTick()
    const row = document.querySelector(`.models-name--model[data-model-id="${id}"]`)
    row?.focus()
    state.focusTreeRowId = null
  },
)

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

// The app-level notice (§5.1) — *no model configured*, or the store itself
// unusable — is no longer assembled here: it is one of the lines the band's
// single `messageFor` verdict chooses, so the dialog has one message area and
// not six that each push different content down at a different moment.
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

    <form class="settings-form" @submit.prevent>
      <nav class="settings-nav" aria-label="Settings sections">
        <ul>
          <li v-for="section in SECTIONS" :key="section.id">
            <button
              type="button"
              :class="{ active: state.activeSection === section.id }"
              :aria-current="state.activeSection === section.id ? 'true' : undefined"
              @click="setSection(section.id)"
            >
              {{ section.label }}
            </button>
          </li>
        </ul>
      </nav>

      <div class="settings-body">
        <div class="settings-editor">
          <!-- The Servers section (§4): the store's servers on the left, each
               expandable to its own models, and the selected row's fields on the
               right. It is the old LLM and Sampling sections merged, because a
               model carries its own samplers — the split only made sense while
               there was one connection and one model.

               No model is marked as special anywhere in here: which agent runs on
               which model is the agent's own field, and the question is asked in
               the Agent-modes dialog (D5). What this section says about that is
               the band's cross-store line, not a line of its own (§4.7).

               The body is the shared two-column grid, with the toolbar and the
               tree down the left column's two rows and the detail column spanning
               both — the Agents card's geometry, so the two dialogs put a toolbar
               over a list in the same place (§4.3, §6.2). It has no heading of its
               own: the section strip one row above already reads `Servers`, and
               repeating it there is a second title for the thing it titles. -->
          <section v-show="state.activeSection === 'servers'" class="settings-models">
            <!-- **Three verb slots, a spacer, two reserved confirmation slots** —
                 the Agents card's toolbar, in the shared classes. Every slot keeps
                 its size whether or not it holds a button, so the pair's arrival
                 moves nothing and the toolbar never changes height. The verbs are
                 scoped to the page that is visible, which is why no label spells
                 its scope (§4.3). -->
            <div class="agent-modes-toolbar" role="group" aria-label="Server and model actions">
              <span class="agent-modes-slot">
                <button
                  class="icon-btn servers-add"
                  type="button"
                  :disabled="addSlot.disabled"
                  :aria-label="addSlot.label"
                  :title="addSlot.label"
                  @click="addRow"
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
                  class="icon-btn servers-save"
                  type="button"
                  :disabled="saveSlot.disabled"
                  :aria-label="saveSlot.label"
                  :title="saveSlot.label"
                  @click="saveRow"
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
                  class="icon-btn servers-delete"
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
              <!-- The delete pair, **absent from the DOM** until asked (§4.8). Its
                   slots were already reserved, so the three verbs do not move when
                   it arrives; the sentence naming what the delete takes with it is
                   the band's, not the toolbar's. -->
              <span class="agent-modes-slot">
                <button
                  v-if="deleteConfirmation.rendered"
                  class="icon-btn agent-modes-cancel servers-cancel-delete"
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
                  class="icon-btn agent-modes-confirm servers-confirm-delete"
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

            <!-- The tree is the grid's only flexible row, so it scrolls in its own
                 bounded area and the toolbar above it never scrolls away with it. -->
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
                      :data-model-id="model.id"
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
                <!-- The detail column's two pages (§4.5). Both tabs stay in the DOM
                     and the strip is **reserved** whatever is selected, so choosing
                     a model cannot push the first field down by a row. On the server
                     page they are hidden rather than removed: the section strip
                     above already reads `Servers`, so a `Settings` tab there would
                     repeat it — and removing the row is what would move the fields.
                     Which page is drawn is `body`'s answer, never a condition here. -->
                <nav class="settings-nav models-detail-tabs" aria-label="Model page">
                  <ul role="tablist">
                    <li
                      v-for="(tab, index) in tabs"
                      :key="tab.id"
                      :class="{ 'models-detail-tab--hidden': tab.hidden }"
                    >
                      <button
                        :id="`models-tab-${tab.id}`"
                        type="button"
                        role="tab"
                        class="models-detail-tab"
                        :class="{ active: activeTab === tab.id }"
                        :aria-selected="activeTab === tab.id ? 'true' : 'false'"
                        :aria-controls="`models-panel-${tab.id}`"
                        :tabindex="activeTab === tab.id ? 0 : -1"
                        :ref="(el) => setDetailTabRef(el, index)"
                        @click="setDetailTab(tab.id)"
                        @keydown="onDetailTabKeydown($event, index)"
                      >
                        {{ tab.label }}
                      </button>
                    </li>
                  </ul>
                </nav>

                <!-- Both pages read and write **one** `state.modelDraft`, so the
                     tab is presentation only: a keystroke made on either page is
                     on the other the moment it is drawn, and switching writes
                     nothing (§4.5). No API key appears on either: the credential
                     is a server column and a model request never carries one (§2.1). -->
                <div
                  v-if="body === 'modelSettings'"
                  id="models-panel-settings"
                  role="tabpanel"
                  aria-labelledby="models-tab-settings"
                  class="models-page models-page--settings"
                >
                  <!-- One three-column grid for the whole page (§4.5): the name
                       takes a column, the reasoning level the two that are left,
                       and the six samplers fall into the same columns two rows
                       down — so every field's left edge is one of three, and the
                       vision tick sits at the row's right end. -->
                  <label class="models-field models-field--name">
                    Model name
                    <input
                      v-model="state.modelDraft.name"
                      type="text"
                      placeholder="exactly as the server names it"
                    />
                  </label>
                  <label class="models-field models-field--reasoning">
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
                  <label
                    v-for="field in SAMPLER_FIELDS"
                    :key="field"
                    class="models-field models-field--sampler"
                  >
                    {{ SAMPLER_LABELS[field] }}
                    <input
                      v-model="state.modelDraft[field]"
                      type="number"
                      :step="field === 'topK' ? '1' : '0.1'"
                      :min="samplerBounds(state.serversCaps, field).min ?? undefined"
                      :max="samplerBounds(state.serversCaps, field).max ?? undefined"
                    />
                  </label>
                  <label class="models-field models-field--vision">
                    <input type="checkbox" v-model="state.modelDraft.supportsVision" />
                    Model accepts image input (vision)
                  </label>
                </div>

                <div
                  v-else-if="body === 'modelPrompt'"
                  id="models-panel-prompt"
                  role="tabpanel"
                  aria-labelledby="models-tab-prompt"
                  class="models-page models-page--prompt"
                >
                  <textarea
                    v-model="state.modelDraft.sysPrompt"
                    class="models-prompt"
                    placeholder="You are a helpful assistant."
                  ></textarea>
                </div>

                <!-- The server page: its three fields, then *Fetch models* under
                     the key it dials, then the listing that answer fills (§4.4).
                     The verb sits **inside** the page rather than in the toolbar
                     because what it answers is this page's body — which is also
                     what makes its disabled state legible: it is disabled *about
                     this server*, and the fields above it are the server. -->
                <div
                  v-else-if="body === 'server'"
                  class="models-page models-page--server"
                >
                  <label class="models-server-name">
                    Name
                    <input v-model="state.serverDraft.name" type="text" placeholder="Local" />
                  </label>
                  <label class="models-server-url">
                    Server URL
                    <input
                      v-model="state.serverDraft.url"
                      type="url"
                      placeholder="http://127.0.0.1:8080/v1"
                    />
                  </label>
                  <label class="models-server-key">
                    API key
                    <ApiKeyField v-model="state.serverDraft.apiKey" />
                  </label>
                  <button
                    class="models-fetch"
                    type="button"
                    :disabled="fetchSlot.disabled"
                    :aria-label="fetchSlot.label"
                    :title="fetchSlot.label"
                    @click="fetchModels"
                  >
                    {{ fetchSlot.text }}
                  </button>

                  <!-- The listing: a real table, `name` and `Add`, whose **own**
                       scroll area holds any number of names so the detail column
                       gains no scrollbar of its own (§4.4, §6.4). A name the server
                       already has keeps its `+` in the cell, inert with its reason:
                       a column that answered differently per row would make the
                       table's widths jump. -->
                  <div class="models-listing">
                    <table class="models-listing-table">
                      <thead>
                        <tr>
                          <th scope="col">name</th>
                          <th scope="col" class="models-listing-add-col">Add</th>
                        </tr>
                      </thead>
                      <tbody>
                        <tr v-for="row in rows" :key="row.name" class="models-listing-row">
                          <td class="models-listing-name">{{ row.name }}</td>
                          <td class="models-listing-add">
                            <button
                              class="icon-btn models-add-row"
                              type="button"
                              :disabled="rowSlotFor(row).disabled"
                              :aria-label="`${rowSlotFor(row).label}: ${row.name}`"
                              :title="rowSlotFor(row).label"
                              @click="addFromListing(row)"
                            >
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"
                                stroke="currentColor" stroke-width="2" stroke-linecap="round"
                                stroke-linejoin="round" aria-hidden="true">
                                <path d="M12 5v14M5 12h14" />
                              </svg>
                            </button>
                          </td>
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>

                <!-- The column's own nothing-to-edit state: the tree holds no row
                     and the toolbar has nothing to act on. -->
                <p v-else class="caption">
                  Select a server or a model to edit it.
                </p>
              </div>
          </section>

          <!-- The MCP and LSP sections (§4.9): their `Save` left the footer for a
               toolbar of the Servers tab's shape — heading at one end, the verb at
               the other — so the footer is **one shape for all three sections**:
               the band and `Close`. Their top-level lines (package not installed,
               the read's failure) moved to the band too; what stays beside a row
               is that row's own badge and its own error, because a band that
               carries six connector errors is a list, not a message (§4.7). -->
          <section v-show="state.activeSection === 'mcp'" class="settings-hub-section">
            <div class="settings-section-toolbar">
              <h3 class="settings-section-title">MCP connectors</h3>
              <button
                class="settings-section-save"
                type="button"
                :disabled="mcpSaveSlot.disabled"
                :aria-label="mcpSaveSlot.label"
                :title="mcpSaveSlot.label"
                @click="saveMcp"
              >
                {{ mcpSaveSlot.text }}
              </button>
            </div>
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

          <section v-show="state.activeSection === 'lsp'" class="settings-hub-section">
            <div class="settings-section-toolbar">
              <h3 class="settings-section-title">LSP language servers</h3>
              <button
                class="settings-section-save"
                type="button"
                :disabled="lspSaveSlot.disabled"
                :aria-label="lspSaveSlot.label"
                :title="lspSaveSlot.label"
                @click="saveLsp"
              >
                {{ lspSaveSlot.text }}
              </button>
            </div>
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

      <!-- **The dialog's one message band** (§4.7), in the shared footer shape:
           the line fills the row left of `Close`, is always there, and carries
           the text and the role `messageFor` answered with. Nothing else in the
           dialog says anything, so no sentence can push a control out of place.
           `Close` is the footer's only verb for all three sections (§4.9). -->
      <footer class="settings-actions">
        <p class="agent-modes-message" :role="message.role">{{ message.text }}</p>
        <!-- The one message the user can act on from here: the band renders it as
             the button that opens the Agent-modes dialog, and which line that is
             is `messageFor`'s choice, not the template's. -->
        <button
          v-if="message.action === 'agentModes'"
          class="settings-message-action"
          type="button"
          @click="requestAgentModes"
        >
          Assign one
        </button>
        <button class="secondary contrast settings-close" type="button" @click="closeSettings">
          Close
        </button>
      </footer>
    </form>
    </article>
  </dialog>
</template>
