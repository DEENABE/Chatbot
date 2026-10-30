Native desktop behaviours around the chat window: window modes (full, bubble, OCR, toolbar), global shortcut, clipboard watching, wake-word detection and text-to-speech.

**Status:** Implemented; wake word **unverified** (depends on an external detector script resolved by `getWakewordScriptPath()`; failures are only logged)

## Responsibilities
- `managers/WindowManager.js`: create/position the main window, mode switching, avatar bubble sizing
- `managers/ShortcutManager.js`: global show/hide shortcut
- `managers/ClipboardManager.js`: polls clipboard and forwards `clipboard-changed`
- `managers/WakewordManager.js`: spawns the wake-word process and forwards `wakeword-detected`
- `managers/NotificationManager.js`, `services/TextToSpeech.js` (`say` → Windows voices, voice name sanitized), `services/ScreenCapture.js`, `services/FileService.js`
- `utils/crashGuard.js` (GPU-safe mode, crash guard), `utils/windowState.js`, `utils/redactDiagnostics.js`, `utils/logger.js`

## Tech Stack
- Electron `BrowserWindow`, `globalShortcut`, `clipboard`, `desktopCapturer`, `say`
