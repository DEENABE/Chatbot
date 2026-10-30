import { DocIntelError } from './errors.js';
import { LIMITS } from './formats.js';
import {
  classifyNumeric,
  display,
  exactSum,
  isBlank,
  isoDate,
  normKey,
  splitId,
  toDate,
  toNumber,
} from './values.js';

/**
 * DocumentOperationEngine: exact search, ID ranges, filters, sorting, grouping,
 * duplicate detection and Excel-style aggregations over parsed tables.
 * Everything runs on the actual parsed rows — never on model output or on a
 * top-k vector search — and every result carries row references, counts and
 * warnings so the caller can show exactly what was included.
 *
 * A table is { name, columns, columnLetters?, rows: [{ ref, values, formulas?, errors? }], source }.
 */

const STOP = new Set(['the', 'of', 'a', 'an', 'in', 'column', 'field', 'values', 'value']);
const words = (s) =>
  normText(s)
    .split(' ')
    .filter((w) => w && !STOP.has(w));
export const normText = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[_\-./()]+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Column name → index. Exact, case-insensitive, normalized, Excel letter
 * ("column C"), then a unique word match. Ambiguity is an error with candidates.
 */
export function resolveColumn(table, name) {
  const columns = table.columns;
  if (typeof name === 'number' && columns[name] !== undefined) return name;
  const wanted = String(name ?? '').trim();
  if (!wanted)
    throw new DocIntelError('COLUMN_REQUIRED', 'Which column should I use?', {
      details: { columns },
    });
  let i = columns.indexOf(wanted);
  if (i >= 0) return i;
  i = columns.findIndex((c) => c.toLowerCase() === wanted.toLowerCase());
  if (i >= 0) return i;
  i = columns.findIndex((c) => normKey(c) === normKey(wanted));
  if (i >= 0) return i;
  const letter = wanted.match(/^(?:column\s+)?([A-Z]{1,3})$/i);
  if (letter && table.columnLetters) {
    i = table.columnLetters.indexOf(letter[1].toUpperCase());
    if (i >= 0) return i;
  }
  const w = words(wanted);
  if (w.length) {
    const scored = columns
      .map((c, idx) => {
        const cw = words(c);
        const hits = w.filter(
          (x) =>
            cw.includes(x) || cw.some((y) => y.length > 3 && (y.startsWith(x) || x.startsWith(y))),
        ).length;
        return { idx, hits, exact: hits === w.length && cw.length === w.length };
      })
      .filter((s) => s.hits > 0)
      .sort((a, b) => b.hits - a.hits || Number(b.exact) - Number(a.exact));
    if (scored.length === 1 || (scored.length > 1 && scored[0].hits > scored[1].hits))
      return scored[0].idx;
    if (scored.length > 1)
      throw new DocIntelError(
        'AMBIGUOUS_COLUMN',
        `"${wanted}" matches more than one column: ${scored
          .slice(0, 6)
          .map((s) => `"${columns[s.idx]}"`)
          .join(', ')}. Which one do you mean?`,
        {
          details: { candidates: scored.map((s) => columns[s.idx]) },
        },
      );
  }
  throw new DocIntelError(
    'COLUMN_NOT_FOUND',
    `Column "${wanted}" was not found in "${table.name}". Available columns: ${columns.join(', ')}.`,
    {
      details: { columns },
    },
  );
}

export const ref = (table, row, col) => ({
  table: table.name,
  ...(table.source?.sheet ? { sheet: table.source.sheet } : {}),
  ...(table.source?.page ? { page: table.source.page } : {}),
  row: row.ref,
  ...(col !== undefined && table.columnLetters
    ? { cell: `${table.columnLetters[col]}${row.ref}` }
    : {}),
});

export function describeRef(table) {
  const s = table.source || {};
  if (s.kind === 'sheet') return `sheet "${s.sheet}"`;
  if (s.kind === 'pdf-table') return `page ${s.page}, table ${s.table}`;
  if (s.kind === 'docx-table') return `table ${s.table}`;
  return `"${table.name}"`;
}

// ------------------------------------------------------------- ID ranges

const ID_HEADER = /\b(id|code|no|number|sku|ref|item|product|emp|employee|invoice|key)\b/i;

