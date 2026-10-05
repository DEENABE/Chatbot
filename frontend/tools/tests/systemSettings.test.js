import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ToolEngineRouter } from '../ToolEngineRouter.js';
import { ExecutionLedger } from '../ExecutionLedger.js';
import { SystemSettingsService } from '../services/SystemSettingsService.js';
import { SETTINGS, SETTING_IDS, SOURCES, planChange, matches } from '../apps/SystemSettingsCatalog.js';
import { DESKTOP_HELPERS, OPTIONAL_HELPERS, helperScriptPath } from '../DesktopRuntime.js';
import { desktopCapabilityDiagnostics } from '../DesktopCapabilityDiagnostics.js';
import { modelPolicy } from '../repair/contract.js';
import { SETTING_IDS as CONTRACT_IDS, SETTING_LIMITS as CONTRACT_LIMITS, SETTING_OPTIONS as CONTRACT_OPTIONS, SETTING_FORBIDDEN as CONTRACT_FORBIDDEN, SETTING_PER_SOURCE as CONTRACT_PER_SOURCE, validateCapability, verificationPredicates } from '../../../backend/src/orchestrator/CapabilityContracts.js';
import { computerTask, settingsChangeTask, executionOnlyReply } from '../../../backend/src/orchestrator/ComputerTaskPolicy.js';

/** Fake Windows: an in-memory store with the same request/response shape as SystemSettings.ps1. */
function fakeWindows(initial = {}, { unavailable = [], stuck = [] } = {}) {
  const state = {
    'dark-mode': true, brightness: 69, volume: 100, mute: false, 'mic-mute': false, transparency: true, 'file-extensions': true, 'hidden-files': true,
    notifications: true, 'clipboard-history': false, 'screen-timeout': 5, 'sleep-timeout': 15, 'mouse-speed': 10, 'mic-volume': 32, 'pointer-precision': true,
    'scroll-lines': 3, 'double-click-speed': 500, 'keyboard-repeat-rate': 31, 'power-mode': 'balanced', 'airplane-mode': false,
    'lid-close-action': 'sleep', 'power-button-action': 'sleep', 'mouse-primary-button': 'left', 'cursor-blink-rate': 530, 'clock-24-hour': true,
    'hibernate-timeout': 180, 'disk-timeout': 20, 'lock-screen-timeout': 1, 'pointer-trails': 0, 'keyboard-repeat-delay': 1, 'menu-show-delay': 400,
    animations: true, 'drag-window-contents': true, 'snap-to-default-button': false, 'hide-pointer-while-typing': true, 'pointer-location-on-ctrl': false,
    'usb-selective-suspend': true, 'dim-timeout': 10, 'max-processor-state': 100, 'battery-saver-threshold': 30, 'wake-timers': 'important-only', 'cooling-policy': 'active',
    wifi: true, bluetooth: true, ...initial,
  };
  // Power-plan settings keep a separate on-battery value (state holds the plugged-in one, like the helper's "value").
  const perSource = new Set(SETTINGS.filter(x => x.perSource).map(x => x.id));
  const batteryOnly = new Set(SETTINGS.filter(x => x.batteryOnly).map(x => x.id));
  const battery = { ...state, 'screen-timeout': 3, 'sleep-timeout': 10, 'dim-timeout': 5, 'disk-timeout': 10, 'wake-timers': 'disabled', 'cooling-policy': 'passive' };
  const power = id => perSource.has(id) || batteryOnly.has(id);
  const reading = id => ({ value: batteryOnly.has(id) ? battery[id] : state[id], ...(power(id) ? { pluggedIn: state[id], onBattery: battery[id] } : {}) });
  const calls = [];
  const reader = async input => {
    calls.push(input);
    if (unavailable.includes(input.id)) throw Object.assign(new Error('No Bluetooth radio was found on this PC.'), { code: 'SETTING_UNAVAILABLE' });
    if (input.action === 'list') return { success: true, settings: SETTING_IDS.map(id => unavailable.includes(id) ? { id, available: false, reason: 'No radio.' } : { id, available: true, ...reading(id) }) };
    if (input.action === 'get') return { success: true, id: input.id, ...reading(input.id) };
    const id = input.id, source = input.source ?? 'both';
    if (!power(id)) {
      const previous = state[id];
      if (!stuck.includes(id)) state[id] = input.value; // "stuck": Windows ignores the change
      return { success: true, id, previous, requested: input.value, value: state[id] };
    }
    const before = { pluggedIn: state[id], onBattery: battery[id] };
    if (!stuck.includes(id)) {
      if (batteryOnly.has(id) || source !== 'plugged-in') battery[id] = input.value;
      if (!batteryOnly.has(id) && source !== 'battery') state[id] = input.value;
    }
    const side = batteryOnly.has(id) || source === 'battery' ? 'onBattery' : 'pluggedIn';
    return { success: true, id, source, previous: before[side], requested: input.value, value: side === 'onBattery' ? battery[id] : state[id], pluggedIn: state[id], onBattery: battery[id], before };
  };
  return { state, battery, calls, reader, sets: () => calls.filter(c => c.action === 'set') };
}

function fixture(t, windows = fakeWindows()) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const router = new ToolEngineRouter({ pathOptions: { readRoots: [root], writeRoots: [root] } });
  router.services.set('systemSettings', new SystemSettingsService(router.gate, null, { reader: windows.reader }));
  const ledger = new ExecutionLedger({ dispatch: r => router.dispatch(r) });
  ledger.toolRegistry = router.registry;
  let n = 0;
  const call = (tool, action, params = {}, trusted = {}) => ledger.execute('backend:alice', { tool, action, params, toolCallId: 'task-1', requestId: `req-${++n}`, idempotencyKey: `key-${n}` }, null, { origin: 'model', ...trusted });
  const approve = id => call('_system', 'confirm', { confirmationId: id }, { humanApproved: true });
  return { router, windows, call, approve };
}

