import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'

import SettingsDialog from '../src/components/SettingsDialog.vue'
import { useBenchmark } from '../src/composables/useBenchmark'

// The dialog holds two System prompt fields and they are not the same setting:
// the LLM one is ``LLM_SYSPROMPT``, the verifier one belongs to the verifier
// endpoint. A save that wired both to the same model field would silently grade
// with the answer prompt, so each textarea is pinned to its own value.
//
// What each prompt is *used for* is the core's rule and is pinned on the Python
// side; nothing here re-litigates it.

const { state } = useBenchmark()

function llmSettings() {
  return {
    serverUrl: 'http://127.0.0.1:8080/v1',
    apiKey: '',
    endpoint: 'model-a',
    sysprompt: 'Answer concisely.',
    // The payload shape since the workspace-file split: sampling fields are
    // numbers or null, the vision flag a boolean, and no debug field at all.
    temp: 0.2, topP: null, topK: null, minP: null, repeatPenalty: null, presencePenalty: null,
    reasoning: '', supportsVision: false, questionSet: 'legacy',
    verifier: { serverUrl: '', apiKey: '', endpoint: '', sysprompt: 'Grade the answer.' },
  }
}

function syspromptLabels(wrapper) {
  return wrapper.findAll('label').filter((node) =>
    node.text().trim().startsWith('System prompt'),
  )
}

describe('the two System prompt fields are two settings', () => {
  beforeEach(() => {
    state.settings = llmSettings()
  })

  it('renders one field per endpoint, each holding its own value', async () => {
    const wrapper = mount(SettingsDialog)
    const labels = syspromptLabels(wrapper)
    expect(labels).toHaveLength(2)

    const areas = labels.map((node) => node.find('textarea'))
    expect(areas[0].element.value).toBe('Answer concisely.')
    expect(areas[1].element.value).toBe('Grade the answer.')

    // And they are really two models: editing the LLM one leaves the verifier's
    // value where it was, so a save can only send each to its own endpoint.
    await areas[0].setValue('Answer at length.')
    expect(state.settings.sysprompt).toBe('Answer at length.')
    expect(state.settings.verifier.sysprompt).toBe('Grade the answer.')
    wrapper.unmount()
  })
})
