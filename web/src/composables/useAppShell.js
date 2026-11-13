import { reactive } from 'vue'
import { describePolicy } from '../lib/path-location-policy'
import { loadChatLsp, loadChatMcp } from './useChat'
import { useWorkspaceTree } from './useWorkspaceTree'
import { describeTransportError, fetchWithRetry } from '../lib/api-fetch'

// Read handle on "a batch is running", registered by useBatch on import — the
// same one-way hook useChat uses for its hub guards, so the two hubs' owners
// never have to import the composable that owns the flag.
let batchGuard = null

export function registerBatchGuard(isRunning) {
  batchGuard = typeof isRunning === 'function' ? isRunning : null
}

// ---------------------------------------------------------------------------
// The model connection as the store holds it (appdb-08).
//
// The dialog used to edit **one** connection: twelve fields of one workspace
// file, and a model chosen from that one server. It now edits a *catalogue* —
// servers, each with its own models — so the state below is a tree plus the
// dialog's selection inside it, and every write is addressed by the row id the
// read handed out.
//
// The rules are plain functions at the bottom of this file, so the dialog
// renders answers rather than deriving them, exactly as the modes and helper
// composables do. No range, no cap and no reasoning level is spelled here: they
// arrive in the read's ``caps``.
// ---------------------------------------------------------------------------

const state = reactive({
  config: null,
  configError: null,
  // The settings store's own state: ``{usable, sentence}``. §5.4 narrows the
  // app bar to the **store-level** question — is the store usable, and does it
  // hold at least one model? — because whether *this* turn can run is the
  // composer's business: that is where the agent is chosen and where the fix is
  // one click away. One warning in two places would mean two sentences to keep
  // in step, and a user who cannot tell which one they are answering.
  storeState: null,
  activeTab: 'chat', // chat | editor
  settingsOpen: false,
  settings: null,
  settingsLoading: false,
  settingsSaving: false,
  settingsError: null,
  // The store's ``servers`` rows, each carrying its ``models`` — the whole
  // connection, in the read's insertion order, exactly as the server answered it.
  servers: [],
  serversLoading: false,
  serversError: null,
  // The read's ``caps``: ``{samplerRanges, reasoningLevels}``. The form's
  // ``min``/``max`` and its reasoning options come from here.
  serversCaps: null,
  // ``{agentsWithoutModel, agents}`` — the one thing the connection read answers
  // about the *other* store, because a fresh install has four agents and no
  // models, and every one of them is unrunnable until it is given one (D7).
  unassigned: null,
  // The dialog's selection: which row the right-hand column edits. ``null`` id
  // with a draft means a row that does not exist yet (the Add affordance).
  selectedServerId: null,
  selectedModelId: null,
  // The row being edited, as a copy: a field typed here is not the store's
  // until Save posts it, and Close has nothing to undo.
  serverDraft: null,
  modelDraft: null,
  // Which servers the left column has opened, as their ids. A re-read that keeps
  // the rows keeps the shape the user left them in.
  expandedServers: [],
  // ``*Fetch models*`` answers, keyed by the row it was fetched for: the ids
  // that server's own ``/models`` listed, offered for the model name field. Per
  // server rather than one global dropdown, because a model belongs to the
  // server that names it (§5.1).
  fetchedModelIds: {},
  fetchedModelsLoading: null, // the key whose listing is in flight, or null
  // Refusals are keyed like the listings: a server that could not be listed is a
  // fact about *that* row, and one global field here would show its failure on
  // whichever server happens to be selected.
  fetchedModelsErrors: {},
  // One request for the Agent-modes dialog, bumped by the Models section's
  // unassigned line. A counter rather than a boolean because the composer owns
  // the card's open state (it mounts it), and a second opener must not be able
  // to leave a stale ``true`` behind that opens the card on the next mount.
  agentModesRequest: 0,
  mcpInstalled: false,
  mcpConnectors: [],
  mcpEnabled: [], // connector ids ticked in the dialog, saved via saveMcp()
  mcpLoading: false,
  mcpSaving: false,
  mcpError: null,
  mcpExternalsError: null, // .nojae/mcp-settings.json validation errors from the backend
  lspInstalled: false, // pygls/lsprotocol importable server-side
  lspServers: [],
  // Server ids ticked in the dialog, saved via saveLsp(). These ticks *are* the
  // activation decision: the save writes the declaration's `enable` flag and
  // nothing else (D13), so a ticked row runs here.
  //
  // Named `lspActivated`, never `lspEnabled`: that word belongs to the
  // **conversation**-scoped allowlist the Chat Tools panel holds and the chat /
  // Editor-query payloads send (D13 — the two meanings must not converge on one
  // word). This is the workspace-level "does this server run here" set.
  lspActivated: [],
  lspLoading: false,
  lspSaving: false,
  lspError: null,
  lspServersError: null, // .nojae/lsp-settings.json validation errors from the backend
  // Working location both hubs point at (${NOJAE_PATH_LOCATION} in
  // .nojae/mcp-settings.json and .nojae/lsp-settings.json), shown and set from
  // the app bar. ``pathLocation`` is what its input holds, ``pathLocationCurrent``
  // the value the server confirmed — Set is enabled while the two differ.
  pathLocation: '',
  pathLocationCurrent: '',
  pathLocationLoading: false,
  pathLocationSaving: false,
  pathLocationError: null,
  // The workspace's own read-write policy file (pol-05). The server seeds a
  // default ``.nojae/read-write-policy.json`` when a folder becomes the working
  // location, and reports what happened: ``{state, path, error}`` with
  // ``created`` / ``existing`` / ``absent`` / ``failed``. Only the block is
  // kept: the wording is ``lib/path-location-policy``'s, and a ``failed`` seed
  // is rendered as a *note* — never into ``pathLocationError``, because the
  // switch itself succeeded and a red line there would claim it had not.
  pathLocationPolicy: null,
  // The one sentence the app bar shows under its field for this file: set from
  // ``describePolicy`` only when its tone is ``warn``, so a ``created`` or
  // ``absent`` report (and ``existing``, which has nothing to tell) leaves the
  // bar's line out. Cleared on every attempt, so a note from a switch that has
  // since worked cannot linger.
  pathLocationPolicyNote: null,
})

