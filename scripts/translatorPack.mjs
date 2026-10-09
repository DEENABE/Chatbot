/**
 * Builds a relocatable "translator pack": the IndicTrans2 service, its own Python with every package it needs, and
 * the three model folders, in ONE folder that can be copied to another Windows PC next to the application. That PC
 * then needs no Python and no internet. Nothing in the source folders is modified or deleted; the pack is written to a
 * fresh output folder only.
 *
 * Why not inside the installer: the weights alone are about 3.3 GB and NSIS installers are limited to roughly 2 GB, so
 * the pack travels beside the installer (or beside the unpacked app) and the app finds it at start-up
 * (backend/src/services/indictransProcess.js).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const DIRECTIONS = ['en-indic', 'indic-en', 'indic-indic'];
const TEMPLATE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'translator-pack');
export const TEMPLATE_FILES = [
  'selftest.py',
  'Install-Translator.cmd',
  'Verify-Translator.cmd',
  'Start-Translator.cmd',
  'README.txt',
];
/** Microsoft's redistributable C++ runtime DLLs torch needs; copied beside python.exe so a clean PC does not need the installer. */
export const VC_RUNTIME_DLLS = [
  'vcruntime140.dll',
  'vcruntime140_1.dll',
  'msvcp140.dll',
  'msvcp140_1.dll',
  'msvcp140_2.dll',
  'concrt140.dll',
];

const posix = (value) => value.split(path.sep).join('/');

export function parsePyvenvCfg(text) {
  const values = {};
  for (const line of String(text).split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/);
    if (match) values[match[1].toLowerCase()] = match[2];
  }
  return { home: values.home || null, version: values.version || null };
}

const PYTHON_SKIP_DIRS = [
  'doc',
  'tools',
  'include',
  'libs',
  'scripts',
  'lib/test',
  'lib/idlelib',
  'lib/turtledemo',
  'lib/site-packages',
];
/** @param {string} relative path inside the base Python folder, "/"-separated. */
export function copyPythonEntry(relative) {
  const lower = relative.toLowerCase();
  return !PYTHON_SKIP_DIRS.some((dir) => lower === dir || lower.startsWith(`${dir}/`));
}
/** pip is not needed to run the service; everything else in site-packages stays (dist-info is read by transformers). */
export function copySitePackagesEntry(relative) {
  const top = relative.split('/')[0].toLowerCase();
  return !(top === 'pip' || top.startsWith('pip-'));
}
/** The duplicate pytorch_model.bin is skipped when model.safetensors is present (about 3.3 GB saved). */
export function copyModelFile(name, siblings, keepBin = false) {
  if (name === '.gitattributes') return false;
  if (name === 'pytorch_model.bin' && !keepBin && siblings.includes('model.safetensors'))
    return false;
  return true;
}

/** @param {string} relative path inside one model folder, "/"-separated. */
export function copyModelEntry(relative, siblings, keepBin = false) {
  // `.cache/huggingface` only holds the downloader's bookkeeping.
  if (relative.startsWith('.cache/')) return false;
  return relative.includes('/') ? true : copyModelFile(relative, siblings, keepBin);
}

async function* walk(root, relative = '') {
  const entries = await fs.promises.readdir(path.join(root, relative), { withFileTypes: true });
  for (const entry of entries) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(root, child);
    else if (entry.isFile()) yield child;
  }
}

