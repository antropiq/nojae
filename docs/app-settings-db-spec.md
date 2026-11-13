# App-level settings database — `nojae.db`

**Status**: **ready for task breakdown** — the eight questions this draft raised
are answered (§8 records each verdict and what it changed in the body). Four of
the answers turned out to *delete* a concept rather than relocate it: `lspEnabled`
(D13), the composer's mode lock and the `editable` flag (§4.4), the default model
and the default agent — and with them the `app_config` table that would have held
them (D5).

**Scope**: three of the seven `.nojae/*.json` files stop being files, stop being
per-workspace, and become tables in one SQLite database owned by the nojaé
install: the model connection, the agent modes and the prompt helpers. The other
four stay exactly as they are. The Settings dialog and the Agent-modes dialog
become editors over that database.

**Out of scope by construction**: MCP/LSP declarations, the read-write policy,
`.env`, the working-location mechanism, and every streaming/measurement rule.

---

## 1. What this is for

The model connection, the agent personas and the prompt-helper bullets are today
**per-workspace files**. Configuring a new folder therefore means redoing all
three: picking the server again, re-declaring the personas, re-typing the nine
bullets. But none of the three is really about the folder:

- the **server and the model** are facts about the machine and the user's
  subscriptions, not about the tree being edited;
- the **agent personas** are facts about how the user wants an agent to behave;
  the facts about *this project* already have their own channel — `AGENTS.md`,
  which is injected into every turn whatever the mode;
- the **prompt helpers** are habits of the user.

What genuinely belongs to a workspace — which connectors and language servers
exist there, and what may be written there — already lives in its own declaration
files and stays there.

After this change:

- one **`nojae.db`** at the install root holds the configured servers, the models
  under them, the agent modes and the prompt helpers. Switching the working
  location changes nothing in it: the agents, the LLM connections and the bullets
  a user built once are available in every workspace, immediately.
- one workspace can therefore offer **many** models, and **each agent can be
  pinned to its own model** — a cheap local model for the todo builder, a strong
  one for coding — which the single-connection file could not express.
- `.nojae/` keeps only what is truly workspace-declared: the MCP and LSP
  declarations, the read-write policy, and the e2e suite's own settings file.

### What this reverses, on purpose

Two earlier specs argued the opposite direction and are partially superseded:

| spec | what it said | what this changes |
|---|---|---|
| `nojae-settings-workspace-spec.md` | the model connection belongs to the workspace, so a workspace travels with its model | the connection belongs to the install; a workspace no longer carries one |
| `prompt-helpers-workspace-scope.md` §1 | a helper is "a habit of one tree", so it must travel with that tree | a helper is a habit of the user; the bullets are shared |

Both reversals are deliberate. The bullets that matter in practice — how to write
a commit message, what a review pass must check — describe the *user's* standards,
and the project documents a bullet points at are not immutable anyway: a bullet
that says "follow CONTRIBUTING.md" is a habit, not a fact about one tree. What is
genuinely tree-specific already has its channels (`AGENTS.md`, the read-write
policy, the hub declarations).

---

## 2. What exists today (verified against the code)

| piece | where | what it does |
|---|---|---|
| model connection | `src/core/workspace_settings.py` + `<location>/.nojae/nojae-settings.json` (template `nojae-settings.default.json`) | 14 flat members: server, key, model id, system prompt, 6 samplers, reasoning, vision, `lspEnabled`, `maxToolIteration`. Seeded at the two moments a folder becomes the working location; cached per root; written by the Settings dialog and by the LSP panel. |
| typed view of it | `EndpointsConfig.from_workspace` (`src/core/models.py`), `config.load_endpoints_config()`, `config.workspace_settings_refusal()` | the one object every model call is built from, plus the single refusal sentence a chat turn answers with when the file is unusable. |
| agent modes | `src/core/agent_modes.py` (read), `agent_modes_write.py` (whole-document save), `agent_modes_defaults.py` (built-ins), `<location>/.nojae/agent-modes.json` | personas + two hub booleans, hand-seeded then edited from the composer's pencil. `todoBuilder` is **not in the file**: it is rendered from code and appended last, and a file that names it gets a note. |
| prompt helpers | `src/core/prompt_helpers.py` + `<location>/.nojae/prompt-helpers.json` | exactly 9 `{color, content}` slots; a wrong count is an error, never repaired. |
| e2e connection | `<location>/.nojae/nojae-test-settings.json`, switched by `NOJAE_TEST_SETTINGS` | same 14 members, hand-authored, never seeded nor written, no fallback in either direction. |
| frontend | `SettingsDialog.vue` (LLM / Sampling / MCP / LSP), `AgentModesDialog.vue` + `useAgentModes.js`, `MemoryBullets.vue` + `RegistrationMemoryDlg.vue` + `usePromptHelpers.js` | the LLM and Sampling sections edit one flat connection; the modes dialog edits a **file document** (mtime token, findings, whole-document save); the bullet row is drawn as a fixed 9 and mirrors the backend's `SLOT_COUNT` by hand. |
| app bar | `GET`/`POST /api/path-location` carry `workspaceSettings`, `agentModes`, `promptHelpers` state blocks | notices about a missing/broken/unconfigured **file** in the workspace just switched to. |

Three properties of today's design must survive the move, because nothing else
in the app re-states them:

1. **`EndpointsConfig` is the only shape a model call consumes.** Re-pointing it at
   the database leaves `core/llmkit` untouched, and leaves `core/chat.py` and the
   batch runner with one change each: they ask the resolution seam for the
   **selected agent's** connection instead of the workspace's one (D7). Nothing
   downstream of that answer changes.
2. **A broken configuration is a named state with one sentence, never a silent
   default.** An agent that has no model must refuse, not dial a model nobody chose
   for it (D5) — and refuse in the same words wherever the question is asked.
3. **`web/src` never contains a reserved agent id.** The client recognises the
   app-owned mode by a data flag, not by its name.

---

## 3. Decisions

### D1 — one database file, owned by the install, gitignored

`<install root>/nojae.db`, created by the app on first boot. It joins `.env` and
`.env.test` as an install-scoped, secret-bearing, gitignored file — with one
difference that matters: it is **binary and single-writer**, so it is never
hand-edited and has no committed template.

- No new dependency: the Python standard library ships SQLite.
- The path is computed from the install root the same way every other
  install-scoped path is, so it is correct on Linux and Windows without a
  platform branch.
- **The file is hidden from every file surface** (D10), which is new: today the
  secrets live inside `.nojae/`, which is already invisible everywhere.

### D2 — the three stores move, the four declarations stay

| store | after this change |
|---|---|
| `nojae-settings.json` | **gone**; its members become the `servers` + `models` tables |
| `agent-modes.json` | **gone**; personas become the `agents` table |
| `prompt-helpers.json` | **gone**; slots become the `prompt_helpers` table |
| `lsp-settings.json`, `mcp-settings.json` | unchanged in shape, workspace-scoped — but `lsp-settings.json`'s `enable` flag becomes the **only** LSP gate (D13) |
| `read-write-policy.json` | unchanged, workspace-scoped |
| `nojae-test-settings.json` | stays a flat file, restructured (§4.6) |

