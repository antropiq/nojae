<!-- Moved out of README.md so the front page stays short. The prose is
     verbatim -- edit it here, the README links here. -->

# Configuring the app

What the settings store holds, the two declaration files, the working
location, and `.env`.

Two kinds of thing configure the app. The **model connection, the agents and the
prompt-helper bullets** are rows of one SQLite database — `nojae.db`, at the
install root, created by the app on first boot and edited from the dialogs. The
**declarations** stay files, in a workspace's reserved `.nojae/`, and they are the
only settings a folder carries.

| | Holds | Written by |
|---|---|---|
| `nojae.db` (install root) | The servers and the models under them, each server with its key; the agents; the prompt helpers. | the Settings and Agent-modes dialogs — and nothing else |
| `.env` (from `.env.example`) | The install-scoped technical keys: `LLM_DEBUG` (log every request payload), `NOJAE_PYTHON_ROOT` (the python the stdio connectors run on), and the two numbers of the model-endpoint wait. | by hand; nothing in the dialog edits them |
| `.nojae/mcp-settings.json` (seeded from `mcp_connectors/mcp-settings.default.json`) | The MCP connectors the agent may call. | by hand; the dialog's toggles write each entry's `enable` flag |
| `.nojae/lsp-settings.json` (written from the seeded `.nojae/lsp-settings.template.json`) | The language servers. | by hand; same |

The database is **binary and single-writer**: never hand-edited, and with no
committed template, because it has no member you would type into it. It holds the
model keys, so it is gitignored like the other secret-bearing files, and it is
hidden from the Editor's tree, from file reads and search, and from both
connectors — the protection `.env` already has. A store the app cannot open is a
**named state**, never a silent empty one: the app bar says so in the one sentence
that names the path, and a chat turn refuses with that same sentence.

The two declaration files may carry API keys too, so they are gitignored and their
secrets are never returned by the API. Both belong to a workspace: when a folder is
first admitted, the app seeds the MCP declaration from its committed
template — with the `console` and `fedit` connectors pre-declared — and leaves the
LSP *template* beside it, a copy of `lsp_connectors/lsp_servers.example.json`. No
seed ever overwrites an existing file. The LSP declaration is never seeded as a
working file — its entries name machine-local paths — you write it yourself from
the template.

Nothing about the connection, the agents or the bullets travels with the folder:
point a tab at another project and the same servers, the same agents and the same
bullets answer there. The store is read afresh at the start of every turn, so a
dialog save needs no restart at all. `.env` follows the other rule: a hand-edit
waits for one.

### The model connection — Settings → **Servers**

A connection is two things, and the dialog edits them one after the other:

1. **Add a server** — a name you will recognise, its OpenAI-compatible base URL
   (`http://127.0.0.1:8080/v1` for a local llama.cpp), and its API key, which
   stays on the server and is never sent to a connector, a log or a tool listing.
   **Fetch models** asks that server what it offers: the names it answers with are
   listed in a table under the button, each with a **+** that adds that model
   under the server. The server must be saved first; the fetch dials its saved URL
   and key.
2. **Add a model under it** — the id *exactly as the server names it*, the system
   prompt that model is given, its samplers, and whether it accepts images. A
   sampler left empty is left out of the request rather than defaulted, so `0` and
   "not set" stay different values.

A server with no model under it dials nothing, and an agent with no model cannot
run — there is no default model to fall back on, so the composer says which agent
is unrunnable before the Send button lets you find out. Which agent runs on which
model is the agent's own field, set in the Agent-modes dialog.

### The agents — the pencil beside the composer's dropdown

The **Agent-modes** dialog holds the personas the composer offers. It is titled
**Agents**, and its left column is the agent list under a toolbar of three verbs —
add, save, delete — each acting on **the selected agent**: a row click shows that
agent's form, which holds a label, the two hub switches (whether the MCP tools and
the language servers reach it at all), the persona, the cap on that agent's tool
loop, and the model it runs on.

Add opens an empty form — a new agent joins the list only when a save succeeds —
and a save writes just the agent in view, leaving the dialog open. Delete asks
first, in the toolbar; `Close` is the only way out and asks the same way before
discarding typed edits. The agents nojae ships with are seeded into the store on
every boot, so no hand-edit and no damaged file can lose them; the one the lot
contract pins is **read-only** — it is listed like the others and its model is
yours to set, but everything else about it is re-asserted from code at each start.

