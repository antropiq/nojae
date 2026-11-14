# 07 — Prompt helpers: the whole vertical, with no count rule

## Deliver

The nine bullets stop being a file and become rows — and stop being nine. This store is
independent of the connection and the agents (spec §9: "Prompt helpers are independent
of all four and can land any time after step 1"), so the vertical — table read, routes,
UI, tests — lands complete in one task.

**Backend**

- `src/core/prompt_helpers.py` keeps its name and its read/write contract, but its file
  half is **deleted**: the path helpers, the seeder, the file-state reader, the legacy
  lift, the document formatter, `SLOT_COUNT`, the "exactly 9" check and its error type
  are deleted, **not relaxed** (§4.5). Reads and writes go through the store module's
  accessors (task 03) — this module does not write SQL itself.
- Routes, in the pattern the reserved folder's files already established — never a path
  parameter, never an `/api/fs` route, never reachable from a tool (§4.5): a read that
  lists the rows, and create / update-one / delete. Keep the existing validation
  strictness: a colour that is not a 6-digit hex triplet, or content over the existing
  character cap, is refused with a message that **names the field**. "A database column
  does not make a bad value less bad."
- The `GET`/`POST /api/path-location` payloads lose their `promptHelpers` state block
  (the file is not in the workspace any more), and `src/api/server.py` and the
  workspace-switch path lose the helpers seed call.
- **The chat-streaming gate stays exactly as it is**: the helper writes were never
  gated and still are not, because D7's resolve-once-at-turn-start makes a mid-turn
  save harmless by construction. No new route gains the "unavailable while a reply
  streams" affordance and no existing one loses it.

**Frontend**

- `web/src/composables/usePromptHelpers.js`: list-shaped state, add/delete, and **no
  mirrored constant** — `PROMPT_HELPER_SLOT_COUNT` is deleted and the state initialises
  from an empty list until the first load.
- `web/src/components/MemoryBullets.vue` renders **as many bullets as the store holds**,
  numbered by position, and its layout must tolerate a longer list — wrapping, not
  horizontal overflow. That is the only visual change this section asks for.
- `web/src/components/RegistrationMemoryDlg.vue` gains **Add bullet** and **Delete this
  bullet**. Saving a bullet keeps today's behaviour (colour + content; empty content
  clears it). Whether the row also keeps a visible "+" affordance or the add lives only
  in the dialog is a layout call — the requirement is that adding and deleting are
  reachable without leaving the app.
- The **starting** state is still nine empty gray bullets (seeded at creation, task 02),
  so a first boot looks exactly like today's.

## Files

- `src/core/prompt_helpers.py`, `src/api/routes.py`, `src/api/server.py`
- `web/src/composables/usePromptHelpers.js`, `web/src/components/MemoryBullets.vue`,
  `web/src/components/RegistrationMemoryDlg.vue`, and `web/src/App.vue` if it drives the
  first fill.
- `tests/test_prompt_helpers.py`, `tests/test_prompt_helpers_api.py`,
  `tests/test_prompt_helpers_seed.py` (the count rules become add/delete tests; the
  seed test moves to "created once, never refilled" — which task 02 already covers, so
  re-home rather than duplicate), `web/tests/promptHelpers.test.js`.
- `tests/test_write_surface_isolation.py` — extended, see below.

## Rules it must not break

- **`AGENTS.md`**: "Every write surface is the browser's alone … and each is refused
  while a chat reply streams" — the new routes join the isolation test's pinned list:
  pinned per path, only the browser's half writes, and no connector, tool or chat path
  reaches them. That test already guards the modes save that task 10 deletes; the
  helpers' writes are the same kind of surface.
- **`AGENTS.md`**: "a store is written by the app through its own route, never through a
  path."
- **`AGENTS.md`**: "`composables/` hold app-shell and stream state"; "every decision
  lives in a composable as a plain function, so a component only renders answers" — the
  add/delete/numbering decisions go in `usePromptHelpers.js`, not in the component.
- **No cap is spelled in the client**: the character cap still arrives in the payload.
- **Tests stay hermetic**: the temporary database from task 04.

## Depends on

Tasks 02, 03, 04.

## Done when

- Helpers can be added and deleted through the routes; the read answers whatever count
  the store holds, including zero; the bullet row renders N bullets and wraps.
- `grep` for `SLOT_COUNT` returns nothing anywhere in `src/` or `web/src/`.
- The "exactly 9" error type and its tests are gone; the add/delete tests replace them;
  the colour and length validations still refuse with a message naming the field.
- The isolation test covers the new write routes.
- Backend and frontend suites pass.
