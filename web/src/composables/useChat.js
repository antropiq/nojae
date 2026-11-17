import { nextTick, reactive } from 'vue'
import {
  neutralizeControlTokenRuns,
  renderMarkdown,
  TOOL_LINE_MARKER,
} from '../lib/markdown'
import { createReasoningBuffer } from '../lib/reasoning-buffer'
import {
  noteHubPayload,
  reportPoolRefusal,
  withWorkspace,
  withWorkspaceRoot,
} from './useWorkspaceSession'
import { registerReRootHandler } from './useWorkspaceTree'
import {
  agentModePayloadId,
  applySessionAgentMode,
  clearAgentModeNotice,
  loadAgentModes,
  selectedAgentGateReason,
} from './useAgentModes'

const state = reactive({
  messages: [], // { role, raw, html, streaming, images } in conversation order
  phase: 'idle', // idle | waiting | reasoning | answering
  error: null,
  // Composer draft mirrored as rendered markdown so WorkBenchView can preview the
  // exact HTML that send() will attach to the user message (no re-parse).
  draft: { raw: '', html: '', renderedRaw: '' },
  // Images picked for the next message, in the order they were attached:
  // `{ dataUrl, name, size }` entries. A message may carry several, and every
  // read of this field answers about the whole list ("is there an image to
  // send?" is "is the list non-empty?"), never about a single one.
  pendingImages: [],
  // The strip: user messages the composer has accepted but no turn has carried
  // yet, in flush order. Each row is what a user message is — `raw`, its
  // rendered `html`, `streaming: false`, its own `images` — plus an `id`:
  // rows are removed and pulled back by identity, because a position stops
  // being a handle as soon as a row can be dropped. Composer input state, in
  // the same order as the draft: never part of the conversation, so nothing
  // that reads `messages` sees a row, and nothing here reaches a request.
  staged: [],
  // Chat session clock (consumed by useSessionStats, rendered by the app bar's
  // SessionClock): ms timestamp of when the running reply started, plus the
  // milliseconds every reply of the conversation has already spent
  // (`spentMs`). A turn covers the whole request — waiting, thinking and every
  // MCP/LSP tool round — and its span is added to `spentMs` when it ends, is
  // stopped or errors out, so the app bar keeps the conversation's total time
  // between two turns. Both are zeroed by reset() alone: that is the Restart
  // button, the one gesture that starts the counters over.
  // `agentMode` is the agent **this** turn was sent as, recorded when the
  // request is opened (null = no turn running). The app bar names the running
  // model off it rather than off the composer's selection, because a mid-stream
  // dropdown change reaches no turn in flight — the line would otherwise be able
  // to name an agent the stream is not answering as.
  session: { startedAt: 0, spentMs: 0, agentMode: null },
  // The reasoning panel's Live View (toggled in WorkBenchFocusGutter.vue): on
  // lets the panel paint only what its box can hold, which is the default —
  // the bounded panel is the cheap one, and the whole history is what the
  // click gives back; off keeps every line of the thinking on screen. Panel
  // render state only — the flows stay in `block.text`, so a save or a copy
  // never loses bytes.
  liveView: true,
  // A pause request is armed but its `pause_ack` has not landed yet: the ⏸
  // button blinks and is disabled, and the composer stays shut (the ack is
  // what reopens it). Cleared by the ack, by finish(), and by reset().
  pausePending: false,
  // Conversation-scoped MCP toggles (independent from the SettingsDialog):
  // the Settings-activated connectors snapshotted on tab entry, each ON by
  // default, frozen once the first message is accepted by the server.
  mcp: {
    connectors: [], // { id, label, status } — only connectors active in Settings
    enabled: {}, // id -> boolean (this conversation only, never persisted)
    loaded: false, // GET /api/mcp snapshot succeeded (panel + filter usable)
    locked: false, // sticky: first accepted send locks the toggles
    restarting: false, // POST /api/mcp/restart in flight (button stays busy)
    error: null, // the route's sentence when it refused this workspace
  },
  // Conversation-scoped LSP toggles — the exact MCP slice pattern, fed by
  // GET /api/lsp instead. Shared `locked` flag semantics: the first accepted
  // send freezes both panels until restart resets them.
  lsp: {
    servers: [], // { id, label, status } — only language servers active in Settings
    enabled: {}, // id -> boolean (this conversation only, never persisted)
    loaded: false, // GET /api/lsp snapshot succeeded (panel + filter usable)
    locked: false, // sticky: first accepted send locks the toggles (as mcp)
    restarting: false, // POST /api/lsp/restart in flight (button stays busy)
    error: null, // the route's sentence when it refused this workspace
  },
})

let controller = null
let renderScheduled = false
let activeMessage = null
let draftTimer = null
// Streamed thinking, coalesced into the panel timeline once per frame (see
// lib/reasoning-buffer). Module-level: one reply streams at a time.
const reasoningBuffer = createReasoningBuffer()
// Explicit Stop discards the partial reply; connection drops keep it.
let userStopped = false
// Pause's local fallback (when POST /api/chat/pause itself is unreachable)
// also aborts the fetch, but must NOT discard: the whole point of Pause is
// that the partial turn stays in the conversation. Distinguishes that abort
// from Stop's.
let userPaused = false

// Must mirror the backend ChatImageUrl validation (routes.py).
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

// How many images one flush may carry, counted over everything that flush would
// send: every staged message's images plus the composer's own. Images travel as
// base64 in a POST body and nothing on the path bounds the aggregate, so this is
// the bound that keeps one request small; the per-image size limit above stays
// where it is. Checked as an image is added, never at flush time — the refusal
// has to reach the user where they are attaching.
export const MAX_FLUSH_IMAGES = 6

// The images a flush would carry: every staged message's, in strip order, plus
// the composer's own pending ones. The budget above bounds exactly this count,
// so nothing else counts them a second way.
function flushImageCount() {
  const staged = state.staged.reduce((total, row) => total + (row.images?.length ?? 0), 0)
  return state.pendingImages.length + staged
}

export function humanFileSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

function clearDraft() {
  state.draft.raw = ''
  state.draft.html = ''
  state.draft.renderedRaw = ''
}

function setDraft(text) {
  state.draft.raw = text
  if (draftTimer) clearTimeout(draftTimer)
  draftTimer = setTimeout(() => {
    draftTimer = null
    const trimmed = state.draft.raw.trim()
    state.draft.renderedRaw = trimmed
    state.draft.html = trimmed ? renderMarkdown(trimmed) : ''
  }, 200)
}

// Composer textarea, registered by WorkBenchInput so draft insertions (memory
// bullets) can focus it after appending.
let draftInputEl = null

function registerDraftInput(el) {
  draftInputEl = el ?? null
}

// Appends a memory bullet's text to the draft (never overwrites): joined to
// the existing draft with a blank line when there is one. Goes through
// setDraft, so the markdown preview updates on the usual debounce.
function appendDraft(text) {
  const value = text ?? ''
  if (!value) return
  const existing = state.draft.raw
  setDraft(existing.trim() ? `${existing}\n\n${value}` : value)
  nextTick(() => {
    if (draftInputEl && document.activeElement !== draftInputEl) {
      draftInputEl.focus()
    }
  })
}

function flushDraftHtml(trimmed) {
  if (draftTimer) {
    clearTimeout(draftTimer)
    draftTimer = null
  }
  if (state.draft.renderedRaw === trimmed && state.draft.html) {
    return state.draft.html
  }
  return renderMarkdown(trimmed)
}

// Validates and reads a picked file into state.pendingImages (appending it to
// the ones already attached, in attachment order). Returns false (with
// state.error set) when rejected.
function attachImage(file) {
  if (!file) return false
  state.error = null
  if (!IMAGE_MIME_TYPES.includes(file.type)) {
    state.error = `Unsupported image type: ${file.type || file.name} (png, jpeg, webp or gif).`
    return false
  }
  if (file.size > MAX_IMAGE_BYTES) {
    state.error = `Image too large (${humanFileSize(file.size)}, max ${humanFileSize(MAX_IMAGE_BYTES)}).`
    return false
  }
  // The bound is on the request a flush would make, so it counts the strip's
  // images too — and it is checked here, at the moment of attaching, because a
  // refusal at flush time would arrive after the user had written everything.
  const wouldBe = flushImageCount() + 1
  if (wouldBe > MAX_FLUSH_IMAGES) {
    state.error = `This image would make ${wouldBe} images in this message set; at most ${MAX_FLUSH_IMAGES} fit in one turn.`
    return false
  }
  const reader = new FileReader()
  reader.onload = () => {
    state.pendingImages.push({
      dataUrl: String(reader.result),
      name: file.name || 'image',
      size: file.size,
    })
  }
  reader.onerror = () => {
    state.error = 'Could not read the selected image.'
  }
  reader.readAsDataURL(file)
  return true
}

