# 08 — Servers and models: the routes, and the Settings dialog's Models section

## Deliver

The connection becomes a **catalogue** the browser can edit: purpose-built routes over
the `servers` and `models` tables, and the dialog's LLM + Sampling sections merged into
one **Models** section that edits them.

**Interim state this task opens, and closes nothing**: the dialog now writes the store
while a chat turn still reads `.nojae/nojae-settings.json`. That is deliberate (spec §9
step 2 pairs this task with 09, which flips the read and deletes the file). Do not
"helpfully" keep the two in sync — there is no migration (D3) and no compatibility
reader. Finish 08 and let 09 close the window.

**Backend routes** (§4.5's shape; exact paths are yours, in the pattern the reserved
folder's files already established — never a path parameter, never an `/api/fs` route,
never reachable from a tool):

| store | read | write |
|---|---|---|
| servers | list **with their models** | create, update, delete |
| models | (in the server list) | create, update, delete |

- **Validation is the same strictness as the file reader**: a sampler outside the
  accepted range, a reasoning value outside the known set, a duplicate server name, a
  duplicate model name under one server — refused with a message that names the field.
  The unique constraints are the last line, not the first: the app refuses before the
  database does, in words.
- **Deleting a server cascades to its models; deleting a model nulls the agents that
  pointed at it** (schema behaviour, not application code — but a test must prove both).
- **D12's copy before a destructive write**: before any `DELETE` (server, model — and
  the agent deletes of task 10 use the same helper), the app copies the whole
  `nojae.db` into the app's existing dated backup folder, **reusing the same helper and
  retention sweep every file replacement already uses** (`src/core/editorfs/files.py`'s
  backup + prune pair). An `UPDATE` needs no copy: "the row it replaces is a field the
  user can retype; a `DELETE` is the one thing they cannot."
- **The API key is never sent to a connector, a log or a tool listing.** It is returned
  to the Settings dialog, which edits it, exactly as today.
- The read returns **servers with their models and nothing else** — there is no fourth
  store and no "app defaults" surface (§4.5).

**Frontend — the Models section** (§5.1), in the dialog's existing two-column shape:

```
nav: Models | MCP | LSP
       └ left column: servers, each expandable to its models
         right column: the selected server's fields, or the selected model's fields
```

- **Server fields**: name, URL, API key (the existing reveal-capable key field), plus
  *Fetch models* — the existing live listing call, which now fills **a server's** model
  list rather than one global dropdown.
- **Model fields**: name (pickable from the fetched list or typed), system prompt, the
  six samplers, reasoning level, vision checkbox — today's Sampling section, moved under
  the model it belongs to.
- **Add / remove** at both levels, with the destructive confirmations D12 asks for.
- **No "default model" concept anywhere**: the dialog marks no model as special. The
  answer to "which model will this agent run on?" lives in the agent's own tab (task 11).
- **The unassigned count**: a quiet line — "2 of 4 agents have no model" — that is
  clickable into the Agent-modes dialog. It is the only place the two stores have to
  talk to each other, and it is a requirement rather than polish: a fresh install has
  four agents and no models, so every agent starts unrunnable (D7).
- `useAppShell`'s settings state becomes a server/model tree. Leave the app-bar notice
  and the workspace-settings state block for 09 — the file still exists until then.

## Files

- `src/api/routes.py` (the new routes and their request models), the store module
  (its write accessors), `src/core/editorfs/files.py` (reused, not changed, unless the
  backup helper needs a whole-file entry point).
- `web/src/components/SettingsDialog.vue`, `web/src/composables/useAppShell.js`.
- New backend tests for the routes and the cascade/set-null/backup behaviour;
  `web/tests/settingsWorkspaceFileNote.test.js` and `web/tests/settingsLspNoIterationsField.test.js`
  touched only as far as the changed section list forces; new web tests for server/model
  selection and the unassigned count (§5.6).
- `tests/test_write_surface_isolation.py` — the new write routes pinned per path.

## Rules it must not break

- **`AGENTS.md`**: "Every write surface is the browser's alone … Every tool returns
  information … no connector, tool or chat path reaches a write route." Extend the
  isolation test rather than trusting the sentence.
- **`AGENTS.md`**: "No write destroys bytes: a save backs up what it replaces" — for
  this store that is D12's pre-delete copy, and it must land **with** the first
  destructive route, i.e. here.
- **`AGENTS.md`**: "`.env` is regenerated from a fixed template on every save" — the
  dialog still owns `.env`'s managed keys and that behaviour is unchanged; only the
  model-connection members leave it. Check what `POST /api/settings` writes today and
  keep the `.env` half intact until 09 decides its fate.
- **The API key stays server-side except for the dialog** (the rule above), and the
  reserved-folder rule that "its secrets never leave the server".
- **Composables own decisions**; the count line's arithmetic is a plain function.

## Depends on

Tasks 03, 04. Independent of 05–07.

## Done when

- Servers and their models can be created, edited and deleted through the routes, with
  field-naming refusals for every invalid value the old file reader refused.
- A test proves: deleting a server removes its models and leaves the pointing agents
  with a null `model_id`; a copy of the database exists in the backup folder before each
  delete; the retention sweep applies to it.
- The Models section renders the tree, the fetch fills a server's model list, and the
  unassigned count reads correctly and opens the Agent-modes dialog.
- The isolation test covers the new routes; backend and frontend suites pass.
