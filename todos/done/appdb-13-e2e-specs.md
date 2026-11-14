# 13 — The e2e specs stop reading store bytes; the whole suite runs green

## Deliver

The Playwright specs that read a store's bytes off disk are rewritten against the routes:
"there is no file to read any more, and a spec that reads a store's bytes is a second
authority on it" (§4.6). Then run the full e2e suite against the restructured test
fixture and fix what the lot broke.

1. **`web/e2e/03-workspace-switch.spec.js`**: its assertions about what a fresh
   workspace's `.nojae/` folder holds drop the three store files (settings, modes,
   helpers) and keep the ones that stay — the policy, the MCP declaration, the LSP
   *template*. Its helper-bullet section, which today writes through
   `POST /api/prompt-helpers` and then reads the file back, asserts through the read
   route instead. Add the acceptance this lot promises and no spec yet proves: after a
   workspace switch, the servers, models, agents and bullets are all still there,
   unchanged, with no setup step (AC-1) — and `.nojae/` in the new workspace holds no
   settings, modes or helpers file, and nothing looks for them (AC-2).
2. **`web/e2e/04-agent-modes.spec.js`**: it reads and hand-writes
   `.nojae/agent-modes.json` and asserts `payload.source.path` names that file. Rewritten
   against the agent routes: create an agent, edit it, assert the composer's dropdown and
   the dialog's tab, and assert the `readonly` refusal from the route (AC-4's "including
   one attempted directly against its route"). Its premise — "the file is the user's,
   edited outside the app, so its flags are the user's" — no longer exists; the
   equivalent premise is "the store is the app's, edited through its routes".
3. **`web/e2e/08-editor-lsp.spec.js`**: its setup comment and any step that puts a server
   id in `lspEnabled` in the workspace settings file become "declare it with
   `enable: true` in the workspace's own `lsp-settings.json`", which is what the fixture
   already writes per test (D13, §4.6).
4. **Sweep the rest of `web/e2e/`** for any spec that reads or writes a store file, or
   asserts one of the three deleted `path-location` state blocks.
5. **Run the suites**: the backend suite, the frontend unit suite, and the e2e suite
   (`cd web && npm run test:e2e`, per the README — it needs the test model reachable and
   builds `web/dist` first). Fix what fails, in the layer that is wrong: a spec that
   asserts deleted behaviour is rewritten or deleted per §5.6's rule; a spec that catches
   a real regression is a bug in an earlier task, and fixing it there is in scope for
   this task.

## Files

- `web/e2e/03-workspace-switch.spec.js`, `web/e2e/04-agent-modes.spec.js`,
  `web/e2e/08-editor-lsp.spec.js`, and any other spec the sweep finds.
- `web/playwright.config.js` and `web/e2e/global-setup.js` only if the fixture's new shape
  needs their checks adjusted (the loud "fixture missing" failure stays).
- Any production file an e2e failure proves wrong — name it in the answer.

## Rules it must not break

- **`AGENTS.md`**: "A test run takes its endpoint from the test files, never from a
  developer's." The specs must not gain any path that reaches the real `nojae.db` or the
  developer's connection (AC-7).
- **`AGENTS.md`**: "Tests stay hermetic" — the e2e server keeps `NOJAE_DISABLE_MCP` /
  `NOJAE_DISABLE_LSP` and `NOJAE_TEST_SETTINGS=1` as `playwright.config.js` sets them.
- **The e2e specs' own determinism rule** (stated in `playwright.config.js`): assert on
  app state the composables own or on the shape of a stream, never on a sleep or on the
  wording of a model's answer.
- **A spec must not become a second authority on a store**: assert through routes and the
  DOM, never through the database file's bytes.

## Depends on

Tasks 05–12 (everything the specs exercise must exist). Task 09 and 12 for the fixture's
shape and its step 3.

## Done when

- `grep` for `nojae-settings`, `agent-modes.json`, `prompt-helpers.json` and
  `workspaceSettings` in `web/e2e/` returns nothing.
- The backend suite, the frontend unit suite and the e2e suite all pass.
- AC-1, AC-2 and AC-4 have a spec that proves them.
