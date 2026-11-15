import { reactive } from 'vue'

import { AGENT_STORAGE_KEY } from './useWorkspaceSession'

// ---------------------------------------------------------------------------
// Agent modes: the persona WorkBench answers as, and what it may reach.
//
// One fetch (`GET /api/agents`) fills this singleton: the dropdown in the
// composer, the hub panels' gray-out, the Agent-modes dialog and the
// `agentMode` key of every chat payload all read *here*, so the same verdict
// drives all four. The list is the **install's** — rows of nojae's settings
// store, the same in every workspace — so nothing here holds an agent id: an
// agent the app owns is recognised by `readonly` (which fields are disabled) and
// by `deletable` (whether Delete is offered), both of them **data** from the
// server. That is deliberate — the ids those rows have are the server's to
// know, and `web/src` must never contain one.
//
// Every decision lives in this file as a plain function, so the components
// render answers instead of re-deriving rules — and no cap is spelled here
// either: the byte counter, the id pattern and the tool-iteration floor all
// arrive in the payload's `caps`.
//
// What this file no longer has, because D5 and §4.4 deleted it rather than
// moved it: the mode **lock** (with `agentModeLockedFor`, `modeOptionDisabled`
// and the fixed-mode tooltip sentence), the server-side **default** agent and
// the whole file-document machinery the dialog used to edit (`mtime`, the
// conflict guard, the draft-from-a-document reader). The last-used agent is
// **tab** state — `sessionStorage`, beside the tab's workspace — and the dialog
// now reads and saves the store's rows one agent at a time.
// ---------------------------------------------------------------------------

