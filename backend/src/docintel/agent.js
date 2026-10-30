import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DocIntelError } from './errors.js';
import { LIMITS, OUTPUT_MIME, withExtension } from './formats.js';
import { columnTypes, compactList, describeDocument, parseDocument } from './parser.js';
import {
  aggregate,
  describeCondition,
  extractPages,
  filterRows,
  findDuplicates,
  groupRows,
  idRange,
  lookupValues,
  monthKey,
  paginate,
  resolveColumn,
  searchRows,
  searchText,
  sortRows,
} from './operations.js';
import { routeDocumentTask, routeGenerateWithoutDocuments, routerContext } from './router.js';
import { convertDocument, documentBlocks } from './conversion.js';
import { renderDocument, writeXlsx } from './generation.js';
import { verifyOutput, verificationSummary } from './verify.js';
import { compareDocuments } from './compare.js';
import { draftDocumentSpec, explainComparison, explainDocument } from './explainer.js';
import {
  collectFormulas,
  editDocx,
  editSpreadsheet,
  formulasAreSafe,
  parseReplace,
} from './edit.js';
import { findSoffice, sofficeConvert } from './libreoffice.js';
import { display, normKey } from './values.js';

/**
 * Document Intelligence Agent: one entry point for read / search / filter /
 * calculate / summarize / explain / compare / edit / convert / generate.
 *
 *   routeTask()     DocumentTaskRouter (deterministic) → task or clarification
 *   executeTask()   DocumentOperationEngine / GenerationEngine / VerificationEngine
 *                   produce a structured result; ResponseExplainer (local model)
 *                   is used only for summaries, explanations and new prose.
 *
 * Every result separates source facts (rows, cells, pages), calculated values,
 * assumptions and warnings, and carries source references. Generated files are
 * re-opened and checked before a download link is shown.
 */

const fmtNum = (n) =>
  typeof n === 'number' ? n.toLocaleString('en-IN', { maximumFractionDigits: 10 }) : display(n);