Deleting a server, a model or an agent first copies the whole database into the
app's dated backup folder (`logs/editor_backups/`, kept as long as every other
backup the app makes), so the mistake is recoverable. And since the store has no
hand-edited member, that is the whole reset story: stop the app, remove `nojae.db`
and its `-wal`/`-shm` sidecars beside it, start it — the app rebuilds it with the
built-in agents and no servers.

### The MCP setup file — `.nojae/mcp-settings.json`

One entry per connector id, each with an `enable` flag that is the only switch
that counts. Two kinds:

- **`remote`** — a Streamable HTTP endpoint (`url` plus optional `headers`);
- **`local`** — a stdio child the hub starts and owns (`command` as an argv list,
  e.g. launched through `npx`).

Any `url`, `command`, `headers` or `env` value may reference an environment
variable as `${NAME}`, or `${NAME:-fallback}` when the variable is optional. The
reference is expanded when the file is read, using the environment the connector
runs with — the app's own, `.env` included — so one declaration works on every
machine and a secret can stay out of the file. Two names answer from the app
itself rather than from the environment: `${PROJECT_ROOT}` is this install's
own folder, always right by construction. Only the braced `${…}` form is
special, an
expanded value is never re-split into arguments, and an unset name is left
written as-is and reported as a validation note in **Settings → MCP** rather
than blanked.

**On Linux:**

```json
{
  "context7": {
    "type": "remote",
    "enable": true,
    "url": "${MCP_BASE_URL:-https://mcp.context7.com/mcp}",
    "headers": { "CONTEXT7_API_KEY": "${CONTEXT7_API_KEY}" }
  },
  "chrome-devtools": {
    "type": "local",
    "enable": true,
    "command": ["npx", "-y", "chrome-devtools-mcp@latest",
                "--executablePath=/usr/bin/chromium", "--headless"]
  },
  "console": {
    "type": "local",
    "enable": true,
    "description": "Console command",
    "command": ["/home/me/.pyenv/versions/nojae/bin/python",
                "${NOJAE_PATH_LOCATION}/mcp_connectors/console_mcp.py",
                "--root-dir", "${NOJAE_PATH_LOCATION}", "--transport", "stdio"]
  },
  "fedit": {
    "type": "local",
    "enable": true,
    "description": "File editor",
    "command": ["/home/me/.pyenv/versions/nojae/bin/python",
                "${NOJAE_PATH_LOCATION}/mcp_connectors/fedit_mcp.py",
                "--root-dir", "${NOJAE_PATH_LOCATION}", "--transport", "stdio"]
  }
}
```

**On Windows**, the same entries with the interpreter written the way a Windows
venv lays out — and nothing else about the file changes:

```json
{
  "console": {
    "type": "local",
    "enable": true,
    "description": "Console command",
    "command": ["${NOJAE_PATH_LOCATION}\\.venv\\Scripts\\python.exe",
                "${NOJAE_PATH_LOCATION}\\mcp_connectors\\console_mcp.py",
                "--root-dir", "${NOJAE_PATH_LOCATION}", "--transport", "stdio"]
  },
  "fedit": {
    "type": "local",
    "enable": true,
    "description": "File editor",
    "command": ["${NOJAE_PATH_LOCATION}\\.venv\\Scripts\\python.exe",
                "${NOJAE_PATH_LOCATION}\\mcp_connectors\\fedit_mcp.py",
                "--root-dir", "${NOJAE_PATH_LOCATION}", "--transport", "stdio"]
  }
}
```

The `npx` lines work as they do on Linux — the connector process inherits your
`PATH`, where npm put `npx` — so the only real difference is which Python you
name. Two rules of thumb anyway: the brace closes right after the variable name
(`${NOJAE_PATH_LOCATION}/web`, never `${NOJAE_PATH_LOCATION/web}`),
and a backslash inside a JSON string is written twice.

`console` and `fedit` are the two connectors shipped with the app — the shell
command surface and the file-edit surface (read, preview, apply, revert). Batch
mode needs both. They take `--root-dir`, so their reach is bounded by their own
deny-list, and `console` execs one command with no shell: no pipes, no
redirections, no command chains. `chrome-devtools` and `context7` are third-party
and entirely optional.

