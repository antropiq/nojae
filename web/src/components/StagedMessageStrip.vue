<script setup>
import { computed } from 'vue'
import MarkdownStream from './MarkdownStream.vue'
import { flushGateReason, useChat } from '../composables/useChat'

// The strip: the user messages the composer has accepted but no turn has
// carried yet, in flush order, drawn above the draft preview because they are
// the next thing that will be sent. It reads useChat's input state and calls
// its verbs; every rule about what a row may do — and whether it would be
// accepted — is answered there, so this component spells none of its own.
const emit = defineEmits(['preview'])

const { state, chatBusy, removeStaged, pullBackStaged } = useChat()

// One entry per staged message: the number it holds in flush order (a position,
// not an identity — a removal renumbers the rest) and the verdict on whether the
// request a flush would make survives carrying it. `flushGateReason` is the same
// verdict the flush itself runs, so a row and a refused send can never disagree.
const rows = computed(() =>
  state.staged.map((row, index) => ({
    row,
    number: index + 1,
    refusal: flushGateReason(row),
  })),
)

// The strip stays on screen while a reply streams or a batch owns the
// conversation — it is read-only then, never hidden — so the two verbs say why
// they are inert rather than disappearing.
const locked = computed(() => chatBusy())
const lockedTitle = 'Available when no reply is streaming and no batch runs'

function onRemove(row) {
  removeStaged(row.id)
}

function onPullBack(row) {
  pullBackStaged(row.id)
}
</script>

<template>
  <!-- Nothing at all until the first stage: no box, no border, no reserved
       space, so the panel and the composer are exactly what they were. -->
  <section
    v-if="rows.length"
    class="chat-staged-strip"
    aria-label="Staged messages (not sent yet)"
  >
    <ol class="chat-staged-list">
      <li
        v-for="entry in rows"
        :key="entry.row.id"
        class="chat-staged-row"
        :class="{ 'chat-staged-row--refused': entry.refusal }"
      >
        <div class="chat-staged-head">
          <span class="chat-staged-number">{{ entry.number }}</span>
          <div class="chat-staged-actions">
            <button
              class="icon-btn chat-staged-pull"
              type="button"
              :disabled="locked"
              :aria-label="`Pull staged message ${entry.number} back into the composer`"
              :title="
                locked
                  ? lockedTitle
                  : `Pull message ${entry.number} back into the composer`
              "
              @click="onPullBack(entry.row)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M9 14 4 9l5-5" />
                <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
              </svg>
            </button>
            <button
              class="icon-btn chat-staged-remove"
              type="button"
              :disabled="locked"
              :aria-label="`Remove staged message ${entry.number}`"
              :title="
                locked ? lockedTitle : `Remove message ${entry.number} from the strip`
              "
              @click="onRemove(entry.row)"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M18 6 6 18" />
                <path d="m6 6 12 12" />
              </svg>
            </button>
          </div>
        </div>
        <!-- One thumbnail per image, in the order it will travel in; each opens
             the same full-size lightbox a sent turn's thumbnails open. -->
        <div v-if="entry.row.images?.length" class="chat-staged-thumbs">
          <button
            v-for="(image, index) in entry.row.images"
            :key="index"
            type="button"
            class="chat-thumb-zoom"
            :aria-label="`View ${image.name} at full size`"
            :title="`View ${image.name} at full size`"
            @click="emit('preview', image)"
          >
            <img :src="image.dataUrl" :alt="image.name" class="chat-thumb" loading="lazy" />
          </button>
        </div>
        <MarkdownStream v-if="entry.row.html" :html="entry.row.html" />
        <!-- The verdict's own sentence, not a second copy of it, and announced:
             a flush is all-or-nothing, so a row that would arrive empty is the
             reason nothing is sent. The glyph keeps the marking readable
             without relying on its colour. -->
        <p v-if="entry.refusal" class="error-line chat-staged-refusal" role="alert">
          <span aria-hidden="true">&#9888;</span>
          {{ entry.refusal }}
        </p>
      </li>
    </ol>
  </section>
</template>