// Drops one attached image by its position in the list; a position the list no
// longer holds (a double click on the remove button) touches nothing.
function removeImage(index) {
  if (index < 0 || index >= state.pendingImages.length) return
  state.pendingImages.splice(index, 1)
}

function clearImage() {
  state.pendingImages = []
}

// Strip rows are addressed by this rather than by their position: a row can be
// removed or pulled back, and a position stops naming the same message the
// moment one of those happens. Only ever increases, so two live rows cannot
// share a name.
let stagedSeq = 0

function stagedId() {
  stagedSeq += 1
  return `staged-${stagedSeq}`
}

// Moves the composer's draft, with the composer's images, to the end of the
// strip: same object shape and same rendering a sent turn has, so a staged row
// and a sent turn are read the same way — but it is input state, so it is never
// pushed to the conversation and it opens no stream (a stage is not a turn and
// must not look like one). The order rows are appended in is the order a flush
// sends them.
//
// Refused while a reply streams or a batch owns the conversation, and the
// refusal is silent here: the affordance that would call this is disabled in
// that window, so a stray keypress must not do anything at all.
function stage() {
  if (chatBusy()) return false
  const trimmed = state.draft.raw.trim()
  const images = state.pendingImages.map((image) => ({ ...image }))
  // Nothing to stage: no empty row, no error line.
  if (!trimmed && !images.length) return false
  // The draft's HTML comes from the same path a send takes, so Enter arriving
  // before the preview's debounce still stages the rendered draft.
  const html = trimmed ? flushDraftHtml(trimmed) : ''
  state.staged.push({
    id: stagedId(),
    role: 'user',
    raw: trimmed,
    html,
    streaming: false,
    images,
  })
  clearDraft()
  clearImage()
  nextTick(() => {
    if (draftInputEl && document.activeElement !== draftInputEl) draftInputEl.focus()
  })
  return true
}

// Drops one staged row by its id; an id the strip no longer holds (a double
// click on the remove button) touches nothing. Refused while the conversation
// is busy, exactly as staging is: the strip is read-only then, never hidden.
function removeStaged(id) {
  if (chatBusy()) return false
  const index = state.staged.findIndex((row) => row.id === id)
  if (index === -1) return false
  state.staged.splice(index, 1)
  return true
}

// Moves one staged row back into the composer for editing: its text becomes the
// draft and its images join the composer's pending list, in their own order
// after the ones already there. This is the same images changing hands, so the
// per-turn image budget cannot be exceeded by it and is deliberately not
// re-checked. Refused while the conversation is busy, as every strip verb is.
function pullBackStaged(id) {
  if (chatBusy()) return false
  const index = state.staged.findIndex((row) => row.id === id)
  if (index === -1) return false
  const [row] = state.staged.splice(index, 1)
  setDraft(row.raw)
  state.pendingImages = [
    ...state.pendingImages,
    ...(row.images ?? []).map((image) => ({ ...image })),
  ]
  return true
}

// The tab's folder moved: the strip goes with it. Staged text carries no path,
// but a staged mockup and the intent behind it very well may, so the same rule
// that forgets the Editor's open buffers applies here — and the loss is
// *reported* rather than silently dropped. The report goes on the chat error
// line above the composer: that is the app's alert line, it sits exactly where
// the strip was, and it is visible whenever the WorkBench tab is — the Editor's
// notices stack renders only on the other tab, where nobody would read it.
// Nothing to lose moves silently, the way a folder switch with no unsaved buffer
// says nothing at all.
function discardStagedForReRoot({ workspace = '' } = {}) {
  const lost = state.staged.length
  if (!lost) return
  state.staged = []
  state.error =
    `Working location switched${workspace ? ` to ${workspace}` : ''} — ` +
    `${lost} staged ${lost === 1 ? 'message was' : 'messages were'} discarded ` +
    'before being sent'
}

// Everything a conversation needs freshly snapshotted: the agent-mode list and
// both hub allowlists. The three are per-workspace and per-settings, so every
// entry point into a conversation (boot, the WorkBench tab's watch, a restart)
// calls this one function instead of picking a subset — which is what keeps the
// mode dropdown from being the one thing that stayed stale.
export async function loadChatHubs() {
  loadAgentModes()
  await Promise.all([loadChatMcp(), loadChatLsp()])
}

// Snapshot the Settings-activated connectors for a new conversation. Never
// touches a locked (already-started) conversation; on failure the panel
// stays hidden and send() omits the mcpEnabled filter, so chat keeps
// working with every activated connector — a failed load must not silently
// disable connectors the user never got to toggle. Toggle choices survive
// the refresh (restart, tab re-entry and MCP settings saves): previously
// switched-off connectors come back off, freshly appearing ones default to
// ON. Exported for useAppShell's saveMcp() so saving the MCP settings
// refreshes the panel right away (no cycle: useChat imports useAppShell
// nowhere).
export async function loadChatMcp() {
  if (state.mcp.locked) return
  try {
    const res = await fetch(withWorkspace('/api/mcp'))
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      // The route's own sentence, verbatim. A 429 is the pool refusing this
      // workspace, so the app bar says the same thing (one sentence, two
      // surfaces); a 422 is the folder itself, and the bar already named it.
      state.mcp.error =
        typeof body?.detail === 'string' && body.detail
          ? body.detail
          : `Could not load MCP connectors (${res.status})`
      if (res.status === 429) reportPoolRefusal(state.mcp.error)
      throw new Error(state.mcp.error)
    }
    state.mcp.error = null
    // `built` is the visible-restart flag (spec §5.4 rule 23): the bar says the
    // tools are coming back, and the next live answer clears it.
    noteHubPayload(body)
    state.mcp.connectors = (body.connectors || [])
      .filter((connector) => connector.active)
      .map(({ id, label, status }) => ({ id, label, status }))
    const previous = state.mcp.enabled
    const enabled = {}
    for (const connector of state.mcp.connectors) {
      enabled[connector.id] =
        connector.id in previous ? previous[connector.id] : true
    }
    state.mcp.enabled = enabled
    state.mcp.loaded = true
  } catch {
    state.mcp.connectors = []
    state.mcp.enabled = {}
    state.mcp.loaded = false
  }
}

// A running batch is the one caller-owned reason a conversation-scoped hub
// change must be refused while `phase` is momentarily 'idle' (the window
// between two task turns). The flag itself belongs to useBatch — this hook is
// how it reaches the guards below without useChat importing useBatch: the
// dependency direction stays acyclic (useBatch -> useChat, never the reverse).
let busyGuard = null

export function registerChatBusyGuard(isBusy) {
  busyGuard = typeof isBusy === 'function' ? isBusy : null
}

// True when a reply is streaming, or a batch owns the conversation.
function chatBusy() {
  return state.phase !== 'idle' || !!busyGuard?.()
}

// The Live View's switch (§3.2), owned here rather than by whichever component
// draws the control: the flag is conversation state and the lock is this
// composable's own busy rule, so a mode can never be switched mid-reply from a
// second place that reads a different streaming flag.
function toggleLiveView() {
  if (chatBusy()) return
  state.liveView = !state.liveView
}

function setChatMcp(id, on) {
  if (state.mcp.locked || chatBusy()) return
  if (!(id in state.mcp.enabled)) return
  state.mcp.enabled[id] = !!on
}

// Conversation-scoped twin of loadChatMcp, for the LSP language servers
// (GET /api/lsp). Same rules: never touches a locked conversation, a failed
// load hides the panel and send() omits the lspEnabled filter (chat keeps
// working with every Settings-activated server), and previous on/off
// choices survive the refresh. Exported for useAppShell's saveLsp().
export async function loadChatLsp() {
  if (state.lsp.locked) return
  try {
    const res = await fetch(withWorkspace('/api/lsp'))
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      // Same rule as the MCP twin above: the server's sentence, and the bar's
      // when the pool's ceiling is what refused the workspace.
      state.lsp.error =
        typeof body?.detail === 'string' && body.detail
          ? body.detail
          : `Could not load language servers (${res.status})`
      if (res.status === 429) reportPoolRefusal(state.lsp.error)
      throw new Error(state.lsp.error)
    }
    state.lsp.error = null
    noteHubPayload(body)
    state.lsp.servers = (body.servers || [])
      .filter((server) => server.active)
      .map(({ id, label, status }) => ({ id, label, status }))
    const previous = state.lsp.enabled
    const enabled = {}
    for (const server of state.lsp.servers) {
      enabled[server.id] = server.id in previous ? previous[server.id] : true
    }
    state.lsp.enabled = enabled
    state.lsp.loaded = true
  } catch {
    state.lsp.servers = []
    state.lsp.enabled = {}
    state.lsp.loaded = false
  }
}

function setChatLsp(id, on) {
  if (state.lsp.locked || chatBusy()) return
  if (!(id in state.lsp.enabled)) return
  state.lsp.enabled[id] = !!on
}