test('catalog, helper script, backend contract and model policy stay in sync', () => {
  assert.deepEqual(CONTRACT_IDS, SETTING_IDS, 'backend CapabilityContracts SETTING_IDS drifted from the catalog');
  assert.deepEqual(CONTRACT_LIMITS, Object.fromEntries(SETTINGS.filter(s => s.type === 'percent' || s.type === 'number').map(s => [s.id, [s.min, s.max]])), 'backend SETTING_LIMITS drifted from the catalog');
  assert.deepEqual(CONTRACT_OPTIONS, Object.fromEntries(SETTINGS.filter(s => s.type === 'choice').map(s => [s.id, s.options.map(o => o.id)])), 'backend SETTING_OPTIONS drifted from the catalog');
  assert.ok(OPTIONAL_HELPERS.includes('SystemSettings.ps1'));
  assert.ok(!DESKTOP_HELPERS.includes('SystemSettings.ps1'), 'a missing settings helper must never make desktop control "not ready"');
  const script = fs.readFileSync(helperScriptPath('SystemSettings.ps1'), 'utf8');
  for (const id of SETTING_IDS) assert.ok(script.includes(`'${id}'`), `SystemSettings.ps1 does not implement ${id}`);
  for (const action of ['list', 'get', 'set', 'setConfirmed']) assert.equal(modelPolicy('systemSettings', action), null);
  assert.equal(modelPolicy('systemSettings', 'reset'), 'MODEL_CAPABILITY_DENIED');
});

test('registry: reads are READ, reversible changes SAFE_WRITE, radios DANGEROUS with approval', t => {
  const { router } = fixture(t);
  const risk = a => router.registry.get(`systemSettings.${a}`).risk;
  assert.deepEqual(['list', 'get', 'set', 'setConfirmed'].map(risk), ['READ', 'READ', 'SAFE_WRITE', 'DANGEROUS']);
  assert.equal(router.registry.get('systemSettings.setConfirmed').requiresApproval, true);
  for (const s of SETTINGS) assert.equal(s.risk === 'DANGEROUS', ['wifi', 'bluetooth', 'airplane-mode', 'lid-close-action', 'power-button-action', 'mouse-primary-button'].includes(s.id), s.id);
});

test('planChange accepts only typed, in-range values for catalog ids', () => {
  assert.deepEqual(planChange({ id: 'volume', level: 30 }).value, 30);
  assert.deepEqual(planChange({ id: 'dark-mode', enabled: false }).value, false);
  const bad = [
    {}, { id: 'calc; whoami', enabled: true }, { id: 'volume' }, { id: 'volume', level: '30' }, { id: 'volume', level: 30.5 }, { id: 'volume', level: 101 },
    { id: 'volume', level: -1 }, { id: 'brightness', level: 5 }, { id: 'dark-mode', level: 1 }, { id: 'dark-mode', enabled: 'yes' }, { id: 'wifi', enabled: true, level: 1 },
    { id: 'volume', level: 10, command: 'calc' },
  ];
  for (const params of bad) assert.throws(() => planChange(params), e => typeof e.code === 'string', JSON.stringify(params));
  assert.ok(matches(SETTINGS.find(s => s.id === 'volume'), 40, 41));
  assert.ok(!matches(SETTINGS.find(s => s.id === 'volume'), 40, 43));
});

test('list and get read live values with confirmation metadata', async t => {
  const { call } = fixture(t, fakeWindows({ volume: 35 }, { unavailable: ['bluetooth'] }));
  const list = (await call('systemSettings', 'list')).data;
  assert.equal(list.settings.length, SETTING_IDS.length);
  assert.deepEqual(list.settings.find(s => s.id === 'volume'), { id: 'volume', name: 'Speaker volume', type: 'percent', range: [0, 100], description: list.settings.find(s => s.id === 'volume').description, requiresConfirmation: false, available: true, value: 35, display: '35%' });
  assert.equal(list.settings.find(s => s.id === 'wifi').requiresConfirmation, true);
  assert.equal(list.settings.find(s => s.id === 'bluetooth').available, false);
  assert.equal((await call('systemSettings', 'get', { id: 'volume' })).data.display, '35%');
});

test('reversible settings apply immediately and are verified by read-back', async t => {
  const f = fixture(t);
  const dark = await f.call('systemSettings', 'set', { id: 'dark-mode', enabled: false });
  assert.ok(!dark.needsConfirmation);
  assert.equal(dark.data.status, 'SETTING_APPLIED');
  assert.equal(dark.data.verification.criterion, 'readback');
  assert.match(dark.data.message, /light.*was dark/);
  const vol = await f.call('systemSettings', 'set', { id: 'volume', level: 30 });
  assert.equal(vol.data.value, 30);
  const same = await f.call('systemSettings', 'set', { id: 'mute', enabled: false });
  assert.equal(same.data.status, 'SETTING_UNCHANGED');
  assert.deepEqual(f.windows.sets().map(c => [c.id, c.value]), [['dark-mode', false], ['volume', 30], ['mute', false]]);
});

test('a change Windows ignores is reported as NOT verified, never as success', async t => {
  const f = fixture(t, fakeWindows({}, { stuck: ['brightness'] }));
  const r = await f.call('systemSettings', 'set', { id: 'brightness', level: 20 });
  assert.equal(r.data.success, false);
  assert.equal(r.data.status, 'SETTING_NOT_VERIFIED');
  assert.equal(verificationPredicates['systemSettings.set'](r.data, { id: 'brightness' }), false);
});

