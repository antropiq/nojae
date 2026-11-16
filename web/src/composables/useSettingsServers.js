import { computed } from 'vue'

import {
  fetchedModelIdsFor,
  fetchedModelsErrorFor,
  hasFetchedListing,
  unassignedLine,
  useAppShell,
} from './useAppShell'

//: ---------------------------------------------------------------------------
//: The Servers section's rules, as plain functions.
//:
//: This is the settings dialog's half of the idiom the Agent-modes card settled
//: on (`useAgentModes.js`): every enablement verdict, every tooltip and the
//: dialog's **one** message are answered here, and `SettingsDialog.vue` renders
//: the answers. The property that buys is the one the migration plan asks for
//: (§7.12): no rule about what a control may do is written in the template, so a
//: rule cannot drift from the button that shows it.
//:
//: Each slot answers the same two things — is it inert, and what does it say —
//: in **one** string. That string is the button's accessible name when it is
//: live and the reason it is inert when it is not, so the pair moves as one or
//: not at all and an inert control always explains itself.
//:
//: Nothing here spells a cap, a range or a reasoning level: those arrive in the
//: read's ``caps``, which is also what the server refuses against.
//: ---------------------------------------------------------------------------

//: The three sentences more than one slot says. Spelled once, because a reason
//: that reads differently in two tooltips is two reasons.
const NOT_READ_LABEL = 'The servers have not been read.'
const WRITE_IN_FLIGHT_LABEL = 'A write is in flight — wait for it to finish.'
const CONFIRMATION_PENDING_LABEL = 'A confirmation is pending — answer it first.'
const NOTHING_SELECTED_LABEL = 'Select a server or a model to edit it.'
const SERVER_NOT_SAVED_LABEL = 'Save the server before fetching its models.'

//: The detail column's two pages. They are **pages of one form**, not two forms:
//: both read and write the same `state.modelDraft`, so switching between them
//: cannot lose a keystroke and cannot write anything (§4.5).
export const DETAIL_SETTINGS = 'settings'
export const DETAIL_PROMPT = 'prompt'

export const DETAIL_TABS = [
  { id: DETAIL_SETTINGS, label: 'Settings' },
  { id: DETAIL_PROMPT, label: 'System prompt' },
]

function slotLive(label) {
  return { disabled: false, label }
}

function slotInert(label) {
  return { disabled: true, label }
}

//: A **text** button's slot. A glyph can make one string do both jobs — it is the
//: button's accessible name when live and its reason when inert — but a word on
//: a button cannot also be a sentence, so these carry the two apart: `text` is
//: always the verb the button shows, `label` is its accessible name and its
//: tooltip. The template renders both and chooses neither.
function slotLiveText(text) {
  return { disabled: false, text, label: text }
}

function slotInertText(text, label) {
  return { disabled: true, text, label }
}

//: What every verdict reads, in one object, so the three verbs cannot disagree
//: about the state they are rendered in. The defaults are the plainest state the
//: section can be in — read, nothing in flight, nothing asked — so a caller
//: passes only what it actually holds.
function slotContext({
  loaded = true,
  saving = false,
  listing = false,
  confirming = false,
  page = null,
  serverSaved = false,
  urlFilled = false,
  rowSaved = true,
} = {}) {
  return {
    loaded: loaded !== false,
    saving: saving === true,
    listing: listing === true,
    confirming: confirming === true,
    page: page === 'model' ? 'model' : page === 'server' ? 'server' : null,
    serverSaved: serverSaved === true,
    urlFilled: urlFilled === true,
    rowSaved: rowSaved !== false,
  }
}

//: The row the toolbar acts on: the **page that is visible** is the scope
//: (§4.3), so `Save` on the model page saves that model and `Save` on the server
//: page saves that server. The labels never spell the scope — the page and the
//: verb are always on screen together, which is the only thing that makes the
//: short word honest.
export function addSlotFor(context = {}) {
  const ctx = slotContext(context)
  if (!ctx.loaded) return slotInert(NOT_READ_LABEL)
  if (ctx.saving) return slotInert(WRITE_IN_FLIGHT_LABEL)
  if (ctx.confirming) return slotInert(CONFIRMATION_PENDING_LABEL)
  if (ctx.page === 'server' && !ctx.serverSaved) {
    return slotInert('Already adding a server — save it or select one.')
  }
  return slotLive('Add')
}