// Restart a hub: tear every session down and rebuild it from a fresh scan of
// its declaration file, so a hand-edited
// ``.nojae/mcp-settings.json``/``.nojae/lsp-settings.json``
// (new entry, changed command, another ``workspaceRoot``) takes effect without
// restarting the web app. Awaited by the server, so on return the statuses in
// the refreshed snapshot are real. Errors never throw: they land in
// ``state.error`` (the chat error line) and, for a failing entry, in its own
// status — the panel still refreshes so the user sees which one broke.
// The rows a panel currently shows (`connectors` for MCP, `servers` for LSP),
// refreshed in place from a hub payload of the same shape the GET endpoints
// return.
function applyHubStatuses(kind, body) {
  const shown = kind === 'mcp' ? state.mcp.connectors : state.lsp.servers
  const fresh = kind === 'mcp' ? body?.connectors : body?.servers
  if (!Array.isArray(fresh)) return
  const byId = Object.fromEntries(fresh.map((row) => [row.id, row]))
  for (const row of shown) {
    const update = byId[row.id]
    if (update) row.status = update.status
  }
}

async function restartHub(kind) {
  const hub = state[kind]
  if (hub.restarting || chatBusy()) return
  hub.restarting = true
  try {
    const res = await fetch(withWorkspace(`/api/${kind}/restart`), { method: 'POST' })
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      const sentence = body?.detail || `Restart failed (HTTP ${res.status})`
      // The panel that asked shows the route's sentence, and the bar shows the
      // pool's ceiling when that is what refused the workspace.
      hub.error = sentence
      if (res.status === 429) reportPoolRefusal(sentence)
      state.error = sentence
    } else {
      state.error = null
      hub.error = null
      // A started conversation has a locked (frozen) toggle set, so the
      // loaders below would skip it and leave the status dots stale — and
      // watching those dots turn green is the point of the button. The
      // restart response already carries live statuses, so paint them.
      applyHubStatuses(kind, body)
    }
  } catch {
    state.error = 'Restart failed: the server did not answer'
  } finally {
    hub.restarting = false
    // Re-snapshot either way: a refused restart leaves the hub untouched but
    // still lets the panel refresh, and a successful one shows the new ids
    // and statuses. A locked conversation keeps its frozen toggles.
    if (kind === 'mcp') loadChatMcp()
    else loadChatLsp()
  }
}

function scheduleMarkdownRender() {
  if (renderScheduled) return
  renderScheduled = true
  requestAnimationFrame(() => {
    renderScheduled = false
    if (activeMessage)
      activeMessage.html = renderMarkdown(activeMessage.raw, { mermaid: true })
  })
}

// Client-side mirror of the backend's estimate_completion_tokens() heuristic
// (~4 chars/token): feeds the live tok/s badge and the abort fallbacks.
function estimateTokens(count) {
  return Math.ceil(Math.max(count, 0) / 4)
}

// Characters this reply generated and the client can actually see: answer text
// (`raw`, minus the tool-line sentinels it only carries for rendering) plus
// streamed thinking. Tool-call arguments never reach the client, so they are
// only ever counted through the server's exact `usage` figures.
function generatedChars(message) {
  const answer = (message.raw ?? '').split(TOOL_LINE_MARKER).join('').length
  return answer + (message.reasoningChars ?? 0)
}

// Generated text produced AFTER the last `usage` baseline: what the live
// badges and the abort fallback must still add on top of the exact figures.
function estimateGeneratedTail(message) {
  const generated = generatedChars(message) - (message.usageGeneratedChars || 0)
  return estimateTokens(generated)
}

// Every generated chunk (answer text or thinking delta) opens/extends the
// generation window, mirroring the backend (see stream_chat): thinking deltas
// are generated tokens too, so a reasoning phase is neither free to the
// numerator nor to the tok/s denominator — which is what keeps the speed badge
// ticking while the model thinks instead of freezing it on the previous reply.
function noteGenerated(assistant) {
  const now = Date.now()
  if (!assistant.windowStartAt) assistant.windowStartAt = now
  assistant.lastTokenAt = now
}

// Closes the open generation window so what follows it (tool execution, the
// re-prefill of the next round) stays out of the measured seconds. Called on
// `tool_call` / `usage` and when the reply ends; the next generated chunk
// opens a fresh window.
function closeGenerationWindow(assistant) {
  if (!assistant.windowStartAt) return
  assistant.generatedSeconds +=
    Math.max((assistant.lastTokenAt || 0) - assistant.windowStartAt, 0) / 1000
  assistant.windowStartAt = 0
}

// Seconds of generation measured client-side: every closed window plus the one
// still open, ended at the last chunk seen — so an idle gap inside the stream
// never inflates the live denominator.
function measuredSeconds(message) {
  const open = message.windowStartAt
    ? Math.max((message.lastTokenAt || 0) - message.windowStartAt, 0) / 1000
    : 0
  return (message.generatedSeconds || 0) + open
}

// Live tok/s of a streaming reply, as `{ value, estimated }` or null.
// Preferred basis: the server's cumulative exact figures from the last `usage`
// frame (completion tokens — thinking and tool arguments included — over the
// summed decode seconds), extended by whatever arrived since: those tokens are
// char-estimated (flagging the result), and their seconds come from the
// client-measured generation windows, so the tool loop's dead time stays out
// of the rate. With no `usage` in the payload at all the whole reply is
// measured client-side — answer text AND thinking over their own windows.
export function liveTokenRate(message) {
  if (!message) return null
  const seconds = measuredSeconds(message)
  if (message.usageTokens > 0 && message.usageDecode > 0) {
    const tail = estimateGeneratedTail(message)
    const tailSeconds = Math.max(seconds - (message.usageGeneratedSeconds || 0), 0)
    const secs = message.usageDecode + tailSeconds
    if (secs <= 0) return null
    return {
      value: (message.usageTokens + tail) / secs,
      estimated: tail > 0,
    }
  }
  const tokens = estimateTokens(generatedChars(message))
  if (seconds <= 0 || tokens <= 0) return null
  return { value: tokens / seconds, estimated: true }
}

// The text one message's copy chip puts on the clipboard: the reply as the
// model wrote it, minus the tool-line sentinel `raw` carries only for rendering
// (the same strip messagePayload() does, so a copy is what the model said, not
// what the pane drew). Unlike the payload there is no interruption note: that
// sentence exists to tell the *model* a fragment is unfinished, and a reader
// copying a reply wants the reply.
export function messageClipboardText(message) {
  if (!message) return ''
  return (message.raw ?? '').split(TOOL_LINE_MARKER).join('')
}

export function conversationMarkdown(messages) {
  return messages
    .map((m) => {
      const parts = []
      if (m.raw.trim()) parts.push(m.raw)
      for (const image of m.images ?? []) parts.push(`*[image: ${image.name}]*`)
      return parts.length ? `## ${m.role}\n\n${parts.join('\n\n')}` : null
    })
    .filter(Boolean)
    .join('\n\n')
}

// Whether one user turn would be refused by the server if a flush carried it:
// a sentence naming why, or null when it would be accepted.
//
// The server's rule is that a user turn carries text or an image, and a blank
// user turn is refused as a whole *request* — which, for a flush, would discard
// every other message that rode with it. So a flush validates every message it
// is about to carry, and this is the one verdict that answers for one message.
//
// It judges the text as the server will see it: the incoming door strips
// chat-template control-token runs from message text, so a message that looks
// non-empty in the strip can arrive empty. The stripper used here is the
// markdown module's — the seam that already says what such a run is — rather
// than a second copy of the rule that could drift from it.
export function flushGateReason(message) {
  if ((message?.images ?? []).length) return null
  if (neutralizeControlTokenRuns(message?.raw ?? '').trim()) return null
  return 'This message would arrive empty, and the server rejects a blank user turn as a whole request.'
}

