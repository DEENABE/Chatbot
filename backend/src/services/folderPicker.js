import { spawn } from 'node:child_process';
import path from 'node:path';

/**
 * Native Windows folder dialog for the browser (localhost) UI, where Electron's
 * dialog is unavailable. The backend only listens on loopback and the route is
 * authenticated; the dialog runs on this PC and only returns the path the user
 * picked. Connecting/authorizing the workspace stays a separate explicit step.
 */
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Opacity = 0
$owner.Show()
$owner.Activate()
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = 'Choose a project folder for Chanakya AI'
$dialog.ShowNewFolderButton = $true
$result = $dialog.ShowDialog($owner)
$owner.Close()
if ($result -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write('OK:' + $dialog.SelectedPath) } else { [Console]::Out.Write('CANCEL') }
`;

let active = null;

function powershellPath() {
  const systemRoot = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function chooseFolderNative({
  timeoutMs = 5 * 60 * 1000,
  spawnImpl = spawn,
  platform = process.platform,
} = {}) {
  if (platform !== 'win32') return Promise.resolve({ cancelled: true, unsupported: true });
  // Only one dialog at a time; a second click waits for the open one.
  if (active) return active;
  active = new Promise((resolve) => {
    const encoded = Buffer.from(SCRIPT, 'utf16le').toString('base64');
    let out = '';
    let err = '';
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    let child;
    try {
      child = spawnImpl(
        powershellPath(),
        ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false },
      );
    } catch {
      return done({ cancelled: true, error: 'Could not open the Windows folder dialog. Type the folder path instead.' });
    }
    const timer = setTimeout(() => {
      child.kill();
      done({ cancelled: true, error: 'The folder dialog timed out. Type the folder path instead.' });
    }, timeoutMs);
    child.stdout.on('data', (d) => (out += d.toString('utf8')));
    child.stderr.on('data', (d) => (err += d.toString('utf8')));
    child.on('error', () =>
      done({ cancelled: true, error: 'Could not open the Windows folder dialog. Type the folder path instead.' }),
    );
    child.on('close', () => {
      const text = out.trim();
      if (text.startsWith('OK:') && text.length > 3) return done({ cancelled: false, root: text.slice(3) });
      if (text === 'CANCEL') return done({ cancelled: true, root: null });
      done({
        cancelled: true,
        error: `The folder dialog failed${err.trim() ? `: ${err.trim().split(/\r?\n/)[0].slice(0, 200)}` : ''}. Type the folder path instead.`,
      });
    });
  }).finally(() => {
    active = null;
  });
  return active;
}