function describeError(body, fallback) {
  const detail = body?.detail
  if (typeof detail === 'string' && detail) return detail
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => {
      const field = Array.isArray(item?.loc)
        ? item.loc.filter((part) => part !== 'body').join('.')
        : ''
      return field ? `${field}: ${item?.msg ?? 'invalid'}` : item?.msg ?? 'invalid'
    })
    if (messages.length) return messages.join(' · ')
  }
  return fallback
}

// ---------------------------------------------------------------------------
// The Models section's rules, as plain functions.
//
// Every one of these judges a row or a draft that is handed to it, so a test
// can ask the question without a mounted app, and the dialog only renders the
// answer. Nothing here holds state and nothing here spells a cap: the ranges
// and the reasoning levels come from the read's ``caps``, which is what the
// server refuses against too.
// ---------------------------------------------------------------------------

// The six samplers, in the order the form draws them. One list, so the draft,
// the payload and the grid cannot each carry their own copy.
export const SAMPLER_FIELDS = [
  'temperature', 'topP', 'topK', 'minP', 'repeatPenalty', 'presencePenalty',
]

// One row, as the form holds it. A **new** row is the same shape with a null id,
// which is what lets Save pick its route from the draft alone.
export function serverRowDraft(server) {
  return {
    id: server?.id ?? null,
    name: server?.name ?? '',
    url: server?.url ?? '',
    apiKey: server?.apiKey ?? '',
  }
}

export function modelRowDraft(model) {
  const draft = {
    id: model?.id ?? null,
    name: model?.name ?? '',
    sysPrompt: model?.sysPrompt ?? '',
    reasoning: model?.reasoning ?? '',
    supportsVision: model?.supportsVision === true,
  }
  for (const field of SAMPLER_FIELDS) draft[field] = model?.[field] ?? null
  return draft
}

