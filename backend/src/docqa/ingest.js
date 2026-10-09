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
import { assertFileContentMatchesExtension, extractDocument } from '../services/documentService.js';
import { parseDocxTables, parseSpreadsheet, tableToChunks } from './tableParser.js';

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
    if (!text.trim()) throw new ValidationError('No extractable text (scanned/image-only PDF?).');
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