/** The column whose values look like `sample` IDs (same prefix), preferring ID-like headers. */
export function findIdColumn(table, sample, preferred) {
  if (preferred !== undefined && preferred !== null) return resolveColumn(table, preferred);
  const target = splitId(sample);
  if (!target)
    throw new DocIntelError('BAD_ID', `"${sample}" does not look like an ID with a number.`);
  const prefix = target.prefix.toLowerCase();
  const scored = table.columns.map((c, i) => {
    let hits = 0;
    let filled = 0;
    for (const r of table.rows) {
      const v = r.values[i];
      if (isBlank(v)) continue;
      filled++;
      const id = splitId(v);
      if (id && id.prefix.toLowerCase() === prefix) hits++;
    }
    return { i, hits, ratio: filled ? hits / filled : 0, header: ID_HEADER.test(c) };
  });
  const best = scored
    .filter((s) => s.hits > 0 && s.ratio >= 0.5)
    .sort((a, b) => Number(b.header) - Number(a.header) || b.ratio - a.ratio || b.hits - a.hits);
  if (!best.length)
    throw new DocIntelError(
      'ID_COLUMN_NOT_FOUND',
      `No column in "${table.name}" contains IDs like "${sample}".`,
      { details: { columns: table.columns } },
    );
  return best[0].i;
}

/**
 * Inclusive ID range, e.g. P110..P115. Returns every existing matching row,
 * ordered by ID number (document order for equal IDs), plus missing and
 * duplicated IDs. Never returns only the first and last record.
 */
export function idRange(table, { from, to, column } = {}) {
  const a = splitId(from);
  if (!a) throw new DocIntelError('BAD_ID', `"${from}" does not look like an ID with a number.`);
  // "P110 to 115": a bare number takes the first ID's prefix.
  let b =
    /^\d+$/.test(String(to ?? '').trim()) && a.prefix
      ? splitId(`${a.prefix}${String(to).trim()}`)
      : splitId(to);
  if (!b) throw new DocIntelError('BAD_ID', `"${to}" does not look like an ID with a number.`);
  if (a.prefix.toLowerCase() !== b.prefix.toLowerCase())
    throw new DocIntelError(
      'BAD_RANGE',
      `"${from}" and "${to}" have different prefixes, so they do not form one range.`,
    );
  if (a.number > b.number)
    throw new DocIntelError(
      'BAD_RANGE',
      `The range starts after it ends (${from} > ${to}). Did you mean ${to} to ${from}?`,
    );
  const col = findIdColumn(table, a.text, column);
  const prefix = a.prefix.toLowerCase();
  const matched = [];
  for (const [order, r] of table.rows.entries()) {
    const id = splitId(r.values[col]);
    if (id && id.prefix.toLowerCase() === prefix && id.number >= a.number && id.number <= b.number)
      matched.push({ r, n: id.number, order });
  }
  matched.sort((x, y) => x.n - y.n || x.order - y.order);
  const found = new Map();
  for (const m of matched) found.set(m.n, (found.get(m.n) || 0) + 1);
  const span = b.number - a.number + 1;
  const width = Math.max(a.width, b.width);
  const fmt = (n) =>
    `${a.prefix}${a.width > String(n).length || b.width > String(n).length ? String(n).padStart(width, '0') : n}`;
  const missing = [];
  if (span <= 100_000)
    for (let n = a.number; n <= b.number; n++) if (!found.has(n)) missing.push(fmt(n));
  const duplicates = [...found]
    .filter(([, c]) => c > 1)
    .map(([n, c]) => ({ id: fmt(n), count: c }));
  return {
    operation: 'range',
    column: table.columns[col],
    requested: { from: a.text, to: b.text, count: span },
    rows: matched.map((m) => m.r),
    total: matched.length,
    missing,
    missingCount: span <= 100_000 ? missing.length : null,
    duplicates,
    verified: verifyRange(
      matched.map((m) => m.r),
      col,
      a,
      b,
    ),
  };
}

/** Independent re-check: every returned ID is inside the range and in non-decreasing order. */
function verifyRange(rows, col, a, b) {
  let last = -Infinity;
  for (const r of rows) {
    const id = splitId(r.values[col]);
    if (
      !id ||
      id.prefix.toLowerCase() !== a.prefix.toLowerCase() ||
      id.number < a.number ||
      id.number > b.number ||
      id.number < last
    )
      return false;
    last = id.number;
  }
  return true;
}

