# Client-owned working location

**Status**: decided — every question is closed (§2). This document is the
requirement set a task breakdown is written from.

**In one sentence**: the open tab, not the server process, decides which folder
it works on, so several tabs can work on several folders at once — each with its
own agent and therefore its own model and endpoint — while every tab draws its
agents, models and prompt helpers from the same installation.

**Not in scope**: the catalogue. Servers, models, agents and prompt-helper
bullets stay installation-wide, configured once and offered in every tab. The
model half of the need already works today: an agent is pinned to its own model,
and the catalogue already holds several servers with several models. Only the
*folder* and the *agent choice* are wrongly held in one place.

---

## 1. The need

In the user's words:

> "There is no way to have a web browser tab pointing on workspace A while
> another tab is pointing on workspace B, because the active workspace is owned
> by the server part. I would like the client to own that information, so I can
> use Agent A (using server A and model A) to work on workspace A while another
> tab has Agent B (using server B and model B) working on workspace B."

Restated as behaviour the user can see:

1. Two tabs are open on the same address. Each is **on its own folder**.
2. Each tab answers as **its own agent**, so its replies run on that agent's
   model and endpoint. Changing the agent in one tab moves nothing in the other.
3. Neither tab is disturbed by the other. A reply streaming in one does not
   freeze the other's editor, refuse its saves, or re-root it.
4. A conversation in one tab and a batch run in another proceed at the same
   time. So do two conversations.
5. The agents, models, servers and prompt helpers are configured **once** and
   offered in both tabs.

Expectation 5 is the point of the whole exercise. It is what makes this
different from running two copies of the app, and it is the reason the folder
must move rather than the process.

---

## 2. Decisions taken

Recorded so later tasks do not re-litigate them.

| # | Question | Answer | What it forces |
|---|---|---|---|
| D1 | Which "server" does the need mean? | The one Python backend that holds the working location today — one process, one address | The folder must become a **per-request input**. Running a second instance is not the answer. |
| D2 | One catalogue or two? | **One.** Both tabs read the same settings store: servers → models → agents | The catalogue is deliberately untouched. Two tabs may select two different agents. |
| D3 | How many workspaces alive at once? | **As many tabs as are opened.** Opening a tab and pointing it at a folder makes that folder that tab's workspace | The app holds a **set** of workspaces, not one. A set needs a ceiling and an idle rule. |
| D4 | Does the folder survive a reload? | **A reload keeps it; a new tab does not inherit it.** A new tab opens on the installation folder and the user points it with the app bar's working-location field | The tab remembers its folder itself, in **per-tab** browser storage. Nothing is added to the URL. |
| D5 | Does the tab own its agent too? | **Yes**, and this is required: the last-used agent is remembered browser-wide today, so every tab shares it | The remembered agent becomes per tab. |
| D6 | May two tabs stream at once? | **Yes.** | "A reply is streaming" stops being a process-wide fact. |
| D7 | Must folder creation or deletion propagate between tabs? | **No.** A stale tree until the user refreshes is acceptable; this is one person using two tabs | No cross-tab invalidation channel. This removes the single most expensive-looking piece. |
| D8 | Does batch mode follow the tab? | **Yes** — a batch in one tab while another tab holds a discussion | A batch is a fact about one workspace, not about the process. |
| D9 | How is a tab addressed? | All tabs use the same address, and the address **never** names a workspace | The workspace travels with each request as a request field. No route prefix, no URL scheme, no bookmark-per-workspace. |
| D10 | What happens to a turn whose tab is closed mid-reply? | **It is cancelled** — and that is the user's responsibility, not the app's | This already works: the stream's cleanup sets the cancel flag when the client goes away. Nothing to build, but it must not regress. |
| D11 | Does a tab's folder outlive the tab? | **No.** Closing the tab forgets it; opening a tab puts the user on the installation folder to point where they like | Per-tab browser storage, not remembered browser-wide and not persisted on the server. Every tab is entered deliberately. |

---

## 3. What the tab already owns, and what it must take over

