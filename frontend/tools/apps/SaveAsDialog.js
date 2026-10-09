// Generic "Save As" support for any application that uses the Windows common file dialog (Notepad, Notepad++, Paint,
// WordPad, Office, VS Code, most Win32/WinUI apps). Nothing here is application-specific: the dialog is recognised by the
// stable automation ids Windows gives the common item dialog (1001 = File name edit, 1 = Save/OK button) with a label
// fallback, and success is proven by the file appearing on disk, never by a clicked button.
import path from 'node:path';
import os from 'node:os';

const failure = (code, message = code) => Object.assign(new Error(message), { code });

// Folders the agent never writes into, whatever the user typed.
const PROTECTED = [
  /^[a-z]:\\windows(\\|$)/i,
  /^[a-z]:\\program files( \(x86\))?(\\|$)/i,
  /^[a-z]:\\programdata(\\|$)/i,
  /^[a-z]:\\\$recycle\.bin(\\|$)/i,
  /^[a-z]:\\system volume information(\\|$)/i,
  /^[a-z]:\\recovery(\\|$)/i,
  /\\appdata\\(local|roaming)\\microsoft\\(windows|credentials|protect)(\\|$)/i,
];
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;

/** Absolute, normalised Windows file path that is safe to save to; throws INVALID_SAVE_PATH / PROTECTED_SAVE_PATH. */
export function validateSavePath(input) {
  if (typeof input !== 'string')
    throw failure(
      'INVALID_SAVE_PATH',
      'Provide the full path to save to, for example E:\\notes\\todo.txt.',
    );
  let raw = input
    .trim()
    .replace(/^["']|["']$/g, '')
    .replace(/\//g, '\\');
  if (/^%userprofile%\\/i.test(raw) || /^~\\/.test(raw))
    raw = path.win32.join(os.homedir(), raw.replace(/^(%userprofile%|~)\\/i, ''));
  if (
    !/^[A-Za-z]:\\/.test(raw) ||
    raw.length > 240 ||
    /[\x00-\x1f<>"|?*]/.test(raw) ||
    raw.slice(2).includes(':')
  )
    throw failure('INVALID_SAVE_PATH', 'Provide a full Windows path such as E:\\notes\\todo.txt.');
  if (raw.split('\\').includes('..'))
    throw failure('INVALID_SAVE_PATH', 'Relative segments (..) are not allowed in a save path.');
  const file = path.win32.normalize(raw);
  const name = path.win32.basename(file);
  if (!name || /[. ]$/.test(name) || RESERVED.test(name) || file.endsWith('\\'))
    throw failure('INVALID_SAVE_PATH', 'The save path must end with a file name.');
  if (PROTECTED.some((p) => p.test(file)))
    throw failure('PROTECTED_SAVE_PATH', `Saving into ${path.win32.dirname(file)} is not allowed.`);
  return file;
}

const isEdit = (c) => c?.role === 'Edit';
const isButton = (c) => c?.role === 'Button';
const enabled = (c) => c && c.enabled !== false;
const has = (c, op) => Array.isArray(c?.actions) && c.actions.includes(op);

/** The File name field and Save button of a common file dialog inside this observation, or null. */
export function findSaveDialog(raw, { processId, mainWindowId } = {}) {
  if (!raw?.success || (processId && raw.processId !== processId) || !Array.isArray(raw.controls))
    return null;
  if (mainWindowId && raw.windowId === mainWindowId && !raw.isDialog) return null;
  const controls = raw.controls.filter((c) => c.provider !== 'VISION');
  const field =
    controls.find((c) => isEdit(c) && enabled(c) && c.automationId === '1001') ||
    controls.find(
      (c) => isEdit(c) && enabled(c) && /^file\s*name\s*:?$/i.test(String(c.label || '').trim()),
    );
  const button =
    controls.find((c) => isButton(c) && enabled(c) && c.automationId === '1' && has(c, 'invoke')) ||
    controls.find(
      (c) =>
        isButton(c) &&
        enabled(c) &&
        has(c, 'invoke') &&
        /^&?save$/i.test(String(c.label || '').trim()),
    );
  return field && button ? { raw, field, button } : null;
}

/** "Confirm Save As – file already exists. Replace?" task dialog: its Yes/No buttons, or null. */
export function findReplacePrompt(raw, { processId } = {}) {
  if (!raw?.success || (processId && raw.processId !== processId) || !Array.isArray(raw.controls))
    return null;
  const buttons = raw.controls.filter((c) => isButton(c) && enabled(c) && has(c, 'invoke'));
  const yes =
    buttons.find((c) => c.automationId === 'CommandButton_6') ||
    buttons.find((c) => /^&?yes$/i.test(String(c.label || '').trim()));
  const no =
    buttons.find((c) => c.automationId === 'CommandButton_7') ||
    buttons.find((c) => /^&?no$/i.test(String(c.label || '').trim()));
  const text = raw.controls.map((c) => `${c.label || ''} ${c.text || ''}`).join(' ');
  return yes && no && /already exists|replace|overwrite/i.test(text + ' ' + (raw.windowTitle || ''))
    ? { yes, no }
    : null;
}

/** Any other modal message in the dialog family (e.g. "Path does not exist", "Access denied"): its visible text, or null. */
export function dialogMessage(raw, { processId, mainWindowId } = {}) {
  if (!raw?.success || (processId && raw.processId !== processId) || raw.windowId === mainWindowId)
    return null;
  if (findSaveDialog(raw, { processId }) || findReplacePrompt(raw, { processId })) return null;
  const text = (raw.controls || [])
    .filter((c) => ['Text', 'Pane', 'Document'].includes(c.role) && c.label)
    .map((c) => c.label)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, 300) : null;
}

/** Files the save may have produced: the exact path, or the path plus an extension the app appended (Notepad adds .txt). */
export function savedCandidates(file, entries) {
  const dir = path.win32.dirname(file),
    base = path.win32.basename(file).toLowerCase();
  const out = [file];
  if (!path.win32.extname(base))
    for (const e of entries || [])
      if (e.toLowerCase().startsWith(base + '.') && e.length - base.length <= 6)
        out.push(path.win32.join(dir, e));
  return out;
}
