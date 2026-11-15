import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'

import BatchModeDialog from '../src/components/BatchModeDialog.vue'
import { NO_BATCH_ITEMS_MESSAGE, useBatch } from '../src/composables/useBatch'
import { useChat } from '../src/composables/useChat'
import { pointTabAt, workspaceOf } from './helpers/workspace-url'

// The lot is *chosen*, not typed: the dialog offers one option per prefix that
// has a task in the lot folder, so a lot that cannot launch is never offered.
// The prefix list is therefore the server's answer (GET /api/batch/prefixes),
// and the dialog keeps no prefix knowledge of its own.
//
// **The folder is the tab's** (clws-09): both reads name it on the query string,
// so opening the dialog in tab A lists A's lot and a folder B tab offers B's. The
// dialog re-reads on open, and that re-read is what keeps a stale lot from being
// launched after the tab has moved (spec §5.7 rule 32).

const batch = useBatch().state
const chat = useChat().state

//: The folder the tab in this file is on. Every numbered case starts here; the
//: two-folder cases point the tab somewhere else and prove the list followed.
const TAB_A = '/w/project-a'
const TAB_B = '/w/project-b'

function prefixEntry(prefix, tasks, hasLot = false) {
  return { prefix, tasks, hasLot }
}

function listingBody({ prefix = 'doc-', tasks = [], lot = null, lotNote = null } = {}) {
  return {
    dir: 'todos',
    workspace: '/srv/proj',
    prefix,
    taskCount: Math.max(0, ...tasks.map((item) => item.number)),
    doneFolder: true,
    lot,
    lotNote,
    tasks,
    skipped: [],
    truncated: false,
  }
}

function taskEntry(number, name) {
  return {
    number,
    name,
    size: 40,
    taskLocation: `todos/${name}`,
    heading: null,
  }
}

// `prefixes` is the /api/batch/prefixes answer (null: the fetch fails);
// `listing` is the /api/batch/tasks answer. Both are recorded so a test can say
// *which* folder was listed and with which prefix.
function stubRoutes({ prefixes = [], listing = null, prefixCalls = [], taskCalls = [] }) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const key = String(url)
    if (key.startsWith('/api/batch/prefixes')) {
      prefixCalls.push(key)
      if (prefixes === null) {
        return {
          ok: false,
          status: 404,
          json: async () => ({ detail: 'Batch folder does not exist: todos' }),
        }
      }
      return { ok: true, json: async () => ({ dir: 'todos', prefixes }) }
    }
    if (key.startsWith('/api/batch/tasks')) {
      taskCalls.push(key)
      return { ok: true, json: async () => listing ?? listingBody() }
    }
    throw new Error(`unexpected fetch: ${key}`)
  })
}

function reset() {
  vi.restoreAllMocks()
  // Every batch request names the tab's folder, so each case says which one it
  // is on before it asks anything (spec §5.7 rule 32).
  pointTabAt(TAB_A)
  chat.phase = 'idle'
  chat.messages = []
  chat.error = null
  batch.open = false
  batch.prefix = ''
  batch.dir = 'todos'
  batch.prefixes = []
  batch.prefixesLoading = false
  batch.listing = null
  batch.loading = false
  batch.error = null
  batch.active = false
  batch.status = 'idle'
  batch.pinnedMode = null
  batch.pinnedWorkspace = null
}

