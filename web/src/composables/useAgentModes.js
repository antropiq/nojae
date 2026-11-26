import { reactive } from 'vue'

import { AGENT_STORAGE_KEY } from './useWorkspaceSession'

// ---------------------------------------------------------------------------
// Agent modes: the persona WorkBench answers as, and what it may reach.
//
// One fetch (`GET /api/agents`) fills this singleton: the composer's dropdown,
// the hub panels' gray-out, the Agent-modes dialog and the `agentMode` key of
// every chat payload all read *here*, so the same verdict drives all four. The
// list is the **install's** — rows of nojae's settings store, the same in every
// workspace — so nothing here holds an agent id: an agent the app owns is
// recognised by `readonly` (which fields are disabled) and by `deletable`
// (whether Delete is offered), both of them **data** from the server, because
// `web/src` must never contain one of those ids.
//
// Every decision lives in this file as a plain function, so the components
// render answers instead of re-deriving rules — and no cap is spelled here
// either: the byte counter, the id pattern and the tool-iteration floor all
// arrive in the payload's `caps`.
//
// The last-used agent is **tab** state — `sessionStorage`, beside the tab's
// folder — and the dialog reads and saves the store's rows one agent at a time.
// ---------------------------------------------------------------------------

const state = reactive({
  // [{ id, label, mcpEnable, lspEnable, readonly, deletable, maxToolIteration,
  //    systemMessage, modelId, modelName }] — the rows `GET /api/agents`
  // answers, in dropdown order. `modelId` + `modelName` say whether this agent
  // can run at all: the composer's warning reads those fields rather than
  // re-deriving the rule.
  modes: [],
  current: null, // the agent id in play; null until a list has been read
  loaded: false, // false = the fetch failed; Send then refuses
  findings: [], // what the store's read noticed, if anything
  notice: null, // one quiet line the composer shows under the select
})

// A second fetch already in flight (tab entry racing a boot).
let inFlight = null

// ---------------------------------------------------------------------------
// The tab's remembered choice
// ---------------------------------------------------------------------------

// Where the last agent the user chose is remembered: the **tab's** storage,
// under `AGENT_STORAGE_KEY` — written and read here, but *named* in
// `useWorkspaceSession`, so the tab's two pieces of identity (its folder and its
// agent) are spelled in one file.
//
// `sessionStorage` and not `localStorage` is the whole requirement: browser-wide
// storage meant every tab answered as the same agent, and moving the choice in
// one moved it in all of them. Here a reload is the same tab and keeps its agent,
// a new tab starts on the list's first entry, and a closed tab forgets its
// choice. The **catalogue** stays the installation's: the same install-owned rows,
// selected per tab, not a per-tab copy of them.
//
// A `localStorage` value from an older build is **not** read: inheriting the old
// key would re-share a choice that is per tab now.

// Tolerant on purpose: a missing key, a cleared storage and a private-mode
// throw all mean the same thing — no remembered agent.
export function rememberedAgentId() {
  try {
    const value = window.sessionStorage.getItem(AGENT_STORAGE_KEY)
    return value ? value : null
  } catch {
    return null
  }
}