//: **save** — `Saving…` while a write is in flight, and inert for nothing else.
//: A form that holds a problem does **not** disable it: the click is refused and
//: the reason lands in the message band, because taking the button away hides the
//: answer (§4.3).
export function saveSlotFor(context = {}) {
  const ctx = slotContext(context)
  if (ctx.saving) return slotInert('Saving…')
  if (!ctx.loaded) return slotInert(NOT_READ_LABEL)
  if (ctx.confirming) return slotInert(CONFIRMATION_PENDING_LABEL)
  if (ctx.page === null) return slotInert(NOTHING_SELECTED_LABEL)
  return slotLive('Save')
}

//: **delete** — a row that has no backend row cannot be deleted, and that is true
//: of a new server and a new model alike: the write would address nothing. The
//: reason is said rather than the button hidden, so the toolbar's geometry never
//: depends on which row is selected.
export function deleteSlotFor(context = {}) {
  const ctx = slotContext(context)
  if (!ctx.loaded) return slotInert(NOT_READ_LABEL)
  if (ctx.page === null) return slotInert('Select a server or a model to delete it.')
  if (!ctx.rowSaved) {
    return slotInert(
      ctx.page === 'model'
        ? 'Save the model before it can be deleted.'
        : 'Save the server before it can be deleted.',
    )
  }
  if (ctx.saving) return slotInert(WRITE_IN_FLIGHT_LABEL)
  if (ctx.confirming) return slotInert(CONFIRMATION_PENDING_LABEL)
  return slotLive('Delete')
}

//: The delete pair, and whether it is in the DOM at all: **absent**, not hidden,
//: until a delete has been asked for (§4.8). Its two tooltips are the question
//: and its two answers; the sentence naming what the delete takes with it is the
//: band's, not the toolbar's, because a server delete loses its models and that
//: copy is too long for a glyph.
export function deleteConfirmationFor(context = {}) {
  const ctx = slotContext(context)
  if (!ctx.confirming || ctx.page === null || !ctx.rowSaved) {
    return { rendered: false, cancel: null, confirm: null }
  }
  return {
    rendered: true,
    cancel: ctx.saving ? slotInert(WRITE_IN_FLIGHT_LABEL) : slotLive('Cancel delete'),
    confirm: ctx.saving ? slotInert(WRITE_IN_FLIGHT_LABEL) : slotLive('Confirm delete'),
  }
}

//: ---------------------------------------------------------------------------
//: The server page's own two verbs: *Fetch models* and the listing's `+`.
//: ---------------------------------------------------------------------------

//: *Fetch models* lives under the API key field, not in the toolbar: what it
//: answers is the body of that page, and a disabled button beside the field it
//: is disabled *about* needs no tooltip to explain which row it means (§4.3).
//: One gate covers listing and adding both — the server must have a row — which
//: is why no `+` can ever be shown for an unsaved server (§4.4).
export function fetchSlotFor(context = {}) {
  const ctx = slotContext(context)
  if (ctx.listing) return slotInertText('Fetching…', 'Fetching…')
  if (ctx.saving) return slotInertText('Fetch models', WRITE_IN_FLIGHT_LABEL)
  if (!ctx.loaded) return slotInertText('Fetch models', NOT_READ_LABEL)
  if (!ctx.serverSaved) return slotInertText('Fetch models', SERVER_NOT_SAVED_LABEL)
  if (!ctx.urlFilled) {
    return slotInertText('Fetch models', 'Fill in the server URL before fetching its models.')
  }
  return slotLiveText('Fetch models')
}

