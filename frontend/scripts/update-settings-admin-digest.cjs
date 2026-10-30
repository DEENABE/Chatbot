// Recomputes the pinned digest of tools/apps/SystemSettingsAdmin.ps1 (BOM and CRLF/LF differences do not change it).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const apps = path.resolve(__dirname, '..', 'tools', 'apps');
const text = fs
  .readFileSync(path.join(apps, 'SystemSettingsAdmin.ps1'), 'utf8')
  .replace(/^﻿/, '')
  .replace(/\r\n/g, '\n');
const sha = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
fs.writeFileSync(
  path.join(apps, 'SystemSettingsAdminDigest.js'),
  `// Pins the exact SystemSettingsAdmin.ps1 that may run elevated. Regenerate with \`npm run settings:admin-digest\` after any change to
// that script; a test fails while the two disagree and SettingsElevator refuses to elevate a script that does not match.
export const ADMIN_SCRIPT_SHA256 =
  "${sha}";
`,
);
console.log(sha);
