# Task 04 — The snippet, and the three checks that make it trustworthy

## Deliver

`src/core/wizard/snippet.py`: takes the text page 2 produced and answers whether
page 3 may present it as trustworthy — with **the app's own verdict, not a second
opinion** (§6 of the spec). Three checks, and the values it returns are what the
dialog renders.

1. **Build the member.** For MCP, the snippet is built from the catalogue entry's
   **`member` group and nothing else** — an entry's install line, docs link,
   signals and description are the wizard's own material and must be incapable of
   reaching the JSON (AC-21). For LSP, from the prepared answer. The output is
   **always a member** (`"id": { … }`), **never a whole file** (AC-19): a missing
   declaration file changes a sentence, not the shape.
2. **Check 1 — the app's own loader reads it.** Hand the member to the **same
   validator that reads the real declaration file**, per family, and report its
   words verbatim (AC-9). Today both loaders (`mcphub.discovery.load_externals`,
   `lsphub.discovery.load_lsp_servers`) validate *inside* their file walk, so
   extract each one's per-entry validation into a function the file walk calls and
   this module calls — **one validator, no drift**, and the file loaders' existing
   behaviour and their tests must stay green and unchanged in wording. A refusal
   names the field to change.
3. **Check 2 — the command is *resolved*, never spawned.** For a member with a
   `command`, ask whether `argv[0]` resolves **the way the hub would look it up**:
   `shutil.which` over **the environment the child would actually get** (the LSP
   hub replaces `PATH` wholesale with the declaration's own `env.PATH`; the MCP hub
   builds its child environment through `mcphub.process.connector_environment`
   merged with the entry's `env`). Reuse those rules rather than restating them —
   if the hub's helper is a private method, extract it so the hub and this check
   call one function: *one search, one verdict*. No answer becomes the readiness
   line `not installed` with the install line beside it; an answer is
   `looks installed`. **Nothing is spawned to find out**, and a not-installed
   candidate is still offered — never silently dropped.
4. **Check 3 — a declared id is a warning, not a stop.** If the id is already a
   key of that declaration file, or a `_`-prefixed key of that name exists there
   (a comment key would make the pasted member a duplicate of the note), say so
   plainly and still offer the snippet (AC-11).
5. **Values, in one place** (§8): the environment-reference form for paths
   (`${NOJAE_PATH_LOCATION}`, optionally plus a sub-folder), **one canonical
   sentinel constant** `__put_your_api_key_here__` — defined once in core so the
   one spelling is assertable — and the alternative `"${NAME}"` form available,
   with the answer stating **which of the two it is showing** (default: the
   sentinel, the one shape that cannot be silently empty). A "not ready" line that
   says the entry will not authenticate until the slot is replaced. Refuse to emit
   a member carrying a literal secret or a literal absolute path where a reference
   belongs (AC-13): the sentinel's presence is the *check*, and an expansion the
   loader would perform on an absolute path is a note, not a rewrite.
6. **The hub's own reach refusal, in its own words.** Where the platform's path
   guardrails do not speak, the app already refuses to start a `local` connector
   (`mcp_reach_is_refused` / `lsp_reach_is_refused`, and the sentence in
   `mcphub.constants.LOCAL_REACH_REFUSAL`). A `local` candidate the hub would
   refuse carries that sentence into page 2's answer, so the user reads it before a
   restart rather than after it. Ask the hub's predicate; never restate the rule.

## Files it touches

- creates `src/core/wizard/snippet.py`
- edits `src/core/mcphub/discovery.py`, `src/core/lsphub/discovery.py`,
  `src/core/lsphub/manager.py`, `src/core/mcphub/process.py` **only** to extract
  the shared per-entry validator and the shared command-resolution rule so the
  hubs and this check cannot drift — behaviour and messages unchanged
- creates `tests/test_wizard_snippet.py`
- **does not** touch `src/api/routes.py`, `src/config.py`, `web/`, either hub's
  manager's spawning path, the panels or the tool lists.

## Rules it must not break

- "It cannot produce a snippet the app would refuse — the verdict on page 3 is the
  loader's, not a second opinion." If a check disagrees with the loader, the
  loader wins; adding a *second* validator is the failure mode of this task.
- **Nothing downstream re-checks anything.** No sentinel recognition, no auth
  pre-check, no readiness verification is added to the hubs, the panels or the
  tool lists (AC-22): the feature ends at the snippet and the sentence that warns
  about the slot.
- **Never starts a connector or a language server**, and never a trial run; "the
  wizard reports readiness, not a test run" (§7). Resolving a path is not starting
  it — spawning is, and spawning is out.
- "Inside the reserved folder a declaration is created only when absent and
  changed only outside the app": this module **reads** the declaration file to
  warn about a duplicate id and to name its path; it never writes it, never
  touches its mtime, and never takes a backup of it.
- Extraction rule from `AGENTS.md`: "The `core/mcphub/` and `core/lsphub/` hubs …
  mirror each other — keep that symmetry." Any function you extract for one hub,
  extract the sibling of for the other, in the same shape and same place.
- `${NAME}` expansion is the loader's job and stays there: this module never
  expands, never blanks an unresolved reference, and never resolves a value against
  `.env` — an unresolved reference is kept verbatim with a note, as it is today.
- Tests stay hermetic: no live hub, no real store, no network. Every declaration
  file exercised is a `tmp_path` one inside a scoped workspace.

## Depends on

- **01** (the catalogue's `member` group is the only thing an MCP snippet is built
  from)
- **02** (the front-end folder is the default `workspaceRoot` a member references)
- **03** (consumes the prepared answer; the two are siblings, not one module)

## Done when

1. `pytest tests/test_wizard_snippet.py` passes, and that file asserts, at
   minimum:
   - **loader parity, both families**: a member this module accepts is accepted by
     the real loader and one it refuses is refused **in the loader's words** — proved
     by running the loader over a file containing the member and comparing the two
     sentences, so "one validator" is a fact, not a claim;
   - an MCP snippet built from an entry contains **no** `requires`/`relevance`/
     `docs`/`description` value, and one holding `CONTEXT7_API_KEY` carries exactly
     the sentinel;
   - an id already present in the declaration file, and a `_`-prefixed key of that
     name, each produce the warning **and still return the snippet**;
   - resolution: a `command` whose `argv[0]` is on the child's `PATH` answers
     `looks installed`; one that is not answers `not installed` plus the install
     line, with the member still returned; and a **`PATH` the entry itself sets**
     changes the verdict (proving the child's environment is asked, not the app's);
   - **nothing spawns**: the subprocess machinery is poisoned/patched to raise and
     the whole module still answers every case above;
   - no returned member contains a literal absolute workspace path or a literal
     key, and each answer names which value form it is showing;
   - a `local` candidate answers with `LOCAL_REACH_REFUSAL` verbatim when the
     hub's predicate is on (patched the way the hub's own tests patch it);
   - the answer is a member, never a file, for both a present and an absent
     declaration file.
2. `pytest` (whole backend suite) passes **unchanged** — every existing
   `tests/test_mcp*.py`, `tests/test_lsp*.py` and `tests/test_write_surface_isolation.py`
   row included, since this task moved code inside two hubs.
3. `git status` shows no change outside the files listed above.
4. **Move this file to `todos/done/`** as the very last step.
