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
  phase: 'idle', // idle | waiting | reasoning | answering | reconnecting
  error: null,
  // Composer draft mirrored as rendered markdown, so WorkBenchView previews the
  // exact HTML send() attaches to the user message.
  draft: { raw: '', html: '', renderedRaw: '' },
  // Images picked for the next message, in attachment order: `{ dataUrl, name,
  // size }`. Every read answers about the whole list, never about a single one.
  pendingImages: [],
  // The strip: user messages the composer has accepted but no turn has carried
  // yet, in flush order. Each row is a user message plus an `id`, because rows
  // are removed and pulled back by identity — a position stops being a handle as
  // soon as a row can be dropped. Composer input state, never part of the
  // conversation: nothing that reads `messages` sees a row.
  staged: [],
  // Chat session clock (consumed by useSessionStats, rendered by the app bar's
  // SessionClock): ms timestamp of when the running reply started, plus the
  // milliseconds every reply has already spent (`spentMs`). Both are zeroed by
  // reset() alone — the Restart button. A turn's span is banked **less the
  // seconds it spent waiting on a refused endpoint**: a wait is neither inference
  // nor thinking, so a provider outage must not read as session time. The turn's
  // own span keeps the wait, which is why it is shown beside the clock.
  // `agentMode` is the agent **this** turn was sent as, recorded when the
  // request is opened (null = no turn running). The app bar names the running
  // model off it, so a mid-stream dropdown change cannot make the line name an
  // agent the stream is not answering as.
  session: { startedAt: 0, spentMs: 0, agentMode: null },
  // The reasoning panel's Live View (toggled in WorkBenchFocusGutter.vue): on
  // paints only what the panel's box can hold, off keeps every line of the
  // thinking. Panel render state only — the flows stay in `block.text`, so a save
  // or a copy never loses bytes.
  liveView: true,
  // A pause request is armed but its `pause_ack` has not landed yet: the ⏸
  // button blinks and is disabled, and the composer stays shut (the ack is
  // what reopens it). Cleared by the ack, by finish(), and by reset().
  pausePending: false,
  // The endpoint refused the current round and the worker is waiting before it
  // re-sends: the four fields of the `reconnecting` frame that announced it —
  // `{ attempt, budget, waitSeconds, message }` — or **null** when no wait is in
  // progress. Status line content and nothing else: never a message, never a
  // marker in the thread.
  //
  // One field, emptied by one function: every arrival that means the endpoint
  // answered again and every terminal path calls it, plus reset() — Restart does
  // not wait for the abort it starts to settle. So the line cannot outlive its
  // wait, and there is no second copy of that rule to forget.
  endpointWait: null,
  // Conversation-scoped MCP toggles (independent from the SettingsDialog): the
  // Settings-activated connectors snapshotted on tab entry, ON by default, frozen
  // once the first message is accepted by the server.
  mcp: {
    connectors: [], // { id, label, status } — only connectors active in Settings
    enabled: {}, // id -> boolean (this conversation only, never persisted)
    loaded: false, // GET /api/mcp snapshot succeeded (panel + filter usable)
    locked: false, // sticky: first accepted send locks the toggles
    restarting: false, // POST /api/mcp/restart in flight (button stays busy)
    error: null, // the route's sentence when it refused this workspace
  },
  // Conversation-scoped LSP toggles — the same slice as `mcp`, fed by GET
  // /api/lsp. The first accepted send freezes both panels until restart resets
  // them.
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
// Pause's local fallback also aborts the fetch, but must NOT discard: the partial
// turn stays in the conversation. Distinguishes that abort from Stop's.
let userPaused = false

// Must mirror the backend ChatImageUrl validation (routes.py).
export const IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024

// How many images one flush may carry, over every staged message's images plus
// the composer's own. Nothing on the path bounds the aggregate base64 body, so
// this is the bound that keeps one request small; checked as an image is added,
// never at flush time, so the refusal reaches the user where they are attaching.
export const MAX_FLUSH_IMAGES = 6

// The images a flush would carry: every staged message's, in strip order, plus
// the composer's own. The budget above bounds exactly this count.
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

// Composer textarea, registered by WorkBenchInput so draft insertions can focus
// it after appending.
let draftInputEl = null

function registerDraftInput(el) {
  draftInputEl = el ?? null
}

// Appends a memory bullet's text to the draft, joined with a blank line: through
// setDraft, so the preview updates on the usual debounce.
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

// Validates a picked file and appends it to state.pendingImages. Returns false
// with state.error set when rejected.
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
  // Checked at attaching, not at flush time: a refusal then would arrive after
  // the user had written everything.
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

// Drops one attached image by its position; one the list no longer holds (a
// double click) touches nothing.
function removeImage(index) {
  if (index < 0 || index >= state.pendingImages.length) return
  state.pendingImages.splice(index, 1)
}

function clearImage() {
  state.pendingImages = []
}

// Strip rows are addressed by id, never by position: removing or pulling one
// back moves the positions. Only increases, so two live rows cannot share a name.
let stagedSeq = 0

function stagedId() {
  stagedSeq += 1
  return `staged-${stagedSeq}`
}

