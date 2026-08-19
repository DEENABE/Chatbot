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
fully gated and never touches GitHub at all:

1. Stages everything (`git add -A`)
2. Runs 4 independent checks — secrets scan (gitleaks), tests (`npm test`),
   build (`npm run build`), and a diff review (blocks on sensitive file
   paths like `.env`/`.pem`/`credentials.json`)
3. **Any failure → stops immediately, unstages, nothing committed.** Report
   the failure and fix it before trying again.
4. **All pass → commits locally, on the current branch.** Nothing is
   pushed and no PR is opened.

Pushing to GitHub and opening PRs are manual, human-only actions — the user
does these themselves. Don't run `git push` (to `main` or any other branch)
and don't open or merge a PR unless explicitly asked to in that moment.

Requires `gitleaks` on PATH.
