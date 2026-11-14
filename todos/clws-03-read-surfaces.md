# 03 — The read surfaces answer about the request's folder

**Read first**: `docs/client-owned-workspace-spec.md` §5.1 rules 2 and 3, §5.2
rules 10–12, §5.6 rules 29 and 31, §9's T2. The big picture's *The mechanism*.

Every Editor read route now answers about the folder the request names, and two
requests naming two folders are answered independently. This is the first task
where the guarantee is *observable*: two tabs, two trees, two searches, no
environment write between them.

## Deliver

### 1. Each read route goes through `require_workspace`

The routes, all under `src/api/routes.py`:

- `GET /api/fs/tree`, `GET /api/fs/file`, `GET /api/fs/stat`,
  `GET /api/fs/search`, `GET /api/fs/files`, `GET /api/fs/status`,
  `GET /api/fs/diff`.

Each obtains the workspace through `require_workspace(request)` **before** calling
into core, so a refused field answers 422 with the seam's sentence and the folder is
never touched. The core functions themselves need no new argument: task 01 pointed
them at the seam, and the API entered the scope for this request. If a core
function has to be called outside a request (a test, a script), it is called inside
`workspace.scope(root)` — do not add a `root` parameter to a surface that already
reads the seam, because two ways to name the folder is the drift this lot exists to
remove.

### 2. The project-instructions block is the request's workspace's

Verify and pin (the change landed in task 01 through the seam; this task is where
it becomes a stated contract): the block `core.chat` injects is read from the
request's workspace root, **per request**, and a turn in one tab never carries
another's instructions. Add the case: two folders, one carrying `AGENTS.md`, the
other carrying a different one, and each turn's system message carrying its own.

### 3. What each read answers, unchanged in everything else

Nothing about a read's *shape* changes: the entry caps, the policy verdict per
path, the prune the tree and the search share, quick-open's exclusion of `ro`
paths, the git rows and the diff's two sides. Only the root they are measured from
differs — and spec §5.6 rule 30 falls out here, so prove it:

- a workspace that **is** the installation folder answers with level A active
  (`.env` hidden, `logs/` reserved, the app's own files read-only) — as today;
- a workspace that is **not** the installation folder answers with level A dormant
  (its own `.env` is an ordinary file), the reserved `.nojae` folder still hidden
  in *every* workspace;
- both at once, in one process, in that order and in the reverse order, with no
  cache invalidation call between them.

That last point matters: the per-root caches (`policy_file._CACHE`,
`fscase._CACHE`) already key on the root, so no invalidation is needed and none
must be added — an `invalidate_*()` call in a route would be the second mechanism
and would make one workspace's answer depend on another's traffic.

### 4. `web/src` reads the answers it already reads

No client change is expected: task 02 put the field on every call. The one thing
to check is that a re-root does not leave a stale view — `useWorkspaceTree`'s
`reRoot`, the editor's tab-closing rule and the search/quick-open/git composables'
refresh calls all still fire on a folder change, exactly as they fired on the old
switch. If any of them was keyed on the app shell's removed `pathLocation*` slot,
repoint it at the session composable.

## Files

- `src/api/routes.py` — the seven read routes
- `src/core/editorfs/tree.py`, `files.py`, `search.py`, `quickopen.py`,
  `gitstatus.py` — only if a call site still reaches `config.path_location`
  directly (the guard test from task 01 will say so); the expected answer is "no
  change needed"
- `src/core/chat.py` / `src/config.py` — no change expected; the instructions case
  is a test, not a change
- `tests/test_editorfs.py`, `tests/test_editorfs_search.py`,
  `tests/test_editorfs_quickopen.py`, `tests/test_editorfs_git.py` — repointed at
  the field through `workspace_params`, plus the two-folder and the two-level cases
- `tests/test_chat.py` — the per-workspace instructions case
- `web/tests/` — only if a composable reached the removed slot

## Rules it must not break

- *"Path rules come from two levels, one verdict: the strictest match wins. The
  app's own rules apply only while the working location is the app's directory."*
  Per workspace, and compared per workspace (spec §5.6 rule 30). A tab rooted at
  the install directory is stricter than a tab rooted elsewhere — in the same
  process, at the same time.
- *"Inside the reserved folder a declaration is created only when absent and
  changed only outside the app. The folder is hidden from the tree, from reads and
  from git status."* A read never seeds and never writes. `.nojae` stays hidden in
  both workspaces.
- *"Core owns logic, the API owns transport."* Do not add a root argument to a core
  read in this task. The seam is the one way; a second way is the defect.
- *"Tools are read-only by design"* and *"no connector, tool or chat path reaches a
  write route"* — none of these seven routes gains a writer, and
  `tests/test_write_surface_isolation.py` stays green.
- *"Tests stay hermetic"* — every folder named is under `tmp_path`. No test points
  a workspace at this checkout; that is exactly what would make the level-A half
  of the new cases unprovable and the suite non-hermetic.

## Depends on

Tasks 01 and 02.

## Done when

- `GET /api/fs/tree?workspace=A` and `…?workspace=B` list A's files and B's, in
  either request order, with no environment write in between.
- A search, a quick-open listing, a git status and a diff each answer about the
  folder named; a refused folder answers 422 with the seam's one sentence from all
  seven routes.
- The two level-A cases are asserted in one process, in both orders: the
  installation folder is stricter than a foreign folder.
- Two turns in two workspaces carry their own `AGENTS.md` and nothing of the
  other's.
- `pytest` and `cd web && npm test` are green. The e2e suite is **not** run (it is
  rewritten in task 12).

Finish by moving this file into `todos/done/`.
