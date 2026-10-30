/**
 * Deterministic table operations. The model only proposes a plan; every number
 * in the output is computed here, so totals and filters are exact.
 * A table is { name, columns: string[], rows: any[][] }.
 */

export class TableOpError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TableOpError';
    this.status = 400;
  }
}

export const OPERATIONS = [
  'trim',
  'dropEmptyRows',
  'dropEmptyColumns',
  'dedupe',
  'filter',
  'sort',
  'select',
  'remove',
  'rename',
  'fillEmpty',
  'groupBy',
  'limit',
];
export const FILTER_OPERATORS = [
  '=',
  '!=',
  '>',
  '>=',
  '<',
  '<=',
  'contains',
  'notContains',
  'startsWith',
  'endsWith',
  'empty',
  'notEmpty',
];
export const AGGREGATES = ['sum', 'count', 'avg', 'min', 'max'];

const norm = (v) =>
  String(v ?? '')
    .toLowerCase()
    .replace(/[\s_\-./()]+/g, '');

export const isEmpty = (v) => v === null || v === undefined || String(v).trim() === '';

export function toNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  let s = v.trim();
  if (!s) return null;
  const negative = /^\(.*\)$/.test(s);
  s = s.replace(/^\(|\)$/g, '').replace(/(?:₹|rs\.?|inr|\$|€|£|usd)/gi, '').replace(/[,\s]/g, '');
  const percent = s.endsWith('%');
  if (percent) s = s.slice(0, -1);
  if (!/^[-+]?\d*\.?\d+(?:e[-+]?\d+)?$/i.test(s)) return null;
  const n = Number(s) * (negative ? -1 : 1);
  return Number.isFinite(n) ? n : null;
}

function toDate(v) {
  if (v instanceof Date) return v.getTime();
  if (typeof v !== 'string' || !v.trim()) return null;
  const s = v.trim();
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/); // dd/mm/yyyy (India default)
  if (m) {
    const t = Date.UTC(+m[3], +m[2] - 1, +m[1]);
    return Number.isFinite(t) ? t : null;
  }
  m = s.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})/);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  if (!/[a-z]/i.test(s)) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

export function resolveColumn(columns, name) {
  if (typeof name !== 'string' || !name.trim())
    throw new TableOpError('A column name is required.');
  const exact = columns.indexOf(name);
  if (exact >= 0) return exact;
  const lower = columns.findIndex((c) => String(c).toLowerCase() === name.toLowerCase());
  if (lower >= 0) return lower;
  const n = norm(name);
  const normalized = columns.findIndex((c) => norm(c) === n);
  if (normalized >= 0) return normalized;
  const partial = columns.filter((c) => n && (norm(c).includes(n) || n.includes(norm(c))));
  if (partial.length === 1) return columns.indexOf(partial[0]);
  throw new TableOpError(
    `Column "${name}" was not found. Available columns: ${columns.join(', ')}.`,
  );
}

function compareValues(a, b) {
  if (isEmpty(a) && isEmpty(b)) return 0;
  if (isEmpty(a)) return 1; // empty values last
  if (isEmpty(b)) return -1;
  const na = toNumber(a);
  const nb = toNumber(b);
  if (na !== null && nb !== null) return na - nb;
  const da = toDate(a);
  const db = toDate(b);
  if (da !== null && db !== null) return da - db;
  return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
}

function matches(cell, operator, value) {
  const text = String(cell ?? '').trim();
  const target = String(value ?? '').trim();
  switch (operator) {
    case 'empty':
      return isEmpty(cell);
    case 'notEmpty':
      return !isEmpty(cell);
    case 'contains':
      return text.toLowerCase().includes(target.toLowerCase());
    case 'notContains':
      return !text.toLowerCase().includes(target.toLowerCase());
    case 'startsWith':
      return text.toLowerCase().startsWith(target.toLowerCase());
    case 'endsWith':
      return text.toLowerCase().endsWith(target.toLowerCase());
    case '=':
    case '!=': {
      const nc = toNumber(cell);
      const nv = toNumber(value);
      const equal =
        nc !== null && nv !== null ? nc === nv : text.toLowerCase() === target.toLowerCase();
      return operator === '=' ? equal : !equal;
    }
    default: {
      if (isEmpty(cell)) return false;
      const c = compareValues(cell, value);
      if (operator === '>') return c > 0;
      if (operator === '>=') return c >= 0;
      if (operator === '<') return c < 0;
      if (operator === '<=') return c <= 0;
      throw new TableOpError(`Unknown filter operator "${operator}".`);
    }
  }
}

