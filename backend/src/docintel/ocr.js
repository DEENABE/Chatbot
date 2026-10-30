import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DocIntelError } from './errors.js';

/**
 * Local OCR for scanned PDF pages. Fully offline:
 *   - page images come from Poppler's `pdftoppm` when it is installed
 *     (CHANAKYA_PDFTOPPM, PATH, or C:\Program Files\poppler*), otherwise from
 *     JPEG page images embedded in the PDF (typical for scanner output);
 *   - text comes from tesseract.js with language data already on this PC
 *     (backend/storage/ocr/<lang>.traineddata[.gz]). Nothing is downloaded.
 * Returns { pages: [{ page, text, confidence }], engine, reason? }.
 */

const MAX_OCR_PAGES = Number(process.env.DOCINTEL_MAX_OCR_PAGES || 30);

export function findPdftoppm(
  env = process.env,
  exists = fsSync.existsSync,
  platform = process.platform,
) {
  if (env.CHANAKYA_PDFTOPPM) return exists(env.CHANAKYA_PDFTOPPM) ? env.CHANAKYA_PDFTOPPM : null;
  const exe = platform === 'win32' ? 'pdftoppm.exe' : 'pdftoppm';
  const dirs = String(env.PATH || env.Path || '')
    .split(platform === 'win32' ? ';' : ':')
    .filter(Boolean);
  if (platform === 'win32') {
    for (const root of [env.ProgramFiles, env['ProgramFiles(x86)'], 'C:\\Program Files'].filter(
      Boolean,
    )) {
      let names = [];
      try {
        names = fsSync.readdirSync(root).filter((n) => /^poppler/i.test(n));
      } catch {
        /* not listable */
      }
      for (const n of names)
        dirs.push(path.win32.join(root, n, 'Library', 'bin'), path.win32.join(root, n, 'bin'));
    }
  }
  for (const d of dirs) {
    const candidate = path.join(d, exe);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/** Languages whose trained data is present locally. */
export function localOcrLanguages(dir) {
  const langs = [];
  for (const lang of ['eng', 'tam']) {
    if (
      fsSync.existsSync(path.join(dir, `${lang}.traineddata.gz`)) ||
      fsSync.existsSync(path.join(dir, `${lang}.traineddata`))
    )
      langs.push(lang);
  }
  return langs;
}

function run(cmd, args, { timeoutMs = 120_000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-1000)));
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener?.('abort', abort, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', abort);
      code === 0 ? resolve() : reject(new Error(`exit ${code}: ${stderr.slice(-200)}`));
    });
  });
}

