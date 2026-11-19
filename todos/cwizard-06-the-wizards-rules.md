# Task 06 — The wizard's rules: one composable that decides everything

## Deliver

`web/src/composables/useConnectorWizard.js` — the wizard's **one** rule surface
(§11 of the spec), in the idiom `useSettingsServers.js` and `useAgentModes.js`
settled: "every enablement verdict, every tooltip and the dialog's **one** message
are answered here, and the `.vue` renders the answers." Task 07's dialog must be
able to render this module's answers with no rule of its own.

1. **State** for one wizard at a time: which family opened it (`mcp` / `lsp`, from
   the button, never a question), the current page, the candidate list, the chosen
   candidate, the prepared answer, the in-flight flag, the failure sentence, and
   the resolved connection the header line renders. Opening a second panel's button
   while a dialog is open is answered by this module (re-open on the new family,
   discarding the unfinished walk — the dialog holds no server-side draft to lose).
2. **Page order as data** — `choose` → `prepare` → `apply` — with the one rule that
   page 1's *source of candidates* differs by family and nothing else does.
3. **The gate** (both buttons; §10's table is the whole truth): live during a
   streaming reply, during a batch, while the hub toggles are locked, while the
   active agent mode switches that hub off, and when a hub route refused the
   workspace. **The one real gate is the model**: with no resolvable model for the
   agent the panel is showing, the button is inert and its accessible name is the
   reason — built from the **existing** `useAgentModes` refusal sentence for that
   row (`agentNoModelSentence`), never a new wording, because one reason that reads
   differently in two tooltips is two reasons.
4. **Every sentence, as a plain function**, each spelled once: the header line
   (`Wizard is running with <agent> on <server> — <model>`), the waiting line per
   step, the three *different* failure sentences (endpoint unreachable/refused ·
   the model answered in a shape nothing could read · nothing offered fits this
   need), the "none of these" stop sentence naming the declaration file, the
   readiness pair (`looks installed` / `not installed`), the sentinel warning
   ("will not authenticate until it is replaced"), the missing-file sentence (the
   file has to be created; the member goes inside an object at its top level; the
   path to create), the restart sentence pointing at the panel's own restart button,
   the duplicate-id warning, the copy confirmation, and the two buttons'
   `Set me up!`. Where the server already said something (the loader's verdict, the
   reach refusal, the endpoint's sentence), render **its** words — this module adds
   no paraphrase of a sentence the app already owns.
5. **The stop** (§3): nothing in the client may grow a "none of these" entry, a
   free-text field, or a path to the JSON editor. An unmatched need is the one
   sentence and the end of the road.
6. **The install hand-over** (§7): an action that puts the install line into the
   composer draft **and nothing else** — no arming, no send, no focused send
   control, no pre-approval. Reuse the composer's own draft setter from `useChat`
   so the preview updates on the usual path; do not reach for its send or its
   staging.
7. **Loading**: the catalogue read (page 1 MCP, no model run yet), the connection
   read (at open, for the header line and the gate), the scan/propose and prepare
   posts. Each owns its in-flight flag and its failure sentence; the reads may use
   the app's GET-retry helper (transport failures only), the two posts **must not**
   be retried — one attempt is the rule, and `api-fetch`'s own note says POSTs are
   deliberately not wrapped.
8. A `reset` that leaves nothing behind (no draft, no cached snippet), because the
   feature has no memory by design.

## Files it touches

- creates `web/src/composables/useConnectorWizard.js`
- creates `web/tests/connectorWizardRules.test.js`
- **does not** touch `useChat.js`, `useAgentModes.js`, `useAppShell.js`,
  `api-fetch.js`, any `.vue` file, or the styles.

## Rules it must not break

- The idiom it joins: "no rule about what a control may do is written in the
  template, so a rule cannot drift from the button that shows it." Everything here
  is a plain function over plain state; no DOM, no `v-html`, no markdown rendering
  (the snippet block is plain text).
- An inert control **always explains itself**: the same string is its accessible
  name when live and its reason when not, so the pair moves as one or not at all.
- **No token, no cost, no timing anywhere**: nothing in this state renders a
  number, and nothing here reads or writes the session clock or the cost badges'
  state — the wizard's calls are not part of the session (§5).
- It may not start, restart or toggle anything: no call to `restartMcp`/
  `restartLsp`, no `setChatMcp`/`setChatLsp`, no hub state mutation. It points at
  the restart, it never presses it.
- It never sends: the only composer surface it touches is the draft.
- The gate reads the agent rows' own fields (`modelId` / `agentCanRun`) and the
  server's refusal — **never re-derive the rule from two tables**, and never name a
  reserved agent id in `web/src`.
- The family comes from the button and is never asked; the dialog is one component
  with one state machine, not two.

## Depends on

- **05** — it consumes the catalogue, connection, scan, propose and prepare
  payloads; the shape of the three outcomes is task 03's, carried through 05.

## Done when

1. `cd web && npm test -- connectorWizardRules` passes, and that file asserts, at
   minimum:
   - the gate table, row by row: streaming / batch / locked toggles / hub switched
     off by the mode / hub-route-refused workspace all answer *live*, and no-model
     answers *inert* with **the existing refusal string** for that row (compared
     against `useAgentModes`'s own builder, so it cannot drift);
   - opening from each panel yields that family, and page 1's candidate source
     differs while the page order does not;
   - **no model is run** by opening the dialog or by rendering page 1's MCP list:
     the catalogue read is fetched and the propose/prepare posts are not;
   - the three failure sentences are pairwise distinct, and none of them is the
     empty-list sentence (AC-7);
   - an empty proposal renders the stop sentence naming the declaration file, and
     no state exists that could hold a hand-written candidate (AC-18);
   - the hand-over action writes the draft and calls **no** send/stage/focus
     function (spies on each), and its text is the install line verbatim;
   - the header line names agent, server and model for a resolved connection and
     carries **no digits** — asserted over every page's rendered answer set;
   - `reset` clears candidate, prepared answer and failure, and nothing survives an
     open→close→open (no draft, no cached snippet);
   - the two posts are issued exactly once per press, with no retry and no sleep
     between attempts, while the reads may retry.
2. `cd web && npm test` passes unchanged (the existing panel tests still see the
   panels as they were — no component changed in this task).
3. `git status` shows no change outside the files listed above.
4. **Move this file to `todos/done/`** as the very last step.