/** Exact lookup of a list of IDs / values in one column; reports which were not found. */
export function lookupValues(table, values, { column } = {}) {
  const col = column !== undefined ? resolveColumn(table, column) : findIdColumn(table, values[0]);
  const wanted = values.map((v) => String(v).trim());
  const index = new Map();
  for (const r of table.rows) {
    const key = String(display(r.values[col])).trim().toLowerCase();
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(r);
  }
  const rows = [];
  const missing = [];
  for (const v of wanted) {
    const hit = index.get(v.toLowerCase());
    if (hit) rows.push(...hit);
    else missing.push(v);
  }
  return {
    operation: 'lookup',
    column: table.columns[col],
    requested: { values: wanted, count: wanted.length },
    rows,
    total: rows.length,
    missing,
    missingCount: missing.length,
  };
}

// --------------------------------------------------------------- filters

export const FILTER_OPS = [
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'between',
  'contains',
  'not_contains',
  'starts',
  'ends',
  'empty',
  'not_empty',
  'in',
  'date_between',
  'date_before',
  'date_after',
  'date_on',
];
const NUMERIC_OPS = new Set(['gt', 'gte', 'lt', 'lte', 'between']);
const DATE_OPS = new Set(['date_between', 'date_before', 'date_after', 'date_on']);

export function describeCondition(c, table) {
  const name = typeof c.column === 'number' ? table?.columns[c.column] : c.column;
  const v = (x) => (typeof x === 'number' ? x.toLocaleString('en-IN') : `"${x}"`);
  switch (c.op) {
    case 'eq':
      return `${name} = ${v(c.value)}`;
    case 'ne':
      return `${name} ≠ ${v(c.value)}`;
    case 'gt':
      return `${name} > ${v(c.value)}`;
    case 'gte':
      return `${name} ≥ ${v(c.value)}`;
    case 'lt':
      return `${name} < ${v(c.value)}`;
    case 'lte':
      return `${name} ≤ ${v(c.value)}`;
    case 'between':
      return `${name} between ${v(c.value)} and ${v(c.value2)} (inclusive)`;
    case 'contains':
      return `${name} contains ${v(c.value)}`;
    case 'not_contains':
      return `${name} does not contain ${v(c.value)}`;
    case 'starts':
      return `${name} starts with ${v(c.value)}`;
    case 'ends':
      return `${name} ends with ${v(c.value)}`;
    case 'empty':
      return `${name} is empty`;
    case 'not_empty':
      return `${name} is not empty`;
    case 'in':
      return `${name} is one of ${c.value.map(v).join(', ')}`;
    case 'date_between':
      return `${name} from ${c.value} to ${c.value2} (inclusive)`;
    case 'date_before':
      return `${name} before ${c.value}`;
    case 'date_after':
      return `${name} after ${c.value}`;
    case 'date_on':
      return `${name} on ${c.value}`;
    default:
      return `${name} ${c.op} ${v(c.value)}`;
  }
}

/**
 * Apply AND-ed conditions. Rows whose cell cannot be compared (text in a
 * numeric comparison, an unreadable date) are excluded and reported, never
 * silently treated as 0.
 */
export function filterRows(table, rows, conditions = []) {
  const resolved = conditions.map((c) => {
    if (!FILTER_OPS.includes(c.op))
      throw new DocIntelError('BAD_FILTER', `Unknown filter "${c.op}".`);
    const col = resolveColumn(table, c.column);
    const out = { ...c, col, column: table.columns[col] };
    if (NUMERIC_OPS.has(c.op)) {
      out.n1 = toNumber(c.value);
      out.n2 = c.op === 'between' ? toNumber(c.value2) : null;
      if (out.n1 === null || (c.op === 'between' && out.n2 === null)) {
        // Allow date comparisons through the numeric operators ("after 2024-01-01").
        const d1 = toDate(String(c.value));
        if (d1 !== null)
          return {
            ...out,
            op:
              c.op === 'between'
                ? 'date_between'
                : c.op.startsWith('g')
                  ? 'date_after'
                  : 'date_before',
            d1,
            d2: c.op === 'between' ? toDate(String(c.value2)) : null,
            inclusive: c.op.endsWith('e'),
          };
        throw new DocIntelError(
          'BAD_FILTER',
          `"${c.value}${c.op === 'between' ? ` / ${c.value2}` : ''}" is not a number for the ${table.columns[col]} filter.`,
        );
      }
      if (c.op === 'between' && out.n1 > out.n2) [out.n1, out.n2] = [out.n2, out.n1];
    }
    if (DATE_OPS.has(c.op)) {
      out.d1 = toDate(String(c.value));
      out.d2 = c.op === 'date_between' ? toDate(String(c.value2)) : null;
      if (out.d1 === null || (c.op === 'date_between' && out.d2 === null))
        throw new DocIntelError(
          'BAD_FILTER',
          `"${c.value}${c.value2 ? ` / ${c.value2}` : ''}" is not a date I can read. Use a format like 2024-03-31 or 31/03/2024.`,
        );
      if (c.op === 'date_between' && out.d1 > out.d2) [out.d1, out.d2] = [out.d2, out.d1];
    }
    return out;
  });
  const skipped = [];
  const kept = [];
  for (const r of rows) {
    let ok = true;
    for (const c of resolved) {
      const cell = r.values[c.col];
      const verdict = test(cell, c);
      if (verdict === null) {
        if (!isBlank(cell))
          skipped.push({
            row: r.ref,
            column: c.column,
            value: display(cell),
            reason: DATE_OPS.has(c.op) ? 'not a date' : 'not a number',
          });
        ok = false;
        break;
      }
      if (!verdict) {
        ok = false;
        break;
      }
    }
    if (ok) kept.push(r);
  }
  return { rows: kept, conditions: resolved, skipped };
}

