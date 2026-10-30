import fs from 'node:fs/promises';
import mammoth from 'mammoth';
import { DocIntelError } from './errors.js';
import { OUTPUT_MIME, withExtension } from './formats.js';
import { findSoffice, sofficeConvert } from './libreoffice.js';
import { blocksToHtml, renderDocument, writeXlsx } from './generation.js';
import { display, toNumber } from './values.js';

/**
 * Conversion registry: explicit source → target pairs, each with the engine it
 * needs and what it cannot preserve. Anything not listed is rejected with a
 * clear message — extensions are never just renamed.
 */

const TEXTY = ['.txt', '.md'];
const SHEETS = ['.xlsx', '.xlsm', '.xls', '.csv', '.tsv'];

/** Block model for a parsed document (used by several converters). */
export function documentBlocks(doc) {
  if (doc.kind === 'pdf') {
    const blocks = [];
    for (const p of doc.pages) {
      blocks.push({ type: 'heading', level: 2, text: `Page ${p.number}` });
      const tablesHere = doc.tables.filter((t) => t.source?.page === p.number);
      const paras = String(p.text || '')
        .split(/\n\s*\n/)
        .map((x) => x.replace(/\s*\n\s*/g, ' ').trim())
        .filter(Boolean);
      if (!paras.length && p.scanned)
        blocks.push({
          type: 'paragraph',
          text: '[Scanned page — no text could be read]',
          italic: true,
        });
      for (const para of paras) blocks.push({ type: 'paragraph', text: para });
      for (const t of tablesHere)
        blocks.push({
          type: 'table',
          columns: t.columns,
          rows: t.rows.map((r) => r.values.map(display)),
        });
    }
    return blocks;
  }
  if (doc.blocks) {
    return doc.blocks.map((b) =>
      b.type === 'list'
        ? { type: 'bullets', items: b.items }
        : b.type === 'table'
          ? { type: 'table', columns: b.columns, rows: b.rows }
          : { type: b.type, level: b.level, text: b.text },
    );
  }
  if (doc.tables.length)
    return doc.tables.flatMap((t) => [
      ...(doc.tables.length > 1 ? [{ type: 'heading', level: 2, text: t.name }] : []),
      { type: 'table', columns: t.columns, rows: t.rows.map((r) => r.values.map(display)) },
    ]);
  return String(doc.text || '')
    .split(/\n{2,}/)
    .filter((x) => x.trim())
    .map((text) => ({ type: 'paragraph', text: text.trim() }));
}

/** CSV/JSON text cells → typed Excel cells (numbers stay text when they carry leading zeros, e.g. PIN codes, IDs). */
function excelValue(v) {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (/^0\d/.test(s) || /^[+]/.test(s) || s.length > 15) return v;
  const n = toNumber(s);
  return n !== null && /^[-(]?[₹$]?[\d,]*\.?\d+\)?$/.test(s.replace(/\s/g, '')) ? n : v;
}

const tableSheets = (doc) =>
  doc.tables.map((t) => ({
    name: t.name,
    columns: t.columns,
    rows: t.rows.map((r) => r.values.map(excelValue)),
  }));

function needTables(doc) {
  if (!doc.tables.length)
    throw new DocIntelError(
      'NO_TABLES',
      `"${doc.name}" has no tables to put in a spreadsheet. Convert it to Word, PDF or text instead.`,
    );
}

