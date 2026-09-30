import { trustedSystemCapability } from './WindowsSystemCapabilityRegistry.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export const sources = new Set(['start_menu','app_paths','uninstall','msix','path','running','shell_apps','install_roots']);
const blocked = /^(?:cmd|powershell(?:_ise)?|pwsh|wscript|cscript|mshta|rundll32|regsvr32|msiexec|regedit|mmc|taskkill|shutdown|mimikatz|procdump|python\d*|pythonw|node|git|bash|wsl|wt|msconfig|recoverydrive|dfrgui|iscsicpl|mdsched|install.*|unins.*|setup.*)$/i;
const inTemp = p => [os.tmpdir(),process.env.TEMP,process.env.TMP].filter(Boolean).some(root=>{
  const relative=path.win32.relative(root,p);return relative===''||(!relative.startsWith('..')&&!path.win32.isAbsolute(relative));
});
export function validateTarget(app, exists = fs.existsSync) {
  if (trustedSystemCapability(app)) { if (!exists(app.executablePath) || app.source==='windows_management'&&!exists(app.launchArgs[0])) throw new Error('APP_TARGET_MISSING'); return; }
  if (!app || !sources.has(app.source) || app.available !== true) throw new Error('APP_UNSAFE_TARGET');
  if (!Array.isArray(app.launchArgs) || app.launchArgs.length) throw new Error('APP_UNSAFE_ARGUMENTS');
  if (app.launchType === 'app_user_model_id') {
    if (!/^[A-Za-z0-9._-]+![A-Za-z0-9._-]+$/.test(app.appUserModelId || '')) throw new Error('APP_UNSAFE_TARGET');
    if (/WindowsTerminal|DesktopAppInstaller/i.test(app.appUserModelId)) throw new Error('APP_UNSAFE_TARGET');
    return;
  }
  const p = app.executablePath;
  if (app.launchType !== 'executable' || typeof p !== 'string' || !/^[A-Za-z]:\\/.test(p) || /[\x00-\x1f"<>|]/.test(p) || p.slice(2).includes(':') || p.split(/[\\/]/).includes('..') || path.win32.extname(p).toLowerCase() !== '.exe') throw new Error('APP_UNSAFE_TARGET');
  if (inTemp(p) || /(?:^|[\\/])(?:temp|tmp|package cache)(?:[\\/]|$)/i.test(p) || blocked.test(path.win32.basename(p).replace(/\.exe$/i,''))) throw new Error('APP_UNSAFE_TARGET');
  if (!exists(p)) throw new Error('APP_TARGET_MISSING');
  // Resolve junctions/symlinks before applying the location policy again.
  if (exists === fs.existsSync) {
    const real = fs.realpathSync(p);
    if (!/^[A-Za-z]:\\/.test(real) || inTemp(real) || /(?:^|[\\/])(?:temp|tmp|package cache)(?:[\\/]|$)/i.test(real) || blocked.test(path.win32.basename(real).replace(/\.exe$/i,''))) throw new Error('APP_UNSAFE_TARGET');
    if (!fs.statSync(real).isFile()) throw new Error('APP_UNSAFE_TARGET');
  }
}