The MCP panel's **Set me up!** button is the guided way in: it offers the
committed catalogue (`mcp_connectors/catalog-mcp.json`), prepares the chosen
entry for this machine and this folder, and hands over a JSON **member** to
paste into this file. The member is put through the app's own loader and the
page prints its verdict in the loader's own words, so a member the loader would
refuse is refused there, naming the field to change, before any restart. Nothing
in the wizard writes this file for you: the paste is yours, and the panel's
**restart** is what applies it, since the hub reads the declaration at
start-up. One rule at the paste: a slot spelling `__put_your_api_key_here__`
must be replaced with your key before the entry authenticates, and a snippet
never carries a key the app has seen — the `${…}` form above is the
alternative when the key belongs outside the file.

### The LSP setup file — `.nojae/lsp-settings.json`

When a folder is first admitted, the app leaves
`.nojae/lsp-settings.template.json` in its reserved folder — a copy of the
committed `lsp_connectors/lsp_servers.example.json`, never overwritten. Copy
it to `.nojae/lsp-settings.json` and adapt it; the app reads only
`lsp-settings.json`, and a workspace without one simply has no language
servers. One entry per server id: a stdio `command`, the `workspaceRoot` it
indexes, the file `extensions` it owns and the `tools` to expose. An enabled
server adds `lsp_<id>_<action>` tools — diagnostics, hover, definition,
references, symbols, completion, formatting — to the WorkBench tab.
`${NAME}` expansion works here exactly as it does for MCP.

The LSP panel's **Set me up!** button is the guided way in, and it starts from
this folder: it proposes the servers the project's own files ask for, prepares
the chosen one for this machine, and hands over a JSON **member** — checked by
the app's own loader before it is offered, and reported as `looks installed` or
`not installed` by resolving its command, never by running it. What has to be
installed stays the user's line to run. When `lsp-settings.json` does not exist
yet the page prints the path to create and the member still goes inside an
object at its top level: the wizard writes nothing, so the seeded file stays a
template and the paste stays yours. The panel's **restart** is what applies it,
since the hub reads the declaration at start-up.

One gate decides whether a server runs in this workspace: its `enable` flag in
`lsp-settings.json`. That file is the single source of truth, exactly as
`mcp-settings.json` is for the connectors — so a declaration you copy in with
`enable: true` starts those servers on first open, and a workspace cloned from
another machine runs what its own file says with nothing else to tick. The
Settings dialog's LSP section is an editor over that flag: a ticked row means
"this server runs here", the save writes the flag back to the file, and a
hand-edit of the file takes effect on the next hub restart (the LSP panel's
restart button, or an app restart).

There used to be a second switch agreeing with that flag, so a prepared
declaration could stay entirely dormant until servers were ticked. It is gone,
and with it the state where a declaration full of `enable: true` started nothing
— which is the honest reading of a file that says "enabled", and what MCP has
always meant by its own flag. The name `lspEnabled` survives in one place, for a
different question: the **conversation**-scoped `lspEnabled` the WorkBench Tools
panel holds and the Editor's code pane sends, which narrows the running servers
to the ones this conversation may use and can never add one that the declaration
has switched off.

Install the servers themselves with npm, the same line on either system (the
`lsp` extra only brings the Python client side):

```bash
npm install -g pyright typescript typescript-language-server @vue/language-server
```

**On Linux** — the form of the committed example, where `${VOLTA_BIN:-/usr/local/bin}`
covers both a Volta-managed install and a plain global one:

```json
{
  "pyright": {
    "enable": true,
    "label": "Pyright (Python)",
    "extensions": [".py", ".pyi"],
    "command": ["${VOLTA_BIN:-/usr/local/bin}/pyright-langserver", "--stdio"],
    "workspaceRoot": "${NOJAE_PATH_LOCATION}",
    "env": { "PATH": "${VOLTA_BIN:-/usr/local/bin}:/usr/local/bin:/usr/bin:/bin" },
    "initializationOptions": { "typeCheckingMode": "standard" },
    "tools": ["diagnostics", "hover", "definition", "references", "document_symbols"],
    "idleShutdownSeconds": 300
  },
  "typescript": {
    "enable": true,
    "label": "TypeScript",
    "extensions": [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
    "command": ["typescript-language-server", "--stdio"],
    "workspaceRoot": "${NOJAE_PATH_LOCATION}/web",
    "lazy": true,
    "initializationOptions": { "tsserver": { "path": "/usr/local/lib/node_modules/typescript" } },
    "tools": ["diagnostics", "hover", "definition", "references", "document_symbols",
              "completion", "signature_help", "formatting"],
    "idleShutdownSeconds": 300
  },
  "vue": {
    "enable": true,
    "label": "Vue",
    "extensions": [".vue"],
    "command": ["vue-language-server", "--stdio",
                "--tsdk=${NOJAE_PATH_LOCATION}/web/node_modules/typescript/lib"],
    "workspaceRoot": "${NOJAE_PATH_LOCATION}/web",
    "lazy": true,
    "tools": ["diagnostics", "hover", "definition", "references", "document_symbols",
              "completion", "formatting"],
    "idleShutdownSeconds": 300
  }
}
```

