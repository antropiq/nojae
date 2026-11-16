import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import SettingsDialog from '../src/components/SettingsDialog.vue'
import { useAppShell } from '../src/composables/useAppShell'

// ---------------------------------------------------------------------------
// The one app-level notice that replaced the three per-workspace file blocks
// (§5.1, §5.4).
//
// There is no settings file any more: the dialog edits the settings store's own
// routes. What it says is the store-level question — *is the store usable, and
// does it hold at least one model?* — and the sentence for an unusable store is
// the server's: the dialog shows it verbatim and translates nothing, so a client
// can never print a path or a name the server did not give it.
//
// Where it says it is the **one message band** at the bottom of the dialog
// (settings-dialog-migration-plan §4.7), not a block above the fields: the two
// sentences below are `messageFor`'s findings, so this suite reads the band.
// ---------------------------------------------------------------------------

const { state } = useAppShell()

function band(wrapper) {
  return wrapper.find('.agent-modes-message')
}

describe('the dialog shows one store-level notice', () => {
  beforeEach(() => {
    state.settings = { store: true }
    state.settingsError = null
    state.servers = []
    state.serversCaps = null
    state.unassigned = null
    state.serversLoading = false
    state.serversLoaded = true
    state.serversError = null
    state.activeSection = 'servers'
    state.serverDraft = null
    state.modelDraft = null
    state.pendingDelete = null
    state.pendingDeleteSentence = null
    state.fetchedModelIds = {}
    state.fetchedModelsLoading = null
    state.fetchedModelsErrors = {}
  })

  it('says nothing once a model is configured', () => {
    state.storeState = { usable: true, sentence: null }
    state.config = { models: [{ id: 1, name: 'm' }], store: state.storeState }

    const wrapper = mount(SettingsDialog)
    const text = wrapper.text().replace(/\s+/g, ' ')

    // A configured store answers no sentence at all, and the dialog invents
    // none: neither a file's name nor a path it was not given.
    expect(band(wrapper).text()).toBe('')
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

    expect(band(wrapper).text()).toContain('No model is configured yet')
    expect(band(wrapper).attributes('role')).toBe('alert')
    wrapper.unmount()
  })

  it('shows the server\'s own sentence for an unusable store', () => {
    const sentence = "nojae's settings store at /srv/nojae.db cannot be read."
    state.storeState = { usable: false, sentence }
    state.config = { models: [], store: state.storeState }

    const wrapper = mount(SettingsDialog)

    // Verbatim, path included -- the server named it, the dialog repeats it.
    expect(band(wrapper).text()).toBe(sentence)
    expect(band(wrapper).attributes('role')).toBe('alert')
    wrapper.unmount()
  })
})