describe('the prefix dropdown', () => {
  beforeEach(reset)

  it('offers one option per prefix the folder holds', async () => {
    stubRoutes({
      prefixes: [prefixEntry('doc-', 3, true), prefixEntry('oth-', 1)],
    })
    const { refreshLot } = useBatch()
    await refreshLot()

    const wrapper = mount(BatchModeDialog)
    const options = wrapper.findAll('select option')
    // The first is the placeholder; the lots come after it.
    expect(options).toHaveLength(3)
    expect(options[1].text()).toContain('doc-')
    expect(options[1].text()).toContain('3 tasks')
    expect(options[2].text()).toContain('oth-')
    expect(options[2].text()).toContain('1 task')
    wrapper.unmount()
  })

  it('lists the prefixes of the folder the field names', async () => {
    const prefixCalls = []
    stubRoutes({ prefixes: [], prefixCalls })
    batch.dir = 'work/todos'
    const { refreshLot } = useBatch()
    await refreshLot()

    expect(prefixCalls).toHaveLength(1)
    expect(prefixCalls[0]).toContain('dir=work%2Ftodos')
  })

  it('a folder that cannot be listed is an error, not an empty list', async () => {
    stubRoutes({ prefixes: null })
    const { refreshLot } = useBatch()
    await refreshLot()

    expect(batch.prefixes).toEqual([])
    expect(batch.error).toContain('Batch folder does not exist')
    // The "no batch items" sentence would be a lie about a folder the app could
    // not open, so it stays hidden while the error line speaks.
    const wrapper = mount(BatchModeDialog)
    expect(wrapper.text()).not.toContain('There is no existing batch items')
    expect(wrapper.find('.alert-error').text()).toContain('does not exist')
    wrapper.unmount()
  })

  it('a prefix whose lot is gone is dropped from the selection', async () => {
    batch.prefix = 'ed-'
    batch.listing = listingBody({ tasks: [taskEntry(1, 'ed-01-a.md')] })
    stubRoutes({ prefixes: [prefixEntry('doc-', 2)] })
    const { refreshLot } = useBatch()
    await refreshLot()

    // The stale choice and the listing built from it are both gone: Launch would
    // otherwise run a lot the folder no longer holds.
    expect(batch.prefix).toBe('')
    expect(batch.listing).toBeNull()
  })

  it('a prefix that survived the re-fetch keeps its listing', async () => {
    batch.prefix = 'doc-'
    const taskCalls = []
    stubRoutes({ prefixes: [prefixEntry('doc-', 2)], taskCalls })
    const { refreshLot } = useBatch()
    await refreshLot()

    expect(batch.prefix).toBe('doc-')
    // The count is re-read too: a task moved into done/ must not be launchable
    // a second time off a stale listing.
    expect(taskCalls).toHaveLength(1)
  })

  it('picking an option lists that lot', async () => {
    const taskCalls = []
    stubRoutes({
      prefixes: [prefixEntry('doc-', 2), prefixEntry('oth-', 1)],
      listing: listingBody({ prefix: 'oth-', tasks: [taskEntry(1, 'oth-01-c.md')] }),
      taskCalls,
    })
    const { refreshLot } = useBatch()
    await refreshLot()
    const wrapper = mount(BatchModeDialog)
    await wrapper.find('select').setValue('oth-')
    await vi.waitFor(() => expect(taskCalls).toHaveLength(1))

    expect(batch.prefix).toBe('oth-')
    expect(taskCalls[0]).toContain('prefix=oth-')
    expect(wrapper.text()).toContain('Found tasks 1')
    wrapper.unmount()
  })

  it('says what to do when the folder holds no batch item', async () => {
    stubRoutes({ prefixes: [] })
    const { refreshLot } = useBatch()
    await refreshLot()

    const wrapper = mount(BatchModeDialog)
    expect(wrapper.text()).toContain(NO_BATCH_ITEMS_MESSAGE)
    expect(wrapper.text()).toContain('Todo builder agent')
    // Nothing to choose and nothing to launch.
    expect(wrapper.find('select').exists()).toBe(false)
    expect(wrapper.find('button[type="submit"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
})

describe("the dialog lists the tab's folder", () => {
  beforeEach(reset)

  it('both reads name the tab workspace on the query string', async () => {
    const prefixCalls = []
    const taskCalls = []
    // The prefix survives the re-fetch, so both reads really happen: the option
    // list first, then the lot the surviving selection names.
    stubRoutes({ prefixes: [prefixEntry('doc-', 1)], prefixCalls, taskCalls })
    batch.prefix = 'doc-'
    const { refreshLot } = useBatch()
    await refreshLot()

    // The folder travels as a query parameter, never in `dir` (spec D9): `dir`
    // is a folder *inside* the workspace, and the two are different fields.
    expect(prefixCalls).toHaveLength(1)
    expect(workspaceOf(prefixCalls[0])).toBe(TAB_A)
    expect(prefixCalls[0]).toContain('dir=todos')
    expect(taskCalls).toHaveLength(1)
    expect(workspaceOf(taskCalls[0])).toBe(TAB_A)
    expect(taskCalls[0]).toContain('dir=todos')
  })

  it('a folder B tab offers B prefixes, never A ones', async () => {
    const prefixCalls = []
    stubRoutes({ prefixes: [prefixEntry('beta-', 2)], prefixCalls })
    pointTabAt(TAB_B)
    const { refreshLot } = useBatch()
    await refreshLot()

    expect(workspaceOf(prefixCalls[0])).toBe(TAB_B)
    expect(batch.prefixes.map((item) => item.prefix)).toEqual(['beta-'])
  })

  it('a folder change re-reads instead of reusing the list', async () => {
    const prefixCalls = []
    // A on the first read, B on the second: one stub, two folders.
    let call = 0
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const key = String(url)
      if (!key.startsWith('/api/batch/prefixes')) {
        throw new Error(`unexpected fetch: ${key}`)
      }
      prefixCalls.push(key)
      call += 1
      const prefixes = call === 1
        ? [prefixEntry('alpha-', 3, true)]
        : [prefixEntry('beta-', 1)]
      return { ok: true, json: async () => ({ dir: 'todos', prefixes }) }
    })
    const { refreshLot, openDialog } = useBatch()

    // Tab A opens the dialog: A's lots.
    openDialog()
    await vi.waitFor(() => expect(batch.prefixes).toHaveLength(1))
    expect(batch.prefixes[0].prefix).toBe('alpha-')
    expect(workspaceOf(prefixCalls[0])).toBe(TAB_A)

    // The user points the tab at B and opens the dialog again. The list is
    // re-read — it is not carried across the folder change, which is what keeps
    // a stale lot from being launched off a list belonging to another folder.
    pointTabAt(TAB_B)
    await refreshLot()
    expect(workspaceOf(prefixCalls[1])).toBe(TAB_B)
    expect(batch.prefixes.map((item) => item.prefix)).toEqual(['beta-'])
  })

  it('a launch pins the folder it started on, and a later change lists the new one', async () => {
    const prefixCalls = []
    stubRoutes({ prefixes: [prefixEntry('doc-', 1)], prefixCalls })
    const { refreshLot } = useBatch()
    await refreshLot()

    // Pinned by a launch: every later read of the lot names A, even though the
    // tab has moved to B in the meantime (spec §5.7 rule 33).
    batch.pinnedWorkspace = TAB_A
    pointTabAt(TAB_B)
    await refreshLot()
    expect(workspaceOf(prefixCalls[1])).toBe(TAB_A)

    // Once the run is over the pin is gone, so the dialog lists the tab's own
    // folder again — B — and offers B's lot (spec §5.7 rule 32).
    batch.pinnedWorkspace = null
    await refreshLot()
    expect(workspaceOf(prefixCalls[2])).toBe(TAB_B)
  })
})

describe('the dialog no longer asks', () => {
  beforeEach(reset)

  it('has no big-picture checkbox — a 00 file is always included', async () => {
    stubRoutes({ prefixes: [prefixEntry('doc-', 2, true)] })
    const { refreshLot } = useBatch()
    await refreshLot()
    batch.listing = listingBody({
      tasks: [taskEntry(1, 'doc-01-a.md')],
      lot: { name: 'doc-00-lot.md', path: 'todos/doc-00-lot.md', size: 20, heading: null, text: 'the big picture' },
    })

    const wrapper = mount(BatchModeDialog)
    expect(wrapper.find('input[type="checkbox"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Include the big picture')
    // The lot is still reported, as a fact rather than a choice.
    expect(wrapper.text()).toContain('big picture: doc-00-lot.md')
    wrapper.unmount()
  })

  it('has no explanatory paragraph about the retry budget', async () => {
    stubRoutes({ prefixes: [prefixEntry('doc-', 2)] })
    const { refreshLot } = useBatch()
    await refreshLot()

    const wrapper = mount(BatchModeDialog)
    expect(wrapper.text()).not.toContain('one task per chat turn')
    expect(wrapper.text()).not.toContain('relaunched')
    // What the form needs is still there: the folder field and the count line.
    expect(wrapper.find('input[type="text"]').exists()).toBe(true)
    expect(wrapper.find('#batch-count').exists()).toBe(true)
    wrapper.unmount()
  })
})