//: One fetched name's `+`. It is a **write** (§4.4), so it shares the
//: write-in-flight guard rather than racing it, and a name the server already
//: has is inert with its reason instead of clicking into a store refusal. It
//: stays in its cell either way: a column that answers differently per row would
//: make the table's widths jump.
export function addRowSlotFor({
  added = false,
  context = {},
} = {}) {
  const ctx = slotContext(context)
  if (ctx.saving) return slotInert(WRITE_IN_FLIGHT_LABEL)
  if (ctx.listing) return slotInert('Listing this server’s models…')
  if (!ctx.serverSaved) return slotInert(SERVER_NOT_SAVED_LABEL)
  if (added) return slotInert('Already added')
  return slotLive('Add this model')
}

//: The listing's rows: the names the server answered with, each marked with
//: whether that server already holds a model of the name. The comparison is
//: against the tree the client already holds, so it costs no route (§4.4).
export function listingRowsFor(fetchedIds, server) {
  const names = new Set((server?.models ?? []).map((model) => model.name))
  return (fetchedIds ?? []).map((name) => ({ name, added: names.has(name) }))
}

//: ---------------------------------------------------------------------------
//: The detail column's tab strip.
//:
//: Both tabs are always in the DOM and the strip is **reserved** whatever is
//: selected, so choosing a model does not push the first field down by one row
//: (§4.5). On the server page neither tab is *shown*: the section strip above
//: already reads `Servers`, so a `Settings` tab there repeats the word directly
//: over it. They are hidden rather than removed, which is what keeps the strip
//: the same height in every state.
//: The page that is drawn is a reading of the tab *and* the page: only a model
//: has a System prompt, so a tab left on `prompt` while a server is selected
//: draws the server's fields rather than an empty textarea.
//: ---------------------------------------------------------------------------

export function detailTabsFor(page) {
  const shown = page === 'model'
  return DETAIL_TABS.map((tab) => ({ ...tab, hidden: !shown }))
}

//: The tabs a keyboard tour may walk. The hidden ones are not reachable by a
//: pointer either, so the arrow keys must not land the focus on an invisible tab.
export function visibleDetailTabsFor(page) {
  return detailTabsFor(page).filter((tab) => !tab.hidden)
}

export function detailPageFor(page, tab) {
  if (page === 'model' && tab === DETAIL_PROMPT) return DETAIL_PROMPT
  return DETAIL_SETTINGS
}

//: Which page the column actually draws, from the same two readings. Three
//: form answers plus `empty`, so the template holds no condition of its own
//: about which form is on screen — and a server can never be drawn with a
//: textarea where its fields should be (§4.5). `empty` is the column's own
//: nothing-to-edit state, which is content of the column rather than one of the
//: band's nine findings (§4.7).
export function detailBodyFor(page, tab) {
  if (page === 'model') {
    return tab === DETAIL_PROMPT ? 'modelPrompt' : 'modelSettings'
  }
  return page === 'server' ? 'server' : 'empty'
}

//: ---------------------------------------------------------------------------
//: Why a click on Save is refused, or null when this form may be written.
//:
//: The client states the two things the store's own validators refuse for the
//: same reason (a row must be named, a URL must be diallable) so the sentence
//: arrives without a round-trip. It is a **message**, never a disabled button.
//: ---------------------------------------------------------------------------

export function saveRefusalFor({ page = null, draft = null } = {}) {
  if (!draft || page === null) return null
  if (!String(draft.name ?? '').trim()) {
    return page === 'model'
      ? 'The form must be completed before this model can be saved: name must not be empty.'
      : 'The form must be completed before this server can be saved: name must not be empty.'
  }
  if (page === 'server') {
    const url = String(draft.url ?? '').trim().toLowerCase()
    if (!url) {
      return 'The form must be completed before this server can be saved: url must not be empty.'
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return 'The form must be completed before this server can be saved: url must start with http:// or https://.'
    }
  }
  return null
}

//: ---------------------------------------------------------------------------
//: The dialog's **one** message (§4.7).
//:
//: Everything the dialog says comes out of the band at the bottom, chosen by
//: this fixed priority and never by recency, so two truths never fight for the
//: line. The role is part of the answer because the line is announced and not
//: just drawn: `alert` for a refusal or a failure, `status` for progress and for
//: the incomplete-form sentence.
//:
//: It always answers an object, so the band is a slot that is *always there*: an
//: empty `text` means nothing to say, and filling or emptying it reflows nothing.
//: The cross-store line answers with `action: 'agentModes'` because it is the one
//: message the user can act on from here — the band renders it as the button that
//: opens the Agent-modes dialog, and the template chooses nothing else.
//: ---------------------------------------------------------------------------

