import { reactive } from 'vue'

import { describeTransportError, fetchWithRetry } from '../lib/api-fetch'
import { copyText } from '../lib/clipboard'
import { useBatch } from './useBatch'
import { useChat } from './useChat'
import {
  agentCanRun,
  agentModePayloadId,
  agentNoModelSentence,
  modeBlocksHub,
  modeById,
} from './useAgentModes'
import { useWorkspaceSession, withWorkspace } from './useWorkspaceSession'

// ---------------------------------------------------------------------------
// The connector wizard's rules ("Set me up!").
//
// The wizard's **one** rule surface, in the idiom `useSettingsServers` and
// `useAgentModes` settled on: every enablement verdict, every tooltip and the
// dialog's one message are answered here as a plain function, and
// `ConnectorWizardDialog.vue` renders the answers. No rule about what a control
// may do is written in the template, so a rule cannot drift from the button that
// shows it — and an inert control always explains itself, because its accessible
// name when live and its reason when not are one string moving as one.
//
// Two buttons open **one** three-page dialog (choose → prepare → apply). The
// family comes from the button that opened it and is never a question; only page
// 1's *source of candidates* differs. Nothing writes a declaration file, starts
// or restarts a connector or a language server, installs a package or spawns the
// candidate — so nothing here calls a hub, and nothing here arms or sends a chat
// turn. The snippet is text handed to the user; the install line is a composer
// draft and nothing else.
//
// Three consequences worth stating where the code can be read against them:
//
//  * **the only gate is the model.** A reply streaming, a running batch, a locked
//    toggle set, an agent mode that switches this hub off and a hub route that
//    refused the workspace all leave the button live: discovery writes nothing
//    and starts nothing. The gate is `setMeUpSlotFor`'s one branch, and its inert
//    reason is `useAgentModes`'s existing no-model sentence for that row, reused
//    verbatim — one reason that reads differently in two tooltips is two reasons.
//  * **no numbers, anywhere.** The wizard's model calls belong to no
//    conversation: their tokens enter neither the session clock nor the cost
//    badges, so this module reads and writes neither, and no sentence it builds
//    carries a figure. Every page shows the header line instead.
//  * **one attempt, no waiting.** The two posts are deliberately not retried:
//    `api-fetch`'s own comment is why (a retry on a POST either duplicates a
//    write or resumes a half-streamed reply), and a dialog that silently sleeps
//    through a backoff is worse than a named failure the user can answer by
//    pressing again. The three *reads* (catalogue, connection, scan) go through
//    the retry helper, because a transport blip on a GET costs nothing to absorb.
// ---------------------------------------------------------------------------

//: The two families, spelled the way the panels and the routes spell them. The
//: family arrives from the button; there is no third name and no question.
export const FAMILY_MCP = 'mcp'
export const FAMILY_LSP = 'lsp'
export const FAMILIES = [FAMILY_MCP, FAMILY_LSP]

//: The pages, in order, as **data** — the dialog walks this list and decides
//: nothing itself. Page 1's *source of candidates* is the one thing a family
//: changes, and it is named here beside the pages so the two cannot drift.
export const PAGE_CHOOSE = 'choose'
export const PAGE_PREPARE = 'prepare'
export const PAGE_APPLY = 'apply'
export const PAGES = [PAGE_CHOOSE, PAGE_PREPARE, PAGE_APPLY]

//: Page 1's candidate source per family: the committed catalogue for MCP, the
//: servers the model proposed for this folder for LSP — there is no LSP
//: catalogue.
export const SOURCE_CATALOGUE = 'catalogue'
export const SOURCE_PROPOSAL = 'proposal'

export function candidateSource(family) {
  if (family === FAMILY_MCP) return SOURCE_CATALOGUE
  if (family === FAMILY_LSP) return SOURCE_PROPOSAL
  return null
}

//: The button's tooltip **and** its accessible name — one string, the app's
//: convention for an icon button (`Set me up!`).
export const SET_ME_UP_LABEL = 'Set me up!'

//: The header line's two halves. The names are the connection read's; this
//: module invents none of them and adds no number.
const HEADER_LEAD = 'Wizard is running with'

