# Quick Open — fuzzy file finder (Editor tab)

**Status**: final — the four open questions of the draft are answered in §8.
**Surface**: the Editor tab only — one keyboard chord, one modal, one new
read-only route, one new core module. No LLM, no hub, no SSE, no writes.

## 1. The need

The Editor tab answers "where is this string?" (the tree search), but not
"which file is this?". To open a file whose name you know, you expand branches
until the row is visible. In a real checkout that is several clicks through
folders you do not care about, and the tree caps at 2000 rows per directory
anyway.

So: press Ctrl+P while working in a buffer, type a few characters of a file
name, get a live list of matching files, press Enter or click one, land in that
file. The interaction is the editor-standard "quick open" shape (VS Code's
Ctrl+P, JetBrains' Shift+Shift).

## 2. Decisions taken

### 2.1 The chord is Ctrl+P, scoped to the Editor tab, taken from Monaco

Ctrl+P is the browser's **Print**. The chord must be claimed so that Print
never fires while the Editor tab holds focus — `preventDefault` is part of the
feature, not an implementation detail.

Where the chord is intercepted:

- **When the Monaco pane has focus** — inside Monaco itself, via its own
  command API (`editor.addCommand(KeyMod.CtrlCmd | KeyCode.KeyP, …)`). A global
  `keydown` listener cannot reliably beat Monaco's internal keybinding service,
  and Monaco is exactly where the user is when the need arises.
- **When the tree or another Editor-tab surface has focus** — through
  `lib/editor-keys.js`, the module that already owns the app's chords (Ctrl+S,
  Ctrl+W) and refuses keys it has no answer for. It gains exactly one entry.

The chord exists **only on the Editor tab**. WorkBench's composer keeps Ctrl+P
unclaimed; a global chord would need a rule about every other tab, which is
scope v1 does not need.

**Rejected: Ctrl+P as a second binding for the existing content search.** The
two features answer different questions (name vs content) and the muscle memory
from every other editor says Ctrl+P is *files*. The content search keeps its
menu/icon entry points.

### 2.2 The dialog, and what happens to the buffer underneath

A `<dialog>` + `showModal()` over the Editor pane — the house style
(`EditorTreeDialogs.vue`, `BatchModeDialog.vue`, and the content-search dialog
when it lands). Top to bottom:

