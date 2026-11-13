import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  bulletColor,
  bulletNumber,
  capViolation,
  isFilled,
  newBulletColor,
  usePromptHelpers,
} from '../src/composables/usePromptHelpers'
import { useAppShell } from '../src/composables/useAppShell'
import App from '../src/App.vue'
import MemoryBullets from '../src/components/MemoryBullets.vue'
import RegistrationMemoryDlg from '../src/components/RegistrationMemoryDlg.vue'
import { useWorkspaceTree } from '../src/composables/useWorkspaceTree'

// Layer 1 (jsdom): the bullet row's own store, after appdb-07 moved the bullets
// into ``nojae.db``. What is pinned here is §5.3's UI claim — the row renders
// **as many bullets as the store holds**, so the client holds no count of its
// own and invents no slots: the state is an empty list until the first read, and
// a read that answers zero rows leaves it empty.
//
// The stubbed payloads mirror what the routes answer: ``GET /api/prompt-helpers``
// adds ``caps`` to the rows, and the three writes each answer the whole new list.

const {
  state,
  loadPromptHelpers,
  savePromptHelper,
  addPromptHelper,
  deletePromptHelper,
} = usePromptHelpers()

const CAPS = { contentMaxChars: 32000, defaultColor: '#808080' }

function jsonResponse(body, ok = true, status = 200) {
  return Promise.resolve({ ok, status, json: () => Promise.resolve(body) })
}

function rows(count, first = '') {
  return Array.from({ length: count }, (_, i) => ({
    id: i + 1,
    color: i === 0 ? '#2ec27e' : '#808080',
    content: i === 0 ? first : '',
  }))
}

function readBody(count = 9, first = 'a') {
  return { slots: rows(count, first), caps: CAPS }
}

function resetState() {
  state.slots = []
  state.caps = null
  state.loaded = false
  state.saving = false
  state.error = null
}

// jsdom has no `showModal`/`close` on `<dialog>`, so both are patched on the
// prototype — the same patch every dialog suite in this folder makes, for the
// same reason: the bullet form's open/close is driven by them.
Element.prototype.showModal = function showModal() {
  this.open = true
}
Element.prototype.close = function close() {
  this.open = false
}

describe('the client holds no count', () => {
  beforeEach(resetState)

  it('exports no slot-count constant at all', async () => {
    const module = await import('../src/composables/usePromptHelpers')
    expect(
      Object.keys(module).filter((name) => name.includes('SLOT')),
    ).toEqual([])
    expect(module.PROMPT_HELPER_CONTENT_MAX_CHARS).toBeUndefined()
  })

  it('starts from an empty list, not nine invented slots', () => {
    resetState()
    expect(state.slots).toEqual([])
    expect(state.loaded).toBe(false)
  })

  it('takes the count from the read, whatever it is', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => jsonResponse(readBody(4)))
    await loadPromptHelpers()
    expect(state.slots).toHaveLength(4)
    expect(state.loaded).toBe(true)
  })

  it('answers zero rows as zero bullets, not as a fallback nine', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse({ slots: [], caps: CAPS }),
    )
    await loadPromptHelpers()
    expect(state.slots).toEqual([])
    expect(state.error).toBeNull()
  })

  it('learns the cap from the payload', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => jsonResponse(readBody()))
    await loadPromptHelpers()
    expect(state.caps).toEqual(CAPS)
    expect(capViolation('x'.repeat(CAPS.contentMaxChars))).toBeNull()
    expect(capViolation('x'.repeat(CAPS.contentMaxChars + 1))).toContain('32000')
  })

  it('a 422 naming the store leaves the list as it was and says why', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse({ detail: "nojae's settings store at /srv/app/nojae.db cannot be read" }, false, 422),
    )
    await loadPromptHelpers()
    expect(state.slots).toEqual([])
    expect(state.error).toContain('cannot be read')
  })

  it('an unreachable API is an error too, not an empty row', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => Promise.reject(new Error('down')))
    await loadPromptHelpers()
    expect(state.error).toContain('Could not reach the API')
  })
})

