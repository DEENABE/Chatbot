import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildPack,
  copyModelEntry,
  copyModelFile,
  copyPythonEntry,
  copySitePackagesEntry,
  parsePyvenvCfg,
  TEMPLATE_FILES,
} from '../../scripts/translatorPack.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'translator-pack-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));
const write = (file, content = 'x') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
};
const OLD_TIME = new Date('2024-03-04T05:06:08Z');
const sha = (text) => crypto.createHash('sha256').update(text).digest('hex');

/** A stand-in for the PC where the translator works: base Python, a venv, the service code and three models. */
function fixture(name, { bin = true, safetensors = true, skipDirection } = {}) {
  const base = path.join(root, name);
  const python = path.join(base, 'Python312');
  for (const file of [
    'python.exe',
    'python312.dll',
    'vcruntime140.dll',
    'Lib/os.py',
    'Lib/json/__init__.py',
    'Lib/test/test_a.py',
    'Lib/idlelib/a.py',
    'Lib/turtledemo/b.py',
    'Lib/site-packages/pip/base.py',
    'Doc/a.chm',
    'Tools/a.py',
    'include/Python.h',
    'libs/python312.lib',
    'DLLs/_ssl.pyd',
    'Scripts/pip.exe',
    'tcl/a.tcl',
  ])
    write(path.join(python, ...file.split('/')), `base:${file}`);
  const service = path.join(base, 'indictrans-service');
  write(
    path.join(service, '.venv', 'pyvenv.cfg'),
    `home = ${python}\r\nversion = 3.12.10\r\ninclude-system-site-packages = false\r\n`,
  );
  for (const file of [
    'torch/__init__.py',
    'torch/__pycache__/__init__.cpython-312.pyc',
    'transformers-4.44.2.dist-info/METADATA',
    'pip/__init__.py',
    'pip-24.0.dist-info/METADATA',
    'fastapi/__init__.py',
  ])
    write(path.join(service, '.venv', 'Lib', 'site-packages', ...file.split('/')), `venv:${file}`);
  fs.utimesSync(
    path.join(service, '.venv', 'Lib', 'site-packages', 'torch', '__init__.py'),
    OLD_TIME,
    OLD_TIME,
  );
  write(path.join(service, 'app', 'main.py'), 'app');
  write(path.join(service, 'app', '__pycache__', 'main.pyc'), 'pyc');
  write(path.join(service, 'requirements.txt'), 'torch');
  write(path.join(service, '.env'), 'INDICTRANS_MODEL_PATH=E:/this-pc/models');
  for (const direction of ['en-indic', 'indic-en', 'indic-indic']) {
    if (direction === skipDirection) continue;
    const dir = path.join(service, 'models', direction);
    write(path.join(dir, 'config.json'), '{}');
    write(path.join(dir, 'model.SRC'), 'tokenizer');
    write(path.join(dir, '.gitattributes'), 'lfs');
    write(path.join(dir, '.cache', 'huggingface', 'download', 'config.json.metadata'), 'meta');
    if (safetensors) write(path.join(dir, 'model.safetensors'), `weights:${direction}`);
    if (bin) write(path.join(dir, 'pytorch_model.bin'), `weights:${direction}`);
  }
  const system = path.join(base, 'System32');
  for (const dll of ['msvcp140.dll', 'vcruntime140_1.dll', 'vcruntime140.dll'])
    write(path.join(system, dll), `sys:${dll}`);
  return { base, python, service, system };
}
const exists = (...parts) => fs.existsSync(path.join(...parts));

