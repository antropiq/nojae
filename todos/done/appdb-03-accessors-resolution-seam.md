# 03 — Accessors and the resolution seam

## Deliver

The read side of the store: the functions every later task calls instead of a file
reader. They exist, they are tested, and **no route or chat path calls any of them
yet** — the old file readers stay in place and still answer, so the app's behaviour is
unchanged at the end of this task.

Provide, in the store's own module:

- **Server + model rows** — the equivalent of today's
  `workspace_settings.load_workspace_settings()`: the servers each with its models,
  and single-row lookups by id. Uncached (D11): "the database is the cache". No
  per-root key anywhere in the read path.
- **`EndpointsConfig.from_store(server_row, model_row)`** in `src/core/models.py` —
  the same output object, the same pydantic validation, the same "absent means" table
  as today's `from_workspace`. A **nullable sampler column stays `None`** so
  `to_kwargs()` omits it from the request body: `0` and "not set" are different values
  and must not converge. A missing server row for a model that names one (only
  reachable through a hand-edited database) is not a crash — see the refusal below.
- **The one refusal sentence (D7).** One function, one sentence, reused by the chat
  route, the Settings dialog and the app bar. It moves the authority today's
  `config.workspace_settings_refusal()` holds from a file to the store, and it covers
  the three states that sentence has to name:
  1. the agent has no model — **the sentence names the agent**, because "which agent"
     is the part the user can act on;
  2. a model whose server row is missing — the same refusal, not a crash;
  3. the store itself is unusable — the sentence naming the path (from task 02).
  There is no fourth branch and no ladder: `agent.model_id` set → that model and its
  server → the connection; null → the sentence.
- **The resolution seam**: one function taking the resolved agent and answering
  `(config, None)` or `(None, sentence)` — the contract `config.load_endpoints_config()`
  holds today, but now **per agent**, because which connection answers is no longer one
  answer for the whole app (D7). Add it beside the old function; task 09 moves the
  callers and deletes the old one.
- **The per-agent cap**: the resolved agent's `max_tool_iteration` (D9), as the
  accessor that replaces `config.max_tool_iteration()`. Floor of 1, **no ceiling**.
  Still MCP's knob only — LSP round-trips stay uncapped, exactly as today.
- **The agents read model over the table**: the two functions today's
  `agent_modes.resolve_modes()` / `resolve_mode()` are, reading `agents` instead of
  the file, keeping the two guarantees that are about behaviour rather than storage —
  it **never raises** (a bad row is reported, the dropdown still renders) and the
  app-owned agent is still **last** in the order — and applying the two changes D5
  makes:
  - no `default` key in the answer at all;
  - `resolve_mode` narrows to "an id in, a row or nothing out": a missing id resolves
    to nothing (the caller answers the 422 of D5), while the unknown-id branch and its
    message listing what *is* available are unchanged.
  Each agent row also carries whether it can run at all — `model_id` plus the resolved
  model's name — so the composer's warning (task 12) reads a field rather than
  re-deriving the rule from two tables. Agents come back in insertion order.
- **The prompt-helper rows**: the equivalent of `load_prompt_helpers()`, reading the
  table, with **no count rule** (§4.5) — a row is a bullet and the count is simply the
  count.

Naming: columns are `snake_case`, the JSON that crosses to the browser keeps the app's
`camelCase` payload convention, and **the translation lives in this module** — never
spread per route (§4.2).

## Files

- The store module from tasks 01–02.
- `src/core/models.py` (`from_store` beside `from_workspace`).
- `src/config.py` (the seam and the refusal builder, added beside the old ones).
- `tests/test_appdb_read.py` (new).

## Rules it must not break

- **"Core owns logic, the API owns transport"** and **"nothing under `core` may import
  the API layer"** (`AGENTS.md`). The seam returns a sentence, never an HTTP status.
- **`AGENTS.md`**: "A mode only ever narrows what settings and the conversation already
  allow; it never grants anything." The read model must not invent a persona or a
  capability that is not in a row or in the built-in definition.
- **The never-raises promise of the modes read** — a bad row is reported, the dropdown
  still renders. Keep it, and keep the app-owned agent last.
- **Tests stay hermetic**: `tmp_path` databases only.

## Depends on

Tasks 01 and 02.

## Done when

- Tests cover the seam's two branches and each of its three refusals, including that
  the "no model" sentence **names the agent**; that a model with a missing server row
  answers the refusal and not a traceback; and that a nullable sampler column produces
  a request-body kwargs dict that **omits** it while a `0` column keeps it.
- Tests cover the read model's guarantees: a hand-corrupted row is reported and the
  rest still render; the app-owned agent is last; there is no `default` key; a missing
  id resolves to nothing and an unknown id's message lists what is available.
- Tests cover the helper read at any count, including zero.
- No existing test changed and the backend suite passes: nothing calls the new
  functions yet.
