import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { detectFileTask } from './intent.js';
import { applyOperation, mergeTables, runPlan, profileTable, toNumber, TableOpError } from './tableOps.js';
import { planTableOperations, validatePlan, fallbackPlan } from './planner.js';
import { toCsv, toXlsx, toMarkdownTable, crc32 } from './writers.js';
import { joinChunks, extractEntities } from './extract.js';
import { splitParts, planParts, summarizeDocument } from './summarize.js';
import { buildMoves, createPlan, applyPlan, undoPlan, PlanStore, assertOrganizableRoot, cleanName, scanFolder } from './organize.js';
import { markdownToBlocks, toDocx, toHtml, htmlToPdf } from './documents.js';
import { runFileAgent } from './index.js';

// minimal zip reader for assertions
function unzip(buf) {
  const files = {};
  let eocd = buf.length - 22;
  while (buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const lnlen = buf.readUInt16LE(off + 26);
    const lelen = buf.readUInt16LE(off + 28);
    const data = buf.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    const raw = method === 8 ? zlib.inflateRawSync(data) : data;
    assert.equal(crc32(raw), crc, `crc of ${name}`);
    files[name] = raw.toString('utf8');
    p += 46 + nlen + elen + clen;
  }
  return files;
}

const sales = {
  name: 'Sales',
  columns: ['Region', 'Customer', 'Amount', 'Date', 'Status'],
  rows: [
    ['South', ' Ravi  Kumar ', '1,200', '05/01/2026', 'Paid'],
    ['North', 'Asha', 800, '12/01/2026', 'Pending'],
    ['South', 'Meena', '₹2,500', '02/02/2026', 'Paid'],
    ['South', ' Ravi  Kumar ', '1,200', '05/01/2026', 'Paid'],
    ['', '', '', '', ''],
    ['East', 'தமிழ் Store', 300, '20/12/2025', 'paid'],
  ],
};

// ───────── intent ─────────
test('intent: action requests are file tasks, ordinary questions are not', () => {
  const att = { hasTextAttachments: true, hasTables: true };
  assert.equal(detectFileTask('remove duplicates', att).kind, 'table');
  assert.equal(detectFileTask('clean this data', att).kind, 'table');
  assert.equal(detectFileTask('merge these files into one excel', att).kind, 'table');
  assert.deepEqual(detectFileTask('filter Status = Paid and export to excel', att), { kind: 'table', format: 'xlsx' });
  assert.equal(detectFileTask('what is the total amount?', att), null);
  assert.equal(detectFileTask('sort by amount', att), null); // a question → docqa
  assert.deepEqual(detectFileTask('make a PDF report', att), { kind: 'report', format: 'pdf' });
  const docs = { hasTextAttachments: true, hasTables: false };
  assert.deepEqual(detectFileTask('summarize this', docs), { kind: 'summarize', format: null });
  assert.deepEqual(detectFileTask('இதை சுருக்கமாக சொல்லு', docs), { kind: 'summarize', format: null });
  assert.deepEqual(detectFileTask('summarize and give it as a word document', docs), { kind: 'summarize', format: 'docx' });
  assert.deepEqual(detectFileTask('convert this to pdf', docs), { kind: 'convert', format: 'pdf' });
  assert.deepEqual(detectFileTask('convert to markdown', docs), { kind: 'convert', format: 'md' });
  assert.deepEqual(detectFileTask('extract all emails and phone numbers', docs), { kind: 'extract', targets: ['emails', 'phones'], format: null });
  assert.deepEqual(detectFileTask('', { ...docs, attachmentsOnly: true }), { kind: 'auto' });
  assert.equal(detectFileTask('who wrote this?', docs), null);
  assert.equal(detectFileTask('summarize', { hasTextAttachments: false }), null);
  const org = detectFileTask('organize D:\\Downloads by type', {});
  assert.equal(org.kind, 'organize');
  assert.equal(org.mode, 'type');
  assert.equal(org.path, 'D:\\Downloads');
  assert.equal(detectFileTask('rename all files in my downloads folder with date', {}).mode, 'rename-date');
  assert.equal(detectFileTask('organize my downloads folder by month', {}).mode, 'date');
  assert.equal(detectFileTask('find duplicate files in my documents folder', {}).mode, 'duplicates');
});

