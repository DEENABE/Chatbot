# App control fixes — 29 October 2026

## Symptom
`open teams schedule meeting` opened Teams and stopped, or the desktop loop ended with
"The proposed primitive is not available in the current UI or permission level."

## Root causes
1. **Routing** – `open teams schedule meeting` had no "and", and `schedule` was not a known goal verb, so the
   whole phrase became the app name ("teams schedule meeting") and only a plain launch ran.
   `open X and <goal>` went to the generic loop, which has no install-if-missing step.
2. **Planner strictness** (`GenericAppPlanner.js`) – Qwen often picks the *text label* inside a button/list item.
   That element has no operations, so the proposal was rejected and the whole task ended on the first mistake.
   `click` also picked the first exposed operation even when App Permissions disallowed it.
3. **Menus in WebView apps** – clicking through Teams' calendar UI with a 7B model is fragile.

## Changes
- `GenericDesktopTask.js`, `AstraTask.js`, `ComputerTaskPolicy.js`, `TaskRouter.js`: app/goal split knows
  schedule/book/join/call/message/send/...; Tanglish `teams la meeting schedule pannu` is admitted;
  every `open <app> <goal>` now runs as an Astra task (open → install through the validated provider chain with
  your approval if missing → goal). Close / Settings / Calculator keep their own flows.
- `GenericAppPlanner.js`: proposals are grounded on the nearest ancestor (or single child) that exposes a
  *permitted* operation; focus/select fall back to click. A rejected proposal is sent back to the model with the
  reason (up to 3 tries, `DESKTOP_MAX_PROPOSALS`). Real permission blocks now say which App Permissions level is needed.
- `GenericDesktopService.js`: `click` prefers an operation the permission level allows.
- New **app intents** (`backend/src/orchestrator/AppIntents.js`, `frontend/tools/apps/AppIntentCatalog.js`,
  `app.openIntent`, SAFE_WRITE): a matching goal opens the app straight at a pre-filled screen through its documented
  deep link (`msteams:/l/meeting/new?subject&startTime&endTime&attendees`). Date/time/duration/attendees/subject are
  parsed deterministically (English + Tanglish: naalai, maalai 5 mani...). The model never supplies a URI; the desktop
  app builds it from validated slots and checks the scheme is registered by the installed app.
  Sending is still a UI click on **Send**, which is DANGEROUS and asks for your confirmation.
  No time given → the form opens pre-filled and nothing is sent.

## Tests
`backend/tests/appControl.test.mjs` (new), `frontend/tools/tests/appIntents.test.mjs` (new), updated
`appActions.test.mjs`; planner, routing and software-flow suites pass. Not verified on a real Teams window from here:
rebuild with `rebuild.cmd` and try it on Windows.

Backups of every edited file: `*.before-appcontrol`.
