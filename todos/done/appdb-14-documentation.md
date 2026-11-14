# 14 — Documentation: the README around the dialog, `AGENTS.md` current, the two old specs marked

## Deliver

Three documents, each edited to the rule that governs it. No code changes.

1. **`README.md`'s configuration section, rewritten around the dialog rather than around
   a file** (§4.11): how to add a server, how to add a model under it, how to pin an agent
   to a model, and where the credentials live now. Places that need it, found by reading
   the file rather than this list: the settings/data-file table (the
   `nojae-settings.json` row and its "seeded from `nojae-settings.default.json`" note),
   the agent-modes section (today it documents `.nojae/agent-modes.json` as a file the
   user hand-edits, with fields instead of JSON — that whole framing goes), the LSP
   activation section (which today explains the **two** gates and the dormancy they
   bought — D13's behaviour change belongs here, stated plainly: a declaration that says
   `enable: true` runs), the tool-iteration cap section (now per agent), the prompt-helper
   bullets section (now add/delete, no fixed nine), and the "Setting up tests for nojae"
   section, whose table describes the test settings file as "the same members as the
   workspace's `nojae-settings.json`… `lspEnabled`, `maxToolIteration`" — it is now the
   nested `server { model { … } }` document of §4.6, and it seeds a temporary database the
   suite owns. Keep the README's existing voice and its rule that machine-specific setup
   lives here and not in `AGENTS.md`.
2. **`AGENTS.md`, in the three places §4.11 names** — and obeying this file's own rules
   while doing it: big picture only, no code detail that moves, one idea per bullet, and
   *shrink rather than append* when a paragraph's subject changes.
   - **the data-file table**: add the `nojae.db` row (its role: the install's model
     connections, agents and prompt helpers) and its rules — written only through its own
     routes, never through a path; it holds secrets; it is gitignored; **it has no
     committed template because it has no hand-edited member**. Delete the
     `nojae-settings.json` row — which today claims that file holds "this workspace's
     model connection **and which language servers it activates**" — and shrink the
     reserved-folder bullet that describes declarations and stores so it loses the store
     half of its sentence.
   - **the "one LLM layer" pattern**: the connection comes from the store, not from a
     workspace file. Say the invariant (one seam speaks HTTP; adding a model is
     configuration, never new code) and, if it earns its bytes, the one new thing: a turn
     resolves its agent's connection **once, at its start**.
   - **the working-location paragraph**: it stops claiming the model connection travels
     with the workspace. A workspace switch invalidates only what is genuinely
     workspace-scoped.
   - Also current by the same rule, because earlier tasks made each sentence false: the
     agent-mode bullet ("a **workspace-owned** persona" — it is install-owned now, and a
     mode still only narrows), the LSP/MCP gate sentences (one gate each, the declaration's
     `enable`), the batch bullet that promises a fallback to "the server's default" for a
     workspace with no coding mode (it is a refusal now, and an agent with no model cannot
     run a task), and the "exactly 9 slots" / per-workspace-store claims if any remain.
     Keep it short: several of these are *deletions* of sentences, not additions.
3. **The two superseded specs get a pointer at the top, not a rewrite** (§4.11):
   `docs/nojae-settings-workspace-spec.md` and `docs/prompt-helpers-workspace-scope.md`
   each gain a short "superseded by `docs/app-settings-db-spec.md`" note naming what this
   change reverses (the connection's scope; the helper's scope) and saying they remain the
   record of the decisions they made. Check `docs/nojae-test-settings-spec.md` and
   `docs/agent-modes-editor-spec.md` for the same need and give them the same treatment if
   their subject moved; do not rewrite them either.

## Files

- `README.md`, `AGENTS.md`, `docs/nojae-settings-workspace-spec.md`,
  `docs/prompt-helpers-workspace-scope.md`, and the two other docs if they need a pointer.

## Rules it must not break

- **`AGENTS.md`'s own rules**, which take precedence for that file: "This file states what
  the app is and how its pieces fit, not how to build it… No machine-specific setup… No
  code details that move: no line numbers, quoted code, exhaustive route or member lists,
  counts or version numbers… A big-picture view only… Keep it short and current — the
  shorter it is, the more of it a model actually holds. When the code a paragraph
  described changes, shrink or cut the paragraph instead of appending a newer one beside
  it." It is injected into every chat turn, so every line is paid for there.
- **`AGENTS.md`**: "No **code details that move**" — do not write the four table names or
  their columns into `AGENTS.md`; the schema belongs to the code and to the spec.
- **`AGENTS.md`**: "Setup, run and test commands live in the README" — anything about
  where `nojae.db` is created, or how to reset it, is README material.
- **The spec's own instruction for the superseded files**: a pointer, not a rewrite — they
  remain the record of the decisions they made.
- Do not put a secret, a real key or a machine-specific path in any document, including in
  the description of the test settings file (the README's existing rule: "no document
  about it may").

## Depends on

Tasks 05–13 — it documents the finished state, including the behaviour changes 06 and 12
made. Run it after 13 so the suite results it describes are the real ones.

## Done when

- `grep` for `nojae-settings`, `agent-modes.json`, `prompt-helpers.json`, `lspEnabled` (as
  a workspace-settings member) and "default mode" across `README.md` and `AGENTS.md`
  returns nothing that describes a file or a gate that no longer exists.
- `AGENTS.md` is **not longer** than it was, and every remaining sentence is true of the
  code as it now stands.
- A reader following only the README can configure a server, add two models, pin two agents
  to them, and know where the key lives and which files are gitignored.
- Both suites still pass (documentation-only change, but the file-icons and policy tests
  read documents — confirm nothing asserted on README or `AGENTS.md` text).
