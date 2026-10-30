import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { zip } from './writers.js';

/**
 * Word (.docx) and PDF generation from a small block model:
 *   { type: 'heading', level: 1-3, text } | { type: 'paragraph', text }
 *   { type: 'bullets', items: string[] } | { type: 'table', columns, rows }
 * DOCX is written directly (no dependency). PDF is printed by the Chromium
 * engine of Microsoft Edge (installed on Windows 10/11) so Tamil and other
 * complex scripts are shaped correctly.
 */

// ---------- Markdown → blocks ----------
export function markdownToBlocks(markdown) {
  const blocks = [];
  const lines = String(markdown || '').replace(/\r/g, '').split('\n');
  let para = [];
  let bullets = null;
  const flushPara = () => {
    if (para.length) blocks.push({ type: 'paragraph', text: para.join(' ').trim() });
    para = [];
  };
  const flushBullets = () => {
    if (bullets?.length) blocks.push({ type: 'bullets', items: bullets });
    bullets = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      flushPara();
      flushBullets();
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      flushBullets();
      blocks.push({ type: 'heading', level: Math.min(3, heading[1].length), text: heading[2].trim() });
      continue;
    }
    const boldHeading = trimmed.match(/^\*\*([^*]{2,80})\*\*:?$/);
    if (boldHeading) {
      flushPara();
      flushBullets();
      blocks.push({ type: 'heading', level: 3, text: boldHeading[1].trim() });
      continue;
    }
    if (/^\|.*\|$/.test(trimmed) && /^\|?\s*:?-{2,}/.test(lines[i + 1]?.trim() || '')) {
      flushPara();
      flushBullets();
      const split = (l) =>
        l
          .trim()
          .replace(/^\||\|$/g, '')
          .split(/(?<!\\)\|/)
          .map((c) => c.replace(/\\\|/g, '|').trim());
      const columns = split(trimmed);
      const rows = [];
      i += 2;
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) rows.push(split(lines[i++]));
      i--;
      blocks.push({ type: 'table', columns, rows });
      continue;
    }
    const bullet = trimmed.match(/^(?:[-*•]|\d+[.)])\s+(.*)$/);
    if (bullet) {
      flushPara();
      (bullets ||= []).push(bullet[1]);
      continue;
    }
    if (/^_.*_$/.test(trimmed) || /^---+$/.test(trimmed)) {
      flushPara();
      flushBullets();
      if (!/^---+$/.test(trimmed)) blocks.push({ type: 'paragraph', text: trimmed.slice(1, -1), italic: true });
      continue;
    }
    flushBullets();
    para.push(trimmed);
  }
  flushPara();
  flushBullets();
  return blocks;
}

/** Inline **bold** segments → [{text, bold}] (links and code shown as plain text). */
function runs(text) {
  const out = [];
  const clean = String(text ?? '')
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1');
  const re = /\*\*([^*]+)\*\*/g;
  let last = 0;
  for (const m of clean.matchAll(re)) {
    if (m.index > last) out.push({ text: clean.slice(last, m.index) });
    out.push({ text: m[1], bold: true });
    last = m.index + m[0].length;
  }
  if (last < clean.length) out.push({ text: clean.slice(last) });
  return out.map((r) => ({ ...r, text: r.text.replace(/(^|\s)\*([^*]+)\*(?=\s|$)/g, '$1$2') }));
}

