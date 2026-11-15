import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  MAX_TASK_RETRIES,
  RETRY_NOTE_TEMPLATE,
  TASK_INSTRUCTION_TEMPLATE,
  nextBatchAction,
  relaunchDelayMs,
  taskCountedForProgress,
  taskInstruction,
  taskInstructionForAttempt,
  useBatch,
} from '../src/composables/useBatch'
import { useAppShell } from '../src/composables/useAppShell'
import { useChat } from '../src/composables/useChat'
import { loadAgentModes, setAgentMode, useAgentModes } from '../src/composables/useAgentModes'
import { useWorkspaceSession } from '../src/composables/useWorkspaceSession'
import { pointTabAt, workspaceOf } from './helpers/workspace-url'

// Layer 1 (jsdom): the retry rule of batch mode. A task is finished when its
// file has left the lot folder — the move into `done/` is the agent's own
// acknowledgement, and the re-listing (the only file surface batch mode has,
// B13) is how the loop reads it. What is asserted here is the decision table
// and the loop that acts on it, against a stubbed /api/chat and /api/batch/tasks:
// the outcome wording and the retry note are e2e/visual concerns.

const batch = useBatch().state
const { launch, stopBatch } = useBatch()
const chat = useChat().state
const appShell = useAppShell().state

// ---------------------------------------------------------------------------
// The pure rules first: the decision table, and the message a retry carries.

describe('the retry note', () => {
  it('the first attempt is the plain instruction, byte for byte', () => {
    expect(taskInstructionForAttempt('todos/ed-01-a.md', 0)).toBe(
      taskInstruction('todos/ed-01-a.md'),
    )
    expect(taskInstructionForAttempt('todos/ed-01-a.md')).toBe(
      TASK_INSTRUCTION_TEMPLATE.replace('<task_location>', 'todos/ed-01-a.md'),
    )
  })

  it('a relaunch appends the note naming the retry number', () => {
    // The wording is the architect's and the model acts on it, so it is pinned
    // verbatim — the emphasis is what tells it the *move* is the missing step.
    expect(taskInstructionForAttempt('todos/ed-01-a.md', 1)).toBe(
      "You've been given task: todos/ed-01-a.md to proceed. Do the coding " +
        'tasks needed to implement the feature. Once done move it into the ' +
        'todos/done folder.\n\n' +
        'Important: The task as been relaunch because *it has not been moved* ' +
        'to the **todos/done** folder (retry number *1*)',
    )
  })

  it('the note carries the retry number of the attempt being made', () => {
    for (const attempt of [1, 2, MAX_TASK_RETRIES]) {
      expect(taskInstructionForAttempt('todos/ed-02-b.md', attempt)).toContain(
        `(retry number *${attempt}*)`,
      )
    }
    expect(RETRY_NOTE_TEMPLATE).toContain('<retry_number>')
  })
})

// The relaunch wait: a rising schedule so a brief network cut (under 5s) is
// absorbed by the first relaunch instead of costing a wasted turn.
describe('relaunchDelayMs', () => {
  it('waits 5s, then 15s, then 30s before each relaunch', () => {
    expect([relaunchDelayMs(1), relaunchDelayMs(2), relaunchDelayMs(3)]).toEqual([
      5000, 15000, 30000,
    ])
  })

  it('never waits for the first try, nor past the schedule', () => {
    expect(relaunchDelayMs(0)).toBe(0)
    expect(relaunchDelayMs(-1)).toBe(0)
    expect(relaunchDelayMs(4)).toBe(30000) // last entry repeats (unreachable)
  })
})

describe('taskCountedForProgress', () => {
  it('a turn that ran to its end fills the bar', () => {
    for (const outcome of ['done', 'truncated', 'capped']) {
      expect(taskCountedForProgress({ outcome, moved: true })).toBe(true)
    }
  })

  it('a turn whose task file is still in the lot does not', () => {
    expect(taskCountedForProgress({ outcome: 'done', moved: false })).toBe(false)
  })

  it('an inconclusive check still counts: the lot was not told it failed', () => {
    expect(taskCountedForProgress({ outcome: 'done', moved: null })).toBe(true)
  })

  it('a stopped, failed or never-started turn never counts', () => {
    for (const outcome of ['stopped', 'error', 'not-started']) {
      expect(taskCountedForProgress({ outcome, moved: true })).toBe(false)
    }
  })
})

