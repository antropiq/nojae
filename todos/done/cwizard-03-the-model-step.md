# Task 03 — The model step (the app's first conversation-less calls)

## Deliver

The reasoning half of the wizard: **one model call per step**, the first model
calls in the app that belong to **no conversation** (§5 of the spec). Both call
shapes and both prompts live in one new core package, so there is exactly one
place that decides what the wizard asks and what it accepts back.

1. **`src/core/wizard/__init__.py`** — the package, with its docstring stating
   what the wizard may never do (never writes a declaration, never starts a
   process, never installs, never a second agent loop).
2. **`src/core/wizard/prompts.py`** — the two prompts **and their answer shapes,
   side by side in this one module** (§11):
   - **propose** — in: the scan facts from task 02 (extension counts, manifests
     and their dependency names, the declared servers, the front-end folder) and
     the declaration file's path. Out: an **ordered** list of proposed language
     servers, each with `id`, the `command` argv it believes runs on this machine,
     the `extensions` it should serve, a `workspaceRoot` **as an environment
     reference** (`${NOJAE_PATH_LOCATION}`, or that plus a sub-folder) and an
     **evidence line** naming what it saw. Ordering rule the prompt must state and
     the parser must preserve: what this folder clearly **lacks** leads; a language
     the project already serves does not. No LSP catalogue exists — this is the
     only place a language-server candidate can come from for the LSP family.
   - **prepare** — in: the chosen candidate (a catalogue `member` for MCP, a
     proposal for LSP) plus the scan facts. Out: the **complete JSON member**, the
     install line(s) per platform where they differ, whether anything must be
     installed, and **one line per platform- or project-specific decision** it had
     to make. The prompt must demand the member carry environment references for
     paths and the sentinel `__put_your_api_key_here__` for a required secret —
     never a value it has seen and never a literal absolute path.
   - Each prompt's expected answer is a **JSON object of a stated shape**; the
     module also owns the strict parse of that shape (a text block around it is
     tolerated, anything not parseable is not).
3. **`src/core/wizard/modelstep.py`** — the call, in both steps' service:
   - it calls **`core.llmkit.chat_completion`** and nothing else (already the
     non-streaming shape; the body carries **no `tools` key**, so the call is
     tool-less by construction);
   - it takes a **resolved connection as an argument** (`model`, `server_url`,
     `api_key`, the sampling the store holds) and never reads `.env`, the store or
     the request itself — resolution is task 05's route, at the dialog's start;
   - **one attempt.** It never consults the seam's retryability verdict to wait,
     never sleeps, never retries. On `LLMRequestError` it returns the endpoint's
     **own** sentence (what `str(exc)` carries);
   - it returns **three distinguishable outcomes**, and the difference is the
     whole point: `ok` (parsed candidates / prepared member), `empty` (the model
     answered well and found nothing — "no language server found"), `failed` (the
     endpoint refused, could not be reached, or answered in a shape the parser
     could not read — each naming itself). "No language server found" and "the
     model could not be reached" must never read the same;
   - it **discards** the response's `usage` and emits no timing: no session clock,
     no cost badge, no number anywhere.
4. A test seam in the package's own style: the call goes out through one
   module-level function so a test re-points one attribute (the pattern the LSP
   hub's command resolution uses) rather than monkeypatching `llmkit` globally.

## Files it touches

- creates `src/core/wizard/__init__.py`, `src/core/wizard/prompts.py`,
  `src/core/wizard/modelstep.py`
- creates `tests/test_wizard_model_step.py`
- **does not** touch `src/core/llmkit/`, `src/core/chat.py`, `src/core/models.py`,
  `src/config.py`, `src/api/routes.py`, `web/`, or either hub.

## Rules it must not break

- "One LLM layer. Every model call — every chat reply, a batch task's turns
  included — goes through `core/llmkit`, the only seam that speaks HTTP." No
  second HTTP path, ever. Do not add a function to `llmkit` for this: the
  non-streaming shape already exists and already sanitises messages on the way
  out.
- "A refused round waits, and only it does." The chat turn's wait stays exactly as
  it is; **this** call makes one attempt and shows the sentence, because a dialog
  that sleeps through a backoff is worse than a named failure (§5).
- Non-streaming and **tool-less**: nothing is offered to the model to execute.
  That is what keeps a preparation dialog from being a second, unsupervised agent
  loop — so no loop here either: one call, one answer.
- "Core owns logic, the API owns transport … nothing under `core` may import the
  API layer." No FastAPI type, no `Request`, no event emission; `emit` is not the
  wizard's mechanism — it returns a value.
- The connection is **not** resolved here, and never re-resolved mid-dialog (the
  chat's "once, at a turn's start" rule applied to a wizard).
- No number, ever: the wizard's tokens enter neither the session clock nor the
  cost badges, and the implementation must not quietly fold them in (§5).
- **Never invents** a version pin, a registry name or a docs URL: the prepare
  prompt for the **MCP** family receives the catalogue's `member` and must not be
  asked to produce one; for LSP its command line is checked by task 04 before it
  is offered, so the prompt states that it will be checked and must not pad a
  package with a version it is unsure of.
- Tests stay hermetic: no test reaches a network, reads a real connection or opens
  the install's store.

## Depends on

- **01** (the catalogue's `member` shape is what prepare receives for MCP)
- **02** (the scan facts are the propose/prepare input)

## Done when

1. `pytest tests/test_wizard_model_step.py` passes, and that file asserts, at
   minimum:
   - both steps build their messages through this module and post through the one
     seam function — asserted by capturing the call (the style
     `tests/test_llmkit_client.py` and `tests/llmkit_fakes.py` use), including
     that the body carries **no `tools` key** and **no `stream` key**;
   - a refused call is **not** waited on: the step returns the endpoint's sentence
     with no sleep in between (assert on the patched seam's call count == 1,
     including for a status in `TRANSIENT_STATUSES` — the ones the chat would
     wait out);
   - the three outcomes are distinguishable and no two share a sentence: parseable
     empty list vs. HTTP refusal vs. transport failure vs. unparseable answer;
   - a proposal list keeps the model's order, and each item carries id, argv,
     extensions, an environment-reference root and an evidence line — an item
     missing any of those is dropped with a note, never guessed into shape;
   - `usage` from the response reaches no return value and no counter, and the
     prepared answer carries no token or cost field;
   - the two prompts are the module's own data: a test asserts propose demands the
     gap-leads ordering and prepare demands environment references plus the
     sentinel spelling, by name.
2. `pytest` (whole backend suite) passes unchanged — `tests/test_chat.py` and
   `tests/test_llm*.py` in particular, whose waiting behaviour this task must not
   have touched.
3. `git status` shows no change outside the files listed above.
4. **Move this file to `todos/done/`** as the very last step.