// What a model write posts. The samplers go out as they stand — a null is the
// column's "unset", and a ``0`` is a ``0`` (§4.2 keeps them apart).
export function modelWritePayload(draft) {
  const payload = {
    name: draft.name,
    sysPrompt: draft.sysPrompt ?? '',
    reasoning: draft.reasoning || null,
    supportsVision: draft.supportsVision === true,
  }
  for (const field of SAMPLER_FIELDS) payload[field] = draft[field]
  return payload
}

// The key the fetched list is filed under: a saved row by its id, a new one by
// the sentinel, so an unsaved server still gets its own listing.
export function draftKey(draft) {
  return draft?.id ?? 'new'
}

export function selectedServer() {
  return state.servers.find((server) => server.id === state.selectedServerId) ?? null
}

// The list *Fetch models* answered for the row the form is editing.
export function fetchedModelIdsFor(draft) {
  return state.fetchedModelIds[draftKey(draft)] ?? []
}

// The refusal *Fetch models* answered for that row, or null when it listed it
// (or was never asked). Keyed like the list above: a server that could not be
// dialled is a fact about that row, not about whatever row is on screen.
export function fetchedModelsErrorFor(draft) {
  return state.fetchedModelsErrors[draftKey(draft)] ?? null
}

// The unassigned line's text, or null when there is nothing to say. The
// arithmetic lives here because it is a decision — "2 of 4 agents have no
// model" — and the dialog renders the sentence (§5.1).
export function unassignedLine(unassigned) {
  if (!unassigned || !unassigned.agents) return null
  const { agentsWithoutModel, agents } = unassigned
  if (!agentsWithoutModel) return null
  return `${agentsWithoutModel} of ${agents} agents have no model`
}

// One sampler's bounds, read off the caps so the field and the server's refusal
// agree. A bound the app does not state is no attribute on the input.
export function samplerBounds(caps, field) {
  const range = caps?.samplerRanges?.[field]
  return { min: range?.min ?? null, max: range?.max ?? null }
}

// The model the composer's views read a per-model flag off.
//
// `GET /api/config` answers **per model** and deliberately names no default
// (D5), so "the" model is the composer's answer, not the route's. The composer
// gets a selection in the same task that gives an agent its model dropdown; until
// then this answers the first entry, which is the shape the two views had while
// one connection served the whole app. It returns null for an install with no
// model, so a flag read off it is `false` rather than a guess.
export function modelInView(config) {
  const models = config?.models
  return Array.isArray(models) && models.length ? models[0] : null
}

// The destructive confirmations D12 asks for. They name what else goes with the
// row, because that is the part a user cannot retype — and the cascade is the
// schema's, so the client states its consequence without owning its rule.
export function serverDeleteSentence(server) {
  const models = server?.models?.length ?? 0
  return models
    ? `Delete ${server.name} and the ${models} model${models === 1 ? '' : 's'} under it? ` +
      'Agents running on them will have no model.'
    : `Delete ${server.name}?`
}

export function modelDeleteSentence(model) {
  return `Delete ${model?.name ?? 'this model'}? Agents running on it will have no model.`
}