describe('nextBatchAction', () => {
  it('a task file still in the lot is relaunched, with a rising retry number', () => {
    for (let attempt = 0; attempt < MAX_TASK_RETRIES; attempt += 1) {
      expect(
        nextBatchAction({ outcome: 'done', moved: false, attempt, active: true }),
      ).toBe('retry')
    }
  })

  it('once the retry budget is spent the whole lot is aborted', () => {
    expect(
      nextBatchAction({
        outcome: 'done',
        moved: false,
        attempt: MAX_TASK_RETRIES,
        active: true,
      }),
    ).toBe('abort')
  })

  it('a moved task, and an unjudgeable one, let the lot move on', () => {
    for (const moved of [true, null]) {
      expect(
        nextBatchAction({ outcome: 'done', moved, attempt: 0, active: true }),
      ).toBe('next')
    }
  })

  it('Stop outranks a pending retry', () => {
    expect(
      nextBatchAction({
        outcome: 'done',
        moved: false,
        attempt: 0,
        active: false,
      }),
    ).toBe('stopped')
    expect(
      nextBatchAction({
        outcome: 'stopped',
        moved: null,
        attempt: 2,
        active: true,
      }),
    ).toBe('stopped')
  })

  it('a failed turn ends the lot before the completion check can matter', () => {
    for (const outcome of ['error', 'not-started']) {
      expect(
        nextBatchAction({ outcome, moved: false, attempt: 0, active: true }),
      ).toBe('failed')
    }
  })
})

// ---------------------------------------------------------------------------
// The loop, against stubbed routes. `/api/chat` answers every turn with a
// normal `done` frame; `/api/batch/tasks` reports what is *still* in the lot
// folder, which is the only evidence the retry rule reads.

function chatDoneFrame() {
  return 'event: done\ndata: {"tokens":12,"took":1.5,"ttft":0.4,"decode":1.1}\n\n'
}

// A body useChat's reader loop accepts: one chunk holding the frame, then the
// stream ends. jsdom has no ReadableStream, so the reader is the minimal shape
// the loop actually calls.
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

function task(number, name) {
  return { number, name }
}

function listingOf(stillInLot) {
  return {
    dir: 'todos',
    workspace: '/srv/proj',
    prefix: 'ed-',
    taskCount: Math.max(0, ...stillInLot.map((item) => item.number)),
    doneFolder: true,
    lot: null,
    lotNote: null,
    tasks: stillInLot.map((item) => ({
      number: item.number,
      name: item.name,
      size: 40,
      taskLocation: `todos/${item.name}`,
      heading: null,
    })),
    skipped: [],
    truncated: false,
  }
}

// The lot folder as the loop sees it: a set of task files, from which a turn
// removes at most one — the file whose agent moved it into `done/`.
// `movedAfter[number]` is how many turns of that task it takes (Infinity: the
// agent never moves it, the case the retry exists for).
// `modes` is what `GET /api/agents` answers (default: the seeded four);
// `modes: null` makes that fetch fail. `payloads` collects whole /api/chat bodies.
// `poolRefusal` is the sentence `GET /api/workspace` answers 429 with when the
// hub pool will not admit the folder (the ceiling, spec §4.4).
function stubRoutes({
  sent,
  tasks,
  movedAfter = {},
  failListing = false,
  duringTurn = null,
  payloads = null,
  // Absent (undefined) answers the seeded four; `null` makes the fetch fail.
  modes,
  poolRefusal = null,
  workspaceCalls = null,
  // The URL of every `/api/chat` post, so a case can say *which folder* a task
  // turn named. (`payloads` carries the body, and the folder is never in it —
  // spec D9: a query parameter everywhere.)
  chatUrls = null,
  // The URL of every `/api/batch/tasks` read: the launch's own listing and the
  // completion check's re-listing. Both are the lot's own folder's lot, which is
  // what keeps a moved tab from judging A's lot by B's listing (spec §5.7 rule 32).
  listingCalls = null,
}) {
  const stillInLot = tasks.slice()
  const turnsOf = new Map()
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
    const key = String(url)
    if (key.startsWith('/api/workspace')) {
      // The launch's pool gate (clws-09): a read, so it names the lot's folder
      // and answers the pool's sentence — 429 — only when the pool refused it.
      if (workspaceCalls) workspaceCalls.push(key)
      if (poolRefusal) {
        return { ok: false, status: 429, json: async () => ({ detail: poolRefusal }) }
      }
      return { ok: true, json: async () => ({ workspace: LOT_WORKSPACE }) }
    }
    if (key.startsWith('/api/agents')) {
      if (modes === null) {
        return { ok: false, status: 500, json: async () => ({}) }
      }
      return { ok: true, json: async () => modes ?? seededModesBody() }
    }
    if (key.startsWith('/api/chat')) {
      const body = JSON.parse(init.body)
      const instruction = body.messages[0].content
      sent.push(instruction)
      if (payloads) payloads.push(body)
      if (chatUrls) chatUrls.push(key)
      const task = tasks.find((item) =>
        instruction.includes(`todos/${item.name}`),
      )
      if (task) {
        const turns = (turnsOf.get(task.number) ?? 0) + 1
        turnsOf.set(task.number, turns)
        if (turns >= (movedAfter[task.number] ?? 1)) {
          const index = stillInLot.findIndex((item) => item === task)
          if (index !== -1) stillInLot.splice(index, 1)
        }
      }
      if (duringTurn) duringTurn()
      return { ok: true, body: sseBody(chatDoneFrame()) }
    }
    if (key.startsWith('/api/batch/tasks')) {
      if (listingCalls) listingCalls.push(key)
      if (failListing) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ detail: 'Batch folder does not exist: todos' }),
        }
      }
      const payload = listingOf(stillInLot)
      return { ok: true, json: async () => payload }
    }
    throw new Error(`unexpected fetch: ${key}`)
  })
}

