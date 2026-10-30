import test from 'node:test';
import assert from 'node:assert/strict';
import { GenericDesktopService } from '../services/GenericDesktopService.js';
import { digest } from '../apps/SemanticUI.js';

/**
 * A Windows 11 Notepad-like Save As dialog:
 *  - a UIA SetValue changes the box text but the dialog ignores it and saves its own
 *    suggestion ("deena.txt") in its last folder (Documents);
 *  - typed keystrokes are taken;
 *  - while the dialog opens, one observation reports WINDOW_NOT_FOUND.
 */
function notepad({ transientMisses = 1 } = {}) {
  const disk = new Map();
  const state = {
    dialog: false,
    text: '',
    typed: false,
    misses: transientMisses,
    title: 'deena - Notepad',
  };
  const fail = (code) => Object.assign(new Error(code), { code });
  const raw = () =>
    state.dialog
      ? {
          success: true,
          processId: 10,
          windowId: 20,
          isDialog: true,
          windowTitle: 'Save as',
          controls: [
            {
              role: 'Edit',
              automationId: '1001',
              locator: 'name',
              signature: 'name',
              label: 'File name:',
              actions: ['focus', 'setValue'],
              valueHash: digest(state.text),
              focused: true,
            },
            {
              role: 'Button',
              automationId: '1',
              locator: 'save',
              label: 'Save',
              actions: ['invoke'],
            },
          ],
        }
      : { success: true, processId: 10, windowId: 1, windowTitle: state.title, controls: [] };
  const submit = () => {
    const target = state.typed ? state.text : 'C:\\Users\\me\\Documents\\deena.txt';
    disk.set(target.toLowerCase(), { size: 5, mtimeMs: Date.now() });
    state.title = `${target.split('\\').at(-1)} - Notepad`;
    state.dialog = false;
  };
  const reader = async (input) => {
    if (input.action === 'observe') {
      if (state.dialog && state.misses-- > 0) throw fail('WINDOW_NOT_FOUND');
      return raw();
    }
    if (input.action === 'input' && input.kind === 'key') {
      if (input.payload === 'ctrl+shift+s') state.dialog = true;
      if (input.payload === 'ctrl+a') state.text = '';
      if (input.payload === 'enter' && state.dialog) submit();
      return { success: true };
    }
    if (input.action === 'input' && input.kind === 'type') {
      state.text = input.payload;
      state.typed = true;
      return raw();
    }
    if (input.action === 'act') {
      if (input.operation === 'setValue') state.text = input.value;
      if (input.operation === 'invoke' && input.locator === 'save') submit();
      return raw();
    }
    throw new Error(`unexpected ${JSON.stringify(input)}`);
  };
  const missing = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  const files = {
    stat: async (p) => {
      if (/^[A-Z]:\\?$/i.test(p)) return { isFile: () => false, isDirectory: () => true };
      const hit = disk.get(p.toLowerCase());
      if (!hit) throw missing();
      return { isFile: () => true, isDirectory: () => false, ...hit };
    },
    mkdir: async () => {},
    readdir: async (dir) =>
      [...disk.keys()]
        .filter((p) => p.startsWith(`${dir.toLowerCase().replace(/\\$/, '')}\\`))
        .map((p) => p.split('\\').at(-1)),
  };
  const service = new GenericDesktopService(null, null, null, {
    reader,
    files,
    permissions: { levelFor: () => 'modify' },
  });
  const record = {
    app: { name: 'Notepad', executablePath: 'C:\\Windows\\notepad.exe' },
    raw: { processId: 10, windowId: 1, rootWindowId: 1 },
    query: 'notepad',
  };
  service.record = () => record;
  service.assertPermitted = () => {};
  service.save = () => ({ snapshot: null });
  return { service, disk, state };
}

test('Save As types the requested location instead of relying on SetValue', async () => {
  const { service, disk } = notepad();
  const result = await service.saveAs({ snapshotId: 's', path: 'D:\\sample.txt' });
  assert.equal(result.status, 'FILE_SAVED');
  assert.equal(result.path.toLowerCase(), 'd:\\sample.txt');
  assert.ok(disk.has('d:\\sample.txt'));
  assert.ok(!disk.has('c:\\users\\me\\documents\\deena.txt'), 'nothing went to Documents');
});

test('a transient WINDOW_NOT_FOUND while the dialog opens is not a failure', async () => {
  const { service } = notepad({ transientMisses: 3 });
  const result = await service.saveAs({ snapshotId: 's', path: 'D:\\notes\\sample.txt' });
  assert.equal(result.status, 'FILE_SAVED');
});