/** PNG buffers for the given 1-based pages using pdftoppm. */
async function rasterizeWithPoppler(pdftoppm, bytes, pages, signal) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-ocr-'));
  try {
    const input = path.join(dir, 'in.pdf');
    await fs.writeFile(input, bytes);
    const images = new Map();
    for (const n of pages) {
      const prefix = path.join(dir, `p${n}`);
      await run(
        pdftoppm,
        ['-r', '200', '-f', String(n), '-l', String(n), '-png', '-singlefile', input, prefix],
        { signal },
      );
      images.set(n, await fs.readFile(`${prefix}.png`));
    }
    return images;
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * JPEG (DCTDecode) image streams in file order. Scanner PDFs store one
 * full-page JPEG per page; the mapping to pages is only trusted when the
 * number of large JPEGs equals the number of pages.
 */
export function embeddedJpegs(bytes) {
  const buf = Buffer.from(bytes);
  const text = buf.toString('latin1');
  const out = [];
  const re =
    /<<((?:(?!>>\s*stream)[\s\S]){0,2000}?\/Subtype\s*\/Image[\s\S]{0,2000}?)>>\s*stream\r?\n/g;
  let m;
  while ((m = re.exec(text))) {
    const dict = m[1];
    if (
      !/\/DCTDecode/.test(dict) ||
      /\/(?:FlateDecode|LZWDecode|ASCII85Decode|ASCIIHexDecode)/.test(dict)
    )
      continue;
    const width = Number(dict.match(/\/Width\s+(\d+)/)?.[1] || 0);
    const height = Number(dict.match(/\/Height\s+(\d+)/)?.[1] || 0);
    const start = m.index + m[0].length;
    const length = Number(dict.match(/\/Length\s+(\d+)(?!\s+\d+\s+R)/)?.[1] || 0);
    let end = length ? start + length : text.indexOf('endstream', start);
    if (end < 0) continue;
    const data = buf.subarray(start, end);
    if (data[0] !== 0xff || data[1] !== 0xd8) continue;
    out.push({ width, height, data });
    re.lastIndex = end;
  }
  return out.filter((j) => j.width >= 300 && j.height >= 300);
}

let workerPromise = null;
let workerLangs = '';

async function getWorker(langs, dir) {
  const key = langs.join('+');
  if (workerPromise && workerLangs === key) return workerPromise;
  if (workerPromise) (await workerPromise.catch(() => null))?.terminate?.().catch(() => {});
  workerLangs = key;
  workerPromise = (async () => {
    const { createWorker } = await import('tesseract.js');
    const gz = langs.every((l) => fsSync.existsSync(path.join(dir, `${l}.traineddata.gz`)));
    return createWorker(key, 1, {
      langPath: dir,
      cachePath: path.join(os.tmpdir(), 'chanakya-ocr-cache'),
      gzip: gz,
      cacheMethod: 'none',
      logger: () => {},
    });
  })();
  workerPromise.catch(() => (workerPromise = null));
  return workerPromise;
}

export async function terminateOcr() {
  if (!workerPromise) return;
  const w = await workerPromise.catch(() => null);
  workerPromise = null;
  await w?.terminate?.().catch(() => {});
}

/**
 * Factory: returns an `ocr(bytes, pageNumbers, { totalPages })` function for parseDocument.
 * @param {{ langDir: string, pdftoppm?: string|null, recognize?: Function }} options
 */
export function createPdfOcr({ langDir, pdftoppm = findPdftoppm(), recognize } = {}) {
  return async function ocr(bytes, scannedPages, { totalPages, signal } = {}) {
    const langs = localOcrLanguages(langDir);
    if (!langs.length)
      return {
        pages: [],
        reason: `no OCR language data in ${path.basename(langDir)} (needs eng.traineddata)`,
      };
    const wanted = scannedPages.slice(0, MAX_OCR_PAGES);
    let images = new Map();
    let engine;
    if (pdftoppm) {
      images = await rasterizeWithPoppler(pdftoppm, bytes, wanted, signal);
      engine = 'pdftoppm+tesseract';
    } else {
      const jpegs = embeddedJpegs(bytes);
      if (!jpegs.length || jpegs.length !== totalPages)
        return {
          pages: [],
          reason:
            'the page images could not be extracted. Install Poppler (pdftoppm) for OCR of this PDF, or set CHANAKYA_PDFTOPPM',
        };
      for (const n of wanted) images.set(n, jpegs[n - 1].data);
      engine = 'embedded-jpeg+tesseract';
    }
    const recog =
      recognize ||
      (async (image) => {
        const worker = await getWorker(langs, langDir);
        const { data } = await worker.recognize(image);
        return { text: data.text || '', confidence: Number(data.confidence) || 0 };
      });
    const pages = [];
    for (const n of wanted) {
      if (signal?.aborted) throw new DocIntelError('CANCELLED', 'Cancelled.', { status: 499 });
      const r = await recog(images.get(n));
      pages.push({ page: n, text: r.text.trim(), confidence: Math.round(r.confidence) });
    }
    const reason =
      scannedPages.length > wanted.length
        ? `only the first ${wanted.length} scanned pages are OCR'd`
        : undefined;
    return { pages, engine, languages: langs, ...(reason ? { reason } : {}) };
  };
}
