# 01 — The seam: a workspace is a value, and every path resolves through it

**Read first**: the big picture's *The mechanism, stated once* and *Interim
states*; then `docs/client-owned-workspace-spec.md` §4.1, §4.2, §5.1 rules 1–9,
§5.2 (all three rules), §8's first paragraph. §9's T1 is this task.

This task lands the seam and **changes no behaviour**: with one tab on one folder,
every answer is exactly what it is today. It creates the module that decides what
a workspace is, moves every path-resolving read under `src/core` onto it, gives
the API one place to resolve the field of a request, and adds the route that
reports a workspace. Nothing else moves — no surface changes what it answers, and
no route starts *requiring* the field except the new one.

## Deliver

### 1. `src/core/workspace.py` — the new module

Written in the house style of its neighbours (`core/editorfs/policy.py`,
`core/batch.py`): module docstring explaining the invariant, one concern per
function, no FastAPI, no browser concerns, every constant patchable at call time.

It owns, and is the only place that owns:

- **`Workspace`** — a resolved folder. One attribute, the canonical absolute root
  (the same canonical form the app already uses: `realpath`, `~` expanded). No
  policy, no cache, no hubs: those hang off the root, they are not the workspace.
- **`resolve(raw)`** — the one validator. Answers `(Workspace, None)` or
  `(None, sentence)`. It refuses, with one sentence each and in this order: an
  empty value, a value that is not an absolute path after `~` expansion, a value
  that is not an existing directory, and a value on the restricted-roots
  deny-list (`lsphub.discovery.restricted_lsp_roots()` — the same list the tree
  and the old switch already refuse by, folded per the current conventions so a
  case-folding volume answers once). The sentence names the folder and the rule
  that fired, and never what it refused to look at; the deny-list sentence keeps
  the wording the two existing call sites already emit, because spec §5.2 rule 10
  is one sentence wherever the question is asked.
- **`installation()`** — the install directory (`config.PROJECT_ROOT`). It is the
  boot workspace, the folder a new tab lands on (spec D4), and the folder
  `is_self_workspace()` compares against (spec §5.6 rule 30).
- **`default_workspace()`** — the workspace a request that names none gets *during
  this lot*, from `NOJAE_PATH_LOCATION` (which falls back to the installation
  folder). This is the interim fallback the big picture records. It lives here and
  **only** here, behind a module-level switch (`WORKSPACE_ENV_FALLBACK`, default
  on) so task 10 can turn it off and delete it in one place.
- **`scope(root)` / `current_root()`** — the request-scoped workspace, a
  `contextvars.ContextVar` holding the canonical root. `scope` is a context
  manager; `current_root()` raises a named error when no scope is entered and the
  fallback switch is off, and never silently answers the installation folder
  (spec §5.2 rule 12). The `ContextVar` is the whole mechanism: FastAPI runs a
  sync route in a worker thread that inherits a copy of the caller's context, so a
  scope entered in the request's context is visible inside the route and cannot
  leak into a concurrent one.
- **`current_workspace()`** — `Workspace(current_root())`, the convenience the
  core surfaces call.

Add `NOJAE_PATH_LOCATION` to `config.provided_env_values()` **by reading the
seam**, not the environment: the value is `current_root()` when a scope is
entered, and the environment value only through `default_workspace()`. Keep
`PROJECT_ROOT` exactly as it is. The two names must not converge: the placeholder
in a declaration means *the folder being served* (spec §4.3), `PROJECT_ROOT` means
the installation. Document that in the docstring of both.

### 2. Every path-resolving core surface reads the seam

Replace `config.path_location()` and `editorfs.policy.workspace_root()`'s own
reading of it with the seam, so that a folder resolves in exactly one way:

- `core/editorfs/policy.py` — `workspace_root()` becomes the seam's
  `current_root()`, and the refusal text in `_qualified_refusal` /
  `normalise_rel` names the same root. Every editorfs module already reaches the
  root through `policy.workspace_root()`, so they need no change of their own: they
  need only that the one accessor now answers the scope.
- `core/editorfs/builtin_policy.py` — `is_self_workspace()` compares the **scope**
  against `workspace.installation()` at call time. It is already a call-time
  comparison; keep it one.
- `core/editorfs/policy_file.py`, `policy_seed.py`, `fscase` users — keep reading
  through `workspace_root()`; the per-root caches already key on the resolved root,
  so a second workspace gets its own entry with no change.
- `core/mcphub/constants.py` (`mcp_settings_path()`), `core/lsphub/constants.py`
  (`lsp_settings_path()`) — build the path from `current_root()`.
- `core/mcphub/process.py` (`guardrails_speak_here`) — resolve the scope.
- `core/batch.py` — its three locks answer about the scope. `PROJECT_ROOT` stays
  where it is used for `sys.path`.