function test(cell, c) {
  const text = display(cell).trim();
  const lower = text.toLowerCase();
  const target = String(c.value ?? '')
    .trim()
    .toLowerCase();
  switch (c.op) {
    case 'empty':
      return isBlank(cell);
    case 'not_empty':
      return !isBlank(cell);
    case 'contains':
      return lower.includes(target);
    case 'not_contains':
      return !lower.includes(target);
    case 'starts':
      return lower.startsWith(target);
    case 'ends':
      return lower.endsWith(target);
    case 'in':
      return c.value.some((x) => String(x).trim().toLowerCase() === lower);
    case 'eq':
    case 'ne': {
      const a = toNumber(cell);
      const b = toNumber(c.value);
      let equal = a !== null && b !== null ? a === b : lower === target;
      if (!equal) {
        const da = toDate(cell instanceof Date ? cell : text);
        const db = toDate(String(c.value));
        if (da !== null && db !== null) equal = da === db;
      }
      return c.op === 'eq' ? equal : !equal;
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte':
    case 'between': {
      if (isBlank(cell)) return null;
      const n = toNumber(cell);
      if (n === null) return null;
      if (c.op === 'gt') return n > c.n1;
      if (c.op === 'gte') return n >= c.n1;
      if (c.op === 'lt') return n < c.n1;
      if (c.op === 'lte') return n <= c.n1;
      return n >= c.n1 && n <= c.n2;
    }
    default: {
      if (isBlank(cell)) return null;
      const d = toDate(cell instanceof Date ? cell : text);
      if (d === null) return null;
      const day = Math.floor(d / 86_400_000) * 86_400_000;
      if (c.op === 'date_on') return day === c.d1;
      if (c.op === 'date_after') return c.inclusive ? day >= c.d1 : day > c.d1;
      if (c.op === 'date_before') return c.inclusive ? day <= c.d1 : day < c.d1;
      return day >= c.d1 && day <= c.d2;
    }
  }
}

/** Case-insensitive search for `query` in any (or one) column. exact=true matches whole cells. */
export function searchRows(table, rows, query, { column, exact = false } = {}) {
  const q = String(query ?? '')
    .trim()
    .toLowerCase();
  if (!q) throw new DocIntelError('BAD_QUERY', 'What should I search for?');
  const cols =
    column !== undefined && column !== null
      ? [resolveColumn(table, column)]
      : table.columns.map((_, i) => i);
  const hits = [];
  for (const r of rows) {
    const matchCols = cols.filter((i) => {
      const t = display(r.values[i]).trim().toLowerCase();
      return exact ? t === q : t.includes(q);
    });
    if (matchCols.length) hits.push({ row: r, columns: matchCols.map((i) => table.columns[i]) });
  }
  return {
    rows: hits.map((h) => h.row),
    matches: hits.map((h) => ({ row: h.row.ref, columns: h.columns })),
  };
}

// --------------------------------------------------------------- sorting

export function compareCells(a, b) {
  if (isBlank(a) && isBlank(b)) return 0;
  if (isBlank(a)) return 1;
  if (isBlank(b)) return -1;
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) return na - nb;
  const da = toDate(a instanceof Date ? a : String(a));
  const db = toDate(b instanceof Date ? b : String(b));
  if (da !== null && db !== null) return da - db;
  return display(a).localeCompare(display(b), 'en', { sensitivity: 'base', numeric: true });
}