1. one text field, autofocused, placeholder naming what is matched ("file
   name — type to filter");
2. the result list underneath, updating **on every keystroke**;
3. a footer line only when the list was truncated (2.5).

Keyboard is the primary path: ↑/↓ move the selection, Enter opens the selected
file, Escape closes the dialog and returns focus to the pane. Clicking a row
does the same as Enter. The selection is visible at all times (highlighted
row), and the list scrolls the selected row into view.

**The dialog closes on open** — same rule as the content search (its §2.6): a
result the user cannot yet see is a result they cannot use.

### 2.3 One file list, fetched once, filtered client-side

The list of candidate files is fetched **once, when the dialog opens**, and the
per-keystroke filtering happens **in the browser**. No request per keystroke, no
debounce, no spinner between keystrokes — typing feels instant because it is.

This is the opposite trade-off from the content search (its §2.2, one blocking
scan per query), and the reason is the shape of the work: a content scan is
unbounded work per query, while a file *listing* is bounded once by the caps in
2.5 and then reused for every keystroke of the session. The list is held in a
composable singleton and refreshed:

- on every dialog open — cheap, and it keeps the list honest after renames,
  deletes and new files made since the last open;
- never mid-session in the background.

**Rejected: server-side fuzzy search per keystroke.** It would add latency to
the exact interaction (typing) where latency is the feature, and it needs
debouncing, cancellation of in-flight requests and out-of-order-response
handling — machinery whose only cause would be the wrong split of work.

### 2.4 The fuzzy match, and what it matches against

Matching is a **case-insensitive smart subsequence** over the
workspace-relative path: the query's characters must appear in order, and
matches score better when they are contiguous, at word boundaries (after `/`,
`.`, `_`, `-`, or a case change) or at the start of a segment. `usred` finds
`src/core/editorfs/redact.py`; `readme` finds `README.md` before
`docs/old/reader-me.txt`.

- The match is against the **whole relative path**, not the bare file name, so
  `corellm` can deliberately pick `core/llmkit.py` — but a bare-name match
  outranks a mid-path match at equal structure, because that is what the user
  usually means.
- Results are ordered by score, ties broken by the tree's own ordering
  (`(name.lower(), name)` per segment) so the list is deterministic.
- The **matched spans are highlighted** in each row — as separate `<span>`
  elements around slices of the path string, never by injecting the path into
  HTML (the app renders no raw HTML anywhere; see the content-search spec §2.3's
  same rule for snippets).
- The matcher is one pure function in `web/src/lib/` (kebab-case module, like
  `search-scope.js`), testable in jsdom without mounting anything.

**Out of scope for v1**: `:line` / `@line` goto suffixes, `>` command mode,
negation (`!pattern`), glob syntax. The field matches file paths and nothing
else.

### 2.5 The candidate set is the tree's visible set — and the caps bound it

The rule is the content-search spec's §2.5, inherited verbatim: **the finder's
candidate set is exactly what the tree would list.** One policy verdict per
path, the same matcher, no second answer:

| path mode | candidate? | why |
|---|---|---|
| normal | yes | |
| `ro` | **no — excluded** | the finder is a *search* surface, not an open surface: `ro` marks paths the workspace keeps out of the way (vendored code, `node_modules/`), and listing them would bury real results under noise |
| `hidden` | **no — pruned, never listed** | a hidden path is indistinguishable from an absent one; the list must not even confirm the name |

So the finder's bar is **readable *and* writable** — stricter than the tree's
own listing, which shows `ro` rows. That is deliberate: the tree is a map of
the workspace, the finder is a shortcut to files you will *edit*. It covers
`.nojae/` (reserved, hidden in every workspace), the app-level rules that are
live while the working location is the install dir, and every rule in the
workspace's own policy file — including the `ro` rule that keeps `node_modules/`
out. A symlinked directory is listed at one level and never followed — the
`tree.py` rule.

**The policy is the only exclusion mechanism.** If `node_modules/` is not
hidden or read-only in the workspace's policy file, it *is* in the candidate
list. The finder does not keep its own ignore list; a search box
with a private ignore list would be a second, temporary policy the workspace's
rules do not know about (the content-search spec §5 already states this for
content; it holds harder for names, because a name in a list is an observation).

Caps, in `core/editorfs/constants.py` beside the other Editor caps, read
qualified (`constants.MAX_…`) so a test can patch them:

| constant | value | bounds |
|---|---|---|
| `MAX_QUICKOPEN_FILES` | 5000 | paths in the payload; extra files counted, not sent |

`truncated: true` in the payload, one footer line in the dialog ("showing the
first 5000 files — narrow with the policy or type to filter"). Typing still
filters the 5000 sent, so truncation degrades gracefully rather than breaking
the feature; the footer is what makes it honest.

### 2.6 Opening a result

Clicking or pressing Enter does two things, in this order — the same flow the
content search uses (its §2.6):

1. publish the path as the tree's selection, so the existing `openFile(path)`
   flow opens or focuses the buffer, with its existing refused-open answers
   (binary, over the size cap) already the pane's own words;
2. return focus to the Monaco pane.

No line reveal — the finder knows names, not positions. If the file was
renamed or deleted between listing and click, the existing refused-open answer
reports it; no staleness machinery.

### 2.7 State, and the working-location switch

The candidate list and the last query live in a composable singleton, not in
the component — the same reason the content search keeps its results in one
(`useWorkspaceSearch`). The list is refetched on every open (2.3), so there is
no "stale answer" question; the query is kept so re-opening shows the previous
filter, which the user can clear with one keystroke.

A **working-location switch clears everything** — query and list — through the
same one-way `registerReRootHandler` registry the buffers and the search
composable use: paths relative to a root that no longer exists are a lie.

### 2.8 Empty query

With an empty field the list shows the workspace's **top-level entries**
(folders and files at the root, the same rows the tree's root shows), so the
dialog is useful as a launcher before typing, and ↑/↓ already have something to
move through. **Decided**: not "recently opened files" — that needs a recency
store this feature does not otherwise touch; revisit only if the chord's use
shows a demand for it.

## 3. What it builds on

| existing piece | reused for |
|---|---|
| `policy.resolve_in_workspace` / `policy_modes.mode_for` | every path decision the listing makes |
| `tree.py`'s walk order and `_name_key` | deterministic candidate order |
| `useEditorFiles.openFile(path)` | opening/focusing the buffer for a pick |
| `useWorkspaceTree.registerReRootHandler` | clearing state on a working-location switch |
| `lib/editor-keys.js` | the chord outside Monaco |
| `EditorTreeDialogs.vue` shape | `<dialog>` + `showModal()` over composable state |

## 4. Shape and files of the new pieces

### `src/core/editorfs/quickopen.py` (new)

Core-only, no FastAPI — the discipline of the rest of `editorfs/`: plain values
in, dict out.

```python
def list_workspace_files() -> Dict[str, Any]: ...
```

A depth-first `os.scandir` walk of the working location, in the tree's order
(dirs first, then files, `(name.lower(), name)` per directory), one
`mode_for(child_rel)` verdict per child — `hidden` prunes a directory and
omits a file, exactly `tree.py`'s three lines; a symlinked directory is never
descended. Emits workspace-relative paths up to `MAX_QUICKOPEN_FILES`, counts
the rest, answers `{ "files": [...], "fileCount": N, "truncated": bool }`.

No file is ever opened — names only, so no size cap, no binary sniff, no UTF-8
question. Exported through `core/editorfs/__init__.py` beside `list_dir` and
`search_workspace`.

### `GET /api/fs/files` (new route in `api/routes.py`)

No parameters; the scope is always the whole working location. A `GET`, so it
stays outside `test_write_surface_isolation.py`'s write-marker scan — with the
same implementer caveat as the search route: no write marker in this module's
prose either.

### `web/src/lib/fuzzy-match.js` (new)

One pure function, `fuzzyMatch(query, path)` → `{ score, spans } | null`, and
`rankMatches(query, paths)` → sorted rows. The scoring rules of 2.4 live here
and nowhere else.

### `web/src/composables/useQuickOpen.js` (new)

Singleton holding `open` (dialog visibility), `query`, `list` (the fetched
candidates), `state` (`idle | loading | ready | error`), the selected index,
and `openDialog()` / `pick(path)`. `openDialog()` fetches the list fresh every
time (2.3). Registers through `registerReRootHandler` to forget everything on
a working-location switch (2.7).

### `web/src/components/QuickOpenDialog.vue` (new)

`<dialog>` + `showModal()`. The field, the list, the truncation footer. Rows
are buttons; the selected row is highlighted and scrolled into view; path
spans are highlighted with `<span>` slices, never `v-html`. ↑/↓/Enter/Escape
handled on the dialog.

### `MonacoEditor.vue`, `lib/editor-keys.js`, `EditorArea.vue` (edits)

| file | change |
|---|---|
| `MonacoEditor.vue` | one `addCommand` for Ctrl+P raising the dialog (2.1) |
| `lib/editor-keys.js` | one chord entry for the same, for tree/pane focus |
| `EditorArea.vue` | mounts `<QuickOpenDialog />`; wires the chord to the composable |

## 5. Out of scope for v1

- **Recency** ("recently opened" ordering, a `#` recent-files mode).
- **Line/column goto** suffixes (`file.py:42`).
- **Command mode** (`>` prefix) or any non-file target.
- **Creating/renaming** from the dialog — read-only by design, like the content
  search; it must stay out of the guarded write surface.
- **Chords beyond Ctrl+P** (no Ctrl+Shift+O alias, no Shift+Shift).
- The chord on **other tabs**.
- **Persistence** of the query across reloads.

## 6. Verification

### Backend (`tests/test_editorfs_quickopen.py`, new)

Hermetic, `tmp_path` workspace — the pattern of `tests/test_editorfs.py`:

| test | asserts |
|---|---|
| flat list | nested files appear as workspace-relative paths |
| deterministic order | same list twice; matches the tree's ordering |
| hidden folder pruned | a `hidden` directory's files are absent, and no key counts them |
| hidden file omitted | same, for a file-level rule |
| `ro` excluded | an `ro` file is **not** in the list, and an `ro` directory's files are absent |
| `.nojae` never listed | seeded workspace: nothing under `.nojae/` |
| symlinked dir not followed | a link out of the workspace contributes nothing |
| cap | more files than `MAX_QUICKOPEN_FILES` ⇒ truncated list, `truncated: true`, honest count |
| empty workspace | `{ "files": [], "truncated": false }`, not an error |

Caps patched as module attributes, never by writing 5000 files.

### Frontend (Vitest + jsdom)

- `fuzzyMatch.test.js` — subsequence in/out, word-boundary and contiguity
  scoring, bare-name beats mid-path, determinism of ties, span indices are
  non-overlapping and in order.
- `useQuickOpen.test.js` — list refetched on every open (stub counts calls);
  a working-location switch empties query and list.
- `quickOpenDialog.test.js` — empty query shows top-level entries; typing
  filters without a second fetch; Enter picks the highlighted row; a path is
  never injected as HTML.

### e2e (Playwright, own server, endpoint from `.env.test`)

1. focus the Monaco pane → Ctrl+P → the dialog is up, Print did **not** fire;
2. type a fragment of a nested file's name → the row appears → Enter → the tab
   strip holds that file and focus is back in the pane;
3. a path hidden **or read-only** by the workspace policy is never in the list, whatever is
   typed;
4. Escape closes and returns focus; re-opening keeps the previous query.

## 7. Note for `AGENTS.md` when this lands

One clause beside the Editor's file-surface sentence:

> The Editor's quick-open finder lists exactly the paths the tree lists minus
> the read-only ones — a hidden folder is pruned and its names never shown —
> and matches them in the browser against one policy-filtered listing.

## 8. Resolved questions

1. **`node_modules` and friends** — **resolved: the policy, via `ro`.** The
   workspace already tags dependency folders `ro`; the finder excludes `ro`
   paths (2.5), so no new rule and no built-in ignore list is needed. The
   policy file remains the only exclusion mechanism.
2. **Empty query** — **resolved: top-level entries** (2.8). No recency store.
3. **A visible entry point** — **resolved: the chord only.** Ctrl+P is a common
   shortcut; no icon button in v1. Adding one later is a one-component change.
4. **Chord reach** — **resolved: Monaco *and* the tree** (2.1), as drafted.
   The chord is claimed on the Editor tab's two focus surfaces, nowhere else.
