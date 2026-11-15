# 02 — A model write never carries a credential

**Read first**: `docs/settings-dialog-migration-plan.md` §2.1, §7.2, §8's T2. Then
`todos/sdmp-00-big-picture.md`.

The mockup `docs/imgs/Settings-Dialog-models_01.png` shows an *API key* field on a
model's page. **That is an error in the picture and this lot does not build it.** The
credential belongs to the server alone: `api_key` is a `servers` column, `models`
has none, and `POST /api/models/add` / `POST /api/models/save` take the model's
fields plus `serverId` / `id` and nothing else.

The code is already right. This task **proves it** and then **keeps it true**, so a
later task (05 splits the model page into two tabs; 04 and 07 rebuild its verbs)
cannot quietly reintroduce the field.

## Deliver

### 1. The reading, recorded in the lot

Read `web/src/composables/useAppShell.js`:

- `serverRowDraft` builds `{ id, name, url, apiKey }` — the server's three fields
  and its credential.
- `modelRowDraft` builds `{ id, name, sysPrompt, reasoning, supportsVision }` plus
  the six `SAMPLER_FIELDS` — **no credential**.
- `modelWritePayload` returns `{ name, sysPrompt, reasoning, supportsVision }` plus
  the six samplers — **no credential**.
- `saveModelDraft` adds `serverId` for a create and `id` for an update, and posts
  through `postConnectionWrite`. Nothing else reaches a model body.

If any of those four is not as described, fix it in this task and say so in the
change; that is the whole corrective content of this task, and the rest is the
guard.

### 2. The guard

Add `web/tests/settingsModelNoCredential.test.js`. It asserts, without a browser:

1. `modelRowDraft(modelRow({...}))` with a server-shaped row carrying `apiKey` in
   its input yields an object with **no** `apiKey`, `api_key` or `key` member — a
   credential in the wrong place is dropped, not copied along.
2. `modelWritePayload(modelRowDraft(...))` for a fresh draft and for a full one has
   no `apiKey`, `api_key` or `key` member.
3. The **model page has no credential control**: read
   `web/src/components/SettingsDialog.vue` from disk (the pattern
   `web/tests/agentModesDialog.test.js` already uses, `readFileSync` +
   `/templates?/`) and assert the model-page block holds no `ApiKeyField` and no
   `apiKey`. Keep the assertion narrow: the **server** page must still bind
   `ApiKeyField` to the server draft, so assert the presence there too — a guard
   that only forbids would let the field be deleted from both pages.
4. A model save posted through `useAppShell` never carries a credential: with
   `fetch` mocked, call `saveModelDraft` for a new and for an existing model, and
   assert the parsed body of each call has no credential member while a server save
   in the same test **does** carry `apiKey`. Both halves matter: the credential
   travels on the server write and only there.

Make the failure message name the rule, so a later reader knows why the test
exists: the credential is the server's column, `models` has none.

### 3. What this task does not do

- It does not restructure the model page. The two-tab split is task 05; the toolbar
  is task 04.
- It does not touch the server page's own `ApiKeyField`. A server keeps its key, at
  the server row, as today.
- It does not touch `src/`. The schema's shape is not this lot's to change.

## Files

- `web/tests/settingsModelNoCredential.test.js` — new, the four assertions above.
- `web/src/composables/useAppShell.js` — only if the reading in §1 found something
  to fix.
- `web/src/components/SettingsDialog.vue` — only if the reading in §1 found the
  field already present.

## Rules it must not break

- *"`nojae.db` … its model connections, its agents and its prompt helpers. Written
  only through its own routes"* — a model's write keeps going through
  `/api/models/add` and `/api/models/save`, addressed by its own fields.
- *"Every write surface is the browser's alone … and the file ones are refused while
  a chat reply streams."* No new surface is opened here; a test that mock-posts a
  settings route is not a new one.
- *"Tests stay hermetic: no test reads a real model connection … and each test runs
  on a temporary store of its own."* `fetch` is mocked; the source-reading assertion
  reads a file in the checkout, which is not the store.
- *"`lib/` holds the single markdown renderer"* — untouched; no rendered HTML here.

## Depends on

Task 01 (it changes labels in the same file this task reads).

## Done when

- The four assertions exist and pass, and each fails if a credential is put back on
  a model draft, on a model payload, on the model page or in a model's POST body.
- The server page still carries its own `ApiKeyField`, bound to the server draft,
  and a server save still posts `apiKey`.
- `cd web && npm test` is green.

Finish by moving this file into `todos/done/`.
