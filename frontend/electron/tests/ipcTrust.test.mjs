// Phase 9 — IPC sender validation. Real Electron runtime (see
// navigationGuard.test.mjs for why: node:test's scheduler doesn't reliably
// resolve inside Electron's main-process event loop). Run with:
//   node_modules/.bin/electron frontend/electron/tests/ipcTrust.test.mjs
//
// isTrustedSender() runs inside ipcMain.handle callbacks, comparing
// event.sender (a real WebContents, supplied by Electron itself — never
// renderer-controlled) against WindowManager's tracked window. Uses the
// real WindowManager.createWindow() (not a monkey-patched stand-in — ESM
// namespace exports are read-only, so getMainWindow can't be reassigned
// from outside the module anyway) so "the tracked window" in this test is
// genuinely the same object production code would see.
import { app, BrowserWindow } from 'electron';
import assert from 'node:assert/strict';
import * as WindowManager from '../managers/WindowManager.js';
import { isTrustedSender, requireTrustedSender } from '../utils/ipcTrust.js';

app.whenReady().then(async () => {
  const results = [];
  function check(name, fn) {
    try {
      fn();
      results.push({ name, pass: true });
    } catch (err) {
      results.push({ name, pass: false, error: err.message });
    }
  }

  // The real production window — createWindow() sets WindowManager's
  // internal tracked window, which getMainWindow()/isTrustedSender rely on.
  const trustedWindow = WindowManager.createWindow();
  // A second, structurally identical window WindowManager never tracked.
  const otherWindow = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  check("the tracked window's own webContents is recognized as trusted", () => {
    assert.equal(isTrustedSender({ sender: trustedWindow.webContents }), true);
  });

  check("a second, real but untracked window's webContents is not trusted", () => {
    assert.equal(isTrustedSender({ sender: otherWindow.webContents }), false);
  });

  check('requireTrustedSender lets the real handler run for the trusted sender', () => {
    const handler = requireTrustedSender((event) => ({
      ran: true,
      sender: event.sender,
    }));
    const result = handler({ sender: trustedWindow.webContents });
    assert.equal(result.ran, true);
  });

  check('requireTrustedSender refuses to run the handler for an untrusted sender', () => {
    let handlerRan = false;
    const handler = requireTrustedSender(() => {
      handlerRan = true;
      return { ran: true };
    });
    const result = handler({ sender: otherWindow.webContents });
    assert.equal(
      handlerRan,
      false,
      'the wrapped handler must never execute for an untrusted sender',
    );
    assert.equal(result.success, false);
    assert.equal(result.error.code, 'UNTRUSTED_SENDER');
  });

  check('a destroyed tracked window is never treated as trusted', () => {
    const sender = trustedWindow.webContents;
    trustedWindow.destroy();
    assert.equal(isTrustedSender({ sender }), false);
  });

  otherWindow.destroy();

  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'} :: ${r.name}${r.pass ? '' : ' :: ' + r.error}`);
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  app.exit(failed === 0 ? 0 : 1);
});
