// Turns one uploaded file into { text, chunks, tables } ready for indexing.
//   XLSX / CSV → tables (every row kept) + self-describing row chunks
//   DOCX       → text chunks + any tables inside the document
//   PDF        → page-tagged chunks ("[Page 3] ...") so answers can cite pages
//   TXT / MD   → text chunks
import fs from 'node:fs/promises';
import path from 'node:path';
import pdf from 'pdf-parse';
import { chunkText } from '../lib/chunkText.js';
import { ValidationError } from '../lib/validate.js';
import {
  assertFileContentMatchesExtension,
  extractDocument,
  isDocIntelOnlyFormat,
} from '../services/documentService.js';
import {
  buildTable,
  formatValue,
  parseDocxTables,
  parseSpreadsheet,
  tableToChunks,
} from './tableParser.js';
import { parseDocument } from '../docintel/parser.js';
import { DocIntelError } from '../docintel/errors.js';
import { pdfOcr } from '../docintel/runtime.js';

/** XLSM / XLS / TSV / JSON / DOC (and OCR for scanned PDFs) through the Document Intelligence parser. */
async function prepareWithDocIntel(file, { ocr } = {}) {
  let doc;
  try {
    doc = await parseDocument(file.path, file.originalname, { mime: file.mimetype, ocr });
  } catch (error) {
    if (error instanceof DocIntelError) throw new ValidationError(error.message);
    throw error;
  }
  const name = file.originalname;
  const tables = doc.tables
    .map((t) => buildTable(t.name, [t.columns, ...t.rows.map((r) => r.values.map(formatValue))]))
    .filter(Boolean);
  if (doc.pages) {
    const chunks = [];
    doc.pages.forEach((p) => {
      for (const chunk of chunkText(p.text || '')) chunks.push(`[Page ${p.number}] ${chunk}`);
    });
    return {
      text: doc.pages.map((p) => p.text).join('\n\n'),
      chunks,
      tables: [],
      warnings: doc.warnings,
    };
  }
  const chunks =
    tables.length && doc.kind !== 'word'
      ? tables.flatMap((t) => tableToChunks(name, t))
      : [...chunkText(doc.text), ...tables.flatMap((t) => tableToChunks(name, t))];
  return { text: doc.text, chunks, tables, warnings: doc.warnings };
}

async function extractPdfPages(filePath) {
  const pages = [];
  // Same text assembly as pdf-parse's default renderer, but kept per page.
  const pagerender = async (pageData) => {
    const content = await pageData.getTextContent({
      normalizeWhitespace: false,
      disableCombineTextItems: false,
    });
    let lastY;
    let text = '';
    for (const item of content.items) {
      if (lastY === item.transform[5] || lastY === undefined) text += item.str;
      else text += `\n${item.str}`;
      lastY = item.transform[5];
    }
    pages.push(text);
    return text;
  };
  // pdf-parse's bundled PDF.js assumes TypedArray slice copies bytes. Node
  // Buffer.slice returns a shared view; that corrupts xref processing on
  // current Node/Electron runtimes and reports "bad XRef entry" for valid PDFs.
  const bytes = Uint8Array.from(await fs.readFile(filePath));
  const result = await pdf(bytes, { pagerender });
  return pages.length ? pages : [result.text || ''];
}

export async function prepareDocument(file) {
  const extension = path.extname(file.originalname).toLowerCase();
  const name = file.originalname;
  if (isDocIntelOnlyFormat(name)) return prepareWithDocIntel(file);

  if (extension === '.xlsx' || extension === '.csv') {
    await assertFileContentMatchesExtension(file.path, extension);
    const tables = await parseSpreadsheet(file.path, extension);
    if (tables.length) {
      const chunks = tables.flatMap((table) => tableToChunks(name, table));
      return {
        text: chunks.join('\n\n'),
        chunks,
        tables,
      };
    }
    // No tabular structure found (e.g. a notes-only sheet) → plain text.
    const text = await extractDocument(file);
    return { text, chunks: chunkText(text), tables: [] };
  }

  if (extension === '.pdf') {
    await assertFileContentMatchesExtension(file.path, extension);
    const pages = await extractPdfPages(file.path);
    const chunks = [];
    pages.forEach((pageText, index) => {
      for (const chunk of chunkText(pageText)) chunks.push(`[Page ${index + 1}] ${chunk}`);
    });
    const text = pages.join('\n\n');
    if (!text.trim()) {
      // Scanned / image-only PDF: local OCR (offline) when page images and language data are available.
      const ocrResult = await prepareWithDocIntel(file, { ocr: pdfOcr });
      if (ocrResult.text.trim()) return ocrResult;
      throw new ValidationError(
        `No extractable text (scanned/image-only PDF). ${(ocrResult.warnings || []).find((w) => /scanned|OCR/i.test(w)) || ''}`.trim(),
      );
    }
    return { text, chunks, tables: [] };
  }

  if (extension === '.docx') {
    const text = await extractDocument(file);
    let tables = [];
    try {
      tables = await parseDocxTables(file.path);
    } catch (error) {
      console.error(`[docqa] ${name}: table extraction failed:`, error.message);
    }
    const chunks = [...chunkText(text), ...tables.flatMap((table) => tableToChunks(name, table))];
    return { text, chunks, tables };
  }

  const text = await extractDocument(file);
  return { text, chunks: chunkText(text), tables: [] };
}
