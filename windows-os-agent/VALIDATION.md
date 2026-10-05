# Validation report — October 2, 2026

Environment: Windows 11 Pro, build 26200, x64; PowerShell 5.1.26100.9549; Node.js 24.18.0; standard-user process in interactive session 1. Ollama reported Qwen running with no model memory on GPU.

| Check | Result |
|---|---|
| Dependency installation and lockfile generation | Passed |
| Node unit/integration tests | 31 passed |
| PowerShell parser | All 9 runtime/check scripts passed |
| C# native interop compilation | Passed |
| Synthetic Windows postcondition/state-comparison tests | 27 passed |
| Live Windows read-only adapters | 14 passed |
| Live Ollama `qwen3.5:9b` → `system.inspect` → final response | Passed with `think:false`; 142.8 seconds total |
| Dependency audit | 0 reported vulnerabilities at the time of testing |
| Mutation acceptance testing | Not performed; no Windows settings changed during validation |
| Windows 10 / other hardware / other UI languages | Not tested |
| UIA mutation profiles | Not calibrated or tested |
| Microsoft LGPO integration | Not runtime-tested; external utility must be configured |

The 14 live read checks covered system, network, saved Wi-Fi profile metadata, WinRT radios, displays, WMI brightness, Core Audio, power, personalization, location consent, firewall profiles, a service, an allowlisted registry value and Windows Update history. Network addresses, endpoint IDs and local filenames are omitted from this report.

The live model correctly returned Windows build 26200 and non-administrator status after executing `system.inspect`. The shipped configuration disables reasoning by default. This successful run validates one live read-only tool round, not every model decision or multi-step mutation workflow. Per-call timeout is 120 seconds; multiple model calls plus tool execution can make the complete round trip longer.

This revision restores the standalone package and adds flushed journal records, request replay protection across restart, persistent blocking after interrupted writes, worker-side approval-state comparison, single-instance ownership, and Unicode-safe subprocess output. Synthetic tests cover these paths without changing Windows settings.

Production readiness still requires mutation/recovery acceptance tests, UI profile calibration, suitable Windows ACLs, a deployment privilege model, and a journal retention procedure. Restart/replay safeguards are implemented and tested; a privileged broker and OS-level process sandbox are not. See README for the exact capability boundary.
