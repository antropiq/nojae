import { computed } from 'vue'
import { useBatch } from './useBatch'
import { useEditorFiles } from './useEditorFiles'
import { useEditorNotices } from './useEditorNotices'
import { useChat } from './useChat'

// Editor mode: whether the code pane currently promises an editable surface.
//
// A composable because one answer is both shown in the file tree's header and
// enforced on the code pane — two components, one rule. The server enforces it
// on every write route too, so this is the badge's source, not the boundary.
// The pane is read-only while a reply streams or a batch runs: the model is the
// only other writer of these files and must not race a human in the same buffer.
//
// The badge sits in the navigator header, where there is room for it (the tab
// strip shrinks as buffers pile up), and its `title` explains the two states a
// pane-wide label cannot: an unsaved buffer behind an editable badge, and a
// write that was just refused for this path.

export function useEditorMode() {
  const files = useEditorFiles()
  const batch = useBatch()
  const notices = useEditorNotices()
  const chat = useChat()

  // The active tab's kind: 'file' (an editable buffer) or a view's kind. A view
  // has no buffer to type into, so the badge's editable promise is a file's.
  const activeKind = computed(() => {
    const active = files.state.active
    if (!active) return null
    return files.state.open.find((item) => item.key === active)?.kind ?? null
  })

  // Its own name because the badge words a diff separately below.
  const isDiffTab = computed(() => activeKind.value === 'diff')
  const isPreviewTab = computed(() => activeKind.value === 'preview')
  const isViewTab = computed(() => activeKind.value !== null && activeKind.value !== 'file')

  const editorMode = computed(() => {
    if (isViewTab.value) return 'read_only'
    // Idle *and* no lot running: between two task turns `phase` is 'idle' while
    // the next turn is already queued and the model may be mid-edit here.
    return chat.state.phase === 'idle' && !batch.state.active
      ? 'read_write'
      : 'read_only'
  })

  const paneReadonly = computed(() => editorMode.value === 'read_only')
  const isEditable = computed(() => editorMode.value === 'read_write')

  const badgeLabel = computed(() => (isEditable.value ? 'read-write' : 'read-only'))

  const badgeTitle = computed(() => {
    const parts = []
    if (isDiffTab.value) {
      parts.push('Read-only — this tab is a diff: the committed side and the one on disk.')
    } else if (isPreviewTab.value) {
      parts.push('Read-only — this tab shows the rendered Markdown of the file.')
    } else if (batch.state.active) {
      parts.push(
        'Read-only — a batch is running and its tasks edit these files. Saving is refused until the lot stops.',
      )
    } else if (isEditable.value) {
      parts.push(
        'Editable — the WorkBench is idle. Unsaved edits are kept in the tab, not written to disk yet.',
      )
    } else {
      parts.push(
        'Read-only — a WorkBench reply is running and may be editing these files. Saving is refused until it ends.',
      )
    }

    // The badge is where a pane-wide state is explained, so the buffer's
    // freshness rides here too: the chip says which tab, this what it means.
    const active = files.state.open.find((item) => item.key === files.state.active)
    if (active?.kind === 'file') {
      // The language server answers whether the pane is editable or locked, and
      // this is the only badge to say so in.
      parts.push(
        'Ctrl+click, hover and find-references still work — the language server answers in both modes.',
      )
      // The one pane-wide indicator of unsaved work that survives a tab switch,
      // and the wording follows the mode: "Ctrl+S" on a locked pane would lie.
      if (active.dirty) {
        parts.push(
          isEditable.value
            ? 'This buffer has changes that are not on disk yet (Ctrl+S writes them).'
            : 'This buffer has changes that are not on disk, and cannot be written until the pane is editable.',
        )
      }
      if (active.deleted) {
        parts.push('This file is gone from disk; the buffer is all that is left of it.')
      } else if (active.stale) {
        parts.push('This file changed on disk while it is open here.')
      }
      // The last word on "why did my Ctrl+S do nothing?": the refusal this path
      // is under, quoted from the notice the write raised.
      const refusal = notices.noticeForPath(active.path)
      if (refusal) parts.push(refusal.text)
    }
    return parts.join(' ')
  })

  return {
    editorMode,
    paneReadonly,
    isEditable,
    isDiffTab,
    isPreviewTab,
    isViewTab,
    badgeLabel,
    badgeTitle,
  }
}
