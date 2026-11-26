import { reactive } from 'vue'
import { loadChatLsp, loadChatMcp } from './useChat'
import {
  noteHubPayload,
  reportPoolRefusal,
  useWorkspaceSession,
  withWorkspace,
} from './useWorkspaceSession'
import { describeTransportError, fetchWithRetry } from '../lib/api-fetch'

// Read handle on "a batch is running", registered by useBatch on import — the
// same one-way hook useChat uses for its hub guards, so the two hubs' owners
// never have to import the composable that owns the flag.
let batchGuard = null

export function registerBatchGuard(isRunning) {
  batchGuard = typeof isRunning === 'function' ? isRunning : null
}

// The settings dialog's auto-save flush, registered by that dialog's composable
// (which imports this module, so this module cannot import it). The shell calls
// it before a gesture **replaces or drops a form** — `Close`, and any row
// selection — so a click that lands before the debounce has run still writes
// what was typed.
let settingsAutoSaveFlush = null

export function registerSettingsAutoSaveFlush(flush) {
  settingsAutoSaveFlush = typeof flush === 'function' ? flush : null
}

// ---------------------------------------------------------------------------
// The model connection as the store holds it.
//
// The dialog edits a *catalogue* — servers, each with its own models — so the
// state below is a tree plus the dialog's selection inside it, and every write
// is addressed by the row id the read handed out.
//
// The rules are plain functions in this file, so the dialog renders answers
// rather than deriving them. No range, no cap and no reasoning level is spelled
// here: they arrive in the read's ``caps``.
// ---------------------------------------------------------------------------

