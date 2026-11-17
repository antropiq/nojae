# Endpoint reconnect — spec

**Status: agreed.** The decisions this feature turns on are settled in §7; the
behaviour in §5 is binding. Lot prefix: `eprec-`.

## 1. The ask

A batch lot running unattended died on this line:

> `LLM call failed: the model endpoint answered HTTP 502 for
> https://api.cortecs.ai/v1/chat/completions: Bad Gateway`

The request is that a transient failure of the model endpoint should **wait and
resume** instead of ending the run, so a lot left alone overnight finishes by
itself rather than waiting for someone to come back and press Start again.

Two corrections to the framing, both of which change the design:

- **It is not the browser's network.** The failing call is nojaé's **backend →
  the model endpoint**. The browser talks to the local server, and that link was
  healthy throughout — it is the channel that delivered the error sentence. A
  guard watching the browser's connectivity would be watching a link that never
  broke. The only honest predicate is *"the model endpoint answers usefully
  again"*, and only the backend can observe it.
- **This was not a network drop.** `502 Bad Gateway` means the request reached
  the provider's gateway and *that* gateway could not reach its upstream. The
  local connection was up. So the guard cannot be keyed on "network back"; it is
  keyed on the endpoint's answer, which covers provider-side 5xx, rate limits,
  connect failures and read stalls alike.

## 2. Feasibility

Five facts about the code as it stands, all verified:

- **The failure happens before a single byte of the reply exists.** The status
  is known before the stream generator is handed back — the client sends the
  request eagerly. So the error surfaces in the `except` around the *call*, not
  in the chunk loop. Nothing was streamed, no tool call was half-received, and
  the message list at that point is byte-for-byte what the failed request was
  about to send.
- **Therefore a retry is a pure replay.** Re-calling the seam with the same
  arguments re-sends the identical request. This is the best possible case:
  resume is *seamless*, not "restart the task on a fresh context".
- **The retry point is inside the tool loop, not outside it.** The loop keeps
  its accumulated messages across rounds, so a failure on round 4 — after three
  rounds of real tool results — replays round 4 with all of that work intact.
  This is what makes "continue where it was left" literal rather than
  approximate.
- **The error is already classified, without string-parsing.** The request
  error carries the status and the URL as fields; transport failures are
  distinct exception types. So "retryable or not" is a decision on data, not on
  the shape of a sentence.
- **The vocabulary already exists.** The frontend's fetch helper draws exactly
  the line this feature needs (*only the transport failure retries; a 4xx/5xx
  reached the server and had something to say*) and already produces a "Network
  unavailable" sentence. Reuse it; do not invent a second one.

**Consequence: this is a backend feature with a thin frontend surface.** The
waiting happens in the one place that can see the endpoint, and the UI only
displays it.

### Why the batch loop needs no change

This is the result worth stating plainly, because it is what makes the feature
small. Today an errored turn ends the lot on purpose (E3: *the lot is one job,
and 8 identical failures teach nothing while each costs a round-trip*). That
rule stays **exactly as it is**.

A retried turn never becomes an error at all: the retry happens inside the
stream, so the turn still ends on its normal `done` frame, the batch loop reads
its normal outcome, and the lot moves on. A budget that runs out still produces
the error frame and still fails the lot. So the batch loop's decision table, its
task-relaunch budget, its delays and the progress bar are all untouched. The
only batch-visible difference is that the transcript shows the wait and the bar
holds still during it.

## 3. Vocabulary

- **the round** — one call to the LLM seam inside the tool loop. A turn is one
  or more rounds. The retry operates on a round, never on a turn.
- **retryable** — an answer that says *try again*: 408, 429, 500, 502, 503, 504,
  and the connect/read transport failures. Everything else is **final**.
- **the wait** — the pause between two attempts at the same round.
- **the budget** — how many waits one round may spend before the failure is
  reported as final. Two `.env` keys set it (§6).
- **Reconnecting** — the label the user sees. Short on purpose, for the composer
  strip's layout.

Avoid **"reconnect"** as a verb for what the app does, and avoid **"network"**
in any user-facing sentence about it. The app is not reconnecting anything and
the user's network is usually innocent (§1); the honest description is *the
model endpoint is not answering, so we are asking again*. The word survives only
in the label, where it is the shortest thing that reads as "not stuck, still
trying".

Avoid **"retry"** unqualified: the batch loop already owns that word for
relaunching a whole *task* (its retry budget, its retry note). This feature
retries a *round* inside one task, and a document that uses one word for both
makes every sentence about either ambiguous.

## 4. Where the guard lives

One place, and it is not the frontend:

| concern | owner |
|---|---|
| noticing the endpoint refused | the chat loop's handler around the seam call |
| deciding retryable vs final | the LLM seam — it owns the exception types |
| waiting, counting attempts, re-sending | the chat loop, same place |
| telling the UI it is waiting | one **non-terminal** `reconnecting` event |
| showing it | the chat composable + the composer strip |