async function seedLot(tasks, { agent = 'code' } = {}) {
  batch.listing = listingOf(tasks)
  // A lot runs in the agent the composer's dropdown shows, and refuses to launch
  // when that agent cannot run, so every case that intends to run one starts
  // from the readable list its stub answers *and* a selection that has tools and
  // a model. A case that wants another selection sets it after this call; a case
  // that wants the unreadable list loads `modes: null` itself, and `loaded` then
  // stays false so this cannot mask it.
  if (!agentModes.loaded) await loadAgentModes()
  setAgentMode(agent)
}

// An agents payload in the shape `GET /api/agents` answers since appdb-10. The
// app-owned agent is spelled with a stand-in id here too: this file may not name
// it either, for the same reason `web/src` may not (the scan in
// agentModes.test.js reads the id out of the Python module).
function seededModesBody({ noModelFor = null, chatMcpTools = false } = {}) {
  const rows = [
    {
      id: 'chat',
      label: 'Chat',
      mcpEnable: chatMcpTools,
      lspEnable: false,
      readonly: false,
    },
    { id: 'code', label: 'Code', mcpEnable: true, lspEnable: true, readonly: false },
    { id: 'architect', label: 'Architect', mcpEnable: true, lspEnable: false, readonly: false },
    { id: 'reserved-mode-under-test', label: 'Reserved', mcpEnable: true, lspEnable: false, readonly: true },
  ]
  // The list the composer's dropdown reads: `chat` first, so the agent a lot
  // runs in is never just "the first row" — `seedLot` has to select one, and the
  // cases below prove the turn carries *that* selection.
  return {
    agents: rows.map((row, index) => {
      const modelId = row.id === noModelFor ? null : index + 1
      return {
        ...row,
        maxToolIteration: 25,
        systemMessage: '',
        modelId,
        modelName: modelId === null ? null : `model-${modelId}`,
      }
    }),
    caps: { minToolIteration: 1, maxIdChars: 32 },
    findings: [],
  }
}

//: The folder every lot in this file belongs to — the tab's workspace, which the
//: lot pins at launch (clws-09). A case that moves the tab mid-lot says so.
const LOT_WORKSPACE = '/w/tab-a'

function reset() {
  // The relaunch wait uses a real timer; the loop tests exercise the retry
  // *path*, not wall-clock seconds, so make the timer fire on the next
  // microtask. `restoreMocks` (vitest config) undoes this after each test.
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb) => {
    queueMicrotask(cb)
    return 0
  })
  // The tab's folder, which every batch request names: a lot lists that folder's
  // lot and its turns are about it (spec §5.7 rules 32–33).
  pointTabAt(LOT_WORKSPACE)
  chat.phase = 'idle'
  chat.messages = []
  chat.error = null
  chat.pausePending = false
  chat.session.startedAt = 0
  chat.mcp.loaded = false
  chat.mcp.locked = false
  chat.lsp.loaded = false
  chat.lsp.locked = false
  appShell.activeTab = 'chat'
  batch.active = false
  batch.status = 'idle'
  batch.total = 0
  batch.index = 0
  batch.current = null
  batch.outcomes = []
  batch.error = null
  batch.listing = null
  batch.loading = false
  batch.prefix = 'ed-'
  batch.dir = 'todos'
  batch.pinnedMode = null
  batch.pinnedWorkspace = null
  batch.modeNote = null
  agentModes.modes = []
  agentModes.current = null
  agentModes.loaded = false
  agentModes.findings = []
  agentModes.notice = null
  // The remembered agent is the tab's (§5.5 rule 26): its storage is
  // `sessionStorage`, so that is what a fresh case clears.
  window.sessionStorage.clear()
}

const agentModes = useAgentModes().state