export function useAppShell() {
  async function loadConfig() {
    state.configError = null
    try {
      const res = await fetchWithRetry('/api/config')
      const body = await res.json()
      if (!res.ok) {
        state.configError =
          typeof body.detail === 'string'
            ? body.detail
            : JSON.stringify(body.detail)
        state.config = null
        // An unusable store answers 422 with its own sentence, so that sentence
        // is the store-level state too -- the bar shows one line, not two.
        state.storeState = { usable: false, sentence: state.configError }
        return
      }
      state.config = body
      state.storeState = body.store ?? null
    } catch (exc) {
      state.configError = describeTransportError(exc)
      state.storeState = { usable: false, sentence: state.configError }
    }
  }

  // A running batch pins the app to WorkBench: the tab buttons are disabled,
  // but the refusal lives here too so a keyboard path cannot escape mid-lot
  // (the same rule the composer's launch guard already enforces). Switching *to*
  // the tab the batch is on stays allowed, which is what lets BatchModeDialog's
  // Launch perform its own setTab('chat') — the flag is set only afterwards.
  //
  // The predicate is registered by useBatch rather than imported: useAppShell
  // already imports useChat, and useBatch imports both, so importing useBatch
  // here would close a cycle. The flag itself stays single-owner
  // (useBatch.state.active) — this only hands a read handle down.
  function batchRunning() {
    return !!batchGuard?.()
  }

  function setTab(tab) {
    // A running batch pins the app to the tab it is on; the refusal lives here
    // too so a keyboard path cannot escape mid-lot.
    if (batchRunning() && tab !== state.activeTab) return
    state.activeTab = tab
  }

  async function openSettings() {
    if (state.settingsLoading || batchRunning()) return
    state.settingsError = null
    state.settingsLoading = true
    state.settingsOpen = true
    // Opening the dialog *is* a read of the store now: the Models section's
    // whole payload is `/api/servers`, so there is no separate `/api/settings`
    // document to fetch first. `state.settings` stays the dialog's "may I
    // render" flag, set as soon as the store has been asked.
    state.settings = { store: true }
    try {
      state.mcpConnectors = []
      state.mcpEnabled = []
      state.mcpError = null
      state.mcpExternalsError = null
      state.lspServers = []
      state.lspActivated = []
      state.lspError = null
      state.lspServersError = null
      // The working location is not this dialog's business any more: its field
      // and its answer lines live in the app bar, whose state a settings read
      // must not clear (a seed warning the user has not read yet would vanish
      // on an unrelated visit to the dialog). ``loadPathLocation()`` runs at
      // boot and after every switch.
      loadServers()
      loadMcp()
      loadLsp()
    } catch (exc) {
      state.settingsError = describeTransportError(exc)
    } finally {
      state.settingsLoading = false
    }
  }

  function closeSettings() {
    state.settingsOpen = false
    state.settingsError = null
  }

  // -- the Models section: the store's servers and models -----------------------

  // The read's whole answer, adopted wholesale. Every write below answers the
  // same shape, so the dialog re-baselines on the server's rows instead of
  // splicing the one it sent — which is also what makes a cascade (deleting a
  // server takes its models) visible without the client knowing the rule.
  function adoptServers(body) {
    state.servers = Array.isArray(body?.servers) ? body.servers : []
    state.serversCaps = body?.caps ?? null
    state.unassigned = body?.unassigned ?? null
    // A row that stopped existing cannot stay selected, and a draft of a row
    // that is gone must not be savable. A **new** row's draft is neither: it
    // addresses nothing, so no write from anywhere can have removed it, and
    // dropping it here would empty the form the user is typing into.
    const isNewRowDraft =
      state.selectedServerId === null && state.serverDraft !== null
    if (
      !isNewRowDraft &&
      !state.servers.some((server) => server.id === state.selectedServerId)
    ) {
      selectServer(state.servers[0]?.id ?? null)
    }
    const server = selectedServer()
    if (
      state.selectedModelId !== null &&
      !server?.models.some((model) => model.id === state.selectedModelId)
    ) {
      selectModel(null)
    }
  }

  async function loadServers() {
    state.serversLoading = true
    state.serversError = null
    try {
      const res = await fetchWithRetry('/api/servers')
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        state.serversError = describeError(
          body,
          `Could not load the model connection (${res.status})`,
        )
        return
      }
      adoptServers(body)
    } catch (exc) {
      state.serversError = describeTransportError(exc)
    } finally {
      state.serversLoading = false
    }
  }

  // One POST to one of the store's write routes, answered with the new tree.
  // The three server writes and the three model writes differ only in path and
  // body, so the answer's shape — and the sentence when it fails — is decided
  // once here.
  async function postConnectionWrite(path, payload, fallback) {
    state.settingsSaving = true
    state.serversError = null
    try {
      const res = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        state.serversError = describeError(body, fallback)
        return false
      }
      adoptServers(body)
      return true
    } catch (exc) {
      state.serversError = describeTransportError(exc)
      return false
    } finally {
      state.settingsSaving = false
    }
  }

  // -- selection and drafts ------------------------------------------------------

  // Selecting a row is what puts its copy in the right-hand column. The copy is
  // deliberate: typing in a field must not change what the store holds, and
  // Close has nothing to undo.
  function selectServer(id) {
    state.selectedServerId = id
    state.selectedModelId = null
    state.modelDraft = null
    const server = state.servers.find((entry) => entry.id === id) ?? null
    state.serverDraft = server ? serverRowDraft(server) : null
  }

  // Selecting a model selects its **server** too: the detail column shows the
  // model, the tree highlights the parent it belongs to, and a model row clicked
  // straight out of the tree is still editable.
  function selectModel(id) {
    const parent =
      state.servers.find((server) =>
        server.models.some((model) => model.id === id)) ?? null
    if (parent && parent.id !== state.selectedServerId) {
      state.selectedServerId = parent.id
      state.serverDraft = serverRowDraft(parent)
    }
    state.selectedModelId = id
    const model = parent?.models.find((entry) => entry.id === id) ?? null
    state.modelDraft = model ? modelRowDraft(model) : null
  }

  // A new row: the same draft shape, with no id, so the form and the Save call
  // are one code path and the difference is only which route it posts to.
  function addServerRow() {
    state.selectedServerId = null
    state.selectedModelId = null
    state.modelDraft = null
    state.serverDraft = serverRowDraft(null)
  }

  function addModelRow() {
    state.selectedModelId = null
    state.modelDraft = modelRowDraft(null)
  }

  async function saveServerDraft() {
    const draft = state.serverDraft
    if (!draft) return
    const payload = { name: draft.name, url: draft.url, apiKey: draft.apiKey }
    const isNew = draft.id === null
    if (!isNew) payload.id = draft.id
    const ok = await postConnectionWrite(
      isNew ? '/api/servers/add' : '/api/servers/save',
      payload,
      `Could not save the server (${isNew ? 'added' : 'saved'})`,
    )
    if (ok) {
      // The new row is the last one the read answered; a save keeps the
      // selection on the row the user was editing, which is now addressed.
      const saved = state.servers.find(
        (server) =>
          (isNew && server.name === payload.name) || server.id === draft.id,
      )
      if (saved) selectServer(saved.id)
    }
  }

  async function saveModelDraft() {
    const draft = state.modelDraft
    const server = selectedServer()
    if (!draft || !server) return
    const payload = modelWritePayload(draft)
    const isNew = draft.id === null
    if (isNew) payload.serverId = server.id
    else payload.id = draft.id
    const ok = await postConnectionWrite(
      isNew ? '/api/models/add' : '/api/models/save',
      payload,
      'Could not save the model',
    )
    if (ok) {
      // Look the row up in the tree the write answered, not in the one held
      // before it: the write replaced ``state.servers`` wholesale.
      const saved = selectedServer()?.models.find(
        (model) =>
          (isNew && model.name === payload.name) || model.id === draft.id,
      )
      if (saved) selectModel(saved.id)
    }
  }

  // The destructive writes. The confirm is the caller's (the dialog asks), and
  // the server keeps its own copy of the database first (D12) — the client's
  // sentence names what else goes with the row, because that is the part the
  // user cannot undo by retyping.
  async function deleteServerRow(id) {
    if (id === null) return
    await postConnectionWrite('/api/servers/delete', { id }, 'Could not delete the server')
  }

  async function deleteModelRow(id) {
    if (id === null) return
    await postConnectionWrite('/api/models/delete', { id }, 'Could not delete the model')
  }

  function toggleServerExpanded(id) {
    const opened = new Set(state.expandedServers)
    if (opened.has(id)) opened.delete(id)
    else opened.add(id)
    state.expandedServers = [...opened]
  }

  // *Fetch models*: the existing live listing call, now answering **a server's**
  // model list rather than one global dropdown. It dials the URL and key in the
  // draft, not the stored row, so a server whose address was just corrected can
  // be listed before it is saved.
  async function fetchServerModels() {
    const draft = state.serverDraft
    const serverUrl = (draft?.url || '').trim()
    const key = (draft?.apiKey || '').trim()
    const id = draftKey(draft)
    const forgetFailure = () => {
      const { [id]: _gone, ...rest } = state.fetchedModelsErrors
      state.fetchedModelsErrors = rest
    }
    forgetFailure()
    if (!serverUrl) {
      state.fetchedModelIds = { ...state.fetchedModelIds, [id]: [] }
      return
    }
    if (state.fetchedModelsLoading === id) return
    state.fetchedModelsLoading = id
    state.fetchedModelIds = { ...state.fetchedModelIds, [id]: [] }
    try {
      let url = `/api/models?serverUrl=${encodeURIComponent(serverUrl)}`
      if (key) url += `&apiKey=${encodeURIComponent(key)}`
      const res = await fetchWithRetry(url)
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        state.fetchedModelsErrors = {
          ...state.fetchedModelsErrors,
          [id]: describeError(body, `Could not load models (${res.status})`),
        }
        return
      }
      state.fetchedModelIds = {
        ...state.fetchedModelIds,
        [id]: body.models || [],
      }
    } catch (exc) {
      state.fetchedModelsErrors = {
        ...state.fetchedModelsErrors,
        [id]: describeTransportError(exc),
      }
    } finally {
      state.fetchedModelsLoading = null
    }
  }

  // The unassigned line's one action: ask for the Agent-modes dialog. The card
  // itself is mounted by the composer, which owns its open state — hence a
  // request rather than a flag.
  //
  // It closes this dialog on the way, because a `<dialog>` opened with
  // ``showModal`` is on top of everything: a card opened behind it would be a
  // click that did nothing at all. Nothing is lost by closing it — every write
  // lands as it is made, so there is no unsaved state here to abandon.
  function requestAgentModes() {
    closeSettings()
    state.agentModesRequest += 1
  }

  async function loadLsp() {
    state.lspLoading = true
    state.lspError = null
    try {
      const res = await fetchWithRetry('/api/lsp')
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        state.lspError = describeError(body, `Could not load LSP servers (${res.status})`)
        return
      }
      state.lspInstalled = !!body.installed
      state.lspServers = body.servers || []
      // No iteration counter here: the LSP payload stopped carrying the shared
      // tool-loop cap the moment this section lost its second gate — the cap is
      // the MCP section's knob alone (and becomes a per-agent value later).
      state.lspServersError = body.serversError || null
      // `active` is the declaration's `enable` flag, so the ticks mirror the
      // file the save writes back to.
      state.lspActivated = state.lspServers
        .filter((server) => server.active)
        .map((server) => server.id)
    } catch (exc) {
      state.lspError = describeTransportError(exc)
    } finally {
      state.lspLoading = false
    }
  }

  function toggleLsp(id, checked) {
    const activated = new Set(state.lspActivated)
    if (checked) activated.add(id)
    else activated.delete(id)
    // Keep declaration order so the saved list stays stable.
    state.lspActivated = state.lspServers
      .map((server) => server.id)
      .filter((serverId) => activated.has(serverId))
  }

  async function saveLsp() {
    if (state.lspSaving) return
    state.lspError = null
    state.lspSaving = true
    try {
      const res = await fetch('/api/lsp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The whole payload: the route writes the declaration's `enable` flag
        // for these ids and nothing else (D13).
        body: JSON.stringify({ enabled: state.lspActivated }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        state.lspError = describeError(body, `Could not save LSP settings (${res.status})`)
        return
      }
      state.lspInstalled = !!body.installed
      state.lspServers = body.servers || []
      state.lspServersError = body.serversError || null
      state.lspActivated = state.lspServers
        .filter((server) => server.active)
        .map((server) => server.id)
      state.settingsOpen = false
      // Keep the Chat tab's conversation-scoped LSP panel in sync with the
      // just-saved activation set (kept-OFF switches survive; a locked
      // conversation keeps its frozen list — loadChatLsp is a no-op then).
      loadChatLsp()
    } catch (exc) {
      state.lspError = `Could not reach the API: ${exc}`
    } finally {
      state.lspSaving = false
    }
  }

  async function loadMcp() {
    state.mcpLoading = true
    state.mcpError = null
    try {
      const res = await fetchWithRetry('/api/mcp')
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        state.mcpError = describeError(body, `Could not load MCP connectors (${res.status})`)
        return
      }
      state.mcpInstalled = !!body.installed
      state.mcpConnectors = body.connectors || []
      // No tool-loop cap here: it is a per-agent column now (D9), so this
      // section neither reads nor writes one.
      state.mcpExternalsError = body.externalsError || null
      state.mcpEnabled = state.mcpConnectors
        .filter((connector) => connector.active)
        .map((connector) => connector.id)
    } catch (exc) {
      state.mcpError = describeTransportError(exc)
    } finally {
      state.mcpLoading = false
    }
  }

  function toggleMcp(id, checked) {
    const enabled = new Set(state.mcpEnabled)
    if (checked) enabled.add(id)
    else enabled.delete(id)
    // Keep discovery order so the saved list stays stable.
    state.mcpEnabled = state.mcpConnectors
      .map((connector) => connector.id)
      .filter((connectorId) => enabled.has(connectorId))
  }

  async function saveMcp() {
    if (state.mcpSaving) return
    state.mcpError = null
    state.mcpSaving = true
    try {
      const res = await fetch('/api/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The ids and nothing else: the cap is the agent tab's to edit.
        body: JSON.stringify({ enabled: state.mcpEnabled }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        state.mcpError = describeError(body, `Could not save MCP settings (${res.status})`)
        return
      }
      state.mcpInstalled = !!body.installed
      state.mcpConnectors = body.connectors || []
      state.mcpExternalsError = body.externalsError || null
      state.mcpEnabled = state.mcpConnectors
        .filter((connector) => connector.active)
        .map((connector) => connector.id)
      state.settingsOpen = false
      // Keep the Chat tab's conversation-scoped MCP panel in sync with the
      // just-saved activation set (kept OFF switches survive; a locked
      // conversation keeps its frozen list — loadChatMcp is a no-op then).
      loadChatMcp()
    } catch (exc) {
      state.mcpError = `Could not reach the API: ${exc}`
    } finally {
      state.mcpSaving = false
    }
  }

  async function loadPathLocation() {
    state.pathLocationLoading = true
    state.pathLocationError = null
    try {
      const res = await fetchWithRetry('/api/path-location')
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        state.pathLocationError = describeError(
          body,
          `Could not load the working location (${res.status})`,
        )
        return
      }
      state.pathLocationCurrent = body.path || ''
      state.pathLocation = state.pathLocationCurrent
      // Read-only on purpose: GET never seeds (a read that writes a folder into
      // someone's project is the mistake pol-05 forbids), so ``absent`` here is
      // a real state — a workspace whose seed failed, or one opened before the
      // feature existed.
      state.pathLocationPolicy = body.policy || null
      // Same rule as after a switch: only a ``warn`` tone becomes the bar's own
      // line, so ``absent`` stays silent, and a lingering note from an earlier
      // attempt cannot outlive the read that disproves it.
      const described = describePolicy(body.policy)
      state.pathLocationPolicyNote =
        described && described.tone === 'warn' ? described.text : null
      // The agents and the prompt helpers are not here any more: they live in
      // ``nojae.db``, so there is no per-workspace file for a read to report on
      // (D11).
    } catch (exc) {
      state.pathLocationError = describeTransportError(exc)
    } finally {
      state.pathLocationLoading = false
    }
  }

  // Apply a new working location: the endpoint sets the env var and restarts
  // both hubs in one call, so on return the MCP/LSP panels below already
  // carry the post-restart statuses of the tools pointed at the new folder.
  async function setPathLocation() {
    if (state.pathLocationSaving) return
    const next = (state.pathLocation || '').trim()
    if (!next || next === state.pathLocationCurrent) return
    state.pathLocationSaving = true
    state.pathLocationError = null
    state.pathLocationPolicyNote = null
    try {
      const res = await fetch('/api/path-location', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: next }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        state.pathLocationError = describeError(
          body,
          `Could not set the working location (${res.status})`,
        )
        return
      }
      // The server canonicalises the path (realpath), so adopt what it stored
      // rather than what was typed: field and Set button then agree.
      state.pathLocationCurrent = body.path || ''
      state.pathLocation = state.pathLocationCurrent
      // pol-05: the switch seeded this workspace's default policy file (or
      // tried to). A ``failed`` state is a note, not an error — the location is
      // set and both hubs restarted; only the workspace's own rules are
      // missing. ``lib/path-location-policy`` is what turns the block into the
      // sentence under the app bar's field — its own words, and the only place
      // these two blocks are rendered.
      state.pathLocationPolicy = body.policy || null
      const described = describePolicy(body.policy)
      state.pathLocationPolicyNote =
        described && described.tone === 'warn' ? described.text : null
      // The hubs just restarted: refresh both panels so the tool lists and
      // status dots show the new location.
      if (body.mcp) {
        state.mcpInstalled = !!body.mcp.installed
        state.mcpConnectors = body.mcp.connectors || []
        state.mcpExternalsError = body.mcp.externalsError || null
        state.mcpEnabled = state.mcpConnectors
          .filter((connector) => connector.active)
          .map((connector) => connector.id)
        loadChatMcp()
      }
      if (body.lsp) {
        state.lspInstalled = !!body.lsp.installed
        state.lspServers = body.lsp.servers || []
        state.lspServersError = body.lsp.serversError || null
        state.lspActivated = state.lspServers
          .filter((server) => server.active)
          .map((server) => server.id)
        loadChatLsp()
      }
      // **Three things are deliberately not reloaded here** (D11): the model
      // connection, the agent list and the prompt helpers. All three live in
      // ``nojae.db``, which belongs to the installation rather than to a folder,
      // so a workspace switch invalidates nothing in them — the servers, models,
      // agents and bullets a user built once are the same everywhere. The
      // composer's *selected* agent does not move either, and that is one more
      // reason no refresh belongs here: the list is identical, and the selection
      // is the browser's own memory (`localStorage`), not the workspace's.
      // The Editor tab's tree browses this location, so the whole workspace-
      // relative view of the app moves here: the tree forgets the listings it
      // cached under the old root and re-roots, and the tabs that held files of
      // the old one close with it (useWorkspaceTree.reRoot -> the buffer half's
      // handler, registered by useEditorFiles when the Editor chunk loads).
      // Driven from the save path rather than from the tab, because the tab may
      // never have been opened — in which case there is nothing to forget.
      // `refresh()` would be the wrong call: its cached paths mean something
      // else entirely in another root. (The terminal's `cwd` moves with the same
      // value: a new session is born on the current location.)
      try {
        await useWorkspaceTree().reRoot(state.pathLocationCurrent)
      } catch (exc) {
        // The hubs moved but the tree could not be listed: the panel and the
        // tools agree, and the next tree request re-reads it. Say so rather
        // than let it end the save as a failure.
        state.pathLocationError = `Working location is set, but the file tree could not re-root: ${exc}`
      }
    } catch (exc) {
      state.pathLocationError = `Could not reach the API: ${exc}`
    } finally {
      state.pathLocationSaving = false
    }
  }

  return {
    state,
    loadConfig,
    batchRunning,
    setTab,
    openSettings,
    closeSettings,
    loadServers,
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
    loadMcp,
    toggleMcp,
    saveMcp,
    loadLsp,
    toggleLsp,
    saveLsp,
    loadPathLocation,
    setPathLocation,
  }
}