//: The readiness pair — the two answers the resolution check gives. Spelled once
//: here so the dialog compares nothing; the *words* are the snippet module's,
//: because the app owns them.
export const READY = 'looks installed'
export const NOT_INSTALLED = 'not installed'

//: The platform keys an install line may carry. ``any`` is the line where no
//: platform differs, and a platform's own key beside it overrides that one.
export const PLATFORM_WINDOWS = 'windows'
export const PLATFORM_POSIX = 'posix'
export const PLATFORM_ANY = 'any'

//: The three failures the wizard names apart, plus the stop that is a *fourth*
//: thing and must never read like one of them. Each is a plain sentence this
//: module owns, used only where the server said nothing; wherever the payload
//: carries a sentence, `failureSentence` hands that one back verbatim, because
//: this module adds no paraphrase of a sentence the app already owns.
export const FAILURE_ENDPOINT = 'endpoint'
export const FAILURE_UNREADABLE = 'unreadable'
export const FAILURE_NOTHING = 'nothing'

export const FAILURE_ENDPOINT_SENTENCE =
  'The model could not be reached: the wizard makes one attempt and stops here, ' +
  'so press the button again to retry.'

export const FAILURE_UNREADABLE_SENTENCE =
  "The model's answer could not be read: it did not carry the shape the wizard " +
  'asked for, so press the button again to retry.'

//: The third failure, hardest to keep apart from the stop: the model answered and
//: was readable, and what it answered offers no entry this need can be built
//: from. It is a *failure* — a press may ask again — where the stop is the end of
//: the road, so the two never share a sentence.
export const FAILURE_NOTHING_SENTENCE =
  "The model's answer offered no entry that fits this need: nothing was " +
  'prepared, so press the button again to ask it again.'

//: The one sentence the "none of these" road ends on: it names the declaration
//: file the entry would have belonged in and stops there. There is no entry, no
//: field and no link to the JSON editor — the user edits that file by hand.
export const STOP_SENTENCE_LEAD =
  'Nothing offered fits this need — the wizard stops here, and the entry has to ' +
  'be written by hand in '

//: The copy action's two answers. The confirmation is only ever reached after the
//: clipboard helper answered.
export const COPIED_LABEL = 'Copied'
export const COPY_FAILED_LABEL = 'Copy failed'

//: One line per step, while the step is in flight. A status line, never a token
//: stream: the wizard's calls are non-streaming by construction.
const WAITING_CHOOSE_MCP = 'Reading the connector catalogue…'
const WAITING_CHOOSE_LSP = 'Looking at this project to choose a server for it…'
const WAITING_PREPARE = 'Preparing the entry for this machine and this folder…'

//: ---------------------------------------------------------------------------
//: State: one wizard at a time
//: ---------------------------------------------------------------------------
//
// One component with one state machine, not two, so there is one of everything
// here. Nothing is a draft: there is no saved snippet, no server-side draft and no
// free-text field to hold one, so a closed walk leaves nothing behind — which is
// why `reset()` exists and why `open()` calls it.
const state = reactive({
  open: false,
  // `mcp` / `lsp` — from the button, never a question.
  family: null,
  // One of `PAGES`.
  page: null,
  // The agent the dialog resolved its connection from, pinned at open so a
  // mid-dialog switch cannot split the walk (the chat's "once, at a turn's
  // start" rule, applied to a wizard).
  agentMode: null,
  // Page 1's list: catalogue entries for MCP, proposals for LSP.
  candidates: [],
  // The one candidate chosen. Only ever a row of `candidates` — `select` refuses
  // anything else, so no state exists that could hold a hand-written candidate.
  selected: null,
  // Page 2/3's answer, exactly as the prepare post returned it.
  prepared: null,
  // The step in flight.
  loading: false,
  // The one failure sentence (see `failureSentence`).
  failure: null,
  // The model answered and offered nothing that fits — a *stop*, not a failure.
  empty: false,
  // The absolute path page 3 prints, from whichever answer last carried it.
  declarationPath: null,
  // What a read noticed (the catalogue's own notes, a prepare's notes).
  notes: [],
  // `null` until a copy has been asked for, then whether it landed.
  copied: null,
  // The connection read's answer: `{agentMode, agent, server, model, canRun,
  // refusal}`. Three names and one verdict, never a credential.
  connection: null,
  // Its own in-flight flag and its own failure sentence, kept apart from
  // `loading`/`failure` because the connection is a fact about the **install**
  // rather than about a walk: a step that later succeeds must not wipe the
  // reason the header line cannot name what the wizard would run as.
  connectionLoading: false,
  connectionFailure: null,
  // The other two reads, each with its own in-flight flag and its own verdict.
  // The two posts share `loading`/`failure` above: one step at a time is the
  // wizard's whole shape, so they are one flag rather than two that could
  // disagree.
  catalogue: { entries: [], notes: [], loaded: false, loading: false, failure: null },
  scan: { facts: null, loading: false, failure: null },
})