describe('the loop relaunches a task whose file never left the lot', () => {
  beforeEach(reset)

  // The path every lot took before retries existed stays exactly as it was: a
  // task whose file left the folder is never asked about again.
  it('moves on when the task file left the lot folder', async () => {
    const sent = []
    const tasks = [task(1, 'ed-01-a.md'), task(2, 'ed-02-b.md')]
    stubRoutes({ sent, tasks }) // every turn moves its own task file
    await seedLot(tasks)

    await launch()

    expect(sent).toEqual([
      taskInstruction('todos/ed-01-a.md'),
      taskInstruction('todos/ed-02-b.md'),
    ])
    expect(batch.status).toBe('finished')
    expect(batch.index).toBe(2)
    expect(batch.outcomes.map((item) => item.moved)).toEqual([true, true])
    expect(chat.error).toBeNull()
  })

  it('relaunches the task once, then takes the next one', async () => {
    const sent = []
    const tasks = [task(1, 'ed-01-a.md'), task(2, 'ed-02-b.md')]
    // Task 1's agent forgets the move on its first turn and does it on the retry.
    stubRoutes({ sent, tasks, movedAfter: { 1: 2 } })
    await seedLot(tasks)

    await launch()

    expect(sent).toEqual([
      taskInstruction('todos/ed-01-a.md'),
      taskInstructionForAttempt('todos/ed-01-a.md', 1),
      taskInstruction('todos/ed-02-b.md'),
    ])
    expect(batch.status).toBe('finished')
    expect(batch.index).toBe(2)
    // One record per *turn*: the relaunch is what the bar's title reports.
    expect(batch.outcomes).toEqual([
      { number: 1, attempt: 0, outcome: 'done', moved: false },
      { number: 1, attempt: 1, outcome: 'done', moved: true },
      { number: 2, attempt: 0, outcome: 'done', moved: true },
    ])
  })

  it('does not let the bar claim a task it is about to redo', async () => {
    const sent = []
    const tasks = [task(1, 'ed-01-a.md')]
    stubRoutes({ sent, tasks, movedAfter: { 1: 2 } })
    await seedLot(tasks)

    await launch()

    expect(batch.outcomes.map((item) => item.moved)).toEqual([false, true])
    expect(batch.outcomes[0].outcome).toBe('done')
    // The unfinished turn left the bar where it was; the retry filled it.
    expect(batch.index).toBe(1)
  })

  // The budget is what stops the loop, not the model's good intentions: n runs
  // from 1 to MAX_TASK_RETRIES, then the remaining tasks are never started.
  it('aborts the lot once the retry budget is spent', async () => {
    const sent = []
    const tasks = [task(1, 'ed-01-a.md'), task(2, 'ed-02-b.md')]
    // Task 1's file never leaves the folder: context overflow, a dead tool, or
    // an agent that simply will not do the move.
    stubRoutes({ sent, tasks, movedAfter: { 1: Infinity } })
    await seedLot(tasks)

    await launch()

    // The first try plus MAX_TASK_RETRIES relaunches, all about task 1.
    expect(sent).toHaveLength(MAX_TASK_RETRIES + 1)
    for (let attempt = 1; attempt <= MAX_TASK_RETRIES; attempt += 1) {
      expect(sent[attempt]).toBe(
        taskInstructionForAttempt('todos/ed-01-a.md', attempt),
      )
    }
    // Task 2 was never started: the lot is one job.
    expect(sent.every((text) => text.includes('todos/ed-01-a.md'))).toBe(true)
    expect(batch.status).toBe('failed')
    expect(batch.outcomes).toHaveLength(MAX_TASK_RETRIES + 1)
    expect(batch.outcomes.every((item) => item.moved === false)).toBe(true)
    expect(chat.error).toContain('todos/ed-01-a.md')
    expect(chat.error).toContain(String(MAX_TASK_RETRIES))
    // An aborted lot leaves the app launchable again, like any failed one.
    expect(batch.active).toBe(false)
    expect(batch.current).toBeNull()
  })

  // Context overflow (the reply cut short) and tool-iteration overflow both
  // used to let the lot move on (B8/E4): the file staying in the folder is what
  // now says the task is not finished, whatever shape the turn ended in.
  it('relaunches a turn that was cut short and left the file in the lot', async () => {
    const sent = []
    const tasks = [task(1, 'ed-01-a.md'), task(2, 'ed-02-b.md')]
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const key = String(url)
      if (key.startsWith('/api/agents')) {
        return { ok: true, json: async () => seededModesBody() }
      }
      if (key.startsWith('/api/chat')) {
        sent.push(JSON.parse(init.body).messages[0].content)
        // The honest server-cut signal: an `error` frame carrying `truncated`.
        return {
          ok: true,
          body: sseBody(
            'event: token\ndata: {"text":"half an answer"}\n\n' +
              'event: error\ndata: {"message":"stream cut short","truncated":true}\n\n',
          ),
        }
      }
      const payload = listingOf(tasks) // nothing ever moves
      return { ok: true, json: async () => payload }
    })
    await seedLot(tasks)

    await launch()

    expect(sent).toHaveLength(MAX_TASK_RETRIES + 1)
    expect(batch.outcomes.map((item) => item.outcome)).toEqual(
      Array(MAX_TASK_RETRIES + 1).fill('truncated'),
    )
    expect(batch.outcomes.every((item) => item.moved === false)).toBe(true)
    expect(batch.status).toBe('failed')
  })

  // A listing that cannot answer is not evidence of an unfinished task: it must
  // not burn turns relaunching work that was already done.
  it('a listing that fails does not trigger a retry', async () => {
    const sent = []
    const tasks = [task(1, 'ed-01-a.md'), task(2, 'ed-02-b.md')]
    stubRoutes({ sent, tasks, failListing: true })
    await seedLot(tasks)

    await launch()

    expect(sent).toHaveLength(2)
    expect(batch.outcomes.map((item) => item.moved)).toEqual([null, null])
    expect(batch.status).toBe('finished')
    expect(batch.index).toBe(2)
    expect(chat.error).toBeNull()
  })

  // Stop during the turn that left the file in place: relaunching it would be
  // restarting work the user just interrupted.
  it('Stop wins over a pending retry', async () => {
    const sent = []
    const tasks = [task(1, 'ed-01-a.md'), task(2, 'ed-02-b.md')]
    stubRoutes({
      sent,
      tasks,
      movedAfter: { 1: Infinity },
      duringTurn: () => stopBatch(),
    })
    await seedLot(tasks)

    await launch()

    expect(sent).toHaveLength(1)
    expect(batch.outcomes).toEqual([
      { number: 1, attempt: 0, outcome: 'stopped', moved: null },
    ])
    expect(batch.status).toBe('stopped')
    expect(batch.index).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// One rule for every session: a lot runs in the agent the composer's dropdown
// shows. The id is read once at launch and carried by every task turn, so the
// dropdown cannot change anything mid-lot — and a selection that cannot run is
// a launch refusal, never a lot that runs under an agent nobody chose.

describe('the lot runs in the selected agent', () => {
  beforeEach(reset)

  // The reported bug: pick a non-`code` agent in the dropdown, launch a lot.
  // Every task turn must carry *that* agent — the same persona, model and hub
  // gating as a standard session of the same selection.
  it('the agent selected in the dropdown runs every task turn', async () => {
    const sent = []
    const payloads = []
    const tasks = [task(1, 'ed-01-a.md'), task(2, 'ed-02-b.md')]
    stubRoutes({ sent, payloads, tasks })
    await seedLot(tasks, { agent: 'architect' })

    await launch()

    expect(batch.pinnedMode).toBe('architect')
    expect(batch.modeNote).toBeNull()
    expect(payloads).toHaveLength(2)
    for (const payload of payloads) {
      expect(payload.agentMode).toBe('architect')
    }
  })

  // The selection is never a default either: with nothing chosen by hand, the
  // list's first row answers — the same selection a standard session sends.
  it("a lot launched on the list's first agent sends that one", async () => {
    const sent = []
    const payloads = []
    const tasks = [task(1, 'ed-01-a.md')]
    stubRoutes({ sent, payloads, tasks, modes: seededModesBody({ chatMcpTools: true }) })
    await loadAgentModes()
    batch.listing = listingOf(tasks) // no setAgentMode: the first row is selected
    expect(agentModes.current).toBe('chat')

    await launch()

    expect(payloads).toHaveLength(1)
    expect(payloads[0].agentMode).toBe('chat')
  })

  // The reason the selection is held in state and not read per turn: a dropdown
  // change between two turns must not reach the next one.
  it('a dropdown change mid-run cannot reach the next task', async () => {
    const sent = []
    const payloads = []
    const tasks = [task(1, 'ed-01-a.md'), task(2, 'ed-02-b.md')]
    stubRoutes({
      sent,
      payloads,
      tasks,
      // Task 1's turn ends; the human switches agent before task 2 is sent.
      duringTurn: () => setAgentMode('chat'),
    })
    await seedLot(tasks, { agent: 'code' })

    await launch()

    expect(payloads).toHaveLength(2)
    expect(payloads[0].agentMode).toBe('code')
    expect(payloads[1].agentMode).toBe('code')
    expect(agentModes.current).toBe('chat')
  })

  // A selection naming a row the list does not hold (a remembered id after a
  // delete) is a refusal: the app cannot name the agent the lot would run under,
  // and choosing one for the user is exactly what the rule forbids.
  it('an unresolvable selection refuses to launch', async () => {
    const sent = []
    const payloads = []
    const tasks = [task(1, 'ed-01-a.md')]
    stubRoutes({ sent, payloads, tasks })
    await loadAgentModes()
    batch.listing = listingOf(tasks)
    agentModes.current = 'gone-agent'

    await launch()

    expect(sent).toEqual([])
    expect(payloads).toEqual([])
    expect(batch.active).toBe(false)
    expect(batch.pinnedMode).toBeNull()
    expect(chat.error).toContain('selected in the WorkBench dropdown')
    expect(chat.error).toContain('is not one this installation has')
  })

  // The other unresolvable selection: a list that could not be read at all.
  it('an unreadable agent list refuses to launch', async () => {
    const sent = []
    const payloads = []
    const tasks = [task(1, 'ed-01-a.md')]
    stubRoutes({ sent, payloads, tasks, modes: null })
    await loadAgentModes()
    batch.listing = listingOf(tasks)

    await launch()

    expect(sent).toEqual([])
    expect(payloads).toEqual([])
    expect(batch.active).toBe(false)
    expect(batch.pinnedMode).toBeNull()
    expect(chat.error).toContain('could not be read')
  })

  // The selected agent's model is the model every task turn runs on, so a null
  // one stops the lot — with the sentence naming that agent.
  it('a selected agent with no model refuses with the sentence naming it', async () => {
    const sent = []
    const tasks = [task(1, 'ed-01-a.md')]
    stubRoutes({
      sent,
      tasks,
      modes: seededModesBody({ noModelFor: 'architect' }),
    })
    chat.mcp.loaded = true
    chat.mcp.enabled = { fedit: true, console: true }
    await seedLot(tasks, { agent: 'architect' })

    await launch()

    expect(sent).toEqual([])
    expect(batch.active).toBe(false)
    expect(batch.pinnedMode).toBeNull()
    expect(chat.error).toContain('Architect')
    expect(chat.error).toContain('no model')
    expect(chat.error).toContain('assign a model')
  })

  // The agent gate joins the *existing* connector list rather than becoming a
  // second guard, so one message explains one dead lot. Here the connectors are
  // all ticked, so the selected agent's own hub switch is the only thing wrong.
  it('a selected agent with no MCP tools is reported in the launch guard', async () => {
    const sent = []
    const tasks = [task(1, 'ed-01-a.md')]
    stubRoutes({ sent, tasks })
    chat.mcp.loaded = true
    chat.mcp.enabled = { fedit: true, console: true }
    await seedLot(tasks, { agent: 'chat' }) // the tools-off row of the seeded list

    await launch()

    expect(chat.error).toContain('Chat')
    expect(chat.error).toContain('MCP tools')
    // Nothing ran, and no agent was kept for a lot that never launched.
    expect(sent).toEqual([])
    expect(batch.active).toBe(false)
    expect(batch.pinnedMode).toBeNull()
  })

  // ...and it lands in the same sentence as missing connectors — one list, one
  // reason, one place the user learns why Launch did nothing.
  it('a missing connector and a tools-off agent are one message', async () => {
    const sent = []
    const tasks = [task(1, 'ed-01-a.md')]
    stubRoutes({ sent, tasks })
    chat.mcp.loaded = true
    chat.mcp.enabled = { fedit: true, console: false }
    await seedLot(tasks, { agent: 'chat' })

    await launch()

    expect(chat.error).toContain('console')
    expect(chat.error).toContain('Chat')
    // One sentence, not two refusals: the connector list and the agent clause
    // are joined by one "and", and both fixes are in the same tail.
    expect(chat.error.match(/Batch mode needs/g)).toHaveLength(1)
    expect(chat.error.indexOf(' and ') < chat.error.indexOf(' — ')).toBe(true)
    expect(chat.error.split('; ')).toHaveLength(2) // the two fixes, one tail
    expect(sent).toEqual([])
    expect(chat.error).toContain('Settings → MCP')
    expect(chat.error).toContain('dropdown')
  })

  // An agent whose hub is open costs nothing: the guard stays quiet about agents
  // when there is nothing wrong with them.
  it('a tools-on agent passes the guard that the connectors alone pass', async () => {
    const sent = []
    const tasks = [task(1, 'ed-01-a.md')]
    stubRoutes({ sent, tasks })
    chat.mcp.loaded = true
    chat.mcp.enabled = { fedit: true, console: true }
    await seedLot(tasks)

    await launch()

    expect(chat.error).toBeNull()
    expect(sent).toHaveLength(1)
  })

  // The held agent belongs to one run: Restart (B15) forgets it, so the next lot
  // reads the dropdown again.
  it('clearing a run drops the held agent', async () => {
    const sent = []
    const tasks = [task(1, 'ed-01-a.md')]
    stubRoutes({ sent, tasks, movedAfter: { 1: Infinity } })
    await seedLot(tasks, { agent: 'code' })

    await launch()
    expect(batch.pinnedMode).toBe('code')

    useBatch().clearBatchRun()
    expect(batch.pinnedMode).toBeNull()
    expect(batch.modeNote).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The big picture is a fact about the lot, not an option: there is no checkbox
// any more, so a listing that found a 00 file sends it on every task turn, and
// one that found none sends nothing.

describe('the big picture rides automatically', () => {
  beforeEach(reset)

  it('a lot with a 00 file sends its text on every task turn', async () => {
    const sent = []
    const payloads = []
    const tasks = [task(1, 'ed-01-a.md'), task(2, 'ed-02-b.md')]
    stubRoutes({ sent, payloads, tasks })
    await loadAgentModes()
    await seedLot(tasks)
    batch.listing.lot = {
      name: 'ed-00-lot.md',
      path: 'todos/ed-00-lot.md',
      size: 15,
      heading: null,
      text: 'the lot big picture',
    }

    await launch()

    expect(payloads).toHaveLength(2)
    for (const payload of payloads) {
      expect(payload.batchContext).toBe('the lot big picture')
    }
  })

  it('a lot without one sends no batchContext at all', async () => {
    const sent = []
    const payloads = []
    const tasks = [task(1, 'ed-01-a.md')]
    stubRoutes({ sent, payloads, tasks })
    await loadAgentModes()
    await seedLot(tasks) // listingOf() carries lot: null

    await launch()

    expect(payloads).toHaveLength(1)
    expect('batchContext' in payloads[0]).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// A lot's workspace is part of its pin (clws-09, spec §5.7 rules 32–33).
//
// Every request the lot makes names **the folder the run started on**: the task
// turns, the re-listing that judges a task finished, and the pool gate. So a tab
// pointed somewhere else mid-lot re-roots nothing — the same rule the mode pin
// already holds for the agent, read one level wider.

describe('a lot pins the folder it started on', () => {
  beforeEach(reset)

  it('every task turn names the pinned folder, and so does the re-listing', async () => {
    const sent = []
    const chatUrls = []
    const workspaceCalls = []
    const listingCalls = []
    const tasks = [task(1, 'ed-01-a.md'), task(2, 'ed-02-b.md')]
    stubRoutes({
      sent,
      chatUrls,
      tasks,
      workspaceCalls,
      listingCalls,
      // The tab moves once the run has started, so the pin is the lot's from
      // then on and the tab's new folder reaches nothing.
      duringTurn: () => pointTabAt('/w/tab-b'),
    })
    await seedLot(tasks)

    await launch()

    expect(batch.pinnedWorkspace).toBeNull() // released with the run
    expect(chatUrls).toHaveLength(2)
    for (const url of chatUrls) {
      expect(workspaceOf(url)).toBe(LOT_WORKSPACE)
    }
    // The pool gate asked about the same folder, before any turn ran.
    expect(workspaceCalls).toHaveLength(1)
    expect(workspaceOf(workspaceCalls[0])).toBe(LOT_WORKSPACE)
    // ...and so did every completion check's re-listing: the lot judges its own
    // folder's lot, never the folder the tab has since moved to (rule 32).
    expect(listingCalls).toHaveLength(2)
    for (const url of listingCalls) {
      expect(workspaceOf(url)).toBe(LOT_WORKSPACE)
    }
  })

  it('a folder change mid-run reaches no task in the run', async () => {
    const sent = []
    const chatUrls = []
    const tasks = [task(1, 'ed-01-a.md'), task(2, 'ed-02-b.md')]
    stubRoutes({
      sent,
      chatUrls,
      tasks,
      // The human points the tab at another folder before task 2 is sent.
      duringTurn: () => pointTabAt('/w/tab-b'),
    })
    await seedLot(tasks)

    await launch()

    // Both turns name A — the folder the lot started on — even though the tab is
    // on B by the time the second one is posted (spec §5.7 rule 33).
    expect(chatUrls).toHaveLength(2)
    expect(chatUrls.map((url) => workspaceOf(url))).toEqual([
      LOT_WORKSPACE,
      LOT_WORKSPACE,
    ])
    expect(useWorkspaceSession().state.workspace).toBe('/w/tab-b')
  })

  it('the pin is held for the run and only for the run', async () => {
    const sent = []
    const chatUrls = []
    const tasks = [task(1, 'ed-01-a.md')]
    stubRoutes({
      sent,
      chatUrls,
      tasks,
      duringTurn: () => {
        // Mid-turn: the pin is what every later request reads, so it is still
        // there and it is still the folder the run started on.
        expect(batch.pinnedWorkspace).toBe(LOT_WORKSPACE)
        pointTabAt('/w/tab-b')
      },
    })
    await seedLot(tasks)

    await launch()

    // Over: the dialog's next read must list the folder the tab is on now, not
    // the one this run started on (spec §5.7 rule 32).
    expect(batch.pinnedWorkspace).toBeNull()
  })

  it('a lot never launched pins no folder at all', async () => {
    const sent = []
    const tasks = [task(1, 'ed-01-a.md')]
    stubRoutes({ sent, tasks, modes: null }) // the agent list is unreadable
    await loadAgentModes()
    batch.listing = listingOf(tasks)

    await launch()

    expect(sent).toEqual([])
    expect(batch.pinnedWorkspace).toBeNull()
  })

  // Restart/Clear (B15) ends a run for good: a pinned folder left behind would
  // make the next dialog list a folder the tab has left, so it goes with the
  // mode pin — the moment the run is cleared, not only when the run ends.
  it('clearing a run drops the held folder too', async () => {
    const sent = []
    const tasks = [task(1, 'ed-01-a.md')]
    let pinWhenCleared = 'not cleared'
    stubRoutes({
      sent,
      tasks,
      movedAfter: { 1: Infinity },
      duringTurn: () => {
        expect(batch.pinnedWorkspace).toBe(LOT_WORKSPACE) // held mid-run
        useBatch().clearBatchRun() // Restart, with the task streaming
        pinWhenCleared = batch.pinnedWorkspace
        pointTabAt('/w/tab-b')
      },
    })
    await seedLot(tasks)

    await launch()

    expect(pinWhenCleared).toBeNull()
    // With the pin gone, the next read is the tab's own folder again.
    expect(batch.pinnedWorkspace).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The pool gate: a lot cannot start on a folder whose tools are absent.
//
// A workspace the ceiling refused would run every task with no connectors, which
// is a lot that cannot move a single file. The refusal is the **pool's** sentence,
// rendered in the dialog's own message line while the dialog is still open.

describe('a folder the pool refused is a launch refusal', () => {
  beforeEach(reset)

  const CEILING =
    'Too many workspaces are open at once: nojae keeps at most 6 alive, and ' +
    'these are the live ones — /w/a, /w/b. Point another tab away from one of ' +
    'them, or wait for an idle one to be let go.'

  it('the launch refuses with the pool sentence and sends no turn', async () => {
    const sent = []
    const payloads = []
    const tasks = [task(1, 'ed-01-a.md')]
    stubRoutes({ sent, payloads, tasks, poolRefusal: CEILING })
    await seedLot(tasks)

    await launch()

    expect(sent).toEqual([])
    expect(payloads).toEqual([])
    expect(batch.active).toBe(false)
    // Nothing is pinned for a lot that never launched.
    expect(batch.pinnedMode).toBeNull()
    expect(batch.pinnedWorkspace).toBeNull()
    // The server's own sentence, verbatim, on the **dialog's** message line —
    // the client re-spells no rule of its own (spec §5.2 rule 10).
    expect(batch.error).toBe(CEILING)
    expect(batch.error).toContain('at most 6')
  })

  it('the dialog shows it in its message line, and the dialog stays open', async () => {
    const { mount } = await import('@vue/test-utils')
    const { default: BatchModeDialog } = await import('../src/components/BatchModeDialog.vue')
    const sent = []
    const tasks = [task(1, 'ed-01-a.md')]
    stubRoutes({ sent, tasks, poolRefusal: CEILING })
    await loadAgentModes()
    setAgentMode('code')
    batch.listing = listingOf(tasks)
    batch.prefix = 'ed-'
    batch.prefixes = [{ prefix: 'ed-', tasks: 1, hasLot: false }]
    batch.open = true

    const wrapper = mount(BatchModeDialog)
    await wrapper.find('form').trigger('submit')
    await vi.waitFor(() => expect(batch.error).toBe(CEILING))

    // The dialog never closed: the sentence is the user's to act on.
    expect(batch.open).toBe(true)
    expect(wrapper.find('.alert-error').text()).toBe(CEILING)
    expect(sent).toEqual([])
    wrapper.unmount()
  })

  it('a pool that answers anything else does not refuse', async () => {
    const sent = []
    const tasks = [task(1, 'ed-01-a.md')]
    stubRoutes({ sent, tasks }) // 200: the folder is admitted
    await seedLot(tasks)

    await launch()

    expect(sent).toHaveLength(1)
    expect(chat.error).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// "A batch is running" is a fact about **one tab** (spec §5.7 rule 35).
//
// The flag and the two guards registered from it are module state of a per-tab
// composable, so a lot in A blocks nothing in B. jsdom has one `window` and
// therefore one module instance, so — the way `agentModes.test.js` simulates its
// second tab — the second tab here is a **reset of this module's state**: what
// the assertion owns is that the guard's answer follows the flag rather than
// some process-wide fact, and that one tab's run leaves the other's send, tab
// switch and lot reachable. The real two-tab run is the e2e suite's (task 12).

describe("two tabs' batch guards are independent", () => {
  beforeEach(reset)

  // A **real** lot, not a hand-set flag: the case is about what a streaming
  // lot does to the guards the rest of the app reads, so it runs one.
  // `movedAfter: Infinity` keeps its task in the lot, and `duringTurn` runs
  // inside the turn — the only moment the flags are what a running lot means.
  async function runOneLot(duringTurn) {
    stubRoutes({
      sent: [],
      tasks: [task(1, 'ed-01-a.md')],
      movedAfter: { 1: Infinity },
      duringTurn,
    })
    await seedLot([task(1, 'ed-01-a.md')])
    await launch()
  }

  it('this tab refuses an interactive send and a tab switch while its lot runs', async () => {
    let bodyBusy = null
    let tabsPinned = null
    await runOneLot(() => {
      bodyBusy = useChat().chatBusy()
      // The tab switch the app bar's buttons and the keyboard both go through.
      useAppShell().setTab('editor')
      tabsPinned = appShell.activeTab
    })

    expect(bodyBusy).toBe(true)
    expect(tabsPinned).toBe('chat') // pinned by this tab's own run
  })

  it("the other tab's guards let everything through", async () => {
    await runOneLot()

    // The second tab is a **fresh module state** — no lot of its own, which is
    // what `reset()` above leaves behind. Nothing of A's run is in it, so its
    // send is free, its tab switch is allowed, and a lot of its own may launch
    // (spec §5.7 rule 35): "a batch is running" never became a fact about the
    // app that A's run could leave behind.
    expect(batch.active).toBe(false)
    expect(useChat().chatBusy()).toBe(false)
    useAppShell().setTab('editor')
    expect(appShell.activeTab).toBe('editor')

    // B then launches its own lot: a fresh module state is a fresh conversation
    // too (the transcript is the tab's, like the folder), so B wipes it the way
    // Restart does and starts on its own folder. Nothing of A's run refuses it.
    useChat().reset({ refetchHubs: false })
    const sent = []
    stubRoutes({ sent, tasks: [task(1, 'ed-01-a.md')] })
    pointTabAt('/w/tab-b')
    await seedLot([task(1, 'ed-01-a.md')])
    await launch()

    expect(sent).toHaveLength(1)
    expect(batch.error).toBeNull()
  })
})
