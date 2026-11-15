import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useChat } from '../src/composables/useChat'
import { useAgentModes } from '../src/composables/useAgentModes'
import { useBatch } from '../src/composables/useBatch'
import { useAppShell } from '../src/composables/useAppShell'
import {
  clearTabWorkspace,
  pointTabAt,
  workspaceOf,
  withWorkspace,
} from './helpers/workspace-url'

// ---------------------------------------------------------------------------
// A chat turn is about **this tab's** folder (clws-02 §4).
//
// The change is one line — `startTurn` opens its request through `withWorkspace`
// — and this suite is the reason that line is load-bearing: the server answers
// the system prompt's project-instructions block, and roots the agent's tools,
// from the folder the request names. Two tabs on two folders must therefore
// produce two requests naming two folders, and Pause must reach the reply of the
// tab that pressed it.
//
// The stream's own behaviour is untouched and stays asserted where it always
// was: same body, same SSE frames, same cancellation-on-disconnect (spec D10),
// and a paused reply still ends on its own `pause_ack`.
// ---------------------------------------------------------------------------

const chat = useChat().state
const batch = useBatch().state
const agentModes = useAgentModes().state
const appShell = useAppShell().state

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

function sseBody(text) {
  const bytes = new TextEncoder().encode(text)
  let delivered = false
  return {
    getReader() {
      return {
        async read() {
          if (delivered) return { done: true, value: undefined }
          delivered = true
          return { done: false, value: bytes }
        },
      }
    },
  }
}

const DONE =
  'event: done\ndata: {"tokens":12,"took":1.5,"ttft":0.4,"decode":1.1}\n\n'

// The routes a turn touches. `/api/agents` answers one row so the composer's
// gate lets the send through; `/api/chat` records the whole request URL.
function stubTurn({ urls = [], pauseUrls = [] } = {}) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
    const key = String(url)
    urls.push([key, init?.method ?? 'GET', init])
    if (key.startsWith('/api/agents')) {
      return jsonResponse({
        agents: [
          {
            id: 'code', label: 'Code', mcpEnable: true, lspEnable: true,
            readonly: false, deletable: true, maxToolIteration: 25,
            systemMessage: '', modelId: 1, modelName: 'm',
          },
        ],
        caps: {
          maxIdChars: 32, idPattern: '^[a-z][A-Za-z0-9_-]*$', maxLabelChars: 40,
          maxPersonaBytes: 16384, maxPersonaLines: 16, minToolIteration: 1,
        },
        findings: [],
      })
    }
    if (key.startsWith('/api/chat/pause')) {
      pauseUrls.push(key)
      return jsonResponse({ paused: 'requested' })
    }
    if (key.startsWith('/api/chat')) {
      return { ok: true, body: sseBody(DONE) }
    }
    return jsonResponse({})
  })
  return { urls, pauseUrls }
}

function reset() {
  clearTabWorkspace()
  chat.phase = 'idle'
  chat.messages = []
  chat.error = null
  chat.pausePending = false
  chat.session.startedAt = 0
  chat.session.agentMode = null
  chat.pendingImage = null
  chat.mcp = { connectors: [], enabled: {}, loaded: false, locked: false, restarting: false }
  chat.lsp = { servers: [], enabled: {}, loaded: false, locked: false, restarting: false }
  batch.active = false
  batch.status = 'idle'
  appShell.activeTab = 'chat'
  agentModes.modes = []
  agentModes.current = null
  agentModes.loaded = false
  agentModes.findings = []
  agentModes.notice = null
  // The remembered agent is the tab's (§5.5 rule 26): clear the storage the
  // selection lives in, not the browser-wide one the theme and layout use.
  window.sessionStorage.clear()
}

async function typeAndSend(text) {
  const { setDraft, send } = useChat()
  setDraft(text)
  await send()
}

function chatPosts(urls) {
  return urls.filter(([url, method]) => method === 'POST' && url.startsWith('/api/chat?'))
}

describe('a turn names the folder its tab is on', () => {
  beforeEach(() => {
    reset()
    vi.restoreAllMocks()
  })

  it('posts the request with the tab workspace on the URL', async () => {
    const root = pointTabAt('/w/workspace-a')
    const { urls } = stubTurn()
    await useAgentModes().loadAgentModes()
    await typeAndSend('hello')

    const posts = chatPosts(urls)
    expect(posts).toHaveLength(1)
    const [url] = posts[0]
    expect(url).toBe(withWorkspace('/api/chat'))
    expect(workspaceOf(url)).toBe(root)
    // The field is a query parameter, never a body field (spec D9): the body is
    // exactly what it was before this task.
    const body = JSON.parse(posts[0][2].body)
    expect('workspace' in body).toBe(false)
    expect(body.messages.at(-1).content).toBe('hello')
  })

  it('two tabs on two folders send two different requests', async () => {
    const { urls } = stubTurn()
    await useAgentModes().loadAgentModes()

    pointTabAt('/w/workspace-a')
    await typeAndSend('from A')
    pointTabAt('/w/workspace-b')
    await typeAndSend('from B')

    const folders = chatPosts(urls).map(([url]) => workspaceOf(url))
    expect(folders).toEqual(['/w/workspace-a', '/w/workspace-b'])
  })

  it('Pause carries the same field, so it reaches this tab reply', async () => {
    const root = pointTabAt('/w/workspace-a')
    const { pauseUrls } = stubTurn()
    chat.phase = 'answering'

    await useChat().pause()

    expect(pauseUrls).toHaveLength(1)
    expect(pauseUrls[0]).toBe(withWorkspace('/api/chat/pause'))
    expect(workspaceOf(pauseUrls[0])).toBe(root)
  })
})