The browser already owns the entire **view**: open buffers, tree expansion,
scroll positions, splitter sizes, the chat transcript and the active tab are all
per tab today. Two tabs are already two independent views.

What they do not own is any **answer**, because the folder is process state. So
this is not "make the app multi-user". It is:

> Retire one piece of process state — the working location — and one piece of
> browser-wide state — the chosen agent — and make both belong to the tab.

That one piece of process state is read by every file-touching surface in the
app, and by three long-lived subsystems that were built around its being fixed.
That is the whole cost of the feature.

### 3.1 What is process-wide today, and why it blocks two folders

| What | Why it blocks two folders |
|---|---|
| **The working location** — one environment value, read live at every call | It is the answer to "which folder", and there is one answer |
| **The MCP connector hub** — one long-lived object | Each local connector is started *with* the folder as its root argument, so a connector is bound to one folder for its lifetime |
| **The language-server hub** — one long-lived object | Same: each server is started with the folder as its workspace root and indexes it for its lifetime |
| **The terminal sessions** | The registry is shared, but a session already records the folder it was born in; only "where a new shell starts" has to follow the tab |
| **The in-flight reply slot** | One reply at a time, and one Pause target |
| **"A reply is streaming" as a refusal** | Written as a global fact, consulted by the write routes, the hub restarts and the folder switch |
| **The chosen agent** | Remembered in browser-wide storage, so every tab shares one choice |

Two consequences drive the rest of this document:

1. **A hub is bound to a folder at birth, not at call time.** Two folders cannot
   be served by pointing one hub at two roots. It takes **one of each per
   folder** — that is, per workspace, its own connectors and its own language
   servers. There is no cheaper shape.
2. **Several refusals are phrased as global facts** — the write surfaces, the
   hub restarts, the folder switch and the working-location field's own lock.
   Each becomes a fact about a workspace. That is more work than the status quo,
   and it is also strictly better behaviour: today each rule is only correct
   because one tab exists.

---

## 4. The model: a workspace-scoped session

### 4.1 The session

The unit the browser owns is a **session**: one open tab. A session carries
exactly two things.

- **Its workspace** — one folder, absolute and canonical, chosen by the user.
- **Its agent** — one agent id from the installation's catalogue, chosen by the
  user, remembered across reloads.

Both are held **in the tab's own storage**, so both die with the tab and neither
is visible to a sibling tab (§8). Everything else the tab already owns stays
where it is. Nothing else is added to the session.

The session is **not** a login, a permission or a security boundary. The app is
single-user and loopback-only. The workspace a session names is *correlation* —
it tells the server which folder to answer about — and it is validated on every
use by the same path policy that guards it today. Naming a folder in a request
grants nothing that the path policy does not already grant.

### 4.2 Three scopes, stated once

This distinction is the spine of the feature and every task must respect it.

| Scope | Contents | Lifetime |
|---|---|---|
| **Installation** | Servers, models, agents, prompt-helper bullets, technical keys, the settings store | The install. Shared by every tab. |
| **Workspace** | The folder's reserved declarations, its read/write policy, its project instructions, its connectors, its language servers, its cached tree and search answers | While at least one tab is on it, and not longer |
| **Tab** | Open buffers, tree expansion, scroll, transcript, active tab, **its workspace**, **its agent** | The tab |

The existing rule survives intact, read one level up: *moving a tab's workspace
invalidates what is genuinely workspace-scoped, and never the settings store,
which is the installation's.*

### 4.3 Every workspace is its own tool host

Each workspace alive in the app gets **its own** connectors and language servers,
started against it, answering about it and nothing else, and torn down when it
is let go.

The reserved declaration files stay exactly as they are, authored per workspace
and referencing the working-location placeholder. That placeholder must now mean
*the workspace being served*, not a process-wide value. A tab on folder A must
get A's connectors, A's language servers and A's read/write policy; a tab on
folder B must get B's. This falls out of the design rather than being extra
work: each repository carries its own declarations.

The install-root placeholder keeps its present meaning — the installation — and
must not be confused with the workspace.

