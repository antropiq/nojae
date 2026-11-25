import { watchEffect } from 'vue'
import { useChat } from './useChat'
import { useBatch } from './useBatch'
import { inferenceRunning } from '../lib/inference-state'

// The browser tab is the only thing visible while the app's tab is in the
// background, so it carries the one bit that matters there: ⚡ in front of the
// title while an inference runs, ✨ when none does.
//
// The base text is read once, at import time, so the prefix never stacks up;
// the leading-glyph strip guards a hot reload, where document.title may already
// hold a prefix written by the previous instance of this module.
const BASE_TITLE = document.title.replace(/^(?:[⚡✨]\s*)*/, '')

export function useTabTitle() {
  const { state: chat } = useChat()
  const { state: batch } = useBatch()

  // Mirrors the app bar's status pill (AppBar.vue reads the same two flags);
  // deliberately only two states, since a background tab is read at a glance.
  watchEffect(() => {
    document.title = inferenceRunning({ chat, batch })
      ? `⚡ ${BASE_TITLE}`
      : `✨ ${BASE_TITLE}`
  })
}