**On Windows** the same three entries take a different shape, and the two
differences are exactly why a Linux declaration copied verbatim fails there:

```json
{
  "pyright": {
    "enable": true,
    "extensions": [".py", ".pyi"],
    "command": ["pyright-langserver", "--stdio"],
    "workspaceRoot": "${NOJAE_PATH_LOCATION}",
    "env": { "PATH": "${LOCALAPPDATA}\\Volta\\bin;${ProgramFiles}\\Volta" },
    "initializationOptions": { "typeCheckingMode": "standard" },
    "tools": ["diagnostics", "hover", "definition", "references", "document_symbols"],
    "idleShutdownSeconds": 300
  },
  "typescript": {
    "enable": true,
    "extensions": [".ts", ".tsx", ".js", ".mjs", ".cjs", ".json"],
    "command": ["typescript-language-server", "--stdio"],
    "workspaceRoot": "${NOJAE_PATH_LOCATION}/web",
    "lazy": true,
    "env": { "PATH": "${LOCALAPPDATA}\\Volta\\bin;${ProgramFiles}\\Volta" },
    "tools": ["diagnostics", "hover", "definition", "references", "document_symbols",
              "completion", "signature_help", "formatting"],
    "idleShutdownSeconds": 300
  },
  "vue": {
    "enable": true,
    "extensions": [".vue"],
    "command": ["vue-language-server", "--stdio",
                "--tsdk=${NOJAE_PATH_LOCATION}/web/node_modules/typescript/lib"],
    "workspaceRoot": "${NOJAE_PATH_LOCATION}/web",
    "lazy": true,
    "env": { "PATH": "${LOCALAPPDATA}\\Volta\\bin;${ProgramFiles}\\Volta" },
    "tools": ["diagnostics", "hover", "definition", "references", "document_symbols",
              "completion", "formatting"],
    "idleShutdownSeconds": 300
  }
}
```

- **The `PATH` separator is `;`, not `:`** — and an `env.PATH` *replaces* the
  child's `PATH` wholesale, so it must carry every folder the command resolves
  through: with Volta, both the shim folder and the one holding `volta.exe` and
  `node.exe`, otherwise the shim starts and immediately fails.
- **Write the command as the bare program name.** What npm and Volta install
  under `pyright-langserver` is a `#!/bin/bash` script Windows cannot exec; the
  hub resolves `argv[0]` with `shutil.which` over the child's own `PATH`, which
  honours `PATHEXT` and finds the `.cmd` beside it. When nothing answers the
  name, the server is left at `error` with a sentence naming the command and the
  folders searched.

`${VOLTA_BIN}` is a POSIX idea and there is no conditional in `${…}` — no
platform test, no OS-dependent default — which is why the example file states the
Windows form in a `_windows_note` instead of pretending one string fits both.

Two more knobs worth knowing:

- **`"lazy": true`** spawns a server on its first tool call instead of with the
  app (tsserver's cold start is multi-second and eats RAM). A settings panel
  listing a lazy server as *stopped* is not a failure.
- **`lsp_connectors/restricted-paths.txt`** lists, one prefix per line and in
  both platforms' path forms (`/etc`, `${SystemRoot}`, `${HOME}/.ssh`,
  `${USERPROFILE}/.aws`, …), the roots no `workspaceRoot` may sit inside. A
  language server indexing a secret tree would put that tree in the model's
  context window, so the declaration is refused instead.

### The working location

The working location belongs to **the tab**, not the app: each tab points at one
folder, holds it in its own `sessionStorage`, and sends it with every request that
needs it. A reload keeps the folder; a new tab starts on the installation
directory; the address bar never carries it, so two tabs on the same address can
work on two folders at once.