const state = reactive({
  // [{ id, label, mcpEnable, lspEnable, readonly, deletable, maxToolIteration,
  //    systemMessage, modelId, modelName }] — the rows `GET /api/agents`
  // answers, in dropdown order. `readonly` is which fields the dialog disables
  // (§4.4), `deletable` whether its Delete is offered (D4), and `modelId` +
  // `modelName` whether this agent can run at all (D5) — the composer's warning
  // reads those fields rather than re-deriving the rule.
  modes: [],
  current: null, // the agent id in play; null until a list has been read
  loaded: false, // false = the fetch failed; Send then refuses (task 12)
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
// `sessionStorage` and not `localStorage`, and that is the whole requirement
// (spec D5, §5.5 rule 26). Browser-wide storage meant every tab answered as the
// same agent — moving the choice in one moved it in all of them — which is
// exactly what D5 retires. Here a reload is the same tab and keeps its agent, a
// new tab starts on the list's first entry, and a closed tab forgets its choice.
//
// The **catalogue** stays the installation's, deliberately: these are the same
// install-owned rows, selected per tab, not a per-tab copy of them (§4.2, §5.5
// rule 25). Only the *choice* moved; the agents did not.
//
// A `localStorage` value from an older build is **not** read: the new key is a
// new place, and inheriting the old one would re-share a choice this lot exists
// to make per tab.

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
// behave exactly as they did before the feature (no gate). What the gate costs
// the user is said by the panel's own row tooltip, not by a sentence here.
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

// The `<select>`'s title: the hint, qualified by whatever currently stops the
// user acting on it. The **only** qualifier left is a running lot: D5 deleted
// the mode lock and with it the fixed-mode sentence — "a message describing
// behaviour that no longer happens is worse than no message".
export function modeSelectTitle({ batchActive = false } = {}) {
  const hint = modeHint(state.current)
  if (!hint) return ''
  if (batchActive) return `${hint} — a running lot keeps the agent it launched with`
  return hint
}

// Whether the whole `<select>` is inert: a running lot whose mode the runner
// took at launch, and nothing else. A mid-`streaming` switch is *not* in here —
// the server has always accepted an `agentMode` change at any point in a
// thread, so switching simply cannot reach the turn already in flight.
//
// The batch half is a *rendering* rule; the behaviour lives in useBatch, which
// reads this selection once per run into `state.pinnedMode` and sends that id on
// every task turn. So the select is disabled while a lot runs for the honest
// reason: changing it can neither move the running lot nor the next task of it,
// and leaving it live would advertise a power the dropdown does not have over
// a lot.
export function modeSelectDisabled(batchActive = false) {
  return !!batchActive
}

// Choosing an agent: whatever the thread has done, from any agent to any other
// (§4.4, AC-10). What is left of the old guard is the list itself — a client
// never invents an id — and the **tab's** memory of the choice (spec D5).
export function setAgentMode(id) {
  const next = modeById(id)
  if (!next) return // never the server's list, never a guess
  state.current = next.id
  rememberAgent(next.id)
}

// What `send()` puts in `payload.agentMode`: null means *omit the key*, which
// since D5 is a 422 naming the field rather than a server-side default — so the
// composer refuses the send before it gets there (task 12). Never a guess.
export function agentModePayloadId() {
  return state.loaded && state.current ? state.current : null
}

// §5.4/§5.5: *can the selected agent run?* — the plain answer the composer's
// warning icon and its Send gate both read.
//
// It reads the row's **own** field, which task 03 put there (`modelId` plus the
// resolved `modelName`), and never re-derives the rule from two tables. The
// server's sentence — the one naming the agent — is the authority behind it,
// not something this client builds: no agent id is named here, and no model is
// guessed.
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

//: The composer's warning (§5.4). One wording for the icon's tooltip, its
//: accessible name and the Send button's disabled reason, so the user cannot
//: read two different explanations of the same state.
export const NO_MODEL_WARNING = 'Agent has no model to run with. Please assign a model'

//: What a composer whose list never arrived says. It cannot name an agent it
//: has not read, and D5 removed the server-side default the old send leaned on.
export const AGENT_LIST_WARNING =
  'The agent list could not be read — Send is unavailable until it loads'

// D7's sentence, for the callers that name the agent (batch mode's launch
// refusal). The composer's icon does *not* use it: it must never name an agent id,
// and the icon is about the selection the user can see. Same wording as
// ``src.config.agent_connection_refusal``'s no-model branch, built from the
// row's label so the lot and the server say one thing.
export function agentNoModelSentence(mode) {
  const who = String(mode?.label ?? '').trim() || 'the selected agent'
  return `Agent ${who} has no model to run with. Please assign a model in the Agent modes dialog.`
}

// The one answer both the warning icon and the Send gate read (§5.4): null when
// a turn may be sent, otherwise the reason it may not. Three states, in the order
// the user can act on them:
//
//  * the list never loaded — the composer cannot name an agent at all;
//  * a loaded list with no selection — the same answer, for a store with no rows;
//  * the selected row has no model — D7's sentence behind it, the icon before it.
export function selectedAgentGateReason() {
  if (!state.loaded) return AGENT_LIST_WARNING
  const mode = currentMode()
  if (!mode) return AGENT_LIST_WARNING
  if (!agentCanRun(mode)) return NO_MODEL_WARNING
  return null
}

// One quiet line about what the store's read noticed. Not a modal and not a
// banner: a warning that cannot be dismissed would nag on every turn. The store
// has no file to point at (the agents are rows), so the line names the dialog
// the user can fix them in instead of a path.
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
// dialog edits — "the draft becomes the agent list"), plus the selection.
//
// The selection is resolved in one order, and each step says which authority
// answered: a selection the new list still holds is kept (a plain refresh, or a
// save); otherwise the **remembered** id (§5.4, the tab's `sessionStorage`),
// because that is the last agent the user chose in this tab; otherwise the first
// entry — which is also what a brand-new tab gets, having remembered nothing
// (spec D4, D11). A remembered id naming an agent that is gone — deleted, or a
// store restored from elsewhere — therefore falls back instead of leaving the
// composer with nothing.
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
    // §4.4: **`readonly` is data**, the one flag that decides which fields of a
    // tab render disabled. Nothing here compares an agent id.
    readonly: agent.readonly === true,
    // D4: whether Delete is offered. A flag for the same reason — three of
    // nojae's four rows are deletable=no without being readonly.
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
// stays as it was, and the composer refuses to send (task 12) — D5 removed the
// server-side fallback a missing list used to lean on. A failed dropdown must
// never silently downgrade anybody to another persona, which is also why the
// previous list survives a failed *refresh*: the composer keeps showing the
// agent the last turn actually used.
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
// The doc-shaped half is gone with the file it edited (§4.7): there is no
// document to read, no `mtime` token to compare, no conflict, no "saving will
// create this file" and no findings that name a JSON pointer — the app is the
// store's only writer. What the dialog edits is what `GET /api/agents` answers,
// so the draft *is* the list, and every rule below judges that draft as a plain
// function so the component renders answers instead of deriving them.
//
// No cap is spelled here: the id pattern and length, the label cap, the persona
// byte cap and the tool-iteration floor all arrive in the payload's `caps`
// (task 03's read publishes them), which is also what the server refuses
// against.
// ---------------------------------------------------------------------------

//: The model dropdown's empty option, and the sentence a tab shows when it is
//: the answer. Spell it once: the empty option and "cannot run" are one fact.
export const NO_MODEL_LABEL = '— no model: this agent cannot run —'

//: Why a tab's other fields are disabled. Said once, for every `readonly` row —
//: the client never names one (§4.4).
export const READONLY_CAPTION =
  'These fields belong to nojae: it re-asserts them from code on every start. ' +
  'The model is yours to choose.'

function capsOf(draft) {
  return draft?.caps ?? {}
}

function byteLengthOf(text) {
  return new TextEncoder().encode(text).length
}

// The slug a new agent's id starts as: lowercase, then letters/digits/'_'/'-',
// within the payload's id cap, made unique against the ids already in the list.
// `caps` is the draft's own `caps` object — the numbers come from the payload,
// never a literal here (a missing cap means "no client-side cap", which the
// server still enforces).
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
// saved session that names it, so this is a function's answer, not a template's
// `:disabled`.
export function idEditableFor(entry) {
  return !!entry && entry.isNew === true && entry.readonly !== true
}

// Whether an entry's editable fields are live: everything but the model is
// nojae's on a `readonly` row (§4.4/§5.2).
export function fieldsDisabledFor(entry) {
  return !!entry && (entry.readonly === true || entry.saving === true)
}

// Whether Delete is offered: user-created rows only (D4), and never for a row
// that does not exist yet.
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

// The tool-iteration cap's floor, as a message or null (D9: a floor of 1 and
// **no ceiling**, so nothing here refuses a big number).
export function toolIterationProblem(draft, value) {
  const floor = capsOf(draft).minToolIteration
  if (value === null || value === undefined || value === '') return null
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
// `[{field, message}]`. Nothing renders it per field any more (D11): it is read
// only to build `saveRefusalFor`'s sentence, so the rules are still the ones the
// server refuses against, said in the card's one message line instead of under
// the field each one is about.
//
// A `readonly` row has one field the user owns, so only the model is judged —
// every other column is the server's to re-assert (D4).
export function entryProblems(draft, entry) {
  if (!entry) return []
  const problems = []
  if (entry.readonly !== true) {
    if (!String(entry.label ?? '').trim()) {
      problems.push({ field: 'label', message: 'A label is required.' })
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

//: The save slot's **enablement**, and nothing else (D1, Q2): is there something
//: for Save to act on, and is a write already in flight. Those are the only two
//: reasons the slot is *disabled*.
//:
//: An incomplete form is deliberately **not** in here — that was the old
//: one-verdict Save gate's answer, and this rework drops it: taking the button
//: away hides the reason, so the click is how the user learns what is missing
//: (D11). The verdict is renamed rather than reused, because the old name kept
//: the lie the rework removes.
//:
//: The one exception is the **app-owned row** (§5's last paragraph): the model is
//: the only field of that row the user owns, so a save which could only rewrite
//: what is already stored has nothing to offer, and the slot stays inert until
//: that one field changes. That is a rule about one row's one field —
//: `modelUnchangedFor` reads `modelId` and nothing else — and it is *not* the
//: general "dirty" test Q2 dropped: no other row and no other field is judged
//: here, and the whole-form comparison belongs to `closeWouldLoseFor` alone.
//:
//: A pending confirmation also lands here (§5's last two rows): one destructive
//: action is decided at a time, so the verbs go inert while the card waits for
//: an answer. The card passes the same context to every slot verdict.
export function writeBlockedFor(entry, context = {}) {
  const { saving, confirming, closing } = slotContext(context)
  if (!entry || saving || confirming || closing) return true
  if (entry.readonly === true) return modelUnchangedFor(entry)
  return false
}

//: Why a click on the save slot is refused, or null when this form may be
//: written: one sentence saying the form must be completed, naming what is
//: missing. Built by reading `entryProblems` — the per-field wording is not
//: re-derived here and never reaches the template.
export function saveRefusalFor(draft, entry) {
  const problems = entryProblems(draft, entry)
  if (!problems.length) return null
  return `The form must be completed before this agent can be saved: ${problems
    .map((problem) => problem.message)
    .join(' ')}`
}

//: ---------------------------------------------------------------------------
//: The toolbar's five slots (§5), and the two confirmation pairs.
//:
//: One function per slot, each answering the same two things: is it inert, and
//: what does it say — its own name when it is live, the reason when it is not.
//: The card reads that **one** value as both its accessible name and its tooltip
//: (`slot.label`), so the two cannot drift (§6.16) and an inert slot always
//: explains itself (D1). Every situation §5 lists is answered here, including the
//: ones the card cannot reach yet, so no condition has to be invented in a
//: template when the toolbar is wired: the card passes its own state as one
//: context object and renders the answers.
//: ---------------------------------------------------------------------------

//: The three sentences more than one slot says. Spelled once, because a reason
//: that reads differently in two tooltips is two reasons.
const NOT_READ_LABEL = 'The agent list has not been read.'
const WRITE_IN_FLIGHT_LABEL = 'A write is in flight — wait for it to finish.'
const CONFIRMATION_PENDING_LABEL = 'A confirmation is pending — answer it first.'

//: The card's state, as every slot verdict reads it: has the list been read, is a
//: creation form being typed (D4 — a form with no row), is a write in flight, and
//: is a delete or a close confirmation awaiting its answer. The defaults are the
//: plainest state the card can be in — read, nothing being typed, nothing asked —
//: so a caller passes only what it actually holds.
function slotContext({
  loaded = true,
  creating = false,
  saving = false,
  confirming = false,
  closing = false,
} = {}) {
  return {
    loaded: loaded !== false,
    creating: creating === true,
    saving: saving === true,
    confirming: confirming === true,
    closing: closing === true,
  }
}

//: A slot's answer: one string, which is its accessible name when it is live and
//: the reason it is inert when it is not. There is no second field to keep in
//: step with, by design.
function slotLive(label) {
  return { disabled: false, label }
}

function slotInert(label) {
  return { disabled: true, label }
}

//: **add** — live whenever the list is loaded (D5: adding is not dangerous and
//: writes nothing). Its two reasons are both said in its tooltip: a creation is
//: already being typed (pressing add again would empty a form the user may have
//: started), or a write is in flight. It is the one control that can be inert
//: while nothing is selected, which is why `creating` is its own argument rather
//: than a reading of "no selection".
export function addSlotFor(context = {}) {
  const { loaded, creating, saving, confirming, closing } = slotContext(context)
  if (!loaded) return slotInert(NOT_READ_LABEL)
  if (saving) return slotInert(WRITE_IN_FLIGHT_LABEL)
  if (confirming || closing) return slotInert(CONFIRMATION_PENDING_LABEL)
  if (creating) return slotInert('Already adding an agent — save it or select one.')
  return slotLive('Add agent')
}

//: **save** — `Saving…` while a write is in flight, and that word is the slot's
//: name *and* its tooltip together, because they are the same value: the pair
//: moves as one or not at all, which is what keeps §6.16 true while the word is
//: there. Otherwise it is inert for `writeBlockedFor`'s reasons and nothing else
//: — an incomplete form is **not** one of them (D11: the click refuses and the
//: message line says why).
//:
//: "Nothing selected" is two states and stays two: in creation mode the card
//: hands over the creation form as the subject, so save is live; with a list that
//: came back empty there is no form to type into, so it is not.
export function saveSlotFor(entry, context = {}) {
  const ctx = slotContext(context)
  if (ctx.saving) return slotInert('Saving…')
  if (!ctx.loaded) return slotInert(NOT_READ_LABEL)
  if (!writeBlockedFor(entry, ctx)) return slotLive('Save agent')
  if (ctx.confirming || ctx.closing) return slotInert(CONFIRMATION_PENDING_LABEL)
  if (!entry) return slotInert('There is no agent selected to save.')
  return slotInert('Only the model is yours on this agent, and it has not changed.')
}

//: **delete** — whether it is offered stays `deleteOfferedFor`'s answer (D3:
//: called unchanged); this adds the reason, the write-in-flight case and the
//: pending confirmation. The reasons are the store's two flags, so nothing here
//: names an agent id.
export function deleteSlotFor(entry, context = {}) {
  const ctx = slotContext(context)
  if (!ctx.loaded) return slotInert(NOT_READ_LABEL)
  if (!entry) return slotInert('Select an agent to delete it.')
  if (!deleteOfferedFor(entry)) {
    return slotInert(
      entry.isNew === true
        ? 'Save this agent before it can be deleted.'
        : 'nojae owns this agent, so it cannot be deleted.',
    )
  }
  if (ctx.saving) return slotInert(WRITE_IN_FLIGHT_LABEL)
  if (ctx.confirming || ctx.closing) return slotInert(CONFIRMATION_PENDING_LABEL)
  return slotLive('Delete agent')
}

//: The delete pair, and whether it is in the DOM at all (§6.17): **absent**, not
//: hidden, until a delete is being confirmed for a row that can be deleted. Its
//: two tooltips are the whole question and its two answers (Q7) — no sentence is
//: added anywhere. A write in flight disables the pair rather than queueing it
//: (§8), so a pending destructive action never outlives the state it was asked in.
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
// that names it (§5.2). Plain data — the server list is `GET /api/servers`'s
// answer, and this only reshapes it for the `<optgroup>`s.
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
  // The row names a model the catalogue no longer holds — a hand-edited
  // database, or a server removed in another tab. The agent cannot run either
  // way, and the sentence that says so is the same one (D7).
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

//: **One baseline per entry** (D8): what the store last said about this row, as
//: the plain field snapshot the form is compared against. It is captured in the
//: one place a draft is built from a payload — `entryOfRow`, which the read and
//: both writes go through — so it is *always* the store's answer and never what
//: the user typed, which is the whole invariant the close guard rests on.
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
//: typing** (D6, §6.18). A write answers the whole new list and the card adopts
//: it — that is what makes a refusal, a cascade or a re-asserted built-in visible
//: without the client knowing the rule. But the card holds one form per agent, so
//: adopting the answer verbatim would silently throw away what the user typed in
//: an agent this write did not touch.
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

//: The one field of an **app-owned** row the user owns (§5's last paragraph): is
//: its model still what the store answered? That is the save slot's only dirty
//: test, and it reads `modelId` alone — never the whole form, which is
//: `closeWouldLoseFor`'s business. A row with no baseline was never read from the
//: store, so it is never blocked by this rule.
export function modelUnchangedFor(entry) {
  if (!entry?.baseline) return false
  return (entry.modelId ?? null) === (entry.baseline.modelId ?? null)
}

//: **Would closing lose something?** (D8) — the close guard's only question, and
//: the only reader of the baseline. Always yes in creation mode, where nothing was
//: ever written; otherwise the entry against its baseline.
//:
//: This is deliberately *not* the save slot's answer: *may this be saved* is the
//: form's completeness (`writeBlockedFor` + `saveRefusalFor`), and Q2 dropped any
//: dirty gate there. Two functions, two questions, and neither reads the other's
//: input — which is what keeps the baseline from leaking back into the toolbar.
export function closeWouldLoseFor(entry, { creating = false } = {}) {
  if (creating === true) return true
  if (!entry) return false
  if (!entry.baseline) return true
  return BASELINE_FIELDS.some(
    (field) => (entry[field] ?? null) !== (entry.baseline[field] ?? null),
  )
}

//: **Would closing *this card* lose something?** (D8) — the card-level reading of
//: the verdict above, and the only one the footer's guard asks. The card holds one
//: form per agent, so a keystroke in a row the user has since left behind is still
//: work that leaving would throw away: the answer is `closeWouldLoseFor` for every
//: entry the card holds, plus creation mode, and **nothing else** — the baseline is
//: its only input, and the save slot is consulted nowhere in here (Q2).
export function closeWouldLoseForDraft(draft, { creating = false } = {}) {
  if (creating === true) return true
  return (Array.isArray(draft?.entries) ? draft.entries : []).some((entry) =>
    closeWouldLoseFor(entry),
  )
}

//: The **close** pair, same shape as the delete pair's verdict: absent from the
//: DOM until a close is being confirmed, and never inert once it is there —
//: `Keep editing` and `Discard and close` are answers that can always be given.
export function closeConfirmationFor(context = {}) {
  const { closing } = slotContext(context)
  if (!closing) return { rendered: false, cancel: null, confirm: null }
  return {
    rendered: true,
    cancel: slotLive('Keep editing'),
    confirm: slotLive('Discard and close'),
  }
}

//: The row to select once a delete has landed (D7.5): the **next** one in the
//: order it is given, else the **previous** one when the deleted row was last,
//: else nothing when the list came back empty. It adds no ordering of its own —
//: the store's order is the server's (`resolve_agents()`, app-owned row last), so
//: the card calls it with the list as it held it while the deleted row was still
//: in it, and then selects the returned row by id in the re-baselined list.
export function successorAfterDelete(entries, entry) {
  const list = Array.isArray(entries) ? entries : []
  if (!list.length) return null
  const index = list.indexOf(entry)
  if (index === -1) return null
  return list[index + 1] ?? list[index - 1] ?? null
}

//: **What an empty new-agent form holds** (D4): no label, no persona, both hub
//: switches off, the tool loop at the payload's floor, no model, and the id the
//: existing slug rule derives from an empty label — a neutral placeholder the Id
//: field still corrects. The card never assembles a form field-by-field in the
//: template, and no number is spelled here: the floor is `caps`'s.
//:
//: It carries the flags a not-yet-stored row needs — new, not deletable, not
//: readonly — so the same slot verdicts answer for it: save is live (there is a
//: form to write), delete is inert with its reason (nothing is stored to delete).
//: Its baseline is null because nothing was ever written, which is also why the
//: close guard treats creation mode as unsaved work by definition.
export function creationFormFor(draft) {
  return {
    id: slugForDraft(draft, ''),
    isNew: true,
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
// read noticed. Nothing is copied out of a document, and no entry is added: the
// app owns these rows.
export function createAgentDraft(payload) {
  const agents = Array.isArray(payload?.agents) ? payload.agents : []
  return {
    caps: payload?.caps ?? {},
    findings: Array.isArray(payload?.findings) ? payload.findings : [],
    entries: agents.map(entryOfRow),
  }
}

// Drop an entry from the in-memory list. The card never appends one (D4: a new
// agent is a form, not an entry, until a save succeeds), so this is the only
// draft mutation the editor's shape still answers for.
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
// A **`readonly`** row sends its model association and nothing else: every
// other column is nojae's, and the route refuses the rest with one sentence
// (D4) — so the client never asks for what it knows is refused.
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
  const cap = Number(entry.maxToolIteration)
  if (Number.isInteger(cap)) payload.maxToolIteration = cap
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
  // The two failures the card can meet are told apart because D11's priority
  // ranks them differently: a refused **write** outranks the incomplete-form
  // sentence, a failed **read** is under it.
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

//: The store's own sentence about the last refused write, verbatim (D11: a
//: refusal is said in the store's words, not the client's paraphrase). A refusal
//: answers either with one `detail` string — kept as a finding — or with a
//: validation body, which `describeError` turned into `writeError`.
function storeRefusalSentence() {
  return editorState.serverFindings[0]?.message || editorState.writeError || null
}

//: **The card's one message** (D11): everything it has to say — progress, a
//: refusal from the store, an incomplete form, a failed read, the read's
//: findings — chosen by this fixed priority and never by recency, so two truths
//: never fight for the line. The role is part of the answer, because the line is
//: announced and not just drawn: `alert` for a refusal or a failure, `status` for
//: progress and for the incomplete-form sentence.
//:
//: It always answers an object, so the line is a slot that is *always there*: an
//: empty `text` means nothing to say, and filling or emptying it reflows nothing
//: (D10). It clears when its cause goes away because it is derived from the state
//: that caused it — typing the missing label empties the form sentence, and a
//: successful write clears the store's.
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

// Remove one agent. The store copies the database first (D12), so the confirm
// the dialog asks is the only guard the user needs.
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