test('radios are confirmation-gated: set refuses, setConfirmed asks first and changes nothing until approved', async t => {
  const f = fixture(t);
  const refused = await f.call('systemSettings', 'set', { id: 'wifi', enabled: false });
  assert.equal(refused.success, false);
  assert.ok(!refused.needsConfirmation);
  assert.equal(f.windows.sets().length, 0);

  const asked = await f.call('systemSettings', 'setConfirmed', { id: 'bluetooth', enabled: false });
  assert.equal(asked.needsConfirmation, true);
  assert.match(asked.message, /Bluetooth off \(currently on\)/);
  assert.match(asked.message, /disconnects paired devices/);
  const turnOn = await f.call('systemSettings', 'setConfirmed', { id: 'wifi', enabled: true });
  assert.match(turnOn.message, /^Turn Wi-Fi on \(currently on\)\?$/, 'no "disconnects" warning when turning a radio on');
  assert.equal(f.windows.sets().length, 0, 'nothing may change before approval');
  assert.equal(f.windows.state.bluetooth, true);

  const done = await f.approve(asked.confirmationId);
  assert.equal(done.data.status, 'SETTING_APPLIED');
  assert.equal(f.windows.state.bluetooth, false);
  assert.equal(f.windows.sets().length, 1);
  const replay = await f.approve(asked.confirmationId);
  assert.equal(replay.success, false);
  assert.equal(f.windows.sets().length, 1, 'an approval is single-use');
});

test('bad requests never create a confirmation or run a script', async t => {
  const f = fixture(t, fakeWindows({}, { unavailable: ['bluetooth'] }));
  const attempts = [
    ['setConfirmed', { id: 'volume', level: 20 }],           // does not need confirmation
    ['setConfirmed', { id: 'wifi', enabled: 'off' }],        // wrong type
    ['setConfirmed', { id: 'wifi; calc', enabled: false }],  // not a catalog id
    ['setConfirmed', { id: 'bluetooth', enabled: true }],    // radio missing: do not ask a human about it
    ['set', { id: 'brightness', level: 3 }],
    ['set', { id: 'volume', level: 500 }],
    ['set', { id: 'volume' }],
  ];
  for (const [action, params] of attempts) {
    const r = await f.call('systemSettings', action, params);
    assert.equal(r.success, false, `${action} ${JSON.stringify(params)}`);
    assert.ok(!r.needsConfirmation);
  }
  assert.equal(f.windows.sets().length, 0);
  assert.equal(Object.keys(f.router.gate.records).length, 0);
});

test('orchestrator contracts validate steps and demand read-back evidence', () => {
  assert.equal(validateCapability('systemSettings', 'set', { id: 'volume', level: 30 }), null);
  assert.equal(validateCapability('systemSettings', 'setConfirmed', { id: 'wifi', enabled: false }), null);
  assert.ok(validateCapability('systemSettings', 'set', {}));
  assert.ok(validateCapability('systemSettings', 'set', { id: 'x; calc', level: 3 }));
  assert.ok(validateCapability('systemSettings', 'set', { id: 'volume', level: 101 }));
  assert.equal(validateCapability('systemSettings', 'set', { id: 'screen-timeout', level: 600 }), null);
  assert.ok(validateCapability('systemSettings', 'set', { id: 'brightness', level: 5 }));
  assert.ok(validateCapability('systemSettings', 'set', { id: 'mouse-speed', level: 0 }));
  assert.ok(validateCapability('systemSettings', 'set', { id: 'mute', level: 1 }));
  assert.ok(validateCapability('systemSettings', 'set', { id: 'mute', enabled: 'yes' }));
  assert.ok(validateCapability('systemSettings', 'setConfirmed', { id: 'wifi', level: 1 }));
  const ok = { success: true, status: 'SETTING_APPLIED', id: 'volume', verification: { status: 'verified', criterion: 'readback', observedAt: new Date().toISOString() } };
  assert.equal(verificationPredicates['systemSettings.set'](ok, { id: 'volume' }), true);
  assert.equal(verificationPredicates['systemSettings.set']({ ...ok, id: 'mute' }, { id: 'volume' }), false);
  assert.equal(verificationPredicates['systemSettings.set']({ ...ok, verification: { ...ok.verification, status: 'unverified' } }, { id: 'volume' }), false);
});

test('every new setting is reversible, typed, bounded, and only radios need confirmation', () => {
  const byId = Object.fromEntries(SETTINGS.map(s => [s.id, s]));
  for (const id of ['mic-mute', 'transparency', 'file-extensions', 'hidden-files', 'notifications', 'clipboard-history', 'screen-timeout', 'sleep-timeout', 'mouse-speed']) assert.equal(byId[id].risk, 'SAFE_WRITE', id);
  assert.deepEqual(['screen-timeout', 'sleep-timeout', 'mouse-speed'].map(id => [byId[id].min, byId[id].max]), [[0, 720], [0, 720], [1, 20]]);
  for (const [id, level] of [['screen-timeout', 721], ['screen-timeout', -1], ['sleep-timeout', 1000], ['mouse-speed', 0], ['mouse-speed', 21]]) assert.throws(() => planChange({ id, level }), e => e.code === 'OUT_OF_RANGE', `${id} ${level}`);
  assert.equal(planChange({ id: 'screen-timeout', level: 0 }).value, 0); // 0 = never
  assert.throws(() => planChange({ id: 'notifications', level: 3 }), e => e.code === 'INVALID_INPUT');
  assert.throws(() => planChange({ id: 'mouse-speed', enabled: true }), e => e.code === 'INVALID_INPUT');
  // Exact match for everything except brightness/volume rounding.
  assert.ok(!matches(byId['mouse-speed'], 12, 13));
  assert.ok(!matches(byId['screen-timeout'], 10, 11));
});

