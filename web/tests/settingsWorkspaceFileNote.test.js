import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import SettingsDialog from '../src/components/SettingsDialog.vue'
import { useBenchmark } from '../src/composables/useBenchmark'

// Which settings file the dialog edits is the **server's** answer, never a name
// the dialog knows: with the e2e switch on the file in use is
// `nojae-test-settings.json`, so a file name written into the component would
// print a wrong one half the time. The dialog therefore speaks a path only when
// the server's own sentence carries it — the `absent` state is unreachable in
// production (the seed always creates the file) but routine in that mode, where
// the app never seeds anything, so empty fields with no explanation would read
// as an app bug.

const { state } = useBenchmark()

function settings() {
  return {
    serverUrl: '',
    apiKey: '',
    endpoint: '',
    sysprompt: '',
    temp: null, topP: null, topK: null, minP: null, repeatPenalty: null,
    presencePenalty: null, reasoning: '', supportsVision: false,
    questionSet: 'legacy',
    verifier: { serverUrl: '', apiKey: '', endpoint: '', sysprompt: '' },
  }
}

function llmSection(wrapper) {
  return wrapper.find('.settings-editor > section')
}

describe('the dialog names the file the server reported', () => {
  beforeEach(() => {
    state.settings = settings()
    state.settingsError = null
    state.questionSetsError = null
  })

  it('names no file of its own when the server reported one', () => {
    state.workspaceSettings = {
      state: 'ok',
      path: '/srv/ws/.nojae/nojae-test-settings.json',
      error: null,
      configured: true,
      message: null,
    }
    const wrapper = mount(SettingsDialog)
    const text = wrapper.text().replace(/\s+/g, ' ')

    // A configured file answers no sentence at all, and the dialog invents none:
    // neither the reported path nor either file's name is the component's text.
    expect(llmSection(wrapper).find('.alert-error').exists()).toBe(false)
    expect(text).not.toContain('nojae-settings.json')
    expect(text).not.toContain('nojae-test-settings.json')
    wrapper.unmount()
  })

  it('shows the reader\'s own sentence for an absent file', () => {
    state.workspaceSettings = {
      state: 'absent',
      path: '/scratch/.nojae/nojae-test-settings.json',
      error: null,
      configured: false,
      message: 'there is no workspace settings file at '
        + '/scratch/.nojae/nojae-test-settings.json yet',
    }
    const wrapper = mount(SettingsDialog)
    const note = llmSection(wrapper).find('.alert-error')
    expect(note.exists()).toBe(true)
    expect(note.text()).toContain('there is no workspace settings file at')
    expect(note.text()).toContain('/scratch/.nojae/nojae-test-settings.json')
    wrapper.unmount()
  })
})