const round = (n) => Math.round(n * 1e6) / 1e6;

export function applyOperation(table, op) {
  const columns = [...table.columns];
  let rows = table.rows.map((r) => [...r]);
  const col = (name) => resolveColumn(columns, name);
  switch (op.op) {
    case 'trim':
      rows = rows.map((r) =>
        r.map((v) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : v)),
      );
      break;
    case 'dropEmptyRows':
      rows = rows.filter((r) => r.some((v) => !isEmpty(v)));
      break;
    case 'dropEmptyColumns': {
      const keep = columns.map((_, i) => rows.some((r) => !isEmpty(r[i])));
      return {
        ...table,
        columns: columns.filter((_, i) => keep[i]),
        rows: rows.map((r) => r.filter((_, i) => keep[i])),
      };
    }
    case 'dedupe': {
      const idx = Array.isArray(op.columns) && op.columns.length ? op.columns.map(col) : null;
      const seen = new Set();
      rows = rows.filter((r) => {
        const key = JSON.stringify(
          (idx ? idx.map((i) => r[i]) : r).map((v) =>
            String(v ?? '')
              .trim()
              .toLowerCase(),
          ),
        );
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      break;
    }
    case 'filter': {
      if (!FILTER_OPERATORS.includes(op.operator))
        throw new TableOpError(`Unknown filter operator "${op.operator}".`);
      const i = col(op.column);
      rows = rows.filter((r) => matches(r[i], op.operator, op.value));
      break;
    }
    case 'sort': {
      const i = col(op.column);
      const dir = String(op.direction || 'asc').toLowerCase().startsWith('d') ? -1 : 1;
      rows = rows
        .map((r, n) => [r, n])
        .sort((a, b) => {
          const c = compareValues(a[0][i], b[0][i]);
          if (isEmpty(a[0][i]) || isEmpty(b[0][i])) return c || a[1] - b[1];
          return c * dir || a[1] - b[1];
        })
        .map(([r]) => r);
      break;
    }
    case 'select': {
      if (!Array.isArray(op.columns) || !op.columns.length)
        throw new TableOpError('select needs a list of columns.');
      const idx = op.columns.map(col);
      return { ...table, columns: idx.map((i) => columns[i]), rows: rows.map((r) => idx.map((i) => r[i])) };
    }
    case 'remove': {
      if (!Array.isArray(op.columns) || !op.columns.length)
        throw new TableOpError('remove needs a list of columns.');
      const drop = new Set(op.columns.map(col));
      return {
        ...table,
        columns: columns.filter((_, i) => !drop.has(i)),
        rows: rows.map((r) => r.filter((_, i) => !drop.has(i))),
      };
    }
    case 'rename': {
      const i = col(op.from);
      if (typeof op.to !== 'string' || !op.to.trim()) throw new TableOpError('rename needs a new name.');
      columns[i] = op.to.trim().slice(0, 200);
      break;
    }
    case 'fillEmpty': {
      const idx = op.column ? [col(op.column)] : columns.map((_, i) => i);
      const value = op.value ?? '';
      rows = rows.map((r) => {
        const copy = [...r];
        for (const i of idx) if (isEmpty(copy[i])) copy[i] = value;
        return copy;
      });
      break;
    }
    case 'groupBy': {
      const by = (Array.isArray(op.by) ? op.by : [op.by]).filter(Boolean).map(col);
      if (!by.length) throw new TableOpError('groupBy needs at least one column.');
      const aggregates = (Array.isArray(op.aggregates) && op.aggregates.length
        ? op.aggregates
        : [{ fn: 'count' }]
      ).map((a) => {
        if (!AGGREGATES.includes(a.fn)) throw new TableOpError(`Unknown aggregate "${a.fn}".`);
        if (a.fn !== 'count' && !a.column) throw new TableOpError(`${a.fn} needs a column.`);
        return { fn: a.fn, index: a.column ? col(a.column) : null };
      });
      const groups = new Map();
      for (const r of rows) {
        const key = JSON.stringify(by.map((i) => String(r[i] ?? '').trim()));
        if (!groups.has(key)) groups.set(key, { values: by.map((i) => r[i]), rows: [] });
        groups.get(key).rows.push(r);
      }
      const outRows = [...groups.values()].map((g) => [
        ...g.values,
        ...aggregates.map(({ fn, index }) => {
          if (fn === 'count')
            return index === null ? g.rows.length : g.rows.filter((r) => !isEmpty(r[index])).length;
          const nums = g.rows.map((r) => toNumber(r[index])).filter((n) => n !== null);
          if (!nums.length) return '';
          if (fn === 'sum') return round(nums.reduce((s, n) => s + n, 0));
          if (fn === 'avg') return round(nums.reduce((s, n) => s + n, 0) / nums.length);
          if (fn === 'min') return Math.min(...nums);
          return Math.max(...nums);
        }),
      ]);
      return {
        ...table,
        columns: [
          ...by.map((i) => columns[i]),
          ...aggregates.map(({ fn, index }) =>
            fn === 'count' && index === null ? 'Count' : `${fn[0].toUpperCase()}${fn.slice(1)} of ${columns[index]}`,
          ),
        ],
        rows: outRows,
      };
    }
    case 'limit': {
      const n = Math.max(0, Math.min(1_000_000, Math.floor(Number(op.n) || 0)));
      rows = rows.slice(0, n);
      break;
    }
    default:
      throw new TableOpError(`Unsupported operation "${op.op}".`);
  }
  return { ...table, columns, rows };
}

/** Stack several tables into one; columns are matched by normalized name. */
export function mergeTables(tables, { sourceColumn = true } = {}) {
  const columns = [];
  const keys = [];
  for (const t of tables)
    for (const c of t.columns)
      if (!keys.includes(norm(c))) {
        keys.push(norm(c));
        columns.push(c);
      }
  const rows = [];
  for (const t of tables) {
    const map = t.columns.map((c) => keys.indexOf(norm(c)));
    for (const r of t.rows) {
      if (r.every(isEmpty)) continue; // the Source column must not make empty rows look filled
      const out = new Array(columns.length).fill('');
      map.forEach((target, i) => (out[target] = r[i] ?? ''));
      if (sourceColumn) out.push(t.source || t.name);
      rows.push(out);
    }
  }
  return {
    name: 'Merged',
    columns: sourceColumn ? [...columns, 'Source'] : columns,
    rows,
  };
}

export function runPlan(tables, plan) {
  let working = plan.merge && tables.length > 1 ? [mergeTables(tables)] : tables;
  const log = [];
  for (const op of plan.operations || []) {
    working = working.map((t) => {
      const before = t.rows.length;
      const out = applyOperation(t, op);
      log.push({ table: t.name, op: op.op, before, after: out.rows.length });
      return out;
    });
  }
  return { tables: working, log };
}

/** Quick data-quality profile used when a spreadsheet is uploaded without instructions. */
export function profileTable(table) {
  const columns = table.columns.map((name, i) => {
    const values = table.rows.map((r) => r[i]);
    const filled = values.filter((v) => !isEmpty(v));
    const nums = filled.map(toNumber).filter((n) => n !== null);
    const numeric = filled.length > 0 && nums.length / filled.length >= 0.8;
    const info = {
      name,
      empty: values.length - filled.length,
      distinct: new Set(filled.map((v) => String(v).trim().toLowerCase())).size,
      numeric,
    };
    if (numeric && nums.length) {
      info.sum = round(nums.reduce((s, n) => s + n, 0));
      info.min = Math.min(...nums);
      info.max = Math.max(...nums);
      info.avg = round(info.sum / nums.length);
    }
    return info;
  });
  const seen = new Set();
  let duplicates = 0;
  let emptyRows = 0;
  for (const r of table.rows) {
    if (r.every(isEmpty)) emptyRows++;
    const key = JSON.stringify(r.map((v) => String(v ?? '').trim().toLowerCase()));
    if (seen.has(key)) duplicates++;
    else seen.add(key);
  }
  return { name: table.name, rows: table.rows.length, columns, duplicates, emptyRows };
}