// Moves the composer's draft and images to the end of the strip, in the shape a
// sent turn has so both are read the same way — but it is input state: never
// pushed to the conversation, and it opens no stream (a stage is not a turn). The
// order rows are appended in is the order a flush sends them.
//
// Refused while a reply streams or a batch owns the conversation, silently: the
// affordance calling this is disabled then, so a stray keypress does nothing.
function stage() {
  if (chatBusy()) return false
  const trimmed = state.draft.raw.trim()
  const images = state.pendingImages.map((image) => ({ ...image }))
  // No empty row and no error line for nothing to stage.
  if (!trimmed && !images.length) return false
  // The same path a send takes, so Enter before the preview's debounce still
  // stages rendered HTML.
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

// Drops one staged row by its id; an id the strip no longer holds touches
// nothing. Refused while busy, as staging is: the strip is read-only then.
function removeStaged(id) {
  if (chatBusy()) return false
  const index = state.staged.findIndex((row) => row.id === id)
  if (index === -1) return false
  state.staged.splice(index, 1)
  return true
}

// Moves one staged row back into the composer for editing: its text becomes the
// draft, its images join the pending list. The image budget is deliberately not
// re-checked — the same images changing hands. Refused while busy.
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

// The tab's folder moved: the strip goes with it, as the Editor's open buffers
// do — but the loss is *reported* rather than silently dropped, on the chat error
// line above the composer. That line sits where the strip was and is visible
// whenever the WorkBench tab is, while the Editor's notices render on the other
// tab. Nothing to lose moves silently.
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
// both hub allowlists. Every entry point into a conversation (boot, the
// WorkBench tab's watch, a restart) calls this one function rather than picking a
// subset, which is what keeps one of the three from staying stale.
export async function loadChatHubs() {
  loadAgentModes()
  await Promise.all([loadChatMcp(), loadChatLsp()])
}

// Snapshot the Settings-activated connectors for a new conversation. Never
// touches a locked (already-started) one; on failure the panel stays hidden and
// send() omits the mcpEnabled filter, so chat keeps working with every activated
// connector rather than silently disabling ones the user never got to toggle.
// Previous on/off choices survive the refresh, new connectors default to ON.
// Exported for useAppShell's saveMcp() (no cycle: useChat imports useAppShell
// nowhere).
export async function loadChatMcp() {
  if (state.mcp.locked) return
  try {
    const res = await fetch(withWorkspace('/api/mcp'))
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      // The route's own sentence, verbatim. A 429 is the pool refusing this
      // workspace, so the app bar says the same thing; a 422 is the folder
      // itself, which the bar already named.
      state.mcp.error =
        typeof body?.detail === 'string' && body.detail
          ? body.detail
          : `Could not load MCP connectors (${res.status})`
      if (res.status === 429) reportPoolRefusal(state.mcp.error)
      throw new Error(state.mcp.error)
    }
    state.mcp.error = null
    // `built` is the visible-restart flag: the bar says the tools are coming
    // back, and the next live answer clears it.
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

// A running batch is the one caller-owned reason a hub change must be refused
// while `phase` is momentarily 'idle' (between two task turns). The flag belongs
// to useBatch — injected here so the dependency stays acyclic (useBatch ->
// useChat, never the reverse).
let busyGuard = null

export function registerChatBusyGuard(isBusy) {
  busyGuard = typeof isBusy === 'function' ? isBusy : null
}

// True when a reply is streaming, or a batch owns the conversation.
function chatBusy() {
  return state.phase !== 'idle' || !!busyGuard?.()
}

// The Live View's switch, owned here rather than by whichever component draws the
// control: the flag is conversation state and the lock is this composable's own
// busy rule, so it can never be switched mid-reply from a second place.
function toggleLiveView() {
  if (chatBusy()) return
  state.liveView = !state.liveView
}

function setChatMcp(id, on) {
  if (state.mcp.locked || chatBusy()) return
  if (!(id in state.mcp.enabled)) return
  state.mcp.enabled[id] = !!on
}

// Conversation-scoped twin of loadChatMcp, for the LSP servers (GET /api/lsp):
// same rules, with send() omitting the lspEnabled filter on a failed load.
// Exported for useAppShell's saveLsp().
export async function loadChatLsp() {
  if (state.lsp.locked) return
  try {
    const res = await fetch(withWorkspace('/api/lsp'))
    const body = await res.json().catch(() => null)
    if (!res.ok) {
      // As in the MCP twin: the server's sentence, and the bar's when the pool's
      // ceiling refused the workspace.
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

// Restart a hub: tear every session down and rebuild it from a fresh scan of its
// declaration file, so a hand-edited ``.nojae/mcp-settings.json`` or
// ``.nojae/lsp-settings.json`` takes effect without restarting the web app.
// Awaited by the server, so on return the refreshed statuses are real. Errors
// never throw: they land in ``state.error`` and, for a failing entry, in its own
// status — the panel still refreshes, so the user sees which one broke.
//
// The rows a panel currently shows, refreshed in place from a hub payload.
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
      // The panel that asked shows the route's sentence; the bar shows the pool's
      // ceiling when that refused the workspace.
      hub.error = sentence
      if (res.status === 429) reportPoolRefusal(sentence)
      state.error = sentence
    } else {
      state.error = null
      hub.error = null
      // A locked conversation has a frozen toggle set, so the loaders below skip
      // it and would leave the status dots stale — and watching those turn green
      // is the point of the button. The response already carries live statuses.
      applyHubStatuses(kind, body)
    }
  } catch {
    state.error = 'Restart failed: the server did not answer'
  } finally {
    hub.restarting = false
    // Re-snapshot either way: a refused restart leaves the hub untouched but
    // still refreshes the panel. A locked conversation keeps its frozen toggles.
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

// Client-side mirror of the backend's estimate heuristic (~4 chars/token): feeds
// the live tok/s badge and the abort fallbacks.
function estimateTokens(count) {
  return Math.ceil(Math.max(count, 0) / 4)
}

// Characters this reply generated that the client can see: answer text (`raw`,
// minus its rendering-only tool-line sentinels) plus streamed thinking.
// Tool-call arguments never reach the client, so only the server's exact `usage`
// figures count them.
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
// generation window: thinking deltas are generated tokens too, so a reasoning
// phase counts to both the numerator and the tok/s denominator, keeping the
// speed badge ticking instead of freezing it on the previous reply.
function noteGenerated(assistant) {
  const now = Date.now()
  if (!assistant.windowStartAt) assistant.windowStartAt = now
  assistant.lastTokenAt = now
}

// Closes the open generation window so what follows it (tool execution, the next
// round's prefill) stays out of the measured seconds. The next generated chunk
// opens a fresh one.
function closeGenerationWindow(assistant) {
  if (!assistant.windowStartAt) return
  assistant.generatedSeconds +=
    Math.max((assistant.lastTokenAt || 0) - assistant.windowStartAt, 0) / 1000
  assistant.windowStartAt = 0
}

// Seconds of generation measured client-side: every closed window plus the open
// one, ended at the last chunk seen, so an idle gap never inflates the rate.
function measuredSeconds(message) {
  const open = message.windowStartAt
    ? Math.max((message.lastTokenAt || 0) - message.windowStartAt, 0) / 1000
    : 0
  return (message.generatedSeconds || 0) + open
}

// Live tok/s of a streaming reply, as `{ value, estimated }` or null. Preferred
// basis: the server's exact cumulative figures from the last `usage` frame
// (completion tokens over summed decode seconds), extended by what arrived since
// — those tokens char-estimated (flagging the result) over the client-measured
// windows, so the tool loop's dead time stays out of the rate. With no `usage`
// frame the whole reply is measured client-side.
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

// The text one message's copy chip puts on the clipboard: the same strip
// messagePayload() does, so a copy is what the model said, not what the pane
// drew. No interruption note, unlike the payload: that sentence exists to tell
// the *model* a fragment is unfinished, and a reader wants the reply.
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

// Whether one user turn would be refused by the server if a flush carried it: a
// sentence naming why, or null when it would be accepted.
//
// A blank user turn is refused as a whole *request*, which for a flush would
// discard every message riding with it, so each one is judged before the send.
//
// It judges the text as the server will see it: the incoming door strips
// chat-template control-token runs, so a message that looks non-empty in the
// strip can arrive empty. It asks the markdown module's stripper rather than
// keeping a second copy of the rule that could drift from it.
export function flushGateReason(message) {
  if ((message?.images ?? []).length) return null
  if (neutralizeControlTokenRuns(message?.raw ?? '').trim()) return null
  return 'This message would arrive empty, and the server rejects a blank user turn as a whole request.'
}

// "a", "a and b", "a, b and c" — so the sentence naming a refused flush's rows
// reads as prose whatever the strip holds.
function joinNames(names) {
  if (names.length <= 1) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

// OpenAI content shape for one message: a plain string when text-only,
// multimodal parts once an image is attached (image-only ones omit the text part).
function messagePayload(message) {
  const images = message.images ?? []
  // The rendering-only tool-line sentinel never reaches the model.
  let raw = message.raw.split(TOOL_LINE_MARKER).join('')
  // A turn the user interrupted must not read to the model as a finished answer:
  // the note is added here, at payload-build time, so the bubble the user reads
  // stays clean. The same serializer writes saved sessions, so a loaded fragment
  // keeps the note — but not the `paused` flag and its caption.
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
// the shape the chat route accepts — so continuing a loaded conversation is free:
// every send already re-posts state.messages through messagePayload(). Images
// keep their standard `image_url` parts, so the base64 data URL round-trips.
// Tool-loop turns and the per-turn badges are never written: the browser holds
// only preview-capped tool summaries, so writing them back would be fabrication,
// and the system prompt is rebuilt server-side per send.
//
// Each image part carries one nojae-only extra key, `name`, needed for the
// restored thumbnail: the backend's content-part model ignores unknown keys, so
// it is dropped on the way to the model.
//
// The one extra field an assistant turn may carry is `reasoning` — that reply's
// streamed thinking flows, one entry per reasoning block of the panel timeline (a
// tool_call frame splits one flow from the next round's). It lives beside
// `content`, never inside it: thinking is not conversation text, and putting it
// in `content` would change what the model sees on the next send. Panel render
// state only — messagePayload() reads `raw`/`images` alone, so a restored flow
// can never reach the model.
// ---------------------------------------------------------------------------

export const SESSION_FILE_FORMAT = 'nojae-chat-session'
// v2 added the optional per-assistant-turn `reasoning` list, v3 started saving
// the attached images instead of stripping them, v4 records the conversation's
// agent mode in the envelope. Older files simply carry no image parts and no
// `agentMode`, so the loader needs no version branch either way.
export const SESSION_FILE_VERSION = 4
// Stands in for a loaded image part whose data URL is unusable (a hand-edited or
// truncated file), so an image-only turn keeps a non-empty content — an empty one
// would fail the next send.
export const SESSION_IMAGE_PLACEHOLDER =
  '[image from the saved session could not be restored]'
// Must mirror the backend ChatImageUrl validation (routes.py).
const SESSION_IMAGE_DATA_URL =
  /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/

// Thinking flows of one assistant reply, in panel order: every reasoning block of
// its timeline as one string, blanks dropped. A list rather than one joined
// string, so the panel timeline keeps its original block boundaries.
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
    // model was shown. Each image part then gets its file `name` (see the block
    // header), which the backend drops on its way to the model.
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
      // Omitted entirely when the reply streamed no thinking, so files stay small.
      const flows = reasoningFlows(message)
      if (flows.length) payload.reasoning = flows
    }
    items.push(payload)
  }
  // No `stats` block on purpose: tok/s and ctx badges are client-only render state.
  //
  // `agentMode` is the one piece of *conversation* state the envelope carries: the
  // mode is not a message and never belongs in the list, but a saved thread was
  // written by one persona, and re-opening it in another would change what its
  // next turn means. Omitted when the mode list is not loaded, and the loader then
  // leaves the workspace's default alone.
  const agentMode = agentModePayloadId()
  return {
    format: SESSION_FILE_FORMAT,
    version: SESSION_FILE_VERSION,
    ...(agentMode ? { agentMode } : {}),
    messages: items,
  }
}

// One loaded image part -> the client image shape `{ dataUrl, name, size }`, or
// null when the data URL is unusable: the caller inserts the placeholder text
// instead, so the turn stays postable. A well-formed but oversized image fails
// loudly instead — the backend would reject the very same payload on the next
// send, a far more confusing place to hit the error.
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

// Content of one loaded turn, split as the client keeps it: `{ text, images }`,
// with text parts joined into `raw`. Image parts are only ever restored onto user
// turns — the backend rejects multimodal assistant content — so a hand-written
// file gets the placeholder there.
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

// Optional per-assistant-turn thinking flows of a loaded turn: a list of strings,
// a lone string accepted too for hand-written files. Returns [] when the key is
// absent or empty and throws when it holds anything else, so a malformed file
// fails loudly instead of restoring half a timeline.
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
// `{ messages: [{ role, content, images, reasoning }], agentMode }`, `agentMode`
// being null for a bare array or an envelope without that key. Throws with a
// precise message: silently dropping a system/tool turn would change the
// conversation's meaning, so an invalid file must fail loudly. Unknown extra keys
// are ignored, and a bare `[{role, content}, ...]` array is accepted for
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
    // A mode id of the wrong shape is tolerated rather than fatal: the rule that
    // judges it ("is this a mode the *current* workspace offers?") belongs to
    // useAgentModes, where a file with no key keeps the workspace default.
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
    // A user turn never carries thinking: the key is ignored there.
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

// Ends the wait's status line. One function is the whole clearing rule: every
// arrival that proves the endpoint answered again and every terminal path calls
// it, so a line can never outlive the wait it described.
function clearEndpointWait() {
  state.endpointWait = null
}

// The one line a wait says about itself:
//
//   Reconnecting 2/3 — the model endpoint answered HTTP 502 · retrying in 10s
//
// A plain function rather than template logic, so a test can hold the composable
// to its shape. `Reconnecting` is the **label** and the only place that word
// survives; the sentence between the separators is the endpoint's own, passed
// through verbatim. A missing figure reads 0 rather than hiding the segment,
// because the label is what tells the user the app is not stuck.
export function endpointWaitLine(wait) {
  if (!wait) return ''
  const attempt = Number.isFinite(wait.attempt) ? wait.attempt : 0
  const budget = Number.isFinite(wait.budget) ? wait.budget : 0
  const seconds = Number.isFinite(wait.waitSeconds) ? wait.waitSeconds : 0
  const sentence = typeof wait.message === 'string' ? wait.message : ''
  return `Reconnecting ${attempt}/${budget} — ${sentence} · retrying in ${seconds}s`
}

function applyEvent(name, data, assistant) {
  switch (name) {
    case 'token': {
      // A token is the replayed round answering: the wait is over, so its line
      // goes — it was a status line, never content.
      clearEndpointWait()
      if (state.phase !== 'answering') state.phase = 'answering'
      // Tool-loop continuation: the first token after a tool_result opens a fresh
      // line prefixed with the tool icon (sentinel replaced at render time by
      // lib/markdown.js) so each post-tool message starts on its own line instead
      // of running onto the previous round's text. Consumed once per tool round.
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
      // Terminal frame: whatever it carries, no wait is in progress any more, so
      // the wait's line goes with it.
      clearEndpointWait()
      assistant.tokens = data.tokens ?? 0
      assistant.took = data.took ?? 0
      assistant.ttft = data.ttft ?? 0
      // Cumulative decode seconds across all tool-loop rounds: the accurate
      // tok/s denominator once tools ran (took - ttft would include tool
      // execution and inter-round gaps). 0 on payloads from an old server.
      assistant.decode = data.decode ?? 0
      // Seconds this turn spent waiting on a refused endpoint, over every round's
      // waits. Defaulted to 0 like `decode` above, because finish() subtracts it
      // from the banked span and `undefined` would make that NaN. Neither a decode
      // window nor a token figure: it enters the session clock's exclusion and the
      // per-turn caption only.
      assistant.waited = data.waited ?? 0
      assistant.tokensEstimated = !!data.tokensEstimated
      // Context occupancy of the FINAL round, to compare against the server
      // window: it never accumulates across rounds.
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
      // Terminal frame of a user-interrupted reply. Its exact figures arrived as
      // the `usage` frame just before it, so all that is left is the measurement
      // bookkeeping: freeze the window, flag the fragment and reopen the composer.
      closeGenerationWindow(assistant)
      // That `usage` frame holds the cumulative exact figures for everything
      // generated, so they become the message's final numbers: finish()'s
      // char-based fallback would otherwise flag a server-reported count as
      // estimated, and the tok/s badge needs `decode` to stay exact.
      if (assistant.usageTokens > 0) {
        assistant.tokens = assistant.usageTokens
        assistant.tokensEstimated = false
        if (assistant.usageDecode > 0) assistant.decode = assistant.usageDecode
      }
      assistant.paused = true
      // Paused before anything was generated (still prefilling): an empty turn
      // would sit in the thread and be re-posted, so it goes.
      if (!assistant.raw) {
        state.messages.splice(state.messages.indexOf(assistant), 1)
      }
      state.pausePending = false
      // Terminal frame too: the ack ends the turn the wait was inside.
      clearEndpointWait()
      state.phase = 'idle'
      break
    case 'tool_call':
      // A call the replayed round submitted: it answered, so the wait's line is
      // stale from this frame on.
      clearEndpointWait()
      assistant.tools.push({
        id: data.id ?? `${data.tool}-${assistant.tools.length}`,
        tool: data.tool ?? 'tool',
        server: data.server ?? '',
        preview: data.argsPreview ?? '',
        // A call the model wrote as text instead of submitting it: the panel
        // paints it as a bad tool call.
        bad: data.bad === true,
        state: 'running',
      })
      // The round's generation is over: close the client-side window so the tool
      // execution (which can take tens of seconds) never enters the live tok/s
      // denominator.
      closeGenerationWindow(assistant)
      // Draw buffered thinking before the badge: a delta still in the buffer
      // arrived before this call, so it must keep its earlier slot in the
      // timeline. One flush per tool round, not per chunk.
      reasoningBuffer.flush()
      // The block carries that same reactive object, so a later tool_result state
      // flip re-renders the badge in place.
      assistant.blocks.push({
        kind: 'tool',
        tool: assistant.tools[assistant.tools.length - 1],
      })
      // Server-authoritative tool-loop position for the iteration gauge.
      if (data.iteration) assistant.mcpIteration = data.iteration
      if (data.maxIterations) assistant.mcpMax = data.maxIterations
      break
    case 'usage':
      // Cumulative completion tokens (tool-call arguments included) and decode
      // seconds, arriving as soon as a tool round finished generating: this keeps
      // the side-panel badges live while the tool loop is still running.
      assistant.usageTokens = data.tokens ?? assistant.usageTokens
      assistant.usageDecode = data.decode ?? assistant.usageDecode
      // Close this round's window before snapshotting, so both baselines match the
      // server's exact figures: only what arrives after this frame is added by
      // later estimates, never double-counted and never missed.
      closeGenerationWindow(assistant)
      assistant.usageGeneratedChars = generatedChars(assistant)
      assistant.usageGeneratedSeconds = measuredSeconds(assistant)
      // Occupancy of the round that just ended: refreshed between rounds, right
      // when generation stops.
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
      // Arm the tool-icon line prefix (see the 'token' case).
      assistant.pendingStreamQuote = true
      break
    }
    case 'reconnecting':
      // The endpoint refused this round and the worker is waiting before it
      // re-sends: a **progress** frame, not a terminal one, so the turn still
      // closes on exactly one of `done` / `error` / `pause_ack` (plus finish()'s
      // fallback for an ending that reaches none).
      //
      // Unlike the `reasoning` case below, this one deliberately *can* leave
      // `answering`: a wait after a tool round follows an `answering` phase, so a
      // phase that could not leave it would never show. A refused round genuinely
      // is not answering any more — the failure landed before a byte of the reply
      // existed, which is what makes the replay a replay — and the next round's
      // first `token` opens `answering` again.
      state.phase = 'reconnecting'
      // Keep the frame's four fields as the composer strip's status line. The
      // endpoint's sentence is stored as it arrived — the UI quotes it and never
      // re-words it — and nothing is written to the thread: a status line, not
      // content.
      state.endpointWait = {
        attempt: data.attempt ?? 0,
        budget: data.budget ?? 0,
        waitSeconds: data.waitSeconds ?? 0,
        message: data.message ?? '',
      }
      break
    case 'reasoning':
      // The replayed round is thinking: the wait ended with this frame, and a
      // line still reading `Reconnecting` would say the opposite of what is
      // happening.
      clearEndpointWait()
      // Never downgrade to reasoning once answer text started; `reconnecting` is in
      // the set because the wait is over the moment this frame arrives.
      if (
        state.phase === 'waiting' ||
        state.phase === 'reasoning' ||
        state.phase === 'reconnecting'
      ) {
        state.phase = 'reasoning'
      }
      break
    case 'reasoning_delta': {
      // Streamed thinking is an arrival too: the endpoint answered again, so
      // this round is no longer a wait.
      clearEndpointWait()
      // Thinking text, streamed live. Buffered into the panel timeline once per
      // animation frame (see lib/reasoning-buffer): each write into the reactive
      // block re-cuts the panel's rows and re-runs its autoscroll, which a chunk's
      // network-set rate would trigger far too often.
      const text = data.text ?? ''
      if (!text) break
      reasoningBuffer.append(assistant.blocks, text)
      // Thinking is generated text the client DOES see: it feeds the live tok/s
      // numerator and keeps the measurement window open. Synchronous on purpose —
      // a `usage` frame snapshots its baseline out of it, so deferring would count
      // the buffered tail twice.
      assistant.reasoningChars += text.length
      noteGenerated(assistant)
      break
    }
    case 'error':
      // Terminal frame: the budget ran out (or the error was final), so the wait
      // this line described is over — the failure is what the user reads now.
      clearEndpointWait()
      state.error = data.message || 'Chat request failed.'
      // A server-cut reply keeps its partial text in the conversation (unlike an
      // explicit Stop) and re-posts it on the next send, so the message itself
      // carries the marker, not just the transient error line.
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
  // Nothing may read a timeline still missing its last chunks: session saving
  // serializes these blocks and does not wait for a frame.
  reasoningBuffer.flush()
  if (activeMessage)
    activeMessage.html = renderMarkdown(activeMessage.raw, { mermaid: true })
  activeMessage = null
  // Stream ended without an exact usage report (stop/abort/error): exact
  // cumulative tokens from the last `usage` frame plus the ~4 chars/token
  // heuristic on what streamed since, flagged as estimated.
  if (!assistant.tokens) {
    const carried = assistant.usageTokens || 0
    const tail = estimateGeneratedTail(assistant)
    if (carried + tail > 0) {
      assistant.tokens = carried + tail
      assistant.tokensEstimated = true
    }
  }
  // Freeze the measurement window: a finished reply's live rate is never
  // recomputed.
  closeGenerationWindow(assistant)
  // Stop/abort mid tool-execution: no tool_result will arrive, so never leave a
  // badge stuck on the pulsing "running" state.
  for (const tool of assistant.tools ?? []) {
    if (tool.state === 'running') tool.state = 'error'
  }
  assistant.streaming = false
  state.phase = 'idle'
  // Bank this turn's span: the app bar's clock reads the conversation's total
  // time, so an ended reply stops ticking without losing what it counted. Only
  // reset() zeroes it.
  //
  // The banked span **excludes the seconds this turn waited on a refused
  // endpoint** (`waited`, off the `done` frame): a wait is neither inference nor
  // thinking, so an outage must not read as session time. The turn's own span
  // keeps them and is shown beside the clock, which is why that separate figure
  // exists.
  //
  // A turn that ended with no `done` frame (Stop, an abort, a dropped connection,
  // a `pause_ack`) banks its whole span with `waited` read as 0: the app cannot
  // know what such a turn waited, and inventing a figure would be worse.
  if (state.session.startedAt > 0) {
    const span = Math.max(Date.now() - state.session.startedAt, 0)
    const waitedMs = (assistant.waited || 0) * 1000
    state.session.spentMs += Math.max(span - waitedMs, 0)
    state.session.startedAt = 0
  }
  // The turn is over, so nothing is running on any agent: the app bar's running
  // line goes blank, rather than keeping the last model's name.
  state.session.agentMode = null
  controller = null
  // A pause whose `pause_ack` never arrives: the reply is over either way, so the
  // ⏸ must stop blinking. The per-message `paused` flag only drives a caption.
  state.pausePending = false
  // The local fallback for every ending that reached no terminal frame — Stop's
  // abort, a dropped connection, a stream closed between two waits: the turn is
  // over, so a wait's line cannot survive it either.
  clearEndpointWait()
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
// what "my last message" means; and after a reply the model left unfinished, the
// run still holds every user turn that reply has not answered.
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

// One streamed turn, end to end: push the user bubbles and the reply's, open the
// SSE request and run finish() in its finally. Both entry points call it —
// `send()` for an interactive flush, `sendBatchTurn()` for one batch task —
// because the pause/truncation/measurement logic below must never be forked.
//
// `userMessages` is what this turn opens on: one message for a batch task or a
// draft-only send, several for a flush, which is still **one** turn — one
// request, one agent, one clock span.
//
// `history` is the message list posted to the server and the ONLY thing that
// varies between the two entry points: an interactive send sends the whole
// accumulated thread, a batch task sends its one instruction — the model context
// is reset per task, while the displayed transcript keeps accumulating. The
// client never sends a system message: `core/chat.py` stays the only place one is
// created.
//
// `agentMode` (the last entry): the mode **this turn** runs in. An interactive
// send passes the composer's selection; a batch task turn passes the runner's
// pin — a lot is one job executed under one set of rules, and the dropdown the
// user may be touching meanwhile is not part of it. `undefined` means "ask the
// server for its default", which is what `useBatch` passes when its pin could not
// be resolved.
async function startTurn({
  userMessages,
  history,
  batchContext = null,
  agentMode = undefined,
  workspace = undefined,
}) {
  userStopped = false
  // Fresh turn: a previous turn's pause must not survive into it (its fragment
  // already carries its own `paused` flag, which is per message).
  userPaused = false
  state.error = null
  // A flush carries the whole strip in one request, so every message goes in, in
  // order, before the reply's bubble.
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
    // Client-side generation timing (see noteGenerated/measuredSeconds).
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
    // Seconds this turn waited on a refused endpoint, from the same `done` event:
    // keeps the turn span (which includes them) tellable apart from the session
    // total (which excludes them). 0 until the frame arrives.
    waited: 0,
    contextTokens: 0, // LAST round's prompt + completion = context occupancy
    contextEstimated: false, // occupancy figure involves a char estimate
    // Set by a `truncated` error frame: the server ended the stream before the
    // reply was finished, so this turn is a fragment.
    truncated: false,
    // Set by the `pause_ack` frame: the user interrupted this turn, so its
    // fragment is deliberately kept in the conversation and the payload says so
    // (display state, like `truncated` — never written to session JSON).
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
      // contribute tools. Omitted when the snapshot failed to load.
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
    // The agent mode for this turn. The composer refuses an interactive send when
    // the list is not loaded and a lot refuses at launch when its pin does not
    // resolve, so a live turn always names the agent it runs as. `undefined` means
    // "read the composer's selection"; a resolved batch pin is sent as it stands.
    const modeId = agentMode === undefined ? agentModePayloadId() : agentMode
    if (modeId) {
      payload.agentMode = modeId
    }
    // Recorded for the app bar's running line: the agent **this** request
    // carries, not the composer's current selection, so a lot's pin reads
    // correctly and a dropdown moved mid-reply cannot misname the stream.
    state.session.agentMode = modeId ?? null
    if (batchContext) {
      // The lot's big picture: the server appends it to its own system message, so
      // it rides on every task turn without ever becoming a visible bubble — which
      // is what survives the per-task context reset.
      payload.batchContext = batchContext
    }
    // The turn is **about this tab's folder**: the field rides on the URL like
    // every other workspace-scoped request (a query parameter, never a body
    // field), so the server injects that folder's project instructions and roots
    // that folder's tools.
    //
    // `workspace` names an **explicit** folder rather than the tab's current one:
    // a batch task turn passes its run's pin, so a tab that moves during the lot
    // cannot re-root the task still being executed. Absent (`undefined`) means the
    // interactive shape — the tab's own folder.
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
    // Accepted send: the conversation has started, so the MCP and LSP toggles
    // freeze until the restart button resets them (sticky by design —
    // edit-and-resend of the last message does not unlock them).
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
    // A paused reply keeps its fragment, except when nothing was generated: the
    // fallback abort has no `pause_ack` to drop the empty turn, so it goes here.
    const discard = (userStopped && !userPaused) || (userPaused && !assistant.raw)
    if (discard) {
      // Stop discards the partial reply entirely, tool badges included. The user
      // message stays so it can be edited and re-sent.
      const index = state.messages.indexOf(assistant)
      if (index !== -1) state.messages.splice(index, 1)
    }
    finish(assistant)
  }
}

export function useChat() {
  // A replaced working location takes the strip with it, through the same keyed
  // registry the Editor's open buffers are forgotten through — this module never
  // imports an Editor file composable, so the dependency stays one-way. A
  // re-registration replaces this key's entry instead of appending a second copy.
  registerReRootHandler('chatStrip', discardStagedForReRoot)

  // The sending key flushes: every staged message, then the draft if it has
  // content, become consecutive user turns of **one** turn. A draft-only send is
  // the send this always was, down to the payload.
  //
  // Everything that can refuse runs first, and a refusal moves nothing: a broken
  // agent selection or a busy conversation must never eat a written brief.
  // Validation is all-or-nothing for the same reason — the server rejects a
  // request carrying a blank user turn, which would discard every message that
  // rode with it, so each one is judged here first.
  async function send() {
    const trimmed = state.draft.raw.trim()
    const pendingImages = state.pendingImages.slice()
    const hasDraft = !!trimmed || pendingImages.length > 0
    // Nothing staged and nothing typed: nothing to flush, so nothing moves.
    if ((!hasDraft && !state.staged.length) || chatBusy()) return

    // An agent with no model — or a list the composer never read — cannot be sent
    // to. The same verdict paints the warning icon and disables Send. Nothing has
    // been posted, so the draft survives and no stream is left half-open.
    if (selectedAgentGateReason()) return

    // The flush's turns, in flush order: every staged row as it stands, then the
    // draft if it has content. The draft's HTML is filled in only once the flush
    // is accepted — rendering it now would cancel the preview's debounce, and a
    // refusal must leave the composer as it found it.
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
          // Every image the composer holds travels with this message, in
          // attachment order.
          images: pendingImages.map((image) => ({ ...image })),
        }
      : null
    if (draftMessage) userMessages.push(draftMessage)

    // All-or-nothing: one message the server would refuse blocks the whole flush,
    // so the good rows are not spent on a request that will not land.
    const refused = []
    userMessages.forEach((message, position) => {
      const reason = flushGateReason(message)
      if (!reason) return
      // The row's number in flush order is what the strip shows; the draft, when
      // it is the offender, is not a row.
      refused.push(
        position < state.staged.length
          ? `message ${position + 1} (${reason})`
          : `the draft (${reason})`,
      )
    })
    if (refused.length) {
      // The chat error line is where a refused send is announced: the strip marks
      // the offending rows off the same verdict, and this says why the flush
      // stopped. Nothing has moved.
      state.error = `Nothing was sent: ${joinNames(refused)}.`
      return
    }

    // Accepted: the strip and the composer empty as part of opening the turn, never
    // before the gates. The MCP/LSP toggles lock on the accepted request inside
    // startTurn, so staging alone freezes nothing. The draft's HTML reuses what
    // setDraft's preview rendered, re-rendering only if the sending key beat the
    // debounce.
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

  // Batch mode's entry point: one task instruction, one turn. Returns whether the
  // turn was *started* — the batch loop needs that flag instead of awaiting a
  // phase change that would never come. The payload deliberately carries this turn
  // alone: `state.messages` is never used to build a batch request, so task N+1
  // arrives with no trace of task N's transcript.
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

  // Ends the turn in flight, and nothing else: what the user staged is not part of
  // that turn, so the strip keeps its rows, order and images. The abort reaches the
  // stream, never the composer's input state.
  function stop() {
    userStopped = true
    if (controller) controller.abort()
  }

  // Non-destructive twin of stop(): the server closes the upstream stream at its
  // next message boundary and terminates the reply with `pause_ack`, which keeps
  // the partial turn in the conversation. One-way — the ack puts the app back to
  // idle, and the user's next Send is the only way back into inference.
  //
  // Like `stop()`, it ends a turn and leaves the strip alone: a staged message is
  // uncommitted input, not part of what is in flight, so neither this path, its
  // local abort fallback, nor the `finish()` that follows touches staged rows.
  async function pause() {
    // Blinking = waiting for the ack: not clickable, and nothing to pause once
    // the reply is over.
    if (state.phase === 'idle' || state.pausePending) return
    state.pausePending = true
    try {
      // No body: the server keeps the single in-flight handle. The workspace field
      // names **this tab's** reply.
      await fetch(withWorkspace('/api/chat/pause'), { method: 'POST' })
    } catch {
      // Endpoint unreachable: fall back to a local abort that keeps the fragment.
      // The abort ends readStream, so finish() runs and clears pausePending.
      userPaused = true
      // Flag the fragment here, since no `pause_ack` will: it gets the caption and
      // the payload note that tells the model this turn is unfinished.
      if (activeMessage) activeMessage.paused = true
      if (controller) controller.abort()
    }
  }

  // Puts the last unanswered group of user turns back into the strip: every turn
  // of the run, in order, each with all of its images, and drops the whole run plus
  // everything after it from the thread. **Not one message** — a flush opens a turn
  // with several user turns in a row, so the name keeps naming the gesture the
  // pencil draws while returning the run that thing was part of.
  //
  // Splicing to the end takes a partial reply the model left after the last user
  // turn with it — interrupted, truncated or still being written — which is right:
  // the group is what is unanswered.
  //
  // The group joins the strip **in front of** anything already staged, because the
  // strip is the flush order. The draft is deliberately untouched: it is the
  // user's in-progress typing. No request is made.
  function editLast() {
    if (chatBusy()) return
    const start = lastUserGroupStart(state.messages)
    if (start === -1) return
    // Only the user turns of the run come back: a reply after the last of them is
    // what is going away.
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

  // Replaces the conversation with the turns of a parsed session file. Returns
  // `{ restored }`, or null when refused because a reply is streaming — the
  // "must not be running" rule lives here, not only on the button.
  function loadSession(parsed) {
    if (chatBusy()) return null
    const items = Array.isArray(parsed?.messages) ? parsed.messages : []
    if (!items.length) return { restored: 0 }

    // Rebuild the rich shape the view and the side panel render: the common fields
    // plus the assistant-only set startTurn() initialises, so the badges never see
    // `undefined`.
    state.messages = items.map((item) => {
      const raw = item.content ?? ''
      const message = {
        role: item.role,
        raw,
        html: renderMarkdown(raw, { mermaid: true }),
        streaming: false,
        // Images restored from the file (already `{ dataUrl, name, size }`), so
        // every thumbnail renders and the next send re-posts them to the model.
        images: item.images ?? [],
      }
      if (item.role !== 'assistant') return message
      // The loaded thinking flows become the reply's panel timeline: one reasoning
      // block per flow, in file order (tool badges are never saved).
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

    // A loaded conversation counts as started: the toggles freeze as after a first
    // accepted send, and the loaders below ignore a locked conversation. No reset()
    // here — it would wipe the messages just loaded.
    if (state.messages.length) {
      state.mcp.locked = true
      state.lsp.locked = true
    } else {
      loadChatMcp()
      loadChatLsp()
    }
    // The agent the file was saved with **wins over the tab's remembered choice**:
    // the file describes the conversation, `sessionStorage` the tab, and the more
    // specific one answers a resume. useAgentModes judges it against the loaded
    // list — an unknown id falls back to the first agent with one notice line,
    // never a silent swap of persona.
    applySessionAgentMode(parsed.agentMode)
    state.error = null
    state.pendingImages = []
    // The strip belonged to the conversation this file replaced: loading is a
    // replacement, not an addition, and a staged message never travels in either
    // direction — `conversationJson()` renders the thread alone.
    state.staged = []
    // A loaded conversation replaces the one the meters measured, so they start
    // from nothing: keeping the previous total would credit these turns with time
    // they never spent.
    state.session.startedAt = 0
    state.session.spentMs = 0
    return { restored: state.messages.length }
  }

  // `refetchHubs: false` is batch mode's between-task wipe: the conversation is
  // wiped but the hub allowlist must NOT be re-seeded, or a connector that
  // appeared mid-lot would silently join the remaining tasks' tool set.
  function reset({ refetchHubs = true } = {}) {
    if (controller) controller.abort()
    state.messages = []
    state.error = null
    state.pendingImages = []
    // Restart wipes everything, so the strip goes with the conversation: a queue
    // that outlived it would be the only survivor of a thread nobody can see.
    // Silent on purpose — Restart already means wipe.
    state.staged = []
    // The conversation the meters described is gone, so they start over: the
    // **only** place the clock and the counters go back to blank. Batch mode's
    // between-task wipe reaches this too, and that is intended: a task's model
    // context is its own, so the next task must not open on its predecessor's
    // occupancy or speed.
    state.session.startedAt = 0
    state.session.spentMs = 0
    // A pause still in flight has no conversation to ack: clear the blinking flag
    // (and the per-reply fallback flag) so no ⏸ survives on a conversation that no
    // longer streams.
    state.pausePending = false
    // The abort above ends a turn that reached no terminal frame, so the wait's
    // status line needs the same sweep: Restart during a wait would otherwise
    // leave a stale line under a composer holding no turn.
    clearEndpointWait()
    userPaused = false
    // The session-mode notice explained a conversation that no longer exists, and
    // it must be cleared before the `refetchHubs` early return too — batch mode's
    // between-task wipe resets without refetching.
    clearAgentModeNotice()
    if (!refetchHubs) return
    // New conversation: MCP and LSP toggles unlock against freshly fetched
    // snapshots, keeping the previous on/off choices. The agent list is refreshed
    // by the same call, so a store edited mid-lot takes effect next time.
    state.mcp.locked = false
    state.lsp.locked = false
    loadChatHubs()
  }

  return {
    state,
    send,
    // The same busy rule the guards here use: a control that locks while a reply
    // streams reads this rather than watching `phase`, so the two cannot disagree.
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
    // Back to the strip, all of the last unanswered group: not a one-message undo,
    // whatever the name still says.
    editLast,
    loadSession,
    attachImage,
    removeImage,
    clearImage,
    // The strip's verbs: stage the draft, drop one row, pull one back into the
    // composer. All three refuse while the composer is shut, and the strip is
    // read-only then rather than hidden. What a row says about itself comes from
    // `flushGateReason`, so the strip quotes one verdict.
    stage,
    removeStaged,
    pullBackStaged,
    loadChatMcp,
    setChatMcp,
    restartMcp: () => restartHub('mcp'),
    loadChatLsp,
    setChatLsp,
    restartLsp: () => restartHub('lsp'),
    // The three together (modes + both hubs), for entry points that want a fresh
    // conversation snapshot rather than one list.
    loadChatHubs,
  }
}
