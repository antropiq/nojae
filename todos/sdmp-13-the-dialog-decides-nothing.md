# 13 — The dialog decides nothing

**Read first**: `docs/settings-dialog-migration-plan.md` §4.3's first bullet, §6.1,
§7.12, and §1's fourth consequence ("the rules … are written **in the template**").
Then the way `web/tests/agentModesDialog.test.js` asserts the same property for the
Agents card — it reads the component's source and the composable's, and asserts the
template renders answers. Then `todos/sdmp-00-big-picture.md`.

The acceptance item with no task of its own in the spec's breakdown: **no rule about
enablement is expressed in the template**; an assertion shows the dialog reads verdicts
from the composable. This task writes that assertion and removes the last condition
that is still inline.

## Deliver

1. **Find and remove what is left.** After tasks 03–10 the Servers section's template
   must contain no enablement rule. Sweep it for:
   - `:disabled="…"` whose expression is anything but a verdict's `.disabled`;
   - `v-if` / `v-else-if` whose test decides whether an **action** may be taken (row
     existence for a *visible control* is a rule; choosing which page to render from
     the selection is presentation and may stay);
   - `:title="…"` / `:aria-label="…"` whose expression builds a sentence inline rather
     than reading a verdict's `.label`;
   - any `state.settingsSaving`, `state.serversLoading`, `state.selectedServerId ===
     null`, `…id !== null` or `state.fetchedModelsLoading === …` in a `:disabled`, a
     `:title`, a `:aria-label` or an action's `v-if`.
   Anything found moves into `useSettingsServers.js` as a verdict (extend it; do not
   create a second rules module).
2. **Write the assertion.** New `web/tests/settingsTemplateDecidesNothing.test.js`,
   reading the sources from disk (the same technique `agentModesDialog.test.js` uses
   with `readFileSync`, and specifically its template slice: take only the
   `<template>…</template>` region, since `<script setup>` legitimately reads state):
   - The Servers section's template slice contains **no** `settingsSaving`,
     `serversError`-as-a-condition, `selectedServerId ===`, `selectedModelId ===`,
     `fetchedModelsLoading ===`, `draftKey(`, or `!== null` inside a `:disabled`,
     `:title`, `:aria-label` or an action's `v-if`.
   - Every `disabled` binding in the slice is of the form `<name>.disabled` where
     `<name>` is bound to a verdict computed in `<script setup>`.
   - Every `title` / `aria-label` on a toolbar slot, the fetch button and a listing
     `+` reads a verdict's `.label`.
   - The reason strings the verdicts answer with appear **only** in
     `useSettingsServers.js`: assert the component's source contains none of the
     fixed reasons listed in `todos/sdmp-03-the-sections-rules-become-functions.md`.
     A reason typed into the template is a second authority on an enablement.
   - The strip's state (`state.detailTab`) is **not** counted as an enablement rule:
     allow it explicitly, so the test does not force a presentation decision into a
     verdict.
   Make every failure message say what the rule is ("enablement is a composable's
   verdict, never a template condition"), because this test is the pointer `AGENTS.md`
   style asks for.
3. **Sanity-check the sibling.** The Agents card is the model this lot copies; if a
   rule found in the Servers section exists because a shared component imposes it,
   fix it in the Servers section only. Do not "tidy" `AgentModesDialog.vue` — it is
   out of scope and its own test guards it.

## Do not

- **Do not restructure anything for the test's sake.** If a condition is legitimate
  presentation (which page renders, which section is visible), allow it in the test and
  say so in a comment; do not bend the markup to fit a regex.
- **Do not assert on line numbers or on the markup's shape.** Assert on the presence or
  absence of the patterns that *are* the rule.
- **Do not duplicate `agentModesDialog.test.js`.** This file is about this dialog; do
  not fold the two together.
- **Do not touch `src/`.**

## Files

- `web/tests/settingsTemplateDecidesNothing.test.js` — new, the assertion above.
- `web/src/components/SettingsDialog.vue` — the last inline condition(s) removed, and
  the verdicts they become.
- `web/src/composables/useSettingsServers.js` — any verdict added by that sweep.
- The test file that covered a moved condition (most likely
  `web/tests/settingsServersRules.test.js`) — the case now asserts the verdict.

## Rules it must not break

- *"Keep it short and current … name the invariant rather than the implementation a
  routine change would move. A test that exists to enforce an invariant is worth
  naming as a pointer — the invariant stays the point."* The failure messages are
  written to that instruction.
- *"composables/ hold app-shell and stream state … components use them directly."* A
  verdict is a composable's function; the component reads it.
- *"`components/` and `styles/` are the widgets and the theme."* Nothing here moves a
  style.
- *"Tests stay hermetic"* — this file reads two source files in the checkout and
  reaches no route, no store and no browser.

## Depends on

Tasks 03 (the verdicts), 04 (the toolbar), 07 (the fetch button and the listing `+`)
and 10 (the last template conditions in the other two sections' toolbars).

## Done when

- Each `disabled`, `title` and `aria-label` in the Servers section's template reads a
  verdict, and no action's `v-if` tests a fact a verdict should own.
- No fixed reason string appears in `SettingsDialog.vue`.
- The new test passes, and fails — naming the rule — if any of those conditions is put
  back.
- The presentation decisions the test allows are named in its own comments, so a later
  reader does not think the rule is looser than it is.
- `cd web && npm test` is green.

Finish by moving this file into `todos/done/`.