export function messageFor({
  section = 'servers',
  saving = false,
  listing = false,
  storeState = null,
  serversError = null,
  settingsError = null,
  fetchError = null,
  deleteSentence = null,
  listingEmpty = false,
  refusal = null,
  config = null,
  unassigned = null,
  mcpInstalled = true,
  mcpError = null,
  mcpExternalsError = null,
  mcpLoading = false,
  lspInstalled = true,
  lspError = null,
  lspServersError = null,
  lspLoading = false,
} = {}) {
  if (saving) return { text: 'Saving…', role: 'status', action: null }
  if (listing) {
    return { text: 'Listing this server’s models…', role: 'status', action: null }
  }
  // A hub read in flight is progress about the section on screen, which is what
  // the band is for; the row list below it simply has nothing in it yet.
  if (section === 'mcp' && mcpLoading) {
    return { text: 'Loading connectors…', role: 'status', action: null }
  }
  if (section === 'lsp' && lspLoading) {
    return { text: 'Loading language servers…', role: 'status', action: null }
  }

  // A delete awaiting its answer: the sentence is the store's own copy, put in
  // the band by the verb that asked (§4.8). It outranks everything the read or a
  // stale failure could say, because the question on screen is the one that
  // needs answering.
  if (deleteSentence) return { text: deleteSentence, role: 'alert', action: null }

  // The store's own sentence, verbatim: it already names what is wrong, and the
  // dialog adds nothing and translates nothing.
  if (storeState && storeState.usable === false && storeState.sentence) {
    return { text: storeState.sentence, role: 'alert', action: null }
  }

  if (section === 'mcp') {
    const line = mcpTopLevelLine({ mcpInstalled, mcpError, mcpExternalsError })
    if (line) return { text: line, role: 'alert', action: null }
  } else if (section === 'lsp') {
    const line = lspTopLevelLine({ lspInstalled, lspError, lspServersError })
    if (line) return { text: line, role: 'alert', action: null }
  }

  if (serversError) return { text: serversError, role: 'alert', action: null }
  if (fetchError) return { text: fetchError, role: 'alert', action: null }
  if (refusal) return { text: refusal, role: 'status', action: null }
  if (settingsError) return { text: settingsError, role: 'alert', action: null }

  // The read's findings, joined as **one** message rather than two lines that
  // would compete for the same slot.
  const findings = storeFindings({ storeState, config })
  if (findings) return { text: findings, role: 'alert', action: null }

  if (section === 'servers') {
    const line = unassignedMessage(unassigned)
    if (line) return line
  }

  // The quietest thing the band ever says, and last for that reason: a listing
  // that came back empty is contextual help about the table on screen, and it
  // must not out-rank a failure or the cross-store line (§9.1-2).
  if (listingEmpty) {
    return { text: 'This server lists no models.', role: 'status', action: null }
  }

  return { text: '', role: 'status', action: null }
}

//: The store-level question the dialog asks at the top of nothing any more: is
//: the store usable, and does it hold at least one model? The unusable case is
//: answered by priority 3 with the server's own words; this is the second half.
function storeFindings({ storeState, config }) {
  if (!storeState || storeState.usable === false) return null
  if (!(config?.models ?? []).length) {
    return 'No model is configured yet. Add a server and a model under it, then ' +
      'assign one to the agent you use.'
  }
  return null
}

//: The MCP section's top-level lines only. A row's own badge and its own error
//: stay beside the connector they describe: a band that carries six connector
//: errors is a list, not a message (§4.7).
function mcpTopLevelLine({ mcpInstalled, mcpError, mcpExternalsError }) {
  if (!mcpInstalled) {
    return 'The mcp package is not installed. Run pip install -e ".[mcp]" and ' +
      'restart the app.'
  }
  return mcpError || mcpExternalsError || null
}

