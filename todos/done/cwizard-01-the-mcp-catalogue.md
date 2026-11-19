# Task 01 — The MCP catalogue

## Deliver

The wizard's only source of a package name: one committed JSON catalogue plus the
read that loads it, with the app itself knowing no package name of its own.

1. **`mcp_connectors/catalog-mcp.json`** — exactly **nine** entries, the settled
   first pass (§9 of the spec): `playwright`, `chrome-devtools`, `context7`,
   `filesystem`, `fetch`, `git`, `memory`, `sequential-thinking`, `sqlite`. All
   keyless except `context7`, which carries the sentinel
   (`"headers": { "CONTEXT7_API_KEY": "__put_your_api_key_here__" }`).
2. **A read of that file in core** — `src/core/mcphub/catalogue.py`, mirroring
   how the MCP hub reads its committed template today (`mcphub/seed.py`'s
   template read):
   - the path is a **module attribute on `mcphub.constants`** (sibling of
     `MCP_SETTINGS_TEMPLATE`, derived from the same `MCP_CONNECTORS_DIR`), so a
     test redirects it by patching one attribute;
   - the file is **read at call time**, never cached at import;
   - the reader **never raises**: unreadable/invalid JSON answers one file-level
     sentence and an empty list (the same shape the two declaration loaders use,
     so a damaged catalogue is a named state, never a crash and never a silent
     empty list);
   - a shape-valid entry whose *member* group is unusable is skipped with a
     per-entry note; the rest still load.
3. The four field groups, named as such in the file and in the reader's shape
   checks (§9): **identity** (`id`/`name`/`description`/`docs`), **member**
   (`type`, `url` *or* `command`, `headers`/`env`), **requirements** (`requires`
   per platform: package + install line; `inputs`: the slots to fill),
   **relevance** (`signals`). The `id` also keys the top-level object, like the
   declaration files do, so the loader's words are the words the panel would
   later show.
4. Every entry's **argv, executable path and package name verified by hand before
   commit** — the one thing the spec leaves genuinely open (§9, §14). For each of
   the nine, record in your commit message the upstream repository or official
   docs page you confirmed the command line against, and prefer the official
   steward over a community fork where both exist. An entry you could not verify
   stays out of the commit — the file is where that check has to have happened,
   because the app cannot reach a registry.
   - `playwright`'s member is the official `npx` server. The dead
     `mcp_connectors/playwright_mcp.py` is **not** a candidate and nothing in this
     task imports or references it.
   - **No `console` and no `fedit` entry**: both ship seeded and always present;
     offering them invites a duplicate id.

## Files it touches

- creates `mcp_connectors/catalog-mcp.json`
- creates `src/core/mcphub/catalogue.py`
- edits `src/core/mcphub/constants.py` (the path attribute)
- creates `tests/test_mcp_catalogue.py`
- **does not** touch `src/api/routes.py`, any hub manager, any declaration file,
  `AGENTS.md`, `README.md`, or anything under `web/`.

## Rules it must not break

- "The declaration files are the only source of truth for what runs." This file
  is *catalogue*, not declaration: nothing in it is read by a hub, starts a
  process, or lands in a workspace. Adding an entry stays "a data change and a
  review, never a new module under `src/`".
- The catalogue is **committed and reviewed, not user-editable per workspace**
  (§15). Do not seed, copy, generate or migrate it into a workspace's reserved
  folder, and do not add a route that writes it.
- Nothing here may hold a secret value: the only key-bearing member carries the
  one canonical sentinel, spelled `__put_your_api_key_here__`.
- No member may carry a machine-specific absolute path: where a path is needed it
  is an environment reference (`${NOJAE_PATH_LOCATION}`, `${NAME}`) exactly as a
  declaration may hold one.
- "Tests stay hermetic": no test reads a real model connection, reaches a live
  hub or opens the settings store. The catalogue read needs none of them.
- Do not modify `mcp_connectors/mcp-settings.default.json`, `console_mcp.py`,
  `fedit_mcp.py` or `path_policy.py`.

## Depends on

None — first task of the lot.

## Done when

1. `pytest tests/test_mcp_catalogue.py` passes, and that file asserts, at minimum:
   - the committed file parses and carries **exactly the nine settled ids**, and
     offers neither `console` nor `fedit`;
   - every entry parses into the four groups, and each `member` is accepted by
     the hubs' **own** MCP shape validator (the loader task 04 will reuse), so a
     snippet built from it cannot be refused for shape;
   - `context7`'s member carries the sentinel in the header slot and it is the
     only entry with a required input; no member carries any other sentinel
     spelling, any literal secret, or any literal absolute path outside an
     environment reference;
   - an unreadable/invalid file answers `([], [one sentence])` and one malformed
     entry is skipped with a note while the others load — never a raise;
   - the path is read through the `constants` attribute (a poisoned attribute in a
     temporary tree redirects the read), proving patchability rather than intent.
2. `pytest` (whole backend suite) passes unchanged.
3. The commit message names, per entry, where the command line was verified.
4. `git status` shows no change outside the files listed above — in particular no
   workspace `.nojae/`, no `nojae.db`, no `.env`.
5. **Move this file to `todos/done/`** as the very last step.