Consequence worth naming: **a project-specific persona is no longer possible.**
The channel for "what this project tells the agent" is `AGENTS.md`, which is
already injected into every turn and re-read per request, so nothing is lost that
the app did not already offer by a better route.

### D3 — no migration, no seeding of the user's current values

The flat files are simply no longer read. There is no import step, no
"first boot lifts your JSON into the tables", and no compatibility reader. The
app is not in production, and a half-migrated settings layer is the expensive
alternative. The operator re-enters the connection once, in the dialog, and it is
then valid everywhere.

Corollary: the three files, their template (`nojae-settings.default.json`), their
seeders and their per-workspace state blocks are **deleted**, not deprecated. A
leftover file in a workspace is inert bytes.

### D4 — built-in agents are seeded into the database; `todoBuilder` becomes visible

The four built-in agents — `chat`, `code`, `architect`, `todoBuilder` — are
inserted when the database is created, and re-checked on every boot after that
(§4.3). Only `todoBuilder` is seeded `readonly = 1`.

**`todoBuilder` is now shown to the user**, in the Agent-modes dialog and in the
composer's dropdown, so a model can be associated with it. This changes the rule
that hid it: it was hidden because editing it would let a workspace break the lot
contract. `readonly` is the narrower answer to the same fear — the agent is
visible, its model is settable, everything else about it is not editable.

**For a `readonly` agent, code stays the source of truth for every column except
`model_id`**: at every boot the app re-asserts the built-in's label, hub flags,
persona and cap on that row. Only the model association survives a restart. That
is what makes "re-seed on boot" safe rather than destructive, and it keeps the
generated lot-conventions block (which is derived from the batch runner's own
rules) in exactly one place.

Built-in rows cannot be deleted; user-created rows can. `code` in particular is
the id a lot pins at launch, and a dropdown that can lose it would turn a running
feature into a mystery.

### D5 — there is no `app_config` table, because neither value it would hold is a setting

The flat files carried two values none of the four tables can express. Neither earns
a row, and the reason each is dropped is different:

**"the default model" is dropped: an agent with no model cannot run.** The old
single connection made "which model" a question with an answer even when nobody
had chosen one. That answer goes away on purpose — a turn that silently dials a
model nobody picked for that agent is the same failure mode as the silent default
this spec refuses everywhere else (§2). An agent's `model_id` is therefore
**required in practice**: unset means the agent is not usable, and the composer
says so before the send button is enabled (D7, §5.4).

**"the default agent" is dropped: it is browser state, not app configuration.**
Which agent the composer opens on is the last one the user chose, which is what
`localStorage` already holds for the other per-browser preferences (theme, layout
collapse, Enter-sends, splitter sizes, session sound). It is not a fact about the
installation, so it does not belong in the store the installation owns.

One correction to a natural assumption here: **the active workspace is not one of
those `localStorage` preferences.** It lives in the server process (the working
location the app holds), so it is remembered per running server, not per browser.
The last-used agent is the other kind of thing, and the precedent to copy is the
theme composable's — a key constant, a tolerant read, a write on change — not a
workspace one. Worth stating because an implementer who looks for a workspace key
in `localStorage` will not find one and may conclude the pattern does not exist.

The consequence is that **the store has no key/value table at all**: four tables,
each of which is a thing a user can point at and name. The schema version stays
where it was going to be anyway — SQLite's own `PRAGMA user_version` (D6) — so
nothing needed a settings bag to live in.

One behaviour this removes rather than relocates: today a chat payload with no
`agentMode` falls back to the modes file's `default`, and the server documents
that as the compatibility path for a client predating modes. With no server-side
default to fall back to, **a turn with no `agentMode` is a 422 naming the field**,
not a turn that runs as some agent the client never chose — the same reasoning the
unknown-id 422 already records.

That leaves two client paths that today rely on the fallback and must stop:

- the composer, when the agent list **failed to load** — it currently sends no
  `agentMode` and lets the server decide. It must instead refuse the send with the
  load failure, since it cannot name an agent it has not read;
- a lot whose pin did not resolve — same rule, and it becomes much rarer: the pin
  is `code`, built-ins cannot be deleted (D4), and the store is no longer something
  a workspace can rename. An unresolved pin now means the store is unreadable, which
  stops the lot rather than quietly running it under a stranger.

### D6 — the schema is versioned, and a newer file than the app is a refusal

`PRAGMA user_version` records the schema level. Boot either creates the schema at
the current level, or upgrades an older one, or **refuses to touch** a file whose
level the app does not understand and says so. Silently reading a newer schema
with older rules is how a settings store quietly loses rows.

### D7 — one agent in, one connection out, or one sentence back

Every model call resolves through a single seam, and it has two branches, not a
ladder:

```
agent.model_id  →  (set)  that model + its server  →  the connection
                →  (null) refusal sentence naming the agent
```

- The refusal is **one sentence**, built by one function, reused by the chat
  route, the Settings dialog and the app bar — the same single-authority rule
  `workspace_settings_refusal()` holds today, moved from a file to a database.
  It names the agent that has no model, because "which agent" is the part the
  user can act on; a sentence about a missing default would describe a setting
  that no longer exists.
- A model whose server row is missing is the same refusal, not a crash. The
  schema's `ON DELETE SET NULL` makes that state unreachable through the app, so
  reaching it means a hand-edited database, which is exactly when a named state
  matters most.
- **A turn resolves once, at its start.** A save that lands mid-turn cannot split
  the turn it is streaming. This is the invariant that replaces today's
  "refused while a chat reply streams" gate for these stores.
- **The refusal is reachable in normal use, not only after damage.** A fresh
  install has four agents and no models, so every agent starts unrunnable until
  the user assigns one. That is the intended cost of D5, and it is why the
  composer's warning icon (§5.4) is the primary path to fixing it rather than a
  corner case.

### D8 — the system prompt keeps its two levels

An agent's `system_message` wins; empty means "use the model's own
`sys_prompt`". That is today's rule (`mode.system_message == ""` → the configured
system prompt), unchanged, except that the fallback is now a property of the
**model** rather than of the workspace.

### D9 — the tool-loop cap becomes a per-agent number

`maxToolIteration` leaves the connection and becomes `agents.max_tool_iteration`.
Today one number bounds every turn's MCP loop whatever the persona; per-agent is
both more honest and more useful (a chat agent needs few iterations, a coding
agent many). The value stays **MCP's knob only** — LSP round-trips remain
uncapped, as they are today.

Consequence for the UI: the "Max tool iterations" field leaves the Settings
dialog's MCP and LSP sections and appears on each agent tab.

**Seeded value and accepted range**: 25 for all four built-ins — the same number
the app defaults to today, so a fresh install behaves exactly as it does now. The
accepted range is a **floor of 1 and no ceiling**: today's reader already enforces
only the floor, so the 500 found in a live file is a value someone typed, not a
limit the app imposed. Nothing here introduces an upper bound.

### D10 — the database is invisible to every file surface, and protected like `.env`

