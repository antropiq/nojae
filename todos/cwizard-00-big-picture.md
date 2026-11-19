# The connector wizard — "Set me up!" (lot big picture)

The full design is `docs/mcp-lsp-connector-wizard.md`. It is settled: every
question is answered there and nothing in this lot re-opens a decision. Read it
before your task; this file is the map and the rulebook, not a summary of the
prose.

## What is being built

Two buttons (`Set me up!`), one per tool-hub panel, opening **one** three-page
modal dialog. From the MCP panel the first page offers a **committed catalogue**
of nine well-known MCP connectors; from the LSP panel it offers language servers
the model **proposes for this folder**, grounded in a read-only workspace scan.
Page 2 prepares the chosen candidate with a model call and shows the JSON member,
the install line and whether it looks installed. Page 3 shows the member verbatim
in a read-only block, the **hubs' own loader's verdict** on it, the absolute path
of the declaration file it belongs in, and the copy action. That is the whole
feature.

**Nothing writes a declaration file, nothing starts a connector or a language
server, nothing installs a package, nothing spawns the candidate.**

## The invariants (all of §4, §5, §6, §7, §8 of the spec — none is negotiable)

1. **Never writes a declaration.** No save button, no "remember", no server-side
   draft. Snippet is text handed to the user. The app's standing rule is
   untouched: a declaration entry is *created only when absent and changed only
   outside the app*.
2. **Never a process.** No connector start, no language-server start, no trial
   run, no install, no download. **Resolving a program's path is not starting
   it** — that is the one thing that may be done.
3. **Never a second file reader.** The scan answers derived facts from a fixed
   manifest allow-list and **never returns file bytes**. It goes through the
   workspace policy: the reserved folder stays invisible, a hidden path is absent
   (not pruned-with-a-note), a read-only path is not read. It stops at the
   existing walk cap and says it stopped.
4. **Cannot produce a snippet the app would refuse.** Page 3's verdict is the
   hubs' own loader's words, plus the command-resolution check, plus a duplicate
   id/`_`-key *warning* (never a stop). No second validator.
5. **Never invents** a version pin, a registry name or a documentation URL. MCP
   command lines come only from the catalogue; an LSP command line is checked
   against this machine before it is offered.
6. **The model step**: one call per step, through `core/llmkit` (the one seam
   that speaks HTTP), **non-streaming and tool-less**, resolved **per wizard at
   its start** from the agent the panel is showing. **One attempt, no waiting** —
   the chat turn's refused-round wait is explicitly *not* reused here. A failed
   call, a garbage answer and "nothing fits" are three different sentences. Its
   tokens enter **neither** the session clock **nor** the cost badges, and no
   number is ever shown in the dialog; what every page shows from the moment it
   opens is the header line naming agent, server and model.
7. **Values**: paths in a snippet are environment references
   (`${NOJAE_PATH_LOCATION}`, optionally plus a sub-folder), never a literal
   absolute path. A required secret is the **one canonical sentinel**
   `__put_your_api_key_here__` in the value slot; the alternative `"${NAME}"`
   form stays available and the page says which of the two it shows (default:
   sentinel). The dialog never asks for and never displays a secret. Nothing
   downstream (panels, tool lists, hubs) is taught to recognise the sentinel —
   **no verification is added anywhere after the paste**.
8. **The snippet is always a member, never a whole file.** A missing declaration
   file becomes a sentence plus the path to create.
9. **The install hand-over fills and only fills** the composer: never arms, never
   sends, never focuses a send control.
10. **Neither list offers "none of these."** An unmatched need is one sentence
    naming the declaration file, and the road ends there.
11. **The only gate is the model.** The buttons are live during a streaming
    reply, during a batch, while the toggles are locked, while the agent mode
    switches that hub off, and when a hub route refused the workspace. With no
    resolvable model for the current agent both buttons are inert and say why,
    in the app's **existing** agent-refusal words (reused verbatim, not
    rewritten for this feature). **The wizard has no restart button of its own.**

## Where the pieces live

| piece | lands in |
|---|---|
| the MCP catalogue (committed data, the only source of a package name) | `mcp_connectors/catalog-mcp.json`, read by `src/core/mcphub/catalogue.py` (path a patchable `mcphub.constants` attribute, read at call time, mirroring `MCP_SETTINGS_TEMPLATE`) |
| the scan | `src/core/editorfs/projectfacts.py` — same policy verdicts, same walk cap as quick-open |
| the model step + the two prompts | `src/core/wizard/` (new core package: `prompts.py`, `modelstep.py`) |
| the snippet's verdict | `src/core/wizard/snippet.py` — reuses the hubs' loaders |
| the routes | `src/api/routes.py`: catalogue + connection reads are **installation-scoped**, scan/propose/prepare are **workspace-scoped** like every other workspace route; all of them write nothing |
| the rules | `web/src/composables/useConnectorWizard.js` — the `useSettingsServers` / `useAgentModes` idiom: page order, gates, and **every sentence a plain function**, so the template decides nothing |
| the dialog | `web/src/components/ConnectorWizardDialog.vue` — one instance, mounted where the other app-level dialogs are mounted (`App.vue`, beside `BatchModeDialog`), rendering answers only |
| the two buttons | one line each in `WorkBenchMcpPanel.vue` / `WorkBenchLspPanel.vue` heads, left of restart, plus the reworded empty-state sentences |