// "a", "a and b", "a, b and c" — for the sentence that names the rows a refused
// flush is about, so it reads as prose whatever the strip holds.
function joinNames(names) {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// OpenAI content shape for one message: plain string when text-only (the
// backend and the LLM client keep the classic form), multimodal parts once an
// image is attached (image-only messages omit the text part entirely).
function messagePayload(message) {
  const images = message.images ?? []
  // The rendering-only tool-line sentinel never reaches the model.
  let raw = message.raw.split(TOOL_LINE_MARKER).join('')
  // A turn the user interrupted must not read to the model as a finished
  // answer: the note is added here (payload-build time) so the bubble the user
  // reads stays clean while the model sees where the fragment came from. The
  // same serializer writes saved sessions, so a loaded fragment keeps the note
  // — what does not survive a reload is the `paused` flag and its caption.
  if (message.paused) raw += '\n\n[interrupted by the user]'
  if (!images.length) return { role: message.role, content: raw }
  const parts = []
  if (raw.trim()) parts.push({ type: 'text', text: raw })
  for (const image of images) {
    parts.push({ type: 'image_url', image_url: { url: image.dataUrl } })
  }
  return { role: message.role, content: parts }
}

// ---------------------------------------------------------------------------
// Save / load a session as a JSON file (frontend only).
//
// The file is a thin envelope around the OpenAI user/assistant message list —
// exactly the shape POST /api/chat accepts — so continuing a loaded
// conversation is free: every send already re-posts state.messages mapped
// through messagePayload(). A user turn with attached images keeps them as
// standard OpenAI `image_url` parts, so the base64 data URL round-trips and the
// next send re-posts it to the model. Tool-loop turns and the per-turn badges
// are still never written (the browser only holds _preview-capped tool
// summaries, so writing them back would be fabrication; the system prompt is
// rebuilt server-side per send).
//
// Each image part carries one nojae-only extra key, `name` (the original
// file name, needed for the restored thumbnail's alt/title): the backend's
// `ChatContentPart` uses extra="ignore", so that key is dropped on the way to
// the model.
//
// The one extra field an assistant turn may carry is `reasoning` — the streamed
// thinking flows of that reply, one entry per reasoning block of the
// WorkBenchToolPanel timeline (a tool_call frame splits one flow from the next
// round's). It lives beside `content`, never inside it: thinking is not
// conversation text, and putting it in `content` would change what the model
// sees on the next send. It is panel render state only — send() builds its
// history through messagePayload(), which reads `raw`/`images` alone, so a
// restored flow can never reach the model.
// ---------------------------------------------------------------------------

export const SESSION_FILE_FORMAT = 'nojae-chat-session'
// v2 added the optional per-assistant-turn `reasoning` list, v3 started saving
// the attached images instead of stripping them, v4 records the conversation's
// agent mode in the envelope. Older files simply carry no image parts and no
// `agentMode`, so the loader needs no version branch either way.
export const SESSION_FILE_VERSION = 4
// Stands in for a loaded image part whose data URL is unusable (a hand-edited
// or truncated file), so an image-only turn keeps a non-empty content (an
// empty one would 422 the next send).
export const SESSION_IMAGE_PLACEHOLDER =
  '[image from the saved session could not be restored]'
// Must mirror the backend ChatImageUrl validation (routes.py).
const SESSION_IMAGE_DATA_URL =
  /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/

// Thinking flows of one assistant reply, in panel order: every
// `{ kind: 'reasoning' }` block of its timeline as one string, blank ones
// dropped. Kept as a list (not joined) so the panel timeline can be rebuilt
// with its original block boundaries — and so a v2 file stays readable by hand.
function reasoningFlows(message) {
  return (message.blocks ?? [])
    .filter((block) => block.kind === 'reasoning')
    .map((block) => block.text ?? '')
    .filter((text) => text.trim())
}

export function conversationJson(messages) {
  const items = []
  for (const message of messages) {
    // The very serializer a live send uses, so the file holds exactly what the
    // model was shown: text parts plus base64 `image_url` parts for an attached
    // image. Each image part then gets its file `name` (see the block header),
    // which the backend drops on its way to the model.
    const payload = messagePayload(message)
    const parts = typeof payload.content === 'string' ? [] : payload.content
    const hasText =
      typeof payload.content === 'string'
        ? Boolean(payload.content.trim())
        : parts.some((part) => part.type === 'text' && part.text.trim())
    const imageParts = parts.filter((part) => part.type === 'image_url')
    // A turn with neither text nor an image carries nothing worth restoring.
    if (!hasText && !imageParts.length) continue
    const images = message.images ?? []
    imageParts.forEach((part, i) => {
      if (images[i]) part.name = images[i].name || 'image'
    })
    if (message.role === 'assistant') {
      // Omitted entirely when the reply streamed no thinking, so files stay as
      // small as v1 ones for non-reasoning models.
      const flows = reasoningFlows(message)
      if (flows.length) payload.reasoning = flows
    }
    items.push(payload)
  }
  // No `stats` block on purpose: tok/s and ctx badges are client-only render
  // state, and the loader stays tolerant of a future version adding one back.
  //
  // `agentMode` is the one piece of *conversation* state the envelope carries
  // (am-07): the mode is not a message and never belongs in the list, but a
  // saved thread was written by one persona, and re-opening it in another would
  // change what its next turn means. Omitted when the mode list is not loaded
  // (or never was): a file without the key is a v3 file's shape, and the loader
  // then leaves the workspace's default alone.
  const agentMode = agentModePayloadId()
  return {
    format: SESSION_FILE_FORMAT,
    version: SESSION_FILE_VERSION,
    ...(agentMode ? { agentMode } : {}),
    messages: items,
  }
}

// One loaded image part -> the client image shape `{ dataUrl, name, size }`, or
// null when the part carries no usable data URL: the caller then inserts the
// placeholder text instead, so the turn stays postable. A well-formed but
// oversized image fails loudly instead — the backend would 422 the very same
// payload on the next send, a far more confusing place to hit the error.
function normalizeLoadedImage(part, index) {
  const url = part?.image_url?.url
  if (typeof url !== 'string') return null
  const match = SESSION_IMAGE_DATA_URL.exec(url)
  if (!match) return null
  let base64
  try {
    base64 = atob(match[2])
  } catch {
    return null
  }
  // atob yields exactly one character per decoded byte, so its length *is* the
  // decoded size — the same bound the backend checks with a real b64decode.
  const bytes = base64.length
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error(
      `Message ${index + 1} carries a ${humanFileSize(bytes)} image (max ${humanFileSize(MAX_IMAGE_BYTES)}).`,
    )
  }
  const name =
    typeof part.name === 'string' && part.name.trim() ? part.name.trim() : 'image'
  return { dataUrl: url, name, size: bytes }
}

// Content of one loaded turn, split into where the client keeps each part:
// `{ text, images }` — text parts joined into `raw`, image parts restored as
// `images` entries (an unusable one becomes the placeholder text). Image parts
// are only ever restored onto user turns: save() never writes them elsewhere,
// and messagePayload() would turn them into a multimodal `content` the backend
// rejects for assistant turns ("assistant messages must use plain text
// content"), so a hand-written file gets the placeholder instead.
function normalizeLoadedContent(content, role, index) {
  if (typeof content === 'string') return { text: content, images: [] }
  if (!Array.isArray(content)) return { text: '', images: [] }
  const texts = []
  const images = []
  for (const part of content) {
    if (part?.type === 'image_url') {
      const image = normalizeLoadedImage(part, index)
      if (!image || role === 'assistant') texts.push(SESSION_IMAGE_PLACEHOLDER)
      else images.push(image)
    } else if (typeof part?.text === 'string') {
      texts.push(part.text)
    }
  }
  return { text: texts.join('\n'), images }
}

// Optional per-assistant-turn thinking flows of a loaded turn: a list of
// strings (v2) — a lone string is accepted too, for hand-written files.
// Returns [] when the key is absent (every v1 file) or empty; throws when the
// key holds anything else, so a malformed file fails loudly instead of
// restoring half a timeline.
function normalizeLoadedReasoning(reasoning, index) {
  if (reasoning === undefined || reasoning === null) return []
  const flows = typeof reasoning === 'string' ? [reasoning] : reasoning
  if (!Array.isArray(flows)) {
    throw new Error(
      `Message ${index + 1} has a "reasoning" field that is neither a string nor a list of strings.`,
    )
  }
  const texts = []
  for (const flow of flows) {
    if (typeof flow !== 'string') {
      throw new Error(
        `Message ${index + 1} has a "reasoning" entry that is not a string.`,
      )
    }
    if (flow.trim()) texts.push(flow)
  }
  return texts
}

// Validates a session file's text and returns its turns as
// `{ messages: [{ role, content, images, reasoning }], agentMode }` (`images`
// being the restored `{ dataUrl, name, size }` entries of that turn, and
// `agentMode` the mode id the envelope carried — null for a v3 file, a bare
// array, or an envelope without that key). Throws with a precise
// message: silently dropping a system/tool turn would change the
// conversation's meaning, so an invalid file must fail loudly. Unknown extra
// keys are ignored, and a bare `[{role, content}, ...]` array is accepted for
// hand-written files.
export function parseSessionFile(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Not a valid JSON file.')
  }
  let items = null
  let agentMode = null
  if (Array.isArray(parsed)) {
    items = parsed
  } else if (parsed && typeof parsed === 'object') {
    if (parsed.format && parsed.format !== SESSION_FILE_FORMAT) {
      throw new Error(
        `Unknown session format "${parsed.format}" (expected "${SESSION_FILE_FORMAT}").`,
      )
    }
    if (!Array.isArray(parsed.messages)) {
      throw new Error('Not a chat session file: no "messages" list found.')
    }
    items = parsed.messages
    // A mode id of the wrong shape is tolerated rather than fatal: this key is
    // conversation state the parser has no opinion about, and the rule that
    // judges it ("is this a mode the *current* workspace offers?") belongs to
    // useAgentModes, where a v3 file with no key keeps the workspace default.
    if (typeof parsed.agentMode === 'string' && parsed.agentMode.trim()) {
      agentMode = parsed.agentMode.trim()
    }
  } else {
    throw new Error('Not a chat session file: expected a JSON object or array.')
  }

  const messages = []
  for (const [index, item] of items.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`Message ${index + 1} is not an object.`)
    }
    if (item.tool_calls) {
      throw new Error(
        `Message ${index + 1} carries tool_calls: saved sessions store conversation text only.`,
      )
    }
    if (item.role !== 'user' && item.role !== 'assistant') {
      throw new Error(
        `Message ${index + 1} has role ${JSON.stringify(item.role ?? '')}: only "user" and "assistant" turns can be loaded.`,
      )
    }
    const { text: content, images } = normalizeLoadedContent(item.content, item.role, index)
    // A turn is usable when it has text or a restorable image.
    if (!content.trim() && !images.length) continue
    // A user turn never carries thinking: the key is ignored there (unknown
    // extra keys are tolerated by design).
    const reasoning =
      item.role === 'assistant' ? normalizeLoadedReasoning(item.reasoning, index) : []
    messages.push({ role: item.role, content, images, reasoning })
  }
  if (!messages.length) throw new Error('Session file holds no usable message.')
  return { messages, agentMode }
}

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

