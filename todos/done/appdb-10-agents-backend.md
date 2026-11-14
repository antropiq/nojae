# 10 — Agents: the `agents` table is the modes source, and the modes file dies

## Deliver

The personas stop being a workspace file and become rows. This is the agents half of
the store going live: the read model from task 03 becomes the only answer, the file
layer and its optimistic-concurrency machinery are deleted, and the browser gets
purpose-built agent routes.

1. **`resolve_modes()` / `resolve_mode()` read the `agents` table** (task 03's read
   model), keeping the two behaviour guarantees — never raises, app-owned agent last —
   and applying the two D5 changes: **no `default` key** in the payload, and
   `resolve_mode` narrowing to "an id in, a row or nothing out". The per-root cache and
   the file-state reader are deleted (D11).
2. **A chat turn with no `agentMode` is a 422 naming the field** (D5), not a turn that
   runs as some agent the client never chose — the same reasoning the unknown-id 422
   already records, whose message listing what *is* available is unchanged. The
   request model's validator stops accepting "empty for the default".
3. **Agent routes** (§4.5): read = list with `readonly` and the resolved model; write =
   create, update, delete. Rules the route must enforce, each with a test:
   - **a `readonly` agent refuses every write except its model association**, with the
     same refusal sentence wherever it is reached from;
   - **built-in agents refuse deletion** (D4) — the route answers the same refusal
     sentence, and the client never offers the button (task 11);
   - **validation is the file reader's strictness**: an id outside the slug pattern, a
     label that duplicates another agent's — refused with a message naming the field,
     the duplicate label answered with the existing slug-collision message rather than a
     silent renumber;
   - `max_tool_iteration` accepts a floor of 1 and **no ceiling** (D9);
   - a delete copies the database first, through task 08's helper (D12).
4. **The payload's flags**: `readonly` replaces `editable` (§4.4). `editable` carried
   two meanings and both die — "no tab in the dialog" (todoBuilder now gets a tab) and
   "a thread that has turned cannot leave this agent" (its only subject, and it no
   longer locks). Each agent row also carries whether it can run at all (task 03).
5. **Delete the file layer** (§4.7): `src/core/agent_modes_write.py`, the modes seeder
   and its boot + workspace-switch call sites, the document read
   (`read_agent_modes_document`) and its two routes (`/api/agent-modes/document`,
   `/api/agent-modes/save`), the mtime token, the conflict guard and the
   findings-about-a-file machinery — "the app is the database's only writer, so the
   whole optimistic-concurrency layer for agent modes goes away with the file". The
   `agentModes` block of `GET`/`POST /api/path-location` goes too.
   `agent_modes.py` **survives as the read model** (validation, ordering, the
   never-raises promise, the fallback); only its file half is removed.
   `tests/test_agent_modes_write.py` is deleted; `tests/test_agent_modes_seed.py`'s
   surviving rules move to task 02's seeding tests; `tests/test_agent_modes.py` keeps
   its rules and loses its file fixtures.
6. **Extend the isolation test**: the new agent write routes are pinned per path, only
   the browser's half writes, and no connector, tool or chat path reaches them — the
   same guard that protected the modes save being deleted here.

## Interim state this task opens (closed by 11 and 12 — do not fix it here, and do not
paper over it)

- The pencil's dialog cannot load: its file and its two routes are gone. Task 11 lands
  the dialog against the store.
- The composer's lock predicate and the dialog's Common tab become dead code. They read
  fields that are no longer in the payload; the lock predicate's `editable !== false`
  normalisation means **no agent locks**, which is the intended end state, so leaving it
  for 11 is safe. Task 11 deletes them.
- With no `default` key, the composer has no server-side answer for "which agent" and
  would send no `agentMode` — a 422. Task 11's `localStorage` restore gives it a
  selection. Do not reintroduce a fallback to fix this.
- The dialog's **file-shaped** web tests (`/api/agent-modes/document`, the mtime
  conflict, "saving will create this file", the document/draft machinery) have nothing
  left to test. Delete those cases here so the suite stays green; task 11 writes their
  store-shaped replacements. The tab / create-by-label / slug assertions are **kept**
  and adapted to the new payload, not deleted — §5.6 asks for exactly that.

## Files

- `src/core/agent_modes.py` (file half out, table read in), `src/api/routes.py`,
  `src/api/server.py`, the store module (agent write accessors).
- Deleted: `src/core/agent_modes_write.py`, `tests/test_agent_modes_write.py`.
- `tests/test_agent_modes.py`, `tests/test_agent_modes_seed.py`, `tests/test_chat.py`,
  `tests/test_api.py`, `tests/test_batch.py`, `tests/test_write_surface_isolation.py`.
- `web/src/composables/useAgentModes.js` and `web/src/composables/useBatch.js`: **only**
  the changes needed to keep their tests running against the new payload shape (the
  `default` key and `editable` disappearing). The rewrite is task 11.

## Rules it must not break

- **`AGENTS.md`**: "Every WorkBench turn runs in an agent mode — a workspace-owned
  persona that replaces the configured system prompt and may switch a whole hub off. A
  mode only ever narrows what settings and the conversation already allow; it never
  grants anything." (The word "workspace-owned" stops being true with this task; task 14
  updates that sentence.)
- **`AGENTS.md`**: "This file is injected into every chat turn whatever the mode" —
  unchanged, and the built-in personas plus the generated lot-conventions block stay in
  `agent_modes_defaults.py` as the single definition the seeder and the fallback share.
- **`AGENTS.md`**: "`web/src` never contains a reserved agent id" — the payload carries
  `readonly` as data; nothing in `src/` may special-case an id either, beyond the
  built-in definitions themselves.
- **`AGENTS.md`**: "A lot runs every task in one mode, pinned at launch… A workspace with
  no such mode falls back to the server's default and says so rather than being refused."
  That fallback sentence stops being true with this task — the pin becomes a refusal in
  task 12. Keep the lot's existing tests green here by giving them a store with a `code`
  row (task 04's helper already does), and note the change in the task's answer.
- **`AGENTS.md`**: "A task is finished when its file leaves the lot folder" — the lot
  contract and its generated text are untouched.

## Depends on

Tasks 03, 04, 08 (the delete-backup helper). Independent of 05–07 and 09, though it lands
after 09 in this lot's order.

## Done when

- `grep` for `agent-modes.json`, `agent_modes_write`, `editable` and `default` (as a
  modes-payload key) in `src/` returns nothing; `agent_modes.py` still exists as the
  read model.
- Tests prove: a `readonly` agent refuses every write except `model_id`; a built-in
  refuses deletion; a user-created agent can be created, edited and deleted; a duplicate
  label and a bad slug are refused with a field-naming message; a cap of 1 is accepted
  and a huge cap is accepted; a delete is preceded by a database copy.
- A chat request with no `agentMode` answers 422 naming the field; an unknown id still
  answers 422 listing what is available.
- The isolation test covers the agent write routes; backend suite passes (frontend
  failures in the modes tests are expected and are fixed in 11 — say so in the answer,
  and keep the count of failing files to the modes/settings ones).
