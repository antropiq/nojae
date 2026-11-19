# The connector wizard — "Set me up!"

**Status**: draft, settled — every decision from the three discussion rounds is
folded into the text and no question is left open. Nothing implemented.
**Surface**: two buttons in the WorkBench tools dock, one new dialog, one new
composable, one read-only scan, one committed MCP catalogue, and the app's first
model calls that belong to no conversation.
**Nothing writes a declaration file, and nothing installs anything.**

---

## 1. The need

Declaring a tool is the one step of nojae that is still pure hand-work. The
`console` and `fedit` connectors arrive by themselves, but everything else — a
browser, a docs server, a CSS language server — means opening the workspace's
declaration file, writing a JSON member by hand, knowing which npm package
provides which language server, knowing that a workspace root must be absolute
and must point at the right sub-folder, knowing that a formatter tool answers
with a diff — and then finding the restart button.

Two costs, both real:

- **The blank page.** A user who wants "a language server for my CSS files" does
  not know the package name, the argv, the extensions list, or which tools the
  server can actually answer. The seeded LSP *template* teaches the format, not
  the choice.
- **The silent mismatch.** A hand-written entry can be shape-valid and still
  wrong — a root pointing at the install instead of the sub-folder, an extensions
  list that misses the files in the project, a `tools` list naming an action the
  server never advertises, a package that is not installed. The app only says so
  after a restart, in the panel's error line.

The wizard turns "declare a tool" into a guided choice grounded in **the folder in
front of the user**, and ends on a JSON member the app's own loader accepts — not
on a plausible-looking guess.

## 2. The two buttons

One per panel, each at the left of that panel's existing restart button, in the
same head row:

- **MCP tools** → opens the wizard in its connector family.
- **LSP tools** → opens the wizard in its language-server family.

Tooltip and accessible name are the same string, as every icon button in the app
does: **Set me up!**. The glyph is a sparkle/wand inline SVG, `aria-hidden`, in
the same 1.5rem box as the restart glyph beside it — the panels keep their
current width, height and head layout, and this button never changes either.

The family comes from the button that opened the dialog and is **never a
question**. One dialog serves both.

Each panel's empty state keeps its current sentence but is reworded to invite the
click: it no longer only says where the declaration file is, it says that button
sets one up.

## 3. What the user gets

A modal dialog in three pages. The pages are the same for both families; only the
first page's *source of candidates* differs.

Every page carries one header line, present from the moment the dialog opens:
the **agent**, its **server** and the **model** the wizard is reasoning with
(§5). It names whose credentials and whose context the reasoning spends; it shows
no numbers.

### Page 1 — choose

**From the MCP panel** the dialog shows the **committed catalogue**: a short,
scrollable list of well-known MCP connectors, each with its name and one line of
what it is good for (browser control, live docs lookup, filesystem, git, …). No
model has run yet; this page is the same list on every machine, in every folder.
The user picks one and goes on.

**From the LSP panel** the dialog asks the model to look at this project first
(§5) and shows the **servers it proposes for this folder**, best first, each with
the evidence line that justifies it — "Python here (142 `.py` files, a
`pyproject.toml`), and no Python language server declared". There is no LSP
catalogue: which language server helps depends on what the project is written in.

Candidates are ordered by **what this folder clearly lacks**, at the top of the
list: a project full of `.py` files with no Python server declared leads with a
Python server, and a language the project already serves well does not lead.

Both families end page 1 the same way: one candidate chosen, one button to go on.

**An empty answer is a stop, not a form.** Neither list carries a "none of these"
entry. When nothing offered fits — an MCP server the catalogue does not carry, or
an LSP proposal the user does not want — the wizard says so in one sentence,
names the declaration file it would have belonged in, and ends the road there:
the user edits that file by hand, exactly as today. The wizard offers a curated
or a reasoned choice; it never degrades into the JSON editor it exists to
replace.

### Page 2 — prepare

This is where the agent enters the scene for both families. For MCP the catalogue
has already fixed *which* server it is; for LSP the agent fixed that on page 1.
What is left for it here is **this machine and this folder**: it is handed the
chosen candidate and the facts the scan derived, and it answers with:

