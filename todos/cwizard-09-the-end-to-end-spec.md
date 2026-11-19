# Task 09 — The end-to-end spec

## Deliver

`web/e2e/13-connector-wizard.spec.js` — the wizard in a real browser, in the
numbered e2e series, following the conventions of the specs beside it (`04-agent-modes`,
`08-editor-lsp`, `12-staged-messages` are the closest neighbours): reach controls by
**accessible name**, read the page rather than a sleep, and route the app's own
endpoints so no spec talks to a real model.

Cover, as browser facts the unit suite cannot establish:

1. **Geometry** (AC-1): both panels' heads hold `Set me up!` at the left of the
   restart button, and the two panels and the dock have the **same rendered
   dimensions** they had before this feature (measure the panels' bounding boxes;
   the head row's height must not have grown). jsdom lays nothing out — this is the
   half only Playwright can assert.
2. **Entry and family** (AC-3): clicking the MCP panel's button opens the dialog on
   the catalogue list with **no** propose request issued; clicking the LSP panel's
   opens the proposed-servers list. The family is never asked: no control in the
   dialog names a family to choose.
3. **The gate** (AC-6): an agent with no model leaves both buttons inert, and each
   inert button's accessible name is the refusal — matched by a fragment of its
   **reason**, the way `04-agent-modes.spec.js` queries an inert slot (so it is
   never matched by its live name).
4. **The three pages, end to end, with the wizard's own posts routed** to fixture
   answers: choose → prepare (member + readiness + install line, AC-8) → apply
   (member verbatim, copy, the path, the restart sentence, AC-10/12). Page 1's LSP
   list shows a fixture proposal whose evidence line names the files the fixture
   folder really holds (AC-4/5's rendered half: the *evidence line* is what the
   browser can show; the ranking itself belongs to the model-step tests).
5. **Copy really copies** (AC-10): grant the clipboard permission, click copy, read
   the clipboard back and compare it to the payload's member, and see the
   confirmation.
6. **Fill-only hand-over** (AC-20): press it, assert the composer's textarea holds
   the install line verbatim, that **no** request reached the chat route, that no
   message was staged, and that focus is not on a send control.
7. **Nothing was written** (AC-14's browser half): snapshot the fixture workspace's
   `.nojae/` tree (bytes and mtimes) before the walk through the dialog and after
   it, and assert it is identical — including that no declaration file appeared
   where none existed (AC-19's other half).
8. **The header line, and no numbers** (AC-17): the line with agent, server and
   model is on screen the moment the dialog opens and on every page; assert the
   dialog's whole rendered text contains no token/cost figure.
9. **A named failure, not an empty page** (AC-7): route the propose post to a
   refusal and assert the sentence on the page; route it to an empty list and assert
   the stop sentence naming the declaration file — two different renderings.

Conventions that are not optional here:

- The suite's **own** model connection is what the app runs on (`.env.test` +
  `.nojae/nojae-test-settings.json`, via the test switch); the spec **routes** the
  wizard's propose/prepare posts, so **no spec sends a completion request** anywhere.
- The fixture workspace is created and removed by the spec, in the folder names the
  suite's `.gitignore` already reserves for e2e workspaces. A created agent, if the
  gate rows need one, is deleted before the spec ends — the store is shared.
- Selectors: accessible names first; keep any class hook the composable already
  pins. Never assert on a sentence's whole wording where a fragment identifies it,
  except for the **exact** strings this lot declares by contract (`Set me up!`, the
  header line, the sentinel).

## Files it touches

- creates `web/e2e/13-connector-wizard.spec.js`
- touches nothing else. If a fixture answer shape is unreachable through the UI,
  that is a defect in task 06/07 — say so in the report rather than reaching into
  the component's internals.

## Rules it must not break

- "A test run takes its endpoint from the test files, never from a developer's" —
  and this spec's model calls stop at the routed response: no chat request, no
  wizard completion request, no registry, and no connector or language server is
  started (`NOJAE_DISABLE_MCP` / `NOJAE_DISABLE_LSP` stay on for the suite).
- **No app path may create a declaration for a scenario**: where a spec needs one,
  it writes the fixture file itself with `fs`, exactly as
  `03-workspace-switch.spec.js` writes its scratch files, and removes it with the
  folder. What is asserted all the way through is that **no request** to the app
  leaves a file behind.
- Do not weaken another spec to make this one pass, and do not add a route the
  feature does not have.
- Nothing in this task changes `src/`, `web/src/`, or `web/tests/`.

## Depends on

- **05, 06, 07, 08** — the whole surface. It is written against the shipped
  behaviour, not against a sketch.

## Done when

1. `cd web && npm run test:e2e -- 13-connector-wizard` passes on this machine for
   both platforms' path forms (the suite already speaks the host's paths — do not
   hardcode one).
2. `cd web && npm run test:e2e` as a whole passes unchanged: the new spec leaves no
   workspace folder and no store row behind.
3. `cd web && npm test` and `pytest` still pass (this task changed no source, which
   the diff proves).
4. `git status` shows no change outside the new spec file (the e2e workspace folders
   are gitignored).
5. **Move this file to `todos/done/`** as the very last step.