describe('add and delete', () => {
  beforeEach(async () => {
    resetState()
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => jsonResponse(readBody()))
    await loadPromptHelpers()
    vi.restoreAllMocks()
  })

  it('add posts the new bullet and replaces the list with the answer', async () => {
    const next = [...rows(9, 'a'), { id: 10, color: '#ff0000', content: 'new' }]
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse({ slots: next }))

    const slots = await addPromptHelper('#ff0000', 'new')

    expect(fetchSpy.mock.calls[0][0]).toBe('/api/prompt-helpers/add')
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      color: '#ff0000',
      content: 'new',
    })
    expect(slots).toHaveLength(10)
    expect(state.slots).toHaveLength(10)
  })

  it('delete posts the id and drops the row from the list', async () => {
    const next = rows(9, 'a').filter((row) => row.id !== 3)
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse({ slots: next }))

    const slots = await deletePromptHelper(3)

    expect(fetchSpy.mock.calls[0][0]).toBe('/api/prompt-helpers/delete')
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({ id: 3 })
    expect(slots.map((row) => row.id)).toEqual([1, 2, 4, 5, 6, 7, 8, 9])
  })

  it('save addresses a bullet by its id, not by its position', async () => {
    const next = rows(9, 'a').map((row) =>
      row.id === 4 ? { ...row, color: '#0000ff', content: 'edited' } : row,
    )
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse({ slots: next }))

    await savePromptHelper(4, '#0000ff', 'edited')

    expect(fetchSpy.mock.calls[0][0]).toBe('/api/prompt-helpers/save')
    expect(JSON.parse(fetchSpy.mock.calls[0][1].body)).toEqual({
      id: 4,
      color: '#0000ff',
      content: 'edited',
    })
  })

  it('a 404 on a stale id is an error the dialog can show', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse({ detail: 'no prompt helper with id 999 — it cannot be saved' }, false, 404),
    )

    expect(await savePromptHelper(999, '#ff0000', 'x')).toBeNull()
    expect(state.error).toContain('999')
  })

  it('the cap is checked before the request, in the server\'s words', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    state.caps = { contentMaxChars: 5, defaultColor: '#808080' }

    expect(await addPromptHelper('#ff0000', 'too long')).toBeNull()
    expect(state.error).toContain('5 character cap')
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})

describe('the drawing rules live in the composable', () => {
  beforeEach(resetState)

  it('numbers a bullet by its position', () => {
    expect(bulletNumber(0)).toBe(1)
    expect(bulletNumber(11)).toBe(12)
  })

  it('draws an empty bullet gray whatever colour its row carries', () => {
    expect(isFilled({ color: '#ff0000', content: '' })).toBe(false)
    expect(bulletColor({ color: '#ff0000', content: '' })).toBe('#808080')
    expect(isFilled({ color: '#ff0000', content: 'x' })).toBe(true)
    expect(bulletColor({ color: '#ff0000', content: 'x' })).toBe('#ff0000')
  })

  it('starts a new bullet on the store\'s colour', () => {
    expect(newBulletColor()).toBe('#808080')
    state.caps = { contentMaxChars: 10, defaultColor: '#123456' }
    expect(newBulletColor()).toBe('#123456')
  })
})

// The row itself: N buttons for N rows, wrapping (the layout rule §5.3 asks
// for), and the "+" that keeps the dialog reachable when the store holds none.
describe('MemoryBullets renders the store', () => {
  beforeEach(resetState)

  it('draws as many bullets as the list holds, numbered by position', () => {
    state.slots = rows(13, 'keep')
    const wrapper = mount(MemoryBullets)

    const bullets = wrapper.findAll('.memory-bullet')
    expect(bullets).toHaveLength(13)
    expect(bullets[0].text()).toBe('1')
    expect(bullets[12].text()).toBe('13')
    wrapper.unmount()
  })

  it('asks for a bullet by its id, so a delete cannot aim at the wrong row', async () => {
    state.slots = rows(3, 'keep')
    const wrapper = mount(MemoryBullets)

    await wrapper.findAll('.memory-bullet')[1].trigger('click', { ctrlKey: true })

    expect(wrapper.emitted('configure')[0]).toEqual([2])
    wrapper.unmount()
  })

  it('shows a single add affordance when the store holds nothing', () => {
    state.slots = []
    const wrapper = mount(MemoryBullets)

    // The "+" is the only thing in the row, and it carries the bullet's own
    // class so it is drawn as one — so "no bullets" is counted without it.
    expect(wrapper.findAll('.memory-bullet:not(.memory-bullet-add)')).toHaveLength(0)
    const add = wrapper.find('.memory-bullet-add')
    expect(add.exists()).toBe(true)
    add.trigger('click')
    expect(wrapper.emitted('configure')[0]).toEqual([null])
    wrapper.unmount()
  })

  it('does not add a second affordance once there are bullets', () => {
    state.slots = rows(2)
    const wrapper = mount(MemoryBullets)

    expect(wrapper.find('.memory-bullet-add').exists()).toBe(false)
    wrapper.unmount()
  })
})

