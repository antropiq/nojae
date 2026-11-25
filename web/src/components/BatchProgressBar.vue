<script setup>
import { computed } from 'vue'
import { useBatch } from '../composables/useBatch'
import { modeById } from '../composables/useAgentModes'

// The batch meter, rendered under the stopwatch while a batch runs. It reuses the
// <progress> + caption pair styled by `.progress-row`: GaugeBar's green→red
// gradient encodes a *level*, which a task counter has no opinion about.
const { state } = useBatch()

// Running, plus afterwards only on Stop or a failed turn: that outcome stays worth
// reading, and a Restart (which resets the status) is the way back. A lot that
// simply finished keeps no meter on screen.
const visible = computed(
  () => state.active || state.status === 'stopped' || state.status === 'failed',
)

// The highest completed task number, so a gap in the numbering still fills the bar.
const value = computed(() => Math.min(state.index, state.total))

const caption = computed(() => `${state.prefix} · ${state.dir}`)

// One lot, one agent: the one the composer showed at launch, and a lot whose agent
// could not be resolved never launched, so a running one always has one to name.
const modeCaption = computed(() => {
  if (state.modeNote) return state.modeNote
  if (!state.pinnedMode) return null
  // The list's own label for the id the run holds — the dropdown and this line
  // must not call the same agent by two names.
  const label = modeById(state.pinnedMode)?.label ?? state.pinnedMode
  return `tasks run in ${label} mode`
})

// The task being worked on, so it reads 1/3 while the first turn streams
// (`state.index` only counts turns that ran to their end). With no turn in flight
// it falls back to that completed count.
const current = computed(() =>
  state.current ? state.current.number : Math.min(state.index, state.total),
)

const counter = computed(() => `${current.value}/${state.total} task`)

const ariaLabel = computed(() => {
  const task = state.current ? `: ${state.current.name}` : ''
  return `${state.prefix} batch — task ${current.value} of ${state.total}${task}`
})

// What each turn outcome means. The turn's ending is only half the story: the loop
// also checks whether the task file left the lot folder (`moved`), the completion
// signal a relaunch runs on. Batch mode reads no task body, so `moved: true` means
// "no longer listed in the lot", never "the work was good".
const OUTCOME_LABEL = {
  done: 'turn finished',
  truncated: 'turn cut short by the server',
  capped: 'hit the tool-iteration cap',
  stopped: 'stopped',
  'not-started': 'turn never started',
  error: 'turn failed',
}

// One entry per turn, so a relaunched task reads as several lines with the same
// task number: the retry count is what the user is owed.
function noteFor(record, i) {
  const number = record?.number ?? state.listing?.tasks?.[i]?.number ?? i + 1
  const attempt = record?.attempt ?? 0
  const label = OUTCOME_LABEL[record?.outcome] ?? record?.outcome
  const suffix = attempt > 0 ? ` (retry ${attempt})` : ''
  if (record?.moved === false) {
    return `task ${number}: ${label}${suffix} — task file still in the lot`
  }
  return `task ${number}: ${label}${suffix}`
}

const title = computed(() => {
  const head =
    `Batch progress — turns of ${state.total} numbered task(s); a task whose ` +
    'file is still in the lot folder is relaunched.'
  const notes = state.outcomes.map(noteFor)
  if (state.status === 'failed') {
    notes.push(
      'batch aborted — a turn failed, or a task stayed unmoved after the retries',
    )
  }
  if (state.status === 'stopped') notes.push('batch stopped by you')
  return [head, ...notes].join(' · ')
})
</script>

<template>
  <section v-if="visible" class="batch-progress" aria-label="Batch progress">
    <p class="caption">{{ caption }}</p>
    <p v-if="modeCaption" class="caption batch-mode-caption" role="status">
      {{ modeCaption }}
    </p>
    <div class="progress-row">
      <progress :value="value" :max="state.total" :aria-label="ariaLabel"></progress>
    </div>
    <p class="caption mono" :title="title">{{ counter }}</p>
  </section>
</template>
