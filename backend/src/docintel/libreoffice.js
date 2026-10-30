import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { DocIntelError } from './errors.js';
import { LIMITS } from './formats.js';

/**
 * LibreOffice headless, used only through a fixed allowlist of conversions.
 * Never downloaded at runtime: it is used when already installed (or when
 * CHANAKYA_SOFFICE points at soffice). Arguments are fixed; only validated
 * file paths inside a private temp directory are passed; no shell is used.
 * Macros are disabled through a throwaway user profile with security level 3.
 */

// target extension → LibreOffice --convert-to filter
const FILTERS = Object.freeze({
  pdf: 'pdf',
  // Passed as one argv entry (no shell), so filter names are NOT quoted.
  docx: 'docx:MS Word 2007 XML',
  xlsx: 'xlsx:Calc MS Excel 2007 XML',
  txt: 'txt:Text',
  html: 'html',
  csv: 'csv:Text - txt - csv (StarCalc):44,34,76,1',
});

// (source → target) pairs LibreOffice is trusted with here.
export const SOFFICE_PAIRS = Object.freeze(
  new Set([
    '.docx>pdf',
    '.doc>docx',
    '.doc>pdf',
    '.xls>xlsx',
    '.xlsx>pdf',
    '.xlsm>pdf',
    '.csv>pdf',
    '.html>pdf',
    '.xlsx>recalc', // recalculation: xlsx → xlsx via Calc
  ]),
);

export function findSoffice(
  env = process.env,
  exists = fsSync.existsSync,
  platform = process.platform,
) {
  if (env.CHANAKYA_SOFFICE) return exists(env.CHANAKYA_SOFFICE) ? env.CHANAKYA_SOFFICE : null;
  const candidates = [];
  if (platform === 'win32') {
    for (const root of [
      env.ProgramFiles,
      env['ProgramFiles(x86)'],
      'C:\\Program Files',
      'C:\\Program Files (x86)',
    ].filter(Boolean))
      candidates.push(path.win32.join(root, 'LibreOffice', 'program', 'soffice.exe'));
  } else if (platform === 'darwin') {
    candidates.push('/Applications/LibreOffice.app/Contents/MacOS/soffice');
  } else {
    candidates.push(
      '/usr/bin/soffice',
      '/usr/lib/libreoffice/program/soffice',
      '/opt/libreoffice/program/soffice',
      '/usr/bin/libreoffice',
    );
  }
  return candidates.find((c) => exists(c)) || null;
}

const SECURITY_XCU = `<?xml version="1.0" encoding="UTF-8"?>
<oor:items xmlns:oor="http://openoffice.org/2001/registry" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="DisableMacrosExecution" oor:op="fuse"><value>true</value></prop></item>
<item oor:path="/org.openoffice.Office.Common/Misc"><prop oor:name="UseLocking" oor:op="fuse"><value>false</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
<item oor:path="/org.openoffice.Office.Writer/Content/Update"><prop oor:name="Link" oor:op="fuse"><value>2</value></prop></item>
__RECALC__</oor:items>`;

// Recalculate every formula on load (only for the explicit 'recalc' operation on formula-checked workbooks).
const RECALC_XCU = `<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="OOXMLRecalcMode" oor:op="fuse"><value>0</value></prop></item>
<item oor:path="/org.openoffice.Office.Calc/Formula/Load"><prop oor:name="ODFRecalcMode" oor:op="fuse"><value>0</value></prop></item>
`;

/**
 * Converts `inputPath` to `target` and returns the output bytes.
 * @param {string} inputPath file inside a directory the caller controls
 * @param {string} sourceExt e.g. '.docx'
 * @param {string} target e.g. 'pdf' | 'recalc'
 */
export async function sofficeConvert(
  inputPath,
  sourceExt,
  target,
  { soffice = findSoffice(), timeoutMs = LIMITS.convertTimeoutMs, signal, spawnImpl = spawn } = {},
) {
  const pair = `${sourceExt}>${target}`;
  if (!SOFFICE_PAIRS.has(pair))
    throw new DocIntelError(
      'UNSUPPORTED_CONVERSION',
      `Conversion ${sourceExt} → ${target} is not allowed.`,
    );
  if (!soffice)
    throw new DocIntelError(
      'CONVERTER_MISSING',
      'This conversion needs LibreOffice installed on this PC (it runs fully offline). Install LibreOffice, or set CHANAKYA_SOFFICE to soffice.exe, then retry.',
      { status: 503 },
    );
  const outExt = target === 'recalc' ? 'xlsx' : target;
  const filter = target === 'recalc' ? FILTERS.xlsx : FILTERS[target];
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-soffice-'));
  try {
    const inDir = path.join(work, 'in');
    const outDir = path.join(work, 'out');
    const profile = path.join(work, 'profile');
    await fs.mkdir(inDir);
    await fs.mkdir(outDir);
    await fs.mkdir(path.join(profile, 'user'), { recursive: true });
    await fs.writeFile(
      path.join(profile, 'user', 'registrymodifications.xcu'),
      SECURITY_XCU.replace('__RECALC__', target === 'recalc' ? RECALC_XCU : ''),
    );
    // 'recalc' writes xlsx → xlsx; a distinct input name keeps LibreOffice from overwriting its own input.
    const input = path.join(inDir, `input${sourceExt}`);
    await fs.copyFile(inputPath, input);
    const args = [
      '--headless',
      '--invisible',
      '--nologo',
      '--norestore',
      '--nolockcheck',
      '--nodefault',
      `-env:UserInstallation=${pathToFileURL(profile).href}`,
      '--convert-to',
      filter,
      '--outdir',
      outDir,
      input,
    ];
    await new Promise((resolve, reject) => {
      let settled = false;
      const child = spawnImpl(soffice, args, {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe'],
        shell: false,
      });
      let stderr = '';
      child.stderr?.on('data', (d) => (stderr = (stderr + d).slice(-2000)));
      const done = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', abort);
        error ? reject(error) : resolve();
      };
      const kill = () => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* exited */
        }
      };
      const abort = () => {
        kill();
        done(new DocIntelError('CANCELLED', 'The conversion was cancelled.', { status: 499 }));
      };
      const timer = setTimeout(() => {
        kill();
        done(
          new DocIntelError('TIMEOUT', 'The conversion took too long and was stopped.', {
            status: 504,
          }),
        );
      }, timeoutMs);
      signal?.addEventListener?.('abort', abort, { once: true });
      child.on('error', () =>
        done(
          new DocIntelError('CONVERTER_FAILED', 'LibreOffice could not be started.', {
            status: 503,
          }),
        ),
      );
      child.on('close', (code) =>
        code === 0
          ? done()
          : done(
              new DocIntelError(
                'CONVERTER_FAILED',
                `LibreOffice could not convert this file (exit ${code}).`,
                { status: 422, details: { stderr: stderr.slice(-300) } },
              ),
            ),
      );
    });
    const produced = (await fs.readdir(outDir)).find((n) => n.toLowerCase().endsWith(`.${outExt}`));
    if (!produced)
      throw new DocIntelError(
        'CONVERTER_FAILED',
        'LibreOffice finished but produced no output file.',
        { status: 422 },
      );
    const data = await fs.readFile(path.join(outDir, produced));
    if (!data.length)
      throw new DocIntelError('CONVERTER_FAILED', 'LibreOffice produced an empty file.', {
        status: 422,
      });
    return data;
  } finally {
    fs.rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
