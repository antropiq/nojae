# 15 — The project's own words

**Read first**: `docs/settings-dialog-migration-plan.md` §10 (the docs table) and §8's
T14. Then the files it names. Then `todos/sdmp-00-big-picture.md`.

The rework changed what a user sees and how they add a model, so the documents that
describe the dialog must say what it now does — and **nothing else** in them is
touched.

## Deliver

### 1. `README.md` — the model connection section

Its heading is `### The model connection — Settings → **Models**`. Change it to name
**Servers**. Inside it, step 1's description of **Fetch models** is now wrong: it says
the names "are listed under the button and fill the name list the model field completes
from". Replace that with the truth of the new page:

- the answer is a **`name` / `Add` table** under the API key, which scrolls inside
  itself;
- a row's `+` **adds that model under that server** — it writes the row with the
  server's id and the endpoint's default samplers, and opens the model's page with the
  name filled in;
- **Fetch models is unavailable until the server is saved**, because listing needs a
  server that has a row. That sentence replaces any claim that it works on an unsaved
  server — the section currently makes that claim explicitly ("It dials the URL in the
  field, so it works on a server that is not saved yet"), and it must go.
- Mention the toolbar in one clause, because the section currently describes the verbs
  as living on each form: they are now three verbs over the tree and they act on the
  page on screen. One sentence, not a paragraph.

Keep the section's shape and length. `AGENTS.md`'s maintenance rule applies to the
README here too: **shrink the paragraph the rework invalidated rather than appending a
newer one beside it.**

### 2. `README.md` — the data-files table

Its row for `nojae.db` currently reads *"The servers and the models under them, each
server with its key; the agents; the prompt helpers. | the Settings and Agent-modes
dialogs — and nothing else"*. If it describes the dialog's shape at all, name the
toolbar, so a reader learns that a click there is what writes. If the row does not
describe the shape, leave it alone — do not add a sentence to a table row that does not
need one.

### 3. `AGENTS.md` — probably no change, and that is a decision

Spec §10 says this file `likely needs **no change** — do not add one`: it names the
store and its routes, not the card. Read it and confirm. If, and only if, a sentence
there describes the dialog's shape (its sections, its footer, its verbs), correct that
sentence in place. **Do not add a paragraph about this rework.** This file is injected
into every chat turn and every line is paid for there.

### 4. `docs/nojae-settings-workspace-spec.md` — a pointer, not a rewrite

That document pins the dialog's sections and footer (the group-1 fields, the MCP/LSP
`Save`). Add **one pointer** to
`docs/settings-dialog-migration-plan.md` at the place it pins the dialog, saying that
the layout it pins has since been reworked and where the current shape is described.
Do not rewrite §5, and do not mark the old document superseded — its field-level
content is still right; only the layout moved.

### 5. `docs/agents-dialog-rework.md` — one line

Its toolbar and message-band rules are now the shared house idiom, used by two dialogs
(and a template for a third list-editor). Add **one line** in its §3.2 area — the
section that establishes the toolbar — saying that the Settings dialog's Servers
section now uses the same idiom, with a pointer to the new spec. Do not restate the
rules there.

## Do not

- **Do not rewrite any document wholesale.** Every change here is a sentence
  corrected, replaced or added — never a new section, never a summary of this lot.
- **Do not add a changelog, a migration note or a "what changed" list** to any
  document. The specs record the reasoning; the project's words record the state.
- **Do not touch `docs/settings-dialog-migration-plan.md`.** It is the spec, and its
  `Status` line is the only candidate — leave it: the lot's own big picture records
  where the work landed.
- **Do not add a machine-specific command, port or path** to `AGENTS.md`. If a
  correction there needs an example, it does not: name the invariant instead.
- **Do not touch `src/` or `web/`.** This task is documentation only.

## Files

- `README.md` — the model-connection section's heading and its Fetch-models
  paragraph, plus the `nojae.db` table row only if it describes the dialog's shape.
- `AGENTS.md` — only if a sentence describes the dialog's shape.
- `docs/nojae-settings-workspace-spec.md` — one pointer.
- `docs/agents-dialog-rework.md` — one line.

## Rules it must not break

- *"This file states **what the app is and how its pieces fit**, not how to build it.
  … No **code details that move**: no line numbers, quoted code, exhaustive route or
  member lists, counts or version numbers. … A **big-picture view only**."* Applies
  to every line this task adds to `AGENTS.md` — which is why "probably no change" is a
  legitimate outcome.
- *"Keep it **short and current** — the shorter it is, the more of it a model actually
  holds. When the code a paragraph described changes, shrink or cut the paragraph
  instead of appending a newer one beside it."*
- *"One idea per bullet. A test that exists to enforce an invariant is worth naming as
  a pointer — the invariant stays the point."*
- *"Setup, run and test commands live in the README"* — the README keeps holding them;
  nothing here moves a command.
- *"Those files may hold secrets, so they are gitignored … no document about it may"* —
  nothing written here names a key, an endpoint or a path from `.env.test` /
  `.nojae/nojae-test-settings.json`.
- *"Tests stay hermetic"* — this task runs none; it changes no test.

## Depends on

Tasks 01–14 (the finished behaviour, which the words describe). Writing them earlier
would describe something that does not exist yet.

## Done when

- `README.md`'s model-connection section names **Servers**, describes the
  `name` / `Add` table and its `+` as a write, and no longer claims that Fetch models
  works on an unsaved server; the section is no longer than it was.
- `AGENTS.md` either is unchanged, or has exactly the sentence corrected that
  described the dialog's shape — and no new paragraph.
- `docs/nojae-settings-workspace-spec.md` points at
  `docs/settings-dialog-migration-plan.md` from the place it pins the dialog.
- `docs/agents-dialog-rework.md` says in one line that the idiom is shared.
- No document gained a changelog, and `grep -n 'Settings → \*\*Models\*\*' README.md`
  finds nothing.
- `cd web && npm test` is still green (nothing this task touches is code, but the run
  is how the task is closed).

Finish by moving this file into `todos/done/`.