function applyEvent(name, data, assistant) {
  switch (name) {
    case 'token': {
      if (state.phase !== 'answering') state.phase = 'answering'
      // Tool-loop continuation: the first token after a tool_result opens a
      // fresh line prefixed with the tool icon (sentinel replaced at render
      // time by lib/markdown.js, after a blank line) so each post-tool
      // message starts on its own line in WorkBenchView instead of running onto
      // the previous round's text. Flag consumed once per tool round (the
      // round's later tokens keep flowing on that icon line).
      if (assistant.pendingStreamQuote) {
        assistant.pendingStreamQuote = false
        assistant.raw += assistant.raw ? `\n\n${TOOL_LINE_MARKER}` : TOOL_LINE_MARKER
      }
      assistant.raw += data.text ?? ''
      noteGenerated(assistant)
      scheduleMarkdownRender()
      break
    }
    case 'done':
      assistant.tokens = data.tokens ?? 0
      assistant.took = data.took ?? 0
      assistant.ttft = data.ttft ?? 0
      // Cumulative decode seconds across all tool-loop rounds: the accurate
      // tok/s denominator once tools ran (took - ttft would include tool
      // execution and inter-round gaps). 0 on payloads from an old server.
      assistant.decode = data.decode ?? 0
      assistant.tokensEstimated = !!data.tokensEstimated
      // Context occupancy of the FINAL round: the figure to compare against
      // the server window: it never accumulates across rounds.
      if (typeof data.contextTokens === 'number' && data.contextTokens > 0) {
        assistant.contextTokens = data.contextTokens
        assistant.contextEstimated = !!data.contextEstimated
      }
      break
    case 'pause_ack':
      // A late ack (the reply had already terminated on `done`/`error`, or
      // Restart wiped the conversation while the pause was in flight): the turn
      // is closed, so this frame must not re-open it.
      if (!assistant.streaming) break
      // Terminal frame of a user-interrupted reply. Its exact figures arrived
      // as the `usage` frame just before it (the tool-loop sites reuse the
      // pre-tool `usage`), so all that is left is the measurement bookkeeping:
      // freeze the window, flag the fragment (caption + the payload note that
      // tells the model this turn is unfinished) and reopen the composer —
      // which is what hides Stop, shows Send and takes ⏸ out of the row.
      closeGenerationWindow(assistant)
      // The `usage` frame that precedes the ack holds the cumulative exact
      // figures for everything generated (the round is never reported by any
      // other frame), so they become the message's final numbers: finish()'s
      // char-based fallback would otherwise flag a server-reported count as
      // estimated, and the tok/s badge needs `decode` to stay exact.
      if (assistant.usageTokens > 0) {
        assistant.tokens = assistant.usageTokens
        assistant.tokensEstimated = false
        if (assistant.usageDecode > 0) assistant.decode = assistant.usageDecode
      }
      assistant.paused = true
      // Paused before anything was generated (still prefilling): an empty
      // assistant turn would sit in the thread and be re-posted, so it goes —
      // the same guard the non-OK response path uses.
      if (!assistant.raw) {
        state.messages.splice(state.messages.indexOf(assistant), 1)
      }
      state.pausePending = false
      state.phase = 'idle'
      break
    case 'tool_call':
      assistant.tools.push({
        id: data.id ?? `${data.tool}-${assistant.tools.length}`,
        tool: data.tool ?? 'tool',
        server: data.server ?? '',
        preview: data.argsPreview ?? '',
        // A call the model wrote as text instead of submitting it: the server
        // never ran it, and the panel paints it as a bad tool call rather than
        // as one of the connector's own (see `bad` in WorkBenchToolPanel).
        bad: data.bad === true,
        state: 'running',
      })
      // Same reactive object in the panel timeline, at its chronological
      // slot: reasoning text flows around the badges, tool_result state
      // flips still re-render the badge in place.
      // The round's generation is over: close the client-side window so the
      // tool execution (which can take tens of seconds) never enters the
      // live tok/s denominator.
      closeGenerationWindow(assistant)
      // Draw buffered thinking before the badge: a delta still in the buffer
      // arrived before this call, so it must keep its earlier slot in the
      // timeline. One flush per tool round, not per chunk.
      reasoningBuffer.flush()
      assistant.blocks.push({
        kind: 'tool',
        tool: assistant.tools[assistant.tools.length - 1],
      })
      // Server-authoritative tool-loop position for the iteration gauge.
      if (data.iteration) assistant.mcpIteration = data.iteration
      if (data.maxIterations) assistant.mcpMax = data.maxIterations
      break
    case 'usage':
      // Cumulative completion tokens (tool-call arguments included) and
      // decode seconds as soon as a tool round has finished generating:
      // keeps the side-panel badges live while the MCP tool loop is still
      // running. usageRawLen snapshots the answer text already streamed so
      // later estimates only count the characters generated after this
      // exact baseline (never double-counted, never missed).
      assistant.usageTokens = data.tokens ?? assistant.usageTokens
      assistant.usageDecode = data.decode ?? assistant.usageDecode
      // Close the window opened by this round's chunks before snapshotting, so
      // both baselines match the server's exact figures: what arrives after
      // this frame is the only thing later estimates add on top (answer text
      // AND thinking — never double-counted, never missed).
      closeGenerationWindow(assistant)
      assistant.usageGeneratedChars = generatedChars(assistant)
      assistant.usageGeneratedSeconds = measuredSeconds(assistant)
      // Occupancy of the round that just ended: the tool loop refreshes the
      // context badge between rounds, right when generation stops.
      if (typeof data.contextTokens === 'number' && data.contextTokens > 0) {
        assistant.contextTokens = data.contextTokens
        assistant.contextEstimated = !!data.contextEstimated
      }
      break
    case 'tool_result': {
      const tool = assistant.tools.find((item) => item.id === data.id)
      if (tool) {
        tool.state = data.ok ? 'ok' : 'error'
        tool.resultPreview = data.preview ?? ''
      }
      // Arm the tool-icon line prefix: the next round's first streamed token
      // starts on a fresh line in WorkBenchView (see the 'token' case).
      assistant.pendingStreamQuote = true
      break
    }
    case 'reasoning':
      // Never downgrade to reasoning once answer text started.
      if (state.phase === 'waiting' || state.phase === 'reasoning') {
        state.phase = 'reasoning'
      }
      break
    case 'reasoning_delta': {
      // Thinking text, streamed live. The text is buffered and lands in the
      // panel timeline once per animation frame (see lib/reasoning-buffer):
      // chunks arrive at a network-set rate, and each write into the reactive
      // block re-cuts the panel's rows and re-runs its autoscroll.
      const text = data.text ?? ''
      if (!text) break
      reasoningBuffer.append(assistant.blocks, text)
      // Thinking is generated text the client DOES see: it feeds the live
      // tok/s numerator and keeps the measurement window open, so a long
      // reasoning phase ticks the speed badge instead of freezing it.
      // This counter stays synchronous on purpose — a `usage` frame snapshots
      // an exact baseline out of it, so deferring it would count the buffered
      // tail twice.
      assistant.reasoningChars += text.length
      noteGenerated(assistant)
      break
    }
    case 'error':
      state.error = data.message || 'Chat request failed.'
      // A server-cut reply keeps its partial text in the conversation (unlike
      // an explicit Stop, which discards it) and that fragment is re-posted on
      // the next send — so the message itself carries the marker, not just the
      // transient error line.
      if (data.truncated) assistant.truncated = true
      break
    default:
      break
  }
}

