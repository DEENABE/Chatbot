# Reliability and security fixes — 24 October 2026

## Fixed failures

- Recreated the missing Electron preload, test runners, release scripts and package validators from the tracked source. Their staged deletions were removed so a later commit cannot silently delete the restored runtime. Other existing changes were preserved. Source scripts and component test folders are no longer hidden by broad Git ignore rules.
- Restored finite model deadlines. Missing configuration previously passed `undefined` to the silence timer, aborting normal answers almost immediately. Defaults now allow 900 seconds for model loading/prompt evaluation and 300 seconds between output chunks. Receiving HTTP headers alone no longer shortens the initial output window.
- Enabled configurable thinking for models that declare support. Chat and desktop decisions respect the preference; desktop decisions receive an appropriate reasoning budget. Model selection from chat is now forwarded to the router. Desktop/composition jobs follow the selected model rather than silently replacing it with unrelated environment tags.
- Fixed NDJSON handling of split UTF-8 and final records without a newline. Malformed and truncated streams surface errors, and readers are cancelled and released. An incomplete Ollama response is not saved as a completed answer.
- Added fixed, read-only network, Bluetooth, audio and system/performance diagnostic plans to Repair. English/Tanglish symptom routing no longer sends ordinary printer questions into repair. Repair conversations persist through the normal owned chat history.
- Validated embedding counts, dimensions and finite values; invalid batch configuration cannot cause an infinite loop. Concurrent first uploads serialize vector writes and preserve both documents. Vector deletion errors propagate before removing the corresponding structured document data. Keyword search remains available when semantic indexing fails.

## Security changes

- Local service URLs reject remote hosts, URL credentials, paths, queries and fragments. Inference/translation requests reject redirects that could carry private prompts or documents elsewhere.
- Discovery and routing reject models identified as cloud/remote proxies, even when Ollama itself runs on loopback.
- API browser access is restricted to the configured frontend, the actual backend origin, and authenticated desktop clients. Host checks reject DNS rebinding destinations.
- `Origin: null` is not treated as desktop authentication: a sandboxed website can have the same opaque origin. Electron generates an independent per-launch client key, passes it through the preload, and attaches it to API requests. Requests from opaque browser origins must supply the matching key before reaching authentication/registration routes. This key is separate from the computer-tool proposal signing secret.
- IPC authority requires the tracked main window and its main frame. Subframes and untracked windows cannot invoke privileged handlers. Media permission requests are scoped to the tracked application window.
- Packaging checks include the new security/repair modules and exclude old source backup copies. Existing approval gates, application permissions and protected Print Spooler runner checks remain enforced.

## Verification

- `node scripts/run-tests.mjs`: **562 tests; 560 passed, 0 failed, 2 skipped**. The two native MSI/MSIX fixture checks were skipped by their existing conditions. Windows native-helper tests run serially to avoid process startup starvation.
- `node scripts/run-electron-tests.mjs`: **9/9 passed**, using real Electron IPC/frame and navigation checks.
- Frontend production compilation to `.tmp/verified-ui`: **passed**. Existing large bundle and browser-externalized Node module warnings remain.
- `node frontend/scripts/validate-repair-package.cjs`: **passed**; protected runner bytes match the pinned digest.
- `git diff --check`: **passed**.
- The existing isolated backend runtime and its native dependency directories are present, and its dependency manifest matches the backend package.

Tests exercise real local HTTP/SQLite/LanceDB and Electron boundaries, with model responses and diagnostic execution simulated where needed. No real printer service mutation or comprehensive third-party application task was executed. This work is not a claim that every application, model response or possible security issue has been certified.

## Rebuild and supported repair scope

The Windows installer was not rebuilt. Run `build-exe.cmd`, or `npm run electron:release -w frontend`, to package these changes. Both the frontend and Electron/backend sources must come from this updated checkout because the API client key crosses all three components. The release validators run against the resulting package.

In Settings → Models, select installed General/Windows models and leave reasoning enabled when wanted. Application permissions still determine which controls can be operated.

The mutating repair capability remains an explicitly approved start of the Print Spooler in a protected installation, followed by verification of service state. Network/Bluetooth/audio/performance plans collect diagnostics and suggest the next step; they do not claim that the user's issue was repaired. Broader autonomous OS repair requires additional typed, approved and verified capabilities.