// ---------------------------------------------------------------------------
// Plain helpers over the state above
// ---------------------------------------------------------------------------

function slotLive(label) {
  return { disabled: false, label }
}

function slotInert(label) {
  return { disabled: true, label }
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

// The server's refusal sentence, when it is a sentence — the body's `detail`
// verbatim, the same reading every other composable in the app does.
function describeError(body, fallback) {
  const detail = body?.detail
  if (typeof detail === 'string' && detail) return detail
  if (Array.isArray(detail)) {
    const messages = detail.map((item) => {
      const field = Array.isArray(item?.loc)
        ? item.loc.filter((part) => part !== 'body' && part !== 'query').join('.')
        : ''
      return field ? `${field}: ${item?.msg ?? 'invalid'}` : item?.msg ?? 'invalid'
    })
    if (messages.length) return messages.join(' · ')
  }
  return fallback
}

// The snippet, or nothing: the one accessor the dialog's block reads, so there
// is no second place a cached snippet could live.
export function snippet() {
  return state.prepared?.snippet ?? null
}

//: ---------------------------------------------------------------------------
//: The gate
//: ---------------------------------------------------------------------------
//
// The gate is a table of *live*: a reply streaming, a batch running, the toggles
// locked by a started conversation, the active agent mode switching this hub off,
// and a hub route that refused the workspace all leave the button live.
// Discovery writes nothing and starts nothing, so nothing the toggles are gated
// by gates preparation — and the fields are accepted here rather than dropped on
// the floor, so the rule is *asserted* rather than merely intended.

function gateContext({
  mode = null,
  connection = null,
  streaming = false,
  batchActive = false,
  togglesLocked = false,
  modeSwitchesHubOff = false,
  poolRefused = null,
} = {}) {
  return {
    mode,
    connection,
    // Read, deliberately, by nothing below. Spelled out anyway: these five rows
    // leave the button live, and a future edit that made one of them gate the
    // button should have to delete one of these lines and read this comment.
    streaming: streaming === true,
    batchActive: batchActive === true,
    togglesLocked: togglesLocked === true,
    modeSwitchesHubOff: modeSwitchesHubOff === true,
    poolRefused: textOf(poolRefused) || null,
  }
}

// Can the agent the panel is showing run at all?
//
// Two authorities, in one order: the connection read's own `canRun` when it has
// answered, otherwise the agent row's `modelId` through `agentCanRun`. Neither
// re-derives the rule from two tables — that rule is `useAgentModes`'s.
function canRunOf(ctx) {
  if (ctx.connection && typeof ctx.connection.canRun === 'boolean') {
    return ctx.connection.canRun
  }
  return agentCanRun(ctx.mode)
}

// Why it cannot, in the app's existing words — exactly two of them, because there
// are exactly two states: a row carrying no model gets `useAgentModes`'s own
// `agentNoModelSentence`, never a re-wording here; a row that *does* name a model
// the app cannot reach gets the server's refusal from the connection read,
// verbatim, because it names the state the row cannot see.
function reasonOf(ctx) {
  if (ctx.mode && !agentCanRun(ctx.mode)) return agentNoModelSentence(ctx.mode)
  return textOf(ctx.connection?.refusal) || agentNoModelSentence(ctx.mode)
}

//: The two buttons' one verdict: `{disabled, label}`. The same string is the
//: button's accessible name when live and its reason when inert, so the pair
//: moves as one or not at all.
export function setMeUpSlotFor(context = {}) {
  const ctx = gateContext(context)
  // No hub state appears on this line, and that absence is the rule.
  if (canRunOf(ctx)) return slotLive(SET_ME_UP_LABEL)
  return slotInert(reasonOf(ctx))
}

// The modules that own the state the gate reads, resolved **once**: this file is
// a singular module, so its collaborators are never re-created per render. Their
// factories do real work (a re-root registration, a set of computeds), which a
// computed re-evaluating on every keystroke must not repeat.
let collaborators = null

function live() {
  if (!collaborators) {
    collaborators = {
      chat: useChat(),
      batch: useBatch().state,
      session: useWorkspaceSession().state,
    }
  }
  return collaborators
}

// The composer the hand-over writes the draft through — `useChat`'s own instance,
// so the preview updates on the usual debounce rather than a second setter.
function composer() {
  return live().chat
}

// The gate read off the app's live state, in the gate's own five fields plus the
// agent row — so the panel that draws the button passes nothing and decides
// nothing.
export function panelGateContext(family) {
  const { chat, batch, session } = live()
  const hub = family === FAMILY_LSP ? 'lsp' : 'mcp'
  return {
    // The row the panel is **showing**: `useAgentModes`'s current selection.
    mode: modeById(),
    connection: state.connection,
    streaming: chat.state.phase !== 'idle',
    batchActive: batch.active === true,
    togglesLocked: chat.state[hub]?.locked === true,
    modeSwitchesHubOff: modeBlocksHub(hub),
    poolRefused: session.poolRefusal,
  }
}

//: The button's verdict for one panel: `{disabled, label}`.
export function setMeUpSlot(family) {
  return setMeUpSlotFor(panelGateContext(family))
}

//: ---------------------------------------------------------------------------
//: Every sentence, as a plain function, each spelled once
//: ---------------------------------------------------------------------------

//: The header line: whose reasoning the wizard spends, and on what. Present from
//: the moment the dialog opens and on every page. Three **names** and no number —
//: an unresolved half is not guessed, it is left out, because a header naming a
//: model nobody chose would be worse than a short line.
export function headerLine(connection = state.connection) {
  if (!connection) return null
  const agent = textOf(connection.agent)
  if (!agent) return null
  const server = textOf(connection.server)
  const model = textOf(connection.model)
  if (!server || !model) return `${HEADER_LEAD} ${agent}`
  return `${HEADER_LEAD} ${agent} on ${server} — ${model}`
}

//: The line a page shows while its step is in flight — a status line, never a
//: token stream. `null` when nothing is running.
export function waitingLine() {
  if (!state.loading) return null
  if (state.page === PAGE_PREPARE) return WAITING_PREPARE
  return state.family === FAMILY_LSP ? WAITING_CHOOSE_LSP : WAITING_CHOOSE_MCP
}

//: The three failures, pairwise distinct, and none of them the empty answer's
//: sentence. `carried` is the endpoint's or the model step's own sentence: when it
//: is there, its words are the words the page shows.
export function failureSentence(kind, carried = null) {
  const said = textOf(carried)
  if (said) return said
  if (kind === FAILURE_UNREADABLE) return FAILURE_UNREADABLE_SENTENCE
  if (kind === FAILURE_NOTHING) return FAILURE_NOTHING_SENTENCE
  return FAILURE_ENDPOINT_SENTENCE
}

//: The stop: one sentence naming the declaration file, and the end of the road.
//: Neither list carries a "none of these" entry, and there is no free-text field
//: and no link to the JSON editor behind this line.
export function stopSentence(declarationPath = state.declarationPath) {
  const path = textOf(declarationPath)
  if (!path) return STOP_SENTENCE_LEAD + 'the declaration file for this workspace.'
  return STOP_SENTENCE_LEAD + path + '.'
}

//: The dialog's **one** message: the highest-priority line the page has to say,
//: and nothing competing with it. A failure outranks the stop, because a step
//: that did not answer is not an answer that found nothing; a connection read
//: that failed outranks a note, because it is why the header line is short.
export function messageLine() {
  if (state.failure) return { text: state.failure, role: 'alert' }
  if (state.empty) return { text: stopSentence(), role: 'status' }
  if (state.connectionFailure) return { text: state.connectionFailure, role: 'alert' }
  const notes = state.notes ?? []
  if (notes.length) return { text: notes.join(' · '), role: 'status' }
  return { text: '', role: 'status' }
}

//: The readiness line: the resolution's verdict, in the app's own words. `null`
//: when there is nothing to look up (a remote member carries no command).
export function readinessLine(prepared = state.prepared) {
  const value = textOf(prepared?.readiness)
  if (value === READY) return READY
  if (value === NOT_INSTALLED) return NOT_INSTALLED
  return null
}

//: The sentinel warning: the page says the entry will not authenticate until the
//: slot is replaced. The sentence is the snippet module's; this module passes it
//: through and adds no second wording.
export function sentinelWarning(prepared = state.prepared) {
  return textOf(prepared?.valueWarning) || null
}

//: Which of the two value forms the member shows — `sentinel`,
//: `environment-reference` or `none` — so page 3 can say which one it is.
export function valueForm(prepared = state.prepared) {
  return textOf(prepared?.valueForm) || null
}

//: The duplicate-id warning: a warning, never a stop — the snippet is still
//: offered, and nothing changes until the user pastes it.
export function duplicateWarning(prepared = state.prepared) {
  return textOf(prepared?.duplicate) || null
}

//: The loader's verdict on the member, in the loader's own words. A refusal names
//: the field to change because the hub's loader does.
export function verdictLine(prepared = state.prepared) {
  return textOf(prepared?.verdict) || null
}

//: What the loader noticed besides its verdict — an unresolved `${NAME}`, the
//: reach refusal saying a `local` candidate cannot be started here.
export function verdictNotes(prepared = state.prepared) {
  const notes = prepared?.verdictNotes
  return Array.isArray(notes) ? notes.filter((note) => textOf(note)) : []
}

//: The lines the member's shape had to decide (a workspace root, an executable,
//: a key's slot) — one line each, so the reasoning is visible rather than
//: summarised away.
export function decisionLines(prepared = state.prepared) {
  const lines = prepared?.decisions
  return Array.isArray(lines) ? lines.filter((line) => textOf(line)) : []
}

//: The missing-file sentence: the file has to be created, the member goes inside
//: an object at its top level, and this is the absolute path to create. The
//: snippet stays a **member** either way — the wizard never emits a whole file,
//: and creating the file is the user's act like every other write.
export function missingFileSentence(prepared = state.prepared) {
  if (!prepared || prepared.declarationExists !== false) return null
  const path = textOf(prepared.declarationPath)
  if (!path) return null
  return (
    `There is no declaration file yet: create ${path} and put this member inside ` +
    'the object at its top level. The wizard never creates it for you.'
  )
}

//: The restart sentence: the app reads a declaration only at start-up, so a
//: restart is what applies the member — pointing at the panel's own restart
//: button. The wizard has no restart control of its own.
export function restartSentence() {
  return (
    "nojae reads the declaration file only at start-up: press this panel's " +
    'restart button after pasting, and the new entry appears.'
  )
}

//: The copy confirmation — reached only after the clipboard helper answered.
export function copyConfirmation() {
  if (state.copied === true) return COPIED_LABEL
  if (state.copied === false) return COPY_FAILED_LABEL
  return null
}

//: The copy action's own slot: inert until there is a member to copy, and its
//: label becomes the confirmation once the copy landed.
export function copySlot() {
  const confirmation = copyConfirmation()
  if (confirmation) return slotLive(confirmation)
  if (!snippet()) return slotInert('There is no member to copy yet.')
  return slotLive('Copy the member')
}

//: Page 1's one button: live once a candidate is chosen, and its inert reason
//: says what is missing instead of leaving the user to guess.
export function continueSlot() {
  if (state.loading) return slotInert('Waiting for the wizard to answer.')
  if (state.page === PAGE_CHOOSE) {
    return state.selected
      ? slotLive('Continue')
      : slotInert('Choose one of the candidates first.')
  }
  if (state.page === PAGE_PREPARE) {
    return state.prepared
      ? slotLive('Continue')
      : slotInert('The entry is not ready yet.')
  }
  return slotInert('There is nothing left to do on this page.')
}

//: ---------------------------------------------------------------------------
//: The install line, and the hand-over that fills and only fills
//: ---------------------------------------------------------------------------

//: The platform this browser is running on, in the two words an install line
//: uses. Only ever decides *which* of the lines to show: neither word is a rule
//: about the machine, and the payload carries the lines themselves.
export function currentPlatform(nav = globalThis.navigator) {
  const agent = String(nav?.userAgent ?? '')
  return /windows|win32|win64/i.test(agent) ? PLATFORM_WINDOWS : PLATFORM_POSIX
}

//: The line the user would run here: the platform's own key when the payload
//: carries one, else the platform-independent `any`.
export function installLine(install, platform = currentPlatform()) {
  if (!install || typeof install !== 'object') return null
  const own = textOf(install[platform])
  if (own) return own
  return textOf(install[PLATFORM_ANY]) || null
}

//: Every line the payload carries, so a page can show the ones that differ per
//: platform: `[{platform, line}]`, `any` first.
export function installLines(install) {
  if (!install || typeof install !== 'object') return []
  const order = [PLATFORM_ANY, PLATFORM_WINDOWS, PLATFORM_POSIX]
  const rows = []
  for (const platform of order) {
    const line = textOf(install[platform])
    if (line) rows.push({ platform, line })
  }
  return rows
}

//: The hand-over: it **fills the composer and nothing else**. No arming, no send,
//: no focused send control, no pre-approval — the only composer surface touched
//: is the draft, through `useChat`'s own setter so the preview updates on the
//: usual debounce.
export function handOverInstallLine(line, target = null) {
  const text = textOf(line)
  if (!text) return null
  const onto = target ?? composer()
  // The one composer surface this feature touches. `setDraft` and nothing else:
  // no `send`, no `stage`, no `appendDraft` (which would focus the textarea).
  onto.setDraft(text)
  return text
}

//: The same hand-over for the answered page: the install line the payload
//: carries for this platform. `null` when nothing has to be installed.
export function handOverInstall(target = null) {
  return handOverInstallLine(installLine(state.prepared?.install), target)
}

//: Whether the answered page has anything to install at all.
export function installSlot() {
  const line = installLine(state.prepared?.install)
  if (!line) return slotInert('This entry installs nothing.')
  return slotLive('Write the install line in the composer')
}

// ---------------------------------------------------------------------------
// The loading: three reads (retried) and two posts (one attempt)
// ---------------------------------------------------------------------------

function fail(sentence, read = null) {
  state.failure = sentence
  if (read) read.failure = sentence
  return null
}

// The page 1 MCP list: the committed catalogue, and **no model run**. It is
// installation-scoped, so it names no folder.
async function loadCatalogue() {
  state.loading = true
  state.failure = null
  state.catalogue.loading = true
  state.catalogue.failure = null
  try {
    const res = await fetchWithRetry('/api/wizard/catalogue')
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      state.catalogue.entries = []
      state.catalogue.loaded = false
      state.candidates = []
      return fail(
        describeError(body, `Could not read the connector catalogue (${res.status}).`),
        state.catalogue,
      )
    }
    state.catalogue.entries = Array.isArray(body?.entries) ? body.entries : []
    state.catalogue.notes = Array.isArray(body?.notes) ? body.notes : []
    state.catalogue.loaded = true
    // A catalogue that could not be read answers an empty list **and** the
    // reader's sentence, never a silent empty list — the same rule the route
    // holds, so the page cannot say "nothing is offered" when the truth is "the
    // file could not be read".
    state.notes = state.catalogue.notes
    state.candidates = state.catalogue.entries
    return state.candidates
  } catch (exc) {
    state.catalogue.entries = []
    state.catalogue.loaded = false
    state.candidates = []
    return fail(describeTransportError(exc), state.catalogue)
  } finally {
    state.catalogue.loading = false
    state.loading = false
  }
}

