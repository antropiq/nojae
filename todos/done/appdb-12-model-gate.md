# 12 — The model gate: the composer's warning, and the lot's two launch checks

## Deliver

The last piece of the behaviour D5 makes one: **an agent with no model cannot be sent
to**, and nothing falls back to a choice nobody made. This task also lands D14's step 3,
because this is the step that makes an agent without a model unrunnable.

**The composer** (§5.4):

- When the selected agent's `model_id` is null: a **warning icon renders immediately
  beside the pencil** (the two already share a row, so this adds a glyph and no layout),
  with the tooltip *"Agent has no model to run with. Please assign a model"*, and the
  **Send button stays disabled**.
- The warning is about the **selected agent only**: switching to an agent that has a
  model clears it and re-enables Send, so the fix is either to assign a model or to pick
  a different agent.
- The warning reads the agent row's own "can it run" field (§4.4, landed in task 03) and
  the server's sentence (D7) — it does not re-derive the rule, and it never names an
  agent id. Disabling Send is the point: the user is stopped where the problem is visible,
  rather than after a request that could only fail. **The server's 422 stays as the
  authority behind it**, for a stale tab or a hand-made request — so the refusal must
  still be reachable by a direct request (AC-3).
- When the agent list **failed to load**, Send is disabled with that failure as the
  reason: the composer cannot name an agent it has not read, and D5 removed the
  server-side fallback it used to lean on (today it sends no `agentMode` and lets the
  server decide — that path must stop).

**Batch mode** (§5.4, two changes to the launch gate):

- **The unresolved-pin note becomes a refusal.** Today an unresolvable pin is "not a
  refusal: the tasks carry no `agentMode` and the server's default answers". With no
  server-side default that path would fail on the first task anyway, so the lot stops at
  launch with the reason. It becomes much rarer — the pin is `code`, built-ins cannot be
  deleted (D4), and a workspace can no longer rename it — so an unresolved pin now means
  the store is unreadable, which stops the lot rather than quietly running it under a
  stranger.
- The lot gains a check beside the existing "the pinned agent has no MCP tools" one: **a
  pinned agent with no model cannot run a task**, so it refuses to launch with the same
  sentence naming the agent. New only because nothing was unrunnable before — the old
  single connection guaranteed a model.
- The lot still pins its agent at launch and reads it per task turn; the model it runs on
  is that agent's own (§6 — no task-runner agent, no separate model choice).

**D14 step 3 — the e2e fixture points every agent row at the test model.** With the test
switch on, after the temporary database is created and the file's server and model are
inserted (task 09), **every** agent row's `model_id` is set to that model. The reason for
step 3 rather than a test-mode branch in the resolution seam is stated in D14: a special
case there would mean the suite exercises a resolution path production never takes, "the
worst property a settings layer can have". Materialising the fixture into rows keeps
**one** seam. A test that wants an agent with no model clears that row's `model_id`
itself.

**Web tests** (§5.6, the new cases): an agent with no model shows the warning beside the
pencil and leaves Send disabled, and picking an agent that has a model clears both; the
remembered agent survives a reload and falls back to the first entry when it names a
deleted agent (the second half of that may already exist from task 11 — extend rather
than duplicate).

## Files

- `web/src/components/WorkBenchInput.vue`, `web/src/composables/useAgentModes.js` (the
  "can the selected agent run?" answer is already there from 11 — wire the Send gate and
  the warning to it), `web/src/composables/useChat.js` (the send path's refusal to post),
  `web/src/composables/useBatch.js` (the two launch-gate changes).
- `src/api/server.py` or wherever the test-mode materialisation lives (task 09's), for
  step 3.
- `web/tests/composerEnterToggle.test.js`, `web/tests/batchRetries.test.js`,
  `web/tests/agentModesPencil.test.js`, and the new gate tests.
- `tests/test_batch.py` and the backend test for the e2e materialisation (step 3).

## Rules it must not break

- **`AGENTS.md`**: "A lot runs every task in one mode, pinned at launch — the workspace's
  coding mode, so moving the composer's choice mid-lot reaches no task." The pin stays
  per-turn-read; only the unresolved case changes from note to refusal. (Task 14 updates
  the sentence about the fallback.)
- **`AGENTS.md`**: "A task is finished when its file leaves the lot folder; that move is
  the agent's own acknowledgement… A file still there is relaunched up to the loop's
  budget, then the lot aborts." Untouched.
- **`AGENTS.md`**: "SSE is the UI's only source of truth… Each stream has its own channel
  and closes with exactly one terminal event; a reply the user paused still ends on its
  own ack." A disabled Send must not leave a half-open stream or a stuck composer state.
- **`AGENTS.md`**: "`web/src` never contains a reserved agent id" — the gate reads the
  row's field.
- **One seam**: no test-mode branch in the resolution seam (D14). If a test needs an
  unrunnable agent, it clears the row.

## Depends on

Tasks 09 (the seam and the refusal sentence), 10 (the 422 for a missing `agentMode`), 11
(the selection, the "can it run" answer, the remembered agent).

## Done when

- AC-3 end to end: an agent with no model shows the warning with that tooltip, Send is
  disabled, and the same state refuses a request made directly against the chat route
  with one sentence naming the agent; assigning a model clears all of it.
- A composer whose agent list failed to load cannot send, with the load failure as the
  reason.
- A lot whose pin does not resolve refuses at launch with the reason; a lot whose pinned
  agent has no model refuses at launch with the sentence naming the agent; a lot whose
  pinned agent has a model runs as before.
- With the test switch on, every agent row resolves the fixture's model, and a test that
  clears one row's `model_id` sees the refusal — proving there is one seam.
- Backend and frontend suites pass.