test('new settings change through the real tool path with plain-language results', async t => {
  const f = fixture(t);
  const say = async (id, params) => (await f.call('systemSettings', 'set', { id, ...params })).data.message;
  assert.match(await say('screen-timeout', { level: 0 }), /Screen timeout is now never \(was 5 minutes plugged in, 3 minutes on battery\)/);
  assert.match(await say('sleep-timeout', { level: 30 }), /Sleep timeout is now 30 minutes \(was 15 minutes plugged in, 10 minutes on battery\)/);
  assert.match(await say('mouse-speed', { level: 14 }), /Pointer speed is now 14 level \(was 10 level\)/);
  assert.match(await say('mic-mute', { enabled: true }), /Microphone mute is now muted \(was unmuted\)/);
  assert.match(await say('file-extensions', { enabled: false }), /File extensions is now hidden \(was shown\)/);
  assert.match(await say('hidden-files', { enabled: false }), /Hidden files is now hidden \(was shown\)/);
  assert.match(await say('notifications', { enabled: false }), /App notifications is now off \(was on\)/);
  assert.match(await say('transparency', { enabled: false }), /Transparency effects is now off \(was on\)/);
  assert.match(await say('clipboard-history', { enabled: true }), /Clipboard history is now on \(was off\)/);
  const list = (await f.call('systemSettings', 'list')).data.settings;
  assert.deepEqual(list.find(s => s.id === 'screen-timeout').range, [0, 720]);
  assert.equal(list.find(s => s.id === 'screen-timeout').unit, 'minutes');
  assert.equal(list.find(s => s.id === 'screen-timeout').display, 'never');
  assert.equal(list.length, SETTING_IDS.length);
  assert.equal(f.windows.sets().length, 9);
  assert.equal(Object.keys(f.router.gate.records).length, 0, 'reversible settings never ask for confirmation');
});

test('the second batch is typed and bounded: levels, a multiple-choice option, and airplane mode as a confirmed radio', () => {
  const byId = Object.fromEntries(SETTINGS.map(s => [s.id, s]));
  assert.deepEqual(['mic-volume', 'scroll-lines', 'double-click-speed', 'keyboard-repeat-rate'].map(id => [byId[id].min, byId[id].max]), [[0, 100], [1, 100], [200, 900], [0, 31]]);
  for (const [id, level] of [['mic-volume', 101], ['scroll-lines', 0], ['double-click-speed', 199], ['double-click-speed', 901], ['keyboard-repeat-rate', 32]]) assert.throws(() => planChange({ id, level }), e => e.code === 'OUT_OF_RANGE', `${id} ${level}`);
  assert.equal(planChange({ id: 'power-mode', option: 'best-performance' }).value, 'best-performance');
  for (const bad of [{ id: 'power-mode' }, { id: 'power-mode', option: 'turbo' }, { id: 'power-mode', option: 'balanced', level: 1 }, { id: 'power-mode', enabled: true }, { id: 'volume', level: 5, option: 'balanced' }, { id: 'mute', enabled: true, option: 'x' }])
    assert.throws(() => planChange(bad), e => typeof e.code === 'string', JSON.stringify(bad));
  assert.equal(byId['airplane-mode'].risk, 'DANGEROUS');
  assert.equal(byId['pointer-precision'].risk, 'SAFE_WRITE');
  assert.equal(byId['power-mode'].risk, 'SAFE_WRITE');
});

test('power mode and the other new settings change through the real tool path', async t => {
  const f = fixture(t);
  const say = async (id, params) => (await f.call('systemSettings', 'set', { id, ...params })).data.message;
  assert.match(await say('power-mode', { option: 'best-performance' }), /Power mode is now Best performance \(was Balanced\)/);
  assert.match(await say('mic-volume', { level: 80 }), /Microphone volume is now 80% \(was 32%\)/);
  assert.match(await say('scroll-lines', { level: 6 }), /Scroll lines is now 6 lines \(was 3 lines\)/);
  assert.match(await say('double-click-speed', { level: 700 }), /Double-click speed is now 700 ms \(was 500 ms\)/);
  assert.match(await say('keyboard-repeat-rate', { level: 20 }), /Keyboard repeat rate is now 20 level \(was 31 level\)/);
  assert.match(await say('pointer-precision', { enabled: false }), /Pointer precision is now off \(was on\)/);
  const bad = await f.call('systemSettings', 'set', { id: 'power-mode', option: 'turbo' });
  assert.equal(bad.success, false);
  const list = (await f.call('systemSettings', 'list')).data.settings;
  const power = list.find(s => s.id === 'power-mode');
  assert.deepEqual(power.options, ['best-power-efficiency', 'balanced', 'best-performance']);
  assert.equal(power.display, 'Best performance');
  assert.equal(Object.keys(f.router.gate.records).length, 0);
});

test('airplane mode is confirmation-gated and only warns in the risky direction', async t => {
  const f = fixture(t);
  assert.equal((await f.call('systemSettings', 'set', { id: 'airplane-mode', enabled: true })).success, false);
  assert.equal(f.windows.sets().length, 0);
  const on = await f.call('systemSettings', 'setConfirmed', { id: 'airplane-mode', enabled: true });
  assert.equal(on.needsConfirmation, true);
  assert.match(on.message, /Turn Airplane mode on \(currently off\)\? Airplane mode turns off Wi-Fi, Bluetooth/);
  const off = await f.call('systemSettings', 'setConfirmed', { id: 'airplane-mode', enabled: false });
  assert.match(off.message, /^Turn Airplane mode off \(currently off\)\?$/, 'turning airplane mode off carries no warning');
  assert.equal(f.windows.sets().length, 0);
  const done = await f.approve(on.confirmationId);
  assert.equal(done.data.status, 'SETTING_APPLIED');
  assert.equal(f.windows.state['airplane-mode'], true);
});

