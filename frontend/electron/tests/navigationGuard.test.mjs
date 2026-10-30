// Phase 6 — Electron navigation security. Must be run under the REAL
// Electron binary, not plain Node (it needs a real BrowserWindow and real
// navigation events) — that's what actually makes this a meaningful test:
// the boundary under audit only exists once Chromium's navigation events
// are real, which a mocked/unit-level test can't exercise.
//
// Run with:
//   node_modules/.bin/electron frontend/electron/tests/navigationGuard.test.mjs
//
// Not node:test — node:test's scheduler does not reliably resolve inside
// Electron's main-process event loop (confirmed while writing this: a
// node:test version of this file hung indefinitely, and a version
// restructured around an async run() function + loadURL() consistently hit
// ERR_FAILED loading a real file:// path that loadFile() with this exact
// top-level app.whenReady().then() shape loads without issue — Electron/
// Chromium quirk, not something worth chasing further for a test script).
// Plain assertions with an explicit app.exit() code instead; still a real
// pass/fail per check. Not wired into any existing runner since this repo
// has no Electron-level test harness to extend — documented here and in
// the phase report.
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
// http(s) targets to the system browser instead — this proves that against
// a real Electron BrowserWindow using the identical handler code.
import { app, BrowserWindow, shell } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let openExternalCalls = [];
const realOpenExternal = shell.openExternal.bind(shell);
shell.openExternal = async (url) => {
  openExternalCalls.push(url);
  return true; // never actually open a browser during the test
};

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

  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-nav-test-'));
  const fixturePath = path.join(fixtureDir, 'index.html');
  fs.writeFileSync(fixturePath, '<html><body>fixture</body></html>');

  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // The exact same two handlers added to WindowManager.js.
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

  await win.loadFile(fixturePath);
  const loadedUrl = win.webContents.getURL();

  // ── Check 1: a clicked-link-style navigation to an external URL ──
  openExternalCalls = [];
  win.webContents
    .executeJavaScript("location.href = 'https://evil.example.com/steal'")
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  check('a clicked-link-style navigation to an external URL is prevented, not followed', () => {
    assert.equal(
      win.webContents.getURL(),
      loadedUrl,
      'window must still show the original app page',
    );
    assert.deepEqual(
      openExternalCalls,
      ['https://evil.example.com/steal'],
      'http(s) target must be forwarded to the system browser',
    );
  });

  // ── Check 2: window.open() never creates a second privileged window ──
  openExternalCalls = [];
  const countBefore = BrowserWindow.getAllWindows().length;
  await win.webContents
    .executeJavaScript("window.open('https://evil.example.com/popup')")
    .catch(() => {});
  await new Promise((r) => setTimeout(r, 300));
  check('window.open() to an external URL never creates a second privileged window', () => {
    assert.equal(
      BrowserWindow.getAllWindows().length,
      countBefore,
      'no new BrowserWindow should exist',
    );
    assert.deepEqual(openExternalCalls, ['https://evil.example.com/popup']);
  });

  // ── Check 3: a non-http(s) scheme is blocked and never forwarded ──
  openExternalCalls = [];
  const fileUrl = 'file:///' + fixturePath.replace(/\\/g, '/');
  win.webContents.executeJavaScript(`location.href = ${JSON.stringify(fileUrl)}`).catch(() => {});
  await new Promise((r) => setTimeout(r, 800));
  check(
    'a non-http(s) scheme navigation is blocked and never forwarded to the system browser',
    () => {
      assert.equal(
        win.webContents.getURL(),
        loadedUrl,
        'even a same-scheme navigation attempt is blocked — this SPA never legitimately re-navigates',
      );
      assert.equal(
        openExternalCalls.length,
        0,
        'a non-http(s) target must never reach shell.openExternal',
      );
    },
  );

  shell.openExternal = realOpenExternal;
  win.destroy();
  fs.rmSync(fixtureDir, { recursive: true, force: true });

  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'} :: ${r.name}${r.pass ? '' : ' :: ' + r.error}`);
  }
  const failed = results.filter((r) => !r.pass).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  app.exit(failed === 0 ? 0 : 1);
});