A secret-bearing file at the install root is a new thing in this app: `.env` is
already hidden by a level-A rule and by the connectors' deny-list, and `.nojae/`
is reserved wholesale, but `nojae.db` sits at the root of a tree that **is** the
working location whenever the user works on nojaé itself.

So the same protections apply, and they apply to the WAL sidecar files too:

- hidden from the Editor tree, from file reads, from search and from git status;
- named-to-refusal rather than silently absent for a write attempt;
- unreachable by the console and fedit connectors, inside the root by the
  workspace policy and outside it by the connectors' own deny-lists.

**A test asserts this rather than a sentence in this document**: the same style as
the existing write-surface isolation test.

### D11 — reads are uncached; the database is the cache

Today `workspace_settings` and `agent_modes` each keep a per-root cache with its
own invalidation rules, because they read a file from disk on every turn. A local
SQLite read does not earn that. Dropping the caches also drops the class of bug
this feature is most exposed to: a store that is app-level but still keyed by
workspace would answer the previous project's settings after a switch.

**A workspace switch invalidates nothing in the database.** It invalidates only
what is genuinely workspace-scoped: the hubs, the policy, the tree caches.

### D12 — writes stay the browser's alone, and destructive writes keep a copy

The database is written only through purpose-built routes reached from the SPA —
never from a connector, a tool, a terminal or a chat path (the existing
isolation test extends to the new routes).

"No write destroys bytes" cannot mean per-row history in a database, but it can
mean the same thing the file rule means: **before a destructive write** (deleting
a server, a model or an agent), the app copies the whole `nojae.db` into its
existing dated backup folder, reusing the same helper and retention sweep that
every file replacement already uses. An `UPDATE` needs no copy — the row it
replaces is a field the user can retype; a `DELETE` is the one thing they cannot.

### D13 — LSP activation has one gate, and it is the workspace declaration

`lspEnabled` is a member of `nojae-settings.json`, so it moves with that file —
but it does not fit any of the four tables, because it is not app-level: it names
which language servers **this tree** activates. It is therefore **dropped, not
moved**. The per-entry `enable` flag in the workspace's `.nojae/lsp-settings.json`
already carries exactly that decision, so it stops being one of two agreeing gates
and becomes the only one.

The two flags that survive in `agents` are a different axis and stay: `mcp_enable`
and `lsp_enable` say what a *persona* may reach. A workspace that activates one
language server and an agent that never wants code-style lookups are independent
facts, and the pair expresses them without a third store.

| | before | after |
|---|---|---|
| is this server running here? | `enable` **and** listed in `lspEnabled` | `enable` |
| may this agent use the hub? | `mode.lsptools` | `agents.lsp_enable` |

This also makes the two hubs **symmetric**: MCP connectors have had one gate —
their declaration's `enable` flag, "single source of truth, no .env key involved"
— since before this change, and the code comments already call that the precedent
the LSP file follows. LSP was the odd one out with two.

**The behavior change to be aware of**: the second gate existed so that a prepared
declaration file could stay entirely dormant until the user ticked servers in the
dialog. With one gate, a declaration that says `enable: true` runs — so a cloned
or freshly-authored workspace with enabled declarations starts those servers on
first open. That is the honest reading of a file that says "enabled", it is what
MCP already means by its own `enable` flag, and it is what makes the declaration
file the single source of truth the app's rules already claim it is. Stated here
rather than left as a side effect.

The name `lspEnabled` does **not** free up: the chat payload and the Editor's
query route already carry a `lspEnabled` field that is the *conversation*-scoped
allowlist the Tools panel holds. That field is untouched by this change and is a
third, unrelated axis. Code and comments must not let the two converge on one
word for two meanings.

### D14 — the test suite keeps its flat file, and never opens the database

With `NOJAE_TEST_SETTINGS` truthy, the suite runs against a **temporary database**
the harness creates, exactly as it already redirects `.env` and the workspace
lookup to a test-owned path. In that mode the app **never opens `nojae.db`**: a
suite run cannot read, and must not write, the developer's configured agents,
bullets and key.

The flat file keeps its role as the source of the test connection, but its new
job is to **seed that temporary database**, not to bypass it:

1. create the temporary database and seed the built-ins, as at boot;
2. insert the file's one server and its one model as rows;
3. point **every** agent row at that model.

The reason for step 3 rather than a test-mode branch in the resolution seam is
that D5 made "the agent has a model" the only way a turn can run. A special case
there — "in test mode, use the file's connection whatever the row says" — would
mean the suite exercises a resolution path production never takes, which is the
worst property a settings layer can have. Materialising the fixture into rows
keeps **one** seam, and the file stays as honest as it was: hand-authored, never
written by the app, never defaulted, and a missing or malformed file makes the
suite refuse rather than fall through.

Because step 3 assigns the model to every agent, a test that wants an agent with
**no** model — to assert the refusal and the composer's warning — clears that
row's `model_id` itself. That is the only way such a state is reachable in test
mode, which is what makes it a deliberate fixture rather than an accident.

---

## 4. Backend

### 4.1 The database file

| property | value |
|---|---|
| path | `<install root>/nojae.db` |
| sidecar files | `nojae.db-wal`, `nojae.db-shm` (write-ahead logging) |
| gitignored | all three |
| created | on first boot, exclusively; a boot that cannot create it must not die (§4.3) |
| opened | read-write, one connection per worker thread, with a busy timeout |
| dependency | none — standard library `sqlite3` |

Why WAL: the app's shape is a request thread plus a chat worker thread, and the
worker reads the configuration while the request thread may be saving it. Rollback
journaling serialises that into `database is locked` errors under any real
overlap; WAL lets the reader proceed. The busy timeout covers the writer-writer
case (two browser tabs).

The connection lifecycle belongs to one module that owns the database and nothing
else. Every other module asks that module for data; nobody else opens a file,
nobody else writes SQL, and no core function accepts a path to the database.

### 4.2 Schema

```sql
CREATE TABLE servers (
  id       INTEGER PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE,
  url      TEXT NOT NULL,
  api_key  TEXT NOT NULL DEFAULT ''
);

CREATE TABLE models (
  id               INTEGER PRIMARY KEY,
  server_id        INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
  name             TEXT NOT NULL,
  sys_prompt       TEXT NOT NULL DEFAULT '',
  temperature      REAL,
  top_p            REAL,
  top_k            INTEGER,
  min_p            REAL,
  repeat_penalty   REAL,
  presence_penalty REAL,
  reasoning        TEXT,
  supports_vision  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (server_id, name)
);

CREATE TABLE agents (
  id                  TEXT PRIMARY KEY,          -- slug, matches today's mode-id pattern
  label               TEXT NOT NULL UNIQUE,
  max_tool_iteration  INTEGER NOT NULL DEFAULT 25,
  mcp_enable          INTEGER NOT NULL DEFAULT 1,
  lsp_enable          INTEGER NOT NULL DEFAULT 0,
  system_message      TEXT NOT NULL DEFAULT '',
  readonly            INTEGER NOT NULL DEFAULT 0,
  model_id            INTEGER REFERENCES models(id) ON DELETE SET NULL
);

CREATE TABLE prompt_helpers (
  id          INTEGER PRIMARY KEY,
  color_code  TEXT NOT NULL,
  content     TEXT NOT NULL DEFAULT ''
);
```

