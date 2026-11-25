<script setup>
import { computed, ref } from 'vue'
import WorkspaceNavigator from './WorkspaceNavigator.vue'
import EditorArea from './EditorArea.vue'
import EditorNoticeStack from './EditorNoticeStack.vue'
import EditorStatusBar from './EditorStatusBar.vue'
import EditorTerminal from './EditorTerminal.vue'
import { useSplitter } from '../composables/useSplitter.js'

// The Editor tab's shell: navigator on the left, the code pane in the centre,
// the terminal strip under it and the status bar along the very bottom, full
// width — a grid whose tracks are sized by the two splitters below. Each region
// owns its own state in a composable, so this component only lays them out.
//
// The navigator keeps its own state in useWorkspaceTree, so the whole view
// staying mounted (App.vue's v-show) is what preserves open files and the
// terminal session across a peek at the WorkBench tab. A tab moving to another
// folder re-roots that tree from the gesture itself, so this view owns no
// cross-tab wiring.
const shell = ref(null)
const nav = ref(null)
const terminal = ref(null)

// Sidebar: the pane *before* the bar grows to the right, never past half the
// shell, so the code pane always keeps a usable width.
const {
  dragging: sidebarDragging,
  shellStyle: sidebarStyle,
  onPointerDown: sidebarDown,
  onPointerMove: sidebarMove,
  onPointerUp: sidebarUp,
  onKeyDown: sidebarKey,
  onDoubleClick: sidebarReset,
} = useSplitter(shell, nav, {
  orientation: 'vertical',
  storageKey: 'nojae:editorSidebar',
  minResized: 160,
  minOther: 240,
  maxRatio: 0.5,
  sizeVar: '--bi-editor-sidebar',
})

// Terminal: the pane *after* the bar grows upwards; 96 px is two lines plus the
// panel header, and the code pane above it keeps 200 px.
const {
  dragging: terminalDragging,
  shellStyle: terminalStyle,
  onPointerDown: terminalDown,
  onPointerMove: terminalMove,
  onPointerUp: terminalUp,
  onKeyDown: terminalKey,
  onDoubleClick: terminalReset,
} = useSplitter(shell, terminal, {
  orientation: 'horizontal',
  storageKey: 'nojae:editorTerminal',
  minResized: 96,
  minOther: 200,
  sizeVar: '--bi-editor-terminal',
})

// Narrow screens: the tree becomes a drawer, because the single-column stack
// would otherwise push the code pane below the fold.
const navOpen = ref(true)

// The terminal's fold, the Chat tools dock's twin: a flag, not a size, so a
// dragged terminal height survives it untouched and unfolding comes back at
// exactly that height. The write-through keeps it durable however it is flipped.
const TERMINAL_COLLAPSED_KEY = 'nojae:editorTerminalCollapsed'

function loadTerminalCollapsed() {
  try {
    return window.localStorage.getItem(TERMINAL_COLLAPSED_KEY) === '1'
  } catch {
    return false
  }
}

const collapsed = ref(loadTerminalCollapsed())
const terminalCollapsed = computed({
  get: () => collapsed.value,
  set: (value) => {
    collapsed.value = value
    try {
      window.localStorage.setItem(TERMINAL_COLLAPSED_KEY, value ? '1' : '0')
    } catch {
      // Storage disabled: the fold still works for the session.
    }
  },
})
</script>

<template>
  <div
    ref="shell"
    class="editor-shell"
    :class="{ 'nav-collapsed': !navOpen, 'editor-shell--terminal-collapsed': terminalCollapsed }"
    :style="[sidebarStyle, terminalCollapsed ? null : terminalStyle]"
  >
    <div ref="nav" class="editor-nav-col">
      <button
        class="editor-nav-toggle"
        type="button"
        :aria-expanded="navOpen"
        aria-controls="editor-nav"
        :title="navOpen ? 'Hide the file tree' : 'Show the file tree'"
        @click="navOpen = !navOpen"
      >
        Files
      </button>
      <div id="editor-nav" class="editor-nav-slot">
        <WorkspaceNavigator />
      </div>
    </div>

    <div
      class="pane-resizer pane-resizer--vertical editor-resizer-v"
      :class="{ dragging: sidebarDragging }"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the file tree (drag, arrow keys, double-click to reset)"
      tabindex="0"
      @pointerdown="sidebarDown"
      @pointermove="sidebarMove"
      @pointerup="sidebarUp"
      @pointercancel="sidebarUp"
      @keydown="sidebarKey"
      @dblclick="sidebarReset"
    ></div>

    <EditorArea class="editor-area-slot" />

    <!-- The bar goes with the body: folding takes both out of the flow, so the
         terminal's row is sized by its head strip alone. -->
    <div
      v-if="!terminalCollapsed"
      class="pane-resizer editor-resizer-h"
      :class="{ dragging: terminalDragging }"
      role="separator"
      aria-orientation="horizontal"
      aria-label="Resize the terminal (drag, arrow keys, double-click to reset)"
      tabindex="0"
      @pointerdown="terminalDown"
      @pointermove="terminalMove"
      @pointerup="terminalUp"
      @pointercancel="terminalUp"
      @keydown="terminalKey"
      @dblclick="terminalReset"
    ></div>

    <EditorTerminal
      ref="terminal"
      v-model:collapsed="terminalCollapsed"
      class="editor-terminal-slot"
    />

    <!-- The status bar: the last child of the shell, so it belongs to the Editor
         *screen* (tree, pane and terminal alike) and sits below all of them. It
         is chrome, not a fourth pane: not resizable, and nothing goes under it. -->
    <EditorStatusBar />

    <!-- The write-feedback stack. Mounted here rather than in EditorArea so it
         belongs to the Editor *screen* instead of to one of its panes — it
         teleports to `<body>` anyway, and staying inside this lazy chunk keeps
         the Editor's weight where it is now. -->
    <EditorNoticeStack />
  </div>
</template>