// ───────── table ops ─────────
test('tableOps: clean, filter, sort, group and merge are exact', () => {
  assert.equal(toNumber('₹2,500'), 2500);
  assert.equal(toNumber('(1,000)'), -1000);
  assert.equal(toNumber('12%'), 12);
  assert.equal(toNumber('abc'), null);
  let t = applyOperation(sales, { op: 'trim' });
  t = applyOperation(t, { op: 'dropEmptyRows' });
  t = applyOperation(t, { op: 'dedupe' });
  assert.equal(t.rows.length, 4);
  assert.equal(t.rows[0][1], 'Ravi Kumar');
  const paid = applyOperation(t, { op: 'filter', column: 'status', operator: '=', value: 'PAID' });
  assert.equal(paid.rows.length, 3);
  const big = applyOperation(t, { op: 'filter', column: 'Amount', operator: '>=', value: '1000' });
  assert.deepEqual(big.rows.map((r) => r[1]), ['Ravi Kumar', 'Meena']);
  const byDate = applyOperation(t, { op: 'sort', column: 'Date', direction: 'asc' });
  assert.deepEqual(byDate.rows.map((r) => r[3]), ['20/12/2025', '05/01/2026', '12/01/2026', '02/02/2026']);
  const g = applyOperation(t, { op: 'groupBy', by: ['Region'], aggregates: [{ fn: 'sum', column: 'Amount' }, { fn: 'count' }] });
  assert.deepEqual(g.columns, ['Region', 'Sum of Amount', 'Count']);
  assert.deepEqual(g.rows, [['South', 3700, 2], ['North', 800, 1], ['East', 300, 1]]);
  assert.throws(() => applyOperation(t, { op: 'sort', column: 'Nope' }), /Available columns: Region/);
  const merged = mergeTables([
    { name: 'A', columns: ['Name', 'Amount'], rows: [['x', 1]] },
    { name: 'B', columns: ['amount', 'name', 'City'], rows: [[2, 'y', 'Chennai']] },
  ]);
  assert.deepEqual(merged.columns, ['Name', 'Amount', 'City', 'Source']);
  assert.deepEqual(merged.rows, [['x', 1, '', 'A'], ['y', 2, 'Chennai', 'B']]);
  const p = profileTable(sales);
  assert.equal(p.duplicates, 1);
  assert.equal(p.emptyRows, 1);
  assert.equal(p.columns[2].numeric, true);
  assert.equal(p.columns[2].sum, 6000);
});

test('planner: model plan is validated against real columns, fallback covers common asks', async () => {
  const good = validatePlan({ operations: [{ op: 'filter', column: 'Status', operator: '=', value: 'Paid' }, { op: 'sort', column: 'Amount', direction: 'desc' }], outputName: 'paid/../x' }, [sales]);
  assert.equal(good.operations.length, 2);
  assert.equal(good.outputName, 'paid..x');
  assert.throws(() => validatePlan({ operations: [{ op: 'filter', column: 'Price', operator: '=', value: 1 }] }, [sales]), TableOpError);
  assert.throws(() => validatePlan({ operations: [{ op: 'exec', cmd: 'rm' }] }, [sales]), TableOpError);
  let calls = 0;
  const flaky = async () => (++calls === 1 ? { operations: [{ op: 'sort', column: 'Price' }] } : { operations: [{ op: 'dedupe' }] });
  const r = await planTableOperations({ request: 'remove duplicates', tables: [sales], completeJSON: flaky });
  assert.equal(r.source, 'model');
  assert.equal(calls, 2);
  const offline = await planTableOperations({ request: 'clean it', tables: [sales], completeJSON: async () => { throw new Error('offline'); } });
  assert.equal(offline.source, 'fallback');
  assert.deepEqual(offline.plan.operations.map((o) => o.op), ['trim', 'dropEmptyRows', 'dedupe']);
  assert.equal(fallbackPlan('tell me a joke', [sales]), null);
  await assert.rejects(planTableOperations({ request: 'make it pretty', tables: [sales], completeJSON: async () => ({}) }), TableOpError);
  const res = runPlan([sales, { ...sales, name: 'Sales2' }], { merge: true, operations: [{ op: 'dropEmptyRows' }] });
  assert.equal(res.tables.length, 1);
  assert.equal(res.tables[0].rows.length, 10);
});

