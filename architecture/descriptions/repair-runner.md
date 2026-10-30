Executes the only system-mutating repair the app supports — Print Spooler inspect / start / verify — by running a single hash-pinned PowerShell script with strict time and output limits, and records every repair step in a durable store.

**Status:** Implemented

## Responsibilities
- `frontend/tools/repair/ProtectedRunner.js` (`createProtectedRunner`): refuses to run unless `PrintSpoolerRunner.ps1` matches its expected SHA-256 (`runnerDigest.js`); accepts only `inspect`, `start`, `verify`; spawns `powershell.exe` with per-operation timeouts (`LIMITS` from `contract.js`)
- `PrintSpoolerRunner.ps1`: the actual service query / start / sampling logic
- `contract.js`: shared limits and `modelPolicy` (what a model may request)
- `RepairStore.js` + `wireRepairLedger.js`: persist repair records and link them to the execution ledger so a crash mid-start can be reconciled instead of blindly retried

## Tech Stack
- PowerShell 5.1, Node `crypto` (sha256), Electron main process