test('pyvenv.cfg is read for the base Python folder and version', () => {
  assert.deepEqual(parsePyvenvCfg('home = C:\\Py\\Python312\r\nversion = 3.12.10\r\n'), {
    home: 'C:\\Py\\Python312',
    version: '3.12.10',
  });
  assert.deepEqual(parsePyvenvCfg(''), { home: null, version: null });
});
test('filters: development-only Python parts and pip are left out, everything the service needs stays', () => {
  for (const skip of [
    'Doc/a',
    'Tools/x/y.py',
    'include/Python.h',
    'libs/python312.lib',
    'Scripts/pip.exe',
    'Lib/test/test_a.py',
    'Lib/idlelib/a.py',
    'Lib/site-packages/x.py',
  ])
    assert.equal(copyPythonEntry(skip), false, skip);
  for (const keep of [
    'python.exe',
    'python312.dll',
    'DLLs/_ssl.pyd',
    'Lib/os.py',
    'Lib/json/__init__.py',
    'Lib/testing_helpers.py',
    'tcl/a.tcl',
  ])
    assert.equal(copyPythonEntry(keep), true, keep);
  assert.equal(copySitePackagesEntry('pip/__init__.py'), false);
  assert.equal(copySitePackagesEntry('pip-24.0.dist-info/METADATA'), false);
  assert.equal(copySitePackagesEntry('pipdeptree/x.py'), true);
  assert.equal(
    copySitePackagesEntry('torch-2.4.0.dist-info/METADATA'),
    true,
    'dist-info is read by transformers',
  );
  assert.equal(
    copyModelFile('pytorch_model.bin', ['model.safetensors', 'pytorch_model.bin']),
    false,
  );
  assert.equal(
    copyModelFile('pytorch_model.bin', ['pytorch_model.bin']),
    true,
    'the only weights are never dropped',
  );
  assert.equal(copyModelFile('pytorch_model.bin', ['model.safetensors'], true), true);
  assert.equal(copyModelFile('.gitattributes', []), false);
  assert.equal(copyModelEntry('.cache/huggingface/download/x.metadata', []), false);
  assert.equal(
    copyModelEntry('tokenizer/vocab.json', ['tokenizer']),
    true,
    'other sub-folders are kept',
  );
  assert.equal(copyModelEntry('config.json', ['config.json']), true);
});

test("a pack is relocatable: own Python with the venv's packages, service code, models without duplicate weights", async () => {
  const fx = fixture('ok');
  const out = path.join(root, 'out-ok', 'translator');
  const messages = [];
  const manifest = await buildPack({
    serviceDir: fx.service,
    outDir: out,
    systemDir: fx.system,
    log: (m) => messages.push(m),
  });
  // Python from the base install, packages from the venv.
  assert.ok(exists(out, 'python', 'python.exe'));
  assert.ok(exists(out, 'python', 'Lib', 'os.py'));
  assert.ok(exists(out, 'python', 'DLLs', '_ssl.pyd'));
  assert.equal(
    fs.readFileSync(
      path.join(out, 'python', 'Lib', 'site-packages', 'torch', '__init__.py'),
      'utf8',
    ),
    'venv:torch/__init__.py',
  );
  assert.ok(
    exists(
      out,
      'python',
      'Lib',
      'site-packages',
      'torch',
      '__pycache__',
      '__init__.cpython-312.pyc',
    ),
    '.pyc is kept so a read-only install starts fast',
  );
  assert.ok(
    exists(out, 'python', 'Lib', 'site-packages', 'transformers-4.44.2.dist-info', 'METADATA'),
  );
  for (const gone of [
    'Doc',
    'Tools',
    'include',
    'libs',
    'Scripts',
    path.join('Lib', 'test'),
    path.join('Lib', 'idlelib'),
    path.join('Lib', 'turtledemo'),
  ])
    assert.ok(!exists(out, 'python', gone), `${gone} should not be in the pack`);
  assert.ok(!exists(out, 'python', 'Lib', 'site-packages', 'pip'));
  assert.ok(!exists(out, 'python', 'Lib', 'site-packages', 'pip-24.0.dist-info'));
  // Service, requirements; no .env of the build PC.
  assert.ok(exists(out, 'app', 'main.py'));
  assert.ok(exists(out, 'app', '__pycache__', 'main.pyc'));
  assert.ok(exists(out, 'requirements.txt'));
  assert.ok(!exists(out, '.env'), "the build PC's model path must not travel with the pack");
  assert.ok(!exists(out, '.venv'));
  // Modification times survive the copy, so the .pyc files that were compiled from those sources stay valid.
  assert.equal(
    Math.round(
      fs.statSync(path.join(out, 'python', 'Lib', 'site-packages', 'torch', '__init__.py'))
        .mtimeMs / 1000,
    ),
    Math.round(OLD_TIME.getTime() / 1000),
  );
  // Models: weights once.
  for (const direction of ['en-indic', 'indic-en', 'indic-indic']) {
    assert.ok(exists(out, 'models', direction, 'model.safetensors'));
    assert.ok(exists(out, 'models', direction, 'config.json'));
    assert.ok(!exists(out, 'models', direction, 'pytorch_model.bin'), 'duplicate weights skipped');
    assert.ok(!exists(out, 'models', direction, '.gitattributes'));
    assert.ok(!exists(out, 'models', direction, '.cache'), 'downloader bookkeeping is not shipped');
  }
  assert.equal(manifest.keptPytorchBin, false);
  // C++ runtime beside python.exe: copied when missing, not duplicated over the base install's own copy.
  assert.deepEqual(manifest.cppRuntime.sort(), ['msvcp140.dll', 'vcruntime140_1.dll']);
  assert.equal(
    fs.readFileSync(path.join(out, 'python', 'vcruntime140.dll'), 'utf8'),
    'base:vcruntime140.dll',
  );
  assert.equal(
    fs.readFileSync(path.join(out, 'python', 'msvcp140.dll'), 'utf8'),
    'sys:msvcp140.dll',
  );
  // Templates, with Windows line endings for batch files.
  for (const name of TEMPLATE_FILES) assert.ok(exists(out, name), name);
  for (const name of ['Install-Translator.cmd', 'Verify-Translator.cmd', 'Start-Translator.cmd']) {
    const text = fs.readFileSync(path.join(out, name), 'utf8');
    assert.ok(!/[^\r]\n/.test(text), `${name} must use CRLF`);
  }
  // Integrity manifest covers every model file with its real hash.
  const written = JSON.parse(fs.readFileSync(path.join(out, 'pack-manifest.json'), 'utf8'));
  assert.equal(Object.keys(written.models).length, 9);
  assert.equal(written.models['models/en-indic/model.safetensors'].sha256, sha('weights:en-indic'));
  assert.equal(
    written.models['models/en-indic/model.safetensors'].size,
    Buffer.byteLength('weights:en-indic'),
  );
  assert.equal(written.python, '3.12.10');
  // The source was not modified.
  assert.ok(exists(fx.service, 'models', 'en-indic', 'pytorch_model.bin'));
  assert.ok(exists(fx.service, '.env'));
  assert.ok(messages.some((m) => /Copying models/.test(m)));
});

