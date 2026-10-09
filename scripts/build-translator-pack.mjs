#!/usr/bin/env node
/**
 * Builds the offline translator pack on the PC where the translator already works (indictrans-service\.venv and
 * models\ present). Read-only on the source; writes only to a fresh output folder.
 *
 *   node scripts/build-translator-pack.mjs [--out=<folder>] [--keep-bin] [--skip-verify]
 *
 * Default output: <repo>\translator-pack\<timestamp>\translator   (copy THAT folder to the other PC).
 * After copying, the script runs the pack's own self-test from the new location with the pack's own Python.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildPack } from './translatorPack.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const option = (name) => args.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
const serviceDir = path.resolve(option('service-dir') || path.join(repo, 'indictrans-service'));
const outDir = path.resolve(
  option('out') || path.join(repo, 'translator-pack', stamp, 'translator'),
);

console.log(`Source : ${serviceDir}\nOutput : ${outDir}\n`);
try {
  const manifest = await buildPack({
    serviceDir,
    outDir,
    keepBin: args.includes('--keep-bin'),
    log: (message) => console.log(message),
  });
  console.log(`\nPack written: ${manifest.files} files, ${(manifest.bytes / 1e9).toFixed(2)} GB.`);
  if (manifest.keptPytorchBin) console.log('(pytorch_model.bin was kept)');
  if (!manifest.cppRuntime.length)
    console.log(
      "NOTE: no Microsoft C++ runtime DLLs were found to include; a very clean PC may need the 'Microsoft Visual C++ 2015-2022 Redistributable (x64)'.",
    );
  if (args.includes('--skip-verify')) {
    console.log('Self-test skipped. Run Verify-Translator.cmd in the pack before trusting it.');
  } else {
    console.log("\nRunning the pack's own self-test from the new folder (1-3 minutes)...\n");
    const python = path.join(outDir, 'python', 'python.exe');
    const done = spawnSync(python, [path.join(outDir, 'selftest.py')], {
      cwd: outDir,
      stdio: 'inherit',
      env: { ...process.env, PYTHONNOUSERSITE: '1' },
    });
    process.exitCode = done.status ?? 1;
    console.log(
      done.status === 0
        ? `\nSelf-test passed on THIS PC. Copy this folder to the other PC:\n  ${outDir}\nThen follow README.txt inside it.`
        : '\nSelf-test did NOT pass. Do not copy this pack; send the lines above.',
    );
  }
} catch (error) {
  console.error(`\n[X] ${error.userFacing ? error.message : error.stack || error}`);
  process.exitCode = 1;
}