// ───────── writers ─────────
test('writers: CSV has BOM and quoting; XLSX is a valid package with inline strings', () => {
  const csv = toCsv({ columns: ['a', 'b'], rows: [['x,y', 'he said "hi"'], [1, 'தமிழ்']] }).toString('utf8');
  assert.ok(csv.startsWith('\ufeff'));
  assert.ok(csv.includes('"x,y","he said ""hi"""'));
  assert.ok(csv.includes('1,தமிழ்'));
  const files = unzip(toXlsx([sales, { name: 'Sales', columns: ['x'], rows: [['<&>']] }]));
  assert.ok(files['[Content_Types].xml'].includes('sheet2.xml'));
  assert.ok(files['xl/workbook.xml'].includes('name="Sales (2)"'));
  assert.ok(files['xl/worksheets/sheet1.xml'].includes('<v>800</v>'));
  assert.ok(files['xl/worksheets/sheet1.xml'].includes('தமிழ் Store'));
  assert.ok(files['xl/worksheets/sheet2.xml'].includes('&lt;&amp;&gt;'));
  const md = toMarkdownTable({ columns: ['a|b'], rows: [['1|2']] });
  assert.ok(md.includes('a\\|b') && md.includes('1\\|2'));
});

test('documents: markdown → DOCX package and printable HTML', () => {
  const blocks = markdownToBlocks('# Title\n\nSome **bold** text.\n\n**Key points**\n- one\n- இரண்டு\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n_note_');
  assert.deepEqual(blocks.map((b) => b.type), ['heading', 'paragraph', 'heading', 'bullets', 'table', 'paragraph']);
  const files = unzip(toDocx({ title: 'Report', blocks }));
  const doc = files['word/document.xml'];
  assert.ok(doc.includes('<w:b/><w:bCs/></w:rPr><w:t xml:space="preserve">bold</w:t>'));
  assert.ok(doc.includes('இரண்டு'));
  assert.ok(doc.includes('<w:tbl>'));
  assert.ok(files['word/numbering.xml'] && files['word/styles.xml']);
  const html = toHtml({ title: 'R <x>', blocks });
  assert.ok(html.includes('<title>R &lt;x&gt;</title>') && html.includes('<b>bold</b>') && html.includes('Nirmala UI'));
});

test('documents: missing browser returns null (HTML fallback), never throws', async () => {
  assert.equal(await htmlToPdf('<p>x</p>', { browser: null }), null);
});

// ───────── extract / text ─────────
test('extract: overlapping chunks are rejoined and entities found', () => {
  const a = 'Intro paragraph about the project. The budget is ₹5,00,000 for 2026.';
  const b = 'is ₹5,00,000 for 2026. Contact ravi.k@example.com or +91 98765 43210 by 15/03/2026.';
  const text = joinChunks(['[Page 1] ' + a, '[Page 1] ' + b, '[Page 2] Visit https://example.org/docs.']);
  assert.equal((text.match(/₹5,00,000/g) || []).length, 1);
  assert.ok(text.includes('--- Page 2 ---'));
  const t = extractEntities([{ name: 'a.pdf', text }], ['emails', 'phones', 'urls', 'dates', 'amounts']);
  const values = t.rows.map((r) => `${r[0]}:${r[1]}`);
  for (const v of ['Email:ravi.k@example.com', 'Phone:+91 98765 43210', 'URL:https://example.org/docs', 'Date:15/03/2026', 'Amount:₹5,00,000'])
    assert.ok(values.includes(v), `${v} in ${values}`);
});

test('summarize: long text is split into parts; map → reduce streams only the final answer', async () => {
  const para = 'Sentence about revenue growth in the southern region. '.repeat(30);
  const text = Array.from({ length: 40 }, (_, i) => `Section ${i}. ${para}`).join('\n\n');
  const plan = planParts(text);
  assert.ok(plan.parts.length > 1 && plan.parts.length <= 16);
  assert.ok(splitParts('a'.repeat(25000), 9000).every((p) => p.length <= 9000));
  const calls = [];
  let streamed = '';
  const chat = async (messages, { onToken } = {}) => {
    calls.push(messages);
    const out = onToken ? 'Overview.\n\n**Key points**\n- growth' : '- note';
    onToken?.(out);
    return out;
  };
  const result = await summarizeDocument({ name: 'r.pdf', text, request: 'summarize', chat, emit: (t) => (streamed += t) });
  assert.equal(calls.length, plan.parts.length + 1);
  assert.ok(streamed.startsWith('Overview.'));
  assert.ok(result.startsWith('Overview.'));
});

// ───────── organize ─────────
async function tempFolder(files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'fa-org-'));
  for (const [rel, content, mtime] of files) {
    const p = path.join(root, rel);
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content);
    if (mtime) await fs.utimes(p, mtime, mtime);
  }
  return root;
}