// The dialog's two new buttons (§5.3): adding and deleting are reachable without
// leaving the app, and a delete asks first.
describe('RegistrationMemoryDlg adds and deletes', () => {
  beforeEach(resetState)

  it('offers Add bullet and Delete this bullet for an existing row', () => {
    state.slots = rows(2, 'keep')
    const wrapper = mount(RegistrationMemoryDlg, { props: { open: true, helperId: 1 } })

    expect(wrapper.get('#memory-dlg-title').text()).toBe('Memory bullet 1')
    expect(wrapper.find('.memory-bullet-add').exists()).toBe(true)
    expect(wrapper.find('.memory-bullet-delete').exists()).toBe(true)
    wrapper.unmount()
  })

  it('offers no delete for a bullet that does not exist yet', () => {
    state.slots = rows(2, 'keep')
    const wrapper = mount(RegistrationMemoryDlg, { props: { open: true, helperId: null } })

    expect(wrapper.get('#memory-dlg-title').text()).toBe('New memory bullet')
    expect(wrapper.find('.memory-bullet-delete').exists()).toBe(false)
    expect(wrapper.find('button[type="submit"]').text()).toBe('Add')
    wrapper.unmount()
  })

  it('asks before deleting, and only posts on a yes', async () => {
    state.slots = rows(2, 'keep')
    const confirmSpy = vi.spyOn(window, 'confirm').mockImplementation(() => false)
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const wrapper = mount(RegistrationMemoryDlg, { props: { open: true, helperId: 2 } })

    await wrapper.find('.memory-bullet-delete').trigger('click')
    expect(confirmSpy).toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()

    confirmSpy.mockImplementation(() => true)
    vi.spyOn(globalThis, 'fetch').mockImplementation(() =>
      jsonResponse({ slots: rows(2, 'keep').filter((row) => row.id !== 2) }),
    )
    await wrapper.find('.memory-bullet-delete').trigger('click')
    await flushPromises()
    expect(fetchSpy.mock.calls.some(([url]) => url === '/api/prompt-helpers/delete')).toBe(true)
    wrapper.unmount()
  })

  it('Add hands the parent the request to open a new form', async () => {
    state.slots = rows(2, 'keep')
    const wrapper = mount(RegistrationMemoryDlg, { props: { open: true, helperId: 1 } })

    await wrapper.find('.memory-bullet-add').trigger('click')

    expect(wrapper.emitted('add')).toHaveLength(1)
    wrapper.unmount()
  })
})

// The bullets are install state now (D11), so the switch that used to reload
// them must not: the row is fetched once, at boot, and a workspace change
// leaves the user's own habits where they are.
describe('a working-location switch leaves the bullets alone', () => {
  const { setPathLocation } = useAppShell()
  const appShell = useAppShell().state

  beforeEach(() => {
    vi.restoreAllMocks()
    resetState()
    appShell.pathLocation = '/srv/new'
    appShell.pathLocationCurrent = '/srv/old'
    appShell.pathLocationSaving = false
    appShell.pathLocationError = null
    appShell.pathLocationPolicyNote = null
    const tree = useWorkspaceTree()
    tree.state.nodes = {}
    tree.state.expanded = { '': true }
  })

  it('makes no helper request of its own', async () => {
    let slotOne = 'old workspace'
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((url, options) => {
      const key = String(url)
      if (key === '/api/path-location' && options?.method === 'POST') {
        return jsonResponse({
          key: 'NOJAE_PATH_LOCATION',
          path: '/srv/new',
          default: '/srv/app',
          mcp: { installed: true, connectors: [], externalsError: null },
          lsp: { installed: true, servers: [], serversError: null },
          policy: { state: 'created', path: '/srv/new/.nojae/read-write-policy.json', error: null },
        })
      }
      if (key === '/api/prompt-helpers') return jsonResponse(readBody(9, slotOne))
      if (key.startsWith('/api/fs/')) {
        return jsonResponse({ path: '', workspace: '/srv/new', entries: [], truncated: false })
      }
      return jsonResponse({})
    })

    await loadPromptHelpers()
    expect(state.slots[0].content).toBe('old workspace')

    slotOne = 'new workspace'
    await setPathLocation()
    await flushPromises()

    // The switch happened, and the bullets it cannot see stayed put.
    expect(appShell.pathLocationCurrent).toBe('/srv/new')
    expect(state.slots[0].content).toBe('old workspace')
    expect(
      fetchSpy.mock.calls.filter(([url]) => String(url) === '/api/prompt-helpers'),
    ).toHaveLength(1)
  })
})

// The chat tab is the app's default screen, so nothing waits for a tab switch:
// the boot fetch is the row's first fill.
describe('the chat tab landing first-fills the bullets', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    resetState()
    useAppShell().state.activeTab = 'chat'
  })

  it('fetches the bullets on boot, with no tab switch', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() => jsonResponse(readBody(9, 'boot')))

    // Only the shell is under test, so every child view is stubbed: none of the
    // bullets' siblings should be needed for the boot-time fetch.
    const wrapper = mount(App, {
      global: {
        stubs: {
          AppBar: true,
          SettingsDialog: true,
          BatchModeDialog: true,
          WorkBenchView: true,
        },
      },
    })
    await flushPromises()

    expect(state.loaded).toBe(true)
    expect(state.slots[0].content).toBe('boot')
    expect(fetchSpy.mock.calls.some(([url]) => String(url) === '/api/prompt-helpers')).toBe(true)
    wrapper.unmount()
  })
})