test('third batch: lid, power button and mouse button are confirmed choices; blink rate and clock are safe', async t => {
  const byId = Object.fromEntries(SETTINGS.map(s => [s.id, s]));
  for (const id of ['lid-close-action', 'power-button-action', 'mouse-primary-button']) assert.equal(byId[id].risk, 'DANGEROUS', id);
  for (const id of ['cursor-blink-rate', 'clock-24-hour']) assert.equal(byId[id].risk, 'SAFE_WRITE', id);
  assert.deepEqual(byId['lid-close-action'].options.map(o => o.id), ['do-nothing', 'sleep', 'hibernate', 'shut-down']);
  assert.deepEqual(byId['mouse-primary-button'].options.map(o => o.id), ['left', 'right']);
  assert.throws(() => planChange({ id: 'cursor-blink-rate', level: 199 }), e => e.code === 'OUT_OF_RANGE');
  assert.throws(() => planChange({ id: 'cursor-blink-rate', level: 1201 }), e => e.code === 'OUT_OF_RANGE');
  assert.throws(() => planChange({ id: 'lid-close-action', option: 'explode' }), e => e.code === 'INVALID_INPUT');
  assert.throws(() => planChange({ id: 'mouse-primary-button', option: 'sleep' }), e => e.code === 'INVALID_INPUT', 'options are per setting');

  const f = fixture(t);
  assert.match((await f.call('systemSettings', 'set', { id: 'cursor-blink-rate', level: 700 })).data.message, /Cursor blink rate is now 700 ms \(was 530 ms\)/);
  assert.match((await f.call('systemSettings', 'set', { id: 'clock-24-hour', enabled: false })).data.message, /Clock format is now 12-hour \(was 24-hour\)/);
  // choices that change device behavior never run through `set`
  for (const [id, option] of [['lid-close-action', 'do-nothing'], ['power-button-action', 'shut-down'], ['mouse-primary-button', 'right']]) {
    const refused = await f.call('systemSettings', 'set', { id, option });
    assert.equal(refused.success, false, id);
    assert.ok(!refused.needsConfirmation);
  }
  assert.equal(f.windows.sets().length, 2);

  const lid = await f.call('systemSettings', 'setConfirmed', { id: 'lid-close-action', option: 'do-nothing' });
  assert.equal(lid.needsConfirmation, true);
  assert.match(lid.message, /^Set Lid close action to Do nothing \(currently Sleep\)\? This changes what happens whenever the lid is closed/);
  assert.match(lid.message, /hot\) in a bag/);
  assert.equal(f.windows.state['lid-close-action'], 'sleep', 'unchanged until approved');
  const done = await f.approve(lid.confirmationId);
  assert.match(done.data.message, /Lid close action is now Do nothing \(was Sleep\)/);
  assert.equal(f.windows.state['lid-close-action'], 'do-nothing');

  const mouse = await f.call('systemSettings', 'setConfirmed', { id: 'mouse-primary-button', option: 'right' });
  assert.match(mouse.message, /^Set Primary mouse button to Right button \(currently Left button\)\?/);
  assert.match(mouse.message, /swaps the mouse buttons/);
  const list = (await f.call('systemSettings', 'list')).data.settings;
  assert.equal(list.find(s => s.id === 'power-button-action').requiresConfirmation, true);
  assert.deepEqual(list.find(s => s.id === 'power-button-action').options, ['do-nothing', 'sleep', 'hibernate', 'shut-down']);
  assert.deepEqual(list.find(s => s.id === 'cursor-blink-rate').range, [200, 1200]);
});

test('fourth batch: more timeouts, pointer trails, keyboard repeat delay and menu delay', async t => {
  const byId = Object.fromEntries(SETTINGS.map(s => [s.id, s]));
  const added = ['hibernate-timeout', 'disk-timeout', 'lock-screen-timeout', 'pointer-trails', 'keyboard-repeat-delay', 'menu-show-delay'];
  for (const id of added) assert.equal(byId[id].risk, 'SAFE_WRITE', id);
  assert.deepEqual(added.map(id => [byId[id].min, byId[id].max]), [[0, 1440], [0, 1440], [0, 60], [0, 20], [0, 3], [0, 4000]]);
  for (const [id, level] of [['hibernate-timeout', 1441], ['lock-screen-timeout', 61], ['keyboard-repeat-delay', 4], ['menu-show-delay', 4001], ['pointer-trails', 21], ['disk-timeout', -1]])
    assert.throws(() => planChange({ id, level }), e => e.code === 'OUT_OF_RANGE', `${id} ${level}`);

  // A pointer-trail length of 1 reads back as 0 on Windows, so it is refused at every layer instead of failing verification.
  assert.throws(() => planChange({ id: 'pointer-trails', level: 1 }), e => e.code === 'OUT_OF_RANGE' && /2 \(short\) to 20/.test(e.message));
  assert.deepEqual(CONTRACT_FORBIDDEN, Object.fromEntries(SETTINGS.filter(s => s.forbid).map(s => [s.id, s.forbid])), 'backend SETTING_FORBIDDEN drifted from the catalog');
  assert.ok(validateCapability('systemSettings', 'set', { id: 'pointer-trails', level: 1 }));
  assert.equal(validateCapability('systemSettings', 'set', { id: 'pointer-trails', level: 5 }), null);
  assert.equal(validateCapability('systemSettings', 'set', { id: 'menu-show-delay', level: 3000 }), null);
  assert.ok(validateCapability('systemSettings', 'set', { id: 'lock-screen-timeout', level: 120 }));

  const f = fixture(t);
  const say = async (id, level) => (await f.call('systemSettings', 'set', { id, level })).data.message;
  assert.match(await say('hibernate-timeout', 0), /Hibernate timeout is now never \(was 180 minutes\)/);
  assert.match(await say('disk-timeout', 30), /Hard disk timeout is now 30 minutes \(was 20 minutes plugged in, 10 minutes on battery\)/);
  assert.match(await say('lock-screen-timeout', 5), /Lock screen timeout is now 5 minutes \(was 1 minute\)/);
  assert.match(await say('pointer-trails', 8), /Pointer trails is now 8 length \(was off\)/);
  assert.match(await say('keyboard-repeat-delay', 3), /Keyboard repeat delay is now 3 level \(was 1 level\)/);
  assert.match(await say('menu-show-delay', 100), /Menu show delay is now 100 ms \(was 400 ms\)/);
  const refused = await f.call('systemSettings', 'set', { id: 'pointer-trails', level: 1 });
  assert.equal(refused.success, false);
  assert.equal(f.windows.state['pointer-trails'], 8, 'the refused value never reached Windows');
  assert.equal(f.windows.sets().length, 6);
  assert.equal(Object.keys(f.router.gate.records).length, 0, 'none of these needs confirmation');
});