/** Stable multi-key sort; blanks always last. */
export function sortRows(table, rows, keys = []) {
  const resolved = keys.map((k) => ({
    col: resolveColumn(table, k.column),
    dir: /^d/i.test(k.direction || 'asc') ? -1 : 1,
  }));
  return rows
    .map((r, i) => [r, i])
    .sort(([a, ia], [b, ib]) => {
      for (const k of resolved) {
        const va = a.values[k.col];
        const vb = b.values[k.col];
        if (isBlank(va) !== isBlank(vb)) return isBlank(va) ? 1 : -1;
        const c = compareCells(va, vb) * k.dir;
        if (c) return c;
      }
      return ia - ib;
    })
    .map(([r]) => r);
}

// ----------------------------------------------------------- aggregation

export const AGGREGATES = [
  'SUM',
  'AVERAGE',
  'COUNT',
  'COUNTA',
  'COUNTBLANK',
  'MIN',
  'MAX',
  'COUNTIF',
  'SUMIF',
  'AVERAGEIF',
  'MEDIAN',
];

const round = (n) => (n === null ? null : Math.round(n * 1e10) / 1e10);

/**
 * Excel-style aggregate over `rows`, with an explicit account of what was used:
 *   included   numeric cells counted
 *   blanks     empty cells (refs)
 *   invalid    text / error cells that are not numbers (refs + value) — never treated as 0
 *   textNumbers numbers stored as text that were converted ("1,200")
 *   formulaResults values that came from cached formula results
 * COUNTIF / SUMIF / AVERAGEIF take `criteria` (filter conditions) and, for
 * SUMIF/AVERAGEIF, `column` is the column that is summed.
 */
export function aggregate(table, rows, { fn, column, criteria = [] } = {}) {
  const FN = String(fn || '').toUpperCase();
  if (!AGGREGATES.includes(FN))
    throw new DocIntelError(
      'BAD_AGGREGATE',
      `Unsupported calculation "${fn}". Supported: ${AGGREGATES.join(', ')}.`,
    );
  let scope = rows;
  let applied = [];
  let skipped = [];
  if (/IF$/.test(FN)) {
    if (!criteria.length)
      throw new DocIntelError(
        'CRITERIA_REQUIRED',
        `${FN} needs a condition, for example "where Region is South".`,
      );
    const f = filterRows(table, rows, criteria);
    scope = f.rows;
    applied = f.conditions;
    skipped = f.skipped;
  }
  const base = {
    fn: FN,
    rowsConsidered: scope.length,
    conditions: applied.map((c) => describeCondition(c)),
    conditionSkipped: skipped,
  };
  if (FN === 'COUNTIF' && (column === undefined || column === null))
    return {
      ...base,
      value: scope.length,
      included: scope.length,
      column: null,
      blanks: [],
      invalid: [],
      errors: [],
      uncalculated: [],
      textNumbers: 0,
      formulaResults: 0,
      verified: true,
    };
  if (column === undefined || column === null)
    throw new DocIntelError('COLUMN_REQUIRED', `Which column should ${FN} use?`, {
      details: { columns: table.columns },
    });
  const col = resolveColumn(table, column);
  const blanks = [];
  const invalid = [];
  const errors = [];
  const uncalculated = [];
  const numbers = [];
  let textNumbers = 0;
  let formulaResults = 0;
  const strictNumbers = []; // real numeric cells only — what Excel's SUM/AVERAGE see (text numbers are ignored there)
  for (const r of scope) {
    const err = r.errors?.[col];
    if (err) {
      errors.push({ row: r.ref, error: err });
      continue;
    }
    const v = r.values[col];
    const k = classifyNumeric(v);
    // A formula whose result was never saved is unknown, not empty and not zero.
    if (k.kind === 'blank' && r.formulas?.[col])
      uncalculated.push({ row: r.ref, formula: r.formulas[col] });
    else if (k.kind === 'blank') blanks.push(r.ref);
    else if (k.kind === 'invalid') invalid.push({ row: r.ref, value: display(v) });
    else {
      numbers.push(k.value);
      if (typeof v === 'string') textNumbers++;
      else strictNumbers.push(k.value);
      if (r.formulas?.[col]) formulaResults++;
    }
  }
  const nonBlank = scope.length - blanks.length - uncalculated.length;
  let value;
  switch (FN) {
    case 'SUM':
    case 'SUMIF':
      value = exactSum(numbers);
      break;
    case 'AVERAGE':
    case 'AVERAGEIF':
      value = numbers.length ? exactSum(numbers) / numbers.length : null;
      break;
    case 'MEDIAN': {
      const s = [...numbers].sort((x, y) => x - y);
      value = s.length
        ? s.length % 2
          ? s[(s.length - 1) / 2]
          : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
        : null;
      break;
    }
    case 'COUNT':
      value = numbers.length;
      break;
    case 'COUNTA':
      value = nonBlank;
      break;
    case 'COUNTBLANK':
      value = blanks.length;
      break;
    case 'COUNTIF':
      value = nonBlank;
      break;
    case 'MIN':
      value = numbers.length ? Math.min(...numbers) : null;
      break;
    case 'MAX':
      value = numbers.length ? Math.max(...numbers) : null;
      break;
    default:
      value = null;
  }
  let at = null;
  if ((FN === 'MIN' || FN === 'MAX') && value !== null) {
    at = scope.filter((r) => toNumber(r.values[col]) === value).map((r) => r.ref);
  }
  return {
    ...base,
    column: table.columns[col],
    columnLetter: table.columnLetters?.[col],
    value: round(value),
    included: ['COUNTA', 'COUNTBLANK', 'COUNTIF'].includes(FN) ? value : numbers.length,
    blanks,
    invalid,
    errors,
    uncalculated,
    textNumbers,
    formulaResults,
    ...(at ? { at } : {}),
    // When numbers are stored as text, Excel's own SUM/AVERAGE would give a different result.
    ...(textNumbers && ['SUM', 'SUMIF'].includes(FN)
      ? { excelValue: round(exactSum(strictNumbers)) }
      : {}),
    ...(textNumbers && ['AVERAGE', 'AVERAGEIF'].includes(FN)
      ? {
          excelValue: strictNumbers.length
            ? round(exactSum(strictNumbers) / strictNumbers.length)
            : null,
        }
      : {}),
    verified: FN === 'SUM' || FN === 'SUMIF' ? verifySum(numbers, value) : true,
  };
}

