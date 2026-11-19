# Task 02 — The workspace scan

## Deliver

`src/core/editorfs/projectfacts.py`: the read-only scan the wizard's LSP flow is
grounded in (§6 of the spec). It answers **derived facts about the folder in front
of the user**, never file bytes, and it is the reason a proposal can say *"Python
here (142 `.py` files, a `pyproject.toml`), and no Python language server
declared"*.

The answer it returns (a plain dict, plain values, like the rest of `editorfs/`):

- **extension counts** — the extensions present, most numerous first, with the
  file count for each;
- **which manifests exist**, workspace-relative, from a **fixed allow-list**: the
  manifests the spec names (`package.json`, `pyproject.toml`, `requirements.txt`,
  `go.mod`, `Cargo.toml`, `composer.json`, `Gemfile`, `build.gradle`) plus the
  configs that say which linter or toolchain a project already chose (eslint /
  prettier / biome / ruff / mypy / tsconfig-style ones). The list is a module
  constant so a reviewer can see the whole reach in one place. For an opened
  manifest it reports only the **declared dependency names** it parsed out (the
  keys of a `package.json` dependency block, the package names of a
  `pyproject.toml`/`requirements.txt`, and their siblings in the other
  ecosystems) — names, never file contents;
- **which servers are already declared** — passed **in** as plain data (the
  declared MCP ids and LSP ids, with their `extensions` lists), not read here:
  see the rules below. It is used to demote a language the project already serves
  and to name the gap in an evidence line;
- **where the "front end" of the project looks to be** — the folder that is the
  natural LSP `workspaceRoot` default (the one holding the web manifests /
  front-end manifests), reported workspace-relative;
- **whether the walk stopped at the cap** (`truncated`) and how many files it
  counted in total — the honest pair quick-open and search already return.

Three bounds, each a rule, all three asserted:

1. **Through the workspace policy** — one `mode_for` verdict per path, the same
   three lines `editorfs.quickopen` / `editorfs.tree` use: a `hidden` path is
   **pruned and uncounted** (so the payload cannot even confirm a hidden name, and
   the reserved folder is invisible from it), and an `ro` path is **not opened**
   (its name may still count toward an extension total, since the tree shows it,
   but a read-only manifest is not parsed). No private ignore list of any kind:
   the policy is the only exclusion mechanism.
2. **The fixed manifest allow-list** — only a path whose *file name* is on that
   list is ever opened, and nothing else is opened at all. Credential files are
   not on the list, and this task must not add anything to it beyond what the
   spec lists.
3. **The existing caps** — the walk stops at the tree's own file budget
   (`editorfs.constants`, read qualified so a test patches the name instead of
   writing thousands of files) and says it stopped. Symlinked directories are
   listed at one level and never descended, as in `tree.py`/`quickopen.py`.

## Files it touches

- creates `src/core/editorfs/projectfacts.py`
- edits `src/core/editorfs/constants.py` **only** if the scan needs a cap of its
  own (prefer reusing the existing walk cap and the existing per-directory caps)
- edits `src/core/editorfs/__init__.py` to export it the way `quickopen` is
  exported
- creates `tests/test_editorfs_projectfacts.py`
- **does not** touch `src/api/routes.py`, the hubs, `web/`, or the policy modules
  (`policy.py`, `policy_modes.py`, `builtin_policy.py`, `mcp_connectors/policy_*`).

## Rules it must not break

- "It does not become a second file reader. The scan answers derived facts from a
  fixed allow-list of manifests and never returns file bytes." (§4)
- "A hidden path is indistinguishable from an absent one to a reader" / "The
  folder is hidden from the tree, from reads and from git status." The wizard
  must not be the one surface that confirms a name the tree hides (§6).
- Both of `AGENTS.md`'s editorfs promises hold here: *"Paths are relative to the
  request's workspace, reads are bounded, no write destroys bytes, and every call
  answers from the workspace policy's verdict"*, and what the tree lists / what is
  invisible to it are **the same set** as here.
- **No writes, ever.** No mkdir, no cache file, no sidecar.
- **Nothing under `core` may import the API layer**, and `editorfs` must not start
  importing a hub: `src/core/lsphub/discovery.py` already reaches *into*
  `editorfs.policy`, so importing `lsphub`/`mcphub` from here would be a cycle.
  Declared servers therefore arrive as an **argument** — this module answers about
  facts, and task 05's route is the one that fills the declared ids in from the
  hubs' loaders.
- Paths it reports are **workspace-relative**. The one absolute path the wizard
  shows (the declaration file's) is resolved elsewhere — not here.
- "Tests stay hermetic" — every folder scanned is a `tmp_path` one; nothing here
  reads the repository's own checkout.

## Depends on

None — parallel with task 01.

## Done when

1. `pytest tests/test_editorfs_projectfacts.py` passes, and that file asserts, at
   minimum:
   - a folder of `.py` files plus a `pyproject.toml` answers with `.py` leading,
     the count, the manifest present and the manifest's dependency **names**;
   - a `hidden` path (via a written workspace rule, never by patching a name list)
     is absent **and uncounted** from every part of the answer, and the reserved
     folder's own files never appear;
   - an `ro` manifest on the allow-list is not opened: its name counts, its
     dependencies do not appear;
   - a file whose name is not on the allow-list is never opened — proved with the
     poisoned-file style the neighbouring suites use (plant a credential-named file
     with content that would be reported if read, assert it is not in the payload);
   - **no value in the payload is file content** — assert the payload's shape
     carries only counts, names, relative paths and the two truncation fields;
   - patching the walk cap yields `truncated: true` with `fileCount` still the
     honest total, and the same first N paths every run (deterministic order);
   - a symlinked directory is not descended;
   - the front-end folder answers the web/front-end manifest's folder, and a
     project with none answers without inventing one;
   - a language whose extensions are already covered by a declared server (passed
     in) is reported as already served, and one that is not is reported as the gap.
2. `pytest` (whole backend suite) passes unchanged; in particular
   `tests/test_editorfs*.py` and `tests/test_write_surface_isolation.py`.
3. `git status` shows no change outside the files listed above.
4. **Move this file to `todos/done/`** as the very last step.