test('--keep-bin keeps both weight files', async () => {
  const fx = fixture('keep');
  const out = path.join(root, 'out-keep', 'translator');
  const manifest = await buildPack({
    serviceDir: fx.service,
    outDir: out,
    systemDir: fx.system,
    keepBin: true,
  });
  assert.ok(exists(out, 'models', 'indic-en', 'pytorch_model.bin'));
  assert.equal(manifest.keptPytorchBin, true);
});
test('a model folder that only has pytorch_model.bin still ships that file', async () => {
  const fx = fixture('binonly', { safetensors: false });
  const out = path.join(root, 'out-binonly', 'translator');
  await buildPack({ serviceDir: fx.service, outDir: out, systemDir: fx.system });
  assert.ok(exists(out, 'models', 'en-indic', 'pytorch_model.bin'));
});
test('refuses to build from an incomplete source and never writes a half pack', async () => {
  const missing = fixture('missing', { skipDirection: 'indic-indic' });
  const out = path.join(root, 'out-missing', 'translator');
  await assert.rejects(
    () => buildPack({ serviceDir: missing.service, outDir: out, systemDir: missing.system }),
    /Model folder is incomplete: .*indic-indic/,
  );
  assert.ok(!fs.existsSync(out), 'nothing is written when validation fails');
  const noVenv = fixture('novenv');
  fs.rmSync(path.join(noVenv.service, '.venv'), { recursive: true });
  await assert.rejects(
    () =>
      buildPack({
        serviceDir: noVenv.service,
        outDir: path.join(root, 'out-novenv'),
        systemDir: noVenv.system,
      }),
    /No virtual environment/,
  );
  const noPython = fixture('nopython');
  fs.rmSync(noPython.python, { recursive: true });
  await assert.rejects(
    () =>
      buildPack({
        serviceDir: noPython.service,
        outDir: path.join(root, 'out-nopython'),
        systemDir: noPython.system,
      }),
    /Python folder .* was not found/,
  );
});
test('never writes into a folder that already has files', async () => {
  const fx = fixture('busy');
  const out = path.join(root, 'out-busy');
  write(path.join(out, 'keep-me.txt'), 'mine');
  await assert.rejects(
    () => buildPack({ serviceDir: fx.service, outDir: out, systemDir: fx.system }),
    /not empty/,
  );
  assert.equal(fs.readFileSync(path.join(out, 'keep-me.txt'), 'utf8'), 'mine');
  assert.ok(!exists(out, 'python'));
});
