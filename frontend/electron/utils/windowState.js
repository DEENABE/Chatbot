import fs from 'fs';
import path from 'path';
import { app } from 'electron';

const FILE_NAME = 'window-state.json';

function statePath() {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * The windowed (compact) chat bounds the user last left the app at, or null
 * when nothing usable is stored. Anything malformed is ignored rather than
 * trusted, so a hand-edited or truncated file can never size the window.
 */
export function loadCompactBounds() {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(), 'utf8'));
    const bounds = parsed?.compact;
    if (
      bounds &&
      [bounds.x, bounds.y, bounds.width, bounds.height].every(isFiniteNumber) &&
      bounds.width > 0 &&
      bounds.height > 0
    ) {
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    }
  } catch {
    // First run or unreadable file — fall back to the default size.
  }
  return null;
}

export function saveCompactBounds(bounds) {
  if (!bounds) return;
  try {
    fs.writeFileSync(
      statePath(),
      JSON.stringify({
        compact: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
      }),
    );
  } catch {
    // Losing the remembered size is harmless; never fail a window change over it.
  }
}