## Vocabulary (exact strings — one spelling each, asserted by tests)

- button tooltip **and** accessible name: `Set me up!` (glyph: sparkle/wand inline
  SVG, `aria-hidden`, in the same 1.5rem box as the restart glyph beside it)
- header line: `Wizard is running with <agent> on <server> — <model>`
- secret slot: `__put_your_api_key_here__`
- readiness: `looks installed` / `not installed`
- workspace reference: `${NOJAE_PATH_LOCATION}`

## House rules quoted from AGENTS.md (every task obeys these)

- "Core owns logic, the API owns transport … nothing under `core` may import the
  API layer."
- "One LLM layer. Every model call … goes through `core/llmkit`."
- "A refused round waits, and only it does." — the wizard is the deliberate
  exception stated by the spec: it makes **one** attempt.
- "**`.env` is regenerated from a fixed template on every settings save**" — so
  no wizard sentence may tell a user to "add it to `.env`".
- "Every write surface is the browser's alone" and "Tools are read-only by
  design." `tests/test_write_surface_isolation.py` asserts the shape of that
  promise; this lot extends it (AC-14) rather than working around it.
- "Tests stay hermetic": no test reads a real model connection, reaches a live
  hub or opens the settings store. The suite runs on a temporary store;
  `NOJAE_DISABLE_MCP` / `NOJAE_DISABLE_LSP` switch the hubs off. Every workspace a
  test names is a `tmp_path` one.
- Frontend: "`composables/` hold app-shell and stream state"; "`lib/` holds the
  single markdown renderer — all rendered HTML goes through it, never raw
  `v-html`"; the tree's per-file-type icons are generated, never hand-edited.
- README carries setup/run/test commands; AGENTS.md carries only the big picture
  and stays short.

## Tests, how they run

- backend: `pytest`
- frontend: `cd web && npm test` (vitest, jsdom, specs in `web/tests/`)
- end to end: `cd web && npm run test:e2e` (Playwright, specs in `web/e2e/`,
  numbered `NN-<slug>.spec.js`; its own model connection from `.env.test` +
  `.nojae/nojae-test-settings.json`, never a developer's)

## The tasks, in execution order

| # | title | depends on |
|---|---|---|
| 01 | the MCP catalogue | — |
| 02 | the workspace scan | — |
| 03 | the model step | 01, 02 |
| 04 | the snippet and its verdict | 01, 02 |
| 05 | the routes | 01, 02, 03, 04 |
| 06 | the wizard's rules (composable) | 05 |
| 07 | the dialog | 06 |
| 08 | the two buttons and the empty states | 06, 07 |
| 09 | the end-to-end spec | 05, 06, 07, 08 |
| 10 | the project's own words | 01–08 |
| 11 | the acceptance sweep | all |

Each task is finished when **its own file has moved from `todos/` into
`todos/done/`** — that move is the acknowledgement, so do it last, after the
checks in that file pass. The runner never reads task bodies: it re-lists the
folder and relaunches whatever is still there.

## Acceptance (spec §12 — task 11 walks this list and nothing else)

1. Each panel shows Set me up! left of its restart, same box, that tooltip; both
   panels keep their width, height and head layout.
2. Each empty state invites the click instead of only naming the file.
3. MCP opens on the committed catalogue, running no model until a candidate is
   chosen; LSP opens on servers proposed for this folder by the agent. The family
   is never asked.
4. A folder with CSS files and no CSS tooling proposes a CSS language server
   first, with an evidence line naming the files it saw.
5. A Python project with no Python server ranks a Python server first; a language
   the project already serves does not lead.
6. No resolvable model → both buttons inert and saying why, in the app's existing
   words.
7. An unreachable model is a named sentence on the page, distinct from an empty
   candidate list.
8. Page 2 shows the complete member and, when something must be installed, the
   install line and whether it looks installed already.
8a. A key-bearing catalogue entry produces a snippet carrying the canonical
   sentinel in the value slot; page 3 says it will not authenticate until it is
   replaced. No snippet ever carries a key the app has seen.
9. A snippet is refused when the loader would refuse it, in the loader's words,
   naming the field to change.
10. An accepted snippet copies in one click, and the copy says so.
11. A duplicate id is a warning and the snippet is still offered.
12. Page 3 names the absolute path of the declaration file and says a restart
    applies it.
13. No snippet carries a literal absolute path or a literal secret.
14. Nothing writes a declaration, starts a process or installs a package —
    **asserted**, not intended. Resolving a path is not starting.
15. The scan never reports a hidden path and never returns file bytes.
16. The wizard's model calls enter neither the session clock nor the cost badges.
17. Every page shows agent, server and model from the moment the dialog opens,
    and no token or cost number.
18. Neither list offers "none of these": an unmatched need is one sentence naming
    the declaration file, and the dialog ends there.
19. A missing declaration file yields the member plus the path to create, never a
    whole file.
20. The install hand-over fills the composer and nothing else: no send, no armed
    message, no focused send control.
21. The catalogue carries all nine settled entries, and each snippet is built from
    its `member` fields alone.
22. No panel, tool list or hub gains a sentinel check, an auth pre-check or any
    other verification of a pasted entry's readiness.
