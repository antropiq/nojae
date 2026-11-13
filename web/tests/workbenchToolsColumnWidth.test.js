import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

// The Chat left column's width is the two tool panels' width, and it is fixed.
//
// A fresh workspace has no `.nojae/lsp-settings.json`: the app seeds only the
// template there, never the declaration (see `core/lsphub/seed.py`), so the LSP
// hub answers with nothing. The column used to narrow to one panel's width in
// that case and the reasoning timeline lost half of it. What is pinned here is
// the opposite contract: the panels, the dock body that holds them, its
// splitter and the column's width are all independent of what the hub
// declaration files hold. A hub with nothing declared is a panel that says so,
// never a panel that leaves the dock.
//
// jsdom lays nothing out and loads no stylesheet, so the real widths belong to
// the Playwright half. What this file can assert is the DOM handed to the CSS
// (the column carries no width variant) and the shipped rules themselves.
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

import WorkBenchView from '../src/components/WorkBenchView.vue'
import WorkBenchMcpPanel from '../src/components/WorkBenchMcpPanel.vue'
import WorkBenchLspPanel from '../src/components/WorkBenchLspPanel.vue'
import { useChat } from '../src/composables/useChat'

const { state: chat } = useChat()

function hubs({ mcp = false, lsp = false }) {
  chat.mcp.loaded = mcp
  chat.mcp.connectors = mcp ? [{ id: 'console', label: 'Console', status: 'running' }] : []
  chat.mcp.enabled = mcp ? { console: true } : {}
  chat.lsp.loaded = lsp
  chat.lsp.servers = lsp ? [{ id: 'pyright', label: 'Pyright', status: 'running' }] : []
  chat.lsp.enabled = lsp ? { pyright: true } : {}
  chat.phase = 'idle'
}

// The four states a workspace's two hub declaration files can be in. Only the
// last one is a fresh install, but the column must not answer to any of them.
const HUB_CASES = [
  ['both hubs declared', { mcp: true, lsp: true }],
  ['MCP only', { mcp: true }],
  ['LSP only', { lsp: true }],
  ['neither (a fresh workspace)', {}],
]

function themeCss() {
  return readFileSync(join(resolve(), 'src', 'styles', 'theme.css'), 'utf8')
}

// One selector list per rule block, comments removed first: this stylesheet
// documents these classes in prose, and a scan that reads a comment as a
// selector would be asserting on documentation instead of on a rule.
function ruleSelectors(css) {
  return [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{/g)].map((match) =>
    match[1].replace(/\s+/g, ' ').trim(),
  )
}

beforeEach(() => {
  window.localStorage.clear()
  hubs({ mcp: true, lsp: true })
})

afterEach(() => {
  window.localStorage.clear()
  hubs({})
})

describe('the tools dock always has its body', () => {
  for (const [label, hub] of HUB_CASES) {
    it(`renders both panels side by side with ${label}`, () => {
      hubs(hub)
      const w = mount(WorkBenchView)

      const body = w.find('.chat-tools-dock-body')
      expect(body.exists(), 'the dock keeps its body').toBe(true)
      expect(body.find('.chat-mcp-panel').exists()).toBe(true)
      expect(body.find('.chat-lsp-panel').exists()).toBe(true)
      // The dock starts expanded, so the bar that sizes it is there too.
      expect(w.find('.chat-col-resizer').exists()).toBe(true)
      expect(w.find('.chat-tools-dock-toggle').exists()).toBe(true)
      w.unmount()
    })
  }

  // The fold is the only thing the dock's contents decide about the layout, and
  // it answers to the flag alone: with nothing declared the strip is still
  // foldable, so the control is never a button pretending it has no body.
  it('folds and unfolds with nothing declared', async () => {
    hubs({})
    const w = mount(WorkBenchView)
    const btn = w.find('.chat-tools-dock-toggle')

    expect(btn.attributes()['aria-expanded']).toBe('true')
    await btn.trigger('click')
    expect(w.vm.dockCollapsed).toBe(true)
    expect(w.find('.chat-tools-dock-body').exists()).toBe(false)
    expect(w.find('.chat-col-resizer').exists()).toBe(false)

    await w.find('.chat-tools-dock-toggle').trigger('click')
    expect(w.vm.dockCollapsed).toBe(false)
    expect(w.find('.chat-tools-dock-body').exists()).toBe(true)
    w.unmount()
  })

  // Folded with nothing switched on, the strip has no counts to carry, and an
  // empty `role="status"` would be announced as a change that says nothing.
  it('leaves the folded strip without an empty summary', async () => {
    hubs({})
    const w = mount(WorkBenchView)
    await w.find('.chat-tools-dock-toggle').trigger('click')

    expect(w.find('.chat-tools-dock-summary').exists()).toBe(false)
    expect(w.find('.chat-tools-dock-head').exists()).toBe(true)
    w.unmount()
  })
})