// The connection read: the header line's three names and the gate's verdict,
// resolved once at the wizard's start. Its failure lives in its own slot rather
// than in `failure`, because this is "the wizard cannot say what it would run as",
// which a later step that works must not clear.
async function loadConnection(agentMode = state.agentMode) {
  state.connectionFailure = null
  state.connectionLoading = true
  const query = new URLSearchParams()
  if (agentMode) query.set('agentMode', agentMode)
  const suffix = query.toString() ? `?${query}` : ''
  try {
    const res = await fetchWithRetry(`/api/wizard/connection${suffix}`)
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      state.connection = null
      state.connectionFailure = describeError(
        body,
        `Could not read the wizard's connection (${res.status}).`,
      )
      return null
    }
    state.connection = body
    return body
  } catch (exc) {
    state.connection = null
    state.connectionFailure = describeTransportError(exc)
    return null
  } finally {
    state.connectionLoading = false
  }
}

// The derived facts about this request's folder, and never its bytes. It is not on
// the dialog's open path, because the LSP page's answer is grounded in the same
// scan **server-side** and the page renders the proposal, not the facts.
async function loadScan() {
  state.scan.loading = true
  state.scan.failure = null
  try {
    const res = await fetchWithRetry(withWorkspace('/api/wizard/scan'))
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      state.scan.facts = null
      return fail(
        describeError(body, `Could not scan this folder (${res.status}).`),
        state.scan,
      )
    }
    state.scan.facts = body?.facts ?? null
    return state.scan.facts
  } catch (exc) {
    state.scan.facts = null
    return fail(describeTransportError(exc), state.scan)
  } finally {
    state.scan.loading = false
  }
}