Four tables and no key/value bag: every row is a thing a user can point at and
name, and the two settings that were neither are deleted rather than relocated
(D5).

Invariants the schema itself must express, and what each one is for:

- **`servers.name` unique** — the dialog lists servers by name; two "Local"
  entries are unresolvable to a human.
- **`models` unique per (server, name)** — a model id is chosen from the server's
  own list; a duplicate under the same server is a mistake, never a variant.
- **`models.server_id` `ON DELETE CASCADE`** — deleting a server deletes the
  models under it. They are meaningless without it, and an orphan model is a row
  the dialog cannot render.
- **`agents.model_id` `ON DELETE SET NULL`** — deleting a model does not delete
  the agent; the agent becomes unrunnable until it is given another (D7). A
  persona outlives the model it was tried with, and losing the persona would be
  the real damage.
- **`agents.id` is the slug, not a surrogate** — it is the value a chat payload
  and a saved session carry today. Keeping it stable keeps every session file on
  disk resolvable.
- **`agents.label` unique** — the dialog creates an agent *by label* and derives
  the id from it; a duplicate label is refused with the existing slug-collision
  message rather than silently renumbered.
- **nullable samplers** — an absent sampler is omitted from the request body, as
  "member absent means" works today. A `0` and a "not set" are different values
  and must stay distinguishable in the row.
- **`prompt_helpers` has no count constraint** — see §4.5.

**Naming**: columns are `snake_case`, and the e2e file (§4.6) uses those same
names, because both describe a stored connection and one vocabulary for a
connection is cheaper than a mapping table nobody remembers to update. The JSON
that crosses to the browser keeps the app's existing `camelCase` payload
convention; the translation lives in the one module that owns the store, never
spread per route.

### 4.3 Seeding

At boot, in order: open (or create) the database → apply the schema at the
current level, or upgrade, or refuse (D6) → seed.

Seeding is **idempotent**, run on every boot rather than only on
the first:

