import { createRequire } from 'node:module';

/**
 * Child processes started from this app never get a console window.
 *
 * Our own code passes windowsHide itself. Libraries do not: `say` starts PowerShell (and taskkill) without it, so every
 * spoken reply would flash a console. Node leaves windowsHide off by default, so it is switched on here for every spawn
 * in the main process. An explicit `windowsHide: false` (a GUI program the user asked to open) is kept as it is.
 */
const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hidden = (options) => ({
  windowsHide: true,
  ...(plain(options) ? options : {}),
});

// args[from] is where an options object may sit; when absent one is inserted before any callback.
function inject(args, from) {
  const list = [...args];
  for (let i = from; i < list.length; i++) {
    if (plain(list[i])) {
      list[i] = hidden(list[i]);
      return list;
    }
    if (typeof list[i] === 'function') {
      list.splice(i, 0, hidden());
      return list;
    }
  }
  list.splice(list.length, 0, hidden());
  return list;
}

function wrap(name, optionsAt) {
  const original = childProcess[name];
  if (typeof original !== 'function' || original.__windowsHide) return;
  const wrapped = function (...args) {
    return original.apply(this, inject(args, optionsAt(args)));
  };
  // Keep util.promisify's custom behaviour (execFile/exec resolve {stdout, stderr}).
  for (const key of Reflect.ownKeys(original))
    if (!(key in wrapped) || key === 'length')
      try {
        Object.defineProperty(wrapped, key, Object.getOwnPropertyDescriptor(original, key));
      } catch {
        /* non-configurable built-ins stay as they are */
      }
  wrapped.__windowsHide = true;
  childProcess[name] = wrapped;
}

export function hideChildConsoles() {
  if (process.platform !== 'win32') return;
  const afterCommandAndArgs = (args) => (Array.isArray(args[1]) ? 2 : 1);
  wrap('spawn', afterCommandAndArgs);
  wrap('spawnSync', afterCommandAndArgs);
  wrap('execFile', afterCommandAndArgs);
  wrap('execFileSync', afterCommandAndArgs);
  wrap('exec', () => 1);
  wrap('execSync', () => 1);
}

hideChildConsoles();