// The one post helper the two steps share: **one attempt**, no retry, no sleep.
// A plain JSON post, not SSE, and a model step that failed is a `failed` outcome
// with its sentence at 200 rather than an HTTP failure. Only a bad request (an
// unknown agent, a folder that was refused) is a 4xx, and its detail is the app's
// sentence.
async function postStep(url, payload) {
  state.loading = true
  state.failure = null
  try {
    const res = await fetch(withWorkspace(url), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      return fail(
        describeError(body, `The wizard's request was refused (${res.status}).`),
      )
    }
    if (!body || typeof body !== 'object') {
      return fail(failureSentence(FAILURE_UNREADABLE))
    }
    return body
  } catch (exc) {
    return fail(describeTransportError(exc))
  } finally {
    state.loading = false
  }
}

// Adopt one step's answer: the outcome is `ok` / `empty` / `failed` and there is
// no fourth shape, so the page has nothing to branch on beyond these three.
function adoptProposal(body) {
  state.declarationPath = textOf(body?.declarationPath) || state.declarationPath
  state.notes = Array.isArray(body?.notes) ? body.notes : []
  if (body?.outcome === 'ok') {
    state.candidates = Array.isArray(body.proposals) ? body.proposals : []
    state.empty = state.candidates.length === 0
    return state.candidates
  }
  state.candidates = []
  if (body?.outcome === 'empty') {
    // The model answered and nothing fits: a stop, not a failure.
    state.empty = true
    return state.candidates
  }
  state.empty = false
  return fail(failureSentence(FAILURE_NOTHING, body?.sentence))
}

