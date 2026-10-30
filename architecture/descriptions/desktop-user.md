The person running Chanakya AI on their own Windows PC; they sign in with a local account and are the only one who can approve system-changing actions.

**Status:** Implemented

## Responsibilities
- Register / log in with a local username + password (no cloud identity provider)
- Chat, attach files, index folders as workspaces, run coding tasks, request translations
- Approve or reject every `DANGEROUS` tool action (service start, process launch, file delete, installs) in the confirmation modal
- Users with `role = 'Admin'` (set only by direct DB write) can additionally read repair sessions and export the repair dataset (`GET /api/repair/sessions`, `/api/repair/dataset`)

## Tech Stack
- Interacts through the Electron desktop window, floating avatar bubble, voice input and global shortcuts
