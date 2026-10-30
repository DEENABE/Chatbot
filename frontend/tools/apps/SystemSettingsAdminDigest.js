// Pins the exact SystemSettingsAdmin.ps1 that may run elevated. Regenerate with `npm run settings:admin-digest` after any change to
// that script; a test fails while the two disagree and SettingsElevator refuses to elevate a script that does not match.
export const ADMIN_SCRIPT_SHA256 =
  '556e95ab0f805a1cbd4e89ce0ef4ee761122b04bbb548e17313e22b238d13d10';