function lspTopLevelLine({ lspInstalled, lspError, lspServersError }) {
  if (!lspInstalled) {
    return 'The pygls package is not installed. Run pip install -e ".[lsp]" and ' +
      'restart the app.'
  }
  return lspError || lspServersError || null
}

//: ---------------------------------------------------------------------------
//: The MCP and LSP sections' one verb each.
//:
//: Their `Save` left the footer for a toolbar of the Servers tab's shape (§4.9),
//: and a toolbar verb is a verdict like any other: the two sections share the
//: band's message priority, so their enablement is answered here too rather than
//: written as a condition beside the button.
//: ---------------------------------------------------------------------------

export function mcpSaveSlotFor({ saving = false, loading = false, installed = true } = {}) {
  if (saving) return slotInertText('Saving…', 'Saving…')
  if (!installed) return slotInertText('Save', 'The mcp package is not installed.')
  if (loading) return slotInertText('Save', 'The connectors are still being read.')
  return slotLiveText('Save')
}

export function lspSaveSlotFor({ saving = false, loading = false, installed = true } = {}) {
  if (saving) return slotInertText('Saving…', 'Saving…')
  if (!installed) return slotInertText('Save', 'The pygls package is not installed.')
  if (loading) return slotInertText('Save', 'The language servers are still being read.')
  return slotLiveText('Save')
}

//: The one line that is a button. Its sentence is the shell's (`unassignedLine`)
//: and the band adds only the verb the button carries, so the two places that
//: report this count cannot drift apart in wording.
function unassignedMessage(unassigned) {
  const line = unassignedLine(unassigned)
  if (!line) return null
  return { text: line, role: 'status', action: 'agentModes' }
}

//: ---------------------------------------------------------------------------
//: The wiring: the verdicts above read the shell's state, and the component
//: reads these. One place builds the context, so the five controls cannot be
//: shown under five different readings of the same moment.
//: ---------------------------------------------------------------------------

