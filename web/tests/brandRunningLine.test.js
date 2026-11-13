import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import AppBar from '../src/components/AppBar.vue'
import { runningOnLine, useAgentModes } from '../src/composables/useAgentModes'
import { useAppShell } from '../src/composables/useAppShell'
import { useBatch } from '../src/composables/useBatch'
import { useChat } from '../src/composables/useChat'

// ---------------------------------------------------------------------------
// The brand's gray line, which now describes the **running** turn instead of
// the install: `Running <model> on <server>`, for as long as a reply streams.
//
// The old sentence named the host the app was reached on and every model the
// install held — information the agent carries now, so it can only be answered
// once a turn is actually running on one agent. Hence the two rules asserted
// here: the line appears with the stream and disappears with it, and it names
// the agent the turn was **sent** as (`chat.session.agentMode`), never the
// composer's current selection — a dropdown moved mid-reply, or a lot running
// under its own pin, must not make the bar name a stranger to the stream.
//
// The names are the server's throughout: `modelName` from the agent row, and
// the server from the model that row points at in `GET /api/config`'s list.
// ---------------------------------------------------------------------------

const MODELS = [
  { id: 1, name: 'qwen-3.8-flash-next_iq3_s', serverId: 7, serverName: 'hpz' },
  { id: 2, name: 'llama-3.1-8b', serverId: 8, serverName: 'lab' },
]

const AGENTS = [
  { id: 'code', label: 'Code', modelId: 1, modelName: 'qwen-3.8-flash-next_iq3_s' },
  { id: 'chat', label: 'Chat', modelId: 2, modelName: 'llama-3.1-8b' },
  { id: 'bare', label: 'Bare', modelId: null, modelName: null },
]

describe('runningOnLine: the rule behind the line', () => {
  it('names the model and its server', () => {
    expect(runningOnLine(AGENTS[0], MODELS)).toBe(
      'Running qwen-3.8-flash-next_iq3_s on hpz',
    )
    expect(runningOnLine(AGENTS[1], MODELS)).toBe('Running llama-3.1-8b on lab')
  })

  it('says nothing for an agent with no model', () => {
    expect(runningOnLine(AGENTS[2], MODELS)).toBe(null)
    expect(runningOnLine(null, MODELS)).toBe(null)
  })

  // The row names a model the catalogue no longer holds (a server deleted in
  // another tab): the agent row's own resolved name is still the truth about
  // the turn, but there is no server to name — so the server half is dropped
  // rather than guessed at.
  it('keeps the model name when only the server is unknown', () => {
    const row = { id: 'x', modelId: 99, modelName: 'orphan-model' }
    expect(runningOnLine(row, MODELS)).toBe('Running orphan-model')
  })

  // Nothing trustworthy to name: the bar stays silent instead of inventing a
  // model, which is the same refusal the composer's gate makes. A catalogue
  // that never loaded still has the agent row's name to go by.
  it('says nothing when no name can be resolved', () => {
    expect(runningOnLine({ id: 'x', modelId: 99, modelName: null }, MODELS)).toBe(null)
    expect(runningOnLine({ id: 'x', modelId: 99 }, [])).toBe(null)
    expect(runningOnLine(AGENTS[0], undefined)).toBe(
      'Running qwen-3.8-flash-next_iq3_s',
    )
  })
})

const shell = useAppShell().state
const agentModes = useAgentModes().state
const chat = useChat().state
const batch = useBatch().state

function reset() {
  shell.config = { models: MODELS, store: { usable: true, sentence: null } }
  shell.storeState = { usable: true, sentence: null }
  shell.configError = null
  shell.pathLocation = '/w/proj'
  shell.pathLocationCurrent = '/w/proj'
  shell.pathLocationSaving = false
  shell.pathLocationError = null
  shell.pathLocationPolicyNote = null
  shell.activeTab = 'chat'
  agentModes.modes = AGENTS
  agentModes.current = 'code'
  agentModes.loaded = true
  agentModes.findings = []
  agentModes.notice = null
  batch.active = false
  batch.status = 'idle'
  chat.phase = 'idle'
  chat.messages = []
  chat.session.startedAt = 0
  chat.session.agentMode = null
}

