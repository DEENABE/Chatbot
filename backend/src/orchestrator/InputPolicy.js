// Keyboard input policy for the generic desktop agent. The model proposes a chord as text; only this module decides
// whether it is a known key, and how risky it is. Nothing here is ever passed to a shell.
//
//   SAFE_WRITE  - navigation, search/find, selection and text editing inside a text field
//   DANGEROUS   - anything that may change data or trigger an action (save, delete, enter on a button, paste, close...)
//   CRITICAL    - refused at every permission level (system shortcuts, Windows key, window closing by Alt+F4...)
export const TEXT_ROLES = new Set(['Edit', 'Document', 'ComboBox']);
const MODIFIERS = new Map([['ctrl', 'ctrl'], ['control', 'ctrl'], ['shift', 'shift'], ['alt', 'alt']]);
const NAMED = new Map([['esc', 'escape'], ['escape', 'escape'], ['enter', 'enter'], ['return', 'enter'], ['tab', 'tab'], ['space', 'space'], ['backspace', 'backspace'],
  ['delete', 'delete'], ['del', 'delete'], ['up', 'up'], ['down', 'down'], ['left', 'left'], ['right', 'right'], ['home', 'home'], ['end', 'end'],
  ['pageup', 'pageup'], ['pagedown', 'pagedown'], ['pgup', 'pageup'], ['pgdn', 'pagedown']]);
const FORBIDDEN_NAMES = new Set(['win', 'windows', 'meta', 'cmd', 'super', 'printscreen', 'prtsc']);
const isKeyName = k => /^[a-z0-9]$/.test(k) || /^f([1-9]|1[0-2])$/.test(k) || [...NAMED.values()].includes(k);

/** "Ctrl + Shift + F" -> {mods:['ctrl','shift'], key:'f', text:'ctrl+shift+f'}; null when it is not one known, well-formed chord. */
export function parseChord(input) {
  if (typeof input !== 'string' || !input.trim() || input.length > 40) return null;
  const parts = input.toLowerCase().split('+').map(p => p.trim());
  if (parts.some(p => !p)) return null;
  const mods = new Set();let key = null;
  for (const part of parts) {
    if (MODIFIERS.has(part)) { mods.add(MODIFIERS.get(part)); continue; }
    if (FORBIDDEN_NAMES.has(part)) return { forbidden: true, mods: [], key: part, text: part };
    const name = NAMED.get(part) || part;
    if (!isKeyName(name) || key) return null;
    key = name;
  }
  if (!key) return null;
  const ordered = ['ctrl', 'alt', 'shift'].filter(m => mods.has(m));
  return { mods: ordered, key, text: [...ordered, key].join('+') };
}

const NAVIGATION = new Set(['up', 'down', 'left', 'right', 'home', 'end', 'pageup', 'pagedown', 'tab', 'escape']);
// Ctrl+<letter> combinations that only search, navigate or select/copy.
const SAFE_CTRL = new Set(['f', 'h', 'g', 'l', 'a', 'c', 'home', 'end', 'left', 'right', 'up', 'down', 'tab', 'pageup', 'pagedown']);
const TEXT_EDIT_KEYS = new Set(['backspace', 'delete', 'enter', 'space']);

/** Risk class of a parsed chord given the role of the focused control ('' when unknown). */
export function chordRisk(chord, focusedRole = '') {
  if (!chord || chord.forbidden) return 'CRITICAL';
  const { mods, key } = chord, has = m => mods.includes(m);
  // Window/session level shortcuts are never automated.
  if (has('alt') && key === 'f4') return 'CRITICAL';
  if (has('alt') && (key === 'tab' || key === 'escape')) return 'CRITICAL';
  if (has('ctrl') && has('alt') && key === 'delete') return 'CRITICAL';
  if (has('ctrl') && has('shift') && key === 'escape') return 'CRITICAL';
  if (has('ctrl') && key === 'escape') return 'CRITICAL';
  const inText = TEXT_ROLES.has(focusedRole);
  if (!has('ctrl') && !has('alt')) {
    if (NAVIGATION.has(key)) return 'SAFE_WRITE';
    if (/^f3$/.test(key)) return 'SAFE_WRITE';
    // Editing keys are ordinary text entry inside a text field, but activate or delete things anywhere else.
    if (TEXT_EDIT_KEYS.has(key)) return inText && !has('shift') ? 'SAFE_WRITE' : 'DANGEROUS';
    if (/^[a-z0-9]$/.test(key)) return inText ? 'SAFE_WRITE' : 'DANGEROUS';
    return 'DANGEROUS';
  }
  if (has('ctrl') && !has('alt') && SAFE_CTRL.has(key)) return 'SAFE_WRITE';
  if (has('ctrl') && !has('alt') && key === 'f3') return 'SAFE_WRITE';
  return 'DANGEROUS';
}

/** Text typed into a focused field: bounded, single line, no control characters (Enter/Tab are keys, not text). */
export function validTypedText(text) {
  return typeof text === 'string' && text.length >= 1 && text.length <= 500 && !/[\x00-\x1f\x7f]/.test(text);
}

export const KEY_GUIDE = Object.freeze({
  safe: 'arrows, Home/End, PageUp/PageDown, Tab, Escape, F3, Ctrl+F/H/G/L/A/C, and editing keys inside a text field',
  needsConfirmation: 'Ctrl+S/N/O/P/Z/Y/V/X/W, Delete, Enter or Space outside a text field, letters outside a text field, other function keys',
  refused: 'Windows key, Alt+F4, Alt+Tab, Ctrl+Alt+Delete, Ctrl+Shift+Esc, Ctrl+Esc, Print Screen',
});