/** Second, independent computation (plain floating-point) must agree to 1e-6 relative. */
function verifySum(numbers, value) {
  const plain = numbers.reduce((s, x) => s + x, 0);
  return Math.abs(plain - value) <= Math.max(1e-6, Math.abs(value) * 1e-9);
}

/** Group rows by one or more columns and aggregate each group. */
export function groupRows(table, rows, { by = [], aggregates = [{ fn: 'COUNTA' }] } = {}) {
  if (!by.length)
    throw new DocIntelError('COLUMN_REQUIRED', 'Group by which column?', {
      details: { columns: table.columns },
    });
  const byCols = by.map((b) => resolveColumn(table, b));
  const groups = new Map();
  for (const r of rows) {
    const key = JSON.stringify(byCols.map((i) => display(r.values[i]).trim().toLowerCase()));
    if (!groups.has(key))
      groups.set(key, { label: byCols.map((i) => display(r.values[i]).trim()), rows: [] });
    groups.get(key).rows.push(r);
  }
  const aggs = aggregates.map((a) => ({ fn: String(a.fn).toUpperCase(), column: a.column }));
  const columns = [
    ...byCols.map((i) => table.columns[i]),
    ...aggs.map((a) =>
      a.column === undefined || a.column === null
        ? 'Row count'
        : `${a.fn} of ${table.columns[resolveColumn(table, a.column)]}`,
    ),
  ];
  const warnings = [];
  const out = [...groups.values()].map((g, gi) => {
    const values = [...g.label.map((l) => l || '(blank)')];
    for (const a of aggs) {
      if (a.column === undefined || a.column === null) values.push(g.rows.length);
      else {
        const res = aggregate(table, g.rows, a);
        values.push(res.value);
        if (res.invalid.length || res.errors.length)
          warnings.push(
            `${values[0]}: ${res.invalid.length + res.errors.length} non-numeric cell(s) in ${res.column} excluded.`,
          );
      }
    }
    return { ref: gi + 1, values, members: g.rows.map((r) => r.ref) };
  });
  return { columns, rows: out, groups: out.length, warnings: warnings.slice(0, 20) };
}