### 4.4 Bounding the set

"As many tabs as I open" is the requirement; it is not a licence to keep N sets
of connector processes and N language-server indexes resident forever. The app
therefore needs, from the first line of code rather than after a memory report:

- a **ceiling** on workspaces kept alive at once, small and stated;
- an **idle rule** that lets an unused workspace go, with a visible restart when
  a tab returns to it rather than a silent pause;
- a **veto**: a workspace with a streaming reply or a running batch is never let
  go;
- a **sentence** the interface shows when the ceiling is reached, naming the
  rule. Never a silent eviction of the tab that just asked.

---

## 5. Functional contract

Written as behaviour, so it can be broken into tasks. Every line should be
readable by someone who has never opened the code.

### 5.1 A tab always knows its workspace, and nothing else decides it

1. A tab works on exactly one folder at a time, chosen by the user.
2. Every answer the tab receives — tree, reads, search, quick-open, git status,
   terminal start, batch listing, the agent's tools, the injected project
   instructions — is about **that** folder.
3. Two tabs on two folders never observe each other's answers.
4. Two tabs *may* hold the same folder; they then see the same answers.
5. A tab's folder survives a reload. On reload the tab returns to its own folder
   without asking again.
6. A **newly opened tab starts on the installation folder**, whatever the other
   tabs are on. It never inherits another tab's folder, and the user points it
   with the app bar's working-location field before working.
7. The remembering is **per tab** — it ends with the tab. Closing a tab forgets
   its folder; there is no browser-wide or server-side memory of it.
8. The address bar never carries a workspace. Two tabs showing the same address
   can be on two different folders; the address says *which app*, never *which
   folder*.
9. The folder is visible in the tab in one place, and it is the value the
   agent's tools are rooted at — one value, not two that can drift.

### 5.2 The workspace is validated before it is used, in one sentence

10. A folder that is missing, not absolute, or under a restricted path is
    refused, with the same sentence wherever the question is asked.
11. A refusal names the folder and the rule that fired. It never confirms what it
    refused to look at.
12. No surface falls back to a different folder. A refusal is an answer, never a
    silent substitution.

### 5.3 A second tab is a peer, not a guest

13. A reply streaming against one workspace obstructs nothing about another: its
    writes are not refused, its hubs are not restarted, its folder is not pinned.
14. A reply streaming against a workspace **does** refuse writes to that same
    folder, whoever asks — the protection the model's own edits need today, kept
    with the workspace as its subject instead of the process.
15. Pause reaches the reply the tab is showing, and never another tab's.
16. Two conversations may stream at the same time, on the same model or on
    different ones. The app does not serialise turns across tabs.
17. Per-tab view state — open buffers, tree expansion, scroll, transcript,
    active tab, chosen agent — stays that tab's, as today.
18. **Closing a tab ends the turn it was streaming.** The turn is cancelled, its
    partial reply is kept nowhere, and no work continues for a tab that is gone.
    This is the user's responsibility, not a prompt to confirm.
19. A tab's working-location field is locked only while **that tab's** workspace
    is busy. A reply streaming in another tab never stops this tab from pointing
    elsewhere. The field still explains its own lock in one line.

### 5.4 Each workspace's tools are its own

20. Every workspace alive has its own connectors and language servers, rooted at
    it, answering only about it, torn down with it.
21. The working-location placeholder in a workspace's declarations resolves to
    that workspace.
22. The number of workspaces kept alive is bounded and the bound is stated when
    reached.
23. A workspace whose tools were let go is **restarted visibly** when a tab
    returns to it, not silently left without tools.
24. A workspace with a streaming reply or a running batch is never let go.

### 5.5 The catalogue stays the installation's

25. Every tab is offered the same servers, models, agents and prompt-helper
    bullets, configured once.
26. Which agent a tab answers as is that tab's choice, remembered per tab.
27. A turn resolves its agent and its model **once, at its start**; a settings
    change made in another tab never splits a turn already streaming.
28. Nothing about a folder is written into the catalogue, and a tab changing
    folder invalidates nothing that belongs to the installation.