async function plan(root, accept, target) {
  const files = [];
  for await (const relative of walk(root)) {
    if (!accept(relative)) continue;
    const source = path.join(root, ...relative.split('/'));
    const stat = await fs.promises.stat(source);
    files.push({
      source,
      target: path.join(target, ...relative.split('/')),
      size: stat.size,
      mtime: stat.mtime,
    });
  }
  return files;
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function copyAll(files, log, label) {
  let done = 0;
  for (const file of files) {
    await fs.promises.mkdir(path.dirname(file.target), { recursive: true });
    await fs.promises.copyFile(file.source, file.target, fs.constants.COPYFILE_EXCL);
    // A .pyc records the time of the source it was compiled from; keeping that time means the copied bytecode stays
    // valid, so a read-only install (Program Files) does not recompile torch on every start.
    if (file.mtime) await fs.promises.utimes(file.target, file.mtime, file.mtime);
    done += 1;
    if (done % 2000 === 0) log(`  ${label}: ${done}/${files.length} files`);
  }
}

const fail = (message) => Object.assign(new Error(message), { userFacing: true });

/**
 * @param {object} options
 * @param {string} options.serviceDir   the indictrans-service folder (needs app/, models/, .venv/)
 * @param {string} options.outDir       a folder that does not exist yet or is empty
 * @param {string} [options.pythonHome] base Python folder; default: `home` from .venv/pyvenv.cfg
 * @param {string} [options.systemDir]  where the C++ runtime DLLs are (default %SystemRoot%\System32)
 * @param {boolean} [options.keepBin]   keep pytorch_model.bin even when model.safetensors exists
 */
export async function buildPack({
  serviceDir,
  outDir,
  pythonHome,
  systemDir = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32') : '',
  keepBin = false,
  log = () => {},
}) {
  const venv = path.join(serviceDir, '.venv');
  const config = parsePyvenvCfg(
    await fs.promises.readFile(path.join(venv, 'pyvenv.cfg'), 'utf8').catch(() => {
      throw fail(
        `No virtual environment at ${venv}. Run indictrans-service\\setup-translator.cmd on this PC first.`,
      );
    }),
  );
  pythonHome ||= config.home;
  if (!pythonHome || !fs.existsSync(path.join(pythonHome, 'Lib', 'os.py')))
    throw fail(
      `The Python folder named by the virtual environment was not found: ${pythonHome || '(none)'}`,
    );
  const sitePackages = path.join(venv, 'Lib', 'site-packages');
  if (!fs.existsSync(sitePackages)) throw fail(`No packages found at ${sitePackages}.`);
  if (!fs.existsSync(path.join(serviceDir, 'app', 'main.py')))
    throw fail(`The service code is missing: ${path.join(serviceDir, 'app', 'main.py')}`);
  for (const direction of DIRECTIONS) {
    const dir = path.join(serviceDir, 'models', direction);
    const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
    if (
      !names.includes('config.json') ||
      !(names.includes('model.safetensors') || names.includes('pytorch_model.bin'))
    )
      throw fail(`Model folder is incomplete: ${dir} (needs config.json and model.safetensors).`);
  }
  if (fs.existsSync(outDir) && fs.readdirSync(outDir).length)
    throw fail(
      `The output folder is not empty: ${outDir}. A pack is always written to a fresh folder.`,
    );

  log('Planning files...');
  const pythonFiles = await plan(pythonHome, copyPythonEntry, path.join(outDir, 'python'));
  const packageFiles = await plan(
    sitePackages,
    copySitePackagesEntry,
    path.join(outDir, 'python', 'Lib', 'site-packages'),
  );
  const appFiles = await plan(path.join(serviceDir, 'app'), () => true, path.join(outDir, 'app'));
  const modelFiles = [];
  for (const direction of DIRECTIONS) {
    const root = path.join(serviceDir, 'models', direction);
    const siblings = fs.readdirSync(root);
    modelFiles.push(
      ...(await plan(
        root,
        (relative) => copyModelEntry(relative, siblings, keepBin),
        path.join(outDir, 'models', direction),
      )),
    );
  }
  const extra = [];
  if (fs.existsSync(path.join(serviceDir, 'requirements.txt')))
    extra.push({
      source: path.join(serviceDir, 'requirements.txt'),
      target: path.join(outDir, 'requirements.txt'),
      size: 0,
    });
  const runtime = [];
  for (const name of VC_RUNTIME_DLLS) {
    const source = systemDir ? path.join(systemDir, name) : '';
    const target = path.join(outDir, 'python', name);
    if (source && fs.existsSync(source) && !pythonFiles.some((file) => file.target === target))
      runtime.push({ source, target, size: fs.statSync(source).size });
  }
  const all = [...pythonFiles, ...packageFiles, ...appFiles, ...modelFiles, ...extra, ...runtime];
  const totalBytes = all.reduce((sum, file) => sum + file.size, 0);
  log(`${all.length} files, ${(totalBytes / 1e9).toFixed(2)} GB to copy.`);

  await fs.promises.mkdir(outDir, { recursive: true });
  try {
    const stats = await fs.promises.statfs(outDir);
    const free = Number(stats.bavail) * Number(stats.bsize);
    if (free < totalBytes * 1.05)
      throw fail(
        `Not enough free disk space: need about ${((totalBytes * 1.05) / 1e9).toFixed(1)} GB, have ${(free / 1e9).toFixed(1)} GB at ${outDir}.`,
      );
  } catch (error) {
    if (error.userFacing) throw error;
    log('(free disk space could not be checked)');
  }

  for (const [label, files] of [
    ['Python', pythonFiles],
    ['packages', packageFiles],
    ['service code', appFiles],
    ['models', modelFiles],
    ['requirements', extra],
    ['C++ runtime', runtime],
  ]) {
    log(`Copying ${label} (${files.length} files)...`);
    await copyAll(files, log, label);
  }

  const templateNames = [];
  for (const name of TEMPLATE_FILES) {
    const source = path.join(TEMPLATE_DIR, name);
    let text = await fs.promises.readFile(source, 'utf8');
    // Windows batch files need CRLF line endings (labels and goto misbehave with bare LF).
    if (/\.cmd$/i.test(name) || /\.txt$/i.test(name)) text = text.replace(/\r?\n/g, '\r\n');
    await fs.promises.writeFile(path.join(outDir, name), text);
    templateNames.push(name);
  }

  log('Hashing model files for the integrity manifest...');
  const models = {};
  for (const file of modelFiles) {
    const relative = posix(path.relative(outDir, file.target));
    models[relative] = { size: file.size, sha256: await sha256File(file.target) };
  }
  const manifest = {
    createdAt: new Date().toISOString(),
    builtOn: process.platform,
    python: config.version,
    files: all.length + templateNames.length,
    bytes: totalBytes,
    keptPytorchBin: modelFiles.some((file) => path.basename(file.target) === 'pytorch_model.bin'),
    cppRuntime: runtime.map((file) => path.basename(file.target)),
    models,
  };
  await fs.promises.writeFile(
    path.join(outDir, 'pack-manifest.json'),
    JSON.stringify(manifest, null, 2),
  );
  return manifest;
}
