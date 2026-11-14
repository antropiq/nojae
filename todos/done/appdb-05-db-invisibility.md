# 05 — `nojae.db` is invisible to every file surface, and protected like `.env`

## Deliver

A secret-bearing file at the install root is a new thing in this app: `.env` is already
hidden by a level-A rule and by the connectors' deny-list, and the reserved folder is
hidden wholesale, but `nojae.db` sits at the root of a tree that **is** the working
location whenever the user works on nojaé itself (D10). Give the database and its WAL
sidecars (`nojae.db-wal`, `nojae.db-shm`) the same protections, in both levels, plus
the gitignore entries.

1. **One level-A rule** in `src/core/editorfs/builtin_policy.py`, alongside the
   `.env**` and `logs/**` rules: hidden, with a reason spelled the way the other rules
   spell theirs — something like "nojaé's own settings store, which holds the model
   credentials". It is **workspace-conditional like `.env**` and `logs/**`**: a folder
   that is not the install has no reason to hide a file called `nojae.db`. Cover the
   three names with the pattern form that level A already uses for a name-at-any-depth
   check, and read the comment on the `.env**` rule before choosing it — it explains
   why a bare root-anchored pattern is not enough.
2. **The connectors' own deny-lists** (`mcp_connectors/path_policy.py`): the database
   and its sidecars unreachable by the console and fedit connectors. Inside a root the
   workspace policy decides, so what you add here is the floor that applies **outside**
   it — the `AGENTS.md` rule is that the two lists stay separate: "merging them would
   move secrets into a per-project file". Pick the list that matches on the last path
   component (`DENY_FILENAMES` / `DENY_FILE_SUFFIXES` / `DENY_FILE_PREFIXES`) rather
   than inventing a prefix that would also deny an unrelated `.db` file.
3. **`.gitignore`**: `nojae.db` and both sidecars, in the section that already holds
   `.env` and `.env.test` — the file joins them as an install-scoped, secret-bearing,
   gitignored file, with the difference that matters stated in the comment: it is
   **binary and single-writer**, so it is never hand-edited and has no committed
   template (D1).
4. **The tests that assert this rather than a sentence in a document** (D10's closing
   line), extending the existing policy tests in the style of
   `tests/test_editorfs_builtin_policy.py` and `tests/test_path_policy.py`: when the
   working location **is** the install, all three names are hidden from the tree, from
   file reads, from search, and from git status, and a write attempt is **named to
   refusal** rather than silently absent; when the working location is another folder,
   a file called `nojae.db` there is an ordinary file. And a connector-level test that
   both connectors refuse all three names outside a root.

## Files

- `src/core/editorfs/builtin_policy.py`
- `mcp_connectors/path_policy.py`
- `.gitignore`
- `tests/test_editorfs_builtin_policy.py`, `tests/test_path_policy.py`,
  `tests/test_console_policy.py`, `tests/test_fedit_policy.py` (extended), and
  `tests/test_editorfs_git.py` if git status needs its own assertion.

## Rules it must not break

- **`AGENTS.md`**: "A hidden path is indistinguishable from an absent one to a reader
  and named to a writer; a read-only path is searchable but named to a writer." Hidden
  is the right mode here — the app is the file's only editor, so a second reader of its
  bytes is exactly what must not exist.
- **`AGENTS.md`**: "Path rules come from two levels, one verdict: the strictest match
  wins. The app's own rules apply only while the working location is the app's
  directory." Do not make the rule unconditional, and do not put it in the seeded
  workspace policy.
- **The two deny-lists stay separate** (the sentence above): the level-A rule and the
  connector floor are two edits for one reason, not one shared table.
- **The app must still be able to open its own database.** Nothing in this task changes
  how the store module reaches the path — the store is not a file surface, and no
  connector or Editor path may reach it.

## Depends on

Task 01 (the file and its sidecar names must exist to be hidden). Independent of 02–04.

## Done when

- The new and extended tests pass, including the negative case (a foreign workspace's
  `nojae.db` is an ordinary file).
- `git status` in this checkout shows no `nojae.db*` entry once the app has created one.
- The backend suite passes.