describe('the column carries no width variant', () => {
  for (const [label, hub] of HUB_CASES) {
    it(`names the left column the same way with ${label}`, () => {
      hubs(hub)
      const w = mount(WorkBenchView)
      expect(w.find('.chat-col--left').classes()).toEqual(['chat-col', 'chat-col--left'])
      w.unmount()
    })
  }

  // The variant that used to halve the column is gone from both sides: no rule
  // targets it, and the template never puts it on the element. A leftover rule
  // nobody targets would be a second width waiting to be re-targeted, so what
  // is asserted is the selector list of every rule that reaches the column —
  // a short value, unlike the whole stylesheet.
  it('gives the left column one width in the shipped theme', () => {
    const css = themeCss()
    const reaching = ruleSelectors(css).filter((list) =>
      list.includes('.chat-col--left'),
    )
    expect(reaching).toEqual([
      '.chat-col--left',
      '.chat-shell--conversation .chat-col--left',
      '.chat-shell--reasoning .chat-col--left',
    ])

    const body = css.match(/\.chat-col--left\s*\{([^}]*)\}/)[1]
    expect(body).toContain('flex: 0 0 var(--bi-chat-tools-col-width)')
  })
})

describe('an empty panel names the file that is missing', () => {
  // Option (a) of the layout decision: the panel keeps its box and fills it
  // with the sentence that says where the declaration goes. The two paths are
  // the actionable half — the template is seeded, the declaration never is.
  it('says where the language-server declaration belongs', () => {
    hubs({})
    const w = mount(WorkBenchLspPanel)
    const line = w.find('.chat-hub-empty')

    expect(line.exists()).toBe(true)
    expect(line.text()).toContain('.nojae/lsp-settings.template.json')
    expect(line.text()).toContain('.nojae/lsp-settings.json')
    // The restart is what picks up a declaration written after the boot scan.
    expect(w.find('.chat-hub-restart').exists()).toBe(true)
    w.unmount()
  })

  it('says where the MCP declaration belongs', () => {
    hubs({})
    const w = mount(WorkBenchMcpPanel)
    expect(w.find('.chat-hub-empty').text()).toContain('.nojae/mcp-settings.json')
    w.unmount()
  })

  // The empty line is the only thing in the panel then, and the panel clips
  // sideways rather than scrolling: without a rule of its own the long path
  // token it names would be cut off at the narrowest breakpoint.
  it('gives the empty line a rule of its own', () => {
    const css = themeCss()
    const rule = css.match(/\.chat-hub-empty\s*\{[^}]*\}/)
    expect(rule, 'the empty line has a rule').not.toBeNull()
    expect(rule[0]).toContain('overflow-wrap: break-word')
  })

  it('keeps the switch list instead of the empty line when servers are declared', () => {
    hubs({ lsp: true })
    const w = mount(WorkBenchLspPanel)
    expect(w.find('.chat-hub-empty').exists()).toBe(false)
    expect(w.findAll('.chat-mcp-row')).toHaveLength(1)
    w.unmount()
  })
})
