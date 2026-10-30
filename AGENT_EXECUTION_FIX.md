# Application execution fixes — 25 October 2026

The application and installer were rebuilt in `frontend/release-desktop-20261025063933`.
Close the existing Chanakya instance before launching this build: the single-instance
lock otherwise brings the already-running executable to the foreground.

## Observed failures

- The saved request `run calculator add 2 3` fell through to general model tool
  selection. Its arithmetic wording was not recognized, so the model could answer
  without proposing an action. `open calcualtor add 2+5` also mixed the app name
  and action during application resolution.
- Adobe Reader reached discovery, a validated package-manager plan, and explicit
  installation approval. WinGet started an interactive installer; its native log
  reports exit 1602 (cancelled). Discovery alone did not prove installation.
- Package-manager output pipes could remain open in descendants after the manager
  exited, leaving the caller waiting for its deadline rather than its exit receipt.

## Changes

- Explicit two-operand Calculator commands become typed native UI requests without
  depending on a model to choose a tool. Complex requests use the observed desktop
  loop; arithmetic is never evaluated as code.
- Natural commands such as `run Future Reader search invoice` separate the app name
  and goal before registry resolution. Generic desktop tasks receive a step budget
  consistent with their planner's existing limit.
- A desktop model that returns text without a tool call receives one JSON-action
  retry using the same model and local transport. Its proposal must pass the same
  fixed action catalog, argument, observed-element, permission, and verification
  checks. Shell commands, invented controls, and unavailable actions remain rejected.
- Approved WinGet installs use supported silent mode, with the same pinned package,
  version, architecture, source, checksum, publisher checks and approval gates.
  Publisher agreements and Windows administrator prompts are not bypassed.
- The runner drains final output and returns the manager's exit receipt even when
  a descendant retains the output pipe. Cancellation remains a failed operation;
  uncertain side effects are not automatically replayed.
- The app displays preparation, download, installation and inventory-verification
  stages. Progress is scoped to the authenticated request and cleared at completion
  or account changes. The approval dialog explains the installation mode.

## Verification

- 78 focused routing, planner, software execution, approval and process tests passed.
- 9 real Electron trust/frame/navigation checks passed; repair-runner integrity passed.
- The rebuilt executable received the actual signed chat proposals and operated real
  Windows Calculator: `run calculator add 2 3` displayed **5** and
  `open calcualtor add 2+5` displayed **7**, with verified native evidence and no
  uncaught renderer errors. Evidence is under `.tmp/app-control-live-5bjfKU` and
  `.tmp/app-control-live-MY2feV`.
- Frontend compilation, installer creation, package source matching, portability
  checks and `git diff --check` passed.
- Final full suite: **619 tests; 610 passed, 7 failed, 2 skipped**. The seven
  remaining failures are in the existing coding-model adapter/benchmark tests:
  those fixtures request an 8192-token context while this host's current free-memory
  admission limits them to 4096. They are not a green full-suite result; the memory
  protection was retained. Final log:
  `C:/Users/Administrator/AppData/Local/Temp/chanakya-agent-final-tests-eed9524c864c4dab894865f38383bf79.log`.

Installation behavior was exercised with controlled verified fixtures and process
tests. No new third-party product was installed as part of this repair. Individual
publishers can still require an interactive installer, license acceptance, login,
administrator approval or a restart; success is reported only after matching fresh
installed-software evidence.