// ---------- DOCX ----------
const xml = (s) =>
  String(s ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const FONT = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Nirmala UI" w:eastAsia="Calibri"/>';
const runXml = ({ text, bold }, extra = '') =>
  `<w:r><w:rPr>${FONT}${bold ? '<w:b/><w:bCs/>' : ''}${extra}</w:rPr><w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
const paraXml = (text, { style, extra = '', italic = false } = {}) =>
  `<w:p>${style ? `<w:pPr><w:pStyle w:val="${style}"/></w:pPr>` : ''}${runs(text)
    .map((r) => runXml(r, `${italic ? '<w:i/>' : ''}${extra}`))
    .join('')}</w:p>`;

function tableXml(block) {
  const cols = block.columns.length || 1;
  const width = Math.floor(9000 / cols);
  const cell = (text, header) =>
    `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${header ? '<w:shd w:val="clear" w:color="auto" w:fill="D9E2F3"/>' : ''}</w:tcPr><w:p><w:pPr><w:spacing w:before="20" w:after="20"/></w:pPr>${runXml({ text: String(text ?? ''), bold: header }, '<w:sz w:val="18"/><w:szCs w:val="18"/>')}</w:p></w:tc>`;
  const row = (cells, header) =>
    `<w:tr>${header ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${Array.from({ length: cols }, (_, i) => cell(cells[i], header)).join('')}</w:tr>`;
  const border = '<w:top w:val="single" w:sz="4" w:color="A6A6A6"/><w:left w:val="single" w:sz="4" w:color="A6A6A6"/><w:bottom w:val="single" w:sz="4" w:color="A6A6A6"/><w:right w:val="single" w:sz="4" w:color="A6A6A6"/><w:insideH w:val="single" w:sz="4" w:color="A6A6A6"/><w:insideV w:val="single" w:sz="4" w:color="A6A6A6"/>';
  return (
    `<w:tbl><w:tblPr><w:tblW w:w="5000" w:type="pct"/><w:tblBorders>${border}</w:tblBorders></w:tblPr>` +
    `<w:tblGrid>${Array.from({ length: cols }, () => `<w:gridCol w:w="${width}"/>`).join('')}</w:tblGrid>` +
    row(block.columns, true) +
    block.rows.map((r) => row(r, false)).join('') +
    '</w:tbl><w:p/>'
  );
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr>${FONT}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-IN" w:bidi="ta-IN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="2F5496"/><w:sz w:val="32"/><w:szCs w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200" w:after="80"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:color w:val="2F5496"/><w:sz w:val="26"/><w:szCs w:val="26"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="160" w:after="60"/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:color w:val="1F3864"/><w:sz w:val="23"/><w:szCs w:val="23"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="ListBullet"><w:name w:val="List Bullet"/><w:basedOn w:val="Normal"/><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr><w:spacing w:after="60"/><w:ind w:left="720" w:hanging="360"/></w:pPr></w:style>
</w:styles>`;

const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="•"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
</w:numbering>`;

/** @param {{title?: string, blocks: object[]}} doc */
export function toDocx({ title, blocks }) {
  const body = [];
  if (title) body.push(paraXml(title, { style: 'Title' }));
  for (const b of blocks) {
    if (b.type === 'heading') body.push(paraXml(b.text, { style: `Heading${b.level || 1}` }));
    else if (b.type === 'paragraph') body.push(paraXml(b.text, { italic: b.italic }));
    else if (b.type === 'bullets') for (const item of b.items) body.push(paraXml(item, { style: 'ListBullet' }));
    else if (b.type === 'table') body.push(tableXml(b));
  }
  const document =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>' +
    body.join('') +
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>' +
    '</w:body></w:document>';
  return zip([
    {
      name: '[Content_Types].xml',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
        '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
        '</Types>',
    },
    {
      name: '_rels/.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    },
    {
      name: 'word/_rels/document.xml.rels',
      data:
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>',
    },
    { name: 'word/document.xml', data: document },
    { name: 'word/styles.xml', data: STYLES },
    { name: 'word/numbering.xml', data: NUMBERING },
  ]);
}

// ---------- HTML (for PDF) ----------
const html = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
const inlineHtml = (text) => runs(text).map((r) => (r.bold ? `<b>${html(r.text)}</b>` : html(r.text))).join('');

export function toHtml({ title, blocks }) {
  const body = [];
  if (title) body.push(`<h1 class="title">${html(title)}</h1>`);
  for (const b of blocks) {
    if (b.type === 'heading') body.push(`<h${(b.level || 1) + 1}>${inlineHtml(b.text)}</h${(b.level || 1) + 1}>`);
    else if (b.type === 'paragraph') body.push(`<p${b.italic ? ' class="note"' : ''}>${inlineHtml(b.text)}</p>`);
    else if (b.type === 'bullets') body.push(`<ul>${b.items.map((i) => `<li>${inlineHtml(i)}</li>`).join('')}</ul>`);
    else if (b.type === 'table')
      body.push(
        `<table><thead><tr>${b.columns.map((c) => `<th>${html(c)}</th>`).join('')}</tr></thead><tbody>${b.rows
          .map((r) => `<tr>${b.columns.map((_, i) => `<td>${html(r[i])}</td>`).join('')}</tr>`)
          .join('')}</tbody></table>`,
      );
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${html(title || 'Report')}</title><style>
@page { size: A4; margin: 18mm 16mm; }
body { font-family: "Segoe UI", "Nirmala UI", "Latha", "Noto Sans Tamil", Arial, sans-serif; font-size: 10.5pt; line-height: 1.5; color: #1f2328; }
h1.title { font-size: 22pt; color: #1f3864; margin: 0 0 12pt; border-bottom: 2px solid #2f5496; padding-bottom: 6pt; }
h2 { font-size: 15pt; color: #2f5496; margin: 16pt 0 6pt; } h3 { font-size: 12.5pt; color: #2f5496; margin: 12pt 0 4pt; } h4 { font-size: 11pt; color: #1f3864; margin: 10pt 0 4pt; }
p { margin: 0 0 7pt; } p.note { color: #57606a; font-style: italic; } ul { margin: 0 0 8pt 18pt; padding: 0; } li { margin: 0 0 3pt; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0 12pt; font-size: 8.5pt; page-break-inside: auto; }
thead { display: table-header-group; } tr { page-break-inside: avoid; }
th { background: #d9e2f3; text-align: left; } th, td { border: 1px solid #a6a6a6; padding: 3pt 5pt; vertical-align: top; }
tbody tr:nth-child(even) td { background: #f6f8fa; }
</style></head><body>${body.join('\n')}</body></html>`;
}

// ---------- PDF via Edge/Chrome headless ----------
export function findBrowser(env = process.env, exists = fsSync.existsSync) {
  if (env.CHANAKYA_PDF_BROWSER && exists(env.CHANAKYA_PDF_BROWSER)) return env.CHANAKYA_PDF_BROWSER;
  const roots = [env['ProgramFiles(x86)'], env.ProgramFiles, env.LOCALAPPDATA].filter(Boolean);
  const candidates = roots.flatMap((r) => [
    path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ]);
  if (process.platform !== 'win32')
    candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/microsoft-edge');
  return candidates.find((c) => exists(c)) || null;
}

export async function htmlToPdf(htmlText, { browser = findBrowser(), timeoutMs = 90_000, spawnImpl = spawn } = {}) {
  if (!browser) return null;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-pdf-'));
  const input = path.join(dir, 'report.html');
  const output = path.join(dir, 'report.pdf');
  const profile = path.join(dir, 'profile');
  try {
    await fs.writeFile(input, htmlText, 'utf8');
    const complete = async () => {
      const pdf = await fs.readFile(output).catch(() => null);
      return pdf &&
        pdf.subarray(0, 5).toString('latin1') === '%PDF-' &&
        pdf.subarray(-1024).toString('latin1').includes('%%EOF')
        ? pdf
        : null;
    };
    const headlessShell = /headless[_-]shell/i.test(path.basename(browser));
    const args = [
      ...(headlessShell ? [] : ['--headless=new']),
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-component-update',
      '--disable-default-apps',
      '--disable-dev-shm-usage',
      '--no-pdf-header-footer',
      // Chromium refuses to start as root without this (Linux containers only).
      ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
      `--user-data-dir=${profile}`,
      `--print-to-pdf=${output}`,
      `file:///${input.replace(/\\/g, '/').replace(/^\/+/, '')}`,
    ];
    const pdf = await new Promise((resolve) => {
      let done = false;
      let child;
      const finish = async () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(poll);
        const result = await complete();
        try {
          child?.kill();
        } catch {
          /* already exited */
        }
        resolve(result);
      };
      // Some browser builds keep running after printing; the finished file is the signal.
      const poll = setInterval(async () => {
        if (!done && (await complete())) finish();
      }, 300);
      const timer = setTimeout(finish, timeoutMs);
      try {
        child = spawnImpl(browser, args, { windowsHide: true, stdio: 'ignore', shell: false });
      } catch {
        return finish();
      }
      child.on('error', finish);
      child.on('close', finish);
    });
    return pdf;
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Report blocks for tables: an overview line, then each table (capped for documents). */
export function tableReportBlocks(tables, { maxRows = 500 } = {}) {
  const blocks = [];
  for (const t of tables) {
    if (tables.length > 1) blocks.push({ type: 'heading', level: 2, text: t.name });
    blocks.push({
      type: 'paragraph',
      text: `${t.rows.length.toLocaleString('en-IN')} row(s), ${t.columns.length} column(s).${t.rows.length > maxRows ? ` The first ${maxRows} rows are shown; the Excel file has all rows.` : ''}`,
    });
    blocks.push({ type: 'table', columns: t.columns.map(String), rows: t.rows.slice(0, maxRows).map((r) => r.map((v) => (v === null || v === undefined ? '' : String(v)))) });
  }
  return blocks;
}

export const tempId = () => randomUUID();