export function useSettingsServers() {
  const shell = useAppShell()
  const { state } = shell

  const page = computed(() =>
    state.modelDraft ? 'model' : state.serverDraft ? 'server' : null,
  )
  const listingInFlight = computed(
    () =>
      state.fetchedModelsLoading !== null &&
      state.fetchedModelsLoading !== undefined &&
      state.fetchedModelsLoading === (state.serverDraft?.id ?? 'new'),
  )
  const slotContextFor = computed(() => ({
    loaded: !state.serversLoading && state.serversError === null,
    saving: state.settingsSaving,
    listing: listingInFlight.value,
    confirming: state.pendingDelete !== null,
    page: page.value,
    serverSaved: state.serverDraft?.id != null,
    urlFilled: !!String(state.serverDraft?.url ?? '').trim(),
    rowSaved:
      page.value === 'model'
        ? state.modelDraft?.id != null
        : state.serverDraft?.id != null,
  }))

  const addSlot = computed(() => addSlotFor(slotContextFor.value))
  const saveSlot = computed(() => saveSlotFor(slotContextFor.value))
  const deleteSlot = computed(() => deleteSlotFor(slotContextFor.value))
  const deleteConfirmation = computed(() =>
    deleteConfirmationFor(slotContextFor.value),
  )
  const fetchSlot = computed(() => fetchSlotFor(slotContextFor.value))

  const tabs = computed(() => detailTabsFor(page.value))
  const visibleTabs = computed(() => visibleDetailTabsFor(page.value))
  const activeTab = computed(() => detailPageFor(page.value, state.detailTab))
  const body = computed(() => detailBodyFor(page.value, activeTab.value))
  const mcpSaveSlot = computed(() =>
    mcpSaveSlotFor({
      saving: state.mcpSaving,
      loading: state.mcpLoading,
      installed: state.mcpInstalled,
    }),
  )
  const lspSaveSlot = computed(() =>
    lspSaveSlotFor({
      saving: state.lspSaving,
      loading: state.lspLoading,
      installed: state.lspInstalled,
    }),
  )

  const refusal = computed(() =>
    saveRefusalFor({ page: page.value, draft: state.modelDraft ?? state.serverDraft }),
  )

  const message = computed(() =>
    messageFor({
      section: activeSectionOf(state),
      saving: state.settingsSaving,
      listing: listingInFlight.value,
      storeState: state.storeState,
      serversError: state.serversError,
      settingsError: state.settingsError,
      fetchError: fetchedModelsErrorFor(state.serverDraft),
      deleteSentence: state.pendingDeleteSentence,
      listingEmpty: listingEmptyFor(state),
      refusal: refusal.value,
      config: state.config,
      unassigned: state.unassigned,
      mcpInstalled: state.mcpInstalled,
      mcpError: state.mcpError,
      mcpExternalsError: state.mcpExternalsError,
      lspInstalled: state.lspInstalled,
      lspError: state.lspError,
      lspServersError: state.lspServersError,
    }),
  )

  const rows = computed(() =>
    listingRowsFor(fetchedModelIdsFor(state.serverDraft), selectedServerOf(state)),
  )

  //: A fetched name's `+`, answered the same way as a toolbar slot's: the verdict
  //: is the composable's, so a click on an inert row cannot reach a write.
  function rowSlotFor(row) {
    return addRowSlotFor({ added: row.added, context: slotContextFor.value })
  }

  //: The toolbar's `+`, scoped to the page that is visible (§4.3): a new server
  //: from the server page or from no selection at all, a new model under the
  //: selected server from the model page.
  function addRow() {
    if (addSlot.value.disabled) return
    if (page.value === 'model') shell.addModelRow()
    else shell.addServerRow()
  }

  //: The toolbar's Save. A form that holds a problem is **not** a disabled
  //: button: the click is refused here and the reason is already in the band,
  //: because `refusal` is derived from the draft the field is bound to (§4.3).
  function saveRow() {
    if (saveSlot.value.disabled || refusal.value) return
    if (page.value === 'model') shell.saveModelDraft()
    else if (page.value === 'server') shell.saveServerDraft()
  }

  //: The listing's `+`, under the same guard as its verdict.
  function addFromListing(row) {
    if (rowSlotFor(row).disabled) return
    return shell.addModelFromListing(row.name)
  }

  //: *Fetch models*, under its own gate: the verdict that made the button inert
  //: is the same one that refuses the click, so a keyboard activation cannot
  //: reach a fetch the button said it would not make.
  function fetchModels() {
    if (fetchSlot.value.disabled) return
    return shell.fetchServerModels()
  }

  //: The delete verb and its two answers. Asking is refused by the same verdict
  //: that made the glyph inert; the answers are refused only while a write is in
  //: flight, which is what their own slots say.
  function askDelete() {
    if (deleteSlot.value.disabled) return
    shell.askDeleteRow(page.value)
  }

  function dismissDelete() {
    if (deleteConfirmation.value.cancel?.disabled) return
    shell.dismissDeleteRow()
  }

  function confirmDelete() {
    if (deleteConfirmation.value.confirm?.disabled) return
    return shell.confirmDeleteRow()
  }

  return {
    page,
    slotContextFor,
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
    refusal,
    message,
    addRow,
    saveRow,
    addFromListing,
    fetchModels,
    askDelete,
    dismissDelete,
    confirmDelete,
  }
}

//: The row the listing belongs to: the selected server, which is the parent the
//: `+` writes under. Read off the tree rather than the draft, because the draft
//: holds what is *typed* and the comparison is against what is *stored*.
function selectedServerOf(state) {
  return state.servers.find((server) => server.id === state.selectedServerId) ?? null
}

//: The listing table's one line of its own: the server **was** listed and
//: answered with nothing. Only the server page can show a listing, so only the
//: server page can be empty — and "nothing asked yet" is not a finding (§9.1-2).
function listingEmptyFor(state) {
  if (!state.serverDraft || state.modelDraft) return false
  if (state.fetchedModelsLoading != null) return false
  if (!hasFetchedListing(state.serverDraft)) return false
  return (fetchedModelIdsFor(state.serverDraft) ?? []).length === 0
}

//: The section the band speaks for. It is the dialog's own local state (a strip
//: nothing deep-links), so the shell holds it rather than the component: the band
//: is the shell's message area and one section's failure must not be printed
//: while another is on screen.
function activeSectionOf(state) {
  return state.activeSection
}
