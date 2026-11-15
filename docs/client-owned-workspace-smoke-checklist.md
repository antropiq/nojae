# Live smoke checklist — the client-owned working location

The human-only half of this feature's verification (spec
`client-owned-workspace-spec.md` §10). The suites prove the contract
hermetically, against temporary workspaces and disabled hubs; what is left needs
two real browser tabs, two real folders, real models — and the costs that only a
machine shows. **No automated task runs this list.**

## The rule that binds it

Run every item **against this machine's own model connections** (do not add a
remote one for the occasion), and in **scratch workspaces, never a project that
matters**: admitting a folder seeds its reserved `.nojae/` folder and starts its
connectors and language servers, and the terminal and the agent write there.
Create scratch folders **A** and **B** — the observations that need more say so —
and open one tab on each.

## The six observations

1. **Two replies at once, each on its own folder.** Configure tab A's agent and
   tab B's agent on two different real models. In A, send a turn that asks the
   console connector to run a command printing its working directory; while it
   streams, do the same in B.
   *Expected:* both replies stream at the same time. A's tool answer names A and
   B's names B; each tab's running line names its own model; neither tab waits
   for the other.

2. **Pause in A stops A alone.** With both replies streaming, press Pause in A.
   *Expected:* A's partial turn stays in A's transcript and closes on its own ack
   with no `done` and no truncation; A returns to idle, and B's reply continues
   untouched to its own finish.

3. **Two repositories, two live tool sets.** Open one real repository in A and a
   different one in B, each with an enabled language server and at least one
   connector. Query a symbol in each tab and call each tab's connector.
   *Expected:* each panel lists only its own folder's declarations, each tool
   answers about its own folder, and the machine is paying for two live indexes
   and two sets of connector processes. Working in one tab does not start or stop
   the other's.

4. **A workspace let go comes back visibly.** Leave one tab unused long enough
   for the pool's idle rule to release that workspace (the bound is in the code,
   not in this list), then return to it and ask for its tools.
   *Expected:* the returning tab shows the "this workspace's tools are
   restarting" line, then its connectors and language servers answer against its
   own folder again; the other tab is not disturbed.

5. **The ceiling is a sentence.** Open tabs on new scratch folders until the pool
   refuses one more than it keeps alive.
   *Expected:* the extra tab is refused with the pool's own sentence, naming the
   bound and the live folders and saying what to do; it never shows an empty tool
   catalogue. Idling or closing one live folder lets the refused tab in.

6. **A folder moved or deleted while its tab was closed.** Close a tab on a
   scratch folder, move or delete that folder, then restore the tab.
   *Expected:* the tab opens on the folder it remembers; the first answer refuses
   it and names why; the field still holds the old path; re-pointing to a real
   folder works. Nothing is repaired or substituted silently.

## What this list does not cover

- The per-workspace contract itself: `tests/test_hubpool.py`,
  `tests/test_workspace_seam.py`, `tests/test_chat.py` and
  `tests/test_write_surface_isolation.py`.
- The two-tab browser flow at the interface level:
  `web/e2e/11-two-tabs.spec.js` runs it against a real server, temporarily pinned
  settings and scratch roots. What it cannot show is two live language-server
  indexes and the machine's cost.