/** Rows grouped by a calendar month of a date column ("monthly" reports). */
export function monthKey(cell) {
  const t = toDate(cell instanceof Date ? cell : display(cell));
  return t === null ? null : isoDate(t).slice(0, 7);
}

// ------------------------------------------------------------ duplicates

/** Rows sharing the same key (selected columns, or the whole row), with their row refs. */
export function findDuplicates(table, rows, { columns } = {}) {
  const cols = columns?.length
    ? columns.map((c) => resolveColumn(table, c))
    : table.columns.map((_, i) => i);
  const map = new Map();
  for (const r of rows) {
    const key = cols.map((i) => display(r.values[i]).trim().toLowerCase());
    if (key.every((k) => !k)) continue;
    const k = JSON.stringify(key);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(r);
  }
  const groups = [...map.values()].filter((g) => g.length > 1);
  return {
    operation: 'duplicates',
    columns: cols.map((i) => table.columns[i]),
    groups: groups.map((g) => ({
      key: cols.map((i) => display(g[0].values[i])),
      rows: g.map((r) => r.ref),
      count: g.length,
    })),
    duplicateRows: groups.reduce((n, g) => n + g.length - 1, 0),
    rows: groups.flat(),
  };
}

// ------------------------------------------------------------- paging

/** Never truncates silently: returns the page plus the total and page count. */
export function paginate(rows, { page = 1, pageSize = LIMITS.pageSize } = {}) {
  const size = Math.max(1, Math.min(LIMITS.maxPageSize, Math.floor(pageSize) || LIMITS.pageSize));
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const current = Math.min(Math.max(1, Math.floor(page) || 1), pages);
  const start = (current - 1) * size;
  return {
    rows: rows.slice(start, start + size),
    total: rows.length,
    page: current,
    pageSize: size,
    pages,
    from: rows.length ? start + 1 : 0,
    to: Math.min(start + size, rows.length),
  };
}

// --------------------------------------------------------- text search

/** Keyword / phrase search in page or block text with page/paragraph references. */
export function searchText(doc, query, { maxHits = 200 } = {}) {
  const q = String(query ?? '').trim();
  if (!q) throw new DocIntelError('BAD_QUERY', 'What should I search for?');
  const lower = q.toLowerCase();
  const hits = [];
  const units = doc.pages
    ? doc.pages.map((p) => ({ where: { page: p.number }, text: p.text }))
    : (doc.blocks || []).map((b) => ({
        where: { paragraph: b.index, section: sectionFor(doc, b.index) },
        text:
          b.type === 'list'
            ? b.items.join('\n')
            : b.type === 'table'
              ? [b.columns.join(' | '), ...b.rows.map((r) => r.join(' | '))].join('\n')
              : b.text,
      }));
  if (!units.length && doc.text) units.push({ where: {}, text: doc.text });
  let total = 0;
  for (const u of units) {
    const text = String(u.text || '');
    const hay = text.toLowerCase();
    let i = hay.indexOf(lower);
    while (i >= 0) {
      total++;
      if (hits.length < maxHits) {
        const start = Math.max(0, i - 80);
        const end = Math.min(text.length, i + q.length + 80);
        hits.push({
          ...u.where,
          snippet: `${start ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`,
        });
      }
      i = hay.indexOf(lower, i + lower.length);
    }
  }
  return { query: q, total, hits, truncated: total > hits.length };
}

function sectionFor(doc, index) {
  const s = (doc.sections || []).find((x) => index >= x.start && index <= x.end);
  return s ? s.title : undefined;
}

/** Page range extraction for PDFs (inclusive, 1-based). */
export function extractPages(doc, from, to = from) {
  if (!doc.pages) throw new DocIntelError('NOT_PAGED', 'Page ranges apply to PDF files only.');
  const total = doc.pages.length;
  const a = Math.floor(Number(from));
  const b = Math.floor(Number(to));
  if (!(a >= 1) || !(b >= a)) throw new DocIntelError('BAD_RANGE', 'The page range is not valid.');
  if (a > total) throw new DocIntelError('BAD_RANGE', `The document has only ${total} page(s).`);
  const pages = doc.pages.slice(a - 1, Math.min(b, total));
  return { from: a, to: Math.min(b, total), requestedTo: b, total, pages, truncated: b > total };
}