### 5.6 A workspace's own rules stay its own

29. The read/write policy comes from the workspace each request names, and the
    strictest matching rule still wins.
30. The app's own built-in rules still apply **only** when a workspace is the
    installation folder. A tab rooted at the install directory is stricter than
    a tab rooted elsewhere, and that comparison is made per workspace.
31. The project instructions at a workspace's root are injected into that
    workspace's turns and re-read per request. A tab never receives another
    workspace's instructions.

### 5.7 Batch mode follows the tab

32. A batch run belongs to one workspace: its lot is that folder's lot, listed
    through the same path policy as everything else.
33. A batch pins its agent at launch, taken from the tab that started it, and a
    change of agent in any tab afterwards reaches no task in the run.
34. A batch running in one tab freezes nothing in another; a reply streaming in
    one tab does not block a batch in another on a different folder.
35. "A batch is running" remains a fact about a workspace, not about the app.

---

## 6. Limits and deliberate non-goals

Stated so no task tries to solve them.

**Out of scope — no work at all**

- **No cross-tab invalidation.** A folder created or deleted on disk is
  invisible to the app until the user refreshes. A stale tree in the second tab
  is accepted behaviour.
- **No isolation between two tabs on the same folder.** Two editors on one file
  are still last-write-wins. The streaming rule protects read-versus-write
  coherence, not two concurrent edits.
- **No multi-user story.** No accounts, no per-user folders, no authorisation.
  The session is correlation, not security (§4.1).
- **No second instance, no second address.** One backend, one store.

**Limits that remain afterwards**

- **Resources are paid per live workspace.** Two large repositories mean two live
  indexes and two sets of connector processes. The ceiling and the idle rule are
  the answer, and they are not free.
- **Installation settings are still shared.** A settings save in one tab affects
  what the *next* turn in every tab resolves. Streaming turns are safe (§5.5,
  rule 27), which is what keeps this tolerable.
- **A server restart ends every tab's stream.** With the folder held by the
  browser, each tab reconnects to its own workspace afterwards — better than
  today's outcome, but the stream itself is gone. A reload, by contrast, brings
  a tab back to its own folder and agent.
- **Closing a tab mid-reply kills that reply.** Accepted, per D10: the tab owned
  the turn, so the turn goes with it. The partial answer is not recoverable.
- **A remembered folder is convenience, not a guarantee.** If the folder was
  moved or deleted while the tab was closed, the tab opens on it and the first
  answer refuses it (§5.2). The user re-points; nothing is repaired silently.

---

## 7. What this changes in the project's own words

Recorded separately because `AGENTS.md` is injected into every chat turn, so its
sentences are load-bearing rather than descriptive.

- *One setting defines the working location, held outside the settings store.* →
  the location is no longer held by the server at all; it is an input of each
  request. The warning that follows — that moving it invalidates every held path
  — survives unchanged, per tab.
- *Hubs are long-lived singletons; a restart rebuilds a hub's internals but never
  replaces the object the app holds.* → there is one hub **per workspace**, and
  the app holds a pool. The invariant's reason is unchanged and must be kept:
  something other than a single request owns the object.
- *Every write surface is the browser's alone and is refused while a chat reply
  streams.* → refused while a reply streams **on that workspace**.
- *A lot runs every task in one mode, pinned at launch.* → and in one workspace,
  for the same reason.
- *The project-instructions file is injected into every chat turn and re-read per
  request.* → the workspace the request names, not the one the process holds.
- The browser's remembered agent stops being one browser-wide value and becomes
  one per tab.

---

## 8. How the tab carries its workspace

The answers in §2 fix the mechanism, and it is worth stating once because every
task depends on it.

**Each request names the workspace.** The tab sends its folder with the request
that needs one, the server resolves it for that request only, and nothing is
retained on the server between requests. The address bar stays free of it (D9),
so the folder never appears in a URL, a bookmark or a route.