- `core/termhub/session.py` — `self.cwd = current_root()`. (A session still records
  the folder it was born in; task 07 makes a new one start in its tab's folder.)
- `core/appdb.py` — `test_settings_path()` keeps its shape but reads the scope, so
  a suite pointed at a temporary folder still finds its fixture there.

Leave `config.path_location()` in place: the API has not moved yet, and the fallback
in the seam reads the same value. It is deleted in task 10.

### 3. The API's one resolver, and `GET /api/workspace`

In `src/api/routes.py`:

- **One** router-level dependency that reads the query parameter `workspace`, puts
  the raw text on `request.state`, resolves it through `workspace.resolve`, and
  enters the seam's scope for the duration of the request (cleared afterwards). A
  request that names nothing gets `workspace.default_workspace()` — the interim
  behaviour the big picture records.
- **One** helper `require_workspace(request)` any route calls to obtain the
  resolved workspace, raising the seam's sentence as a **422** when resolution
  failed. No route spells the parameter name, the scope entry or the refusal.
- `GET /api/workspace` — the read that replaces the reporting half of today's
  `GET /api/path-location`: `{workspace, default, policy, mcpSettings,
  lspSettings, lspSettingsTemplate, hubs}`. `workspace` is the resolved root,
  `default` is `installation()`; the four reserved-folder blocks are exactly what
  `GET /api/path-location` reports today (read-only state reports — no seeding),
  answered **about the requested folder**; `hubs` is a placeholder object the next
  tasks fill (today: the same two hub payloads `GET /api/mcp` and `GET /api/lsp`
  answer, since there is still one of each).
- `POST /api/path-location` and `GET /api/path-location` **stay** in this task,
  unchanged in behaviour, and are deleted in task 02. They are the last callers of
  `path_location()` in the API, which is why they go together.

### 4. The guard test

New `tests/test_workspace_seam.py`, holding the invariant the rest of the lot
leans on:

- **No path-resolving surface reads the process-wide location.** A source scan
  over `src/core/**` and `src/api/**` asserting the only module allowed to name
  `path_location` is `src/core/workspace.py` (and `src/config.py`, which defines
  it). The scan is written the way `tests/test_write_surface_isolation.py` writes
  its own — a reader that walks the tree, and a case that plants a poisoned module
  in a temporary tree and asserts the scan catches it, so the guard is a guard and
  not a comment.
- `resolve()`'s refusals: empty, relative, a file instead of a folder, an absent
  folder, a folder on the deny-list — each answers a sentence naming the folder and
  the rule, and each is the *same* sentence `require_workspace` raises.
- `current_root()` outside a scope raises while the fallback is off, and answers
  `default_workspace()` while it is on.
- `provided_env_values()` expands `NOJAE_PATH_LOCATION` to the scope inside a
  scope, and `PROJECT_ROOT` to the installation inside and outside one.
- **`GET /api/workspace`** answers for two `tmp_path` folders in turn, and its four
  reserved-folder blocks are about the folder named — proven by giving each folder
  a different policy file.

### 5. The test harness helper

`tests/conftest.py` gains `workspace_params(root) -> dict`, the one way a test
builds the field (`{"workspace": str(root)}`), plus a short docstring saying why
it exists: the tests keep naming folders by value, and the field's spelling must
never be hand-written in a test any more than in a call site. Every test file that
will need it in later tasks imports it from here.

## Files

- `src/core/workspace.py` (new)
- `src/config.py` — `provided_env_values`, and the docstring of `path_location`
  marking it as the interim accessor
- `src/api/routes.py` — the dependency, `require_workspace`, `GET /api/workspace`
- `src/core/editorfs/policy.py`, `builtin_policy.py`
- `src/core/mcphub/constants.py`, `mcphub/process.py`,
  `src/core/lsphub/constants.py`
- `src/core/batch.py`, `src/core/termhub/session.py`, `src/core/appdb.py`
- `tests/conftest.py`, `tests/test_workspace_seam.py` (new)
- Any existing test whose patch target was `config.path_location` where a scope is
  now the right seam — repoint it, keep its assertion.

## Rules it must not break

- *"Core owns logic, the API owns transport."* … and *"nothing under `core` may
  import the API layer"*. The new module imports `src.config` and lazily imports
  `lsphub.discovery`; it never imports `src.api`.
- *"Every path the app holds is relative to it"* — the seam is what makes that one
  sentence mean one folder per request. Keep the boot default: an unconfigured
  install still lands on the installation folder.
- *"Path rules come from two levels, one verdict: the strictest match wins."* This
  task does not touch the verdict. `mode_for`, `normalise_rel` and the three locks
  keep their answers; only the root they measure against becomes the scope's.
- *"The declaration files are the only source of truth for what runs"*, and *"an
  unresolved name is kept verbatim with a note, never blanked."* Expansion gains
  one more provided value and keeps its behaviour: a name that resolves to nothing
  is still left written as-is.
- *"Tests stay hermetic"* — every new test names a `tmp_path` folder, and the
  guard test's scan must not be fooled by the checkout's own `.nojae`. No new test
  opens the install's store, reaches a hub, or reads a real connection.
- *"`tests/test_write_surface_isolation.py` asserts"* the write-surface invariants
  — this task adds no route that writes and must leave that suite green.

## Depends on

Nothing. This is the first task.

## Done when

- `python -c "import src.core.workspace"` says nothing, and `resolve("")`,
  `resolve("rel")`, `resolve(<a file>)`, `resolve(<absent>)` and
  `resolve(<deny-listed folder>)` each answer one sentence naming the folder and
  the rule.
- `GET /api/workspace?workspace=<folder>` answers about that folder, and
  `GET /api/workspace` with no field answers about the interim default.
- `grep` over `src/core` and `src/api` finds `path_location` only in
  `src/core/workspace.py` and `src/config.py`, and the guard test says so.
- `GET /api/path-location` and `POST /api/path-location` still behave exactly as
  they do today — `pytest tests/test_api.py` is green with no change to its
  `TestPathLocationEndpoint` class.
- `pytest` is green. `cd web && npm test` is green (the client is untouched).
- Nothing in the app's behaviour changed: one tab, on the installation folder,
  answers exactly what it answered before this task.
- The e2e suite is **not** run in this task; it is red from task 02 and rewritten
  in task 12.

Finish by moving this file into `todos/done/`.
