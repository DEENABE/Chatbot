// Phase 6 — Electron navigation security. Must be run under the REAL
// Electron binary, not plain Node (it needs a real BrowserWindow and real
// navigation events) — that's what actually makes this a meaningful test:
// the boundary under audit only exists once Chromium's navigation events
// are real, which a mocked/unit-level test can't exercise.
//
// Run with:
//   node_modules/.bin/electron frontend/electron/tests/navigationGuard.test.mjs
//
// Not wired into `node --test` (which cannot load the `electron` module at
// all outside the Electron runtime) or any npm script, since this repo has
// no existing Electron-level test runner to extend — documented here and
// in the phase report instead of inventing a new one.
//
// Finding under test: this SPA never legitimately navigates its own window
// after the initial load. Chat replies render through ReactMarkdown with no
// link interception, so a link in an LLM response — including one echoed
// from injected RAG/document content (Phase 5's threat model) — is the
// realistic trigger for an unsolicited top-level navigation. Left
// unhandled, Electron's default lets that navigate the *same*, privileged
// BrowserWindow, and the preload script (window.toolEngine, window.
// sessionAPI — the live session token, Phase 4's PowerShell/CMD/file/
// registry tools) is re-injected on whatever loads next. WindowManager.js
// now prevents all in-window navigation and window.open(), redirecting
// http(s) targets to the system browser instead — this test proves that
// against a real Electron BrowserWindow using the identical handler code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { app, BrowserWindow, shell } from 'electron';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function installGuards(win, calls) {
  const realOpenExternal = shell.openExternal.bind(shell);
  shell.openExternal = async (url) => {
    calls.push(url);
    return true; // never actually open a browser during the test
  };
  win.webContents.on('will-navigate', (event, navigationUrl) => {
    event.preventDefault();
    if (/^https?:\/\//i.test(navigationUrl)) {
      shell.openExternal(navigationUrl).catch(() => {});
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      shell.openExternal(url).catch(() => {});
    }
    return { action: 'deny' };
  });
  return () => { shell.openExternal = realOpenExternal; };
}

await app.whenReady();

const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-nav-test-'));
const fixturePath = path.join(fixtureDir, 'index.html');
fs.writeFileSync(fixturePath, '<html><body>fixture</body></html>');

test('a top-level navigation to an external URL (e.g. a clicked chat-markdown link) is prevented, not followed', async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const calls = [];
  const restore = installGuards(win, calls);
  try {
    await win.loadFile(fixturePath);
    const before = win.webContents.getURL();

    await win.webContents.executeJavaScript("location.href = 'https://evil.example.com/steal'").catch(() => {});
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(win.webContents.getURL(), before, 'the window must still be showing the original app page, not the attacker URL');
    assert.deepEqual(calls, ['https://evil.example.com/steal'], 'the http(s) target must be handed to the system browser instead');
  } finally {
    restore();
    win.destroy();
  }
});

test('window.open() to an external URL never creates a second privileged window', async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const calls = [];
  const restore = installGuards(win, calls);
  try {
    await win.loadFile(fixturePath);
    const countBefore = BrowserWindow.getAllWindows().length;

    await win.webContents.executeJavaScript("window.open('https://evil.example.com/popup')").catch(() => {});
    await new Promise((r) => setTimeout(r, 300));

    assert.equal(BrowserWindow.getAllWindows().length, countBefore, 'no new BrowserWindow should have been created');
    assert.deepEqual(calls, ['https://evil.example.com/popup']);
  } finally {
    restore();
    win.destroy();
  }
});

test('a non-http(s) scheme (e.g. a crafted file:// or javascript: target) is prevented and never forwarded to the system browser', async () => {
  const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true } });
  const calls = [];
  const restore = installGuards(win, calls);
  try {
    await win.loadFile(fixturePath);
    const before = win.webContents.getURL();

    await win.webContents.executeJavaScript(`location.href = 'file:///${fixturePath.replace(/\\/g, '/')}'`).catch(() => {});
    await new Promise((r) => setTimeout(r, 500));

    assert.equal(win.webContents.getURL(), before, 'even a same-scheme navigation attempt is blocked — this SPA never legitimately re-navigates');
    assert.equal(calls.length, 0, 'a non-http(s) target must never be forwarded to shell.openExternal');
  } finally {
    restore();
    win.destroy();
  }
});

test.after(() => {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
  app.exit(0);
});