The `emit(event: dict)` contract and the "exactly one terminal frame" rule both
survive untouched: `reconnecting` is a progress event like a tool result, and
the turn still closes with exactly one of `done` / `error` / `pause_ack`.

## 5. Behaviour

Numbered so tasks and tests can cite them.

### When it waits

1. A round whose seam call raises a **retryable** error waits and re-sends, up
   to the budget. This is the *only* retry site.
2. A **final** error behaves exactly as today: the error frame, the turn ends, a
   lot fails. Final means every status the retryable list does not name —
   notably `400`, `401`, `403`, `404`, `422`. A revoked key or a renamed model
   must never be waited on: waiting would turn a one-second diagnosis into a
   silent stall, which is strictly worse than the error line.
3. **An unrecognised exception is final.** The retryable set is written out
   positively and everything unknown falls through to today's behaviour. A
   feature that retries by default would eventually retry a bug.
4. **A mid-stream cut is not retried.** Both shapes of it — the stream-error
   path and the no-finish-reason truncation path — keep their current behaviour
   unchanged. Text has already reached the panel by then, so a replay would
   either duplicate it or silently discard what the user watched arrive. The
   truncation guard exists precisely because a half-streamed tool call must not
   be executed; retrying the same failure mode from the other side would undo
   that.
5. The retry covers **every round of the loop**, including the ones after tool
   calls. A failure on round 4 replays round 4 with the earlier rounds' results
   still in the message list.

### The wait itself

6. Before waiting, the worker emits one `reconnecting` event carrying: the
   attempt number, the budget, how long it will wait, and the endpoint's own
   sentence. The UI shows `Reconnecting 2/3 — the model endpoint answered HTTP
   502 · retrying in 10s`.
7. The wait is **interruptible by Stop**. A Stop during a wait ends the turn the
   way a Stop during a stream does — no new frame, no new state, the partial
   turn discarded as it is today. The worker checks the cancel flag *before*
   each re-send, so a Stop never costs the remaining seconds.
8. **A Pause armed during a wait does not cut the wait short.** The request is
   accepted and answered exactly as it is today (the flag is armed), and takes
   effect at the first chunk of the next successful round — which is the
   existing pause semantics, unchanged. It cannot end the wait, because pause
   means *"interrupt the reply, keep what arrived"* and during a wait nothing
   has arrived to keep. **Stop is the affordance that ends a wait** (§5.7); a
   pause during one is not an error and is not silently dropped.
9. The wait does not re-arm anything: the same turn, the same connection
   resolved at its start, the same tools, the same workspace. A settings save
   landing during a wait cannot split the turn, which is the existing invariant
   and is not weakened here.
10. When the budget runs out, the final error names the attempts: the endpoint's
    sentence plus that it was retried N times over the wait. The old message
    alone would hide the fact that the app already tried.

### What the user sees

11. A new phase, **`reconnecting`**, distinct from the existing `waiting` (which
    means "sent, no first token yet"). The two must never be confusable on
    screen: one means the endpoint refused, the other means it is thinking.
12. The composer stays locked and the running indicator stays lit through a wait
    — the turn is still in flight. **This is the feature's most likely bug**, so
    it is worth being exact: the phase list that answers "is a reply streaming?"
    is written **twice**, and both copies must gain the new value. The shared
    inference-state predicate is what the browser-tab glyph and the
    end-of-session chime read, and the app bar keeps its own copy for the status
    pill. Update one and not the other and the app goes quiet mid-turn: the
    chime fires as though the reply had ended and the tab glyph stops, while the
    composer stays locked. A test asserting the two lists agree is worth more
    here than a test of the new value itself, because it keeps working when a
    further phase arrives later.
13. Nothing is written into the conversation transcript for a wait: no message,
    no marker. The wait is a status line, not content. A replayed round produces
    no duplicate text because the failed round produced none.
14. The same guard applies to **interactive chat** and to a **batch turn** — one
    mechanism, one code path, no per-mode branch. A 502 during a normal
    conversation now waits instead of printing an error line.

### The clock

15. The total time spent waiting is reported on the turn's `done` frame.
16. The **session total excludes it**. A wait is not inference and not thinking;
    a 40-minute provider outage must not read as a 40-minute session.
17. The **per-turn span keeps it**, and the waited time is shown beside it. The
    turn's span is documented as the whole request — waiting included — and that
    meaning is honest and stays. What the user needs is to be able to tell "this
    turn took 41 minutes" from "this turn took 1 minute and waited 40", which
    the separate figure gives them.

## 6. Configuration

Two `.env` keys, as requested. They join the managed key list, which per this
project's own rule means **three places change together** — the key list, the
file's renderer, and the committed example — and there is a test that asserts
the three agree.

| key | meaning | default |
|---|---|---|
| `NETWORK_FAIL_MAX_RETRY` | attempts after the first failure | `3` |
| `NETWORK_FAIL_WAIT_FOR` | seconds between attempts | `10` |