function brandLines(wrapper) {
  return wrapper.findAll('.brand-sub').map((node) => node.text())
}

// A reply in flight, running as the agent `id` — which is what startTurn
// records when it opens the request.
function streamingAs(id) {
  chat.phase = 'answering'
  chat.session.startedAt = 1000
  chat.session.agentMode = id
}

describe('the brand line names the running model, for the length of the stream', () => {
  beforeEach(reset)

  it('is absent while nothing streams', () => {
    const wrapper = mount(AppBar)
    expect(brandLines(wrapper)).toEqual([])
    wrapper.unmount()
  })

  it('appears with the stream, naming that turn model and server', () => {
    streamingAs('code')
    const wrapper = mount(AppBar)
    expect(brandLines(wrapper)).toEqual([
      'Running qwen-3.8-flash-next_iq3_s on hpz',
    ])
    wrapper.unmount()
  })

  // The other half of the request: the line is about a live turn, so a finished
  // model's name must not stay on screen as if it were current.
  it('is gone again when the reply ends', async () => {
    streamingAs('code')
    const wrapper = mount(AppBar)
    expect(brandLines(wrapper)).toHaveLength(1)

    chat.phase = 'idle'
    chat.session.startedAt = 0
    chat.session.agentMode = null
    await wrapper.vm.$nextTick()

    expect(brandLines(wrapper)).toEqual([])
    wrapper.unmount()
  })

  // The reason the line reads `session.agentMode` rather than the selection:
  // the composer may be moved while a reply streams, and that change reaches no
  // turn in flight.
  it('follows the running turn, not a mid-reply agent switch', async () => {
    streamingAs('code')
    const wrapper = mount(AppBar)

    agentModes.current = 'chat'
    await wrapper.vm.$nextTick()

    expect(brandLines(wrapper)).toEqual([
      'Running qwen-3.8-flash-next_iq3_s on hpz',
    ])
    wrapper.unmount()
  })

  // A lot runs every task under its own pin, and that pin is the agent its
  // turns carry — the line reads it too, because it reads the sent agent.
  it('names the agent a batch turn was sent as', () => {
    batch.active = true
    streamingAs('chat')
    const wrapper = mount(AppBar)
    expect(brandLines(wrapper)).toEqual(['Running llama-3.1-8b on lab'])
    wrapper.unmount()
  })

  // An agent whose row has no model cannot run, so no stream can be running on
  // one; the bar has nothing to say either way.
  it('says nothing for a turn whose agent has no model', () => {
    streamingAs('bare')
    const wrapper = mount(AppBar)
    expect(brandLines(wrapper)).toEqual([])
    wrapper.unmount()
  })

  // A turn that carries no agent names no model. `modeById` answers the
  // composer's *current* selection for a missing id, so without the guard the
  // bar would credit the running stream with whatever agent the dropdown holds
  // — a stranger to it. The line stays blank instead.
  it('says nothing for a turn that carries no agent', () => {
    chat.phase = 'answering'
    chat.session.startedAt = 1000
    chat.session.agentMode = null
    agentModes.current = 'code'

    const wrapper = mount(AppBar)
    expect(brandLines(wrapper)).toEqual([])
    wrapper.unmount()
  })

  // The store-level problem keeps its line: it is the thing to fix before any
  // turn can run, and the bar has room for one line only.
  it('yields to the store sentence', () => {
    shell.config = { models: [], store: { usable: false, sentence: 'store is broken' } }
    shell.storeState = { usable: false, sentence: 'store is broken' }
    streamingAs('code')
    const wrapper = mount(AppBar)

    expect(brandLines(wrapper)).toEqual(['store is broken'])
    wrapper.unmount()
  })
})