const plural = (n, w, p = `${w}s`) => `${Number(n).toLocaleString('en-IN')} ${n === 1 ? w : p}`;
const md = (s) =>
  String(s ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ');
const WH_QUESTION =
  /^\s*(?:who|what|where|when|which|whose|why|tell me about|is there|are there|does|do)\b/i;

// ------------------------------------------------------------------ routing

/**
 * @returns {object|null} task / clarification, or null when the message is not a document task
 */
export function routeTask(message, docs) {
  const usable = docs.filter((d) => !d.failed);
  if (!usable.length) {
    if (docs.length) return { action: 'failed', documents: docs.map((d) => d.id) };
    const g = routeGenerateWithoutDocuments(message);
    if (g && !/^\s*(?:how|what|why|can|could|should|is|does|do)\b|\?\s*$/i.test(message)) return g;
    return null;
  }
  const replace = parseReplace(message);
  const words = usable.filter((d) => d.kind === 'word');
  if (replace && words.length)
    return {
      action: 'edit',
      edit: { kind: 'replace', ...replace },
      documents: [words.length === 1 ? words[0].id : pickNamed(message, words)?.id || words[0].id],
    };
  const task = routeDocumentTask(message, routerContext(usable, columnTypes));
  if (!task) return null;
  // Open questions ("who joined in 2021?") stay with the conversational document Q&A.
  if (
    ['filter', 'lookup', 'search'].includes(task.action) &&
    WH_QUESTION.test(message) &&
    !task.output
  )
    return null;
  return task;
}

function pickNamed(message, docs) {
  const lower = String(message).toLowerCase();
  return (
    docs.find(
      (d) =>
        lower.includes(d.name.toLowerCase()) ||
        lower.includes(d.name.toLowerCase().replace(/\.[^.]+$/, '')),
    ) || null
  );
}

// ----------------------------------------------------------------- helpers

function docsFor(task, docs) {
  const ids = task.documents?.length ? task.documents : docs.map((d) => d.id);
  return docs.filter((d) => ids.includes(d.id) && !d.failed);
}

function tablesFor(task, docs) {
  const out = [];
  for (const d of docsFor(task, docs))
    for (const t of d.tables || []) out.push({ doc: d, table: t });
  if (task.sheet) {
    const exact = out.filter((x) => normKey(x.table.name) === normKey(task.sheet));
    if (exact.length) return exact;
  }
  return out;
}

const rowLabel = (table) =>
  table.refKind === 'record' ? 'Record' : table.source?.kind === 'sheet' ? 'Row' : '#';

export function sourceOf(doc, table, refs = []) {
  const where =
    table.source?.kind === 'sheet'
      ? `sheet "${table.source.sheet}"`
      : table.source?.kind === 'pdf-table'
        ? `page ${table.source.page}, table ${table.source.table}`
        : table.source?.kind === 'docx-table'
          ? `table ${table.source.table}`
          : `"${table.name}"`;
  const nums = [...new Set(refs.filter((r) => Number.isFinite(r)))].sort((a, b) => a - b);
  return {
    file: doc.name,
    where,
    rowKind: table.refKind === 'record' ? 'records' : 'rows',
    rows: nums.length ? compactList(nums) : '',
  };
}

const sourceText = (s) => `${s.file} › ${s.where}${s.rows ? ` › ${s.rowKind} ${s.rows}` : ''}`;

/** Markdown table of source rows with their real row numbers. */
function rowsMarkdown(table, rows, { limit = LIMITS.pageSize, columns } = {}) {
  const cols = columns
    ? columns.map((c) => resolveColumn(table, c))
    : table.columns.map((_, i) => i);
  const head = [rowLabel(table), ...cols.map((i) => table.columns[i])];
  const lines = [`| ${head.map(md).join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`];
  for (const r of rows.slice(0, limit))
    lines.push(`| ${[r.ref, ...cols.map((i) => display(r.values[i]))].map(md).join(' | ')} |`);
  return lines.join('\n');
}

function plainTable(columns, rows, limit = LIMITS.pageSize) {
  const lines = [
    `| ${columns.map(md).join(' | ')} |`,
    `| ${columns.map(() => '---').join(' | ')} |`,
  ];
  for (const r of rows.slice(0, limit))
    lines.push(`| ${r.map((v) => md(display(v))).join(' | ')} |`);
  return lines.join('\n');
}

/** Stores a full tabular result for paging; returns markdown pager text. */
function pageable(ctx, { title, columns, rows, source }) {
  if (rows.length <= LIMITS.pageSize || !ctx.results) return '';
  const id = ctx.results.put(ctx.userId, { title, columns, rows, source });
  return `\n\n_Showing 1–${LIMITS.pageSize} of ${plural(rows.length, 'row')}._ [Show all ${rows.length.toLocaleString('en-IN')} rows](#chanakya-docintel=${id})`;
}

const fullRows = (table, rows) => rows.map((r) => [r.ref, ...r.values.map(display)]);

/** Excel formula equivalent for a contiguous sheet range (only when row numbers are real sheet rows). */
function excelEquivalent(table, rows, res, conditions) {
  if (
    table.refKind === 'record' ||
    table.source?.kind !== 'sheet' ||
    !table.columnLetters ||
    !rows.length
  )
    return null;
  const refs = rows.map((r) => r.ref);
  const first = Math.min(...refs);
  const last = Math.max(...refs);
  if (last - first + 1 !== refs.length) return null;
  const col = table.columnLetters[table.columns.indexOf(res.column)];
  const range = (letter) => `${letter}${first}:${letter}${last}`;
  const crit = (c) => {
    const v = String(c.value ?? '').replace(/"/g, '""');
    const op = { eq: '', ne: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' }[c.op];
    return op === undefined ? null : `"${op}${v}"`;
  };
  if (
    ['SUM', 'AVERAGE', 'COUNT', 'COUNTA', 'MIN', 'MAX', 'MEDIAN', 'COUNTBLANK'].includes(res.fn) &&
    col &&
    !conditions.length
  )
    return `=${res.fn}(${range(col)})`;
  if (/IF$/.test(res.fn) && conditions.length === 1) {
    const c = conditions[0];
    const cl = table.columnLetters[c.col ?? table.columns.indexOf(c.column)];
    const k = crit(c);
    if (!cl || !k) return null;
    if (res.fn === 'COUNTIF') return `=COUNTIF(${range(cl)},${k})`;
    if (col) return `=${res.fn}(${range(cl)},${k},${range(col)})`;
  }
  return null;
}

async function saveVerified(ctx, { name, buffer, ext, expectations = {}, notes = [] }) {
  const verification = await verifyOutput(buffer, ext, expectations);
  if (!verification.ok)
    return {
      ok: false,
      line: `⚠️ **${name}** was not offered for download: ${verificationSummary(verification)}`,
      verification,
    };
  const saved = await ctx.outputs.save(
    ctx.userId,
    name,
    buffer,
    OUTPUT_MIME[ext] || 'application/octet-stream',
    { docintel: true, verification },
  );
  const size =
    saved.size >= 1048576
      ? `${(saved.size / 1048576).toFixed(1)} MB`
      : `${Math.max(1, Math.round(saved.size / 1024))} KB`;
  return {
    ok: true,
    output: saved,
    line: `[${saved.name.replace(/[[\]]/g, '')} (${size})](#chanakya-output=${saved.id})\n\n_✓ ${verificationSummary(verification)}_${notes.length ? `\n\n${notes.map((n) => `_ℹ️ ${n}_`).join('\n\n')}` : ''}`,
    verification,
  };
}

/** Writes a tabular result in the requested output format. */
async function tableOutput(
  ctx,
  { output, title, columns, rows, summary = [], source, totals = [], fileBase, chart },
) {
  if (!output) return null;
  const base = withExtension(fileBase || title, output).replace(/\.[^.]+$/, '');
  if (output === 'xlsx') {
    const { buffer, totals: t } = await writeXlsx({
      sheets: [{ name: title.slice(0, 31), columns, rows, totals }],
    });
    return saveVerified(ctx, {
      name: `${base}.xlsx`,
      buffer,
      ext: 'xlsx',
      expectations: {
        sheets: [{ rows: rows.length, columns }],
        totals: t.map((x) => ({ cell: x.cell, value: x.value })),
      },
    });
  }
  if (output === 'csv' || output === 'json') {
    const r = await renderDocument(output, {
      title,
      sheets: [{ columns, rows }],
      data: rows.map((row) => Object.fromEntries(columns.map((c, i) => [c, row[i] ?? null]))),
    });
    return saveVerified(ctx, {
      name: `${base}.${output}`,
      buffer: r.buffer,
      ext: output,
      expectations: { records: rows.length },
    });
  }
  if (['pdf', 'docx', 'html', 'md', 'txt'].includes(output)) {
    const blocks = [
      ...summary.map((s) => ({ type: 'paragraph', text: s })),
      ...(chart ? [{ type: 'chart', ...chart }] : []),
      { type: 'table', columns, rows: rows.slice(0, 2000) },
      ...(rows.length > 2000
        ? [
            {
              type: 'paragraph',
              italic: true,
              text: `Only the first 2,000 of ${rows.length} rows are printed; download Excel for all rows.`,
            },
          ]
        : []),
      ...(source ? [{ type: 'paragraph', italic: true, text: `Source: ${source}` }] : []),
    ];
    const r = await renderDocument(output, { title, blocks, header: title }, ctx.pdfOptions);
    const sample = rows
      .slice(0, 3)
      .flat()
      .map(display)
      .filter((v) => v.length >= 3 && /[a-z0-9]/i.test(v))
      .slice(0, 3);
    return saveVerified(ctx, {
      name: `${base}.${output}`,
      buffer: r.buffer,
      ext: output,
      notes: r.notes,
      expectations: {
        contains: [title.slice(0, 40), ...sample],
        ...(output === 'docx' ? { tables: 1 } : {}),
      },
    });
  }
  return { ok: false, line: `⚠️ ${output.toUpperCase()} output is not supported for this result.` };
}

// ---------------------------------------------------------------- actions

async function doRange(task, docs, ctx) {
  const results = [];
  let lastError = null;
  for (const { doc, table } of tablesFor(task, docs)) {
    try {
      const r = idRange(table, { from: task.ids.from, to: task.ids.to, column: task.column });
      results.push({ doc, table, r });
    } catch (error) {
      if (error.code === 'ID_COLUMN_NOT_FOUND') {
        lastError = error;
        continue;
      }
      throw error;
    }
  }
  if (!results.length)
    throw (
      lastError ||
      new DocIntelError('ID_COLUMN_NOT_FOUND', `No table contains IDs like "${task.ids.from}".`)
    );
  const withRows = results.filter((x) => x.r.total).length
    ? results.filter((x) => x.r.total)
    : results.slice(0, 1);
  const parts = [];
  const sources = [];
  for (const { doc, table, r } of withRows) {
    let rows = r.rows;
    let filterNote = '';
    if (task.conditions?.length) {
      const f = filterRows(table, rows, task.conditions);
      filterNote = `\n- Extra filter: ${f.conditions.map((c) => describeCondition(c)).join(' AND ')} → ${plural(f.rows.length, 'row')} of ${r.total}${f.skipped.length ? ` (${f.skipped.length} cell(s) could not be compared and were left out)` : ''}`;
      rows = f.rows;
    }
    const src = sourceOf(
      doc,
      table,
      rows.map((x) => x.ref),
    );
    sources.push(src);
    const found = r.requested.count - (r.missingCount ?? 0);
    const head =
      `**${r.requested.from} to ${r.requested.to}** (inclusive) in column **${r.column}** — ${plural(rows.length, 'matching row')}` +
      `${withRows.length > 1 ? ` in ${src.where}` : ''}.`;
    const facts =
      [
        `- Requested IDs: ${plural(r.requested.count, 'ID')}; present: ${r.missingCount === null ? 'not counted (range too large)' : `${found} of ${r.requested.count}`}`,
        r.missing.length
          ? `- Missing (not in the file): ${r.missing.slice(0, 50).join(', ')}${r.missing.length > 50 ? `, … ${r.missing.length - 50} more` : ''}`
          : '- Missing: none',
        ...(r.duplicates.length
          ? [`- Repeated IDs: ${r.duplicates.map((d) => `${d.id} ×${d.count}`).join(', ')}`]
          : []),
        `- Check: ${r.verified ? `every returned ID is inside ${r.requested.from}–${r.requested.to} and in order` : '⚠️ the independent re-check of the returned IDs failed'}`,
      ].join('\n') + filterNote;
    const columns = [rowLabel(table), ...table.columns];
    const table_md = rows.length ? rowsMarkdown(table, rows) : '_No rows in this range._';
    const pager = pageable(ctx, {
      title: `${r.requested.from}–${r.requested.to}`,
      columns,
      rows: fullRows(table, rows),
      source: sourceText(src),
    });
    parts.push(`${head}\n\n${table_md}${pager}\n\n${facts}\n\n_Source: ${sourceText(src)}_`);
    const out = await tableOutput(ctx, {
      output: task.output,
      title: `${r.requested.from} to ${r.requested.to}`,
      columns,
      rows: fullRows(table, rows),
      source: sourceText(src),
      fileBase: `${doc.name.replace(/\.[^.]+$/, '')}-${r.requested.from}-${r.requested.to}`,
    });
    if (out) parts.push(out.line);
    if (!r.verified) ctx.partial = true;
  }
  return { markdown: parts.join('\n\n---\n\n'), sources };
}

async function doLookup(task, docs, ctx) {
  const { doc, table } = pickTable(task, docs);
  const r = lookupValues(table, task.values, { column: task.column });
  const src = sourceOf(
    doc,
    table,
    r.rows.map((x) => x.ref),
  );
  const columns = [rowLabel(table), ...table.columns];
  let text = `**${plural(r.rows.length, 'row')}** found for ${plural(r.requested.count, 'requested value')} in column **${r.column}**.\n\n${r.rows.length ? rowsMarkdown(table, r.rows) : ''}`;
  text += pageable(ctx, {
    title: 'Lookup',
    columns,
    rows: fullRows(table, r.rows),
    source: sourceText(src),
  });
  text += `\n\n- Not found: ${r.missing.length ? r.missing.join(', ') : 'none'}\n\n_Source: ${sourceText(src)}_`;
  const out = await tableOutput(ctx, {
    output: task.output,
    title: 'Lookup result',
    columns,
    rows: fullRows(table, r.rows),
    source: sourceText(src),
    fileBase: `${doc.name.replace(/\.[^.]+$/, '')}-lookup`,
  });
  return { markdown: text + (out ? `\n\n${out.line}` : ''), sources: [src] };
}

function pickTable(task, docs) {
  const cands = tablesFor(task, docs);
  if (!cands.length)
    throw new DocIntelError(
      'NO_TABLES',
      'The attached files have no tables or sheets for this operation.',
    );
  return cands[0];
}

async function recalculated(doc, ctx) {
  if (!doc.original || !['.xlsx', '.xlsm'].includes(doc.ext)) return { doc: null, note: null };
  const soffice = ctx.soffice === undefined ? findSoffice() : ctx.soffice;
  if (!soffice)
    return {
      doc: null,
      note: 'LibreOffice is not installed, so formulas without saved results could not be recalculated.',
    };
  if (!formulasAreSafe(collectFormulas(doc)))
    return {
      doc: null,
      note: 'The workbook uses functions or links that are not allowed to run (e.g. WEBSERVICE, INDIRECT or external workbooks), so it was not recalculated.',
    };
  ctx.status?.('Recalculating formulas with LibreOffice');
  const ext = doc.ext === '.xlsm' ? '.xlsx' : doc.ext;
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-recalc-'));
  try {
    const src = path.join(dir, `in${ext}`);
    await fs.copyFile(doc.original.path, src);
    const buffer = await sofficeConvert(src, '.xlsx', 'recalc', { soffice, signal: ctx.signal });
    const out = path.join(dir, 'recalc.xlsx');
    await fs.writeFile(out, buffer);
    const parsed = await parseDocument(out, withExtension(doc.name, 'xlsx'));
    return {
      doc: parsed,
      note: 'Formulas were recalculated with LibreOffice (offline; only safe functions were allowed) before calculating.',
    };
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

async function doAggregate(task, docs, ctx) {
  let { doc, table } = pickTable(task, docs);
  const assumptions = [...(task.assumptions || [])];
  const warnings = [];
  if (task.fn === 'COUNTROWS') {
    const src = sourceOf(
      doc,
      table,
      table.rows.map((r) => r.ref),
    );
    return {
      markdown: `**${plural(table.rows.length, 'data row')}** in ${src.where} of ${doc.name} (header row${table.headerRow ? ` ${table.headerRow}` : ''} excluded, empty rows not counted).\n\n_Source: ${sourceText(src)}_`,
      sources: [src],
    };
  }
  let res = aggregate(table, table.rows, {
    fn: task.fn,
    column: task.column,
    criteria: task.conditions || [],
  });
  let recalc = false;
  if (res.uncalculated?.length) {
    const re = await recalculated(doc, ctx).catch((e) => ({
      doc: null,
      note: `Recalculation failed: ${e.message}`,
    }));
    if (re.doc) {
      const t2 = re.doc.tables.find((t) => t.name === table.name);
      if (t2) {
        table = t2;
        res = aggregate(table, table.rows, {
          fn: task.fn,
          column: task.column,
          criteria: task.conditions || [],
        });
        recalc = true;
      }
    }
    if (re.note) assumptions.push(re.note);
  }
  const scopeRows = res.conditions.length
    ? filterRows(table, table.rows, task.conditions).rows
    : table.rows;
  const src = sourceOf(
    doc,
    table,
    scopeRows.map((r) => r.ref),
  );
  const label = res.column
    ? `${res.fn} of ${res.column}${res.columnLetter ? ` (column ${res.columnLetter})` : ''}`
    : res.fn;
  const value = res.value === null ? 'no numeric values' : fmtNum(res.value);
  const lines = [`**${label} = ${value}**`, ''];
  lines.push('**Calculation**');
  if (res.conditions.length)
    lines.push(
      `- Condition: ${res.conditions.join(' AND ')} → ${plural(res.rowsConsidered, 'row')} matched`,
    );
  else
    lines.push(
      `- Rows considered: ${plural(res.rowsConsidered, 'data row')} (${src.rows ? `${src.rowKind} ${src.rows}` : 'none'})`,
    );
  if (!['COUNTIF', 'COUNTA', 'COUNTBLANK'].includes(res.fn))
    lines.push(`- Numeric cells used: ${res.included}`);
  const formula = excelEquivalent(
    table,
    scopeRows,
    res,
    res.conditions.length ? filterRows(table, table.rows, task.conditions).conditions : [],
  );
  if (formula && res.excelValue === undefined) lines.push(`- Excel equivalent: \`${formula}\``);
  else if (formula)
    lines.push(
      `- Excel's \`${formula}\` would show ${fmtNum(res.excelValue)}, because Excel ignores the ${res.textNumbers} number(s) stored as text that are counted here`,
    );
  lines.push(
    `- Check: ${res.verified ? 'recomputed independently — same result' : '⚠️ independent re-check disagreed'}`,
  );
  const excluded = [];
  if (res.blanks.length)
    excluded.push(
      `- Blank cells (not counted, not treated as 0): ${res.blanks.length} — ${src.rowKind} ${compactList([...res.blanks].sort((a, b) => a - b).slice(0, 40))}`,
    );
  if (res.invalid.length)
    excluded.push(
      `- Non-numeric cells excluded: ${res.invalid.length} — ${res.invalid
        .slice(0, 10)
        .map((x) => `${src.rowKind === 'rows' ? 'row' : 'record'} ${x.row}: "${x.value}"`)
        .join(', ')}${res.invalid.length > 10 ? ', …' : ''}`,
    );
  if (res.errors.length)
    excluded.push(
      `- Error cells excluded: ${res.errors.length} — ${res.errors
        .slice(0, 10)
        .map((x) => `row ${x.row}: ${x.error}`)
        .join(', ')}`,
    );
  if (res.uncalculated?.length)
    excluded.push(
      `- Formula cells with no saved result (unknown, excluded): ${res.uncalculated.length} — e.g. row ${res.uncalculated[0].row}: =${res.uncalculated[0].formula}`,
    );
  if (res.conditionSkipped?.length)
    excluded.push(`- Rows the condition could not be checked on: ${res.conditionSkipped.length}`);
  if (excluded.length) lines.push('', '**Excluded / warnings**', ...excluded);
  const notes = [];
  if (res.textNumbers)
    notes.push(
      `- ${res.textNumbers} number(s) were stored as text (e.g. "1,200") and were read as numbers`,
    );
  if (res.formulaResults)
    notes.push(
      `- ${res.formulaResults} value(s) are the saved results of formulas (formula text is not re-run)`,
    );
  if (res.at?.length) notes.push(`- Found at ${src.rowKind} ${compactList(res.at.slice(0, 20))}`);
  if (notes.length) lines.push('', '**Notes**', ...notes);
  if (assumptions.length) lines.push('', '**Assumptions**', ...assumptions.map((a) => `- ${a}`));
  if (res.invalid.length || res.errors.length || res.uncalculated?.length)
    warnings.push('Some cells were excluded from the calculation (listed above).');
  lines.push('', `_Source: ${sourceText(src)}_`);
  let out = null;
  if (task.output) {
    const rows = [
      [
        res.fn,
        res.column || '',
        res.value,
        res.rowsConsidered,
        res.included,
        res.blanks.length,
        res.invalid.length + res.errors.length + (res.uncalculated?.length || 0),
        res.conditions.join(' AND '),
      ],
    ];
    out = await tableOutput(ctx, {
      output: task.output,
      title: label,
      columns: [
        'Function',
        'Column',
        'Result',
        'Rows considered',
        'Numbers used',
        'Blank',
        'Excluded',
        'Condition',
      ],
      rows,
      source: sourceText(src),
      fileBase: `${doc.name.replace(/\.[^.]+$/, '')}-${res.fn.toLowerCase()}`,
    });
  }
  return {
    markdown: lines.join('\n') + (out ? `\n\n${out.line}` : ''),
    sources: [src],
    warnings,
    value: res.value,
    ...(recalc ? { suppress: /no saved result/ } : {}),
  };
}

async function doFilter(task, docs, ctx) {
  const { doc, table } = pickTable(task, docs);
  const f = filterRows(table, table.rows, task.conditions || []);
  let rows = task.sort?.length ? sortRows(table, f.rows, task.sort) : f.rows;
  const matched = rows.length;
  if (task.limit) rows = rows.slice(0, task.limit);
  const src = sourceOf(
    doc,
    table,
    rows.map((r) => r.ref),
  );
  const desc = [
    ...(f.conditions.length
      ? [`Filter: ${f.conditions.map((c) => describeCondition(c)).join(' AND ')}`]
      : []),
    ...(task.sort?.length
      ? [
          `Sorted by ${task.sort.map((s) => `${s.column} (${s.direction === 'desc' ? 'high → low' : 'low → high'})`).join(', ')}`,
        ]
      : []),
    ...(task.limit ? [`Limited to ${task.limit} of ${matched} matching rows`] : []),
  ];
  const columns = [rowLabel(table), ...table.columns];
  let text = `**${plural(rows.length, 'row')}**${task.limit ? '' : ' match'} out of ${plural(table.rows.length, 'data row')}.\n\n- ${desc.join('\n- ')}\n\n${rows.length ? rowsMarkdown(table, rows) : '_No rows match._'}`;
  text += pageable(ctx, {
    title: 'Filtered rows',
    columns,
    rows: fullRows(table, rows),
    source: sourceText(src),
  });
  if (f.skipped.length)
    text += `\n\n⚠️ ${plural(f.skipped.length, 'row')} could not be compared (${[...new Set(f.skipped.map((s) => s.reason))].join(', ')}) and were left out: ${f.skipped
      .slice(0, 8)
      .map((s) => `row ${s.row} "${s.value}"`)
      .join(', ')}${f.skipped.length > 8 ? ', …' : ''}`;
  text += `\n\n_Source: ${sourceText(src)}_`;
  const out = await tableOutput(ctx, {
    output: task.output,
    title: 'Filtered rows',
    columns,
    rows: fullRows(table, rows),
    summary: desc,
    source: sourceText(src),
    fileBase: `${doc.name.replace(/\.[^.]+$/, '')}-filtered`,
  });
  return {
    markdown: text + (out ? `\n\n${out.line}` : ''),
    sources: [src],
    partial: f.skipped.length > 0,
  };
}

async function doGroup(task, docs, ctx) {
  const { doc } = pickTable(task, docs);
  let { table } = pickTable(task, docs);
  let rows = table.rows;
  const conditions = task.conditions || [];
  let f = null;
  if (conditions.length) {
    f = filterRows(table, rows, conditions);
    rows = f.rows;
  }
  let by = task.by || [];
  if (task.monthColumn) {
    const mc = resolveColumn(table, task.monthColumn);
    table = {
      ...table,
      columns: [...table.columns, 'Month'],
      columnLetters: undefined,
      rows: table.rows.map((r) => ({
        ...r,
        values: [...r.values, monthKey(r.values[mc]) || '(no date)'],
      })),
    };
    const ids = new Set(rows.map((r) => r.ref));
    rows = table.rows.filter((r) => ids.has(r.ref));
    by = ['Month'];
  }
  const g = groupRows(table, rows, { by, aggregates: task.aggregates });
  let out = g.rows;
  if (task.monthColumn)
    out = [...out].sort((a, b) => String(a.values[0]).localeCompare(String(b.values[0])));
  else if (task.sort?.length) {
    const idx = Math.max(
      0,
      g.columns.findIndex((c) => normKey(c).includes(normKey(task.sort[0].column))),
    );
    out = [...out].sort(
      (a, b) =>
        (Number(a.values[idx]) - Number(b.values[idx]) ||
          String(a.values[idx]).localeCompare(String(b.values[idx]))) *
        (task.sort[0].direction === 'desc' ? -1 : 1),
    );
  }
  if (task.limit) out = out.slice(0, task.limit);
  const src = sourceOf(
    doc,
    table,
    rows.map((r) => r.ref),
  );
  const columns = [...g.columns, 'Rows'];
  const data = out.map((r) => [...r.values, r.members.length]);
  const valueIdx = g.columns.length - 1;
  const grand = task.aggregates[0]?.column
    ? aggregate(table, rows, { fn: 'SUM', column: task.aggregates[0].column })
    : null;
  let text = `**${g.columns.slice(by.length).join(', ')} by ${by.join(', ')}** — ${plural(out.length, 'group')} from ${plural(rows.length, 'row')}.${conditions.length ? `\n\n- Filter: ${f.conditions.map((c) => describeCondition(c)).join(' AND ')}` : ''}\n\n${plainTable(columns, data)}`;
  text += pageable(ctx, { title: 'Groups', columns, rows: data, source: sourceText(src) });
  if (grand && task.aggregates[0].fn === 'SUM')
    text += `\n\n- Check: the group totals add up to ${fmtNum(data.reduce((s, r) => s + (Number(r[valueIdx]) || 0), 0))}; overall SUM = ${fmtNum(grand.value)}${task.limit ? ' (only the shown groups are added)' : ''}`;
  if (g.warnings.length) text += `\n\n⚠️ ${g.warnings.slice(0, 5).join(' ')}`;
  text += `\n\n_Source: ${sourceText(src)}_`;
  const chart =
    data.length <= 40
      ? {
          title: g.columns[valueIdx],
          labels: data.map((r) => r[0]),
          values: data.map((r) => r[valueIdx]),
          labelTitle: by.join(', '),
          valueTitle: g.columns[valueIdx],
        }
      : null;
  const outFile = await tableOutput(ctx, {
    output: task.output,
    title: `${g.columns[valueIdx]} by ${by.join(', ')}`.slice(0, 80),
    columns,
    rows: data,
    source: sourceText(src),
    chart,
    totals: task.aggregates[0]?.fn === 'SUM' ? [g.columns[valueIdx]] : [],
    fileBase: `${doc.name.replace(/\.[^.]+$/, '')}-summary`,
  });
  return { markdown: text + (outFile ? `\n\n${outFile.line}` : ''), sources: [src] };
}

async function doDuplicates(task, docs, ctx) {
  const { doc, table } = pickTable(task, docs);
  const d = findDuplicates(table, table.rows, { columns: task.columns });
  const src = sourceOf(
    doc,
    table,
    d.rows.map((r) => r.ref),
  );
  const columns = [...d.columns, 'Times', `${rowLabel(table)}s`];
  const data = d.groups.map((g) => [...g.key, g.count, compactList(g.rows)]);
  let text = d.groups.length
    ? `**${plural(d.groups.length, 'duplicate group')}** (${plural(d.duplicateRows, 'extra row')}) by ${d.columns.length === table.columns.length ? 'the whole row' : d.columns.join(' + ')}.\n\n${plainTable(columns, data)}`
    : `**No duplicates** by ${d.columns.length === table.columns.length ? 'the whole row' : d.columns.join(' + ')} in ${plural(table.rows.length, 'row')}.`;
  text += pageable(ctx, { title: 'Duplicates', columns, rows: data, source: sourceText(src) });
  text +=
    '\n\n- Matching ignores letter case and surrounding spaces. Nothing was removed; ask "remove duplicates" for a cleaned copy.';
  text += `\n\n_Source: ${sourceText(sourceOf(doc, table, []))}_`;
  const out = await tableOutput(ctx, {
    output: task.output,
    title: 'Duplicates',
    columns,
    rows: data,
    fileBase: `${doc.name.replace(/\.[^.]+$/, '')}-duplicates`,
  });
  return { markdown: text + (out ? `\n\n${out.line}` : ''), sources: [src] };
}

async function doSearch(task, docs, ctx) {
  const parts = [];
  const sources = [];
  for (const doc of docsFor(task, docs)) {
    if (doc.tables?.length && (doc.kind === 'spreadsheet' || doc.kind === 'json')) {
      for (const table of doc.tables) {
        const r = searchRows(table, table.rows, task.query, {
          column: task.column,
          exact: task.exact,
        });
        if (!r.rows.length) continue;
        const src = sourceOf(
          doc,
          table,
          r.rows.map((x) => x.ref),
        );
        sources.push(src);
        parts.push(
          `**${plural(r.rows.length, 'row')}** in ${src.where} contain "${task.query}":\n\n${rowsMarkdown(table, r.rows)}${pageable(ctx, { title: `Search: ${task.query}`, columns: [rowLabel(table), ...table.columns], rows: fullRows(table, r.rows), source: sourceText(src) })}\n\n_Source: ${sourceText(src)}_`,
        );
      }
    } else {
      const r = searchText(doc, task.query);
      if (!r.total) continue;
      sources.push({
        file: doc.name,
        where: [
          ...new Set(
            r.hits.map((h) => (h.page ? `p.${h.page}` : h.section || `para ${h.paragraph}`)),
          ),
        ]
          .slice(0, 20)
          .join(', '),
      });
      parts.push(
        `**${plural(r.total, 'match', 'matches')}** for "${r.query}" in ${doc.name}:\n\n${r.hits
          .slice(0, 30)
          .map(
            (h) =>
              `- ${h.page ? `[p.${h.page}]` : h.section ? `[§ ${h.section}]` : h.paragraph ? `[para ${h.paragraph}]` : ''} ${h.snippet}`,
          )
          .join(
            '\n',
          )}${r.hits.length > 30 || r.truncated ? `\n- … ${r.total - Math.min(30, r.hits.length)} more` : ''}`,
      );
    }
  }
  if (!parts.length)
    return {
      markdown: `"${task.query}" was not found in ${docsFor(task, docs)
        .map((d) => d.name)
        .join(', ')}.`,
      sources: [],
    };
  return { markdown: parts.join('\n\n'), sources };
}

async function doInspect(task, docs) {
  const parts = [];
  for (const doc of docsFor(task, docs)) {
    const d = describeDocument(doc);
    const m = doc.metadata || {};
    const lines = [
      `### ${doc.name}`,
      `- Type: ${doc.kind.toUpperCase()} (${doc.ext}), ${Math.max(1, Math.round((doc.size || 0) / 1024))} KB`,
    ];
    if (doc.pages)
      lines.push(
        `- Pages: ${doc.pages.length}${m.scannedPages?.length ? ` (scanned: ${compactList(m.scannedPages)})` : ''}; ${m.textBased === false ? 'image-only (scanned) PDF' : 'text-based PDF'}`,
      );
    if (m.title || m.author) lines.push(`- Title / author: ${m.title || '—'} / ${m.author || '—'}`);
    if (doc.sections?.length > 1)
      lines.push(
        `- Sections: ${doc.sections
          .slice(0, 20)
          .map((s) => s.title)
          .join(' · ')}`,
      );
    for (const t of d.tables) {
      lines.push(
        `- **${t.name}**: ${plural(t.rows, 'data row')}, ${plural(t.columns.length, 'column')}${t.headerRow ? `, header on row ${t.headerRow}` : ''}${t.formulaCells ? `, ${t.formulaCells} formula cell(s)` : ''}${t.merged ? `, ${t.merged} merged range(s)` : ''}`,
      );
      lines.push(
        '',
        plainTable(
          ['Column', 'Letter', 'Type'],
          t.columns.map((c, i) => [c, t.columnLetters?.[i] || '', t.types[i]]),
          60,
        ),
        '',
      );
    }
    if (m.sheets?.some((s) => s.empty))
      lines.push(
        `- Empty sheets: ${m.sheets
          .filter((s) => s.empty)
          .map((s) => s.name)
          .join(', ')}`,
      );
    if (doc.warnings?.length) lines.push(...doc.warnings.map((w) => `- ⚠️ ${w}`));
    parts.push(lines.join('\n'));
  }
  return { markdown: parts.join('\n\n') };
}

async function doPages(task, docs, ctx) {
  const doc = docsFor(task, docs).find((d) => d.pages);
  if (!doc) throw new DocIntelError('NOT_PAGED', 'Page ranges apply to PDF files only.');
  const r = extractPages(doc, task.pages.from, task.pages.to);
  let text = `**${doc.name} — page${r.from === r.to ? ` ${r.from}` : `s ${r.from}–${r.to}`}** of ${r.total}${r.truncated ? ` (you asked up to ${r.requestedTo}; the document ends at ${r.total})` : ''}.\n\n`;
  text += r.pages
    .map(
      (p) =>
        `#### Page ${p.number}${p.ocr ? ` _(OCR, ${p.ocr.confidence}% confidence)_` : p.scanned ? ' _(scanned — no text)_' : ''}\n\n${String(
          p.text || '',
        )
          .slice(0, 4000)
          .replace(
            /\n/g,
            '  \n',
          )}${p.text.length > 4000 ? '\n\n_… page text shortened in chat; download for the full text._' : ''}`,
    )
    .join('\n\n');
  if (task.output) {
    const sub = {
      ...doc,
      pages: r.pages,
      tables: doc.tables.filter((t) => t.source?.page >= r.from && t.source?.page <= r.to),
      text: r.pages.map((p) => p.text).join('\n\n'),
    };
    const target = ['docx', 'txt', 'pdf', 'md', 'json'].includes(task.output) ? task.output : 'txt';
    const title = `${doc.name.replace(/\.[^.]+$/, '')} pages ${r.from}-${r.to}`;
    const rendered = await renderDocument(
      target,
      { title, blocks: documentBlocks(sub), data: { file: doc.name, pages: r.pages } },
      ctx.pdfOptions,
    );
    const out = await saveVerified(ctx, {
      name: withExtension(title, target),
      buffer: rendered.buffer,
      ext: target,
      notes: rendered.notes,
    });
    text += `\n\n${out.line}`;
  }
  return { markdown: text, sources: [{ file: doc.name, where: `pages ${r.from}–${r.to}` }] };
}

async function doExplain(task, docs, ctx) {
  if (!ctx.chat)
    throw new DocIntelError(
      'MODEL_UNAVAILABLE',
      'Summaries need the local model (Ollama) to be running.',
      { status: 503 },
    );
  const targets = docsFor(task, docs);
  let content = '';
  const emitted = (t) => {
    content += t;
    ctx.emit?.(t);
  };
  const links = [];
  for (const [i, doc] of targets.entries()) {
    if (targets.length > 1) emitted(`${i ? '\n\n' : ''}## ${doc.name}\n\n`);
    const text = await explainDocument({
      doc,
      mode: task.action,
      sectionWise: task.sectionWise,
      language: task.language,
      request: ctx.message,
      pages: task.pages,
      chat: ctx.chat,
      emit: emitted,
      status: ctx.status,
      signal: ctx.signal,
    });
    if (task.output && ['docx', 'pdf', 'md', 'txt', 'html'].includes(task.output)) {
      const title = `${task.action === 'explain' ? 'Explanation' : 'Summary'} — ${doc.name.replace(/\.[^.]+$/, '')}`;
      const blocks = markdownBlocks(text);
      const r = await renderDocument(
        task.output,
        { title, blocks, header: doc.name },
        ctx.pdfOptions,
      );
      const out = await saveVerified(ctx, {
        name: withExtension(title.replace(/ — /, '-'), task.output),
        buffer: r.buffer,
        ext: task.output,
        notes: r.notes,
        expectations: { contains: [title.slice(0, 30)] },
      });
      links.push(out.line);
    }
  }
  if (links.length) emitted(`\n\n${links.join('\n\n')}`);
  return {
    markdown: content,
    streamed: true,
    sources: targets.map((d) => ({
      file: d.name,
      where: d.pages
        ? `${d.pages.length} page(s)`
        : d.sections
          ? `${d.sections.length} section(s)`
          : 'whole document',
    })),
  };
}

/** Minimal markdown → blocks for saving model text into DOCX/PDF. */
export function markdownBlocks(text) {
  const blocks = [];
  for (const part of String(text)
    .replace(/\r/g, '')
    .split(/\n{2,}/)) {
    const t = part.trim();
    if (!t) continue;
    const h = t.match(/^(#{1,6})\s+(.+)$/);
    if (h && !t.includes('\n'))
      blocks.push({
        type: 'heading',
        level: Math.min(3, h[1].length),
        text: h[2].replace(/\*\*/g, ''),
      });
    else if (t.split('\n').every((l) => /^\s*(?:[-*•]|\d+[.)])\s+/.test(l)))
      blocks.push({
        type: 'bullets',
        items: t.split('\n').map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '')),
      });
    else blocks.push({ type: 'paragraph', text: t.replace(/\n/g, ' ') });
  }
  return blocks;
}

function comparisonMarkdown(c) {
  const out = [`**Comparing ${c.a} → ${c.b}**`];
  if (c.text) {
    const t = c.text;
    if (t.identical) out.push('- Text: identical.');
    else {
      out.push(
        `- Text: ${t.counts.changed} changed, ${t.counts.added} added, ${t.counts.removed} removed (of ${t.unitsA} → ${t.unitsB} lines/paragraphs; ${t.same} unchanged).`,
      );
      if (t.changed.length)
        out.push(
          '',
          '**Changed**',
          ...t.changed
            .slice(0, 25)
            .map(
              (x) =>
                `- [${x.before.where} → ${x.after.where}] "${x.before.text.slice(0, 160)}" → "${x.after.text.slice(0, 160)}"`,
            ),
        );
      if (t.added.length)
        out.push(
          '',
          `**Only in ${c.b}**`,
          ...t.added.slice(0, 25).map((x) => `- [${x.where}] ${x.text.slice(0, 200)}`),
        );
      if (t.removed.length)
        out.push(
          '',
          `**Only in ${c.a}**`,
          ...t.removed.slice(0, 25).map((x) => `- [${x.where}] ${x.text.slice(0, 200)}`),
        );
      if (t.truncated || t.changed.length > 25 || t.added.length > 25 || t.removed.length > 25)
        out.push(
          '_Only the first differences are listed; download the comparison for all of them._',
        );
    }
  }
  for (const t of c.tables) {
    out.push(
      '',
      `**Table ${t.tableA}${t.tableA !== t.tableB ? ` ↔ ${t.tableB}` : ''}** (${t.rowsA} → ${t.rowsB} rows${t.key ? `, matched by ${t.key}` : ', matched by whole rows'})`,
    );
    if (t.columnsAdded.length) out.push(`- Columns added: ${t.columnsAdded.join(', ')}`);
    if (t.columnsRemoved.length) out.push(`- Columns removed: ${t.columnsRemoved.join(', ')}`);
    out.push(
      `- Rows added: ${t.counts.added}, removed: ${t.counts.removed}, changed cells: ${t.counts.changed}`,
    );
    if (t.mode === 'key') {
      if (t.added.length)
        out.push(
          `- Added ${t.key}: ${t.added.slice(0, 30).join(', ')}${t.added.length > 30 ? ', …' : ''}`,
        );
      if (t.removed.length)
        out.push(
          `- Removed ${t.key}: ${t.removed.slice(0, 30).join(', ')}${t.removed.length > 30 ? ', …' : ''}`,
        );
      if (t.changes.length)
        out.push(
          '',
          plainTable(
            [t.key, 'Column', 'Before', 'After', 'Rows'],
            t.changes
              .slice(0, 50)
              .map((x) => [x.key, x.column, x.before, x.after, `${x.rowA} → ${x.rowB}`]),
          ),
        );
    }
  }
  return out.join('\n');
}

async function doCompare(task, docs, ctx) {
  const [a, b] = docsFor(task, docs);
  if (!a || !b) throw new DocIntelError('NEED_TWO', 'Attach two documents to compare.');
  const c = compareDocuments(a, b);
  let text = comparisonMarkdown(c);
  ctx.emit?.(text);
  let explanation = '';
  if (
    ctx.chat &&
    !(
      c.text?.identical &&
      c.tables.every((t) => !t.counts.added && !t.counts.removed && !t.counts.changed)
    )
  ) {
    ctx.emit?.(
      '\n\n**What this means** _(explanation by the local model, based only on the differences above)_\n\n',
    );
    try {
      explanation = await explainComparison({
        comparisonMarkdown: text,
        language: task.language,
        chat: ctx.chat,
        emit: (t) => ctx.emit?.(t),
        signal: ctx.signal,
      });
      explanation = `\n\n**What this means** _(explanation by the local model, based only on the differences above)_\n\n${explanation}`;
    } catch (error) {
      if (ctx.signal?.aborted) throw error;
      explanation =
        '\n\n_The local model is unavailable, so only the exact differences are shown._';
      ctx.emit?.(explanation);
    }
  }
  text += explanation;
  if (task.output && ['docx', 'pdf', 'md', 'txt', 'html'].includes(task.output)) {
    const title = `Comparison — ${a.name} vs ${b.name}`;
    const r = await renderDocument(
      task.output,
      { title, blocks: markdownBlocks(text.replace(/^\*\*Comparing.*$/m, '')) },
      ctx.pdfOptions,
    );
    const out = await saveVerified(ctx, {
      name: withExtension(
        `comparison-${a.name.replace(/\.[^.]+$/, '')}-${b.name.replace(/\.[^.]+$/, '')}`,
        task.output,
      ),
      buffer: r.buffer,
      ext: task.output,
      notes: r.notes,
    });
    ctx.emit?.(`\n\n${out.line}`);
    text += `\n\n${out.line}`;
  }
  return {
    markdown: text,
    streamed: true,
    sources: [
      { file: a.name, where: 'whole document' },
      { file: b.name, where: 'whole document' },
    ],
  };
}

async function doConvert(task, docs, ctx) {
  const parts = [];
  for (const doc of docsFor(task, docs)) {
    ctx.status?.(`Converting ${doc.name} to ${String(task.output).toUpperCase()}`);
    let outputs;
    try {
      outputs = await convertDocument({
        doc,
        target: task.output,
        original: doc.original || null,
        signal: ctx.signal,
        soffice: ctx.soffice,
        pdfOptions: ctx.pdfOptions,
      });
    } catch (error) {
      if (!(error instanceof DocIntelError)) throw error;
      parts.push(`⚠️ **${doc.name}**: ${error.message}`);
      continue;
    }
    const lines = [`**${doc.name} → ${task.output.toUpperCase()}**`];
    for (const o of outputs) {
      const saved = await saveVerified(ctx, {
        name: o.name,
        buffer: o.buffer,
        ext: o.ext,
        expectations: o.expectations,
        notes: o.notes,
      });
      lines.push(saved.line);
      if (!saved.ok) ctx.partial = true;
    }
    if (doc.warnings?.length) lines.push(...doc.warnings.map((w) => `_⚠️ ${w}_`));
    parts.push(lines.join('\n\n'));
  }
  return { markdown: parts.join('\n\n---\n\n') };
}

/** Report from attached table data (or text docs → summary report). */
async function doGenerate(task, docs, ctx) {
  const targets = docsFor(task, docs);
  const output = task.output || 'docx';
  if (!targets.length) {
    if (!ctx.completeJSON)
      throw new DocIntelError(
        'MODEL_UNAVAILABLE',
        'Writing a new document needs the local model (Ollama) to be running.',
        { status: 503 },
      );
    ctx.status?.('Drafting the document with the local model');
    const spec = await draftDocumentSpec({
      request: ctx.message,
      output,
      completeJSON: ctx.completeJSON,
      signal: ctx.signal,
    });
    if (!spec)
      throw new DocIntelError(
        'DRAFT_FAILED',
        'The local model did not return a usable document outline. Try describing the document in more detail.',
        { status: 422 },
      );
    if (spec.sheets) {
      const sheets = spec.sheets.map((s) => ({ name: s.name, columns: s.columns, rows: [] }));
      const { buffer } = await writeXlsx({ sheets });
      const out = await saveVerified(ctx, {
        name: withExtension(spec.title, 'xlsx'),
        buffer,
        ext: 'xlsx',
        expectations: { sheets: sheets.map((s) => ({ rows: 0, columns: s.columns })) },
        notes: [
          'This is an empty template: no data rows were invented. Fill it in or attach your data and ask again for a report.',
        ],
      });
      return {
        markdown: `**${spec.title}** — Excel template with ${spec.sheets.map((s) => `"${s.name}" (${s.columns.join(', ')})`).join('; ')}.\n\n${out.line}`,
      };
    }
    const r = await renderDocument(
      output === 'xlsx' ? 'docx' : output,
      { title: spec.title, blocks: spec.blocks, header: spec.title },
      ctx.pdfOptions,
    );
    const ext = output === 'xlsx' ? 'docx' : output;
    const out = await saveVerified(ctx, {
      name: withExtension(spec.title, ext),
      buffer: r.buffer,
      ext,
      notes: [
        ...r.notes,
        'Written by the local model from your request; check names, dates and figures before sending.',
      ],
      expectations: { contains: [spec.title.slice(0, 40)] },
    });
    const preview = spec.blocks
      .slice(0, 6)
      .map((b) =>
        b.type === 'heading'
          ? `**${b.text}**`
          : b.type === 'bullets'
            ? b.items
                .slice(0, 4)
                .map((i) => `- ${i}`)
                .join('\n')
            : b.type === 'table'
              ? `_(table: ${b.columns.join(', ')})_`
              : b.text.slice(0, 300),
      )
      .join('\n\n');
    return {
      markdown: `**${spec.title}**\n\n${preview}${spec.blocks.length > 6 ? '\n\n_…_' : ''}\n\n${out.line}`,
    };
  }
  const tabular = targets.filter(
    (d) => d.tables?.length && ['spreadsheet', 'json'].includes(d.kind),
  );
  if (!tabular.length)
    return doExplain(
      { ...task, action: 'summarize', output: output === 'xlsx' ? 'docx' : output },
      docs,
      ctx,
    );
  const doc = tabular[0];
  const blocks = [];
  const sheets = [];
  const summaryLines = [];
  for (const table of doc.tables.slice(0, 10)) {
    const types = columnTypes(table);
    const numeric = table.columns.filter((_, i) => types[i] === 'number');
    const stats = numeric.map((c) => {
      const s = aggregate(table, table.rows, { fn: 'SUM', column: c });
      const avg = aggregate(table, table.rows, { fn: 'AVERAGE', column: c });
      const mn = aggregate(table, table.rows, { fn: 'MIN', column: c });
      const mx = aggregate(table, table.rows, { fn: 'MAX', column: c });
      return [
        c,
        s.value,
        avg.value === null ? '' : Math.round(avg.value * 100) / 100,
        mn.value,
        mx.value,
        s.included,
        s.blanks.length,
        s.invalid.length + s.errors.length + s.uncalculated.length,
      ];
    });
    blocks.push({ type: 'heading', level: 1, text: table.name });
    blocks.push({
      type: 'paragraph',
      text: `${plural(table.rows.length, 'row')} and ${plural(table.columns.length, 'column')} from ${sourceText(sourceOf(doc, table, []))}.`,
    });
    summaryLines.push(
      `- **${table.name}**: ${plural(table.rows.length, 'row')}${
        numeric.length
          ? `; totals: ${stats
              .slice(0, 4)
              .map((s) => `${s[0]} ${fmtNum(s[1])}`)
              .join(', ')}`
          : ''
      }`,
    );
    if (stats.length)
      blocks.push({
        type: 'table',
        columns: ['Column', 'Total', 'Average', 'Min', 'Max', 'Numbers', 'Blank', 'Excluded'],
        rows: stats,
      });
    // breakdown by the first low-cardinality text column
    const cat = table.columns.findIndex(
      (c, i) =>
        types[i] === 'text' &&
        new Set(table.rows.map((r) => display(r.values[i]).toLowerCase())).size <= 25 &&
        new Set(table.rows.map((r) => display(r.values[i]))).size > 1,
    );
    if (cat >= 0 && numeric.length) {
      const g = groupRows(table, table.rows, {
        by: [table.columns[cat]],
        aggregates: [{ fn: 'SUM', column: numeric.at(-1) }],
      });
      blocks.push({
        type: 'heading',
        level: 2,
        text: `${numeric.at(-1)} by ${table.columns[cat]}`,
      });
      blocks.push({
        type: 'chart',
        title: `${numeric.at(-1)} by ${table.columns[cat]}`,
        labels: g.rows.map((r) => r.values[0]),
        values: g.rows.map((r) => r.values[1]),
        labelTitle: table.columns[cat],
        valueTitle: `SUM of ${numeric.at(-1)}`,
      });
      sheets.push({
        name: `By ${table.columns[cat]}`.slice(0, 31),
        columns: g.columns,
        rows: g.rows.map((r) => r.values),
        totals: [g.columns[1]],
      });
    }
    const dateCol = types.findIndex((t) => t === 'date');
    if (task.monthly && dateCol >= 0 && numeric.length) {
      const withMonth = {
        ...table,
        columns: [...table.columns, 'Month'],
        columnLetters: undefined,
        rows: table.rows.map((r) => ({
          ...r,
          values: [...r.values, monthKey(r.values[dateCol]) || '(no date)'],
        })),
      };
      const g = groupRows(withMonth, withMonth.rows, {
        by: ['Month'],
        aggregates: [{ fn: 'SUM', column: numeric.at(-1) }],
      });
      const rows = g.rows
        .map((r) => r.values)
        .sort((x, y) => String(x[0]).localeCompare(String(y[0])));
      blocks.push({
        type: 'heading',
        level: 2,
        text: `Monthly ${numeric.at(-1)} (${table.columns[dateCol]})`,
      });
      blocks.push({
        type: 'chart',
        title: `Monthly ${numeric.at(-1)}`,
        labels: rows.map((r) => r[0]),
        values: rows.map((r) => r[1]),
      });
      sheets.push({ name: 'Monthly', columns: g.columns, rows, totals: [g.columns[1]] });
    } else if (task.monthly)
      summaryLines.push(
        `- ⚠️ ${table.name}: no date column was found, so there is no monthly breakdown.`,
      );
    blocks.push({ type: 'heading', level: 2, text: 'Data' });
    blocks.push({
      type: 'table',
      columns: [rowLabel(table), ...table.columns],
      rows: fullRows(table, table.rows.slice(0, 1000)),
    });
    if (table.rows.length > 1000)
      blocks.push({
        type: 'paragraph',
        italic: true,
        text: `First 1,000 of ${table.rows.length} rows shown.`,
      });
    sheets.unshift({
      name: table.name,
      columns: table.columns,
      rows: table.rows.map((r) => r.values),
      totals: numeric,
    });
    blocks.push({ type: 'pagebreak' });
  }
  if (blocks.at(-1)?.type === 'pagebreak') blocks.pop();
  const title = `${doc.name.replace(/\.[^.]+$/, '')} — ${task.monthly ? 'monthly ' : ''}report`;
  let out;
  if (output === 'xlsx') {
    const { buffer, totals } = await writeXlsx({ sheets });
    out = await saveVerified(ctx, {
      name: withExtension(title.replace(' — ', '-'), 'xlsx'),
      buffer,
      ext: 'xlsx',
      expectations: {
        sheets: sheets.map((s) => ({ rows: s.rows.length })),
        totals: totals.map((t) => ({ sheet: t.sheet, cell: t.cell, value: t.value })),
      },
      notes: [
        'Total rows use real SUM formulas with their computed values saved.',
        ...(blocks.some((b) => b.type === 'chart')
          ? ['Charts are in the PDF/Word report; the Excel file has the chart data.']
          : []),
      ],
    });
  } else {
    const r = await renderDocument(output, { title, blocks, header: doc.name }, ctx.pdfOptions);
    out = await saveVerified(ctx, {
      name: withExtension(title.replace(' — ', '-'), r.ext),
      buffer: r.buffer,
      ext: r.ext,
      notes: r.notes,
      expectations: {
        contains: [doc.tables[0].name.slice(0, 30)],
        ...(r.ext === 'docx' ? { tables: 1 } : {}),
      },
    });
  }
  return {
    markdown: `**${title}**\n\n${summaryLines.join('\n')}\n\n${out.line}`,
    sources: doc.tables.map((t) => sourceOf(doc, t, [])),
  };
}

async function doEdit(task, docs, ctx) {
  const doc = docsFor(task, docs)[0];
  if (!doc) throw new DocIntelError('NOT_FOUND', 'The document to edit is not attached.');
  if (task.edit.kind === 'replace') {
    const r = await editDocx(doc, task.edit);
    const name = withExtension(`${doc.name.replace(/\.[^.]+$/, '')}-edited`, 'docx');
    const saved = await saveVerified(ctx, {
      name,
      buffer: r.buffer,
      ext: 'docx',
      notes: r.notes,
      expectations: { contains: [task.edit.replace].filter((s) => s.length >= 3) },
    });
    return {
      markdown: `**Replaced ${plural(r.count, 'occurrence')}** of "${task.edit.find}" with "${task.edit.replace}"${task.edit.section ? ` in the "${task.edit.section}" section` : ''}.\n\n**Preview of the change**\n${r.preview.map((p) => `- ${p}`).join('\n')}\n\n${saved.line}`,
    };
  }
  const table = doc.tables.find((t) => t.name === task.sheet) || doc.tables[0];
  const r = await editSpreadsheet(doc, table?.name, task.edit);
  const name = withExtension(`${doc.name.replace(/\.[^.]+$/, '')}-edited`, 'xlsx');
  // Verify: re-open, formulas present with the expected saved results; optionally cross-check with LibreOffice.
  const verification = await verifyEditedWorkbook(r, ctx);
  const saved = verification.ok
    ? await saveVerified(ctx, {
        name,
        buffer: r.buffer,
        ext: 'xlsx',
        notes: [...r.notes, ...verification.notes],
      })
    : {
        ok: false,
        line: `⚠️ The edited workbook failed verification and was not offered: ${verification.notes.join(' ')}`,
      };
  return {
    markdown: `**Edit preview** (${r.sheet})\n${r.preview.map((p) => `- ${p}`).join('\n')}\n\n${saved.line}`,
  };
}

async function verifyEditedWorkbook(r, ctx) {
  const notes = [];
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chanakya-editcheck-'));
  try {
    const file = path.join(dir, 'edited.xlsx');
    await fs.writeFile(file, r.buffer);
    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.getWorksheet(r.sheet) || wb.worksheets[0];
    const bad = r.formulas.filter((f) => {
      const cell = ws.getCell(f.cell);
      const v = cell.value;
      return !(
        v &&
        typeof v === 'object' &&
        'formula' in v &&
        `=${v.formula}` === f.formula &&
        (f.value === null || Math.abs(Number(cell.result) - f.value) < 1e-9)
      );
    });
    if (bad.length)
      return {
        ok: false,
        notes: [`${bad.length} formula cell(s) did not round-trip (e.g. ${bad[0].cell}).`],
      };
    notes.push(
      `Re-opened: ${r.formulas.length} formula cell(s) present with the expected saved values.`,
    );
    const soffice = ctx.soffice === undefined ? findSoffice() : ctx.soffice;
    if (soffice && formulasAreSafe(r.formulas.map((f) => f.formula))) {
      try {
        const recalc = await sofficeConvert(file, '.xlsx', 'recalc', {
          soffice,
          signal: ctx.signal,
        });
        const out = path.join(dir, 'recalc.xlsx');
        await fs.writeFile(out, recalc);
        const wb2 = new ExcelJS.Workbook();
        await wb2.xlsx.readFile(out);
        const ws2 = wb2.getWorksheet(r.sheet) || wb2.worksheets[0];
        const mismatch = r.formulas
          .filter((f) => f.value !== null)
          .filter((f) => {
            const cell = ws2.getCell(f.cell);
            const res = cell.value && typeof cell.value === 'object' ? cell.result : cell.value;
            return !(Math.abs(Number(res) - f.value) <= Math.max(1e-6, Math.abs(f.value) * 1e-9));
          });
        if (mismatch.length)
          return {
            ok: false,
            notes: [
              `LibreOffice recalculation disagrees in ${mismatch.length} cell(s) (e.g. ${mismatch[0].cell}).`,
            ],
          };
        notes.push('LibreOffice recalculated every formula and got the same values.');
      } catch (error) {
        notes.push(`LibreOffice cross-check skipped (${error.message}).`);
      }
    }
    return { ok: true, notes };
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const ACTIONS = {
  range: doRange,
  lookup: doLookup,
  aggregate: doAggregate,
  filter: doFilter,
  group: doGroup,
  duplicates: doDuplicates,
  search: doSearch,
  inspect: doInspect,
  pages: doPages,
  summarize: doExplain,
  explain: doExplain,
  compare: doCompare,
  convert: doConvert,
  generate: doGenerate,
  edit: doEdit,
};

/**
 * Execute a routed task. Returns { action, status, markdown, sources, streamed? }.
 * status: ok | partial | clarify | error. Errors from DocIntelError become
 * user-facing messages; anything else is rethrown.
 */
export async function executeTask(task, docs, ctx) {
  if (task.action === 'clarify') {
    const markdown = `${task.question}${
      task.options?.length
        ? `\n\n${task.options
            .slice(0, 12)
            .map((o) => `- ${o}`)
            .join('\n')}`
        : ''
    }`;
    return { action: 'clarify', status: 'clarify', markdown };
  }
  if (task.action === 'failed') {
    const failed = docs.filter((d) => d.failed);
    return {
      action: 'failed',
      status: 'error',
      markdown: failed.map((d) => `⚠️ **${d.name}**: ${d.failed.message}`).join('\n\n'),
    };
  }
  const fn = ACTIONS[task.action];
  if (!fn)
    return {
      action: task.action,
      status: 'error',
      markdown: `The action "${task.action}" is not supported.`,
    };
  const local = { ...ctx, partial: false };
  try {
    const r = await fn(task, docs, local);
    const warnings = [...new Set(docsFor(task, docs).flatMap((d) => d.warnings || []))].filter(
      (w) => !r.suppress?.test(w),
    );
    let markdown = r.markdown;
    if (warnings.length && !['inspect', 'convert'].includes(task.action))
      markdown += `\n\n${warnings.map((w) => `_⚠️ ${w}_`).join('\n\n')}`;
    return {
      action: task.action,
      status: local.partial || r.partial ? 'partial' : 'ok',
      markdown,
      sources: r.sources || [],
      streamed: !!r.streamed,
      warnings,
    };
  } catch (error) {
    if (error instanceof DocIntelError)
      return {
        action: task.action,
        status:
          error.code === 'AMBIGUOUS_COLUMN' || error.code === 'COLUMN_REQUIRED'
            ? 'clarify'
            : 'error',
        markdown: `${error.code === 'AMBIGUOUS_COLUMN' || error.code === 'COLUMN_REQUIRED' ? '' : '⚠️ '}${error.message}`,
        code: error.code,
      };
    throw error;
  }
}

/**
 * Chat entry point. Returns null when the message is not a document task
 * (the caller then falls through to the file agent / document Q&A), else the
 * full assistant message content.
 */
export async function runDocumentIntelligence({
  message,
  userId,
  documentIds = [],
  emit,
  status,
  signal,
  deps,
}) {
  const docs = documentIds.length
    ? await deps.loadDocuments(userId, documentIds, { signal, status })
    : [];
  if (documentIds.length && !docs.length) return null;
  const task = routeTask(message, docs);
  if (!task) return null;
  status?.(statusText(task));
  let streamed = '';
  const ctx = {
    userId,
    message,
    signal,
    status,
    emit: (t) => {
      streamed += t;
      emit(t);
    },
    chat: deps.chat,
    completeJSON: deps.completeJSON,
    outputs: deps.outputs,
    results: deps.results,
    soffice: deps.soffice,
    pdfOptions: deps.pdfOptions,
  };
  const result = await executeTask(task, docs, ctx);
  if (result.streamed) {
    if (!streamed) emit(result.markdown);
    return { task, result, content: streamed || result.markdown };
  }
  emit(result.markdown);
  return { task, result, content: result.markdown };
}

function statusText(task) {
  return (
    {
      range: 'Retrieving the ID range from the file',
      lookup: 'Looking up the IDs',
      aggregate: 'Calculating from every row',
      filter: 'Filtering rows',
      group: 'Grouping and totalling',
      duplicates: 'Checking for duplicates',
      search: 'Searching the documents',
      inspect: 'Reading the file structure',
      pages: 'Extracting pages',
      summarize: 'Summarizing',
      explain: 'Explaining',
      compare: 'Comparing the documents',
      convert: 'Converting',
      generate: 'Creating the document',
      edit: 'Editing a copy of the file',
    }[task.action] || 'Working on the documents'
  );
}
