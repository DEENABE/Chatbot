import path from 'node:path';
import { execFile, executionContext } from '../ExecutionContext.js';
import { powerShellPath } from '../DesktopRuntime.js';

// Read installed registrations independently of app launchability. Product names
// come from this PC's registry/AppX registrations, never a supported-app list.
export const INVENTORY_SCRIPT = String.raw`
$ErrorActionPreference='Stop';[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$rows=New-Object System.Collections.Generic.List[object];$errors=New-Object System.Collections.Generic.List[string]
foreach($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*','HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*','HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*')){
  try{foreach($item in @(Get-ItemProperty -Path $root -ErrorAction SilentlyContinue)){
    if($item.DisplayName){$rows.Add([pscustomobject]@{id=[string]$item.PSChildName;productId=[string]$item.PSChildName;packageIdentity=[string]$item.PSChildName;name=[string]$item.DisplayName;publisher=[string]$item.Publisher;version=[string]$item.DisplayVersion;source='uninstall_registry';installLocation=[string]$item.InstallLocation})}
    if($rows.Count -ge 5000){break}
  }}catch{$errors.Add('uninstall_registry_unavailable')}
}
try{foreach($item in @(Get-AppxPackage -ErrorAction Stop)){
  $rows.Add([pscustomobject]@{id=[string]$item.Name;productId=[string]$item.Name;packageIdentity=[string]$item.Name;packageFamilyName=[string]$item.PackageFamilyName;name=[string]$item.Name;publisher=[string]$item.Publisher;version=[string]$item.Version;architecture=[string]$item.Architecture;source='appx_registration';installLocation=[string]$item.InstallLocation})
  if($rows.Count -ge 5000){break}
}}catch{$errors.Add('appx_registration_unavailable')}
[pscustomobject]@{entries=$rows.ToArray();errors=$errors.ToArray()}|ConvertTo-Json -Depth 4 -Compress
`;

export async function installedSoftwareInventory({ run } = {}) {
  if (run) return normalizeInventory(await run());
  if (process.platform !== 'win32') return { entries: [], errors: ['windows_required'] };
  const systemRoot = process.env.SystemRoot || 'C:\\Windows';
  const result = await new Promise((resolve, reject) =>
    execFile(
      powerShellPath(),
      ['-NoProfile', '-NonInteractive', '-Command', INVENTORY_SCRIPT],
      {
        windowsHide: true,
        timeout: 30000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        env: {
          ...process.env,
          PSModulePath: path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules'),
        },
        signal: executionContext.getStore()?.signal,
      },
      (error, stdout) =>
        error ? reject(error) : resolve(JSON.parse(stdout.replace(/^\uFEFF/, ''))),
    ),
  );
  return normalizeInventory(result);
}
function normalizeInventory(result) {
  if (!Array.isArray(result?.entries) || result.entries.length > 5000)
    throw new Error('Installed software inventory returned invalid metadata.');
  return {
    entries: result.entries.filter(
      (entry) =>
        entry &&
        typeof entry.name === 'string' &&
        typeof entry.publisher === 'string' &&
        typeof entry.version === 'string',
    ),
    errors: Array.isArray(result.errors) ? result.errors : [],
  };
}