test('fifth batch: power-plan settings keep separate plugged-in and on-battery values', async t => {
  const byId = Object.fromEntries(SETTINGS.map(x => [x.id, x]));
  assert.deepEqual(CONTRACT_PER_SOURCE, SETTINGS.filter(x => x.perSource).map(x => x.id), 'backend SETTING_PER_SOURCE drifted from the catalog');
  assert.deepEqual(SOURCES, ['both', 'plugged-in', 'battery']);
  for (const id of ['screen-timeout', 'sleep-timeout', 'hibernate-timeout', 'disk-timeout', 'lock-screen-timeout', 'dim-timeout', 'max-processor-state', 'usb-selective-suspend', 'wake-timers', 'cooling-policy', 'lid-close-action', 'power-button-action'])
    assert.equal(byId[id].perSource, true, id);
  assert.ok(!byId['volume'].perSource && !byId['battery-saver-threshold'].perSource && byId['battery-saver-threshold'].batteryOnly);

  // planning: source defaults to both, is validated, and exists only for these settings
  assert.equal(planChange({ id: 'screen-timeout', level: 10 }).source, 'both');
  assert.equal(planChange({ id: 'screen-timeout', level: 10, source: 'battery' }).source, 'battery');
  assert.equal(planChange({ id: 'volume', level: 10 }).source, undefined);
  for (const bad of [{ id: 'volume', level: 10, source: 'battery' }, { id: 'screen-timeout', level: 10, source: 'moon' }, { id: 'battery-saver-threshold', level: 20, source: 'battery' }, { id: 'dark-mode', enabled: true, source: 'both' }])
    assert.throws(() => planChange(bad), e => e.code === 'INVALID_INPUT', JSON.stringify(bad));

  // the orchestrator contract agrees
  assert.equal(validateCapability('systemSettings', 'set', { id: 'screen-timeout', level: 10, source: 'battery' }), null);
  assert.ok(validateCapability('systemSettings', 'set', { id: 'volume', level: 10, source: 'battery' }));
  assert.ok(validateCapability('systemSettings', 'set', { id: 'screen-timeout', level: 10, source: 'moon' }));
  assert.equal(validateCapability('systemSettings', 'set', { id: 'wake-timers', option: 'enabled', source: 'plugged-in' }), null);

  const f = fixture(t);
  const say = async (params) => (await f.call('systemSettings', 'set', params)).data.message;
  // battery only: plugged-in is untouched
  assert.match(await say({ id: 'screen-timeout', level: 10, source: 'battery' }), /^Screen timeout is now 10 minutes on battery \(was 3 minutes\)\.$/);
  assert.deepEqual([f.windows.state['screen-timeout'], f.windows.battery['screen-timeout']], [5, 10]);
  // plugged-in only: battery is untouched
  assert.match(await say({ id: 'screen-timeout', level: 20, source: 'plugged-in' }), /^Screen timeout is now 20 minutes when plugged in \(was 5 minutes\)\.$/);
  assert.deepEqual([f.windows.state['screen-timeout'], f.windows.battery['screen-timeout']], [20, 10]);
  // both: the message says what each side was when they differed
  assert.match(await say({ id: 'screen-timeout', level: 7 }), /^Screen timeout is now 7 minutes \(was 20 minutes plugged in, 10 minutes on battery\)\.$/);
  assert.deepEqual([f.windows.state['screen-timeout'], f.windows.battery['screen-timeout']], [7, 7]);
  assert.match(await say({ id: 'screen-timeout', level: 7, source: 'battery' }), /was already 7 minutes on battery/);
  // choices and booleans work per source too
  assert.match(await say({ id: 'wake-timers', option: 'enabled', source: 'battery' }), /^Wake timers is now Enabled on battery \(was Disabled\)\.$/);
  assert.equal(f.windows.state['wake-timers'], 'important-only');
  assert.match(await say({ id: 'usb-selective-suspend', enabled: false }), /USB selective suspend is now disabled/);
  // battery saver applies on battery only, by definition
  assert.match(await say({ id: 'battery-saver-threshold', level: 50 }), /^Battery saver threshold is now 50% \(was 30%\)\.$/);
  assert.equal(f.windows.state['battery-saver-threshold'], 30, 'the plugged-in side is not touched');
  assert.equal(f.windows.battery['battery-saver-threshold'], 50);

  // a change is only verified when EVERY targeted side took it
  const stuck = fixture(t, fakeWindows({}, { stuck: ['dim-timeout'] }));
  const refused = await stuck.call('systemSettings', 'set', { id: 'dim-timeout', level: 2 });
  assert.equal(refused.data.success, false);
  assert.equal(refused.data.status, 'SETTING_NOT_VERIFIED');
  assert.equal(verificationPredicates['systemSettings.set'](refused.data, { id: 'dim-timeout' }), false);

  // list and get expose both values
  const list = (await f.call('systemSettings', 'list')).data.settings;
  const screen = list.find(x => x.id === 'screen-timeout');
  assert.equal(screen.perSource, true);
  assert.equal(screen.display, '7 minutes');
  assert.equal(screen.displayOnBattery, '7 minutes');
  assert.equal(list.find(x => x.id === 'volume').onBattery, undefined);
  assert.equal(list.find(x => x.id === 'battery-saver-threshold').appliesTo, 'battery');
  const got = (await f.call('systemSettings', 'get', { id: 'cooling-policy' })).data;
  assert.deepEqual([got.pluggedIn, got.onBattery], ['active', 'passive']);
  assert.match(got.display, /Active \(fan first\) plugged in, Passive \(slow the CPU first\) on battery/);
});