// The LSP page 1: the servers the model proposes for this folder, best first.
async function propose() {
  const body = await postStep('/api/wizard/propose', { agentMode: state.agentMode })
  if (!body) {
    state.candidates = []
    return null
  }
  return adoptProposal(body)
}

// Page 2 of both families: the complete member for the chosen candidate, plus
// everything page 3 prints.
async function prepare() {
  const candidate = state.selected
  if (!candidate) return fail(FAILURE_NOTHING)
  state.prepared = null
  state.copied = null
  state.empty = false
  state.notes = []
  // Which connector this is comes from the catalogue and nowhere else, so the
  // body carries the entry's **id** and never its member: a request that carried
  // its own member could hand the model — and then the user — a command line no
  // reviewer ever saw.
  const payload = {
    agentMode: state.agentMode,
    family: state.family,
    candidate:
      state.family === FAMILY_MCP ? { id: candidate.id } : { ...candidate },
  }
  const body = await postStep('/api/wizard/prepare', payload)
  if (!body) return null
  state.declarationPath = textOf(body?.declarationPath) || state.declarationPath
  state.notes = Array.isArray(body?.notes) ? body.notes : []
  if (body?.outcome !== 'ok' || !body?.member) {
    state.prepared = null
    return fail(failureSentence(FAILURE_NOTHING, body?.sentence))
  }
  // One shape whatever happened, so the dialog renders answers only: a prepared
  // page and a refused one carry the same keys.
  state.prepared = body
  state.empty = false
  return body
}