const textExpect = (doc) => {
  const words = String(doc.text || '')
    .split(/\n+/)
    .filter((l) => !l.includes('\t')) // table rows: cell spacing differs per format
    .map((l) =>
      l
        .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(
      (l) =>
        l.length >= 12 && /[a-z]/i.test(l) && !/^--- Page \d+ ---$/.test(l) && !/^#+\s/.test(l),
    );
  return {
    contains: [words[0], words[Math.floor(words.length / 2)], words.at(-1)]
      .filter(Boolean)
      .map((s) => s.slice(0, 40)),
  };
};

/**
 * key "<source ext>><target>" → { engine, run(ctx) → [{ name, buffer, ext, expectations }], notes? }
 * ctx = { doc, original: { path } | null, signal, soffice, pdfOptions }
 */
const REGISTRY = new Map();
const reg = (sources, target, def) => sources.forEach((s) => REGISTRY.set(`${s}>${target}`, def));

// ---- PDF ----
reg(['.pdf'], 'txt', {
  engine: 'built-in',
  notes: ['Text only: layout, images and fonts are not kept.'],
  run: async ({ doc }) => [
    {
      ext: 'txt',
      buffer: Buffer.from(
        doc.pages.map((p) => `--- Page ${p.number} ---\n${p.text}`).join('\n\n') + '\n',
        'utf8',
      ),
      expectations: textExpect(doc),
    },
  ],
});
reg(['.pdf'], 'md', {
  engine: 'built-in',
  notes: ['Layout, images and fonts are not kept.'],
  run: async ({ doc }) => [await rendered('md', doc)],
});
reg(['.pdf'], 'docx', {
  engine: 'built-in',
  notes: [
    'PDF → Word keeps the text (page by page) and detected tables. The original layout, columns, images and fonts are not reproduced exactly.',
  ],
  run: async ({ doc }) => [await rendered('docx', doc, { tables: doc.tables.length })],
});
reg(['.pdf'], 'json', {
  engine: 'built-in',
  run: async ({ doc }) => [
    {
      ext: 'json',
      buffer: Buffer.from(
        JSON.stringify(
          {
            file: doc.name,
            pages: doc.pages.map((p) => ({ page: p.number, text: p.text, scanned: p.scanned })),
            tables: doc.tables.map(tableJson),
          },
          null,
          2,
        ),
      ),
      expectations: {},
    },
  ],
});

// ---- Word ----
reg(['.docx', '.doc'], 'pdf', {
  engine: 'libreoffice-or-browser',
  run: async (ctx) => {
    const { doc, original, signal } = ctx;
    const soffice = ctx.soffice === undefined ? findSoffice() : ctx.soffice;
    if (original && soffice) {
      const buffer = await sofficeConvert(original.path, doc.ext, 'pdf', { soffice, signal });
      return [
        {
          ext: 'pdf',
          buffer,
          expectations: textExpect(doc),
          notes: ['Converted with LibreOffice (layout kept as closely as LibreOffice renders it).'],
        },
      ];
    }
    if (doc.ext === '.doc')
      throw new DocIntelError(
        'CONVERTER_MISSING',
        'Legacy .doc files need LibreOffice installed to convert.',
        { status: 503 },
      );
    const out = await rendered('pdf', doc, {}, ctx.pdfOptions);
    out.notes = [
      original
        ? 'LibreOffice is not installed, so the PDF was rebuilt from the document text: headings, lists and tables are kept; fonts, images, columns and exact page breaks are not.'
        : 'The original file is no longer stored, so the PDF was rebuilt from the extracted text: fonts, images and exact layout are not kept.',
    ];
    return [out];
  },
});
reg(['.doc'], 'docx', {
  engine: 'libreoffice',
  run: async ({ doc, original, signal, soffice }) => {
    if (!original)
      throw new DocIntelError(
        'ORIGINAL_MISSING',
        'The original .doc file is no longer stored. Upload it again to convert it.',
        { status: 410 },
      );
    return [
      {
        ext: 'docx',
        buffer: await sofficeConvert(original.path, '.doc', 'docx', {
          soffice: soffice === undefined ? findSoffice() : soffice,
          signal,
        }),
        expectations: textExpect(doc),
      },
    ];
  },
});
reg(['.docx', '.doc'], 'txt', {
  engine: 'built-in',
  notes: ['Text only: formatting and images are not kept.'],
  run: async ({ doc }) => [await rendered('txt', doc)],
});
reg(['.docx', '.doc'], 'md', {
  engine: 'built-in',
  run: async ({ doc }) => [await rendered('md', doc)],
});
reg(['.docx'], 'html', {
  engine: 'built-in',
  notes: ['HTML keeps headings, lists, tables, bold/italic and images; page layout is not kept.'],
  run: async ({ doc, original }) => {
    if (!original) return [await rendered('html', doc)];
    const { value } = await mammoth.convertToHtml({ path: original.path });
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${doc.name.replace(/[<>&"]/g, '')}</title><style>body{font-family:"Segoe UI","Nirmala UI",Arial,sans-serif;max-width:900px;margin:24px auto;line-height:1.5}table{border-collapse:collapse}td,th{border:1px solid #aaa;padding:4px 6px}</style></head><body>${value}</body></html>`;
    return [{ ext: 'html', buffer: Buffer.from(html, 'utf8'), expectations: textExpect(doc) }];
  },
});
reg(['.docx', '.doc'], 'json', {
  engine: 'built-in',
  run: async ({ doc }) => [
    {
      ext: 'json',
      buffer: Buffer.from(
        JSON.stringify(
          {
            file: doc.name,
            metadata: doc.metadata,
            blocks: doc.blocks,
            tables: doc.tables.map(tableJson),
          },
          null,
          2,
        ),
      ),
      expectations: {},
    },
  ],
});

// ---- tables out of PDF / Word ----
for (const src of ['.pdf', '.docx', '.doc']) {
  reg([src], 'xlsx', {
    engine: 'built-in',
    notes:
      src === '.pdf'
        ? ['Tables are reconstructed from text positions in the PDF — check column alignment.']
        : [],
    run: async ({ doc }) => {
      needTables(doc);
      const { buffer } = await writeXlsx({ sheets: tableSheets(doc) });
      return [
        {
          ext: 'xlsx',
          buffer,
          expectations: { sheets: doc.tables.map((t) => ({ rows: t.rows.length })) },
        },
      ];
    },
  });
  reg([src], 'csv', {
    engine: 'built-in',
    run: async ({ doc }) => (needTables(doc), csvOutputs(doc)),
  });
}

// ---- spreadsheets ----
reg(SHEETS, 'csv', {
  engine: 'built-in',
  notes: ['CSV keeps cell values only (no formulas or formatting); one file per sheet.'],
  run: async ({ doc }) => (needTables(doc), csvOutputs(doc)),
});
reg(SHEETS, 'json', {
  engine: 'built-in',
  run: async ({ doc }) => {
    needTables(doc);
    const data =
      doc.tables.length === 1
        ? tableJson(doc.tables[0]).records
        : Object.fromEntries(doc.tables.map((t) => [t.name, tableJson(t).records]));
    return [
      {
        ext: 'json',
        buffer: Buffer.from(JSON.stringify(data, null, 2)),
        expectations: doc.tables.length === 1 ? { records: doc.tables[0].rows.length } : {},
      },
    ];
  },
});
reg(['.csv', '.tsv', '.json', '.xls'], 'xlsx', {
  engine: 'built-in',
  run: async ({ doc }) => {
    needTables(doc);
    const { buffer } = await writeXlsx({ sheets: tableSheets(doc) });
    return [
      {
        ext: 'xlsx',
        buffer,
        expectations: {
          sheets: doc.tables.map((t) => ({ rows: t.rows.length, columns: t.columns })),
        },
      },
    ];
  },
});
reg(SHEETS, 'pdf', {
  engine: 'browser-or-libreoffice',
  notes: [
    'Spreadsheet → PDF is a printable report of the cell values (formulas show their results).',
  ],
  run: async ({ doc }, opts) => [await rendered('pdf', doc, {}, opts?.pdfOptions)],
});
reg(SHEETS, 'docx', {
  engine: 'built-in',
  notes: ['Written as Word tables with the cell values.'],
  run: async ({ doc }) => [await rendered('docx', doc, { tables: doc.tables.length })],
});
reg(SHEETS, 'html', { engine: 'built-in', run: async ({ doc }) => [await rendered('html', doc)] });

// ---- JSON / text ----
reg(['.json'], 'csv', {
  engine: 'built-in',
  run: async ({ doc }) => (needTables(doc), csvOutputs(doc)),
});
for (const target of ['docx', 'pdf', 'html', 'txt', 'md'])
  reg(TEXTY.concat(['.json']), target, {
    engine: target === 'pdf' ? 'browser-or-libreoffice' : 'built-in',
    run: async ({ doc }, opts) => [await rendered(target, doc, {}, opts?.pdfOptions)],
  });

function tableJson(t) {
  return {
    name: t.name,
    columns: t.columns,
    records: t.rows.map((r) =>
      Object.fromEntries(
        t.columns.map((c, i) => [
          c,
          r.values[i] instanceof Date ? display(r.values[i]) : (r.values[i] ?? null),
        ]),
      ),
    ),
  };
}

function csvOutputs(doc) {
  return doc.tables.slice(0, 50).map((t) => ({
    ext: 'csv',
    suffix: doc.tables.length > 1 ? `-${t.name}` : '',
    buffer: Buffer.concat([
      Buffer.from('﻿'),
      Buffer.from(
        [t.columns, ...t.rows.map((r) => r.values.map(display))]
          .map((row) => row.map(csvCell).join(','))
          .join('\r\n') + '\r\n',
        'utf8',
      ),
    ]),
    expectations: { records: t.rows.length },
  }));
}
const csvCell = (v) =>
  /[",\r\n]/.test(String(v)) || /^\s|\s$/.test(String(v))
    ? `"${String(v).replace(/"/g, '""')}"`
    : String(v);

async function rendered(format, doc, expect = {}, pdfOptions) {
  const blocks = documentBlocks(doc);
  const title = doc.metadata?.title || doc.name.replace(/\.[^.]+$/, '');
  const { buffer, notes } = await renderDocument(format, { title, blocks }, pdfOptions);
  const expectations = { ...textExpect(doc), ...expect };
  if (format === 'md' || format === 'txt' || format === 'html') delete expectations.tables;
  return { ext: format, buffer, notes, expectations };
}

/** All supported targets for a source extension. */
export function supportedTargets(ext) {
  return [...REGISTRY.keys()].filter((k) => k.startsWith(`${ext}>`)).map((k) => k.split('>')[1]);
}

export function conversionInfo(ext, target) {
  return REGISTRY.get(`${ext}>${target}`) || null;
}

/**
 * Convert a parsed document. Returns [{ name, buffer, ext, mime, notes[], expectations }].
 * Rejects unsupported pairs and same-format "conversions".
 */
export async function convertDocument({
  doc,
  target,
  original = null,
  signal,
  soffice,
  pdfOptions,
} = {}) {
  const t = String(target || '')
    .toLowerCase()
    .replace(/^\./, '');
  if (`.${t}` === doc.ext || (t === 'xlsx' && doc.ext === '.xlsm'))
    throw new DocIntelError('SAME_FORMAT', `"${doc.name}" is already a ${t.toUpperCase()} file.`);
  const def = conversionInfo(doc.ext, t);
  if (!def) {
    const options = supportedTargets(doc.ext);
    throw new DocIntelError(
      'UNSUPPORTED_CONVERSION',
      `Converting ${doc.ext.slice(1).toUpperCase()} to ${t.toUpperCase() || '?'} is not supported.${options.length ? ` Supported targets for this file: ${options.map((x) => x.toUpperCase()).join(', ')}.` : ''}`,
    );
  }
  if (original) await fs.access(original.path).catch(() => (original = null));
  const outputs = await def.run({ doc, original, signal, soffice, pdfOptions }, { pdfOptions });
  return outputs.map((o) => ({
    ...o,
    name: withExtension(`${doc.name.replace(/\.[^.]+$/, '')}${o.suffix || ''}`, o.ext),
    mime: OUTPUT_MIME[o.ext],
    notes: [...(def.notes || []), ...(o.notes || [])],
    warnings: doc.warnings,
  }));
}

export { blocksToHtml };