const state = reactive({
  config: null,
  configError: null,
  // The settings store's own state: ``{usable, sentence}``. The app bar answers
  // only the **store-level** question — is the store usable, and does it hold at
  // least one model? Whether *this* turn can run is the composer's business, and
  // one warning in two places would mean two sentences to keep in step.
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
  // True once a **read** has answered. Neither a failed read nor a failed write
  // clears it: the rows on screen are still the store's either way, so the form
  // must stay usable and say the failure's sentence rather than going inert as
  // unread — a row that is there can be deleted, and the store answers a delete
  // of a row it no longer holds with its own 404 sentence.
  serversLoaded: false,
  serversError: null,
  // The read's ``caps``: ``{samplerRanges, reasoningLevels}``. The form's
  // ``min``/``max`` and its reasoning options come from here.
  serversCaps: null,
  // ``{agentsWithoutModel, agents}`` — the one thing the connection read answers
  // about the *other* store, because a fresh install has agents and no models,
  // and every one of them is unrunnable until it is given one.
  unassigned: null,
  // Which section the dialog's strip is on. It lives here rather than in the
  // component because the dialog's **one** message band is the shell's answer:
  // a section's failure must not be printed while another section is on screen,
  // and a message area that read component state could not know which it was.
  activeSection: 'servers',
  // Which of the detail column's two pages is drawn (`settings` | `prompt`).
  // Shell state because the flow that adds a model from the server page's
  // listing has to *set* it, and that flow is a shell action.
  detailTab: 'settings',
  // The row a delete is being confirmed for: `{kind, id}`, or null. The id is
  // captured when the question is asked, so the confirmation answers *that*
  // row even if the selection moves before it is confirmed.
  pendingDelete: null,
  // The sentence the band says while a delete awaits its answer. Set when the
  // question is asked, cleared with it — the copy is the store's own
  // (`serverDeleteSentence` / `modelDeleteSentence`), never re-derived here.
  pendingDeleteSentence: null,
  // The tree row to focus once the DOM has caught up. Set when a model is added
  // from the listing, which must land on its new row; the component consumes it
  // and clears it.
  focusTreeRowId: null,
  // The dialog's selection: which row the right-hand column edits. ``null`` id
  // with a draft means a row that does not exist yet (the Add affordance).
  selectedServerId: null,
  selectedModelId: null,
  // The row being edited, as a copy. A keystroke here is written to the store
  // by the dialog's auto-save, so the copy is only ever a few hundred
  // milliseconds ahead of what the store holds.
  serverDraft: null,
  modelDraft: null,
  // Which servers the left column has opened, as their ids. A re-read that keeps
  // the rows keeps the shape the user left them in.
  expandedServers: [],
  // ``*Fetch models*`` answers, keyed by the row it was fetched for: the ids
  // that server's own ``/models`` listed, offered for the model name field. Per
  // server rather than one global dropdown, because a model belongs to the
  // server that names it. The key includes the endpoint the list came from, so a
  // URL/key edit (or a reused row id) cannot show a dead server's listing.
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
  // `null` means "not known yet": a package flag is only trusted after a read
  // has answered, so a failed read is never reported as "not installed".
  mcpInstalled: null,
  mcpConnectors: [],
  mcpEnabled: [], // connector ids ticked in the dialog, saved via saveMcp()
  mcpLoading: false,
  mcpSaving: false,
  mcpError: null,
  mcpExternalsError: null, // .nojae/mcp-settings.json validation errors from the backend
  lspInstalled: null, // pygls/lsprotocol importable server-side; null = not read yet
  lspServers: [],
  // Server ids ticked in the dialog, saved via saveLsp(). These ticks *are* the
  // activation decision: the save writes the declaration's `enable` flag and
  // nothing else, so a ticked row runs here.
  //
  // Named `lspActivated`, never `lspEnabled`: that word belongs to the
  // **conversation**-scoped allowlist the Chat Tools panel holds and the chat /
  // Editor-query payloads send — the two meanings must not converge on one word.
  // This is the workspace-level "does this server run here" set.
  lspActivated: [],
  lspLoading: false,
  lspSaving: false,
  lspError: null,
  lspServersError: null, // .nojae/lsp-settings.json validation errors from the backend
  // The folder this tab works on is **not** held here: it is the tab's own, in
  // ``useWorkspaceSession``. What stays in the shell is only what the hub panels
  // need — the connector and language-server rows the workspace read answered
  // with — because those panels are the shell's state and the app bar performs
  // the gesture. The policy note the read reports lives with the field that
  // renders it, in the session composable.
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
// Each one judges a row or a draft handed to it, so a test can ask the question
// without a mounted app and the dialog only renders the answer. Nothing here
// holds state and nothing spells a cap: the ranges and the reasoning levels come
// from the read's ``caps``, which is what the server refuses against too.
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
// column's "unset", and a ``0`` is a ``0``. The two must stay apart.
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

// The key the fetched list is filed under: the row's id **and the endpoint it
// was fetched from**, so a save that changes the URL or key cannot reuse an
// answer about another endpoint. A new row uses the sentinel, so an unsaved
// server still gets its own listing.
export function draftKey(draft) {
  if (!draft || draft.id === null || draft.id === undefined) return 'new'
  return `${draft.id}|${String(draft.url ?? '').trim()}|${String(draft.apiKey ?? '').trim()}`
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

// Has this row ever been listed? The listing table distinguishes "nothing asked
// yet" from "asked, and the server answered with no names" — the second is a
// fact worth saying, the first is not. Keyed like the listings.
export function hasFetchedListing(draft) {
  return draft !== null && draft !== undefined &&
    Object.prototype.hasOwnProperty.call(state.fetchedModelIds, draftKey(draft))
}

// The listing and error caches are facts about an endpoint, not about an id the
// store can reuse. These two helpers make a stale entry impossible: one forgets
// every entry for a row, the other drops entries whose row no longer exists.
function isCacheKeyFor(key, id) {
  return String(key) === String(id) || String(key).startsWith(`${id}|`)
}

function dropServerCaches(id, { listing = true, errors = true } = {}) {
  if (id === null || id === undefined) return
  const keep = (cache) =>
    Object.fromEntries(
      Object.entries(cache).filter(([key]) => !isCacheKeyFor(key, id)),
    )
  if (listing) state.fetchedModelIds = keep(state.fetchedModelIds)
  if (errors) state.fetchedModelsErrors = keep(state.fetchedModelsErrors)
}

function pruneServerCaches() {
  const present = new Set(state.servers.map((server) => server.id))
  const keep = (cache) =>
    Object.fromEntries(
      Object.entries(cache).filter(([key]) => {
        const head = String(key).split('|')[0]
        if (head === 'new') return true
        const id = Number(head)
        return !Number.isFinite(id) || present.has(id)
      }),
    )
  state.fetchedModelIds = keep(state.fetchedModelIds)
  state.fetchedModelsErrors = keep(state.fetchedModelsErrors)
}

// The unassigned line's text, or null when there is nothing to say. The
// arithmetic lives here because it is a decision — "2 of 4 agents have no
// model" — and the dialog renders the sentence.
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
// `GET /api/config` answers **per model** and deliberately names no default, so
// "the" model is the composer's answer, not the route's — and the caller has to
// say which agent it is asking about. `mode` is an agent row (its `modelId` is
// the pointer); with one held, the answer is that row's model **or null**: a row
// naming a model the catalogue no longer holds must blank the flag, because
// falling back to another model would state a cap that belongs to a stranger.
//
// `models[0]` answers only when the caller has no agent to name at all — the
// list has not been read, or the store holds no row — which is the one case where
// no better answer exists yet.
export function modelInView(config, mode = null) {
  const models = Array.isArray(config?.models) ? config.models : []
  if (!models.length) return null
  const wanted = mode?.modelId
  if (wanted !== null && wanted !== undefined) {
    return models.find((model) => model?.id === wanted) ?? null
  }
  return models[0]
}

//: **Does the dialog hold something the store does not?** — the auto-save's only
//: question, asked of every surface it can write. The baseline is always *the
//: store's answer* (``state.servers``, adopted wholesale by every read and every
//: write, plus the hub reads' ``active`` flags), never what was typed, which is
//: what makes the answer self-clearing: a write re-baselines, so the same bytes
//: are never posted twice.
//:
//: An **unsaved** row is judged against the empty form the Add verb creates, so a
//: form opened and never typed in is not a write to make. A row the store no
//: longer holds *does* count: what is typed addresses nothing else.
const SERVER_DIRTY_FIELDS = ['name', 'url', 'apiKey']
const MODEL_DIRTY_FIELDS = [
  'name', 'sysPrompt', 'reasoning', 'supportsVision', ...SAMPLER_FIELDS,
]

//: One draft against the baseline it was filled from: the store's row went
//: through **the same constructor that fills the form**, so a comparison never
//: trips on a shape difference the form introduces (an absent `reasoning` is `''`
//: on both sides). With no row to answer for, the baseline is the empty form the
//: `+` produced.
function draftDiffers(draft, { row, fields, draftOf }) {
  if (!draft) return false
  const baseline = draftOf(row ?? null)
  if (draft.id == null) {
    // Unsaved: judged against the empty form, which is the only thing it can
    // have departed from.
    return !sameFields(draft, baseline, fields)
  }
  // A row the store no longer holds: what is typed addresses nothing.
  if (!row) return true
  return !sameFields(draft, baseline, fields)
}

function sameFields(draft, baseline, fields) {
  return fields.every((field) => sameField(draft?.[field], baseline?.[field]))
}

//: Two field-values, *the same thing the form holds*. A number typed into a
//: `type="number"` input arrives as a string while the store's row has a number,
//: and an unset column is `null` on one side and `''` on the other — neither is
//: something somebody typed, so neither may ask for a write. Anything else is
//: compared as it stands.
function sameField(held, stored) {
  if ((held ?? '') === (stored ?? '')) return true
  const bothFilled = held !== '' && held != null && stored !== '' && stored != null
  if (!bothFilled) return false
  const a = Number(held)
  const b = Number(stored)
  return Number.isFinite(a) && Number.isFinite(b) && a === b
}

//: Which row auto-save writes next, or null when the store already holds both
//: forms. One row at a time, and the server first: the two forms are never typed
//: in simultaneously, and a model write addresses its server's row, so saving the
//: parent before the child is the order a manual save could never violate.
export function settingsAutoSaveTarget(appState) {
  const servers = Array.isArray(appState?.servers) ? appState.servers : []
  const models = servers.flatMap((server) => server.models ?? [])
  if (
    draftDiffers(appState?.serverDraft ?? null, {
      row: servers.find((server) => server.id === appState?.serverDraft?.id) ?? null,
      fields: SERVER_DIRTY_FIELDS,
      draftOf: serverRowDraft,
    })
  ) {
    return 'server'
  }
  if (
    draftDiffers(appState?.modelDraft ?? null, {
      row: models.find((model) => model.id === appState?.modelDraft?.id) ?? null,
      fields: MODEL_DIRTY_FIELDS,
      draftOf: modelRowDraft,
    })
  ) {
    return 'model'
  }
  return null
}

//: A hub section's ticks differ the moment they disagree with the declaration the
//: read answered — the same shape as a draft against its row, and needing no
//: baseline of its own because the read's rows carry it. Order is never a
//: difference: both verbs re-materialise their list in declaration order.
export function hubSelectionDiffers(selected, rows) {
  const stored = (Array.isArray(rows) ? rows : [])
    .filter((row) => row?.active)
    .map((row) => row.id)
  const held = Array.isArray(selected) ? selected : []
  if (stored.length !== held.length) return true
  const set = new Set(held)
  return stored.some((id) => !set.has(id))
}

// The destructive confirmations. They name what else goes with the row, because
// that is the part a user cannot retype — and the cascade is the schema's, so
// the client states its consequence without owning its rule.
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
    if (batchRunning()) return
    // The MCP and LSP reads are workspace-scoped, so opening before the boot
    // workspace read has answered would name no folder (and be refused). The
    // app bar's button is disabled for the same window; this is the keyboard
    // guard.
    if (useWorkspaceSession().state.loading) return
    if (state.settingsOpen) return
    // A closed dialog whose reads are still in flight is reopened, not read
    // again: one set of answers is already on its way, and a second would race
    // it into the same state.
    if (state.settingsLoading) {
      state.settings = state.settings ?? { store: true }
      state.settingsOpen = true
      return
    }
    state.settingsError = null
    state.settingsLoading = true
    state.settingsOpen = true
    // Opening the dialog *is* a read of the store now: the Models section's
    // whole payload is `/api/servers`, so there is no separate `/api/settings`
    // document to fetch first. `state.settings` stays the dialog's "may I
    // render" flag, set as soon as the store has been asked.
    state.settings = { store: true }
    state.mcpConnectors = []
    state.mcpEnabled = []
    state.mcpInstalled = null
    state.mcpError = null
    state.mcpExternalsError = null
    state.lspServers = []
    state.lspActivated = []
    state.lspInstalled = null
    state.lspError = null
    state.lspServersError = null
    // The workspace is not this dialog's business: its field and its answer
    // lines live in the app bar, whose state a settings read must not clear
    // (a policy note the user has not read yet would vanish on an unrelated
    // visit to the dialog). ``loadWorkspace()`` runs at boot and
    // ``setWorkspaceFromField()`` on every move.
    try {
      // Await them: the loading flag is the single-flight guard, and the
      // section on screen has a fact to show while its read is in flight.
      await Promise.all([loadConfig(), loadServers(), loadMcp(), loadLsp()])
    } catch (exc) {
      state.settingsError = describeTransportError(exc)
    } finally {
      state.settingsLoading = false
    }
  }

  //: Leaving the dialog. **`Close` is its only exit, and it writes nothing of its
  //: own** — auto-save has written whatever was typed by the time it is clicked —
  //: but it does not *allow* a keystroke still inside the debounce window to be
  //: dropped, so the owed write is made here first, while the dialog still counts
  //: as open to the writer. Nothing is asked: there is no longer any work that
  //: leaving would lose.
  function closeSettings() {
    settingsAutoSaveFlush?.()
    state.settingsOpen = false
    state.settingsError = null
    // A delete that was asked but never answered dies with the dialog: the pair
    // is absent from the DOM when it is closed, so a pending question must not
    // survive to be answered against a state it was not asked in.
    state.pendingDelete = null
    state.pendingDeleteSentence = null
    // The **in-memory forms go with the close**, so a re-open reads the store
    // afresh rather than resuming a draft the store has already been told about.
    resetSettingsForms()
    // The hub ticks are the two forms the same reasoning covers; each section's
    // read re-derives them from the declaration's `active` flags on the next open.
    state.mcpEnabled = []
    state.lspActivated = []
  }

  //: Drop the dialog's copies without touching the store. `closeSettings` does
  //: this on the way out, and a write that landed while the dialog was already
  //: closed does it after the fact — its answer re-selected the row it wrote, and
  //: a closed dialog has no row showing.
  function resetSettingsForms() {
    state.selectedServerId = null
    state.selectedModelId = null
    state.serverDraft = null
    state.modelDraft = null
  }

  // -- the Models section: the store's servers and models -----------------------

  // The read's whole answer, adopted wholesale. Every write below answers the
  // same shape, so the dialog re-baselines on the server's rows instead of
  // splicing the one it sent — which is also what makes a cascade (deleting a
  // server takes its models) visible without the client knowing the rule.
  function adoptServers(body) {
    state.servers = Array.isArray(body?.servers) ? body.servers : []
    // A write's answer should carry the read's whole envelope. Keep the last
    // known caps/count when an older or partial answer omits them, rather than
    // blanking the form's bounds and the unassigned line on every write.
    if (body && Object.prototype.hasOwnProperty.call(body, 'caps')) {
      state.serversCaps = body.caps ?? null
    }
    if (body && Object.prototype.hasOwnProperty.call(body, 'unassigned')) {
      state.unassigned = body.unassigned ?? null
    }
    // A listing/error for a row the store no longer has is dead data, and SQLite
    // reuses a freed id: drop it before a new row can inherit it.
    pruneServerCaches()
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
      state.serversLoaded = true
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
      // A write that landed while the dialog was **closed** — a flush racing a
      // close — must not leave a selection and two forms standing for a dialog
      // that is not on screen: the bytes are in the store, and the next open
      // reads them from there. A dialog that was reopened by the time this
      // landed is a new visit and owns its own selection, so it is left alone
      // (`adoptDraft` matches the draft by identity, which a re-open broke).
      adoptServers(body)
      // The dialog edits what `/api/config` describes (the install's models),
      // so a successful write must move the app bar and the band with it.
      await loadConfig()
      if (!state.settingsOpen) resetSettingsForms()
      return true
    } catch (exc) {
      state.serversError = describeTransportError(exc)
      return false
    } finally {
      state.settingsSaving = false
    }
  }

  // -- selection and drafts ------------------------------------------------------

  //: A gesture that **replaces a form** writes it first: a click on another row
  //: half a second after a keystroke must not leave that keystroke in the form
  //: that is being thrown away. Cheap when nothing is owed, and inert while a
  //: write is in flight, which is what keeps a write's own re-selection from
  //: re-entering it.
  function flushSettingsDraft() {
    // Gated on the open dialog: a write's own answer re-selects the row it wrote
    // through this same verb, and a flush there would post again while that write
    // is still the one in flight.
    if (!state.settingsOpen) return null
    return settingsAutoSaveFlush?.() ?? null
  }

  // Selecting a row is what puts its copy in the right-hand column. The copy is
  // deliberate: typing in a field must not change what the store holds, and the
  // store is told about it in its own time.
  function selectServer(id) {
    // A pending question was asked about the row that was selected then; moving
    // the selection abandons it rather than letting the answer name one row and
    // delete another.
    dismissDeleteRow()
    flushSettingsDraft()
    state.selectedServerId = id
    state.selectedModelId = null
    state.modelDraft = null
    const server = state.servers.find((entry) => entry.id === id) ?? null
    state.serverDraft = server ? serverRowDraft(server) : null
  }

  // Selecting a model selects its **server** too: the detail column shows the
  // model, the tree highlights the parent it belongs to, and a model row clicked
  // straight out of the tree is still editable.
  //
  // The detail tab is **not** reset here. A model clicked out of the tree while
  // the strip is on `System prompt` opens on `System prompt`, the predictable
  // outcome; the one flow that *does* choose a page is the listing's `+`, which
  // asks for Settings explicitly.
  function selectModel(id) {
    dismissDeleteRow()
    flushSettingsDraft()
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

  //: A write's answer points the dialog at the row it stored, and **addresses the
  //: draft in place** rather than re-filling it: the form keeps whatever was typed
  //: while the write was in flight, which a re-fill from the store would silently
  //: drop. An addressed draft is also what makes the next keystroke an update of
  //: this row instead of a second add of it.
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
      // The store strips names, so the lookup compares trimmed text: a name
      // typed as ` Local ` must land on the row stored as `Local`.
      const wanted = payload.name.trim()
      const saved = state.servers.find(
        (server) =>
          (isNew && server.name.trim() === wanted) || server.id === draft.id,
      )
      if (saved) {
        // The listing/error was fetched from the endpoint as it stood before
        // the save. A fresh row's id can be a reused one, so it has no cache at
        // all; an existing row keeps its listing when the endpoint is unchanged
        // (the key carries the endpoint it came from) and drops it when the URL
        // or key moved. Either way an earlier fetch failure is forgotten now
        // the save succeeded.
        const endpointChanged = draftKey(draft) !== draftKey(saved)
        dropServerCaches(saved.id, { listing: isNew || endpointChanged })
        adoptDraft('server', draft, saved, payload)
      }
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
      // before it: the write replaced ``state.servers`` wholesale. The store
      // strips the name, so the comparison strips it too.
      const wanted = payload.name.trim()
      const saved = selectedServer()?.models.find(
        (model) =>
          (isNew && model.name.trim() === wanted) || model.id === draft.id,
      )
      if (saved) adoptDraft('model', draft, saved, payload)
    }
  }

  //: A draft, re-baselined on the row the store answered with. It takes the row's
  //: id — which is what turns the next keystroke into an update of *this* row
  //: rather than a second add of it — and, field by field, the store's own value
  //: wherever the form still holds what was posted (so a name the store stripped
  //: shows stripped, and a sampler it normalised reads as its answer). A field
  //: that has moved on since the POST holds typing that no write carried yet, so
  //: it is left exactly as typed: a write must never eat a character typed while
  //: it was in flight.
  function adoptDraft(kind, draft, saved, payload) {
    if (state[kind === 'model' ? 'modelDraft' : 'serverDraft'] !== draft) return
    const fields = kind === 'model' ? MODEL_DIRTY_FIELDS : SERVER_DIRTY_FIELDS
    for (const field of fields) {
      if (sameField(draft[field], payload[field])) draft[field] = saved[field] ?? draft[field]
    }
    draft.id = saved.id
    if (kind === 'model') state.selectedModelId = saved.id
    else state.selectedServerId = saved.id
  }

  // The destructive writes. The confirm is the caller's (the dialog asks), and
  // the server backs up its own database first — the client's sentence names what
  // else goes with the row, because that is the part the user cannot undo by
  // retyping.
  async function deleteServerRow(id) {
    if (id === null) return
    const ok = await postConnectionWrite(
      '/api/servers/delete',
      { id },
      'Could not delete the server',
    )
    // A deleted row's fetched listing and fetch error leave with it. The id may
    // be handed to a later server, and nothing about this endpoint describes
    // that one.
    if (ok) dropServerCaches(id)
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

  // *Fetch models*: the live listing call, answering **a server's** own model
  // list. It dials the URL and key in the draft, so a server whose address was
  // just corrected is listed from what is typed; the button is gated on the row
  // existing, which retires the unsaved-row path.
  //
  // The previous answer is **not** blanked on the way out: a 200-name table that
  // collapsed to nothing for a second and then re-grew is the exact reflow the
  // layout exists to prevent. An empty answer is still an answer, so it does
  // replace the rows once it lands.
  async function fetchServerModels() {
    const draft = state.serverDraft
    if (!draft || draft.id === null) return
    const serverUrl = (draft.url || '').trim()
    const key = (draft.apiKey || '').trim()
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

  // -- the Servers section's own actions --------------------------------------

  // The detail strip's two pages. Only a model has a second one, so the tab is
  // stored as asked and *read* through `detailPageFor`, which falls back to
  // Settings for a server.
  function setDetailTab(tab) {
    state.detailTab = tab === 'prompt' ? 'prompt' : 'settings'
  }

  // The listing's `+`: **a write**, not a pre-fill. One click posts the name, the
  // parent's id and nothing else — the six samplers stay null columns, so the
  // model runs on the endpoint's own defaults until someone edits them. The write
  // answers the whole tree, so no merge is needed: expand the parent, select the
  // new model, ask for its row to be focused, and open its Settings page, where
  // the name field already holds the name just added.
  async function addModelFromListing(name) {
    const server = selectedServer()
    if (!server || state.settingsSaving) return false
    const ok = await postConnectionWrite(
      '/api/models/add',
      { name, serverId: server.id },
      'Could not add the model',
    )
    if (!ok) return false
    // The store strips the name it was given, so the row it created is the one
    // whose trimmed name matches (a server-provided name may carry whitespace).
    const wanted = String(name).trim()
    const added = selectedServer()?.models.find(
      (model) => model.name.trim() === wanted,
    )
    if (!added) return true
    if (!state.expandedServers.includes(server.id)) {
      toggleServerExpanded(server.id)
    }
    selectModel(added.id)
    setDetailTab('settings')
    state.focusTreeRowId = added.id
    return true
  }

  // The inline delete confirmation, replacing `window.confirm`. Asking puts the
  // store's own sentence in the band — a server delete takes its models with it,
  // and that is the part nobody can retype — and the toolbar's two reserved slots
  // carry the answers. The cascade itself is the schema's and is untouched.
  function askDeleteRow(kind) {
    if (kind !== 'server' && kind !== 'model') return
    const model =
      kind === 'model'
        ? selectedServer()?.models.find(
            (entry) => entry.id === state.selectedModelId,
          ) ?? null
        : null
    const server = kind === 'server' ? selectedServer() : null
    if (kind === 'model' && (state.modelDraft?.id == null || !model)) return
    if (kind === 'server' && (state.serverDraft?.id == null || !server)) return
    // The subject is captured **now**, with the sentence: a later selection
    // change must neither re-aim the answer nor leave a stale question on
    // screen.
    state.pendingDelete = { kind, id: kind === 'server' ? server.id : model.id }
    state.pendingDeleteSentence =
      kind === 'server'
        ? serverDeleteSentence(server)
        : modelDeleteSentence(model)
  }

  function dismissDeleteRow() {
    state.pendingDelete = null
    state.pendingDeleteSentence = null
  }

  async function confirmDeleteRow() {
    const subject = state.pendingDelete
    if (!subject) return
    if (subject.kind === 'server') await deleteServerRow(subject.id)
    else if (subject.kind === 'model') await deleteModelRow(subject.id)
    dismissDeleteRow()
  }

  // The unassigned line's one action: ask for the Agent-modes dialog. The card
  // itself is mounted by the composer, which owns its open state — hence a
  // request rather than a flag.
  //
  // It closes this dialog on the way, because a `<dialog>` opened with
  // ``showModal`` is on top of everything: a card opened behind it would be a
  // click that did nothing at all. So this *is* a close, and it leaves through
  // the same verb, which is the one that writes what was typed.
  function requestAgentModes() {
    closeSettings()
    state.agentModesRequest += 1
  }

  async function loadLsp() {
    state.lspLoading = true
    state.lspError = null
    try {
      const res = await fetchWithRetry(withWorkspace('/api/lsp'))
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        state.lspError = describeError(body, `Could not load LSP servers (${res.status})`)
        // The pool's ceiling is one sentence wherever it is raised: the bar
        // shows it too, and this panel shows the same text.
        if (res.status === 429) reportPoolRefusal(state.lspError)
        return
      }
      // `built` is the visible restart; a live answer without it clears the
      // bar's restarting line.
      noteHubPayload(body)
      state.lspInstalled = !!body.installed
      state.lspServers = body.servers || []
      // No iteration counter here: the tool-loop cap is the agent's own column.
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
      const res = await fetch(withWorkspace('/api/lsp'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The whole payload: the route writes the declaration's `enable` flag
        // for these ids and nothing else.
        body: JSON.stringify({ enabled: state.lspActivated }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        state.lspError = describeError(body, `Could not save LSP settings (${res.status})`)
        if (res.status === 429) reportPoolRefusal(state.lspError)
        return
      }
      noteHubPayload(body)
      state.lspInstalled = !!body.installed
      state.lspServers = body.servers || []
      state.lspServersError = body.serversError || null
      state.lspActivated = state.lspServers
        .filter((server) => server.active)
        .map((server) => server.id)
      // Save is a write, not an exit: the dialog stays open, as it does for the
      // Servers section.
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
      const res = await fetchWithRetry(withWorkspace('/api/mcp'))
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        state.mcpError = describeError(body, `Could not load MCP connectors (${res.status})`)
        if (res.status === 429) reportPoolRefusal(state.mcpError)
        return
      }
      noteHubPayload(body)
      state.mcpInstalled = !!body.installed
      state.mcpConnectors = body.connectors || []
      // No tool-loop cap here: it is a per-agent column now, so this section
      // neither reads nor writes one.
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
      const res = await fetch(withWorkspace('/api/mcp'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // The ids and nothing else: the cap is the agent tab's to edit.
        body: JSON.stringify({ enabled: state.mcpEnabled }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        state.mcpError = describeError(body, `Could not save MCP settings (${res.status})`)
        if (res.status === 429) reportPoolRefusal(state.mcpError)
        return
      }
      noteHubPayload(body)
      state.mcpInstalled = !!body.installed
      state.mcpConnectors = body.connectors || []
      state.mcpExternalsError = body.externalsError || null
      state.mcpEnabled = state.mcpConnectors
        .filter((connector) => connector.active)
        .map((connector) => connector.id)
      // Save is a write, not an exit: the dialog stays open, as it does for the
      // Servers section.
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

  // Paint the hub panels from the ``hubs`` block of a workspace read.
  //
  // The app bar owns the tab's folder and the gesture that moves it; these two
  // panels are the shell's state, so the read hands them over rather than the bar
  // reaching in. Same shape as the two hub loaders above: the declaration file is
  // the only activation source, so the rows adopted here are the ones the server
  // says run, and the conversation-scoped panels are re-snapshotted from them (a
  // locked conversation keeps its frozen toggles — ``loadChatMcp`` is a no-op
  // then).
  //
  // **Nothing of the installation is reloaded by a move**: the model connection,
  // the agent list and the prompt helpers are rows of ``nojae.db``, so what a user
  // built once is the same in every folder. The tree re-rooting and the buffers
  // closing with it are the caller's — the gesture that moved the folder owns
  // what it invalidates.
  function applyWorkspaceHubs(hubs) {
    const mcp = hubs?.mcp
    if (mcp) {
      state.mcpInstalled = !!mcp.installed
      state.mcpConnectors = mcp.connectors || []
      state.mcpExternalsError = mcp.externalsError || null
      state.mcpEnabled = state.mcpConnectors
        .filter((connector) => connector.active)
        .map((connector) => connector.id)
      loadChatMcp()
    }
    const lsp = hubs?.lsp
    if (lsp) {
      state.lspInstalled = !!lsp.installed
      state.lspServers = lsp.servers || []
      state.lspServersError = lsp.serversError || null
      state.lspActivated = state.lspServers
        .filter((server) => server.active)
        .map((server) => server.id)
      loadChatLsp()
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
    setDetailTab,
    addModelFromListing,
    askDeleteRow,
    dismissDeleteRow,
    confirmDeleteRow,
    requestAgentModes,
    loadMcp,
    toggleMcp,
    saveMcp,
    loadLsp,
    toggleLsp,
    saveLsp,
    applyWorkspaceHubs,
  }
}
