Internet software catalogues the software-installation agent searches when the user asks to find or install an application — the only outbound internet dependency of the app.

**Status:** Implemented, opt-in per request (the renderer's `softwareAPI.discover(query, online)` defaults to `online = false`)

## Responsibilities
- winget package index (`cdn.winget.microsoft.com`) and Microsoft Store listings (`apps.microsoft.com`) for discovery/metadata
- Web search fallback (`html.duckduckgo.com`) used by the web-install provider to locate vendor installers
- Every install is a `DANGEROUS` action that requires an explicit confirmation; offline installers picked from disk are also supported

## Tech Stack
- `frontend/tools/software/providers/` (Winget, Metadata, Offline providers), `frontend/tools/services/WingetService.js`, `WebInstallService.js`