// ---------------------------------------------------------------------------
// The walk
// ---------------------------------------------------------------------------

//: Opening the dialog: which family, which page, and the two reads the first page
//: needs. Opening the MCP family runs **no model** — the catalogue is a committed
//: file — while the LSP family's page 1 *is* the proposal, because there is no LSP
//: catalogue.
export async function open(family, { agentMode = null } = {}) {
  if (!FAMILIES.includes(family)) return false
  // Opening the other panel's button while this dialog is up re-opens on the new
  // family and discards the unfinished walk: there is no server-side draft to
  // lose, so there is nothing to ask about.
  reset()
  state.open = true
  state.family = family
  state.page = PAGE_CHOOSE
  state.agentMode = agentMode ?? agentModePayloadId()
  // The header line is on screen from the moment the dialog opens, so the
  // connection is read before the page has content to show.
  await loadConnection(state.agentMode)
  if (family === FAMILY_MCP) return loadCatalogue()
  return propose()
}

//: Closing the wizard leaves nothing behind: no candidate, no prepared answer,
//: no failure, no snippet — the feature has no memory by design. The connection
//: survives, because it is a fact about the install rather than about a walk and
//: the buttons' gate reads it while the dialog is shut.
export function close() {
  state.open = false
  state.family = null
  state.page = null
  state.agentMode = null
  reset()
}

