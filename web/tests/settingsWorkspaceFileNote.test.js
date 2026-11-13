import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import SettingsDialog from '../src/components/SettingsDialog.vue'
import { useAppShell } from '../src/composables/useAppShell'

// ---------------------------------------------------------------------------
// The one app-level notice that replaced the three per-workspace file blocks
// (§5.1, §5.4).
//
// There is no settings file any more: the dialog edits the settings store's own
// routes. What it says at the top of the Models section is the store-level
// question — *is the store usable, and does it hold at least one model?* — and
// the sentence for an unusable store is the server's: the dialog shows it
// verbatim and translates nothing, so a client can never print a path or a name
// the server did not give it.
// ---------------------------------------------------------------------------

const { state } = useAppShell()

function llmSection(wrapper) {
  return wrapper.find('.settings-editor > section')
}

describe('the dialog shows one store-level notice', () => {
  beforeEach(() => {
    state.settings = { store: true }
    state.settingsError = null
    state.servers = []
    state.serversCaps = null
    state.unassigned = null
    state.serversLoading = false
    state.serversError = null
  })

  it('says nothing once a model is configured', () => {
    state.storeState = { usable: true, sentence: null }
    state.config = { models: [{ id: 1, name: 'm' }], store: state.storeState }

    const wrapper = mount(SettingsDialog)
    const text = wrapper.text().replace(/\s+/g, ' ')

    // A configured store answers no sentence at all, and the dialog invents
    // none: neither a file's name nor a path it was not given.
    expect(llmSection(wrapper).find('.alert-error').exists()).toBe(false)
    expect(text).not.toContain('nojae-settings.json')
    expect(text).not.toContain('nojae-test-settings.json')
    wrapper.unmount()
  })

  // The notice a fresh install actually meets: four agents, no models, so
  // every one of them is unrunnable until the user assigns one (D7).
  it('says so when the store holds no model', () => {
    state.storeState = { usable: true, sentence: null }
    state.config = { models: [], store: state.storeState }

    const wrapper = mount(SettingsDialog)
    const note = llmSection(wrapper).find('.alert-error')

    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('No model is configured yet')
    wrapper.unmount()
  })

  it('shows the server\'s own sentence for an unusable store', () => {
    const sentence = "nojae's settings store at /srv/nojae.db cannot be read."
    state.storeState = { usable: false, sentence }
    state.config = { models: [], store: state.storeState }

    const wrapper = mount(SettingsDialog)
    const note = llmSection(wrapper).find('.alert-error')

    expect(note.exists()).toBe(true)
    // Verbatim, path included -- the server named it, the dialog repeats it.
    expect(note.text()).toBe(sentence)
    wrapper.unmount()
  })
})
