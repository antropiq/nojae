import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

import { useChat } from '../src/composables/useChat'
import { useAppShell } from '../src/composables/useAppShell'
import { useAgentModes } from '../src/composables/useAgentModes'

// Layer 1 (jsdom): what the chat composable does with the frames of a repaired
// round. The server keeps a text-written tool call out of the answer, reports it
// as a `bad` tool call and carries on (see tests/test_chat.py); this file pins
// the client's half: the badge is marked as bad, its failure flips it, and the
// markup never lands in the conversation's raw text.

const chatApi = useChat()
const chat = chatApi.state
const appShell = useAppShell().state
const agentModes = useAgentModes().state

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

function frame(name, data) {
  return `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`
}

// The frames of one repaired reply: the bad call, its failed result, then the
// answer the model produced after it was corrected.
function repairedReply() {
  return [
    frame('phase', {}),
    frame('tool_call', {
      id: 'bad-tool-call',
      tool: 'read_files',
      server: '',
      argsPreview: '',
      bad: true,
      iteration: 1,
      maxIterations: 25,
    }),
    frame('tool_result', { id: 'bad-tool-call', ok: false, preview: 'did not succeed' }),
    frame('token', { text: 'Recovered.' }),
    frame('done', { tokens: 2, took: 1, ttft: 0.2, decode: 0.8 }),
  ].join('')
}

async function sendOne(bodyText) {
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    headers: { get: () => 'text/event-stream' },
    body: sseBody(bodyText),
  }))
  chat.draft.raw = 'read AGENTS.md'
  await chatApi.send({})
}

function lastAssistant() {
  return chat.messages.find((m) => m.role === 'assistant')
}

describe('a bad tool call in the reply', () => {
  beforeEach(() => {
    appShell.config = { models: [{ id: 1, name: 'm', contextWindow: 8192 }], store: { usable: true } }
    // The composer's send gate refuses a turn with no runnable agent (a real
    // rule, not this feature's): seed a loaded list whose current mode has a
    // model, so the frames this file is about are what gets exercised.
    agentModes.loaded = true
    agentModes.modes = [{ id: 'code', label: 'Code', modelId: 1, mcpEnable: true, lspEnable: true }]
    agentModes.current = 'code'
    chat.messages = []
    chat.phase = 'idle'
    chat.draft.raw = ''
  })

  afterEach(() => vi.unstubAllGlobals())

  it('lands in the timeline marked as bad', async () => {
    await sendOne(repairedReply())
    const badge = lastAssistant().blocks.find((b) => b.kind === 'tool')
    expect(badge.tool.bad).toBe(true)
    expect(badge.tool.tool).toBe('read_files')
  })

  it('flips to the failed state its result reports', async () => {
    await sendOne(repairedReply())
    expect(lastAssistant().blocks.find((b) => b.kind === 'tool').tool.state).toBe('error')
  })

  it('leaves no markup in the conversation text', async () => {
    await sendOne(repairedReply())
    const raw = lastAssistant().raw
    // The tool icon's line sentinel prefixes the post-tool answer (unchanged
    // behaviour); what must be absent is the call's markup itself.
    expect(raw).toContain('Recovered.')
    expect(raw).not.toContain('tool_call')
    expect(raw).not.toContain('read_files')
  })

  it('reports a connector call as not bad', async () => {
    // The same frames without `bad`: an ordinary call must not be relabelled.
    const body = [
      frame('tool_call', { id: 'c1', tool: 'read_file', server: 'fedit', argsPreview: '{}' }),
      frame('tool_result', { id: 'c1', ok: true, preview: 'ok' }),
      frame('token', { text: 'done' }),
      frame('done', { tokens: 1, took: 1, ttft: 0.1, decode: 0.5 }),
    ].join('')
    await sendOne(body)
    expect(lastAssistant().blocks.find((b) => b.kind === 'tool').tool.bad).toBe(false)
  })
})