//: The walk's own state, back to nothing.
export function reset() {
  state.candidates = []
  state.selected = null
  state.prepared = null
  state.loading = false
  state.failure = null
  state.empty = false
  state.declarationPath = null
  state.notes = []
  state.copied = null
}

//: Choosing a candidate. Only a row the list offered may become the choice, so a
//: hand-written candidate has no state to live in — the wizard offers a curated
//: or a reasoned list and never degrades into the editor it replaces.
export function select(candidate) {
  const id = candidate?.id
  if (!id) return null
  const found = state.candidates.find((item) => item?.id === id)
  if (!found) return null
  state.selected = found
  state.prepared = null
  state.copied = null
  return found
}

//: The dialog's one "continue": page 1 to page 2 starts the prepare step, page 2
//: to page 3 shows the verdict. Page 3 issues no request — everything it prints
//: came with the prepared answer.
export async function goOn() {
  // A step already in flight owns the next answer: a second press must not post
  // its own step over the one that is running.
  if (state.loading) return null
  if (state.page === PAGE_CHOOSE) {
    if (!state.selected) return null
    state.page = PAGE_PREPARE
    return prepare()
  }
  if (state.page === PAGE_PREPARE) {
    if (!state.prepared) return null
    state.page = PAGE_APPLY
    return state.prepared
  }
  return null
}

//: Pressing the page's button again after a named failure: one more attempt at
//: **the step that failed**, and nothing else. That is the whole of the app's
//: answer to a refusal here — no waiting, no backoff, no retry inside a press.
export async function retry() {
  if (state.loading) return null
  if (state.page === PAGE_PREPARE) return prepare()
  if (state.family === FAMILY_MCP) return loadCatalogue()
  if (state.family === FAMILY_LSP) return propose()
  return null
}

//: Copying the member. The only action in the feature that changes anything, and
//: it changes only the clipboard; the confirmation appears only after the app's
//: own helper answered.
export async function copySnippet() {
  const text = snippet()
  if (!text) return false
  const ok = await copyText(text)
  state.copied = ok === true
  return ok
}

export function useConnectorWizard() {
  return {
    state,
    // the walk
    open,
    close,
    reset,
    select,
    goOn,
    retry,
    loadScan,
    copySnippet,
    handOverInstall,
    handOverInstallLine,
    // every answer the dialog renders
    snippet,
    headerLine,
    waitingLine,
    messageLine,
    failureSentence,
    stopSentence,
    readinessLine,
    sentinelWarning,
    valueForm,
    duplicateWarning,
    verdictLine,
    verdictNotes,
    decisionLines,
    missingFileSentence,
    restartSentence,
    copyConfirmation,
    copySlot,
    continueSlot,
    installSlot,
    installLine,
    installLines,
    candidateSource,
    setMeUpSlot,
    setMeUpSlotFor,
    panelGateContext,
  }
}

