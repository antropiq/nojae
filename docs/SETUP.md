<!-- Moved out of README.md so the front page stays short. The prose is
     verbatim -- edit it here, the README links here. -->

# Setup

The full installation reference for both platforms: what each optional
extra is for, Node and Python under Volta and pyenv, development mode,
tests, and the end-to-end suite's own model connection.

The short path is the README's
[Getting started](../README.md#getting-started). This is every detail.

You need **Python ≥ 3.10** for the backend and **Node.js** for the frontend. The
app is desktop-browser only.

### Git Bash on Windows 🪟

On Windows, **Git for Windows is not optional**. It is what gives the two most
useful parts of the app a vocabulary there:

- The `console` MCP connector runs its whitelisted commands through Git's POSIX
  toolset (`ls.exe`, `grep.exe`, `find.exe`, `mv.exe` in `<Git>\usr\bin`) rather
  than a `cmd` vocabulary, so the same command list behaves the same on both
  systems.
- The Editor's terminal opens **Git Bash** as its shell, over a pseudo-console.
  It never falls back to `cmd.exe` or PowerShell: one terminal vocabulary,
  whatever the tab's folder.

The app looks for an installation in the usual places — `git` on `PATH` first,
then `C:\Program Files\Git`, `%LOCALAPPDATA%\Programs\Git`, Scoop and Chocolatey.
An installation is only accepted when its `usr\bin\ls.exe` is really there, so a
lone `git.exe` cannot be mistaken for one. If yours sits somewhere else, point
`NOJAE_GIT_BASH_DIR` at its install root. When nothing answers, the
terminal and the connector refuse **in words**, naming every folder they
searched — they never half-work.

### Setup on Windows

```powershell
# 1. Backend — from the project root
py -3.12 -m venv .venv
.venv\Scripts\Activate.ps1
pip install -e ".[mcp,lsp,windows]"
```

`pip install -e .` alone gives you the chat and the Editor; the extras are what
add the rest, and none of them is mandatory:

| Extra | What it adds |
|---|---|
| `mcp` | The MCP SDK and Playwright — the WorkBench connectors. |
| `lsp` | The LSP client — the language-server tools. |
| `windows` | The Editor terminal's pseudo-console driver. Never pulled in on Linux. |
| `test` | `pytest` and its plugins. |

```powershell
# 2. Frontend
cd web
npm install
npm run build
cd ..
```

Node is easiest to manage with [Volta](https://volta.sh), which pins the runtime
per project: `volta install node@22` in the project root, then `npm install -g
volta` once per machine. Volta keeps its shims in `%LOCALAPPDATA%\Volta\bin`, and
those shims shell out to `volta.exe` in `%ProgramFiles%\Volta` — remember both
folders, they come back when you declare a language server.

### Run on Windows

```powershell
.venv\Scripts\Activate.ps1
nojae
```

Then open <http://127.0.0.1:8001>. The Editor's terminal needs Git Bash to be
installed (and the `windows` extra); without either, it shows you what is missing
instead of an empty pane.

### Setup on Linux

Either environment works — pick one virtualenv manager, not both at once.

**Plain venv:**

```bash
cd /path/to/nojae
python -m venv .venv
source .venv/bin/activate
pip install -e ".[mcp,lsp]"
```

**pyenv:** this repo does **not** ship a `.python-version` — that file only
exists if you use pyenv, and you create it yourself. Name it after a `nojae`
virtualenv so it activates when you `cd` into the project; create that
environment first (`pyenv virtualenv 3.12 nojae`, or let `pyenv install` do
it), then:

```bash
pip install -e ".[mcp,lsp]"
```

> If you use a venv while pyenv is installed, make sure only **one** environment
> is active — pyenv shims otherwise shadow `.venv/bin`.

Then build the frontend. With **Volta**, `volta install node@22` in the project
root is enough and no `PATH` editing is involved; Volta installs under
`~/.volta/bin`, which your shell profile already puts on `PATH`:

```bash
cd web
npm install
npm run build
cd ..
```

Finally, when a connector drives a browser, install its runtime once:

```bash
playwright install --with-deps chromium
```

### Run on Linux

```bash
source .venv/bin/activate     # or: pyenv activate nojae
nojae
```

Then open <http://127.0.0.1:8001>. The terminal pane runs `$SHELL` (falling back
to `/bin/sh`) over a kernel PTY.

### Development (hot reload)

Two processes, on either system:

```bash
uvicorn src.api.server:app --reload --port 8001   # the API on :8001
cd web && npm run dev                             # Vite on :5173, proxying /api to :8001
```

This is `uvicorn`'s own command line, so it carries **no boot flag**: the app runs
on the documented defaults (debug off, the endpoint wait on its pair). Pass `--port`
to `uvicorn` here, not to the app. To try a flag, run the console script instead —
`nojae --llm-debug --port 8001`.

### Tests

```bash
pip install -e ".[test]"
pytest                # backend
cd web && npm test    # frontend
```

The suite is hermetic: it needs no reachable model, `NOJAE_DISABLE_MCP`
/ `NOJAE_DISABLE_LSP` switch the two hubs off entirely, and every test runs on a
temporary settings store of its own — the install's `nojae.db` is never opened.

### Setting up tests for nojae

The end-to-end suite (`cd web && npm run test:e2e`) has **its own** model
connection, so a spec can never talk to a server this install is configured with.
One file and one switch:

| File | Holds |
|---|---|
| `.nojae/nojae-test-settings.json` | The suite's **model connection** — one `server` object holding one `model` object, spelled with the settings store's own column names: `name`, `url`, `api_key`, then the model's `name`, `sys_prompt`, samplers and `supports_vision`. |

`web/playwright.config.js` exports `NOJAE_TEST_SETTINGS=1`, which is the one switch
that puts the server under test in **test mode**: it never opens the install's
`nojae.db`, and works instead on a temporary database it creates in a throw-away
folder. The test settings file's job is to **seed that database** — one server
row, one model row, and every agent pointed at that model — so the suite resolves
a turn's connection exactly the way a real turn does, against a configuration
nobody else owns. Nothing else turns it on — the backend suite pins it off.

The app-level settings the suite used to read from a `.env.test` are **boot flags**
now, and the harness starts the app with `uvicorn`'s own command, which carries
none: the run under test is on the defaults (debug off, the wait on its pair),
which is what it always was whenever that file left them commented out.

**The test settings file is created by hand and never by the app.** It has no
committed template and the app never seeds, saves or rewrites it, so a
Settings-dialog save cannot change what the suite talks to, and it is invisible
to the built-in Editor (`.nojae` is reserved) — edit it outside the app. It is
gitignored with the rest of `.nojae`, so it may hold a real key; no document
about it may.

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

The member names are the store's **column** names, and every one of them is
required: the reader validates the file with the tables' own strictness, so an
unknown key, a missing one or a wrong type is a named failure rather than a
silently-defaulted sampler — a green suite that measured a default is worse than
a red one. Neither id appears, because the harness assigns both. Two things that
used to be members are **absent on purpose**: LSP activation is the workspace
declaration's `enable` flag alone, and the tool-loop cap is a per-agent number a
spec that needs one sets on its own agent row.

Write it at the installation folder's `.nojae/nojae-test-settings.json` — the
app's own checkout, which is the folder a new tab lands on. The suite resolves the
fixture there, never from a developer's configured folder and never from
`NOJAE_PATH_LOCATION`. The pinned samplers and `"reasoning": "off"` are what keep
the streaming specs reproducible.

**A missing file stops the whole suite before a spec runs**, with a message
naming the path — there is no fallback to this install's store, because a suite
that quietly reached your own servers and key would be green while proving
nothing. Fix it by writing the file above; then make sure the server it names is
reachable, since the endpoint stays a real one.

Two checks confirm the fixture really is what the suite talks to (one machine,
by hand):

1. Put a deliberately wrong `server.model.name` in the file and run the suite —
   the failure names `nojae-test-settings.json`.
2. Move the file away and run it again — the suite refuses to start, before any
   spec runs.

Both are cheap, and together they rule out the one failure mode this file
exists to prevent: a green run measured against someone else's server.
