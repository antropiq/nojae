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
# The browser the end-to-end suite drives: the one this repo's
# @playwright/test pins, so this is Playwright's own installer.
npx playwright install --with-deps chromium
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
```

Finally, once per machine, the browser the end-to-end suite drives — still from
`web`, because it is **this repo's `@playwright/test`** that decides which build
that is. `--with-deps` adds the system libraries that are the missing half of the
story on Linux:

```bash
npx playwright install --with-deps chromium
cd ..
```

Nothing else chooses the browser: the harness names no executable path of its
own, so a run always uses that pinned download, and
`PLAYWRIGHT_EXECUTABLE_PATH` is the single override for a run that must drive
another binary. A **connector** that drives a browser is a declaration of yours
and names its own binary — see [Configuring the app](CONFIGURATION.md).

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

The end-to-end suite asks for one thing the others do not: the browser it drives.
Install it before a first e2e run — `cd web && npx playwright install --with-deps
chromium`, the same on every platform
([Playwright's introduction](https://playwright.dev/docs/intro)); the Linux
install steps above give it a place in the setup.

### Setting up tests for nojae

The end-to-end suite (`cd web && npm run test:e2e`) has **its own** model
connection and **its own model server**, so a spec can never talk to a server —
or a model — this install is configured with. One file, one switch, one stub:

| Piece | Role |
|---|---|
| `web/tests/nojae-test-settings.json` | The suite's **model connection** — one `server` object holding one `model` object, spelled with the settings store's own column names: `name`, `url`, `api_key`, then the model's `name`, `sys_prompt`, samplers and `supports_vision`. |
| `tools/openai_fake_server.py` | An OpenAI-compatible **stub** model server: it answers the two routes the app speaks (`/v1/models`, `/v1/chat/completions`) with a fixed, word-paced, exactly-shaped stream. |
| `NOJAE_TEST_SETTINGS=1` | The switch that puts the server under test in **test mode** (never opens the install's `nojae.db`). |

The Playwright harness starts both processes itself — the stub first, then the
app — and stops them in reverse, so `npm run test:e2e` needs nothing running
ahead of it and reaches no model of anyone's.

The fixture's job is to **seed the temporary store** the app boots with: one
server row, one model row, and every agent pointed at that model, so the suite
resolves a turn's connection exactly the way a real turn does, against a
configuration nobody else owns. Nothing else turns the switch on — the backend
suite pins it off.

**The harness reads the fixture, it does not repeat it.** The stub is started on
the host and port the fixture's `server.url` names, and advertised under its
`server.model.name`, so changing the file moves both sides at once. The one
address rule to hold: point it at the stub's own default
(`http://127.0.0.1:8199/v1`), because that is the process being started for it.

The app-level settings the suite used to read from a `.env.test` are **boot flags**
now, and the harness starts the app with `uvicorn`'s own command, which carries
none: the run under test is on the defaults (debug off, the wait on its pair),
which is what it always was whenever that file left them commented out.

**The test settings file is created by hand and never by the app.** The app never
seeds, saves or rewrites it, so a Settings-dialog save cannot change what the
suite talks to. It is committed under `web/tests`, beside the config that boots
it and the specs that read it, and it holds **no secret**: the stub accepts
anyone's request, so `api_key` is empty by design. `src/core/appdb.py` reads the
same path, and `tests/test_appdb_test_fixture.py` pins that the two agree.

```json
{
  "server": {
    "name": "test-fake",
    "url": "http://127.0.0.1:8199/v1",
    "api_key": "",
    "model": {
      "name": "fake-model",
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

The stub **serves whichever model name it is asked for**, so a fixture's
`server.model.name` cannot be refused for a typo — but it advertises the name it
was started with at `/v1/models`, which is where the context-window read comes
from, so keep both spellings the file's. The pinned samplers and
`"reasoning": "off"` are what keep the streaming specs reproducible.

**A missing fixture stops the whole suite before a spec runs**, with a message
naming the path — there is no fallback to this install's store, because a suite
that quietly reached your own servers and key would be green while proving
nothing.

Two checks confirm the fixture really is what the suite talks to (one machine,
by hand):

1. Change `server.url` to a port nothing answers and run the suite — the streamed
   turns fail, which is the proof the store's rows came from that file.
2. Move the file away and run it again — the suite refuses to start, before any
   spec runs.

Both are cheap, and together they rule out the one failure mode this file
exists to prevent: a green run measured against someone else's server.