function processFrame(frame, assistant) {
  let name = null
  let data = null
  for (const line of frame.split('\n')) {
    if (line.startsWith('event: ')) name = line.slice(7).trim()
    else if (line.startsWith('data: ')) {
      try {
        data = JSON.parse(line.slice(6))
      } catch {
        /* skip malformed frame data */
      }
    }
  }
  if (name && data) applyEvent(name, data, assistant)
}

function finish(assistant) {
  // Nothing may read a timeline that is still missing its last chunks: session
  // saving serializes these blocks, and it does not wait for a frame.
  reasoningBuffer.flush()
  if (activeMessage)
    activeMessage.html = renderMarkdown(activeMessage.raw, { mermaid: true })
  activeMessage = null
  // Stream ended without an exact usage report (stop/abort/error): keep the
  // conversation totals stable — exact cumulative tokens from the last
  // `usage` event (covers every completed tool round, reasoning and tool
  // arguments included) plus the ~4 chars/token heuristic on the answer
  // text AND thinking streamed since then, flagged as estimated.
  if (!assistant.tokens) {
    const carried = assistant.usageTokens || 0
    const tail = estimateGeneratedTail(assistant)
    if (carried + tail > 0) {
      assistant.tokens = carried + tail
      assistant.tokensEstimated = true
    }
  }
  // Freeze the measurement window: a finished reply's live rate is never
  // recomputed, and the badge falls back to the server's exact figures.
  closeGenerationWindow(assistant)
  // Stop/abort mid tool-execution: no tool_result will ever arrive, so never
  // leave a badge stuck on the pulsing "running" state in the tool panel.
  for (const tool of assistant.tools ?? []) {
    if (tool.state === 'running') tool.state = 'error'
  }
  assistant.streaming = false
  state.phase = 'idle'
  // Bank this turn's span: the app bar's clock reads the conversation's total
  // time, so an ended reply stops ticking without losing what it counted. Only
  // reset() zeroes it — the Restart button is what starts the counters over.
  if (state.session.startedAt > 0) {
    state.session.spentMs += Math.max(Date.now() - state.session.startedAt, 0)
    state.session.startedAt = 0
  }
  // The turn is over, so nothing is running on any agent: the app bar's running
  // line goes blank, rather than keeping the last model's name.
  state.session.agentMode = null
  controller = null
  // A pause whose `pause_ack` never arrives (the server died mid-round, or the
  // fallback abort ended the stream): the reply is over either way, so the ⏸
  // must stop blinking. The per-message `paused` flag is left alone — it only
  // drives a caption.
  state.pausePending = false
}

async function readStream(response, assistant) {
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let boundary = buffer.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary)
      buffer = buffer.slice(boundary + 2)
      if (frame.trim()) processFrame(frame, assistant)
      boundary = buffer.indexOf('\n\n')
    }
  }
}

// The last unanswered group of user turns: the maximal run of consecutive user
// messages ending at the last user message, found by adjacency alone — nothing is
// written into the thread to mark where a flush's run ended. Returns the index of
// the group's **first** message, or -1 when the thread holds no user turn.
//
// A flush opens one turn carrying several user messages in a row, so the group is
// what "my last message" means once a turn can carry more than one; adjacency also
// gives the gesture a property worth having — after a reply the model left
// unfinished, the run still holds every user turn that reply has not answered. A
// saved session that happens to end with consecutive user turns is one group by
// the same rule, which is defensible: they are all unanswered.
export function lastUserGroupStart(messages) {
  const list = Array.isArray(messages) ? messages : []
  let end = -1
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i].role === 'user') {
      end = i
      break
    }
  }
  if (end === -1) return -1
  let start = end
  while (start > 0 && list[start - 1].role === 'user') start -= 1
  return start
}

