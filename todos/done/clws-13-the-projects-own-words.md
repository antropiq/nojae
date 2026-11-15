# 13 — The project's own words

**Read first**: `docs/client-owned-workspace-spec.md` §7 in full (it is the list of
sentences to change), §6, and `AGENTS.md`'s own "Maintaining this file" section. Read
`README.md`'s "The working location" section and
`docs/nojae-settings-workspace-smoke-checklist.md` for the shape a checklist takes
here.

`AGENTS.md` is injected into every chat turn, so its sentences are load-bearing
rather than descriptive: editing it is part of the feature, not a write-up after it.
This task brings the project's own words up to the code tasks 01–12 landed.

## Deliver

### 1. `AGENTS.md`, per spec §7

Each bullet below quotes the sentence that changes and says what it becomes. Keep
the file's own rules while doing it: the big picture only, one idea per bullet, no
line numbers or code, no counts, and **shrink or cut a paragraph rather than append
a newer one beside it**.

- *"One setting defines the working location… held outside the settings store"* →
  the location is no longer held by the server at all: it is an input of each
  request, so several tabs work on several folders. The warning that follows — that
  moving it invalidates what is genuinely workspace-scoped — survives, per tab.
- *"Hubs are long-lived singletons. A restart rebuilds a hub's internals but never
  replaces the object the app holds…"* → there is one **pool**, keyed by folder, and
  the app holds it; a workspace's own hubs are rebuilt inside it. The reason the
  invariant existed is unchanged and must be kept: something other than a single
  request owns the object.
- *"Every write surface is the browser's alone … and the file ones are refused while
  a chat reply streams"* → refused while a reply streams **on that workspace**.
- *"A lot runs every task in one mode, pinned at launch"* → and in one workspace, for
  the same reason.
- *"The project-instructions file is injected into every chat turn and re-read per
  request"* → the workspace the request names, not the one the process holds.
- The browser's remembered agent stops being one browser-wide value and becomes one
  per tab.

Then the places the same change makes stale, which §7 does not list but which must
not be left saying the opposite:

- the `config` bullet in **Code layout** — the working location is no longer a
  config-sourced value; name the workspace seam instead, in one clause;
- **Code layout**'s `core/mcphub/` and `core/lsphub/` bullet — "one hub per
  workspace, held in a pool" replaces "one long-lived object", and the mirroring
  sentence stays;
- **Code layout**'s `core/termhub/` bullet — a new shell starts in its tab's folder;
  a live session keeps the one it was born in;
- **How a request flows**'s chat bullet — the workspace travels with the request;
- **Data files**' "One setting defines the working location…" bullet, and the
  `NOJAE_PATH_LOCATION` sentence wherever it survives — it is now only the
  placeholder a declaration expands, meaning the workspace being served;
- **Gotchas** — add nothing unless a task found a trap a reader would otherwise fall
  into. The two candidates are the un-scoped read (a core surface outside a scope is
  an error, never a fallback) and the ceiling (a workspace the pool refused is a
  named refusal, never an empty catalogue). Keep each to one line, or cut them if the
  rule is already said above.

The file must not grow: if the edit adds a line, another line goes. Check the result
reads as one document, not as a document plus patch notes.

### 2. `README.md`

- **"The working location"** — rewritten, not appended to. It says: the folder is the
  tab's, held in the tab's own browser storage, sent with every request that needs
  it; a reload keeps it, a new tab starts on the installation folder, the address bar
  never carries it; the app bar's field points this tab alone and is locked while this
  tab is busy. Keep the sentence about the read/write policy file and the one about
  the settings store deliberately not being part of it.
- The `${NOJAE_PATH_LOCATION}` mentions in the LSP declaration examples stay correct
  (the placeholder still expands, now per workspace) — check each one reads right and
  change only what is now wrong.
- The e2e section: the suite's own connection fixture is resolved from the
  installation folder.
- Any place that says "one working location" or "the active workspace" as a
  process-wide fact — one grep for `working location`, `workspace` and
  `NOJAE_PATH_LOCATION` over the file, and fix what the code made false.

### 3. The smoke checklist

New `docs/client-owned-workspace-smoke-checklist.md`, in the shape of the two
existing ones (a short statement of why it is human-only, the rule that binds it,
then the numbered observations with their expected answer):

- The two items task 12 left: two replies streaming at once, each naming its own
  folder in its tools' answers, on two real models; and Pause in A stopping A only.
- The pooling cost a suite cannot show: two real repositories meaning two live
  indexes and two sets of connector processes, and a workspace let go and restarted
  visibly when its tab returns.
- The ceiling reached on a real machine, and its sentence.
- A folder moved or deleted while a tab was closed: the tab opens on it, the first
  answer refuses it, the user re-points and nothing is repaired silently.
- The origin rule: run it against this machine's own folders, and in scratch
  workspaces rather than projects that matter, because a folder's admission seeds
  its reserved folder.

### 4. Nothing else

- Do not edit `docs/client-owned-workspace-spec.md`: it is the requirement set and it
  is not a changelog.
- Do not touch the older specs and checklists. Where one of them describes behaviour
  this lot changed, the README is the current word and a stale spec stays stale — a
  sweep of the docs folder is not this task.

## Files

- `AGENTS.md`
- `README.md`
- `docs/client-owned-workspace-smoke-checklist.md` (new)

## Rules it must not break

- *"This file states **what the app is and how its pieces fit**, not how to build
  it. It is injected into every agent turn, so every line is paid for there."*
- *"No machine-specific setup: no virtualenv manager, package-manager or
  browser-install commands, no ports or paths tied to one machine."*
- *"No code details that move: no line numbers, quoted code, exhaustive route or
  member lists, counts or version numbers."* So: **no ceiling number, no idle window,
  no route list**. Say "a small stated bound" and let the code say which.
- *"Keep it short and current — the shorter it is, the more of it a model actually
  holds. When the code a paragraph described changes, shrink or cut the paragraph
  instead of appending a newer one beside it."*
- *"A test that exists to enforce an invariant is worth naming as a pointer — the
  invariant stays the point."* The seam's guard test and
  `tests/test_write_surface_isolation.py` are the two worth naming.
- *"Setup, run and test commands live in the README"* — the checklist names no
  command that belongs there.

## Depends on

Tasks 01–12.

## Done when

- `AGENTS.md` carries every change in spec §7, in the file's own voice, and is **no
  longer** than it was. A reader who has never opened the code can say where a
  workspace comes from, who owns it and what is per tab.
- `AGENTS.md` states no number, no route name, no line number and no quoted code.
- The README's "The working location" section describes the tab's folder, the
  reload/new-tab rule and the address bar, and no longer says the server holds it.
- The new checklist exists, follows the two existing ones' shape, and carries the two
  items task 12 left plus the pooling, ceiling and stale-folder observations.
- `pytest` and `cd web && npm test` remain green (nothing in this task should touch
  them; if a doc test names a sentence, update it).

Finish by moving this file into `todos/done/`.