- **The defaults are non-zero, so the feature is on without configuration.** A
  guard that has to be switched on to work would not have saved the run that
  motivated it. `3 × 10s` absorbs exactly the blip in §1.
- **`NETWORK_FAIL_MAX_RETRY=0` switches the whole feature off** and restores
  today's behaviour exactly. Every new behaviour needs an off switch.
- Worst-case hold is `MAX_RETRY × WAIT_FOR`, which is the number that matters
  for §7 D4.
- A blank, non-numeric or negative value is **not** silently coerced: it reads
  as the default, and the settings surface reports the key's effective value so
  the mistake is visible. A retry budget nobody can read off the screen is a
  stall with extra steps.
- The keys are read when the retry decision is made, not cached at boot, but
  **a hand-edit of `.env` still waits for a restart** like every other key
  there.
- These keys are **not** in the Settings dialog. The dialog no longer carries
  `.env` keys at all — the model connection moved to the settings store — so
  these are hand-edited like the connector interpreter path. See §7 D3.

## 7. Decisions

- **D1 — the retryable set is written out positively; unknown means final.**
  408, 429, 500, 502, 503, 504 plus connect/read transport failures. The
  alternative (a deny-list of finals) would retry anything a future provider
  invents, including permanent failures.
- **D2 — mid-stream cuts are out.** Decided in the review. It is also the
  decision that keeps this feature to one retry site, which is why it is cheap.
- **D3 — `.env`, hand-edited, no dialog field.** Agreed as the storage. The
  consequence accepted with it: changing the budget needs a restart, and the
  budget is not discoverable from the UI. If that turns out to bite, the fix is
  a read-only display of the effective value, not a new dialog section.
- **D4 — the budget is the ceiling; there is no second, unbounded layer.** The
  wait holds the workspace's chat slot, and **while a reply streams on a
  folder, every Editor write to that folder is refused**. So a generous budget
  is not free: `120 × 30s` means two hours during which the Editor cannot save
  on that workspace. The budget is the honest place to state that cost, and
  Stop releases it immediately. A separate frontend layer that outlasted the
  stream was considered and rejected: it would need a new batch outcome, new
  progress-bar vocabulary, and it could only resume by re-running the whole task
  turn on a fresh context — a coarser resume than the one this design already
  gives.
- **D5 — the session clock excludes waiting; the turn span does not.** See §5
  15–17. One new field on the `done` frame covers both.
- **D6 — `Reconnecting` as the label, with the endpoint named in the detail.**
  The label is short for the layout; the tooltip/detail line says what is
  actually refusing, so the word does not teach the wrong model of what
  happened.
- **D7 — the batch failure rule (E3) is unchanged.** A budget that runs out ends
  the lot, as it does today, and for the same reason.

## 8. Test surface

- **The retry itself**: a stubbed seam that raises a retryable error twice then
  succeeds — the turn completes, the request was sent three times, the payload
  of the third is byte-identical to the first, and exactly one terminal frame
  was emitted.
- **Final errors do not wait**: 401 and 404 produce the error frame on the first
  attempt, with no `reconnecting` event.
- **Unknown exceptions do not wait** (D1's safety default).
- **A mid-stream cut is not retried** (D2) — asserted as a non-regression on
  both existing shapes.
- **A replay preserves earlier rounds**: fail on round 2 of a tool-using turn,
  assert the replayed request carries round 1's tool result.
- **Stop during a wait** ends the turn with no re-send and no extra frame.
- **A Pause armed during a wait** does not shorten it: the next round streams,
  and the pause takes effect at its first chunk with the partial turn kept
  (§5.8).
- **Budget exhaustion** names the attempt count and still fails the lot.
- **The `.env` trio** — the existing parity test must pass with the two new keys
  in all three places, and neither name may collide with an OS variable.
- **The clock**: a turn with a known wait reports it, the session total excludes
  it, the turn span includes it.
- **The batch loop is untouched**: an existing batch test with a retrying turn
  must pass with no change to the batch module — that is the proof of §2's
  claim.
- **The phase lists agree**: both copies of the "is a reply streaming?" list
  recognise the new phase, asserted as one test comparing the two (§5 12) — the
  shared predicate and the app bar's own copy must not be able to drift.

## 9. Out of scope

- **Server-side batch ownership.** A lot that survives a browser reload, a
  closed tab or a sleeping machine is a different feature with a different shape
  (the lot would stop being browser state), and it is deliberately not this one.
  **Walking away still requires the tab open and the machine awake.** A reload
  discards a batch by design, and a backgrounded tab throttles its timers.
- **Any guard on the browser's own connectivity.** It was never the broken link
  (§1), and there is no such listener in the app today.
- **Retrying anything other than a chat round** — the models listing, the hub
  calls, the Editor's file routes. Those already have their own transport retry.
- **Provider-side diagnosis.** The endpoint's own sentence is passed through
  verbatim; this feature does not interpret it.

