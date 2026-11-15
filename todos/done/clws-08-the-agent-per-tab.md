# 08 — The agent belongs to the tab

**Read first**: `docs/client-owned-workspace-spec.md` §2 (D5), §4.1, §5.3 rule 17,
§5.5 rules 25–28, §10 items 2 and 7, §9's T6. The big picture's *The tab's own
memory*.

The last-used agent is remembered **browser-wide** today, so every tab shares one
choice. It becomes the tab's, in the same storage as the tab's workspace. A turn
still resolves its agent and its model once, at its start — that invariant is
untouched and stays where it is.

## Deliver

### 1. The remembered agent moves to `sessionStorage`

In `web/src/composables/useAgentModes.js`:

- `rememberedAgentId()` / `rememberAgent(id)` read and write the **tab's** storage,
  through the session composable's key rather than a second base name (one file
  owns the `nojae:*` keys — task 02's module). Keep both functions' contract
  exactly: tolerant on read, a missing key and a cleared storage both mean "no
  remembered agent", a throw never propagates.
- The docstring that explains where the choice lives changes with it, and must say
  why: a browser-wide key meant every tab answered as the same agent, which is
  exactly what D5 retires. The *catalogue* is still the installation's — say that
  too, because the two sentences sit next to each other and only one of them moved.

- The selection order in `acceptPayload` is unchanged: a selection the new list still
  holds wins, then the tab's remembered id, then the first entry. A stale remembered
  id still falls back instead of leaving the composer empty.
- **`applySessionAgentMode(rawId)`'s precedence is unchanged**: a saved session file's
  agent beats the tab's memory, because the file describes the conversation and the
  storage describes the tab. Only the storage it falls back to changes.

### 2. Setting it from the composer

`web/src/components/WorkBenchInput.vue`'s agent select already calls
`rememberAgent` on change. Verify that the change lands in the tab's storage, and
that two tabs driven by two different selects end with two different values. No
component logic beyond that call changes: the dropdown's rules, its title and its
hub-gate behaviour stay exactly as they are.

### 3. The turn still resolves once

`POST /api/chat` resolves the agent's row, the connection from its model and server,
and the tool-loop cap **before** the worker starts — `config.load_endpoints_config`
does, and its docstring states the invariant. Nothing in this task changes that, and
nothing may: a settings save in another tab must not split a reply that is streaming
(spec §5.5 rule 27). Add the case that proves it: start a turn in a tab, change the
agent's model row through the store's route from a *second* client, and assert the
streaming reply keeps the model it started on.

### 4. Nothing of the catalogue becomes per-workspace or per-tab

`GET /api/agents`, `/api/servers*`, `/api/models*`, `/api/prompt-helpers*` stay
installation-scoped and gain no `workspace` field (the big picture's invariant, and
task 02 already kept the client from sending one). A tab changing folder invalidates
nothing of the installation's (spec §5.5 rule 28) — assert that a folder change
leaves the agent list, the model list and the helper bullets byte-identical in the
client's state.

### 5. Tests

- `web/tests/agentModes.test.js` — the remembered id lives in `sessionStorage`; a
  `localStorage` value from an older build is **not** read (the new key is a new
  place, and inheriting the old one would re-share a choice); the selection order
  holds with a missing, a stale and a matching remembered id.
- Two tabs: two selects, two remembered ids, two different `agentMode` values in the
  two chat payloads posted from them. The unit suite simulates the second tab by
  resetting the module state — say so in the case's docstring so nobody mistakes it
  for a real browser test (the real one is task 12's e2e).
- `tests/test_chat.py` — the mid-turn settings save case from §3 above.

## Files

- `web/src/composables/useAgentModes.js` — the storage functions and their docs
- `web/src/composables/useWorkspaceSession.js` — the key, if it is shared
- `web/src/components/WorkBenchInput.vue` — verification only; keep the change minimal
- `web/tests/agentModes.test.js`, `web/tests/agentModesDialog.test.js` (only if it
  reads the storage), `web/tests/composerModelGate.test.js`,
  `web/tests/useWorkspaceSession.test.js`
- `tests/test_chat.py`

## Rules it must not break

- *"Every WorkBench turn runs in an agent mode — an install-owned persona… It only
  ever narrows what settings and the conversation already allow."* A per-tab choice
  narrows nothing and grants nothing: the same install-owned rows, chosen per tab.
- *"The connection comes from the settings store, resolved per agent **once, at a
  turn's start**, so a mid-turn save cannot split a streaming turn."* Untouched, and
  now with a test.
- *"`web/src` names no reserved agent id, and the client recognises the app-owned
  agent by a flag."* Nothing here compares an id; `readonly` and `deletable` remain
  the vocabulary. The scan in `tests/test_write_surface_isolation.py` and the source
  scan in `web/tests/agentModes.test.js` must stay green.
- *"composables/ hold app-shell and stream state …; components use them directly."*
  The storage functions stay in the composable; the component calls them.
- *"No server-side memory, no browser-wide memory"* (spec §8) — `sessionStorage`
  only. `localStorage` gains no agent key and loses none it still needs (the theme,
  the layout, the sound and the Enter-sends keys stay where they are: they are
  app-shell preferences, not a tab's identity).
- *"Tests stay hermetic"* — the mid-turn case writes only through the temporary
  store the suite already owns.

## Depends on

Tasks 01 and 02.

## Done when

- The remembered agent is per tab: two tabs, two selects, two remembered ids, and a
  reload of one tab returns to *its* agent while a new tab starts on the first
  entry.
- A saved session file's agent still beats the tab's memory.
- A `localStorage` value from an older build is not read.
- A settings change made mid-turn does not split the streaming reply.
- A folder change leaves the agent list, the model list and the helper bullets
  unchanged.
- `pytest` and `cd web && npm test` are green. The e2e suite is **not** run.

Finish by moving this file into `todos/done/`.
