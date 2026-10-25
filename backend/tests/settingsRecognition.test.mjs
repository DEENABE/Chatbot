// "turn off location" used to be answered with advice ("go to Settings > Location") because the wording was not
// recognised as a Windows setting change, so the General route (no tools) handled it. These tests pin the recognition
// both ways: the loose privacy wordings must be taken, ordinary sentences that merely contain the words must not.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-recognition-'));
process.env.APP_DATA_PATH = dataDir;
const { computerTask, settingsChangeTask, privacySettingCall } =
  await import('../src/orchestrator/ComputerTaskPolicy.js');
test.after(() => {
  try {
    fs.rmSync(dataDir, { recursive: true, force: true });
  } catch {
    /* a temp folder left behind is harmless */
  }
});

const LOCATION = { id: 'location-access' };
const CAMERA = { id: 'camera-access' };
const POSITIVE = [
  ['turn off location', { ...LOCATION, enabled: false }],
  ['Turn Off Location.', { ...LOCATION, enabled: false }],
  ['turn off the location', { ...LOCATION, enabled: false }],
  ['turn location off', { ...LOCATION, enabled: false }],
  ['disable location', { ...LOCATION, enabled: false }],
  ['switch off my location', { ...LOCATION, enabled: false }],
  ['stop location tracking', { ...LOCATION, enabled: false }],
  ['turn off location services', { ...LOCATION, enabled: false }],
  ['please turn off location', { ...LOCATION, enabled: false }],
  ['can you turn off the location please', { ...LOCATION, enabled: false }],
  ['turn off location on my laptop', { ...LOCATION, enabled: false }],
  ['turn on gps', { ...LOCATION, enabled: true }],
  ['turn off gps', { ...LOCATION, enabled: false }],
  ['enable location', { ...LOCATION, enabled: true }],
  ['allow location', { ...LOCATION, enabled: true }],
  ['location off', { ...LOCATION, enabled: false }],
  ['location off pannu', { ...LOCATION, enabled: false }],
  ['location ah off pannu', { ...LOCATION, enabled: false }],
  ['location on pannunga', { ...LOCATION, enabled: true }],
  ['gps off pannu', { ...LOCATION, enabled: false }],
  ['turn off the camera', { ...CAMERA, enabled: false }],
  ['disable camera', { ...CAMERA, enabled: false }],
  ['block camera', { ...CAMERA, enabled: false }],
  ['turn off webcam', { ...CAMERA, enabled: false }],
  ['turn on the webcam', { ...CAMERA, enabled: true }],
  ['turn off camera access', { ...CAMERA, enabled: false }],
  ['camera ah off pannu', { ...CAMERA, enabled: false }],
  ['webcam disable pannu', { ...CAMERA, enabled: false }],
];

test('privacy-switch commands are taken as Windows setting changes with the exact setting and direction', () => {
  for (const [message, params] of POSITIVE) {
    assert.equal(settingsChangeTask(message), true, message);
    const task = computerTask(message);
    assert.equal(task?.requiresSettings, true, message);
    assert.deepEqual(
      task.call,
      { tool: 'systemSettings', action: 'setConfirmed', params },
      message,
    );
  }
});

test('"toggle location" is a setting change but has no direction, so the model reads the current value', () => {
  const task = computerTask('toggle location');
  assert.equal(task?.requiresSettings, true);
  assert.equal(task.call, undefined);
  assert.equal(privacySettingCall('toggle location'), null);
});

test('ordinary sentences that merely contain location / camera / gps are not setting changes', () => {
  for (const message of [
    'set location to Chennai',
    'turn off the camera in zoom',
    'turn off location for chrome',
    'is location on?',
    'how do I turn off location',
    'how to disable camera',
    'what is gps',
    'explain location services',
    'location of the warehouse',
    'show the camera feed',
    'where is my location',
    'camera on the table',
    'enable location based filtering in the report',
    'block the camera angle in the video',
    'which location has the most employees',
    'open location settings',
  ]) {
    assert.equal(settingsChangeTask(message), false, message);
    assert.ok(!computerTask(message)?.requiresSettings, message);
    assert.equal(privacySettingCall(message), null, message);
  }
});

test('the settings that were already recognised keep working and still leave the choice to the model', () => {
  for (const message of ['turn on dark mode', 'set volume to 30', 'turn off bluetooth', 'mute']) {
    const task = computerTask(message);
    assert.equal(task?.requiresSettings, true, message);
    assert.equal(task.call, undefined, message);
  }
});
