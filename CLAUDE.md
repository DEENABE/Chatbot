# Working agreements for this repo

## Auto-ship after changes

After finishing a set of code changes (a feature, a fix, a cleanup pass —
use judgment on what counts as "done"), automatically run:

```
npm run ship
```

Do this without asking for confirmation first. The user has given standing
authorization for this specific, gated workflow.

`npm run ship` (scripts/ship.mjs) is safe to run unprompted because it is
fully gated and never touches `main`:

1. Stages everything (`git add -A`)
2. Runs 4 independent checks — secrets scan (gitleaks), tests (`npm test`),
   build (`npm run build`), and a diff review (blocks on sensitive file
   paths like `.env`/`.pem`/`credentials.json`)
3. **Any failure → stops immediately, unstages, nothing committed.** Report
   the failure and fix it before trying again.
4. **All pass → commits → pushes the `claude-auto` branch → opens or
   updates a GitHub PR into `main`.** `main` itself is never pushed to
   directly — a human always reviews and merges the PR by hand.

Don't run `git push` directly to `main`, and don't merge the PR yourself —
both remain manual, human actions. `npm run ship` is the only path code
changes take to reach GitHub.

Requires `gitleaks` and `gh` (authenticated via `gh auth login`) on PATH.