- **what this entry will be** — the JSON member, complete, ready to paste;
- **what has to be installed first**, when something does: the install line to
  copy, and whether it looks installed already (§7 — the user runs it, not the
  app);
- **anything platform- or project-specific** it had to decide, stated in one line
  each, so the user can see the reasoning that shaped the member.

Nothing is hidden here: every value the model resolved (an executable path, a
workspace root, a key's variable name) is shown as part of the member, not
summarised away. A local server whose command line cannot be resolved on this
machine is still offered — flagged "not installed", with its install line — and is
never silently dropped.

### Page 3 — apply

The JSON member, verbatim, in a read-only block, with the copy action as the
primary button. Beside it:

- the **verdict** of the app's own loader on that member (§6);
- the absolute path of the file it belongs in;
- one sentence that the app only reads the declaration at start-up, so a
  **restart** is what makes the new entry appear — pointing at the panel's own
  restart button. **The wizard has no restart button of its own.**

When that file does not exist at all — possible for the LSP declaration, which is
seeded only as a template — the page says so plainly instead of pretending: the
file has to be created, the member goes inside an object at its top level, and
the absolute path to create is printed. **The snippet stays a member either way;
the wizard never emits a whole file**, and creating the file is the user's act
like every other write here.

Copying is the only action that changes anything, and it changes only the
clipboard.

## 4. What the wizard may never do

The invariants the feature is built around, stated so no task drifts from them:

- **It never writes a declaration file.** The snippet is text handed to the user.
  The app's rule stands unchanged: an entry is created only when absent and
  changed only outside the app. Hence no save button, no "remember", no
  server-side draft.
- **It never starts a connector or a language server**, and never a trial run of
  the candidate. A browser-reachable spawn of a command that is not yet declared
  is out of scope by decision, not by omission.
- **It never installs anything itself** (§7 — running the install line is the
  user's own act, in their own shell).
- **It does not become a second file reader.** The scan answers derived facts from
  a fixed allow-list of manifests and never returns file bytes.
- **It cannot produce a snippet the app would refuse** — the verdict on page 3 is
  the loader's, not a second opinion.
- **It never invents a version pin, a registry name or a documentation URL.** The
  MCP catalogue carries them; for an LSP server the model's command line is
  checked against what is actually on this machine before it is offered (§6).

## 5. The model step

The reasoning is one model call per step, and these are the first model calls in
the app that belong to **no conversation**: one for the MCP flow, at prepare; two
for the LSP flow — one to propose candidates for this folder, one to prepare the
chosen candidate.

The rules that keep that honest:

- **It goes through `core/llmkit`, like every other model call.** No second HTTP
  path to an endpoint, ever.
- **It is resolved per wizard, at its start**, from the agent the panel is
  currently showing — the same agent, and the same one-sentence refusal when that
  agent has no model. The sentence is the app's existing one, reused verbatim, not
  rewritten for this feature.
- **It is non-streaming and tool-less.** The dialog shows a waiting state, not a
  token stream; nothing is offered to the model to execute. That is what keeps a
  preparation dialog from being a second, unsupervised agent loop.
- **It is not part of the session.** Its tokens enter neither the session clock
  nor the cost badges, and no number is shown. What the dialog does show, on every
  page and from the moment it opens, is the header line naming whose reasoning it
  is: *"Wizard is running with `<agent>` on `<server>` — `<model>`"*. The
  implementation must not quietly fold those tokens into the session's numbers.
- **No waiting out a refusal.** The chat turn waits out a refused round because a
  whole reply depends on it. A dialog that silently sleeps through a 30-second
  backoff is worse than a named failure: the wizard makes one attempt and shows
  the endpoint's own sentence, and the user can press the button again.
- **A failed call is a sentence on the page, never an empty list.** A model that
  answers garbage, an endpoint that refuses, an agent with no model: each names
  itself. "No language server found" and "the model could not be reached" must
  never read the same.

## 6. The scan, and what makes a snippet trustworthy

### The scan

Bounded three ways, each a rule worth naming:

- **Through the workspace policy.** The reserved folder stays invisible, a hidden
  path is absent rather than pruned-with-a-note, and a read-only path is not read.
  The wizard must not be the one surface that confirms a name the tree hides.
- **By a fixed manifest allow-list.** Only known manifest names are opened
  (`package.json`, `pyproject.toml`, `requirements.txt`, `go.mod`, `Cargo.toml`,
  `composer.json`, `Gemfile`, `build.gradle`, plus the configs that say which
  linter or toolchain a project already chose). Credential files are not on that
  list and never become one.
- **By the existing caps.** The walk stops at the tree's own file budget and says
  it stopped, as quick-open and search already do.

What it reports is derived, small and auditable: extension counts, which manifests
exist, which dependencies they declare, which servers are already declared, and
where the "front end" of the project looks to be — which is what an LSP workspace
root defaults to. Paths it reports are workspace-relative, plus the one absolute
path of the declaration file the user is being asked to edit.

### The three checks on a prepared snippet

Page 2 produces text; page 3 must not present it as trustworthy on its own word:

1. **The app's own loader reads it.** The same function that reads the real
   declaration file is given the member and answers. One validator, no drift, and
   the words the user reads are the words the panel would have shown after a
   restart.
2. **The command is checked to exist.** Not spawned — *resolved*: the first token
   of the argv is looked up the way the hub would look it up. A path that is not
   there, or a program name not on the child's own `PATH`, becomes the readiness
   line "not installed" with the install line beside it. This is the honest half
   of "which dev dependency is missing", and it is the part users most often get
   wrong.
3. **A declared id is a warning, not a stop.** If the id is already in the file,
   the page says so plainly and still offers the snippet. Nothing changes until
   the user pastes it, and the loader would refuse the duplicate anyway. The check
   covers both an entry of that id and a `_`-prefixed key of that name, since a
   comment key there would make the pasted member a duplicate of the note.

## 7. Installing: the wizard advises, the user installs

A missing dependency is the user's to install. The wizard's whole job here is to
leave no doubt about **what** to run and **whether it is already there**:

- **It reports readiness, not a test run.** For the chooser's command line it says
  either "looks installed" or "not installed", derived from resolving the program
  the way the hub would resolve it (§6, check 2). It never spawns the candidate to
  find out.
- **It shows the install line, ready to copy** — per platform where the command
  differs, and taken from the catalogue for MCP, or from the model's answer for
  LSP.
- **It may offer to take the user to the chat** with that line already written in
  the composer, as a convenience only. It **fills, and only fills**: it never
  arms or sends the message, never focuses a send control, never pre-approves
  anything. That is a hand-over, not an execution: the turn is the user's to
  send, and it runs with the tools and the cost accounting the conversation
  already has.
- **It never installs, downloads or spawns anything.** No install button, no
  background run, no "fix it for me".

The reason is not caution for its own sake: a model naming a package from memory
can name one that does not exist, and a modal that runs it has hidden consent
behind a dialog. Handing the line over shows the command before anything runs it,
and leaves the decision where the responsibility already is.

An install that turns out to be needed is compatible with the paste: the entry can
be added before the dependency exists. The panel will report the spawn failure
until the user installs it, which is a named failure, not a silent one.

## 8. Values, secrets, and where they actually live

The snippet never carries a machine-specific literal where a placeholder will do,
and it never carries a secret value at all:

- **Paths are environment references.** A workspace root is written
  `${NOJAE_PATH_LOCATION}` (or that plus the sub-folder), never an absolute path
  spelled this machine's way, so the entry survives the folder being moved or the
  file being copied to another checkout.
- **A required secret is a visible placeholder, not a value.** Where an entry needs
  an API key, the snippet carries a canonical sentinel in the value slot:

  ```json
  "headers": { "CONTEXT7_API_KEY": "__put_your_api_key_here__" }
  ```

  The sentinel is what tells the user exactly where the key goes. There is **one**
  spelling of it, spelling it consistently is a requirement, and page 3 says
  plainly that the entry will not authenticate until it is replaced.
- **The dialog never asks for, and never displays, a secret.** It names the slot.
- **The environment-reference form stays available** for a user who wants the key
  outside the file: the entry may instead carry `"${CONTEXT7_API_KEY}"`, and the
  page says which of the two forms it is showing. The default is the sentinel,
  because it is the one shape that cannot be silently empty.

**Two traps this feature must not walk into:**

- **The sentinel is not a reference.** The loader expands `${NAME}` and nothing
  else, so an unreplaced sentinel is sent upstream as the key and fails at
  authentication, far from its cause. Hence the not-ready line on page 3, and
  hence exactly one canonical spelling to name it by.
- **Nothing downstream re-checks it.** The panel is not taught to recognise the
  sentinel: once pasted, an unfilled slot surfaces exactly as a wrong value does
  today, in the connector's own error. The feature ends at the snippet and the
  sentence that warns about the slot — it adds no verification to the hubs, the
  panels or the tool lists.
- **`.env` is regenerated from a fixed template on every settings save**, so a
  variable a user adds to it by hand does not survive the next save. Any guidance
  that points at the environment must say where the value really lives for this
  install, and must not say "add it to `.env`" unless the app itself writes that
  key.

## 9. The MCP catalogue

One committed JSON file, `mcp_connectors/catalog-mcp.json` — beside
`mcp-settings.default.json`, which is where the app's committed connector data
already lives: curated entries, hand reviewed like the two declaration templates,
and free to grow without a code change. The app knows no package name of its own;
everything it can offer comes from this file.

There is **no LSP catalogue**, by decision. Which language server helps is a fact
about the project, and the agent answers it per folder (§5). The two flows are
deliberately asymmetric: MCP offers a fixed curated list, LSP offers a reasoned one.

### What an entry carries

Four groups of fields, and the split is the point — only one of them becomes the
snippet:

| group | fields | role |
|---|---|---|
| **identity** | `id`, `name`, `description`, `docs` | what the user reads in the list |
| **the member** | `type`, `url` *or* `command`, `headers`/`env` | the JSON the snippet is built from |
| **requirements** | `requires` (per platform: the package and its install line), `inputs` (the slots to fill) | guidance, never pasted as-is |
| **relevance** | `signals` | which projects it suits, for ordering only |

Two rules that keep the groups honest:

- **Only `member` becomes JSON in the user's file.** An entry's install line, docs
  link, signals and description are the wizard's own material. Nothing under
  `requirements` or `relevance` can leak into the snippet — a task-level trap.
- **A `member` field may hold a `${...}` placeholder** (`${NOJAE_PATH_LOCATION}`,
  an input's slot name), exactly like a declaration does, and for the same reason.

### Secrets in the first pass

The catalogue's first pass favours entries that need **no credentials**, so the
first-run experience is a paste and a restart. One exception is admitted on
purpose — **context7**, which needs a key — because it is our own documented
example and because it proves the sentinel path (§8) end to end:

```json
"context7": {
  "type": "remote",
  "enable": true,
  "url": "https://mcp.context7.com/mcp",
  "headers": { "CONTEXT7_API_KEY": "__put_your_api_key_here__" }
}
```

An entry that needs a key is never withheld for that reason; it is offered with the
sentinel in the slot and the warning on page 3 that it will not authenticate until
the slot is filled.

### The first entries, and how they get in

The first pass, settled: **playwright**, **chrome-devtools**, **context7**,
**filesystem**, **fetch**, **git**, **memory**, **sequential-thinking**,
**sqlite** — all nine, all keyless except **context7**. Each is verified entry by
entry before it is committed; the list is closed at nine for the first pass and
grows afterwards by the review rule above.

Two facts about this project that shape the first pass:

- **`mcp_connectors/playwright_mcp.py` exists but is dead code** — nothing under
  `src/`, `web/` or `tests/` imports or declares it, and the catalogue's
  `playwright` entry is the official `npx` server, not that file. Leftover files
  are not candidates, and this one should not be mistaken for one when the list is
  written.
- **The two internal connectors already ship working**, so the catalogue must not
  offer `console` or `fedit`: they are seeded, they are always there, and offering
  them would invite a duplicate id.

Four consequences:

- **A curated command line is the only command line.** The wizard never invents a
  package name or an argv. That is the difference between a guided setup and a
  generator of broken configs.
- **Every entry is verified before it is committed.** The app can check that an
  entry is well formed and cannot check that a package exists on a registry — so
  the file is where that check has to have happened. Several of the proposed
  entries need an executable path or have moved between official and community
  stewardship; each is confirmed at commit time.
- **A local candidate the hub would refuse is refused here.** Where the platform's
  path guardrails do not speak, the app already refuses to start a `local`
  connector; the wizard says so on page 2 with the hub's own words, not after a
  restart.
- **The file grows without a code change.** Adding an entry is a data change and a
  review, never a new module under `src/` — the same rule the app already holds for
  connectors themselves.

## 10. When the buttons are live

Discovery writes nothing and starts nothing, so the hub states that gate the
toggles do not gate it:

| state | Set me up! | why |
|---|---|---|
| a reply streaming on this workspace | live | the wizard touches no hub and no conversation |
| a batch running | live | same reason |
| toggles locked (a started conversation) | live | a lock freezes the tool set, not preparation |
| the active agent mode switches this hub off | live, with the reason available | a mode narrows a turn; this is preparation |
| a hub route refused the workspace | live | a folder can still be prepared — worth a sentence |

The **one** real gate is the model: with no resolvable model for the current
agent, the button explains it and stays inert, because the prepare step of both
flows is a model call and a dialog that opens only to say "you have no model" is
worse than a button that says it.

Each panel's own sentence for that case is the app's existing agent refusal,
reused.

## 11. Where the pieces live

| piece | what it is |
|---|---|
| the MCP catalogue | committed data, reviewed, the only source of a package name |
| the scan | core, under the existing workspace policy, answering derived facts and never bytes |
| the model step | core, through `llmkit.chat_completion`, non-streaming and tool-less, with its two prompts (propose, prepare) and their answer shapes in one place |
| the snippet's verdict | the hubs' own loader, plus the command-resolution check |
| the routes | workspace-scoped like every other route, writing nothing and starting nothing |
| the dialog | one component, rendering answers only |
| the rules | one composable, the `useSettingsServers` idiom: page order, gates and every sentence a plain function, so the template decides nothing |
| the two buttons | one line each in the two panel heads, left of restart |

## 12. Acceptance

1. Each panel shows the Set me up! button at the left of its restart button, in the
   same box, with that tooltip, and both panels keep their width, height and head
   layout.
2. Each panel's empty state invites the click instead of only naming the file.
3. Opening from the MCP panel offers the committed catalogue and runs no model
   until a candidate is chosen; from the LSP panel, servers proposed for this
   folder by the agent. The family is never asked.
4. On a folder holding CSS files and no CSS tooling, the LSP wizard proposes a CSS
   language server first, and its evidence line names the files it saw.
5. In a Python project with no Python language server declared, the LSP wizard
   ranks a Python server first; a language the project already serves well does
   not lead.
6. With no resolvable model for the current agent, both buttons are inert and say
   why, in the app's existing words.
7. A model that cannot be reached is a named sentence on the page, distinct from
   an empty candidate list.
8. Page 2 shows the complete member and, when something must be installed, the
   install line and whether it looks installed already.
8a. A catalogue entry that needs a key produces a snippet carrying the canonical
    sentinel in the value slot, and page 3 says the entry will not authenticate
    until it is replaced. No snippet ever carries a key the app has seen.
9. A snippet is refused when the loader would refuse it, in the loader's words, and
   the page names the field to change.
10. A snippet the loader accepts can be copied in one click, and the copy says so.
11. An id already declared is a warning, and the snippet is still offered.
12. Page 3 names the absolute path of the declaration file it belongs in, and says
    a restart is what applies it.
13. No snippet carries a literal absolute path or a literal secret (§8).
14. Nothing in the feature writes a declaration, starts a process or installs a
    package — asserted, not intended. Resolving a program's path is not starting
    it.
15. The scan never reports a hidden path and never returns file bytes.
16. The wizard's model calls enter neither the session clock nor the cost badges.
17. Every page shows the agent, its server and its model, from the moment the
    dialog opens, and no token or cost number.
18. Neither list offers a "none of these" entry: an unmatched need is one sentence
    naming the declaration file, and the dialog ends there.
19. A missing declaration file yields the member plus the path to create, never a
    whole file.
20. The install hand-over fills the composer and nothing else: no send, no armed
    message, no focused send control.
21. The MCP catalogue carries all nine settled entries, and the snippet of each is
    built from its member fields alone.
22. No panel, tool list or hub gains a sentinel check, an auth pre-check or any
    other verification of a pasted entry's readiness.

## 13. Task sketch

The shape a lot can be cut from; the numbering is the runner's, not a promise.

| # | task | lands |
|---|---|---|
| 00 | big picture | this file, every decision recorded with its consequence (§14) |
| 01 | the catalogue | `catalog-mcp.json`, its four field groups, its first reviewed entries, and a read that loads it without the app knowing a package name |
| 02 | the scan | extension counts, manifests and their declared dependencies, declared servers, the front-end folder, under the policy and the caps |
| 03 | the model step | the existing `llmkit.chat_completion` seam wired for a non-streaming, tool-less call; the two prompts (propose, prepare), their answer shape, the agent resolution, the reused refusal, the header line's source, and the no-wait rule |
| 04 | the snippet | the loader's verdict, the command-resolution check, the `${...}` rules, the secret sentinel, the member-never-a-file rule, the duplicate-id and `_`-key warnings |
| 05 | the routes | the workspace-scoped reads and the write-nothing prepare post |
| 06 | the wizard's rules | the composable: pages, gates, the stop on an empty answer, readiness lines, every sentence |
| 07 | the dialog | the three pages, the header line, the waiting and failure states, the copy action, the fill-only install hand-over |
| 08 | the two buttons | the panel heads, the tooltip, the empty-state sentences |
| 09 | the project's own words | README's declaration sections, AGENTS.md's one line |

## 14. Decisions, and what they cost

All six questions are answered; nothing is left to settle. Recorded with the
consequence each one has, because several of them removed work rather than added
it:

| decision | consequence |
|---|---|
| **All nine catalogue entries** | task 01 commits exactly nine, each verified before it goes in. No reserved slot, no "more later" field. |
| **No "none of these"** | the "name it yourself" field page is cut from the dialog entirely. An unmatched need is one sentence and a stop. |
| **A missing file is not created** | the full-file output is cut. The snippet is always a member; a missing file becomes a sentence and a path. |
| **Header line, no numbers** | one string, visible on every page, sourced where the wizard already resolved its connection. No cost surface to build. |
| **The hand-over fills only** | no arming, no send, no focus. The convenience action is a clipboard-free composer write and nothing else. |
| **No downstream verification** | the panels, the tool lists and the hubs are untouched by this feature. The "needs a key" idea is dropped, not deferred. |

The one thing still genuinely open is **not** a design question: each catalogue
entry's actual argv, executable path and package name must be checked by hand
before commit (§9). That is task 01's own work, not a decision for this
document.

## 15. Out of scope

- Editing, disabling or deleting an existing entry from the wizard. It adds.
- Writing the declaration, or a "paste it into the file for me" that would.
- Verifying that a package exists on a registry, or reaching a registry at all.
- Starting the candidate to see whether it works.
- An entry point from the Settings dialog's MCP and LSP sections; the two panels
  are the entry points.
- Any change to how the hubs read, validate or toggle a declaration — including
  the hubs' post-paste readiness, which stays exactly as it is today.
- A user-editable catalogue: the file is committed and reviewed, not a third
  declaration the app owns per workspace.