| what | rule |
|---|---|
| built-in agents | inserted when absent, with `model_id` **null** — the seeder cannot know which model the user will configure, and inventing one is what D5 refuses; for `readonly` rows, every column except `model_id` is re-asserted from code (D4) |
| prompt helpers | nine empty gray rows inserted **when the database is created, and never again** — an empty table after that is a choice the user made, and a boot that refilled it would undo a delete the app promised to honour (D12). The row then renders nothing until the first add. |
| servers / models | never seeded. There is no example server and no placeholder key: a value that cannot be dialled must not be inserted to be dialled (the rule today's template instruction sentences exist to satisfy, now satisfied by absence) |

The built-in personas, hub flags and labels stay in the module that holds them
today, as the single definition the seeder and the fallback share — the reason
that module gives for existing is unchanged by the move.

**A boot that cannot open or create the database must not take the app down**, the
same contract every seed in the app already holds: the app starts, the app bar
says the settings store is unusable with the one sentence that names the path, and
a chat turn refuses with it. An unopenable database is a *named state*, never a
silent empty one — the rule that made today's file reader check the file itself.

### 4.4 Reading: accessors and the resolution seam

The read side keeps today's seams so the blast radius stays small:

| today | after |
|---|---|
| `workspace_settings.load_workspace_settings()` | `app_settings` module: server + model rows |
| `EndpointsConfig.from_workspace(mapping)` | `EndpointsConfig.from_store(server_row, model_row)` — same output object, same pydantic validation, same "absent means" table |
| `config.load_endpoints_config()` | same contract — `(config, None)` or `(None, sentence)` — but it now **takes the resolved agent**, because which connection answers is no longer one answer for the whole app (D7) |
| `config.workspace_settings_refusal()` | the same single-sentence builder, now about the store: no server, the agent has no model, unusable database |
| `config.max_tool_iteration()` | per-agent: the resolved agent's `max_tool_iteration` |
| `agent_modes.resolve_modes()` / `resolve_mode()` | same two functions, reading the `agents` table; `resolve_modes()` loses its `default` key and each row gains its resolved model (below) |
| `prompt_helpers.load_prompt_helpers()` | same function, reading the table |

`resolve_modes()` keeps its two guarantees, which are about behaviour rather than
storage: it **never raises** (a bad row is reported, the dropdown still renders),
and the app-owned agent is still **last** in the order.

Two of its answers change, both because of D5:

- its `default` key is **removed** from the payload — there is no server-side
  default agent to report, and a key that always answered "nothing" would be read
  as meaningful by the composer and the lot;
- `resolve_mode(None)` no longer resolves to anything: a missing id is the 422 of
  D5, so the function's contract narrows to "an id in, a row or nothing out". The
  unknown-id branch and its message listing what *is* available are unchanged.

Each agent row also carries whether it can run at all — `model_id` plus the
resolved model's name — so the composer's warning (§5.4) reads a field rather than
re-deriving the rule from two tables.

Order: agents are returned in insertion order, which is stable and needs no new
column. Reordering the dropdown is out of scope (§6).

**`readonly` replaces `editable`, and the composer's mode lock disappears with it.**
Today's single `editable: false` carries two meanings at once, and the move pulls
them apart — then finds that neither survives:

| meaning of `editable: false` today | who obeys it | after this change |
|---|---|---|
| "this agent has no tab in the dialog at all" | the modes dialog | **gone** — `todoBuilder` gets a tab, so a flag meaning "absent" is no longer the right word |
| "a thread that has turned cannot leave this agent" | the composer's dropdown | **gone** — `todoBuilder` was the only agent the flag ever named, and it no longer locks |

So the payload carries **one** flag, `readonly`, answering one question: *which
fields of this agent's tab are disabled*. There is no lock predicate to keep, no
second name to invent, and no agent for which the dropdown freezes.

Why dropping the lock is safe rather than a regression: the lock's stated purpose
was to stop a conversation drifting out of the lot contract. But a lot **pins its
own agent at launch** and reads it per task turn, so a chat thread's mode was never
what a lot depended on. And the server has always accepted an `agentMode` change
mid-thread — the lock was documented as "client-side convenience, not enforcement",
because a resumed session may legitimately want a different persona next turn.
Removing it removes a client-side surprise (pick an agent, the dropdown freezes)
without changing what any turn can do.

What remains of the dropdown's disabling rules: a running lot still renders the
select inert (its mode is pinned at launch), and the per-hub gray-out of the
Tools panels still follows `mcp_enable` / `lsp_enable`. Both are unchanged.

The client-side rule is unchanged either way: it reads `readonly` as **data** and
never names an agent id (the existing test that `web/src` holds no reserved id
stays, and is extended to assert the flag — not an id — drives disabled rendering).

### 4.5 Writing: the routes

The three stores get purpose-built browser routes, in the pattern the reserved
folder's files already established — never a path parameter, never an `/api/fs`
route, never reachable from a tool. Exact paths are for the task breakdown; the
shape is:

| store | read | write |
|---|---|---|
| servers | list with their models | create, update, delete |
| models | (in the server list) | create, update, delete |
| agents | list with `readonly` and the resolved model | create, update, delete |
| prompt helpers | list | create, update one, delete |

There is no fourth store and no "app defaults" surface: neither of the two values
that would live there survived D5, so the settings read returns servers with their
models and nothing else.

Rules that carry over or are new, and why:

- **Validation is the same strictness as the file reader.** A sampler outside the
  accepted range, a reasoning value outside the known set, a colour that is not a
  6-digit hex triplet, an id outside the slug pattern: refused with a message that
  names the field. A database column does not make a bad value less bad.
- **The API key is never sent to a connector, a log or a tool listing.** It is
  returned to the Settings dialog, which edits it, exactly as today.
- **Deleting a server cascades to its models** (D12's backup covers the mistake);
  **deleting a model nulls the agents that pointed at it.**
- **A `readonly` agent refuses every write except its model association.** The
  refusal is the same sentence wherever it is reached from.
- **Prompt helpers have no count rule.** Today a file that does not hold exactly
  nine slots is an error, because the app was the file's only writer and a wrong
  count meant corruption. In a table, a row is a bullet: adding and deleting are
  the normal operations, and the count is simply the count. The existing
  "exactly 9" check and its error type are deleted, not relaxed.
- **No mtime token, no conflict guard, no findings-about-a-file.** Those existed
  because a hand-edited file could change under the dialog. The app is the
  database's only writer, so the whole optimistic-concurrency layer for agent
  modes goes away with the file.
- **The chat-streaming gate** stays exactly as it is today: the settings and
  prompt-helper writes were never gated and still are not, because D7's
  resolve-once-at-turn-start makes a mid-turn save harmless by construction. No
  new route gains the "unavailable while a reply streams" affordance, and no
  existing one loses it.
- **Built-in agents refuse deletion** (D4): the route answers the same refusal
  sentence for a `readonly` write, and the client never offers the button.
- **The existing LSP activation route changes shape, not just storage.**
  `POST /api/lsp` today writes *two* gates and the shared cap: `lspEnabled` into
  the workspace settings file and `enable` back into `lsp-settings.json`. With
  D13 it writes the declaration's `enable` flag only, and it stops carrying
  `maxIterations` (D9 moved the cap per agent). Its payload drops `maxIterations`
  and its `active` flag becomes the declaration's `enable` alone. This is the one
  route outside the three stores that this change touches, and it is touched
  because the file it wrote is being deleted.
- **The conversation-scoped `lspEnabled` payload field is untouched** (D13): chat
  and the Editor pane keep sending their allowlist, which is still intersected
  with the now-single activation gate.

### 4.6 The e2e test file

`.nojae/nojae-test-settings.json` stays a flat file and is restructured to mirror
the table layout, so one vocabulary describes a connection everywhere:

```json
{
  "server": {
    "name": "test-local",
    "url": "http://<test-host>:8080/v1",
    "api_key": "",
    "model": {
      "name": "<the test model id, exactly as the server names it>",
      "sys_prompt": "You are a helpful assistant.",
      "temperature": 1,
      "top_p": 0.95,
      "top_k": 20,
      "min_p": 0,
      "repeat_penalty": 1.0,
      "presence_penalty": 0,
      "reasoning": "off",
      "supports_vision": false
    }
  }
}
```

- The member names are the **column names**, so the file and the tables describe a
  connection the same way (§4.2). This is a deliberate break from today's
  camelCase members: the file is a store fixture, not a UI payload.
- The reader validates it with the same strictness as the tables: an unknown key
  or a wrong type is a named failure, never a silently-defaulted sampler — a
  green suite that measured a default is worse than a red one.
- It is read once, at harness start, and **materialised into the temporary
  database** as one server row, one model row, and the `model_id` of every agent
  row (D14). The real `nojae.db` is never opened by a test.
- `lspEnabled` and `maxToolIteration` are **absent from the file**, because they
  are no longer part of a connection: the first is gone entirely (D13), the second
  is a per-agent column (D9). A suite that needs an LSP server active declares it
  with `enable: true` in the workspace's own `lsp-settings.json`, which is what
  the fixture already writes per test; a suite that needs a cap sets the agent
  row's value in its temporary database.
- The file describes **one** server with **one** model, which is all a suite needs
  and keeps the fixture honest about being a fixture: it is not a partial export
  of the tables, and it never carries an id — the harness assigns both.
- The e2e specs that read the workspace file's bytes off disk (the workspace-switch
  and agent-modes specs) are rewritten against the routes instead: there is no
  file to read any more, and a spec that reads a store's bytes is a second
  authority on it.

### 4.7 What disappears

| removed | because |
|---|---|
| `src/core/workspace_settings.py`, `nojae-settings.default.json` | no file |
| `agent_modes_write.py`, the modes seeder, the modes file-state reader | no file, no hand-editing, no mtime guard |
| the file half of `prompt_helpers.py`, its seeder and its state reader | no file |
| the three per-workspace seed calls at boot and on a workspace switch | nothing to seed per workspace |
| `workspaceSettings` / `agentModes` / `promptHelpers` blocks in `GET`/`POST /api/path-location` | those files are not in the workspace any more |
| the "still holds the template's text" state (D8 of the parent spec) | nothing is seeded with instruction sentences |
| the per-root caches in the settings and modes readers | D11 |
| `config.lsp_enabled_ids()` and the second LSP gate it implements | D13 — one gate, the declaration's `enable` |
| `editable` on the mode payload, and the client's lock predicate built from it | §4.4 — no agent is left for it to name |
| the `default` key of the modes payload, the helper that computed a fallback for it, and the dialog's Common tab | D5 — the last-used agent is `localStorage`, and there is no server-side default to report |

`agent_modes.py` survives as the **read model** for agents (validation, ordering,
the never-raises promise, the fallback); only its file half is removed.

### 4.8 Path policy and secrets

One new level-A rule and one new connector deny-list entry, both for
`nojae.db` and its sidecars, with the reason spelled the way the other rules
spell theirs ("nojaé's own settings store, which holds the model credentials").
The rule is workspace-conditional like `.env`'s and `logs/**`: a folder that is
not the install has no reason to hide a file called `nojae.db`.

`AGENTS.md`'s data-file table gains the row and its rules: the store is written
only through its own routes, never through a path; it holds secrets; it is
gitignored; it has no committed template because it has no hand-edited member.
The same table's `nojae-settings.json` row — which today claims that file holds
"this workspace's model connection **and which language servers it activates**" —
is deleted, and the reserved-folder bullet that describes declarations and stores
loses the store half of its sentence.

### 4.9 Cross-platform notes

- Paths come from the install root; no separator, no drive assumption, no
  `~` expansion anywhere near this code.
- WAL is supported on Windows filesystems the app already runs on; the busy
  timeout is what makes a second writer wait rather than fail.
- The database is opened in binary-safe mode with no text-mode translation — the
  lesson the LSP seeder records about `\n` becoming `\r\n` applies to any file the
  app writes on Windows.
- A file lock held by another process (an editor with the file open, a backup
  sweep) is the named-state path of §4.3, not a traceback.

### 4.10 Tests

- **Hermeticity first.** No test may open the real `nojae.db`. The suite gets a
  test-owned database the way it already gets a test-owned `.env` and working
  location — one autouse fixture, one helper a test calls when it owns its own
  root, mirroring the existing pair of fixtures for the settings file.
- **New store tests**: schema creation and version refusal; seeding idempotence
  (a second boot changes nothing, a `readonly` row's persona is re-asserted after
  a hand-corruption, its `model_id` survives); the resolution seam and each of
  its refusals; cascade and set-null on delete; the `readonly` write refusal;
  prompt-helper add/delete with no count rule.
- **Existing tests that must change, and how**: every test that neutralises the
  workspace settings file neutralises the store instead; the modes tests drop
  their file fixtures and keep their rules; the "exactly 9 slots" tests become
  add/delete tests; the app-bar notice tests drop the three file blocks.
- **The measured blast radius**, so the breakdown budgets for it rather than
  discovering it: the workspace-settings file is touched by a dozen test modules
  (its own two, plus the LSP, chat, API, config, MCP and editorfs suites, and
  `conftest.py`'s fixtures), and agent modes by a similar set including the
  write-surface isolation test. `conftest.py` is the load-bearing one — its
  neutralising fixture is what most of those tests call, so replacing that one
  helper with a store-shaped equivalent is a single task that unblocks most of
  the rest. Three modules (`test_workspace_settings.py`,
  `test_workspace_settings_seed.py`, `test_agent_modes_write.py`) test the file
  layer itself and are **deleted**, their surviving rules re-homed as store tests.
- **The LSP gate change gets its own tests** (D13): the pair of tests that assert
  "declared `enable: true` but not in `lspEnabled`, so nothing runs" invert — the
  declaration alone now decides. They are the only existing assertions about
  behaviour this change *alters* rather than relocates, which makes them the
  tests to read first when implementing D13.
- **Isolation test extended**: the new write routes are pinned per path, only the
  browser's half writes, and no connector, tool or chat path reaches them — the
  same guard that already protects the modes save, which is being deleted.
- **Policy test extended**: `nojae.db` and its sidecars are hidden from the tree,
  reads, search and git status, and refused to a writer, when the workspace is
  the install (D10).
- **A test that the app boots without a database**, one that a boot with an
  unopenable database still serves the app bar with the sentence, and one that a
  second boot neither duplicates the built-ins nor refills deleted prompt-helper
  rows.
- **The thread-safety claim gets a test**, not a paragraph: a reader on one
  thread while a writer holds the lock on another must not raise.

### 4.11 Documentation

`README.md`'s configuration section is rewritten around the dialog rather than
around a file: how to add a server, add a model under it, pin an agent to a model,
and where the credentials live now. `AGENTS.md` changes in three places — the
data-file table, the "one LLM layer" pattern (the connection comes from the
store, not from a workspace file), and the working-location paragraph, which stops
claiming the model connection travels with the workspace. `docs/nojae-settings-workspace-spec.md`
and `docs/prompt-helpers-workspace-scope.md` get a superseded-by pointer at the
top, not a rewrite: they remain the record of the decisions they made.

---

## 5. Frontend

### 5.1 Settings dialog — from one connection to a server/model catalogue

The LLM and Sampling sections merge into one **Models** section with a
master–detail layout in the dialog's existing two-column shape:

```
nav: Models | MCP | LSP
       └ left column: servers, each expandable to its models
         right column: the selected server's fields, or the selected model's fields
```

**Server fields**: name, URL, API key (the existing reveal-capable key field),
plus *Fetch models* — the existing live listing call, which now fills a server's
model list rather than one global dropdown.

**Model fields**: name (pickable from the fetched list or typed), system prompt,
the six samplers, reasoning level, vision checkbox. These are today's Sampling
section, moved under the model they belong to.

**Add / remove** at both levels, with the destructive confirmations D12 asks for.

**No "default model" concept.** A model is used by being assigned to an agent, and
nothing else (D5). The dialog therefore does not mark any model as special, and it
does not need to: the answer to "which model will this agent run on?" lives in the
agent's own tab (§5.2), where the question is asked.

What the Models section *does* need is a count of who is unassigned, because a
fresh install has four agents and no models, and every one of them is unrunnable
until the user assigns one (D7). A quiet line — "2 of 4 agents have no model" —
that is clickable into the Agent-modes dialog is the whole affordance. It is the
only place the two stores have to talk to each other.

**MCP and LSP sections**: unchanged in what they list, but two things leave them:
the shared "Max tool iterations" field (D9), and — for LSP — the *second* gate.
The section's checkboxes now drive the declaration's `enable` flag alone (D13), so
a ticked row means "this server runs here" with no further agreement required.
The row's tooltip has to say that plainly, because the meaning of a tick changed.

**What goes away**: the workspace-settings file notice (the sentence about a file
that is absent, malformed, or still holds the template's text). In its place, one
app-level notice: *no model configured* — with the same rule as today, that the
dialog shows the server's own sentence and translates nothing.

### 5.2 Agent-modes dialog — a store editor, with a model per agent

The dialog keeps its shape (one tab per agent, create-by-label) and loses the file
and its Common tab:

| today | after |
|---|---|
| reads a file document, saves the whole document | reads the agent list, saves per agent |
| mtime conflict line, "saving will create this file" | gone |
| findings that name a JSON pointer | form-level validation messages that name a field |
| app-owned agent absent everywhere | **shown**, as a tab whose fields are disabled |

Per-agent tab: label, id (editable only while new, as today), MCP switch, LSP
switch, system prompt with the byte counter, **max tool iterations** (new here,
D9), and **Model** — a dropdown over every configured model, grouped by server.

The dropdown has **no "use the default" entry**, because there is no default to
use (D5). Its empty option is therefore an explicit choice with a visible cost:
*"— no model: this agent cannot run —"*. Selecting it is a legal save, and the
composer then refuses to send with the warning of §5.4. An agent's model is the
one field of a `readonly` agent the user owns, so `todoBuilder`'s tab shows the
same dropdown with the same empty option and the same consequence.

**The Common tab is deleted.** Its only control was the default-mode dropdown, and
D5 removes the setting it edited; a tab holding one field that no longer exists is
worse than no tab. The dialog's existing "open on the composer's current agent"
rule becomes the landing rule, with the first agent as the fallback it already
falls back to.

For a `readonly` agent: every field rendered but disabled, the model dropdown
live, and one caption saying why — the fields are nojaé's own, the model is the
user's. The client decides this from the `readonly` flag in the payload and
**never from the agent's id** (the existing rule that `web/src` must not contain
a reserved id survives, and its test is updated to assert the flag drives the
rendering).

Each agent tab carries a quiet line naming the model it will run on — server and
model — or, when it has none, the same "cannot run" wording the dropdown uses.
That is the answer someone reading a persona wants without opening a second dialog,
and with no default to resolve it is now a plain read of one field.

Delete: offered for user-created agents only; a built-in's tab says it cannot be
deleted.

### 5.3 Prompt helpers — unconstrained bullets

The bullet row renders **as many bullets as the store holds**, numbered by
position, instead of a fixed nine. The composable stops mirroring a backend
`SLOT_COUNT` by hand (there is no such constant any more) and initialises from an
empty list until the first load.

The slot dialog gains **Add bullet** and **Delete this bullet**. Saving a bullet
keeps today's behaviour (colour + content, empty content clears it). The row's
layout must tolerate a longer list — wrapping, not a horizontal overflow — which
is the only visual change this section asks for.

Whether the row keeps a visible "+" affordance or the add lives only in the dialog
is a layout call for the implementation; the requirement is only that adding and
deleting are reachable without leaving the app.

The **starting** state stays nine empty gray bullets (§4.3), so a first boot looks
exactly like today's and the "no UI change" expectation holds; the count only
becomes the user's business from the first add or delete.

### 5.4 Composer and app bar

- The dropdown offers the same agents in every workspace, which is the point.
  Two visible differences: `todoBuilder` is now in the list, and **the mode lock
  is gone** — a thread that has turned can switch agent freely, as §4.4 explains
  and as the server has always allowed. The per-hub gray-out of the Tools panels
  and the running-lot disabling of the select are unchanged.
- Deleting the lock also deletes its call sites: the lock predicate, the
  option-disable rule, and the "the selection did not move" branch of the
  after-save reset decision. What is left of that decision is the lot pin alone.
  The tooltip sentence about a fixed mode goes with them — a message describing
  behaviour that no longer happens is worse than no message.
- **An agent with no model cannot be sent to.** When the selected agent's
  `model_id` is null, a **warning icon renders immediately beside the pencil**
  (the two already share a row, so this adds a glyph and no layout), with the
  tooltip *"Agent has no model to run with. Please assign a model"*, and the
  **Send button stays disabled**. The warning is about the selected agent only —
  switching to an agent that has a model clears it and re-enables Send, so the
  fix is either to assign a model or to pick a different agent.
- The warning reads the agent row's own "can it run" field (§4.4) and the
  server's sentence (D7); it does not re-derive the rule, and it never names an
  agent id. Disabling Send is the point: the user is stopped where the problem is
  visible, rather than after a request that could only fail. The server's 422
  stays as the authority behind it, for a stale tab or a hand-made request.
- **The selected agent is remembered in `localStorage`** — the last one chosen,
  restored on load, validated against the loaded list and falling back to the
  first entry when it is gone. This is the pattern the app already uses for every
  other per-browser preference (theme, layout collapse, Enter-sends, splitter
  sizes, session sound), and it is what replaces the store's `default` key (D5).
  Two consequences of it being browser state rather than configuration: a second
  browser on the same installation can open on a different agent, and a workspace
  switch no longer changes it — the agent list is the same everywhere now, so
  there is nothing to re-resolve.
- A session file that carries an `agentMode` still overrides the remembered choice
  on resume, exactly as today: the file describes the conversation, `localStorage`
  describes the browser, and the more specific one wins.
- When the agent list **failed to load**, Send is disabled with that failure as
  the reason — the composer cannot name an agent it has not read, and D5 removed
  the server-side fallback it used to lean on.
- The app bar loses the three per-workspace file notices, and its connection
  indicator narrows to the store-level question: **is the store usable, and does
  it hold at least one model?** Whether *this* turn can run is deliberately left
  to the composer, which is where the agent is chosen and where the fix is one
  click away. The indicator could read the same selection the composer does, but
  showing one warning in two places means two sentences to keep in step and a
  user who cannot tell which one they are answering.
- Batch mode: the lot still pins its agent at launch, and the model it runs on is
  that agent's own (§6). Two changes to the launch gate:
  - **the unresolved-pin note becomes a refusal.** Today an unresolvable pin is
    "not a refusal: the tasks carry no `agentMode` and the server's default
    answers". With no server-side default (D5) that path would fail on the first
    task anyway, so the lot stops at launch with the reason. It becomes much
    rarer: the pin is `code`, built-ins cannot be deleted (D4), and a workspace
    can no longer rename it — an unresolved pin now means the store is unreadable.
  - the lot gains a check beside the existing "the pinned agent has no MCP tools"
    one: **a pinned agent with no model cannot run a task**, so it refuses to
    launch with the same sentence naming the agent. This is new only because
    nothing was unrunnable before — the old single connection guaranteed a model.

### 5.5 Composables

| composable | change |
|---|---|
| `useAppShell` | settings state becomes a server/model tree; drops the workspace-settings state block, the `lspEnabled` allowlist it held, and the per-switch reload of modes and helpers (they no longer change on a switch) |
| `useAgentModes` | keeps the rules it owns that survive (slug, tab caption, findings→field mapping); the lock rule, the default-mode rule, its document/draft machinery and its mtime handling are removed; the draft becomes the agent list |
| `usePromptHelpers` | list-shaped state, add/delete, no mirrored constant |

The rule that every decision lives in a composable as a plain function, so a
component only renders answers, is unchanged — as is the rule that no cap is
spelled in the client: the caps still arrive in the payload.

Two new plain functions belong to `useAgentModes`, because both are decisions
rather than rendering: *"can the selected agent run?"* (the warning icon and the
Send gate read the same answer) and *"remember / restore the chosen agent"*
around the `localStorage` key (§5.4). The second follows the shape the other
per-browser preferences use — a key constant, a read that tolerates a missing or
stale value, a write on change.

### 5.6 Web tests

The unit tests that assert the file-shaped behaviour are rewritten, not deleted:
the modes dialog's tab/create/slug rules keep their assertions and lose the mtime
and "will create file" ones. The **lock tests and the default-mode tests are
deleted rather than rewritten** — they assert behaviour answers 6 and D5 removed,
and a rewritten version of a test for deleted behaviour is how a feature comes
back (§4.4). What replaces them is a positive assertion that switching agent after
a turn is allowed, so the removal is pinned too.

New cases: a `readonly` agent renders disabled fields with a live model dropdown,
driven by the flag; **an agent with no model shows the warning beside the pencil
and leaves Send disabled, and picking an agent that has a model clears both**; the
remembered agent survives a reload and falls back to the first entry when it names
a deleted agent; the prompt-helper tests replace "always nine" with
add/delete/render-N; the settings tests cover server/model selection, the
unassigned-agent count, and the no-model notice. The e2e specs stop reading store
bytes off disk (§4.6).

---

## 6. Out of scope

- Reordering agents or prompt helpers by drag (insertion order is the order).
- Per-workspace overrides of anything in the store — the whole point is that
  there are none.
- Importing the current flat files (§3).
- Multiple profiles of settings, and any sharing/sync of the database between
  machines.
- A settings history beyond D12's pre-delete copy.
- Changing what `.env` holds, or moving the MCP/LSP declarations and the policy
  (their *contents* stay workspace-scoped; only the LSP gate count changes, D13).
- Any new tab or layout change outside the two dialogs and the bullet row.
- **A dedicated task-runner agent for batch mode.** Batch keeps today's shape: it
  pins its agent (`code`) at launch and runs every task in it. What it runs *on*
  is then that agent's own model, which is the natural consequence of D5 rather
  than a decision this spec makes — the lot never chose a model separately, it
  chose an agent, and the agent now carries the model. A separate task-runner
  agent is a small follow-up (a built-in row with its own model and persona) and
  is deliberately left for another session, so this one stays a storage change
  rather than a batch-behaviour change.

---

## 7. Acceptance

1. Configure a server with two models, pin one agent to each, in workspace A.
   Switch to workspace B: the servers, models, agents and bullets are all there,
   unchanged, with no setup step.
2. `.nojae/` in a fresh workspace holds no settings file, no modes file and no
   helpers file, and nothing in the app looks for them.
3. An agent with no model cannot be sent to: the composer shows the warning beside
   the pencil with the tooltip that says to assign a model, Send stays disabled,
   and the same state refuses a request made directly against the chat route with
   one sentence naming the agent. Assigning a model clears all of it.
4. The `todoBuilder` agent is visible in the dropdown and in the dialog, can be
   given a model, and refuses every other edit — including one attempted directly
   against its route.
5. Prompt helpers can be added and deleted; the row renders whatever count the
   store holds.
6. `nojae.db` and its sidecars are absent from the Editor tree, from search, from
   git status, and unreachable by both connectors, when the working location is
   the install directory.
7. A test run with the test switch on never opens `nojae.db`; its connection comes
   from the restructured test file materialised into a temporary database, every
   agent resolves a model from it, and the run refuses to start when that file is
   absent or malformed.
8. Deleting a server removes its models and leaves the agents that pointed at them
   with no model — visible as the warning in the composer and as the unassigned
   count in the Settings dialog, not as a silent failure; a copy of the database
   precedes the delete in the app's backup folder.
9. A language server declared `enable: true` in a workspace's `lsp-settings.json`
   runs there with no other switch ticked, and an agent with `lsp_enable` false
   still cannot reach it (D13).
10. A chat thread can switch agent after it has turned, from any agent to any
    other, including `todoBuilder` (§4.4). A running lot still cannot be moved.
11. The four built-in agents cannot be deleted, from the dialog or from the route;
    a user-created agent can.
12. The existing suites pass with the changes §4.10 and §5.6 name — including the
    write-surface isolation test, extended to the new routes.

---

## 8. Resolved questions

The questions this draft raised, and what each answer changed in the body. Recorded
because several of them turned out to **delete** a concept rather than relocate it,
and anyone arriving from the earlier design will look for it.

| # | question | answer | where it landed |
|---|---|---|---|
| 1 | where does `lspEnabled` go? | **nowhere** — dropped; the declaration's `enable` flag is the only LSP gate | D13, §4.5, §4.7, §4.10, §5.1, AC-9 |
| 2 | are prompt helpers really app-level? | yes — a bullet is a habit of the user, and the documents a bullet points at are not immutable | §1 |
| 3 | the cap's default and range | 25 for all four built-ins; floor of 1, **no ceiling** | D9 |
| 4 | can built-in agents be deleted? | no | D4, §4.5, §5.2, AC-11 |
| 5 | may Settings write while a reply streams? | unchanged from today (yes), made safe by resolving once per turn | §4.5 |
| 6 | does `todoBuilder` still lock a thread? | **no** — and the `editable` flag thereby loses its last subject | §4.4, §4.7, §5.4, §5.5, AC-10 |
| 7 | one default model, or a second for batch? | **neither** — see 8; batch pins its agent and inherits that agent's model | §6 |
| 8 | is a default model / default agent worth a table? | **no** — an agent with no model cannot run, and the last-used agent is browser state; **there is no `app_config` table** | D5, D7, §4.2, §4.3, §4.4, §4.5, §5.1, §5.2, §5.4, §5.5, §5.6, D14, §4.6, AC-3, AC-7, AC-8 |

Answer 8 is the largest of the eight, because it deletes a table *and* the two
settings it would have held, and the second of those is a **server-side behaviour**
rather than a stored value. Four things follow from it that are easy to miss:

- **The `default` key of the modes payload disappears**, not just the setting. The
  lot's unresolved-pin branch and the composer's "list failed to load" branch both
  lean on it today, and both must refuse instead of falling back (D5, §4.4).
- **A fresh install runs nothing until models are assigned** — four agents, no
  models. That is the intended cost, and it is why the composer's warning and the
  Settings dialog's unassigned count are requirements rather than polish (D7, §5.1).
- **The modes dialog loses its Common tab**, whose only control edited the setting
  that is gone (§5.2).
- **Test mode changes shape**: with no default connection to fall back on, the test
  file must materialise its model into the temporary database and point every agent
  at it, or every test-mode turn refuses (D14).

The other deletions deserve a second read before implementing, because the code
stays behind looking useful:

- **`lspEnabled`** — the *name* survives in the chat payload and the Editor query
  route with a different meaning (the conversation-scoped allowlist). Only the
  workspace-settings member dies, so a sweep that deletes every occurrence of the
  word breaks the Editor pane (D13).
- **`editable`** — after answer 6 nothing sets it to `false`, so every branch that
  reads it is dead code that still looks load-bearing. The flag and the lock
  predicate go in the same change (§4.4); leaving the predicate behind means a
  dropdown that can still freeze for a reason no longer in the payload.
- **`default`** — the key is read by the composer, the lot and the modes dialog.
  Deleting the setting but leaving the key returning a value invites someone to
  wire it back up (D5).

---

## 9. Build order

Not a task list — the breakdown owns that — but the four places where the spec's
own logic forbids splitting the work, so a breakdown does not invent a step that
cannot be landed green on its own.

1. **The store, alone.** Schema (four tables, no key/value bag), connection
   module, seeding, accessors, the resolution seam, and the `conftest.py` fixture
   that replaces the file neutraliser. Nothing reads it yet. This is the only step
   that can be merged with the app still behaving exactly as before, and it is
   what the rest builds on.
2. **Model connection: backend and frontend together.** The moment `EndpointsConfig`
   comes from the store, the Settings dialog must edit the store — a dialog that
   writes a file nothing reads is worse than one that does not exist. Same for the
   app-bar notices.
3. **Agents, the model gate, and the lock, together.** `readonly`, the visible
   `todoBuilder`, the per-agent model and cap, the modes dialog's rewrite, the
   composer's warning and Send gate, the `localStorage` choice, the lot's two
   launch checks, and the deletion of `editable`, the lock predicate and the
   payload's `default` key.

   This is one step and not three, because D5 makes them one behaviour: removing
   the server-side default without adding the composer's gate leaves a Send button
   that 422s with no warning; adding the gate while `default` is still reported
   leaves two authorities on which agent a turn runs. The e2e fixture's **step 3**
   — pointing every agent row at the test model (D14) — belongs here, because this
   is the step that makes an agent without a model unrunnable.
4. **The LSP gate, with its tests.** D13 changes behaviour, so its route change,
   its panel change and its inverted assertions land as one — a half-applied gate
   either double-gates or silently runs servers.

Prompt helpers are independent of all four and can land any time after step 1.

The e2e fixture splits along the same seam as the code it feeds: its *shape*
(§4.6) and the first two materialisation steps — the temporary database and the
server/model rows (D14) — move with step 2, because that is when a connection can
only come from a row; its third step moves with step 3.