**The tab holds it in per-tab storage.** Browser storage exists in two flavours
and the difference is exactly the requirement: one survives the tab, one does
not. D11 asks for the one that does not, so a closed tab forgets its folder and
a new tab starts on the installation folder. A reload is the same tab, so it
keeps its folder — which is what D4 asks for. No server-side memory, no
browser-wide memory.

**Two surfaces cannot simply take a field**, and both must be handled
explicitly rather than assumed:

- **The terminal connection** is a persistent socket opened once. It has no
  per-request body, so the workspace is supplied when the socket opens, and a
  live shell keeps the folder it was born in (as today).
- **The chat stream** already sends a request body per reply, so it names the
  workspace like any other request. Its cancellation-on-disconnect behaviour
  (D10) is a property of the existing stream and must be preserved, not rebuilt.

**Consequence worth naming**: because the folder is not in the address, two tabs
on the same address are *not* interchangeable by copy-paste of a URL. That is
accepted (D9, D11). Should bookmark-per-workspace ever be wanted, it is a later
addition on top of the same per-request field, not a rewrite of it.

---

## 9. Suggested task breakdown

Ordered so that each slice is usable and testable on its own. T1 is the seam and
changes no behaviour; everything after it is one surface moved onto that seam.

- **T1 — The seam.** Introduce the session and make one folder resolve through
  it. Behaviour is unchanged with one tab. Includes the guard test: no
  path-resolving surface reads the process-wide location directly.
- **T2 — Read surfaces follow the session.** Tree, file reads, search,
  quick-open, git status, and the project-instructions block.
- **T3 — Write surfaces follow the session**, and the streaming refusal becomes
  per workspace. Includes the reserved-folder reads and the delete and backup
  paths.
- **T4 — Per-workspace hubs.** A pool keyed by canonical folder, spawned against
  that folder, with the ceiling, the idle rule, the veto and the "let go"
  sentence. The working-location placeholder resolves per workspace.
- **T5 — Per-workspace terminal.** A new shell starts in its tab's folder; a
  live session keeps the folder it was born in.
- **T6 — Per-tab agent.** The remembered agent becomes per tab; a turn still
  resolves it once, at start.
- **T7 — Batch per workspace.** Listing, prefix dropdown, the agent pinned from
  the starting tab, and the refusals keyed per workspace.
- **T8 — Concurrent turns.** Several replies at once, and Pause reaching the
  tab's own reply. The closed-tab cancellation (D10) already works and only
  needs a test that it still does once the slot is per workspace.
- **T9 — The interface.** One visible workspace per tab, the app bar's field
  pointing this tab alone, the field's lock scoped to this tab's workspace, the
  "this workspace's tools are restarting" line, and the ceiling sentence. Also
  the entry point: a new tab lands on the installation folder, and a reload
  restores that tab's own folder and agent.
- **T10 — The project's own words.** Update `AGENTS.md` per §7 and the README,
  and add a two-tab run to the smoke checklist.

---

## 10. Acceptance

The feature is done when this can be performed without a caveat.

1. Open two tabs on the same address. Point one at repository A and the other at
   repository B.
2. In tab A select an agent whose model is a small local one; in tab B an agent
   whose model is a large hosted one. Send a prompt in each. Both stream at the
   same time, each on its own model, each naming its own folder in its tools'
   answers.
3. While both stream, tab B's editor saves a file in repository B. It succeeds.
   Saving the same way in repository A is refused, naming the reason.
4. Pause in tab A stops A's reply only.
5. Tab A's tree lists A's files under A's read/write rules; tab B's lists B's.
   Repository A's own connectors are offered in A and not in B.
6. Start a batch lot in tab A while tab B holds a normal conversation. Both
   progress; neither blocks the other.
7. Reload each tab. Each returns to its own folder and its own agent.
8. A third tab on repository A sees the same answers as tab A, with its own
   agent.
9. Open a fourth tab. It lands on the installation folder, **not** on any other
   tab's folder, and the address bar is the same as every other tab's.
10. Close a tab mid-reply: its turn stops, and the other tabs' turns do not.
11. Nothing about the catalogue had to be configured twice.
