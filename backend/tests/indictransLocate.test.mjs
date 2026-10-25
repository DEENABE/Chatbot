import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  locateTranslatorService,
  planTranslatorLaunch,
  translatorCandidates,
} from '../src/services/indictransProcess.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-locate-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const touch = (...parts) => {
  const file = path.join(tmp, ...parts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x');
  return file;
};
const folder = (name, { python = 'python/python.exe', models = true, app = true } = {}) => {
  if (app) touch(name, 'app', 'main.py');
  if (models) fs.mkdirSync(path.join(tmp, name, 'models', 'en-indic'), { recursive: true });
  if (python) touch(name, ...python.split('/'));
  return path.join(tmp, name);
};
const base = (extra = {}) => ({
  platform: 'win32',
  env: {},
  backendDir: path.join(tmp, 'repo', 'backend'),
  execPath: path.join(tmp, 'install', 'Chanakya AI.exe'),
  appDataPath: path.join(tmp, 'appdata'),
  ...extra,
});

test('candidates are only places the person or an administrator controls, in a fixed order', () => {
  const list = translatorCandidates(
    base({ env: { INDICTRANS_SERVICE_DIR: 'D:/chosen', ProgramData: 'C:/ProgramData' } }),
  );
  assert.deepEqual(
    list.map((item) => item.source),
    [
      'INDICTRANS_SERVICE_DIR',
      'development checkout',
      'next to the application',
      'application resources',
      'per-user data folder',
    ],
  );
  assert.ok(
    !list.some((item) => /ProgramData/i.test(item.dir)),
    'a folder any local user can create is never searched',
  );
});
test('nothing found reports every folder that was checked and what was missing', () => {
  const { service, checked } = locateTranslatorService(base());
  assert.equal(service, null);
  assert.equal(checked.length, 4);
  assert.ok(checked.every((item) => item.missing === 'app/main.py'));
});
test('a pack next to the application is found and its own Python is used', () => {
  const dir = folder(path.join('install', 'translator'));
  const { service } = locateTranslatorService(base());
  assert.equal(service.dir, dir);
  assert.equal(service.bundledPython, true);
  assert.equal(service.pythonExe, path.join(dir, 'python', 'python.exe'));
  assert.equal(service.modelsDir, path.join(dir, 'models'));
});
test('a development checkout keeps using its .venv exactly as before', () => {
  const dir = folder(path.join('repo', 'indictrans-service'), {
    python: '.venv/Scripts/python.exe',
  });
  const { service } = locateTranslatorService(base());
  assert.equal(service.dir, dir);
  assert.equal(service.bundledPython, false);
  assert.equal(service.pythonExe, path.join(dir, '.venv', 'Scripts', 'python.exe'));
});
test('an explicit INDICTRANS_SERVICE_DIR wins, and an invalid one falls through instead of silently disabling translation', () => {
  const chosen = folder('chosen');
  assert.equal(
    locateTranslatorService(base({ env: { INDICTRANS_SERVICE_DIR: chosen } })).service.dir,
    chosen,
  );
  const { service, checked } = locateTranslatorService(
    base({ env: { INDICTRANS_SERVICE_DIR: path.join(tmp, 'typo') } }),
  );
  assert.equal(service.dir, path.join(tmp, 'repo', 'indictrans-service'));
  assert.equal(checked[0].source, 'INDICTRANS_SERVICE_DIR');
});
test('an incomplete folder is skipped: no models, or no Python', () => {
  fs.rmSync(path.join(tmp, 'install'), { recursive: true, force: true });
  fs.rmSync(path.join(tmp, 'repo'), { recursive: true, force: true });
  folder(path.join('install', 'translator'), { models: false });
  folder(path.join('install', 'resources', 'translator'), { python: null });
  const { service, checked } = locateTranslatorService(base());
  assert.equal(service, null);
  const byDir = Object.fromEntries(
    checked.map((item) => [path.relative(tmp, item.dir), item.missing]),
  );
  assert.equal(byDir[path.join('install', 'translator')], 'models');
  assert.equal(byDir[path.join('install', 'resources', 'translator')], 'python');
});
test('the per-user data folder is the last resort', () => {
  const dir = folder('appdata/translator');
  assert.equal(locateTranslatorService(base()).service.dir, dir);
});

