# Task 05 — The routes (transport for a wizard that writes nothing)

## Deliver

The HTTP half, in `src/api/routes.py`, over the core tasks 01–04 (§11). Four to
six endpoints, each one a thin transport: it resolves the workspace and the
connection, calls core, and turns the core's answer into a status. **No rule about
the wizard lives in this file.**

- **catalogue read** — the nine MCP entries for page 1's MCP list. **Installation
  scoped** like `GET /api/agents` and `GET /api/config`: the catalogue belongs to
  the install, so it answers the same way whatever folder the request names, and
  it must keep answering when the folder the tab named has been deleted. It returns
  the identity + member + requirements + relevance groups and the loader's notes,
  plus a sentence when the file could not be read (never a silent empty list).
- **connection read** — what the dialog's header line is built from and what the
  buttons' gate reads: for the agent the panel is showing, `canRun` plus the three
  names (agent label, server, model) and, when it cannot run, the refusal.
  **Installation scoped**, and its refusal is `config.agent_connection_refusal`'s
  sentence — **reused verbatim, never rewritten for this feature**. Nothing here
  returns an `api_key`, a URL or any sampler value: the dialog shows three names
  and no numbers, and the credential never leaves the server (§8: the dialog never
  displays a secret).
- **scan read** (workspace-scoped) — the derived facts of task 02 for the folder
  the request names, with the **declared** MCP ids and LSP ids filled in from the
  hubs' loaders (the scan takes them as data; a route is the one that joins them).
- **propose post** (workspace-scoped) — resolve the connection **once** from the
  named agent, run task 03's propose, return `ok` / `empty` / `failed` with its
  sentence. A 422 that **names the field** when the agent id names no row — the
  app's standing rule, never a silent default agent.
- **prepare post** (workspace-scoped, either family) — the same resolution, then
  task 03's prepare and task 04's three checks, returning the member, the verdict
  in the loader's words, the readiness line, the install line(s), the decision
  lines, the sentinel/env-reference form in use and its warning, the duplicate-id
  warning when it fires, and the **absolute path of the declaration file** the
  member belongs in plus whether that file exists.

Rules the transport has to get right:

- **Every workspace-scoped one is workspace-scoped like every other route**: the
  field is asked for **first** (`require_workspace`), so a folder that was named
  and refused is a 422 carrying the seam's sentence and never a scan of some other
  folder; a folder the pool refused is still scannable (a folder can always be
  prepared — the spec's §10 table), so these routes read the **loaders** directly
  and do **not** acquire a hub set. Discovery writes nothing and starts nothing, so
  it is not gated by anything the toggles are gated by.
- The two posts are **plain JSON posts, not SSE**: one answer, no frames, no
  terminal event, nothing entering the stream layer. The connection is resolved
  per request and held for that one call.
- A model step that fails answers **200 with a `failed` outcome and its sentence**
  (the client renders the sentence on the page and lets the user press the button
  again); a bad request answers 4xx. A 5xx would read like the app's own fault and
  invite a retry loop the spec forbids.

## Files it touches

- edits `src/api/routes.py`
- creates `tests/test_wizard_api.py`
- **does not** touch `src/core/wizard/`, `src/core/editorfs/`, either hub,
  `src/config.py`, `web/`, or the SSE events module.

## Rules it must not break

- "Core owns logic, the API owns transport." If a line of `if`/`else` in this file
  decides a wizard *rule* rather than a status code, it belongs in core.
- "**Every write surface is the browser's alone** — the Editor's file routes and
  the settings-store routes." None of these routes may reach `/api/fs` writes, the
  declaration **writers** (`set_externals_enabled`, `set_lsp_enabled`), the seeding
  path (`ensure_mcp_settings_file`), or any settings-store write. These routes
  write nothing and start nothing (§11), and they never restart a hub.
- "A workspace's `.env`, the declarations … may hold secrets, so they are
  gitignored" + §8: **no response carries a secret value or a machine's credential**
  beyond the sentinel; the header line is three names and no numbers.
- `tests/test_write_surface_isolation.py`'s contract, extended rather than worked
  around: this task adds **no new write marker**, so the marker scan and the
  `llmkit`-URL-shape guard stay as they are — and the new routes are reads plus
  two conversation-less posts, which the guard must be shown to leave out of the
  write surface (that is a test here, not a `WRITE_MARKERS` edit).
- "Moving a tab's folder invalidates that folder's hubs, policy, cached views…" —
  nothing here caches a scan or a proposal across requests.
- Tests stay hermetic: `NOJAE_DISABLE_MCP` / `NOJAE_DISABLE_LSP` are on, each test
  runs on its own temporary store, the client from `tests/conftest.py` names the
  workspace, and **no test reaches a live model** — patch the wizard package's own
  seam function, and assert on the model's absence as well as its presence.

## Depends on

- **01** catalogue read · **02** scan read · **03** the two posts · **04** the
  verdict folded into prepare's answer.

## Done when

1. `pytest tests/test_wizard_api.py` passes, and that file asserts, at minimum:
   - the two posts resolve the connection **once** per request from the named
     agent, and an agent with no model is refused with `agent_connection_refusal`'s
     sentence — asserted as **the same string** the chat's route produces for the
     same agent, so "reused verbatim" is proven;
   - an agent id naming no row is a **422 naming the field**;
   - the scan and both posts answer **the folder the request names** — two
     `tmp_path` folders with different contents side by side, each answered about
     its own; a folder that was named and refused is the seam's 422 and nothing was
     scanned;
   - the catalogue and connection reads answer correctly when the named folder is
     garbage (the installation-scoped rule the app bar relies on);
   - a folder whose hub the pool refused (or a workspace with no declaration file
     at all) still gets a scan, a proposal and a prepared snippet — the hub-free
     discovery path, asserted by poisoning hub acquisition so it must not be called;
   - **no route writes**: over a scoped workspace whose declaration files, seeded
     files and `.nojae/` contents are snapshotted before each call, every endpoint
     leaves the tree byte-identical (mtime included);
   - no response body of any of them carries a value that appears in the test
     store's `api_key`, and prepare's answer for a key-bearing entry carries only
     the sentinel;
   - prepare returns the declaration file's **absolute** path and the
     exists/does-not-exist flag, and the member it hands back is a member, never a
     file, in both cases;
   - a failed model step is a `failed` outcome plus its sentence at 200, with the
     seam's call count exactly **1** (no waiting at the transport either).
2. `pytest` (whole backend suite) passes unchanged, `tests/test_write_surface_isolation.py`
   and `tests/test_workspace_seam.py` included.
3. `git status` shows no change outside the files listed above.
4. **Move this file to `todos/done/`** as the very last step.