The **app bar** holds this tab's field: type another folder and press **Set** to
point that tab's MCP and LSP tools, the Editor's tree and new terminal sessions at
it in one step. Set is inert while a WorkBench reply or a batch is running **in
this tab** — a session must not have its root moved out from under it. The folder
must exist and must not sit under a restricted path. The server resolves the
folder for each request; no setting holds it. In a declaration, reference it as
`${NOJAE_PATH_LOCATION}` — the placeholder expands to the workspace being served,
so one declaration is correct in every tab. `${PROJECT_ROOT}` keeps meaning the
installation.

That folder gets its own read/write policy in `.nojae/read-write-policy.json`
inside it, which answers one question per file — `rw`, `ro` or `hidden` — for the
Editor *and* for the agent's file tools: a folder you mark `ro` is not editable by
an agent either. The file is seeded for you (dependency and build folders come
read-only) and edited outside the app. The
settings store is deliberately **not** part of that switch: the servers, the
agents and the bullets are the install's, so moving a tab invalidates only that
workspace's hubs, policy and tree caches.

The skills folder is one path this switch answers about in a particular way,
because what it governs is a folder the agent reads (see *Skills* under
[What the app does](FEATURES.md#what-the-app-does)):

| mode on `.agents` | catalogue | the agent can read a skill | the agent can change one |
|---|---|---|---|
| `rw` (default) | yes | yes | yes — **prompted not to** |
| `ro` | yes | yes | refused by the policy |
| `hidden` | **no** | no — unreachable | no |

**`ro` is the recommended setting** for a skills folder: it keeps the know-how
readable by the agent and takes away the one thing it should not do, without
touching your own editor. And **`hidden` is the per-workspace off switch** — it
removes that project's skills from every turn, which is why the scan honours it
rather than listing files the connectors would refuse.

### The install's technical keys — `.env`

Copy `.env.example` to `.env` when you want to turn the request logging on, to
name the interpreter your connectors run on, or to change how long a refused
model round is waited on. This file holds only what is scoped to **this nojae
install** and edited by hand: the model connection — servers, their models,
keys, prompts, sampling and the vision flag — is in the settings store, edited
from the Settings dialog, and the tool-loop cap is a number on each agent (see
the table at the top of this section). What is left here are the technical keys
below, and nothing in the dialog edits them:

```bash
#LLM_DEBUG=1                # logs every request payload to the console
#NOJAE_PYTHON_ROOT=         # the python the stdio connectors run on
#NETWORK_FAIL_MAX_RETRY=3   # how many times a refused round is asked again
#NETWORK_FAIL_WAIT_FOR=10   # seconds between two attempts at that round
```

All four are **hand-edited managed keys**: a settings save keeps them, but
nothing in the dialog edits them. `LLM_DEBUG=1` makes the LLM client log the
payload of every request to the server console — very verbose, and switched back
off once the failure is read.

`NETWORK_FAIL_MAX_RETRY` and `NETWORK_FAIL_WAIT_FOR` are the two numbers of the
endpoint wait described under
[One configuration, one streaming layer](FEATURES.md#one-configuration-one-streaming-layer):
how many times one refused round is asked again, and the seconds between two
attempts at it. Both defaults are non-zero, so the wait is **on with no
configuration at all**; `NETWORK_FAIL_MAX_RETRY=0` switches it off and a refused
round fails on its first attempt. One round can hold the turn for at most the
product of the two — `120 × 30s` is two hours — and that hold is not free: a
reply stays in flight through the wait, so **the Editor refuses every write to
its folder** until the round lands. A generous budget is therefore a long window
in which that workspace cannot save, and **Stop** closes it at once. A blank,
non-numeric or negative value is never silently coerced: the default answers for
that key alone, and `GET /api/config` answers the effective pair with a note
naming every key whose written value was unusable — so a typo there is visible
instead of being a stall with extra steps.

A `.env` save **regenerates the file from a fixed template**: fixed key set and
order, empty optional keys commented out, hand-written extras lost. Add or rename
a key and you change the template, the renderer and the committed example
together.

The e2e suite reads the same app-level keys from `.env.test`, and its model
connection from the test settings file — see
[Setting up tests for nojae](SETUP.md#setting-up-tests-for-nojae).

### Run

Both systems, once the two builds above are done:

```bash
nojae          # API + UI on http://127.0.0.1:8001
```

Nothing else is required for the Editor. A fresh checkout's WorkBench needs one
thing: the model connection, which **Settings → Servers** writes into the install's
settings store — a fresh one holds no server and says so in the app bar, and until
an agent is given a model no turn can run. The connectors and servers only decide
how far the agent may reach.