test("when a folder has both, the pack's own Python is preferred over a .venv copied from another PC", () => {
  fs.rmSync(path.join(tmp, 'repo'), { recursive: true, force: true });
  fs.rmSync(path.join(tmp, 'install'), { recursive: true, force: true });
  const dir = folder(path.join('install', 'translator'));
  touch('install', 'translator', '.venv', 'Scripts', 'python.exe');
  const { service } = locateTranslatorService(base());
  assert.equal(service.bundledPython, true);
  assert.equal(service.pythonExe, path.join(dir, 'python', 'python.exe'));
});
test('a pack gets its model path, an offline Python and no user site-packages; a dev checkout keeps its environment', () => {
  const pack = {
    dir: path.join(tmp, 'p'),
    modelsDir: path.join(tmp, 'p', 'models'),
    pythonExe: path.join(tmp, 'p', 'python', 'python.exe'),
    bundledPython: true,
  };
  const plan = planTranslatorLaunch(pack, {
    serviceUrl: 'http://127.0.0.1:8100',
    env: { PATH: 'x' },
    readFile: () => {
      throw new Error('no .env');
    },
  });
  assert.equal(plan.command, pack.pythonExe);
  assert.deepEqual(plan.args, [
    '-m',
    'uvicorn',
    'app.main:app',
    '--host',
    '127.0.0.1',
    '--port',
    '8100',
  ]);
  assert.equal(plan.cwd, pack.dir);
  assert.equal(plan.env.INDICTRANS_MODEL_PATH, pack.modelsDir);
  assert.equal(plan.env.PYTHONNOUSERSITE, '1');
  assert.equal(plan.env.HF_HUB_OFFLINE, '1');
  assert.equal(plan.env.TRANSFORMERS_OFFLINE, '1');
  const dev = {
    ...pack,
    bundledPython: false,
    pythonExe: path.join(tmp, 'p', '.venv', 'Scripts', 'python.exe'),
  };
  const devPlan = planTranslatorLaunch(dev, {
    serviceUrl: 'http://127.0.0.1:8100',
    env: {},
    readFile: () => 'INDICTRANS_MODEL_PATH=E:/own/models\n',
  });
  assert.equal(devPlan.env.INDICTRANS_MODEL_PATH, undefined, "the folder's own .env decides");
  assert.equal(devPlan.env.PYTHONNOUSERSITE, undefined);
  assert.equal(devPlan.env.HF_HUB_OFFLINE, undefined);
});
test('an explicit INDICTRANS_MODEL_PATH is never overridden', () => {
  const pack = {
    dir: path.join(tmp, 'p'),
    modelsDir: path.join(tmp, 'p', 'models'),
    pythonExe: 'py',
    bundledPython: true,
  };
  const plan = planTranslatorLaunch(pack, {
    serviceUrl: 'http://localhost:8100',
    env: { INDICTRANS_MODEL_PATH: 'D:/models' },
    readFile: () => '',
  });
  assert.equal(plan.env.INDICTRANS_MODEL_PATH, 'D:/models');
});
test('the service is only ever started on the loopback address the app already allows', () => {
  const pack = { dir: tmp, modelsDir: tmp, pythonExe: 'py', bundledPython: true };
  const plan = planTranslatorLaunch(pack, {
    serviceUrl: 'http://127.0.0.1:8100',
    env: {},
    readFile: () => '',
  });
  assert.equal(plan.args[plan.args.indexOf('--host') + 1], '127.0.0.1');
});