export function rememberAgent(id) {
  try {
    if (id) window.sessionStorage.setItem(AGENT_STORAGE_KEY, String(id))
    else window.sessionStorage.removeItem(AGENT_STORAGE_KEY)
  } catch {
    // Private mode / storage disabled: the choice lasts the tab's lifetime.
  }
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

// The mode object for an id (or for `state.current` when called with nothing).
export function modeById(id) {
  const wanted = id ?? state.current
  return state.modes.find((mode) => mode.id === wanted) ?? null
}

export function currentMode() {
  return modeById(state.current)
}

// `true` when the current mode switches that hub off, so the panel is disabled.
//
// Gated on `loaded` as much as on the flags: with a stale list this client
// cannot know what the turn it is about to send would gate, so the panels
// behave as they did before the feature (no gate). What the gate costs the user
// is said by the panel's own row tooltip.
export function modeBlocksHub(hub) {
  const mode = state.loaded ? currentMode() : null
  return !!mode && mode[`${hub}Enable`] === false
}

// The select's `title`: the mode's own sentence about what it can reach. The
// hub panels say the same thing per row, in their tooltips.
export function modeHint(id) {
  const mode = modeById(id)
  if (!mode) return ''
  const hubs = []
  if (mode.mcpEnable) hubs.push('MCP')
  if (mode.lspEnable) hubs.push('language servers')
  const tools = hubs.length
    ? `${hubs.join(' and ')} available`
    : 'no tools'
  return `${mode.label} — ${tools}`
}

// The `<select>`'s title: what the **selected** agent runs as and on, in three
// lines — `<agent>: <server>`, `model: <model>` and the two hubs with their
// verdict. The per-`<option>` tooltip stays the short `modeHint` sentence: a
// dropdown row is too narrow for this.
//
// Nothing is invented: the server name comes from the catalogue entry the agent's
// row points at (`GET /api/config`'s `models`, resolved by the caller), and the
// model name from that entry or — while the catalogue has not been read — from
// the name the agent row carries itself. A half that cannot be named is dropped,
// never guessed: an agent with no model shows no model line at all, and a row
// whose catalogue entry is gone keeps its model name but loses the server.
//
// The one qualifier is a running lot, which keeps the agent it launched with.
export function modeSelectTitle({ batchActive = false, models = [] } = {}) {
  const mode = modeById(state.current)
  if (!mode) return ''
  const entry = (Array.isArray(models) ? models : []).find(
    (model) => model?.id === mode.modelId,
  )
  const modelName = String(entry?.name ?? mode.modelName ?? '').trim()
  const serverName = String(entry?.serverName ?? '').trim()
  const lines = [serverName ? `${mode.label}: ${serverName}` : mode.label]
  if (modelName) lines.push(`model: ${modelName}`)
  lines.push(`MCP: ${mode.mcpEnable ? 'On' : 'Off'}, LSP: ${mode.lspEnable ? 'On' : 'Off'}`)
  if (batchActive) lines.push('a running lot keeps the agent it launched with')
  return lines.join('\n')
}

// Whether the whole `<select>` is inert: a running lot whose mode the runner took
// at launch, and nothing else. A mid-`streaming` switch is *not* in here — the
// server accepts an `agentMode` change at any point in a thread, so switching
// cannot reach the turn already in flight.
//
// The batch half is a *rendering* rule; the behaviour lives in useBatch, which
// reads this selection once per run into `state.pinnedMode` and sends that id on
// every task turn. So the select is disabled while a lot runs: changing it can
// neither move the running lot nor the next task of it, and leaving it live would
// advertise a power the dropdown does not have over a lot.
export function modeSelectDisabled(batchActive = false) {
  return !!batchActive
}

// Choosing an agent: whatever the thread has done, from any agent to any other.
// The only guard left is the list itself — a client never invents an id — plus
// the **tab's** memory of the choice.
export function setAgentMode(id) {
  const next = modeById(id)
  if (!next) return // never the server's list, never a guess
  state.current = next.id
  rememberAgent(next.id)
}

// What `send()` puts in `payload.agentMode`: null means *omit the key*, which the
// server answers with a 422 naming the field rather than a default — so the
// composer refuses the send before it gets there. Never a guess.
export function agentModePayloadId() {
  return state.loaded && state.current ? state.current : null
}

// *Can the selected agent run?* — the plain answer the composer's warning icon
// and its Send gate both read.
//
// It reads the row's **own** field (`modelId` plus the resolved `modelName`) and
// never re-derives the rule from two tables. The server's sentence — the one
// naming the agent — is the authority behind it, not something this client
// builds: no agent id is named here, and no model is guessed.
export function selectedAgentCanRun() {
  const mode = currentMode()
  if (!mode) return false // nothing read yet: the composer cannot name an agent
  return mode.modelId !== null && mode.modelId !== undefined
}

// The same answer for any row a caller holds (a lot's pinned agent, a test).
export function agentCanRun(mode) {
  return !!mode && mode.modelId !== null && mode.modelId !== undefined
}

//: The app bar's line for a **running** turn: which model the stream is being
//: answered by, on which server. It is the agent the turn was *sent* as that
//: answers (the caller resolves that id, not this function), and the names are
//: the server's — `modelName` from the agent row, the server from the model the
//: row points at in `GET /api/config`'s list.
//:
//: Nothing is invented here: an agent with no model, or one whose row names a
//: model the catalogue no longer holds and carries no name of its own, answers
//: null — the bar then says nothing rather than naming a stranger. The server
//: half is dropped alone when only it is missing, because the model name is
//: still the truth about the turn.
export function runningOnLine(mode, models) {
  if (!agentCanRun(mode)) return null
  const entry = (Array.isArray(models) ? models : []).find(
    (model) => model?.id === mode.modelId,
  )
  const modelName = String(entry?.name ?? mode.modelName ?? '').trim()
  if (!modelName) return null
  const serverName = String(entry?.serverName ?? '').trim()
  return serverName ? `Running ${modelName} on ${serverName}` : `Running ${modelName}`
}

//: The composer's warning. One wording for the icon's tooltip, its accessible
//: name and the Send button's disabled reason, so the user cannot read two
//: different explanations of the same state.
export const NO_MODEL_WARNING = 'Agent has no model to run with. Please assign a model'

//: What a composer whose list never arrived says. It cannot name an agent it has
//: not read, and there is no server-side default to lean on.
export const AGENT_LIST_WARNING =
  'The agent list could not be read — Send is unavailable until it loads'

// The sentence for the callers that *name* the agent (batch mode's launch
// refusal). The composer's icon does *not* use it: it must never name an agent
// id, and the icon is about the selection the user can see. Same wording as
// ``src.config.agent_connection_refusal``'s no-model branch, built from the
// row's label so the lot and the server say one thing.
export function agentNoModelSentence(mode) {
  const who = String(mode?.label ?? '').trim() || 'the selected agent'
  return `Agent ${who} has no model to run with. Please assign a model in the Agent modes dialog.`
}

// The one answer both the warning icon and the Send gate read: null when a turn
// may be sent, otherwise the reason it may not. Three states, in the order the
// user can act on them:
//
//  * the list never loaded — the composer cannot name an agent at all;
//  * a loaded list with no selection — the same answer, for a store with no rows;
//  * the selected row has no model — a server-side refusal behind it.
export function selectedAgentGateReason() {
  if (!state.loaded) return AGENT_LIST_WARNING
  const mode = currentMode()
  if (!mode) return AGENT_LIST_WARNING
  if (!agentCanRun(mode)) return NO_MODEL_WARNING
  return null
}

// One quiet line about what the store's read noticed. Not a modal and not a
// banner: a warning that cannot be dismissed would nag on every turn. The agents
// are rows, so the line names the dialog the user can fix them in, not a path.
export function findingsLine() {
  if (!state.findings.length) return null
  const n = state.findings.length
  return `${n} problem${n === 1 ? '' : 's'} in nojae's settings store — see the Agent modes dialog`
}

// The notice line is about one *loaded session*, so a new conversation retires
// it. `findingsLine()` needs no such reset: the store's problems come back with
// the next fetch of the list.
export function clearAgentModeNotice() {
  state.notice = null
}

// The mode a loaded session file asked for, judged against the loaded list.
//
// **The file wins over the tab's memory**, which is the one place the two kinds
// of state meet: the file describes the conversation, `sessionStorage` describes
// the tab, and the more specific one answers a resume. An unknown id falls back
// to the list's first entry — never to a different persona silently, and never
// by refusing to load the conversation.
export function applySessionAgentMode(rawId) {
  const wanted = typeof rawId === 'string' ? rawId.trim() : ''
  if (!wanted) {
    // A v3 file carries no mode: the composer keeps the agent it had (the
    // remembered one, or the first).
    state.notice = null
    if (!state.current) state.current = state.modes[0]?.id ?? null
    return null
  }
  if (!state.loaded) {
    // Nothing trustworthy to judge it against, and the composer already refuses
    // to send without a list. Said out loud, because a saved mode that silently
    // does nothing reads as a bug.
    state.notice = `The saved session asked for agent mode "${wanted}", but the agent list could not be read — the composer cannot send until it is.`
    return null
  }
  const found = modeById(wanted)
  if (found) {
    state.current = found.id
    rememberAgent(found.id)
    state.notice = null
    return wanted
  }
  const fallback = state.modes[0]?.id ?? null
  state.current = fallback
  state.notice = `The saved session asked for agent mode "${wanted}", which this installation does not have — using ${modeById(fallback)?.label ?? 'the first agent'}.`
  return null
}

// ---------------------------------------------------------------------------
// The fetch
// ---------------------------------------------------------------------------

// Adopt one `GET /api/agents` answer: the rows verbatim (that *is* the shape the
// dialog edits — the draft is the agent list), plus the selection.
//
// The selection is resolved in one order, and each step says which authority
// answered: a selection the new list still holds is kept (a plain refresh, or a
// save); otherwise the **remembered** id (the tab's `sessionStorage`), because
// that is the last agent the user chose in this tab; otherwise the first entry —
// which is also what a brand-new tab gets, having remembered nothing. A
// remembered id naming an agent that is gone — deleted, or a store restored from
// elsewhere — therefore falls back instead of leaving the composer with nothing.
function acceptPayload(body, { reseed }) {
  const agents = Array.isArray(body?.agents) ? body.agents : []
  if (!agents.length) throw new Error('no agents in the response')
  state.modes = agents.map((agent) => ({
    id: agent.id,
    label: agent.label ?? agent.id,
    maxToolIteration: agent.maxToolIteration ?? null,
    mcpEnable: agent.mcpEnable !== false,
    lspEnable: agent.lspEnable !== false,
    systemMessage: typeof agent.systemMessage === 'string' ? agent.systemMessage : '',
    // **`readonly` is data**, the one flag that decides which fields of a tab
    // render disabled. Nothing here compares an agent id.
    readonly: agent.readonly === true,
    // Whether Delete is offered, a flag for the same reason: some of nojae's own
    // rows are not deletable without being readonly.
    deletable: agent.deletable !== false,
    modelId: agent.modelId ?? null,
    modelName: agent.modelName ?? null,
  }))
  state.findings = Array.isArray(body.findings) ? body.findings : []
  const kept = modeById(state.current)
  const remembered = modeById(rememberedAgentId())
  const chosen = kept?.id ?? remembered?.id ?? state.modes[0].id
  state.current = chosen
  if (reseed) state.notice = null
  state.loaded = true
}

// Read the agent list. `reseed: true` (the first load, and after a store write)
// also retires the quiet session notice.
//
// Failure **hides nothing and changes nothing**: `loaded` goes false, `current`
// stays as it was, and the composer refuses to send — there is no server-side
// fallback a missing list could lean on. A failed dropdown must never silently
// downgrade anybody to another persona, which is also why the previous list
// survives a failed *refresh*: the composer keeps showing the agent the last turn
// actually used.
export async function loadAgentModes({ reseed = false } = {}) {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      const res = await fetch('/api/agents')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      acceptPayload(await res.json(), { reseed })
    } catch {
      state.loaded = false
      state.findings = []
      state.notice = null
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

export function agentModesLoaded() {
  return state.loaded
}

// ---------------------------------------------------------------------------
// The modes editor: the dialog's rules over **the agent list itself**.
//
// There is no document behind it: no `mtime` to compare, no conflict, no findings
// naming a JSON pointer — the app is the store's only writer. What the dialog
// edits is what `GET /api/agents` answers, so the draft *is* the list, and every
// rule below judges that draft as a plain function so the component renders
// answers instead of deriving them.
//
// No cap is spelled here: the id pattern and length, the label cap, the persona
// byte cap and the tool-iteration floor all arrive in the payload's `caps`, which
// is also what the server refuses against.
// ---------------------------------------------------------------------------

//: The model dropdown's empty option, and the sentence a tab shows when it is
//: the answer. Spell it once: the empty option and "cannot run" are one fact.
export const NO_MODEL_LABEL = '— no model: this agent cannot run —'

//: How long a keystroke waits before it is written. Long enough that a word is
//: one write and not five, short enough that the save is over before the hand
//: leaves the keyboard. The same pause the Settings dialog's auto-save uses.
export const AUTOSAVE_DELAY_MS = 600

function capsOf(draft) {
  return draft?.caps ?? {}
}

function byteLengthOf(text) {
  return new TextEncoder().encode(text).length
}

// The slug a new agent's id starts as: lowercase, then letters/digits/'_'/'-',
// within the payload's id cap, made unique against the ids already in the list.
// The numbers come from the payload's `caps`, never a literal here (a missing cap
// means "no client-side cap", which the server still enforces).
export function slugForModeId(label, takenIds = [], caps = null) {
  const maxIdChars = Number.isFinite(caps?.maxIdChars) ? caps.maxIdChars : null
  let slug = String(label ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
  if (!slug) slug = 'agent' // an empty slug is not an id; a neutral one is editable
  if (!/^[a-z]/.test(slug)) slug = `a-${slug}` // the pattern wants a lowercase start
  if (maxIdChars !== null && slug.length > maxIdChars) slug = slug.slice(0, maxIdChars)
  const taken = new Set(takenIds ?? [])
  if (!taken.has(slug)) return slug
  // Uniqueness: a numeric suffix, and the base gives up its tail for it — the
  // result never exceeds the cap, because an over-cap id is what the validator
  // refuses, and the form would then refuse its own Create.
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`
    const base =
      maxIdChars === null ? slug : slug.slice(0, Math.max(1, maxIdChars - suffix.length))
    const candidate = `${base}${suffix}`
    if (!taken.has(candidate)) return candidate
  }
}

// The draft's ids, minus one **entry**'s (matched by identity, not by key: a
// new agent whose typed id collides with an existing one must still be told it
// collides) — the "taken" set a slug or a typed id is judged against.
function takenIds(draft, exceptEntry = null) {
  return (draft?.entries ?? [])
    .filter((entry) => entry !== exceptEntry)
    .map((entry) => entry.id)
}

// Slug generation for one draft: the label, and every id the list already
// holds, under the draft's own caps.
export function slugForDraft(draft, label) {
  return slugForModeId(label, takenIds(draft), capsOf(draft))
}

// Whether an entry's id field is editable: **only while the agent is new**.
// Renaming an existing id is a delete plus an add and silently orphans every
// saved session that names it.
export function idEditableFor(entry) {
  return !!entry && entry.isNew === true && entry.readonly !== true
}

// Whether an entry's editable fields are live: everything but the model is
// nojae's on a `readonly` row.
export function fieldsDisabledFor(entry) {
  return !!entry && (entry.readonly === true || entry.saving === true)
}

// Whether Delete is offered: user-created rows only, and never for a row that
// does not exist yet.
export function deleteOfferedFor(entry) {
  return !!entry && entry.isNew !== true && entry.deletable !== false
}

// Why a *new* agent's id is not usable, or null when it is: the payload's
// pattern, the payload's length cap, and uniqueness against the ids already in
// the list. Existing entries are not judged — their id is immutable.
export function idValidityProblem(draft, entry) {
  if (!idEditableFor(entry)) return null
  const caps = capsOf(draft)
  const id = entry.id
  if (typeof id !== 'string' || !id) return 'An id is required.'
  if (Number.isFinite(caps.maxIdChars) && id.length > caps.maxIdChars) {
    return `The id must be at most ${caps.maxIdChars} characters.`
  }
  if (typeof caps.idPattern === 'string' && new RegExp(caps.idPattern).test(id) === false) {
    return `The id must match ${caps.idPattern} — a lowercase letter, then letters, digits, '_' or '-'.`
  }
  if (takenIds(draft, entry).includes(id)) {
    return `The id "${id}" is already used by another agent.`
  }
  return null
}

// The persona's byte counter — the one counter the tab shows. The cap is hard:
// over it, the store refuses the row and the form blocks the save before the
// server does.
export function personaByteCount(text) {
  return byteLengthOf(typeof text === 'string' ? text : '')
}

export function personaOverByteCap(draft, text) {
  const cap = capsOf(draft).maxPersonaBytes
  return Number.isFinite(cap) && personaByteCount(text) > cap
}

// The tool-iteration value's problem, as a message or null (a floor and **no
// ceiling**, so nothing here refuses a big number).
//
// An empty field is a problem, not "no value": the column is `INTEGER NOT NULL`
// and the store refuses anything below its floor, so a blank form that reports
// nothing would post a 0 (or nothing at all) the server rejects. Saying it here
// is what lets the message line answer before the click.
export function toolIterationProblem(draft, value) {
  const floor = capsOf(draft).minToolIteration
  if (value === null || value === undefined || value === '') {
    return 'Max tool iterations must be a whole number.'
  }
  const number = Number(value)
  if (!Number.isInteger(number)) return 'Max tool iterations must be a whole number.'
  if (Number.isFinite(floor) && number < floor) {
    return `Max tool iterations must be at least ${floor}.`
  }
  return null
}

// The row a label already belongs to, or null: two agents cannot answer to one
// label (the schema's UNIQUE, refused in words by the route).
function labelTakenBy(draft, entry) {
  const wanted = String(entry?.label ?? '').trim()
  if (!wanted) return null
  return (
    (draft?.entries ?? []).find(
      (other) => other !== entry && String(other.label ?? '').trim() === wanted,
    ) ?? null
  )
}

// Every problem *this entry's form* has, each naming the field it belongs to:
// `[{field, message}]`. Nothing renders it per field: it is read only to build
// `saveRefusalFor`'s sentence, so the rules are still the ones the server refuses
// against, said in the card's one message line instead of under each field.
//
// A `readonly` row has one field the user owns, so only the model is judged —
// every other column is the server's to re-assert.
export function entryProblems(draft, entry) {
  if (!entry) return []
  const problems = []
  if (entry.readonly !== true) {
    const label = String(entry.label ?? '').trim()
    const maxLabelChars = capsOf(draft).maxLabelChars
    if (!label) {
      problems.push({ field: 'label', message: 'A label is required.' })
    } else if (Number.isFinite(maxLabelChars) && label.length > maxLabelChars) {
      // The server measures the trimmed label against this same cap, so a stored
      // over-cap row is marked broken and its save refused in the line — not
      // discovered only when the store answers a 422 after the click.
      problems.push({
        field: 'label',
        message: `The label must be at most ${maxLabelChars} characters.`,
      })
    } else if (labelTakenBy(draft, entry)) {
      problems.push({
        field: 'label',
        message: `Another agent is already labelled "${String(entry.label).trim()}".`,
      })
    }
    const idProblem = idValidityProblem(draft, entry)
    if (idProblem) problems.push({ field: 'id', message: idProblem })
    if (personaOverByteCap(draft, entry.personaText)) {
      const cap = capsOf(draft).maxPersonaBytes
      problems.push({
        field: 'systemMessage',
        message:
          `The system prompt is ${personaByteCount(entry.personaText)} bytes, over the ` +
          `${cap}-byte cap — this text is re-sent on every turn of the conversation.`,
      })
    }
    const capProblem = toolIterationProblem(draft, entry.maxToolIteration)
    if (capProblem) problems.push({ field: 'maxToolIteration', message: capProblem })
  }
  return problems
}

//: Why auto-save must not post this form, or null when it may be written: one
//: sentence saying the form must be completed, naming what is missing — which is
//: also the sentence the band says while it is incomplete. Built by reading
//: `entryProblems`, so the per-field wording is not re-derived here and never
//: reaches the template; a half-typed agent is never posted just to be answered
//: with a 422.
export function saveRefusalFor(draft, entry) {
  const problems = entryProblems(draft, entry)
  if (!problems.length) return null
  return `The form must be completed before this agent can be saved: ${problems
    .map((problem) => problem.message)
    .join(' ')}`
}

//: ---------------------------------------------------------------------------
//: The toolbar's slots, and the delete confirmation pair.
//:
//: One function per slot, each answering the same two things: is it inert, and
//: what does it say — its own name when it is live, the reason when it is not.
//: The card reads that **one** value as both its accessible name and its tooltip
//: (`slot.label`), so the two cannot drift and an inert slot always explains
//: itself. Every situation is answered here, so no condition has to be invented
//: in a template: the card passes its own state as one context object and renders
//: the answers.
//: ---------------------------------------------------------------------------

//: The three sentences more than one slot says. Spelled once, because a reason
//: that reads differently in two tooltips is two reasons.
const NOT_READ_LABEL = 'The agent list has not been read.'
const WRITE_IN_FLIGHT_LABEL = 'A write is in flight — wait for it to finish.'
const CONFIRMATION_PENDING_LABEL = 'A confirmation is pending — answer it first.'

//: The card's state, as every slot verdict reads it: has the list been read, is a
//: creation form being typed (a form with no row), is a write in flight, and is a
//: delete awaiting its answer. The defaults are the plainest state the card can be
//: in — read, nothing being typed, nothing asked — so a caller passes only what it
//: actually holds.
function slotContext({
  loaded = true,
  creating = false,
  saving = false,
  confirming = false,
} = {}) {
  return {
    loaded: loaded !== false,
    creating: creating === true,
    saving: saving === true,
    confirming: confirming === true,
  }
}

//: A slot's answer: one string, which is its accessible name when it is live and
//: the reason it is inert when it is not — no second field to keep in step with.
function slotLive(label) {
  return { disabled: false, label }
}

function slotInert(label) {
  return { disabled: true, label }
}

//: **add** — live whenever the list is loaded (adding is not dangerous and writes
//: nothing). Its two reasons are both said in its tooltip: a creation is already
//: being typed (pressing add again would empty a form the user may have started),
//: or a write is in flight. It is the one control that can be inert while nothing
//: is selected, which is why `creating` is its own argument rather than a reading
//: of "no selection".
export function addSlotFor(context = {}) {
  const { loaded, creating, saving, confirming } = slotContext(context)
  if (!loaded) return slotInert(NOT_READ_LABEL)
  if (saving) return slotInert(WRITE_IN_FLIGHT_LABEL)
  if (confirming) return slotInert(CONFIRMATION_PENDING_LABEL)
  if (creating) {
    return slotInert('Already adding an agent — complete its form or select one.')
  }
  return slotLive('Add agent')
}

//: **delete** — whether it is offered stays `deleteOfferedFor`'s answer; this adds
//: the reason, the write-in-flight case and the pending confirmation. The reasons
//: are the store's two flags, so nothing here names an agent id.
export function deleteSlotFor(entry, context = {}) {
  const ctx = slotContext(context)
  if (!ctx.loaded) return slotInert(NOT_READ_LABEL)
  if (!entry) return slotInert('Select an agent to delete it.')
  if (!deleteOfferedFor(entry)) {
    return slotInert(
      entry.isNew === true
        ? 'This agent is not stored yet — delete needs a stored row.'
        : 'nojae owns this agent, so it cannot be deleted.',
    )
  }
  if (ctx.saving) return slotInert(WRITE_IN_FLIGHT_LABEL)
  if (ctx.confirming) return slotInert(CONFIRMATION_PENDING_LABEL)
  return slotLive('Delete agent')
}

//: The delete pair, and whether it is in the DOM at all: **absent**, not hidden,
//: until a delete is being confirmed for a row that can be deleted. Its two
//: tooltips are the whole question and its two answers — no sentence is added
//: anywhere. A write in flight disables the pair rather than queueing it, so a
//: pending destructive action never outlives the state it was asked in.
export function deleteConfirmationFor(entry, context = {}) {
  const ctx = slotContext(context)
  if (!ctx.confirming || !deleteOfferedFor(entry)) {
    return { rendered: false, cancel: null, confirm: null }
  }
  return {
    rendered: true,
    cancel: ctx.saving ? slotInert(WRITE_IN_FLIGHT_LABEL) : slotLive('Cancel delete'),
    confirm: ctx.saving ? slotInert(WRITE_IN_FLIGHT_LABEL) : slotLive('Confirm delete'),
  }
}

// A tab's caption: the Label field it currently holds, falling back to the id
// when the label is empty. It follows the field live, which is why it is read
// here and not remembered from the read.
export function tabCaptionFor(entry) {
  if (!entry) return ''
  const label = typeof entry.label === 'string' ? entry.label.trim() : ''
  return label || String(entry.id ?? '')
}

// The model dropdown's contents: every configured model, grouped by the server
// that names it. Plain data — the server list is `GET /api/servers`'s answer, and
// this only reshapes it for the `<optgroup>`s.
export function modelChoices(servers) {
  const groups = []
  for (const server of Array.isArray(servers) ? servers : []) {
    const models = (server?.models ?? []).map((model) => ({
      id: model.id,
      name: model.name,
    }))
    if (models.length) groups.push({ server: server.name, models })
  }
  return groups
}

// The quiet line under an agent's model dropdown: which model it will run on,
// named by its server and its own name — or, when it has none, the same "cannot
// run" wording the dropdown's empty option uses.
export function modelLineFor(entry, servers) {
  if (!entry) return null
  if (entry.modelId === null || entry.modelId === undefined) return NO_MODEL_LABEL
  for (const server of Array.isArray(servers) ? servers : []) {
    for (const model of server?.models ?? []) {
      if (model.id === entry.modelId) return `${server.name} · ${model.name}`
    }
  }
  // The row names a model the catalogue no longer holds — a hand-edited database,
  // or a server removed in another tab. The agent cannot run either way, so the
  // sentence that says so is the same one.
  return NO_MODEL_LABEL
}

//: The fields a form holds that the store can answer for, and therefore the only
//: ones a baseline records. `id` is absent on purpose: a stored row's id is
//: immutable, so it can never be the thing closing would lose.
const BASELINE_FIELDS = [
  'label',
  'maxToolIteration',
  'mcpEnable',
  'lspEnable',
  'personaText',
  'modelId',
]

//: **One baseline per entry**: what the store last said about this row, as the
//: plain field snapshot the form is compared against. It is captured in the one
//: place a draft is built from a payload — `entryOfRow`, which the read and both
//: writes go through — so it is *always* the store's answer and never what the
//: user typed, which is the whole invariant the close guard rests on.
function baselineOf(entry) {
  const snapshot = {}
  for (const field of BASELINE_FIELDS) snapshot[field] = entry[field] ?? null
  return snapshot
}

// One store row as an editable entry: the shape the form holds.
function entryOfRow(row) {
  const entry = {
    id: row.id,
    isNew: false,
    label: row.label ?? '',
    maxToolIteration: row.maxToolIteration ?? null,
    mcpEnable: row.mcpEnable !== false,
    lspEnable: row.lspEnable !== false,
    personaText: typeof row.systemMessage === 'string' ? row.systemMessage : '',
    readonly: row.readonly === true,
    deletable: row.deletable !== false,
    modelId: row.modelId ?? null,
    modelName: row.modelName ?? null,
    // The baseline is the row as the store answered it, taken here and nowhere
    // else. A write re-baselines by rebuilding the draft from its answer.
    baseline: null,
  }
  entry.baseline = baselineOf(entry)
  return entry
}

//: **Re-baseline the list on a write's answer without discarding another agent's
//: typing.** A write answers the whole new list and the card adopts it — that is
//: what makes a refusal, a cascade or a re-asserted built-in visible without the
//: client knowing the rule. But the card holds one form per agent, so adopting the
//: answer verbatim would silently throw away what the user typed in an agent this
//: write did not touch.
//:
//: So each incoming row keeps the store's fresh baseline (always the store's
//: answer, never what was typed — the invariant the close guard rests on), and
//: the fields the user had changed in the row it replaces are put back. The agent
//: that was just written is skipped: its stored state is now the truth, and its
//: form must show that rather than what was sent.
export function rebaselinedDraft(next, previousDraft, writtenId) {
  if (!next) return next
  const held = new Map(
    (Array.isArray(previousDraft?.entries) ? previousDraft.entries : []).map((entry) => [
      entry.id,
      entry,
    ]),
  )
  for (const entry of next.entries) {
    if (entry.id === writtenId) continue
    const before = held.get(entry.id)
    if (!before) continue
    let modelRestored = false
    for (const field of BASELINE_FIELDS) {
      // With no baseline the held row was never read from the store, so nothing
      // about it is "unchanged" and every field of it is the user's typing.
      const stored = before.baseline ? before.baseline[field] ?? null : undefined
      if (stored === undefined || (before[field] ?? null) !== stored) {
        entry[field] = before[field]
        if (field === 'modelId') modelRestored = true
      }
    }
    // The model's resolved name travels with its id: a row whose model was put
    // back must not keep the name of the model the store answered for.
    if (modelRestored) entry.modelName = before.modelName ?? null
  }
  return next
}

//: The one field of an **app-owned** row the user owns: is its model still what
//: the store answered? It reads `modelId` alone — never the whole form, which is
//: `entryDiffersFromBaseline`'s business. A row with no baseline was never read
//: from the store, so this never answers for it.
export function modelUnchangedFor(entry) {
  if (!entry?.baseline) return false
  return (entry.modelId ?? null) === (entry.baseline.modelId ?? null)
}

//: **Does this form hold something the store does not?** — the only reader of the
//: baseline, and the question auto-save asks per row. A form with no baseline was
//: never written (a creation), so it always differs. On a `readonly` row every
//: field but the model is nojae's and renders disabled, so only a moved model is
//: something this client could write — posting the rest would be a write the route
//: refuses.
export function entryDiffersFromBaseline(entry) {
  if (!entry) return false
  if (!entry.baseline) return true
  if (entry.readonly === true && modelUnchangedFor(entry)) return false
  return BASELINE_FIELDS.some(
    (field) => (entry[field] ?? null) !== (entry.baseline[field] ?? null),
  )
}

//: **A form's shape**: the bytes it would post, as one string. Two forms of the
//: same shape are the same write, which is what lets auto-save remember that it
//: already posted these bytes — a write the store answered without taking them (a
//: row it would not create) must not be posted again on the next tick.
export function writeShapeFor(entry) {
  return JSON.stringify({ id: entry?.id ?? null, ...agentWritePayload(entry) })
}

//: What a form holds **now**, field by field, in the same shape as a baseline: the
//: snapshot taken just before its bytes are posted, so a later keystroke can be
//: told apart from what was sent.
export function typedSnapshot(entry) {
  return baselineOf(entry)
}

//: **The keystrokes made while a write was in flight.** The answer re-baselines the
//: written row to what the store holds, which would eat a character typed during
//: that window; every field whose value has moved on since the bytes were sent is
//: put back over the answer. A field the store normalised (a name it stripped) has
//: *not* moved on, so it shows the store's answer and no second write is owed for
//: it — which is also what keeps a normalising store from being written forever.
export function restoreTypedFields(row, before, sentValues) {
  if (!row || !before) return
  for (const field of BASELINE_FIELDS) {
    if ((before[field] ?? null) === (sentValues?.[field] ?? null)) continue
    row[field] = before[field]
    // The model's resolved name travels with its id.
    if (field === 'modelId') row.modelName = before.modelName ?? null
  }
}

//: **Which forms auto-save owes a write.** A form is written when it stops
//: changing, so the card needs no `Save`: the entry is the record of what is
//: typed and the baseline is the record of what is stored, and a write is owed
//: wherever the two disagree — and only where the form holds nothing the store
//: would refuse, because a posted half-typed agent would answer with a 422 the
//: band has to say anyway. The creation form is one of the forms: it has no row
//: yet, so its write goes to the add route.
export function autoSaveTargetsFor(draft, creation = null) {
  const forms = [
    ...(Array.isArray(draft?.entries) ? draft.entries : []),
    ...(creation ? [creation] : []),
  ]
  return forms.filter(
    (entry) =>
      entryDiffersFromBaseline(entry) && !saveRefusalFor(draft, entry),
  )
}

//: The row to select once a delete has landed: the **next** one in the order it is
//: given, else the **previous** one when the deleted row was last, else nothing
//: when the list came back empty. It adds no ordering of its own — the store's
//: order is the server's (`resolve_agents()`, app-owned row last) — so the card
//: calls it with the list as it held it while the deleted row was still in it, and
//: then selects the returned row by id in the re-baselined list.
export function successorAfterDelete(entries, entry) {
  const list = Array.isArray(entries) ? entries : []
  if (!list.length) return null
  const index = list.indexOf(entry)
  if (index === -1) return null
  return list[index + 1] ?? list[index - 1] ?? null
}

//: **What an empty new-agent form holds**: no label, no persona, both hub switches
//: off, the tool loop at the payload's floor, no model, and the id the slug rule
//: derives from an empty label — a neutral placeholder the Id field still
//: corrects. The card never assembles a form field-by-field in the template, and
//: no number is spelled here: the floor is `caps`'s.
//:
//: It carries the flags a not-yet-stored row needs — new, not deletable, not
//: readonly — so the same slot verdicts answer for it. Its baseline is null
//: because nothing was ever written, which is what makes auto-save owe it a write.
//:
//: `idEdited` is the creation form's own provenance for its id: the Label slug
//: keeps it up to date only while the user has not corrected it by hand, so a
//: later Label edit never discards a chosen id.
export function creationFormFor(draft) {
  return {
    id: slugForDraft(draft, ''),
    isNew: true,
    idEdited: false,
    label: '',
    maxToolIteration: capsOf(draft).minToolIteration ?? null,
    mcpEnable: false,
    lspEnable: false,
    personaText: '',
    readonly: false,
    deletable: false,
    modelId: null,
    modelName: null,
    baseline: null,
  }
}

//: **Is a creation being typed?** The one reading of the card's creation state: a
//: form is held that has no row. Every slot verdict takes that as an argument, and
//: the close verdict counts it as unsaved work — nothing was ever written.
export function creationActiveFor(creation) {
  return !!creation
}

// The draft from an agent payload: **the list itself** (`state.modes`, already
// adopted by `acceptPayload`), plus the caps the form enforces and whatever the
// read noticed. No entry is added: the app owns these rows.
export function createAgentDraft(payload) {
  const agents = Array.isArray(payload?.agents) ? payload.agents : []
  return {
    caps: payload?.caps ?? {},
    findings: Array.isArray(payload?.findings) ? payload.findings : [],
    entries: agents.map(entryOfRow),
  }
}

// Drop an entry from the in-memory list. The card never appends one (a new agent
// is a form, not an entry, until a save succeeds), so this is the only draft
// mutation the editor's shape answers for.
export function removeAgentFromDraft(draft, entry) {
  const index = draft.entries.indexOf(entry)
  if (index === -1) return false
  draft.entries.splice(index, 1)
  return true
}

// What one entry's write posts. A new agent names its own id (the slug a chat
// payload and every saved session file carry); an existing one addresses the
// row it was read under, and never sends its id as a change.
//
// A **`readonly`** row sends its model association and nothing else: every other
// column is nojae's, and the route refuses the rest with one sentence — so the
// client never asks for what it knows is refused.
export function agentWritePayload(entry) {
  if (entry.readonly === true) {
    return { id: entry.id, modelId: entry.modelId ?? null }
  }
  const payload = {
    label: String(entry.label ?? '').trim(),
    mcpEnable: entry.mcpEnable === true,
    lspEnable: entry.lspEnable === true,
    systemMessage: entry.personaText ?? '',
    modelId: entry.modelId ?? null,
  }
  const cap = entry.maxToolIteration
  // Only a real value is serialised: a cleared field is `''` (Vue's `.number`
  // keeps it) and a missing one is null/undefined, and `Number('')` and
  // `Number(null)` are both `0` — a value the store refuses. Omitting the key
  // leaves an update's stored cap alone and lets a create take the route's
  // default, which is why the form's rule refuses the empty field first.
  if (cap !== '' && cap !== null && cap !== undefined) {
    const number = Number(cap)
    if (Number.isInteger(number)) payload.maxToolIteration = number
  }
  return payload
}

// ---------------------------------------------------------------------------
// The editor's transport state, and the four calls
//
// Kept separate from the dropdown's singleton so a failed dialog read can never
// disturb the composer (the same non-destructive rule `loadAgentModes` follows).
// ---------------------------------------------------------------------------

const editorState = reactive({
  open: false,
  loading: false,
  saving: false,
  // The two failures are told apart because the message priority ranks them
  // differently: a refused **write** outranks the incomplete-form sentence, a
  // failed **read** is under it.
  readError: null,
  writeError: null,
  serverFindings: [], // the last refused write's messages, each naming a field
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

//: The store's own sentence about the last refused write, verbatim (a refusal is
//: said in the store's words, not the client's paraphrase). A refusal answers
//: either with one `detail` string — kept as a finding — or with a validation
//: body, which `describeError` turned into `writeError`.
function storeRefusalSentence() {
  return editorState.serverFindings[0]?.message || editorState.writeError || null
}

//: **The card's one message**: everything it has to say — progress, a refusal
//: from the store, an incomplete form, a failed read, the read's findings —
//: chosen by this fixed priority and never by recency, so two truths never fight
//: for the line. The role is part of the answer, because the line is announced
//: and not just drawn: `alert` for a refusal or a failure, `status` for progress
//: and for the incomplete-form sentence.
//:
//: A write in flight comes first: auto-save posts it without being asked, so
//: bytes are moving and that is the one truth the user cannot yet act on.
//:
//: It always answers an object, so the line is a slot that is *always there*: an
//: empty `text` means nothing to say, and filling or emptying it reflows nothing.
//: It clears when its cause goes away because it is derived from the state that
//: caused it.
export function messageFor(draft, entry) {
  if (editorState.saving) return { text: 'Saving…', role: 'status' }
  if (editorState.loading) return { text: 'Reading the agents…', role: 'status' }

  const refusal = storeRefusalSentence()
  if (refusal) return { text: refusal, role: 'alert' }

  const incomplete = saveRefusalFor(draft, entry)
  if (incomplete) return { text: incomplete, role: 'status' }

  if (editorState.readError) return { text: editorState.readError, role: 'alert' }

  // The read's findings — the loader's and the server's — are **one** message,
  // not two lines that would compete for the same slot.
  const findings = [
    ...(Array.isArray(draft?.findings) ? draft.findings : []),
    ...editorState.serverFindings,
  ]
    .map((finding) => finding?.message)
    .filter(Boolean)
  if (findings.length) return { text: findings.join(' · '), role: 'alert' }

  return { text: '', role: 'status' }
}

// The read: `GET /api/agents`, which is the *same* payload the dropdown reads —
// one factsheet for both, so the dialog can never show a list the composer does
// not offer. The answer also feeds the singleton, so a save made here lands in
// the dropdown without a second round-trip.
export async function fetchAgentDraft() {
  editorState.loading = true
  editorState.readError = null
  // The editor state is a module singleton that outlives the card, so a failure
  // from a previous open must not greet the next one as if it had just happened
  // — nor outrank (it is read first) a read failure in this one.
  editorState.writeError = null
  editorState.serverFindings = []
  try {
    const res = await fetch('/api/agents')
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      editorState.readError = describeError(body, `Could not read the agents (${res.status}).`)
      return null
    }
    try {
      acceptPayload(body, { reseed: false })
    } catch {
      // The list is empty in a way the composer refuses to render; the dialog
      // still shows what came back, so the user can see there is nothing.
    }
    return createAgentDraft(body)
  } catch (exc) {
    editorState.readError = `Could not reach the API: ${exc}`
    return null
  } finally {
    editorState.loading = false
  }
}

// One write — create, update or the model-only save a `readonly` row allows.
// The answer is the whole new list, so the dialog re-baselines on the server's
// rows instead of splicing the one it sent (which is what makes a refusal, a
// cascade or a re-asserted built-in visible without the client knowing the rule).
async function postAgent(path, payload, fallback) {
  if (editorState.saving) return null
  editorState.saving = true
  editorState.writeError = null
  editorState.serverFindings = []
  try {
    const res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      const detail = body?.detail
      if (typeof detail === 'string' && detail) {
        editorState.serverFindings = [{ kind: 'error', message: detail }]
      } else {
        editorState.writeError = describeError(body, fallback)
      }
      return null
    }
    try {
      acceptPayload(body, { reseed: false })
    } catch {
      state.loaded = false
    }
    return createAgentDraft(body)
  } catch (exc) {
    editorState.writeError = `Could not reach the API: ${exc}`
    return null
  } finally {
    editorState.saving = false
  }
}

// Save one agent. A new row is added; an existing one is rewritten — and a
// `readonly` row sends its model alone. The answer is the new draft, or null
// with the reason in `editorState`.
export async function saveAgent(entry) {
  const payload = agentWritePayload(entry)
  return postAgent(
    entry.isNew ? '/api/agents/add' : '/api/agents/save',
    { ...payload, id: entry.id },
    `Could not save the agent (${entry.isNew ? 'added' : 'saved'}).`,
  )
}

// Remove one agent. The store copies the database first, so the confirm the
// dialog asks is the only guard the user needs.
export async function deleteAgent(entry) {
  return postAgent('/api/agents/delete', { id: entry.id }, 'Could not delete the agent.')
}

export function useAgentModes() {
  return {
    state,
    editor: editorState,
    loadAgentModes,
    setAgentMode,
    currentMode,
    modeHint,
  }
}

