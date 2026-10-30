// Window layout modes — full screen, windowed (compact) and bubble.
// Must run under the real Electron binary (it needs a real BrowserWindow and
// real display metrics):
//   node_modules/electron/dist/electron.exe frontend/electron/tests/windowModes.test.mjs
// Plain assertions with an explicit app.exit() code, like the other Electron
// tests in this folder.
import { app, screen } from 'electron';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'chanakya-window-test-'));
app.setPath('userData', userData);

app.whenReady().then(async () => {
  const results = [];
  const check = async (name, fn) => {
    try {
      await fn();
      results.push({ name, pass: true });
    } catch (err) {
      results.push({ name, pass: false, error: err.message });
    }
  };

  const WM = await import('../managers/WindowManager.js');
  const win = WM.createWindow();
  const area = screen.getPrimaryDisplay().workArea;
  const sameBounds = (actual, expected) =>
    assert.deepEqual(
      { x: actual.x, y: actual.y, width: actual.width, height: actual.height },
      { x: expected.x, y: expected.y, width: expected.width, height: expected.height },
    );

  await check('the app launches as the 80px corner bubble', () => {
    assert.equal(WM.getWindowMode(), 'bubble');
    const { width, height } = win.getBounds();
    assert.equal(width, 80);
    assert.equal(height, 80);
    assert.equal(win.isResizable(), false);
  });

  await check('full screen fills the work area and is not resizable', () => {
    assert.equal(WM.setWindowMode('full'), 'full');
    sameBounds(win.getBounds(), area);
    assert.equal(win.isResizable(), false);
  });

  await check('windowed mode uses the default chat size on first use', () => {
    assert.equal(WM.setWindowMode('compact'), 'compact');
    const { width, height } = win.getBounds();
    assert.equal(width, 420);
    assert.equal(height, 680);
  });

  await check('a resize in windowed mode is applied', () => {
    assert.equal(WM.resizeWindow(640, 720), true);
    const { width, height } = win.getBounds();
    assert.equal(width, 640);
    assert.equal(height, 720);
  });

  await check('switching to full screen and back keeps the windowed size', () => {
    WM.setWindowMode('full');
    sameBounds(win.getBounds(), area);
    WM.setWindowMode('compact');
    const { width, height } = win.getBounds();
    assert.equal(width, 640);
    assert.equal(height, 720);
  });

  await check('full screen ignores resize requests', () => {
    WM.setWindowMode('full');
    assert.equal(WM.resizeWindow(500, 500), false);
    sameBounds(win.getBounds(), area);
  });

  await check('the bubble collapses to 80px and reopens in the last used mode', () => {
    WM.setWindowMode('compact');
    WM.setWindowMode('bubble');
    const { width, height } = win.getBounds();
    assert.equal(width, 80);
    assert.equal(height, 80);
    assert.equal(WM.toggleExpand(true), true);
    assert.equal(WM.getWindowMode(), 'compact');
    assert.equal(win.getBounds().width, 640);
  });

  await check('an unknown mode is rejected without changing the window', () => {
    assert.equal(WM.setWindowMode('maximised'), 'compact');
  });

  await check('minimize keeps the mode so restore returns the same layout', () => {
    assert.equal(WM.minimizeWindow(), true);
    assert.equal(WM.getWindowMode(), 'compact');
    win.restore();
  });

  await check('the windowed size is saved when the window closes', async () => {
    win.close();
    const saved = JSON.parse(fs.readFileSync(path.join(userData, 'window-state.json'), 'utf8'));
    assert.equal(saved.compact.width, 640);
    assert.equal(saved.compact.height, 720);
  });

  for (const r of results) {
    console.log(`${r.pass ? 'PASS' : 'FAIL'} :: ${r.name}${r.error ? ` — ${r.error}` : ''}`);
  }
  const passed = results.filter((r) => r.pass).length;
  console.log(`\n${passed}/${results.length} passed`);
  app.exit(passed === results.length ? 0 : 1);
});