test('confirmation text names the source, and settings that change device behavior still ask first', async t => {
  const f = fixture(t);
  const battery = await f.call('systemSettings', 'setConfirmed', { id: 'lid-close-action', option: 'do-nothing', source: 'battery' });
  assert.equal(battery.needsConfirmation, true);
  assert.match(battery.message, /^Set Lid close action to Do nothing on battery \(currently Sleep\)\?/);
  const both = await f.call('systemSettings', 'setConfirmed', { id: 'power-button-action', option: 'shut-down' });
  assert.match(both.message, /^Set Power button action to Shut down \(currently Sleep\)\?/);
  assert.equal(f.windows.sets().length, 0);
  const done = await f.approve(battery.confirmationId);
  assert.match(done.data.message, /Lid close action is now Do nothing on battery \(was Sleep\)/);
  assert.equal(f.windows.state['lid-close-action'], 'sleep', 'plugged-in lid action is unchanged');
  assert.equal(f.windows.battery['lid-close-action'], 'do-nothing');
});

test('sixth batch: animations, window dragging and pointer behavior toggles', async t => {
  const added = ['animations', 'drag-window-contents', 'snap-to-default-button', 'hide-pointer-while-typing', 'pointer-location-on-ctrl', 'usb-selective-suspend'];
  const byId = Object.fromEntries(SETTINGS.map(x => [x.id, x]));
  for (const id of added) { assert.equal(byId[id].type, 'boolean', id); assert.equal(byId[id].risk, 'SAFE_WRITE', id); }
  assert.deepEqual(['dim-timeout', 'max-processor-state', 'battery-saver-threshold'].map(id => [byId[id].min, byId[id].max]), [[0, 1440], [20, 100], [0, 100]]);
  assert.throws(() => planChange({ id: 'max-processor-state', level: 19 }), e => e.code === 'OUT_OF_RANGE', 'a CPU cap below 20% would make the PC unusable');
  assert.deepEqual(byId['wake-timers'].options.map(o => o.id), ['disabled', 'enabled', 'important-only'], 'order matches the values Windows assigns (0, 1, 2)');
  assert.deepEqual(byId['cooling-policy'].options.map(o => o.id), ['passive', 'active']);

  const f = fixture(t);
  const say = async (id, enabled) => (await f.call('systemSettings', 'set', { id, enabled })).data.message;
  assert.match(await say('animations', false), /Window animations is now off \(was on\)/);
  assert.match(await say('drag-window-contents', false), /Show window contents while dragging is now hidden \(was shown\)/);
  assert.match(await say('snap-to-default-button', true), /Snap pointer to default button is now on \(was off\)/);
  assert.match(await say('hide-pointer-while-typing', false), /Hide pointer while typing is now off \(was on\)/);
  assert.match(await say('pointer-location-on-ctrl', true), /Show pointer location with Ctrl is now on \(was off\)/);
  assert.match((await f.call('systemSettings', 'set', { id: 'max-processor-state', level: 80 })).data.message, /Maximum processor state is now 80% \(was 100%\)/);
  assert.match((await f.call('systemSettings', 'set', { id: 'dim-timeout', level: 0 })).data.message, /Display dim timeout is now never \(was 10 minutes plugged in, 5 minutes on battery\)/);
  assert.equal(Object.keys(f.router.gate.records).length, 0, 'none of these needs confirmation');
});

test('the PowerShell helper never bundles its native calls into one assembly (security software blocks that)', () => {
  const script = fs.readFileSync(helperScriptPath('SystemSettings.ps1'), 'utf8');
  const classes = [...script.matchAll(/public static class (\w+)\{([^}]*)\}/g)].map(m => ({ name: m[1], body: m[2] }));
  assert.ok(classes.length >= 5, 'native groups are compiled separately');
  assert.ok(!script.includes('MouseSpi'), 'the old all-in-one input/power assembly must not come back');
  for (const c of classes) {
    const families = new Set();
    if (/SystemParametersInfo/.test(c.body)) families.add('spi');
    if (/DoubleClickTime/.test(c.body)) families.add('click');
    if (/CaretBlinkTime|GetSystemMetrics/.test(c.body)) families.add('caret');
    if (/powrprof/.test(c.body)) families.add('power');
    assert.ok(families.size <= 1, `${c.name} mixes native families: ${[...families].join(', ')}`);
  }
});