test('organize: plan → apply → undo restores everything; nothing is deleted', async () => {
  const root = await tempFolder([
    ['report.pdf', 'pdf'],
    ['photo 1.JPG', 'img'],
    ['data.xlsx', 'x'],
    ['setup.exe', 'e'],
    ['notes', 'n'],
    ['Documents/old.pdf', 'already sorted'],
    ['desktop.ini', 'skip'],
  ]);
  const store = new PlanStore(path.join(root, '..', `${path.basename(root)}-plans`));
  const plan = await createPlan(store, { userId: 'u1', root, mode: 'type' });
  const targets = Object.fromEntries(plan.moves.map((m) => [m.from, m.to]));
  assert.deepEqual(targets, {
    'report.pdf': 'Documents/report.pdf',
    'photo 1.JPG': 'Images/photo 1.JPG',
    'data.xlsx': 'Spreadsheets/data.xlsx',
    'setup.exe': 'Installers/setup.exe',
    notes: 'Others/notes',
  });
  await assert.rejects(applyPlan(store, 'someone-else', plan.id), /not found/);
  await fs.writeFile(path.join(root, 'Documents', 'report.pdf'), 'collision'); // appears after planning
  const applied = await applyPlan(store, 'u1', plan.id);
  assert.equal(applied.applied.length, 5);
  assert.equal(applied.failed.length, 0);
  assert.equal(await fs.readFile(path.join(root, 'Documents', 'report (2).pdf'), 'utf8'), 'pdf');
  await assert.rejects(applyPlan(store, 'u1', plan.id), /already applied/);
  const undone = await undoPlan(store, 'u1', plan.id);
  assert.equal(undone.undo.restored, 5);
  for (const f of ['report.pdf', 'photo 1.JPG', 'data.xlsx', 'setup.exe', 'notes', 'desktop.ini', 'Documents/old.pdf', 'Documents/report.pdf'])
    await fs.access(path.join(root, f));
  await assert.rejects(fs.access(path.join(root, 'Images')), 'empty created folder removed');
});

test('organize: duplicates, date rename, clean names and root guards', async () => {
  const d = new Date('2025-03-09T10:00:00Z');
  const root = await tempFolder([
    ['a.txt', 'same', new Date('2024-01-01')],
    ['b copy.txt', 'same', new Date('2025-01-01')],
    ['c.txt', 'different'],
    ['My File__(1)!!.PDF', 'x', d],
  ]);
  const { files } = await scanFolder(root);
  const dup = await buildMoves(root, files, 'duplicates');
  assert.deepEqual(dup.map((m) => [m.from, m.to]), [['b copy.txt', '_Duplicates/b copy.txt']]);
  const dated = await buildMoves(root, files, 'rename-date');
  assert.ok(dated.some((m) => /^\d{4}-\d{2}-\d{2}_My File__\(1\)!!\.PDF$/.test(m.to)));
  assert.equal(cleanName('My File__(1)!!.PDF'), 'My-File-(1).pdf');
  assert.equal(cleanName('தமிழ் கோப்பு.docx'), 'தமிழ்-கோப்பு.docx');
  assert.throws(() => assertOrganizableRoot('C:\\'), /whole drive/);
  assert.throws(() => assertOrganizableRoot('/'), /whole drive/);
  assert.throws(() => assertOrganizableRoot('/home/me', { home: '/home/me' }), /profile/);
  assert.throws(() => assertOrganizableRoot('/data', { protectedRoots: ['/data/app'] }), /assistant/);
});

// ───────── end to end with fake deps ─────────
function fakeDeps(docs, extra = {}) {
  const saved = [];
  return {
    saved,
    deps: {
      model: 'test-model',
      loadDocuments: async () => docs,
      outputs: {
        save: async (_u, name, data, mime) => {
          const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
          saved.push({ name, buf, mime });
          return { id: `00000000-0000-4000-8000-00000000000${saved.length}`, name, size: buf.length, mime };
        },
      },
      htmlToPdf: async () => Buffer.from('%PDF-1.7 fake'),
      completeJSON: async () => ({ operations: [{ op: 'filter', column: 'Status', operator: '=', value: 'paid' }, { op: 'groupBy', by: ['Region'], aggregates: [{ fn: 'sum', column: 'Amount' }] }], outputName: 'paid-by-region' }),
      chat: async (_m, { onToken } = {}) => {
        const out = 'Overview of the policy.\n\n**Key points**\n- Leave is 12 days';
        onToken?.(out);
        return out;
      },
      ...extra,
    },
  };
}
const sheetDoc = { id: 'd1', name: 'sales.xlsx', ext: '.xlsx', tables: [sales], text: '' };
const textDoc = { id: 'd2', name: 'policy.docx', ext: '.docx', tables: [], text: 'Leave policy. Employees get 12 days. Email hr@corp.in.\n' };

