# Task 10 — The project's own words

## Deliver

The feature's two documents, no more (§11). This task changes no code.

1. **README — the MCP setup file section** (the one that documents
   `.nojae/mcp-settings.json`): a paragraph saying that the MCP panel's
   **Set me up!** button offers the committed catalogue (`mcp_connectors/catalog-mcp.json`),
   that page 3 hands over a JSON **member** the app's own loader has already
   accepted, that the user pastes it into the file, and that the panel's **restart**
   is what applies it — the app reads the declaration at start-up. Say, in the
   section's existing voice, that the app **never** writes that file for you.
   Cross-reference the `${…}` explanation that already lives there rather than
   repeating it, and mention the **one** secret rule the reader needs at the paste:
   a slot spelling `__put_your_api_key_here__` must be replaced before the entry
   authenticates, and a snippet never carries a key the app has seen.
2. **README — the LSP setup file section**: the same shape of paragraph for
   `.nojae/lsp-settings.json` — the button proposes servers **for this folder**
   from what the project is actually written in, the member is checked before it is
   offered, the command's readiness is reported (`looks installed` / `not
   installed`) and the install line is the user's to run, and when the file does not
   exist yet the page prints the path to create and the member still goes inside an
   object at its top level. It stays true that the LSP declaration is seeded **only
   as a template** and that the app reads only `lsp-settings.json`.
3. **README — where the wizard's numbers are not**: one clause, in whichever
   section already speaks the session clock and the cost badges, that the wizard's
   reasoning belongs to **no conversation** and enters neither. One sentence, not a
   new section.
4. **AGENTS.md — one line.** It belongs to the hub paragraph: discovery is offered
   to the browser as a **guided preparation** that writes nothing and starts
   nothing. Name the invariant, not the mechanism — this file is injected into
   every agent turn and "the shorter it is, the more of a model actually holds".
   Do **not** describe the pages, the routes, the catalogue's contents or the
   sentinel here; do not add a data-file row for the catalogue unless the file
   stays within its current shape (one table row, and the catalogue is committed
   data, which the table's rule about gitignored secrets must not be bent to
   cover).

## Files it touches

- edits `README.md` (the two declaration sections, plus the one clause in the
  session-meters paragraph)
- edits `AGENTS.md` (one line, in the paragraph about the two hubs)
- touches nothing else: no code, no test, no comment outside these two files.

## Rules it must not break

- AGENTS.md's own rules, quoted: "No **machine-specific setup**: no virtualenv
  manager, package-manager or browser-install commands, no ports or paths tied to
  one machine." So the README carries any install-line example, and AGENTS.md
  carries none.
- "No **code details that move**: no line numbers, quoted code, exhaustive route or
  member lists, counts or version numbers." The README may name the file and the
  button; neither document may enumerate the nine catalogue entries or the wizard's
  routes — that is the catalogue's and the API module's own business.
- "A **big-picture view only** … Feature-by-feature detail belongs in the README,
  route-level detail in the code and its doc comments."
- "Keep it **short and current** — … when the code a paragraph described changes,
  shrink or cut the paragraph instead of appending a newer one beside it." Trim
  whatever the new paragraphs make redundant.
- Setup/run/test commands stay in the README and never land in AGENTS.md.
- **Accuracy over volume** — this file feeds the chat and the model acts on it. If a
  sentence the drafts above suggest would be untrue of the shipped code, write the
  true sentence, and if two tasks disagreed about what is true, report it rather
  than documenting a hope.
- Do not state or imply that the wizard can write a declaration, start a connector,
  install a package or restart a hub: it does none of those, and the README's
  existing rule ("a declaration is created only when absent and changed only outside
  the app") is what the new paragraphs sit inside.
- Do not tell a reader to put a key in `.env` — `.env` is regenerated from a fixed
  template on every settings save, so a hand-added key does not survive the next
  save. Point at the sentinel slot or an existing environment reference instead.

## Depends on

- **01–08** — it documents the feature as shipped. Not on 09: the e2e spec is not
  user-facing.

## Done when

1. Every claim the two new README paragraphs make is true of the code, each checked
   by opening what it names (the catalogue file, a page-3 payload in the composable,
   the restart behaviour of the panel) — not by trusting this lot's wording.
2. `AGENTS.md` is **no longer** than it was by more than that one line, and the one
   line names an invariant rather than an implementation.
3. `pytest` and `cd web && npm test` still pass — this task changed no source, and
   the file-icon generation test in particular is untouched (`tests/test_file_icons.py`).
4. `git status` shows only `README.md` and `AGENTS.md` modified (besides the task
   file's own move).
5. **Move this file to `todos/done/`** as the very last step.