test('a missing settings helper degrades only this feature, with an explanation', async t => {
  // 1. Desktop control readiness does not depend on the optional helper.
  const { router } = fixture(t);
  const present = desktopCapabilityDiagnostics(router, { exists: () => true }).desktopControl.reasons;
  const missing = desktopCapabilityDiagnostics(router, { exists: p => !String(p).endsWith('SystemSettings.ps1') }).desktopControl.reasons;
  assert.deepEqual(missing, present);
  assert.ok(!missing.some(r => /SystemSettings/.test(r)));
  // 2. The settings tool explains the real cause instead of a generic failure.
  const gate = { request: () => ({ confirmationId: 'x', expiresAt: 1 }) };
  const ui = { run: async () => { throw Object.assign(new Error('Desktop helper unavailable.'), { code: 'DESKTOP_HELPER_MISSING' }); } };
  const service = new SystemSettingsService(gate, ui);
  await assert.rejects(service.get({ id: 'volume' }), e => e.code === 'SETTINGS_HELPER_MISSING' && /antivirus/i.test(e.message));
  await assert.rejects(service.list(), e => e.code === 'SETTINGS_HELPER_MISSING');
});

test('routing: the new settings are reachable, per-app requests are not hijacked', () => {
  for (const text of ['mute my microphone', 'turn off the mic', 'turn off transparency effects', 'show file extensions', 'hide file extensions', 'show hidden files',
    'turn off notifications', 'enable clipboard history', 'set screen timeout to 10 minutes', 'set sleep timeout to never', 'turn the screen off after 5 minutes',
    'increase mouse speed', 'set pointer speed to 12', 'turn on airplane mode', 'enable flight mode', 'set mic volume to 60', 'set the microphone level to 40',
    'turn off mouse acceleration', 'disable enhance pointer precision', 'set scroll speed to 5 lines', 'set double click speed to 600', 'increase the keyboard repeat rate',
    'set power mode to best performance', 'switch the power plan to balanced', 'set performance mode',
    'change what the power button does', 'set lid close action to do nothing', 'swap the mouse buttons', 'make the primary mouse button the right one',
    'set cursor blink rate to 700', 'switch to 24 hour clock', 'use 12-hour time', 'change the clock format',
    'set hibernate timeout to 240 minutes', 'turn off pointer trails', 'set menu delay to 200', 'change the lock screen timeout', 'set hard disk timeout to never',
    'increase keyboard repeat delay', 'set screen timeout to 10 minutes on battery', 'turn off animations', 'reduce motion', 'show window contents while dragging',
    'hide the pointer while typing', 'set dim display timeout to 3 minutes', 'limit cpu to 80 percent', 'set max processor state to 70', 'turn off usb selective suspend',
    'disable wake timers', 'set battery saver threshold to 40', 'set the cooling policy to passive', 'turn off usb suspend when plugged in']) assert.equal(settingsChangeTask(text), true, text);
  for (const text of ['mute spotify', 'turn off notifications in chrome', 'set mouse speed in blender', 'show hidden files in vs code', 'what are hidden files',
    'how do I show file extensions', 'open notifications settings', 'start chrome', 'stop the music', 'hide the window',
    'turn on airplane mode in my notes app', 'set scroll speed in chrome', 'what is power mode', 'open power mode settings', 'how do I turn on airplane mode',
    'set 24 hour clock in outlook', 'what does the lid close action do', 'open the power button settings', 'use chrome', 'switch to the other window',
    'what is hibernate', 'how do I turn off pointer trails', 'open lock screen settings', 'set menu delay in photoshop', 'turn off animations in blender', 'what are wake timers',
    'limit cpu usage in chrome', 'turn on battery saver']) assert.ok(!settingsChangeTask(text), text);
});

test('routing: setting-change commands are tool tasks; questions and "open settings" are not', () => {
  for (const text of ['turn on dark mode', 'switch to light mode', 'set volume to 30', 'increase the brightness', 'mute', 'unmute the sound', 'turn off bluetooth',
    'Please disable wi-fi', 'can you turn off the wifi?', 'make it louder', 'dim the screen', 'set the brightness to 50 percent', 'volume 30 aaki vidu', 'bluetooth off pannu']) {
    assert.equal(settingsChangeTask(text), true, text);
    assert.equal(computerTask(text)?.requiresSettings, true, text);
  }
  for (const text of ['turn off wifi on this pc', 'turn on dark mode on my laptop', 'mute everything']) assert.equal(settingsChangeTask(text), true, text);
  // Per-application requests belong to the desktop loop, not the system setting.
  for (const text of ['set the volume to 50 in vlc', 'set volume to 30 on spotify', 'mute spotify', 'turn up the volume in chrome', 'dim the screen in obs', 'make it louder in vlc']) assert.ok(!settingsChangeTask(text), text);
  for (const text of ['what is dark mode', 'how do I turn on bluetooth', 'explain volume normalization', 'open bluetooth settings', 'open sound settings', 'hello', 'volume of a sphere']) {
    assert.ok(!settingsChangeTask(text), text);
    assert.ok(!computerTask(text)?.requiresSettings, text);
  }
  assert.equal(computerTask('open bluetooth settings').call.action, 'openApp');
});

test('a settings task is only reported done with verified read-back evidence', () => {
  const task = computerTask('set volume to 30');
  assert.match(executionOnlyReply(task, [{ success: true, toolName: 'systemSettings_list', data: { success: true } }]), /not been verified/);
  const done = { success: true, toolName: 'systemSettings_set', data: { message: 'Speaker volume is now 30%.', verification: { status: 'verified' } } };
  assert.equal(executionOnlyReply(task, [done]), 'Speaker volume is now 30%.');
});