// One streamed turn, end to end: push the user bubbles and the reply's, open
// the SSE request and run finish() in its finally. Both entry points call it —
// `send()` for an interactive flush, `sendBatchTurn()` for one batch task —
// because the pause/truncation/measurement logic below has already been the
// source of bugs once and must never be forked.
//
// `userMessages` is what this turn opens on: one message for a batch task or a
// draft-only send, several for a flush (every staged message, then the draft),
// which is still **one** turn — one request, one agent, one clock span.
//
// `history` is the message list posted to the server and is the ONLY thing
// that varies between the two entry points: an interactive send sends the whole
// accumulated thread, a batch task sends its one instruction (B6 — the LLM
// context is reset per task, while the displayed transcript keeps accumulating).
// The client never sends a system message: `core/chat.py` stays the only place
// one is created.
// `agentMode` (the last entry): the mode **this turn** runs in. An interactive
// send passes the composer's selection; a batch task turn passes the runner's
// pin (D13) — a lot is one job executed under one set of rules, and the
// dropdown the user may be touching meanwhile is not part of it. `undefined`
// means "ask the server for its default" (the pre-feature shape), which is also
// what `useBatch` passes when its pin could not be resolved.
async function startTurn({
  userMessages,
  history,
  batchContext = null,
  agentMode = undefined,
  workspace = undefined,
}) {
  userStopped = false
  // Fresh turn: a previous turn's pause must not survive into it (its
  // fragment already carries its own `paused` flag, which is per message).
  userPaused = false
  state.error = null
  // One turn may open on several user messages — a flush carries the whole
  // strip in one request — so they all go in, in order, before the reply's
  // bubble: the thread holds exactly what the payload below carried.
  for (const userMessage of userMessages) state.messages.push(userMessage)
  state.messages.push({
    role: 'assistant',
    raw: '',
    html: '',
    streaming: true,
    tools: [], // MCP tool calls: { id, tool, server, preview, state, resultPreview }
    blocks: [], // panel timeline: { kind: 'reasoning', text } | { kind: 'tool', tool }
    // true between a tool_result and the next round's first answer token:
    // the token case then opens a tool-icon line in WorkBenchView.
    pendingStreamQuote: false,
    tokens: 0,
    took: 0,
    ttft: 0,
    tokensEstimated: false,
    // Client-side generation timing (see noteGenerated/measuredSeconds):
    // summed seconds of the closed windows, plus the open window's bounds.
    generatedSeconds: 0,
    windowStartAt: 0,
    lastTokenAt: 0,
    mcpIteration: 0, // server tool-loop position (gauge)
    mcpMax: 0, // MAX_TOOL_ITERATION reported by the server
    usageTokens: 0, // cumulative completion tokens per `usage` event
    usageDecode: 0, // cumulative decode seconds per `usage` event
    reasoningChars: 0, // chars of streamed thinking (live tok/s numerator)
    usageGeneratedChars: 0, // generated chars at the last `usage` baseline
    usageGeneratedSeconds: 0, // client-measured seconds at that same baseline
    decode: 0, // cumulative decode seconds from the `done` event
    contextTokens: 0, // LAST round's prompt + completion = context occupancy
    contextEstimated: false, // occupancy figure involves a char estimate
    // Set by a `truncated` error frame: the server ended the stream before
    // the reply was finished, so this turn is a fragment (see applyEvent).
    truncated: false,
    // Set by the `pause_ack` frame: the user interrupted this turn, so its
    // fragment is deliberately kept in the conversation and the payload says
    // so (display state, like `truncated` — never written to session JSON).
    paused: false,
  })
  // Keep the reactive proxy so token mutations re-render.
  const assistant = state.messages[state.messages.length - 1]
  activeMessage = assistant

  state.phase = 'waiting'
  state.session.startedAt = Date.now()
  controller = new AbortController()
  try {
    const payload = { messages: history }
    if (state.mcp.loaded) {
      // Conversation-scoped allowlist: only the toggles currently on may
      // contribute tools (intersected with the Settings-activated ids
      // server-side). Omitted when the snapshot failed to load.
      payload.mcpEnabled = Object.keys(state.mcp.enabled).filter(
        (id) => state.mcp.enabled[id],
      )
    }
    if (state.lsp.loaded) {
      // Same conversation-scoped filter for the LSP language servers.
      payload.lspEnabled = Object.keys(state.lsp.enabled).filter(
        (id) => state.lsp.enabled[id],
      )
    }
    // The agent mode for this turn (am-07). The composer refuses an interactive
    // send before it reaches here when the list is not loaded (task 12), and a
    // lot refuses at launch when its pin does not resolve, so a live turn always
    // names the agent it runs as. `agentMode === undefined` still means "read the
    // composer's selection" (the interactive shape); a resolved id (the batch
    // runner's pin) is sent as it stands.
    const modeId = agentMode === undefined ? agentModePayloadId() : agentMode
    if (modeId) {
      payload.agentMode = modeId
    }
    // Recorded for the app bar's running line: the agent **this** request
    // carries, not the composer's current selection. A lot's pin therefore
    // reads correctly, and a dropdown moved mid-reply cannot make the line name
    // an agent the stream is not answering as.
    state.session.agentMode = modeId ?? null
    if (batchContext) {
      // The lot's big picture (batch mode): the server appends it to its own
      // system message, so it rides on every task turn without ever becoming
      // a visible bubble — which is what survives the per-task context reset.
      payload.batchContext = batchContext
    }
    // The turn is **about this tab's folder**: the field rides on the URL like
    // every other workspace-scoped request (a query parameter, never a body
    // field — spec D9), so the server injects that folder's project
    // instructions and roots that folder's tools. The body, the SSE and the
    // cancellation-on-disconnect are untouched.
    //
    // `workspace` names an **explicit** folder rather than the tab's current one:
    // a batch task turn passes its run's pin, so a tab that moves during the lot
    // cannot re-root the task still being executed (spec §5.7 rule 33). Absent
    // (`undefined`) means the interactive shape — the tab's own folder.
    const chatUrl =
      workspace === undefined
        ? withWorkspace('/api/chat')
        : withWorkspaceRoot('/api/chat', workspace)
    const res = await fetch(chatUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    if (!res.ok || !res.body) {
      const body = await res.json().catch(() => null)
      state.error = describeError(body, `Chat request failed (${res.status}).`)
      if (!assistant.raw) {
        state.messages.splice(state.messages.indexOf(assistant), 1)
      }
      finish(assistant)
      return
    }
    // Accepted send: the conversation has started, so the MCP and LSP
    // toggles freeze until the restart button resets them (sticky by
    // design — edit-and-resend of the last message does not unlock them
    // again).
    state.mcp.locked = true
    state.lsp.locked = true
    await readStream(res, assistant)
  } catch (exc) {
    if (exc?.name !== 'AbortError') {
      state.error = `Could not reach the API: ${exc}`
    }
    // Connection drop: keep whatever partial answer arrived; an explicit
    // Stop is handled in the finally block below.
  } finally {
    // A paused reply keeps its fragment (Pause's whole point), except when
    // nothing was generated: the fallback abort has no `pause_ack` to drop
    // the empty turn, so it goes here.
    const discard = (userStopped && !userPaused) || (userPaused && !assistant.raw)
    if (discard) {
      // Stop discards the partial reply entirely (including the empty
      // placeholder and its MCP tool badges). The user message stays so it
      // can be edited and re-sent; the server-side stream is aborted.
      const index = state.messages.indexOf(assistant)
      if (index !== -1) state.messages.splice(index, 1)
    }
    finish(assistant)
  }
}

export function useChat() {
  // A working location that is replaced takes the strip with it, through the
  // same keyed registry the Editor's open buffers and the search results are
  // forgotten through — this module never imports an Editor file composable, so
  // the one-way dependency stays the registry's. Registered from the factory
  // body, the shape every other holder uses: a re-registration replaces this
  // key's entry instead of appending a second copy.
  registerReRootHandler('chatStrip', discardStagedForReRoot)

  // The sending key flushes: every staged message, then the draft if it has
  // content, become consecutive user turns of **one** turn. A draft-only send —
  // an empty strip — is the send this always was, down to the payload.
  //
  // Everything that can refuse runs first, and a refusal moves nothing: the
  // draft, the strip and the composer's images all survive it, because a
  // broken agent selection or a busy conversation must never eat a written
  // brief. Validation is all-or-nothing for the same reason one step further
  // along: the server rejects a request carrying a blank user turn, which would
  // discard every message that rode with it, so each one is judged here first
  // and a refused flush names its rows and sends nothing.
  async function send() {
    const trimmed = state.draft.raw.trim()
    const pendingImages = state.pendingImages.slice()
    const hasDraft = !!trimmed || pendingImages.length > 0
    // Nothing staged and nothing typed: nothing to flush, so nothing moves.
    if ((!hasDraft && !state.staged.length) || chatBusy()) return

    // An agent with no model — or a list the composer never read — cannot be
    // sent to. The same answer paints the warning icon and disables Send, so a
    // keyboard send, an Enter keypress and a hand-made call all stop here.
    // Nothing has been posted or pushed, so the draft survives and no stream is
    // left half-open. The server's 422 stays behind this for a stale tab.
    if (selectedAgentGateReason()) return

    // The flush's turns, in flush order: every staged row as it stands, then
    // the draft if it has content (an empty draft is not invented as a turn of
    // its own). The draft's HTML is filled in only once the flush is accepted:
    // rendering it now would cancel the preview's debounce, and a refusal must
    // leave the composer exactly as it found it.
    const userMessages = state.staged.map((row) => ({
      role: 'user',
      raw: row.raw,
      html: row.html,
      streaming: false,
      images: (row.images ?? []).map((image) => ({ ...image })),
    }))
    const draftMessage = hasDraft
      ? {
          role: 'user',
          raw: trimmed,
          html: '',
          streaming: false,
          // Every image the composer holds travels with this one message, in
          // attachment order.
          images: pendingImages.map((image) => ({ ...image })),
        }
      : null
    if (draftMessage) userMessages.push(draftMessage)

    // All-or-nothing: one message the server would refuse blocks the whole
    // flush, so the good rows are not spent on a request that will not land.
    // The strip names the offending rows off the same verdict; here it only has
    // to say why nothing was sent.
    const refused = []
    userMessages.forEach((message, position) => {
      const reason = flushGateReason(message)
      if (!reason) return
      // The row's number in flush order is what the strip shows and what a
      // reader can point at; the draft, when it is the offender, is not a row.
      refused.push(
        position < state.staged.length
          ? `message ${position + 1} (${reason})`
          : `the draft (${reason})`,
      )
    })
    if (refused.length) {
      // The chat error line is where a refused send is already announced: the
      // strip marks the offending rows off the same verdict, and this says why
      // the whole flush stopped. Nothing has moved.
      state.error = `Nothing was sent: ${joinNames(refused)}.`
      return
    }

    // Accepted: the strip and the composer empty as part of opening the turn,
    // never before the gates. The MCP/LSP toggles lock where they always have —
    // on the accepted request inside startTurn — so staging alone freezes
    // nothing. The draft's HTML reuses what setDraft's preview already rendered;
    // it re-renders only if the sending key beat the debounce.
    if (draftMessage) draftMessage.html = trimmed ? flushDraftHtml(trimmed) : ''
    state.staged = []
    clearDraft()
    clearImage()
    const history = [
      ...state.messages.map(messagePayload),
      ...userMessages.map(messagePayload),
    ]
    await startTurn({ userMessages, history })
  }

  // Batch mode's entry point: one task instruction, one turn. Returns whether
  // the turn was *started* (false on an empty instruction or a reply already
  // streaming) — the batch loop needs that flag instead of awaiting a phase
  // change that would never come. The payload deliberately carries this turn
  // alone: `state.messages` is never used to build a batch request, so task N+1
  // arrives with no trace of task N's transcript (B6).
  function sendBatchTurn(
    text,
    { batchContext = null, agentMode = undefined, workspace = undefined } = {},
  ) {
    const trimmed = typeof text === 'string' ? text.trim() : ''
    if (!trimmed || state.phase !== 'idle') return false
    startTurn({
      userMessages: [
        {
          role: 'user',
          raw: trimmed,
          html: renderMarkdown(trimmed),
          streaming: false,
          images: [],
        },
      ],
      history: [{ role: 'user', content: trimmed }],
      batchContext,
      agentMode,
      workspace,
    })
    return true
  }

  // Ends the turn in flight, and nothing else: what the user staged is not part
  // of that turn, so the strip is left exactly as it stands — same rows, same
  // order, same images. The abort reaches the stream, never the composer's input
  // state.
  function stop() {
    userStopped = true
    if (controller) controller.abort()
  }

  // Non-destructive twin of stop(): the server closes the upstream stream at
  // its next message boundary and terminates the reply with `pause_ack`, which
  // keeps the partial turn in the conversation. One-way — the ack puts the app
  // back to idle, and the user's next Send (their comment, riding on top of the
  // interrupted turn) is the only way back into inference.
  //
  // Like `stop()`, it ends a turn and leaves the strip alone: a staged message is
  // the user's uncommitted input, not part of what is in flight, so neither this
  // path, its local abort fallback below, nor the `finish()` that follows either
  // one touches the composer's staged rows.
  async function pause() {
    // Blinking = waiting for the ack: not clickable, and nothing to pause once
    // the reply is over.
    if (state.phase === 'idle' || state.pausePending) return
    state.pausePending = true
    try {
      // No body: there is exactly one pausable reply (the server keeps the
      // single in-flight handle). The workspace field names **this tab's**
      // reply — the slot becomes per workspace in task 04, and sending the
      // field now means that task has no client-side work to do.
      await fetch(withWorkspace('/api/chat/pause'), { method: 'POST' })
    } catch {
      // Endpoint unreachable: fall back to a local abort that keeps the
      // fragment. The abort ends readStream, so finish() runs and clears
      // pausePending.
      userPaused = true
      // Flag the fragment here, since no `pause_ack` will ever do it: it gets
      // the caption and, more importantly, the payload note that tells the
      // model this turn is unfinished.
      if (activeMessage) activeMessage.paused = true
      if (controller) controller.abort()
    }
  }

  // Puts the last unanswered group of user turns back into the strip: every turn
  // of the run, in order, each with all of its images, and drops the whole run
  // plus everything after it from the thread. **Not one message** — a flush opens
  // a turn with several user turns in a row, and a gesture that returned one
  // mockup out of four would be worse than doing nothing. The name is kept as it
  // was because it is still the gesture the pencil draws (the last thing the user
  // wrote); what it now returns is the run that thing was part of.
  //
  // Splicing from the group's first message to the end takes a partial reply the
  // model left after the last user turn with it — interrupted, truncated or still
  // being written — which matches today's gesture and is right: the group is what
  // is unanswered, so nothing after it was an answer to what is coming back.
  //
  // The group joins the strip **in front of** anything already staged, because the
  // strip is the flush order and these messages were written before whatever the
  // user is staging now. The draft is deliberately untouched: it is the user's
  // in-progress typing and nothing here asked for it. No request is made — this
  // only moves text between the thread and the strip.
  function editLast() {
    if (chatBusy()) return
    const start = lastUserGroupStart(state.messages)
    if (start === -1) return
    // Only the user turns of the run come back: a reply after the last of them is
    // what is going away, not something to re-send.
    const group = state.messages.slice(start).filter((message) => message.role === 'user')
    state.staged = [
      ...group.map((message) => ({
        id: stagedId(),
        role: 'user',
        raw: message.raw,
        html: message.html ?? (message.raw.trim() ? renderMarkdown(message.raw) : ''),
        streaming: false,
        // Every image travels with the message it was attached to, in order.
        images: (message.images ?? []).map((image) => ({ ...image })),
      })),
      ...state.staged,
    ]
    // Drop the group and everything after it (a partial reply, its tool badges)
    // so a re-flush opens onto a clean conversation tail.
    state.messages.splice(start)
    state.error = null
  }

  // Replaces the conversation with the turns of a parsed session file (see
  // parseSessionFile). Returns `{ restored }`, or null when refused because a
  // reply is streaming — the "must not be running" rule lives here, not only
  // on the button, exactly as in editLast()/reset().
  function loadSession(parsed) {
    if (chatBusy()) return null
    const items = Array.isArray(parsed?.messages) ? parsed.messages : []
    if (!items.length) return { restored: 0 }

    // Rebuild the rich shape the view and the side panel render: the common
    // fields plus the assistant-only field set send() initialises, so the
    // badges (which read `tokens` / `contextTokens`) never see `undefined`.
    state.messages = items.map((item) => {
      const raw = item.content ?? ''
      const message = {
        role: item.role,
        raw,
        html: renderMarkdown(raw, { mermaid: true }),
        streaming: false,
        // Images restored from the file (already `{ dataUrl, name, size }`), so
        // every thumbnail renders again and the next send re-posts them all to
        // the model — and editLast() carries every one of them back to the strip
        // with the message it belongs to.
        images: item.images ?? [],
      }
      if (item.role !== 'assistant') return message
      // The loaded thinking flows become the reply's panel timeline: one
      // `{ kind: 'reasoning' }` block per flow, in file order (tool badges are
      // never saved, so nothing else belongs in `blocks`).
      const blocks = (item.reasoning ?? []).map((text) => ({ kind: 'reasoning', text }))
      return Object.assign(message, {
        tools: [],
        blocks,
        pendingStreamQuote: false,
        tokens: 0,
        took: 0,
        ttft: 0,
        decode: 0,
        contextTokens: 0,
        tokensEstimated: false,
        contextEstimated: false,
        // Client-side measurement + tool-loop bookkeeping (see noteGenerated):
        // zeroed, so a restored reply reports no rate and no gauge position.
        generatedSeconds: 0,
        windowStartAt: 0,
        lastTokenAt: 0,
        mcpIteration: 0,
        mcpMax: 0,
        usageTokens: 0,
        usageDecode: 0,
        reasoningChars: 0,
        usageGeneratedChars: 0,
        usageGeneratedSeconds: 0,
      })
    })

    // A loaded conversation counts as started: the MCP/LSP toggles freeze as
    // they would have after the first accepted send, and the loaders below
    // must not re-snapshot over them (they ignore a locked conversation).
    // No reset() here — it would wipe the messages just loaded.
    if (state.messages.length) {
      state.mcp.locked = true
      state.lsp.locked = true
    } else {
      loadChatMcp()
      loadChatLsp()
    }
    // The agent the file was saved with (v4 envelope) is conversation state too,
    // and it **wins over the tab's remembered choice**: the file describes
    // the conversation, `sessionStorage` describes the tab, and the more
    // specific one answers a resume. useAgentModes judges it against the loaded
    // list — an unknown id falls back to the first agent with one notice line,
    // never a silent swap of persona and never a refused load.
    applySessionAgentMode(parsed.agentMode)
    state.error = null
    state.pendingImages = []
    // The strip belonged to the conversation this file just replaced: those rows
    // were written on top of a thread that no longer exists, and loading is a
    // replacement, not an addition. A staged message never travels in either
    // direction — `conversationJson()` renders the thread alone.
    state.staged = []
    // A loaded conversation replaces the one the meters measured, so they start
    // from nothing: the file carries no timings (see the zeroed figures above),
    // and keeping the previous conversation's total would credit these turns
    // with time they never spent.
    state.session.startedAt = 0
    state.session.spentMs = 0
    return { restored: state.messages.length }
  }

  // `refetchHubs: false` is batch mode's between-task wipe: the conversation
  // is wiped but the conversation-scoped MCP/LSP allowlist must NOT be re
  // seeded, or a connector that appeared mid-lot would silently join the tool
  // set of the remaining tasks. The toggles stay locked for the whole lot.
  function reset({ refetchHubs = true } = {}) {
    if (controller) controller.abort()
    state.messages = []
    state.error = null
    state.pendingImages = []
    // Restart is the one gesture that wipes everything, so the strip goes with
    // the conversation: a queue that outlived it would be the only survivor of a
    // thread nobody can see any more. Batch mode's between-task wipe reaches this
    // same function and means the same thing. Silent on purpose — Restart already
    // means wipe, so a discarded row needs no message of its own.
    state.staged = []
    // The conversation the meters described is gone, so they start over: this is
    // the **only** place the clock and the counters go back to blank (Restart in
    // the composer). Batch mode's between-task wipe reaches the same function,
    // and that is intended: a task's LLM context is its own, so the next task
    // must not open on its predecessor's occupancy or on its speed.
    state.session.startedAt = 0
    state.session.spentMs = 0
    // A pause still in flight has no conversation to ack any more: clear the
    // blinking flag (and the per-reply fallback flag) so no ⏸ survives on a
    // conversation that no longer streams. The ack itself is a no-op then —
    // `assistant.streaming` is already false (the guard in applyEvent).
    state.pausePending = false
    userPaused = false
    // The session-mode notice explained a conversation that no longer exists.
    // It goes before the `refetchHubs` early return, because batch mode's
    // between-task wipe resets without refetching and must clear it too.
    clearAgentModeNotice()
    if (!refetchHubs) return
    // New conversation: MCP and LSP toggles unlock against freshly fetched
    // snapshots, keeping the previous on/off choices (the loaders seed the
    // new lists from them). The agent list is refreshed by the same call: a
    // store edited while the lot ran (or while this tab sat idle) takes effect
    // on the next conversation.
    state.mcp.locked = false
    state.lsp.locked = false
    loadChatHubs()
  }

  return {
    state,
    send,
    // The same busy rule the guards in this composable use: a control that has
    // to lock while a reply streams reads this rather than watching `phase`, so
    // it cannot disagree with a send being refused.
    chatBusy,
    // The one switch of the Live View, next to the rule that locks it — a
    // component that draws the control calls this and never moves the flag.
    toggleLiveView,
    sendBatchTurn,
    stop,
    pause,
    reset,
    setDraft,
    appendDraft,
    registerDraftInput,
    // Back to the strip, all of the last unanswered group — see its comment: this
    // is not a one-message undo, whatever the name still says.
    editLast,
    loadSession,
    attachImage,
    removeImage,
    clearImage,
    // The strip's verbs: stage the draft (or the Stage button / chord), drop one
    // row, pull one back into the composer. All three refuse while the composer
    // is shut, and the strip is read-only then rather than hidden. What a row
    // says about itself comes from the `flushGateReason` export above, so the
    // strip quotes the one verdict instead of deriving a second one.
    stage,
    removeStaged,
    pullBackStaged,
    loadChatMcp,
    setChatMcp,
    restartMcp: () => restartHub('mcp'),
    loadChatLsp,
    setChatLsp,
    restartLsp: () => restartHub('lsp'),
    // The three together (modes + both hubs), for the entry points that want a
    // fresh conversation snapshot rather than one list.
    loadChatHubs,
  }
}
