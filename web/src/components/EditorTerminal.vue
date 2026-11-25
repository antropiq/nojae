<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useAppShell } from '../composables/useAppShell'
import { useTerminal } from '../composables/useTerminal'

// Bundled with this component only, never in main.js — xterm is heavy and the
// WorkBench tab is the default screen. The xterm classes load lazily inside
// useTerminal.attach(); the emulator's base CSS rides this static import so it
// still lands in the Editor chunk, not the entry one.
import '@xterm/xterm/css/xterm.css'
// Shell-prompt icons need a Nerd Font. Its @font-face is unicode-range-gated, so
// the woff2 is only fetched when a prompt glyph actually falls in those ranges.
import '../fonts/nerd-fonts.css'

// The live xterm.js pane: an emulator mounted into the host div below, bridged
// to `WS /api/terminal`. All the socket/PTY/state logic lives in useTerminal — a
// singleton, so the shell survives the v-show tab switch and a remount never
// opens a second socket behind the user's back. This component owns only the DOM
// lifecycle and the header.
//
// **A live shell keeps the folder it was born in**: the socket names this tab's
// workspace when it opens, and pointing the tab elsewhere afterwards does not
// re-root, kill or relaunch it — a buffered tab must not be torn down because
// the app bar moved. What *does* follow the tab is the **next** shell: the
// New-session button, or a reconnect after the socket dropped, starts in the
// folder the tab holds at that moment. A `cd` inside the pane is the user's own
// business.
//
// The mount trap: the tab is v-show, so the pane is in the DOM but has no layout
// while hidden — `fit()` on a zero-height host computes 0 rows and xterm paints
// a blank grid. A ResizeObserver on the host that fits whenever it has size
// covers entering the tab and the splitter drag, the cases where it regains one.
const host = ref(null)
const terminal = useTerminal()
const state = terminal.state
const appShell = useAppShell()

// The fold: the strip's head stays, because it carries the control that brings
// the pane back; the body goes and EditorView shrinks the terminal's row to the
// head's height. The fold belongs to the layout owner — only it can answer to the
// pane's height — hence the `collapsed` prop / `update:collapsed` pair rather than
// a flag kept here.
const props = defineProps({ collapsed: Boolean })
const emit = defineEmits(['update:collapsed'])
const expanded = computed(() => !props.collapsed)

// pid + cwd from the `open` frame, so a second tab or a lost session is
// diagnosable.
const meta = computed(() =>
  state.status === 'open' && state.pid
    ? ` · pid ${state.pid} · ${state.cwd}`
    : '',
)

// Status dot reuses the app's status-pill palette: blue+pulse while connecting,
// green when open, red on error, muted otherwise.
const DOT_CLASS = {
  connecting: 'editor-terminal-dot--connecting',
  open: 'editor-terminal-dot--open',
  error: 'editor-terminal-dot--error',
}
const dotClass = computed(() => DOT_CLASS[state.status] ?? '')

const STATUS_LABEL = {
  idle: 'no session',
  connecting: 'starting…',
  open: 'running',
  closed: 'closed',
  error: 'error',
}
const statusLabel = computed(() => STATUS_LABEL[state.status] ?? state.status)

// The reason a session is not there (killed, exited, refused, closed), which is
// also the cue that a manual New session brings one back.
const banner = computed(() => (state.status === 'open' ? '' : state.message))

// Kill only makes sense with a live socket; New makes sense any time the pane
// is not mid-handshake (it tears down any old socket first).
const canKill = computed(() => state.status === 'open')
const canNew = computed(() => state.status !== 'connecting')

// A ResizeObserver on the host is the single layout driver: it fires when the
// host gains size on mount, when the pane becomes visible again (v-show back on),
// and on every splitter-drag frame — so fit + the debounced `resize` frame ride
// one mechanism. No "drag end" hook is needed: the drag changes the host's box,
// which is what the observer reports.
let observer = null
onMounted(async () => {
  await nextTick()
  if (host.value) terminal.attach(host.value)
  if (typeof ResizeObserver !== 'undefined' && host.value) {
    observer = new ResizeObserver(() => terminal.sendResize())
    observer.observe(host.value)
  }
})

// Entering the Editor tab is the explicit re-lay-out moment: a hidden terminal
// kept streaming into its scrollback and only re-fits now.
watch(
  () => appShell.state.activeTab,
  (tab) => {
    if (tab === 'editor') nextTick(() => terminal.fitVisible())
  },
)

onBeforeUnmount(() => {
  observer?.disconnect()
  observer = null
  // The socket and the xterm instance are singletons owned by the composable
  // and outlive this component (the Editor view is v-show, not v-if), so the
  // shell is NOT torn down here. dispose() runs only when the whole app goes.
})
</script>

<template>
  <section
    class="editor-terminal"
    :class="{ 'editor-terminal--collapsed': !expanded }"
    aria-label="Workspace terminal"
  >
    <header class="editor-terminal-head">
      <span class="editor-terminal-title">
        Terminal<span class="editor-terminal-meta">{{ meta }}</span>
      </span>
      <span class="editor-terminal-state" role="status">
        <span class="status-dot editor-terminal-dot" :class="dotClass" aria-hidden="true"></span>
        <span class="caption">{{ statusLabel }}</span>
      </span>
      <button
        class="icon-btn editor-terminal-new"
        type="button"
        :disabled="!canNew"
        aria-label="Start a new terminal session"
        title="New shell (a dropped or closed session starts fresh here)"
        @click="terminal.newSession()"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M12 5v14" />
          <path d="M5 12h14" />
        </svg>
      </button>
      <button
        class="icon-btn editor-terminal-kill"
        type="button"
        :disabled="!canKill"
        aria-label="Kill the terminal session"
        title="Kills the shell and everything it started"
        @click="terminal.kill()"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 6 6 18" />
          <path d="m6 6 12 12" />
        </svg>
      </button>
      <!-- The fold, right of the two session controls: it takes the body (and,
           through the layout owner, the pane's whole row) out of the flow, so
           the code pane above gets the room. It lives in the head because a
           control that vanished with the thing it restores would be
           unreachable. -->
      <button
        class="icon-btn editor-terminal-toggle"
        type="button"
        :aria-expanded="expanded"
        :aria-controls="expanded ? 'editor-terminal-body' : undefined"
        :aria-label="expanded ? 'Hide the terminal' : 'Show the terminal'"
        :title="
          expanded
            ? 'Hide the terminal — the code pane takes the room'
            : 'Show the terminal'
        "
        @click="emit('update:collapsed', expanded)"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor"
          stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path v-if="expanded" d="m6 9 6 6 6-6" />
          <path v-else d="m18 15-6-6-6 6" />
        </svg>
      </button>
    </header>

    <!-- `v-show`, not `v-if`: the host has to stay in the DOM so the xterm
         instance and the ResizeObserver that fits it survive the fold, and the
         observer fires again on unfold, which is what re-lays-out the grid. -->
    <div
      v-show="expanded"
      id="editor-terminal-body"
      class="editor-terminal-body"
    >
      <div ref="host" class="editor-term-host"></div>
      <p v-if="banner" class="caption editor-term-banner">{{ banner }}</p>
    </div>
  </section>
</template>