test('agent: table request → exact numbers, xlsx + preview, streamed text equals saved content', async () => {
  const { saved, deps } = fakeDeps([sheetDoc]);
  let streamed = '';
  const content = await runFileAgent({ task: { kind: 'table', format: 'xlsx' }, message: 'total paid amount by region as excel', userId: 'u', documentIds: ['d1'], emit: (t) => (streamed += t), deps });
  assert.equal(content, streamed);
  assert.ok(content.includes('| South | 3700 |') || content.includes('| South | 4900 |'), content);
  assert.ok(content.includes('#chanakya-output='));
  assert.equal(saved[0].name, 'paid-by-region.xlsx');
  const sheet = unzip(saved[0].buf)['xl/worksheets/sheet1.xml'];
  assert.ok(sheet.includes('Sum of Amount'));
});

test('agent: summary as Word, PDF report from data, convert to PDF, extract emails', async () => {
  let r = fakeDeps([textDoc]);
  let content = await runFileAgent({ task: { kind: 'summarize', format: 'docx' }, message: 'summarize as word', userId: 'u', documentIds: ['d2'], emit: () => {}, deps: r.deps });
  assert.ok(content.startsWith('Overview of the policy.'));
  assert.equal(r.saved[0].name, 'policy-summary.docx');
  assert.ok(unzip(r.saved[0].buf)['word/document.xml'].includes('Leave is 12 days'));

  r = fakeDeps([sheetDoc]);
  content = await runFileAgent({ task: { kind: 'report', format: 'pdf' }, message: 'make a pdf report', userId: 'u', documentIds: ['d1'], emit: () => {}, deps: r.deps });
  assert.deepEqual(r.saved.map((s) => s.name), ['sales-report.pdf']);
  assert.ok(content.includes('Report created'));

  r = fakeDeps([textDoc], { htmlToPdf: async () => null });
  content = await runFileAgent({ task: { kind: 'convert', format: 'pdf' }, message: 'convert to pdf', userId: 'u', documentIds: ['d2'], emit: () => {}, deps: r.deps });
  assert.deepEqual(r.saved.map((s) => s.name), ['policy.html']);
  assert.ok(content.includes('Print → Save as PDF'));

  r = fakeDeps([textDoc]);
  content = await runFileAgent({ task: { kind: 'extract', targets: ['emails'] }, message: 'extract emails', userId: 'u', documentIds: ['d2'], emit: () => {}, deps: r.deps });
  assert.ok(content.includes('hr@corp.in'));
  assert.equal(r.saved[0].name, 'policy-extracted.xlsx');
});

test('agent: automatic upload profiles sheets and summarizes documents', async () => {
  const { saved, deps } = fakeDeps([sheetDoc, textDoc]);
  const content = await runFileAgent({ task: { kind: 'auto' }, message: '', userId: 'u', documentIds: ['d1', 'd2'], emit: () => {}, deps });
  assert.ok(content.includes('## sales.xlsx') && content.includes('1 duplicate row'));
  assert.ok(content.includes('## policy.docx') && content.includes('Overview of the policy'));
  assert.ok(content.includes('You can also ask'));
  assert.deepEqual(saved.map((s) => s.name), ['policy-summary.md']);
});

test('agent: organize without a folder asks for one and changes nothing', async () => {
  const { deps } = fakeDeps([]);
  const content = await runFileAgent({ task: { kind: 'organize', mode: 'type' }, message: 'organize my files', userId: 'u', documentIds: [], emit: () => {}, deps: { ...deps, workspaceRoot: async () => null } });
  assert.match(content, /Which folder/);
});

test('intent: folder paths with spaces, quotes and trailing words', async () => {
  const { messagePath } = await import('./intent.js');
  assert.equal(messagePath('organize D:\\My Files\\Downloads by date'), 'D:\\My Files\\Downloads');
  assert.equal(messagePath('organize "D:\\My Files\\by year" please'), 'D:\\My Files\\by year');
  assert.equal(messagePath('rename files in C:\\Users\\me\\Pictures folder with date'), 'C:\\Users\\me\\Pictures');
  assert.equal(messagePath('D:\\Photos கோப்புகளை ஒழுங்குபடுத்து'), 'D:\\Photos');
  assert.equal(messagePath('organize my downloads'), null);
});
